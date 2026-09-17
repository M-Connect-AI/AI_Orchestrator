import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Actor } from "../auth/jwt-auth.guard";
import { JiraMcpClient, toolResultPayload } from "./jira-mcp.client";
import {
  formatJiraSummary,
  JiraIssue,
} from "./jira-summary";

export type JiraTaskFilter = {
  projectKey?: string;
  statusGroup?: "TODO" | "IN_PROGRESS" | "DONE" | "NOT_DONE" | "ALL";
  sprint?: "ACTIVE" | "BACKLOG" | "ALL";
  dueBefore?: string;
  updatedSince?: string;
  maxResults?: number;
};

export type CreateJiraTaskInput = {
  projectKey: string;
  summary: string;
  description?: string;
  issueType?: "Task" | "Story" | "Bug" | "Epic";
  priority?: "Highest" | "High" | "Medium" | "Low" | "Lowest";
  dueDate?: string;
  labels?: string[];
  assignToSprint?: boolean;
};

@Injectable()
export class JiraToolsService {
  private cloudId: string | null = null;

  constructor(
    private readonly mcp: JiraMcpClient,
    private readonly config: ConfigService,
  ) {}

  async myWorkSummary(actor: Actor, filter: JiraTaskFilter) {
    const maxResults = this.queryLimit(filter.maxResults);
    const jql = this.buildJql(actor, filter, true);
    const result = await this.search(jql, maxResults);
    const staleDays = this.staleDays();
    const formatted = formatJiraSummary("Công việc Jira của bạn", result.issues, {
      staleDays,
      truncated: result.truncated,
    });
    return {
      ...formatted,
      issues: result.issues,
      jql,
      truncated: result.truncated,
      citations: this.citations(result.issues),
    };
  }

  async listMyTasks(actor: Actor, filter: JiraTaskFilter) {
    const maxResults = this.queryLimit(filter.maxResults ?? 50);
    const jql = this.buildJql(actor, filter, true);
    const result = await this.search(jql, maxResults);
    const formatted = formatJiraSummary("Danh sách Jira của bạn", result.issues, {
      staleDays: this.staleDays(),
      truncated: result.truncated,
    });
    return {
      ...formatted,
      summary: result.issues.length
        ? `${formatted.summary} Danh sách task nằm trên thẻ.`
        : formatted.summary,
      issues: result.issues,
      jql,
      truncated: result.truncated,
      citations: this.citations(result.issues),
    };
  }

  async analyzeBacklog(
    actor: Actor,
    input: JiraTaskFilter & { scope?: "ME" | "PROJECT"; staleDays?: number },
  ) {
    const scope = input.scope ?? "ME";
    if (scope === "PROJECT" && actor.role !== "MANAGER") {
      throw new Error("Chỉ quản lý được phân tích backlog toàn project.");
    }
    if (scope === "PROJECT" && !input.projectKey) {
      throw new Error("Cần projectKey khi phân tích backlog toàn project.");
    }
    const staleDays = clampNumber(input.staleDays ?? this.staleDays(), 1, 365);
    const filter: JiraTaskFilter = {
      ...input,
      sprint: "BACKLOG",
      statusGroup: "NOT_DONE",
    };
    const maxResults = this.queryLimit(input.maxResults);
    const jql = this.buildJql(actor, filter, scope === "ME");
    const result = await this.search(jql, maxResults);
    const title =
      scope === "ME"
        ? "Backlog Jira của bạn"
        : `Backlog Jira project ${normalizeProjectKey(input.projectKey)}`;
    const formatted = formatJiraSummary(title, result.issues, {
      staleDays,
      truncated: result.truncated,
    });
    const priorityItems = result.issues
      .filter((issue) => issue.statusCategory !== "DONE")
      .sort(compareBacklogPriority)
      .slice(0, 10);
    return {
      ...formatted,
      summary: priorityItems.length
        ? `${formatted.summary} Các task nên ưu tiên nằm trên thẻ.`
        : formatted.summary,
      issues: result.issues,
      priorityItems,
      jql,
      truncated: result.truncated,
      citations: this.citations(priorityItems),
    };
  }

