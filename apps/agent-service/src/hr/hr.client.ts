import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class HrClient {
  constructor(private readonly config: ConfigService) {}

  private base() {
    const raw = this.config.get<string>("HR_MOCK_BASE_URL") ?? "http://127.0.0.1:3002";
    return raw.replace(/localhost/gi, "127.0.0.1").replace(/\/$/, "");
  }

  async request<T>(token: string, path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.base()}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(init?.headers ?? {}),
      },
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* keep text */
    }
    if (!res.ok) {
      throw new Error(hrMessage(body, res.status));
    }
    return body as T;
  }
}

function hrMessage(body: unknown, status: number) {
  if (typeof body === "object" && body && "message" in body) {
    const m = (body as { message: unknown }).message;
    if (Array.isArray(m)) return m.map(String).join("\n");
    if (typeof m === "string" && m.trim()) return m;
  }
  if (typeof body === "string" && body.trim()) return body;
  return `HR API ${status}`;
}
