#!/usr/bin/env bash
#
# audioDL3 — modular audio downloader
# yt-dlp + ffmpeg + fzf
# Two-pass loudnorm via jq (falls back to one-pass if jq missing)
#
set -euo pipefail
trap 'echo "FAILED at line $LINENO: $BASH_COMMAND"' ERR

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
HAVE_GUM=0

info() {
        if [ "$HAVE_GUM" -eq 1 ]; then
                gum style --foreground 4 "▶ $1"
        else
                printf '%s%s\n' "${BLUE}▶${RESET} " "$1"
        fi
}

success() {
        if [ "$HAVE_GUM" -eq 1 ]; then
                gum style --foreground 2 "✔ $1"
        else
                printf '%s%s\n' "${GREEN}✔${RESET} " "$1"
        fi
}

warning() {
        if [ "$HAVE_GUM" -eq 1 ]; then
                gum style --foreground 3 "⚠ $1"
        else
                printf '%s%s\n' "${YELLOW}⚠${RESET} " "$1"
        fi
}

error() {
        if [ "$HAVE_GUM" -eq 1 ]; then
                gum style --foreground 1 "✖ $1"
        else
                printf '%s%s\n' "${RED}✖${RESET} " "$1"
        fi
}

section() {
        if [ "$HAVE_GUM" -eq 1 ]; then
                gum style \
                        --border double \
                        --padding "0 1" \
                        --bold \
                        "$1"
        else
                local line="${CYAN}${BOLD}══════════════════════════════════════════════════════════════${RESET}"
                printf '%s\n' "$line"
                printf '%s\n' "${CYAN}${BOLD} $1${RESET}"
                printf '%s\n' "$line"
        fi
}

print_kv() { printf '  %-12s %s\n' "$1" "$2"; }
print_label() { printf '  %-6s : %s\n' "$1" "$2"; }

# confirm "Prompt" ["default"] -> 0 = yes, 1 = no
confirm() {
        local prompt="$1"
        local default="${2:-Y}"

        if [ "$HAVE_GUM" -eq 1 ]; then
                if [ "$default" = "Y" ]; then
                        gum confirm "$prompt"
                else
                        gum confirm "$prompt" && return 1
                        return 0
                fi
        else
                local ans
                read -rp "$prompt " ans || ans=""
                ans="${ans:-$default}"
                case "$ans" in
                [Yy]*) return 0 ;;
                *) return 1 ;;
                esac
        fi
}

run_spinner() {
        local title="$1"
        shift

        if [ "$HAVE_GUM" -eq 1 ]; then
                gum spin \
                        --spinner dot \
                        --title "$title" \
                        -- "$@"
        else
                info "$title"
                "$@"
        fi
}

# fallback "value" "default"
fallback() {
        local v="$1" d="$2"
        if [ -z "$v" ] || [ "$v" = "NA" ] || [ "$v" = "None" ]; then
                printf '%s' "$d"
        else
                printf '%s' "$v"
        fi
}

# prompt_default "Label" "default"  (only shows [default] when non-empty)

