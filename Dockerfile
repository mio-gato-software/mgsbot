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

# Create writable directories and empty runtime data files,
# owned by the unprivileged `bun` user shipped with the base image
RUN mkdir -p memory/sensory memory/episodes audios logs \
    && echo '[]' > memory/semantic.json \
    && chown -R bun:bun /app

ENV NODE_ENV=production

USER bun

CMD ["bun", "run", "index.ts"]
