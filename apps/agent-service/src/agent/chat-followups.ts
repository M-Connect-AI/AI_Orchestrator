import { ChatBlock, ChatConfirmAction, ChatSuggestion, ChatUiAction, Role } from "@msb/shared";

const MAX = 3;

export type FollowUpInput = {
  role: Role;
  confirm?: ChatConfirmAction | null;
  uiAction?: ChatUiAction | null;
  didMutate?: boolean;
  blocks?: ChatBlock[];
  citations?: string[];
  userMessage?: string;
  reply?: string;
};

type Completer = (
  messages: { role: string; content: string }[],
  opts?: { temperature?: number; max_tokens?: number },
) => Promise<string>;

export async function suggestFollowUps(
  input: FollowUpInput,
  complete: Completer,
): Promise<ChatSuggestion[]> {
  if (input.confirm) return [];
  try {
    const raw = await complete(
      [
        { role: "system", content: FOLLOWUP_SYSTEM },
        { role: "user", content: JSON.stringify(followUpPayload(input)) },
      ],
      { temperature: 0.3, max_tokens: 220 },
    );
    const parsed = parseSuggestions(raw);
    const cleaned = sanitize(parsed, input);
    if (cleaned.length) return cleaned;
  } catch {
    /* fallback */
  }
  return sanitize(buildFollowUps(input), input);
}

/** Fallback khi LLM lỗi — ưu tiên uiAction.key, không nhảy domain. */
export function buildFollowUps(input: FollowUpInput): ChatSuggestion[] {
  if (input.confirm) return [];
  const isManager = input.role === "MANAGER";
  const key = input.uiAction?.key;
  const asked = `${input.userMessage ?? ""} ${input.reply ?? ""}`;
  const blocks = input.blocks ?? [];
  const hasProgress = blocks.some((b) => b.type === "progress");
  const mailList = blocks.some((b) => b.type === "list" && /hộp thư|mail/i.test(b.title ?? ""));
  const leaveCards = blocks.some(
    (b) => b.type === "list" && /nghỉ phép|đơn nghỉ/i.test(b.title ?? ""),
  );

  let items: ChatSuggestion[] = [];
  if (key === "OUTLOOK_MAIL" || mailList || /mail|email|hộp thư/i.test(asked)) {
    items = [
      s("Tóm tắt mail đầu tiên"),
      s("Tóm tắt mail chưa đọc"),
      s("Lịch hôm nay"),
    ];
  } else if (key === "OUTLOOK_CALENDAR" || /lịch|họp|calendar/i.test(asked)) {
    items = [s("Mail chưa đọc hôm nay"), s("Lịch ngày mai")];
  } else if (key === "OUTLOOK_CONNECT") {
    items = [s("Xem hộp thư của tôi"), s("Lịch hôm nay")];
  } else if (key === "JIRA_ISSUE" || /jira|backlog|task jira/i.test(asked)) {
    items = [s("Phân tích backlog Jira của tôi"), s("Liệt kê task Jira đang làm")];
  } else if (key === "TRIP_RESULTS" || /công tác/i.test(asked)) {
    items = isManager
      ? [s("Duyệt các đơn công tác đang chờ"), s("Đơn phép team đang chờ duyệt")]
      : [s("Xin công tác tuần sau"), s("Lịch hôm nay")];
  } else if (key === "LEAVE_RESULTS" || leaveCards || hasProgress || /phép|nghỉ/i.test(asked)) {
    if (hasProgress && !leaveCards) {
      items = isManager
        ? [s("Đơn phép team đang chờ duyệt"), s("Xem đơn nghỉ phép của tôi")]
        : [s("Xem đơn nghỉ phép của tôi"), s("Xin nghỉ phép năm ngày mai")];
    } else {
      items = isManager
        ? [s("Duyệt các đơn nghỉ phép đang chờ"), s("Đơn công tác team đang chờ duyệt")]
        : [s("Tôi còn bao nhiêu ngày phép?"), s("Xin nghỉ phép năm tuần sau")];
    }
  } else if (input.didMutate) {
    items = [s("Xem đơn nghỉ phép của tôi"), s("Lịch hôm nay")];
  } else {
    items = isManager
      ? [s("Đơn phép team đang chờ duyệt"), s("Phân tích backlog Jira của tôi")]
      : [s("Tôi còn bao nhiêu ngày phép?"), s("Thống kê task Jira của tôi")];
  }
  return sanitize(items, input);
}