prompt_default() {
        local label="$1" default="${2:-}" ans

        if [ "$HAVE_GUM" -eq 1 ]; then
                if [ -n "$default" ]; then
                        ans="$(gum input --prompt "$label [$default]: " --value "$default")"
                else
                        ans="$(gum input --prompt "$label: ")"
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

# ============================================================
# Config
# ============================================================
MUSIC_DIR="/media/music"
TARGET_LUFS="-9"
ARTWORK_SIZE="1000"

# Centralized FFmpeg options (spec item 2)
FFMPEG=(
        ffmpeg
        -hide_banner
        -loglevel error
)

# Separate array for the loudnorm analyze pass — no -stats so JSON stays clean
FFMPEG_ANALYZE=(
        ffmpeg
        -hide_banner
        -loglevel info
)

# ============================================================
# Runtime state
# ============================================================
URL="" START="" END=""
ARTIST="" ALBUM="" TITLE="" TRACK="" RECORDING_DATE_ISO=""
FETCHED_DATE="" RAW_THUMB=""
TARGET_DIR="" FINAL_FILE="" BASENAME=""
TMP_DIR="" TMP_TEMPLATE="" TMP_FILE="" NORMALIZED_FILE="" TMP_THUMB=""
HAVE_JQ=0 SOURCE_SAMPLE_RATE=""

# ============================================================
# Persistent session workspace
# ============================================================
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/audioDL"
SESSION_DIR="$STATE_DIR/session"

mkdir -p "$SESSION_DIR"

TMP_DIR="$SESSION_DIR"

SESSION_FILE="$SESSION_DIR/session.env"
CHECKPOINT_FILE="$SESSION_DIR/state"

SUCCESS=0

cleanup() {
        if [ "$SUCCESS" -eq 1 ]; then
                rm -rf "$SESSION_DIR"
        fi
}

trap cleanup EXIT

# ============================================================
# Small reusable helpers
# ============================================================

sanitize_filename() {
        local name="$1"
        name="${name//\//-}" # /
        name="${name//\\/-}" # backslash
        name="${name//:/-}"  # :
        name="${name//\*/-}" # *
        name="${name//\?/-}" # ?
        name="${name//\"/-}" # "
        name="${name//</-}"  # <
        name="${name//>/-}"  # >
        name="${name//\|/-}" # |
        # Collapse whitespace + trim
        name="$(printf '%s' "$name" | tr -s '[:space:]' ' ')"
        name="${name#"${name%%[![:space:]]*}"}"
        name="${name%"${name##*[![:space:]]}"}"
        printf '%s' "$name"
}

get_source_sample_rate() {
        if ! SOURCE_SAMPLE_RATE="$(ffprobe -v error \
                -select_streams a:0 \
                -show_entries stream=sample_rate \
                -of csv=p=0 \
                "$TMP_FILE")"; then
                warning "ffprobe failed, keeping original sample rate."
                SOURCE_SAMPLE_RATE=""
                return
        fi

        if [ -z "$SOURCE_SAMPLE_RATE" ]; then
                warning "Could not detect source sample rate."
                SOURCE_SAMPLE_RATE=""
        else
                info "Source sample rate: ${SOURCE_SAMPLE_RATE} Hz"
        fi
}

# Detect image extension via file --mime-type (spec item 4 / refinement 4)
detect_image_ext() {
        local f="$1" mime
        mime="$(file --mime-type -b "$f" 2>/dev/null)"
        case "$mime" in
        image/jpeg) printf 'jpg' ;;
        image/png) printf 'png' ;;
        image/webp) printf 'webp' ;;
        image/gif) printf 'gif' ;;
        image/bmp) printf 'bmp' ;;
        image/tiff) printf 'tiff' ;;
        image/x-ico | image/vnd.microsoft.icon) printf 'ico' ;;
        *) printf '' ;;
        esac
}

# ============================================================
# Session helpers
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
# Core functions (modular layout preserved)
# ============================================================

check_requirements() {
        for dep in yt-dlp ffmpeg ffprobe fzf curl file magick; do
                if ! command -v "$dep" >/dev/null 2>&1; then
                        error "$dep is not installed."
                        exit 1
                fi
        done
        if command -v jq >/dev/null 2>&1; then
                HAVE_JQ=1
        else
                HAVE_JQ=0
                warning "jq not found; will fall back to one-pass loudnorm."
        fi
        if ! command -v timg >/dev/null 2>&1 && ! command -v chafa >/dev/null 2>&1; then
                warning "Neither timg nor chafa installed; artwork preview disabled."
        fi
        if command -v gum >/dev/null 2>&1; then
                HAVE_GUM=1
        else
                HAVE_GUM=0
        fi
}

prepare_thumbnail() {
        local input="$1"
        local output="$TMP_DIR/cover.jpg"

        if magick "$input" \
                -resize "${ARTWORK_SIZE}x${ARTWORK_SIZE}>" \
                -strip \
                "$output"; then
                TMP_THUMB="$output"
        else
                TMP_THUMB=""
                return 1
        fi
}

fetch_metadata() {
        section "Fetching Metadata"
        info "Contacting yt-dlp..."

        local raw
        if ! raw=$(yt-dlp --quiet --no-download \
                --print "%(artist)s|%(album)s|%(title)s|%(uploader)s|%(upload_date)s|%(thumbnail)s" \
                "$URL" 2>"$TMP_DIR/ytmeta.err"); then
                error "yt-dlp failed to fetch metadata."
                [ -s "$TMP_DIR/ytmeta.err" ] && cat "$TMP_DIR/ytmeta.err" >&2
                exit 1
        fi

        # Detect empty / failed metadata retrieval
        if [ -z "$raw" ]; then
                error "yt-dlp returned empty metadata (invalid URL or no network)."
                exit 1
        fi

        local r_artist r_album r_title r_uploader r_date
        IFS="|" read -r r_artist r_album r_title r_uploader r_date RAW_THUMB <<<"$raw"

        ARTIST="$(fallback "$r_artist" "$r_uploader")"
        ALBUM="$(fallback "$r_album" "Single")"
        TITLE="$(fallback "$r_title" "Unknown Title")"
        FETCHED_DATE="$r_date"

        info "Metadata fetched."
}

