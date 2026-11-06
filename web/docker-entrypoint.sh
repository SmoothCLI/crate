#!/bin/sh
# Runs the server as PUID:PGID (default 1000:1000) so files written into the
# music library are owned by the same user as the rest of that folder, and so
# the script's state/index inside /app/data stays reproducible across rebuilds.
set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
# Defaults so `docker run` works without the image's environment as well.
AUDIODL_DATA="${AUDIODL_DATA:-/app/data}"
MUSIC_DIR="${MUSIC_DIR:-/media/music}"
HOME="${HOME:-/app/data/home}"
export AUDIODL_DATA MUSIC_DIR HOME

mkdir -p "${AUDIODL_DATA}" "${HOME}"

start() {
  exec node /app/web/server/index.mjs
}

if [ "$(id -u)" != "0" ]; then
  # Already unprivileged (compose `user:`); nothing to drop.
  start
fi

if ! getent group "${PGID}" >/dev/null 2>&1; then
  groupadd -g "${PGID}" audiodl
fi
if ! getent passwd "${PUID}" >/dev/null 2>&1; then
  useradd -u "${PUID}" -g "${PGID}" -M -d "${HOME}" -s /usr/sbin/nologin audiodl
fi

# Only re-own the data tree when it was created by someone else (first start, or
# a previous run with a different PUID) - this is a real directory walk.
if [ "$(stat -c '%u:%g' "${AUDIODL_DATA}" 2>/dev/null)" != "${PUID}:${PGID}" ]; then
  chown -R "${PUID}:${PGID}" "${AUDIODL_DATA}" 2>/dev/null || true
fi

# Docker creates a missing bind-mount source as root; an empty library folder is
# almost certainly that case. A populated one is left untouched.
if [ -d "${MUSIC_DIR}" ] && [ -z "$(ls -A "${MUSIC_DIR}" 2>/dev/null)" ]; then
  chown "${PUID}:${PGID}" "${MUSIC_DIR}" 2>/dev/null || true
fi
if [ -d "${MUSIC_DIR}" ] && ! gosu "${PUID}:${PGID}" test -w "${MUSIC_DIR}" 2>/dev/null; then
  echo "[audiodl] warning: ${MUSIC_DIR} is not writable by ${PUID}:${PGID}." >&2
  echo "[audiodl] set PUID/PGID to the owner of that folder, or fix its permissions." >&2
fi

exec gosu "${PUID}:${PGID}" node /app/web/server/index.mjs
