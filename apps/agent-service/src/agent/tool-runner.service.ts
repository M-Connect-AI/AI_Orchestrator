import { Injectable, Logger } from "@nestjs/common";
import { ChatConfirmAction, LeaveType, RequestStatus } from "@msb/shared";
import { validateLeave, validateTrip } from "@msb/policy-docs";
import { Actor } from "../auth/jwt-auth.guard";
import {
  applyOrdinal,
  filterLeaves,
  filterPendingLeaves,
  formatLeaveList,
  formatTripList,
  friendlyConfirmAsk,
  friendlyTripConfirmAsk,
  HrToolsService,
  LeaveRow,
  matchEmployee,
  summarizePendingLeaves,
  TripRow,
} from "../hr/hr-tools.service";
import { explainHrError } from "../hr/explain-error";
import { PolicyRagService } from "../policy/policy-rag.service";
import {
  describeLeaveQuery,
  leaveQueryActive,
  LeaveQuery,
  overlapsDayRange,
  parseListedIds,
  pickByOrdinal,
} from "./leave-query";
import { emptySlots, normalizeVnDate, Slots } from "./schema";

export type ToolRunContext = {
  actor: Actor;
  slots: Slots;
  pending: ChatConfirmAction | null;
};

export type ToolRunSideEffects = {
  confirm: ChatConfirmAction | null;
  pending: ChatConfirmAction | null;
  /** Kết quả ghi thật (sau confirm_pending). */
  executed: unknown;
  /** Dữ liệu xem/preview (list / đề xuất) — KHÔNG phải đã ghi hệ thống. */
  preview: unknown;
  /** true chỉ khi đã mutate HR (create/approve/…). */
  mutated: boolean;
  citations: string[];
  slots: Slots;
};

export type ToolRunResult = {
  content: string;
  effects: Partial<ToolRunSideEffects>;
};

@Injectable()
export class ToolRunnerService {
  private readonly log = new Logger(ToolRunnerService.name);

  constructor(
    private readonly tools: HrToolsService,
    private readonly rag: PolicyRagService,
  ) {}

  async run(name: string, rawArgs: string, ctx: ToolRunContext): Promise<ToolRunResult> {
    let args: Record<string, unknown> = {};
    try {
      args = rawArgs?.trim() ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
    } catch {
      return {
        content: JSON.stringify({ ok: false, error: "Tham số tool không phải JSON hợp lệ." }),
        effects: {},
      };
    }
    try {
      switch (name) {
        case "get_leave_balance":
          return this.getBalance(ctx);
        case "list_pending_approvals":
          return this.listPendingApprovals(ctx);
        case "list_leaves":
          return this.listLeaves(args, ctx);
        case "list_trips":
          return this.listTrips(args, ctx);
        case "search_policy":
          return await this.searchPolicy(args);
        case "propose_create_leave":
          return this.proposeCreateLeave(args, ctx);
        case "propose_create_trip":
          return this.proposeCreateTrip(args, ctx);
        case "propose_cancel_leave":
          return this.proposeCancelLeave(args);
        case "propose_update_leave":
          return this.proposeUpdateLeave(args, ctx);
        case "propose_approve_leaves":
          return this.proposeApproveLeaves(args, ctx);
        case "propose_reject_leaves":
          return this.proposeRejectLeaves(args, ctx);
        case "propose_approve_trips":
          return this.proposeApproveTrips(args, ctx);
        case "propose_reject_trips":
          return this.proposeRejectTrips(args, ctx);
        case "confirm_pending_action":
          return this.confirmPending(ctx);
        case "cancel_pending_action":
          return this.cancelPending(ctx);
        default:
          return {
            content: JSON.stringify({ ok: false, error: `Không có tool ${name}` }),
            effects: {},
          };
      }
    } catch (e) {
      this.log.warn(`Tool ${name} failed: ${String(e)}`);
      return {
        content: JSON.stringify({ ok: false, error: explainHrError(e) }),
        effects: {},
      };
    }
  }

