import { Injectable } from "@nestjs/common";
import { HrClient } from "./hr.client";
import { Actor } from "../auth/jwt-auth.guard";
import {
  LeaveQuery,
  overlapsDayRange,
  pickByOrdinal,
} from "../agent/leave-query";
import { formatVnDate, formatVnDateTime } from "../agent/datetime-vn";

export type LeaveRow = {
  _id?: string;
  id?: string;
  employeeCode: string;
  employeeName?: string;
  type: string;
  from: string;
  to: string;
  days: number;
  reason: string;
  status: string;
};

export type TripRow = {
  _id?: string;
  id?: string;
  employeeCode: string;
  employeeName?: string;
  destination: string;
  from: string;
  to: string;
  purpose: string;
  status: string;
};

@Injectable()
export class HrToolsService {
  constructor(private readonly hr: HrClient) {}

  listLeaves(actor: Actor, scope: "me" | "team" = "me") {
    const allowed = scope === "me" || (scope === "team" && actor.role === "MANAGER");
    if (!allowed) {
      throw new Error("Bạn không được xem danh sách nghỉ phép ngoài phạm vi của mình.");
    }
    return this.hr.request<LeaveRow[]>(actor.token, `/leaves?scope=${scope}`);
  }

  balance(actor: Actor) {
    return this.hr.request(actor.token, "/leaves/balance");
  }

  createLeave(
    actor: Actor,
    dto: { type: string; from: string; to: string; reason: string },
  ) {
    return this.hr.request(actor.token, "/leaves", {
      method: "POST",
      body: JSON.stringify(dto),
    });
  }

  updateLeave(actor: Actor, id: string, dto: Record<string, unknown>) {
    return this.hr.request(actor.token, `/leaves/${id}`, {
      method: "PATCH",
      body: JSON.stringify(dto),
    });
  }

