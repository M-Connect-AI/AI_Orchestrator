import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { POLICY } from "./policy.js";

export type PolicyChunk = { title: string; text: string };

export function leavePolicyMarkdown(): string {
  const files = [join(__dirname, "leave-policy.md"), join(__dirname, "../leave-policy.md")];
  for (const file of files) {
    if (existsSync(file)) return readFileSync(file, "utf8");
  }
  return "";
}

export function policyChunks(): PolicyChunk[] {
  const raw = leavePolicyMarkdown();
  const fromDoc = raw
    .split(/^## /m)
    .filter(Boolean)
    .map((part) => {
      const [title, ...rest] = part.split("\n");
      return { title: title.trim(), text: rest.join("\n").trim() };
    });
  return [...fromDoc, { title: "Tham số hệ thống", text: policyNumbersText() }];
}

export function retrievePolicy(query: string, k = 3): PolicyChunk[] {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
  return policyChunks()
    .map((c) => {
      const hay = `${c.title}\n${c.text}`.toLowerCase();
      const score = tokens.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
      return { c, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .filter((s) => s.score > 0)
    .map((s) => s.c);
}

export function formatPolicyChunks(chunks: PolicyChunk[]) {
  if (!chunks.length) return "Không tìm thấy điều khoản phù hợp.";
  return chunks.map((c) => `### ${c.title}\n${c.text}`).join("\n\n");
}

function policyNumbersText() {
  const { annual, sick, unpaid, blackout } = POLICY.leave;
  return [
    `Phép năm: ${annual.totalDaysPerYear} ngày/năm, xin trước ${annual.minAdvanceDays} ngày, tối đa ${annual.maxConsecutiveDays} ngày liên tục.`,
    `Phép ốm: xin trong ngày, tối đa ${sick.maxDaysPerRequest} ngày/lần.`,
    `Không lương: xin trước ${unpaid.minAdvanceDays} ngày, tối đa ${unpaid.maxDaysPerRequest} ngày/lần.`,
    `Blackout: ${blackout.fromMd} đến ${blackout.toMd}.`,
    `Công tác: mục đích ≥ ${POLICY.trip.minPurposeLength} ký tự, tối đa ${POLICY.trip.maxDays} ngày/chuyến.`,
  ].join("\n");
}