  async createTask(actor: Actor, input: CreateJiraTaskInput) {
    if (!this.mcp.isConfigured()) {
      throw new Error("Jira MCP chưa được cấu hình credential trong .env.");
    }
    if (!(await this.mcp.hasTool("createJiraIssue"))) {
      throw new Error(
        "Credential Jira MCP hiện tại chưa được cấp quyền tạo issue. Hãy bật quyền Write cho Jira trong Rovo MCP.",
      );
    }

    const projectKey = normalizeProjectKey(input.projectKey);
    const summary = input.summary?.trim();
    if (!summary || summary.length < 3 || summary.length > 255) {
      throw new Error("Tiêu đề Jira task phải từ 3 đến 255 ký tự.");
    }
    const issueType = input.issueType ?? "Task";
    if (!["Task", "Story", "Bug", "Epic"].includes(issueType)) {
      throw new Error("issueType Jira chỉ nhận Task, Story, Bug hoặc Epic.");
    }
    if (
      input.priority &&
      !["Highest", "High", "Medium", "Low", "Lowest"].includes(input.priority)
    ) {
      throw new Error("priority Jira không hợp lệ.");
    }
    if (input.description && input.description.length > 32_767) {
      throw new Error("Mô tả Jira task vượt quá 32767 ký tự.");
    }
    const dueDate = input.dueDate ? normalizeDate(input.dueDate) : undefined;
    const labels = normalizeLabels(input.labels);
    const cloudId = await this.getCloudId();
    const assignee = await this.lookupActorAccountId(actor, cloudId);

    const result = await this.mcp.callTool("createJiraIssue", {
      cloudId,
      projectKey,
      summary,
      issueType,
      ...(input.description?.trim()
        ? { description: input.description.trim(), contentFormat: "markdown" }
        : {}),
      ...(input.priority ? { priority: input.priority } : {}),
      ...(assignee ? { assignee } : {}),
      ...(labels.length ? { labels } : {}),
      ...(dueDate ? { additional_fields: { duedate: dueDate } } : {}),
      ...(input.assignToSprint == null ? {} : { assignToSprint: input.assignToSprint }),
    });
    const payload = toolResultPayload(result);
    const key = findString(payload, ["key", "issueKey"]);
    if (!key) throw new Error("Jira đã nhận yêu cầu nhưng không trả về mã issue.");
    const url = `${this.baseUrl() ?? cloudId}/browse/${encodeURIComponent(key)}`;
    return {
      key,
      summary,
      projectKey,
      issueType,
      assigneeEmail: actor.email,
      url,
      message: `Đã tạo Jira ${key}: ${summary}`,
    };
  }

  private buildJql(actor: Actor, filter: JiraTaskFilter, ownOnly: boolean) {
    const clauses: string[] = [];
    if (ownOnly) clauses.push(this.assigneeClause(actor));
    if (filter.projectKey) {
      clauses.push(`project = "${normalizeProjectKey(filter.projectKey)}"`);
    }

    const statusGroup = filter.statusGroup ?? "ALL";
    if (statusGroup === "TODO") clauses.push('statusCategory = "To Do"');
    else if (statusGroup === "IN_PROGRESS") clauses.push('statusCategory = "In Progress"');
    else if (statusGroup === "DONE") clauses.push("statusCategory = Done");
    else if (statusGroup === "NOT_DONE") clauses.push("statusCategory != Done");

    if (filter.sprint === "ACTIVE") clauses.push("sprint in openSprints()");
    else if (filter.sprint === "BACKLOG") clauses.push("sprint is EMPTY");
    if (filter.dueBefore) clauses.push(`due <= "${normalizeDate(filter.dueBefore)}"`);
    if (filter.updatedSince) clauses.push(`updated >= "${normalizeDate(filter.updatedSince)}"`);

    if (!clauses.length) throw new Error("Không tạo được phạm vi truy vấn Jira an toàn.");
    return `${clauses.join(" AND ")} ORDER BY priority DESC, due ASC, updated DESC`;
  }