save_session() {
        cat >"$SESSION_FILE" <<EOF
URL="$URL"
START="$START"
END="$END"

ARTIST="$ARTIST"
ALBUM="$ALBUM"
TITLE="$TITLE"
TRACK="$TRACK"

TMP_FILE="$TMP_FILE"
NORMALIZED_FILE="$NORMALIZED_FILE"
TMP_THUMB="$TMP_THUMB"

FETCHED_DATE="$FETCHED_DATE"
RECORDING_DATE_ISO="$RECORDING_DATE_ISO"

RAW_THUMB="$RAW_THUMB"

SOURCE_SAMPLE_RATE="$SOURCE_SAMPLE_RATE"

TARGET_DIR="$TARGET_DIR"
FINAL_FILE="$FINAL_FILE"
BASENAME="$BASENAME"
EOF
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
}

resume_menu() {
        [ -f "$SESSION_FILE" ] || return 1

        load_session

        section "Unfinished Session"

        print_kv "Artist" "$ARTIST"
        print_kv "Album" "$ALBUM"
        print_kv "Title" "$TITLE"
        print_kv "Stage" "$(get_checkpoint)"

        echo

        local choice

        if [ "$HAVE_GUM" -eq 1 ]; then
                choice="$(gum choose \
                        "Resume" \
                        "Restart" \
                        "Delete session")"
        else
                echo "1) Resume"
                echo "2) Restart"
                echo "3) Delete session"

                read -rp "Choice [1]: " choice

                case "${choice:-1}" in
                1) choice="Resume" ;;
                2) choice="Restart" ;;
                3) choice="Delete session" ;;
                esac
        fi

        case "$choice" in
        Resume)
                return 0
                ;;
        Restart)
                clear_session
                return 1
                ;;
        "Delete session")
                clear_session
                exit 0
                ;;
        esac
}

prompt_metadata() {
        # Artist (with FZF folder match)
        ARTIST="$(prompt_default "Artist" "$ARTIST")"
        local existing

        if [ -d "$MUSIC_DIR" ]; then
                if [ "$HAVE_GUM" -eq 1 ]; then
                        existing="$(
                                find "$MUSIC_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' |
                                        gum filter --placeholder "Existing artists..." --value "$ARTIST" || true
                        )"
                else
                        existing="$(
                                find "$MUSIC_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' |
                                        fzf --query="$ARTIST" --exit-0 || true
                        )"
                fi

                [ -n "$existing" ] && ARTIST="$existing"
        fi

        ALBUM="$(prompt_default "Album" "$ALBUM")"
        TITLE="$(prompt_default "Title" "$TITLE")"
        TRACK="$(prompt_default "Track # (leave blank for 1)" "1")"

        RECORDING_DATE_ISO="$(parse_date "$FETCHED_DATE")"
        if [ -z "$RECORDING_DATE_ISO" ]; then
                local day month year
                day="$(prompt_default "Day" "$(date +%d)")"
                month="$(prompt_default "Month" "$(date +%m)")"
                year="$(prompt_default "Year" "$(date +%Y)")"
                RECORDING_DATE_ISO="$year-$month-$day"
        fi
}

parse_date() {
        local d="$1"
        if [[ $d =~ ^([0-9]{4})([0-9]{2})([0-9]{2})$ ]]; then
                printf '%s-%s-%s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
        fi
}

compute_paths() {
        local safe_artist safe_album
        safe_artist="$(sanitize_filename "$ARTIST")"
        safe_album="$(sanitize_filename "$ALBUM")"
        BASENAME="$(sanitize_filename "$TITLE")"
        [ -z "$BASENAME" ] && BASENAME="Unknown Title"

        TARGET_DIR="$MUSIC_DIR/$safe_artist/$safe_album"
        mkdir -p "$TARGET_DIR"
        FINAL_FILE="$TARGET_DIR/$BASENAME.m4a"
        # Let yt-dlp decide the container/extension (refinement 3)
        TMP_TEMPLATE="$TMP_DIR/download.%(ext)s"
        TMP_FILE="" # assigned in download_audio after yt-dlp writes the file
        NORMALIZED_FILE="$TMP_DIR/$BASENAME.normalized.m4a"
}

