<p align="center">
  <img src="https://github.com/SmoothCLI/.github/blob/main/profile/SmoothCLI.png?raw=true" width="150">
</p>

<h1 align="center">Crate</h1>

<p align="center">
  A smooth, interactive music downloader powered by yt-dlp and FFmpeg.
</p>

<p align="center">
  <img src="https://img.shields.io/github/license/SmoothCLI/crate">
  <img src="https://img.shields.io/github/stars/SmoothCLI/crate">
  <img src="https://img.shields.io/github/last-commit/SmoothCLI/crate">
  <img src="https://img.shields.io/badge/platform-Linux-blue">
</p>

---

Crate is a terminal-based music downloader that combines `yt-dlp`, `FFmpeg`, and related tools into a simple guided workflow.

It handles downloading, metadata, artwork, normalization, and music library organization automatically, creating clean libraries ready for Jellyfin and other media servers.

No complicated commands.  
No remembering dozens of flags.

Just provide a URL and let Crate handle the rest.

---

## Preview

<p align="center">
  <img src="assets/demo.gif" width="880" alt="Pasting a SoundCloud link, reviewing the tags and queueing the download">
</p>

<p align="center">
  <em>The web UI: paste a link, review the tags, queue it (2× speed).</em>
</p>

<p align="center">
  <img src="assets/demo-cli.gif" width="880" alt="A terminal run inspecting, downloading, normalising and tagging the same SoundCloud track">
</p>

<p align="center">
  <em>Or from the terminal: the same link inspected, downloaded, normalised and tagged (1.4× speed).</em>
</p>

---

## Highlights

- 🎵 Single command workflow: paste a URL, Crate does the rest.
- 🎧 Best available audio selection with EBU R128 loudness normalization.
- 📂 Automatic music library organization.
- 📝 Embedded metadata and artwork handling.
- ✨ Optional enhanced terminal UI powered by `gum`.
- 🔄 Safe workflows with resume support and duplicate detection.
- 🖥️ Optional self-hosted web UI with a review card, queue and guest streaming.

---

## Why Crate?

Tools like `yt-dlp` and `FFmpeg` are incredibly powerful, but everyday workflows can become repetitive and difficult to remember.

Crate does not replace these tools.

Instead, it combines them into a smoother workflow so you can focus on your music instead of remembering commands, flags, and filters.

---

## How it works

Crate follows a simple processing pipeline:

```text
URL
 ↓
Metadata extraction
 ↓
Audio download
 ↓
Audio normalization
 ↓
Artwork processing
 ↓
Metadata embedding
 ↓
Organized music library
````

---

## Features

### 🌐 Supported sources

Powered by `yt-dlp`, Crate supports hundreds of websites.

Tested sources include:

* YouTube
* SoundCloud
* Many other `yt-dlp` compatible services

---

### 🎧 Automatic audio processing

Crate automatically handles:

* Best available audio stream selection.
* EBU R128 loudness normalization.
* AAC encoding for modern compatibility.
* Sample rate preservation whenever possible.

The result:

```text
Artist/
└── Album/
    └── Track.m4a
```

A clean and organized music library with embedded metadata and artwork, optimized for Jellyfin, media servers, and everyday playback.

---

### 📝 Metadata management

Crate automatically retrieves metadata when available.

Supported fields:

* Artist
* Album
* Title
* Track number
* Release date

Metadata can be reviewed and edited before processing.

Final metadata is embedded directly into the output file.

---

### 🖼️ Artwork support

Crate supports automatic artwork handling:

* Downloads cover artwork when available.
* Converts and optimizes images using ImageMagick.
* Embeds artwork into the final audio file.
* Optional terminal previews using `timg` or `chafa`.

---

### 📂 Music library organization

Files are automatically organized into a clean structure:

```text
Music/
└── Artist/
    └── Album/
        └── Track.m4a
