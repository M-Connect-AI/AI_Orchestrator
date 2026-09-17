/** Format ngày/giờ hiển thị cho user — luôn Asia/Ho_Chi_Minh (+7), dd/mm/yyyy. */

const TZ = "Asia/Ho_Chi_Minh";

function partsOf(iso: string, withTime: boolean) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(withTime
      ? { hour: "2-digit", minute: "2-digit", hour12: false }
      : {}),
  }).formatToParts(d);
}

function pick(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes) {
  return parts.find((p) => p.type === type)?.value ?? "";
}

/** YYYY-MM-DD hoặc ISO datetime → dd/mm/yyyy */
export function formatVnDate(raw: string | null | undefined): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (ymd && !s.includes("T") && s.length <= 10) {
    return `${ymd[3]}/${ymd[2]}/${ymd[1]}`;
  }
  const parts = partsOf(s.includes("T") ? s : `${s}T12:00:00+07:00`, false);
  if (!parts) return s;
  return `${pick(parts, "day")}/${pick(parts, "month")}/${pick(parts, "year")}`;
}

/** ISO datetime → dd/mm/yyyy HH:mm (giờ VN). All-day / date-only → chỉ ngày. */
export function formatVnDateTime(raw: string | null | undefined): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return formatVnDate(s);
  const parts = partsOf(s, true);
  if (!parts) return formatVnDate(s) || s;
  const date = `${pick(parts, "day")}/${pick(parts, "month")}/${pick(parts, "year")}`;
  const hour = pick(parts, "hour");
  const minute = pick(parts, "minute");
  if (!hour) return date;
  return `${date} ${hour}:${minute}`;
}

/** Khoảng ngày YYYY-MM-DD → text VN cho user. */
export function formatVnDateRange(from: string | null | undefined, to: string | null | undefined): string {
  const a = formatVnDate(from);
  const b = formatVnDate(to);
  if (!a && !b) return "";
  if (a && b && a === b) return a;
  if (a && b) return `${a} → ${b}`;
  return a || b;
}

/**
 * Parse giờ VN từ nhiều dạng → local wall-time cho Graph (timeZone Asia/Ho_Chi_Minh):
 * - 2026-09-17T14:00 / 2026-09-17 14:00
 * - 17/09/2026 14:00 / 17-09-2026 14:00
 * - date-only → 00:00:00
 */
export function parseVnDateTimeLocal(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;

  let m =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s) ||
    /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (!m) return null;

  let y: number;
  let mo: number;
  let d: number;
  let hh: number;
  let mm: number;
  let ss: number;
  if (m[1].length === 4) {
    y = Number(m[1]);
    mo = Number(m[2]);
    d = Number(m[3]);
    hh = Number(m[4] ?? 0);
    mm = Number(m[5] ?? 0);
    ss = Number(m[6] ?? 0);
  } else {
    d = Number(m[1]);
    mo = Number(m[2]);
    y = Number(m[3]);
    hh = Number(m[4] ?? 0);
    mm = Number(m[5] ?? 0);
    ss = Number(m[6] ?? 0);
  }
  if (![y, mo, d, hh, mm, ss].every((n) => Number.isFinite(n))) return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mm > 59 || ss > 59) return null;
  return `${pad(y, 4)}-${pad(mo)}-${pad(d)}T${pad(hh)}:${pad(mm)}:${pad(ss)}`;
}

/** Cộng phút vào local datetime `YYYY-MM-DDTHH:mm:ss` (không DST — VN cố định +7). */
export function addMinutesLocal(localDateTime: string, minutes: number): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(localDateTime.trim());
  if (!m) return null;
  const utc = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]) + minutes,
    Number(m[6]),
  );
  // local = UTC+7 wall → trừ 7h khi format lại từ epoch “giả”
  const shifted = new Date(utc);
  return `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
}

function pad(n: number, len = 2) {
  return String(n).padStart(len, "0");
}
