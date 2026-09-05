import { LEAVE_TYPES, RequestStatus } from "@msb/shared";
import {
  cleanEmployeeHint,
  normalizeVnDate,
  parseEmployeeHint,
  Slots,
} from "./schema";

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

const TYPE_IN_MSG =
  /không lương|unpaid|(phép|đơn|nghỉ)\s*ốm|\bsick\b|(phép|đơn|nghỉ)\s*năm|\bannual\b|(?:duyệt|phê duyệt)\s+ốm/;
const APPROVE_ALL = /tất cả|duyệt hết|toàn bộ|cả team|của team|mọi đơn/;
const DATE_TOKEN = /\d{1,2}[/\-.]\d{1,2}(?:[/\-.]\d{2,4})?|\d{4}-\d{2}-\d{2}/g;
const ORDINAL_WORD: Record<string, string> = {
  nhất: "1",
  một: "1",
  hai: "2",
  ba: "3",
  tư: "4",
  năm: "5",
  sáu: "6",
  bảy: "7",
  tám: "8",
  chín: "9",
  mười: "10",
};

/** Xem / hỏi thông tin đơn — không phải thao tác duyệt. */
export function looksLikeLeaveInfo(message: string) {
  return /xem|thông tin|liệt kê|danh sách|thống kê|chi tiết|tình trạng|lọc đơn|cho (tôi|mình)( xem| biết)?|có (những )?(đơn|phép) nào|đơn nào|các đơn|đơn của|đơn.{0,40}?(của|ngày|tháng|tuần)|đơn (ốm|năm|không lương)|chờ duyệt|cần (phê )?duyệt|đơn thứ|đơn \d+\s*ngày|đơn.{0,16}(đám cưới|cưới|gia đình)|đơn từ \d|đã duyệt|được duyệt|bị từ chối|đã hủy|đã huỷ|tháng này|tháng trước|năm nay|lịch sử duyệt/i.test(
    message,
  );
}

/** Hỏi lịch sử / trạng thái đơn đã xử lý — không phải lệnh phê duyệt. */
export function looksLikeLeaveHistory(message: string) {
  return /(đã|vừa|được)\s+duyệt|duyệt\s+đơn\s+nào|đơn\s+nào.{0,12}(đã|được)\s+duyệt|bị từ chối|đã hủy|đã huỷ|lịch sử duyệt/i.test(
    message,
  );
}

/** Động từ duyệt — không tính “cần duyệt / chờ duyệt / đã duyệt” (đó là xem danh sách). */
export function looksLikeLeaveApprove(message: string) {
  if (looksLikeLeaveHistory(message)) return false;
  return /phê\s*duyệt|chỉ duyệt|duyệt hết|duyệt tất cả|duyệt giúp|duyệt cho|duyệt (các đơn|đơn thứ|phép|luôn|đi)|(?<!đã )(?<!vừa )(?<!được )duyệt đơn/i.test(
    message,
  );
}

export function looksLikeLeaveCreate(message: string) {
  return /(?:tôi|mình|cho tôi)\s+(?:muốn\s+)?(?:xin nghỉ|tạo đơn|đăng ký phép)|xin nghỉ phép|tạo đơn nghỉ/i.test(
    message,
  );
}

