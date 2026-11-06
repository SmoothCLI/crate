<p align="center">
  <img src="https://github.com/SmoothCLI/.github/blob/main/profile/SmoothCLI.png?raw=true" width="120" alt="SmoothCLI">
</p>

<h1 align="center">Crate</h1>

<p align="center">
  A guided music downloader for the terminal, with a self-hosted web queue.<br>
  <sub>yt-dlp · FFmpeg · MusicBrainz · a clean library when it is done.</sub>
</p>

<p align="center">
  <a href="https://github.com/SmoothCLI/crate/releases/latest"><img src="https://img.shields.io/github/v/release/SmoothCLI/crate?style=flat-square" alt="Latest release"></a>
  <a href="https://github.com/SmoothCLI/crate/actions/workflows/publish.yml"><img src="https://img.shields.io/github/actions/workflow/status/SmoothCLI/crate/publish.yml?label=build&style=flat-square" alt="Build"></a>
  <a href="https://github.com/SmoothCLI/crate/stargazers"><img src="https://img.shields.io/github/stars/SmoothCLI/crate?style=flat-square" alt="Stars"></a>
  <a href="https://github.com/SmoothCLI/crate/commits/main"><img src="https://img.shields.io/github/last-commit/SmoothCLI/crate?style=flat-square" alt="Last commit"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/SmoothCLI/crate?style=flat-square" alt="MIT"></a>
  <img src="https://img.shields.io/badge/platform-linux-2f3437?style=flat-square" alt="Linux">
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="web/README.md">Web manual</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="docs/reverse-proxy.md">Reverse proxy</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

---

Crate turns a track or playlist URL into a tagged, normalized file inside a
library that Jellyfin, Navidrome and friends already understand. It wraps
`yt-dlp`, FFmpeg and MusicBrainz so you do not have to remember the flags.

The same engine ships with a web UI: paste a link, review what it found, fix the
tags or cover, and queue it. Guests can download too, without ever writing into
your library.

## Preview

<p align="center">
  <img src="assets/demo.gif" width="880" alt="Pasting a SoundCloud link, reviewing the tags and queueing the download">
</p>

<p align="center">
  <sub><b>Web UI</b> — paste a link, review the tags, queue it (2× speed).</sub>
</p>

<p align="center">
  <img src="assets/demo-cli.gif" width="880" alt="A terminal run inspecting, downloading, normalising and tagging the same SoundCloud track">
</p>

<p align="center">
  <sub><b>Terminal</b> — the same link inspected, downloaded, normalized and tagged (1.4× speed).</sub>
</p>

## Quick start

The fastest path is the published image. It already contains `yt-dlp`, FFmpeg,
`jq`, Python and mutagen, and runs as your user so files are not owned by root.

```bash
git clone https://github.com/SmoothCLI/crate.git
cd crate
docker compose up -d
```

Open **http://localhost:8099** and finish the one-time setup at `/setup`: pick an
instance name, an owner username and a password. The library is `MUSIC_DIR` from
your environment, `~/Music` by default, mounted at the same path inside the
container.

