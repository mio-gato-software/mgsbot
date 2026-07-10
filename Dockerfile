FROM oven/bun:1.3.14 AS base
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

# The bot touches /tmp/mgsbot-heartbeat every 30s while its event loop is
# alive; consider it unhealthy if the file goes stale for >2 minutes.
HEALTHCHECK --interval=60s --timeout=10s --retries=3 --start-period=1m \
    CMD bun -e "const t = Number(await Bun.file('/tmp/mgsbot-heartbeat').text()); process.exit(Date.now() - t < 120_000 ? 0 : 1)"

CMD ["bun", "run", "index.ts"]
