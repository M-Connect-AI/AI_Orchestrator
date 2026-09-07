/**
 * CLI: đọc packages/policy-docs/policies/*.md → embed local → ghi Qdrant.
 *
 *   pnpm policy:ingest
 *
 * Cần Qdrant đang chạy. Embedding mặc định: Xenova/multilingual-e5-small (local).
 */
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { policyChunks, qdrantPointId } from "@msb/policy-docs";
import { embedTexts } from "./embedding.client";
import {
  ensurePolicyCollection,
  POLICY_COLLECTION,
  upsertPolicyPoints,
} from "./qdrant.client";

function loadEnvFiles() {
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../../.env"),
    resolve(__dirname, "../../../../.env"),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  }
}

async function main() {
  loadEnvFiles();

  const model =
    process.env.EMBEDDING_MODEL?.trim() ||
    process.env.LLM_EMBEDDING_MODEL?.trim() ||
    "Xenova/multilingual-e5-small";
  const qdrantUrl = process.env.QDRANT_URL?.trim() || "http://127.0.0.1:6333";
  const collection =
    process.env.QDRANT_POLICY_COLLECTION?.trim() || POLICY_COLLECTION;

  const chunks = policyChunks();
  if (!chunks.length) {
    throw new Error("Không có chunk policy nào để ingest");
  }

  console.log(`Embedding ${chunks.length} chunk bằng ${model} (local)…`);
  const texts = chunks.map((c) => `${c.title}\n${c.text}`);
  const vectors = await embedTexts(texts, { model, asQuery: false });
  const dim = vectors[0]?.length;
  if (!dim) throw new Error("Vector embedding rỗng");

  console.log(`Recreate collection "${collection}" (dim=${dim}) @ ${qdrantUrl}`);
  await ensurePolicyCollection(qdrantUrl, collection, dim);

  const points = chunks.map((c, i) => ({
    id: qdrantPointId(c),
    vector: vectors[i],
    payload: {
      chunkId: c.id,
      title: c.title,
      text: c.text,
      source: c.source,
    },
  }));

  await upsertPolicyPoints(qdrantUrl, collection, points);
  console.log(`Ingest OK: ${points.length} points → ${collection}`);
  for (const c of chunks) {
    console.log(`  - [${c.source}] ${c.title}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
