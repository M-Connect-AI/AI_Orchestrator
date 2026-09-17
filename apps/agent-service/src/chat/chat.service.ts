import { Injectable, Logger } from "@nestjs/common";
import { Actor } from "../auth/jwt-auth.guard";
import { ToolAgentService } from "../agent/tool-agent.service";
import { ThreadService } from "./thread.service";
import { ChatBlock, ChatConfirmAction, ChatHighlight, ChatSuggestion, ChatUiAction } from "@msb/shared";
import { suggestFollowUps } from "../agent/chat-followups";
import { LlmClient } from "../agent/llm.client";

export type ChatTurnResult = {
  threadId: string;
  reply: string;
  confirm: ChatConfirmAction | null;
  executed: unknown;
  didMutate: boolean;
  citations: string[];
  uiAction: ChatUiAction | null;
  blocks: ChatBlock[];
  highlights: ChatHighlight[];
  suggestions: ChatSuggestion[];
};

export type ChatProgress = (event: "status" | "token", data: unknown) => void;

@Injectable()
export class ChatService {
  private readonly log = new Logger(ChatService.name);

  constructor(
    private readonly agent: ToolAgentService,
    private readonly threads: ThreadService,
    private readonly llm: LlmClient,
  ) {}

  async turn(
    actor: Actor,
    message: string,
    threadId?: string,
    onProgress?: ChatProgress,
    opts?: { confirm?: boolean },
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
      confirm: opts?.confirm,
    });
    this.log.debug(
      `Agent turn intent=${state.intent || "-"} confirm=${Boolean(state.confirm)} didMutate=${Boolean(state.didMutate)} uiAction=${state.uiAction?.key ?? "-"}`,
    );
    const suggestions = await suggestFollowUps(
      {
        role: actor.role,
        confirm: state.confirm,
        uiAction: state.uiAction,
        didMutate: state.didMutate,
        blocks: state.blocks,
        citations: state.citations,
        userMessage: message,
        reply: state.reply,
      },
      (msgs, opts) => this.llm.complete(msgs, opts),
    );
    thread.messages.push({ role: "user", content: message });
    thread.messages.push({
      role: "assistant",
      content: state.reply,
      blocks: state.blocks ?? [],
      highlights: state.highlights ?? [],
      uiAction: state.uiAction ?? null,
      suggestions,
    });
    await this.threads.save(thread, {
      slots: state.slots ?? thread.slots,
      intent: state.intent ?? thread.intent,
      pendingAction: state.pending ?? null,
      messages: thread.messages,
    });
    return {
      threadId: thread.threadId,
      reply: state.reply,
      confirm: state.confirm ?? null,
      executed: state.didMutate ? state.executed ?? null : null,
      didMutate: Boolean(state.didMutate),
      citations: state.citations ?? [],
      uiAction: state.uiAction ?? null,
      blocks: state.blocks ?? [],
      highlights: state.highlights ?? [],
      suggestions,
    };
  }
}
