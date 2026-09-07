# MSB HR Copilot

Hệ thống AI Agent thực thi nghiệp vụ nhân sự nội bộ (nghỉ phép, công tác). Hackathon MSB 2026.

## Kiến trúc

- `apps/web` — React, chat + tab kết quả
- `apps/agent-service` — NestJS + LangGraph, guardrails, HITL
- `apps/hr-mock-service` — NestJS + MongoDB, CRUD giả lập HR
- `packages/policy-docs` — quy định nghỉ phép / công tác (markdown + số liệu + validate)
- MongoDB cho HR data và conversation checkpoint

LLM: GreenNode MaaS (OpenAI-compatible), bắt buộc `LLM_API_KEY` trong `.env`.

## Chạy local

```bash
docker compose up -d
cp .env.example .env
pnpm install
pnpm --filter @msb/shared --filter @msb/policy-docs build
pnpm --filter @msb/hr-mock-service seed
pnpm dev
```

- UI: http://localhost:5173
- Agent: http://localhost:3001
- HR Mock: http://localhost:3002

Tài khoản demo (mật khẩu `password123`):

| Role | Email | Ghi chú |
|---|---|---|
| STAFF | a.nguyen@msb.vn | Team Trần Thị B |
| STAFF | c.le@msb.vn | Team Trần Thị B |
| MANAGER | b.tran@msb.vn | Duyệt đơn team |

Hoặc dùng tab **Đăng ký** trên màn login để tạo user mới (tự cấp `EMPxxx`).

Gắn GreenNode: điền `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` trong `.env`.

## Deploy VNG Cloud (vServer)

Cùng một stack: Caddy (80/443) → web + `/api/agent` + `/api/hr`; Mongo không public. LLM vẫn gọi GreenNode MaaS.

1. Tạo vServer Ubuntu 22.04/24.04 (HCM), gắn IP public. Security Group mở **22, 80, 443**.
2. SSH vào máy, clone repo, cài Docker:

```bash
sudo bash deploy/vserver-bootstrap.sh
# đăng xuất SSH rồi login lại (group docker)
```

3. Tạo `.env.prod` từ mẫu, điền `JWT_SECRET` và `LLM_API_KEY`.

```bash
cp .env.prod.example .env.prod
nano .env.prod
```

4. Build và chạy:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
docker compose -f docker-compose.prod.yml --env-file .env.prod --profile seed run --rm seed
```

5. Mở `http://<IP-public>`. Demo: `b.tran@msb.vn` / `password123`.

**Domain + HTTPS:** trỏ A record về IP VM, sửa `SITE_ADDRESS=copilot.example.com` và `ACME_EMAIL`, rồi `docker compose -f docker-compose.prod.yml --env-file .env.prod up -d web`.
