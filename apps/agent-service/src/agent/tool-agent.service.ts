import { Injectable, Logger } from "@nestjs/common";
import { ChatBlock, ChatConfirmAction, ChatHighlight, ChatSuggestion, ChatUiAction } from "@msb/shared";
import { buildChatBlocks, highlightChatText, spokenFactsFromPreview } from "./chat-blocks";
import { Actor } from "../auth/jwt-auth.guard";
import { AGENT_TOOL_DEFS, PENDING_RESOLUTION_TOOLS } from "./agent-tools";
import {
  ChatMessage,
  ChatToolDef,
  isRateLimitError,
  LlmClient,
  stripThink,
} from "./llm.client";
import { InputGuardService } from "./input-guard.service";
import { nowInVietnam } from "./leave-query";
import { emptySlots, Slots } from "./schema";
import { ToolRunnerService, ToolRunSideEffects } from "./tool-runner.service";
import { resolveChatUiAction, uiActionFromPendingTool } from "./ui-action";

export type AgentTurnResult = {
  reply: string;
  confirm: ChatConfirmAction | null;
  pending: ChatConfirmAction | null;
  /** Chỉ payload sau khi GHI hệ thống (create/approve/…). Không chứa list/preview. */
  executed: unknown;
  /** true khi đã mutate — client mới nên dùng event result. */
  didMutate: boolean;
  citations: string[];
  slots: Slots;
  intent: string;
  uiAction: ChatUiAction | null;
  blocks: ChatBlock[];
  highlights: ChatHighlight[];
  suggestions: ChatSuggestion[];
};

export type AgentProgress = (event: "status" | "token", data: unknown) => void;

const MAX_ROUNDS = 6;

const PHRASE_SYSTEM = `Bạn là M-Mate — trợ lý AI cho CBNV MSB trên M-Connect.
Nhiệm vụ: diễn đạt lại bản nháp thành câu trả lời gửi user.

Giọng: xưng "mình", gọi user "bạn". Tiếng Việt tự nhiên, gần gũi, ngắn gọn.

BẮT BUỘC — định dạng text thuần:
- Không markdown: không **, __, #, code fence.
- Không dùng mã enum: ANNUAL/SICK/UNPAID/PENDING… → phép năm / phép ốm / không lương / chờ duyệt…
- Không nhắc tool, JSON, prompt, "bản nháp".
- Ngày giờ với user: luôn theo giờ Việt Nam (+7), format ngày dd/mm/yyyy (ví dụ 16/09/2026 14:30). Không để ISO (2026-09-16T…) hay giờ UTC.
- Nếu nháp nói ĐÃ tạo/gửi/duyệt thành công: giữ đúng ý đó. KHÔNG nhắc “tab Kết quả” / “vào Kết quả xem” — UI tự hiện nút điều hướng. Cấm "đang xử lý / sẽ thông báo sau".
- Nếu nháp đang MỜI xác nhận: kết thúc bằng lời mời xác nhận, chưa nói đã gửi/đã duyệt.
- Nếu nháp là lỗi / thiếu thông tin: giữ đúng, không bịa đã thành công.
- CẤM thêm mã task, tiêu đề, trạng thái, priority, due date hoặc số liệu không xuất hiện trong nháp.
- CẤM nói đã duyệt/đã gửi nếu nháp chỉ là danh sách đơn hoặc đề xuất chờ xác nhận.
- CẤM đổi ngày/loại phép/tên người so với nháp (ví dụ nháp là 06/09 phép ốm thì không viết thành 08/09 phép năm).
- CẤM nhắc user “vào tab Kết quả / mở Jira / mở Outlook” — client sẽ hiện nút theo uiAction.
- Khi nháp là tóm tắt số liệu (số đơn / mail / sự kiện / task): chỉ 1–2 câu đúng số liệu. CẤM liệt kê lại từng mục thành gạch đầu dòng hay “Cụ thể:”. CẤM nói “trên thẻ”, “đã hiện trên thẻ”, “nằm trên thẻ”.
- CẤM bịa đơn, mail, ngày, trạng thái, tiêu đề, địa điểm, phòng họp, người tham dự không có trong nháp.
- Nếu nháp không nêu địa điểm / phòng họp thì CẤM viết “tại …”, “Phòng họp …”. Thiếu field thì bỏ, không đoán.
- Giữ nguyên số liệu, ngày, mã đơn, kết luận từ nháp. Chỉ khi nháp là tóm tắt NỘI DUNG từng mail (outlook_get_mail) mới được nêu từng mail — không rút bớt số lượng.
2–8 câu. Không gạch đầu dòng khi nháp đã là tóm tắt số liệu.
Chỉ trả lời nội dung cho user, không JSON.`;

@Injectable()
export class ToolAgentService {
  private readonly log = new Logger(ToolAgentService.name);

  constructor(
    private readonly llm: LlmClient,
    private readonly guard: InputGuardService,
    private readonly runner: ToolRunnerService,
  ) {}

