const assert = require("node:assert/strict");
const test = require("node:test");
const { summarizeJiraIssues } = require("../dist/jira/jira-summary.js");
const {
  extractJiraIssues,
  findJiraAccountId,
  normalizeJiraIssue,
} = require("../dist/jira/jira-tools.service.js");

test("summarizeJiraIssues phân loại tiến độ và rủi ro backlog", () => {
  const issues = [
    issue({
      key: "MC-1",
      status: "To Do",
      statusCategory: "TO_DO",
      dueDate: "2026-09-01",
      updated: "2026-08-01T00:00:00.000Z",
    }),
    issue({
      key: "MC-2",
      status: "In Progress",
      statusCategory: "IN_PROGRESS",
      dueDate: null,
      updated: "2026-09-08T00:00:00.000Z",
    }),
    issue({
      key: "MC-3",
      status: "Done",
      statusCategory: "DONE",
      dueDate: "2026-09-01",
      updated: "2026-08-01T00:00:00.000Z",
    }),
  ];

  const result = summarizeJiraIssues(issues, {
    staleDays: 14,
    today: "2026-09-09",
  });

  assert.deepEqual(
    {
      total: result.total,
      toDo: result.toDo,
      inProgress: result.inProgress,
      done: result.done,
      overdue: result.overdue,
      stale: result.stale,
      withoutDueDate: result.withoutDueDate,
    },
    {
      total: 3,
      toDo: 1,
      inProgress: 1,
      done: 1,
      overdue: 1,
      stale: 1,
      withoutDueDate: 1,
    },
  );
});

test("parse response searchJiraIssuesUsingJql", () => {
  const payload = {
    result: {
      issues: [
        {
          key: "MC-99",
          fields: {
            summary: "Kết nối Jira MCP",
            status: {
              name: "In Progress",
              statusCategory: { key: "indeterminate" },
            },
            priority: { name: "High" },
            issuetype: { name: "Story" },
            project: { key: "MC" },
            duedate: "2026-09-15",
            updated: "2026-09-09T08:00:00.000Z",
          },
        },
      ],
    },
  };

  const raw = extractJiraIssues(payload);
  const parsed = normalizeJiraIssue(raw[0], "https://jira.example.com");

  assert.equal(parsed.key, "MC-99");
  assert.equal(parsed.statusCategory, "IN_PROGRESS");
  assert.equal(parsed.priority, "High");
  assert.equal(parsed.url, "https://jira.example.com/browse/MC-99");
});

test("map Jira account theo email user đăng nhập", () => {
  const payload = {
    users: [
      { accountId: "account-other", emailAddress: "other@example.com" },
      { accountId: "account-phuong", emailAddress: "phuongptt.uet@gmail.com" },
    ],
  };

  assert.equal(
    findJiraAccountId(payload, "PHUONGPTT.UET@GMAIL.COM"),
    "account-phuong",
  );
  assert.equal(findJiraAccountId(payload, "missing@example.com"), undefined);
});

function issue(overrides) {
  return {
    key: "MC-0",
    summary: "Task",
    status: "To Do",
    statusCategory: "TO_DO",
    priority: "Medium",
    issueType: "Task",
    projectKey: "MC",
    assignee: "User",
    dueDate: null,
    updated: null,
    url: null,
    ...overrides,
  };
}