  async executePending(
    actor: Actor,
    action: ChatConfirmAction,
  ): Promise<{ reply: string; executed: unknown; slots: Slots }> {
    try {
      let executed: unknown;
      if (action.tool === "create_leave") {
        executed = await this.tools.createLeave(
          actor,
          action.args as { type: string; from: string; to: string; reason: string },
        );
      } else if (action.tool === "create_trip") {
        executed = await this.tools.createTrip(
          actor,
          action.args as { destination: string; from: string; to: string; purpose: string },
        );
      } else if (action.tool === "cancel_leave") {
        executed = await this.tools.cancelLeave(actor, String(action.args.id));
      } else if (action.tool === "update_leave") {
        const { id, ...dto } = action.args as { id: string } & Record<string, unknown>;
        executed = await this.tools.updateLeave(actor, String(id), dto);
      } else if (action.tool === "approve_leaves") {
        const ids = (action.args.ids as string[]) ?? [];
        executed = await this.tools.approveLeaves(actor, ids);
        const count =
          executed && typeof executed === "object" && "count" in executed
            ? Number((executed as { count: number }).count)
            : ids.length;
        const items =
          executed && typeof executed === "object" && "items" in executed
            ? (executed as { items: LeaveRow[] }).items
            : [];
        const detail = items.length
          ? formatLeaveList(items as LeaveRow[]).stats
          : `Đã phê duyệt ${count} đơn (ids: ${ids.join(", ")}).`;
        return {
          reply: `${detail}\n\nĐã phê duyệt xong ${count} đơn. Bạn xem tab Kết quả để kiểm tra nhé.`,
          executed,
          slots: emptySlots(),
        };
      } else if (action.tool === "reject_leaves") {
        const ids = (action.args.ids as string[]) ?? [];
        executed = await this.tools.rejectLeaves(actor, ids);
        const count =
          executed && typeof executed === "object" && "count" in executed
            ? Number((executed as { count: number }).count)
            : ids.length;
        return {
          reply: `Đã từ chối ${count} đơn nghỉ phép. Bạn xem tab Kết quả để kiểm tra nhé.`,
          executed,
          slots: emptySlots(),
        };
      } else if (action.tool === "approve_trips") {
        const ids = (action.args.ids as string[]) ?? [];
        executed = await this.tools.approveTrips(actor, ids);
        const count =
          executed && typeof executed === "object" && "count" in executed
            ? Number((executed as { count: number }).count)
            : ids.length;
        return {
          reply: `Đã phê duyệt ${count} đơn công tác. Bạn xem tab Kết quả để kiểm tra nhé.`,
          executed,
          slots: emptySlots(),
        };
      } else if (action.tool === "reject_trips") {
        const ids = (action.args.ids as string[]) ?? [];
        executed = await this.tools.rejectTrips(actor, ids);
        const count =
          executed && typeof executed === "object" && "count" in executed
            ? Number((executed as { count: number }).count)
            : ids.length;
        return {
          reply: `Đã từ chối ${count} đơn công tác. Bạn xem tab Kết quả để kiểm tra nhé.`,
          executed,
          slots: emptySlots(),
        };
      } else {
        return {
          reply: `Thao tác ${action.tool} chưa được hỗ trợ.`,
          executed: null,
          slots: emptySlots(),
        };
      }
      return {
        reply: `Xong rồi — ${action.summary}. Bạn xem tab Kết quả để kiểm tra nhé.`,
        executed,
        slots: emptySlots(),
      };
    } catch (e) {
      return { reply: explainHrError(e), executed: null, slots: emptySlots() };
    }
  }

  private async confirmPending(ctx: ToolRunContext): Promise<ToolRunResult> {
    if (!ctx.pending) {
      return {
        content: JSON.stringify({
          ok: false,
          error:
            "Không có thao tác nào đang chờ xác nhận. Nếu user vừa đồng ý tạo đơn, hãy gọi propose_* với đủ thông tin từ hội thoại rồi gọi lại confirm_pending_action.",
        }),
        effects: {},
      };
    }
    const exec = await this.executePending(ctx.actor, ctx.pending);
    const ok = Boolean(exec.executed);
    return {
      content: JSON.stringify({
        ok,
        executed: ok,
        mutated: ok,
        summary: exec.reply,
        result: exec.executed,
      }),
      effects: {
        confirm: null,
        pending: null,
        executed: exec.executed,
        mutated: ok,
        slots: exec.slots,
      },
    };
  }

  private cancelPending(ctx: ToolRunContext): ToolRunResult {
    if (!ctx.pending) {
      return {
        content: JSON.stringify({
          ok: true,
          summary: "Không có thao tác nào đang chờ để hủy.",
        }),
        effects: { confirm: null, pending: null },
      };
    }
    const wasBatch =
      ctx.pending.tool === "approve_leaves" ||
      ctx.pending.tool === "reject_leaves" ||
      ctx.pending.tool === "approve_trips" ||
      ctx.pending.tool === "reject_trips";
    return {
      content: JSON.stringify({
        ok: true,
        cancelled: true,
        summary: "Đã hủy thao tác đang chờ xác nhận.",
      }),
      effects: {
        confirm: null,
        pending: null,
        slots: wasBatch
          ? { ...emptySlots(), listedIds: ctx.slots.listedIds }
          : ctx.slots,
      },
    };
  }

