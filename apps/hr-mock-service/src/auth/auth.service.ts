import { Injectable, UnauthorizedException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import { Employee, EmployeeDocument } from "../schemas/employee.schema";
import { EmployeePublic } from "@msb/shared";

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
