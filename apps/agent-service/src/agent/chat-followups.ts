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

/** Chip từ model nếu có; không thì rule domain. Không gọi LLM thêm. */
export function resolveFollowUps(
  fromModel: ChatSuggestion[] | undefined,
  input: FollowUpInput,
): ChatSuggestion[] {
  if (input.confirm) return [];
  const cleaned = sanitize(fromModel ?? [], input);
  if (cleaned.length) return cleaned;
  return buildFollowUps(input);
}

/** Chip bước tiếp theo khi model không gọi suggest_follow_ups. */
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