  private assigneeClause(actor: Actor) {
    const mode =
      this.config.get<string>("JIRA_MCP_ASSIGNEE_MODE")?.trim().toLowerCase() ||
      "actor-email";
    if (mode === "current-user") return "assignee = currentUser()";
    if (mode !== "actor-email") {
      throw new Error("JIRA_MCP_ASSIGNEE_MODE chỉ nhận actor-email hoặc current-user.");
    }
    if (!actor.email?.trim()) throw new Error("Tài khoản M-Connect chưa có email để map Jira.");
    return `assignee = "${escapeJqlString(actor.email.trim())}"`;
  }

  private async search(jql: string, limit: number) {
    if (!this.mcp.isConfigured()) {
      throw new Error("Jira MCP chưa được cấu hình credential trong .env.");
    }
    const cloudId = await this.getCloudId();
    if (!(await this.mcp.hasTool("searchJiraIssuesUsingJql"))) {
      const authType = this.config
        .get<string>("JIRA_MCP_AUTH_TYPE")
        ?.trim()
        .toLowerCase();
      if (authType === "basic" && (await this.mcp.hasTool("search"))) {
        throw new Error(
          "API token đã xác thực nhưng permission group search_jira chưa được cấp. " +
            "Nhờ Org Admin vào Rovo MCP server > Permissions > Search > Edit details và bật Jira search.",
        );
      }
      throw new Error(
        "Jira MCP không công bố tool searchJiraIssuesUsingJql cho credential hiện tại. " +
          "Kiểm tra quyền Jira MCP và cấu hình tools=all.",
      );
    }
    const issues: JiraIssue[] = [];
    let nextPageToken: string | undefined;
    let hasMore = false;
    do {
      const pageSize = Math.min(100, limit - issues.length);
      const result = await this.mcp.callTool("searchJiraIssuesUsingJql", {
        cloudId,
        jql,
        fields: [
          "summary",
          "status",
          "priority",
          "issuetype",
          "project",
          "assignee",
          "duedate",
          "updated",
        ],
        view: "full",
        maxResults: pageSize,
        ...(nextPageToken ? { nextPageToken } : {}),
      });
      const payload = toolResultPayload(result);
      const page = extractJiraIssues(payload).map((raw) =>
        normalizeJiraIssue(raw, this.baseUrl()),
      );
      issues.push(...page.filter((issue) => issue.key));
      nextPageToken = findString(payload, ["nextPageToken", "nextCursor"]);
      hasMore = Boolean(nextPageToken);
      if (!page.length) break;
    } while (nextPageToken && issues.length < limit);
    return { issues: issues.slice(0, limit), truncated: hasMore || issues.length > limit };
  }

  private async getCloudId() {
    const configured = this.config.get<string>("JIRA_MCP_CLOUD_ID")?.trim();
    if (configured) return configured;
    if (this.cloudId) return this.cloudId;
    const baseUrl = this.baseUrl();
    if (baseUrl) {
      this.cloudId = baseUrl;
      return this.cloudId;
    }
    if (!(await this.mcp.hasTool("getAccessibleAtlassianResources"))) {
      throw new Error(
        "Không xác định được Jira cloudId. Hãy cấu hình JIRA_MCP_CLOUD_ID hoặc JIRA_BASE_URL.",
      );
    }
    const result = await this.mcp.callTool("getAccessibleAtlassianResources", {});
    const payload = toolResultPayload(result);
    const cloudId = findString(payload, ["cloudId", "id"]);
    if (!cloudId) {
      throw new Error("Không xác định được Jira cloudId. Hãy cấu hình JIRA_MCP_CLOUD_ID.");
    }
    this.cloudId = cloudId;
    return cloudId;
  }

