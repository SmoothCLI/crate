# Changelog

All notable changes to Crate are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- An optional Watchtower service in `compose.yaml`, started with
  `docker compose --profile auto-update up -d`, which recreates the container
  when a new `latest` image is published. The README explains the pull-based
  update as well.
- `/library`: browse artists, albums and tracks, search them, and play files in
  place. It reads the folder layout instead of tags, so the listing matches what
  is on disk, and playback is range-served so a phone does not pull a whole
  FLAC to hear ten seconds.

### Fixed

- The first `--inspect` or `--plan` on a fresh state folder failed with
  `FAILED (exit 1, line 4112): prior="$(index_path "$eid")"`. `index_path`
  returned 1 for "no entry in the import index", and `set -e` adopted that
  status from the assignment, so a missing `index.tsv` - every install before
  its first download - aborted the run. The query now always succeeds; a test
  covers inspect and plan with no index file.

## [3.3.0] - 2026-11-06

A web-UI release: update notices are visible and skippable, the first run is a
proper form, and the image answers a health check. The terminal downloader is
unchanged.

### Added

- The release hint can be dismissed for one browser, or skipped for good, and
  the release notes can be read inline; both choices are stored against that
  release, so the next one still shows.
- A small badge on the Settings gear while a newer release is available.
- The admin System tab names the running release, the latest one found, and
  when the last check ran.
- `GET /api/health`: a public, path-free JSON summary (version, uptime, queue,
  library writability and disk) for monitors, now also the image healthcheck.
- The published image carries SLSA provenance and an SBOM.
- The README is rewritten around a Docker quick start, and a reverse-proxy
  guide covers Caddy and nginx for a public instance.

### Changed

- The first-run setup is a fuller form: inline field errors, a show/hide password
  toggle, a 10-character minimum (was 8) and the choice of whether guests may
  download, made before the instance exists.

### Fixed

- Cover art handed to the downloader now has to be a remote HTTP(S) image or an
  uploaded cover; a local path or `file://` URL is ignored instead of being
  passed through to the script.

## [3.2.0] - 2026-11-06

A minor release: the web UI now names the release it is running, links to the
project source, and tells the owner when a newer Crate has been published.

### Added

- The queue footer now names the running release and links to the project
  source, read from the script the server drives instead of duplicated in the
  UI. `GET /api/me` carries the version and repository URL.
- The owner is told when a newer release is published: the server checks the
  project's releases in the background every six hours and `/api/settings`
  carries the result, which the queue, the overview and Settings render as a
  one-line hint with a link to the release notes. Guests never receive the
  field, and the browser audit now covers the hint on the queue and the
  overview with a local stand-in for the releases API.

## [3.1.1] - 2026-11-06

A maintenance release: the server and the UI toolchain move to their current
majors, CI stopped stalling on flaky mirrors, and the project gained the files a
public repository is expected to carry. Nothing in the downloader changed - the
library layout, tags and flags are the same as 3.1.0.

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
- The UI builds with Vite 8 and `@vitejs/plugin-react` 6. The audit still passes
  at 390, 768 and 1440 px, and the bundle is slightly smaller.
- The `org.opencontainers.image.version` label now follows the stamped release
  version, so an image built by a manual publish run no longer reports a branch
  name.

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

[Unreleased]: https://github.com/SmoothCLI/crate/compare/v3.3.0...HEAD
[3.3.0]: https://github.com/SmoothCLI/crate/releases/tag/v3.3.0
[3.2.0]: https://github.com/SmoothCLI/crate/releases/tag/v3.2.0
[3.1.1]: https://github.com/SmoothCLI/crate/releases/tag/v3.1.1
[3.1.0]: https://github.com/SmoothCLI/crate/releases/tag/v3.1.0
