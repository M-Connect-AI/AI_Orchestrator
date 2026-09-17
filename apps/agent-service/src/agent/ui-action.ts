import { ChatConfirmAction, ChatUiAction, ChatUiActionKey } from "@msb/shared";

const OUTLOOK_CALENDAR_URL = "https://outlook.office.com/calendar/view/day";
const OUTLOOK_MAIL_URL = "https://outlook.office.com/mail/";

export function uiAction(
  key: ChatUiActionKey,
  label: string,
  extra?: Partial<Pick<ChatUiAction, "url" | "path">>,
): ChatUiAction {
  return { key, label, ...extra };
}

export function leaveResultsAction(label = "Xem đơn nghỉ phép"): ChatUiAction {
  return uiAction("LEAVE_RESULTS", label, { path: "/leaves" });
}

export function tripResultsAction(label = "Xem đơn công tác"): ChatUiAction {
  return uiAction("TRIP_RESULTS", label, { path: "/trips" });
}

export function outlookCalendarAction(url?: string, label = "Mở lịch Outlook"): ChatUiAction {
  return uiAction("OUTLOOK_CALENDAR", label, { url: url || OUTLOOK_CALENDAR_URL });
}

export function outlookMailAction(url?: string, label = "Mở Outlook Mail"): ChatUiAction {
  return uiAction("OUTLOOK_MAIL", label, { url: url || OUTLOOK_MAIL_URL });
}

export function jiraIssueAction(url: string, label = "Mở trên Jira"): ChatUiAction {
  return uiAction("JIRA_ISSUE", label, { url });
}

export function outlookConnectAction(label = "Kết nối Outlook"): ChatUiAction {
  return uiAction("OUTLOOK_CONNECT", label);
}

export function uiActionFromPendingTool(tool: string | null | undefined): ChatUiAction | null {
  if (!tool) return null;
  if (/trip/i.test(tool)) return tripResultsAction();
  if (/leave/i.test(tool)) return leaveResultsAction();
  return null;
}

/** Suy ra uiAction từ confirm / kết quả đã ghi / preview đọc. */
export function resolveChatUiAction(input: {
  confirm?: ChatConfirmAction | null;
  executed?: unknown;
  preview?: unknown;
  needConnect?: boolean;
}): ChatUiAction | null {
  if (input.needConnect) return outlookConnectAction();

  const executed = asRecord(input.executed);
  if (executed) {
    const jiraUrl = stringField(executed, "url") || stringField(executed, "self");
    const jiraKey = stringField(executed, "key");
    if (jiraUrl && (jiraKey || executed.summary)) {
      return jiraIssueAction(jiraUrl, jiraKey ? `Mở ${jiraKey} trên Jira` : "Mở trên Jira");
    }
    if (executed.event || executed.replied || stringField(executed, "microsoftEmail")) {
      const ev = asRecord(executed.event);
      const webLink = ev ? stringField(ev, "webLink") : undefined;
      if (executed.replied) return outlookMailAction(undefined, "Xem hộp thư Outlook");
      if (ev || executed.event) {
        return outlookCalendarAction(webLink, "Xem lịch Outlook");
      }
    }
    if (executed.destination || looksLikeTripItem(executed)) {
      return tripResultsAction();
    }
    if (executed.type || looksLikeLeaveItem(executed)) {
      return leaveResultsAction();
    }
    // batch approve/reject: { count, items }
    if (executed.items || executed.count != null) {
      const items = Array.isArray(executed.items) ? executed.items : [];
      const first = items.length ? asRecord(items[0]) : null;
      if (first?.destination) return tripResultsAction();
      return leaveResultsAction();
    }
  }

  const confirm = input.confirm;
  if (confirm) {
    if (confirm.tool === "create_jira_task") return null;
    if (confirm.tool === "create_outlook_event") return null;
    if (confirm.tool === "reply_outlook_mail") return null;
    // Đang chờ xác nhận — chưa cần nút màn kết quả
    if (
      /leave|trip/i.test(confirm.tool) ||
      confirm.tool.startsWith("approve_") ||
      confirm.tool.startsWith("reject_") ||
      confirm.tool.startsWith("create_") ||
      confirm.tool.startsWith("cancel_") ||
      confirm.tool.startsWith("update_")
    ) {
      return null;
    }
  }

  const preview = input.preview;
  if (Array.isArray(preview) && preview.length) {
    const first = asRecord(preview[0]);
    if (first?.receivedAt != null || first?.isRead != null) {
      return outlookMailAction(undefined, "Mở Outlook Mail");
    }
    if (first?.showAs != null || (first?.start != null && first?.subject != null && !first?.type)) {
      return outlookCalendarAction(undefined, "Mở lịch Outlook");
    }
    if (first?.destination != null) return tripResultsAction("Xem đơn công tác");
    if (first?.type != null || first?.reason != null) return leaveResultsAction("Xem đơn nghỉ phép");
  }
  if (preview && typeof preview === "object") {
    const p = preview as Record<string, unknown>;
    if (p.mails || p.mail) return outlookMailAction(undefined, "Mở Outlook Mail");
    if (p.events || p.event) return outlookCalendarAction(undefined, "Mở lịch Outlook");
    if (p.annualRemaining != null) return leaveResultsAction("Xem số dư / đơn nghỉ");
    const leaves = Array.isArray(p.leaves) ? p.leaves : [];
    const trips = Array.isArray(p.trips) ? p.trips : [];
    if (leaves.length && !trips.length) return leaveResultsAction("Xem đơn nghỉ phép");
    if (trips.length && !leaves.length) return tripResultsAction("Xem đơn công tác");
    // pending cả hai: ưu tiên nghỉ phép (mobile vẫn có 2 màn riêng)
    if (leaves.length || trips.length) return leaveResultsAction("Xem đơn nghỉ phép");
    if (Array.isArray(p.issues) || p.citations) {
      const url = stringField(p, "url");
      if (url) return jiraIssueAction(url);
    }
  }

  return null;
}

function looksLikeLeaveItem(row: Record<string, unknown>) {
  return row.reason != null || row.type != null || (row._id != null && row.from != null && !row.destination);
}

function looksLikeTripItem(row: Record<string, unknown>) {
  return row.destination != null || row.purpose != null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
