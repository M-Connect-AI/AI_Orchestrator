import { Injectable, Logger } from "@nestjs/common";
import { ChatConfirmAction } from "@msb/shared";
import { Actor } from "../auth/jwt-auth.guard";
import { AGENT_TOOL_DEFS, PENDING_RESOLUTION_TOOLS } from "./agent-tools";
import { ChatMessage, ChatToolDef, LlmClient, stripThink } from "./llm.client";
import { InputGuardService } from "./input-guard.service";
import { nowInVietnam } from "./leave-query";
import { emptySlots, Slots } from "./schema";
import { ToolRunnerService, ToolRunSideEffects } from "./tool-runner.service";

export type AgentTurnResult = {
  reply: string;
  confirm: ChatConfirmAction | null;
  pending: ChatConfirmAction | null;
  executed: unknown;
  citations: string[];
  slots: Slots;
  intent: string;
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
- Nếu nháp nói ĐÃ tạo/gửi/duyệt thành công: giữ đúng ý đó, nhắc xem tab Kết quả. KHÔNG đổi thành "đang xử lý / sẽ thông báo sau".
- Nếu nháp đang MỜI xác nhận: kết thúc bằng lời mời xác nhận, chưa nói đã gửi/đã duyệt.
- Nếu nháp là lỗi / thiếu thông tin: giữ đúng, không bịa đã thành công.
- CẤM nói đã duyệt/đã gửi nếu nháp chỉ là danh sách đơn hoặc đề xuất chờ xác nhận.
- CẤM đổi ngày/loại phép/tên người so với nháp (ví dụ nháp là 06/09 phép ốm thì không viết thành 08/09 phép năm).

Giữ nguyên số liệu, ngày, mã đơn, kết luận từ nháp.
2–8 câu; được xuống dòng và gạch đầu dòng bằng "- ".
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
  }): Promise<AgentTurnResult> {
    const { message, actor, onProgress } = input;
    const slots = input.slots ?? emptySlots();
    const pending = input.pending;

    const g = this.guard.check(message);
    if (!g.ok) {
      const reply = await this.phraseStream(g.reason, message, onProgress);
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
      if (decision.didMutate) {
        const reply = await this.phraseStream(
          decision.toolSummary || decision.draft || "Đã xử lý xong trên hệ thống.",
          message,
          onProgress,
          { mustKeepSuccess: true },
        );
        return {
          reply,
          confirm: null,
          pending: null,
          executed: decision.executed,
          citations: decision.citations,
          slots: decision.slots,
          intent: "",
        };
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
      return {
        reply,
        confirm: run.confirm,
        pending: run.confirm,
        executed: run.preview ?? null,
        citations: run.citations,
        slots: run.slots,
        intent: input.intent ?? "",
      };
    }

    const draft = run.didMutate
      ? run.toolSummary || run.draft || "Đã xử lý xong trên hệ thống."
      : run.toolSummary ||
        run.draft ||
        "Mình chưa gọi được đủ thông tin để trả lời. Bạn mô tả lại giúp mình được không?";

    const reply = await this.phraseStream(draft, message, onProgress, {
      mustKeepSuccess: run.didMutate,
      forbidFakeSuccess: !run.didMutate,
    });

    return {
      reply,
      confirm: null,
      pending: run.didMutate ? null : run.confirm ?? run.pending ?? pending,
      executed: run.didMutate ? run.executed : run.preview ?? null,
      citations: run.citations,
      slots: run.slots,
      intent: input.intent ?? "",
    };
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
    };

    const messages: ChatMessage[] = input.seedMessages
      ? [...input.seedMessages]
      : [
          { role: "system", content: buildSystemPrompt(input.actor) },
          ...historyToMessages(input.history),
          {
            role: "system",
            content: `Ngữ cảnh phiên: listedIds=${slots.listedIds ?? "null"}; role=${input.actor.role}; employeeCode=${input.actor.employeeCode}; hasPending=${Boolean(pending)}.`,
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
            input.onProgress?.("status", { label: statusLabel(tc.function.name) });
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
            });
            const parsed = readToolPayload(run.content);
            if (parsed.askUser) state.askUser = parsed.askUser;
            if (parsed.summary) state.toolSummary = parsed.summary;
            if (parsed.cancelled) state.didCancel = true;
            if (tc.function.name === "confirm_pending_action" && parsed.ok) {
              pending = null;
              state.confirm = null;
              state.didMutate = true;
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
          continue;
        }

        state.draft = sanitizeReply(result.content);
        if (state.draft) break;
      }
    } catch (e) {
      this.log.error(`Tool loop failed: ${String(e)}`);
      state.draft =
        e instanceof Error
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
    },
  ): Promise<string> {
    const factDraft = sanitizeReply(draft) || draft.trim();
    if (!factDraft) return factDraft;

    onProgress?.("status", { label: "Đang soạn trả lời…" });
    let system = PHRASE_SYSTEM;
    if (opts?.mustKeepSuccess) {
      system = `${PHRASE_SYSTEM}\nNháp này là KẾT QUẢ ĐÃ THỰC THI thành công. Nói rõ đã xong, mời xem tab Kết quả. Cấm "đang xử lý/sẽ báo sau".`;
    } else if (opts?.mustInviteConfirm) {
      system = `${PHRASE_SYSTEM}\nNháp đang MỜI XÁC NHẬN trước khi ghi hệ thống.
Viết lại tự nhiên, gần gũi như đồng nghiệp (2–6 câu).
Giữ đủ: số đơn, tên người, loại phép, ngày (có thể viết 8/9 thay 2026-09-08).
Bỏ giọng báo cáo ("Theo trạng thái", "Theo loại", "Có N đơn khớp").
Kết thúc bằng lời mời xác nhận. CẤM nói đã duyệt/đã gửi/đã tạo.`;
    } else if (opts?.forbidFakeSuccess) {
      system = `${PHRASE_SYSTEM}\nNháp CHƯA phải kết quả đã ghi hệ thống. CẤM nói đã gửi/đã tạo/đã duyệt thành công. Nếu thiếu tool/xác nhận thì hỏi lại.`;
    }
    const messages = [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify({ userMessage, factDraft }) },
    ];

    try {
      if (!onProgress) {
        const text = await this.llm.complete(messages, { temperature: 0.45, max_tokens: 450 });
        return sanitizeReply(text) || factDraft;
      }
      let full = "";
      for await (const piece of this.llm.completeStream(messages, {
        temperature: 0.45,
        max_tokens: 450,
      })) {
        full += piece;
        onProgress("token", { text: piece });
      }
      return sanitizeReply(stripThink(full)) || factDraft;
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

  return `Bạn là M-Mate — trợ lý AI dành cho CBNV MSB, chỉ có trên M-Connect.
Bạn hỗ trợ thực thi nghiệp vụ (nghỉ phép, công tác, tra cứu/phê duyệt, quy định).

Giọng: xưng "mình", gọi "bạn". Text thuần, không markdown, không enum với user.
Người dùng: ${actor.employeeCode}, vai trò ${actor.role === "MANAGER" ? "quản lý" : "nhân viên"}.

NGÀY (Asia/Ho_Chi_Minh): hôm nay ${hômNay}.
- hôm nay=${hômNay}; hôm qua=${hômQua}; ngày mai=${ngàyMai}; ngày kia=${ngàyKia}
- tháng này: from=${monthStart}, to=${monthEnd}
- Khi lọc/duyệt đơn đã có: “6/9” hoặc “ngày 6/9” → from=to=năm hiện tại-09-06 (không đổi sang ngày khác, không nhảy năm).

QUYẾT ĐỊNH BẰNG TOOL:
- Hiểu ý user tự nhiên (oke/đồng ý/xác nhận… = đồng ý; không/thôi/hủy = từ chối).
- Có pending + user đồng ý → confirm_pending_action. Có pending + từ chối → cancel_pending_action.
- Yêu cầu TẠO / DUYỆT / HỦY mới (chưa phải câu xác nhận) → chỉ gọi propose_*, rồi mời xác nhận. KHÔNG gọi confirm_pending_action trong cùng lượt.
- Duyệt đơn: truyền đúng employeeHint + from/to theo đúng ngày user nói. Ví dụ “duyệt đơn Minh ngày 6/9” → employeeHint=Minh, from và to = ngày 6/9. Không lấy nhầm đơn ngày khác. Không bịa “đơn 8/9 tương ứng 6/9”.
- Nếu tool báo không khớp bộ lọc: nói rõ và liệt kê đơn chờ, hỏi lại — không chọn đơn khác thay thế.
- Cấm nói đã gửi/tạo/duyệt thành công nếu chưa có kết quả ok từ confirm_pending_action.
- Thiếu thông tin → hỏi. Số liệu thật → get_leave_balance / list_pending_approvals / list_leaves / list_trips / search_policy.
- “Đơn cần duyệt / chờ duyệt / có đơn nào để duyệt” (không nói rõ loại): CHỈ gọi list_pending_approvals — tool này đã gồm cả nghỉ phép + công tác. CẤM chỉ gọi list_trips hoặc chỉ list_leaves.
- User nói rõ “nghỉ phép” → list_leaves. User nói rõ “công tác” → list_trips.
- Duyệt công tác → propose_approve_trips / propose_reject_trips. Duyệt nghỉ phép → propose_approve_leaves / propose_reject_leaves.
- STAFF không xem/duyệt đơn người khác. MANAGER duyệt team.
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

function done(
  reply: string,
  extra: Partial<AgentTurnResult> & { slots: Slots },
): AgentTurnResult {
  return {
    reply,
    confirm: extra.confirm ?? null,
    pending: extra.pending ?? null,
    executed: extra.executed ?? null,
    citations: extra.citations ?? [],
    slots: extra.slots,
    intent: extra.intent ?? "",
  };
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
  ok?: boolean;
  cancelled?: boolean;
} {
  try {
    const parsed = JSON.parse(toolContent) as {
      askUser?: string;
      summary?: string;
      ok?: boolean;
      cancelled?: boolean;
    };
    return {
      askUser: parsed.askUser ? String(parsed.askUser) : undefined,
      summary: parsed.summary ? String(parsed.summary) : undefined,
      ok: parsed.ok,
      cancelled: parsed.cancelled,
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
