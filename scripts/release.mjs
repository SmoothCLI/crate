#!/usr/bin/env node
/**
 * Cut a release in one command.
 *
 *   node scripts/release.mjs minor            # bump, write the changelog
 *   node scripts/release.mjs 3.4.0 --dry-run  # show what would change
 *   node scripts/release.mjs minor --publish  # ... then commit, tag, push, release
 *
 * The version lives in `VERSION="..."` in dlAudio.sh and the notes live under
 * `## [Unreleased]` in CHANGELOG.md. Doing both by hand is how 3.3.1 ended up
 * carrying work that the project's own semver rules call a minor release, so
 * this does the three edits together and checks them with test/repo.test.mjs.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_URL = "https://github.com/SmoothCLI/crate";

const USAGE = `usage: node scripts/release.mjs <patch|minor|major|x.y.z> [--dry-run] [--publish]

  patch        a fix that changes no interface
  minor        a new flag, endpoint, page or admin setting
  major        a changed flag, a renamed variable, a library layout change
  --dry-run    print the edits without writing them
  --publish    commit, tag, push, and create the GitHub release`;

const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const write = (file, text) => fs.writeFileSync(path.join(ROOT, file), text);
const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const numbers = (version) => version.split(".").map(Number);

function bump(current, kind) {
  const [major, minor, patch] = numbers(current);
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function newer(candidate, current) {
  const left = numbers(candidate);
  const right = numbers(current);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i];
  }
  return false;
}

// The body between "## [Unreleased]" and the next release heading.
function unreleasedBody(changelog) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line.trim() === "## [Unreleased]");
  if (start === -1) die("CHANGELOG.md has no `## [Unreleased]` heading");
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith("## [")) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

// One release's section, heading included, for the GitHub release notes.
function section(changelog, version) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start === -1) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith("## [")) {
      end = i;
      break;
    }
  }
  return lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
}

function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((arg) => arg.startsWith("--")));
  const target = args.find((arg) => !arg.startsWith("--")) ?? "";
  const dryRun = flags.has("--dry-run");
  const publish = flags.has("--publish");

  if (!target) die(USAGE);

  const current = read("dlAudio.sh").match(/^VERSION="([^"]+)"/m)?.[1];
  if (!current) die("no VERSION=\"...\" line in dlAudio.sh");

  const known = new Set(["patch", "minor", "major"]);
  const version = known.has(target) ? bump(current, target) : target;
  if (!/^\d+\.\d+\.\d+$/.test(version)) die(`${target} is not a version. ${USAGE}`);
  if (!newer(version, current)) die(`${version} is not newer than ${current}. ${USAGE}`);

  const body = unreleasedBody(read("CHANGELOG.md"));
  if (!body) {
    die(
      "[Unreleased] is empty. Describe what changed there first - a release with no\n" +
        "notes is a release nobody can read.",
    );
  }

  if (publish) {
    const dirty = git("status", "--porcelain");
    if (dirty) {
      die(`The working tree has changes. Commit or stash them before publishing:\n${dirty}`);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const changelog = read("CHANGELOG.md")
    .replace(
      /^## \[Unreleased\]$/m,
      `## [Unreleased]\n\n## [${version}] - ${today}`,
    )
    .replace(
      /^\[Unreleased\]: .*$/m,
      `[Unreleased]: ${REPO_URL}/compare/v${version}...HEAD\n` +
        `[${version}]: ${REPO_URL}/releases/tag/v${version}`,
    );
  const script = read("dlAudio.sh").replace(/^VERSION="[^"]+"/m, `VERSION="${version}"`);

  if (dryRun) {
    process.stdout.write(`Would release ${current} -> ${version}\n\n`);
    process.stdout.write(`dlAudio.sh: VERSION="${current}" -> VERSION="${version}"\n\n`);
    process.stdout.write(`CHANGELOG.md:\n${body}\n\n`);
    process.stdout.write("Nothing written (--dry-run).\n");
    return;
  }

  write("CHANGELOG.md", changelog);
  write("dlAudio.sh", script);

  // The repository test is the same one CI runs: it fails if the script version
  // and the newest changelog heading disagree.
  try {
    execFileSync(process.execPath, ["--test", "test/repo.test.mjs"], {
      cwd: ROOT,
      stdio: "inherit",
    });
  } catch {
    die(
      `\ntest/repo.test.mjs failed after the bump. The files are already written;\n` +
        `fix the changelog or ${ROOT}/dlAudio.sh and run this again, or revert with\n` +
        `  git checkout -- CHANGELOG.md dlAudio.sh`,
    );
  }

  process.stdout.write(`\nBumped ${current} -> ${version}.\n`);

  if (!publish) {
    process.stdout.write(
      "\nNext, if this is the one:\n" +
        "  node --test test/*.test.mjs\n" +
        "  cd web && npm run typecheck && npm test && npm run build && cd ..\n" +
        `  node scripts/release.mjs ${version} --publish\n` +
        "\n(That second run only publishes: the files already say " + version + ".)\n",
    );
    return;
  }

  git("add", "CHANGELOG.md", "dlAudio.sh");
  git("commit", "-m", `Release ${version}`);
  git("tag", "-a", `v${version}`, "-m", `Crate ${version}`);
  git("push", "origin", "main", "--follow-tags");
  process.stdout.write(`\nPushed v${version}.\n`);

  const notes = section(read("CHANGELOG.md"), version);
  execFileSync(
    "gh",
    [
      "release",
      "create",
      `v${version}`,
      "--title",
      `Crate ${version}`,
      "--notes",
      notes,
      "--latest",
    ],
    { cwd: ROOT, stdio: "inherit" },
  );

  process.stdout.write(
    `\nReleased ${version}.\n` +
      "  gh run list --workflow=publish.yml --limit 1\n" +
      `  docker compose pull && docker compose up -d   # then /api/health says ${version}\n`,
  );
}

main();
