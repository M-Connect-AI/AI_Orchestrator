import { Injectable, Logger } from "@nestjs/common";
import { LlmClient, stripThink } from "./llm.client";

const SYSTEM = `Bạn là trợ lý nhân sự nội bộ MSB (MConnect AI).
Xưng "mình", gọi người dùng "bạn". Tiếng Việt tự nhiên, gần gũi, không sáo rỗng.
Viết 2–6 câu. Được xuống dòng và gạch đầu dòng khi liệt kê.

NHIỆM VỤ: diễn đạt LẠI bản nháp sự thật do hệ thống quyết định. Không phải chatbot tự quyết.

CẤM:
- Đổi ngày, loại phép, số dư, mã đơn, kết luận được/không được
- Thêm quyền, hứa duyệt đơn, bịa quy định
- Nói đã gửi đơn nếu nháp chưa nói đã gửi
- Bỏ điều kiện còn thiếu hoặc lý do từ chối
- Nhắc "bản nháp", "hệ thống", "prompt"

NẾU nháp bảo thiếu thông tin: hỏi đúng phần thiếu, giọng nhẹ.
NẾU nháp bảo trái quy định: giữ đủ lý do và căn cứ, an ủi ngắn, gợi ý cách chỉnh.
NẾU nháp là danh sách / thống kê đơn (không mời xác nhận): giữ nguyên số liệu, phạm vi lọc (kể cả đã duyệt / từ chối / đã hủy / tháng này), số thứ tự. Không nói là không liệt kê được. Không tự chuyển thành duyệt đơn.
NẾU nháp là thống kê đơn chờ duyệt kèm mời xác nhận: giữ nguyên số liệu và phạm vi. Hỏi xác nhận đúng số đơn trong nháp, không tự mở rộng thành duyệt hết team.
NẾU nháp mời xác nhận: kết thúc bằng lời mời xác nhận (đơn chưa gửi / chưa duyệt).
NẾU đã gửi hoặc đã duyệt thành công: vui, ngắn, nhắc xem tab Kết quả.
NẾU lỗi: nói rõ chỗ sửa, không đổ lỗi kỹ thuật.

Chỉ trả lời nội dung cho người dùng, không JSON, không markdown heading.`;

@Injectable()
export class ComposeService {
  private readonly log = new Logger(ComposeService.name);

  constructor(private readonly llm: LlmClient) {}

  async phrase(input: {
    draft: string;
    userMessage: string;
    history: string[];
    intent?: string;
    hasConfirm: boolean;
    citations: string[];
    onToken?: (text: string) => void;
  }): Promise<string> {
    const draft = input.draft?.trim();
    if (!draft) return draft;
    const messages = [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: JSON.stringify({
          userMessage: input.userMessage,
          intent: input.intent ?? null,
          waitingForConfirm: input.hasConfirm,
          citations: input.citations,
          recentHistory: input.history.slice(-6),
          factDraft: draft,
        }),
      },
    ];
    try {
      if (input.onToken) {
        let full = "";
        try {
          for await (const piece of this.llm.completeStream(messages, {
            temperature: 0.75,
            max_tokens: 400,
          })) {
            full += piece;
            input.onToken(piece);
          }
          const cleaned = sanitizeReply(stripThink(full));
          return cleaned || draft;
        } catch (e) {
          this.log.warn(`Compose stream fail, fallback non-stream: ${String(e)}`);
          if (full.trim()) return sanitizeReply(stripThink(full)) || draft;
        }
      }
      const text = await this.llm.complete(messages, { temperature: 0.75, max_tokens: 400 });
      const cleaned = sanitizeReply(text) || draft;
      if (input.onToken && cleaned) input.onToken(cleaned);
      return cleaned;
    } catch (e) {
      this.log.warn(`Compose LLM failed, dùng bản nháp: ${String(e)}`);
      return draft;
    }
  }
}

function sanitizeReply(raw: string) {
  const text = raw.replace(/^```(?:\w+)?\s*|\s*```$/g, "").trim();
  if (!text || text.startsWith("{")) return "";
  return text;
}
