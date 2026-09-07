import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import { Employee, EmployeeDocument } from "../schemas/employee.schema";
import { EmployeePublic, Role } from "@msb/shared";
import { RegisterDto } from "./register.dto";

export type JwtPayload = {
  sub: string;
  employeeCode: string;
  role: string;
  email: string;
};

@Injectable()
export class AuthService {
  constructor(
    @InjectModel(Employee.name) private readonly employees: Model<EmployeeDocument>,
    private readonly jwt: JwtService,
  ) {}

  async login(email: string, password: string) {
    const user = await this.employees.findOne({ email: email.toLowerCase() }).exec();
    if (!user) throw new UnauthorizedException("Sai email hoặc mật khẩu");
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new UnauthorizedException("Sai email hoặc mật khẩu");
    return this.issueSession(user);
  }

  async register(dto: RegisterDto) {
    const email = dto.email.trim().toLowerCase();
    const existing = await this.employees.findOne({ email }).exec();
    if (existing) throw new ConflictException("Email đã được đăng ký.");

    const role: Role = dto.role ?? "STAFF";
    const managerEmployeeCode = dto.managerEmployeeCode?.trim() || undefined;
    if (role === "STAFF" && managerEmployeeCode) {
      const manager = await this.employees.findOne({ employeeCode: managerEmployeeCode }).exec();
      if (!manager || manager.role !== "MANAGER") {
        throw new BadRequestException(
          `managerEmployeeCode ${managerEmployeeCode} không phải quản lý hợp lệ.`,
        );
      }
    }

    const employeeCode = await this.nextEmployeeCode();
    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = await this.employees.create({
      employeeCode,
      email,
      passwordHash,
      fullName: dto.fullName.trim(),
      role,
      department: (dto.department ?? "Khối ngân hàng bán lẻ").trim(),
      managerEmployeeCode: role === "STAFF" ? managerEmployeeCode : undefined,
      annualRemaining: 12,
      annualTotal: 12,
      sickRemaining: 30,
    });
    return this.issueSession(user);
  }

  private async issueSession(user: EmployeeDocument) {
    const payload: JwtPayload = {
      sub: String(user._id),
      employeeCode: user.employeeCode,
      role: user.role,
      email: user.email,
    };
    return {
      accessToken: await this.jwt.signAsync(payload),
      user: this.toPublic(user),
    };
  }

  private async nextEmployeeCode() {
    const rows = await this.employees.find({ employeeCode: /^EMP\d+$/i }).select("employeeCode").exec();
    let max = 0;
    for (const row of rows) {
      const n = Number(String(row.employeeCode).replace(/^EMP/i, ""));
      if (Number.isFinite(n) && n > max) max = n;
    }
    return `EMP${String(max + 1).padStart(3, "0")}`;
  }

  async findByCode(employeeCode: string) {
    return this.employees.findOne({ employeeCode }).exec();
  }

  toPublic(user: EmployeeDocument): EmployeePublic & { annualRemaining: number; annualTotal: number; sickRemaining: number } {
    return {
      id: String(user._id),
      employeeCode: user.employeeCode,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      department: user.department,
      managerEmployeeCode: user.managerEmployeeCode,
      annualRemaining: user.annualRemaining,
      annualTotal: user.annualTotal,
      sickRemaining: user.sickRemaining,
    };
  }
}
