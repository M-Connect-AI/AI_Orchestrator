import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

const DEFAULT_EMBEDDING_MODEL = "baai/bge-m3";

export type EmbedOpts = {
  model?: string;
  apiKey?: string;
  baseURL?: string;
  asQuery?: boolean;
};

function resolveModel(override?: string) {
  return override?.trim() || process.env.EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;
}

/**
 * Embed qua GreenNode MaaS OpenAI-compatible `/embeddings`.
 * Model mặc định: baai/bge-m3 (1024-dim).
 */
export async function embedTexts(texts: string[], opts: EmbedOpts = {}): Promise<number[][]> {
  if (!texts.length) return [];

  const model = resolveModel(opts.model);
  const apiKey = (opts.apiKey ?? process.env.LLM_API_KEY)?.trim();
  const baseURL = (opts.baseURL ?? process.env.LLM_BASE_URL)?.trim()?.replace(/\/$/, "");
  if (!apiKey || !baseURL) {
    throw new Error("Thiếu LLM_API_KEY / LLM_BASE_URL để gọi embedding GreenNode");
  }

  const res = await fetch(`${baseURL}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: texts.length === 1 ? texts[0] : texts,
      encoding_format: "float",
    }),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Embedding HTTP ${res.status}: ${body.slice(0, 400)}`);
  }

  const data = JSON.parse(body) as {
    data?: Array<{ embedding?: number[]; index?: number }>;
  };
  const rows = [...(data.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const vectors = rows.map((r) => r.embedding ?? []);
  if (vectors.length !== texts.length || vectors.some((v) => !v.length)) {
    throw new Error("Embedding API trả về số vector không khớp input");
  }
  return vectors;
}

@Injectable()
export class EmbeddingClient {
  private readonly log = new Logger(EmbeddingClient.name);

  constructor(private readonly config: ConfigService) {}

  model() {
    return this.config.get<string>("EMBEDDING_MODEL")?.trim() || DEFAULT_EMBEDDING_MODEL;
  }

  credentials() {
    const apiKey = this.config.get<string>("LLM_API_KEY")?.trim();
    const baseURL = this.config.get<string>("LLM_BASE_URL")?.trim()?.replace(/\/$/, "");
    if (!apiKey || !baseURL) {
      throw new Error("Thiếu LLM_API_KEY / LLM_BASE_URL để gọi embedding");
    }
    return { apiKey, baseURL };
  }

  async embed(texts: string[], _asQuery = false): Promise<number[][]> {
    const { apiKey, baseURL } = this.credentials();
    this.log.debug(`embed ${texts.length} text(s) via ${this.model()}`);
    return embedTexts(texts, { model: this.model(), apiKey, baseURL });
  }

  async embedQuery(text: string): Promise<number[]> {
    const [v] = await this.embed([text], true);
    return v;
  }
}
