# Notes for automated contributors

Crate is a self-hosted downloader and web queue. Keep changes small, tested,
and written in the project's existing voice.

## Commits

- One behaviour per commit, with a message that explains why it changed.
- No attribution of any kind: no "Generated with …" line, no co-author
  trailer, and no assistant, vendor, tool or product name in commit messages,
  code comments, documentation, changelogs, UI copy or release notes.
- The work belongs to the repository, so writing never names the assistant or
  the tooling that helped produce it.

## Checks

Run what a change touches; CI runs all of it:

```sh
node --test test/*.test.mjs
cd web && npm run typecheck && npm test && npm run build
```

The layout audit (`web/test/layout.mjs`) needs Chromium and a built UI, so it is
a separate, slower command.