  async turn(input: {
    message: string;
    actor: Actor;
    slots: Slots;
    intent?: string;
    pending: ChatConfirmAction | null;
    history: string[];
    onProgress?: AgentProgress;
    confirm?: boolean;
  }): Promise<AgentTurnResult> {
    const { message, actor, onProgress } = input;
    const slots = input.slots ?? emptySlots();
    const pending = input.pending;
    const explicitConfirm = Boolean(input.confirm) || looksLikeConfirm(message);
    const explicitCancel = looksLikeCancel(message);

    const g = this.guard.check(message);
    if (!g.ok) {
      const reply = await this.phraseStream(g.reason, message, onProgress);
      return done(reply, { slots, pending, confirm: pending });
    }

    // Nút Xác nhận / câu đồng ý ngắn: ghi hệ thống ngay, không để model bịa “đã gửi”.
    if (pending && explicitConfirm) {
      return this.commitPending({ message, actor, slots, pending, onProgress });
    }
    if (pending && explicitCancel) {
      return this.dropPending({ actor, slots, pending, onProgress });
    }
    if (!pending && (input.confirm || explicitConfirm)) {
      const reply =
        "Hiện không có thao tác nào đang chờ xác nhận. Bạn nói lại việc cần làm giúp mình nhé.";
      emitChunks(reply, onProgress);
      return done(reply, { slots, pending: null, confirm: null });
    }
    if (this.guard.looksLikeForeignAccess(message) && actor.role === "STAFF") {
      const reply = await this.phraseStream(
        "Bạn chỉ được xem và tạo đơn của chính mình. Mình không thể truy xuất nghỉ phép của nhân viên khác.",
        message,
        onProgress,
      );
      return done(reply, { slots, pending, confirm: null });
    }

    // Có pending: để MODEL quyết đồng ý/hủy qua tool (không regex "oke").
    // Chỉ mở 2 tool confirm/cancel — nếu user nói việc khác, model trả text → chạy full tools.
    if (pending) {
      onProgress?.("status", { label: "Đang xử lý xác nhận…" });
      const decision = await this.runToolLoop({
        message,
        actor,
        slots,
        pending,
        history: input.history,
        onProgress,
        tools: PENDING_RESOLUTION_TOOLS,
        extraSystem: `Đang có thao tác chờ xác nhận:
${JSON.stringify(pending)}
- User đồng ý / xác nhận / oke / gửi đi / bấm xác nhận → gọi confirm_pending_action.
- User từ chối / thôi / hủy → gọi cancel_pending_action.
- User hỏi hoặc yêu cầu việc khác (không phải xác nhận pending này) → KHÔNG gọi tool, trả lời ngắn rằng bạn sẽ xử lý yêu cầu mới.`,
      });
      if (decision.didMutate && decision.executed != null) {
        const reply =
          sanitizeReply(decision.toolSummary || "") ||
          "Đã ghi lên hệ thống thành công.";
        emitChunks(reply, onProgress);
        return finish({
          reply,
          confirm: null,
          pending: null,
          executed: decision.executed,
          didMutate: true,
          citations: decision.citations,
          slots: decision.slots,
          intent: "",
          uiAction:
            decision.uiAction ??
            resolveChatUiAction({ executed: decision.executed }) ??
            uiActionFromPendingTool(pending.tool),
        });
      }
      if (decision.didCancel) {
        const reply = await this.phraseStream(
          decision.toolSummary ||
            decision.draft ||
            "Đã hủy thao tác đang chờ xác nhận. Bạn cần gì thêm cứ nói mình nhé.",
          message,
          onProgress,
        );
        return done(reply, {
          slots: decision.slots,
          pending: null,
          confirm: null,
        });
      }
      if (decision.rateLimited) {
        const reply =
          decision.draft ||
          "Hệ thống AI đang quá tải tạm thời. Bạn đợi vài giây rồi gửi lại giúp mình nhé.";
        emitChunks(reply, onProgress);
        return done(reply, {
          slots: decision.slots,
          pending,
          confirm: null,
        });
      }
      // Không phải confirm/cancel → tiếp tục full agent (giữ pending trừ khi propose mới thay).
    }

    onProgress?.("status", { label: "Đang hiểu yêu cầu…" });
    const run = await this.runToolLoop({
      message,
      actor,
      slots,
      pending,
      history: input.history,
      onProgress,
      tools: AGENT_TOOL_DEFS,
      extraSystem: pending
        ? `Đang có thao tác chờ xác nhận (user có thể đang làm việc khác):
${JSON.stringify(pending)}
Nếu propose_* mới → thay pending. Không nói đã duyệt/đã gửi khi chưa confirm_pending_action.`
        : undefined,
    });

    // Sau propose: lời mời xác nhận tự nhiên.
    if (run.confirm && !run.didMutate) {
      const ask =
        run.askUser || `${run.confirm.summary}. Bạn xác nhận giúp mình nhé?`;
      const reply = await this.phraseStream(ask, message, onProgress, {
        mustInviteConfirm: true,
      });
      return finish(
        {
          reply,
          confirm: run.confirm,
          pending: run.confirm,
          executed: null,
          didMutate: false,
          citations: run.citations,
          slots: run.slots,
          intent: input.intent ?? "",
          uiAction: null,
          suggestions: run.suggestions,
        },
        { preview: run.preview },
      );
    }

    // Q&A (mail/lịch/list…): ưu tiên draft của model sau khi đã thấy mọi tool.
    // toolSummary chỉ là fallback — và với nhiều get_mail đã được ghép ở trên.
    const draft = run.didMutate
      ? run.toolSummary || run.draft || "Đã xử lý xong trên hệ thống."
      : run.draft ||
        run.toolSummary ||
        "Mình chưa gọi được đủ thông tin để trả lời. Bạn mô tả lại giúp mình được không?";

    const uiAction =
      run.uiAction ??
      resolveChatUiAction({
        confirm: run.confirm,
        executed: run.didMutate ? run.executed : null,
        preview: run.preview,
      });

    // Rate limit: đừng gọi phrase LLM thêm (tránh đốt quota / lỗi kép).
    if (run.rateLimited) {
      emitChunks(draft, onProgress);
      return finish(
        {
          reply: draft,
          confirm: null,
          pending: run.didMutate ? null : run.confirm ?? run.pending ?? pending,
          executed: run.didMutate ? run.executed : null,
          didMutate: run.didMutate,
          citations: run.citations,
          slots: run.slots,
          intent: input.intent ?? "",
          uiAction,
          suggestions: run.suggestions,
        },
        { preview: run.didMutate ? undefined : run.preview },
      );
    }

    const facts =
      !run.didMutate && !run.confirm ? spokenFactsFromPreview(run.preview) : null;
    if (facts) {
      emitChunks(facts, onProgress);
      return finish(
        {
          reply: facts,
          confirm: null,
          pending: run.confirm ?? run.pending ?? pending,
          executed: null,
          didMutate: false,
          citations: run.citations,
          slots: run.slots,
          intent: input.intent ?? "",
          uiAction,
          suggestions: run.suggestions,
        },
        { preview: run.preview },
      );
    }

    if (run.didMutate) {
      if (run.executed == null) {
        const reply =
          "Mình chưa ghi được lên hệ thống. Bạn thử xác nhận lại giúp mình nhé.";
        emitChunks(reply, onProgress);
        return finish({
          reply,
          confirm: run.confirm ?? pending,
          pending: run.confirm ?? run.pending ?? pending,
          executed: null,
          didMutate: false,
          citations: run.citations,
          slots: run.slots,
          intent: input.intent ?? "",
          uiAction: null,
          suggestions: run.suggestions,
        });
      }
      const reply = sanitizeReply(draft) || "Đã ghi lên hệ thống thành công.";
      emitChunks(reply, onProgress);
      return finish({
        reply,
        confirm: null,
        pending: null,
        executed: run.executed,
        didMutate: true,
        citations: run.citations,
        slots: run.slots,
        intent: input.intent ?? "",
        uiAction:
          uiAction ??
          resolveChatUiAction({ executed: run.executed }) ??
          uiActionFromPendingTool(pending?.tool ?? run.confirm?.tool),
        suggestions: run.suggestions,
      });
    }

    const reply = await this.phraseStream(draft, message, onProgress, {
      forbidFakeSuccess: true,
    });
    const safeReply = claimsWriteSuccess(reply)
      ? sanitizeReply(draft) && !claimsWriteSuccess(draft)
        ? sanitizeReply(draft)
        : "Mình chưa ghi lên hệ thống. Bạn xác nhận giúp mình nếu muốn gửi đơn nhé."
      : reply;

    return finish(
      {
        reply: safeReply,
        confirm: null,
        pending: run.confirm ?? run.pending ?? pending,
        executed: null,
        didMutate: false,
        citations: run.citations,
        slots: run.slots,
        intent: input.intent ?? "",
        uiAction,
        suggestions: run.suggestions,
      },
      { preview: run.preview },
    );
  }