```

The music directory can be customized for:

* Local storage
* NAS libraries
* External drives
* Media servers

---

### 🔄 Reliable workflows

Crate includes features designed for daily use:

* Resume support after interrupted downloads.
* Session checkpoints.
* Existing file detection.
* Safe filename handling.
* Protection against accidental overwrites.

---

### ✨ Beautiful terminal UI

With optional [`gum`](https://github.com/charmbracelet/gum) support, Crate provides:

* Styled messages.
* Interactive prompts.
* Selection menus.
* Loading spinners.
* Improved terminal feedback.

Without `gum`, Crate continues to work in a normal terminal.

---

## Requirements

Make sure these tools are available in your `$PATH`.

### Required

* `bash`
* `yt-dlp`
* `ffmpeg`
* `ffprobe`
* ImageMagick
* `curl`
* `file`
* `fzf`

### Optional

* `jq` — enables two-pass loudness normalization.
* `gum` — enhanced terminal interface.
* `timg` / `chafa` — artwork preview support.

Most Linux distributions provide these packages through their default package manager.

---

## Installation

Clone the repository:

```bash
git clone https://github.com/SmoothCLI/crate.git
cd audioDL
```

Make the script executable:

```bash
chmod +x dlAudio.sh
```

Run:

```bash
./dlAudio.sh <URL>
```

For easier access, you can add it to your `$PATH`:

```bash
sudo ln -s "$(pwd)/dlAudio.sh" /usr/local/bin/crate
```

---

## Quick Start

Download a SoundCloud track:

```bash
crate https://soundcloud.com/example/song
```

Download audio from YouTube:

```bash
crate https://youtube.com/watch?v=EXAMPLE
```

Example workflow:

```text
Fetching metadata...

Artist: Example Artist
Album: Example Album
Title: Example Track

Continue? [Y/n]

Downloading audio...
✔ Download complete.

Normalizing audio...
✔ Normalization complete.

Embedding metadata...
✔ Metadata embedded.

Download completed.

Saved:
~/Music/Example Artist/Example Album/Example Track.m4a
```

---

## Web UI

The same downloader also ships with a self-hosted web app in `web/`: paste a link, review the tags and cover art it found, fix what you like, and queue it. The script still does all the downloading, normalizing and tagging.

```bash
cd web
npm install
npm run build
AUDIODL_PASSWORD=choose-something node server/index.mjs
```

Open `http://localhost:8080`; the first visit asks for an instance name and an owner password. Guests can download too - their audio is streamed straight to the browser and never written to the library.

The image is published to the GitHub Container Registry, so Docker only has to
pull it:

```bash
docker pull ghcr.io/smoothcli/crate:latest
docker compose up -d
```

While changing the server or the UI, build the image from this checkout instead:

```bash
docker compose -f compose.dev.yaml up --build
```

Then open `http://localhost:8099`. The full manual - queue, `/admin`, formats, cover art, guest limits - is in [`web/README.md`](web/README.md).

---

## Configuration

Configuration variables can be found in the `CONFIGURATION` section of the script.

Example:

```bash
MUSIC_DIR="$HOME/Music"
TARGET_LUFS="-9"
ARTWORK_SIZE="1000"
```

Available options:

* `MUSIC_DIR`
  Base directory for the organized music library.

* `TARGET_LUFS`
  Target loudness level used during normalization.

* `ARTWORK_SIZE`
  Maximum artwork size in pixels.

Changes are applied immediately.
No build process is required.

---

## Uninstall

If installed system-wide:

```bash
sudo rm /usr/local/bin/crate
```

Downloaded music files are not removed automatically.

---

## Project status

Crate is considered feature-complete for its current workflow.

Future updates will focus on:

* Improving reliability.
* Fixing bugs.
* Refining the user experience.
* Adding features that fit the existing workflow.

Suggestions and bug reports are welcome through GitHub issues.

---

## Contributing

Contributions are welcome.

To contribute:

1. Fork the repository.
2. Create a feature branch.
3. Make your changes.
4. Test your changes.
5. Open a pull request with a clear explanation.

Please keep the workflow simple and avoid adding unnecessary complexity to the user interface.

---

## Built with

* [yt-dlp](https://github.com/yt-dlp/yt-dlp)
* [FFmpeg](https://ffmpeg.org/)
* [gum](https://github.com/charmbracelet/gum)
* [jq](https://github.com/jqlang/jq)

---

## License

Crate is released under the [MIT License](LICENSE).

<p align="center">
  Made with ❤️ and too much terminal time.
</p>
