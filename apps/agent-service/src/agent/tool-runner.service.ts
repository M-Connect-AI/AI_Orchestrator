import { Injectable, Logger } from "@nestjs/common";
import { ChatConfirmAction, ChatSuggestion, ChatUiAction, LeaveType, RequestStatus } from "@msb/shared";
import { validateLeave, validateTrip } from "@msb/policy-docs";
import { Actor } from "../auth/jwt-auth.guard";
import {
  applyOrdinal,
  filterLeaves,
  filterPendingLeaves,
  formatCalendarWarning,
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
import {
  formatVnDate,
  formatVnDateRange,
  formatVnDateTime,
  parseVnDateTimeLocal,
  addMinutesLocal,
} from "./datetime-vn";
import {
  leaveResultsAction,
  tripResultsAction,
  jiraIssueAction,
  outlookCalendarAction,
  outlookConnectAction,
  outlookMailAction,
  uiActionFromPendingTool,
} from "./ui-action";
import {
  CreateJiraTaskInput,
  JiraTaskFilter,
  JiraToolsService,
} from "../jira/jira-tools.service";

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
  /** Nút điều hướng cho frontend/mobile */
  uiAction: ChatUiAction | null;
  suggestions: ChatSuggestion[];
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
    private readonly jira: JiraToolsService,
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
        case "suggest_follow_ups":
          return {
            content: JSON.stringify({ ok: true, items: parseFollowUpItems(args) }),
            effects: { suggestions: parseFollowUpItems(args) },
          };
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
        case "outlook_list_mails":
          return await this.outlookListMails(args, ctx);
        case "outlook_get_mail":
          return await this.outlookGetMail(args, ctx);
        case "outlook_list_calendar":
          return await this.outlookListCalendar(args, ctx);
        case "propose_create_outlook_event":
          return this.proposeCreateOutlookEvent(args);
        case "propose_reply_outlook_mail":
          return this.proposeReplyOutlookMail(args, ctx);
        case "jira_my_work_summary":
          return await this.jiraMyWorkSummary(args, ctx);
        case "jira_list_my_tasks":
          return await this.jiraListMyTasks(args, ctx);
        case "jira_analyze_backlog":
          return await this.jiraAnalyzeBacklog(args, ctx);
        case "propose_create_jira_task":
          return this.proposeCreateJiraTask(args);
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
      const error =
        name.includes("jira")
          ? explainJiraError(e)
          : name.startsWith("outlook_")
            ? e instanceof Error
              ? e.message
              : String(e)
            : explainHrError(e);
      return { content: JSON.stringify({ ok: false, error, summary: error }), effects: {} };
    }
  }

  private async jiraMyWorkSummary(
    args: Record<string, unknown>,
    ctx: ToolRunContext,
  ): Promise<ToolRunResult> {
    const result = await this.jira.myWorkSummary(ctx.actor, jiraFilter(args));
    const firstUrl = result.issues.find((i) => i.url)?.url;
    return {
      content: JSON.stringify({ ok: true, ...result, issues: result.issues.slice(0, 50) }),
      effects: {
        preview: { issues: result.issues, stats: result.stats },
        citations: result.citations,
        uiAction: firstUrl ? jiraIssueAction(firstUrl, "Mở Jira") : null,
      },
    };
  }

  private async jiraListMyTasks(
    args: Record<string, unknown>,
    ctx: ToolRunContext,
  ): Promise<ToolRunResult> {
    const result = await this.jira.listMyTasks(ctx.actor, jiraFilter(args));
    const firstUrl = result.issues.find((i) => i.url)?.url;
    return {
      content: JSON.stringify({ ok: true, ...result, issues: result.issues.slice(0, 50) }),
      effects: {
        preview: { issues: result.issues, stats: result.stats },
        citations: result.citations,
        uiAction: firstUrl ? jiraIssueAction(firstUrl, "Mở Jira") : null,
      },
    };
  }

  private async jiraAnalyzeBacklog(
    args: Record<string, unknown>,
    ctx: ToolRunContext,
  ): Promise<ToolRunResult> {
    const scope = String(args.scope ?? "ME").toUpperCase();
    const result = await this.jira.analyzeBacklog(ctx.actor, {
      ...jiraFilter(args),
      scope: scope === "PROJECT" ? "PROJECT" : "ME",
      staleDays: numericArg(args.staleDays),
    });
    return {
      content: JSON.stringify({ ok: true, ...result, issues: result.issues.slice(0, 50) }),
      effects: {
        preview: { issues: result.issues, stats: result.stats, priorityItems: result.priorityItems },
        citations: result.citations,
        uiAction: result.issues.find((i) => i.url)?.url
          ? jiraIssueAction(result.issues.find((i) => i.url)!.url!, "Mở Jira")
          : null,
      },
    };
  }

  async executePending(
    actor: Actor,
    action: ChatConfirmAction,
  ): Promise<{ reply: string; executed: unknown; slots: Slots; uiAction?: ChatUiAction | null }> {
    try {
      let executed: unknown;
      if (action.tool === "create_leave") {
        executed = await this.tools.createLeave(
          actor,
          action.args as { type: string; from: string; to: string; reason: string },
        );
        if (executed == null) {
          return {
            reply: "Hệ thống không ghi nhận đơn nghỉ phép. Bạn thử xác nhận lại giúp mình.",
            executed: null,
            slots: emptySlots(),
          };
        }
        const row = executed as LeaveRow;
        const type = leaveTypeLabel(String(row.type ?? action.args.type ?? ""));
        const when = formatVnDateRange(
          String(row.from ?? action.args.from ?? ""),
          String(row.to ?? action.args.to ?? ""),
        );
        const reason = String(row.reason ?? action.args.reason ?? "").trim();
        return {
          reply: `Mình đã gửi đơn ${type} của bạn cho ${when}${reason ? ` với lý do ${reason}` : ""}. Đơn đang chờ duyệt.`,
          executed,
          slots: emptySlots(),
          uiAction: leaveResultsAction("Xem đơn nghỉ phép"),
        };
      } else if (action.tool === "create_jira_task") {
        executed = await this.jira.createTask(
          actor,
          action.args as unknown as CreateJiraTaskInput,
        );
        const created = executed as { key: string; summary: string; url: string };
        return {
          reply: `Đã tạo Jira ${created.key}: ${created.summary}.`,
          executed,
          slots: emptySlots(),
          uiAction: created.url
            ? jiraIssueAction(created.url, `Mở ${created.key} trên Jira`)
            : null,
        };
      } else if (action.tool === "create_trip") {
        executed = await this.tools.createTrip(
          actor,
          action.args as { destination: string; from: string; to: string; purpose: string },
        );
        if (executed == null) {
          return {
            reply: "Hệ thống không ghi nhận đơn công tác. Bạn thử xác nhận lại giúp mình.",
            executed: null,
            slots: emptySlots(),
          };
        }
        const row = executed as TripRow;
        const dest = String(row.destination ?? action.args.destination ?? "");
        const when = formatVnDateRange(
          String(row.from ?? action.args.from ?? ""),
          String(row.to ?? action.args.to ?? ""),
        );
        return {
          reply: `Mình đã gửi đơn công tác ${dest} của bạn cho ${when}. Đơn đang chờ duyệt.`,
          executed,
          slots: emptySlots(),
          uiAction: tripResultsAction("Xem đơn công tác"),
        };
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
          reply: `${detail}\n\nĐã phê duyệt xong ${count} đơn.`,
          executed,
          slots: emptySlots(),
          uiAction: leaveResultsAction(),
        };
      } else if (action.tool === "reject_leaves") {
        const ids = (action.args.ids as string[]) ?? [];
        executed = await this.tools.rejectLeaves(actor, ids);
        const count =
          executed && typeof executed === "object" && "count" in executed
            ? Number((executed as { count: number }).count)
            : ids.length;
        return {
          reply: `Đã từ chối ${count} đơn nghỉ phép.`,
          executed,
          slots: emptySlots(),
          uiAction: leaveResultsAction(),
        };
      } else if (action.tool === "approve_trips") {
        const ids = (action.args.ids as string[]) ?? [];
        executed = await this.tools.approveTrips(actor, ids);
        const count =
          executed && typeof executed === "object" && "count" in executed
            ? Number((executed as { count: number }).count)
            : ids.length;
        return {
          reply: `Đã phê duyệt ${count} đơn công tác.`,
          executed,
          slots: emptySlots(),
          uiAction: tripResultsAction(),
        };
      } else if (action.tool === "reject_trips") {
        const ids = (action.args.ids as string[]) ?? [];
        executed = await this.tools.rejectTrips(actor, ids);
        const count =
          executed && typeof executed === "object" && "count" in executed
            ? Number((executed as { count: number }).count)
            : ids.length;
        return {
          reply: `Đã từ chối ${count} đơn công tác.`,
          executed,
          slots: emptySlots(),
          uiAction: tripResultsAction(),
        };
      } else if (action.tool === "create_outlook_event") {
        const result = await this.tools.createOutlookEvent(
          actor,
          action.args as {
            subject: string;
            start: string;
            end: string;
            timeZone?: string;
            isAllDay?: boolean;
            location?: string;
            body?: string;
            attendees?: string[];
          },
        );
        if (!result.connected || !result.event) {
          return {
            reply: result.error || "Không tạo được sự kiện Outlook.",
            executed: null,
            slots: emptySlots(),
            uiAction: /kết nối|connect/i.test(result.error || "")
              ? outlookConnectAction()
              : null,
          };
        }
        const ev = result.event;
        return {
          reply: `Đã tạo sự kiện Outlook “${ev.subject}” lúc ${formatVnDateTime(ev.start)} → ${formatVnDateTime(ev.end)}${ev.location ? ` tại ${ev.location}` : ""}.`,
          executed: result,
          slots: emptySlots(),
          uiAction: outlookCalendarAction(ev.webLink, "Xem lịch Outlook"),
        };
      } else if (action.tool === "reply_outlook_mail") {
        const messageId = String(action.args.messageId ?? "");
        const comment = String(action.args.comment ?? "");
        const result = await this.tools.replyOutlookMail(actor, messageId, comment);
        if (!result.connected || !result.replied) {
          return {
            reply: result.error || "Không gửi được trả lời mail.",
            executed: null,
            slots: emptySlots(),
            uiAction: /kết nối|connect/i.test(result.error || "")
              ? outlookConnectAction()
              : null,
          };
        }
        return {
          reply: `Đã gửi trả lời mail trên Outlook (${result.microsoftEmail ?? "hộp thư của bạn"}).`,
          executed: result,
          slots: emptySlots(),
          uiAction: outlookMailAction(undefined, "Xem hộp thư Outlook"),
        };
      } else {
        return {
          reply: `Thao tác ${action.tool} chưa được hỗ trợ.`,
          executed: null,
          slots: emptySlots(),
        };
      }
      return {
        reply: `Xong rồi — ${action.summary}.`,
        executed,
        slots: emptySlots(),
        uiAction: uiActionFromPendingTool(action.tool) ?? leaveResultsAction(),
      };
    } catch (e) {
      const error =
        action.tool === "create_jira_task"
          ? explainJiraError(e)
          : action.tool === "create_outlook_event" || action.tool === "reply_outlook_mail"
            ? e instanceof Error
              ? e.message
              : String(e)
            : explainHrError(e);
      return { reply: error, executed: null, slots: emptySlots() };
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
    const ok = exec.executed != null;
    return {
      content: JSON.stringify({
        ok,
        executed: ok,
        mutated: ok,
        summary: exec.reply,
        result: exec.executed,
        error: ok ? undefined : exec.reply,
      }),
      effects: {
        confirm: ok ? null : ctx.pending,
        pending: ok ? null : ctx.pending,
        executed: exec.executed,
        mutated: ok,
        slots: exec.slots,
        uiAction: ok
          ? exec.uiAction ?? uiActionFromPendingTool(ctx.pending.tool)
          : null,
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
      effects: {
        preview: b,
        uiAction: leaveResultsAction("Xem số dư / đơn nghỉ"),
      },
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
    const leaveIds = pendingLeaves.map((r) => String(r._id ?? r.id));
    const tripIds = pendingTrips.map((r) => String(r._id ?? r.id));
    const summary = `Đang chờ duyệt ${pendingLeaves.length} đơn nghỉ phép và ${pendingTrips.length} đơn công tác.`;
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
        uiAction:
          pendingLeaves.length || !pendingTrips.length
            ? leaveResultsAction("Xem đơn nghỉ phép")
            : tripResultsAction("Xem đơn công tác"),
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
            : "UI sẽ hiện nút xem Kết quả — không nhắc tab trong câu trả lời.",
      }),
      effects: {
        preview: matched,
        slots: { ...ctx.slots, listedIds: ids.join(",") },
        uiAction: leaveResultsAction("Xem đơn nghỉ phép"),
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
            : "UI sẽ hiện nút xem Kết quả — không nhắc tab trong câu trả lời.",
      }),
      effects: {
        preview: matched,
        slots: { ...ctx.slots, listedIds: ids.join(",") },
        uiAction: tripResultsAction("Xem đơn công tác"),
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
        effects: {
          preview: {
            policyChunks: chunks.map((c) => ({
              title: c.title,
              text: c.text,
              source: c.source,
            })),
          },
          citations,
        },
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

  private async outlookListMails(
    args: Record<string, unknown>,
    ctx: ToolRunContext,
  ): Promise<ToolRunResult> {
    const from =
      normalizeVnDate(String(args.from ?? ""), { rollPastToNextYear: false }) ??
      (String(args.from ?? "").trim() || undefined);
    const toRaw =
      normalizeVnDate(String(args.to ?? ""), { rollPastToNextYear: false }) ??
      (String(args.to ?? "").trim() || undefined);
    const to = toRaw || from;
    const hasRange = Boolean(from && to);

    const unreadOnly =
      typeof args.unreadOnly === "boolean"
        ? args.unreadOnly
        : String(args.unreadOnly ?? "").toLowerCase() === "true";

    const top = args.top != null ? Number(args.top) : hasRange ? 30 : 15;
    const search = String(args.search ?? "").trim() || undefined;
    const result = await this.tools.listOutlookMails(ctx.actor, {
      unreadOnly,
      top: Number.isFinite(top) ? top : 15,
      search,
      from,
      to,
    });
    if (!result.connected) {
      return {
        content: JSON.stringify({
          ok: false,
          needConnect: true,
          error:
            result.error ||
            "Chưa kết nối Outlook. Nhờ user bấm “Kết nối Outlook” trên thanh trên (cấp quyền Mail.ReadWrite + Calendars.ReadWrite).",
        }),
        effects: { uiAction: outlookConnectAction() },
      };
    }
    const mails = result.mails ?? [];
    const unread = mails.filter((m) => !m.isRead).length;
    const rangeBit =
      hasRange && from && to
        ? from === to
          ? ` ngày ${formatVnDate(from)}`
          : ` từ ${formatVnDateRange(from, to)}`
        : "";
    const unreadBit = unreadOnly ? " chưa đọc" : "";
    const searchBit = search ? ` khớp “${search}”` : "";
    const summary = mails.length
      ? `Có ${mails.length} mail${unreadBit}${rangeBit}${searchBit} trên ${result.microsoftEmail ?? "Outlook"}${
          unread && !unreadOnly ? `, ${unread} chưa đọc` : ""
        }.`
      : `Không có mail${unreadBit}${rangeBit}${searchBit} trên ${result.microsoftEmail ?? "Outlook"}.`;
    const listedMailIds = mails.map((m) => m.id).join("\n");
    return {
      content: JSON.stringify({
        ok: true,
        count: mails.length,
        unreadOnly,
        from: from ?? null,
        to: to ?? null,
        ids: mails.map((m) => m.id),
        summary,
        hint:
          "Khi trả lời user: giữ đúng giờ VN (+7). Không liệt kê từng mail — UI tự vẽ thẻ từ kết quả API. Tóm tắt sâu → outlook_get_mail(ordinal=\"1\").",
      }),
      effects: {
        preview: mails,
        slots: { ...ctx.slots, listedMailIds: listedMailIds || null },
        uiAction: outlookMailAction(undefined, "Mở Outlook Mail"),
      },
    };
  }

  private async outlookGetMail(
    args: Record<string, unknown>,
    ctx: ToolRunContext,
  ): Promise<ToolRunResult> {
    const ordinalRaw = String(args.ordinal ?? "").trim();
    let messageId = String(args.messageId ?? "").trim();

    if (ordinalRaw || !messageId) {
      const listed = (ctx.slots.listedMailIds ?? "")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      if (!listed.length && !messageId) {
        return {
          content: JSON.stringify({
            ok: false,
            needMore: true,
            error:
              "Chưa có danh sách mail trong phiên. Gọi outlook_list_mails trước, rồi outlook_get_mail(ordinal=\"1\").",
          }),
          effects: {},
        };
      }
      if (listed.length) {
        const ord = ordinalRaw || "1";
        const picked = pickByOrdinal(listed, ord);
        if (!picked.length) {
          return {
            content: JSON.stringify({
              ok: false,
              needMore: true,
              error: `Không có mail thứ ${ord} trong ${listed.length} mail vừa liệt kê.`,
            }),
            effects: {},
          };
        }
        messageId = picked[0];
      }
    }

    if (!messageId) {
      return {
        content: JSON.stringify({
          ok: false,
          needMore: true,
          error: "Thiếu ordinal hoặc messageId.",
        }),
        effects: {},
      };
    }

    const result = await this.tools.getOutlookMail(ctx.actor, messageId);
    if (!result.connected || !result.mail) {
      return {
        content: JSON.stringify({
          ok: false,
          needConnect: !result.connected,
          error: result.error || "Không đọc được mail.",
        }),
        effects: {},
      };
    }
    const m = result.mail;
    const summary = [
      `Mail: ${m.subject}`,
      `Từ: ${m.from}`,
      `Nhận: ${formatVnDateTime(m.receivedAt)}`,
      `Trạng thái: ${m.isRead ? "đã đọc" : "chưa đọc"}`,
      "",
      "Nội dung (rút gọn):",
      (m.body || m.preview || "").trim() || "(trống)",
    ].join("\n");
    return {
      content: JSON.stringify({
        ok: true,
        summary,
        hint:
          "Tóm tắt ngắn bằng tiếng Việt. Nếu cùng lượt có nhiều mail khác, phải tóm tắt đủ từng mail, không gom thành một. Ngày giờ dd/mm/yyyy giờ VN (+7). Không bịa nội dung.",
      }),
      effects: {
        preview: m,
        uiAction: outlookMailAction(undefined, "Mở Outlook Mail"),
      },
    };
  }

  private async outlookListCalendar(
    args: Record<string, unknown>,
    ctx: ToolRunContext,
  ): Promise<ToolRunResult> {
    let from =
      normalizeVnDate(String(args.from ?? ""), { rollPastToNextYear: false }) ??
      String(args.from ?? "").trim();
    let to =
      normalizeVnDate(String(args.to ?? ""), { rollPastToNextYear: false }) ??
      String(args.to ?? "").trim();
    if (from && !to) to = from;
    if (to && !from) from = to;
    if (!from || !to) {
      return {
        content: JSON.stringify({
          ok: false,
          needMore: true,
          error: "Thiếu from/to (YYYY-MM-DD). Hôm nay thì from=to=ngày hôm nay.",
        }),
        effects: {},
      };
    }
    const result = await this.tools.listOutlookCalendar(ctx.actor, from, to);
    if (!result.connected) {
      return {
        content: JSON.stringify({
          ok: false,
          needConnect: true,
          error:
            result.error ||
            "Chưa kết nối Outlook. Nhờ user bấm “Kết nối Outlook” trên thanh trên.",
        }),
        effects: { uiAction: outlookConnectAction() },
      };
    }
    const events = result.events ?? [];
    const range = formatVnDateRange(from, to);
    const factLines = events.slice(0, 8).map((e) => {
      const when = e.isAllDay
        ? `${formatVnDate(String(e.start).slice(0, 10))} (cả ngày)`
        : `${formatVnDateTime(e.start)} → ${formatVnDateTime(e.end)}`;
      const loc = (e.location ?? "").trim();
      return loc
        ? `- ${e.subject}: ${when}; địa điểm: ${loc}`
        : `- ${e.subject}: ${when}; không có địa điểm trên lịch`;
    });
    const summary = events.length
      ? `Lịch Outlook ${range}: ${events.length} sự kiện.\nChỉ dùng đúng các dòng sau. CẤM thêm phòng họp/địa điểm không có trong dòng:\n${factLines.join("\n")}`
      : `Lịch Outlook ${range}: không có sự kiện.`;
    return {
      content: JSON.stringify({
        ok: true,
        count: events.length,
        from,
        to,
        summary,
        hint: "Trả lời đúng sự kiện trong summary. Không bịa địa điểm/phòng họp. Ngày giờ dd/mm/yyyy giờ VN (+7).",
      }),
      effects: {
        preview: events,
        uiAction: outlookCalendarAction(undefined, "Mở lịch Outlook"),
      },
    };
  }

  private proposeCreateOutlookEvent(args: Record<string, unknown>): ToolRunResult {
    const subject = String(args.subject ?? "").trim();
    const startLocal = parseVnDateTimeLocal(String(args.start ?? ""));
    let endLocal = parseVnDateTimeLocal(String(args.end ?? ""));
    const location = String(args.location ?? "").trim();
    const body = String(args.body ?? "").trim();
    const isAllDay = Boolean(args.isAllDay);
    const attendees = Array.isArray(args.attendees)
      ? args.attendees.map(String).map((s) => s.trim()).filter(Boolean)
      : [];

    if (!subject || subject.length < 2) {
      return {
        content: JSON.stringify({
          ok: false,
          needMore: true,
          error: "Thiếu tiêu đề sự kiện. Hỏi user muốn đặt tên gì.",
        }),
        effects: {},
      };
    }
    if (!startLocal) {
      return {
        content: JSON.stringify({
          ok: false,
          needMore: true,
          error:
            "Thiếu hoặc sai giờ bắt đầu. Ví dụ: 2026-09-17T14:00 hoặc 17/09/2026 14:00 (giờ VN).",
        }),
        effects: {},
      };
    }
    if (!endLocal) {
      endLocal = addMinutesLocal(startLocal, isAllDay ? 24 * 60 : 60);
    }
    if (!endLocal || endLocal <= startLocal) {
      return {
        content: JSON.stringify({
          ok: false,
          needMore: true,
          error: "Giờ kết thúc phải sau giờ bắt đầu.",
        }),
        effects: {},
      };
    }

    const action: ChatConfirmAction = {
      tool: "create_outlook_event",
      args: {
        subject,
        start: startLocal,
        end: endLocal,
        timeZone: "Asia/Ho_Chi_Minh",
        isAllDay,
        ...(location ? { location } : {}),
        ...(body ? { body } : {}),
        ...(attendees.length ? { attendees } : {}),
      },
      summary: `Tạo sự kiện Outlook “${subject}” ${formatVnDateTime(startLocal)} → ${formatVnDateTime(endLocal)}${location ? ` tại ${location}` : ""}${attendees.length ? ` (mời ${attendees.join(", ")})` : ""}`,
    };
    return {
      content: JSON.stringify({
        ok: true,
        needsConfirm: true,
        summary: action.summary,
        askUser: `${action.summary}.\n\nBạn xác nhận để mình tạo trên lịch Outlook nhé?`,
      }),
      effects: { confirm: action, pending: action },
    };
  }

  private proposeReplyOutlookMail(
    args: Record<string, unknown>,
    ctx: ToolRunContext,
  ): ToolRunResult {
    const comment = String(args.comment ?? "").trim();
    const ordinalRaw = String(args.ordinal ?? "").trim();
    let messageId = String(args.messageId ?? "").trim();

    if (!comment || comment.length < 2) {
      return {
        content: JSON.stringify({
          ok: false,
          needMore: true,
          error: "Thiếu nội dung trả lời. Hỏi user muốn viết gì.",
        }),
        effects: {},
      };
    }

    if (!messageId) {
      const listed = (ctx.slots.listedMailIds ?? "")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      if (!listed.length) {
        return {
          content: JSON.stringify({
            ok: false,
            needMore: true,
            error:
              "Chưa có danh sách mail. Gọi outlook_list_mails trước, rồi propose_reply_outlook_mail(ordinal=\"1\", comment=...).",
          }),
          effects: {},
        };
      }
      const ord = ordinalRaw || "1";
      const picked = pickByOrdinal(listed, ord);
      if (!picked.length) {
        return {
          content: JSON.stringify({
            ok: false,
            needMore: true,
            error: `Không có mail thứ ${ord} trong ${listed.length} mail vừa liệt kê.`,
          }),
          effects: {},
        };
      }
      messageId = picked[0];
    }

    const preview =
      comment.length > 160 ? `${comment.slice(0, 160)}…` : comment;
    const action: ChatConfirmAction = {
      tool: "reply_outlook_mail",
      args: { messageId, comment },
      summary: `Trả lời mail Outlook (thứ ${ordinalRaw || "đã chọn"}): “${preview}”`,
    };
    return {
      content: JSON.stringify({
        ok: true,
        needsConfirm: true,
        summary: action.summary,
        askUser: `${action.summary}.\n\nBạn xác nhận để mình gửi trả lời nhé?`,
      }),
      effects: { confirm: action, pending: action },
    };
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
          summary: `Không thể tạo đơn vì trái quy định:\n- ${verdict.reasons.join("\n- ")}`,
        }),
        effects: { confirm: null, pending: null },
      };
    }
    const action: ChatConfirmAction = {
      tool: "create_leave",
      args: { type, from, to, reason },
      summary: `Tạo nghỉ phép ${leaveTypeLabel(type)} từ ${from} đến ${to} (lý do: ${reason})`,
    };
    const calendarNote = await this.calendarNote(ctx.actor, from, to);
    return {
      content: JSON.stringify({
        ok: true,
        needsConfirm: true,
        summary: action.summary,
        calendarWarning: calendarNote.trim() || null,
        askUser: `${action.summary}.${calendarNote}\n\nBạn xác nhận để mình gửi đơn nhé?`,
      }),
      effects: {
        confirm: action,
        pending: action,
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

  private proposeCreateJiraTask(args: Record<string, unknown>): ToolRunResult {
    const projectKey = String(args.projectKey ?? "").trim().toUpperCase();
    const summary = String(args.summary ?? "").trim();
    const description = String(args.description ?? "").trim();
    const issueType = String(args.issueType ?? "Task") as CreateJiraTaskInput["issueType"];
    const priority = args.priority
      ? (String(args.priority) as CreateJiraTaskInput["priority"])
      : undefined;
    const dueDate = args.dueDate ? String(args.dueDate).trim() : undefined;
    const labels = Array.isArray(args.labels)
      ? args.labels.map(String).map((value) => value.trim()).filter(Boolean)
      : [];

    if (!/^[A-Z][A-Z0-9_-]{0,31}$/.test(projectKey)) {
      return {
        content: JSON.stringify({
          ok: false,
          needMore: true,
          error: "Thiếu hoặc sai projectKey Jira. Hãy hỏi user mã project, ví dụ SCRUM.",
        }),
        effects: {},
      };
    }
    if (summary.length < 3 || summary.length > 255) {
      return {
        content: JSON.stringify({
          ok: false,
          needMore: true,
          error: "Tiêu đề Jira task phải từ 3 đến 255 ký tự.",
        }),
        effects: {},
      };
    }
    if (!["Task", "Story", "Bug", "Epic"].includes(issueType ?? "")) {
      return {
        content: JSON.stringify({ ok: false, error: "issueType Jira không hợp lệ." }),
        effects: {},
      };
    }
    if (
      priority &&
      !["Highest", "High", "Medium", "Low", "Lowest"].includes(priority)
    ) {
      return {
        content: JSON.stringify({ ok: false, error: "priority Jira không hợp lệ." }),
        effects: {},
      };
    }
    if (
      dueDate &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) ||
        Number.isNaN(Date.parse(`${dueDate}T00:00:00Z`)))
    ) {
      return {
        content: JSON.stringify({
          ok: false,
          needMore: true,
          error: "Due date Jira phải theo định dạng YYYY-MM-DD.",
        }),
        effects: {},
      };
    }

    const task: CreateJiraTaskInput = {
      projectKey,
      summary,
      issueType,
      ...(description ? { description } : {}),
      ...(priority ? { priority } : {}),
      ...(dueDate ? { dueDate } : {}),
      ...(labels.length ? { labels } : {}),
      ...(typeof args.assignToSprint === "boolean"
        ? { assignToSprint: args.assignToSprint }
        : {}),
    };
    const details = [
      `${issueType} ${projectKey}: ${summary}`,
      priority ? `priority ${priority}` : null,
      dueDate ? `due date ${dueDate}` : null,
      "gán cho tài khoản Jira khớp email đăng nhập",
    ].filter(Boolean);
    const action: ChatConfirmAction = {
      tool: "create_jira_task",
      args: task as unknown as Record<string, unknown>,
      summary: `Tạo Jira ${details.join(", ")}`,
    };
    return {
      content: JSON.stringify({
        ok: true,
        needsConfirm: true,
        summary: action.summary,
        askUser: `${action.summary}. Bạn xác nhận để mình tạo task nhé?`,
      }),
      effects: { confirm: action, pending: action },
    };
  }

  private async proposeCreateTrip(
    args: Record<string, unknown>,
    ctx: ToolRunContext,
  ): Promise<ToolRunResult> {
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
          summary: `Không thể tạo công tác:\n- ${verdict.reasons.join("\n- ")}`,
        }),
        effects: { confirm: null, pending: null },
      };
    }
    const action: ChatConfirmAction = {
      tool: "create_trip",
      args: { destination, from, to, purpose },
      summary: `Tạo công tác ${destination} từ ${from} đến ${to}`,
    };
    const calendarNote = await this.calendarNote(ctx.actor, from, to);
    return {
      content: JSON.stringify({
        ok: true,
        needsConfirm: true,
        summary: action.summary,
        calendarWarning: calendarNote.trim() || null,
        askUser: `${action.summary}.${calendarNote}\n\nBạn xác nhận để mình gửi đơn nhé?`,
      }),
      effects: {
        confirm: action,
        pending: action,
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

  private async calendarNote(actor: Actor, from: string, to: string) {
    try {
      const result = await this.tools.calendarConflicts(actor, from, to);
      return formatCalendarWarning(result);
    } catch (e) {
      this.log.warn(`calendarConflicts: ${String(e)}`);
      return "\n\n(Không kiểm tra được lịch Outlook lúc này — bạn vẫn có thể gửi đơn.)";
    }
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

function jiraFilter(args: Record<string, unknown>): JiraTaskFilter {
  const status = String(args.statusGroup ?? "ALL").toUpperCase();
  const sprint = String(args.sprint ?? "ALL").toUpperCase();
  return {
    projectKey: textArg(args.projectKey),
    statusGroup: ["TODO", "IN_PROGRESS", "DONE", "NOT_DONE", "ALL"].includes(status)
      ? (status as JiraTaskFilter["statusGroup"])
      : "ALL",
    sprint: ["ACTIVE", "BACKLOG", "ALL"].includes(sprint)
      ? (sprint as JiraTaskFilter["sprint"])
      : "ALL",
    dueBefore: textArg(args.dueBefore),
    updatedSince: textArg(args.updatedSince),
    maxResults: numericArg(args.maxResults),
  };
}

function textArg(value: unknown) {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function parseFollowUpItems(args: Record<string, unknown>): ChatSuggestion[] {
  const raw = args.items ?? args.suggestions ?? args.chips;
  if (!Array.isArray(raw)) return [];
  const out: ChatSuggestion[] = [];
  const seen = new Set<string>();
  for (const row of raw) {
    let label = "";
    if (typeof row === "string") label = row.replace(/\s+/g, " ").trim();
    else if (row && typeof row === "object") {
      const rec = row as Record<string, unknown>;
      label = String(rec.label ?? rec.text ?? "").replace(/\s+/g, " ").trim();
    }
    if (!label) continue;
    if (label.length > 42) label = label.slice(0, 42).trim();
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    out.push({ label, text: label });
    if (out.length >= 3) break;
  }
  return out;
}

function numericArg(value: unknown) {
  if (value == null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function explainJiraError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/permission group search_jira|bật Jira search/i.test(message)) {
    return (
      "API token đã xác thực, nhưng Jira MCP chưa cấp quyền tìm kiếm Jira. " +
      "Nhờ Org Admin vào Rovo MCP server > Permissions > Search > Edit details và bật Jira search."
    );
  }
  if (/organization.*(api token|token)|chưa cấp quyền Jira MCP qua API token/i.test(message)) {
    return (
      "Jira MCP đã kết nối, nhưng Atlassian organization đang chặn truy cập bằng API token. " +
      "Nhờ Org Admin cấp quyền API token cho Jira MCP hoặc dùng phương thức xác thực đã được tổ chức phê duyệt."
    );
  }
  if (/401|unauthorized|credential|api key|api token/i.test(message)) {
    return "Không xác thực được Jira MCP. Kiểm tra auth type, email/token hoặc service account API key.";
  }
  if (/403|forbidden|scope|permission/i.test(message)) {
    return "Jira từ chối quyền truy cập. Kiểm tra permission group và scope read/search Jira của credential MCP.";
  }
  if (/chưa được cấu hình|cần projectKey|không hợp lệ|chỉ quản lý/i.test(message)) {
    return message;
  }
  return `Không truy vấn được Jira MCP: ${message}`;
}

function leaveTypeLabel(type: string) {
  if (type === "ANNUAL") return "phép năm";
  if (type === "SICK") return "phép ốm";
  if (type === "UNPAID") return "không lương";
  return type;
}
