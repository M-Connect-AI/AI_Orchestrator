import { LeaveType } from "@msb/shared";
import { POLICY } from "./policy.js";

function md(iso: string) {
  return iso.slice(5);
}

function inBlackout(from: string, to: string) {
  const a = md(from);
  const b = md(to);
  const { fromMd, toMd } = POLICY.leave.blackout;
  return a <= toMd && b >= fromMd && a >= "12-01";
}

function inclusiveDays(from: string, to: string) {
  const ms = new Date(`${to}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime();
  if (Number.isNaN(ms) || ms < 0) return -1;
  return Math.floor(ms / 86400000) + 1;
}

function daysUntil(from: string) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(`${from}T00:00:00`);
  return Math.round((start.getTime() - today.getTime()) / 86400000);
}

export type PolicyVerdict = {
  allowed: boolean;
  reasons: string[];
  citations: string[];
};

export function validateLeave(input: {
  type: LeaveType;
  from: string;
  to: string;
  annualRemaining?: number;
}): PolicyVerdict {
  const reasons: string[] = [];
  const citations: string[] = [];
  const days = inclusiveDays(input.from, input.to);
  if (days < 1) {
    return { allowed: false, reasons: ["Khoảng ngày không hợp lệ."], citations: [] };
  }
  const advance = daysUntil(input.from);

  if (input.type === "ANNUAL") {
    citations.push("QĐ nghỉ phép §1 Phép năm");
    if (advance < POLICY.leave.annual.minAdvanceDays) {
      reasons.push(
        `Phép năm phải xin trước ít nhất ${POLICY.leave.annual.minAdvanceDays} ngày làm việc.`,
      );
    }
    if (days > POLICY.leave.annual.maxConsecutiveDays) {
      reasons.push(
        `Không nghỉ phép năm liên tục quá ${POLICY.leave.annual.maxConsecutiveDays} ngày.`,
      );
    }
    if (typeof input.annualRemaining === "number" && days > input.annualRemaining) {
      reasons.push(`Số ngày xin (${days}) vượt số dư phép năm còn lại (${input.annualRemaining}).`);
    }
    if (inBlackout(input.from, input.to)) {
      reasons.push("Không được nghỉ phép năm trong giai đoạn blackout 25/12–31/12.");
    }
  }

  if (input.type === "SICK") {
    citations.push("QĐ nghỉ phép §2 Phép ốm");
    if (days > POLICY.leave.sick.maxDaysPerRequest) {
      reasons.push(`Phép ốm tối đa ${POLICY.leave.sick.maxDaysPerRequest} ngày/lần xin .`);
    }
  }

  if (input.type === "UNPAID") {
    citations.push("QĐ nghỉ phép §3 Nghỉ không lương");
    if (advance < POLICY.leave.unpaid.minAdvanceDays) {
      reasons.push(`Nghỉ không lương phải xin trước ${POLICY.leave.unpaid.minAdvanceDays} ngày.`);
    }
    if (days > POLICY.leave.unpaid.maxDaysPerRequest) {
      reasons.push(`Nghỉ không lương tối đa ${POLICY.leave.unpaid.maxDaysPerRequest} ngày/lần.`);
    }
  }

  return { allowed: reasons.length === 0, reasons, citations };
}

export function validateTrip(input: {
  from: string;
  to: string;
  purpose: string;
  destination: string;
}): PolicyVerdict {
  const reasons: string[] = [];
  const citations = ["QĐ nghỉ phép §4 Công tác"];
  const days = inclusiveDays(input.from, input.to);
  if (days < 1) reasons.push("Khoảng ngày công tác không hợp lệ.");
  if (!input.destination?.trim()) reasons.push("Thiếu địa điểm công tác.");
  if ((input.purpose ?? "").trim().length < POLICY.trip.minPurposeLength) {
    reasons.push(`Mục đích công tác phải từ ${POLICY.trip.minPurposeLength} ký tự.`);
  }
  if (days > POLICY.trip.maxDays) {
    reasons.push(`Công tác tối đa ${POLICY.trip.maxDays} ngày/chuyến.`);
  }
  if (POLICY.trip.respectBlackout && days >= 1 && inBlackout(input.from, input.to)) {
    reasons.push("Công tác không khẩn cấp không được trùng blackout 25/12–31/12.");
  }
  return { allowed: reasons.length === 0, reasons, citations };
}
