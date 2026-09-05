import { Injectable, Logger } from "@nestjs/common";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { ChatConfirmAction, LeaveType } from "@msb/shared";
import { Actor } from "../auth/jwt-auth.guard";
import { ExtractService } from "./extract.service";
import { InputGuardService } from "./input-guard.service";
import {
  applyMessageHints,
  emptySlots,
  mergeSlots,
  missingFor,
  resolveIntent,
  Slots,
} from "./schema";
import {
  applyQueryToSlots,
  describeLeaveQuery,
  leaveQueryActive,
  looksLikeLeaveApprove,
  looksLikeLeaveCreate,
  looksLikeLeaveInfo,
  parseLeaveQuery,
  parseListedIds,
  pickByOrdinal,
  queryFromSlots,
} from "./leave-query";
import { validateLeave, validateTrip } from "@msb/policy-docs";
import { PolicyRagService } from "../policy/policy-rag.service";
import {
  applyOrdinal,
  filterLeaves,
  filterPendingLeaves,
  formatLeaveList,
  HrToolsService,
  summarizePendingLeaves,
} from "../hr/hr-tools.service";
import { explainHrError } from "../hr/explain-error";

export type GraphState = {
  message: string;
  actor: Actor;
  slots: Slots;
  intent: string;
  pending: ChatConfirmAction | null;
  history: string[];
  route: string;
  reply: string;
  confirm: ChatConfirmAction | null;
  executed: unknown;
  citations: string[];
  extractedConfirm: boolean;
  extractedCancel: boolean;
};

const State = Annotation.Root({
  message: Annotation<string>(),
  actor: Annotation<Actor>(),
  slots: Annotation<Slots>(),
  intent: Annotation<string>(),
  pending: Annotation<ChatConfirmAction | null>(),
  history: Annotation<string[]>({
    reducer: (_a, b) => b,
    default: () => [],
  }),
  route: Annotation<string>(),
  reply: Annotation<string>(),
  confirm: Annotation<ChatConfirmAction | null>(),
  executed: Annotation<unknown>(),
  citations: Annotation<string[]>({
    reducer: (_a, b) => b,
    default: () => [],
  }),
  extractedConfirm: Annotation<boolean>(),
  extractedCancel: Annotation<boolean>(),
});

@Injectable()
export class AgentGraphService {
  private readonly log = new Logger(AgentGraphService.name);
  private readonly compiled;

  constructor(
    private readonly extract: ExtractService,
    private readonly guard: InputGuardService,
    private readonly rag: PolicyRagService,
    private readonly tools: HrToolsService,
  ) {
    this.compiled = this.build();
  }

  private build() {
    return new StateGraph(State)
      .addNode("extract", (s) => this.extractNode(s))
      .addNode("refuse", (s) => this.refuseNode(s))
      .addNode("ask", (s) => this.askNode(s))
      .addNode("rag", (s) => this.ragNode(s))
      .addNode("read", (s) => this.readNode(s))
      .addNode("hitl", (s) => this.confirmNode(s))
      .addNode("run_tools", (s) => this.executeNode(s))
      .addEdge(START, "extract")
      .addConditionalEdges("extract", (s) => s.route, {
        refuse: "refuse",
        ask: "ask",
        rag: "rag",
        read: "read",
        confirm: "hitl",
        execute: "run_tools",
        smalltalk: "ask",
      })
      .addEdge("refuse", END)
      .addEdge("ask", END)
      .addEdge("rag", END)
      .addEdge("read", END)
      .addEdge("hitl", END)
      .addEdge("run_tools", END)
      .compile();
  }

  invoke(input: {
    message: string;
    actor: Actor;
    slots: Slots;
    intent?: string;
    pending: ChatConfirmAction | null;
    history: string[];
  }) {
    return this.compiled.invoke({
      message: input.message,
      actor: input.actor,
      slots: input.slots,
      intent: input.intent ?? "",
      pending: input.pending,
      history: input.history,
      route: "ask",
      reply: "",
      confirm: null,
      executed: null,
      citations: [],
      extractedConfirm: false,
      extractedCancel: false,
    }) as Promise<GraphState>;
  }

