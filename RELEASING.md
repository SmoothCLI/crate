# Releasing Crate

A release is a version bump, a changelog entry, a tag, and an image that carries
the same number. CI does the image; the rest is three small commits.

## Versioning

Crate uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The
version lives in one place in the downloader:

```sh
VERSION="3.1.0"    # dlAudio.sh, near the top
```

`test/repo.test.mjs` fails when that string and the newest `CHANGELOG.md`
heading disagree, so the two cannot drift.

- **Patch** (`3.1.1`) - a fix that changes no interface.
- **Minor** (`3.2.0`) - a new flag, endpoint, or admin setting.
- **Major** (`4.0.0`) - a changed flag, a renamed environment variable, a
  library layout change, or anything that breaks an existing library.

## One command

```sh
node scripts/release.mjs minor            # bump + write the changelog
node scripts/release.mjs 3.4.0 --dry-run  # show the edits only
node scripts/release.mjs minor --publish  # commit, tag, push, cut the release
```

`scripts/release.mjs` reads `VERSION` from `dlAudio.sh`, computes the next
number (or takes one explicitly), moves the `[Unreleased]` notes under the new
heading, rolls the comparison links forward, and then runs
`test/repo.test.mjs` - the same check CI runs - so a version and a changelog
cannot disagree. It refuses to run on an empty `[Unreleased]`, which is what
keeps a release from shipping without notes. `--publish` commits, tags, pushes
and creates the GitHub release from the changelog section.

Run the full suites before `--publish`:

```sh
node --test test/*.test.mjs
cd web && npm run typecheck && npm test && npm run build && cd ..
```

The checklist below is what the script does, for when it is not the right tool
(a hotfix branch, a release from an older tree).

## Checklist

1. **Decide the version** from the changes under `Unreleased`.

2. **Changelog.** Rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`, keep an
   empty `## [Unreleased]` above it, and update the comparison links at the
   bottom of `CHANGELOG.md`:

   ```md
   [Unreleased]: https://github.com/SmoothCLI/crate/compare/vX.Y.Z...HEAD
   [X.Y.Z]: https://github.com/SmoothCLI/crate/releases/tag/vX.Y.Z
   ```

3. **Version string.** Set `VERSION` in `dlAudio.sh` to the same number.

4. **Test the release commit.**

   ```sh
   node --test test/*.test.mjs
   cd web && npm run typecheck && npm test && npm run build && cd ..
   docker compose -f compose.dev.yaml up --build     # if the image changed
   ```

5. **Commit, then tag.**

   ```sh
   git commit -am "Release X.Y.Z"
   git tag -a vX.Y.Z -m "Crate X.Y.Z"
   git push origin main --follow-tags
   ```

6. **Watch the tag build.** `.github/workflows/publish.yml` publishes
   `ghcr.io/smoothcli/crate:X.Y.Z`, the moving `X.Y`, and `latest`. Check the run
   and then confirm the pull works without credentials:

   ```sh
   docker pull ghcr.io/smoothcli/crate:X.Y.Z
   ```

7. **Publish the release** from the tag, with the changelog section as the
   notes:

   ```sh
   gh release create vX.Y.Z --title "Crate X.Y.Z" --notes-file notes.md
   ```

   Mark it *latest* unless it is a pre-release.

8. **Verify the result** on the package page: the version tag exists, `X.Y`
   points at the same digest, and the package is still public.

## Rebuilding an image for a version that already shipped

The workflow takes a manual `version` input, which stamps the version and its
minor tag onto a fresh build:

```sh
gh workflow run publish.yml --ref main -f version=X.Y.Z
```

Use it when a build was lost, or when the workflow named a different image at
the time of the release. To rebuild the *source* of an old release rather than
today's `main`, run it against a branch created from that tag:

```sh
git checkout -b image/vX.Y.Z vX.Y.Z
git checkout main -- .github/workflows/publish.yml
git commit -m "Publish the X.Y.Z image from the release tree"
git push -u origin image/vX.Y.Z
gh workflow run publish.yml --ref image/vX.Y.Z -f version=X.Y.Z
```

`.github` is in `.dockerignore`, so the workflow swap does not change the image
contents.

## Hotfixes

Branch from the release tag, not from `main`:

```sh
git checkout -b hotfix/X.Y.Z vX.Y.(Z-1)
```

Fix, add a `### Fixed` entry to a new `## [X.Y.Z]` section, bump `VERSION`, tag,
and merge the branch back to `main` afterwards so the fix is not lost.
