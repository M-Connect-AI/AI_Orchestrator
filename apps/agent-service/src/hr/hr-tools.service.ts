import { Injectable } from "@nestjs/common";
import { HrClient } from "./hr.client";
import { Actor } from "../auth/jwt-auth.guard";
import {
  LeaveQuery,
  overlapsDayRange,
  pickByOrdinal,
} from "../agent/leave-query";

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

  listTrips(actor: Actor, scope: "me" | "team" = "me") {
    const allowed = scope === "me" || (scope === "team" && actor.role === "MANAGER");
    if (!allowed) {
      throw new Error("Bạn không được xem công tác ngoài phạm vi của mình.");
    }
    return this.hr.request(actor.token, `/trips?scope=${scope}`);
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
    if (filter.from && filter.to) {
      if (!overlapsDayRange(r.from, r.to, filter.from, filter.to)) return false;
    } else if (filter.from && r.from !== filter.from) return false;
    else if (filter.to && r.to !== filter.to) return false;
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
  const byPerson = new Map<string, number>();
  const byStatus = new Map<string, number>();
  let days = 0;
  for (const r of rows) {
    byType.set(r.type, (byType.get(r.type) ?? 0) + 1);
    byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
    const who = r.employeeName ? `${r.employeeName} (${r.employeeCode})` : r.employeeCode;
    byPerson.set(who, (byPerson.get(who) ?? 0) + 1);
    days += r.days ?? 0;
  }
  const typeLine = [...byType.entries()]
    .map(([t, n]) => `${TYPE_LABEL[t] ?? t}: ${n}`)
    .join(", ");
  const personLine = [...byPerson.entries()].map(([name, n]) => `${name}: ${n} đơn`).join("; ");
  const statusLine = [...byStatus.entries()]
    .map(([s, n]) => `${STATUS_LABEL[s] ?? s}: ${n}`)
    .join(", ");
  const detail = rows
    .map((r, i) => {
      const who = r.employeeName ?? r.employeeCode;
      return `- (${i + 1}) ${who}: ${TYPE_LABEL[r.type] ?? r.type} ${r.from} → ${r.to} (${r.days} ngày, ${STATUS_LABEL[r.status] ?? r.status}, ${r.reason})`;
    })
    .join("\n");
  const stats = [
    `Có ${rows.length} đơn khớp${scopeNote ? ` (${scopeNote})` : ""} — tổng ${days} ngày, trong đó ${pending.length} đơn chờ duyệt.`,
    statusLine ? `Theo trạng thái: ${statusLine}.` : "",
    typeLine ? `Theo loại: ${typeLine}.` : "",
    personLine ? `Theo nhân viên: ${personLine}.` : "",
    detail ? `Chi tiết:\n${detail}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return { rows, ids, pending, stats };
}

export function applyOrdinal(rows: LeaveRow[], ordinal?: string | null) {
  return pickByOrdinal(rows, ordinal);
}

export function summarizePendingLeaves(rows: LeaveRow[], scopeNote?: string) {
  const pending = rows.filter((r) => r.status === "PENDING");
  const ids = pending.map((r) => String(r._id ?? r.id));
  const byType = new Map<string, number>();
  const byPerson = new Map<string, number>();
  let days = 0;
  for (const r of pending) {
    byType.set(r.type, (byType.get(r.type) ?? 0) + 1);
    const who = r.employeeName ? `${r.employeeName} (${r.employeeCode})` : r.employeeCode;
    byPerson.set(who, (byPerson.get(who) ?? 0) + 1);
    days += r.days ?? 0;
  }
  const typeLine = [...byType.entries()]
    .map(([t, n]) => `${TYPE_LABEL[t] ?? t}: ${n}`)
    .join(", ");
  const personLine = [...byPerson.entries()].map(([name, n]) => `${name}: ${n} đơn`).join("; ");
  const detail = pending
    .map((r) => {
      const who = r.employeeName ?? r.employeeCode;
      return `- ${who}: ${TYPE_LABEL[r.type] ?? r.type} ${r.from} → ${r.to} (${r.days} ngày, ${r.reason})`;
    })
    .join("\n");
  const stats = [
    `Có ${pending.length} đơn nghỉ phép chờ duyệt${scopeNote ? ` (${scopeNote})` : ""} — tổng ${days} ngày.`,
    typeLine ? `Theo loại: ${typeLine}.` : "",
    personLine ? `Theo nhân viên: ${personLine}.` : "",
    detail ? `Chi tiết:\n${detail}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return { pending, ids, stats };
}