  private async extractNode(s: typeof State.State): Promise<Partial<GraphState>> {
    const g = this.guard.check(s.message);
    if (!g.ok) {
      return { route: "refuse", reply: g.reason, confirm: null, pending: s.pending };
    }
    if (this.guard.looksLikeForeignAccess(s.message) && s.actor.role === "STAFF") {
      return {
        route: "refuse",
        reply:
          "Bạn chỉ được xem và tạo đơn của chính mình. Tôi không thể truy xuất nghỉ phép của nhân viên khác.",
        confirm: null,
      };
    }

    if (s.pending && isConfirmPhrase(s.message)) {
      return { route: "execute", pending: s.pending, extractedConfirm: true };
    }
    if (s.pending && isCancelPhrase(s.message)) {
      return {
        route: "ask",
        pending: null,
        confirm: null,
        reply: "Đã hủy thao tác đang chờ xác nhận.",
        ...(s.pending.tool === "approve_leaves"
          ? {
              intent: "",
              slots: { ...emptySlots(), listedIds: s.slots.listedIds },
            }
          : {}),
      };
    }

    let extracted;
    try {
      extracted = await this.extract.extract(s.message, s.slots, s.history);
    } catch (e) {
      this.log.error(`LLM extract failed: ${String(e)}`);
      return {
        route: "refuse",
        reply: e instanceof Error ? e.message : "Không gọi được model AI. Thử lại sau.",
        confirm: null,
      };
    }
    let slots = applyMessageHints(s.message, mergeSlots(s.slots, extracted.slots));
    const intent = (() => {
      const resolved = resolveIntent(s.intent, extracted.intent, slots);
      if (s.actor.role === "MANAGER" && looksLikeLeaveApprove(s.message)) {
        const q = parseLeaveQuery(s.message);
        if (q.status && q.status !== "PENDING") return "leave_list";
        return "leave_approve";
      }
      if (
        !looksLikeLeaveCreate(s.message) &&
        (looksLikeLeaveInfo(s.message) || leaveQueryActive(parseLeaveQuery(s.message)))
      ) {
        return "leave_list";
      }
      if (
        looksLikeLeaveInfo(s.message) &&
        looksLikeLeaveCreate(s.message) &&
        /xem|thông tin|danh sách|các đơn|đơn của/.test(s.message)
      ) {
        return "leave_list";
      }
      return resolved;
    })();
    if (intent === "leave_approve" || intent === "leave_list") {
      const q = parseLeaveQuery(s.message, {
        leaveType: extracted.slots.leaveType,
        employeeHint: extracted.slots.employeeHint ?? extracted.otherEmployeeHint,
        from: extracted.slots.from,
        to: extracted.slots.to,
        leaveId: extracted.slots.leaveId,
        status: extracted.slots.status,
        reasonHint: extracted.slots.reason,
        daysHint: extracted.slots.daysHint,
        ordinal: extracted.slots.ordinal,
      });
      slots = { ...applyQueryToSlots(slots, q), listedIds: s.slots.listedIds };
    } else if (s.intent === "leave_approve" || s.intent === "leave_list") {
      slots = applyMessageHints(
        s.message,
        mergeSlots(
          {
            ...emptySlots(),
            listedIds: s.slots.listedIds,
            destination: s.slots.destination,
            purpose: s.slots.purpose,
            tripId: s.slots.tripId,
          },
          extracted.slots,
        ),
      );
    }

    if (extracted.asksOtherEmployee && s.actor.role === "STAFF") {
      return {
        route: "refuse",
        slots,
        intent: "out_of_scope",
        reply:
          "Yêu cầu này vượt quyền. Nhân viên không được xem dữ liệu nhân sự của người khác.",
      };
    }

    if (s.pending && extracted.isCancellation) {
      return {
        route: "ask",
        pending: null,
        confirm: null,
        reply: "Đã hủy thao tác đang chờ xác nhận.",
        ...(s.pending.tool === "approve_leaves"
          ? {
              intent: "",
              slots: { ...emptySlots(), listedIds: slots.listedIds },
            }
          : { slots }),
      };
    }

    if (s.pending && extracted.isConfirmation) {
      return {
        route: "execute",
        slots,
        intent: extracted.intent,
        pending: s.pending,
        extractedConfirm: true,
      };
    }

    if (intent === "out_of_scope") {
      return {
        route: "refuse",
        slots,
        intent,
        reply:
          "Tôi chỉ hỗ trợ nghiệp vụ nhân sự nội bộ: nghỉ phép, công tác và quy định liên quan. Không truy xuất thông tin ngoài phạm vi của bạn.",
      };
    }
    if (intent === "policy_qa") return { route: "rag", slots, intent };
    if (["leave_list", "leave_balance", "trip_list"].includes(intent)) {
      return { route: "read", slots, intent };
    }

    const missing = missingFor(intent, slots);
    if (missing.length) {
      return { route: "ask", slots, intent, pending: s.pending };
    }
    if (intent === "leave_approve") {
      if (s.actor.role !== "MANAGER") {
        return {
          route: "refuse",
          slots,
          intent,
          reply: "Chỉ quản lý được phê duyệt đơn nghỉ phép của nhân viên thuộc team.",
        };
      }
      return { route: "confirm", slots, intent };
    }
    if (intent === "leave_create" || intent === "trip_create" || intent === "leave_cancel") {
      return { route: "confirm", slots, intent };
    }
    return {
      route: "ask",
      slots,
      intent,
      reply:
        extracted.replyHint ??
        "Bạn cần hỗ trợ xin nghỉ phép, xin công tác, xem đơn, hay hỏi quy định?",
    };
  }

