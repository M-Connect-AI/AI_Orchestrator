import { LEAVE_TYPES, RequestStatus } from "@msb/shared";

export type LeaveQuery = {
  leaveType: (typeof LEAVE_TYPES)[number] | null;
  employeeHint: string | null;
  from: string | null;
  to: string | null;
  leaveId: string | null;
  status: RequestStatus | null;
  reasonHint: string | null;
  daysHint: string | null;
  ordinal: string | null;
};

/** Ngày “hiện tại” theo Asia/Ho_Chi_Minh (tránh lệch UTC trên server). */
export function nowInVietnam(base = new Date()): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(base);
  const y = Number(parts.find((p) => p.type === "year")?.value);
  const m = Number(parts.find((p) => p.type === "month")?.value);
  const d = Number(parts.find((p) => p.type === "day")?.value);
  return new Date(y, m - 1, d);
}

export function leaveQueryActive(q: LeaveQuery) {
  return Boolean(
    q.leaveType ||
      q.employeeHint ||
      q.from ||
      q.to ||
      q.leaveId ||
      q.status ||
      q.reasonHint ||
      q.daysHint ||
      q.ordinal,
  );
}

export function describeLeaveQuery(q: LeaveQuery): string {
  const parts: string[] = [];
  if (q.leaveType === "SICK") parts.push("phép ốm");
  if (q.leaveType === "ANNUAL") parts.push("phép năm");
  if (q.leaveType === "UNPAID") parts.push("không lương");
  if (q.status === "PENDING") parts.push("đang chờ duyệt");
  if (q.status === "APPROVED") parts.push("đã duyệt");
  if (q.status === "REJECTED") parts.push("bị từ chối");
  if (q.status === "CANCELLED") parts.push("đã hủy");
  if (q.employeeHint) parts.push(`nhân viên ${q.employeeHint}`);
  if (q.from && q.to && q.from !== q.to) parts.push(`khoảng ${q.from} → ${q.to}`);
  else if (q.from && q.to) parts.push(`ngày ${q.from}`);
  else if (q.from) parts.push(`bắt đầu ${q.from}`);
  else if (q.to) parts.push(`kết thúc ${q.to}`);
  if (q.reasonHint) parts.push(`lý do có “${q.reasonHint}”`);
  if (q.daysHint) parts.push(`${q.daysHint} ngày`);
  if (q.ordinal === "last") parts.push("đơn cuối danh sách");
  else if (q.ordinal) parts.push(`đơn thứ ${q.ordinal}`);
  if (q.leaveId) parts.push(`mã ${q.leaveId}`);
  return parts.join(", ");
}

export function overlapsDayRange(rowFrom: string, rowTo: string, from: string, to: string) {
  return rowFrom <= to && from <= rowTo;
}

export function pickByOrdinal<T>(rows: T[], ordinal: string | null | undefined): T[] {
  if (!ordinal || !rows.length) return rows;
  if (ordinal === "last") return [rows[rows.length - 1]];
  const i = Number(ordinal) - 1;
  if (!Number.isFinite(i) || i < 0 || i >= rows.length) return [];
  return [rows[i]];
}

export function parseListedIds(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