  private async getBalance(ctx: ToolRunContext): Promise<ToolRunResult> {
    const b = (await this.tools.balance(ctx.actor)) as {
      annualRemaining: number;
      annualTotal: number;
      sickRemaining: number;
    };
    return {
      content: JSON.stringify({
        ok: true,
        annualRemaining: b.annualRemaining,
        annualTotal: b.annualTotal,
        sickRemaining: b.sickRemaining,
        summary: `Phép năm còn ${b.annualRemaining}/${b.annualTotal} ngày; phép ốm còn khung ${b.sickRemaining} ngày.`,
      }),
      effects: { preview: b },
    };
  }

  /** Luôn lấy cả nghỉ phép + công tác PENDING — tránh model chỉ gọi một loại. */
  private async listPendingApprovals(ctx: ToolRunContext): Promise<ToolRunResult> {
    const scope = ctx.actor.role === "STAFF" ? "me" : "team";
    const [leaves, trips] = await Promise.all([
      this.tools.listLeaves(ctx.actor, scope),
      this.tools.listTrips(ctx.actor, scope),
    ]);
    const pendingLeaves = (leaves as LeaveRow[]).filter((r) => r.status === "PENDING");
    const pendingTrips = (trips as TripRow[]).filter((r) => r.status === "PENDING");
    const leavePart = pendingLeaves.length
      ? formatLeaveList(pendingLeaves, "nghỉ phép chờ duyệt").stats
      : "Không có đơn nghỉ phép chờ duyệt.";
    const tripPart = pendingTrips.length
      ? formatTripList(pendingTrips, "công tác chờ duyệt").stats
      : "Không có đơn công tác chờ duyệt.";
    const leaveIds = pendingLeaves.map((r) => String(r._id ?? r.id));
    const tripIds = pendingTrips.map((r) => String(r._id ?? r.id));
    const summary = [
      `Tổng chờ duyệt: ${pendingLeaves.length} nghỉ phép + ${pendingTrips.length} công tác.`,
      "",
      "— Nghỉ phép —",
      leavePart,
      "",
      "— Công tác —",
      tripPart,
    ].join("\n");
    return {
      content: JSON.stringify({
        ok: true,
        scope,
        leaveCount: pendingLeaves.length,
        tripCount: pendingTrips.length,
        leaveIds,
        tripIds,
        summary,
        hint:
          ctx.actor.role === "MANAGER"
            ? "Duyệt nghỉ phép → propose_approve_leaves; duyệt công tác → propose_approve_trips."
            : undefined,
      }),
      effects: {
        preview: { leaves: pendingLeaves, trips: pendingTrips },
        slots: {
          ...ctx.slots,
          listedIds: [...leaveIds, ...tripIds].join(","),
        },
      },
    };
  }