  private refuseNode(s: typeof State.State): Partial<GraphState> {
    return { reply: s.reply || "Không thể thực hiện yêu cầu này.", confirm: null };
  }

  private askNode(s: typeof State.State): Partial<GraphState> {
    if (s.reply) return { reply: s.reply, confirm: null, pending: s.pending };
    const missing = missingFor(s.intent, s.slots);
    if (missing.length) {
      return {
        reply: `Để hoàn tất, mình còn thiếu: ${missing.join(", ")}. Bạn cung cấp giúp nhé.`,
        confirm: null,
      };
    }
    return {
      reply: "Mình có thể giúp xin nghỉ phép, xin công tác, xem đơn, giải thích quy định, hoặc (nếu bạn là quản lý) phê duyệt đơn team.",
      confirm: null,
    };
  }

  private ragNode(s: typeof State.State): Partial<GraphState> {
    const chunks = this.rag.retrieve(s.message);
    const body = this.rag.format(chunks);
    return {
      reply: `Theo quy định nội bộ (bản demo):\n\n${body}`,
      citations: chunks.map((c) => c.title),
      confirm: null,
    };
  }

  private async readNode(s: typeof State.State): Promise<Partial<GraphState>> {
    try {
      if (s.intent === "leave_balance") {
        const b = (await this.tools.balance(s.actor)) as {
          annualRemaining: number;
          annualTotal: number;
          sickRemaining: number;
        };
        return {
          reply: `Số dư phép của bạn: phép năm ${b.annualRemaining}/${b.annualTotal} ngày, phép ốm còn khung ${b.sickRemaining} ngày.`,
          executed: b,
        };
      }
      const scope = s.actor.role === "STAFF" ? "me" : "team";
      if (s.intent === "trip_list") {
        const rows = await this.tools.listTrips(s.actor, scope);
        return {
          reply: `Đã lấy danh sách công tác (${scope}). Xem tab Kết quả để thấy chi tiết.`,
          executed: rows,
        };
      }
      const rows = await this.tools.listLeaves(s.actor, scope);
      const q = queryFromSlots(s.slots);
      if (
        s.actor.role === "STAFF" &&
        q.employeeHint &&
        /^EMP/i.test(q.employeeHint) &&
        q.employeeHint.toUpperCase() !== s.actor.employeeCode
      ) {
        return {
          reply: "Bạn chỉ được xem đơn nghỉ phép của chính mình.",
          confirm: null,
        };
      }
      const filtered = filterLeaves(rows, { ...q, ordinal: null });
      const matched = q.ordinal ? applyOrdinal(filtered, q.ordinal) : filtered;
      const scopeNote = leaveQueryActive({ ...q, ordinal: q.ordinal })
        ? describeLeaveQuery(q)
        : undefined;
      if (!matched.length) {
        const { stats: allStats } = formatLeaveList(rows);
        const missOrd = Boolean(q.ordinal && filtered.length && !matched.length);
        return {
          reply: missOrd
            ? `Không có đơn thứ ${q.ordinal} trong ${filtered.length} đơn khớp bộ lọc. Bạn chọn lại số thứ tự hoặc mô tả đơn khác.`
            : `Không có đơn khớp${scopeNote ? ` (${scopeNote})` : ""}.\n\nHiện có:\n${allStats}`,
          executed: rows,
          slots: { ...s.slots, listedIds: rows.map((r) => String(r._id ?? r.id)).join(",") },
        };
      }
      const { stats, ids } = formatLeaveList(matched, scopeNote);
      const hint =
        s.actor.role === "MANAGER"
          ? "\n\nMuốn phê duyệt thì nói rõ phạm vi (theo người, ngày, loại phép, lý do) hoặc “duyệt đơn thứ N” theo danh sách trên."
          : "\n\nBạn xem tab Kết quả để thấy chi tiết.";
      return {
        reply: `${stats}${hint}`,
        executed: matched,
        slots: { ...s.slots, listedIds: ids.join(",") },
      };
    } catch (e) {
      return { reply: explainHrError(e) };
    }
  }