show_summary() {
        section "Summary"

        if [ "$HAVE_GUM" -eq 1 ]; then
                gum style \
                        --border rounded \
                        --padding "1 2" \
                        "Artist: $ARTIST
Album:  $ALBUM
Title:  $TITLE
Track:  ${TRACK:-—}
Date:   $RECORDING_DATE_ISO
Output: $TARGET_DIR"
        else
                print_kv "Artist" "$ARTIST"
                print_kv "Album" "$ALBUM"
                print_kv "Title" "$TITLE"
                print_kv "Track" "${TRACK:-—}"
                print_kv "Date" "$RECORDING_DATE_ISO"
                print_kv "Output" "$TARGET_DIR"
        fi

        echo

        if ! confirm "Continue?"; then
                error "Aborted by user."
                exit 0
        fi
}

download_audio() {
        section "Downloading Audio"
        local args=(
                -f "bestaudio[ext=m4a]/bestaudio[acodec*=aac]/bestaudio"
                -o "$TMP_TEMPLATE"
                --no-playlist
                --no-overwrites
                --abort-on-error
        )
        if [ -n "$START" ] && [ -n "$END" ]; then
                args+=(--download-sections "*${START}-${END}")
        fi
        args+=("$URL")

        run_spinner "Downloading best available audio..." \
                yt-dlp --quiet "${args[@]}"

        shopt -s nullglob
        local files=("$TMP_DIR"/download.*)
        shopt -u nullglob
        if [ "${#files[@]}" -eq 0 ]; then
                error "Download produced no file."
                exit 1
        fi
        TMP_FILE="${files[0]}"
        if [ -z "$TMP_FILE" ]; then
                error "Could not locate downloaded file."
                exit 1
        fi
        success "Download complete."
}

normalize_audio() {
        section "Normalizing Audio"

        if [ "$HAVE_JQ" -eq 1 ]; then
                # --- Two-pass loudnorm using jq ---
                run_spinner "Analyzing loudness..." \
                        "${FFMPEG_ANALYZE[@]}" -i "$TMP_FILE" \
                        -af "loudnorm=I=$TARGET_LUFS:TP=-1.5:LRA=11:print_format=json" \
                        -f null - 2>"$TMP_DIR/loudnorm_raw.txt"
                local json="$TMP_DIR/loudnorm.json"
                awk '/\{/{flag=1} flag; /\}/{flag=0}' "$TMP_DIR/loudnorm_raw.txt" >"$json"

                local mi mtp mlra mthr off
                mi="$(jq -r '.input_i' "$json")"
                mtp="$(jq -r '.input_tp' "$json")"
                mlra="$(jq -r '.input_lra' "$json")"
                mthr="$(jq -r '.input_thresh' "$json")"
                off="$(jq -r '.target_offset' "$json")"

                run_spinner "Applying normalization (pass 2)..." \
                        "${FFMPEG[@]}" -y -i "$TMP_FILE" \
                        -af "loudnorm=I=$TARGET_LUFS:TP=-1.5:LRA=11:measured_I=$mi:measured_TP=$mtp:measured_LRA=$mlra:measured_thresh=$mthr:offset=$off:linear=true" \
                        -c:a aac -q:a 2 \
                        ${SOURCE_SAMPLE_RATE:+-ar "$SOURCE_SAMPLE_RATE"} \
                        "$NORMALIZED_FILE"

        else
                # --- Graceful one-pass fallback (no JSON parsing) ---
                warning "Using one-pass loudnorm (jq unavailable)."
                "${FFMPEG[@]}" -y -i "$TMP_FILE" \
                        -af "loudnorm=I=$TARGET_LUFS:TP=-1.5:LRA=11" \
                        -c:a aac -q:a 2 \
                        ${SOURCE_SAMPLE_RATE:+-ar "$SOURCE_SAMPLE_RATE"} \
                        "$NORMALIZED_FILE"
        fi

        success "Normalization complete."
}

