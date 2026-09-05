import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument } from "mongoose";
import { Slots } from "../agent/schema";
import { ChatConfirmAction } from "@msb/shared";

export type ThreadDocument = HydratedDocument<Thread>;

@Schema({ timestamps: true })
export class Thread {
  @Prop({ required: true, unique: true })
  threadId!: string;

  @Prop({ required: true, index: true })
  employeeCode!: string;

  @Prop({
    type: [
      {
        role: { type: String, enum: ["user", "assistant"], required: true },
        content: { type: String, default: "" },
      },
    ],
    default: [],
  })
  messages!: { role: "user" | "assistant"; content: string }[];

  @Prop({ type: Object, default: {} })
  slots!: Slots;

  @Prop()
  intent?: string;

  @Prop({ type: Object, default: null })
  pendingAction!: ChatConfirmAction | null;
}

export const ThreadSchema = SchemaFactory.createForClass(Thread);
ThreadSchema.index({ employeeCode: 1, updatedAt: -1 });
