# Changelog

All notable changes to Crate are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Browser layout audit in CI: the Playwright run at 390, 768 and 1440 px now
  gates the image build instead of living only on a developer's machine. Chromium
  is cached by lockfile hash, and the audit is skipped when a push cannot have
  changed what it renders.
- `CONTRIBUTING.md`, `SECURITY.md`, `RELEASING.md`, issue forms, a pull request
  template and weekly Dependabot updates.
- A repository consistency test (`test/repo.test.mjs`) that fails when the
  workflow, compose files, README, changelog and script version drift apart - the
  class of breakage a rename causes.

### Changed

- The server runs on Express 5.3 instead of 4.22, and the UI typechecks with
  TypeScript 7. Neither changed a call site: the whole server suite passes on
  the new majors.

### Fixed

- The installation steps told you to `cd audioDL` after cloning the renamed
  repository.

## [3.1.0] - 2026-11-06

The first public release: the terminal downloader and the self-hosted web UI
that drives it.

### Added

- Terminal workflow in `dlAudio.sh`: probe a track or playlist, pick the best
  audio, normalise to a target LUFS, match the release in MusicBrainz, and write
  tags, cover art, lyrics and ReplayGain.
- Library layout `MUSIC_DIR/ARTIST/ALBUM/[NN - ]TITLE.<format>` for `m4a`,
  `mp3`, `opus`, `flac` and `wav`, with resumable sessions, a resumable import
  index for playlists, single-instance locking and multi-artist tags.
- Web UI in `web/`: a review card with per-track titles, numbers, dates, cover
  art and fuzzy artist suggestions from the existing library.
- Download queue with live stage progress, retry after a crash, and an optional
  webhook on completion.
- Guest downloads without a password; guest audio is encoded on demand and
  streamed, never written into the library.
- `/admin` for the library, formats, guest quota, cookies for signed-in sources,
  diagnostics and two-factor authentication.
- Container image `ghcr.io/smoothcli/crate` for `linux/amd64` and `linux/arm64`,
  built and published by `.github/workflows/publish.yml`.
- `compose.yaml` that runs the published image, and `compose.dev.yaml` that
  builds the working copy.

### Changed

- The project is named Crate throughout the documentation, the container image
  and the compose files. The downloader keeps its `dlAudio.sh` filename and the
  `AUDIODL_*` environment variables, which the server and the tests refer to.

[Unreleased]: https://github.com/SmoothCLI/crate/compare/v3.1.0...HEAD
[3.1.0]: https://github.com/SmoothCLI/crate/releases/tag/v3.1.0
