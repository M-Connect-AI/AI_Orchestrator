import { Injectable, Logger } from "@nestjs/common";
import { Actor } from "../auth/jwt-auth.guard";
import { AgentGraphService } from "../agent/graph.service";
import { ComposeService } from "../agent/compose.service";
import { ThreadService } from "./thread.service";
import { ChatConfirmAction } from "@msb/shared";

export type ChatTurnResult = {
  threadId: string;
  reply: string;
  confirm: ChatConfirmAction | null;
  executed: unknown;
  citations: string[];
};

export type ChatProgress = (event: "status" | "token", data: unknown) => void;

@Injectable()
export class ChatService {
  private readonly log = new Logger(ChatService.name);

  constructor(
    private readonly graph: AgentGraphService,
    private readonly threads: ThreadService,
    private readonly compose: ComposeService,
  ) {}

  async turn(
    actor: Actor,
    message: string,
    threadId?: string,
    onProgress?: ChatProgress,
  ): Promise<ChatTurnResult> {
    const thread = await this.threads.load(actor.employeeCode, threadId);
    const history = thread.messages.map((m) => `${m.role}: ${m.content}`);
    const pending = thread.pendingAction;
    const state = await this.graph.invoke({
      message,
      actor,
      slots: thread.slots,
      intent: thread.intent,
      pending,
      history,
    });
    const reply = await this.compose.phrase({
      draft: state.reply,
      userMessage: message,
      history,
      intent: state.intent,
      hasConfirm: Boolean(state.confirm),
      citations: state.citations ?? [],
      onToken: onProgress
        ? (text) => onProgress("token", { text })
        : undefined,
    });
    if (reply !== state.reply) this.log.debug("Compose đã diễn đạt lại câu trả lời");
    thread.messages.push({ role: "user", content: message });
    thread.messages.push({ role: "assistant", content: reply });
    await this.threads.save(thread, {
      slots: state.slots ?? thread.slots,
      intent: state.intent ?? thread.intent,
      pendingAction: state.pending ?? null,
      messages: thread.messages.map((m) => ({ role: m.role, content: m.content })),
    });
    return {
      threadId: thread.threadId,
      reply,
      confirm: state.confirm ?? null,
      executed: state.executed ?? null,
      citations: state.citations ?? [],
    };
  }
}
