FROM oven/bun:1.4.2 AS base
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

# Verify heartbeat freshness, successful polling, and bounded active turns.
HEALTHCHECK --interval=60s --timeout=10s --retries=3 --start-period=1m \
    CMD bun -e "import { isRuntimeHealthy, HEARTBEAT_FILE } from './src/runtime-health.ts'; process.exit(isRuntimeHealthy(JSON.parse(await Bun.file(HEARTBEAT_FILE).text())) ? 0 : 1)"

CMD ["bun", "run", "index.ts"]
