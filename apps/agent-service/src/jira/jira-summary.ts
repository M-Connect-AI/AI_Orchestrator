export type JiraIssue = {
  key: string;
  summary: string;
  status: string;
  statusCategory: "TO_DO" | "IN_PROGRESS" | "DONE" | "UNKNOWN";
  priority: string;
  issueType: string;
  projectKey: string;
  assignee: string;
  dueDate: string | null;
  updated: string | null;
  url: string | null;
};

export type JiraStats = {
  total: number;
  toDo: number;
  inProgress: number;
  done: number;
  unknown: number;
  overdue: number;
  stale: number;
  withoutDueDate: number;
  byStatus: Record<string, number>;
  byPriority: Record<string, number>;
  byIssueType: Record<string, number>;
  byProject: Record<string, number>;
};

export function summarizeJiraIssues(
  issues: JiraIssue[],
  opts: { staleDays?: number; today?: string } = {},
): JiraStats {
  const staleDays = clamp(opts.staleDays ?? 14, 1, 365);
  const today = validDate(opts.today) ? opts.today! : new Date().toISOString().slice(0, 10);
  const staleBefore = new Date(`${today}T00:00:00.000Z`);
  staleBefore.setUTCDate(staleBefore.getUTCDate() - staleDays);

  const stats: JiraStats = {
    total: issues.length,
    toDo: 0,
    inProgress: 0,
    done: 0,
    unknown: 0,
    overdue: 0,
    stale: 0,
    withoutDueDate: 0,
    byStatus: {},
    byPriority: {},
    byIssueType: {},
    byProject: {},
  };

  for (const issue of issues) {
    if (issue.statusCategory === "TO_DO") stats.toDo++;
    else if (issue.statusCategory === "IN_PROGRESS") stats.inProgress++;
    else if (issue.statusCategory === "DONE") stats.done++;
    else stats.unknown++;

    increment(stats.byStatus, issue.status || "Không rõ");
    increment(stats.byPriority, issue.priority || "Không rõ");
    increment(stats.byIssueType, issue.issueType || "Không rõ");
    increment(stats.byProject, issue.projectKey || "Không rõ");

    if (!issue.dueDate && issue.statusCategory !== "DONE") stats.withoutDueDate++;
    if (
      issue.dueDate &&
      issue.dueDate < today &&
      issue.statusCategory !== "DONE"
    ) {
      stats.overdue++;
    }
    if (issue.statusCategory !== "DONE" && issue.updated) {
      const updated = new Date(issue.updated);
      if (!Number.isNaN(updated.getTime()) && updated < staleBefore) stats.stale++;
    }
  }
  return stats;
}

export function formatJiraSummary(
  title: string,
  issues: JiraIssue[],
  opts: { staleDays?: number; today?: string; truncated?: boolean } = {},
) {
  const staleDays = clamp(opts.staleDays ?? 14, 1, 365);
  const stats = summarizeJiraIssues(issues, { staleDays, today: opts.today });
  const lines = [
    `${title}: ${stats.total} task${opts.truncated ? " (đã chạm giới hạn truy vấn)" : ""}.`,
    `Cần làm: ${stats.toDo}; đang làm: ${stats.inProgress}; đã làm: ${stats.done}${stats.unknown ? `; chưa phân loại: ${stats.unknown}` : ""}.`,
    `Quá hạn chưa xong: ${stats.overdue}; chưa xong và không có due date: ${stats.withoutDueDate}; không cập nhật quá ${staleDays} ngày: ${stats.stale}.`,
    mapLine("Theo trạng thái", stats.byStatus),
    mapLine("Theo priority", stats.byPriority),
  ].filter(Boolean);
  return { stats, summary: lines.join("\n") };
}

export function formatJiraList(issues: JiraIssue[], limit = 30) {
  return issues
    .slice(0, clamp(limit, 1, 100))
    .map((issue, index) => {
      const due = issue.dueDate ? `, hạn ${issue.dueDate}` : "";
      return `- (${index + 1}) ${issue.key}: ${issue.summary} (${issue.status}, ${issue.priority}${due})`;
    })
    .join("\n");
}

function increment(target: Record<string, number>, key: string) {
  target[key] = (target[key] ?? 0) + 1;
}

function mapLine(label: string, values: Record<string, number>) {
  const body = Object.entries(values)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => `${key}: ${count}`)
    .join(", ");
  return body ? `${label}: ${body}.` : "";
}

function validDate(value: string | undefined) {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)));
}
