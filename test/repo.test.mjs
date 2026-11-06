import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Repository-level checks. These are cheap and boring on purpose: they catch the
// kind of breakage that no unit test sees, such as the workflow publishing one
// image name while compose pulls another, a release the changelog never
// mentions, or a README that still points at the repository's old name.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const exists = (file) => fs.existsSync(path.join(ROOT, file));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const REPO = "SmoothCLI/crate";
const IMAGE = "ghcr.io/smoothcli/crate";

test("the script version is the newest one the changelog documents", () => {
  const version = read("dlAudio.sh").match(/^VERSION="([^"]+)"/m)?.[1];
  assert.ok(version, "no VERSION= line in dlAudio.sh");

  const changelog = read("CHANGELOG.md");
  assert.match(
    changelog,
    new RegExp(`^## \\[${esc(version)}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m"),
    `CHANGELOG.md has no "## [${version}]" section`,
  );

  const released = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]);
  assert.ok(released.length > 0, "the changelog lists no release");
  assert.equal(released[0], version, "the newest changelog entry is not the script version");
});

test("the workflow publishes the image compose pulls", () => {
  const workflow = read(".github/workflows/publish.yml");
  const declared = workflow.match(/^\s+IMAGE:\s*(\S+)\s*$/m)?.[1];
  assert.equal(declared, IMAGE, "the workflow's IMAGE does not match the documented image");

  const compose = read("compose.yaml");
  assert.match(
    compose,
    new RegExp(`image:\\s*${esc(IMAGE)}:latest\\b`),
    "compose.yaml does not pull the published image",
  );

  const dev = read("compose.dev.yaml");
  assert.match(dev, /^\s+build:/m, "compose.dev.yaml does not build from the checkout");
  assert.doesNotMatch(dev, /ghcr\.io/, "compose.dev.yaml should build, not pull");
});

test("a manual publish stamps the version and its moving minor tag", () => {
  const workflow = read(".github/workflows/publish.yml");
  assert.match(workflow, /^\s*workflow_dispatch:/m);
  assert.match(workflow, /inputs:\n\s+version:/, "no version input for a manual run");
  assert.match(
    workflow,
    /type=semver,pattern=\{\{major\}\}\.\{\{minor\}\}/,
    "tag pushes no longer produce the minor tag",
  );
  assert.match(
    workflow,
    /steps\.minor\.outputs\.value/,
    "a manual run would not produce the minor tag",
  );
});

test("compose and the README agree on the repository and image", () => {
  const readme = read("README.md");
  assert.match(
    readme,
    new RegExp(`git clone https://github\\.com/${esc(REPO)}\\.git`),
    "the clone URL does not match the repository",
  );
  assert.match(readme, /^cd crate$/m, "the clone instructions do not change into the right folder");
  assert.match(
    readme,
    new RegExp(esc(IMAGE)),
    "the README never names the published image",
  );

  for (const badge of ["license", "stars", "last-commit"]) {
    assert.ok(
      readme.includes(`img.shields.io/github/${badge}/${REPO}`),
      `the ${badge} badge does not point at ${REPO}`,
    );
  }
});

test("the demos the README shows are present", () => {
  const readme = read("README.md");
  for (const asset of ["assets/demo.gif", "assets/demo-cli.gif"]) {
    assert.ok(readme.includes(asset), `the README does not reference ${asset}`);
    assert.ok(exists(asset), `${asset} is missing`);
    assert.ok(fs.statSync(path.join(ROOT, asset)).size > 10_000, `${asset} looks empty`);
  }
});

test("the repository ships the files GitHub expects", () => {
  for (const file of [
    "LICENSE",
    "README.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "compose.yaml",
    "compose.dev.yaml",
    "Dockerfile",
    ".github/pull_request_template.md",
    ".github/dependabot.yml",
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/feature_request.yml",
    ".github/ISSUE_TEMPLATE/config.yml",
  ]) {
    assert.ok(exists(file), `${file} is missing`);
  }
});

test("no personal state is tracked", () => {
  const ignored = read(".gitignore");
  for (const entry of ["data/", "node_modules/"]) {
    assert.ok(ignored.includes(entry), `.gitignore no longer covers ${entry}`);
  }
  assert.ok(!exists("data/settings.json") || ignored.includes("data/"));
});
