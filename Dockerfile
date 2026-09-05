# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/agent-service/package.json apps/agent-service/
COPY apps/hr-mock-service/package.json apps/hr-mock-service/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/policy-docs/package.json packages/policy-docs/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
ARG VITE_AGENT_API_URL=/api/agent
ARG VITE_HR_API_URL=/api/hr
ENV VITE_AGENT_API_URL=$VITE_AGENT_API_URL
ENV VITE_HR_API_URL=$VITE_HR_API_URL
RUN pnpm --filter @msb/shared build \
 && pnpm --filter @msb/policy-docs build \
 && pnpm --filter @msb/hr-mock-service build \
 && pnpm --filter @msb/agent-service build \
 && pnpm --filter @msb/web build

FROM node:22-bookworm-slim AS node
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app

FROM caddy:2.9-alpine AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /srv
