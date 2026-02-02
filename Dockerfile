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

# Create writable directories and empty runtime data files
RUN mkdir -p memory/short-term audios \
    && echo '{}' > memory/members.json \
    && echo '[]' > memory/long-term.json

ENV NODE_ENV=production

CMD ["bun", "run", "index.ts"]