  cancelLeave(actor: Actor, id: string) {
    return this.hr.request(actor.token, `/leaves/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status: "CANCELLED" }),
    });
  }

  approveLeaves(actor: Actor, ids: string[]) {
    if (actor.role !== "MANAGER") throw new Error("Nhân viên không được duyệt đơn.");
    return this.hr.request(actor.token, "/leaves/approve-batch", {
      method: "POST",
      body: JSON.stringify({ ids }),
    });
  }

  async rejectLeaves(actor: Actor, ids: string[]) {
    if (actor.role !== "MANAGER") throw new Error("Nhân viên không được từ chối đơn.");
    const items = [];
    for (const id of ids) {
      items.push(
        await this.hr.request(actor.token, `/leaves/${id}/status`, {
          method: "PATCH",
          body: JSON.stringify({ status: "REJECTED" }),
        }),
      );
    }
    return { count: items.length, items };
  }

  listTrips(actor: Actor, scope: "me" | "team" = "me") {
    const allowed = scope === "me" || (scope === "team" && actor.role === "MANAGER");
    if (!allowed) {
      throw new Error("Bạn không được xem công tác ngoài phạm vi của mình.");
    }
    return this.hr.request(actor.token, `/trips?scope=${scope}`) as Promise<TripRow[]>;
  }

  createTrip(
    actor: Actor,
    dto: { destination: string; from: string; to: string; purpose: string },
  ) {
    return this.hr.request(actor.token, "/trips", {
      method: "POST",
      body: JSON.stringify(dto),
    });
  }

  cancelTrip(actor: Actor, id: string) {
    return this.hr.request(actor.token, `/trips/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status: "CANCELLED" }),
    });
  }

  async approveTrips(actor: Actor, ids: string[]) {
    if (actor.role !== "MANAGER") throw new Error("Nhân viên không được duyệt đơn công tác.");
    const items = [];
    for (const id of ids) {
      items.push(
        await this.hr.request(actor.token, `/trips/${id}/status`, {
          method: "PATCH",
          body: JSON.stringify({ status: "APPROVED" }),
        }),
      );
    }
    return { count: items.length, items };
  }

  async rejectTrips(actor: Actor, ids: string[]) {
    if (actor.role !== "MANAGER") throw new Error("Nhân viên không được từ chối đơn công tác.");
    const items = [];
    for (const id of ids) {
      items.push(
        await this.hr.request(actor.token, `/trips/${id}/status`, {
          method: "PATCH",
          body: JSON.stringify({ status: "REJECTED" }),
        }),
      );
    }
    return { count: items.length, items };
  }

  calendarConflicts(actor: Actor, from: string, to: string) {
    return this.hr.request<{
      connected: boolean;
      configured: boolean;
      microsoftEmail: string | null;
      events: {
        id: string;
        subject: string;
        start: string;
        end: string;
        showAs: string;
        isAllDay: boolean;
        location?: string;
      }[];
      error?: string;
    }>(
      actor.token,
      `/outlook/conflicts?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    );
  }

  listOutlookCalendar(actor: Actor, from: string, to: string) {
    return this.hr.request<{
      connected: boolean;
      configured: boolean;
      microsoftEmail: string | null;
      events: {
        id: string;
        subject: string;
        start: string;
        end: string;
        showAs: string;
        isAllDay: boolean;
        location?: string;
      }[];
      error?: string;
    }>(
      actor.token,
      `/outlook/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    );
  }

  listOutlookMails(
    actor: Actor,
    opts: {
      unreadOnly?: boolean;
      top?: number;
      search?: string;
      from?: string;
      to?: string;
    } = {},
  ) {
    const q = new URLSearchParams();
    if (opts.unreadOnly) q.set("unreadOnly", "true");
    if (opts.top) q.set("top", String(opts.top));
    if (opts.search) q.set("search", opts.search);
    if (opts.from) q.set("from", opts.from);
    if (opts.to) q.set("to", opts.to);
    const qs = q.toString();
    return this.hr.request<{
      connected: boolean;
      configured: boolean;
      microsoftEmail: string | null;
      count?: number;
      from?: string | null;
      to?: string | null;
      unreadOnly?: boolean;
      mails?: {
        id: string;
        subject: string;
        from: string;
        receivedAt: string;
        preview: string;
        isRead: boolean;
        hasAttachments: boolean;
        importance: string;
      }[];
      error?: string;
    }>(actor.token, `/outlook/mails${qs ? `?${qs}` : ""}`);
  }

  getOutlookMail(actor: Actor, messageId: string) {
    return this.hr.request<{
      connected: boolean;
      configured: boolean;
      microsoftEmail: string | null;
      mail?: {
        id: string;
        subject: string;
        from: string;
        receivedAt: string;
        preview: string;
        body?: string;
        isRead: boolean;
        hasAttachments: boolean;
        importance: string;
      };
      error?: string;
    }>(
      actor.token,
      `/outlook/mail?id=${encodeURIComponent(messageId)}`,
    );
  }

  createOutlookEvent(
    actor: Actor,
    input: {
      subject: string;
      start: string;
      end: string;
      timeZone?: string;
      isAllDay?: boolean;
      location?: string;
      body?: string;
      attendees?: string[];
    },
  ) {
    return this.hr.request<{
      connected: boolean;
      configured: boolean;
      microsoftEmail: string | null;
      event?: {
        id: string;
        subject: string;
        start: string;
        end: string;
        location?: string;
        isAllDay: boolean;
        webLink?: string;
      };
      error?: string;
    }>(actor.token, "/outlook/events", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  replyOutlookMail(actor: Actor, messageId: string, comment: string) {
    return this.hr.request<{
      connected: boolean;
      configured: boolean;
      microsoftEmail: string | null;
      replied?: boolean;
      messageId?: string;
      error?: string;
    }>(actor.token, "/outlook/mail/reply", {
      method: "POST",
      body: JSON.stringify({ messageId, comment }),
    });
  }
}

export type CalendarConflictsResult = Awaited<
  ReturnType<HrToolsService["calendarConflicts"]>
>;

/** Cảnh báo lịch — không chặn tạo đơn; chỉ gắn vào lời hỏi xác nhận. */
export function formatCalendarWarning(result: CalendarConflictsResult) {
  if (!result.configured) return "";
  if (!result.connected) {
    return "\n\n(Chưa kết nối Outlook — bỏ qua kiểm tra lịch. Bấm “Kết nối Outlook” trên thanh trên nếu muốn cảnh báo sự kiện.)";
  }
  if (!result.events.length) {
    return "\n\nLịch Outlook: không có sự kiện trùng khoảng ngày này.";
  }
  const lines = result.events.slice(0, 8).map((e) => {
    const when = e.isAllDay
      ? `${formatVnDate(e.start.slice(0, 10))} (cả ngày)`
      : `${formatVnDateTime(e.start)} → ${formatVnDateTime(e.end)}`;
    const loc = e.location ? ` @ ${e.location}` : "";
    return `- ${e.subject}${loc} (${when}, ${e.showAs})`;
  });
  const more =
    result.events.length > 8 ? `\n- … và ${result.events.length - 8} sự kiện khác` : "";
  return `\n\n⚠️ Cảnh báo lịch Outlook (${result.microsoftEmail ?? "đã kết nối"}): có ${result.events.length} sự kiện trùng khoảng ngày:\n${lines.join("\n")}${more}\nBạn vẫn có thể xác nhận gửi đơn.`;
}

const TYPE_LABEL: Record<string, string> = {
  ANNUAL: "phép năm",
  SICK: "phép ốm",
  UNPAID: "không lương",
};

export function matchEmployee(row: LeaveRow, hint: string) {
  const h = hint.trim().toLowerCase();
  if (!h) return false;
  const code = (row.employeeCode ?? "").toLowerCase();
  const name = (row.employeeName ?? "").toLowerCase();
  const last = name.split(/\s+/).filter(Boolean).pop() ?? "";
  if (h.length <= 2) return last === h || code === h || code.endsWith(h);
  if (code === h || code.includes(h)) return true;
  if (name.includes(h)) return true;
  return last === h;
}

export function filterLeaves(
  rows: LeaveRow[],
  filter: LeaveQuery,
  opts: { pendingOnly?: boolean } = {},
) {
  return rows.filter((r) => {
    if (opts.pendingOnly && r.status !== "PENDING") return false;
    if (filter.status && r.status !== filter.status) return false;
    if (filter.leaveType && r.type !== filter.leaveType) return false;
    if (filter.employeeHint && !matchEmployee(r, filter.employeeHint)) return false;
    if (filter.from || filter.to) {
      const a = filter.from ?? filter.to!;
      const b = filter.to ?? filter.from!;
      if (!overlapsDayRange(r.from, r.to, a, b)) return false;
    }
    const id = String(r._id ?? r.id ?? "");
    if (filter.leaveId && id !== filter.leaveId) return false;
    if (filter.reasonHint && !(r.reason ?? "").toLowerCase().includes(filter.reasonHint.toLowerCase())) {
      return false;
    }
    if (filter.daysHint && Number(r.days) !== Number(filter.daysHint)) return false;
    return true;
  });
}

export function filterPendingLeaves(rows: LeaveRow[], filter: LeaveQuery) {
  return filterLeaves(rows, filter, { pendingOnly: true });
}

const STATUS_LABEL: Record<string, string> = {
  PENDING: "chờ duyệt",
  APPROVED: "đã duyệt",
  REJECTED: "từ chối",
  CANCELLED: "đã hủy",
};

export function formatLeaveList(rows: LeaveRow[], scopeNote?: string) {
  const ids = rows.map((r) => String(r._id ?? r.id));
  const pending = rows.filter((r) => r.status === "PENDING");
  const byType = new Map<string, number>();
  const byStatus = new Map<string, number>();
  let days = 0;
  for (const r of rows) {
    byType.set(r.type, (byType.get(r.type) ?? 0) + 1);
    byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
    days += r.days ?? 0;
  }
  const typeLine = [...byType.entries()]
    .map(([t, n]) => `${TYPE_LABEL[t] ?? t}: ${n}`)
    .join(", ");
  const statusLine = [...byStatus.entries()]
    .map(([s, n]) => `${STATUS_LABEL[s] ?? s}: ${n}`)
    .join(", ");
  const stats = [
    `Có ${rows.length} đơn khớp${scopeNote ? ` (${scopeNote})` : ""} — tổng ${days} ngày, trong đó ${pending.length} đơn chờ duyệt.`,
    statusLine ? `Theo trạng thái: ${statusLine}.` : "",
    typeLine ? `Theo loại: ${typeLine}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return { rows, ids, pending, stats, days };
}

/** Lời mời xác nhận duyệt/từ chối — ngắn, tự nhiên (không dump thống kê máy móc). */
export function friendlyConfirmAsk(
  rows: LeaveRow[],
  kind: "approve" | "reject",
  opts?: { all?: boolean; scopeNote?: string },
) {
  if (!rows.length) {
    return kind === "approve"
      ? "Hiện không có đơn nào để duyệt."
      : "Hiện không có đơn nào để từ chối.";
  }
  const days = rows.reduce((s, r) => s + (r.days ?? 0), 0);
  const people = [
    ...new Set(rows.map((r) => (r.employeeName ? r.employeeName : r.employeeCode))),
  ];
  const lines = rows.map((r) => {
    const who = r.employeeName ?? r.employeeCode;
    const type = TYPE_LABEL[r.type] ?? r.type;
    const date = r.from === r.to ? formatVnDay(r.from) : `${formatVnDay(r.from)} → ${formatVnDay(r.to)}`;
    const reason = r.reason?.trim() ? `, lý do: ${r.reason.trim()}` : "";
    return `- ${who}: ${type} ${date} (${r.days} ngày${reason})`;
  });
  const whoBit = people.length === 1 ? ` của ${people[0]}` : "";
  const scopeBit = opts?.scopeNote ? ` (${opts.scopeNote})` : "";
  const verb = kind === "approve" ? "duyệt" : "từ chối";
  const head = opts?.all
    ? `Mình sẽ ${verb} hết ${rows.length} đơn đang chờ${whoBit} — tổng ${days} ngày:`
    : `Mình chọn ${rows.length} đơn${whoBit}${scopeBit} — tổng ${days} ngày:`;
  return `${head}\n${lines.join("\n")}\n\nBạn xác nhận ${verb} giúp mình nhé?`;
}

function formatVnDay(iso: string) {
  return formatVnDate(iso) || iso;
}

export function formatTripList(rows: TripRow[], scopeNote?: string) {
  const ids = rows.map((r) => String(r._id ?? r.id));
  const pending = rows.filter((r) => r.status === "PENDING");
  const byStatus = new Map<string, number>();
  for (const r of rows) {
    byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
  }
  const statusLine = [...byStatus.entries()]
    .map(([s, n]) => `${STATUS_LABEL[s] ?? s}: ${n}`)
    .join(", ");
  const stats = [
    `Có ${rows.length} đơn công tác khớp${scopeNote ? ` (${scopeNote})` : ""}, trong đó ${pending.length} đơn chờ duyệt.`,
    statusLine ? `Theo trạng thái: ${statusLine}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return { rows, ids, pending, stats };
}

export function friendlyTripConfirmAsk(
  rows: TripRow[],
  kind: "approve" | "reject",
) {
  if (!rows.length) {
    return kind === "approve"
      ? "Hiện không có đơn công tác nào để duyệt."
      : "Hiện không có đơn công tác nào để từ chối.";
  }
  const verb = kind === "approve" ? "duyệt" : "từ chối";
  const lines = rows.map((r) => {
    const who = r.employeeName ?? r.employeeCode;
    const date = r.from === r.to ? formatVnDay(r.from) : `${formatVnDay(r.from)} → ${formatVnDay(r.to)}`;
    return `- ${who}: ${r.destination} ${date} (${r.purpose})`;
  });
  return `Mình chọn ${rows.length} đơn công tác:\n${lines.join("\n")}\n\nBạn xác nhận ${verb} giúp mình nhé?`;
}

export function applyOrdinal(rows: LeaveRow[], ordinal?: string | null) {
  return pickByOrdinal(rows, ordinal);
}

export function summarizePendingLeaves(rows: LeaveRow[], scopeNote?: string) {
  const pending = rows.filter((r) => r.status === "PENDING");
  const ids = pending.map((r) => String(r._id ?? r.id));
  const byType = new Map<string, number>();
  let days = 0;
  for (const r of pending) {
    byType.set(r.type, (byType.get(r.type) ?? 0) + 1);
    days += r.days ?? 0;
  }
  const typeLine = [...byType.entries()]
    .map(([t, n]) => `${TYPE_LABEL[t] ?? t}: ${n}`)
    .join(", ");
  const stats = [
    `Có ${pending.length} đơn nghỉ phép chờ duyệt${scopeNote ? ` (${scopeNote})` : ""} — tổng ${days} ngày.`,
    typeLine ? `Theo loại: ${typeLine}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return { pending, ids, stats };
}