  private async confirmNode(s: typeof State.State): Promise<Partial<GraphState>> {
    if (s.intent === "leave_create") {
      let remaining: number | undefined;
      try {
        const b = (await this.tools.balance(s.actor)) as { annualRemaining: number };
        remaining = b.annualRemaining;
      } catch (e) {
        this.log.warn(String(e));
      }
      const verdict = validateLeave({
        type: s.slots.leaveType as LeaveType,
        from: s.slots.from!,
        to: s.slots.to!,
        annualRemaining: remaining,
      });
      if (!verdict.allowed) {
        return {
          reply: `Không thể tạo đơn vì trái quy định:\n- ${verdict.reasons.join("\n- ")}\n\nCăn cứ: ${verdict.citations.join(", ")}\n\nĐơn chưa được tạo nên không cần mã đơn. Bạn có thể đổi loại phép, ngày bắt đầu/kết thúc hoặc lý do để mình xét lại.`,
          citations: verdict.citations,
          confirm: null,
          pending: null,
          intent: "leave_create",
          slots: s.slots,
        };
      }
      if ((s.slots.reason ?? "").trim().length < 3) {
        return {
          reply: `Lý do nghỉ phép "${s.slots.reason ?? ""}" quá ngắn (cần ít nhất 3 ký tự). Bạn viết rõ hơn giúp mình, ví dụ: ốm đau, khám bệnh, việc gia đình.`,
          confirm: null,
          pending: null,
          intent: "leave_create",
          slots: s.slots,
        };
      }
      const action: ChatConfirmAction = {
        tool: "create_leave",
        args: {
          type: s.slots.leaveType,
          from: s.slots.from,
          to: s.slots.to,
          reason: s.slots.reason,
        },
        summary: `Tạo nghỉ phép ${s.slots.leaveType} từ ${s.slots.from} đến ${s.slots.to} (lý do: ${s.slots.reason})`,
      };
      return {
        confirm: action,
        pending: action,
        citations: verdict.citations,
        reply: `${action.summary}. Xác nhận để gửi đơn?`,
      };
    }
    if (s.intent === "trip_create") {
      const verdict = validateTrip({
        from: s.slots.from!,
        to: s.slots.to!,
        purpose: s.slots.purpose!,
        destination: s.slots.destination!,
      });
      if (!verdict.allowed) {
        return {
          reply: `Không thể tạo công tác vì trái quy định:\n- ${verdict.reasons.join("\n- ")}`,
          citations: verdict.citations,
          confirm: null,
          pending: null,
        };
      }
      const action: ChatConfirmAction = {
        tool: "create_trip",
        args: {
          destination: s.slots.destination,
          from: s.slots.from,
          to: s.slots.to,
          purpose: s.slots.purpose,
        },
        summary: `Tạo công tác ${s.slots.destination} từ ${s.slots.from} đến ${s.slots.to}`,
      };
      return {
        confirm: action,
        pending: action,
        reply: `${action.summary}. Xác nhận để gửi đơn?`,
      };
    }
    if (s.intent === "leave_cancel" && s.slots.leaveId) {
      const action: ChatConfirmAction = {
        tool: "cancel_leave",
        args: { id: s.slots.leaveId },
        summary: `Hủy đơn nghỉ phép ${s.slots.leaveId}`,
      };
      return { confirm: action, pending: action, reply: `${action.summary}. Xác nhận?` };
    }
    if (s.intent === "leave_approve") {
      try {
        const rows = await this.tools.listLeaves(s.actor, "team");
        const allPending = summarizePendingLeaves(rows).pending;
        if (!allPending.length) {
          return {
            reply: "Hiện team không có đơn nghỉ phép nào đang chờ duyệt.",
            confirm: null,
            pending: null,
            executed: rows,
          };
        }
        const q = queryFromSlots(s.slots);
        if (q.status && q.status !== "PENDING") {
          return {
            reply: `Chỉ phê duyệt được đơn đang chờ. Bộ lọc đang là ${describeLeaveQuery(q)}. Bạn xem thông tin đơn đó trước, hoặc duyệt các đơn chờ khớp phạm vi khác.`,
            confirm: null,
            pending: null,
            executed: rows,
          };
        }
        const qNoOrd = { ...q, ordinal: null, status: null };
        const listed = parseListedIds(s.slots.listedIds);
        let scoped;
        if (q.ordinal && !leaveQueryActive(qNoOrd) && listed.length) {
          const picked = pickByOrdinal(listed, q.ordinal);
          scoped = allPending.filter((r) => picked.includes(String(r._id ?? r.id)));
        } else {
          scoped = leaveQueryActive(qNoOrd)
            ? filterPendingLeaves(allPending, qNoOrd)
            : allPending;
          if (q.ordinal) scoped = applyOrdinal(scoped, q.ordinal);
        }
        const scopeNote = leaveQueryActive(q) ? describeLeaveQuery(q) : undefined;
        if (!scoped.length) {
          const { stats: allStats } = summarizePendingLeaves(allPending);
          const missOrd = Boolean(q.ordinal);
          return {
            reply: missOrd
              ? `Không chọn được đơn thứ ${q.ordinal} trong danh sách đang chờ. Bạn xem lại danh sách hoặc mô tả đơn (người, ngày, loại phép).\n\n${allStats}`
              : `Không có đơn chờ duyệt khớp bộ lọc${scopeNote ? ` (${scopeNote})` : ""}.\n\nĐơn đang chờ của team:\n${allStats}\n\nBạn mô tả lại (theo người, loại phép, ngày, lý do) hoặc nói duyệt tất cả.`,
            confirm: null,
            pending: null,
            executed: allPending,
            slots: {
              ...s.slots,
              listedIds: allPending.map((r) => String(r._id ?? r.id)).join(","),
            },
          };
        }
        const { ids, stats } = formatLeaveList(scoped, scopeNote);
        const summary = scopeNote
          ? `Phê duyệt ${ids.length} đơn (${scopeNote})`
          : `Phê duyệt tất cả ${ids.length} đơn nghỉ phép đang chờ của team`;
        const action: ChatConfirmAction = {
          tool: "approve_leaves",
          args: { ids },
          summary,
        };
        const ask = scopeNote
          ? `Bạn xác nhận phê duyệt ${ids.length} đơn này (các đơn khác vẫn chờ)?`
          : `Bạn xác nhận phê duyệt tất cả ${ids.length} đơn này chứ?`;
        return {
          confirm: action,
          pending: action,
          executed: scoped,
          reply: `${stats}\n\n${ask}`,
          slots: { ...s.slots, listedIds: ids.join(",") },
        };
      } catch (e) {
        return { reply: explainHrError(e), confirm: null, pending: null };
      }
    }
    return { reply: "Chưa đủ dữ liệu để xác nhận.", confirm: null };
  }