  private async commitPending(input: {
    message: string;
    actor: Actor;
    slots: Slots;
    pending: ChatConfirmAction;
    onProgress?: AgentProgress;
  }): Promise<AgentTurnResult> {
    const { actor, slots, pending, onProgress } = input;
    onProgress?.("status", { label: "Đang gửi lên hệ thống…" });
    this.log.log(
      `Commit pending ${pending.tool} for ${actor.employeeCode}: ${pending.summary ?? ""}`,
    );
    const exec = await this.runner.executePending(actor, pending);
    if (exec.executed == null) {
      const reply =
        sanitizeReply(exec.reply) ||
        "Không ghi được lên hệ thống. Bạn thử xác nhận lại giúp mình nhé.";
      emitChunks(reply, onProgress);
      return finish({
        reply,
        confirm: pending,
        pending,
        executed: null,
        didMutate: false,
        citations: [],
        slots,
        intent: "",
        uiAction: null,
      });
    }
    const reply = sanitizeReply(exec.reply) || exec.reply;
    emitChunks(reply, onProgress);
    return finish({
      reply,
      confirm: null,
      pending: null,
      executed: exec.executed,
      didMutate: true,
      citations: [],
      slots,
      intent: "",
      uiAction:
        exec.uiAction ??
        resolveChatUiAction({ executed: exec.executed }) ??
        uiActionFromPendingTool(pending.tool),
    });
  }

