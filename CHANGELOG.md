# Changelog

All notable changes to Crate are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A read-only [Subsonic-compatible API](docs/subsonic.md), speaking protocol
  1.16.1 from `/rest`, so Symfonium, DSub, Feishin and friends can browse and
  stream the same library the web UI shows: `ping`, `getArtists`, `getIndexes`,
  `getArtist`, `getAlbum`, `getSong`, `getAlbumList2`, `search3`, `stream`,
  `download`, `getCoverArt`, `getMusicFolders`, `getScanStatus` and the empty
  answers a read-only server gives for playlists and stars. It signs in with the
  owner's existing credentials, accepts the session cookie, and refuses token
  auth with the protocol's code 41 because only a scrypt hash is stored. Nothing
  in it writes tags, ratings, playlists or scrobbles.

### Changed

- Release notes end with a **Full changelog** compare link. GitHub only adds that
  footer when it writes the notes itself, and these come from `CHANGELOG.md`.

### Fixed

- The terminal demo's caption no longer claims "1.4× speed": nothing in the
  repository could produce or verify that, and the file plays at real time.

## [3.4.1] - 2026-11-06

### Added

- A player bar in `/library`: album art, previous/play-pause/next, elapsed and
  total time, a seek slider, volume with mute, the queue position and a stop
  button. It drives a hidden `<audio>`, so it looks the same in every browser
  instead of borrowing whatever control the browser draws.
- Picking an album in `/library` shows that album alone - cover, name, track
  count and size - with an arrow back to the rest of the grid.
- Volume and mute are remembered per browser, so the bar opens where it was
  left; storage being unavailable falls back to full volume rather than an
  error.
- Keyboard control for the library player: space plays and pauses, the arrows
  move through the queue. Space stays a space inside a text field, and a focused
  button keeps the browser's own handling.
- `npm run dev` in `web/` runs the API and Vite from the working tree with hot
  reload, on ports of their own, so a change can be looked at before it is
  committed. It restarts the API when `dlAudio.sh` changes, which `node --watch`
  cannot see because the script is spawned rather than imported.

### Changed

- Images are published only from a release tag. A push to `main` runs the tests
  and the layout audit and stops there, so `latest` always names the newest
  release instead of the last thing merged; the branch and sha tags are gone
  with it. A manual run still stamps a version onto a fresh build.
- `test/repo.test.mjs` fails if publishing from `main` comes back: the tag
  gate, the tag list and `latest` are each asserted.

### Fixed

- The library player's icon buttons were squeezed to a few pixels by the base
  button padding, which drew the transport icons as dots; sized icon buttons now
  set their own box.
- A library row no longer carries a separate play triangle - the cover is the
  control - so it is one button instead of two near-identical ones.

## [3.4.0] - 2026-11-06

### Added

- Covers in `/library`, taken from the album folder rather than from this app's
  download log: a `cover`/`folder`/`front`/`album`/`artwork` image beside the
  tracks, or the picture embedded in the first audio file, extracted with ffmpeg
  and cached under the data folder. A file copied into the library by hand now
  shows its art too.
- Sorting in `/library` - album order, title, artist, album, recently added or
  largest first - applied on the server to the slice the page actually holds.
- A play-through queue in `/library`: pressing play on a list makes that list
  the queue, and next, previous and the end of a track move through it, so an
  album plays straight through instead of one file at a time.
- `scripts/release.mjs`, with a "One command" section in `RELEASING.md`: the
  version bump, the changelog heading, the comparison links, the tag and the
  GitHub release are one command, and it runs `test/repo.test.mjs` before
  tagging.
- `npm run demo` in `web/`, which records `assets/demo.gif` from a seeded
  throwaway instance so the README preview can be rebuilt rather than
  hand-captured.

### Changed

- The library walk also compares the root folder's mtime, so a download that
  lands in a new artist folder shows up on the next request instead of up to 20
  seconds later.
- The README's web preview is a longer tour: the queue, the overview, the
  library with covers and playback, and the settings page. The `/library` page
  is now part of the browser layout audit.

## [3.3.1] - 2026-11-06

A patch release for a first-run failure: the first review on a fresh install
aborted before it could list a track. It also carries the library browser and
the optional Watchtower service from the same day.

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

[Unreleased]: https://github.com/SmoothCLI/crate/compare/v3.4.1...HEAD
[3.4.1]: https://github.com/SmoothCLI/crate/releases/tag/v3.4.1
[3.4.0]: https://github.com/SmoothCLI/crate/releases/tag/v3.4.0
[3.3.1]: https://github.com/SmoothCLI/crate/releases/tag/v3.3.1
[3.3.0]: https://github.com/SmoothCLI/crate/releases/tag/v3.3.0
[3.2.0]: https://github.com/SmoothCLI/crate/releases/tag/v3.2.0
[3.1.1]: https://github.com/SmoothCLI/crate/releases/tag/v3.1.1
[3.1.0]: https://github.com/SmoothCLI/crate/releases/tag/v3.1.0
