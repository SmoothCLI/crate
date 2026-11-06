# syntax=docker/dockerfile:1

# ---------------------------------------------------------------- UI build ---
FROM node:25-bookworm-slim AS ui

WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY web/ ./
# Ship the built assets and production dependencies only (express).
RUN npm run build \
 && npm prune --omit=dev --no-audit --no-fund

# ----------------------------------------------------------------- runtime ---
FROM node:25-bookworm-slim

# ffmpeg/ffprobe do the encoding, jq is required by the script's --json mode
# (which the server drives), python3 runs the yt-dlp release binary and, with
# mutagen, writes Opus tags and cover art, fpcalc (chromaprint) fingerprints the
# library so the same recording under two names can be found, gosu drops root so
# files land as the host user, tini reaps the script's child processes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      ffmpeg \
      file \
      gosu \
      jq \
      libchromaprint-tools \
      python3 \
      python3-mutagen \
      tini \
 && rm -rf /var/lib/apt/lists/* \
 && fpcalc -version

# Debian's yt-dlp is far too old for music sites; take the latest release.
RUN curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" \
      -o /usr/local/bin/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp \
 && yt-dlp --version

WORKDIR /app

COPY dlAudio.sh /app/dlAudio.sh
COPY web/package.json web/package-lock.json /app/web/
COPY web/server /app/web/server
COPY --from=ui /app/web/dist /app/web/dist
COPY --from=ui /app/web/node_modules /app/web/node_modules
COPY web/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /app/dlAudio.sh /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
    AUDIODL_BIN=/app/dlAudio.sh \
    AUDIODL_HOST=0.0.0.0 \
    AUDIODL_PORT=8080 \
    AUDIODL_DATA=/app/data \
    MUSIC_DIR=/media/music \
    HOME=/app/data/home

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/api/me >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
