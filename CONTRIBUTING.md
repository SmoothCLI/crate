# Contributing to Crate

Thanks for taking the time to help. Bug reports and small, focused pull
requests are both welcome.

## What lives where

| Path | Contents |
|---|---|
| `dlAudio.sh` | The downloader: probing, `yt-dlp`, `ffmpeg`, loudnorm, MusicBrainz, tagging. |
| `web/server/` | The Express server: queue, jobs, library scanning, covers, admin API. |
| `web/src/` | The React UI. |
| `test/` | Tests for the script and for repository-level consistency. |
| `web/test/` | Server suite, plus the browser layout audit. |

## Requirements

- `yt-dlp`, `ffmpeg`/`ffprobe`, `jq` and `curl` for the downloader.
- Node 22 or newer for the web app and the test suites.

## Running it

```sh
./dlAudio.sh <URL>                # the terminal flow

cd web
npm ci
npm run build
AUDIODL_PASSWORD=dev node server/index.mjs    # http://localhost:8080
```

`npm run dev` runs Vite on port 5173 and proxies `/api` to port 8080, so keep
the server running in another terminal. The admin page is at `/admin`, and it
shows the resolved paths, the queue and any diagnostics.

## Tests

Run what your change touches; CI runs all of it.

```sh
node --test test/*.test.mjs        # downloader + repository checks
cd web
npm run typecheck
npm test                           # server suite, no browser needed
npm run build
npx playwright install chromium    # once
npm run test:layout                # real browser at 390, 768 and 1440 px
```

The layout audit needs a built UI (`npm run build`) and is deliberately slow, so
it is a separate command. It asserts that nothing scrolls sideways and that no
card or tab strip leaves the viewport; there are no screenshot baselines, so a
restyle does not need re-approving.

If your change affects the published image:

```sh
docker compose -f compose.dev.yaml up --build
```

## Commits and pull requests

- Keep commits small and single-purpose: a fix, a test, a doc update. Several
  focused commits are easier to review and to revert than one large one.
- Write the subject in the imperative mood (`Fix the queue retry`, not `Fixed`
  or `Fixes`), and explain the *why* in the body when it is not obvious.
- Keep the existing style: the script stays POSIX-ish `bash` with `set -euo
  pipefail`, the server is plain ESM with no build step, and the UI uses the
  existing Tailwind classes and CSS variables rather than new one-off styling.
- Add a test when you change behaviour that a test can describe. If you cannot,
  say in the pull request why.
- CI must be green: tests, typecheck, the UI build, the layout audit and the
  image build all run on every pull request.

## Things not to commit

`data/` holds the password hash, cookies, the saved queue, per-job workspaces
and guest preferences. It is ignored on purpose, and so are `node_modules/`,
`dist/` and any downloaded audio. If a change needs new state, put it under
`data/` or a temp directory.

## Documentation

User-facing docs live in `README.md` (terminal and Docker), `web/README.md` (the
full web manual) and `MUSICBRAINZ.md` (matching behaviour). Every released
version needs an entry in `CHANGELOG.md`; the `Unreleased` section is where a
change lands first.

## Security

Please do not open a public issue for a way to bypass the owner password,
escape the library directory, or otherwise expose an instance. Report it
privately through GitHub's *Security* tab (Report a vulnerability).

## License

By contributing you agree that your work is released under the [MIT
License](LICENSE).
