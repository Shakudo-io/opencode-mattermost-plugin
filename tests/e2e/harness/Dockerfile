FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json bun.lock* ./

RUN bun install --frozen-lockfile 2>/dev/null || bun install

COPY index.ts ./

CMD ["bun", "run", "index.ts"]