  private async dropPending(input: {
    actor: Actor;
    slots: Slots;
    pending: ChatConfirmAction;
    onProgress?: AgentProgress;
  }): Promise<AgentTurnResult> {
    const run = await this.runner.run("cancel_pending_action", "{}", {
      actor: input.actor,
      slots: input.slots,
      pending: input.pending,
    });
    const payload = readToolPayload(run.content);
    const reply =
      sanitizeReply(payload.summary || "") ||
      "Đã hủy thao tác đang chờ xác nhận. Bạn cần gì thêm cứ nói mình nhé.";
    emitChunks(reply, input.onProgress);
    return done(reply, {
      slots: run.effects.slots ?? input.slots,
      pending: null,
      confirm: null,
    });
  }

  private async runToolLoop(input: {
    message: string;
    actor: Actor;
    slots: Slots;
    pending: ChatConfirmAction | null;
    history: string[];
    onProgress?: AgentProgress;
    extraSystem?: string;
    seedMessages?: ChatMessage[];
    tools?: ChatToolDef[];
  }) {
    let slots = input.slots;
    let pending = input.pending;
    const state = {
      confirm: null as ChatConfirmAction | null,
      executed: null as unknown,
      preview: null as unknown,
      citations: [] as string[],
      askUser: null as string | null,
      toolSummary: null as string | null,
      draft: "",
      didMutate: false,
      didCancel: false,
      rateLimited: false,
      uiAction: null as ChatUiAction | null,
      suggestions: [] as ChatSuggestion[],
    };

    const messages: ChatMessage[] = input.seedMessages
      ? [...input.seedMessages]
      : [
          { role: "system", content: buildSystemPrompt(input.actor) },
          ...historyToMessages(input.history),
          {
            role: "system",
            content: `Ngữ cảnh phiên: listedIds=${slots.listedIds ?? "null"}; listedMailIds=${slots.listedMailIds ? `${slots.listedMailIds.split("\n").filter(Boolean).length} mail` : "null"}; role=${input.actor.role}; employeeCode=${input.actor.employeeCode}; hasPending=${Boolean(pending)}.`,
          },
          ...(input.extraSystem
            ? [{ role: "system", content: input.extraSystem } satisfies ChatMessage]
            : []),
          { role: "user", content: input.message },
        ];

    if (input.seedMessages && input.extraSystem) {
      messages.push({ role: "system", content: input.extraSystem });
      messages.push({
        role: "user",
        content: "Hãy gọi tool phù hợp ngay với đủ thông tin đã có.",
      });
    }

    const tools = input.tools ?? AGENT_TOOL_DEFS;

    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const result = await this.llm.chatWithTools(messages, tools, {
          temperature: 0.3,
          max_tokens: 1024,
        });

        if (result.tool_calls.length) {
          messages.push(result.raw);
          for (const tc of result.tool_calls) {
            if (tc.function.name !== "suggest_follow_ups") {
              input.onProgress?.("status", { label: statusLabel(tc.function.name) });
            }
            const run = await this.runner.run(tc.function.name, tc.function.arguments, {
              actor: input.actor,
              slots,
              pending,
            });
            mergeEffects(run.effects, (e) => {
              if (e.slots) slots = e.slots;
              if (e.confirm !== undefined) state.confirm = e.confirm;
              if (e.pending !== undefined) pending = e.pending;
              if (e.preview !== undefined) state.preview = e.preview;
              if (e.executed !== undefined) state.executed = e.executed;
              if (e.mutated) state.didMutate = true;
              if (e.citations?.length) state.citations = e.citations;
              if (e.uiAction !== undefined) state.uiAction = e.uiAction;
              if (e.suggestions?.length) state.suggestions = e.suggestions;
            });
            const parsed = readToolPayload(run.content);
            if (parsed.needConnect && !state.uiAction) {
              state.uiAction = resolveChatUiAction({ needConnect: true });
            }
            if (parsed.askUser) state.askUser = parsed.askUser;
            if (parsed.summary) {
              // Nhiều get_mail trong cùng lượt → ghép, không ghi đè (tránh mất mail).
              if (
                tc.function.name === "outlook_get_mail" &&
                state.toolSummary &&
                state.toolSummary.trim()
              ) {
                state.toolSummary = `${state.toolSummary}\n\n---\n\n${parsed.summary}`;
              } else {
                state.toolSummary = parsed.summary;
              }
            }
            if (parsed.cancelled) state.didCancel = true;
            if (tc.function.name === "confirm_pending_action") {
              if (parsed.ok && state.executed != null) {
                pending = null;
                state.confirm = null;
                state.didMutate = true;
              } else {
                state.didMutate = false;
                state.executed = null;
              }
            }
            if (tc.function.name === "cancel_pending_action") {
              pending = null;
              state.confirm = null;
              state.didCancel = true;
            }
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              name: tc.function.name,
              content: run.content,
            });
          }
          // Propose (chờ confirm) / đã mutate / đã cancel → dừng vòng tool.
          if (state.confirm || state.didMutate || state.didCancel) break;
          const onlyFollowUps = result.tool_calls.every(
            (tc) => tc.function.name === "suggest_follow_ups",
          );
          if (onlyFollowUps && (state.preview != null || state.toolSummary)) break;
          continue;
        }

        state.draft = sanitizeReply(result.content);
        if (state.draft) break;
      }
    } catch (e) {
      this.log.error(`Tool loop failed: ${String(e)}`);
      state.rateLimited = isRateLimitError(e);
      state.draft = state.rateLimited
        ? "Hệ thống AI đang quá tải tạm thời. Bạn đợi vài giây rồi gửi lại giúp mình nhé."
        : e instanceof Error
          ? `Xin lỗi, mình gặp lỗi khi xử lý: ${e.message}. Bạn thử lại giúp mình nhé.`
          : "Xin lỗi, mình chưa xử lý được yêu cầu. Bạn thử lại sau giúp mình.";
    }

    return {
      messages,
      slots,
      pending,
      confirm: state.confirm,
      executed: state.executed,
      preview: state.preview,
      didMutate: state.didMutate,
      didCancel: state.didCancel,
      citations: state.citations,
      askUser: state.askUser,
      toolSummary: state.toolSummary,
      draft: state.draft,
      rateLimited: state.rateLimited,
      uiAction: state.uiAction,
      suggestions: state.suggestions,
    };
  }

  private async phraseStream(
    draft: string,
    userMessage: string,
    onProgress?: AgentProgress,
    opts?: {
      mustKeepSuccess?: boolean;
      mustInviteConfirm?: boolean;
      forbidFakeSuccess?: boolean;
      keepMailBody?: boolean;
    },
  ): Promise<string> {
    const factDraft = sanitizeReply(draft) || draft.trim();
    if (!factDraft) return factDraft;

    onProgress?.("status", { label: "Đang soạn trả lời…" });
    let system = PHRASE_SYSTEM;
    const maxTokens = opts?.keepMailBody ? 900 : 450;
    if (opts?.mustKeepSuccess) {
      system = `${PHRASE_SYSTEM}\nNháp này là KẾT QUẢ ĐÃ THỰC THI thành công. Nói rõ đã xong. Cấm nhắc tab Kết quả / mở app — UI tự hiện nút. Cấm "đang xử lý/sẽ báo sau".`;
    } else if (opts?.mustInviteConfirm) {
      system = `${PHRASE_SYSTEM}\nNháp đang MỜI XÁC NHẬN trước khi ghi hệ thống.
Viết lại tự nhiên, gần gũi như đồng nghiệp (2–6 câu).
Giữ đủ: số đơn, tên người, loại phép, ngày (có thể viết 8/9 thay 2026-09-08).
Bỏ giọng báo cáo ("Theo trạng thái", "Theo loại", "Có N đơn khớp").
Kết thúc bằng lời mời xác nhận. CẤM nói đã duyệt/đã gửi/đã tạo.`;
    } else if (opts?.keepMailBody) {
      system = `${PHRASE_SYSTEM}\nNháp là NỘI DUNG MỘT mail đã lấy từ Outlook (outlook_get_mail).
Tóm tắt mail này bằng tiếng Việt: người gửi, tiêu đề, thời điểm, các ý chính trong nội dung.
CẤM nói lại số lượng hộp thư / liệt kê các mail khác. CẤM bảo user xem lại danh sách.`;
    } else if (opts?.forbidFakeSuccess) {
      system = `${PHRASE_SYSTEM}\nNháp CHƯA phải kết quả đã ghi hệ thống. CẤM nói đã gửi/đã tạo/đã duyệt thành công. Nếu thiếu tool/xác nhận thì hỏi lại.`;
    }
    const messages = [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify({ userMessage, factDraft }) },
    ];

    try {
      const raw = await this.llm.complete(messages, { temperature: 0.45, max_tokens: maxTokens });
      let text = sanitizeReply(raw) || factDraft;
      if (opts?.forbidFakeSuccess && claimsWriteSuccess(text) && !claimsWriteSuccess(factDraft)) {
        text = factDraft;
      }
      emitChunks(text, onProgress);
      return text;
    } catch (e) {
      this.log.warn(`Phrase stream failed, dùng nháp: ${String(e)}`);
      emitChunks(factDraft, onProgress);
      return factDraft;
    }
  }
}

