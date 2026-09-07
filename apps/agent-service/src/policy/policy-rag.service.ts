import { Injectable, Logger } from "@nestjs/common";
import { formatPolicyChunks, PolicyChunk } from "@msb/policy-docs";
import { EmbeddingClient } from "./embedding.client";
import { QdrantPolicyClient } from "./qdrant.client";

@Injectable()
export class PolicyRagService {
  private readonly log = new Logger(PolicyRagService.name);

  constructor(
    private readonly embeddings: EmbeddingClient,
    private readonly qdrant: QdrantPolicyClient,
  ) {}

  async retrieve(query: string, k = 3): Promise<PolicyChunk[]> {
    const vector = await this.embeddings.embedQuery(query);
    const hits = await this.qdrant.search(vector, k);
    const chunks: PolicyChunk[] = [];
    for (const hit of hits) {
      const p = hit.payload as Record<string, unknown> | null;
      if (!p) continue;
      const title = String(p.title ?? "");
      const text = String(p.text ?? "");
      const source = String(p.source ?? "");
      const id = String(p.chunkId ?? hit.id);
      if (!title || !text) continue;
      chunks.push({ id, title, text, source });
    }
    if (!chunks.length) {
      this.log.debug(`Không có hit Qdrant cho query: ${query.slice(0, 80)}`);
    }
    return chunks;
  }

  format(chunks: PolicyChunk[]) {
    return formatPolicyChunks(chunks);
  }
}