  private async lookupActorAccountId(actor: Actor, cloudId: string) {
    const email = actor.email?.trim().toLowerCase();
    if (!email) throw new Error("Tài khoản M-Connect chưa có email để map Jira assignee.");
    if (!(await this.mcp.hasTool("lookupJiraAccountId"))) {
      throw new Error("Jira MCP chưa cấp tool lookupJiraAccountId để map user đăng nhập.");
    }
    const result = await this.mcp.callTool("lookupJiraAccountId", {
      cloudId,
      query: email,
      maxResults: 10,
    });
    const accountId = findJiraAccountId(toolResultPayload(result), email);
    if (!accountId) {
      throw new Error(`Không tìm thấy Jira account khớp email ${email}; task chưa được tạo.`);
    }
    return accountId;
  }

  private staleDays() {
    return clampNumber(Number(this.config.get<string>("JIRA_MCP_STALE_DAYS") ?? 14), 1, 365);
  }

  private queryLimit(requested?: number) {
    const configured = clampNumber(
      Number(this.config.get<string>("JIRA_MCP_MAX_ISSUES") ?? 200),
      1,
      500,
    );
    if (requested == null) return configured;
    return Math.min(configured, clampNumber(requested, 1, 500));
  }

  private baseUrl() {
    return this.config.get<string>("JIRA_BASE_URL")?.trim().replace(/\/$/, "") || null;
  }

  private citations(issues: JiraIssue[]) {
    return [...new Set(issues.map((issue) => issue.url).filter((url): url is string => Boolean(url)))].slice(
      0,
      20,
    );
  }
}

export function extractJiraIssues(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    if (payload.every((item) => isRecord(item) && ("key" in item || "fields" in item))) {
      return payload as Record<string, unknown>[];
    }
    for (const item of payload) {
      const found = extractJiraIssues(item);
      if (found.length) return found;
    }
    return [];
  }
  if (!isRecord(payload)) return [];
  for (const key of ["issues", "values", "results", "result", "items", "data"]) {
    const found = extractJiraIssues(payload[key]);
    if (found.length) return found;
  }
  if (typeof payload.text === "string") {
    try {
      return extractJiraIssues(JSON.parse(payload.text));
    } catch {
      return [];
    }
  }
  return [];
}

export function normalizeJiraIssue(
  raw: Record<string, unknown>,
  baseUrl: string | null,
): JiraIssue {
  const fields = isRecord(raw.fields) ? raw.fields : raw;
  const key = stringValue(raw.key) || stringValue(fields.key);
  const statusRaw = isRecord(fields.status) ? fields.status : {};
  const statusCategoryRaw = isRecord(statusRaw.statusCategory)
    ? statusRaw.statusCategory
    : isRecord(fields.statusCategory)
      ? fields.statusCategory
      : {};
  const status = stringValue(statusRaw.name) || stringValue(fields.status) || "Không rõ";
  const category =
    stringValue(statusCategoryRaw.key) ||
    stringValue(statusCategoryRaw.name) ||
    stringValue(fields.statusCategory);
  const projectRaw = isRecord(fields.project) ? fields.project : {};
  const priorityRaw = isRecord(fields.priority) ? fields.priority : {};
  const issueTypeRaw = isRecord(fields.issuetype)
    ? fields.issuetype
    : isRecord(fields.issueType)
      ? fields.issueType
      : {};
  const assigneeRaw = isRecord(fields.assignee) ? fields.assignee : {};
  const self = stringValue(raw.url) || stringValue(raw.self);
  return {
    key,
    summary: stringValue(fields.summary) || "Không có tiêu đề",
    status,
    statusCategory: normalizeStatusCategory(category, status),
    priority: stringValue(priorityRaw.name) || stringValue(fields.priority) || "Không rõ",
    issueType: stringValue(issueTypeRaw.name) || stringValue(fields.issuetype) || "Không rõ",
    projectKey: stringValue(projectRaw.key) || key.split("-")[0] || "Không rõ",
    assignee:
      stringValue(assigneeRaw.displayName) ||
      stringValue(assigneeRaw.emailAddress) ||
      stringValue(fields.assignee) ||
      "Chưa gán",
    dueDate: dateValue(fields.duedate ?? fields.dueDate),
    updated: dateTimeValue(fields.updated),
    url: (baseUrl && key ? `${baseUrl}/browse/${encodeURIComponent(key)}` : null) || self || null,
  };
}

