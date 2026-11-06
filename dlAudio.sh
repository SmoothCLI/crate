#!/usr/bin/env bash
#
# audioDL3 - modular audio downloader
# yt-dlp + ffmpeg (+ optional: jq, gum, fzf, magick/convert, timg/chafa, curl, file)
#
# Downloads a track (or a whole playlist), loudness-normalises it to a target
# LUFS (two-pass loudnorm when jq is available, one-pass otherwise), checks the
# track against MusicBrainz (optional, see MUSICBRAINZ.md), embeds tags and
# cover art, and keeps a resumable session so a crash or a Ctrl-C never loses
# work. The container is m4a, mp3, flac or wav (OUTPUT_FORMAT). Playlist
# re-runs skip entries already in the library (tracked by extractor id in the
# import index) unless --force is given, and --jobs N fetches several of them at
# once. With --stream-fd N the encoded audio is written to descriptor N instead
# of a file, for the web UI's guest downloads.
#
# Usage:  audioDL3 [OPTIONS] URL [START] [END]
#
# shellcheck disable=SC2030,SC2031  # playlist tracks intentionally run in subshells
set -Eeuo pipefail

VERSION="3.3.1"
PROG="${0##*/}"
START_TIME=$SECONDS

# ============================================================
# Config (every value can be overridden from the environment)
# ============================================================
MUSIC_DIR="${MUSIC_DIR:-/media/music}"
TARGET_LUFS="${TARGET_LUFS:--9}"
TARGET_TP="${TARGET_TP:--1.5}"
TARGET_LRA="${TARGET_LRA:-11}"
ARTWORK_SIZE="${ARTWORK_SIZE:-1000}"
# 1-5. A VBR step for AAC/MP3, and a bitrate step for Opus.
AAC_QUALITY="${AAC_QUALITY:-2}"
# Container written to the library: m4a, mp3, opus, flac or wav.
OUTPUT_FORMAT="${OUTPUT_FORMAT:-m4a}"
# --stream-fd N: encode to a file descriptor instead of a library file.
STREAM_FD="${STREAM_FD:-0}"
AUDIO_FORMAT="${AUDIO_FORMAT:-bestaudio[ext=m4a]/bestaudio[acodec*=aac]/bestaudio}"
JOBS="${JOBS:-1}" # --jobs: playlist tracks fetched at the same time

# MusicBrainz enrichment (optional, see the MusicBrainz section and
# MUSICBRAINZ.md). The API is public and needs no key, but it allows one
# request per second per IP and asks for a descriptive User-Agent.
MUSICBRAINZ_LOOKUP="${MUSICBRAINZ_LOOKUP:-1}"
MUSICBRAINZ_API="${MUSICBRAINZ_API:-https://musicbrainz.org/ws/2}"
MUSICBRAINZ_USER_AGENT="${MUSICBRAINZ_USER_AGENT:-audioDL/$VERSION (set MUSICBRAINZ_USER_AGENT)}"
MUSICBRAINZ_CACHE_DIR="${MUSICBRAINZ_CACHE_DIR:-}" # default: state dir/musicbrainz
MUSICBRAINZ_CACHE_DAYS="${MUSICBRAINZ_CACHE_DAYS:-30}"
MUSICBRAINZ_MIN_INTERVAL="${MUSICBRAINZ_MIN_INTERVAL:-1}"
MUSICBRAINZ_TIMEOUT="${MUSICBRAINZ_TIMEOUT:-15}"
MUSICBRAINZ_CONNECT_TIMEOUT="${MUSICBRAINZ_CONNECT_TIMEOUT:-5}"
MUSICBRAINZ_RETRIES="${MUSICBRAINZ_RETRIES:-3}"
MUSICBRAINZ_MAX_WAIT="${MUSICBRAINZ_MAX_WAIT:-30}"
# MUSICBRAINZ_LOOKUP=0|no|off|false turns the lookup off like --no-mb does.
case "${MUSICBRAINZ_LOOKUP:-1}" in
0 | no | off | false | [Nn][Oo]) MUSICBRAINZ_LOOKUP=0 ;;
*) MUSICBRAINZ_LOOKUP=1 ;;
esac

# Centralised FFmpeg commands. -nostdin stops ffmpeg from swallowing terminal
# input (fatal inside playlist loops); -hide_banner keeps logs readable.
FFMPEG=(ffmpeg -hide_banner -nostdin -loglevel error)
FFMPEG_ANALYZE=(ffmpeg -hide_banner -nostdin -loglevel info)

# ============================================================
# Runtime flags
# ============================================================
AUTO=0             # --yes: never prompt, accept defaults
FORCE=0            # --force: overwrite without asking
KEEP_TEMP=0        # --keep: keep the session workspace on success
NO_ART=0           # --no-art: skip cover art
NO_LYRICS=0        # --no-lyrics: do not look for lyrics
ONE_PASS=0         # --one-pass: skip the loudnorm analysis pass
SELECT_ALL=0       # --all: take every playlist entry
FIRST_ONLY=0       # --first: take only the first playlist entry
TRACK_SPEC=""      # --tracks: explicit playlist entries, e.g. 1-3,7
ALBUM_OVERRIDE=""  # --album: tag every track with this album
ARTIST_OVERRIDE="" # --artist: tag every track with this artist
GENRE_OVERRIDE=""  # --genre: tag every track with this genre
BATCH_MEMO=""      # playlist album remembered from an earlier track
TRACK_PREFIX=0     # prefix filenames with the track number
TRACK_PREFIX_SET=0
VERBOSE=0 # --verbose: show the underlying tool output
NO_SPINNER=0
NO_LOCK=0          # --no-lock: caller serialises runs itself (web queue)
MB_ENABLED="${MUSICBRAINZ_LOOKUP:-1}" # --no-mb: keep only the source metadata
MB_REFRESH=0       # --mb-refresh: ignore the cached MusicBrainz response
MB_REPORT_FILE=""  # --mb-report: write the per-track outcome to this file
RG_ENABLED=1       # --no-replaygain: no ReplayGain tags
# REPLAYGAIN=0|no|off|false turns them off like --no-replaygain does.
case "${REPLAYGAIN:-1}" in
0 | no | off | false | [Nn][Oo]) RG_ENABLED=0 ;;
esac
COOKIES_FILE="${AUDIODL_COOKIES:-}" # --cookies: a Netscape cookie jar for yt-dlp

# Machine interface (used by the web UI)
JSON=0             # --json: NDJSON events on stdout, human output on stderr
INSPECT_ONLY=0     # --inspect: probe + metadata, then exit
PLAN_ONLY=0        # --plan: resolve paths/conflicts, never download
META_JSON=""       # --meta-json: per-entry metadata overrides (JSON file)
TITLE_OVERRIDE=""  # --title: override the track title
TRACK_OVERRIDE=""  # --track: override the track number
DATE_OVERRIDE=""   # --date: override the recording date
ART_OVERRIDE=""    # --art-url: use this cover art URL
SESSION_DIR_ARG="" # --session-dir: workspace for this job
CUR_I=0            # current track index for JSON events
DRY_RUN=0          # --inspect/--plan: resolve paths but never touch the library

# ============================================================
# Colors / UI helpers
# ============================================================
CYAN=$'\033[1;36m'
BLUE=$'\033[1;34m'
GREEN=$'\033[1;32m'
YELLOW=$'\033[1;33m'
RED=$'\033[1;31m'
RESET=$'\033[0m'
BOLD=$'\033[1m'

HAVE_GUM=0 HAVE_JQ=0 HAVE_FZF=0 HAVE_FILE=0 HAVE_CURL=0
HAVE_IM=0 HAVE_PREVIEW=0 IM_CMD=""
SEP=$'\x1f'

info() {
  if [ "$JSON" -eq 1 ]; then
    # printf would read a leading "->" as an option, hence the format indirection.
    printf '%s\n' "-> $1" >&2
    return 0
  fi
  if [ "$HAVE_GUM" -eq 1 ] && [ -t 1 ]; then
    # `--` keeps the leading "->" from being parsed as a flag.
    gum style --foreground 4 -- "-> $1"
  else
    printf '%s%s\n' "${BLUE}->${RESET} " "$1"
  fi
}

success() {
  if [ "$JSON" -eq 1 ]; then
    printf '[ok] %s\n' "$1" >&2
    return 0
  fi
  if [ "$HAVE_GUM" -eq 1 ] && [ -t 1 ]; then
    gum style --foreground 2 -- "[ok] $1"
  else
    printf '%s%s\n' "${GREEN}[ok]${RESET} " "$1"
  fi
}

warning() {
  if [ "$JSON" -eq 1 ]; then
    printf '[!] %s\n' "$1" >&2
    return 0
  fi
  if [ "$HAVE_GUM" -eq 1 ] && [ -t 1 ]; then
    gum style --foreground 3 -- "[!] $1" >&2
  else
    printf '%s%s\n' "${YELLOW}[!]${RESET} " "$1" >&2
  fi
}

error() {
  if [ "$JSON" -eq 1 ]; then
    printf '[x] %s\n' "$1" >&2
    return 0
  fi
  if [ "$HAVE_GUM" -eq 1 ] && [ -t 1 ]; then
    gum style --foreground 1 -- "[x] $1" >&2
  else
    printf '%s%s\n' "${RED}[x]${RESET} " "$1" >&2
  fi
}

section() {
  if [ "$JSON" -eq 1 ]; then
    printf '== %s ==\n' "$1" >&2
    return 0
  fi
  if [ "$HAVE_GUM" -eq 1 ] && [ -t 1 ]; then
    gum style --border double --padding "0 1" --bold -- "$1"
  else
    local line="${CYAN}${BOLD}==============================================================${RESET}"
    printf '%s\n' "$line"
    printf '%s\n' "${CYAN}${BOLD} $1${RESET}"
    printf '%s\n' "$line"
  fi
}

print_kv() {
  if [ "$JSON" -eq 1 ]; then
    printf '  %-12s %s\n' "$1" "$2" >&2
  else
    printf '  %-12s %s\n' "$1" "$2"
  fi
}

print_label() {
  if [ "$JSON" -eq 1 ]; then
    printf '  %-6s : %s\n' "$1" "$2" >&2
  else
    printf '  %-6s : %s\n' "$1" "$2"
  fi
}

die() {
  error "$1"
  json_emit error message="$1" code#="${2:-1}"
  exit "${2:-1}"
}

# ============================================================
# Machine-readable events (--json)
#
# One compact JSON object per line on stdout. Numeric fields are written as
# key#=value so they land as numbers, everything else as strings.
# ============================================================
json_emit() {
  [ "$JSON" -eq 1 ] || return 0
  local ev="$1"
  shift
  local -a args=(--arg event "$ev")
  local kv k v
  for kv in "$@"; do
    [ -n "$kv" ] || continue
    k="${kv%%=*}"
    v="${kv#*=}"
    if [ "${k%#}" != "$k" ]; then
      k="${k%#}"
      case "$v" in
      '' | *[!0-9-]*) v=0 ;;
      esac
      args+=(--argjson "$k" "$v")
    else
      args+=(--arg "$k" "$v")
    fi
  done
  jq -cn "${args[@]}" '{v:1, event:$event} + ($ARGS.named | del(.event))' 2>/dev/null || true
}

# meta_value KEY -> per-entry override from --meta-json (empty when unset)
# The file is keyed by 1-based entry number, e.g. {"3":{"title":"X"}}.
meta_value() {
  [ -n "${META_JSON:-}" ] || return 0
  local key="$1" idx="${ENTRY_NUM:-1}" v=""
  v="$(jq -r --arg i "$idx" --arg k "$key" '.[$i][$k] // empty' "$META_JSON" 2>/dev/null || true)"
  [ "$v" = "null" ] && v=""
  printf '%s' "$v"
}

# ============================================================
# Small reusable helpers
# ============================================================

# fallback "value" "default"
fallback() {
  local v="${1:-}" d="$2"
  if [ -z "$v" ] || [ "$v" = "NA" ] || [ "$v" = "None" ] || [ "$v" = "null" ]; then
    printf '%s' "$d"
  else
    printf '%s' "$v"
  fi
}

is_num() {
  [[ "${1:-}" =~ ^-?[0-9]+(\.[0-9]+)?$ ]]
}

is_int() {
  [[ "${1:-}" =~ ^[0-9]+$ ]]
}

# in_range value min max -> 0 when the (numeric) value lies within [min, max]
in_range() {
  awk -v v="$1" -v lo="$2" -v hi="$3" 'BEGIN { exit !(v + 0 >= lo + 0 && v + 0 <= hi + 0) }'
}

# confirm "Prompt" ["default: Y|N"] -> 0 = yes, 1 = no
confirm() {
  local prompt="$1" default="${2:-Y}" ans flag

  if [ "$AUTO" -eq 1 ]; then
    return 0
  fi

  if [ "$HAVE_GUM" -eq 1 ]; then
    flag="--default=true"
    [ "$default" = "N" ] && flag="--default=false"
    if gum confirm "$flag" "$prompt"; then
      return 0
    fi
    return 1
  fi

  read -rp "$prompt " ans || ans=""
  ans="${ans:-$default}"
  case "$ans" in
  [Yy]*) return 0 ;;
  *) return 1 ;;
  esac
}

# prompt_default "Label" "default"  (shows [default] only when non-empty)
prompt_default() {
  local label="$1" default="${2:-}" ans

  if [ "$AUTO" -eq 1 ]; then
    printf '%s' "$default"
    return 0
  fi

  if [ "$HAVE_GUM" -eq 1 ]; then
    if [ -n "$default" ]; then
      ans="$(gum input --prompt "$label [$default]: " --value "$default")" || ans=""
    else
      ans="$(gum input --prompt "$label: ")" || ans=""
    fi
  else
    if [ -n "$default" ]; then
      read -rp "$label [$default]: " ans || ans=""
    else
      read -rp "$label: " ans || ans=""
    fi
  fi

  printf '%s' "${ans:-$default}"
}

# Run a command with its output captured to a log, behind a spinner when possible.
# Never hides the reason for a failure: the log tail is printed on error.
run_logged() {
  local title="$1" log="$2"
  shift 2

  : >"$log"

  if [ "$VERBOSE" -eq 1 ]; then
    info "$title"
    "$@"
    return $?
  fi

  if [ "$HAVE_GUM" -eq 1 ] && [ -t 1 ] && [ "$NO_SPINNER" -eq 0 ]; then
    # shellcheck disable=SC2016
    if gum spin --title "$title" -- \
      "${BASH:-bash}" -c 'log=$1; shift; exec "$@" >"$log" 2>&1' _ "$log" "$@"; then
      return 0
    fi
    show_log_tail "$log"
    return 1
  fi

  info "$title"
  if ! "$@" >"$log" 2>&1; then
    show_log_tail "$log"
    return 1
  fi
  return 0
}

# ============================================================
# Progress reporting
#
# Both tools already know how far along they are: yt-dlp prints
# "[download]  45.2% of 3.7MiB at 1.2MiB/s ETA 00:03" and ffmpeg can stream
# out_time_ms/speed via -progress. The parsers below turn that into one short
# status fragment; run_with_progress rewrites a single line with it.
# ============================================================

progress_from_ytdlp() {
  local f="$1" line=""
  [ -s "$f" ] || return 0
  line="$(tail -c 4000 "$f" 2>/dev/null | tr '\r' '\n' |
    grep -E '^\[download\][[:space:]]+[0-9]+(\.[0-9]+)?%' | tail -n 1 || true)"
  [ -n "$line" ] || return 0
  line="${line#\[download\]}"
  line="${line#"${line%%[![:space:]]*}"}"
  printf '%s' "$line"
}

pct_from_ytdlp() {
  local f="$1" line="" p=""
  [ -s "$f" ] || return 0
  line="$(tail -c 4000 "$f" 2>/dev/null | tr '\r' '\n' |
    grep -E '^\[download\][[:space:]]+[0-9]+(\.[0-9]+)?%' | tail -n 1 || true)"
  [ -n "$line" ] || return 0
  p="$(printf '%s' "$line" | grep -oE '[0-9]+(\.[0-9]+)?%' | head -n 1 | tr -d '%')"
  [ -n "$p" ] || return 0
  printf '%d' "${p%%.*}"
}

# Progress percentage from ffmpeg's out_time_ms, relative to the source length.
ffmpeg_progress_pct() {
  local f="$1" t=""
  [ -s "$f" ] || return 0
  t="$(tail -c 4000 "$f" 2>/dev/null | tr '\r' '\n' |
    grep '^out_time_ms=' | tail -n 1 | cut -d= -f2 || true)"
  is_int "$t" || return 0
  is_num "${SOURCE_DURATION:-}" || return 0
  [ "${SOURCE_DURATION%.*}" -gt 0 ] 2>/dev/null || return 0
  awk -v s=$((t / 1000000)) -v d="$SOURCE_DURATION" 'BEGIN {
    p = 100 * s / d;
    if (p > 100) p = 100;
    printf "%d", p
  }'
}

pct_from_ffmpeg() {
  ffmpeg_progress_pct "$1"
}

# Percentage/time from ffmpeg's -progress stream, relative to SOURCE_DURATION.
progress_from_ffmpeg() {
  local f="$1" t="" spd="" secs pct out=""
  [ -s "$f" ] || return 0
  t="$(tail -c 4000 "$f" 2>/dev/null | tr '\r' '\n' |
    grep '^out_time_ms=' | tail -n 1 | cut -d= -f2 || true)"
  is_int "$t" || return 0
  secs=$((t / 1000000))
  out="$(format_duration "$secs")"
  pct="$(ffmpeg_progress_pct "$f" || true)"
  if [ -n "$pct" ]; then
    out="$out / $(format_duration "${SOURCE_DURATION%.*}") ($pct%)"
  fi
  spd="$(tail -c 4000 "$f" 2>/dev/null | tr '\r' '\n' |
    grep '^speed=' | tail -n 1 | cut -d= -f2 || true)"
  if [ -n "$spd" ] && [ "$spd" != "N/A" ]; then
    out="$out $spd"
  fi
  printf '%s' "$out"
}

render_progress() {
  local title="$1" detail="${2:-}" line width
  line="$title"
  [ -n "$detail" ] && line="$title  $detail"
  width="${COLUMNS:-80}"
  if [ "${#line}" -ge "$width" ]; then
    line="${line:0:$((width - 1))}"
  fi
  printf '\r\033[K%s %s' "${BLUE}->${RESET}" "$line"
}

clear_progress() {
  printf '\r\033[K'
}

# JSON-mode runner: no status line, only stage events with a percentage.
run_json_progress() {
  local title="$1" log="$2" tool="$3" stage="$4"
  shift 4

  : >"$log"
  rm -f "$log.done"
  local pid status=0 pct="" last_pct="" last_sec=0
  (
    status=0
    "$@" >"$log" 2>&1 || status=$?
    printf '%s' "$status" >"$log.done"
  ) &
  pid=$!

  while [ ! -s "$log.done" ]; do
    pct="$("pct_from_$tool" "$log" 2>/dev/null || true)"
    if [ -n "$pct" ] && { [ "$pct" != "$last_pct" ] || [ $((SECONDS - last_sec)) -ge 1 ]; }; then
      json_emit stage i#="${CUR_I:-0}" stage="$stage" pct#="$pct"
      last_pct="$pct"
      last_sec=$SECONDS
    fi
    sleep 0.2
  done

  wait "$pid" 2>/dev/null || true
  status="$(cat "$log.done" 2>/dev/null || printf '1')"
  is_int "$status" || status=1
  if [ "$status" -eq 0 ] && [ "$last_pct" != "100" ]; then
    json_emit stage i#="${CUR_I:-0}" stage="$stage" pct#=100
  fi
  if [ "$status" -ne 0 ]; then
    show_log_tail "$log"
    return "$status"
  fi
  return 0
}

# run_with_progress "Title" log tool stage command...
# Same contract as run_logged (output captured, tail printed on failure), but
# keeps one live status line updated from the log while the command runs.
# tool is ytdlp or ffmpeg and selects the progress parsers; in --json mode the
# percentage is emitted as stage events instead of a rewritten line.
run_with_progress() {
  local title="$1" log="$2" tool="$3" stage="$4"
  shift 4

  if [ "$JSON" -eq 1 ]; then
    run_json_progress "$title" "$log" "$tool" "$stage" "$@"
    return $?
  fi

  if [ "$VERBOSE" -eq 1 ] || [ ! -t 1 ] || [ "$NO_SPINNER" -eq 1 ]; then
    run_logged "$title" "$log" "$@"
    return $?
  fi

  : >"$log"
  rm -f "$log.done"
  local pid status=0 detail=""
  (
    status=0
    "$@" >"$log" 2>&1 || status=$?
    printf '%s' "$status" >"$log.done"
  ) &
  pid=$!

  # The .done marker is written after the child exits: polling it cannot hang
  # on an unreaped zombie the way `kill -0` can.
  while [ ! -s "$log.done" ]; do
    detail="$("progress_from_$tool" "$log" 2>/dev/null || true)"
    render_progress "$title" "$detail"
    sleep 0.2
  done

  wait "$pid" 2>/dev/null || true
  status="$(cat "$log.done" 2>/dev/null || printf '1')"
  clear_progress
  is_int "$status" || status=1
  if [ "$status" -ne 0 ]; then
    show_log_tail "$log"
    return "$status"
  fi
  return 0
}

# Run a command with live output (no capture) so progress is visible.
run_streamed() {
  local title="$1"
  shift
  info "$title"
  "$@"
}

show_log_tail() {
  local f="$1"
  [ -s "$f" ] || return 0
  printf '%s\n' "--- last lines of output ---" >&2
  # Progress output is carriage-return separated; split it so the real error
  # message is readable on its own line.
  tail -n 40 "$f" 2>/dev/null | tr '\r' '\n' | tail -n 20 >&2 || true
  printf '%s\n' "----------------------------" >&2
}

