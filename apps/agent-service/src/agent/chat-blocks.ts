import {
  ChatBlock,
  ChatChartItem,
  ChatHighlight,
  ChatKpiItem,
  ChatKpiTone,
  ChatListItem,
} from "@msb/shared";
import { formatVnDate, formatVnDateTime } from "./datetime-vn";
import { JiraIssue, summarizeJiraIssues } from "../jira/jira-summary";

const COLOR = {
  orange: "#F15A22",
  orangeSoft: "#F5A06B",
  orangeDeep: "#C7370F",
  gold: "#E8A317",
  taupe: "#C4B5A5",
  ink: "#1C1410",
};

const LIST_CAP = 8;

export function highlightChatText(text: string): ChatHighlight[] {
  if (!text) return [];
  const cands: ChatHighlight[] = [];
  collect(cands, text, /\b[A-Z][A-Z0-9]{1,10}-\d+\b/g, "id");
  collect(cands, text, /\bEMP\d+\b/gi, "id");
  collect(cands, text, /\d{1,2}\/\d{1,2}(?:\/\d{2,4})(?:\s+\d{1,2}:\d{2})?/g, "date");
  collect(cands, text, /\d{1,2}:\d{2}(?!\d)/g, "date");
  collect(
    cands,
    text,
    /\d+(?:[.,]\d+)?(?:\s*\/\s*\d+(?:[.,]\d+)?)?\s*(?:ngày|task|đơn|mail|sự kiện|%)/gi,
    "metric",
  );
  collectStatus(cands, text);
  collect(cands, text, /(?:trùng lịch|chưa kết nối Outlook)/gi, "warn");
  cands.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: ChatHighlight[] = [];
  for (const c of cands) {
    if (c.end <= c.start || c.start < 0 || c.end > text.length) continue;
    if (out.some((o) => c.start < o.end && c.end > o.start)) continue;
    out.push(c);
  }
  return out.sort((a, b) => a.start - b.start);
}

export function buildChatBlocks(input: {
  preview?: unknown;
  executed?: unknown;
  citations?: string[];
}): ChatBlock[] {
  const source = input.executed ?? input.preview;
  const fromData = blocksFromUnknown(source);
  const quotes = quotesFromPreview(input.preview) ?? quotesFromCitations(input.citations);
  return capBlocks([...fromData, ...quotes]);
}

/** Câu nói ngắn từ payload API — không để LLM bịa lại danh sách. */
export function spokenFactsFromPreview(preview: unknown): string | null {
  if (preview == null) return null;
  if (Array.isArray(preview) && preview.length) {
    const rows = preview.map(asRecord).filter(Boolean) as Record<string, unknown>[];
    if (!rows.length) return null;
    if (rows.every(isLeave)) return leaveSpoken(rows);
    if (rows.every(isTrip)) return tripSpoken(rows);
    if (rows.every(isMail)) return mailSpoken(rows);
    if (rows.every(isEvent)) return eventSpoken(rows);
    if (rows.every(isJiraIssue)) {
      return `Hiện có ${rows.length} task khớp bộ lọc.`;
    }
  }
  const rec = asRecord(preview);
  if (!rec) return null;
  if (isEvent(rec)) return eventSpoken([rec]);
  if (isBalance(rec)) {
    return `Bạn còn ${num(rec.annualRemaining)}/${num(rec.annualTotal)} ngày phép năm, khung phép ốm ${num(rec.sickRemaining)} ngày.`;
  }
  if (Array.isArray(rec.leaves) || Array.isArray(rec.trips)) {
    const leaves = Array.isArray(rec.leaves)
      ? rec.leaves.map(asRecord).filter((r): r is Record<string, unknown> => Boolean(r && isLeave(r)))
      : [];
    const trips = Array.isArray(rec.trips)
      ? rec.trips.map(asRecord).filter((r): r is Record<string, unknown> => Boolean(r && isTrip(r)))
      : [];
    return `Đang chờ duyệt ${leaves.length} đơn nghỉ phép và ${trips.length} đơn công tác.`;
  }
  if (Array.isArray(rec.issues) || rec.stats) {
    const n = Array.isArray(rec.issues) ? rec.issues.length : 0;
    return n ? `Hiện có ${n} task khớp bộ lọc.` : "Hiện chưa có task Jira khớp bộ lọc.";
  }
  return null;
}

