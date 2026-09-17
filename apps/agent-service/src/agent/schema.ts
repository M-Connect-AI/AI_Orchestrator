import { LEAVE_TYPES, REQUEST_STATUSES } from "@msb/shared";

export type Slots = {
  leaveType: (typeof LEAVE_TYPES)[number] | null;
  from: string | null;
  to: string | null;
  reason: string | null;
  leaveId: string | null;
  employeeHint: string | null;
  status: (typeof REQUEST_STATUSES)[number] | null;
  daysHint: string | null;
  ordinal: string | null;
  listedIds: string | null;
  /** Id mail từ outlook_list_mails gần nhất (phân tách bằng `\n`). */
  listedMailIds: string | null;
  destination: string | null;
  purpose: string | null;
  tripId: string | null;
};

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
    listedMailIds: null,
    destination: null,
    purpose: null,
    tripId: null,
  };
}

/**
 * Chuẩn hóa ngày VN → YYYY-MM-DD.
 * - rollPastToNextYear=true (tạo đơn): "6/9" đã qua → năm sau (đặt lịch tương lai).
 * - rollPastToNextYear=false (lọc/duyệt): giữ đúng năm hiện tại, không nhảy năm.
 */
export function normalizeVnDate(
  raw: string | null | undefined,
  opts?: { rollPastToNextYear?: boolean },
): string | null {
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
  if (opts?.rollPastToNextYear !== false && !m[3]) {
    const start = new Date(`${iso}T00:00:00`);
    const today = new Date(vnYear, vnMonth - 1, vnDay);
    if (start < today) {
      return `${year + 1}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }
  return iso;
}