function buildSystemPrompt(actor: Actor) {
  const today = nowInVietnam();
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const hômNay = iso(today);
  const hômQua = iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1));
  const ngàyMai = iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1));
  const ngàyKia = iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 2));
  const monthStart = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
  const monthEnd = iso(new Date(today.getFullYear(), today.getMonth() + 1, 0));
  const dow = today.getDay(); // 0=CN
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const weekMon = new Date(today.getFullYear(), today.getMonth(), today.getDate() + mondayOffset);
  const weekSun = new Date(weekMon.getFullYear(), weekMon.getMonth(), weekMon.getDate() + 6);
  const tuầnNàyFrom = iso(weekMon);
  const tuầnNàyTo = iso(weekSun);
  const lastWeekMon = new Date(weekMon.getFullYear(), weekMon.getMonth(), weekMon.getDate() - 7);
  const lastWeekSun = new Date(weekSun.getFullYear(), weekSun.getMonth(), weekSun.getDate() - 7);
  const tuầnTrướcFrom = iso(lastWeekMon);
  const tuầnTrướcTo = iso(lastWeekSun);

  return `Bạn là M-Mate — trợ lý AI dành cho CBNV MSB, chỉ có trên M-Connect.
Bạn hỗ trợ nghiệp vụ nhân sự, công việc Jira, và Outlook (mail + lịch họp) sau khi user đã Kết nối Outlook.

Giọng: xưng "mình", gọi "bạn". Text thuần, không markdown, không enum với user.
Người dùng: ${actor.employeeCode}, email ${actor.email}, vai trò ${actor.role === "MANAGER" ? "quản lý" : "nhân viên"}.
Khi trả lời user: ngày = dd/mm/yyyy, giờ = Asia/Ho_Chi_Minh (+7). Không trả ISO/UTC thô.

NGÀY (Asia/Ho_Chi_Minh): hôm nay ${hômNay}.
- hôm nay=${hômNay}; hôm qua=${hômQua}; ngày mai=${ngàyMai}; ngày kia=${ngàyKia}
- tháng này: from=${monthStart}, to=${monthEnd}
- tuần này (T2–CN): from=${tuầnNàyFrom}, to=${tuầnNàyTo}
- tuần trước: from=${tuầnTrướcFrom}, to=${tuầnTrướcTo}
- Khi lọc/duyệt đơn đã có: “6/9” hoặc “ngày 6/9” → from=to=năm hiện tại-09-06 (không đổi sang ngày khác, không nhảy năm).

QUYẾT ĐỊNH BẰNG TOOL:
- Hiểu ý user tự nhiên (oke/đồng ý/xác nhận… = đồng ý; không/thôi/hủy = từ chối).
- Có pending + user đồng ý → confirm_pending_action. Có pending + từ chối → cancel_pending_action.
- Yêu cầu TẠO / DUYỆT / HỦY mới (chưa phải câu xác nhận) → chỉ gọi propose_*, rồi mời xác nhận. KHÔNG gọi confirm_pending_action trong cùng lượt.
- Duyệt đơn: truyền đúng employeeHint + from/to theo đúng ngày user nói. Ví dụ “duyệt đơn Minh ngày 6/9” → employeeHint=Minh, from và to = ngày 6/9. Không lấy nhầm đơn ngày khác. Không bịa “đơn 8/9 tương ứng 6/9”.
- Nếu tool báo không khớp bộ lọc: nói rõ và liệt kê đơn chờ, hỏi lại — không chọn đơn khác thay thế.
- Cấm nói đã gửi/tạo/duyệt thành công nếu chưa có kết quả ok từ confirm_pending_action.
- Thiếu thông tin → hỏi. Số liệu thật → luôn gọi get_leave_balance / list_pending_approvals / list_leaves / list_trips / search_policy / outlook_* / jira_* trong lượt này. CẤM trả lời danh sách đơn/mail/lịch/Jira từ hội thoại trước hoặc nhớ.
- Ở lượt tool đầu: LUÔN gọi thêm suggest_follow_ups SONG SONG với tool nghiệp vụ (2–3 câu user gửi được ngay, bám đúng việc đang hỏi, không nhảy domain, STAFF không gợi ý duyệt đơn người khác). Khi đang mời xác nhận propose_* thì items=[].
- “Đơn cần duyệt / chờ duyệt / có đơn nào để duyệt” (không nói rõ loại): CHỈ gọi list_pending_approvals — tool này đã gồm cả nghỉ phép + công tác. CẤM chỉ gọi list_trips hoặc chỉ list_leaves.
- Xem / liệt kê / đang có đơn nghỉ phép → list_leaves. Xin nghỉ / tạo đơn phép → propose_create_leave.
- Xem / liệt kê / đang có đơn công tác → list_trips. Tạo / xin / đăng ký công tác (kèm nơi, ngày, mục đích) → propose_create_trip. CẤM list_trips khi user muốn TẠO đơn mới.
- Duyệt công tác → propose_approve_trips / propose_reject_trips. Duyệt nghỉ phép → propose_approve_leaves / propose_reject_leaves.
- STAFF không xem/duyệt đơn người khác. MANAGER duyệt team.
- Outlook MAIL → outlook_list_mails. RULE NGÀY (bắt buộc):
  - “mail hôm nay” → from=to=${hômNay}, unreadOnly=false
  - “mail hôm qua” → from=to=${hômQua}
  - “mail ngày mai” → from=to=${ngàyMai}
  - “mail tuần này” → from=${tuầnNàyFrom}, to=${tuầnNàyTo}
  - “mail tuần trước” → from=${tuầnTrướcFrom}, to=${tuầnTrướcTo}
  - “mail tháng này” → from=${monthStart}, to=${monthEnd}
  - “mail ngày 6/9” / “mail 16/9” → from=to=YYYY-MM-DD đúng ngày đó
  - Chỉ khi hỏi “chưa đọc / chưa xem” mới unreadOnly=true (có thể kèm from/to).
  - Không nêu ngày → không truyền from/to (mail gần đây). CẤM liệt kê mail ngoài khoảng from/to.
  - Tóm tắt sâu / “mail đầu tiên” / “mail thứ N” / “2 mail hôm nay”:
    1) Nếu chưa list đúng khoảng ngày → outlook_list_mails(from=to=ngày đó; unreadOnly nếu user nói chưa đọc).
    2) Gọi outlook_get_mail(ordinal="1"), ordinal="2", … cho TỪNG mail cần tóm tắt.
    3) Trả lời phải đủ SỐ mail đã lấy được; CẤM gom thành 1 khi tool đã trả nhiều. CẤM truyền messageId Graph dài. Chỉ mailbox của chính user. needConnect → nhắc Kết nối Outlook.
- List mail: không chép lại từng thư trong text — UI vẽ thẻ từ kết quả API. Tóm tắt sâu từng mail mới dùng outlook_get_mail.
- Khi tóm tắt mail (get_mail): mỗi mail một mục riêng (tiêu đề / giờ / tóm tắt). Không bịa nội dung ngoài tool; không đọc mail người khác.
- Outlook LỊCH: “hôm nay họp gì / có lịch gì / lịch ngày mai / lịch tuần này” → BẮT BUỘC gọi outlook_list_calendar với from/to đúng khoảng VN. CẤM trả lời lịch mà không gọi tool (kể cả khi đoán là trống). CẤM bịa tiêu đề, giờ, phòng họp, địa điểm — chỉ nêu field có trong kết quả tool; không có địa điểm thì không viết “tại …”.
- Tạo sự kiện lịch Outlook → propose_create_outlook_event (subject + start giờ VN; end tuỳ chọn). PHẢI chờ xác nhận, không tạo ngay.
- Trả lời mail → sau khi đã list/get: propose_reply_outlook_mail(ordinal, comment). PHẢI chờ xác nhận trước khi gửi.
- needConnect / thiếu quyền Write → nhắc Ngắt rồi Kết nối lại Outlook (Calendars.ReadWrite + Mail.ReadWrite/Mail.Send).
- Jira: câu hỏi tổng quan task của tôi → jira_my_work_summary; cần danh sách theo trạng thái → jira_list_my_tasks; phân tích backlog/rủi ro/ưu tiên → jira_analyze_backlog.
- Khi tool Jira trả số liệu tổng: draft 1–2 câu, KHÔNG liệt kê Cần làm/Đang làm/Đã làm/quá hạn thành gạch đầu dòng. CẤM nói “trên thẻ”.
- Tạo Jira task mới → propose_create_jira_task khi đã có projectKey và summary; thiếu trường nào thì hỏi trường đó. Sau khi propose phải chờ user xác nhận, không confirm trong cùng lượt. Task được gán theo email tài khoản M-Connect.
- RULE ASSIGNEE JIRA: user vai trò STAFF chỉ được assign task cho chính mình, tức email ${actor.email}. Nếu STAFF yêu cầu assign cho email/tên người khác: KHÔNG gọi propose_create_jira_task, KHÔNG tự đổi assignee, KHÔNG tạo pending action. Trả lời chính xác: “Theo rule phân quyền, nhân viên chỉ được tạo Jira task và assign cho chính mình. Bạn không thể assign task cho người khác.”
- Không được nói lỗi kết nối, thiếu quyền Jira MCP hoặc thiếu thông tin khi nguyên nhân thực tế là vi phạm rule assignee trên.
- Với mọi câu hỏi Jira, kể cả câu hỏi tiếp nối như “mô tả 2 task”, “task nào”, “board nào”: bắt buộc dùng dữ liệu tool mới nhất. Cấm tự suy diễn hoặc tạo mã task, tiêu đề, trạng thái, priority, due date không có trong kết quả tool.
- "đã làm" → statusGroup=DONE; "đang làm" → IN_PROGRESS; "cần làm" → TODO; "chưa làm/chưa xong" → NOT_DONE.
- Jira của CBNV luôn được scope theo email tài khoản M-Connect. Không tự tạo JQL và không hỏi credential trong chat.
- Chỉ MANAGER được dùng jira_analyze_backlog scope=PROJECT và phải có projectKey. Jira chỉ hỗ trợ đọc và tạo task có xác nhận; chưa hỗ trợ sửa/xóa/chuyển trạng thái.
- Tool args: ANNUAL|SICK|UNPAID; trả lời user luôn tiếng Việt đời thường.`;
}