function leaveSpoken(rows: Record<string, unknown>[]) {
  if (!rows.length) return "Bạn chưa có đơn nghỉ phép nào.";
  const pending = rows.filter((r) => String(r.status ?? "").toUpperCase() === "PENDING").length;
  const approved = rows.filter((r) => String(r.status ?? "").toUpperCase() === "APPROVED").length;
  const rejected = rows.filter((r) => String(r.status ?? "").toUpperCase() === "REJECTED").length;
  const bits: string[] = [];
  if (pending) bits.push(`${pending} đang chờ duyệt`);
  if (approved) bits.push(`${approved} đã được duyệt`);
  if (rejected) bits.push(`${rejected} bị từ chối`);
  return bits.length
    ? `Bạn có ${rows.length} đơn nghỉ phép: ${bits.join(", ")}.`
    : `Bạn có ${rows.length} đơn nghỉ phép.`;
}

function tripSpoken(rows: Record<string, unknown>[]) {
  if (!rows.length) return "Bạn chưa có đơn công tác nào.";
  const pending = rows.filter((r) => String(r.status ?? "").toUpperCase() === "PENDING").length;
  return pending
    ? `Bạn có ${rows.length} đơn công tác, trong đó ${pending} đang chờ duyệt.`
    : `Bạn có ${rows.length} đơn công tác.`;
}

function mailSpoken(rows: Record<string, unknown>[]) {
  if (!rows.length) return "Không có mail nào khớp.";
  const unread = rows.filter((r) => r.isRead === false).length;
  return unread
    ? `Có ${rows.length} mail, trong đó ${unread} chưa đọc.`
    : `Có ${rows.length} mail.`;
}

function eventSpoken(rows: Record<string, unknown>[]) {
  if (!rows.length) return "Không có sự kiện trên lịch trong khoảng này.";
  if (rows.length === 1) return oneEventSpoken(rows[0]);
  return `Có ${rows.length} sự kiện trên lịch.`;
}

function oneEventSpoken(row: Record<string, unknown>) {
  const title = String(row.subject ?? "").trim() || "(không tiêu đề)";
  const when = formatEventWhen(row);
  const loc = String(row.location ?? "").trim();
  const locBit = loc ? ` tại ${loc}` : "";
  return `Bạn có sự kiện “${title}” ${when}${locBit}.`;
}

