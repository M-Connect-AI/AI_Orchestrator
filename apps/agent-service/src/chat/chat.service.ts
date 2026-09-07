import { Injectable, Logger } from "@nestjs/common";
import { Actor } from "../auth/jwt-auth.guard";
import { ToolAgentService } from "../agent/tool-agent.service";
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
    private readonly agent: ToolAgentService,
    private readonly threads: ThreadService,
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
    const state = await this.agent.turn({
      message,
      actor,
      slots: thread.slots,
      intent: thread.intent,
      pending,
      history,
      onProgress,
    });
    this.log.debug(
      `Agent turn intent=${state.intent || "-"} confirm=${Boolean(state.confirm)} toolsExecuted=${Boolean(state.executed)}`,
    );
    thread.messages.push({ role: "user", content: message });
    thread.messages.push({ role: "assistant", content: state.reply });
    await this.threads.save(thread, {
      slots: state.slots ?? thread.slots,
      intent: state.intent ?? thread.intent,
      pendingAction: state.pending ?? null,
      messages: thread.messages.map((m) => ({ role: m.role, content: m.content })),
    });
    return {
      threadId: thread.threadId,
      reply: state.reply,
      confirm: state.confirm ?? null,
      executed: state.executed ?? null,
      citations: state.citations ?? [],
    };
  }
}
