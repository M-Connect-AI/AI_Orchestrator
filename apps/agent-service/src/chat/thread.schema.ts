import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument } from "mongoose";
import { Slots } from "../agent/schema";
import { ChatBlock, ChatConfirmAction, ChatHighlight, ChatSuggestion, ChatUiAction } from "@msb/shared";

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
        blocks: { type: Array, required: false },
        highlights: { type: Array, required: false },
        uiAction: { type: Object, required: false },
        suggestions: { type: Array, required: false },
      },
    ],
    default: [],
  })
  messages!: {
    role: "user" | "assistant";
    content: string;
    blocks?: ChatBlock[];
    highlights?: ChatHighlight[];
    uiAction?: ChatUiAction | null;
    suggestions?: ChatSuggestion[];
  }[];

  @Prop({ type: Object, default: {} })
  slots!: Slots;

  @Prop()
  intent?: string;

  @Prop({ type: Object, default: null })
  pendingAction!: ChatConfirmAction | null;
}

export const ThreadSchema = SchemaFactory.createForClass(Thread);
ThreadSchema.index({ employeeCode: 1, updatedAt: -1 });
