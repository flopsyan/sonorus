# ---- Build stage: install dependencies (better-sqlite3 is compiled here) ----
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Build tools for the native better-sqlite3 extension
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- Runtime stage: slim image without build tools ----
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data \
    TRANSCODE_DIR=/app/transcodes \
    MUSIC_DIR=/music \
    SITE_NAME=Sonorus

WORKDIR /app

# ffmpeg, for the smaller streaming quality. `--no-install-recommends` is what
# keeps this to the audio side of it: the full recommendation set pulls in the
# X11 and video stack, several hundred megabytes of it, none of which decodes a
# FLAC or encodes an Opus. Without ffmpeg the app still runs - it then serves the
# original files and says so under Einstellungen.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# Take the compiled dependencies from the build stage
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY views ./views
COPY public ./public

# Create the data directory (SQLite DB + extracted covers) and hand ownership
# to the non-root user. The music folder is mounted read-only at /music.
#
# The transcodes are a volume of their own on purpose. They grow with the size of
# the library rather than with the number of rows, they are worth nothing in a
# backup - every one of them can be made again from its source - and a backup of
# the database should not have to carry tens of gigabytes of them.
RUN mkdir -p /app/data/covers /app/transcodes && chown -R node:node /app
USER node

EXPOSE 3000
VOLUME ["/app/data", "/app/transcodes"]

# Healthcheck via the fetch API built into Node 22
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