download_thumbnail() {
        TMP_THUMB=""

        if [ -n "$RAW_THUMB" ] && [ "$RAW_THUMB" != "NA" ]; then
                if try_download_thumb "$RAW_THUMB"; then
                        if prepare_thumbnail "$TMP_THUMB"; then
                                preview_thumbnail "$TMP_THUMB"
                        else
                                warning "Could not process artwork."
                                TMP_THUMB=""
                        fi
                        local keep=1

                        if [ "$HAVE_GUM" -eq 1 ]; then
                                local choice
                                choice="$(
                                        gum choose \
                                                "use thumbnail" \
                                                "discard thumbnail"
                                )"

                                [ "$choice" = "use thumbnail" ] || keep=0
                        else
                                confirm "Use this thumbnail?" "Y" || keep=0
                        fi

                        [ "$keep" -eq 1 ] || TMP_THUMB=""
                else
                        warning "Couldn't download artwork from source."
                fi
        fi

        if [ -z "$TMP_THUMB" ]; then
                local url
                url="$(prompt_default "Thumbnail URL (leave blank for none)")"

                if [ -n "$url" ]; then
                        if try_download_thumb "$url"; then
                                if prepare_thumbnail "$TMP_THUMB"; then
                                        preview_thumbnail "$TMP_THUMB"
                                else
                                        warning "Could not process artwork."
                                        TMP_THUMB=""
                                fi
                        else
                                warning "Couldn't download artwork from custom URL."
                                TMP_THUMB=""
                        fi
                fi
        fi
}

try_download_thumb() {
        local url="$1" tmp_noext="$TMP_DIR/thumb" ext
        rm -f "$tmp_noext"*
        if ! curl -fsSL "$url" -o "$tmp_noext" || [ ! -s "$tmp_noext" ]; then
                return 1
        fi
        # Detect real type via mime, save with correct extension
        ext="$(detect_image_ext "$tmp_noext")"
        if [ -z "$ext" ]; then
                return 1
        fi
        mv "$tmp_noext" "$tmp_noext.$ext"
        TMP_THUMB="$tmp_noext.$ext"
        return 0
}

preview_thumbnail() {
        if command -v timg >/dev/null 2>&1; then
                timg "$1"
        elif command -v chafa >/dev/null 2>&1; then
                chafa "$1"
        fi
}

embed_metadata() {
        section "Embedding Metadata"

        # Single metadata array, reused
        local meta_args=(
                -metadata artist="$ARTIST"
                -metadata album="$ALBUM"
                -metadata album_artist="$ARTIST"
                -metadata title="$TITLE"
                -metadata date="$RECORDING_DATE_ISO"
        )
        [ -n "$TRACK" ] && meta_args+=(-metadata track="$TRACK")

        local input_args=(-i "$NORMALIZED_FILE")
        local map_args=(-map 0:a)
        local codec_args=(-c:a copy)

        if [ -n "$TMP_THUMB" ] && [ -s "$TMP_THUMB" ]; then
                input_args+=(-i "$TMP_THUMB")
                map_args+=(-map 1:v)
                codec_args+=(
                        -c:v mjpeg
                        -disposition:v attached_pic
                        -metadata:s:v title="Album cover"
                        -metadata:s:v comment="Cover"
                )
        fi

        # One FFmpeg invocation, no duplicated -metadata blocks
        "${FFMPEG[@]}" -y "${input_args[@]}" "${map_args[@]}" "${codec_args[@]}" "${meta_args[@]}" "$FINAL_FILE"
        success "Metadata embedded."
}

check_existing() {
        if [ -f "$FINAL_FILE" ]; then
                warning "File already exists:"
                echo " $FINAL_FILE"
                echo

                local choice

                if [ "$HAVE_GUM" -eq 1 ]; then
                        choice="$(gum choose \
                                "overwrite" \
                                "skip" \
                                "abort")"
                else
                        echo "Options:"
                        echo "1) overwrite"
                        echo "2) skip"
                        echo "3) abort"

                        read -rp "Choice [2]: " choice

                        case "${choice:-2}" in
                        1) choice="overwrite" ;;
                        2) choice="skip" ;;
                        *) choice="abort" ;;
                        esac
                fi

                case "$choice" in
                overwrite)
                        rm -f "$FINAL_FILE"
                        ;;
                skip)
                        exit 0
                        ;;
                abort)
                        exit 1
                        ;;
                esac
        fi
}