function collect(
  into: ChatHighlight[],
  text: string,
  re: RegExp,
  kind: ChatHighlight["kind"],
  tone?: ChatKpiTone,
) {
  const r = re.global ? re : new RegExp(re.source, `${re.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = r.exec(text))) {
    into.push({ start: m.index, end: m.index + m[0].length, kind, ...(tone ? { tone } : {}) });
  }
}

function collectStatus(into: ChatHighlight[], text: string) {
  const rules: { re: RegExp; tone: ChatKpiTone }[] = [
    { re: /đã duyệt/gi, tone: "ok" },
    { re: /đã đọc/gi, tone: "ok" },
    { re: /chờ duyệt/gi, tone: "warn" },
    { re: /chưa đọc/gi, tone: "warn" },
    { re: /từ chối/gi, tone: "bad" },
    { re: /quá hạn/gi, tone: "bad" },
    { re: /đã hủy/gi, tone: "neutral" },
  ];
  for (const rule of rules) collect(into, text, rule.re, "status", rule.tone);
}

function capBlocks(blocks: ChatBlock[]): ChatBlock[] {
  const out: ChatBlock[] = [];
  let quotes = 0;
  for (const b of blocks) {
    if (b.type === "quote") {
      if (quotes >= 2) continue;
      quotes += 1;
      out.push({ ...b, text: clip(b.text, 320) });
      continue;
    }
    if (b.type === "list") {
      out.push({ ...b, items: b.items.slice(0, LIST_CAP) });
      continue;
    }
    if (b.type === "bars" || b.type === "donut") {
      out.push({ ...b, items: b.items.slice(0, 6) });
      continue;
    }
    out.push(b);
  }
  return out.filter((b) => {
    if (b.type === "kpis") return b.items.length > 0;
    if (b.type === "bars" || b.type === "donut") return b.items.length > 0;
    if (b.type === "list") return b.items.length > 0;
    if (b.type === "progress") return b.max > 0;
    return true;
  });
}

function blocksFromUnknown(value: unknown): ChatBlock[] {
  if (value == null) return [];
  const rec = asRecord(value);
  if (rec?.policyChunks) return [];
  if (rec && isBalance(rec)) return balanceBlocks(rec);
  if (rec && (Array.isArray(rec.leaves) || Array.isArray(rec.trips))) {
    return pendingBundleBlocks(rec);
  }
  if (rec && (Array.isArray(rec.issues) || rec.stats)) {
    const rows = Array.isArray(rec.issues)
      ? rec.issues.map(asRecord).filter((r): r is Record<string, unknown> => Boolean(r && isJiraIssue(r)))
      : [];
    return jiraBlocks(rows.map(toJira));
  }
  if (rec && isMail(rec)) return mailList([rec], "Chi tiết");
  if (rec && isEvent(rec)) return eventList([rec], "Lịch");
  if (rec && isJiraIssue(rec)) return jiraBlocks([toJira(rec)]);
  if (rec && isLeave(rec)) return leaveList([rec], "Đơn nghỉ phép");
  if (rec && isTrip(rec)) return tripList([rec], "Đơn công tác");
  if (rec && Array.isArray(rec.items) && rec.items.length) {
    return blocksFromUnknown(rec.items);
  }
  if (rec && Array.isArray(rec.issues) && rec.issues.length) {
    return blocksFromUnknown(rec.issues);
  }
  if (Array.isArray(value) && value.length) {
    const rows = value.map(asRecord).filter(Boolean) as Record<string, unknown>[];
    if (!rows.length) return [];
    if (rows.every(isJiraIssue)) return jiraBlocks(rows.map(toJira));
    if (rows.every(isLeave)) return leaveList(rows, "Đơn nghỉ phép");
    if (rows.every(isTrip)) return tripList(rows, "Đơn công tác");
    if (rows.every(isMail)) return mailList(rows, "Hộp thư");
    if (rows.every(isEvent)) return eventList(rows, "Lịch");
    if (rows.some(isLeave) && rows.some(isTrip)) {
      return pendingBundleBlocks({
        leaves: rows.filter(isLeave),
        trips: rows.filter(isTrip),
      });
    }
  }
  return [];
}

function quotesFromPreview(preview: unknown): ChatBlock[] {
  const rec = asRecord(preview);
  const chunks = rec && Array.isArray(rec.policyChunks) ? rec.policyChunks : null;
  if (!chunks?.length) return [];
  return chunks
    .map((c) => asRecord(c))
    .filter(Boolean)
    .map((c) => ({
      type: "quote" as const,
      title: String(c!.title ?? "Quy định"),
      text: String(c!.text ?? "").trim(),
      source: String(c!.source ?? "") || undefined,
    }))
    .filter((q) => q.text);
}

function quotesFromCitations(citations?: string[]): ChatBlock[] {
  if (!citations?.length) return [];
  // Jira citations là URL — không biến thành quote.
  const policy = citations.filter((c) => c && !/^https?:\/\//i.test(c) && !/\/browse\//i.test(c));
  return policy.slice(0, 2).map((c) => ({
    type: "quote" as const,
    title: "Nguồn quy định",
    text: c,
  }));
}

function balanceBlocks(b: Record<string, unknown>): ChatBlock[] {
  const remaining = num(b.annualRemaining);
  const total = num(b.annualTotal);
  const sick = num(b.sickRemaining);
  const items: ChatKpiItem[] = [
    { label: "Phép năm còn", value: `${remaining} ngày`, tone: remaining <= 2 ? "warn" : "ok" },
    { label: "Phép năm tổng", value: `${total} ngày`, tone: "neutral" },
    { label: "Khung phép ốm", value: `${sick} ngày`, tone: "neutral" },
  ];
  const blocks: ChatBlock[] = [{ type: "kpis", items }];
  if (total > 0) {
    blocks.push({
      type: "progress",
      title: "Phép năm đã dùng",
      value: Math.max(0, total - remaining),
      max: total,
      suffix: "ngày",
    });
  }
  return blocks;
}

function pendingBundleBlocks(rec: Record<string, unknown>): ChatBlock[] {
  const leaves = Array.isArray(rec.leaves)
    ? rec.leaves.map(asRecord).filter((r): r is Record<string, unknown> => Boolean(r && isLeave(r)))
    : [];
  const trips = Array.isArray(rec.trips)
    ? rec.trips.map(asRecord).filter((r): r is Record<string, unknown> => Boolean(r && isTrip(r)))
    : [];
  const blocks: ChatBlock[] = [
    {
      type: "kpis",
      items: [
        { label: "Nghỉ phép chờ", value: String(leaves.length), tone: leaves.length ? "warn" : "ok" },
        { label: "Công tác chờ", value: String(trips.length), tone: trips.length ? "warn" : "ok" },
      ],
    },
  ];
    if (leaves.length) blocks.push(...leaveList(leaves, "Nghỉ phép", false));
    if (trips.length) blocks.push(...tripList(trips, "Công tác", false));
  return blocks;
}

function jiraBlocks(issues: JiraIssue[]): ChatBlock[] {
  const stats = summarizeJiraIssues(issues);
  const kpis: ChatKpiItem[] = [
    { label: "Cần làm", value: String(stats.toDo), tone: stats.toDo ? "warn" : "neutral" },
    { label: "Đang làm", value: String(stats.inProgress), tone: "neutral" },
    { label: "Đã làm", value: String(stats.done), tone: stats.done ? "ok" : "neutral" },
  ];
  if (stats.overdue) kpis.push({ label: "Quá hạn", value: String(stats.overdue), tone: "bad" });
  else if (stats.stale) kpis.push({ label: "Lâu chưa cập nhật", value: String(stats.stale), tone: "warn" });

  const statusItems: ChatChartItem[] = [
    { label: "Cần làm", value: stats.toDo, color: COLOR.orange },
    { label: "Đang làm", value: stats.inProgress, color: COLOR.orangeSoft },
    { label: "Đã làm", value: stats.done, color: COLOR.taupe },
  ];

  const blocks: ChatBlock[] = [
    { type: "kpis", items: kpis },
    { type: "bars", title: "Theo trạng thái", items: statusItems },
  ];
  if (stats.total > 0) {
    const donutItems = statusItems.filter((i) => i.value > 0);
    if (donutItems.length) {
      blocks.push({ type: "donut", title: "Cơ cấu việc", items: donutItems });
    }
  }
  const priorityBars = chartFromMap(stats.byPriority, priorityColor);
  if (priorityBars.length) {
    blocks.push({ type: "bars", title: "Theo độ ưu tiên", items: priorityBars });
  }
  const riskBars = [
    { label: "Quá hạn", value: stats.overdue, color: COLOR.orangeDeep },
    { label: "Thiếu due date", value: stats.withoutDueDate, color: COLOR.gold },
    { label: "Lâu chưa cập nhật", value: stats.stale, color: COLOR.orangeSoft },
  ].filter((i) => i.value > 0);
  if (riskBars.length) {
    blocks.push({ type: "bars", title: "Rủi ro backlog", items: riskBars });
  }
  const ranked = [...issues]
    .filter((i) => i.statusCategory !== "DONE")
    .sort(compareJira)
    .slice(0, LIST_CAP);
  const listSource = ranked.length ? ranked : issues.slice(0, LIST_CAP);
  if (listSource.length) {
    blocks.push({
      type: "list",
      title: ranked.length ? "Cần ưu tiên" : "Task",
      items: listSource.map(jiraListItem),
    });
  }
  return blocks;
}

function leaveList(rows: Record<string, unknown>[], title: string, withKpis = true): ChatBlock[] {
  const pending = rows.filter((r) => String(r.status ?? "").toUpperCase() === "PENDING").length;
  const approved = rows.filter((r) => String(r.status ?? "").toUpperCase() === "APPROVED").length;
  const rejected = rows.filter((r) => String(r.status ?? "").toUpperCase() === "REJECTED").length;
  const kpis: ChatKpiItem[] = [
    { label: "Tổng đơn", value: String(rows.length), tone: "neutral" },
    { label: "Chờ duyệt", value: String(pending), tone: pending ? "warn" : "ok" },
    { label: "Đã duyệt", value: String(approved), tone: approved ? "ok" : "neutral" },
  ];
  if (rejected) kpis.push({ label: "Từ chối", value: String(rejected), tone: "bad" });
  const blocks: ChatBlock[] = [];
  if (withKpis) blocks.push({ type: "kpis", items: kpis });
  blocks.push({
    type: "list",
    title,
    items: rows.map((r) => ({
      title: `${labelLeaveType(String(r.type ?? ""))} · ${String(r.employeeName || r.employeeCode || "")}`.trim(),
      subtitle: `${formatVnDate(String(r.from ?? ""))} → ${formatVnDate(String(r.to ?? ""))}${
        r.days != null ? ` · ${r.days} ngày` : ""
      }${r.reason ? ` · ${clip(String(r.reason), 80)}` : ""}`,
      badge: labelStatus(String(r.status ?? "")),
      tone: statusTone(String(r.status ?? "")),
    })),
  });
  return blocks;
}

function tripList(rows: Record<string, unknown>[], title: string, withKpis = true): ChatBlock[] {
  const pending = rows.filter((r) => String(r.status ?? "").toUpperCase() === "PENDING").length;
  const approved = rows.filter((r) => String(r.status ?? "").toUpperCase() === "APPROVED").length;
  const kpis: ChatKpiItem[] = [
    { label: "Tổng đơn", value: String(rows.length), tone: "neutral" },
    { label: "Chờ duyệt", value: String(pending), tone: pending ? "warn" : "ok" },
    { label: "Đã duyệt", value: String(approved), tone: approved ? "ok" : "neutral" },
  ];
  const blocks: ChatBlock[] = [];
  if (withKpis) blocks.push({ type: "kpis", items: kpis });
  blocks.push({
    type: "list",
    title,
    items: rows.map((r) => ({
      title: `${String(r.destination ?? "Công tác")} · ${String(r.employeeName || r.employeeCode || "")}`.trim(),
      subtitle: `${formatVnDate(String(r.from ?? ""))} → ${formatVnDate(String(r.to ?? ""))}${
        r.purpose ? ` · ${clip(String(r.purpose), 80)}` : ""
      }`,
      badge: labelStatus(String(r.status ?? "")),
      tone: statusTone(String(r.status ?? "")),
    })),
  });
  return blocks;
}

function mailList(rows: Record<string, unknown>[], title: string): ChatBlock[] {
  const unread = rows.filter((r) => r.isRead === false).length;
  const list: ChatBlock = {
    type: "list",
    title: rows.length > 1 ? title : undefined,
    items: rows.map((r) => {
      const when = r.receivedAt ? formatVnDateTime(String(r.receivedAt)) : "";
      const attach = r.hasAttachments ? " · Có file đính kèm" : "";
      const preview = String(r.preview ?? r.body ?? "").replace(/\s+/g, " ").trim();
      return {
        kicker: [String(r.from ?? "").trim(), when].filter(Boolean).join(" · "),
        title: String(r.subject ?? "(không tiêu đề)"),
        subtitle: `${preview ? clip(preview, 140) : "Không có xem trước"}${attach}`,
        badge: r.isRead === false ? "Chưa đọc" : "Đã đọc",
        tone: r.isRead === false ? ("warn" as const) : ("neutral" as const),
      };
    }),
  };
  if (rows.length <= 1) return [list];
  return [
    {
      type: "kpis",
      items: [
        { label: "Mail", value: String(rows.length), tone: "neutral" },
        { label: "Chưa đọc", value: String(unread), tone: unread ? "warn" : "ok" },
      ],
    },
    list,
  ];
}

function eventList(rows: Record<string, unknown>[], title: string): ChatBlock[] {
  const list: ChatBlock = {
    type: "list",
    title: rows.length > 1 ? title : undefined,
    items: rows.map((r) => ({
      title: String(r.subject ?? "(không tiêu đề)"),
      subtitle: [formatEventWhen(r), r.location ? String(r.location) : ""]
        .filter(Boolean)
        .join(" · "),
      badge: String(r.showAs ?? "") || undefined,
      url: typeof r.webLink === "string" ? r.webLink : undefined,
      tone: "neutral",
    })),
  };
  if (rows.length <= 1) return [list];
  return [
    {
      type: "kpis",
      items: [{ label: "Sự kiện", value: String(rows.length), tone: rows.length ? "neutral" : "ok" }],
    },
    list,
  ];
}

function jiraListItem(issue: JiraIssue): ChatListItem {
  const due = issue.dueDate ? `hạn ${formatVnDate(issue.dueDate)}` : "chưa có hạn";
  const tone: ChatKpiTone =
    issue.statusCategory !== "DONE" && issue.dueDate && issue.dueDate < todayYmd()
      ? "bad"
      : issue.statusCategory === "DONE"
        ? "ok"
        : "neutral";
  return {
    title: `${issue.key}: ${issue.summary}`,
    subtitle: `${issue.status} · ${issue.priority} · ${due}`,
    badge: issue.status,
    tone,
    url: issue.url || undefined,
  };
}

function chartFromMap(
  map: Record<string, number>,
  colorOf: (label: string) => string,
): ChatChartItem[] {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, value]) => ({ label, value, color: colorOf(label) }));
}

function priorityColor(label: string) {
  const k = label.toLowerCase();
  if (k.includes("highest") || k.includes("high") || k.includes("cao")) return COLOR.orangeDeep;
  if (k.includes("low") || k.includes("thấp")) return COLOR.taupe;
  return COLOR.orange;
}

function compareJira(a: JiraIssue, b: JiraIssue) {
  const rank = (p: string) => {
    const k = p.toLowerCase();
    if (k === "highest") return 0;
    if (k === "high") return 1;
    if (k === "medium") return 2;
    if (k === "low") return 3;
    if (k === "lowest") return 4;
    return 5;
  };
  const today = todayYmd();
  const overdue = (i: JiraIssue) =>
    i.dueDate && i.dueDate < today && i.statusCategory !== "DONE" ? 0 : 1;
  return overdue(a) - overdue(b) || rank(a.priority) - rank(b.priority);
}

function toJira(row: Record<string, unknown>): JiraIssue {
  const cat = String(row.statusCategory ?? "UNKNOWN").toUpperCase();
  return {
    key: String(row.key ?? ""),
    summary: String(row.summary ?? ""),
    status: String(row.status ?? ""),
    statusCategory:
      cat === "TO_DO" || cat === "IN_PROGRESS" || cat === "DONE" ? cat : "UNKNOWN",
    priority: String(row.priority ?? ""),
    issueType: String(row.issueType ?? ""),
    projectKey: String(row.projectKey ?? ""),
    assignee: String(row.assignee ?? ""),
    dueDate: typeof row.dueDate === "string" ? row.dueDate : null,
    updated: typeof row.updated === "string" ? row.updated : null,
    url: typeof row.url === "string" ? row.url : null,
  };
}

function isBalance(row: Record<string, unknown>) {
  return row.annualRemaining != null && row.annualTotal != null;
}
function isJiraIssue(row: Record<string, unknown>) {
  return Boolean(row.key && row.summary && (row.statusCategory != null || row.status != null));
}
function isLeave(row: Record<string, unknown>) {
  return (
    (row.type != null || row.reason != null) &&
    row.from != null &&
    row.to != null &&
    row.destination == null
  );
}
function isTrip(row: Record<string, unknown>) {
  return row.destination != null && row.from != null;
}
function isMail(row: Record<string, unknown>) {
  return row.subject != null && (row.receivedAt != null || row.isRead != null || row.from != null) && row.start == null;
}
function isEvent(row: Record<string, unknown>) {
  return row.subject != null && row.start != null && row.type == null;
}

function labelLeaveType(type: string) {
  const t = type.toUpperCase();
  if (t === "ANNUAL") return "Phép năm";
  if (t === "SICK") return "Phép ốm";
  if (t === "UNPAID") return "Không lương";
  return type || "Nghỉ phép";
}
function labelStatus(status: string) {
  const t = status.toUpperCase();
  if (t === "PENDING") return "Chờ duyệt";
  if (t === "APPROVED") return "Đã duyệt";
  if (t === "REJECTED") return "Từ chối";
  if (t === "CANCELLED") return "Đã hủy";
  return status;
}
function statusTone(status: string): ChatKpiTone {
  const t = status.toUpperCase();
  if (t === "PENDING") return "warn";
  if (t === "APPROVED") return "ok";
  if (t === "REJECTED") return "bad";
  return "neutral";
}

function formatEventWhen(row: Record<string, unknown>) {
  const start = typeof row.start === "string" ? row.start : "";
  const end = typeof row.end === "string" ? row.end : "";
  if (start && end) return `${formatVnDateTime(start)} → ${formatVnDateTime(end)}`;
  return formatVnDateTime(start);
}

function todayYmd() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function num(v: unknown) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function clip(text: string, max: number) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
