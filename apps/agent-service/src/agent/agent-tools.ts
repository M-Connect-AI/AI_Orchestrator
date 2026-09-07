import { ChatToolDef } from "./llm.client";

export const AGENT_TOOL_DEFS: ChatToolDef[] = [
  {
    type: "function",
    function: {
      name: "get_leave_balance",
      description: "Lấy số dư phép năm / phép ốm của chính người dùng đang chat.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "list_leaves",
      description:
        "Tra cứu / lọc danh sách đơn nghỉ phép. STAFF chỉ thấy đơn của mình. MANAGER thấy team. Dùng khi user muốn xem, liệt kê, thống kê đơn (kể cả đã duyệt / từ chối). Khi hỏi đơn cần duyệt: gọi status=PENDING và đồng thời gọi list_trips(status=PENDING).",
      parameters: {
        type: "object",
        properties: {
          leaveType: {
            type: "string",
            enum: ["ANNUAL", "SICK", "UNPAID"],
            description: "Loại phép",
          },
          status: {
            type: "string",
            enum: ["PENDING", "APPROVED", "REJECTED", "CANCELLED"],
            description: "Trạng thái đơn",
          },
          employeeHint: {
            type: "string",
            description: "Tên hoặc mã NV (chỉ MANAGER). Ví dụ: An, EMP001",
          },
          from: {
            type: "string",
            description: "Ngày/khoảng — YYYY-MM-DD hoặc 6/9, 06/09. Một ngày thì from=to.",
          },
          to: {
            type: "string",
            description: "Ngày kết thúc khoảng lọc (cùng format). Một ngày thì = from.",
          },
          reasonHint: { type: "string", description: "Từ khóa trong lý do nghỉ" },
          daysHint: { type: "string", description: "Số ngày nghỉ, ví dụ \"1\"" },
          ordinal: {
            type: "string",
            description: "Chọn đơn thứ N trong kết quả lọc, ví dụ \"2\"",
          },
          leaveId: { type: "string", description: "Mã đơn cụ thể nếu biết" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_trips",
      description:
        "Tra cứu đơn công tác (STAFF: của mình; MANAGER: team). Khi user hỏi đơn cần duyệt / chờ duyệt: gọi với status=PENDING (và cũng gọi list_leaves status=PENDING vì nghỉ phép là nguồn khác). Có thể lọc employeeHint, from, to.",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["PENDING", "APPROVED", "REJECTED", "CANCELLED"],
            description: "Lọc trạng thái — PENDING = đang chờ duyệt",
          },
          employeeHint: { type: "string", description: "Tên hoặc mã NV" },
          from: { type: "string", description: "YYYY-MM-DD hoặc 6/9" },
          to: { type: "string" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_policy",
      description: "Tra cứu quy định nội bộ về nghỉ phép / công tác.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Câu hỏi hoặc từ khóa quy định" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_create_leave",
      description:
        "Đề xuất tạo đơn nghỉ phép mới. KHÔNG gửi ngay — hệ thống sẽ hỏi user xác nhận. Gọi khi đã đủ loại phép, ngày, lý do.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["ANNUAL", "SICK", "UNPAID"] },
          from: { type: "string", description: "YYYY-MM-DD" },
          to: { type: "string", description: "YYYY-MM-DD" },
          reason: { type: "string", description: "Lý do nghỉ (≥ 3 ký tự)" },
        },
        required: ["type", "from", "to", "reason"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_create_trip",
      description:
        "Đề xuất tạo đơn công tác. KHÔNG gửi ngay — cần user xác nhận. Cần địa điểm, ngày đi/về, mục đích.",
      parameters: {
        type: "object",
        properties: {
          destination: { type: "string" },
          from: { type: "string", description: "YYYY-MM-DD" },
          to: { type: "string", description: "YYYY-MM-DD" },
          purpose: { type: "string", description: "Mục đích (≥ 10 ký tự)" },
        },
        required: ["destination", "from", "to", "purpose"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_cancel_leave",
      description: "Đề xuất hủy đơn nghỉ phép đang chờ của chính user. Cần leaveId. Chờ xác nhận.",
      parameters: {
        type: "object",
        properties: {
          leaveId: { type: "string" },
        },
        required: ["leaveId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_update_leave",
      description:
        "Đề xuất sửa đơn nghỉ phép đang chờ của chính user. Cần leaveId và các trường cần đổi. Chờ xác nhận.",
      parameters: {
        type: "object",
        properties: {
          leaveId: { type: "string" },
          type: { type: "string", enum: ["ANNUAL", "SICK", "UNPAID"] },
          from: { type: "string" },
          to: { type: "string" },
          reason: { type: "string" },
        },
        required: ["leaveId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_approve_leaves",
      description:
        "Chỉ MANAGER. Đề xuất phê duyệt đơn nghỉ phép đang chờ. BẮT BUỘC truyền đúng bộ lọc user nói: employeeHint (tên/mã), from/to (ngày nghỉ, dạng YYYY-MM-DD hoặc 6/9), leaveType nếu có. Ví dụ “duyệt đơn Minh ngày 6/9” → employeeHint=Minh, from=to=ngày đó. Chỉ dùng ids khi user chọn theo mã/thứ tự danh sách vừa xem và không nêu ngày/người. approveAll=true chỉ khi user nói duyệt hết/tất cả. KHÔNG duyệt ngay — chờ xác nhận.",
      parameters: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            items: { type: "string" },
            description: "Danh sách mã đơn cần duyệt (chỉ khi không có bộ lọc ngày/người)",
          },
          leaveType: { type: "string", enum: ["ANNUAL", "SICK", "UNPAID"] },
          employeeHint: { type: "string" },
          from: {
            type: "string",
            description: "Ngày/khoảng — YYYY-MM-DD hoặc 6/9. Một ngày thì from=to.",
          },
          to: { type: "string", description: "Ngày kết thúc khoảng lọc" },
          reasonHint: { type: "string" },
          ordinal: { type: "string", description: "Duyệt đơn thứ N trong danh sách chờ / listedIds" },
          approveAll: {
            type: "boolean",
            description: "true = duyệt tất cả đơn chờ của team",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_reject_leaves",
      description:
        "Chỉ MANAGER. Đề xuất từ chối đơn nghỉ phép đang chờ. Cùng cách lọc như propose_approve_leaves (employeeHint/from/to/leaveType/ids). Chờ xác nhận.",
      parameters: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" } },
          leaveType: { type: "string", enum: ["ANNUAL", "SICK", "UNPAID"] },
          employeeHint: { type: "string" },
          from: { type: "string" },
          to: { type: "string" },
          reasonHint: { type: "string" },
          ordinal: { type: "string" },
          rejectAll: { type: "boolean" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_approve_trips",
      description:
        "Chỉ MANAGER. Đề xuất phê duyệt đơn công tác đang chờ. Truyền ids, employeeHint/from/to, hoặc approveAll. Chờ xác nhận.",
      parameters: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" } },
          employeeHint: { type: "string" },
          from: { type: "string" },
          to: { type: "string" },
          approveAll: { type: "boolean" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_reject_trips",
      description:
        "Chỉ MANAGER. Đề xuất từ chối đơn công tác đang chờ. Cùng cách lọc như propose_approve_trips. Chờ xác nhận.",
      parameters: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" } },
          employeeHint: { type: "string" },
          from: { type: "string" },
          to: { type: "string" },
          rejectAll: { type: "boolean" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "confirm_pending_action",
      description:
        "Thực thi thao tác đang chờ xác nhận (tạo/hủy/duyệt/từ chối/sửa đơn). Gọi khi user đồng ý (oke, ok, đồng ý, xác nhận, gửi đi, bấm nút…). Chỉ khi có pendingAction.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_pending_action",
      description:
        "Hủy thao tác đang chờ xác nhận. Gọi khi user từ chối (không, thôi, hủy…).",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
];

/** Chỉ dùng khi đã có pending — model tự quyết đồng ý / hủy, không đoán bằng regex. */
export const PENDING_RESOLUTION_TOOLS = AGENT_TOOL_DEFS.filter((t) =>
  t.function.name === "confirm_pending_action" || t.function.name === "cancel_pending_action",
);