Prefer to run without Docker? See [From a checkout](#from-a-checkout).

## What it does

| | |
|---|---|
| **One link in** | A track or a whole playlist; every entry is listed with its title and duration before anything is written. |
| **The right audio** | Best available stream, EBU R128 loudness normalization, AAC by default, optional Opus/MP3/FLAC/WAV. |
| **Real metadata** | MusicBrainz matching, artist/album/title/track/date, multi-artist tags, genre suggestions from the library. |
| **Cover art** | Fetched, resized and embedded — or uploaded/dropped in the web UI, per album or per track. |
| **A tidy library** | `ARTIST/ALBUM/[NN - ]TITLE.format`, existing files detected, resumable sessions, duplicate fingerprints. |
| **A queue that survives** | Live stage progress over SSE, retry after a crash, per-host concurrency caps, optional webhook. |
| **Guests, safely** | Guest downloads are encoded on the server and streamed to the browser; nothing lands in the library. |
| **Owner tools** | `/admin` for formats, quota, cookies for signed-in sources, diagnostics, 2FA and backups. |

## How it works

```text
URL
 │
 ├─ inspect ──── title, duration, artist, album, cover (yt-dlp + MusicBrainz)
 │
 ├─ review ───── fix tags, pick tracks, choose a cover (web UI or prompts)
 │
 ├─ download ─── best audio stream
 ├─ normalize ── EBU R128 to the target LUFS
 ├─ tag ──────── metadata, artwork, date, ReplayGain
 │
 └─ write ────── ARTIST/ALBUM/[NN - ]TITLE.format
```

Nothing is downloaded until you have seen what will be downloaded.

## Installation

### Docker (recommended)

```bash
docker pull ghcr.io/smoothcli/crate:latest
docker compose up -d
```

`compose.yaml` pulls the published image. While changing the server or the UI,
build the working copy instead:

```bash
docker compose -f compose.dev.yaml up --build
```

### From a checkout

Requirements: `bash`, `yt-dlp`, `ffmpeg`, `ffprobe`, ImageMagick, `curl`, `file`,
`fzf`; optional `jq` (two-pass loudness), `gum` (nicer terminal UI), and
`timg`/`chafa` (artwork previews).

```bash
git clone https://github.com/SmoothCLI/crate.git
cd crate
chmod +x dlAudio.sh
./dlAudio.sh https://soundcloud.com/example/song
```

Put it on your `PATH` if you like:

```bash
sudo ln -s "$(pwd)/dlAudio.sh" /usr/local/bin/crate
```

For the web UI from source:

```bash
cd web
npm ci
npm run build
AUDIODL_PASSWORD=choose-something node server/index.mjs
```

The UI is then on **http://localhost:8080**.

## Configuration

### Web server

Set these in a `.env` next to `compose.yaml`, or on the command line. Everything
except `AUDIODL_PASSWORD` can also be changed later at `/admin`.

| Variable | Default | Meaning |
|---|---|---|
| `AUDIODL_PASSWORD` | — | Sets the owner password on startup; skips `/setup`. |
| `MUSIC_DIR` | `~/Music` | Library root. Mounted at the same path in the container. |
| `MUSICBRAINZ_USER_AGENT` | `audioDL/<version>` | Sent to MusicBrainz; set a contact URL or e-mail. |
| `AUDIODL_GUEST` | `1` | `0` requires the password for every download. |
| `AUDIODL_CONCURRENCY` | `2` | Initial jobs that may run at once. |
| `AUDIODL_PER_HOST` | `2` | Initial cap per source host. |
| `AUDIODL_WEBHOOK` | — | Initial webhook URL for finished jobs. |
| `AUDIODL_PORT` | `8080` | HTTP port inside the container. |
| `AUDIODL_HOST` | `0.0.0.0` | Bind address; `127.0.0.1` keeps it local-only. |
| `AUDIODL_DATA` | `web/data` | Settings, saved queue, workspaces. |
| `AUDIODL_BIN` | `../dlAudio.sh` | Path to the downloader. |

The compose file publishes **8099** on the host. State lives in `./data`; the
music library is whatever `MUSIC_DIR` points at.

### Terminal script

The defaults sit near the top of `dlAudio.sh`:

```bash
MUSIC_DIR="$HOME/Music"
TARGET_LUFS="-9"
ARTWORK_SIZE="1000"
```

`./dlAudio.sh --help` lists the flags; `--version` prints the running release.

## Documentation

- [`web/README.md`](web/README.md) — the queue, `/admin`, formats, guests, cookies, covers, troubleshooting.
- [`docs/reverse-proxy.md`](docs/reverse-proxy.md) — HTTPS and a public instance with Caddy or nginx, including SSE settings.
- [`MUSICBRAINZ.md`](MUSICBRAINZ.md) — matching rules and the artist map.
- [`CHANGELOG.md`](CHANGELOG.md) — every release.
- [`RELEASING.md`](RELEASING.md) — how versions, tags and images are made.

## Development

```bash
# terminal script tests (needs ffmpeg/jq)
node --test test/*.test.mjs

# web UI: typecheck, server suite, build, browser audit
cd web
npm ci
npm run typecheck
npm test
npm run build
npx playwright install chromium   # once
npm run test:layout
```

The browser audit runs a real Chromium at 390, 768 and 1440 px against a seeded
server. There are no screenshot baselines on purpose.

Commits follow the present tense, one idea per commit; [`CONTRIBUTING.md`](CONTRIBUTING.md)
has the details.

## Security

Report vulnerabilities privately as described in [`SECURITY.md`](SECURITY.md).
A public instance should sit behind HTTPS — see the
[reverse-proxy guide](docs/reverse-proxy.md) — and guest access can be turned off
entirely at `/admin#guests`.

## License

[MIT](LICENSE). Crate is a workflow around excellent tools, not a replacement for
them: [yt-dlp](https://github.com/yt-dlp/yt-dlp), [FFmpeg](https://ffmpeg.org/),
[gum](https://github.com/charmbracelet/gum), [jq](https://github.com/jqlang/jq).

<p align="center">
  <sub>Built for people who would rather listen than remember flags.</sub>
</p>