# A genre is free text (typed in the web UI or passed on the command line), so
# it is flattened into one clean line before it reaches a tag writer: control
# characters out, whitespace collapsed, and a sane length cap.
sanitize_genre() {
  local value="${1:-}"
  value="$(printf '%s' "$value" | LC_ALL=C tr -d '\000-\037')"
  value="$(printf '%s' "$value" | tr -s '[:space:]' ' ')"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  if [ "${#value}" -gt 60 ]; then
    value="${value:0:60}"
    value="${value%"${value##*[![:space:]]}"}"
  fi
  printf '%s' "$value"
}

sanitize_filename() {
  local name="$1"
  # Drop control characters (keeps UTF-8 high bytes intact).
  name="$(printf '%s' "$name" | LC_ALL=C tr -d '\000-\037')"
  name="${name//\//-}"    # /
  name="${name//\\/-}"    # backslash
  name="${name//:/-}"     # :
  name="${name//\*/-}"    # *
  name="${name//\?/-}"    # ?
  name="${name//\"/-}"    # "
  name="${name//</-}"     # <
  name="${name//>/-}"     # >
  name="${name//\|/-}"    # |
  name="${name//$'\t'/ }" # tab
  # Collapse whitespace + trim
  name="$(printf '%s' "$name" | tr -s '[:space:]' ' ')"
  name="${name#"${name%%[![:space:]]*}"}"
  name="${name%"${name##*[![:space:]]}"}"
  # Collapse runs of dashes and trim dashes/dots that upset some players.
  while [[ "$name" == *--* ]]; do name="${name//--/-}"; done
  name="${name#-}"
  name="${name%-}"
  name="${name#.}"
  name="${name%.}"
  # Keep names well under the usual 255-byte filesystem limit.
  if [ "${#name}" -gt 120 ]; then
    name="${name:0:120}"
    name="${name%"${name##*[![:space:]]}"}"
  fi
  printf '%s' "$name"
}

# One artist string, written the way the library files it: a collaboration
# keeps every name in the source's order, joined with a plain ", ". That is
# what the existing folders use, and it keeps full-width commas and their
# stray spaces out of folder names - and out of the queue label, because both
# read this same value. Trimming and de-duplication match the tag list.
artist_label() {
  local raw="${1:-}" rest name joined="" seen
  local -a parts=() names=()
  rest="${raw//；/,}"
  rest="${rest//，/,}"
  rest="${rest//、/,}"
  rest="${rest//;/,}"
  rest="${rest//　/ }"
  local IFS=','
  read -r -a parts <<<"$rest"
  for name in ${parts[@]+"${parts[@]}"}; do
    name="${name#"${name%%[![:space:]]*}"}"
    name="${name%"${name##*[![:space:]]}"}"
    [ -n "$name" ] || continue
    for seen in ${names[@]+"${names[@]}"}; do
      [ "$seen" = "$name" ] && continue 2
    done
    names+=("$name")
  done
  for name in ${names[@]+"${names[@]}"}; do
    joined="${joined:+$joined, }$name"
  done
  printf '%s' "${joined:-$raw}"
}

# The folder is named after the main - first credited - artist only. A
# collaboration belongs to its lead act in the library, while every name still
# goes into the tags and the queue label.
primary_artist() {
  local label
  label="$(artist_label "${1:-}")"
  printf '%s' "${label%%,*}"
}

parse_date() {
  local d="${1:-}" y m day
  [[ "$d" =~ ^([0-9]{4})([0-9]{2})([0-9]{2})$ ]] || return 1
  y="${BASH_REMATCH[1]}" m="${BASH_REMATCH[2]}" day="${BASH_REMATCH[3]}"
  m=$((10#$m)) day=$((10#$day))
  [ "$y" -ge 1900 ] && [ "$y" -le 2100 ] || return 1
  [ "$m" -ge 1 ] && [ "$m" -le 12 ] || return 1
  [ "$day" -ge 1 ] && [ "$day" -le 31 ] || return 1
  printf '%04d-%02d-%02d' "$y" "$m" "$day"
}

# Detect image extension by content, falling back to the URL suffix.
detect_image_ext() {
  local f="$1" url="${2:-}" mime=""
  if [ "$HAVE_FILE" -eq 1 ]; then
    mime="$(file --mime-type -b "$f" 2>/dev/null || true)"
  fi
  case "$mime" in
  image/jpeg)
    printf 'jpg'
    return 0
    ;;
  image/png)
    printf 'png'
    return 0
    ;;
  image/webp)
    printf 'webp'
    return 0
    ;;
  image/gif)
    printf 'gif'
    return 0
    ;;
  image/bmp)
    printf 'bmp'
    return 0
    ;;
  image/tiff)
    printf 'tiff'
    return 0
    ;;
  image/x-ico | image/vnd.microsoft.icon)
    printf 'ico'
    return 0
    ;;
  esac
  case "${url##*.}" in
  jpg | jpeg | JPG | JPEG)
    printf 'jpg'
    return 0
    ;;
  png | PNG)
    printf 'png'
    return 0
    ;;
  webp | WEBP)
    printf 'webp'
    return 0
    ;;
  gif | GIF)
    printf 'gif'
    return 0
    ;;
  esac
  printf '' # unknown: let the image tool sniff it
}

human_size() {
  local bytes="${1:-0}"
  awk -v b="$bytes" 'BEGIN {
                split("B KiB MiB GiB", u, " ");
                i = 1;
                while (b >= 1024 && i < 4) { b /= 1024; i++ }
                printf "%.1f %s", b, u[i]
        }'
}

format_duration() {
  local s="${1:-0}"
  if [ "$s" -ge 3600 ]; then
    printf '%d:%02d:%02d' $((s / 3600)) $((s % 3600 / 60)) $((s % 60))
  else
    printf '%02d:%02d' $((s / 60)) $((s % 60))
  fi
}

# ============================================================
# Runtime state
# ============================================================
URL="" ORIGIN_URL="" REQUESTED_URL="" START="" END=""
ARTIST="" ALBUM="" ALBUM_FALLBACK=0 ALBUM_ARTIST="" TITLE="" TRACK="" GENRE="" RECORDING_DATE_ISO=""
MB_STATUS="" MB_SCORE="" MB_NOTE="" MB_RECORDING_ID="" MB_RELEASE_ID=""
MB_RELEASE_TITLE="" MB_RELEASE_GROUP_ID="" MB_ARTIST_ID="" MB_ALBUM_ARTIST_ID=""
MB_TRACK_ID="" MB_TRACK_TOTAL="" MB_DISC_NUMBER="" MB_DISC_TOTAL="" MB_TRACK_FILLED=0
FETCHED_DATE="" RAW_THUMB="" PLAYLIST_ID="" PLAYLIST_TITLE=""
ENTRY_COUNT=0 ENTRY_NUM=""
TARGET_DIR="" FINAL_FILE="" BASENAME=""
TMP_DIR="" SESSION_DIR="" SESSION_FILE="" CHECKPOINT_FILE=""
TMP_FILE="" NORMALIZED_FILE="" FINAL_TMP="" TMP_THUMB="" WORK_DIR=""
SOURCE_SAMPLE_RATE="" SOURCE_DURATION="" TRACK_KEY="" FETCHED_DURATION=""
# Loudness of the file the encoder wrote, and its true peak in dBTP. Both come
# from the loudnorm analysis pass, which is where the ReplayGain tags come from.
RG_LOUDNESS="" RG_PEAK_DB=""
URL_IS_PLAYLIST=0
SUCCESS=0
COMPLETED=0
IN_SUBSHELL=0
LOCK_DIR=""
BATCH_DIR=""

# ============================================================
# State directory / session workspace
# ============================================================
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/audioDL"
INDEX_FILE="$STATE_DIR/index.tsv"

set_session_dir() {
  SESSION_DIR="$1"
  if ! mkdir -p "$SESSION_DIR" 2>/dev/null; then
    error "Cannot create state directory: $SESSION_DIR"
    error "Set XDG_STATE_HOME to a writable location and retry."
    return 1
  fi
  TMP_DIR="$SESSION_DIR"
  WORK_DIR="$SESSION_DIR/work"
  mkdir -p "$WORK_DIR"
  SESSION_FILE="$SESSION_DIR/session.env"
  CHECKPOINT_FILE="$SESSION_DIR/state"
}

acquire_lock() {
  local lock="$STATE_DIR/lock" other=""
  mkdir -p "$STATE_DIR" 2>/dev/null || return 0
  if mkdir "$lock" 2>/dev/null; then
    printf '%s\n' "$$" >"$lock/pid"
    LOCK_DIR="$lock"
    return 0
  fi
  if [ -f "$lock/pid" ]; then
    other="$(cat "$lock/pid" 2>/dev/null || true)"
  fi
  if is_int "$other" && kill -0 "$other" 2>/dev/null; then
    error "Another $PROG instance is already running (pid $other)."
    return 1
  fi
  # Stale lock from a killed process.
  rm -rf "$lock"
  if mkdir "$lock" 2>/dev/null; then
    printf '%s\n' "$$" >"$lock/pid"
    LOCK_DIR="$lock"
  fi
  return 0
}

# shellcheck disable=SC2329  # invoked by the EXIT trap
cleanup() {
  local rc=$?

  if [ "${SUCCESS:-0}" -eq 1 ] && [ -n "${SESSION_DIR:-}" ]; then
    if [ "${KEEP_TEMP:-0}" -eq 0 ]; then
      rm -rf "$SESSION_DIR"
    else
      # A finished session left on disk would be offered as resumable on the
      # next run, so park it at a terminal stage and drop its saved state.
      if [ -n "${CHECKPOINT_FILE:-}" ]; then
        set_checkpoint "done"
      fi
      rm -f "${SESSION_FILE:-}"
      info "Kept workspace: $SESSION_DIR"
    fi
  fi
  if [ "${IN_SUBSHELL:-0}" -eq 0 ] && [ -n "${LOCK_DIR:-}" ]; then
    rm -rf "$LOCK_DIR"
  fi
  # A run that stops early must never look like success: bash can exit 0
  # after an expansion error, which would otherwise pass for a clean run.
  if [ "$rc" -eq 0 ] && [ "${COMPLETED:-0}" -ne 1 ]; then
    error "Run stopped before it finished; see the message above."
    exit 1
  fi
}

# shellcheck disable=SC2329  # invoked by the ERR trap
on_error() {
  local rc=$1 line=$2 cmd=$3
  printf '%s\n' "${RED}[x] FAILED${RESET} (exit $rc, line $line): $cmd" >&2
  return 0
}

# Sourcing the script (the MusicBrainz tests) must not install traps or run a
# download; AUDIODL_SOURCE_ONLY=1 turns the file into a function library.
if [ "${AUDIODL_SOURCE_ONLY:-0}" -ne 1 ]; then
  trap 'on_error $? "$LINENO" "$BASH_COMMAND"' ERR
  trap cleanup EXIT
  trap 'error "Interrupted - session kept, re-run to resume."; exit 130' INT TERM
fi

# ============================================================
# Checkpoints
# ============================================================
set_checkpoint() {
  printf '%s\n' "$1" >"$CHECKPOINT_FILE"
}

get_checkpoint() {
  if [ -f "$CHECKPOINT_FILE" ]; then
    cat "$CHECKPOINT_FILE"
  else
    printf 'none'
  fi
}

# ============================================================
# Import index
#
# Remembers which entries already landed in the library, keyed by the extractor
# id, so re-running a playlist only fetches what is new. The stored path is
# checked too: a file that was moved or deleted counts as missing again.
# ============================================================
# A query, not a command: "no entry" is an answer, so this always returns 0.
# Callers read it as `prior="$(index_path …)"`, a plain assignment, and under
# `set -e` the shell adopts the status of the command substitution - returning 1
# here killed the first --inspect/--plan on a state folder with no index.tsv yet,
# which is every fresh install (dlAudio.sh:4112).
index_path() {
  local key="${1:-}"
  [ -n "$key" ] || return 0
  [ -s "${INDEX_FILE:-}" ] || return 0
  awk -F'\t' -v k="$key" '$1 == k { p = $3 } END { if (p != "") print p }' \
    "$INDEX_FILE" 2>/dev/null || true
}

index_has() {
  local key="${1:-}" path=""
  path="$(index_path "$key")"
  [ -n "$path" ] && [ -s "$path" ] || return 1
  # A track in another container is a different file: let the conversion run
  # instead of skipping it as already imported.
  [ "${path##*.}" = "$OUT_EXT" ]
}

index_add() {
  local key="${1:-}" path="${2:-}"
  [ -n "$key" ] && [ -n "$path" ] || return 0
  case "$path" in
  /*) ;;
  *) path="$PWD/$path" ;;
  esac
  mkdir -p "$STATE_DIR" 2>/dev/null || return 0
  # Several runs may write the index at once (--no-lock). The rewrite goes to a
  # per-process file and is swapped in atomically, with a short-lived lock so two
  # runs cannot each drop a different key; a stale lock only costs a retry.
  local lock="$STATE_DIR/index.lock" tries=0
  while ! mkdir "$lock" 2>/dev/null; do
    tries=$((tries + 1))
    [ "$tries" -ge 100 ] && break
    sleep 0.05
  done
  # One row per key, so the file cannot grow without bound.
  if [ -s "$INDEX_FILE" ]; then
    awk -F'\t' -v k="$key" '$1 != k' "$INDEX_FILE" >"$INDEX_FILE.$$.tmp" 2>/dev/null &&
      mv -f "$INDEX_FILE.$$.tmp" "$INDEX_FILE"
  fi
  printf '%s\t%s\t%s\n' "$key" "$(date +%Y-%m-%d)" "$path" >>"$INDEX_FILE"
  rm -f "$INDEX_FILE.$$.tmp"
  rmdir "$lock" 2>/dev/null || true
}

# ============================================================
# Session persistence
#
# Values are written with %q so that titles containing quotes, $, backticks or
# backslashes survive a round-trip. Sourcing the old hand-written file could
# corrupt the session or execute metadata as shell code.
# ============================================================
SESSION_VARS="ORIGIN_URL URL START END ARTIST ALBUM ALBUM_ARTIST TITLE TRACK GENRE
RECORDING_DATE_ISO FETCHED_DATE RAW_THUMB TARGET_DIR FINAL_FILE BASENAME TMP_FILE
NORMALIZED_FILE FINAL_TMP TMP_THUMB SOURCE_SAMPLE_RATE SOURCE_DURATION ENTRY_NUM
PLAYLIST_ID PLAYLIST_TITLE TRACK_KEY MB_STATUS MB_SCORE MB_NOTE MB_RECORDING_ID
MB_RELEASE_ID MB_RELEASE_TITLE MB_RELEASE_GROUP_ID MB_ARTIST_ID MB_ALBUM_ARTIST_ID
MB_TRACK_ID MB_TRACK_TOTAL MB_DISC_NUMBER MB_DISC_TOTAL MB_TRACK_FILLED
RG_LOUDNESS RG_PEAK_DB"

save_session() {
  local v
  {
    for v in $SESSION_VARS; do
      printf '%s=%q\n' "$v" "${!v}"
    done
  } >"$SESSION_FILE.tmp" && mv -f "$SESSION_FILE.tmp" "$SESSION_FILE"
}

load_session() {
  [ -f "$SESSION_FILE" ] || return 1
  # shellcheck disable=SC1090
  source "$SESSION_FILE"
  return 0
}

clear_session() {
  rm -rf "$SESSION_DIR"
  mkdir -p "$SESSION_DIR"
  printf 'none' >"$CHECKPOINT_FILE"
  rm -f "$SESSION_FILE"
}

# ============================================================
# Output format
# ============================================================
# AUDIO_FORMAT above is yt-dlp's *source* selector; this is what the encoder
# writes. OUT_EXT drives every path in the run, which is how the playlist
# writer, the import index and the web queue follow the format for free.
resolve_output_format() {
  local q="${AAC_QUALITY:-2}"
  OUT_FORMAT_NAME=""
  OUT_EXT=""
  OUT_ART=1       # the format can carry cover art at all
  OUT_MUX_ART=1   # ffmpeg can attach it in one pass
  OUT_POST_TAG="" # a tagger that has to run after ffmpeg (opus)
  OUT_SAMPLE_RATE=""
  OUT_CODEC_ARGS=()
  OUT_FILE_ARGS=()
  OUT_STREAM_ARGS=()
  OUT_TAG_ARGS=()

  case "$OUTPUT_FORMAT" in
  m4a | mp4 | aac)
    OUT_FORMAT_NAME="M4A (AAC)"
    OUT_EXT=m4a
    OUT_CODEC_ARGS=(-c:a aac -q:a "$q")
    OUT_FILE_ARGS=(-movflags +faststart)
    # A pipe cannot be seeked back, so faststart is impossible and the MP4
    # has to be fragmented instead. Audio has no keyframes, so frag_keyframe
    # alone would hold the whole file back until the encoder finished: cut a
    # fragment every second so the bytes keep flowing to the reader.
    # delay_moov, not empty_moov: with an empty moov the muxer writes the cover
    # as a stray video track and no covr atom, so players show no artwork.
    OUT_STREAM_ARGS=(-movflags +delay_moov+frag_keyframe+default_base_moof -frag_duration 1000000 -flush_packets 1 -f mp4)
    OUT_TAG_ARGS=(-c:a copy -movflags +faststart)
    ;;
  mp3)
    OUT_FORMAT_NAME="MP3 (LAME VBR)"
    OUT_EXT=mp3
    # LAME's -q:a runs 0-9, not 1-5: map the shared step onto it.
    OUT_CODEC_ARGS=(-c:a libmp3lame -q:a "$(case "$q" in 1) echo 0 ;; 2) echo 2 ;; 3) echo 4 ;; 4) echo 5 ;; *) echo 7 ;; esac)")
    OUT_STREAM_ARGS=(-f mp3 -id3v2_version 0 -write_id3v1 0 -flush_packets 1)
    OUT_TAG_ARGS=(-c:a copy -id3v2_version 3 -write_id3v1 0)
    ;;
  opus | ogg)
    OUT_FORMAT_NAME="Opus"
    OUT_EXT=opus
    OUT_CODEC_ARGS=(
      -c:a libopus
      -b:a "$(case "$q" in 1) echo 160k ;; 2) echo 128k ;; 3) echo 96k ;; 4) echo 80k ;; *) echo 64k ;; esac)"
      -vbr on
    )
    OUT_STREAM_ARGS=(-f ogg)
    OUT_TAG_ARGS=(-c:a copy)
    # libopus takes 48/24/16/12/8 kHz and will not resample a forced rate.
    OUT_SAMPLE_RATE=48000
    # ffmpeg's Ogg muxer drops -metadata and cannot mux a picture stream, so
    # mutagen writes both after the encode (see tag_opus).
    OUT_MUX_ART=0
    OUT_POST_TAG=opus
    ;;
  flac)
    OUT_FORMAT_NAME="FLAC"
    OUT_EXT=flac
    OUT_CODEC_ARGS=(-c:a flac -compression_level 8)
    OUT_STREAM_ARGS=(-f flac -flush_packets 1)
    OUT_TAG_ARGS=(-c:a copy)
    ;;
  wav)
    OUT_FORMAT_NAME="WAV (PCM)"
    OUT_EXT=wav
    OUT_CODEC_ARGS=(-c:a pcm_s16le)
    OUT_STREAM_ARGS=(-f wav -flush_packets 1)
    OUT_TAG_ARGS=(-c:a copy)
    # The WAV muxer takes no video stream; tags become a LIST INFO chunk.
    OUT_ART=0
    OUT_MUX_ART=0
    ;;
  *)
    die "Unknown output format '$OUTPUT_FORMAT' (use m4a, mp3, opus, flac or wav)."
    ;;
  esac
}

# ============================================================
# Requirements
# ============================================================
check_requirements() {
  local missing=0 dep

  for dep in yt-dlp ffmpeg ffprobe; do
    if ! command -v "$dep" >/dev/null 2>&1; then
      error "$dep is not installed (required)."
      missing=1
    fi
  done
  [ "$missing" -eq 0 ] || die "Install the missing tools and try again."

  command -v jq >/dev/null 2>&1 && HAVE_JQ=1 || HAVE_JQ=0
  if [ "$JSON" -eq 1 ] && [ "$HAVE_JQ" -eq 0 ]; then
    die "--json/--inspect/--plan need jq for their output."
  fi
  # The lookup is optional: without its two tools the run is unchanged and the
  # summary simply has nothing to report.
  if [ "${MB_ENABLED:-1}" -eq 1 ]; then
    if [ "$HAVE_JQ" -eq 0 ]; then
      warning "MusicBrainz lookup needs jq; continuing without it."
      MB_ENABLED=0
    elif ! command -v curl >/dev/null 2>&1; then
      warning "MusicBrainz lookup needs curl; continuing without it."
      MB_ENABLED=0
    fi
  fi

  case "$MUSIC_DIR" in
  "" | "/") die "Refusing to use '$MUSIC_DIR' as the music directory." ;;
  esac
  # loudnorm rejects out-of-range values with a cryptic filter error, and only
  # after the download and the analysis pass have already run.
  is_num "$TARGET_LUFS" || die "TARGET_LUFS must be a number (got '$TARGET_LUFS')."
  in_range "$TARGET_LUFS" -70 -5 || die "TARGET_LUFS must be between -70 and -5 (got '$TARGET_LUFS')."
  is_num "$TARGET_TP" || die "TARGET_TP must be a number (got '$TARGET_TP')."
  in_range "$TARGET_TP" -9 0 || die "TARGET_TP must be between -9 and 0 (got '$TARGET_TP')."
  is_num "$TARGET_LRA" || die "TARGET_LRA must be a number (got '$TARGET_LRA')."
  in_range "$TARGET_LRA" 1 50 || die "TARGET_LRA must be between 1 and 50 (got '$TARGET_LRA')."
  is_int "$AAC_QUALITY" || die "AAC_QUALITY must be an integer (got '$AAC_QUALITY')."
  in_range "$AAC_QUALITY" 1 5 || die "AAC_QUALITY must be between 1 and 5 (got '$AAC_QUALITY')."
  resolve_output_format

  if [ "${STREAM_FD:-0}" != 0 ]; then
    is_int "$STREAM_FD" || die "--stream-fd must be an integer (got '$STREAM_FD')."
    [ "$STREAM_FD" -ge 3 ] || die "--stream-fd must be 3 or higher (got '$STREAM_FD')."
    if ! { printf '' >&"$STREAM_FD"; } 2>/dev/null; then
      die "File descriptor $STREAM_FD is not open for writing."
    fi
    # Nothing reaches the library or the import index, so the single-instance
    # lock would only serialise concurrent streams for no reason.
    NO_LOCK=1
    [ "$OUT_POST_TAG" = opus ] && die "Opus cannot be streamed: its tags are written after the encode, which a pipe cannot be reopened for."
    info "Streaming to file descriptor $STREAM_FD ($OUT_FORMAT_NAME, one-pass loudnorm)."
    ONE_PASS=1
  fi

  if [ "$OUT_POST_TAG" = opus ] && ! python3 -c 'import mutagen.oggopus' >/dev/null 2>&1; then
    die "Opus output needs mutagen: install python3-mutagen (Debian/Ubuntu) or python3 -m pip install mutagen."
  fi

  if command -v magick >/dev/null 2>&1; then
    HAVE_IM=1 IM_CMD="magick"
  elif command -v convert >/dev/null 2>&1; then
    HAVE_IM=1 IM_CMD="convert"
  fi
  command -v file >/dev/null 2>&1 && HAVE_FILE=1 || HAVE_FILE=0
  command -v curl >/dev/null 2>&1 && HAVE_CURL=1 || HAVE_CURL=0
  command -v fzf >/dev/null 2>&1 && HAVE_FZF=1 || HAVE_FZF=0
  if command -v timg >/dev/null 2>&1 || command -v chafa >/dev/null 2>&1; then
    HAVE_PREVIEW=1
  fi

  HAVE_GUM=0
  if command -v gum >/dev/null 2>&1 && [ -t 0 ] && [ -t 1 ]; then
    HAVE_GUM=1
  fi

  # Without a terminal every prompt would silently take the default.
  if [ ! -t 0 ] && [ "$AUTO" -eq 0 ]; then
    die "No terminal attached. Re-run with --yes for non-interactive use."
  fi

  if [ "$ONE_PASS" -eq 1 ]; then
    warning "One-pass loudnorm requested (skipping the analysis pass)."
  elif [ "$HAVE_JQ" -eq 0 ]; then
    warning "jq not found; falling back to one-pass loudnorm."
  fi
  if [ "$NO_ART" -eq 0 ] && [ "$HAVE_CURL" -eq 0 ]; then
    warning "curl not found; cover art will be skipped."
    NO_ART=1
  fi
  if [ "$OUT_ART" -eq 0 ] && [ "$NO_ART" -eq 0 ]; then
    info "$OUT_FORMAT_NAME cannot carry cover art; skipping it."
    NO_ART=1
  fi
}

# ============================================================
# Cookies
#
# A site that needs a signed-in session (age gates, members-only uploads, the
# "Sign in to confirm you're not a bot" check) answers yt-dlp with an error
# unless it is handed a cookie jar. One jar serves every host it mentions, so
# the same file is passed to every yt-dlp call - including the probe, which is
# where most sign-in walls show up first.
# ============================================================
COOKIE_ARGS=()
init_cookies() {
  COOKIE_ARGS=()
  [ -n "$COOKIES_FILE" ] || return 0
  if [ ! -r "$COOKIES_FILE" ]; then
    warning "Cookie file not readable: $COOKIES_FILE - continuing without it."
    COOKIES_FILE=""
    return 0
  fi
  COOKIE_ARGS=(--cookies "$COOKIES_FILE")
  info "Using cookies from $COOKIES_FILE"
}

# ============================================================
# URL probing (playlist detection + entry list)
# ============================================================
# The extractor's own error line, turned into a sentence the UI can show.
# "This video is DRM protected" says nothing useful on its own, and some of the
# others read like a crash rather than "that link will never work".
describe_ytdlp_error() {
  local err="$1" line
  line="$(grep -m1 -E '^ERROR:' "$err" 2>/dev/null | sed 's/^ERROR:[[:space:]]*//' || true)"
  [ -n "$line" ] || return 0
  case "$line" in
    *"DRM protected"*|*"DRM-protected"*)
      printf '%s' "That track is DRM protected on the source site, so it cannot be downloaded. Try another upload of the same track."
      ;;
    *"Private video"*|*"private video"*|*"This video is unavailable"*|*"is not available"*)
      printf '%s' "That track is private, removed or blocked on the source site."
      ;;
    *"not available in your country"*|*"not available in your region"*)
      printf '%s' "That track is only offered in another region, so this server cannot read it."
      ;;
    *"Sign in to confirm"*|*"Login required"*|*"login required"*|*"use --cookies"*)
      printf '%s' "The source site asked for a sign-in before it would hand over that track."
      ;;
    *"HTTP Error 404"*|*"Not Found"*)
      printf '%s' "That link does not exist on the source site anymore."
      ;;
    *"HTTP Error 429"*|*"Too Many Requests"*)
      printf '%s' "The source site is rate limiting this server. Wait a minute and try again."
      ;;
    *"Unsupported URL"*)
      printf '%s' "That site is not one the downloader knows how to read."
      ;;
    *)
      printf '%s' "$line"
      ;;
  esac
}

