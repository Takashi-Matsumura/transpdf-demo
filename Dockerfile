# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS builder
WORKDIR /app

# postinstall (scripts/copy-pdfjs-assets.mjs) がこの時点で存在している必要があるため、
# 依存関係のインストール前に package.json と scripts/ だけ先にコピーする。
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci

COPY . .
RUN npm run build

# ---- runtime image ----
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# output: "standalone" が生成する最小構成一式。public/ と .next/static は
# standalone サーバーが自動コピーしないため、ここで明示的に持ってくる。
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

EXPOSE 3000
CMD ["node", "server.js"]