const FOLLOWUP_SYSTEM = `Bạn đề xuất bước tiếp theo trên chat M-Mate (MSB).
Trả về JSON array 2 hoặc 3 chuỗi chip: [{"label":"...","text":"..."}]. Không markdown.

QUAN TRỌNG: label và text PHẢI GIỐNG NHAU. Đó chính là tin nhắn sẽ gửi khi user bấm chip. Không viết label ngắn rồi text dài khác nghĩa.

Ví dụ đúng: {"label":"Tóm tắt mail đầu tiên","text":"Tóm tắt mail đầu tiên"}
Ví dụ sai: {"label":"Tóm tắt hộp thư","text":"Liệt kê lại tất cả mail"}

Câu 2–8 từ, tiếng Việt, đủ để gửi ngay.

BẮT BUỘC:
- Bám đúng chủ đề lượt vừa rồi (mail → mail/lịch; phép → phép; Jira → Jira; công tác → công tác). Không nhảy domain khác.
- Việc user có thể làm tiếp — không lặp đúng câu vừa hỏi.
- Sau danh sách mail: gợi ý đọc/tóm tắt 1 thư (vd. "Tóm tắt mail đầu tiên"), không gợi ý liệt kê lại hộp thư.
- Không trùng nút UI (uiAction.label).
- Không bịa tiêu đề mail, mã đơn, mã Jira.
- STAFF không gợi ý duyệt đơn người khác.`;

function followUpPayload(input: FollowUpInput) {
  const blockHint = (input.blocks ?? [])
    .map((b) => {
      if (b.type === "kpis") return `kpis:${b.items.map((i) => `${i.label}=${i.value}`).join(",")}`;
      if (b.type === "list") return `list:${b.title ?? ""} (${b.items.length})`;
      if (b.type === "progress") return `progress:${b.title}`;
      if (b.type === "quote") return `quote:${b.title}`;
      if (b.type === "bars" || b.type === "donut") return `${b.type}:${b.title}`;
      return "";
    })
    .slice(0, 6);
  return {
    role: input.role,
    userMessage: clip(input.userMessage ?? "", 180),
    assistantReply: clip(input.reply ?? "", 280),
    uiAction: input.uiAction
      ? { key: input.uiAction.key, label: input.uiAction.label }
      : null,
    didMutate: Boolean(input.didMutate),
    blocks: blockHint,
  };
}

function parseSuggestions(raw: string): ChatSuggestion[] {
  const t = raw.replace(/```(?:json)?/gi, "").trim();
  const start = t.indexOf("[");
  const end = t.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const arr = JSON.parse(t.slice(start, end + 1)) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .map((row) => {
        const rec = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
        const label = String(rec.label ?? rec.title ?? "").replace(/\s+/g, " ").trim();
        const text = String(rec.text ?? rec.message ?? rec.query ?? "").replace(/\s+/g, " ").trim();
        return label && text ? { label: clip(label, 42), text: clip(text, 90) } : null;
      })
      .filter((x): x is ChatSuggestion => Boolean(x));
  } catch {
    return [];
  }
}

function sanitize(items: ChatSuggestion[], input: FollowUpInput): ChatSuggestion[] {
  const action = (input.uiAction?.label ?? "").trim().toLowerCase();
  const user = (input.userMessage ?? "").trim().toLowerCase();
  const seen = new Set<string>();
  const out: ChatSuggestion[] = [];
  for (const i of items) {
    const label = clip(i.label.trim(), 42);
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    if (action && (key === action || action.includes(key))) continue;
    if (user && overlaps(user, key)) continue;
    seen.add(key);
    out.push({ label, text: label });
    if (out.length >= MAX) break;
  }
  return out;
}

function overlaps(a: string, b: string) {
  const na = a.replace(/[?.!,]/g, "").replace(/\s+/g, " ").trim();
  const nb = b.replace(/[?.!,]/g, "").replace(/\s+/g, " ").trim();
  if (!na || !nb) return false;
  if (na === nb) return true;
  return na.length >= 10 && nb.length >= 10 && (na.includes(nb) || nb.includes(na));
}

function s(phrase: string): ChatSuggestion {
  return { label: phrase, text: phrase };
}

function clip(text: string, max: number) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
