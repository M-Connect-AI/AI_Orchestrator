import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { Leave, LeaveDocument } from "../schemas/leave.schema";
import { Employee, EmployeeDocument } from "../schemas/employee.schema";
import { CreateLeaveDto, UpdateLeaveDto } from "./leave.dto";
import { inclusiveDays } from "../util/dates";
import { EmployeePublic, RequestStatus } from "@msb/shared";

@Injectable()
export class LeavesService {
  constructor(
    @InjectModel(Leave.name) private readonly leaves: Model<LeaveDocument>,
    @InjectModel(Employee.name) private readonly employees: Model<EmployeeDocument>,
  ) {}

  private canSee(actor: EmployeePublic, employeeCode: string) {
    if (actor.employeeCode === employeeCode) return true;
    if (actor.role === "MANAGER") return true;
    return false;
  }

  private async assertTeamOrSelf(actor: EmployeePublic, employeeCode: string) {
    if (actor.employeeCode === employeeCode) return;
    if (actor.role !== "MANAGER") throw new ForbiddenException("Không đủ quyền");
    const target = await this.employees.findOne({ employeeCode }).exec();
    if (!target || target.managerEmployeeCode !== actor.employeeCode) {
      throw new ForbiddenException("Nhân viên không thuộc team của bạn");
    }
  }

  async list(actor: EmployeePublic, scope: "me" | "team") {
    if (scope === "team") {
      if (actor.role !== "MANAGER") throw new ForbiddenException();
      const reports = await this.employees
        .find({ managerEmployeeCode: actor.employeeCode })
        .select("employeeCode")
        .lean()
        .exec();
      const codes = reports.map((r) => r.employeeCode);
      const rows = await this.leaves
        .find({ employeeCode: { $in: codes } })
        .sort({ createdAt: -1 })
        .lean()
        .exec();
      return this.withNames(rows);
    }
    const rows = await this.leaves
      .find({ employeeCode: actor.employeeCode })
      .sort({ createdAt: -1 })
      .lean()
      .exec();
    return this.withNames(rows);
  }

  async approveBatch(actor: EmployeePublic, ids: string[]) {
    if (actor.role !== "MANAGER") {
      throw new ForbiddenException("Chỉ quản lý được phê duyệt đơn team.");
    }
    if (!ids.length) throw new BadRequestException("Không có đơn để duyệt.");
    const approved = [];
    for (const id of ids) {
      approved.push(await this.setStatus(actor, id, "APPROVED"));
    }
    return { count: approved.length, items: approved };
  }

  async get(actor: EmployeePublic, id: string) {
    const doc = await this.leaves.findById(id).exec();
    if (!doc) throw new NotFoundException();
    if (!this.canSee(actor, doc.employeeCode)) throw new ForbiddenException();
    if (actor.role === "MANAGER" && actor.employeeCode !== doc.employeeCode) {
      await this.assertTeamOrSelf(actor, doc.employeeCode);
    }
    return doc;
  }

  async create(actor: EmployeePublic, dto: CreateLeaveDto) {
    const days = inclusiveDays(dto.from, dto.to);
    if (days < 1) throw new BadRequestException("Khoảng ngày không hợp lệ");
    const created = await this.leaves.create({
      employeeCode: actor.employeeCode,
      type: dto.type,
      from: dto.from,
      to: dto.to,
      days,
      reason: dto.reason,
      status: "PENDING",
    });
    if (dto.type === "ANNUAL") {
      await this.employees.updateOne(
        { employeeCode: actor.employeeCode },
        { $inc: { annualRemaining: -days } },
      );
    }
    return created;
  }

  async update(actor: EmployeePublic, id: string, dto: UpdateLeaveDto) {
    const doc = await this.leaves.findById(id).exec();
    if (!doc) throw new NotFoundException();
    if (doc.employeeCode !== actor.employeeCode) {
      throw new ForbiddenException();
    }
    if (doc.status !== "PENDING") {
      throw new BadRequestException("Chỉ sửa đơn đang chờ duyệt");
    }
    const from = dto.from ?? doc.from;
    const to = dto.to ?? doc.to;
    const type = dto.type ?? doc.type;
    const days = inclusiveDays(from, to);
    if (days < 1) throw new BadRequestException("Khoảng ngày không hợp lệ");
    if (doc.type === "ANNUAL") {
      await this.employees.updateOne(
        { employeeCode: doc.employeeCode },
        { $inc: { annualRemaining: doc.days } },
      );
    }
    doc.type = type;
    doc.from = from;
    doc.to = to;
    doc.days = days;
    if (dto.reason) doc.reason = dto.reason;
    await doc.save();
    if (type === "ANNUAL") {
      await this.employees.updateOne(
        { employeeCode: doc.employeeCode },
        { $inc: { annualRemaining: -days } },
      );
    }
    return doc;
  }

  async setStatus(actor: EmployeePublic, id: string, status: RequestStatus) {
    const doc = await this.leaves.findById(id).exec();
    if (!doc) throw new NotFoundException();
    if (status === "CANCELLED") {
      if (doc.employeeCode !== actor.employeeCode) {
        throw new ForbiddenException();
      }
    } else if (status === "APPROVED" || status === "REJECTED") {
      if (actor.role === "STAFF") throw new ForbiddenException();
      await this.assertTeamOrSelf(actor, doc.employeeCode);
    }
    const prev = doc.status;
    if ((status === "APPROVED" || status === "REJECTED") && prev !== "PENDING") {
      throw new BadRequestException("Chỉ duyệt đơn đang chờ (PENDING).");
    }
    doc.status = status;
    await doc.save();
    if (doc.type === "ANNUAL" && prev === "PENDING" && (status === "CANCELLED" || status === "REJECTED")) {
      await this.employees.updateOne(
        { employeeCode: doc.employeeCode },
        { $inc: { annualRemaining: doc.days } },
      );
    }
    return doc;
  }

  async balance(actor: EmployeePublic, employeeCode?: string) {
    const code = employeeCode ?? actor.employeeCode;
    if (code !== actor.employeeCode) {
      await this.assertTeamOrSelf(actor, code);
    }
    const user = await this.employees.findOne({ employeeCode: code }).exec();
    if (!user) throw new NotFoundException();
    return {
      employeeCode: user.employeeCode,
      annualRemaining: user.annualRemaining,
      annualTotal: user.annualTotal,
      sickRemaining: user.sickRemaining,
    };
  }

  private async withNames<T extends { employeeCode: string }>(rows: T[]) {
    const codes = [...new Set(rows.map((r) => r.employeeCode))];
    const people = await this.employees
      .find({ employeeCode: { $in: codes } })
      .select("employeeCode fullName")
      .lean()
      .exec();
    const names = new Map(people.map((p) => [p.employeeCode, p.fullName]));
    return rows.map((r) => ({
      ...r,
      employeeName: names.get(r.employeeCode) ?? r.employeeCode,
    }));
  }
}
