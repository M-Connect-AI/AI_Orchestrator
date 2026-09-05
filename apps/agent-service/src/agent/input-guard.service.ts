import { Injectable } from "@nestjs/common";

const BLOCK = [
  /ignore (all )?(previous|prior) instructions/i,
  /you are now (dan|jailbroken)/i,
  /system prompt/i,
  /bypass (the )?(policy|guard|rule)/i,
  /lương của/,
  /mức lương/,
  /hồ sơ kỷ luật/,
  /mật khẩu/,
  /dữ liệu khách hàng/,
  /số tài khoản/,
  /core banking/,
];

const OTHER_PERSON = [
  /phép của (anh|chị|cô|chú|ông|bà|bạn|em)\s+\w+/i,
  /xem (toàn bộ|tất cả) (nhân viên|đơn phép|danh sách)/i,
  /list all (employees|leaves)/i,
];

export type GuardResult = { ok: true } | { ok: false; reason: string };

@Injectable()
export class InputGuardService {
  check(message: string): GuardResult {
    const text = message.trim();
    if (!text) return { ok: false, reason: "Tin nhắn trống." };
    if (text.length > 4000) return { ok: false, reason: "Tin nhắn quá dài." };
    for (const re of BLOCK) {
      if (re.test(text)) {
        return {
          ok: false,
          reason:
            "Yêu cầu nằm ngoài phạm vi trợ lý nhân sự hoặc có dấu hiệu cố vượt quyền. Tôi chỉ hỗ trợ nghỉ phép / công tác của bạn.",
        };
      }
    }
    return { ok: true };
  }

  looksLikeForeignAccess(message: string) {
    return OTHER_PERSON.some((re) => re.test(message));
  }
}