export function parseLeaveQuery(
  message: string,
  extracted: Partial<LeaveQuery> = {},
  now = new Date(),
): LeaveQuery {
  const t = message.toLowerCase();
  const fromThisTurn = Boolean(message.trim());
  const mentionedAll = APPROVE_ALL.test(t);
  let leaveType: LeaveQuery["leaveType"] = fromThisTurn ? null : (extracted.leaveType ?? null);
  if (TYPE_IN_MSG.test(t)) {
    if (/không lương|unpaid/.test(t)) leaveType = "UNPAID";
    else if (/(phép|đơn|nghỉ)\s*ốm|\bsick\b|(?:duyệt|phê duyệt)\s+ốm/.test(t)) leaveType = "SICK";
    else if (/(phép|đơn|nghỉ)\s*năm|\bannual\b/.test(t)) leaveType = "ANNUAL";
  }

  const dates = fromThisTurn ? parseQueryDates(message, now) : { from: extracted.from ?? null, to: extracted.to ?? null };
  const parsedName = parseEmployeeHint(message);
  const llmName = fromThisTurn && !mentionedAll ? cleanEmployeeHint(extracted.employeeHint) : null;
  const employeeHint =
    parsedName ?? llmName ?? (!fromThisTurn ? extracted.employeeHint ?? null : null);

  if (fromThisTurn && mentionedAll && !TYPE_IN_MSG.test(t) && !employeeHint && !dates.from) {
    return emptyQuery();
  }

  const idInMsg = message.match(/\b[a-f0-9]{24}\b/i)?.[0] ?? null;
  const status = fromThisTurn ? parseStatus(t) : (extracted.status ?? null);
  const reasonHint = fromThisTurn ? parseReasonHint(message) : (extracted.reasonHint ?? null);
  const daysHint = fromThisTurn ? parseDaysHint(t) : (extracted.daysHint ?? null);
  const ordinal = fromThisTurn ? parseOrdinal(t) : (extracted.ordinal ?? null);

  return {
    leaveType,
    employeeHint,
    from: dates.from,
    to: dates.to,
    leaveId: fromThisTurn
      ? idInMsg ??
        (extracted.leaveId && message.includes(String(extracted.leaveId)) ? extracted.leaveId : null)
      : (extracted.leaveId ?? null),
    status,
    reasonHint,
    daysHint,
    ordinal,
  };
}

export function emptyQuery(): LeaveQuery {
  return {
    leaveType: null,
    employeeHint: null,
    from: null,
    to: null,
    leaveId: null,
    status: null,
    reasonHint: null,
    daysHint: null,
    ordinal: null,
  };
}

export function queryFromSlots(slots: Slots): LeaveQuery {
  return {
    leaveType: slots.leaveType,
    employeeHint: slots.employeeHint,
    from: slots.from,
    to: slots.to,
    leaveId: slots.leaveId,
    status: slots.status,
    reasonHint: slots.reason,
    daysHint: slots.daysHint,
    ordinal: slots.ordinal,
  };
}

