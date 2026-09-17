# Chat UI cho mobile — `blocks` + `highlights`

Web và mobile dùng **cùng JSON**. LLM vẫn trả `content` text thuần (không markdown). Chart / KPI / list / quote đến từ field mới trên SSE `done` và trên từng message assistant khi load lại thread.

`confirm` và `uiAction` **giữ nguyên** như hiện tại — không chuyển vào `blocks`.

## 1. SSE `/chat/stream`

Thứ tự event không đổi: `status` → `token`* → `confirm?` → `result?` → `done` | `error`.

`token`: append vào `content` (streaming). Chưa có chart lúc này.

`done`:

```json
{
  "threadId": "…",
  "uiAction": { "key": "LEAVE_RESULTS", "label": "Xem đơn nghỉ phép", "path": "/leaves" },
  "blocks": [ { "type": "kpis", "items": [] } ],
  "highlights": [
    { "start": 12, "end": 22, "kind": "metric" },
    { "start": 40, "end": 49, "kind": "status", "tone": "ok" }
  ],
  "suggestions": [
    { "label": "Tóm tắt mail chưa đọc", "text": "Tóm tắt mail chưa đọc" },
    { "label": "Xem mail hôm qua", "text": "Xem mail hôm qua" }
  ]
}
```

- `blocks` / `highlights` / `suggestions` có thể `[]`.
- Index highlight là **UTF-16** (JS / Java `String` / Swift `NSString` / Kotlin UTF-16) trên `content` đã ghép đủ token.
- Áp highlight **sau khi stream xong**, trên `content` cuối.
- `suggestions`: 2–3 chip do model đề xuất. `label` = `text` = đúng câu sẽ gửi khi tap (không rút label rồi gửi câu khác). **Không hiện** khi đang có `confirm`. Không trùng `uiAction.label`. Không nhảy domain.

`confirm` event và `uiAction` trên `done` xử lý như docs cũ (nút xác nhận / điều hướng). Chip gợi ý **xếp cùng hàng** với nút `uiAction` (nút cam = điều hướng, chip cream = gửi câu tiếp).

## 2. GET `/chat/threads/:threadId`

Mỗi phần tử `messages[]`:

```json
{
  "role": "assistant",
  "content": "Bạn còn 8/12 ngày phép năm.",
  "highlights": [{ "start": 8, "end": 21, "kind": "metric" }],
  "blocks": [{ "type": "progress", "title": "Phép năm đã dùng", "value": 4, "max": 12, "suffix": "ngày" }],
  "uiAction": { "key": "LEAVE_RESULTS", "label": "Xem số dư / đơn nghỉ", "path": "/leaves" },
  "suggestions": [
    { "label": "Xin nghỉ phép năm ngày mai", "text": "Xin nghỉ phép năm ngày mai" }
  ]
}
```

User message chỉ có `role` + `content`. Message cũ (trước khi deploy) không có `blocks`/`highlights`/`suggestions` — fallback hiện `content`.

## 3. `highlights[]`

| `kind` | Gợi ý style (tone MSB) |
| --- | --- |
| `metric` | Cam `#F15A22`, semibold, không nền |
| `date` | Nền cream `#FFE8DA`, chữ ink |
| `status` | Pill theo `tone` (xem dưới) |
| `id` | Mono, nền cream (Jira key, EMP) |
| `warn` | Nền đỏ nhạt, chữ đỏ |

`kind=status` kèm `tone`:

| `tone` | Ví dụ | Màu |
| --- | --- | --- |
| `ok` | đã duyệt, đã đọc | xanh `#059669` / nền emerald nhạt |
| `warn` | chờ duyệt, chưa đọc | cam `#C7370F` / nền cam nhạt |
| `bad` | từ chối, quá hạn | đỏ |
| `neutral` | đã hủy | xám |

Nếu thiếu `tone`, fallback pill cam. `start` inclusive, `end` exclusive. Bỏ span nếu `end <= start` hoặc vượt `content.length`. Không overlap.

## 4. `blocks[]` — render theo `type`

Bỏ qua `type` lạ (forward-compatible). Thứ tự mảng = thứ tự UI, **dưới** đoạn `content`.

Màu MSB: cam `#F15A22`, cam nhạt `#F5A06B`, cam đậm `#C7370F`, taupe `#C4B5A5`, cream `#FFF3EC`, ink `#1C1410`.

### `kpis`

```json
{ "type": "kpis", "items": [
  { "label": "Cần làm", "value": "8", "tone": "warn" }
]}
```

`tone`: `ok` | `warn` | `bad` | `neutral` (optional). Mobile: lưới 2 cột, số to.

### `bars`

```json
{ "type": "bars", "title": "Theo độ ưu tiên", "items": [
  { "label": "High", "value": 5, "color": "#C7370F" }
]}
```

Bar ngang: label + value, track cream, fill `color` hoặc cam. Scale theo `max(items.value)`.

### `donut`

Cùng shape `items` như `bars`. Legend xếp **dưới** vòng trên mobile; cạnh vòng trên tablet. Lỗ giữa = tổng.

### `progress`

```json
{ "type": "progress", "title": "Phép năm đã dùng", "value": 4, "max": 12, "suffix": "ngày" }
```

Thanh cam, caption `value/max suffix`.

### `list`

```json
{ "type": "list", "title": "Hộp thư", "items": [
  {
    "kicker": "HR MSB · 16/09/2026 21:46",
    "title": "Nhắc hạn đăng ký phép",
    "subtitle": "Bạn vui lòng hoàn tất đơn…",
    "badge": "Chưa đọc",
    "tone": "warn"
  }
]}
```

`kicker` (tuỳ chọn): dòng nhỏ trên title — dùng cho người gửi mail. `url` có → tap mở. `badge` + `tone` như KPI. Mail chưa đọc: `tone=warn`.

### `quote`

```json
{ "type": "quote", "title": "Quy định nghỉ phép", "text": "…", "source": "nghi-phep.md" }
```

Card cream, vạch cam trái — trích policy.

## 5. Layout bubble (bám app MSB)

- User: nền `#F15A22`, chữ trắng, góc ~20, góc dưới-phải nhỏ hơn.
- Assistant: nền trắng, viền cream, chữ ink; **KPI/chart/list nằm trong bubble** (web) hoặc full-width dưới text nếu bubble quá hẹp.
- Chip gợi ý: pill cream, chữ ink — cùng hàng với `uiAction` (pill viền cam). Tap = gửi `suggestion.text`.
- Confirm: card riêng, nút cam full-width pill — **vẫn dùng event `confirm`**, không lấy từ blocks. Khi có confirm thì **ẩn** suggestions.
- `uiAction.key` map màn hình như README (`LEAVE_RESULTS`, `TRIP_RESULTS`, Outlook, Jira, `OUTLOOK_CONNECT`).
- List mail / đơn / lịch: `content` chỉ 1–2 câu đếm **từ API**; chi tiết nằm trong `blocks`, không do LLM bịa hay liệt kê lại.

## 6. Việc không làm

- Không parse markdown / HTML từ `content`.
- Không tự vẽ chart từ text.
- Client cũ bỏ qua `blocks`/`highlights`/`suggestions` vẫn chạy (chỉ text + `uiAction` + `confirm`).