  private async executeNode(s: typeof State.State): Promise<Partial<GraphState>> {
    const action = s.pending;
    if (!action) return { reply: "Không có thao tác nào đang chờ xác nhận." };
    try {
      let executed: unknown;
      if (action.tool === "create_leave") {
        executed = await this.tools.createLeave(
          s.actor,
          action.args as { type: string; from: string; to: string; reason: string },
        );
      } else if (action.tool === "create_trip") {
        executed = await this.tools.createTrip(
          s.actor,
          action.args as { destination: string; from: string; to: string; purpose: string },
        );
      } else if (action.tool === "cancel_leave") {
        executed = await this.tools.cancelLeave(s.actor, String(action.args.id));
      } else if (action.tool === "approve_leaves") {
        const ids = (action.args.ids as string[]) ?? [];
        executed = await this.tools.approveLeaves(s.actor, ids);
        const count =
          executed && typeof executed === "object" && "count" in executed
            ? Number((executed as { count: number }).count)
            : ids.length;
        return {
          reply: `Đã phê duyệt ${count} đơn nghỉ phép của team. Bạn xem tab Kết quả để kiểm tra.`,
          executed,
          pending: null,
          confirm: null,
          slots: emptySlots(),
        };
      } else {
        return { reply: `Tool ${action.tool} chưa được hỗ trợ.`, pending: null };
      }
      return {
        reply: `Đã thực thi: ${action.summary}. Bạn xem tab Kết quả để kiểm tra.`,
        executed,
        pending: null,
        confirm: null,
        slots: emptySlots(),
      };
    } catch (e) {
      return {
        reply: explainHrError(e),
        pending: null,
        confirm: null,
      };
    }
  }
}

function isConfirmPhrase(message: string) {
  return /đồng ý|xác nhận|^ok\b|^oke\b|confirm/i.test(message.trim());
}

function isCancelPhrase(message: string) {
  return /^(không|hủy|huỷ|thôi|cancel)\b/i.test(message.trim());
}
