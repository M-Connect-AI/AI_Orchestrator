import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { POLICY } from "./policy.js";

export type PolicyChunk = {
  id: string;
  title: string;
  text: string;
  source: string;
};

/** Thư mục chứa *.md — nguồn sự thật cho RAG (git). */
export function policiesDir(): string {
  const candidates = [
    join(__dirname, "policies"),
    join(__dirname, "../policies"),
    join(process.cwd(), "packages/policy-docs/policies"),
    join(process.cwd(), "policies"),
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  throw new Error(
    "Không tìm thấy thư mục policies/. Đặt file .md trong packages/policy-docs/policies/",
  );
}

export function listPolicyFiles(): string[] {
  return readdirSync(policiesDir())
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => join(policiesDir(), f));
}

function chunkId(source: string, title: string, text: string) {
  return createHash("sha256").update(`${source}\n${title}\n${text}`).digest("hex").slice(0, 32);
}

/** Qdrant point id (UUID-shaped) ổn định theo nội dung chunk. */
export function qdrantPointId(chunk: Pick<PolicyChunk, "id">): string {
  const h = chunk.id.padEnd(32, "0").slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function chunksFromMarkdown(source: string, raw: string): PolicyChunk[] {
  return raw
    .split(/^## /m)
    .filter(Boolean)
    .map((part) => {
      const [titleLine, ...rest] = part.split("\n");
      const title = titleLine.replace(/^#+\s*/, "").trim();
      const text = rest.join("\n").trim();
      return {
        id: chunkId(source, title, text),
        title,
        text,
        source,
      };
    })
    .filter((c) => c.title && c.text);
}

function policyNumbersChunk(): PolicyChunk {
  const { annual, sick, unpaid, blackout } = POLICY.leave;
  const text = [
    `Phép năm: ${annual.totalDaysPerYear} ngày/năm, xin trước ${annual.minAdvanceDays} ngày, tối đa ${annual.maxConsecutiveDays} ngày liên tục.`,
    `Phép ốm: xin trong ngày, tối đa ${sick.maxDaysPerRequest} ngày/lần.`,
    `Không lương: xin trước ${unpaid.minAdvanceDays} ngày, tối đa ${unpaid.maxDaysPerRequest} ngày/lần.`,
    `Blackout: ${blackout.fromMd} đến ${blackout.toMd}.`,
    `Công tác: mục đích ≥ ${POLICY.trip.minPurposeLength} ký tự, tối đa ${POLICY.trip.maxDays} ngày/chuyến.`,
  ].join("\n");
  const title = "Tham số hệ thống";
  const source = "policy.ts";
  return { id: chunkId(source, title, text), title, text, source };
}

/** Toàn bộ chunk từ policies/*.md + số liệu POLICY (để RAG cite). */
export function policyChunks(): PolicyChunk[] {
  const fromFiles = listPolicyFiles().flatMap((filePath) => {
    const source = filePath.split(/[/\\]/).pop() ?? filePath;
    return chunksFromMarkdown(source, readFileSync(filePath, "utf8"));
  });
  return [...fromFiles, policyNumbersChunk()];
}

export function formatPolicyChunks(chunks: PolicyChunk[]) {
  if (!chunks.length) return "Không tìm thấy điều khoản phù hợp.";
  return chunks.map((c) => `### ${c.title}\n(Nguồn: ${c.source})\n${c.text}`).join("\n\n");
}
