import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export const POLICY_COLLECTION = "policy_chunks";

export type PolicyHit = {
  id: string | number;
  payload: Record<string, unknown> | null;
  score?: number;
};

type QdrantConfig = { url: string; collection: string };

function qdrantConfigFromEnv(): QdrantConfig {
  return {
    url: (process.env.QDRANT_URL?.trim() || "http://127.0.0.1:6333").replace(/\/$/, ""),
    collection: process.env.QDRANT_POLICY_COLLECTION?.trim() || POLICY_COLLECTION,
  };
}

async function qdrantFetch(baseUrl: string, path: string, init?: RequestInit) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`Qdrant ${init?.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  }
  return json as Record<string, unknown>;
}

export async function ensurePolicyCollection(
  url: string,
  collection: string,
  vectorSize: number,
) {
  const base = url.replace(/\/$/, "");
  const list = (await qdrantFetch(base, "/collections")) as {
    result?: { collections?: Array<{ name: string }> };
  };
  const found = list.result?.collections?.some((c) => c.name === collection);
  if (found) {
    await qdrantFetch(base, `/collections/${collection}`, { method: "DELETE" });
  }
  await qdrantFetch(base, `/collections/${collection}`, {
    method: "PUT",
    body: JSON.stringify({
      vectors: { size: vectorSize, distance: "Cosine" },
    }),
  });
}

export async function upsertPolicyPoints(
  url: string,
  collection: string,
  points: Array<{
    id: string;
    vector: number[];
    payload: Record<string, unknown>;
  }>,
) {
  const base = url.replace(/\/$/, "");
  await qdrantFetch(base, `/collections/${collection}/points?wait=true`, {
    method: "PUT",
    body: JSON.stringify({ points }),
  });
}

export async function searchPolicyPoints(
  url: string,
  collection: string,
  vector: number[],
  limit: number,
): Promise<PolicyHit[]> {
  const base = url.replace(/\/$/, "");
  const data = (await qdrantFetch(base, `/collections/${collection}/points/search`, {
    method: "POST",
    body: JSON.stringify({
      vector,
      limit,
      with_payload: true,
    }),
  })) as {
    result?: Array<{
      id: string | number;
      score?: number;
      payload?: Record<string, unknown> | null;
    }>;
  };
  return (data.result ?? []).map((p) => ({
    id: p.id,
    payload: p.payload ?? null,
    score: p.score,
  }));
}

@Injectable()
export class QdrantPolicyClient {
  private readonly log = new Logger(QdrantPolicyClient.name);
  private readonly url: string;
  readonly collection: string;

  constructor(private readonly config: ConfigService) {
    this.url = (this.config.get<string>("QDRANT_URL")?.trim() || "http://127.0.0.1:6333").replace(
      /\/$/,
      "",
    );
    this.collection =
      this.config.get<string>("QDRANT_POLICY_COLLECTION")?.trim() || POLICY_COLLECTION;
  }

  async search(vector: number[], limit: number): Promise<PolicyHit[]> {
    try {
      return await searchPolicyPoints(this.url, this.collection, vector, limit);
    } catch (err) {
      this.log.warn(`Qdrant search failed: ${err instanceof Error ? err.message : err}`);
      throw err;
    }
  }
}

export { qdrantConfigFromEnv };
