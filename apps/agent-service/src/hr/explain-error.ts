const FIELD_LABEL: Record<string, string> = {
  reason: "Lý do nghỉ phép",
  purpose: "Mục đích công tác",
  destination: "Địa điểm công tác",
  from: "Ngày bắt đầu",
  to: "Ngày kết thúc",
  type: "Loại phép",
  status: "Trạng thái đơn",
};

/** Đổi lỗi HR / class-validator thành câu tiếng Việt, chỉ rõ chỗ cần sửa. */
export function explainHrError(raw: unknown): string {
  const items = flattenMessages(raw);
  const lines = items.map(explainOne).filter(Boolean);
  const body = lines.length
    ? lines.map((l) => `- ${l}`).join("\n")
    : "- Hệ thống nhân sự từ chối yêu cầu.";
  return `Không gửi được đơn:\n${body}\n\nĐơn chưa được lưu. Bạn sửa đúng chỗ trên rồi nhắn lại để mình tạo tiếp.`;
}

export function flattenMessages(raw: unknown): string[] {
  if (raw instanceof Error) return flattenMessages(raw.message);
  if (Array.isArray(raw)) return raw.flatMap(flattenMessages);
  if (typeof raw === "object" && raw && "message" in raw) {
    return flattenMessages((raw as { message: unknown }).message);
  }
  if (typeof raw !== "string" || !raw.trim()) return [];
  const text = raw.trim();
  if (text.startsWith("[") && text.endsWith("]")) {
    try {
      return flattenMessages(JSON.parse(text));
    } catch {
      /* not json */
    }
  }
  return text
    .split(/\n|;/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function explainOne(msg: string): string {
  const lower = msg.toLowerCase();
  const field = Object.keys(FIELD_LABEL).find(
    (name) => lower.startsWith(`${name} `) || lower.startsWith(`${name} must`),
  );
  const label = field ? FIELD_LABEL[field] : null;

  const minLen = /longer than or equal to (\d+)/i.exec(msg);
  if (minLen && label) {
    const n = minLen[1];
    if (field === "reason") {
      return `${label} phải từ ${n} ký tự trở lên. “ốm” quá ngắn — viết rõ hơn, ví dụ: ốm đau, khám bệnh, việc gia đình.`;
    }
    return `${label} phải từ ${n} ký tự trở lên. Hiện tại đang quá ngắn.`;
  }

  if (/must match|must be a valid iso|must be a mongodb id/i.test(msg) && label) {
    return field === "from" || field === "to"
      ? `${label} phải dạng năm-tháng-ngày (YYYY-MM-DD), ví dụ 2026-09-12.`
      : `${label} không đúng định dạng.`;
  }

  if (/must be one of|must be a valid enum/i.test(msg) && label) {
    return field === "type"
      ? `${label} chỉ nhận phép năm, phép ốm hoặc không lương.`
      : `${label} không hợp lệ.`;
  }

  if (/unauthorized|jwt|401/i.test(lower)) {
    return "Phiên đăng nhập hết hạn. Bạn đăng nhập lại giúp mình.";
  }

  if (/[àáạảãăằắặẳẵâầấậẩẫèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(msg)) {
    return msg;
  }

  return label ? `${label}: ${msg}` : `Hệ thống nhân sự báo: ${msg}`;
}