function historyToMessages(history: string[]): ChatMessage[] {
  return history.slice(-12).map((line) => {
    const idx = line.indexOf(": ");
    if (idx < 0) return { role: "user", content: line };
    const role = line.slice(0, idx);
    const content = line.slice(idx + 2);
    return {
      role: role === "assistant" ? "assistant" : "user",
      content,
    };
  });
}

function mergeEffects(
  effects: Partial<ToolRunSideEffects>,
  apply: (e: Partial<ToolRunSideEffects>) => void,
) {
  apply(effects);
}

function finish(
  result: Omit<AgentTurnResult, "blocks" | "highlights" | "suggestions"> & {
    suggestions?: ChatSuggestion[];
  },
  visual?: { preview?: unknown },
): AgentTurnResult {
  return {
    ...result,
    suggestions: result.suggestions ?? [],
    // Sau ghi hệ thống: chỉ text + uiAction (key/path). Không vẽ card từ đơn vừa tạo.
    blocks: result.didMutate
      ? []
      : buildChatBlocks({
          preview: visual?.preview,
          citations: result.citations,
        }),
    highlights: highlightChatText(result.reply),
  };
}

function done(
  reply: string,
  extra: Partial<AgentTurnResult> & { slots: Slots; preview?: unknown },
): AgentTurnResult {
  return finish(
    {
      reply,
      confirm: extra.confirm ?? null,
      pending: extra.pending ?? null,
      executed: extra.executed ?? null,
      didMutate: extra.didMutate ?? false,
      citations: extra.citations ?? [],
      slots: extra.slots,
      intent: extra.intent ?? "",
      uiAction: extra.uiAction ?? null,
      suggestions: extra.suggestions,
    },
    { preview: extra.preview },
  );
}

