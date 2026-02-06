FROM oven/bun:1 AS builder

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production=false

COPY tsconfig.json ./
COPY src/ ./src/
COPY .opencode/ ./.opencode/

RUN bunx tsc --noEmit

FROM oven/bun:1-slim

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

COPY --from=builder /app/src/ ./src/
COPY --from=builder /app/.opencode/ ./.opencode/
COPY --from=builder /app/tsconfig.json ./
COPY teams-manifest/ ./teams-manifest/

ENV NODE_ENV=production
ENV TEAMS_BOT_PORT=3978

EXPOSE 3978

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3978/api/health || exit 1

CMD ["bun", "run", "src/teams/index.ts"]
