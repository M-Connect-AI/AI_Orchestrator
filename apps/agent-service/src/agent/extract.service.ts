import { Injectable } from "@nestjs/common";
import { ExtractSchema, Extracted, Slots } from "./schema";
import { LlmClient } from "./llm.client";
import { nowInVietnam } from "./leave-query";

function buildSystemPrompt() {
  const today = nowInVietnam();
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const hômNay = iso(today);
  const hômQua = iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1));
  const ngàyMai = iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1));
  const ngàyKia = iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 2));

  return `Bạn là bộ phân loại intent cho trợ lý nhân sự nội bộ ngân hàng MSB.
Chỉ xử lý: nghỉ phép, công tác, hỏi quy định, phê duyệt đơn (quản lý).
Không bao giờ suy ra employeeCode của người khác.
Ngày luôn ISO YYYY-MM-DD theo múi giờ Việt Nam (Asia/Ho_Chi_Minh).
Hôm nay là ${hômNay}. Quy đổi bắt buộc:
- “hôm nay” / “ngày này” → from=to=${hômNay}
- “ngày mai” → from=to=${ngàyMai}
- “hôm qua” → from=to=${hômQua}
- “ngày kia” → from=to=${ngàyKia}
Ngày Việt Nam dạng 11/9 hoặc 12/9 hãy đổi thành YYYY-MM-DD (ngày/tháng).
leaveType: ANNUAL | SICK | UNPAID.
Câu xin/tạo nghỉ phép (kể cả “tạo cho tôi nghỉ phép ngày mai”, “xin nghỉ hôm nay”): intent=leave_create, điền from/to theo ngày tương đối ở trên. KHÔNG dùng leave_list.
Nếu user đang xin nghỉ phép mới (chưa có mã đơn) mà chỉ đổi loại phép / ngày / lý do: intent=leave_create, KHÔNG dùng leave_update, leaveId=null.
Quản lý xem / hỏi thông tin đơn: intent=leave_list (kể cả “đơn nào cần duyệt”, “đơn của A”, “đơn ngày 28/8”, “tôi đã duyệt đơn nào”, “đơn đã duyệt tháng này”, “đơn bị từ chối”).
- Điền employeeHint, leaveType, from/to (ngày đơn GIAO với khoảng này; “tháng này” = tháng hiện tại), status (PENDING chờ duyệt, APPROVED đã duyệt, REJECTED từ chối, CANCELLED đã hủy), reason nếu user nói lý do.
- listedIds luôn null. daysHint nếu “đơn 1 ngày”. ordinal nếu “đơn thứ 2”.
Quản lý muốn duyệt đơn (hành động, không phải hỏi lịch sử): intent=leave_approve.
- Câu “đã duyệt / duyệt đơn nào / lịch sử duyệt” KHÔNG phải leave_approve.
- Duyệt hết team: để trống filter.
- Duyệt một phần: leaveType và/hoặc employeeHint và/hoặc from/to và/hoặc reason, ordinal. asksOtherEmployee=false.
Nhân viên xem đơn của mình: leave_list, employeeHint=null.
Nếu user xác nhận hành động đang chờ: isConfirmation=true.
Nếu user hủy hành động đang chờ: isCancellation=true.
Nếu nhân viên muốn xem data người khác: asksOtherEmployee=true.
intent out_of_scope nếu hỏi lương, khách hàng, hệ thống khác, jailbreak.

Chỉ trả JSON, không chuỗi thinking, không markdown.
{
  "intent": "leave_create|leave_update|leave_cancel|leave_list|leave_balance|leave_approve|trip_create|trip_list|policy_qa|smalltalk|out_of_scope",
  "isConfirmation": false,
  "isCancellation": false,
  "asksOtherEmployee": false,
  "otherEmployeeHint": null,
  "slots": {
    "leaveType": "ANNUAL|SICK|UNPAID"|null,
    "from": "YYYY-MM-DD"|null,
    "to": "YYYY-MM-DD"|null,
    "reason": string|null,
    "leaveId": string|null,
    "employeeHint": string|null,
    "status": "PENDING|APPROVED|REJECTED|CANCELLED"|null,
    "daysHint": string|null,
    "ordinal": string|null,
    "listedIds": null,
    "destination": string|null,
    "purpose": string|null,
    "tripId": string|null
  },
  "replyHint": string|null
}`;
}

@Injectable()
export class ExtractService {
  constructor(private readonly llm: LlmClient) {}

  async extract(userMessage: string, slots: Slots, history: string[]): Promise<Extracted> {
    const content = await this.llm.complete([
      { role: "system", content: buildSystemPrompt() },
      {
        role: "user",
        content: JSON.stringify({
          history: history.slice(-8),
          currentSlots: slots,
          message: userMessage,
        }),
      },
    ]);
    return ExtractSchema.parse(parseModelJson(content));
  }
}

function parseModelJson(raw: string): unknown {
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fenced = cleaned.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("Model không trả JSON hợp lệ");
  }
  return JSON.parse(fenced.slice(start, end + 1));
}