function looksLikeConfirm(message: string) {
  const t = message
    .trim()
    .toLowerCase()
    .replace(/[!?.…]+$/g, "")
    .trim();
  return /^(đồng ý( xác nhận)?|xác nhận( gửi)?|gửi đi|gửi đơn|oke+|ok+|yes|confirm)$/i.test(t);
}

function looksLikeCancel(message: string) {
  const t = message
    .trim()
    .toLowerCase()
    .replace(/[!?.…]+$/g, "")
    .trim();
  return /^(không|thôi|hủy|huỷ|hủy đi|đừng gửi|cancel|no)$/i.test(t);
}

function claimsWriteSuccess(text: string) {
  const t = text.toLowerCase();
  if (/chưa (gửi|tạo|duyệt)|đang chờ xác nhận|bạn xác nhận|mời xác nhận/.test(t)) return false;
  return /đã (gửi|tạo xong|tạo đơn|phê duyệt|duyệt xong|từ chối \d|hủy thao tác)|mình đã gửi/.test(t);
}

function sanitizeReply(raw: string) {
  let text = stripThink(raw).replace(/^```(?:\w+)?\s*|\s*```$/g, "").trim();
  if (!text || text.startsWith("{")) return "";
  text = text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "");
  text = text
    .replace(/\bANNUAL\b/g, "phép năm")
    .replace(/\bSICK\b/g, "phép ốm")
    .replace(/\bUNPAID\b/g, "không lương")
    .replace(/\bPENDING\b/g, "chờ duyệt")
    .replace(/\bAPPROVED\b/g, "đã duyệt")
    .replace(/\bREJECTED\b/g, "từ chối")
    .replace(/\bCANCELLED\b/g, "đã hủy");
  return text.trim();
}

