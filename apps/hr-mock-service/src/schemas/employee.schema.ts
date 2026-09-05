import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument } from "mongoose";
import { Role } from "@msb/shared";

export type EmployeeDocument = HydratedDocument<Employee>;

@Schema({ timestamps: true })
export class Employee {
  @Prop({ required: true, unique: true })
  employeeCode!: string;

  @Prop({ required: true, unique: true })
  email!: string;

  @Prop({ required: true })
  passwordHash!: string;

  @Prop({ required: true })
  fullName!: string;

  @Prop({ required: true, enum: ["STAFF", "MANAGER"] })
  role!: Role;

  @Prop({ required: true })
  department!: string;

  @Prop()
  managerEmployeeCode?: string;

  @Prop({ required: true, default: 12 })
  annualRemaining!: number;

  @Prop({ required: true, default: 12 })
  annualTotal!: number;

  @Prop({ required: true, default: 30 })
  sickRemaining!: number;
}

export const EmployeeSchema = SchemaFactory.createForClass(Employee);
