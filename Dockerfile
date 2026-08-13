# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1 — build the React SPA
# ---------------------------------------------------------------------------
FROM oven/bun:1.3-debian AS web-build

WORKDIR /app
COPY package.json bun.lock* ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN bun install --frozen-lockfile || bun install

COPY web ./web
RUN bun run --cwd web build

# ---------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------
FROM oven/bun:1.3-debian AS runtime

# ffmpeg drives every video and audio operation; fontconfig lets the subtitle
# renderer resolve the bundled TTF/TTC files. ca-certificates is needed for the
# provider HTTPS calls.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        fontconfig \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    LISTEN_HOST=0.0.0.0 \
    LISTEN_PORT=8080 \
    WEB_DIST=/app/web/dist

WORKDIR /app

COPY package.json bun.lock* ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN bun install --frozen-lockfile --production || bun install --production

COPY server ./server
COPY resource ./resource
COPY --from=web-build /app/web/dist ./web/dist

# Task output, downloaded materials, uploaded assets. Mount a volume here to
# keep generated videos across container rebuilds.
RUN mkdir -p /app/storage/tasks /app/storage/cache_videos /app/storage/local_videos /app/storage/bgm

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD bun -e "fetch('http://127.0.0.1:'+(process.env.LISTEN_PORT||8080)+'/api/v1/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "server/src/index.ts"]
