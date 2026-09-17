import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument } from "mongoose";

export type OutlookConnectionDocument = HydratedDocument<OutlookConnection>;

@Schema({ timestamps: true })
export class OutlookConnection {
  @Prop({ required: true, unique: true, index: true })
  employeeCode!: string;

  @Prop({ required: true })
  microsoftEmail!: string;

  @Prop({ required: true })
  encryptedRefreshToken!: string;

  @Prop()
  encryptedAccessToken?: string;

  @Prop()
  accessTokenExpiresAt?: Date;
}

export const OutlookConnectionSchema = SchemaFactory.createForClass(OutlookConnection);