  private async listLeaves(
    args: Record<string, unknown>,
    ctx: ToolRunContext,
  ): Promise<ToolRunResult> {
    const scope = ctx.actor.role === "STAFF" ? "me" : "team";
    const rows = await this.tools.listLeaves(ctx.actor, scope);
    const q = argsToQuery(args);
    if (
      ctx.actor.role === "STAFF" &&
      q.employeeHint &&
      /^EMP/i.test(q.employeeHint) &&
      q.employeeHint.toUpperCase() !== ctx.actor.employeeCode
    ) {
      return {
        content: JSON.stringify({
          ok: false,
          error: "Bạn chỉ được xem đơn nghỉ phép của chính mình.",
        }),
        effects: {},
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
      const summary = missOrd
        ? `Không có đơn thứ ${q.ordinal} trong ${filtered.length} đơn khớp bộ lọc.`
        : `Không có đơn khớp${scopeNote ? ` (${scopeNote})` : ""}. Hiện có:\n${allStats}`;
      return {
        content: JSON.stringify({ ok: true, count: 0, summary, totalAvailable: rows.length }),
        effects: {
          preview: rows,
          slots: {
            ...ctx.slots,
            listedIds: rows.map((r) => String(r._id ?? r.id)).join(","),
          },
        },
      };
    }
    const { stats, ids } = formatLeaveList(matched, scopeNote);
    return {
      content: JSON.stringify({
        ok: true,
        count: matched.length,
        ids,
        summary: stats,
        hint:
          ctx.actor.role === "MANAGER"
            ? "Muốn duyệt thì gọi propose_approve_leaves với ids hoặc bộ lọc phù hợp."
            : "Chi tiết xem thêm ở tab Kết quả.",
      }),
      effects: {
        preview: matched,
        slots: { ...ctx.slots, listedIds: ids.join(",") },
      },
    };
  }

  private async listTrips(
    args: Record<string, unknown>,
    ctx: ToolRunContext,
  ): Promise<ToolRunResult> {
    const scope = ctx.actor.role === "STAFF" ? "me" : "team";
    const rows = await this.tools.listTrips(ctx.actor, scope);
    const status = String(args.status ?? "").trim().toUpperCase();
    const employeeHint = String(args.employeeHint ?? "").trim();
    const from =
      normalizeVnDate(String(args.from ?? ""), { rollPastToNextYear: false }) ??
      (String(args.from ?? "").trim() || null);
    const to =
      normalizeVnDate(String(args.to ?? ""), { rollPastToNextYear: false }) ??
      (String(args.to ?? "").trim() || null);

    let matched = rows as TripRow[];
    const notes: string[] = [];
    if (status && ["PENDING", "APPROVED", "REJECTED", "CANCELLED"].includes(status)) {
      matched = matched.filter((r) => r.status === status);
      notes.push(status === "PENDING" ? "đang chờ duyệt" : status.toLowerCase());
    }
    if (employeeHint) {
      matched = matched.filter((r) => matchEmployee(r as unknown as LeaveRow, employeeHint));
      notes.push(`nhân viên ~ ${employeeHint}`);
    }
    if (from || to) {
      const a = from ?? to!;
      const b = to ?? from!;
      matched = matched.filter((r) => overlapsDayRange(r.from, r.to, a, b));
      notes.push(`ngày ${a}${a !== b ? ` → ${b}` : ""}`);
    }

    const scopeNote = notes.length ? notes.join(", ") : undefined;
    if (!matched.length) {
      const { stats: allStats } = formatTripList(rows);
      return {
        content: JSON.stringify({
          ok: true,
          count: 0,
          summary: `Không có đơn công tác khớp${scopeNote ? ` (${scopeNote})` : ""}. Hiện có:\n${allStats}`,
          totalAvailable: rows.length,
        }),
        effects: { preview: rows },
      };
    }
    const { stats, ids, pending } = formatTripList(matched, scopeNote);
    return {
      content: JSON.stringify({
        ok: true,
        scope,
        count: matched.length,
        pendingCount: pending.length,
        ids,
        summary: stats,
        hint:
          ctx.actor.role === "MANAGER" && pending.length
            ? "Muốn duyệt công tác thì gọi propose_approve_trips với ids hoặc approveAll."
            : "Chi tiết xem thêm ở tab Kết quả.",
      }),
      effects: {
        preview: matched,
        slots: { ...ctx.slots, listedIds: ids.join(",") },
      },
    };
  }

  private async searchPolicy(args: Record<string, unknown>): Promise<ToolRunResult> {
    const query = String(args.query ?? "").trim();
    if (!query) {
      return {
        content: JSON.stringify({ ok: false, error: "Thiếu query quy định." }),
        effects: {},
      };
    }
    try {
      const chunks = await this.rag.retrieve(query);
      const body = this.rag.format(chunks);
      const citations = chunks.map((c) => `${c.title} (${c.source})`);
      return {
        content: JSON.stringify({
          ok: true,
          summary: body,
          citations,
        }),
        effects: { citations },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`search_policy failed: ${msg}`);
      return {
        content: JSON.stringify({
          ok: false,
          error:
            "Không tra cứu được quy định (Qdrant/embedding). Chạy `pnpm policy:ingest` sau khi Qdrant lên.",
        }),
        effects: {},
      };
    }
  }

  private async proposeCreateLeave(
    args: Record<string, unknown>,
    ctx: ToolRunContext,
  ): Promise<ToolRunResult> {
    const type = String(args.type ?? "") as LeaveType;
    const from = normalizeVnDate(String(args.from ?? ""), { rollPastToNextYear: true }) ?? String(args.from ?? "");
    const to = normalizeVnDate(String(args.to ?? ""), { rollPastToNextYear: true }) ?? String(args.to ?? "");
    const reason = String(args.reason ?? "").trim();
    if (!["ANNUAL", "SICK", "UNPAID"].includes(type) || !from || !to) {
      return {
        content: JSON.stringify({
          ok: false,
          error: "Thiếu hoặc sai loại phép / ngày. Cần type, from, to (YYYY-MM-DD), reason.",
        }),
        effects: {},
      };
    }
    if (reason.length < 3) {
      return {
        content: JSON.stringify({
          ok: false,
          needMore: true,
          error: `Lý do "${reason}" quá ngắn (cần ≥ 3 ký tự). Hãy hỏi user viết rõ hơn.`,
        }),
        effects: {},
      };
    }
    let remaining: number | undefined;
    try {
      const b = (await this.tools.balance(ctx.actor)) as { annualRemaining: number };
      remaining = b.annualRemaining;
    } catch (e) {
      this.log.warn(String(e));
    }
    const verdict = validateLeave({ type, from, to, annualRemaining: remaining });
    if (!verdict.allowed) {
      return {
        content: JSON.stringify({
          ok: false,
          policyBlocked: true,
          reasons: verdict.reasons,
          citations: verdict.citations,
          summary: `Không thể tạo đơn vì trái quy định:\n- ${verdict.reasons.join("\n- ")}`,
        }),
        effects: { citations: verdict.citations, confirm: null, pending: null },
      };
    }
    const action: ChatConfirmAction = {
      tool: "create_leave",
      args: { type, from, to, reason },
      summary: `Tạo nghỉ phép ${leaveTypeLabel(type)} từ ${from} đến ${to} (lý do: ${reason})`,
    };
    return {
      content: JSON.stringify({
        ok: true,
        needsConfirm: true,
        summary: action.summary,
        askUser: `${action.summary}. Bạn xác nhận để mình gửi đơn nhé?`,
      }),
      effects: {
        confirm: action,
        pending: action,
        citations: verdict.citations,
        slots: {
          ...ctx.slots,
          leaveType: type,
          from,
          to,
          reason,
        },
      },
    };
  }

  private proposeCreateTrip(
    args: Record<string, unknown>,
    ctx: ToolRunContext,
  ): ToolRunResult {
    const destination = String(args.destination ?? "").trim();
    const from = normalizeVnDate(String(args.from ?? ""), { rollPastToNextYear: true }) ?? String(args.from ?? "");
    const to = normalizeVnDate(String(args.to ?? ""), { rollPastToNextYear: true }) ?? String(args.to ?? "");
    const purpose = String(args.purpose ?? "").trim();
    if (!destination || !from || !to || !purpose) {
      return {
        content: JSON.stringify({
          ok: false,
          needMore: true,
          error: "Thiếu địa điểm / ngày / mục đích công tác.",
        }),
        effects: {},
      };
    }
    const verdict = validateTrip({ from, to, purpose, destination });
    if (!verdict.allowed) {
      return {
        content: JSON.stringify({
          ok: false,
          policyBlocked: true,
          reasons: verdict.reasons,
          citations: verdict.citations,
          summary: `Không thể tạo công tác:\n- ${verdict.reasons.join("\n- ")}`,
        }),
        effects: { citations: verdict.citations, confirm: null, pending: null },
      };
    }
    const action: ChatConfirmAction = {
      tool: "create_trip",
      args: { destination, from, to, purpose },
      summary: `Tạo công tác ${destination} từ ${from} đến ${to}`,
    };
    return {
      content: JSON.stringify({
        ok: true,
        needsConfirm: true,
        summary: action.summary,
        askUser: `${action.summary}. Bạn xác nhận để mình gửi đơn nhé?`,
      }),
      effects: {
        confirm: action,
        pending: action,
        citations: verdict.citations,
        slots: { ...ctx.slots, destination, from, to, purpose },
      },
    };
  }

  private proposeCancelLeave(args: Record<string, unknown>): ToolRunResult {
    const leaveId = String(args.leaveId ?? "").trim();
    if (!leaveId) {
      return {
        content: JSON.stringify({ ok: false, needMore: true, error: "Thiếu mã đơn cần hủy." }),
        effects: {},
      };
    }
    const action: ChatConfirmAction = {
      tool: "cancel_leave",
      args: { id: leaveId },
      summary: `Hủy đơn nghỉ phép ${leaveId}`,
    };
    return {
      content: JSON.stringify({
        ok: true,
        needsConfirm: true,
        summary: action.summary,
        askUser: `${action.summary}. Bạn xác nhận hủy chứ?`,
      }),
      effects: { confirm: action, pending: action },
    };
  }

  private proposeUpdateLeave(
    args: Record<string, unknown>,
    ctx: ToolRunContext,
  ): ToolRunResult {
    const leaveId = String(args.leaveId ?? "").trim();
    if (!leaveId) {
      return {
        content: JSON.stringify({ ok: false, needMore: true, error: "Thiếu mã đơn cần sửa." }),
        effects: {},
      };
    }
    const dto: Record<string, unknown> = {};
    if (args.type) dto.type = String(args.type);
    if (args.from) {
      dto.from = normalizeVnDate(String(args.from), { rollPastToNextYear: true });
    }
    if (args.to) {
      dto.to = normalizeVnDate(String(args.to), { rollPastToNextYear: true });
    }
    if (args.reason) dto.reason = String(args.reason).trim();
    if (!Object.keys(dto).length) {
      return {
        content: JSON.stringify({
          ok: false,
          needMore: true,
          error: "Cần ít nhất một trường để sửa (type/from/to/reason).",
        }),
        effects: {},
      };
    }
    const action: ChatConfirmAction = {
      tool: "update_leave",
      args: { id: leaveId, ...dto },
      summary: `Sửa đơn ${leaveId}: ${JSON.stringify(dto)}`,
    };
    return {
      content: JSON.stringify({
        ok: true,
        needsConfirm: true,
        summary: action.summary,
        askUser: `${action.summary}. Bạn xác nhận cập nhật chứ?`,
      }),
      effects: {
        confirm: action,
        pending: action,
        slots: { ...ctx.slots, leaveId },
      },
    };
  }

  private async proposeApproveLeaves(
    args: Record<string, unknown>,
    ctx: ToolRunContext,
  ): Promise<ToolRunResult> {
    if (ctx.actor.role !== "MANAGER") {
      return {
        content: JSON.stringify({
          ok: false,
          error: "Chỉ quản lý được phê duyệt đơn nghỉ phép của team.",
        }),
        effects: {},
      };
    }
    const rows = await this.tools.listLeaves(ctx.actor, "team");
    const allPending = summarizePendingLeaves(rows).pending;
    if (!allPending.length) {
      return {
        content: JSON.stringify({
          ok: true,
          count: 0,
          summary: "Hiện team không có đơn nghỉ phép nào đang chờ duyệt.",
        }),
        effects: { preview: rows, confirm: null, pending: null },
      };
    }

    const explicitIds = Array.isArray(args.ids)
      ? (args.ids as unknown[]).map(String).filter(Boolean)
      : [];
    const q = argsToQuery(args);
    if (q.status && q.status !== "PENDING") {
      return {
        content: JSON.stringify({
          ok: false,
          error: `Chỉ phê duyệt được đơn đang chờ. Bộ lọc đang là ${describeLeaveQuery(q)}.`,
        }),
        effects: { preview: rows },
      };
    }
    const qNoOrd = { ...q, ordinal: null, status: null };
    const hasFilter = leaveQueryActive(qNoOrd);

    let scoped: LeaveRow[];
    let scopeNote: string | undefined;

    if (hasFilter) {
      // Có bộ lọc (ngày / người / loại…) → ưu tiên lọc, bỏ ids lệch nếu model gửi kèm.
      scoped = filterPendingLeaves(allPending, qNoOrd);
      if (q.ordinal) scoped = applyOrdinal(scoped, q.ordinal);
      scopeNote = describeLeaveQuery(q);
    } else if (explicitIds.length) {
      const idSet = new Set(explicitIds);
      scoped = allPending.filter((r) => idSet.has(String(r._id ?? r.id)));
      scopeNote = `theo ${explicitIds.length} mã đơn đã chọn`;
    } else if (args.approveAll === true) {
      scoped = allPending;
      scopeNote = undefined;
    } else if (q.ordinal && parseListedIds(ctx.slots.listedIds).length) {
      const listed = parseListedIds(ctx.slots.listedIds);
      const picked = pickByOrdinal(listed, q.ordinal);
      scoped = allPending.filter((r) => picked.includes(String(r._id ?? r.id)));
      scopeNote = `đơn thứ ${q.ordinal} trong danh sách vừa xem`;
    } else {
      const { stats: allStats } = summarizePendingLeaves(allPending);
      return {
        content: JSON.stringify({
          ok: false,
          needMore: true,
          summary: `Cần rõ hơn đơn nào để duyệt (theo người, ngày, loại phép, hoặc “duyệt tất cả”).\n\nĐơn đang chờ:\n${allStats}`,
        }),
        effects: {
          preview: allPending,
          confirm: null,
          pending: null,
          slots: {
            ...ctx.slots,
            listedIds: allPending.map((r) => String(r._id ?? r.id)).join(","),
          },
        },
      };
    }

    if (!scoped.length) {
      const { stats: allStats } = summarizePendingLeaves(allPending);
      return {
        content: JSON.stringify({
          ok: true,
          count: 0,
          summary: `Không có đơn chờ duyệt khớp bộ lọc${scopeNote ? ` (${scopeNote})` : ""}.\n\nĐơn đang chờ:\n${allStats}`,
        }),
        effects: {
          preview: allPending,
          confirm: null,
          pending: null,
          slots: {
            ...ctx.slots,
            listedIds: allPending.map((r) => String(r._id ?? r.id)).join(","),
          },
        },
      };
    }

    const { ids } = formatLeaveList(scoped, scopeNote);
    const summary = scopeNote
      ? `Phê duyệt ${ids.length} đơn (${scopeNote})`
      : `Phê duyệt tất cả ${ids.length} đơn nghỉ phép đang chờ của team`;
    const action: ChatConfirmAction = {
      tool: "approve_leaves",
      args: { ids },
      summary,
    };
    const askUser = friendlyConfirmAsk(scoped, "approve", {
      all: args.approveAll === true && !scopeNote,
      scopeNote,
    });
    return {
      content: JSON.stringify({
        ok: true,
        needsConfirm: true,
        count: ids.length,
        ids,
        summary: action.summary,
        askUser,
      }),
      effects: {
        confirm: action,
        pending: action,
        preview: scoped,
        slots: { ...ctx.slots, listedIds: ids.join(",") },
      },
    };
  }

  private async proposeRejectLeaves(
    args: Record<string, unknown>,
    ctx: ToolRunContext,
  ): Promise<ToolRunResult> {
    const mirrored = await this.proposeApproveLeaves(
      {
        ...args,
        approveAll: args.rejectAll === true ? true : args.approveAll,
      },
      ctx,
    );
    if (!mirrored.effects.confirm) return mirrored;
    const ids = (mirrored.effects.confirm.args.ids as string[]) ?? [];
    const scoped = (mirrored.effects.preview as LeaveRow[]) ?? [];
    const scopeNote = mirrored.effects.confirm.summary
      .replace(/^Phê duyệt\s*/, "")
      .replace(/^tất cả\s*/i, "");
    const action: ChatConfirmAction = {
      tool: "reject_leaves",
      args: { ids },
      summary: `Từ chối ${ids.length} đơn nghỉ phép`,
    };
    const askUser = friendlyConfirmAsk(scoped, "reject", {
      all: args.rejectAll === true,
      scopeNote: scopeNote.includes("đơn") ? undefined : scopeNote || undefined,
    });
    return {
      content: JSON.stringify({
        ok: true,
        needsConfirm: true,
        count: ids.length,
        ids,
        summary: action.summary,
        askUser,
      }),
      effects: {
        confirm: action,
        pending: action,
        preview: scoped,
        slots: mirrored.effects.slots ?? ctx.slots,
      },
    };
  }

  private async proposeApproveTrips(
    args: Record<string, unknown>,
    ctx: ToolRunContext,
  ): Promise<ToolRunResult> {
    return this.proposeTripDecision(args, ctx, "approve");
  }

  private async proposeRejectTrips(
    args: Record<string, unknown>,
    ctx: ToolRunContext,
  ): Promise<ToolRunResult> {
    return this.proposeTripDecision(args, ctx, "reject");
  }

  private async proposeTripDecision(
    args: Record<string, unknown>,
    ctx: ToolRunContext,
    kind: "approve" | "reject",
  ): Promise<ToolRunResult> {
    if (ctx.actor.role !== "MANAGER") {
      return {
        content: JSON.stringify({
          ok: false,
          error: `Chỉ quản lý được ${kind === "approve" ? "phê duyệt" : "từ chối"} đơn công tác của team.`,
        }),
        effects: {},
      };
    }
    const rows = await this.tools.listTrips(ctx.actor, "team");
    const allPending = rows.filter((r) => r.status === "PENDING");
    if (!allPending.length) {
      return {
        content: JSON.stringify({
          ok: true,
          count: 0,
          summary: "Hiện team không có đơn công tác nào đang chờ duyệt.",
        }),
        effects: { preview: rows, confirm: null, pending: null },
      };
    }

    const explicitIds = Array.isArray(args.ids)
      ? (args.ids as unknown[]).map(String).filter(Boolean)
      : [];
    const employeeHint = String(args.employeeHint ?? "").trim();
    const from =
      normalizeVnDate(String(args.from ?? ""), { rollPastToNextYear: false }) ??
      (String(args.from ?? "").trim() || null);
    const to =
      normalizeVnDate(String(args.to ?? ""), { rollPastToNextYear: false }) ??
      (String(args.to ?? "").trim() || null);
    const allFlag = kind === "approve" ? args.approveAll === true : args.rejectAll === true;

    let scoped: TripRow[];
    if (explicitIds.length) {
      const idSet = new Set(explicitIds);
      scoped = allPending.filter((r) => idSet.has(String(r._id ?? r.id)));
    } else if (allFlag) {
      scoped = allPending;
    } else if (employeeHint || from || to) {
      scoped = allPending.filter((r) => {
        if (employeeHint && !matchEmployee(r as unknown as LeaveRow, employeeHint)) return false;
        if (from || to) {
          const a = from ?? to!;
          const b = to ?? from!;
          if (!overlapsDayRange(r.from, r.to, a, b)) return false;
        }
        return true;
      });
    } else {
      const { stats } = formatTripList(allPending, "đang chờ duyệt");
      return {
        content: JSON.stringify({
          ok: false,
          needMore: true,
          summary: `Cần rõ hơn đơn công tác nào để ${kind === "approve" ? "duyệt" : "từ chối"} (theo người, ngày, ids, hoặc “tất cả”).\n\n${stats}`,
        }),
        effects: {
          preview: allPending,
          confirm: null,
          pending: null,
          slots: {
            ...ctx.slots,
            listedIds: allPending.map((r) => String(r._id ?? r.id)).join(","),
          },
        },
      };
    }

    if (!scoped.length) {
      const { stats } = formatTripList(allPending, "đang chờ duyệt");
      return {
        content: JSON.stringify({
          ok: false,
          summary: `Không khớp đơn công tác chờ duyệt theo bộ lọc.\n\n${stats}`,
        }),
        effects: { preview: allPending, confirm: null, pending: null },
      };
    }

    const ids = scoped.map((r) => String(r._id ?? r.id));
    const action: ChatConfirmAction = {
      tool: kind === "approve" ? "approve_trips" : "reject_trips",
      args: { ids },
      summary: `${kind === "approve" ? "Phê duyệt" : "Từ chối"} ${ids.length} đơn công tác`,
    };
    const askUser = friendlyTripConfirmAsk(scoped, kind);
    return {
      content: JSON.stringify({
        ok: true,
        needsConfirm: true,
        count: ids.length,
        ids,
        summary: action.summary,
        askUser,
      }),
      effects: {
        confirm: action,
        pending: action,
        preview: scoped,
        slots: { ...ctx.slots, listedIds: ids.join(",") },
      },
    };
  }
}

function argsToQuery(args: Record<string, unknown>): LeaveQuery {
  const leaveType = args.leaveType as LeaveQuery["leaveType"] | undefined;
  const status = args.status as RequestStatus | undefined;
  // Lọc / duyệt: không roll "6/9" sang năm sau (tránh lệch đơn thật).
  let from = normalizeVnDate(args.from ? String(args.from) : null, {
    rollPastToNextYear: false,
  });
  let to = normalizeVnDate(args.to ? String(args.to) : null, {
    rollPastToNextYear: false,
  });
  // Một ngày (user nói "ngày 6/9") → lọc giao ngày đó.
  if (from && !to) to = from;
  if (to && !from) from = to;
  return {
    leaveType: leaveType && ["ANNUAL", "SICK", "UNPAID"].includes(leaveType) ? leaveType : null,
    employeeHint: args.employeeHint ? String(args.employeeHint).trim() || null : null,
    from,
    to,
    leaveId: args.leaveId ? String(args.leaveId) : null,
    status: status && ["PENDING", "APPROVED", "REJECTED", "CANCELLED"].includes(status) ? status : null,
    reasonHint: args.reasonHint ? String(args.reasonHint) : null,
    daysHint: args.daysHint != null ? String(args.daysHint) : null,
    ordinal: args.ordinal != null ? String(args.ordinal) : null,
  };
}

function leaveTypeLabel(type: string) {
  if (type === "ANNUAL") return "phép năm";
  if (type === "SICK") return "phép ốm";
  if (type === "UNPAID") return "không lương";
  return type;
}
