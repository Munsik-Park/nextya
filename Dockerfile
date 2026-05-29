# ── builder: TypeScript 컴파일 ──────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── deps: 프로덕션 의존성 설치 (better-sqlite3 네이티브 빌드) ──
# 빌드 도구는 이 스테이지에만 두고 최종 이미지에는 넣지 않는다.
FROM node:20-alpine AS deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ── runner: 슬림 런타임 (빌드 도구 없음 + non-root) ──────────
FROM node:20-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
# data 디렉터리를 node 유저 소유로 만들어 둔다 (named volume 첫 마운트 시 소유권 상속).
RUN mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s \
  CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node", "dist/index.js"]
