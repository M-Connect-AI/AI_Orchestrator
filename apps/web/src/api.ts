export const HR_API = import.meta.env.VITE_HR_API_URL ?? "http://localhost:3002";
export const AGENT_API = import.meta.env.VITE_AGENT_API_URL ?? "http://localhost:3001";

export type SessionUser = {
  id: string;
  employeeCode: string;
  email: string;
  fullName: string;
  role: "STAFF" | "MANAGER";
  department: string;
};

export type Session = {
  accessToken: string;
  user: SessionUser;
};

const KEY = "msb-hr-session";

export function loadSession(): Session | null {
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export function saveSession(s: Session) {
  localStorage.setItem(KEY, JSON.stringify(s));
}

export function clearSession() {
  localStorage.removeItem(KEY);
}

export async function hrFetch<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${HR_API}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    let message = text || `HR API ${res.status}`;
    try {
      const body = JSON.parse(text) as { message?: string | string[] };
      if (Array.isArray(body.message)) message = body.message.join("\n");
      else if (typeof body.message === "string" && body.message.trim()) message = body.message;
    } catch {
      /* keep text */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export async function login(email: string, password: string): Promise<Session> {
  const res = await fetch(`${HR_API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error("Đăng nhập thất bại");
  const data = (await res.json()) as Session;
  saveSession(data);
  return data;
}

export type RegisterInput = {
  email: string;
  password: string;
  fullName: string;
  role?: "STAFF" | "MANAGER";
  department?: string;
  managerEmployeeCode?: string;
};

export async function register(input: RegisterInput): Promise<Session> {
  const res = await fetch(`${HR_API}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    let message = "Đăng ký thất bại";
    try {
      const body = (await res.json()) as { message?: string | string[] };
      if (Array.isArray(body.message)) message = body.message.join("\n");
      else if (typeof body.message === "string" && body.message.trim()) message = body.message;
    } catch {
      /* keep default */
    }
    throw new Error(message);
  }
  const data = (await res.json()) as Session;
  saveSession(data);
  return data;
}

export type ChatDone = {
  threadId: string;
  reply: string;
  confirm: {
    tool: string;
    args: Record<string, unknown>;
    summary: string;
  } | null;
  executed: unknown;
  citations: string[];
};

export async function agentFetch<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${AGENT_API}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<T>;
}

export type ThreadSummary = {
  threadId: string;
  title: string;
  preview: string;
  updatedAt: string;
};

export type ThreadDetail = {
  threadId: string;
  messages: { role: "user" | "assistant"; content: string }[];
  pendingAction: ChatDone["confirm"];
};

export function listThreads(token: string) {
  return agentFetch<ThreadSummary[]>("/chat/threads", token);
}

export function getThread(token: string, threadId: string) {
  return agentFetch<ThreadDetail>(`/chat/threads/${threadId}`, token);
}

export type StreamHandlers = {
  onStatus?: (label: string) => void;
  onToken?: (text: string) => void;
  onConfirm?: (confirm: ChatDone["confirm"]) => void;
  onResult?: (executed: unknown) => void;
};

export async function streamChat(
  token: string,
  message: string,
  threadId: string | undefined,
  confirm: boolean | undefined,
  handlers: StreamHandlers,
): Promise<ChatDone> {
  const res = await fetch(`${AGENT_API}/chat/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ message, threadId, confirm }),
  });
  if (!res.ok || !res.body) throw new Error(await res.text());

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let reply = "";
  let done: ChatDone = {
    threadId: threadId ?? "",
    reply: "",
    confirm: null,
    executed: null,
    citations: [],
  };

  const consume = (block: string) => {
    const event = /(?:^|\n)event:\s*(\w+)/.exec(block)?.[1];
    const dataLine = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("\n");
    if (!event || !dataLine) return;
    const data = JSON.parse(dataLine) as Record<string, unknown>;
    if (event === "status" && typeof data.label === "string") handlers.onStatus?.(data.label);
    if (event === "token" && typeof data.text === "string") {
      reply += data.text;
      handlers.onToken?.(data.text);
    }
    if (event === "confirm") {
      done.confirm = data as ChatDone["confirm"];
      handlers.onConfirm?.(done.confirm);
    }
    if (event === "result") {
      done.executed = data.executed;
      handlers.onResult?.(data.executed);
    }
    if (event === "done") {
      done.threadId = String(data.threadId ?? done.threadId);
      done.citations = (data.citations as string[]) ?? [];
    }
    if (event === "error") throw new Error(String(data.message ?? "Agent error"));
  };

  while (true) {
    const { done: eof, value } = await reader.read();
    buf += decoder.decode(value || new Uint8Array(), { stream: !eof });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      consume(block);
    }
    if (eof) break;
  }
  done.reply = reply;
  return done;
}
