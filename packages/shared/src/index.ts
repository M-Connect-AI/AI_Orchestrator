export const ROLES = ["STAFF", "MANAGER"] as const;
export type Role = (typeof ROLES)[number];

export const LEAVE_TYPES = ["ANNUAL", "SICK", "UNPAID"] as const;
export type LeaveType = (typeof LEAVE_TYPES)[number];

export const REQUEST_STATUSES = ["PENDING", "APPROVED", "REJECTED", "CANCELLED"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export type EmployeePublic = {
  id: string;
  employeeCode: string;
  email: string;
  fullName: string;
  role: Role;
  department: string;
  managerEmployeeCode?: string;
};

export type LeaveBalance = {
  employeeCode: string;
  annualRemaining: number;
  annualTotal: number;
  sickRemaining: number;
};

export type LeaveRequest = {
  id: string;
  employeeCode: string;
  type: LeaveType;
  from: string;
  to: string;
  days: number;
  reason: string;
  status: RequestStatus;
  createdAt: string;
};

export type BusinessTrip = {
  id: string;
  employeeCode: string;
  destination: string;
  from: string;
  to: string;
  purpose: string;
  status: RequestStatus;
  createdAt: string;
};

export const AGENT_INTENTS = [
  "leave_create",
  "leave_update",
  "leave_cancel",
  "leave_list",
  "leave_balance",
  "leave_approve",
  "trip_create",
  "trip_list",
  "policy_qa",
  "smalltalk",
  "out_of_scope",
] as const;
export type AgentIntent = (typeof AGENT_INTENTS)[number];

export type ChatConfirmAction = {
  tool: string;
  args: Record<string, unknown>;
  summary: string;
};

/**
 * Key điều hướng cho frontend / mobile.
 * Client map key → màn hình in-app hoặc mở URL ngoài.
 */
export const CHAT_UI_ACTION_KEYS = [
  "NONE",
  /** Màn đơn nghỉ phép */
  "LEAVE_RESULTS",
  /** Màn đơn công tác */
  "TRIP_RESULTS",
  /** Mở Outlook Calendar (web / deep link) */
  "OUTLOOK_CALENDAR",
  /** Mở Outlook Mail */
  "OUTLOOK_MAIL",
  /** Mở Jira issue / board */
  "JIRA_ISSUE",
  /** Nút Kết nối Outlook trong app */
  "OUTLOOK_CONNECT",
] as const;
export type ChatUiActionKey = (typeof CHAT_UI_ACTION_KEYS)[number];

export type ChatUiAction = {
  key: ChatUiActionKey;
  /** Text nút hiển thị trên UI */
  label: string;
  /** Deep link / URL ngoài (Outlook, Jira) */
  url?: string;
  /** Path in-app (web SPA), ví dụ /leaves hoặc /trips */
  path?: string;
};

/** Chip gợi ý bước tiếp theo — tap gửi `text` như tin nhắn user. */
export type ChatSuggestion = {
  /** Chữ trên chip (ngắn) */
  label: string;
  /** Câu gửi lên agent */
  text: string;
};

/** Span highlight trên `content` — index UTF-16 (JS/Java/Swift UTF-16). end exclusive. */
export const CHAT_HIGHLIGHT_KINDS = ["date", "metric", "status", "id", "warn"] as const;
export type ChatHighlightKind = (typeof CHAT_HIGHLIGHT_KINDS)[number];

export const CHAT_KPI_TONES = ["ok", "warn", "bad", "neutral"] as const;
export type ChatKpiTone = (typeof CHAT_KPI_TONES)[number];

export type ChatHighlight = {
  start: number;
  end: number;
  kind: ChatHighlightKind;
  /** Với kind=status: ok=đã duyệt, warn=chờ duyệt, bad=từ chối/quá hạn, neutral=đã hủy. */
  tone?: ChatKpiTone;
};

export type ChatKpiItem = {
  label: string;
  value: string;
  tone?: ChatKpiTone;
};

export type ChatChartItem = {
  label: string;
  value: number;
  color?: string;
};

export type ChatListItem = {
  title: string;
  subtitle?: string;
  /** Dòng phụ phía trên title (vd. người gửi mail) */
  kicker?: string;
  badge?: string;
  tone?: ChatKpiTone;
  url?: string;
};

/**
 * Widget giàu trong bubble assistant. `content` vẫn là text thuần (fallback).
 * Không nhét confirm / uiAction vào đây — giữ field riêng như cũ.
 */
export const CHAT_BLOCK_TYPES = ["kpis", "bars", "donut", "progress", "list", "quote"] as const;
export type ChatBlockType = (typeof CHAT_BLOCK_TYPES)[number];

export type ChatKpisBlock = { type: "kpis"; items: ChatKpiItem[] };
export type ChatBarsBlock = { type: "bars"; title: string; items: ChatChartItem[] };
export type ChatDonutBlock = { type: "donut"; title: string; items: ChatChartItem[] };
export type ChatProgressBlock = {
  type: "progress";
  title: string;
  value: number;
  max: number;
  suffix?: string;
};
export type ChatListBlock = { type: "list"; title?: string; items: ChatListItem[] };
export type ChatQuoteBlock = { type: "quote"; title: string; text: string; source?: string };

export type ChatBlock =
  | ChatKpisBlock
  | ChatBarsBlock
  | ChatDonutBlock
  | ChatProgressBlock
  | ChatListBlock
  | ChatQuoteBlock;

export type SseEventType = "token" | "message" | "confirm" | "result" | "done" | "error";