function readToolPayload(toolContent: string): {
  askUser?: string;
  summary?: string;
  error?: string;
  ok?: boolean;
  cancelled?: boolean;
  needConnect?: boolean;
} {
  try {
    const parsed = JSON.parse(toolContent) as {
      askUser?: string;
      summary?: string;
      error?: string;
      ok?: boolean;
      cancelled?: boolean;
      needConnect?: boolean;
    };
    return {
      askUser: parsed.askUser ? String(parsed.askUser) : undefined,
      summary: parsed.summary ? String(parsed.summary) : undefined,
      error: parsed.error ? String(parsed.error) : undefined,
      ok: parsed.ok,
      cancelled: parsed.cancelled,
      needConnect: Boolean(parsed.needConnect),
    };
  } catch {
    return {};
  }
}

function emitChunks(text: string, onProgress?: AgentProgress) {
  if (!onProgress || !text) return;
  const size = 18;
  for (let i = 0; i < text.length; i += size) {
    onProgress("token", { text: text.slice(i, i + size) });
  }
}

function statusLabel(toolName: string) {
  switch (toolName) {
    case "get_leave_balance":
      return "Đang kiểm tra số dư phép…";
    case "list_leaves":
      return "Đang tra cứu đơn nghỉ phép…";
    case "list_trips":
      return "Đang tra cứu công tác…";
    case "list_pending_approvals":
      return "Đang tra cứu đơn chờ duyệt…";
    case "search_policy":
      return "Đang tìm quy định…";
    case "outlook_list_mails":
    case "outlook_get_mail":
      return "Đang đọc Outlook mail…";
    case "outlook_list_calendar":
      return "Đang xem lịch Outlook…";
    case "propose_create_outlook_event":
      return "Đang soạn sự kiện Outlook…";
    case "propose_reply_outlook_mail":
      return "Đang soạn trả lời mail…";
    case "jira_my_work_summary":
      return "Đang tổng hợp công việc Jira…";
    case "jira_list_my_tasks":
      return "Đang tra cứu task Jira…";
    case "jira_analyze_backlog":
      return "Đang phân tích backlog Jira…";
    case "propose_create_jira_task":
      return "Đang chuẩn bị tạo Jira task…";
    case "propose_create_leave":
    case "propose_create_trip":
      return "Đang chuẩn bị đề xuất đơn…";
    case "propose_cancel_leave":
      return "Đang chuẩn bị hủy đơn…";
    case "propose_update_leave":
      return "Đang chuẩn bị sửa đơn…";
    case "propose_approve_leaves":
      return "Đang chuẩn bị phê duyệt…";
    case "propose_reject_leaves":
      return "Đang chuẩn bị từ chối đơn…";
    case "propose_approve_trips":
      return "Đang chuẩn bị phê duyệt công tác…";
    case "propose_reject_trips":
      return "Đang chuẩn bị từ chối công tác…";
    case "confirm_pending_action":
      return "Đang gửi lên hệ thống…";
    case "cancel_pending_action":
      return "Đang hủy thao tác chờ xác nhận…";
    default:
      return "Đang xử lý…";
  }
}
