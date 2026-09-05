import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument } from "mongoose";
import { RequestStatus } from "@msb/shared";

export type TripDocument = HydratedDocument<Trip>;

@Schema({ timestamps: true })
export class Trip {
  @Prop({ required: true, index: true })
  employeeCode!: string;

  @Prop({ required: true })
  destination!: string;

  @Prop({ required: true })
  from!: string;

  @Prop({ required: true })
  to!: string;

  @Prop({ required: true })
  purpose!: string;

  @Prop({ required: true, enum: ["PENDING", "APPROVED", "REJECTED", "CANCELLED"], default: "PENDING" })
  status!: RequestStatus;
}

export const TripSchema = SchemaFactory.createForClass(Trip);
