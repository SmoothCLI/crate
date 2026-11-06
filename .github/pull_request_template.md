## What this changes

<!-- One or two sentences. What was wrong, or what is new? -->

## Why

<!-- The reason for the change, and anything a reviewer should know. -->

## Checks

- [ ] `node --test test/*.test.mjs` passes
- [ ] `cd web && npm run typecheck` passes
- [ ] `cd web && npm test` passes
- [ ] `cd web && npm run build` passes
- [ ] `cd web && npm run test:layout` passes (if the UI changed)
- [ ] `CHANGELOG.md` has an entry under `Unreleased` (if behaviour changed)