# One flat-playlist call tells us everything: whether the URL is a playlist and
# which tracks it holds. No per-entry metadata fetch happens here.
probe_url() {
  section "Inspecting URL"

  local out="$TMP_DIR/probe.tsv" err="$TMP_DIR/probe.err" rc=0
  : >"$out"
  : >"$err"

  info "Contacting yt-dlp..."

  if ! yt-dlp --no-warnings --flat-playlist \
    --print "%(playlist_id)s${SEP}%(playlist_title)s${SEP}%(id)s${SEP}%(title)s${SEP}%(webpage_url)s${SEP}%(url)s${SEP}%(duration)s" \
    ${COOKIE_ARGS[@]+"${COOKIE_ARGS[@]}"} -- "$URL" >"$out" 2>"$err"; then
    rc=$?
  fi

  if [ ! -s "$out" ]; then
    PROBE_ERROR="$(describe_ytdlp_error "$err")"
    error "${PROBE_ERROR:-yt-dlp could not read that URL (exit $rc).}"
    show_log_tail "$err"
    return 1
  fi
  [ "$rc" -eq 0 ] || warning "yt-dlp reported errors; continuing with what it returned."

  local p_id p_title id title weburl rawurl dur n=0
  ENTRY_COUNT=0
  PLAYLIST_ID=""
  PLAYLIST_TITLE=""
  URL_IS_PLAYLIST=0

  while IFS="$SEP" read -r p_id p_title id title weburl rawurl dur; do
    [ -n "${id:-}" ] || continue
    n=$((n + 1))
    if [ -z "$PLAYLIST_ID" ] && [ -n "${p_id:-}" ] && [ "$p_id" != "NA" ]; then
      PLAYLIST_ID="$p_id"
      PLAYLIST_TITLE="$(fallback "${p_title:-}" "")"
    fi
    printf '%s\n' "$(entry_url "$weburl" "$rawurl" "$id")" >>"$TMP_DIR/entry_urls"
  done <"$out"
  ENTRY_COUNT="$n"

  if [ -n "$PLAYLIST_ID" ] || [ "$ENTRY_COUNT" -gt 1 ]; then
    URL_IS_PLAYLIST=1
  fi

  info "URL is a $([ "$URL_IS_PLAYLIST" -eq 1 ] && echo "playlist with $ENTRY_COUNT track(s)" || echo "single track")."
}

# Prefer a full URL, fall back to the bare id (yt-dlp accepts it).
entry_url() {
  local weburl="${1:-}" rawurl="${2:-}" id="${3:-}"
  if [ -n "$weburl" ] && [ "$weburl" != "NA" ] && [[ "$weburl" == http* ]]; then
    printf '%s' "$weburl"
  elif [ -n "$rawurl" ] && [ "$rawurl" != "NA" ] && [[ "$rawurl" == http* ]]; then
    printf '%s' "$rawurl"
  elif [ -n "$rawurl" ] && [ "$rawurl" != "NA" ]; then
    printf '%s' "$rawurl"
  else
    printf '%s' "$id"
  fi
}

# ============================================================
# Metadata
# ============================================================
fetch_metadata() {
  section "Fetching Metadata"
  info "Contacting yt-dlp..."

  local fmt="%(artist)s${SEP}%(album)s${SEP}%(title)s${SEP}%(uploader)s${SEP}%(upload_date)s${SEP}%(thumbnail)s${SEP}%(track_number)s${SEP}%(id)s${SEP}%(duration)s"
  local raw err="$TMP_DIR/ytmeta.err" rc=0

  : >"$err"
  if ! raw="$(yt-dlp --no-warnings --skip-download --print "$fmt" \
    ${COOKIE_ARGS[@]+"${COOKIE_ARGS[@]}"} -- "$URL" 2>"$err")"; then
    rc=$?
  fi
  if [ -z "${raw:-}" ]; then
    error "yt-dlp returned no metadata (invalid URL, private video or no network)."
    show_log_tail "$err"
    return 1
  fi
  [ "$rc" -eq 0 ] || warning "yt-dlp reported errors while reading metadata."

  local r_artist r_album r_title r_uploader r_date r_track r_id r_dur
  IFS="$SEP" read -r r_artist r_album r_title r_uploader r_date RAW_THUMB r_track r_id r_dur <<<"$raw"

  ARTIST="$(fallback "${r_artist:-}" "${r_uploader:-}")"
  ARTIST="$(fallback "$ARTIST" "Unknown Artist")"
  TITLE="$(fallback "${r_title:-}" "Unknown Title")"
  # No album in the source (a single upload, which is most SoundCloud tracks):
  # the track's own name is the least surprising album, instead of dropping
  # every unrelated single into one shared "Single" folder. ALBUM_FALLBACK lets
  # the playlist logic tell this placeholder from a real album name.
  ALBUM="$(fallback "${r_album:-}" "")"
  if [ -n "$ALBUM" ]; then
    ALBUM_FALLBACK=0
  else
    ALBUM="$TITLE"
    ALBUM_FALLBACK=1
  fi
  FETCHED_DATE="${r_date:-}"
  if is_int "${r_track:-}" && [ "${r_track:-0}" -gt 0 ]; then
    TRACK="$r_track"
  fi
  # Stable key for the import index (the playlist path sets it from the entry).
  TRACK_KEY="$(fallback "${r_id:-}" "$URL")"
  FETCHED_DURATION=""
  if is_num "${r_dur:-}" && [ "${r_dur%.*}" -gt 0 ] 2>/dev/null; then
    FETCHED_DURATION="${r_dur%.*}"
  fi

  info "Metadata fetched."
}

# ============================================================
# MusicBrainz enrichment (optional)
#
# One search request per track, checked against what the extractor reported.
# A recording is only used when its title and artist agree with the source and
# the duration does not contradict it; anything less keeps the source metadata
# and is reported as ambiguous/unmatched instead. Only missing or placeholder
# fields are filled from a match, MBIDs are written through the existing tag
# writers, and nothing is re-encoded. See MUSICBRAINZ.md.
# ============================================================
MB_API="${MUSICBRAINZ_API:-https://musicbrainz.org/ws/2}"
MB_USER_AGENT="${MUSICBRAINZ_USER_AGENT:-audioDL/$VERSION (set MUSICBRAINZ_USER_AGENT)}"
MB_CACHE_DIR="${MUSICBRAINZ_CACHE_DIR:-$STATE_DIR/musicbrainz}"
MB_CACHE_DAYS="${MUSICBRAINZ_CACHE_DAYS:-30}"
MB_MIN_INTERVAL="${MUSICBRAINZ_MIN_INTERVAL:-1}"
MB_MAX_TIME="${MUSICBRAINZ_TIMEOUT:-15}"
MB_CONNECT_TIMEOUT="${MUSICBRAINZ_CONNECT_TIMEOUT:-5}"
MB_MAX_ATTEMPTS="${MUSICBRAINZ_RETRIES:-3}"
MB_MAX_WAIT="${MUSICBRAINZ_MAX_WAIT:-30}"
MB_LIMIT=10
# Releases give the album and track/disc numbering; tags are the only genre
# signal a search response carries (the search API returns no genres list).
MB_INC="releases+artist-credits+tags+media"

# Sourcing the script in a test keeps the variables it defines out of the way.
mb_norm() {
  printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]' |
    sed -e 's/[^[:alnum:]]+/ /g' -e 's/^ //' -e 's/ $//'
}

mb_same() { [ "$(mb_norm "$1")" = "$(mb_norm "$2")" ]; }

# The release half of a match (its IDs and numbering) only describes the file
# when the album still is that release; an album override drops it again.
mb_forget_release() {
  MB_RELEASE_ID="" MB_RELEASE_TITLE="" MB_RELEASE_GROUP_ID="" MB_TRACK_ID=""
  MB_TRACK_TOTAL="" MB_DISC_NUMBER="" MB_DISC_TOTAL="" MB_ALBUM_ARTIST_ID=""
  ALBUM_ARTIST=""
  # A track number that came from that release is meaningless without it.
  if [ "${MB_TRACK_FILLED:-0}" -eq 1 ]; then
    TRACK=""
    MB_TRACK_FILLED=0
  fi
}

mb_reconcile_release() {
  [ -n "${MB_RELEASE_ID:-}" ] || return 0
  if [ -n "${ALBUM:-}" ] && ! mb_same "$ALBUM" "${MB_RELEASE_TITLE:-}"; then
    mb_forget_release
  fi
}

# Lucene terms have their own syntax; a title with a colon or a slash would
# otherwise be read as a field or a regex.
mb_lucene_escape() {
  printf '%s' "${1:-}" | sed \
    -e 's/\\/\\\\/g' \
    -e 's/\[/\\[/g' \
    -e 's/\]/\\]/g' \
    -e 's#[(){}^~?:*|&!+/]#\\&#g'
}

# "Song (Official Video) [HD]" is the same song, but not the same Lucene
# phrase: bracketed upload noise is dropped before searching and comparing.
mb_clean_title() {
  printf '%s' "${1:-}" | awk '
    {
      s = $0
      out = ""
      n = length(s)
      i = 1
      while (i <= n) {
        c = substr(s, i, 1)
        if (c == "(" || c == "[") {
          endch = (c == "(") ? ")" : "]"
          j = index(substr(s, i), endch)
          if (j > 0) {
            grp = substr(s, i, j)
            low = tolower(grp)
            if (low ~ /official|video|audio|lyric|visuali[sz]er|hd|hq|4k|mv/) {
              i += j
              continue
            }
            out = out grp
            i += j
            continue
          }
        }
        out = out c
        i++
      }
      gsub(/[[:space:]]+/, " ", out)
      sub(/^ /, "", out)
      sub(/ $/, "", out)
      print out
    }'
}

# A YouTube/SoundCloud uploader is often "Artist - Topic" or "ArtistVEVO".
mb_clean_artist() {
  local a="${1:-}"
  a="$(printf '%s' "$a" | sed -e 's/[[:space:]]*-[[:space:]]*[Tt][Oo][Pp][Ii][Cc]$//')"
  case "$a" in
  *VEVO) a="${a%VEVO}" ;;
  esac
  printf '%s' "$a" | sed -e 's/[[:space:]]*$//'
}

# MusicBrainz dates are often just a year or a year and month. The tag DATE
# needs a day, so the missing parts become 01 rather than today's date.
mb_date() {
  local d="${1:-}"
  case "$d" in
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) parse_date "${d//-/}" ;;
  [0-9][0-9][0-9][0-9]-[0-9][0-9]) parse_date "${d//-/}01" ;;
  [0-9][0-9][0-9][0-9]) parse_date "${d}0101" ;;
  esac
}

mb_build_query() {
  local title artist
  title="$(mb_clean_title "${TITLE:-}")"
  artist="$(mb_clean_artist "${ARTIST:-}")"
  [ -n "$title" ] || return 1
  if [ -n "$artist" ]; then
    printf 'recording:"%s" AND artist:"%s"' \
      "$(mb_lucene_escape "$title")" "$(mb_lucene_escape "$artist")"
  else
    printf 'recording:"%s"' "$(mb_lucene_escape "$title")"
  fi
}

mb_hash() {
  local h=""
  h="$(printf '%s' "$1" | sha256sum 2>/dev/null | cut -c1-32)"
  [ -n "$h" ] || h="$(printf '%s' "$1" | md5sum 2>/dev/null | cut -c1-32)"
  [ -n "$h" ] || h="$(printf '%s' "$1" | cksum 2>/dev/null | tr ' ' '-')"
  printf '%s' "${h:-query}"
}

# A lock held across the wait, so two parallel jobs cannot both send a request
# in the same second. A lock older than a minute is stale (the longest wait is
# MUSICBRAINZ_MAX_WAIT plus the interval).
mb_lock_acquire() {
  local lock="$1" tries=0
  mkdir -p "$(dirname "$lock")" 2>/dev/null || return 1
  while ! mkdir "$lock" 2>/dev/null; do
    tries=$((tries + 1))
    if [ "$tries" -ge 1200 ]; then
      rm -rf "$lock" 2>/dev/null || true
      mkdir "$lock" 2>/dev/null || return 1
      break
    fi
    sleep 0.05
  done
  return 0
}

mb_lock_release() { rmdir "$1" 2>/dev/null || true; }

mb_throttle() {
  local stamp="$MB_CACHE_DIR/.last-request" lock="$MB_CACHE_DIR/.throttle"
  local last="" now="" wait_us=0 interval_ns=0
  mkdir -p "$MB_CACHE_DIR" 2>/dev/null || return 0
  mb_lock_acquire "$lock" || return 0
  interval_ns="$(awk -v s="${MB_MIN_INTERVAL:-1}" 'BEGIN { if (s + 0 < 1) s = 1; printf "%.0f", s * 1000000000 }')"
  last="$(cat "$stamp" 2>/dev/null || true)"
  now="$(date +%s%N 2>/dev/null || true)"
  if is_int "$now"; then
    is_int "${last:-}" || last=0
    if [ "$now" -lt $((last + interval_ns)) ]; then
      wait_us=$(((last + interval_ns - now) / 1000 + 1))
      sleep "$(awk -v u="$wait_us" 'BEGIN { printf "%.3f", u / 1000000 }')"
    fi
    date +%s%N >"$stamp" 2>/dev/null || true
  else
    # No sub-second clock: one full second between requests is still within
    # the published limit.
    now="$(date +%s)"
    is_int "${last:-}" || last=0
    [ "$now" -gt "$last" ] || sleep 1
    date +%s >"$stamp" 2>/dev/null || true
  fi
  mb_lock_release "$lock"
}

mb_cache_fresh() {
  local file="$1" days="${MB_CACHE_DAYS:-30}" mtime=""
  is_int "$days" && [ "$days" -gt 0 ] || return 1
  [ -s "$file" ] || return 1
  mtime="$(stat -c %Y "$file" 2>/dev/null || stat -f %m "$file" 2>/dev/null || true)"
  is_int "$mtime" || return 0
  [ $(( $(date +%s) - mtime )) -lt $((days * 86400)) ]
}

mb_retry_after() {
  [ -s "${1:-}" ] || return 0
  awk -F': *' 'tolower($1) == "retry-after" { gsub(/\r/, ""); v = $2 } END { print v }' "$1" 2>/dev/null || true
}

# Echoes the HTTP status code; the body lands in $MB_TMP_BODY.
mb_curl() {
  local key="$1" code=""
  shift
  mb_lock_acquire "$MB_CACHE_DIR/.online" || true
  code="$(curl --silent --show-error --location --globoff \
    --connect-timeout "$MB_CONNECT_TIMEOUT" --max-time "$MB_MAX_TIME" \
    --user-agent "$MB_USER_AGENT" --header 'Accept: application/json' \
    --dump-header "$MB_TMP_HEADERS" --output "$MB_TMP_BODY" \
    --write-out '%{http_code}' "$@" 2>/dev/null || true)"
  mb_lock_release "$MB_CACHE_DIR/.online"
  printf '%s' "${code:-000}"
}

# Search with cache, throttle, bounded retries and Retry-After handling.
# Sets MB_BODY (cached or fresh response path) and MB_HTTP.
mb_search() {
  local query="$1" key="" code="" attempt=1 wait="" retry_after=""
  key="$(mb_hash "$query|$MB_LIMIT|$MB_INC")"
  MB_BODY="$MB_CACHE_DIR/$key.json"
  MB_HTTP=""
  if [ "${MB_REFRESH:-0}" -eq 0 ] && mb_cache_fresh "$MB_BODY"; then
    MB_HTTP=200
    return 0
  fi
  mkdir -p "$MB_CACHE_DIR" 2>/dev/null || {
    MB_HTTP=000
    return 1
  }
  MB_TMP_BODY="${TMP_DIR:-${TMPDIR:-/tmp}}/mb-response.$key"
  MB_TMP_HEADERS="${TMP_DIR:-${TMPDIR:-/tmp}}/mb-headers.$key"
  while :; do
    mb_throttle
    code="$(mb_curl "$key" --get \
      --data-urlencode "query=$query" \
      --data-urlencode "fmt=json" \
      --data-urlencode "limit=$MB_LIMIT" \
      --data-urlencode "inc=$MB_INC" \
      "$MB_API/recording")"
    MB_HTTP="${code:-000}"
    case "$MB_HTTP" in
    200)
      if [ -s "$MB_TMP_BODY" ]; then
        mv -f "$MB_TMP_BODY" "$MB_BODY" 2>/dev/null || cp -f "$MB_TMP_BODY" "$MB_BODY" 2>/dev/null || true
      fi
      rm -f "$MB_TMP_HEADERS" 2>/dev/null || true
      return 0
      ;;
    400 | 401 | 403 | 404 | 422)
      rm -f "$MB_TMP_BODY" "$MB_TMP_HEADERS" 2>/dev/null || true
      return 1
      ;;
    esac
    [ "$attempt" -lt "${MB_MAX_ATTEMPTS:-3}" ] || {
      rm -f "$MB_TMP_BODY" "$MB_TMP_HEADERS" 2>/dev/null || true
      return 1
    }
    retry_after="$(mb_retry_after "$MB_TMP_HEADERS")"
    if is_int "${retry_after:-}" && [ "$retry_after" -gt 0 ]; then
      wait="$retry_after"
      [ "$wait" -gt "${MB_MAX_WAIT:-30}" ] && wait="${MB_MAX_WAIT:-30}"
    else
      wait=$((attempt * 2))
    fi
    rm -f "$MB_TMP_BODY" "$MB_TMP_HEADERS" 2>/dev/null || true
    sleep "$wait"
    attempt=$((attempt + 1))
  done
}

