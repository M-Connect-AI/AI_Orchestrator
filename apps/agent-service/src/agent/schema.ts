import { z } from "zod";
import { AGENT_INTENTS, LEAVE_TYPES, REQUEST_STATUSES } from "@msb/shared";

export const ExtractSchema = z.object({
  intent: z.enum(AGENT_INTENTS),
  isConfirmation: z.boolean().default(false),
  isCancellation: z.boolean().default(false),
  asksOtherEmployee: z.boolean().default(false),
  otherEmployeeHint: z.string().nullable().default(null),
  slots: z.object({
    leaveType: z.enum(LEAVE_TYPES).nullable().default(null),
    from: z.string().nullable().default(null),
    to: z.string().nullable().default(null),
    reason: z.string().nullable().default(null),
    leaveId: z.string().nullable().default(null),
    employeeHint: z.string().nullable().default(null),
    status: z.enum(REQUEST_STATUSES).nullable().default(null),
    daysHint: z.string().nullable().default(null),
    ordinal: z.string().nullable().default(null),
    listedIds: z.string().nullable().default(null),
    destination: z.string().nullable().default(null),
    purpose: z.string().nullable().default(null),
    tripId: z.string().nullable().default(null),
  }),
  replyHint: z.string().nullable().default(null),
});

export type Extracted = z.infer<typeof ExtractSchema>;

export type Slots = Extracted["slots"];

export function emptySlots(): Slots {
  return {
    leaveType: null,
    from: null,
    to: null,
    reason: null,
    leaveId: null,
    employeeHint: null,
    status: null,
    daysHint: null,
    ordinal: null,
    listedIds: null,
    destination: null,
    purpose: null,
    tripId: null,
  };
}

export function mergeSlots(prev: Slots, next: Slots): Slots {
  const draftingLeave = !prev.leaveId && isLeaveDraft(prev);
  const draftingTrip = !prev.tripId && isTripDraft(prev);
  return {
    leaveType: next.leaveType ?? prev.leaveType,
    from: normalizeVnDate(next.from) ?? prev.from,
    to: normalizeVnDate(next.to) ?? prev.to,
    reason: next.reason ?? prev.reason,
    // Đơn mới chưa có trên hệ thống: bỏ leaveId model bịa ra.
    leaveId: draftingLeave ? prev.leaveId : (next.leaveId ?? prev.leaveId),
    employeeHint: next.employeeHint ?? prev.employeeHint,
    status: next.status ?? prev.status,
    daysHint: next.daysHint ?? prev.daysHint,
    ordinal: next.ordinal ?? prev.ordinal,
    listedIds: next.listedIds ?? prev.listedIds,
    destination: next.destination ?? prev.destination,
    purpose: next.purpose ?? prev.purpose,
    tripId: draftingTrip ? prev.tripId : (next.tripId ?? prev.tripId),
  };
}

/** Bắt loại phép từ câu tiếng Việt khi model không điền slot. */
export function applyMessageHints(message: string, slots: Slots): Slots {
  const t = message.toLowerCase();
  let leaveType = slots.leaveType;
  if (/không lương|unpaid/.test(t)) leaveType = "UNPAID";
  else if (/(phép|đơn|nghỉ)\s*ốm|\bsick\b/.test(t)) leaveType = "SICK";
  else if (/(phép|đơn|nghỉ)\s*năm|loại phép năm|\bannual\b/.test(t)) leaveType = "ANNUAL";
  const employeeHint = parseEmployeeHint(message) ?? slots.employeeHint;
  return { ...slots, leaveType, employeeHint };
}

