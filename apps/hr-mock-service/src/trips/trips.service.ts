import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { Trip, TripDocument } from "../schemas/trip.schema";
import { Employee, EmployeeDocument } from "../schemas/employee.schema";
import { CreateTripDto, UpdateTripDto } from "./trip.dto";
import { inclusiveDays } from "../util/dates";
import { EmployeePublic, RequestStatus } from "@msb/shared";

@Injectable()
export class TripsService {
  constructor(
    @InjectModel(Trip.name) private readonly trips: Model<TripDocument>,
    @InjectModel(Employee.name) private readonly employees: Model<EmployeeDocument>,
  ) {}

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
      const codes = [
        actor.employeeCode,
        ...reports.map((r) => r.employeeCode),
      ];
      const rows = await this.trips
        .find({ employeeCode: { $in: codes } })
        .sort({ createdAt: -1 })
        .lean()
        .exec();
      return this.withNames(rows);
    }
    const rows = await this.trips
      .find({ employeeCode: actor.employeeCode })
      .sort({ createdAt: -1 })
      .lean()
      .exec();
    return this.withNames(rows);
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

  async create(actor: EmployeePublic, dto: CreateTripDto) {
    const days = inclusiveDays(dto.from, dto.to);
    if (days < 1) throw new BadRequestException("Khoảng ngày không hợp lệ");
    return this.trips.create({
      employeeCode: actor.employeeCode,
      destination: dto.destination,
      from: dto.from,
      to: dto.to,
      purpose: dto.purpose,
      status: "PENDING",
    });
  }

  async update(actor: EmployeePublic, id: string, dto: UpdateTripDto) {
    const doc = await this.trips.findById(id).exec();
    if (!doc) throw new NotFoundException();
    if (doc.employeeCode !== actor.employeeCode) {
      throw new ForbiddenException();
    }
    if (doc.status !== "PENDING") {
      throw new BadRequestException("Chỉ sửa đơn đang chờ duyệt");
    }
    Object.assign(doc, dto);
    await doc.save();
    return doc;
  }

  async setStatus(actor: EmployeePublic, id: string, status: RequestStatus) {
    const doc = await this.trips.findById(id).exec();
    if (!doc) throw new NotFoundException();
    if (status === "CANCELLED") {
      if (doc.employeeCode !== actor.employeeCode) {
        throw new ForbiddenException();
      }
    } else {
      if (actor.role === "STAFF") throw new ForbiddenException();
      await this.assertTeamOrSelf(actor, doc.employeeCode);
    }
    doc.status = status;
    await doc.save();
    return doc;
  }
}