show_output_info() {
        # Single ffprobe call (refinement 4)
        section "Output Information"
        if ! command -v ffprobe >/dev/null 2>&1; then
                warning "ffprobe not installed; skipping detailed output info."
                return
        fi
        info "Verifying generated file..."
        local raw codec="" sr="" dur="" br=""
        raw="$(ffprobe -v error \
                -select_streams a:0 \
                -show_entries stream=codec_name:stream=sample_rate:format=duration:format=bit_rate \
                -of default=nw=1 "$FINAL_FILE")"
        while IFS='=' read -r k v; do
                case "$k" in
                codec_name) codec="$v" ;;
                sample_rate) sr="$v" ;;
                duration) dur="$v" ;;
                bit_rate) br="$v" ;;
                esac
        done <<<"$raw"

        print_kv "Codec" "${codec:-unknown}"
        print_kv "Sample Rate" "${sr:-?} Hz"
        print_kv "Duration" "${dur:-?} s"
        if [ -n "$br" ]; then
                br_kbps=$((br / 1000))
        else
                br_kbps="?"
        fi
        print_kv "Bitrate" "${br_kbps} kbps"
}

print_final() {
        if [ "$HAVE_GUM" -eq 1 ]; then
                gum style \
                        --border double \
                        --padding "1 2" \
                        --bold \
                        "✔ Download completed

Artist: $ARTIST
Album:  $ALBUM
Title:  $TITLE
Track:  ${TRACK:-—}
LUFS:   $TARGET_LUFS

Saved:
$FINAL_FILE"
        else
                local line="${CYAN}${BOLD}══════════════════════════════════════════════════════════════${RESET}"
                printf '%s\n' "$line"
                printf '  %s Download completed\n' "${GREEN}✔${RESET}"
                print_label "Artist" "$ARTIST"
                print_label "Album" "$ALBUM"
                print_label "Title" "$TITLE"
                print_label "Track" "${TRACK:-—}"
                print_label "LUFS" "$TARGET_LUFS"
                printf '  Saved:\n'
                printf '    %s\n' "$FINAL_FILE"
                printf '%s\n' "$line"
        fi
}

# ============================================================
# Entry point
# ============================================================
main() {
        URL="${1:-}"
        START="${2:-}"
        END="${3:-}"

        if [ -z "$URL" ]; then
                error "Usage: $0 <URL> [START] [END]"
                exit 1
        fi

        check_requirements

        if resume_menu; then

                case "$(get_checkpoint)" in

                metadata)
                        prompt_metadata
                        save_session
                        set_checkpoint "prompted"

                        compute_paths
                        save_session
                        set_checkpoint "paths"
                        ;;

                prompted)
                        compute_paths
                        save_session
                        set_checkpoint "paths"
                        ;;

                paths | downloaded | normalized | thumbnail | embedded)
                        # Already prepared or resuming from a later stage.
                        ;;

                *)
                        error "Unknown checkpoint: $(get_checkpoint)"
                        exit 1
                        ;;
                esac

        else

                fetch_metadata
                save_session
                set_checkpoint "metadata"

                prompt_metadata
                save_session
                set_checkpoint "prompted"

                compute_paths
                save_session
                set_checkpoint "paths"

        fi

        while :; do
                case "$(get_checkpoint)" in

                paths)
                        show_summary
                        check_existing

                        download_audio
                        save_session
                        set_checkpoint "downloaded"
                        ;;

                downloaded)
                        if [ -z "$TMP_FILE" ]; then
                                local files
                                shopt -s nullglob
                                files=("$TMP_DIR"/download.*)
                                shopt -u nullglob
                                TMP_FILE="${files[0]}"
                                [ -f "$TMP_FILE" ] || {
                                        error "Downloaded file is missing."
                                        exit 1
                                }
                        fi

                        get_source_sample_rate
                        save_session

                        normalize_audio
                        save_session
                        set_checkpoint "normalized"
                        ;;

                normalized)
                        download_thumbnail
                        save_session
                        set_checkpoint "thumbnail"
                        ;;

                thumbnail)
                        embed_metadata
                        save_session
                        set_checkpoint "embedded"
                        ;;

                embedded)
                        show_output_info
                        SUCCESS=1
                        print_final
                        break
                        ;;

                *)
                        error "Unknown checkpoint: $(get_checkpoint)"
                        exit 1
                        ;;
                esac
        done
}

main "$@"