# One row per recording/release pair, \x1f-separated so empty fields survive.
mb_candidates() {
  jq -r '
    .recordings[]? as $r
    | ($r["artist-credit"] // []) as $ac
    | (($ac | map(.name + (.joinphrase // "")) | join(""))) as $artist
    | (($ac | map(.artist.id) | join(";"))) as $artist_ids
    | (($r.genres // []) | sort_by(-(.count // 0)) | .[0].name // "") as $genre
    | (($r.tags // []) | sort_by(-(.count // 0)) | .[0].name // "") as $tag
    | (if (($r.releases // []) | length) == 0 then [null] else $r.releases end)[]
    | . as $rel
    | [ ($r.id // ""), ($r.title // ""), ($r.score // 0), ($r.length // 0),
        $artist, $artist_ids, ($r["first-release-date"] // ""),
        (if $genre != "" then $genre else $tag end),
        ($rel.id // ""), ($rel.title // ""), ($rel.status // ""), ($rel.date // ""),
        ($rel.country // ""), ($rel["release-group"].id // ""),
        ($rel["release-group"]["primary-type"] // ""),
        (($rel["release-group"]["secondary-types"] // []) | join("+")),
        ($rel.media[0].position // ""), (($rel.media | length) | tostring),
        ($rel.media[0].track[0].number // ""), ($rel.media[0]["track-count"] // ""),
        ($rel.media[0].track[0].id // ""),
        (($rel["artist-credit"] // []) | map(.name + (.joinphrase // "")) | join("")),
        (($rel["artist-credit"] // []) | map(.artist.id) | join(";")),
        ($rel.media[0].track[0].length // 0)
      ] | map(tostring) | join("\u001f")
  ' "$1" 2>/dev/null || true
}

# Adds total, title similarity and artist similarity in front of each row.
mb_score_rows() {
  local src_title src_artist src_album src_dur
  src_title="$(mb_norm "$(mb_clean_title "${TITLE:-}")")"
  src_artist="$(mb_norm "$(mb_clean_artist "${ARTIST:-}")")"
  src_album=""
  if [ "${ALBUM_FALLBACK:-0}" -eq 0 ]; then
    src_album="$(mb_norm "${ALBUM:-}")"
  fi
  src_dur="${FETCHED_DURATION:-}"
  awk -v OFS="$SEP" -F"$SEP" \
    -v src_title="$src_title" -v src_artist="$src_artist" \
    -v src_album="$src_album" -v src_dur="$src_dur" '
    function norm(s) {
      s = tolower(s)
      gsub(/[^[:alnum:]]+/, " ", s)
      sub(/^ /, "", s)
      sub(/ $/, "", s)
      return s
    }
    function sim(a, b,   na, nb, i, j, inter, uni) {
      if (a == "" || b == "") return 0
      if (a == b) return 1
      if (index(" " a " ", " " b " ") > 0 || index(" " b " ", " " a " ") > 0) return 0.85
      inter = 0
      split(a, na, " ")
      split(b, nb, " ")
      for (i in na) for (j in nb) if (na[i] == nb[j] && na[i] != "") { inter++; break }
      uni = length(na) + length(nb) - inter
      return uni > 0 ? inter / uni : 0
    }
    {
      r_title = $2
      mb_score = $3 + 0
      rec_len = $4 + 0
      r_artist = $5
      rel_title = $10
      track_len = $24 + 0
      if (rec_len == 0) rec_len = track_len

      t_s = sim(norm(r_title), src_title)
      a_s = sim(norm(r_artist), src_artist)
      if (src_album == "") al_s = 0.5
      else al_s = sim(norm(rel_title), src_album)

      dur_s = 0.6
      if (src_dur != "" && rec_len > 0) {
        d = (rec_len / 1000) - src_dur
        if (d < 0) d = -d
        if (d <= 3) dur_s = 1
        else if (d <= 8) dur_s = 0.8
        else if (d <= 15) dur_s = 0.6
        else if (d <= 30) dur_s = 0.3
        else dur_s = 0
      }

      # Between two otherwise equal releases, prefer a plain official album
      # over a compilation or a live record.
      kind = 0
      if ($11 == "Official") kind += 1.5
      if ($15 == "Album") kind += 1
      else if ($15 == "Single" || $15 == "EP") kind += 0.5
      if ($16 ~ /Compilation|Live|Bootleg/) kind -= 2

      total = 100 * (0.40 * t_s + 0.30 * a_s + 0.10 * al_s + 0.10 * dur_s + 0.10 * (mb_score / 100)) + kind
      if (total > 100) total = 100
      printf "%.1f%s%.3f%s%.3f%s%s\n", total, OFS, t_s, OFS, a_s, OFS, $0
    }'
}

mb_report_file() {
  if [ -n "${MB_REPORT_FILE:-}" ]; then
    printf '%s' "$MB_REPORT_FILE"
  elif [ -n "${BATCH_DIR:-}" ]; then
    printf '%s' "$BATCH_DIR/mb-report.tsv"
  elif [ -n "${TMP_DIR:-}" ]; then
    printf '%s' "$TMP_DIR/mb-report.tsv"
  fi
}

mb_report_append() {
  local status="${1:-${MB_STATUS:-unmatched}}" score="${2:-${MB_SCORE:-0}}" note="${3:-${MB_NOTE:-}}"
  local dest=""
  dest="$(mb_report_file)"
  [ -n "$dest" ] || return 0
  mkdir -p "$(dirname "$dest")" 2>/dev/null || return 0
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$status" "${score:-0}" "${MB_RECORDING_ID:-}" \
    "${ENTRY_NUM:-1}" "${TITLE:-}" "$note" >>"$dest" 2>/dev/null || true
}

mb_finish() {
  local score_i="0"
  is_num "${MB_SCORE:-}" && score_i="$(printf '%.0f' "$MB_SCORE" 2>/dev/null || printf 0)"
  json_emit mb i#="${CUR_I:-1}" status="${MB_STATUS:-unmatched}" score#="$score_i" \
    recording_id="${MB_RECORDING_ID:-}" release_id="${MB_RELEASE_ID:-}" \
    note="${MB_NOTE:-}"
  mb_report_append "${MB_STATUS:-unmatched}" "${MB_SCORE:-0}" "${MB_NOTE:-}"
}

mb_say() {
  if [ "$JSON" -eq 1 ]; then
    printf '%s\n' "$1" >&2
  else
    printf '%s\n' "$1"
  fi
}

mb_print_summary() {
  local file=""
  file="$(mb_report_file)"
  [ -n "$file" ] && [ -s "$file" ] || return 0
  local matched ambiguous unmatched conflict failed
  read -r matched ambiguous unmatched conflict failed <<<"$(awk -F'\t' '
    $1 == "matched" { m++ }
    $1 == "ambiguous" { a++ }
    $1 == "unmatched" { u++ }
    $1 == "conflict" { c++ }
    $1 == "failed" { f++ }
    END { printf "%d %d %d %d %d", m, a, u, c, f }
  ' "$file" 2>/dev/null || true)"
  section "MusicBrainz"
  print_kv "Matched" "$matched"
  [ "${conflict:-0}" -gt 0 ] && print_kv "Kept source" "$conflict"
  print_kv "Ambiguous" "$ambiguous"
  print_kv "Unmatched" "$unmatched"
  [ "${failed:-0}" -gt 0 ] && print_kv "API failures" "$failed"
  awk -F'\t' '
    $1 != "matched" {
      n++
      if (n <= 12) printf "    %s: %s (%s)\n", $1, $5, ($2 == "0" || $2 == "" ? "no score" : "score " $2)
    }
  ' "$file" 2>/dev/null | while IFS= read -r line; do mb_say "$line"; done
  json_emit mb_summary matched#="$matched" ambiguous#="$ambiguous" unmatched#="$unmatched" \
    conflict#="$conflict" failed#="$failed"
}

musicbrainz_lookup() {
  MB_STATUS="" MB_NOTE="" MB_SCORE=""
  MB_RECORDING_ID="" MB_RELEASE_ID="" MB_RELEASE_TITLE="" MB_RELEASE_GROUP_ID=""
  MB_ARTIST_ID="" MB_ALBUM_ARTIST_ID="" MB_TRACK_ID="" MB_TRACK_TOTAL=""
  MB_DISC_NUMBER="" MB_DISC_TOTAL="" MB_TRACK_FILLED=0 ALBUM_ARTIST=""

  [ "${MB_ENABLED:-1}" -eq 1 ] || return 0
  command -v curl >/dev/null 2>&1 || return 0
  [ "${HAVE_JQ:-0}" -eq 1 ] || return 0

  local query="" title=""
  title="$(mb_clean_title "${TITLE:-}")"
  if [ -z "$title" ]; then
    MB_STATUS="unmatched"
    MB_NOTE="no title to search for"
    mb_finish
    return 0
  fi
  query="$(mb_build_query)" || {
    MB_STATUS="unmatched"
    MB_NOTE="no title to search for"
    mb_finish
    return 0
  }

  if ! mb_search "$query"; then
    MB_STATUS="failed"
    MB_NOTE="HTTP ${MB_HTTP}"
    [ "${MB_HTTP:-000}" = "000" ] && MB_NOTE="request failed"
    mb_finish
    return 0
  fi

  # An uploader name in the artist field often matches nothing; retry once on
  # the title alone before falling back (the second request is still throttled).
  if [ "$(jq '.recordings | length' "$MB_BODY" 2>/dev/null || printf 0)" = "0" ] &&
    [ -n "${ARTIST:-}" ]; then
    query="recording:\"$(mb_lucene_escape "$title")\""
    if ! mb_search "$query"; then
      MB_STATUS="failed"
      MB_NOTE="HTTP ${MB_HTTP}"
      [ "${MB_HTTP:-000}" = "000" ] && MB_NOTE="request failed"
      mb_finish
      return 0
    fi
  fi

  local cands="" scored=""
  cands="${TMP_DIR:-${TMPDIR:-/tmp}}/mb-candidates.tsv"
  scored="${TMP_DIR:-${TMPDIR:-/tmp}}/mb-scored.tsv"
  mb_candidates "$MB_BODY" >"$cands" 2>/dev/null || : >"$cands"
  if [ ! -s "$cands" ]; then
    MB_STATUS="unmatched"
    MB_NOTE="not found in MusicBrainz"
    mb_finish
    return 0
  fi
  mb_score_rows <"$cands" 2>/dev/null | LC_ALL=C sort -t "$SEP" -k1,1gr >"$scored" 2>/dev/null || : >"$scored"

  local best="" second="0"
  best="$(awk -F"$SEP" 'NR == 1 { print; exit }' "$scored" 2>/dev/null || true)"
  if [ -z "$best" ]; then
    MB_STATUS="unmatched"
    MB_NOTE="no usable result"
    mb_finish
    return 0
  fi

  local sc title_sim artist_sim rec_id rec_title c_artist c_artist_ids
  local first_date genre rel_id rel_title rel_status rel_date rg_id rel_type
  local rel_secondary disc disc_total track track_total track_id alb_artist alb_artist_ids
  IFS="$SEP" read -r sc title_sim artist_sim rec_id rec_title _ _ \
    c_artist c_artist_ids first_date genre rel_id rel_title rel_status _ _ \
    rg_id rel_type rel_secondary disc disc_total track track_total track_id alb_artist \
    alb_artist_ids _ <<<"$best"

  second="$(awk -F"$SEP" -v id="$rec_id" '
    $4 != id && ($1 + 0) > best { best = $1 + 0 }
    END { printf "%.1f", best + 0 }
  ' "$scored" 2>/dev/null || printf 0)"

  MB_SCORE="$sc"
  local status="matched" note="" strong=0
  if awk -v a="$sc" 'BEGIN { exit !(a + 0 < 55) }'; then
    status="unmatched"
    note="best candidate scored $sc"
  elif awk -v a="$sc" 'BEGIN { exit !(a + 0 < 70) }' ||
    awk -v a="$sc" -v b="$second" 'BEGIN { exit !(a + 0 - b + 0 < 6) }' ||
    awk -v a="$title_sim" 'BEGIN { exit !(a + 0 < 0.85) }' ||
    awk -v a="$artist_sim" 'BEGIN { exit !(a + 0 < 0.6) }'; then
    status="ambiguous"
    note="closest match scored $sc"
  elif awk -v a="$sc" 'BEGIN { exit !(a + 0 >= 80) }' &&
    awk -v a="$title_sim" 'BEGIN { exit !(a + 0 >= 0.95) }' &&
    awk -v a="$artist_sim" 'BEGIN { exit !(a + 0 >= 0.8) }'; then
    strong=1
  fi

  if [ "$status" = "matched" ]; then
    MB_RECORDING_ID="$rec_id"
    MB_ARTIST_ID="$c_artist_ids"

    # A strong match is canonical enough to correct the extractor's spelling
    # and the upload-noise in the title; an ordinary match only fills gaps.
    if [ "$strong" -eq 1 ]; then
      [ -n "$rec_title" ] && TITLE="$rec_title"
      [ -n "$c_artist" ] && ARTIST="${c_artist}"
    fi
    if [ "${ALBUM_FALLBACK:-0}" -eq 1 ] && [ -z "$rel_title" ]; then
      ALBUM="$TITLE"
    fi

    # Without an album from the source, only a plain official album/single/EP
    # is worth filing under: a greatest-hits or live record would put the track
    # in a release it never came from.
    local release_ok=0
    case "$rel_type" in Album | Single | EP) release_ok=1 ;; esac
    case "$rel_secondary" in
    *Compilation* | *Live* | *Bootleg* | *Soundtrack* | *Mixtape* | *DJ-mix*) release_ok=0 ;;
    esac
    if [ -n "$rel_status" ] && [ "$rel_status" != "Official" ]; then
      release_ok=0
    fi

    local adopt_release=0
    if [ -z "${ALBUM:-}" ] || [ "${ALBUM_FALLBACK:-0}" -eq 1 ]; then
      if [ -n "$rel_title" ] && [ "$release_ok" -eq 1 ]; then
        ALBUM="$rel_title"
        ALBUM_FALLBACK=0
        adopt_release=1
      elif [ -n "$rel_title" ]; then
        note="kept the source album (release is ${rel_type:-unknown}${rel_secondary:+/$rel_secondary})"
      fi
    elif [ -n "$rel_title" ] && mb_same "$ALBUM" "$rel_title"; then
      adopt_release=1
    elif [ -n "$rel_title" ]; then
      # The source album is real and different: keep it (and its numbering)
      # rather than rewrite the file into a release it did not come from.
      note="kept album \"$ALBUM\""
      status="conflict"
    fi

    if [ "$adopt_release" -eq 1 ]; then
      MB_RELEASE_ID="$rel_id"
      MB_RELEASE_TITLE="$rel_title"
      MB_RELEASE_GROUP_ID="$rg_id"
      MB_TRACK_ID="$track_id"
      MB_TRACK_TOTAL="$track_total"
      [ -n "$alb_artist" ] && ALBUM_ARTIST="$alb_artist"
      MB_ALBUM_ARTIST_ID="$alb_artist_ids"
      if [ -z "${TRACK:-}" ] && is_int "$track" && [ "$track" -ge 1 ]; then
        TRACK="$track"
        MB_TRACK_FILLED=1
      fi
      if is_int "$disc" && [ "$disc" -ge 1 ]; then
        MB_DISC_NUMBER="$disc"
        MB_DISC_TOTAL="$disc_total"
      fi
    fi

    # A release date beats today's default; on a strong match it also beats
    # the extractor's upload date, which is not a release date.
    if [ -z "${FETCHED_DATE:-}" ] || [ "$strong" -eq 1 ]; then
      local mb_day=""
      mb_day="$(mb_date "$first_date" || true)"
      [ -n "$mb_day" ] || mb_day="$(mb_date "$rel_date" || true)"
      # FETCHED_DATE keeps yt-dlp's YYYYMMDD shape; everything downstream
      # parses it with parse_date.
      [ -n "$mb_day" ] && FETCHED_DATE="${mb_day//-/}"
    fi
    if [ -z "${GENRE:-}" ] && [ -n "$genre" ]; then
      GENRE="$(sanitize_genre "$genre")"
    fi
  fi

  MB_STATUS="$status"
  MB_NOTE="$note"
  mb_finish
}

# ============================================================
# Metadata prompt
# ============================================================
# Remember the album this batch is using, so a later entry where yt-dlp reports
# no album does not split the batch into one folder per track title.
remember_album() {
  [ -n "${BATCH_MEMO:-}" ] || return 0
  [ -n "${ALBUM:-}" ] || return 0
  # A title used as a stand-in album must not become the album for the rest of
  # the playlist; only a name the source actually reported is remembered.
  if [ "${ALBUM_FALLBACK:-0}" -eq 1 ]; then
    return 0
  fi
  if [ ! -f "$BATCH_MEMO" ] || [ "$(cat "$BATCH_MEMO" 2>/dev/null)" != "$ALBUM" ]; then
    printf '%s' "$ALBUM" >"$BATCH_MEMO.tmp" && mv -f "$BATCH_MEMO.tmp" "$BATCH_MEMO"
  fi
  return 0
}

autofill_or_prompt_metadata() {
  local memo=""

  # Explicit flags apply to every track in the run.
  if [ -n "$ARTIST_OVERRIDE" ]; then
    ARTIST="$ARTIST_OVERRIDE"
  fi
  if [ -n "$GENRE_OVERRIDE" ]; then
    GENRE="$GENRE_OVERRIDE"
  fi
  GENRE="$(sanitize_genre "$GENRE")"
  if [ -n "$ALBUM_OVERRIDE" ]; then
    ALBUM="$ALBUM_OVERRIDE"
  elif [ -n "${BATCH_MEMO:-}" ] && [ -s "$BATCH_MEMO" ]; then
    memo="$(cat "$BATCH_MEMO" 2>/dev/null || true)"
    if [ -n "$memo" ] && { [ -z "$ALBUM" ] || [ "${ALBUM_FALLBACK:-0}" -eq 1 ]; }; then
      ALBUM="$memo"
      ALBUM_FALLBACK=0
    fi
  fi

  # Per-entry overrides from --meta-json (the web UI) win over the extractor;
  # the global --artist/--album flags above still win over both.
  local ov
  ov="$(meta_value artist)"
  [ -n "$ov" ] && ARTIST="$ov"
  ov="$(meta_value album)"
  [ -n "$ov" ] && ALBUM="$ov"
  ov="$(meta_value genre)"
  [ -n "$ov" ] && GENRE="$(sanitize_genre "$ov")"
  ov="$(meta_value title)"
  [ -n "$ov" ] && TITLE="$ov"
  ov="$(meta_value track)"
  if is_int "$ov" && [ "$ov" -ge 1 ]; then TRACK="$ov"; fi
  [ -n "$TITLE_OVERRIDE" ] && TITLE="$TITLE_OVERRIDE"
  if is_int "$TRACK_OVERRIDE" && [ "$TRACK_OVERRIDE" -ge 1 ]; then TRACK="$TRACK_OVERRIDE"; fi
  ov="$(meta_value art)"
  [ -n "$ov" ] && ART_OVERRIDE="$ov"
  [ -n "$ART_OVERRIDE" ] && RAW_THUMB="$ART_OVERRIDE"
  if [ -n "$DATE_OVERRIDE" ]; then
    RECORDING_DATE_ISO="$(parse_date "${DATE_OVERRIDE//-/}" || true)"
  else
    ov="$(meta_value date)"
    [ -n "$ov" ] && RECORDING_DATE_ISO="$(parse_date "${ov//-/}" || true)"
  fi

  # An explicit album decides the release, so the release-level MB data is
  # settled before the non-interactive defaults pick a track number.
  mb_reconcile_release

  if [ "$AUTO" -eq 1 ]; then
    [ -n "${TRACK:-}" ] || TRACK="${ENTRY_NUM:-1}"
    [ -n "${RECORDING_DATE_ISO:-}" ] ||
      RECORDING_DATE_ISO="$(parse_date "$FETCHED_DATE" || printf '%s' "$(date +%Y-%m-%d)")"
    ARTIST="$(artist_label "$ARTIST")"
    mb_reconcile_release
    remember_album
    return 0
  fi

  # Artist (with fzf/gum folder match against the existing library)
  ARTIST="$(prompt_default "Artist" "$ARTIST")"
  local existing=""
  if [ -d "$MUSIC_DIR" ]; then
    if [ "$HAVE_GUM" -eq 1 ]; then
      existing="$(
        find "$MUSIC_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null |
          gum filter --placeholder "Existing artists..." --value "$ARTIST" || true
      )"
    elif [ "$HAVE_FZF" -eq 1 ]; then
      existing="$(
        find "$MUSIC_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null |
          fzf --query="$ARTIST" --exit-0 || true
      )"
    fi
    [ -n "$existing" ] && ARTIST="$existing"
  fi
  [ -n "$ARTIST" ] || ARTIST="Unknown Artist"
  ARTIST="$(artist_label "$ARTIST")"

  ALBUM="$(prompt_default "Album" "$ALBUM")"
  [ -n "$ALBUM" ] || ALBUM="${TITLE:-Single}"
  TITLE="$(prompt_default "Title" "$TITLE")"
  [ -n "$TITLE" ] || TITLE="Unknown Title"
  # In a batch the entry position is the sensible default, not always 1.
  TRACK="$(prompt_default "Track # (leave blank for ${ENTRY_NUM:-1})" "${TRACK:-${ENTRY_NUM:-1}}")"
  if ! is_int "$TRACK" || [ "$TRACK" -lt 1 ]; then
    warning "Invalid track number '$TRACK'; using 1."
    TRACK="1"
  fi

  if [ -z "${RECORDING_DATE_ISO:-}" ]; then
    if ! RECORDING_DATE_ISO="$(parse_date "$FETCHED_DATE")"; then
      local day month year tries=0
      while [ "$tries" -lt 3 ]; do
        day="$(prompt_default "Day" "$(date +%d)")"
        month="$(prompt_default "Month" "$(date +%m)")"
        year="$(prompt_default "Year" "$(date +%Y)")"
        if RECORDING_DATE_ISO="$(parse_date "$year$month$day")"; then
          break
        fi
        warning "Invalid date: $year-$month-$day"
        tries=$((tries + 1))
      done
      if [ "$tries" -ge 3 ]; then
        warning "Keeping today's date."
        RECORDING_DATE_ISO="$(date +%Y-%m-%d)"
      fi
    fi
  fi

  mb_reconcile_release
  remember_album
}

# ============================================================
# Paths
# ============================================================
compute_paths() {
  local safe_artist safe_album base track_num=""

  safe_artist="$(sanitize_filename "$(primary_artist "$ARTIST")")"
  [ -n "$safe_artist" ] || safe_artist="Unknown Artist"
  safe_album="$(sanitize_filename "$ALBUM")"
  # An album that sanitises to nothing (all slashes, say) falls back to the
  # track name, the same rule the metadata stage uses.
  [ -n "$safe_album" ] || safe_album="$(sanitize_filename "$TITLE")"
  [ -n "$safe_album" ] || safe_album="Single"
  base="$(sanitize_filename "$TITLE")"
  [ -n "$base" ] || base="Unknown Title"

  if [ "$TRACK_PREFIX" -eq 1 ] && is_int "${TRACK:-}"; then
    track_num="$(printf '%02d' "$((10#$TRACK))")"
    base="$track_num - $base"
  fi

  BASENAME="$base"
  TARGET_DIR="$MUSIC_DIR/$safe_artist/$safe_album"
  # A stream never writes a library file, so the folder is not created (and
  # cannot be created by a guest who only has a descriptor to write to).
  if [ "${STREAM_FD:-0}" -gt 0 ]; then
    TARGET_DIR="$WORK_DIR/stream"
  elif [ "$DRY_RUN" -eq 0 ] && ! mkdir -p "$TARGET_DIR"; then
    error "Cannot create output directory: $TARGET_DIR"
    return 1
  fi
  FINAL_FILE="$TARGET_DIR/$BASENAME.$OUT_EXT"
  NORMALIZED_FILE="$WORK_DIR/normalized.$OUT_EXT"
  FINAL_TMP="$WORK_DIR/final.$OUT_EXT"

  # Switching container replaces the track instead of leaving a second copy:
  # when the import index knows this entry in another format and that file is
  # still there, it is what "already exists" refers to.
  PREVIOUS_FILE=""
  if [ "${STREAM_FD:-0}" -eq 0 ] && [ ! -f "$FINAL_FILE" ] && [ -n "${TRACK_KEY:-}" ]; then
    local prior
    prior="$(index_path "$TRACK_KEY")"
    if [ -n "$prior" ] && [ -f "$prior" ] && [ "${prior##*.}" != "$OUT_EXT" ]; then
      PREVIOUS_FILE="$prior"
    fi
  fi
}

# ============================================================
# Summary / existing file policy
# ============================================================
show_summary() {
  section "Summary"

  if [ "$AUTO" -eq 1 ]; then
    info "$ARTIST - $ALBUM - $TITLE${TRACK:+ (track $TRACK)}"
    info "Output: $FINAL_FILE"
    return 0
  fi

  if [ "$HAVE_GUM" -eq 1 ]; then
    gum style --border rounded --padding "1 2" \
      "Artist: $ARTIST
Album:  $ALBUM
Title:  $TITLE
Track:  ${TRACK:--}
Date:   $RECORDING_DATE_ISO
Output: $TARGET_DIR"
  else
    print_kv "Artist" "$ARTIST"
    print_kv "Album" "$ALBUM"
    print_kv "Title" "$TITLE"
    print_kv "Track" "${TRACK:--}"
    print_kv "Date" "$RECORDING_DATE_ISO"
    print_kv "Output" "$TARGET_DIR"
  fi

  echo

  if ! confirm "Continue?"; then
    error "Aborted by user."
    # Return (not exit) so a playlist worker can report the status itself.
    return 130
  fi
}

# 0 = keep going, 1 = aborted, 2 = skip this track
# A skipped track must not leave behind the folder this run created for it: an
# empty ARTIST/ALBUM pair is exactly what the library health screen reports as
# broken. rmdir is the test, so anything with a file in it is left alone.
drop_empty_target_dir() {
  [ "${STREAM_FD:-0}" -eq 0 ] || return 0
  [ -n "${TARGET_DIR:-}" ] || return 0
  case "$TARGET_DIR" in
  "$MUSIC_DIR"/*) ;;
  *) return 0 ;;
  esac
  rmdir "$TARGET_DIR" 2>/dev/null || true
  rmdir "${TARGET_DIR%/*}" 2>/dev/null || true
}

check_existing() {
  [ "${STREAM_FD:-0}" -gt 0 ] && return 0
  local existing="$FINAL_FILE" dup=0
  if [ ! -f "$existing" ] && [ -n "${PREVIOUS_FILE:-}" ] && [ -f "$PREVIOUS_FILE" ]; then
    existing="$PREVIOUS_FILE"
  fi
  # The import index knows where an earlier run of *this upload* put its file.
  # Finding that copy under another name (a different album after a MusicBrainz
  # match, a folder renamed since, a corrected artist) is a duplicate, not a
  # file this run would replace: the path is new, the audio is not.
  if [ ! -f "$existing" ] && [ -n "${TRACK_KEY:-}" ]; then
    local prior
    prior="$(index_path "$TRACK_KEY")"
    if [ -n "$prior" ] && [ -f "$prior" ] && [ "$prior" != "$FINAL_FILE" ]; then
      existing="$prior"
      dup=1
    fi
  fi
  [ -f "$existing" ] || return 0

  if [ "$FORCE" -eq 1 ]; then
    if [ "$dup" -eq 1 ]; then
      info "Keeping the earlier copy and writing this one too (--force): $existing"
    else
      info "Overwriting existing file (--force)."
    fi
    return 0
  fi

  if [ "$AUTO" -eq 1 ]; then
    if [ "$dup" -eq 1 ]; then
      warning "Already downloaded, skipping: $existing"
      json_emit track i#="${CUR_I:-1}" stage=skipped reason=duplicate path="$existing" title="$TITLE"
    else
      warning "Already exists, skipping: $existing"
    fi
    drop_empty_target_dir
    return 2
  fi

  if [ "$dup" -eq 1 ]; then
    warning "This source is already in the library:"
    echo " $existing"
    echo " (this run would write $FINAL_FILE)"
    echo
    local pick=""
    if [ "$HAVE_GUM" -eq 1 ]; then
      pick="$(gum choose "skip" "keep both" "abort")" || pick="abort"
      case "$pick" in
      "keep both") pick="both" ;;
      esac
    else
      echo "Options:"
      echo "1) skip"
      echo "2) keep both"
      echo "3) abort"
      read -rp "Choice [1]: " pick || pick=""
      case "${pick:-1}" in
      1) pick="skip" ;;
      2) pick="both" ;;
      *) pick="abort" ;;
      esac
    fi
    case "$pick" in
    both) return 0 ;;
    skip)
      drop_empty_target_dir
      return 2
      ;;
    *)
      error "Aborted by user."
      return 130
      ;;
    esac
  fi

  warning "File already exists:"
  echo " $existing"
  if [ "$existing" != "$FINAL_FILE" ]; then
    echo " (as ${existing##*.}; this run writes $OUT_EXT and then removes the old file)"
  fi
  echo

  local choice=""

  if [ "$HAVE_GUM" -eq 1 ]; then
    choice="$(gum choose "overwrite" "skip" "abort")" || choice="abort"
  else
    echo "Options:"
    echo "1) overwrite"
    echo "2) skip"
    echo "3) abort"
    read -rp "Choice [2]: " choice || choice=""
    case "${choice:-2}" in
    1) choice="overwrite" ;;
    2) choice="skip" ;;
    3) choice="abort" ;;
    *) choice="abort" ;;
    esac
  fi

  case "$choice" in
  overwrite)
    # No rm here: the atomic mv at the end replaces the file, and a failed
    # encode leaves the existing copy intact.
    return 0
    ;;
  skip)
    drop_empty_target_dir
    return 2
    ;;
  *)
    # 130 is distinct from a failure so a playlist batch can stop here too.
    error "Aborted by user."
    return 130
    ;;
  esac
}

# ============================================================
# Download
# ============================================================

# Complete source file left by an earlier attempt (a .part is not complete).
find_complete_source() {
  local -a found
  local f
  shopt -s nullglob
  found=("$WORK_DIR/dl"/source.*)
  shopt -u nullglob
  for f in ${found[@]+"${found[@]}"}; do
    case "$f" in
    *.part) continue ;;
    esac
    [ -s "$f" ] || continue
    printf '%s' "$f"
    return 0
  done
  return 1
}

has_partial_source() {
  local -a parts
  shopt -s nullglob
  parts=("$WORK_DIR/dl"/source.*.part)
  shopt -u nullglob
  [ "${#parts[@]}" -gt 0 ]
}

download_audio() {
  section "Downloading Audio"

  local dl_dir="$WORK_DIR/dl" pathfile="$WORK_DIR/downloaded.path" log="$WORK_DIR/download.log"
  local existing=""
  TMP_FILE=""

  # A crash can leave the audio behind: a finished file whose checkpoint was
  # never written, or a .part yt-dlp is able to continue. Wiping the whole
  # directory here (as this used to) threw both away and restarted from zero.
  if [ "$FORCE" -eq 1 ]; then
    rm -rf "$dl_dir"
  elif existing="$(find_complete_source)"; then
    TMP_FILE="$existing"
    success "Reusing downloaded source: $(basename "$TMP_FILE") ($(human_size "$(wc -c <"$TMP_FILE")"))"
    return 0
  fi

  mkdir -p "$dl_dir"
  rm -f "$pathfile"
  if has_partial_source; then
    info "Continuing a partial download."
  fi

  local -a args
  args=(
    --no-playlist
    --no-overwrites
    --newline
    -f "$AUDIO_FORMAT"
    -o "$dl_dir/source.%(ext)s"
    --print-to-file "after_move:filepath" "$pathfile"
    --no-simulate
  )
  if [ -n "$START" ] && [ -n "$END" ]; then
    args+=(--download-sections "*${START}-${END}")
  fi
  if [ "${#COOKIE_ARGS[@]}" -gt 0 ]; then
    args+=("${COOKIE_ARGS[@]}")
  fi
  args+=(-- "$URL")

  local ok=0
  # In --json mode tool output must stay out of the event stream, so the
  # capture path is used even without a terminal.
  if [ "$JSON" -eq 0 ] && { [ "$VERBOSE" -eq 1 ] || [ ! -t 1 ]; }; then
    if run_streamed "Downloading (format: $AUDIO_FORMAT)..." yt-dlp "${args[@]}"; then
      ok=1
    fi
  else
    if run_with_progress "Downloading..." "$log" ytdlp download yt-dlp "${args[@]}"; then
      ok=1
    fi
  fi
  # run_with_progress/run_streamed already surface the failure detail.
  [ "$ok" -eq 1 ] || {
    error "Download failed."
    local kept=""
    if kept="$(find_complete_source)"; then
      warning "Downloaded audio kept ($(basename "$kept")); re-run to use it."
    elif has_partial_source; then
      warning "Partial download kept; re-run to continue from here."
    fi
    return 1
  }

  # yt-dlp tells us exactly where the file landed; glob only as a fallback.
  if [ -s "$pathfile" ]; then
    TMP_FILE="$(tail -n 1 "$pathfile")"
  fi
  if [ -z "$TMP_FILE" ] || [ ! -s "$TMP_FILE" ]; then
    TMP_FILE="$(find_complete_source || true)"
  fi
  if [ -z "$TMP_FILE" ] || [ ! -s "$TMP_FILE" ]; then
    error "Download produced no usable file."
    return 1
  fi

  success "Download complete: $(basename "$TMP_FILE") ($(human_size "$(wc -c <"$TMP_FILE")"))"
}

resolve_tmp_file() {
  if [ -n "${TMP_FILE:-}" ] && [ -s "$TMP_FILE" ]; then
    return 0
  fi
  local f
  if f="$(find_complete_source)"; then
    TMP_FILE="$f"
    return 0
  fi
  error "The downloaded file is gone; delete the session and start over."
  return 1
}

get_source_sample_rate() {
  local probe="" rate="" dur="" key val
  SOURCE_SAMPLE_RATE=""
  SOURCE_DURATION=""

  if ! probe="$(ffprobe -v error -select_streams a:0 \
    -show_entries stream=sample_rate:format=duration -of default=nw=1 "$TMP_FILE" 2>/dev/null)"; then
    warning "ffprobe failed; keeping the encoder's default sample rate."
    return 0
  fi

  while IFS='=' read -r key val; do
    case "$key" in
    sample_rate) rate="$val" ;;
    duration) dur="$val" ;;
    esac
  done <<<"$probe"

  if is_int "$rate" && [ "$rate" -ge 8000 ] && [ "$rate" -le 384000 ]; then
    SOURCE_SAMPLE_RATE="$rate"
    info "Source sample rate: ${SOURCE_SAMPLE_RATE} Hz"
  else
    warning "Unusable source sample rate ('${rate:-none}'); using the encoder default."
  fi

  # Needed to turn ffmpeg's elapsed time into a percentage.
  if is_num "$dur" && [ "${dur%.*}" -gt 0 ] 2>/dev/null; then
    SOURCE_DURATION="$dur"
  fi
}

# ============================================================
# Normalisation
# ============================================================
# Sets LOUDNORM_FILTER on success.
build_two_pass_filter() {
  local raw="$WORK_DIR/loudnorm_raw.txt" json="$WORK_DIR/loudnorm.json"
  LOUDNORM_FILTER=""
  RG_LOUDNESS=""
  RG_PEAK_DB=""

  if ! run_with_progress "Analysing loudness..." "$raw" ffmpeg analyse \
    "${FFMPEG_ANALYZE[@]}" -progress pipe:2 -i "$TMP_FILE" \
    -af "loudnorm=I=$TARGET_LUFS:TP=$TARGET_TP:LRA=$TARGET_LRA:print_format=json" \
    -f null -; then
    warning "Loudness analysis failed; falling back to one-pass."
    return 1
  fi

  awk '/^[[:space:]]*\{/{f=1} f{print} f&&/^[[:space:]]*\}/{exit}' "$raw" >"$json" || true
  if [ ! -s "$json" ]; then
    warning "No loudnorm JSON in the analysis output; falling back to one-pass."
    return 1
  fi

  local mi mtp mlra mthr off
  mi="$(jq -r '.input_i // empty' "$json" 2>/dev/null || true)"
  mtp="$(jq -r '.input_tp // empty' "$json" 2>/dev/null || true)"
  mlra="$(jq -r '.input_lra // empty' "$json" 2>/dev/null || true)"
  mthr="$(jq -r '.input_thresh // empty' "$json" 2>/dev/null || true)"
  off="$(jq -r '.target_offset // empty' "$json" 2>/dev/null || true)"

  # -inf (digital silence) and "null" would make ffmpeg fail with a cryptic
  # error, so validate before building the filter.
  local v
  for v in "$mi" "$mtp" "$mlra" "$mthr" "$off"; do
    if ! is_num "$v"; then
      warning "Analysis returned a non-numeric value ('${v:-empty}'); falling back to one-pass."
      return 1
    fi
  done

  # ReplayGain is measured, not guessed: the report already says what the file
  # will be. loudnorm prints output_i/output_tp for the pass it just predicted;
  # when only the input side is there, a linear pass is a pure gain, so the
  # output peak is the input peak moved by the gain that reaches the target.
  local oi otp
  oi="$(jq -r '.output_i // empty' "$json" 2>/dev/null || true)"
  otp="$(jq -r '.output_tp // empty' "$json" 2>/dev/null || true)"
  if is_num "$oi" && is_num "$otp"; then
    RG_LOUDNESS="$oi"
    RG_PEAK_DB="$otp"
  else
    RG_LOUDNESS="$TARGET_LUFS"
    RG_PEAK_DB="$(awk -v tp="$mtp" -v i="$mi" -v t="$TARGET_LUFS" 'BEGIN { printf "%.2f", tp + (t - i) }')"
  fi

  LOUDNORM_FILTER="loudnorm=I=$TARGET_LUFS:TP=$TARGET_TP:LRA=$TARGET_LRA:measured_I=$mi:measured_TP=$mtp:measured_LRA=$mlra:measured_thresh=$mthr:offset=$off:linear=true"
  return 0
}

normalize_audio() {
  section "Normalising Audio"

  # A one-pass run measures nothing, so it must not leave an older track's
  # numbers behind to be tagged onto this file.
  RG_LOUDNESS=""
  RG_PEAK_DB=""
  local one_pass_filter="loudnorm=I=$TARGET_LUFS:TP=$TARGET_TP:LRA=$TARGET_LRA"
  local log="$WORK_DIR/normalize.log" pass="one-pass"

  rm -f "$NORMALIZED_FILE"

  if [ "$HAVE_JQ" -eq 1 ] && [ "$ONE_PASS" -eq 0 ]; then
    if build_two_pass_filter; then
      pass="two-pass"
    fi
  fi
  [ "$pass" = "two-pass" ] || LOUDNORM_FILTER="$one_pass_filter"

  local -a args
  args=(
    -y -progress pipe:1 -i "$TMP_FILE"
    -af "$LOUDNORM_FILTER"
    "${OUT_CODEC_ARGS[@]}" "${OUT_FILE_ARGS[@]}"
  )
  if [ -n "${OUT_SAMPLE_RATE:-}" ]; then
    args+=(-ar "$OUT_SAMPLE_RATE")
  elif [ -n "$SOURCE_SAMPLE_RATE" ]; then
    args+=(-ar "$SOURCE_SAMPLE_RATE")
  fi
  args+=("$NORMALIZED_FILE")

  if ! run_with_progress "Encoding ($pass loudnorm, target ${TARGET_LUFS} LUFS)..." "$log" ffmpeg encode \
    "${FFMPEG[@]}" "${args[@]}"; then
    error "Normalisation failed."
    return 1
  fi

  if [ ! -s "$NORMALIZED_FILE" ]; then
    error "Normalisation produced no output."
    return 1
  fi

  success "Normalisation complete ($pass)."
}

# ============================================================
# ReplayGain
# ============================================================
# ReplayGain 2.0 tags for the file that was just written, relative to this
# run's own target loudness (TARGET_LUFS, -9 by default): a player that also
# uses -9 as its reference leaves the library alone, and one with a different
# reference still gets an honest number for the file.
#
# Only track values are written. Album gain would need every track of the album
# measured before the first file is tagged, which a one-track-at-a-time
# pipeline does not have. R128_TRACK_GAIN is left out on purpose: it is defined
# against -23 LUFS, so writing it beside a -9 reference would make Opus players
# 14 dB quieter than every other format in the same library.
#
# Sets RG_GAIN, RG_PEAK and RG_REF (empty when there is nothing measured, as in
# --one-pass, --stream-fd, or a run without jq).
RG_GAIN="" RG_PEAK="" RG_REF=""
replaygain_values() {
  RG_GAIN="" RG_PEAK="" RG_REF=""
  [ "$RG_ENABLED" -eq 1 ] || return 0
  [ -n "$RG_LOUDNESS" ] && [ -n "$RG_PEAK_DB" ] || return 0
  is_num "$RG_LOUDNESS" && is_num "$RG_PEAK_DB" || return 0
  RG_GAIN="$(awk -v ref="$TARGET_LUFS" -v got="$RG_LOUDNESS" 'BEGIN { printf "%.2f dB", ref - got }')"
  # Peak is a linear amplitude in ReplayGain, not dBTP.
  RG_PEAK="$(awk -v tp="$RG_PEAK_DB" 'BEGIN { printf "%.6f", 10 ^ (tp / 20) }')"
  RG_REF="$(awk -v l="$TARGET_LUFS" 'BEGIN { printf "%.1f LUFS", l }')"
}

# ============================================================
# Cover art
# ============================================================
prepare_thumbnail() {
  local input="$1" output="$WORK_DIR/cover.jpg"

  rm -f "$output"

  # ImageMagick gives the nicest result, but it is not a dependency of the
  # script: ffmpeg is always present, so a container without magick still gets
  # covers. ffmpeg flattens transparency onto black, like -alpha remove below.
  if [ "$HAVE_IM" -eq 1 ] && "$IM_CMD" "$input" \
    -resize "${ARTWORK_SIZE}x${ARTWORK_SIZE}>" \
    -background black -alpha remove -alpha off \
    -strip -quality 90 \
    "$output" 2>/dev/null && [ -s "$output" ]; then
    TMP_THUMB="$output"
    return 0
  fi

  if "${FFMPEG[@]}" -y -i "$input" \
    -vf "scale='min(iw,${ARTWORK_SIZE})':'min(ih,${ARTWORK_SIZE})':force_original_aspect_ratio=decrease,format=yuvj420p" \
    -frames:v 1 -q:v 3 "$output" 2>/dev/null && [ -s "$output" ]; then
    TMP_THUMB="$output"
    return 0
  fi

  TMP_THUMB=""
  return 1
}

try_download_thumb() {
  local url="$1" dest="$WORK_DIR/thumb_raw" ext=""

  [ "$HAVE_CURL" -eq 1 ] || return 1
  rm -f "$dest"

  if ! curl -fsSL --max-time 60 --retry 2 --max-filesize 20000000 \
    "$url" -o "$dest" 2>/dev/null; then
    rm -f "$dest"
    return 1
  fi
  [ -s "$dest" ] || {
    rm -f "$dest"
    return 1
  }

  ext="$(detect_image_ext "$dest" "$url")"
  [ -n "$ext" ] || ext="img"
  mv "$dest" "$dest.$ext" || return 1
  TMP_THUMB="$dest.$ext"
  return 0
}

preview_thumbnail() {
  [ "$HAVE_PREVIEW" -eq 1 ] || return 0
  [ -t 1 ] || return 0
  if command -v timg >/dev/null 2>&1; then
    timg "$1" 2>/dev/null || true
  else
    chafa "$1" 2>/dev/null || true
  fi
}

download_thumbnail() {
  TMP_THUMB=""

  if [ "$NO_ART" -eq 1 ]; then
    info "Cover art disabled."
    return 0
  fi

  if [ -n "$RAW_THUMB" ] && [ "$RAW_THUMB" != "NA" ]; then
    if try_download_thumb "$RAW_THUMB"; then
      if prepare_thumbnail "$TMP_THUMB"; then
        preview_thumbnail "$TMP_THUMB"
        if [ "$AUTO" -eq 1 ] || confirm "Use this thumbnail?" "Y"; then
          return 0
        fi
      else
        warning "Could not process artwork."
      fi
      TMP_THUMB=""
    else
      warning "Couldn't download artwork from the source."
    fi
  fi

  # Fall back to a custom URL only when someone is at the keyboard.
  if [ "$AUTO" -eq 0 ]; then
    local url
    url="$(prompt_default "Thumbnail URL (leave blank for none)")"
    if [ -n "$url" ]; then
      if try_download_thumb "$url" && prepare_thumbnail "$TMP_THUMB"; then
        preview_thumbnail "$TMP_THUMB"
      else
        warning "Couldn't use that artwork."
        TMP_THUMB=""
      fi
    fi
  fi
}

# ============================================================
# Lyrics
# ============================================================
# LRCLIB is free and needs no key. Only plain text is embedded: an ID3 USLT or
# a Vorbis LYRICS comment cannot carry timestamps, and a .lrc sidecar would put
# a second file beside every track.
LYRICS_TEXT=""

fetch_lyrics() {
  LYRICS_TEXT=""
  [ "$NO_LYRICS" -eq 0 ] || return 0
  [ -n "$TITLE" ] || return 0
  command -v curl >/dev/null 2>&1 || return 0

  local raw="$WORK_DIR/lyrics.json"
  local -a query=(
    --get --silent --show-error --location --max-time 20
    --user-agent "audioDL/$VERSION"
    --data-urlencode "track_name=$TITLE"
  )
  [ -n "$ARTIST" ] && query+=(--data-urlencode "artist_name=$ARTIST")
  [ -n "$ALBUM" ] && query+=(--data-urlencode "album_name=$ALBUM")

  # The service answers 503 when it is busy; one retry covers most of that
  # without delaying a download for long.
  local attempt=1
  while ! curl --fail "${query[@]}" "https://lrclib.net/api/search" -o "$raw" 2>/dev/null; do
    if [ "$attempt" -ge 2 ]; then
      info "Lyrics lookup failed; continuing without them."
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 2
  done
  [ -s "$raw" ] || return 0

  local text=""
  if [ "$HAVE_JQ" -eq 1 ]; then
    text="$(jq -r '
      (if type == "array" then . else [.] end)
      | map(select(((.plainLyrics // "") | length) > 0 or ((.syncedLyrics // "") | length) > 0))
      | .[0] // {}
      | (.plainLyrics // ((.syncedLyrics // "") | gsub("\\[[0-9:.]+\\] *"; "")))
      // empty
    ' "$raw" 2>/dev/null || true)"
  elif command -v python3 >/dev/null 2>&1; then
    text="$(python3 - "$raw" <<'PY' 2>/dev/null || true
import json
import re
import sys

try:
    data = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    data = []
if isinstance(data, dict):
    data = [data]
for item in data if isinstance(data, list) else []:
    plain = (item.get("plainLyrics") or "").strip()
    if plain:
        print(plain)
        break
    synced = item.get("syncedLyrics") or ""
    if synced.strip():
        print(re.sub(r"\[[0-9:.]+\] *", "", synced).strip())
        break
PY
)"
  fi

  [ -n "$text" ] || {
    info "No lyrics found."
    return 0
  }
  LYRICS_TEXT="$text"
  info "Lyrics found ($(printf '%s\n' "$text" | wc -l | tr -d ' ') lines)."
}

# One tag write for every container mutagen understands; WAV has nowhere to put
# lyrics, so it is skipped there. Failure is never fatal: the audio is already
# encoded and tagged at this point.
tag_lyrics() {
  local file="$1"
  [ -n "${LYRICS_TEXT:-}" ] || return 0
  if ! command -v python3 >/dev/null 2>&1 || ! python3 -c 'import mutagen' >/dev/null 2>&1; then
    warning "mutagen is missing; lyrics were not embedded."
    return 0
  fi
  python3 - "$file" "$LYRICS_TEXT" <<'PY'
import os
import sys

path, text = sys.argv[1], sys.argv[2]
ext = os.path.splitext(path)[1].lower()

if ext == ".wav":
    sys.exit(0)

if ext == ".mp3":
    from mutagen.id3 import ID3, USLT
    from mutagen.mp3 import MP3

    audio = MP3(path)
    tags = audio.tags if audio.tags is not None else ID3()
    tags.delall("USLT")
    tags.add(USLT(encoding=3, lang="eng", desc="", text=text))
    audio.tags = tags
    audio.save(v2_version=3)
elif ext == ".m4a":
    from mutagen.mp4 import MP4

    audio = MP4(path)
    audio["\xa9lyr"] = [text]
    audio.save()
elif ext == ".flac":
    from mutagen.flac import FLAC

    audio = FLAC(path)
    audio["LYRICS"] = [text]
    audio.save()
elif ext == ".opus":
    from mutagen.oggopus import OggOpus

    audio = OggOpus(path)
    audio["LYRICS"] = [text]
    audio.save()
PY
}

# A tag holds a list of artists, but a source reports a collaboration as one
# string ("A, B"). Left alone, every player shows one artist whose name happens
# to contain a comma, and Jellyfin files the album under that one name - so the
# separators become separate values for the artist and the album artist alike,
# trimmed and de-duplicated. WAV is skipped: its RIFF INFO chunk has room for a
# single value.
tag_artists() {
  local file="$1"
  [ -n "${ARTIST:-}" ] || return 0
  case "$ARTIST" in
  *,* | *';'* | *，* | *'；'* | *、*) ;;
  *) return 0 ;;
  esac
  if ! command -v python3 >/dev/null 2>&1 || ! python3 -c 'import mutagen' >/dev/null 2>&1; then
    warning "mutagen is missing; the artist tag keeps both names in one string."
    return 0
  fi
  python3 - "$file" "$ARTIST" <<'PY' || warning "Could not split the artist tag."
import os
import re
import sys

path, artist = sys.argv[1], sys.argv[2]
names = []
for name in re.split(r"[,;，；、]", artist):
    name = name.strip(" \t\u3000")
    if name and name not in names:
        names.append(name)
if len(names) < 2:
    sys.exit(0)

ext = os.path.splitext(path)[1].lower()

if ext == ".mp3":
    from mutagen.id3 import ID3, TPE1, TPE2

    audio = ID3(path)
    audio.delall("TPE1")
    audio.add(TPE1(encoding=3, text=names))
    audio.delall("TPE2")
    audio.add(TPE2(encoding=3, text=names))
    # The same version ffmpeg writes for MP3 (OUT_TAG_ARGS), so the file does
    # not end up carrying two tag versions.
    audio.save(v2_version=3)
elif ext == ".m4a":
    from mutagen.mp4 import MP4, MP4FreeForm

    audio = MP4(path)
    audio["\xa9ART"] = names
    # The freeform tag is where taggers (MusicBrainz Picard, foobar2000) keep
    # the unsplit list, for players that never look past the first ©ART atom.
    audio["----:com.apple.iTunes:ARTISTS"] = [MP4FreeForm(n.encode("utf-8")) for n in names]
    audio["aART"] = names
    audio.save()
elif ext == ".flac":
    from mutagen.flac import FLAC

    audio = FLAC(path)
    audio["ARTIST"] = names
    audio["ALBUMARTIST"] = names
    audio.save()
elif ext == ".opus":
    from mutagen.oggopus import OggOpus

    audio = OggOpus(path)
    audio["ARTIST"] = names
    audio["ALBUMARTIST"] = names
    audio.save()
PY
}

# MBIDs for the containers ffmpeg cannot carry them in: the MP4 muxer drops
# unknown -metadata keys and the Ogg muxer drops metadata altogether. MP3 and
# FLAC keep the keys embed_metadata passes to ffmpeg, so they are left alone.
tag_musicbrainz() {
  local file="$1"
  [ -n "${MB_RECORDING_ID:-}" ] || return 0
  case "$file" in
  *.m4a | *.opus) ;;
  *) return 0 ;;
  esac
  if ! command -v python3 >/dev/null 2>&1 || ! python3 -c 'import mutagen' >/dev/null 2>&1; then
    warning "mutagen is missing; MusicBrainz IDs were not embedded."
    return 0
  fi
  python3 - "$file" "$MB_RECORDING_ID" "${MB_RELEASE_ID:-}" "${MB_RELEASE_GROUP_ID:-}" \
    "${MB_ARTIST_ID:-}" "${MB_ALBUM_ARTIST_ID:-}" "${MB_TRACK_ID:-}" \
    "${MB_TRACK_TOTAL:-}" "${TRACK:-}" "${MB_DISC_NUMBER:-}" "${MB_DISC_TOTAL:-}" <<'PY'
import os
import sys

(path, recording, release, release_group, artist, album_artist, track_id,
 total_tracks, track, disc, disc_total) = (sys.argv[1:] + [""] * 11)[:11]
ext = os.path.splitext(path)[1].lower()

if ext == ".m4a":
    from mutagen.mp4 import MP4, MP4FreeForm

    audio = MP4(path)

    def put(name, value):
        if value:
            audio["----:com.apple.iTunes:" + name] = [MP4FreeForm(value.encode("utf-8"))]

    # The atom names Picard and the players that read its tags use.
    put("MusicBrainz Track Id", recording)
    put("MusicBrainz Release Track Id", track_id)
    put("MusicBrainz Album Id", release)
    put("MusicBrainz Release Group Id", release_group)
    put("MusicBrainz Artist Id", artist)
    put("MusicBrainz Album Artist Id", album_artist)
    audio.save()
elif ext == ".opus":
    from mutagen.oggopus import OggOpus

    audio = OggOpus(path)
    for key, value in (
        ("MUSICBRAINZ_TRACKID", recording),
        ("MUSICBRAINZ_RELEASETRACKID", track_id),
        ("MUSICBRAINZ_ALBUMID", release),
        ("MUSICBRAINZ_RELEASEGROUPID", release_group),
        ("MUSICBRAINZ_ARTISTID", artist),
        ("MUSICBRAINZ_ALBUMARTISTID", album_artist),
        ("TRACKTOTAL", total_tracks),
        ("TRACKNUMBER", track),
        ("DISCNUMBER", disc),
        ("DISCTOTAL", disc_total),
    ):
        if value:
            audio[key] = [value]
    audio.save()
PY
}

# ReplayGain in the container that has nowhere else to put it: the MP4 muxer
# drops unknown -metadata keys, so the freeform atoms Picard and foobar2000 use
# are written by mutagen. MP3 and FLAC were tagged by ffmpeg, Opus by tag_opus,
# and WAV cannot carry them at all.
tag_replaygain() {
  local file="$1"
  [ -n "${RG_GAIN:-}" ] || return 0
  case "$file" in
  *.m4a) ;;
  *) return 0 ;;
  esac
  if ! command -v python3 >/dev/null 2>&1 || ! python3 -c 'import mutagen' >/dev/null 2>&1; then
    warning "mutagen is missing; ReplayGain tags were not embedded."
    return 0
  fi
  python3 - "$file" "$RG_GAIN" "$RG_PEAK" "$RG_REF" <<'PY'
import sys

from mutagen.mp4 import MP4, MP4FreeForm

path, gain, peak, reference = (sys.argv[1:] + [""] * 4)[:4]
audio = MP4(path)
for name, value in (
    ("REPLAYGAIN_TRACK_GAIN", gain),
    ("REPLAYGAIN_TRACK_PEAK", peak),
    ("REPLAYGAIN_REFERENCE_LOUDNESS", reference),
):
    if value:
        audio["----:com.apple.iTunes:" + name] = [MP4FreeForm(value.encode("utf-8"))]
audio.save()
PY
}

# ============================================================
# Tags
# ============================================================
embed_metadata() {
  section "Embedding Metadata"

  local -a meta_args input_args map_args codec_args
  meta_args=(
    -metadata artist="$ARTIST"
    -metadata album="$ALBUM"
    -metadata album_artist="${ALBUM_ARTIST:-$ARTIST}"
    -metadata title="$TITLE"
    -metadata date="$RECORDING_DATE_ISO"
  )
  if [ -n "$TRACK" ]; then
    if is_int "${MB_TRACK_TOTAL:-}" && [ "$MB_TRACK_TOTAL" -gt 1 ]; then
      meta_args+=(-metadata track="$TRACK/$MB_TRACK_TOTAL")
    else
      meta_args+=(-metadata track="$TRACK")
    fi
  fi
  if is_int "${MB_DISC_NUMBER:-}" && [ "$MB_DISC_NUMBER" -ge 1 ]; then
    if is_int "${MB_DISC_TOTAL:-}" && [ "$MB_DISC_TOTAL" -ge "$MB_DISC_NUMBER" ]; then
      meta_args+=(-metadata disc="$MB_DISC_NUMBER/$MB_DISC_TOTAL")
    else
      meta_args+=(-metadata disc="$MB_DISC_NUMBER")
    fi
  fi
  # Optional: a run without --genre leaves ffmpeg's own empty genre alone.
  if [ -n "$GENRE" ]; then
    meta_args+=(-metadata genre="$GENRE")
  fi
  # MP3 and FLAC keep arbitrary keys; MP4 and Opus are handled by
  # tag_musicbrainz below, because their muxers drop these.
  if [ -n "${MB_RECORDING_ID:-}" ]; then
    meta_args+=(-metadata MUSICBRAINZ_TRACKID="$MB_RECORDING_ID")
    [ -n "${MB_RELEASE_ID:-}" ] && meta_args+=(-metadata MUSICBRAINZ_ALBUMID="$MB_RELEASE_ID")
    [ -n "${MB_RELEASE_GROUP_ID:-}" ] && meta_args+=(-metadata MUSICBRAINZ_RELEASEGROUPID="$MB_RELEASE_GROUP_ID")
    [ -n "${MB_ARTIST_ID:-}" ] && meta_args+=(-metadata MUSICBRAINZ_ARTISTID="$MB_ARTIST_ID")
    [ -n "${MB_ALBUM_ARTIST_ID:-}" ] && meta_args+=(-metadata MUSICBRAINZ_ALBUMARTISTID="$MB_ALBUM_ARTIST_ID")
    [ -n "${MB_TRACK_ID:-}" ] && meta_args+=(-metadata MUSICBRAINZ_RELEASETRACKID="$MB_TRACK_ID")
  fi
  # ReplayGain values describe the file this run wrote, so they are only
  # available once the analysis pass has measured it. ffmpeg writes them as
  # TXXX frames (MP3) or Vorbis comments (FLAC); M4A and Opus are tagged after
  # the encode, further down.
  replaygain_values
  if [ -n "$RG_GAIN" ] && { [ "$OUT_EXT" = mp3 ] || [ "$OUT_EXT" = flac ]; }; then
    meta_args+=(
      -metadata REPLAYGAIN_TRACK_GAIN="$RG_GAIN"
      -metadata REPLAYGAIN_TRACK_PEAK="$RG_PEAK"
      -metadata REPLAYGAIN_REFERENCE_LOUDNESS="$RG_REF"
    )
  fi

  # -map_metadata -1 keeps the result deterministic instead of inheriting
  # whatever tags the source happen to carry.
  input_args=(-i "$NORMALIZED_FILE")
  map_args=(-map_metadata -1 -map 0:a)
  codec_args=("${OUT_TAG_ARGS[@]}")

  if [ "$OUT_MUX_ART" -eq 1 ] && [ -n "$TMP_THUMB" ] && [ -s "$TMP_THUMB" ]; then
    input_args+=(-i "$TMP_THUMB")
    map_args+=(-map 1:v)
    codec_args+=(
      -c:v mjpeg
      -disposition:v:0 attached_pic
      -metadata:s:v title="Album cover"
      -metadata:s:v comment="Cover (front)"
    )
  fi

  rm -f "$FINAL_TMP"
  if ! run_logged "Writing tags..." "$WORK_DIR/embed.log" \
    "${FFMPEG[@]}" -y "${input_args[@]}" "${map_args[@]}" "${codec_args[@]}" \
    "${meta_args[@]}" "$FINAL_TMP"; then
    error "Writing the output file failed."
    return 1
  fi
  if [ "$OUT_POST_TAG" = opus ] && ! tag_opus "$FINAL_TMP"; then
    error "Writing the Opus tags failed."
    return 1
  fi
  tag_artists "$FINAL_TMP" || true
  tag_lyrics "$FINAL_TMP" || true
  tag_musicbrainz "$FINAL_TMP" || true
  tag_replaygain "$FINAL_TMP" || true

  if [ ! -s "$FINAL_TMP" ]; then
    error "Output file is empty."
    return 1
  fi

  # Move into place atomically: an interrupted run can never leave a
  # half-written file inside the library.
  if ! mv -f "$FINAL_TMP" "$FINAL_FILE"; then
    error "Could not move the file into $FINAL_FILE"
    return 1
  fi

  success "Metadata embedded."
}

# ============================================================
# Streaming (--stream-fd)
# ============================================================

# ffmpeg only writes ID3v2 when it can seek back to patch the header, so an MP3
# on a pipe arrives untagged. The frames are written here instead, in front of
# the audio, using the same values the library tagger would use.
write_id3_tag() {
  if ! command -v python3 >/dev/null 2>&1; then
    warning "python3 is missing; the streamed MP3 will carry no tags."
    return 1
  fi

  python3 - "$ARTIST" "$ALBUM" "$TITLE" "${TRACK:-}" "$RECORDING_DATE_ISO" "${TMP_THUMB:-}" "$GENRE" >&"$STREAM_FD" <<'PY'
import os
import re
import sys

artist, album, title, track, date, cover, genre = (sys.argv[1:8] + [""] * 7)[:7]

# One TPE1 frame in ID3v2.3, so several artists are separated by "/" inside it.
# TPE2 follows the same shape, so the album artist is a list there too.
names = []
for name in re.split(r"[,;，；、]", artist):
    name = name.strip(" \t\u3000")
    if name and name not in names:
        names.append(name)
artist = "/".join(names) or artist.strip()


def frame(fid, value):
    """ID3v2.3 text frame, UTF-16 with a BOM (encoding byte 0x01)."""
    if not value:
        return b""
    payload = b"\x01\xff\xfe" + value.encode("utf-16-le")
    return fid.encode("ascii") + len(payload).to_bytes(4, "big") + b"\x00\x00" + payload


parts = [
    frame("TPE1", artist),
    frame("TPE2", artist),
    frame("TALB", album),
    frame("TIT2", title),
    frame("TRCK", track),
]
if genre:
    parts.append(frame("TCON", genre))
year, month, day = (date.split("-") + ["", "", ""])[:3]
if year:
    parts.append(frame("TYER", year))
if month and day:
    parts.append(frame("TDAT", f"{day}{month}"))

if cover and os.path.isfile(cover) and os.path.getsize(cover) > 0:
    with open(cover, "rb") as fh:
        image = fh.read()
    # APIC: Latin-1 encoding, MIME, type 3 (front cover), empty description.
    payload = b"\x00image/jpeg\x00\x03\x00" + image
    parts.append(b"APIC" + len(payload).to_bytes(4, "big") + b"\x00\x00" + payload)

frames = b"".join(parts)
# A little padding so a player that rewrites the tag has room to work in.
size = len(frames) + 256
header = b"ID3\x03\x00\x00" + bytes(
    [(size >> 21) & 0x7F, (size >> 14) & 0x7F, (size >> 7) & 0x7F, size & 0x7F]
)
sys.stdout.buffer.write(header + frames + b"\x00" * 256)
PY
}

# Opus tags and cover art: ffmpeg's Ogg muxer writes neither, so mutagen
# rewrites the comment header and adds the METADATA_BLOCK_PICTURE afterwards.
tag_opus() {
  local file="$1"
  python3 - "$file" "$ARTIST" "${ALBUM_ARTIST:-$ARTIST}" "$ALBUM" "$TITLE" "${TRACK:-}" "$RECORDING_DATE_ISO" "${TMP_THUMB:-}" "$GENRE" \
    "${RG_GAIN:-}" "${RG_PEAK:-}" "${RG_REF:-}" <<'PY'
import base64
import os
import sys

from mutagen.flac import Picture
from mutagen.oggopus import OggOpus

(path, artist, album_artist, album, title, track, date, cover, genre, rg_gain,
 rg_peak, rg_ref) = (sys.argv[1:13] + [""] * 12)[:12]
audio = OggOpus(path)


def put(key, value):
    if value:
        audio[key] = [value]


put("ARTIST", artist)
put("ALBUMARTIST", album_artist or artist)
put("ALBUM", album)
put("TITLE", title)
put("TRACKNUMBER", track)
put("DATE", date)
put("GENRE", genre)
put("REPLAYGAIN_TRACK_GAIN", rg_gain)
put("REPLAYGAIN_TRACK_PEAK", rg_peak)
put("REPLAYGAIN_REFERENCE_LOUDNESS", rg_ref)

if cover and os.path.isfile(cover) and os.path.getsize(cover) > 0:
    picture = Picture()
    picture.type = 3  # front cover
    picture.mime = "image/jpeg"
    picture.desc = ""
    with open(cover, "rb") as handle:
        picture.data = handle.read()
    audio["metadata_block_picture"] = [base64.b64encode(picture.write()).decode("ascii")]

audio.save()
PY
}

# Encode loudnorm + tags (+ cover) in one pass straight to the descriptor. The
# three-stage library pipeline cannot be reused: stages 2 and 3 both need to
# reopen the file, which a pipe does not allow.
stream_audio() {
  section "Streaming Audio"

  local filter="loudnorm=I=$TARGET_LUFS:TP=$TARGET_TP:LRA=$TARGET_LRA"
  local -a args=(-y -i "$TMP_FILE") maps=(-map 0:a -map_metadata -1)
  local -a meta=(
    -metadata artist="$ARTIST"
    -metadata album="$ALBUM"
    -metadata album_artist="${ALBUM_ARTIST:-$ARTIST}"
    -metadata title="$TITLE"
    -metadata date="$RECORDING_DATE_ISO"
  )
  [ -n "$TRACK" ] && meta+=(-metadata track="$TRACK")
  [ -n "$GENRE" ] && meta+=(-metadata genre="$GENRE")

  # MP3 gets its cover from the hand-written APIC frame below: the muxer
  # refuses a picture stream when ID3v2 writing is disabled, and it has to be
  # disabled for the header written here to be the only one in the file.
  if [ "$OUT_EXT" != mp3 ] && [ "$OUT_MUX_ART" -eq 1 ] && [ -n "${TMP_THUMB:-}" ] && [ -s "$TMP_THUMB" ]; then
    args+=(-i "$TMP_THUMB")
    maps+=(-map 1:v -c:v mjpeg -disposition:v:0 attached_pic)
  fi

  if [ "$OUT_EXT" = mp3 ]; then
    write_id3_tag || warning "Streaming the MP3 without tags."
  fi

  local -a rate=()
  [ -n "$SOURCE_SAMPLE_RATE" ] && rate=(-ar "$SOURCE_SAMPLE_RATE")

  # ffmpeg's own position in the song, so the queue can show how much is left.
  # The encoder runs ahead of the pipe, so this leads the byte counter slightly.
  local prog="$WORK_DIR/stream.progress" watcher=""
  if [ "$JSON" -eq 1 ] && is_num "${SOURCE_DURATION:-}"; then
    : >"$prog"
    (
      local last="" p=""
      while :; do
        p="$(ffmpeg_progress_pct "$prog" 2>/dev/null || true)"
        if [ -n "$p" ] && [ "$p" != "$last" ]; then
          json_emit stage i#="${CUR_I:-0}" stage=encode pct#="$p"
          last="$p"
        fi
        sleep 0.5
      done
    ) &
    watcher=$!
  fi

  if ! "${FFMPEG[@]}" "${args[@]}" -progress "$prog" -stats_period 0.5 "${maps[@]}" \
    -af "$filter" "${meta[@]}" \
    "${OUT_CODEC_ARGS[@]}" "${OUT_STREAM_ARGS[@]}" "${rate[@]}" \
    "pipe:$STREAM_FD" 2>"$WORK_DIR/stream.log"; then
    [ -n "$watcher" ] && kill "$watcher" 2>/dev/null
    error "Streaming failed."
    tail -n 5 "$WORK_DIR/stream.log" >&2 || true
    return 1
  fi

  if [ -n "$watcher" ]; then
    kill "$watcher" 2>/dev/null || true
    wait "$watcher" 2>/dev/null || true
    json_emit stage i#="${CUR_I:-0}" stage=encode pct#=100
  fi

  success "Stream complete."
}

# ============================================================
# Verification
# ============================================================
show_output_info() {
  section "Output Information"

  if [ ! -s "$FINAL_FILE" ]; then
    error "Output file is missing or empty."
    return 1
  fi
  if ! command -v ffprobe >/dev/null 2>&1; then
    warning "ffprobe not installed; skipping detailed output info."
    return 0
  fi

  info "Verifying generated file..."
  local raw codec="" sr="" dur="" br="" ch=""
  raw="$(ffprobe -v error -select_streams a:0 \
    -show_entries stream=codec_name,sample_rate,channels:format=duration,bit_rate \
    -of default=nw=1 "$FINAL_FILE" 2>/dev/null || true)"

  while IFS='=' read -r k v; do
    case "$k" in
    codec_name) codec="$v" ;;
    sample_rate) sr="$v" ;;
    channels) ch="$v" ;;
    duration) dur="$v" ;;
    bit_rate) br="$v" ;;
    esac
  done <<<"$raw"

  if [ -z "$codec" ]; then
    error "ffprobe cannot read the output file."
    return 1
  fi

  local br_kbps="?"
  if is_int "$br"; then
    br_kbps=$((br / 1000))
  fi

  local dur_s="?"
  if is_num "$dur"; then
    dur_s="$(printf '%.1f' "$dur")"
  fi

  print_kv "Codec" "${codec:-unknown}"
  print_kv "Sample Rate" "${sr:-?} Hz"
  print_kv "Channels" "${ch:-?}"
  print_kv "Duration" "${dur_s} s"
  print_kv "Bitrate" "${br_kbps} kbps"
  print_kv "Size" "$(human_size "$(wc -c <"$FINAL_FILE")")"
  return 0
}

print_final() {
  if [ "$HAVE_GUM" -eq 1 ] && [ -t 1 ]; then
    gum style --border double --padding "1 2" --bold \
      "[ok] Download completed

Artist: $ARTIST
Album:  $ALBUM
Title:  $TITLE
Track:  ${TRACK:--}
LUFS:   $TARGET_LUFS

Saved:
$FINAL_FILE"
  else
    local line="${CYAN}${BOLD}==============================================================${RESET}"
    printf '%s\n' "$line"
    printf '  %s Download completed\n' "${GREEN}[ok]${RESET}"
    print_label "Artist" "$ARTIST"
    print_label "Album" "$ALBUM"
    print_label "Title" "$TITLE"
    print_label "Track" "${TRACK:--}"
    print_label "LUFS" "$TARGET_LUFS"
    printf '  Saved:\n'
    printf '    %s\n' "$FINAL_FILE"
    printf '%s\n' "$line"
  fi
}

# ============================================================
# Pipeline (one track)
# Returns 0 = done, 2 = skipped, other = failure
# ============================================================
run_pipeline() {
  while :; do
    case "$(get_checkpoint)" in

    metadata)
      musicbrainz_lookup
      autofill_or_prompt_metadata
      compute_paths || return 1
      save_session
      set_checkpoint "paths"
      ;;

    paths)
      local rc=0
      show_summary || rc=$?
      [ "$rc" -eq 0 ] || return "$rc"
      check_existing || rc=$?
      if [ "$rc" -eq 2 ]; then
        rm -rf "$SESSION_DIR"
        SUCCESS=0
        COMPLETED=1
        return 2
      fi
      # Propagate the status so a user abort (130) is not mistaken for a
      # per-track failure by the playlist loop.
      [ "$rc" -eq 0 ] || return "$rc"

      download_audio || return 1
      save_session
      set_checkpoint "downloaded"
      ;;

    downloaded)
      resolve_tmp_file || return 1
      get_source_sample_rate
      if [ "${STREAM_FD:-0}" -gt 0 ]; then
        set_checkpoint "stream-thumb"
      else
        normalize_audio || return 1
        save_session
        set_checkpoint "normalized"
      fi
      ;;

    stream-thumb)
      json_emit stage i#="${CUR_I:-1}" stage=art pct#=0
      download_thumbnail
      json_emit stage i#="${CUR_I:-1}" stage=art pct#=100
      save_session
      set_checkpoint "stream-encode"
      ;;

    stream-encode)
      json_emit stage i#="${CUR_I:-1}" stage=encode pct#=0
      stream_audio || return 1
      SUCCESS=1
      COMPLETED=1
      json_emit track i#="${CUR_I:-1}" stage=done path="" size#=0 \
        duration#="${SOURCE_DURATION%%.*}" lufs="${MEASURED_LUFS:-}" \
        title="$TITLE" artist="$ARTIST" album="$ALBUM"
      info "Stream finished (no library file written)."
      return 0
      ;;

    normalized)
      json_emit stage i#="${CUR_I:-1}" stage=art pct#=0
      download_thumbnail
      json_emit stage i#="${CUR_I:-1}" stage=art pct#=100
      save_session
      set_checkpoint "thumbnail"
      ;;

    thumbnail)
      json_emit stage i#="${CUR_I:-1}" stage=tags pct#=0
      fetch_lyrics || true
      embed_metadata || return 1
      if [ -n "${PREVIOUS_FILE:-}" ] && [ -f "$PREVIOUS_FILE" ] && [ "$PREVIOUS_FILE" != "$FINAL_FILE" ]; then
        rm -f "$PREVIOUS_FILE" && info "Removed the previous ${PREVIOUS_FILE##*.} copy."
      fi
      json_emit stage i#="${CUR_I:-1}" stage=tags pct#=100
      save_session
      set_checkpoint "embedded"
      ;;

    embedded)
      json_emit stage i#="${CUR_I:-1}" stage=verify pct#=0
      show_output_info || return 1
      json_emit stage i#="${CUR_I:-1}" stage=verify pct#=100
      index_add "${TRACK_KEY:-}" "$FINAL_FILE"
      SUCCESS=1
      COMPLETED=1
      # The resolved names are included so a caller that only handed over a URL
      # can label the result (queue row, webhook) without parsing the path.
      json_emit track i#="${CUR_I:-1}" stage=done path="$FINAL_FILE" \
        size#="$(stat -c %s "$FINAL_FILE" 2>/dev/null || printf 0)" \
        duration#="${SOURCE_DURATION%%.*}" lufs="${MEASURED_LUFS:-}" \
        title="$TITLE" artist="$ARTIST" album="$ALBUM"
      if [ "$JSON" -eq 1 ]; then print_final >&2; else print_final; fi
      return 0
      ;;

    none | "") set_checkpoint "metadata" ;;

    *)
      error "Unknown checkpoint: $(get_checkpoint)"
      return 1
      ;;
    esac
  done
}

# ============================================================
# Playlist mode# Some extractors (SoundCloud sets, notably) return no title in flat-playlist
# mode, so the URL slug is a far better label than the numeric track id.
title_from_url() {
  local u="${1:-}" slug first rest
  [[ "$u" == http* ]] || return 0
  u="${u%%\?*}"
  u="${u%%#*}"
  u="${u%/}"
  slug="${u##*/}"
  case "$slug" in
  "" | watch | video | embed | track | sets | playlist) return 0 ;;
  esac
  [[ "$slug" =~ [A-Za-z] ]] || return 0
  slug="${slug//-/ }"
  slug="${slug//_/ }"
  slug="$(printf '%s' "$slug" | tr -s ' ')"
  slug="${slug# }"
  first="${slug:0:1}"
  rest="${slug:1}"
  printf '%s%s' "$(printf '%s' "$first" | tr '[:lower:]' '[:upper:]')" "$rest"
}

# A track whose flat-playlist title is missing *and* whose URL carries no words
# (SoundCloud numbers some uploads as just the track id) would be known by its
# id alone: "2092076223" in the track list, in the file name and in the title
# tag. Those entries get a second yt-dlp pass - all of them in one call, and
# matched back by id - so the album is listed with real names.
resolve_missing_titles() {
  local -a urls=()
  local i id title
  for i in "${!ENTRIES_URL[@]}"; do
    id="${ENTRIES_ID[$i]}"
    title="${ENTRIES_TITLE[$i]}"
    # Falling back to the id is the signal that nothing better was available.
    if [ -n "$id" ] && [ "$title" = "$id" ]; then
      urls+=("${ENTRIES_URL[$i]}")
    fi
  done
  [ "${#urls[@]}" -gt 0 ] || return 0

  info "Looking up ${#urls[@]} track(s) that came without a title..."
  local out="$TMP_DIR/titles.tsv" err="$TMP_DIR/titles.err" rc=0
  local rid rtitle rdur
  : >"$out"
  : >"$err"
  if ! yt-dlp --no-warnings --skip-download \
    --print "%(id)s${SEP}%(title)s${SEP}%(duration)s" \
    ${COOKIE_ARGS[@]+"${COOKIE_ARGS[@]}"} -- "${urls[@]}" >"$out" 2>"$err"; then
    rc=$?
  fi
  [ "$rc" -eq 0 ] || warning "yt-dlp reported errors while looking up those titles."
  if [ ! -s "$out" ]; then
    warning "${#urls[@]} track(s) keep their id as the name: yt-dlp returned no title."
    show_log_tail "$err"
    return 0
  fi
  while IFS="$SEP" read -r rid rtitle rdur; do
    [ -n "${rid:-}" ] || continue
    for i in "${!ENTRIES_ID[@]}"; do
      [ "${ENTRIES_ID[$i]}" = "$rid" ] || continue
      if [ -n "${rtitle:-}" ] && [ "$rtitle" != "NA" ]; then
        ENTRIES_TITLE[$i]="$rtitle"
      fi
      if [ -n "${rdur:-}" ] && [ "$rdur" != "NA" ]; then
        ENTRIES_DUR[$i]="$rdur"
      fi
      break
    done
  done <"$out"
}

load_entries() {
  ENTRIES_URL=()
  ENTRIES_TITLE=()
  ENTRIES_ID=()
  ENTRIES_DUR=()
  local p_id p_title id title weburl rawurl dur eurl
  while IFS="$SEP" read -r p_id p_title id title weburl rawurl dur; do
    [ -n "${id:-}" ] || continue
    if [ "${title:-}" = "NA" ]; then
      title=""
    fi
    eurl="$(entry_url "$weburl" "$rawurl" "$id")"
    if [ -z "$title" ]; then
      title="$(title_from_url "$eurl")"
      [ -n "$title" ] || title="$id"
    fi
    ENTRIES_URL+=("$eurl")
    ENTRIES_TITLE+=("$title")
    ENTRIES_ID+=("${id:-$eurl}")
    ENTRIES_DUR+=("${dur:-NA}")
  done <"$TMP_DIR/probe.tsv"

  resolve_missing_titles
}

# The list is display only: select_tracks is called in $(...), so anything
# written to stdout here would be parsed back as track numbers.
render_track_list() {
  local i=1 t
  for t in "${ENTRIES_TITLE[@]}"; do
    printf '  %3d) %s\n' "$i" "$t" >&2
    i=$((i + 1))
  done
}

# "1-3,7" -> 1 2 3 7
parse_selection() {
  local spec="${1//,/ }" part a b i
  local total="${#ENTRIES_URL[@]}"
  for part in $spec; do
    if [[ "$part" =~ ^([0-9]+)-([0-9]+)$ ]]; then
      a=$((10#${BASH_REMATCH[1]}))
      b=$((10#${BASH_REMATCH[2]}))
      for ((i = a; i <= b; i++)); do
        if [ "$i" -ge 1 ] && [ "$i" -le "$total" ]; then
          printf '%s\n' "$i"
        fi
      done
    elif is_int "$part" && [ "$part" -ge 1 ] && [ "$part" -le "$total" ]; then
      printf '%s\n' "$((10#$part))"
    else
      warning "Ignoring invalid track selection: $part"
    fi
  done
}

# "   3) Title" -> 3
numbers_from_lines() {
  local line
  while IFS= read -r line; do
    if [[ "$line" =~ ^[[:space:]]*([0-9]+)\) ]]; then
      printf '%s\n' "$((10#${BASH_REMATCH[1]}))"
    fi
  done
}

# Keep only indices that exist, drop duplicates, preserve order. Everything
# downstream can then do arithmetic on the value without validating it again.
normalize_selection() {
  local total="$1" n i
  local -a out

  while IFS= read -r n; do
    [ -n "$n" ] || continue
    is_int "$n" || continue
    n=$((10#$n))
    [ "$n" -ge 1 ] && [ "$n" -le "$total" ] || continue
    local seen=0
    for i in ${out[@]+"${out[@]}"}; do
      if [ "$i" -eq "$n" ]; then
        seen=1
        break
      fi
    done
    if [ "$seen" -eq 1 ]; then
      continue
    fi
    out+=("$n")
  done

  for i in ${out[@]+"${out[@]}"}; do
    printf '%s\n' "$i"
  done
}

select_tracks() {
  local total="${#ENTRIES_URL[@]}"
  local spec="" i

  local -a opts

  if [ -n "${TRACK_SPEC:-}" ]; then
    parse_selection "$TRACK_SPEC"
    return 0
  fi

  if [ "$SELECT_ALL" -eq 1 ] || [ "$AUTO" -eq 1 ]; then
    for ((i = 1; i <= total; i++)); do
      printf '%s\n' "$i"
    done
    return 0
  fi

  echo >&2
  render_track_list
  echo >&2

  for ((i = 1; i <= total; i++)); do
    opts+=("$(printf '%3d) %s' "$i" "${ENTRIES_TITLE[$((i - 1))]}")")
  done

  if [ "$HAVE_GUM" -eq 1 ] && [ "${#opts[@]}" -gt 0 ]; then
    # The trailing || true keeps a cancelled picker from tripping the
    # ERR trap and printing a scary failure for a normal action.
    spec="$(gum choose --no-limit --header "Select tracks (space toggles, enter confirms)" "${opts[@]}" || true)"
    if [ -n "$spec" ]; then
      numbers_from_lines <<<"$spec"
      return 0
    fi
  fi

  if [ "$HAVE_FZF" -eq 1 ] && [ -t 0 ] && [ "${#opts[@]}" -gt 0 ]; then
    spec="$(fzf --multi --prompt "Tracks> " <<<"$(printf '%s\n' "${opts[@]}")" || true)"
    if [ -n "$spec" ]; then
      numbers_from_lines <<<"$spec"
      return 0
    fi
  fi

  printf 'Select tracks (e.g. 1-3,7 or "all") [all]: ' >&2

  read -r spec || spec=""
  spec="${spec:-all}"
  if [ "$spec" = "all" ]; then
    for ((i = 1; i <= total; i++)); do printf '%s\n' "$i"; done
    return 0
  fi
  parse_selection "$spec"
}

# ============================================================
# One playlist entry
# Runs inside a subshell (sequential loop or parallel worker) and uses BATCH_DIR
# from playlist_mode. Returns 0 = done, 2 = skipped, 130 = user abort.
# ============================================================
process_track() {
  local idx="$1" prc=0

  URL="${ENTRIES_URL[$((idx - 1))]}"
  ORIGIN_URL="$URL"
  ENTRY_NUM="$idx"
  TRACK_KEY="${ENTRIES_ID[$((idx - 1))]:-}"
  BATCH_MEMO="$BATCH_DIR/album"
  SUCCESS=0
  TRACK=""

  CUR_I="$idx"
  json_emit track i#="$idx" stage=start title="${ENTRIES_TITLE[$((idx - 1))]}"
  set_session_dir "$BATCH_DIR/track-$idx" || return 1
  if [ -f "$SESSION_FILE" ]; then
    load_session || return 1
    info "Resuming unfinished work for this track."
  else
    fetch_metadata || return 1
    save_session
    set_checkpoint "metadata"
  fi
  if [ "$TRACK_PREFIX_SET" -eq 0 ]; then
    TRACK_PREFIX=1
  fi
  # The flat-playlist id is the stable key; prefer it over whatever the
  # per-entry metadata call reports.
  TRACK_KEY="${ENTRIES_ID[$((idx - 1))]:-${TRACK_KEY:-}}"

  run_pipeline || prc=$?
  case "$prc" in
  2) json_emit track i#="$idx" stage=skipped ;; # stage=done comes from the pipeline
  0) ;;
  *) json_emit track i#="$idx" stage=failed ;; # partial downloads are kept
  esac
  if [ "$prc" -eq 0 ] && [ "$SUCCESS" -eq 1 ] && [ "$KEEP_TEMP" -eq 0 ]; then
    rm -rf "$SESSION_DIR"
  fi
  if [ "$prc" -eq 2 ]; then
    rm -rf "$SESSION_DIR"
  fi
  return "$prc"
}

playlist_mode() {
  load_entries

  section "Playlist"
  if [ -n "$PLAYLIST_TITLE" ]; then
    info "$PLAYLIST_TITLE"
  fi
  info "$((${#ENTRIES_URL[@]})) track(s) found"
  echo

  local selection
  selection="$(select_tracks | normalize_selection "${#ENTRIES_URL[@]}")"
  if [ -z "$selection" ]; then
    warning "No tracks selected."
    COMPLETED=1
    return 0
  fi

  local slug batch_dir total_selected idx n=0 ok=0 skipped=0 failed=0
  local rc=0 aborted=0 elapsed eta per total_run=0
  local -a failed_list=() skipped_list=() queue=()
  slug="$(sanitize_filename "${PLAYLIST_ID:-playlist}")"
  [ -n "$slug" ] || slug="playlist"
  batch_dir="${SESSION_DIR_ARG:-$STATE_DIR/batch}/$slug"
  BATCH_DIR="$batch_dir"
  # The report is this run's, not a leftover from an earlier batch.
  rm -f "$BATCH_DIR/mb-report.tsv" 2>/dev/null || true
  total_selected="$(printf '%s\n' "$selection" | grep -c . || true)"
  local entry_total="${#ENTRIES_URL[@]}"

  # A memo left behind by an earlier, finished batch would file this run's
  # tracks under the old album. A crashed batch still has track-* workspaces,
  # so only drop the memo when no session is waiting to be resumed.
  if [ -s "$batch_dir/album" ] &&
    [ -z "$(find "$batch_dir" -mindepth 1 -maxdepth 1 -type d -name 'track-*' -print -quit 2>/dev/null || true)" ]; then
    rm -f "$batch_dir/album"
  fi

  # Build the work list once: bad indices are dropped and entries already in
  # the library are skipped before any metadata fetch, so re-running a playlist
  # only pays for what is new. --force (or a retag override) bypasses this.
  while IFS= read -r idx; do
    [ -n "$idx" ] || continue
    if ! is_int "$idx" || [ "$idx" -lt 1 ] || [ "$idx" -gt "$entry_total" ]; then
      warning "Ignoring invalid track index: $idx"
      continue
    fi
    if [ "$FORCE" -eq 0 ] && [ -z "${ARTIST_OVERRIDE:-}" ] && [ -z "${ALBUM_OVERRIDE:-}" ] &&
      index_has "${ENTRIES_ID[$((idx - 1))]:-}"; then
      skipped=$((skipped + 1))
      skipped_list+=("$idx) ${ENTRIES_TITLE[$((idx - 1))]} (already imported)")
      info "Already imported: ${ENTRIES_TITLE[$((idx - 1))]}"
      continue
    fi
    queue+=("$idx")
  done <<<"$selection"
  total_run="${#queue[@]}"

  if [ "$JOBS" -gt 1 ] && [ "$total_run" -gt 1 ]; then
    # Each worker keeps its own log so the UI of one track cannot corrupt
    # another; the parent only polls the small status files.
    local results="$batch_dir/results"
    rm -rf "$results"
    mkdir -p "$results"
    info "Fetching $total_run track(s), $JOBS at a time"

    for idx in "${queue[@]}"; do
      (
        IN_SUBSHELL=1
        process_track "$idx" >"$results/$idx.log" 2>&1
        printf '%s' "$?" >"$results/$idx.rc"
      ) &
      # Keep the pool full; `jobs -r` only lists workers still running.
      while [ "$(jobs -pr | wc -l)" -ge "$JOBS" ]; do
        sleep 0.2
      done
    done

    local finished=0 alive=1 track_rc
    while [ "$finished" -lt "$total_run" ] && [ "$alive" -gt 0 ]; do
      finished=0
      for idx in "${queue[@]}"; do
        [ -s "$results/$idx.rc" ] && finished=$((finished + 1))
      done
      alive="$(jobs -pr | wc -l)"
      if [ -t 1 ]; then
        render_progress "Downloading $total_run track(s)" "$finished/$total_run done"
      fi
      sleep 0.4
    done
    if [ -t 1 ]; then
      clear_progress
    fi
    wait 2>/dev/null || true

    for idx in "${queue[@]}"; do
      # A worker killed before it could report counts as an abort.
      track_rc="$(cat "$results/$idx.rc" 2>/dev/null || true)"
      is_int "$track_rc" || track_rc=130
      case "$track_rc" in
      0)
        ok=$((ok + 1))
        # Nothing to inspect on success: drop the log with the status file.
        rm -f "$results/$idx.log"
        ;;
      2)
        skipped=$((skipped + 1))
        skipped_list+=("$idx) ${ENTRIES_TITLE[$((idx - 1))]}")
        rm -f "$results/$idx.log"
        ;;
      130) aborted=1 ;;
      *)
        failed=$((failed + 1))
        failed_list+=("$idx) ${ENTRIES_TITLE[$((idx - 1))]} (log: $results/$idx.log)")
        ;;
      esac
      rm -f "$results/$idx.rc"
    done
    # Only failures keep a log, so the directory often ends up empty.
    rmdir "$results" 2>/dev/null || true
  else
    for idx in ${queue[@]+"${queue[@]}"}; do
      n=$((n + 1))
      echo
      elapsed=$((SECONDS - START_TIME))
      eta=""
      if [ "$n" -gt 1 ] && [ "$total_run" -gt "$n" ]; then
        per=$((elapsed / n))
        eta=", ~$(format_duration $((per * (total_run - n)))) left"
      fi
      printf '%s\n' "${CYAN}${BOLD}-- track $n/$total_run --${RESET} $(format_duration "$elapsed") elapsed$eta" >&2

      if (
        IN_SUBSHELL=1
        process_track "$idx"
      ); then
        ok=$((ok + 1))
      else
        rc=$?
        if [ "$rc" -eq 130 ]; then
          # The user aborted a prompt or pressed Ctrl-C: stop the whole batch
          # instead of marching through the remaining entries.
          aborted=1
          break
        fi
        if [ "$rc" -eq 2 ]; then
          skipped=$((skipped + 1))
          skipped_list+=("$idx) ${ENTRIES_TITLE[$((idx - 1))]}")
        else
          failed=$((failed + 1))
          warning "Track $idx failed; continuing with the next one."
          failed_list+=("$idx) ${ENTRIES_TITLE[$((idx - 1))]}")
        fi
      fi
    done
  fi

  echo
  section "Playlist summary"
  print_kv "Completed" "$ok"
  print_kv "Skipped" "$skipped"
  print_kv "Failed" "$failed"
  if [ "$aborted" -eq 1 ]; then
    print_kv "Stopped" "after $((ok + skipped + failed + aborted)) of $total_selected track(s)"
  fi
  print_kv "Elapsed" "$(format_duration $((SECONDS - START_TIME)))"
  if [ "${#skipped_list[@]}" -gt 0 ]; then
    printf '  Skipped tracks:\n'
    printf '    %s\n' "${skipped_list[@]}"
  fi
  if [ "${#failed_list[@]}" -gt 0 ]; then
    printf '  Failed tracks:\n'
    printf '    %s\n' "${failed_list[@]}"
  fi
  mb_print_summary

  COMPLETED=1
  json_emit summary ok#="$ok" skipped#="$skipped" failed#="$failed" \
    total#="$total_selected" elapsed#="$((SECONDS - START_TIME))"
  if [ "$aborted" -eq 1 ]; then
    return 130
  fi
  [ "$failed" -eq 0 ] || return 1
  return 0
}

# ============================================================
# Single-track mode
# ============================================================
# Runs the pipeline once and reports the outcome the way a playlist entry does.
# Without this a single track that was skipped (already in the library) left the
# last event at "start", so the UI kept showing it as running and the webhook
# had no counts to report.
single_run() {
  local prc=0
  run_pipeline || prc=$?
  mb_print_summary
  case "$prc" in
  0) json_emit summary ok#=1 skipped#=0 failed#=0 total#=1 elapsed#="$((SECONDS - START_TIME))" ;;
  2)
    json_emit track i#=1 stage=skipped
    json_emit summary ok#=0 skipped#=1 failed#=0 total#=1 elapsed#="$((SECONDS - START_TIME))"
    ;;
  esac
  return "$prc"
}

single_mode() {
  CUR_I=1
  set_session_dir "${SESSION_DIR_ARG:-$STATE_DIR/session}" || return 1
  json_emit track i#=1 stage=start title="${TITLE:-}"
  # Fallback key for the import index; fetch_metadata replaces it with the id.
  TRACK_KEY="$URL"

  local fresh_url="$URL"
  if [ -f "$SESSION_FILE" ]; then
    load_session || true
    if [ -n "${ORIGIN_URL:-}" ] && [ "$ORIGIN_URL" != "$REQUESTED_URL" ]; then
      warning "A session for a different URL exists:"
      echo "  $ORIGIN_URL"
      if confirm "Discard it and start a new download?" "Y"; then
        clear_session
        URL="$fresh_url"
      else
        info "Continuing the stored session instead."
      fi
    fi
    if [ -f "$SESSION_FILE" ]; then
      section "Unfinished Session"
      print_kv "Artist" "${ARTIST:-?}"
      print_kv "Album" "${ALBUM:-?}"
      print_kv "Title" "${TITLE:-?}"
      print_kv "Stage" "$(get_checkpoint)"
      echo

      local choice=""
      if [ "$AUTO" -eq 1 ]; then
        choice="Resume"
      elif [ "$HAVE_GUM" -eq 1 ]; then
        choice="$(gum choose "Resume" "Restart" "Delete session")" || choice="Delete session"
      else
        echo "1) Resume"
        echo "2) Restart"
        echo "3) Delete session"
        read -rp "Choice [1]: " choice || choice=""
        case "${choice:-1}" in
        1) choice="Resume" ;;
        2) choice="Restart" ;;
        *) choice="Delete session" ;;
        esac
      fi

      case "$choice" in
      Resume)
        info "Resuming at stage: $(get_checkpoint)"
        single_run
        return $?
        ;;
      Restart)
        clear_session
        ;;
      *)
        clear_session
        info "Session deleted."
        COMPLETED=1
        return 0
        ;;
      esac
    fi
  fi

  # Fresh run
  fetch_metadata || return 1
  save_session
  set_checkpoint "metadata"
  single_run
}

# ============================================================
# Preview modes (--inspect / --plan)
#
# Both run the real probe and the real path resolution and print one JSON
# object, so the web UI never reimplements sanitising, grouping or defaults.
# --inspect lists everything the extractor reported; --plan resolves only the
# entries a run would take, including per-entry overrides.
# ============================================================
run_preview() {
  local mode="$1" tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/audioDL-$mode.XXXXXX")" || die "Cannot create a temp directory."
  DRY_RUN=1
  set_session_dir "$tmp" || return 1
  : >"$TMP_DIR/entry_urls"
  if ! probe_url; then
    rm -rf "$tmp"
    json_emit error message="${PROBE_ERROR:-yt-dlp could not read that URL.}" event_mode="$mode"
    return 1
  fi
  load_entries
  local total="${#ENTRIES_URL[@]}"
  if [ "$total" -eq 0 ]; then
    rm -rf "$tmp"
    json_emit error message="That URL returned no tracks." event_mode="$mode"
    return 1
  fi

  local kind="track"
  [ "$URL_IS_PLAYLIST" -eq 1 ] && kind="playlist"

  # Defaults come from the first entry: one extra metadata call, and it is
  # exactly what the user would have been asked anyway.
  URL="${ENTRIES_URL[0]}"
  ENTRY_NUM=1
  TRACK=""
  if ! fetch_metadata; then
    # A playlist can still be listed from the flat probe alone (DRM-protected
    # or region-locked first entry, for instance): keep going with placeholders.
    if [ "$kind" = track ]; then
      rm -rf "$tmp"
      return 1
    fi
    warning "Using the playlist's own data for the defaults."
    ARTIST="Unknown Artist"
    ALBUM="${PLAYLIST_TITLE:-${ENTRIES_TITLE[0]:-Single}}"
    FETCHED_DATE=""
    FETCHED_DURATION=""
  fi
  local def_artist="$ARTIST" def_album="$ALBUM" def_date def_thumb="$RAW_THUMB"
  def_date="$(parse_date "$FETCHED_DATE" || printf '%s' "$(date +%Y-%m-%d)")"
  # For a single URL the flat probe only knows the URL slug; yt-dlp's metadata
  # has the real title, so use it for the preview and the resolved path.
  if [ "$kind" = track ] && [ -n "${TITLE:-}" ] && [ "$TITLE" != "NA" ]; then
    ENTRIES_TITLE[0]="$TITLE"
  fi
  if [ "$kind" = playlist ] && [ -n "$PLAYLIST_TITLE" ]; then
    def_album="$PLAYLIST_TITLE"
  fi
  [ -n "$ARTIST_OVERRIDE" ] && def_artist="$ARTIST_OVERRIDE"
  [ -n "$ALBUM_OVERRIDE" ] && def_album="$ALBUM_OVERRIDE"
  def_artist="$(artist_label "$def_artist")"
  [ "$TRACK_PREFIX_SET" -eq 0 ] && [ "$kind" = playlist ] && TRACK_PREFIX=1

  # --plan resolves the selection it was given; --inspect lists every entry.
  local -a sel=()
  local idx
  if [ "$mode" = plan ]; then
    local spec=""
    if [ -n "$TRACK_SPEC" ]; then
      spec="$(parse_selection "$TRACK_SPEC")"
    elif [ "$FIRST_ONLY" -eq 1 ]; then
      spec="1"
    else
      spec="$(seq 1 "$total")"
    fi
    local n
    while IFS= read -r n; do
      is_int "$n" && [ "$n" -ge 1 ] && [ "$n" -le "$total" ] && sel+=("$n")
    done <<<"$spec"
  else
    for ((idx = 1; idx <= total; idx++)); do sel+=("$idx"); done
  fi
  if [ "${#sel[@]}" -eq 0 ]; then
    rm -rf "$tmp"
    die "No valid tracks selected."
  fi

  local preview_file="$TMP_DIR/preview.tsv"
  : >"$preview_file"
  local conflicts=0 ex dur
  for idx in "${sel[@]}"; do
    ENTRY_NUM="$idx"
    URL="${ENTRIES_URL[$((idx - 1))]}"
    TITLE="${ENTRIES_TITLE[$((idx - 1))]}"
    ARTIST="$def_artist"
    ALBUM="$def_album"
    ALBUM_FALLBACK=0
    TRACK="$idx"
    [ "$kind" = track ] && TRACK=1
    RAW_THUMB=""
    autofill_or_prompt_metadata
    compute_paths || {
      rm -rf "$tmp"
      return 1
    }
    dur="${ENTRIES_DUR[$((idx - 1))]:-}"
    if ! is_int "$dur" || [ "${dur:-0}" -le 0 ]; then
      dur="${FETCHED_DURATION:-0}"
    fi
    ex=0
    if [ -f "$FINAL_FILE" ] || { [ -n "${PREVIOUS_FILE:-}" ] && [ -f "$PREVIOUS_FILE" ]; }; then
      ex=1
      conflicts=$((conflicts + 1))
    fi
    # Already imported under another path: the review card says so and leaves
    # the entry unselected, and a run would skip it for the same reason.
    local dup="" eid prior
    eid="${ENTRIES_ID[$((idx - 1))]:-}"
    if [ "$ex" -eq 0 ] && [ -n "$eid" ]; then
      prior="$(index_path "$eid")"
      if [ -n "$prior" ] && [ -f "$prior" ] && [ "$prior" != "$FINAL_FILE" ]; then
        dup="$prior"
      fi
    fi
    printf '%s\x1f%s\x1f%s\x1f%s\x1f%s\x1f%s\x1f%s\x1f%s\x1f%s\x1f%s\x1f%s\x1f%s\n' \
      "$idx" "${ENTRIES_ID[$((idx - 1))]:-}" "$TITLE" "${ENTRIES_URL[$((idx - 1))]}" \
      "$dur" "$FINAL_FILE" "$ex" "$ARTIST" "$ALBUM" "$TRACK" "$RECORDING_DATE_ISO" "$dup" \
      >>"$preview_file"
  done

  local tracks_json
  tracks_json="$(jq -R -s '
    split("\n") | map(select(length > 0) | split("\u001f")) |
    map({i:(.[0]|tonumber), id:.[1], title:.[2], url:.[3],
         duration:(if (.[4]|test("^[0-9]+$")) then (.[4]|tonumber) else 0 end),
         path:.[5], exists:(.[6]=="1"), artist:.[7], album:.[8],
         track:(.[9]|tonumber), date:.[10],
         duplicate:(.[11] // "")})
    | map(if .duplicate == "" then del(.duplicate) else . end)
  ' "$preview_file")"

  jq -cn --arg mode "$mode" --arg kind "$kind" --arg url "$REQUESTED_URL" \
    --argjson total "$total" --argjson conflicts "$conflicts" \
    --arg pid "$PLAYLIST_ID" --arg ptitle "$PLAYLIST_TITLE" \
    --arg artist "$def_artist" --arg album "$def_album" --arg date "$def_date" \
    --arg thumb "$def_thumb" --arg lufs "$TARGET_LUFS" --arg quality "$AAC_QUALITY" \
    --arg format "$OUTPUT_FORMAT" \
    --argjson prefix "$TRACK_PREFIX" --arg music "$MUSIC_DIR" \
    --argjson tracks "$tracks_json" \
    '{v:1, event:$mode, kind:$kind, url:$url,
      playlist:{id:$pid, title:$ptitle, count:$total},
      defaults:{artist:$artist, album:$album, date:$date, thumbnail:$thumb,
                lufs:($lufs|tonumber), quality:($quality|tonumber),
                format:$format,
                trackPrefix:($prefix == 1), musicDir:$music},
      conflicts:$conflicts, tracks:$tracks}'

  # The EXIT trap treats a clean 0 without COMPLETED as an early stop.
  COMPLETED=1
  rm -rf "$tmp"
  return 0
}

# ============================================================
# CLI
# ============================================================
usage() {
  cat <<EOF
${BOLD}$PROG $VERSION${RESET} - yt-dlp + ffmpeg audio downloader

Usage:
  $PROG [OPTIONS] URL [START] [END]
  $PROG --inspect URL            Probe a URL, print JSON, exit
  $PROG --plan [OPTIONS] URL     Resolve targets/conflicts, print JSON, exit

Arguments:
  URL               Track or playlist URL
  START, END        Optional section to cut (e.g. 00:01:30 00:02:15)

Options:
  -o, --out DIR     Music library root          (default: $MUSIC_DIR)
  -l, --lufs N      Target loudness in LUFS     (default: $TARGET_LUFS)
  -f, --format SEL  yt-dlp format selector      (default: $AUDIO_FORMAT)
      --output-format F  Container to write: m4a, mp3, opus, flac or wav
                    (default: $OUTPUT_FORMAT)
      --stream-fd N  Encode to descriptor N instead of a library file
                    (one-pass loudnorm, no index write, no lock)
  -y, --yes         Non-interactive: accept defaults, playlists download
                    their first track unless --all/--tracks is given
      --all         Download every playlist entry
  -s, --tracks SPEC Playlist entries to take, e.g. 1-3,7 (implies --all)
      --first       Download only the first playlist entry
      --artist NAME Tag every track with this artist
      --album NAME  Tag every track with this album
      --genre NAME  Tag every track with this genre
      --force       Overwrite existing files without asking, and fetch
                    entries the import index already considers done
      --no-art      Skip cover art
      --no-lyrics   Do not look for lyrics
      --no-mb       Do not look tracks up in MusicBrainz
      --no-replaygain  Do not write ReplayGain track tags
      --mb-refresh  Ignore the cached MusicBrainz responses for this run
      --mb-report F Write one line per track's lookup outcome to F
                    (default: the run workspace; always summarised at the end)
      --one-pass    Skip the loudnorm analysis pass (faster, less accurate)
      --no-lock     Do not take the single-instance lock; the caller must
                    guarantee one --session-dir per run (the web queue does)
  -j, --jobs N      Fetch N playlist tracks at the same time (needs --yes)
      --track-prefix     Prefix filenames with "NN - "
      --no-track-prefix  Never prefix filenames
      --keep        Keep temporary files after a successful run
      --verbose     Show yt-dlp/ffmpeg output instead of a spinner
      --json        NDJSON events on stdout (implies --yes)
      --inspect     Print probe/metadata JSON and exit
      --plan        Print resolved paths and conflicts, download nothing
      --meta-json F Per-track metadata overrides (JSON, keyed by entry)
      --title T     Override the title
      --track N     Override the track number
      --date D      Override the date (YYYY-MM-DD)
      --art-url U   Use this cover art URL
      --session-dir D  Workspace for this job (default: state dir)
      --cookies F   Read cookies from a Netscape cookie jar (yt-dlp)
  -h, --help        Show this help
  -V, --version     Show the version

Environment:
  MUSIC_DIR, TARGET_LUFS, TARGET_TP, TARGET_LRA, ARTWORK_SIZE, AAC_QUALITY,
  OUTPUT_FORMAT, AUDIO_FORMAT, JOBS, XDG_STATE_HOME
  MUSICBRAINZ_LOOKUP, MUSICBRAINZ_USER_AGENT, MUSICBRAINZ_API,
  MUSICBRAINZ_CACHE_DIR, MUSICBRAINZ_CACHE_DAYS, MUSICBRAINZ_MIN_INTERVAL,
  MUSICBRAINZ_TIMEOUT, MUSICBRAINZ_CONNECT_TIMEOUT, MUSICBRAINZ_RETRIES,
  MUSICBRAINZ_MAX_WAIT, REPLAYGAIN, AUDIODL_COOKIES

Examples:
  $PROG "https://youtu.be/XXXX"
  $PROG --lufs -14 --out ~/Music "https://youtu.be/XXXX" 00:00:45 00:04:10
  $PROG -y --all "https://www.youtube.com/playlist?list=PLxxxx"
  $PROG -y --tracks 2-4,9 "https://soundcloud.com/artist/sets/album"
  $PROG -y --all --artist "Fabitekk" --album "GEWALT" "https://soundcloud.com/..."

In a playlist the album chosen for an earlier track is reused for later entries
where yt-dlp only reports a placeholder, so a set stays in one folder.

Playlist entries already in the library are skipped on later runs of the same
playlist (tracked by extractor id in the import index, see --force). --jobs N
fetches several tracks at once; only tracks that fail leave a log behind.

MusicBrainz lookup is on by default: each track is searched by title and artist,
and a result is only used when title, artist and duration agree. Missing or
placeholder fields (album, track/disc numbers, year, genre) are filled in and
the MBIDs are tagged; existing tags are never replaced by an uncertain match.
Tracks that are not in MusicBrainz keep the source metadata and are listed in
the summary. One request per second, cached for ${MUSICBRAINZ_CACHE_DAYS:-30}
days; see MUSICBRAINZ.md. --no-mb turns it off.

Every file is normalised to the target loudness and then tagged with ReplayGain
track values for what was actually written, measured against that same target,
so a player using it leaves the library as it is (MP3, FLAC, M4A and Opus).
--no-replaygain turns them off; --one-pass and --stream-fd measure nothing and
write none.

A source that wants a signed-in session needs a cookie jar: --cookies FILE (or
AUDIODL_COOKIES) is passed to every yt-dlp call, including the probe.
EOF
}

POS_COUNT=0
set_positional() {
  POS_COUNT=$((POS_COUNT + 1))
  case "$POS_COUNT" in
  1) URL="$1" ;;
  2) START="$1" ;;
  3) END="$1" ;;
  *) die "Too many arguments (try --help)." ;;
  esac
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
    -h | --help)
      usage
      COMPLETED=1
      exit 0
      ;;
    -V | --version)
      printf '%s %s\n' "$PROG" "$VERSION"
      COMPLETED=1
      exit 0
      ;;
    -o | --out)
      [ "$#" -ge 2 ] || die "--out needs a directory"
      MUSIC_DIR="$2"
      shift 2
      ;;
    --out=*)
      MUSIC_DIR="${1#*=}"
      shift
      ;;
    -l | --lufs)
      [ "$#" -ge 2 ] || die "--lufs needs a number"
      TARGET_LUFS="$2"
      shift 2
      ;;
    --lufs=*)
      TARGET_LUFS="${1#*=}"
      shift
      ;;
    -f | --format)
      [ "$#" -ge 2 ] || die "--format needs a selector"
      AUDIO_FORMAT="$2"
      shift 2
      ;;
    --output-format)
      [ "$#" -ge 2 ] || die "--output-format needs a container (m4a, mp3, opus, flac, wav)"
      OUTPUT_FORMAT="$2"
      shift 2
      ;;
    --stream-fd)
      [ "$#" -ge 2 ] || die "--stream-fd needs a descriptor number"
      STREAM_FD="$2"
      shift 2
      ;;
    --stream-fd=*)
      STREAM_FD="${1#*=}"
      shift
      ;;
    --output-format=*)
      OUTPUT_FORMAT="${1#*=}"
      shift
      ;;
    -y | --yes)
      AUTO=1
      shift
      ;;
    --all)
      SELECT_ALL=1
      shift
      ;;
    --first)
      FIRST_ONLY=1
      shift
      ;;
    -s | --tracks)
      [ "$#" -ge 2 ] || die "--tracks needs a selection (e.g. 1-3,7)"
      TRACK_SPEC="$2"
      shift 2
      ;;
    --tracks=*)
      TRACK_SPEC="${1#*=}"
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --no-art)
      NO_ART=1
      shift
      ;;
    --no-lyrics)
      NO_LYRICS=1
      shift
      ;;
    --no-mb)
      MB_ENABLED=0
      shift
      ;;
    --no-replaygain)
      RG_ENABLED=0
      shift
      ;;
    --cookies)
      [ "$#" -ge 2 ] || die "--cookies needs a file"
      COOKIES_FILE="$2"
      shift 2
      ;;
    --cookies=*)
      COOKIES_FILE="${1#*=}"
      shift
      ;;
    --mb-refresh)
      MB_REFRESH=1
      shift
      ;;
    --mb-report)
      [ "$#" -ge 2 ] || die "--mb-report needs a file"
      MB_REPORT_FILE="$2"
      shift 2
      ;;
    --mb-report=*)
      MB_REPORT_FILE="${1#*=}"
      shift
      ;;
    --one-pass)
      ONE_PASS=1
      shift
      ;;
    --no-lock)
      NO_LOCK=1
      shift
      ;;
    --json)
      JSON=1
      AUTO=1
      shift
      ;;
    --inspect)
      INSPECT_ONLY=1
      JSON=1
      AUTO=1
      shift
      ;;
    --plan)
      PLAN_ONLY=1
      JSON=1
      AUTO=1
      shift
      ;;
    --meta-json)
      [ "$#" -ge 2 ] || die "--meta-json needs a file"
      META_JSON="$2"
      shift 2
      ;;
    --meta-json=*)
      META_JSON="${1#*=}"
      shift
      ;;
    --title)
      [ "$#" -ge 2 ] || die "--title needs text"
      TITLE_OVERRIDE="$2"
      shift 2
      ;;
    --title=*)
      TITLE_OVERRIDE="${1#*=}"
      shift
      ;;
    --track)
      [ "$#" -ge 2 ] || die "--track needs a number"
      TRACK_OVERRIDE="$2"
      shift 2
      ;;
    --track=*)
      TRACK_OVERRIDE="${1#*=}"
      shift
      ;;
    --date)
      [ "$#" -ge 2 ] || die "--date needs YYYY-MM-DD"
      DATE_OVERRIDE="$2"
      shift 2
      ;;
    --date=*)
      DATE_OVERRIDE="${1#*=}"
      shift
      ;;
    --art-url)
      [ "$#" -ge 2 ] || die "--art-url needs a URL"
      ART_OVERRIDE="$2"
      shift 2
      ;;
    --art-url=*)
      ART_OVERRIDE="${1#*=}"
      shift
      ;;
    --session-dir)
      [ "$#" -ge 2 ] || die "--session-dir needs a directory"
      SESSION_DIR_ARG="$2"
      shift 2
      ;;
    --session-dir=*)
      SESSION_DIR_ARG="${1#*=}"
      shift
      ;;
    -j | --jobs)
      [ "$#" -ge 2 ] || die "--jobs needs a number"
      JOBS="$2"
      shift 2
      ;;
    --jobs=*)
      JOBS="${1#*=}"
      shift
      ;;
    --track-prefix)
      TRACK_PREFIX=1
      TRACK_PREFIX_SET=1
      shift
      ;;
    --no-track-prefix)
      TRACK_PREFIX=0
      TRACK_PREFIX_SET=1
      shift
      ;;
    --album)
      [ "$#" -ge 2 ] || die "--album needs a name"
      ALBUM_OVERRIDE="$2"
      shift 2
      ;;
    --album=*)
      ALBUM_OVERRIDE="${1#*=}"
      shift
      ;;
    --artist)
      [ "$#" -ge 2 ] || die "--artist needs a name"
      ARTIST_OVERRIDE="$2"
      shift 2
      ;;
    --artist=*)
      ARTIST_OVERRIDE="${1#*=}"
      shift
      ;;
    --genre)
      [ "$#" -ge 2 ] || die "--genre needs a name"
      GENRE_OVERRIDE="$2"
      shift 2
      ;;
    --genre=*)
      GENRE_OVERRIDE="${1#*=}"
      shift
      ;;
    --keep)
      KEEP_TEMP=1
      shift
      ;;
    --verbose)
      VERBOSE=1
      NO_SPINNER=1
      shift
      ;;
    --)
      shift
      while [ "$#" -gt 0 ]; do
        set_positional "$1"
        shift
      done
      ;;
    -*) die "Unknown option: $1 (try --help)." ;;
    *)
      set_positional "$1"
      shift
      ;;
    esac
  done

  if [ -z "$URL" ]; then
    usage >&2
    die "No URL given."
  fi
  if [ -n "$START" ] && [ -z "$END" ]; then
    die "START requires END (e.g. 00:00:45 00:04:10)."
  fi
  if [ "$AUTO" -eq 1 ] && [ "$FIRST_ONLY" -eq 0 ] && [ "$SELECT_ALL" -eq 0 ] && [ -z "$TRACK_SPEC" ]; then
    FIRST_ONLY=1
  fi
  if [ "$FIRST_ONLY" -eq 1 ] && [ "$SELECT_ALL" -eq 1 ]; then
    die "--first and --all are mutually exclusive."
  fi
  if [ "$FIRST_ONLY" -eq 1 ] && [ -n "$TRACK_SPEC" ]; then
    die "--first and --tracks are mutually exclusive."
  fi
  is_int "$JOBS" && [ "$JOBS" -ge 1 ] || die "--jobs must be a positive integer (got '$JOBS')."
  if [ "$JOBS" -gt 1 ] && [ "$AUTO" -eq 0 ]; then
    die "--jobs needs --yes: tag prompts cannot be answered for parallel tracks."
  fi
  if [ "$INSPECT_ONLY" -eq 1 ] && [ "$PLAN_ONLY" -eq 1 ]; then
    die "--inspect and --plan are mutually exclusive."
  fi
  if [ -n "$TRACK_OVERRIDE" ] && { ! is_int "$TRACK_OVERRIDE" || [ "$TRACK_OVERRIDE" -lt 1 ]; }; then
    die "--track must be a positive integer (got '$TRACK_OVERRIDE')."
  fi
  if [ -n "$DATE_OVERRIDE" ] && ! parse_date "${DATE_OVERRIDE//-/}" >/dev/null; then
    die "--date must be YYYY-MM-DD (got '$DATE_OVERRIDE')."
  fi
  if [ -n "$META_JSON" ]; then
    [ -r "$META_JSON" ] || die "Cannot read --meta-json file: $META_JSON"
    command -v jq >/dev/null 2>&1 || die "--meta-json needs jq."
    jq -e . "$META_JSON" >/dev/null 2>&1 || die "--meta-json is not valid JSON: $META_JSON"
  fi
  is_int "${MUSICBRAINZ_CACHE_DAYS:-30}" || die "MUSICBRAINZ_CACHE_DAYS must be an integer (got '$MUSICBRAINZ_CACHE_DAYS')."
  is_num "${MUSICBRAINZ_MIN_INTERVAL:-1}" || die "MUSICBRAINZ_MIN_INTERVAL must be a number (got '$MUSICBRAINZ_MIN_INTERVAL')."
  is_num "${MUSICBRAINZ_TIMEOUT:-15}" || die "MUSICBRAINZ_TIMEOUT must be a number (got '$MUSICBRAINZ_TIMEOUT')."
  is_int "${MUSICBRAINZ_RETRIES:-3}" && [ "$MUSICBRAINZ_RETRIES" -ge 1 ] ||
    die "MUSICBRAINZ_RETRIES must be a positive integer (got '$MUSICBRAINZ_RETRIES')."
  if [ -n "$MB_REPORT_FILE" ]; then
    mkdir -p "$(dirname "$MB_REPORT_FILE")" 2>/dev/null ||
      die "Cannot create the --mb-report directory: $(dirname "$MB_REPORT_FILE")"
    : >"$MB_REPORT_FILE" 2>/dev/null || die "Cannot write --mb-report file: $MB_REPORT_FILE"
  fi
}

