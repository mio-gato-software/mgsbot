FROM oven/bun:1.3 AS base
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Production image
FROM base AS runner

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json index.ts ./
COPY src/ ./src/
COPY memory/permanent.md ./memory/permanent.md
COPY memory/members.json ./memory/members.json

# Create writable directories for runtime data
RUN mkdir -p memory/short-term audios

ENV NODE_ENV=production

CMD ["bun", "run", "index.ts"]
