import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument } from "mongoose";
import { LeaveType, RequestStatus } from "@msb/shared";

export type LeaveDocument = HydratedDocument<Leave>;

@Schema({ timestamps: true })
export class Leave {
  @Prop({ required: true, index: true })
  employeeCode!: string;

  @Prop({ required: true, enum: ["ANNUAL", "SICK", "UNPAID"] })
  type!: LeaveType;

  @Prop({ required: true })
  from!: string;

  @Prop({ required: true })
  to!: string;

  @Prop({ required: true })
  days!: number;

  @Prop({ required: true })
  reason!: string;

  @Prop({ required: true, enum: ["PENDING", "APPROVED", "REJECTED", "CANCELLED"], default: "PENDING" })
  status!: RequestStatus;
}

export const LeaveSchema = SchemaFactory.createForClass(Leave);