# ============================================================
# Entry point
# ============================================================
main() {
  parse_args "$@"
  check_requirements
  init_cookies
  REQUESTED_URL="$URL"
  ORIGIN_URL="$URL"

  # Preview modes never take the lock or touch the library: several can run
  # while a download is in progress, which is what the web UI relies on.
  if [ "$INSPECT_ONLY" -eq 1 ] || [ "$PLAN_ONLY" -eq 1 ]; then
    if [ "$INSPECT_ONLY" -eq 1 ]; then
      run_preview inspect
    else
      run_preview plan
    fi
    exit $?
  fi

  # Parallel jobs are serialised by the web queue instead: each has its own
  # --session-dir, and index writes lock only the index (see index_add).
  if [ "$NO_LOCK" -eq 0 ]; then
    acquire_lock || exit 1
  fi
  set_session_dir "${SESSION_DIR_ARG:-$STATE_DIR/session}" || exit 1
  : >"$TMP_DIR/entry_urls"

  local probe_ok=1
  if ! probe_url; then
    probe_ok=0
    if [ -f "$SESSION_FILE" ]; then
      warning "Continuing with the stored session instead."
      load_session || true
    else
      exit 1
    fi
  fi
  if [ "$probe_ok" -eq 1 ]; then
    json_emit job kind="$([ "$URL_IS_PLAYLIST" -eq 1 ] && echo playlist || echo track)" \
      url="$REQUESTED_URL" n#="$ENTRY_COUNT"
  fi

  if [ "$probe_ok" -eq 1 ] && [ "$URL_IS_PLAYLIST" -eq 0 ] && [ -n "$TRACK_SPEC" ]; then
    warning "--tracks only applies to playlists; ignoring it for this URL."
    TRACK_SPEC=""
  fi

  if [ "$probe_ok" -eq 1 ] && [ "$URL_IS_PLAYLIST" -eq 1 ]; then
    local want_playlist=0
    if [ "$SELECT_ALL" -eq 1 ] || [ -n "$TRACK_SPEC" ]; then
      want_playlist=1
    elif [ "$FIRST_ONLY" -eq 1 ]; then
      want_playlist=0
    elif confirm "Download the entire playlist? (otherwise only the first track)" "N"; then
      want_playlist=1
    fi

    if [ "$want_playlist" -eq 1 ]; then
      local prc=0
      playlist_mode || prc=$?
      rm -rf "$SESSION_DIR"
      exit "$prc"
    fi

    # Single track out of a playlist: resolve the first entry URL.
    URL="$(head -n 1 "$TMP_DIR/entry_urls" 2>/dev/null || true)"
    [ -n "$URL" ] || die "Could not resolve the first track of that playlist."
    info "Using the first track only: $URL"
  fi

  local rc=0
  single_mode || rc=$?
  # 2 means "skipped, the file already exists": not a failure.
  [ "$rc" -eq 2 ] && rc=0
  exit "$rc"
}

# Sourcing the script (the MusicBrainz tests) only defines its functions.
if [ "${AUDIODL_SOURCE_ONLY:-0}" -ne 1 ]; then
  main "$@"
fi
