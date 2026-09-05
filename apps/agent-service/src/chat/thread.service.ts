import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { randomUUID } from "crypto";
import { Thread, ThreadDocument } from "./thread.schema";
import { emptySlots, Slots } from "../agent/schema";
import { ChatConfirmAction } from "@msb/shared";

export type ThreadSummary = {
  threadId: string;
  title: string;
  preview: string;
  updatedAt: string;
};

@Injectable()
export class ThreadService {
  constructor(@InjectModel(Thread.name) private readonly threads: Model<ThreadDocument>) {}

  async load(employeeCode: string, threadId?: string) {
    if (threadId) {
      const existing = await this.threads.findOne({ threadId, employeeCode }).exec();
      if (existing) return existing;
    }
    return this.threads.create({
      threadId: threadId || randomUUID(),
      employeeCode,
      messages: [],
      slots: emptySlots(),
      pendingAction: null,
    });
  }

  async get(employeeCode: string, threadId: string) {
    const doc = await this.threads.findOne({ threadId, employeeCode }).exec();
    if (!doc) throw new NotFoundException("Không tìm thấy cuộc hội thoại.");
    return doc;
  }

  async list(employeeCode: string): Promise<ThreadSummary[]> {
    const rows = await this.threads
      .find({ employeeCode })
      .sort({ updatedAt: -1 })
      .limit(80)
      .select("threadId messages updatedAt")
      .lean()
      .exec();
    return rows
      .filter((row) => (row.messages ?? []).some((m) => m.role === "user"))
      .slice(0, 50)
      .map((row) => {
        const messages = row.messages ?? [];
        const firstUser = messages.find((m) => m.role === "user");
        const last = messages[messages.length - 1];
        const updated = (row as { updatedAt?: Date | string }).updatedAt;
        const updatedAt =
          updated instanceof Date
            ? updated.toISOString()
            : typeof updated === "string"
              ? updated
              : new Date().toISOString();
        return {
          threadId: row.threadId,
          title: clip(firstUser?.content || "Cuộc hội thoại mới", 56),
          preview: clip(last?.content || "", 72),
          updatedAt,
        };
      });
  }

  async save(
    doc: ThreadDocument,
    patch: {
      slots?: Slots;
      intent?: string;
      pendingAction?: ChatConfirmAction | null;
      messages?: Thread["messages"];
    },
  ) {
    const $set: Record<string, unknown> = {};
    if (patch.slots) $set.slots = patch.slots;
    if (patch.intent !== undefined) $set.intent = patch.intent;
    if (patch.pendingAction !== undefined) $set.pendingAction = patch.pendingAction;
    if (patch.messages) {
      $set.messages = patch.messages.map((m) => ({
        role: m.role,
        content: String(m.content ?? ""),
      }));
    }
    await this.threads.updateOne({ _id: doc._id }, { $set }).exec();
    if (patch.slots) doc.slots = patch.slots;
    if (patch.intent !== undefined) doc.intent = patch.intent;
    if (patch.pendingAction !== undefined) doc.pendingAction = patch.pendingAction;
    if (patch.messages) doc.messages = $set.messages as Thread["messages"];
    return doc;
  }
}

function clip(text: string, max: number) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
