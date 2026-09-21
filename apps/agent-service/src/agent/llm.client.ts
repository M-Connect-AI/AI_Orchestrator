import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export type ChatMessage = {
  role: string;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatToolDef = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ChatWithToolsResult = {
  content: string;
  tool_calls: ToolCall[];
  raw: ChatMessage;
};

const RATE_LIMIT_RETRIES = 4;
const RATE_LIMIT_BASE_MS = 1200;

@Injectable()
export class LlmClient {
  constructor(private readonly config: ConfigService) {}

  credentials() {
    const apiKey = this.config.get<string>("LLM_API_KEY")?.trim();
    const baseURL = this.config.get<string>("LLM_BASE_URL")?.trim()?.replace(/\/$/, "");
    const model = this.config.get<string>("LLM_MODEL")?.trim();
    if (!apiKey || !baseURL || !model) {
      throw new Error("Thiếu LLM_API_KEY / LLM_BASE_URL / LLM_MODEL trong .env");
    }
    return { apiKey, baseURL, model };
  }

  async complete(
    messages: { role: string; content: string }[],
    opts: { temperature?: number; max_tokens?: number } = {},
  ) {
    const { apiKey, baseURL, model } = this.credentials();
    const text = await this.postChatCompletions(
      `${baseURL}/chat/completions`,
      apiKey,
      {
        model,
        messages,
        max_tokens: opts.max_tokens ?? 512,
        temperature: opts.temperature ?? 0,
        top_p: 0.9,
        ...this.generationExtras(model),
      },
    );
    const data = JSON.parse(text) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    return stripThink(messageText(data.choices?.[0]?.message?.content));
  }

  async chatWithTools(
    messages: ChatMessage[],
    tools: ChatToolDef[],
    opts: { temperature?: number; max_tokens?: number; tool_choice?: "auto" | "none" } = {},
  ): Promise<ChatWithToolsResult> {
    const { apiKey, baseURL, model } = this.credentials();
    const text = await this.postChatCompletions(
      `${baseURL}/chat/completions`,
      apiKey,
      {
        model,
        messages,
        tools,
        tool_choice: opts.tool_choice ?? "auto",
        max_tokens: opts.max_tokens ?? 1024,
        temperature: opts.temperature ?? 0.3,
        top_p: 0.9,
        ...this.generationExtras(model),
      },
    );
    const data = JSON.parse(text) as {
      choices?: Array<{
        message?: {
          content?: unknown;
          tool_calls?: Array<{
            id?: string;
            type?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
    };
    const msg = data.choices?.[0]?.message ?? {};
    const tool_calls: ToolCall[] = (msg.tool_calls ?? [])
      .filter((tc) => tc.function?.name)
      .map((tc, i) => ({
        id: tc.id || `call_${i}`,
        type: "function" as const,
        function: {
          name: String(tc.function!.name),
          arguments: String(tc.function!.arguments ?? "{}"),
        },
      }));
    const content = stripThink(messageText(msg.content));
    return {
      content,
      tool_calls,
      raw: {
        role: "assistant",
        content: content || null,
        ...(tool_calls.length ? { tool_calls } : {}),
      },
    };
  }

  async *completeStream(
    messages: { role: string; content: string }[],
    opts: { temperature?: number; max_tokens?: number } = {},
  ): AsyncGenerator<string> {
    const { apiKey, baseURL, model } = this.credentials();
    const res = await this.fetchWithRateLimitRetry(
      `${baseURL}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: opts.max_tokens ?? 512,
          temperature: opts.temperature ?? 0,
          top_p: 0.9,
          stream: true,
          ...this.generationExtras(model),
        }),
      },
    );
    if (!res.body) throw new Error("LLM không trả stream");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      buf += decoder.decode(value || new Uint8Array(), { stream: !done });
      let sep;
      while ((sep = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, sep).trim();
        buf = buf.slice(sep + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") {
          if (payload === "[DONE]") return;
          continue;
        }
        try {
          const json = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown } }>;
          };
          const piece = messageText(json.choices?.[0]?.delta?.content);
          if (piece) yield piece;
        } catch {
          /* chunk JSON chưa đủ */
        }
      }
      if (done) break;
    }
  }

  /** Qwen accepts enable_thinking=false; GLM-5.3 always thinks and rejects disable. */
  private generationExtras(model: string): Record<string, unknown> {
    if (alwaysThinkingModel(model)) {
      return {
        reasoning_effort: parseReasoningEffort(
          this.config.get<string>("LLM_REASONING_EFFORT"),
        ),
      };
    }
    return {
      enable_thinking: false,
      chat_template_kwargs: { enable_thinking: false },
    };
  }

  private async postChatCompletions(
    url: string,
    apiKey: string,
    body: Record<string, unknown>,
  ): Promise<string> {
    const res = await this.fetchWithRateLimitRetry(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return res.text();
  }

  private async fetchWithRateLimitRetry(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt++) {
      const res = await fetch(url, init);
      if (res.ok) return res;

      const text = await res.text();
      const message = greenNodeMessage(text, res.status);
      const rateLimited = isRateLimitStatus(res.status, message);
      if (!rateLimited) throw new Error(message);
      lastErr = new LlmRateLimitError(message);
      if (attempt === RATE_LIMIT_RETRIES) break;

      const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
      const backoff =
        retryAfterMs ??
        RATE_LIMIT_BASE_MS * 2 ** attempt + Math.floor(Math.random() * 400);
      await sleep(Math.min(backoff, 20_000));
    }
    throw lastErr ?? new LlmRateLimitError("API rate limit exceeded");
  }
}

export class LlmRateLimitError extends Error {
  readonly rateLimited = true;
  constructor(message: string) {
    super(message);
    this.name = "LlmRateLimitError";
  }
}

export function isRateLimitError(err: unknown): boolean {
  if (err instanceof LlmRateLimitError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /rate limit|too many requests|quota|429/i.test(msg);
}

export function stripThink(raw: string) {
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function alwaysThinkingModel(model: string) {
  return /glm-5\.3/i.test(model);
}

function parseReasoningEffort(raw?: string): "low" | "high" | "max" {
  const v = raw?.trim().toLowerCase();
  if (v === "high" || v === "max" || v === "low") return v;
  return "low";
}

function isRateLimitStatus(status: number, message: string) {
  return status === 429 || /rate limit|too many requests|quota/i.test(message);
}

function parseRetryAfterMs(raw: string | null): number | null {
  if (!raw?.trim()) return null;
  const sec = Number(raw);
  if (Number.isFinite(sec) && sec >= 0) return Math.ceil(sec * 1000);
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return null;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function greenNodeMessage(body: string, status: number) {
  try {
    const parsed = JSON.parse(body) as { message?: string; error?: { message?: string } };
    return parsed.message || parsed.error?.message || `LLM HTTP ${status}`;
  } catch {
    return body?.slice(0, 240) || `LLM HTTP ${status}`;
  }
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          return String((part as { text: unknown }).text);
        }
        return "";
      })
      .join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}