function normalizeStatusCategory(value: string, status: string): JiraIssue["statusCategory"] {
  const text = `${value} ${status}`.toLowerCase();
  if (/done|complete|closed|resolved|hoàn thành|đã xong/.test(text)) return "DONE";
  if (/indeterminate|in.?progress|doing|đang làm|đang xử lý/.test(text)) return "IN_PROGRESS";
  if (/new|to.?do|open|backlog|cần làm/.test(text)) return "TO_DO";
  return "UNKNOWN";
}

function compareBacklogPriority(a: JiraIssue, b: JiraIssue) {
  const priority = (value: string) => {
    const text = value.toLowerCase();
    if (/highest|critical|blocker/.test(text)) return 0;
    if (/high/.test(text)) return 1;
    if (/medium/.test(text)) return 2;
    if (/low/.test(text)) return 3;
    return 4;
  };
  const byPriority = priority(a.priority) - priority(b.priority);
  if (byPriority) return byPriority;
  if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
  if (a.dueDate) return -1;
  if (b.dueDate) return 1;
  return (a.updated ?? "").localeCompare(b.updated ?? "");
}

function findString(payload: unknown, keys: string[]): string | undefined {
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const value = findString(item, keys);
      if (value) return value;
    }
    return undefined;
  }
  if (!isRecord(payload)) return undefined;
  for (const key of keys) {
    const value = stringValue(payload[key]);
    if (value) return value;
  }
  for (const value of Object.values(payload)) {
    const nested = findString(value, keys);
    if (nested) return nested;
  }
  return undefined;
}

function normalizeProjectKey(value: string | undefined) {
  const key = String(value ?? "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]{0,31}$/.test(key)) throw new Error("projectKey Jira không hợp lệ.");
  return key;
}

function normalizeDate(value: string) {
  const date = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new Error("Ngày lọc Jira phải theo định dạng YYYY-MM-DD.");
  }
  return date;
}

export function findJiraAccountId(payload: unknown, expectedEmail: string) {
  const candidates: Array<{ accountId: string; email: string }> = [];
  collectJiraAccounts(payload, candidates);
  const email = expectedEmail.trim().toLowerCase();
  const exact = candidates.find((item) => item.email === email);
  if (exact) return exact.accountId;
  return candidates.length === 1 ? candidates[0].accountId : undefined;
}

function collectJiraAccounts(
  payload: unknown,
  result: Array<{ accountId: string; email: string }>,
) {
  if (Array.isArray(payload)) {
    payload.forEach((item) => collectJiraAccounts(item, result));
    return;
  }
  if (!isRecord(payload)) return;
  const accountId = stringValue(payload.accountId ?? payload.account_id);
  if (accountId) {
    result.push({
      accountId,
      email: stringValue(payload.emailAddress ?? payload.email).toLowerCase(),
    });
  }
  if (typeof payload.text === "string") {
    try {
      collectJiraAccounts(JSON.parse(payload.text), result);
    } catch {
      // MCP có thể trả text mô tả; không dùng text để đoán accountId.
    }
  }
  Object.entries(payload)
    .filter(([key]) => key !== "text")
    .forEach(([, value]) => collectJiraAccounts(value, result));
}

function normalizeLabels(values?: string[]) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))].slice(0, 20);
}

function escapeJqlString(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function dateValue(value: unknown) {
  const text = stringValue(value);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

function dateTimeValue(value: unknown) {
  const text = stringValue(value);
  return text && !Number.isNaN(Date.parse(text)) ? text : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function clampNumber(value: number, min: number, max: number) {
  const safe = Number.isFinite(value) ? Math.round(value) : min;
  return Math.min(max, Math.max(min, safe));
}
