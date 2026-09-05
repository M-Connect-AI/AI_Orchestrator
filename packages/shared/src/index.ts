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

export type SseEventType = "token" | "message" | "confirm" | "result" | "done" | "error";
