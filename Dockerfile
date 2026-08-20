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

# Filled in by BuildKit: "amd64" or "arm64". Chrome is provisioned differently
# on each — see the browser step below.
ARG TARGETARCH

# ffmpeg drives every video and audio operation; fontconfig lets the subtitle
# renderer resolve the bundled TTF/TTC files. ca-certificates is needed for the
# provider HTTPS calls, curl fetches the NodeSource signing key. unzip is not
# optional: it is what HyperFrames shells out to in order to unpack the Chrome
# build it downloads, and `doctor` reports "Archive extractor: Not found"
# without it.
#
# The rest of this layer is HyperFrames. Its CLI is Node, not Bun, and requires
# Node >= 22, so NodeSource's apt repo supplies a real node alongside bun. The
# lib* packages are what a headless Chrome dynamically links against.
#
# Package names are pinned to what actually resolves on this base image, which
# is Debian 13 (trixie): four of Chrome's dependencies were renamed by the
# 64-bit time_t transition and exist ONLY as *t64 here — libatk-bridge2.0-0,
# libatk1.0-0, libcups2 and libasound2 all have "Candidate: (none)" under their
# old names. Verified with apt-cache policy against the base image.
#
# Fonts: Debian's fonts-noto-core carries Latin as well as the non-Latin
# scripts (verified: NotoSans-Regular.ttf answers a :charset=41 query), unlike
# upstream Noto's `hinted/` builds, which ship no Latin at all. Book text in any
# script therefore renders in Chrome instead of coming out as tofu.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ffmpeg \
        fontconfig \
        ca-certificates \
        curl \
        unzip; \
    install -d -m 0755 /etc/apt/keyrings; \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        -o /etc/apt/keyrings/nodesource.asc; \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.asc] https://deb.nodesource.com/node_22.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        nodejs \
        libnss3 \
        libatk-bridge2.0-0t64 \
        libatk1.0-0t64 \
        libcups2t64 \
        libdrm2 \
        libxkbcommon0 \
        libxcomposite1 \
        libxdamage1 \
        libxfixes3 \
        libxrandr2 \
        libgbm1 \
        libasound2t64 \
        libpango-1.0-0 \
        libpangocairo-1.0-0 \
        libcairo2 \
        libxshmfence1 \
        fonts-noto-core \
        fonts-noto-cjk \
        fonts-noto-color-emoji; \
    fc-cache -f; \
    node --version; \
    rm -rf /var/lib/apt/lists/*

# HOME is stated outright because the Chrome download lands in
# $HOME/.cache/hyperframes/chrome and is warmed at build time: if HOME differed
# between build and run, the running container would look for the browser
# somewhere the image never put one. The font cache is pinned to an explicit
# path for the same reason, and out of $HOME so it survives a user change.
ENV NODE_ENV=production \
    LISTEN_HOST=0.0.0.0 \
    LISTEN_PORT=8080 \
    WEB_DIST=/app/web/dist \
    HOME=/root \
    HYPERFRAMES_FONT_CACHE_DIR=/opt/hyperframes/font-cache

WORKDIR /app

COPY package.json bun.lock* ./
COPY server/package.json ./server/
COPY web/package.json ./web/
# The recovery path drops --production before it retries, and it has to: in bun
# 1.3.14 `--production` turns the frozen lockfile ON by itself, with no CLI flag
# and no BUN_CONFIG_FROZEN_LOCKFILE opt-out, so the obvious
# `|| bun install --production` fails with the identical "lockfile is frozen"
# error it was meant to recover from. A plain `bun install` refreshes the
# lockfile instead. node_modules is then wiped before the production install,
# because a second `--production` pass over an existing tree reports
# "no changes" and leaves every devDependency where it is — vite, react and
# typescript would ride into the runtime image.
#
# The fast path stays frozen and reproducible: when bun.lock is in step with
# package.json the recovery never runs. It IS currently out of step — bun.lock
# does not yet carry hyperframes — so until it is regenerated this image pins
# its transitive dependencies at build time rather than from the lockfile.
#
# The hyperframes CLI is a dependency of the server workspace, and bun links
# workspace binaries into that workspace's own node_modules/.bin — it creates no
# /app/node_modules/.bin at all. The shim puts the CLI where the task docs, the
# steps below and the renderer service all expect it.
RUN set -eux; \
    if ! bun install --frozen-lockfile --production; then \
        echo "[build] bun.lock is stale; refreshing it, then reinstalling production-only"; \
        bun install; \
        rm -rf node_modules server/node_modules web/node_modules; \
        bun install --production; \
    fi; \
    mkdir -p node_modules/.bin; \
    ln -sf /app/server/node_modules/.bin/hyperframes node_modules/.bin/hyperframes; \
    test -x node_modules/.bin/hyperframes

ENV PATH="/app/node_modules/.bin:${PATH}"

# Resolve Chrome at BUILD time so no render ever downloads a browser.
#
# On amd64 that is `browser ensure`, which fetches the chrome-headless-shell
# build HyperFrames pins. The pin exists because rendered pixels drift between
# Chrome versions, and two segments of one book must not be rendered by two
# different browsers.
#
# arm64 has no such build to fetch: Chrome for Testing publishes linux64 only
# (mac-arm64 and win aside), and `browser ensure` exits 1 there with "Chrome
# Headless Shell is not available for Linux ARM64" — confirmed by running it.
# Debian's chromium stands in on that arch, which costs the version pin, so
# treat arm64 as a development convenience and render releases on amd64.
#
# Both arches end up symlinked to one stable path, so a single env var points
# the CLI at the browser regardless of how it got there.
RUN set -eux; \
    mkdir -p /opt/hyperframes; \
    if [ "${TARGETARCH}" = "arm64" ]; then \
        apt-get update; \
        apt-get install -y --no-install-recommends chromium; \
        rm -rf /var/lib/apt/lists/*; \
        ln -sf /usr/bin/chromium /opt/hyperframes/chrome; \
    else \
        HYPERFRAMES_SKIP_SKILLS=1 HYPERFRAMES_NO_UPDATE_CHECK=1 \
            node_modules/.bin/hyperframes browser ensure; \
        chrome="$(HYPERFRAMES_SKIP_SKILLS=1 node_modules/.bin/hyperframes browser path | tr -d '\r' | tail -n 1)"; \
        test -x "$chrome"; \
        ln -sf "$chrome" /opt/hyperframes/chrome; \
    fi; \
    test -x /opt/hyperframes/chrome; \
    /opt/hyperframes/chrome --version

ENV HYPERFRAMES_BROWSER_PATH=/opt/hyperframes/chrome

COPY server ./server
COPY resource ./resource
COPY --from=web-build /app/web/dist ./web/dist

# Warm the font cache at BUILD time, which has to happen after `COPY resource`
# because it renders one of the templates that COPY brings in.
#
# The compiler pulls font faces from Google Fonts while compiling a composition
# and caches them under HYPERFRAMES_FONT_CACHE_DIR; classic/card sets EB
# Garamond and Inter. Left cold, a sealed container either stalls on that fetch
# mid-render or silently substitutes a different face — and a silent substitution
# is the worse outcome, because the segments of one book would stop matching each
# other. `check` compiles the composition and boots Chrome, so one invocation
# warms the cache and proves the browser wiring.
#
# HYPERFRAMES_SKIP_SKILLS keeps the CLI from reaching for the skills registry.
#
# The build gates on the cache, not on check's exit code: a lint regression in a
# template is a template defect and should fail T1's tests, not make the image
# unbuildable. An empty font cache does fail the build, because that is this
# step's entire job.
RUN set -eux; \
    export HYPERFRAMES_SKIP_SKILLS=1 HYPERFRAMES_NO_UPDATE_CHECK=1 HYPERFRAMES_NO_TELEMETRY=1; \
    test -x node_modules/.bin/hyperframes; \
    if node_modules/.bin/hyperframes check resource/hyperframes/classic/card; then \
        echo "[build] hyperframes check: clean"; \
    else \
        echo "[build] hyperframes check reported findings; continuing — the font cache is the gate"; \
    fi; \
    rm -rf resource/hyperframes/classic/card/.hyperframes \
           resource/hyperframes/classic/card/out \
           resource/hyperframes/classic/card/snapshots; \
    echo "[build] warmed font cache:"; \
    find "${HYPERFRAMES_FONT_CACHE_DIR}" -type f | sort; \
    test -n "$(find "${HYPERFRAMES_FONT_CACHE_DIR}" -type f -print -quit)"

# Task output, downloaded materials, uploaded assets. Mount a volume here to
# keep generated videos across container rebuilds.
RUN mkdir -p /app/storage/tasks /app/storage/cache_videos /app/storage/local_videos /app/storage/bgm

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD bun -e "fetch('http://127.0.0.1:'+(process.env.LISTEN_PORT||8080)+'/api/v1/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "server/src/index.ts"]