export function applyQueryToSlots(slots: Slots, q: LeaveQuery): Slots {
  return {
    ...slots,
    leaveType: q.leaveType,
    employeeHint: q.employeeHint,
    from: q.from,
    to: q.to,
    leaveId: q.leaveId,
    status: q.status,
    reason: q.reasonHint,
    daysHint: q.daysHint,
    ordinal: q.ordinal,
  };
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

export function parseQueryDates(message: string, now = new Date()): { from: string | null; to: string | null } {
  const t = message.toLowerCase();
  const y = now.getFullYear();
  if (/tháng trước/.test(t)) {
    const prev = new Date(y, now.getMonth() - 1, 1);
    return monthRange(prev.getFullYear(), prev.getMonth() + 1);
  }
  if (/tháng này|tháng hiện tại|trong tháng(?!\s*\d)/.test(t)) {
    return monthRange(y, now.getMonth() + 1);
  }
  if (/năm nay/.test(t) && !/tháng\s*\d/.test(t)) {
    return { from: `${y}-01-01`, to: `${y}-12-31` };
  }
  const month = t.match(/tháng\s*(\d{1,2})(?:\s*(?:\/|năm)\s*(\d{2,4}))?/);
  if (month) {
    const m = Number(month[1]);
    if (m >= 1 && m <= 12) {
      let year = month[2] ? Number(month[2]) : y;
      if (year < 100) year += 2000;
      return monthRange(year, m);
    }
  }
  if (/tuần sau/.test(t)) return weekRange(addDays(startOfDay(now), 7));
  if (/tuần này|tuần hiện tại/.test(t)) return weekRange(now);
  if (/cuối tuần/.test(t)) {
    const mon = startOfWeekMon(now);
    return { from: iso(addDays(mon, 5)), to: iso(addDays(mon, 6)) };
  }

  const rel = relativeDay(t, now);
  const tokens = [...message.matchAll(DATE_TOKEN)].map((m) => normalizeVnDate(m[0])).filter(Boolean) as string[];
  const range = t.match(
    /từ\s+(\d{1,2}[/\-.]\d{1,2}(?:[/\-.]\d{2,4})?|\d{4}-\d{2}-\d{2})\s+đến\s+(\d{1,2}[/\-.]\d{1,2}(?:[/\-.]\d{2,4})?|\d{4}-\d{2}-\d{2})/,
  );
  if (range) {
    return { from: normalizeVnDate(range[1]), to: normalizeVnDate(range[2]) };
  }
  if (tokens.length >= 2) return { from: tokens[0], to: tokens[1] };
  if (tokens.length === 1) {
    if (/bắt đầu/.test(t)) return { from: tokens[0], to: null };
    if (/kết thúc/.test(t)) return { from: null, to: tokens[0] };
    return { from: tokens[0], to: tokens[0] };
  }
  if (rel) return { from: rel, to: rel };
  return { from: null, to: null };
}

function relativeDay(t: string, now: Date): string | null {
  if (/hôm qua/.test(t)) return iso(addDays(now, -1));
  if (/ngày kia/.test(t)) return iso(addDays(now, 2));
  if (/ngày mai/.test(t) && !/tháng mai/.test(t)) return iso(addDays(now, 1));
  if (/hôm nay|ngày này/.test(t)) return iso(now);
  return null;
}

function parseStatus(t: string): RequestStatus | null {
  if (/đã hủy|đã huỷ|bị hủy|cancelled/.test(t)) return "CANCELLED";
  if (/từ chối|rejected/.test(t)) return "REJECTED";
  if (/(đã|vừa|được)\s+duyệt|approved/.test(t) && !/chờ|cần/.test(t)) return "APPROVED";
  if (/chờ duyệt|cần (phê )?duyệt|chưa duyệt|pending|đang chờ/.test(t)) return "PENDING";
  return null;
}

function parseReasonHint(message: string): string | null {
  const t = message.toLowerCase();
  const because = t.match(/(?:lý do|vì|do)\s+([^,.;\n]{2,40})/);
  if (because) {
    const raw = because[1].replace(/\s+(ạ|nhé|của).*$/i, "").trim();
    if (raw && !/^(ốm|năm|phép)$/i.test(raw)) return raw.slice(0, 40);
  }
  for (const key of ["đám cưới", "cưới", "khám bệnh", "gia đình", "tang", "việc riêng", "ốm đau"]) {
    if (t.includes(key)) return key;
  }
  return null;
}

function parseDaysHint(t: string): string | null {
  const m = t.match(/(\d+)\s*ngày/);
  return m ? m[1] : null;
}

function parseOrdinal(t: string): string | null {
  if (/đơn cuối( cùng)?|cái cuối/.test(t)) return "last";
  if (/đơn đầu( tiên)?|cái đầu/.test(t)) return "1";
  const num = t.match(/đơn thứ\s*(\d+)/);
  if (num) return String(Number(num[1]));
  const word = t.match(/đơn thứ\s*(nhất|một|hai|ba|tư|năm|sáu|bảy|tám|chín|mười)/);
  if (word) return ORDINAL_WORD[word[1]] ?? null;
  return null;
}

function monthRange(year: number, month: number) {
  const last = new Date(year, month, 0).getDate();
  return {
    from: `${year}-${pad(month)}-${pad(1)}`,
    to: `${year}-${pad(month)}-${pad(last)}`,
  };
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function iso(d: Date) {
  const x = startOfDay(d);
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
}

function addDays(d: Date, n: number) {
  const x = startOfDay(d);
  x.setDate(x.getDate() + n);
  return x;
}

function startOfWeekMon(d: Date) {
  const x = startOfDay(d);
  const day = x.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  return addDays(x, diff);
}

function weekRange(d: Date) {
  const mon = startOfWeekMon(d);
  return { from: iso(mon), to: iso(addDays(mon, 6)) };
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
