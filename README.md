# MSB HR Copilot

Hệ thống AI Agent thực thi nghiệp vụ nhân sự nội bộ (nghỉ phép, công tác). Hackathon MSB 2026.

## Kiến trúc

- `apps/web` — React, chat + tab kết quả
- `apps/agent-service` — NestJS tool-calling agent, guardrails, HITL, policy RAG (Qdrant)
- `apps/hr-mock-service` — NestJS + MongoDB, CRUD giả lập HR (+ validate đơn)
- `packages/policy-docs` — file quy định (`policies/*.md`) + số liệu / validate helpers
- MongoDB — HR data + conversation checkpoint
- **Qdrant** — vector DB cho tra cứu policy (semantic RAG)

LLM + chat: GreenNode MaaS (OpenAI-compatible). Bắt buộc `LLM_API_KEY` trong `.env`.
Embedding (RAG): model local `Xenova/multilingual-e5-small` (GreenNode hiện chỉ có chat model).

### Policy RAG

1. Thêm/sửa file trong `packages/policy-docs/policies/*.md`
2. Chạy `pnpm policy:ingest` (embed local + ghi Qdrant; **không** có job định kỳ)
3. Agent gọi tool `search_policy` → query Qdrant → cite nguồn

Validate tạo đơn vẫn ở HRIS / rules — tách khỏi RAG.

## Chạy local

```bash
docker compose up -d          # mongo + qdrant
cp .env.example .env          # điền LLM_API_KEY
pnpm install
pnpm --filter @msb/shared --filter @msb/policy-docs build
pnpm --filter @msb/hr-mock-service seed
pnpm policy:ingest            # index policy vào Qdrant (cần API key)
pnpm dev
```

- UI: http://localhost:5173
- Agent: http://localhost:3001
- HR Mock: http://localhost:3002
- Qdrant: http://localhost:6333/dashboard

Tài khoản demo (mật khẩu `password123`):

| Role | Email | Ghi chú |
|---|---|---|
| STAFF | a.nguyen@msb.vn | Team Trần Thị B |
| STAFF | c.le@msb.vn | Team Trần Thị B |
| MANAGER | b.tran@msb.vn | Duyệt đơn team |

Hoặc dùng tab **Đăng ký** trên màn login để tạo user mới (tự cấp `EMPxxx`).

Gắn GreenNode: điền `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` trong `.env`. Embedding RAG dùng model local (xem `EMBEDDING_MODEL`).

## Kết nối Jira qua Atlassian Rovo MCP

M-Mate hỗ trợ thống kê task cần làm/đang làm/đã làm, liệt kê theo project hoặc sprint, phát hiện task quá hạn/stale, phân tích backlog và tạo Jira task sau khi user xác nhận. Dữ liệu cá nhân và assignee của task mới được map theo email tài khoản M-Connect; chỉ role `MANAGER` được phân tích toàn project.

Endpoint mặc định: `https://mcp.atlassian.com/v2/mcp?tools=all`.

Personal API token (Basic auth):

```dotenv
JIRA_MCP_AUTH_TYPE=basic
JIRA_MCP_EMAIL=your.email@msb.com.vn
JIRA_MCP_API_TOKEN=<atlassian-personal-api-token>
JIRA_MCP_CLOUD_ID=<optional-cloud-id>
JIRA_BASE_URL=https://your-domain.atlassian.net
JIRA_MCP_ASSIGNEE_MODE=actor-email
```

Hoặc service account API key:

```dotenv
JIRA_MCP_AUTH_TYPE=bearer
JIRA_MCP_API_KEY=<service-account-api-key>
```

Credential cần quyền Read/Search; để tạo task cần thêm quyền Write và tool `createJiraIssue`. Organization admin phải bật API-token authentication cho Rovo MCP. Sau khi cập nhật `.env`, restart `agent-service`.

Ví dụ chat:

- `Thống kê task Jira tôi cần làm, đang làm và đã làm`
- `Liệt kê task chưa xong trong sprint hiện tại`
- `Phân tích backlog Jira của tôi`
- `Tạo task Jira trong project SCRUM, tiêu đề Chuẩn hóa API contract, priority High, hạn 2026-09-15`
- Với quản lý: `Phân tích backlog project MCONNECT`

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
pnpm prod:policy-ingest   # hoặc: docker compose ... --profile policy-ingest run --rm policy-ingest
```

5. Mở `http://<IP-public>`. Demo: `b.tran@msb.vn` / `password123`.

**Domain + HTTPS:** trỏ A record về IP VM, sửa `SITE_ADDRESS=copilot.example.com` và `ACME_EMAIL`, rồi `docker compose -f docker-compose.prod.yml --env-file .env.prod up -d web`.

**Đổi policy:** sửa `packages/policy-docs/policies/*.md`, rebuild image (hoặc mount), rồi `pnpm prod:policy-ingest`.