export function normalizeVnDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const m = trimmed.match(/^(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2,4}))?$/);
  if (!m) return trimmed;
  const day = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return trimmed;
  const vnParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const vnYear = Number(vnParts.find((p) => p.type === "year")?.value);
  const vnMonth = Number(vnParts.find((p) => p.type === "month")?.value);
  const vnDay = Number(vnParts.find((p) => p.type === "day")?.value);
  let year = m[3] ? Number(m[3]) : vnYear;
  if (year < 100) year += 2000;
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const start = new Date(`${iso}T00:00:00`);
  const today = new Date(vnYear, vnMonth - 1, vnDay);
  if (!m[3] && start < today) {
    return `${year + 1}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  return iso;
}

export function isLeaveDraft(slots: Slots) {
  return Boolean(slots.leaveType || slots.from || slots.to || slots.reason);
}

export function isTripDraft(slots: Slots) {
  return Boolean(slots.destination || slots.purpose);
}

/**
 * Đang tạo đơn mới thì "đổi loại phép / đổi ngày" vẫn là leave_create,
 * không nhảy sang leave_update (sẽ đòi mã đơn chưa tồn tại).
 */
export function resolveIntent(
  prevIntent: string | undefined,
  extractedIntent: string,
  slots: Slots,
): string {
  // Slot lọc duyệt (loại phép / tên) không phải nháp tạo đơn.
  if (
    (prevIntent === "leave_approve" || prevIntent === "leave_list") &&
    extractedIntent !== "leave_approve" &&
    extractedIntent !== "leave_list"
  ) {
    return extractedIntent;
  }
  if (
    (extractedIntent === "leave_update" || extractedIntent === "leave_cancel") &&
    !slots.leaveId &&
    (prevIntent === "leave_create" || isLeaveDraft(slots))
  ) {
    return "leave_create";
  }
  if (
    extractedIntent === "smalltalk" &&
    (prevIntent === "leave_create" || isLeaveDraft(slots))
  ) {
    return "leave_create";
  }
  if (
    extractedIntent === "trip_update" &&
    !slots.tripId &&
    (prevIntent === "trip_create" || isTripDraft(slots))
  ) {
    return "trip_create";
  }
  if (
    extractedIntent === "smalltalk" &&
    (prevIntent === "trip_create" || isTripDraft(slots))
  ) {
    return "trip_create";
  }
  return extractedIntent;
}

export function missingFor(intent: string, slots: Slots): string[] {
  if (intent === "leave_create") {
    const miss: string[] = [];
    if (!slots.leaveType) miss.push("loại phép (năm / ốm / không lương)");
    if (!slots.from) miss.push("ngày bắt đầu (YYYY-MM-DD)");
    if (!slots.to) miss.push("ngày kết thúc (YYYY-MM-DD)");
    if (!slots.reason) miss.push("lý do");
    else if (slots.reason.trim().length < 3) {
      miss.push("lý do rõ hơn (≥ 3 ký tự, ví dụ: ốm đau, việc gia đình)");
    }
    return miss;
  }
  if (intent === "trip_create") {
    const miss: string[] = [];
    if (!slots.destination) miss.push("địa điểm");
    if (!slots.from) miss.push("ngày đi");
    if (!slots.to) miss.push("ngày về");
    if (!slots.purpose) miss.push("mục đích (≥ 10 ký tự)");
    return miss;
  }
  if (intent === "leave_cancel" || intent === "leave_update") {
    return slots.leaveId ? [] : ["mã đơn nghỉ phép"];
  }
  if (intent === "leave_approve" || intent === "trip_list") return [];
  return [];
}

const NAME_STOP =
  /^(đơn|phép|team|tất|cả|hết|ốm|năm|này|nào|đó|ạ|nhé|tôi|mình|bạn|ta|mọi|ai|ngày|tháng|tuần|hôm|thông|tin|chờ|duyệt)$/i;
const TYPE_AS_NAME = /^(ốm|năm|không lương|sick|annual|unpaid|phép ốm|phép năm)$/i;

export function cleanEmployeeHint(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/[.,;!?]/g, "")
    .trim()
    .replace(/\s+(ngày|tháng|tuần|thứ|đơn|phép|lý|vì|do|từ)\b.*$/i, "")
    .replace(/\s+(đơn|phép|team|này|đó|ạ|nhé)$/i, "");
  if (!cleaned || NAME_STOP.test(cleaned) || TYPE_AS_NAME.test(cleaned)) return null;
  if (/\b(team|phép|nghỉ|của|đơn|tất|cả|hết)\b/i.test(cleaned)) return null;
  if (!/^EMP/i.test(cleaned) && /ngày|tháng|tuần|thứ|cưới|gia đình|chờ|duyệt|nào|xin|việc|từ|\d/.test(cleaned)) {
    return null;
  }
  return cleaned;
}

export function parseEmployeeHint(message: string): string | null {
  const code = message.match(/EMP\d+/i)?.[0];
  if (code) return code.toUpperCase();
  const patterns = [
    /(?:nhân viên|nv)\s+([A-Za-zÀ-ỹ0-9]+(?:\s+[A-Za-zÀ-ỹ0-9]+){0,3})/i,
    /của(?:\s+anh|\s+chị|\s+em)?\s+([A-Za-zÀ-ỹ0-9]+(?:\s+[A-Za-zÀ-ỹ0-9]+){0,3})/i,
    /(?:chỉ\s+)?(?:phê\s+)?duyệt\s+(?:đơn|phép)\s+(?:của\s+)?(?:anh\s+|chị\s+)?(?!nghỉ|phép|ốm|năm|team|tất|hết|không|ngày|thứ)([A-Za-zÀ-ỹ]+(?:\s+[A-Za-zÀ-ỹ]+){0,3})/i,
  ];
  for (const re of patterns) {
    const named = message.match(re);
    const hint = cleanEmployeeHint(named?.[1]);
    if (hint) return hint;
  }
  return null;
}
