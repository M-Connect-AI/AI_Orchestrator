import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

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
    const res = await fetch(`${baseURL}/chat/completions`, {
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
        enable_thinking: false,
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(greenNodeMessage(text, res.status));
    }
    const data = JSON.parse(text) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    return stripThink(messageText(data.choices?.[0]?.message?.content));
  }

  async *completeStream(
    messages: { role: string; content: string }[],
    opts: { temperature?: number; max_tokens?: number } = {},
  ): AsyncGenerator<string> {
    const { apiKey, baseURL, model } = this.credentials();
    const res = await fetch(`${baseURL}/chat/completions`, {
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
        enable_thinking: false,
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(greenNodeMessage(text, res.status));
    }
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
}

export function stripThink(raw: string) {
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
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
