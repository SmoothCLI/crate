import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { webhookKind, webhookPayload } from "../server/notify.mjs";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end tests against the real server process: a fresh data folder, a free
// port, and only the owner routes the UI actually uses.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, "../server/index.mjs");
// Ask the OS for a free port rather than guessing: a random one can land on a
// service that is already listening and make the whole file look broken.
let PORT;
let BASE;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "crate-test-"));
const BIN = path.join(DATA, "fake-dlAudio.sh");
// Outside the library root, so the seeded job does not show up in the artist
// list or in the duplicate index the other tests assert on.
const RETAG_ROOT = path.join(DATA, "retag");
const RETAG_FILE = path.join(RETAG_ROOT, "Old Artist", "Old Album", "Old Title.m4a");
// Re-tagging shells out to ffmpeg; without it the route is still tested for its
// guards, but the tag assertions have nothing to read.
const ffmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const ffprobe = ffmpeg && spawnSync("ffprobe", ["-version"]).status === 0;

let child;

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  // The tests never run a download, but the server resolves the binary at boot
  // and needs a plausible plan to test duplicate detection against.
  fs.mkdirSync(path.join(DATA, "music", "Lib Artist", "Lib Album"), { recursive: true });
  fs.writeFileSync(path.join(DATA, "music", "Lib Artist", "Lib Album", "Known Song.m4a"), "x");
  // An older log can still hold guest entries; the owner's view must drop them.
  fs.writeFileSync(
    path.join(DATA, "history.json"),
    JSON.stringify([
      {
        id: "guest-1",
        title: "Guest Stream",
        artist: "Nobody",
        album: "",
        kind: "track",
        format: "m4a",
        stream: true,
        total: 1,
        completed: 1,
        skipped: 0,
        failed: 0,
        state: "done",
        owner: "guest",
        finishedAt: Date.now() - 1000,
      },
      {
        id: "owner-1",
        title: "Owner Song",
        artist: "Y",
        album: "Z",
        kind: "track",
        format: "m4a",
        stream: false,
        total: 1,
        completed: 1,
        skipped: 0,
        failed: 0,
        state: "done",
        owner: "owner",
        finishedAt: Date.now() - 2000,
      },
    ]),
  );
  // A finished owner job with a real file, so the re-tag route has something to
  // rewrite instead of a path that only exists in memory.
  if (ffmpeg) {
    fs.mkdirSync(path.dirname(RETAG_FILE), { recursive: true });
    execFileSync(
      "ffmpeg",
      ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.4", "-c:a", "aac", RETAG_FILE],
      { stdio: "ignore" },
    );
    fs.writeFileSync(
      path.join(DATA, "jobs.json"),
      JSON.stringify([
        {
          id: "retag-1",
          url: "https://example.com/retag",
          kind: "track",
          thumb: "",
          title: "Old Title",
          artist: "Old Artist",
          album: "Old Album",
          lufs: -14,
          quality: 2,
          format: "m4a",
          onePass: false,
          art: true,
          trackPrefix: false,
          policy: "skip",
          selection: [1],
          total: 1,
          completed: 1,
          conflicts: 0,
          owner: "owner",
          host: "example.com",
          dir: RETAG_ROOT,
          state: "done",
          createdAt: Date.now() - 5000,
          startedAt: Date.now() - 5000,
          finishedAt: Date.now() - 4000,
          tracks: [
            {
              i: 1,
              title: "Old Title",
              duration: 0.4,
              state: "done",
              stage: null,
              pct: 100,
              path: RETAG_FILE,
              size: 1024,
            },
          ],
          log: [],
        },
      ]),
    );
  }

  fs.writeFileSync(
    BIN,
    `#!/bin/sh
# Every invocation is recorded so a test can assert what the queue passes on.
printf '%s\n' "$*" >> "${DATA}/args.log"
# A link that only a signed-in session can read: the script's own wording, so
# the server can recognise it and offer the cookie jar.
case "$*" in
  *authwall*)
    case "$*" in
      *--plan*|*--inspect*)
        printf '%s\n' '{"v":1,"event":"error","message":"The source site asked for a sign-in before it would hand over that track."}'
        exit 1 ;;
      *)
        printf '%s\n' '[x] The source site asked for a sign-in before it would hand over that track.' >&2
        exit 1 ;;
    esac ;;
esac
# The artist decides the default genre the server fills in, so the link picks it.
ARTIST="Lib Artist"
TITLE="Known Song (Official Video)"
DUP=""
case "$*" in
  *mosh*) ARTIST="MoshTekk" ;;
  *dups*) TITLE="Fresh Song"; DUP="/music/Lib Artist/Lib Album/Fresh Song.m4a" ;;
esac
for a in "$@"; do
  case "$a" in
    --plan|--inspect)
      cat <<JSON
{"v":1,"event":"plan","kind":"track","url":"https://example.com/x","playlist":{"id":"x","title":"X","count":1},"defaults":{"artist":"$ARTIST","album":"Lib Album","date":"2024","thumbnail":"","lufs":-9,"quality":2,"format":"m4a","trackPrefix":false,"musicDir":"/music"},"conflicts":0,"tracks":[{"i":1,"id":"a","title":"$TITLE","url":"https://example.com/x","duration":120,"path":"/music/Lib Artist/Lib Album/$TITLE.m4a","exists":false,"artist":"$ARTIST","album":"Lib Album","track":1,"date":"2024","duplicate":"$DUP"}]}
JSON
      exit 0;;
    --stream-fd)
      case "$*" in
        *slow*) sleep 4;;
      esac
      printf 'fake-audio' >&3
      exit 0;;
  esac
done
exit 0
`,
    { mode: 0o755 },
  );
  // A stand-in for fpcalc (chromaprint): two files whose name carries "same"
  // get identical prints, everything else a print of its own.
  const fpcalc = path.join(DATA, "bin", "fpcalc");
  fs.mkdirSync(path.dirname(fpcalc), { recursive: true });
  const printA = JSON.stringify(Array.from({ length: 24 }, (_, i) => 11 + i));
  const printB = JSON.stringify(Array.from({ length: 24 }, (_, i) => 101 + i));
  fs.writeFileSync(
    fpcalc,
    `#!/bin/sh
case "$*" in
  *same-*) echo '{"duration":200.0,"fingerprint":${printA}}' ;;
  *) echo '{"duration":33.0,"fingerprint":${printB}}' ;;
esac
`,
    { mode: 0o755 },
  );

  await startServer();
});

after(async () => {
  await stopServer();
  fs.rmSync(DATA, { recursive: true, force: true });
});

async function startServer() {
  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      AUDIODL_DATA: DATA,
      AUDIODL_PORT: String(PORT),
      AUDIODL_HOST: "127.0.0.1",
      AUDIODL_BIN: BIN,
      MUSIC_DIR: path.join(DATA, "music"),
      AUDIODL_GUEST: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      await fetch(`${BASE}/api/me`);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error("server did not start");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function stopServer() {
  if (!child) return;
  const dying = child;
  child = undefined;
  if (dying.exitCode !== null || dying.signalCode !== null) return;
  dying.kill();
  await new Promise((resolve) => dying.once("exit", resolve));
}

function call(pathname, { method = "GET", body, cookie } = {}) {
  return fetch(BASE + pathname, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function cookieOf(response) {
  return (response.headers.getSetCookie?.() ?? [])
    .map((line) => line.split(";")[0])
    .join("; ");
}

async function json(response) {
  return response.json();
}

test("first run setup stores name, contact and username", async () => {
  const initial = await json(await call("/api/setup"));
  assert.equal(initial.needed, true);
  assert.equal(initial.siteName, "Crate");

  const short = await call("/api/setup", {
    method: "POST",
    body: { password: "123456789" },
  });
  assert.equal(short.status, 400);
  assert.match((await json(short)).error, /at least 10/);

  const bad = await call("/api/setup", {
    method: "POST",
    body: { siteName: "X", username: "no spaces", password: "testpassword" },
  });
  assert.equal(bad.status, 400);

  const setup = await call("/api/setup", {
    method: "POST",
    body: {
      siteName: "Jukebox",
      username: "owner",
      contact: "hello@example.com",
      password: "testpassword",
    },
  });
  assert.equal(setup.status, 200);
  assert.equal((await json(setup)).role, "owner");

  const again = await call("/api/setup", {
    method: "POST",
    body: { password: "another-pass" },
  });
  assert.equal(again.status, 409);
});

test("identity is public, the username is not", async () => {
  const me = await json(await call("/api/me"));
  assert.equal(me.siteName, "Jukebox");
  assert.equal(me.contact, "hello@example.com");
  assert.equal("username" in me, false);
  // The footer's provenance line: a named release and a link to its source.
  assert.equal(me.repo, "https://github.com/SmoothCLI/crate");
  assert.ok(me.version.length > 0);

  const owner = await call("/api/login", {
    method: "POST",
    body: { username: "owner", password: "testpassword" },
  });
  const ownerCookie = cookieOf(owner);
  const settings = await json(await call("/api/settings", { cookie: ownerCookie }));
  assert.equal(settings.username, "owner");

  const guest = await call("/api/guest", { method: "POST" });
  const guestCookie = cookieOf(guest);
  const guestSettings = await json(await call("/api/settings", { cookie: guestCookie }));
  assert.equal(guestSettings.username, "");
  assert.equal(guestSettings.canEdit, false);

  // The update hint is the owner's: a guest gets no release check at all.
  assert.equal(settings.update.current, me.version);
  assert.equal(typeof settings.update.available, "boolean");
  assert.match(settings.update.url, /github\.com\/SmoothCLI\/crate\/releases/);
  assert.equal("update" in guestSettings, false);
});

test("turning guest access off ends guest sessions, not just new ones", async () => {
  const login = await call("/api/login", {
    method: "POST",
    body: { username: "owner", password: "testpassword" },
  });
  const ownerCookie = cookieOf(login);

  const guest = await call("/api/guest", { method: "POST" });
  const guestCookie = cookieOf(guest);
  assert.equal((await call("/api/jobs", { cookie: guestCookie })).status, 200);

  const off = await call("/api/settings", {
    method: "PUT",
    cookie: ownerCookie,
    body: { guestEnabled: false },
  });
  assert.equal(off.status, 200);

  try {
    const me = await json(await call("/api/me", { cookie: guestCookie }));
    assert.equal(me.guestEnabled, false);
    assert.equal(me.authed, false, "a guest session must not survive the switch");
    assert.equal(me.role, null);

    // Their next request says what happened rather than "Not signed in": the
    // queue turns that into a sentence instead of saving a JSON error file.
    const jobs = await call("/api/jobs", { cookie: guestCookie });
    assert.equal(jobs.status, 403);
    const refusal = await json(jobs);
    assert.match(refusal.error, /Guest access has been turned off/);
    assert.equal(refusal.guestAccessOff, true);
    assert.equal((await call("/api/guest", { method: "POST" })).status, 403);

    // The owner keeps their session and their queue while guests are locked out.
    const ownerMe = await json(await call("/api/me", { cookie: ownerCookie }));
    assert.equal(ownerMe.role, "owner");
    assert.equal((await call("/api/jobs", { cookie: ownerCookie })).status, 200);
  } finally {
    const on = await call("/api/settings", {
      method: "PUT",
      cookie: ownerCookie,
      body: { guestEnabled: true },
    });
    assert.equal(on.status, 200);
  }

  // With the switch back on, the door opens again for a new visitor.
  assert.equal((await call("/api/guest", { method: "POST" })).status, 200);
});

test("health answers without a session and names the release", async () => {
  const res = await call("/api/health");
  assert.equal(res.status, 200);
  const health = await json(res);
  assert.equal(health.version.length > 0, true);
  assert.equal(typeof health.ok, "boolean");
  assert.equal(typeof health.queue.running, "number");
  assert.equal(typeof health.queue.queued, "number");
  assert.equal(typeof health.library.writable, "boolean");
  // A monitor needs the numbers, not the machine's secrets or its paths.
  assert.equal("musicDir" in health, false);
  assert.equal("passwordHash" in health, false);
  assert.equal("binary" in health, false);
});

test("the page carries a preview card for link unfurlers", async () => {
  const page = await call("/");
  const html = await page.text();
  // An unbuilt checkout serves no shell; there is nothing to inspect then.
  if (!html.includes("og:title")) return;

  assert.equal(page.status, 200);
  assert.match(html, /<title>Jukebox<\/title>/);
  assert.match(html, /property="og:site_name" content="Jukebox"/);
  assert.match(html, /property="og:title" content="Jukebox"/);
  assert.match(html, /property="og:description" content="Download tracks and playlists/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image"/);
  // Absolute URLs: unfurlers do not resolve relative ones.
  assert.match(html, /property="og:image" content="http:\/\/127\.0\.0\.1:\d+\/og\.png"/);
  assert.match(html, /property="og:url" content="http:\/\/127\.0\.0\.1:\d+\/"/);
  assert.match(html, /property="og:image:width" content="1200"/);
  // The placeholder block itself is gone.
  assert.equal(html.includes("<!-- preview -->"), false);

  const png = await call("/og.png");
  assert.equal(png.status, 200);
  assert.match(png.headers.get("content-type"), /image\/png/);
  assert.equal((await png.arrayBuffer()).byteLength > 10_000, true);
});

test("settings clamp values and stay written", async () => {
  const login = await call("/api/login", {
    method: "POST",
    body: { username: "owner", password: "testpassword" },
  });
  const cookie = cookieOf(login);

  const save = await call("/api/settings", {
    method: "PUT",
    cookie,
    body: { maxJobs: 3, perHost: 9, guestQuota: 2, contact: "  contact@example.com  " },
  });
  assert.equal(save.status, 200);
  const saved = await json(save);
  assert.equal(saved.maxJobs, 3);
  assert.equal(saved.perHost, 3);
  assert.equal(saved.guestQuota, 2);
  assert.equal(saved.contact, "contact@example.com");
});

test("webhook is stored, hidden from guests and removable", async () => {
  const login = await call("/api/login", {
    method: "POST",
    body: { username: "owner", password: "testpassword" },
  });
  const ownerCookie = cookieOf(login);

  const bad = await call("/api/settings", {
    method: "PUT",
    cookie: ownerCookie,
    body: { webhookUrl: "ftp://example.com/hook" },
  });
  assert.equal(bad.status, 400);

  const set = await call("/api/settings", {
    method: "PUT",
    cookie: ownerCookie,
    body: { webhookUrl: "https://discord.com/api/webhooks/1/token", webhookGuests: true },
  });
  assert.equal(set.status, 200);

  const owner = await json(await call("/api/settings", { cookie: ownerCookie }));
  assert.equal(owner.webhookSet, true);
  assert.equal(owner.webhookHost, "discord.com");
  assert.equal(owner.webhookGuests, true);
  assert.equal("webhookUrl" in owner, false);

  // Saving something unrelated must keep it.
  await call("/api/settings", {
    method: "PUT",
    cookie: ownerCookie,
    body: { siteName: "Jukebox" },
  });
  assert.equal((await json(await call("/api/settings", { cookie: ownerCookie }))).webhookSet, true);

  const guest = await call("/api/guest", { method: "POST" });
  const guestView = await json(await call("/api/settings", { cookie: cookieOf(guest) }));
  assert.equal(guestView.webhookSet, false);
  assert.equal(guestView.webhookHost, "");

  const removed = await call("/api/settings", {
    method: "PUT",
    cookie: ownerCookie,
    body: { webhookUrl: null },
  });
  assert.equal((await json(removed)).webhookSet, false);
});

test("webhook test route reports the missing URL", async () => {
  const login = await call("/api/login", {
    method: "POST",
    body: { username: "owner", password: "testpassword" },
  });
  const cookie = cookieOf(login);
  const response = await call("/api/webhook/test", { method: "POST", cookie });
  assert.equal(response.status, 400);
});

test("export leaves out secrets and import applies safe keys", async () => {
  const login = await call("/api/login", {
    method: "POST",
    body: { username: "owner", password: "testpassword" },
  });
  const cookie = cookieOf(login);
  await call("/api/settings", {
    method: "PUT",
    cookie,
    body: { webhookUrl: "https://discord.com/api/webhooks/2/token" },
  });

  const exported = await json(await call("/api/settings/export", { cookie }));
  assert.equal(exported.settings.passwordHash, undefined);
  assert.equal(exported.settings.webhookUrl, undefined);
  assert.equal(exported.settings.webhookGuests, true);

  exported.settings.siteName = "Imported";
  exported.settings.guestQuota = 4;
  const imported = await call("/api/settings/import", {
    method: "POST",
    cookie,
    body: exported,
  });
  assert.equal(imported.status, 200);
  const after = await json(await call("/api/settings", { cookie }));
  assert.equal(after.siteName, "Imported");
  assert.equal(after.guestQuota, 4);
  assert.equal(after.webhookSet, true, "import must not clear the stored webhook");
  assert.equal(after.username, "owner", "import must not touch the owner account");
});

test("library stats and history are owner-only", async () => {
  const login = await call("/api/login", {
    method: "POST",
    body: { username: "owner", password: "testpassword" },
  });
  const ownerCookie = cookieOf(login);

  const library = await json(await call("/api/library", { cookie: ownerCookie }));
  for (const key of ["artists", "albums", "tracks", "bytes", "writable"]) {
    assert.ok(key in library, `library stats missing ${key}`);
  }

  const history = await json(await call("/api/history", { cookie: ownerCookie }));
  assert.ok(Array.isArray(history.history));
  assert.equal(
    history.history.some((entry) => entry.owner === "guest"),
    false,
    "guest streams stay out of the owner's history",
  );
  assert.ok(history.history.some((entry) => entry.title === "Owner Song"));

  const guest = await call("/api/guest", { method: "POST" });
  const guestCookie = cookieOf(guest);
  assert.equal((await call("/api/library", { cookie: guestCookie })).status, 403);
  assert.equal((await call("/api/history", { cookie: guestCookie })).status, 403);
  assert.equal((await call("/api/settings/export", { cookie: guestCookie })).status, 403);
});

test("the library health report names what is wrong and only cleans empty folders", async () => {
  const login = await call("/api/login", {
    method: "POST",
    body: { username: "owner", password: "testpassword" },
  });
  const ownerCookie = cookieOf(login);
  const music = path.join(DATA, "music");

  // An empty album folder, a loose file, and an album whose files disagree
  // about numbering.
  const emptyDir = path.join(music, "Nobody", "Nothing Yet");
  fs.mkdirSync(emptyDir, { recursive: true });
  fs.writeFileSync(path.join(music, "loose.m4a"), "x");
  const mixedDir = path.join(music, "Mixed", "Album");
  fs.mkdirSync(mixedDir, { recursive: true });
  fs.writeFileSync(path.join(mixedDir, "01 - One.m4a"), "x");
  fs.writeFileSync(path.join(mixedDir, "Two.m4a"), "x");

  try {
    const health = await json(await call("/api/library/health", { cookie: ownerCookie }));
    assert.ok(health.emptyDirs.includes(emptyDir), "the empty album is listed");
    assert.ok(health.loose.includes(path.join(music, "loose.m4a")), "the loose file is listed");
    assert.equal(health.mixedTotal, 1, "half-numbered albums are counted");
    assert.ok(health.counts.tracks >= 2);

    // Cleaning up only removes what is still empty; the folder that filled up
    // between the scan and the click is left alone.
    fs.writeFileSync(path.join(mixedDir, "Three.m4a"), "x");
    const prune = await json(
      await call("/api/library/health/prune", {
        method: "POST",
        cookie: ownerCookie,
        body: { dirs: [emptyDir, mixedDir, "/etc"] },
      }),
    );
    assert.deepEqual(prune.removed, [emptyDir]);
    assert.equal(prune.failed.length, 2, "a full folder and a path outside the library are refused");
    assert.equal(fs.existsSync(emptyDir), false);
    assert.equal(fs.existsSync(path.join(mixedDir, "01 - One.m4a")), true);

    const guest = await call("/api/guest", { method: "POST" });
    const guestCookie = cookieOf(guest);
    assert.equal((await call("/api/library/health", { cookie: guestCookie })).status, 403);
    assert.equal(
      (await call("/api/library/health/prune", { method: "POST", cookie: guestCookie, body: { dirs: [] } }))
        .status,
      403,
    );
  } finally {
    fs.rmSync(path.join(music, "loose.m4a"), { force: true });
    fs.rmSync(path.join(music, "Mixed"), { recursive: true, force: true });
    fs.rmSync(path.join(music, "Nobody"), { recursive: true, force: true });
  }
});

test("the duplicate report is owner-only and only deletes audio inside the library", async () => {
  const login = await call("/api/login", {
    method: "POST",
    body: { username: "owner", password: "testpassword" },
  });
  const ownerCookie = cookieOf(login);

  const report = await json(await call("/api/library/duplicates", { cookie: ownerCookie }));
  assert.equal(typeof report.fpcalc, "boolean");
  assert.ok(Array.isArray(report.groups));

  const refused = await json(
    await call("/api/library/duplicates/remove", {
      method: "POST",
      cookie: ownerCookie,
      body: { paths: ["/etc/hostname", path.join(DATA, "music", "notes.txt")] },
    }),
  );
  assert.equal(refused.removed.length, 0);
  assert.equal(refused.failed.length, 2);

  const guest = await call("/api/guest", { method: "POST" });
  const guestCookie = cookieOf(guest);
  assert.equal((await call("/api/library/duplicates", { cookie: guestCookie })).status, 403);
  assert.equal(
    (await call("/api/library/duplicates/remove", { method: "POST", cookie: guestCookie, body: { paths: [] } }))
      .status,
    403,
  );
});

test("the fingerprint scan groups the same recording under different names", async () => {
  const login = await call("/api/login", {
    method: "POST",
    body: { username: "owner", password: "testpassword" },
  });
  const ownerCookie = cookieOf(login);
  const music = path.join(DATA, "music");
  const first = path.join(music, "Dup Artist", "One", "same-one.m4a");
  const second = path.join(music, "Dup Artist", "Two", "same-two.m4a");
  const solo = path.join(music, "Dup Artist", "Three", "different.m4a");
  for (const file of [first, second, solo]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "x");
  }
  try {
    let pending = 1;
    for (let guard = 0; guard < 40 && pending > 0; guard += 1) {
      const step = await json(
        await call("/api/library/duplicates/scan", {
          method: "POST",
          cookie: ownerCookie,
          body: { limit: 12 },
        }),
      );
      pending = step.pending;
    }

    const report = await json(await call("/api/library/duplicates", { cookie: ownerCookie }));
    assert.equal(report.fpcalc, true, "the scan reports fpcalc as available");
    const group = report.groups.find((entry) => entry.files.some((file) => file.name === "same-one.m4a"));
    assert.ok(group, "the two copies are grouped");
    assert.deepEqual(
      group.files.map((file) => file.name).sort(),
      ["same-one.m4a", "same-two.m4a"],
      "only the matching recording is in the group",
    );
    assert.equal(
      report.groups.some(
        (entry) =>
          entry.files.some((file) => file.name === "different.m4a") &&
          entry.files.some((file) => file.name === "same-one.m4a"),
      ),
      false,
      "a different recording is never merged into that group",
    );

    const removed = await json(
      await call("/api/library/duplicates/remove", {
        method: "POST",
        cookie: ownerCookie,
        body: { paths: [second] },
      }),
    );
    assert.deepEqual(removed.removed, [second]);
    assert.equal(fs.existsSync(second), false, "the copy is really gone");
  } finally {
    fs.rmSync(path.join(music, "Dup Artist"), { recursive: true, force: true });
  }
});

test("a shared link reaches the composer, and the manifest offers a share target", async () => {
  const target = "https://soundcloud.com/artist/track";

  const get = await fetch(`${BASE}/share?url=${encodeURIComponent(target)}`, { redirect: "manual" });
  assert.equal(get.status, 302);
  assert.equal(get.headers.get("location"), `/?url=${encodeURIComponent(target)}`);

  // Android posts a form, not JSON.
  const post = await fetch(`${BASE}/share`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ title: "A track", text: `listen: ${target} #music` }).toString(),
    redirect: "manual",
  });
  assert.equal(post.status, 302);
  assert.equal(post.headers.get("location"), `/?url=${encodeURIComponent(target)}`);

  const empty = await fetch(`${BASE}/share`, { method: "POST", body: "title=hello" });
  assert.equal(empty.status, 400);

  const manifest = await (await fetch(`${BASE}/manifest.webmanifest`)).json();
  assert.equal(manifest.share_target.action, "/share");
  assert.equal(manifest.share_target.params.url, "url");
});

// The look is a per-browser choice, so it can only reach the server through a
// cookie - and it has to, because the first frame is written here.
test("the shell arrives in the stored theme, from cookies", async (t) => {
  const openTag = (html) => html.match(/<html[^>]*>/)[0];
  const plain = await (await fetch(`${BASE}/`)).text();
  if (!plain.includes("/assets/")) {
    t.skip("no built shell - run `npm run build` first");
    return;
  }

  // Nothing stored: the built-in default, and nothing guessed on top of it.
  assert.match(openTag(plain), / data-theme="auto"/);
  assert.doesNotMatch(openTag(plain), /data-(effects|catppuccin|accent)/);

  const cookies = [
    "audiodl-theme=dark",
    "audiodl-effects=off",
    `audiodl-catppuccin=${encodeURIComponent(JSON.stringify({ flavor: "mocha", accent: "green" }))}`,
  ].join("; ");
  const themed = openTag(await (await fetch(`${BASE}/`, { headers: { cookie: cookies } })).text());
  assert.match(themed, / data-theme="dark"/);
  assert.match(themed, / data-effects="off"/);
  assert.match(themed, / data-catppuccin="mocha"/);
  assert.match(themed, / data-accent="green"/);
  // The shell's own attribute is replaced, not joined by a second one.
  assert.equal(themed.match(/data-theme=/g).length, 1);
  assert.equal(themed.match(/<html/g).length, 1);

  // A cookie the server does not recognise is dropped, never written out.
  const junk = openTag(
    await (
      await fetch(`${BASE}/`, {
        headers: { cookie: 'audiodl-theme="><script>; audiodl-effects=maybe; audiodl-catppuccin=%7Bnope' },
      })
    ).text(),
  );
  assert.match(junk, / data-theme="auto"/);
  assert.doesNotMatch(junk, /data-(effects|catppuccin|accent)|<script/);

  // A flavor whose accent is nonsense still gets the flavor.
  const half = openTag(
    await (
      await fetch(`${BASE}/`, {
        headers: {
          cookie: `audiodl-catppuccin=${encodeURIComponent(JSON.stringify({ flavor: "latte", accent: "chartreuse" }))}`,
        },
      })
    ).text(),
  );
  assert.match(half, / data-catppuccin="latte"/);
  assert.doesNotMatch(half, /data-accent/);
});

// /admin is the other half of that rule: its look is one setting on the server,
// so a device that has never chosen anything still arrives to the same page.
test("the settings page is themed by the server, not by the browser", async (t) => {
  const openTag = (html) => html.match(/<html[^>]*>/)[0];
  const plain = await (await fetch(`${BASE}/`)).text();
  if (!plain.includes("/assets/")) {
    t.skip("no built shell - run `npm run build` first");
    return;
  }

  const login = await call("/api/login", {
    method: "POST",
    body: { username: "owner", password: "testpassword" },
  });
  const ownerCookie = cookieOf(login);

  // Nothing chosen yet: the built-in look, on the settings page as everywhere.
  assert.match(openTag(await (await fetch(`${BASE}/admin`)).text()), / data-theme="auto"/);

  const saved = await json(
    await call("/api/admin/look", {
      method: "PUT",
      cookie: ownerCookie,
      body: { theme: "dark", effects: "off", flavor: "mocha", accent: "green" },
    }),
  );
  assert.equal(saved.adminLook.theme, "dark");
  assert.equal(saved.adminLook.flavor, "mocha");

  // A browser with its own light, effects-on look still gets the stored one:
  // the cookies do not reach this page at all.
  const other = openTag(
    await (
      await fetch(`${BASE}/admin`, {
        headers: { cookie: "audiodl-theme=light; audiodl-effects=on; audiodl-catppuccin=%7B%22accent%22%3A%22red%22%7D" },
      })
    ).text(),
  );
  assert.match(other, / data-theme="dark"/);
  assert.match(other, / data-effects="off"/);
  assert.match(other, / data-catppuccin="mocha"/);
  assert.match(other, / data-accent="green"/);
  assert.equal(other.match(/data-theme=/g).length, 1);
  assert.equal(other.match(/<html/g).length, 1);

  // The queue keeps following each browser, and the trailing-slash form of the
  // settings page keeps the stored look too.
  const queue = openTag(
    await (await fetch(`${BASE}/`, { headers: { cookie: "audiodl-theme=light" } })).text(),
  );
  assert.match(queue, / data-theme="light"/);
  assert.match(openTag(await (await fetch(`${BASE}/admin/`)).text()), / data-theme="dark"/);

  // It is a setting, so it is in the settings file and in the settings payload.
  const stored = JSON.parse(fs.readFileSync(path.join(DATA, "settings.json"), "utf8"));
  assert.equal(stored.adminLook.theme, "dark");
  const payload = await json(await call("/api/settings", { cookie: ownerCookie }));
  assert.equal(payload.adminLook.accent, "green");

  // Rubbish is left as it was rather than written into the page, and a partial
  // update keeps every other field.
  const cleaned = await json(
    await call("/api/admin/look", {
      method: "PUT",
      cookie: ownerCookie,
      body: { theme: '"><script>', accent: "chartreuse" },
    }),
  );
  assert.equal(cleaned.adminLook.theme, "dark", "an unknown theme changes nothing");
  assert.equal(cleaned.adminLook.accent, "green", "an unknown accent changes nothing");
  assert.equal(cleaned.adminLook.flavor, "mocha", "the flavor survives a theme change");
  const cleanedPage = openTag(await (await fetch(`${BASE}/admin`)).text());
  assert.match(cleanedPage, / data-theme="dark"/);
  assert.doesNotMatch(cleanedPage, /<script/);

  // Default comes back by sending null, and only the owner can change any of it.
  const cleared = await json(
    await call("/api/admin/look", { method: "PUT", cookie: ownerCookie, body: { flavor: null } }),
  );
  assert.equal(cleared.adminLook.flavor, null);
  const guest = await call("/api/guest", { method: "POST" });
  assert.equal(
    (await call("/api/admin/look", { method: "PUT", cookie: cookieOf(guest), body: { theme: "light" } })).status,
    403,
  );

  // Back to the built-in look for whatever runs next.
  await call("/api/admin/look", {
    method: "PUT",
    cookie: ownerCookie,
    body: { theme: "auto", effects: "on", accent: "mauve" },
  });
});

test("diagnostics are owner-only", async () => {
  const login = await call("/api/login", {
    method: "POST",
    body: { username: "owner", password: "testpassword" },
  });
  const ownerCookie = cookieOf(login);

  const report = await json(await call("/api/diagnostics", { cookie: ownerCookie }));
  assert.equal(typeof report.ytdlp.version, "string");
  assert.equal(typeof report.ytdlp.path, "string");
  assert.equal(typeof report.ffmpeg.version, "string");
  assert.ok(report.system.node.startsWith("v"));
  assert.ok(report.script.path.endsWith("fake-dlAudio.sh"));

  const guest = await call("/api/guest", { method: "POST" });
  const guestCookie = cookieOf(guest);
  assert.equal((await call("/api/diagnostics", { cookie: guestCookie })).status, 403);
  assert.equal(
    (await call("/api/tools/ytdlp/update", { method: "POST", cookie: guestCookie })).status,
    403,
  );
});

test("webhook payloads fit the service", () => {
  const message = {
    title: "Spaces",
    subtitle: "Nils Frahm",
    state: "done",
    summary: "9 of 9 saved",
    format: "M4A · q2 · -9 LUFS",
    error: "",
    url: "https://example.com/x",
    thumb: "https://example.com/art.jpg",
    finishedAt: 1_700_000_000_000,
    site: "Crate",
    guest: false,
    saved: 1,
    failed: 0,
    skipped: 0,
  };

  const discord = JSON.parse(webhookPayload("discord", message).body);
  assert.equal(discord.embeds.length, 1);
  assert.equal(discord.embeds[0].title, "Spaces");
  assert.equal(discord.embeds[0].color, 0x4c9a52);
  assert.equal(discord.embeds[0].thumbnail.url, "https://example.com/art.jpg");
  assert.equal(discord.embeds[0].url, "https://example.com/x");
  assert.equal(discord.embeds[0].author.name, "example.com");
  assert.equal(discord.embeds[0].description, "Nils Frahm");
  assert.deepEqual(discord.allowed_mentions, { parse: [] });

  // The test button has no link, so it carries no author line and no url.
  const bare = JSON.parse(webhookPayload("discord", { ...message, url: "", subtitle: "" }).body);
  assert.equal(bare.embeds[0].author, undefined);
  assert.equal(bare.embeds[0].url, undefined);
  assert.equal(bare.embeds[0].description, undefined);

  const failed = JSON.parse(
    webhookPayload("discord", { ...message, state: "failed", saved: 0, failed: 1, error: "boom" })
      .body,
  );
  assert.equal(failed.embeds[0].color, 0xe5534b);
  assert.match(failed.embeds[0].description, /boom/);
  // Nothing was saved, so there is no count to show next to the reason.
  assert.deepEqual(
    failed.embeds[0].fields.map((f) => f.name),
    ["Format"],
  );

  const partial = JSON.parse(webhookPayload("discord", { ...message, skipped: 2 }).body);
  assert.equal(partial.embeds[0].color, 0xd29922);

  const slack = JSON.parse(webhookPayload("slack", message).body);
  assert.equal(slack.blocks[0].type, "header");
  assert.match(slack.text, /Spaces/);

  const generic = JSON.parse(webhookPayload("generic", message).body);
  assert.match(generic.content, /Spaces/);
  // Plain text keeps its lines and carries the link, unlike an embed.
  assert.equal(
    generic.content,
    "**Spaces** - Nils Frahm\n9 of 9 saved · M4A · q2 · -9 LUFS\nhttps://example.com/x",
  );
  assert.deepEqual(generic.allowed_mentions, { parse: [] });

  assert.equal(webhookKind("https://discord.com/api/webhooks/1/x"), "discord");
  assert.equal(webhookKind("https://discordapp.com/api/webhooks/1/x"), "discord");
  assert.equal(webhookKind("https://hooks.slack.com/services/x"), "slack");
  assert.equal(webhookKind("https://example.com/hook"), "generic");
});

test("jobs keep a remote thumbnail and the artist list is owner-only", async () => {
  const login = await call("/api/login", {
    method: "POST",
    body: { username: "owner", password: "testpassword" },
  });
  const ownerCookie = cookieOf(login);

  const artists = await json(await call("/api/artists", { cookie: ownerCookie }));
  assert.deepEqual(artists.artists, ["Lib Artist"]);

  const body = {
    url: "https://example.com/x",
    kind: "track",
    title: "With Art",
    rows: [{ i: 1, title: "With Art" }],
  };
  const good = await json(
    await call("/api/jobs", {
      method: "POST",
      cookie: ownerCookie,
      body: { ...body, thumb: "https://i1.sndcdn.com/artworks-x.jpg" },
    }),
  );
  assert.equal(good.job.thumb, "https://i1.sndcdn.com/artworks-x.jpg");

  const bad = await json(
    await call("/api/jobs", {
      method: "POST",
      cookie: ownerCookie,
      body: { ...body, thumb: "javascript:alert(1)" },
    }),
  );
  assert.equal(bad.job.thumb, "");

  const guest = await call("/api/guest", { method: "POST" });
  const guestArtists = await json(await call("/api/artists", { cookie: cookieOf(guest) }));
  assert.deepEqual(guestArtists.artists, []);
});

test("guest quota counts jobs per browser", async () => {
  const login = await call("/api/login", {
    method: "POST",
    body: { username: "owner", password: "testpassword" },
  });
  const ownerCookie = cookieOf(login);
  await call("/api/settings", {
    method: "PUT",
    cookie: ownerCookie,
    body: { guestEnabled: true, guestQuota: 1 },
  });

  const guest = await call("/api/guest", { method: "POST" });
  const guestCookie = cookieOf(guest);
  const job = {
    url: "https://93.184.216.34/track",
    kind: "track",
    title: "Quota Test",
    rows: [{ i: 1, title: "Quota Test" }],
  };
  const first = await call("/api/jobs", { method: "POST", cookie: guestCookie, body: job });
  assert.equal(first.status, 201);
  const second = await call("/api/jobs", { method: "POST", cookie: guestCookie, body: job });
  assert.equal(second.status, 429);
  assert.match((await json(second)).error, /limit/i);
});

test("the owner can re-tag a finished job in place", async (t) => {
  if (!ffmpeg || !ffprobe) {
    t.skip("ffmpeg/ffprobe are not installed");
    return;
  }
  const login = await call("/api/login", {
    method: "POST",
    body: { username: "owner", password: "testpassword" },
  });
  const ownerCookie = cookieOf(login);
  const guestCookie = cookieOf(await call("/api/guest", { method: "POST" }));

  const denied = await call("/api/jobs/retag-1/tags", {
    method: "PATCH",
    cookie: guestCookie,
    body: { artist: "Nobody" },
  });
  assert.equal(denied.status, 403);

  const res = await call("/api/jobs/retag-1/tags", {
    method: "PATCH",
    cookie: ownerCookie,
    body: { title: "New Title", artist: "New Artist", album: "New Album", genre: "Hardtekk" },
  });
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.retagged, 1);
  assert.equal(body.job.title, "New Title");
  assert.equal(body.job.artist, "New Artist");
  assert.equal(body.job.genre, "Hardtekk");
  assert.equal(body.job.tracks[0].title, "New Title");

  const probe = JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "format_tags", "-of", "json", RETAG_FILE], {
      encoding: "utf8",
    }),
  );
  assert.equal(probe.format.tags.title, "New Title");
  assert.equal(probe.format.tags.artist, "New Artist");
  assert.equal(probe.format.tags.album, "New Album");
  assert.equal(probe.format.tags.genre, "Hardtekk");

  const list = await json(await call("/api/jobs", { cookie: ownerCookie }));
  assert.equal(list.jobs.find((job) => job.id === "retag-1").album, "New Album");

  // Clearing an album removes the tag rather than leaving the old one behind.
  const cleared = await call("/api/jobs/retag-1/tags", {
    method: "PATCH",
    cookie: ownerCookie,
    body: { artist: "New Artist", album: "", genre: "" },
  });
  assert.equal(cleared.status, 200);
  const after = JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "format_tags", "-of", "json", RETAG_FILE], {
      encoding: "utf8",
    }),
  );
  assert.equal(after.format.tags.album, undefined);
  assert.equal(after.format.tags.genre, undefined);
  assert.equal((await json(cleared)).job.genre, "");
});

// The genre field starts filled in: the curated map ships with the server and
// the artist the source reports decides which entry it is.
test("the genre field starts from the shipped artist map", async () => {
  const ownerCookie = cookieOf(
    await call("/api/login", {
      method: "POST",
      body: { username: "owner", password: "testpassword" },
    }),
  );

  const plan = await json(
    await call("/api/plan", {
      method: "POST",
      cookie: ownerCookie,
      body: { url: "https://example.com/mosh", kind: "track" },
    }),
  );
  assert.equal(plan.defaults.genre, "Hardtekk", "MoshTekk is a Hardtekk act in the map");
  assert.ok(Array.isArray(plan.genres) && plan.genres.includes("Hardtekk"), "the field is offered the map's vocabulary");

  // An artist the map does not know starts empty rather than guessing.
  const unknown = await json(
    await call("/api/plan", {
      method: "POST",
      cookie: ownerCookie,
      body: { url: "https://example.com/unknown", kind: "track" },
    }),
  );
  assert.equal(unknown.defaults.genre, "");
});

// What the review card holds is what the downloader is told, so a genre typed
// by hand reaches the file in the same pass as the title and album.
test("the queued genre reaches the download script", async () => {
  const ownerCookie = cookieOf(
    await call("/api/login", {
      method: "POST",
      body: { username: "owner", password: "testpassword" },
    }),
  );

  const created = await call("/api/jobs", {
    method: "POST",
    cookie: ownerCookie,
    body: {
      url: "https://example.com/genreprobe",
      kind: "track",
      title: "Genre Probe",
      artist: "MoshTekk",
      album: "Chapter 1",
      genre: "Hardtekk",
      rows: [{ i: 1, title: "Genre Probe", duration: 120 }],
    },
  });
  assert.equal(created.status, 201);
  assert.equal((await json(created)).job.genre, "Hardtekk");

  const log = path.join(DATA, "args.log");
  const deadline = Date.now() + 5000;
  let line = "";
  for (;;) {
    line = fs.existsSync(log)
      ? fs.readFileSync(log, "utf8").split("\n").find((entry) => entry.includes("genreprobe")) ?? ""
      : "";
    if (line) break;
    if (Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(line, "the downloader never ran");
  assert.match(line, /--genre[= ]Hardtekk/, `genre missing from the call: ${line}`);
  // The job was queued with the box unchecked, so the script must be told to
  // leave the number out of the filename.
  assert.match(line, /--no-track-prefix/, `track prefix missing from the call: ${line}`);
});

// Artists live in a tag list; a collaboration typed as one string would reach
// every player as a single artist whose name happens to contain a comma.
test("a collaboration is re-tagged as two artists", async (t) => {
  if (!ffmpeg || !ffprobe) {
    t.skip("ffmpeg/ffprobe are not installed");
    return;
  }
  if (spawnSync("python3", ["-c", "import mutagen"]).status !== 0) {
    t.skip("mutagen is not installed");
    return;
  }
  const ownerCookie = cookieOf(
    await call("/api/login", {
      method: "POST",
      body: { username: "owner", password: "testpassword" },
    }),
  );

  const res = await call("/api/jobs/retag-1/tags", {
    method: "PATCH",
    cookie: ownerCookie,
    body: { artist: "Ruppi van Daline， LuuZz" },
  });
  assert.equal(res.status, 200);
  assert.equal((await json(res)).job.artist, "Ruppi van Daline, LuuZz");

  const read = `
import json, sys
from mutagen.mp4 import MP4

audio = MP4(sys.argv[1])
print(json.dumps({
    "artist": audio.get("\\xa9ART"),
    "album_artist": audio.get("aART"),
    "artists": [name.decode("utf-8") for name in audio.get("----:com.apple.iTunes:ARTISTS") or []],
}))
`;
  const tags = JSON.parse(execFileSync("python3", ["-c", read, RETAG_FILE], { encoding: "utf8" }));
  assert.deepEqual(tags.artist, ["Ruppi van Daline", "LuuZz"]);
  assert.deepEqual(tags.album_artist, ["Ruppi van Daline", "LuuZz"]);
  assert.deepEqual(tags.artists, ["Ruppi van Daline", "LuuZz"]);
});

test("the public tally counts finished guest streams once each", async () => {
  const login = await call("/api/login", {
    method: "POST",
    body: { username: "owner", password: "testpassword" },
  });
  const ownerCookie = cookieOf(login);
  await call("/api/settings", {
    method: "PUT",
    cookie: ownerCookie,
    body: { guestEnabled: true, guestQuota: 0 },
  });

  const tally = async () => (await json(await call("/api/me"))).stats;
  const start = await tally();

  const stream = async (cookie) => {
    const created = await call("/api/jobs", {
      method: "POST",
      cookie,
      body: {
        url: "https://93.184.216.34/track",
        kind: "track",
        title: "Tally Test",
        rows: [{ i: 1, title: "Tally Test" }],
      },
    });
    assert.equal(created.status, 201);
    const { job } = await json(created);
    const res = await fetch(`${BASE}/api/jobs/${job.id}/stream/1`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "fake-audio");
    const deadline = Date.now() + 5000;
    for (;;) {
      const { jobs } = await json(await call("/api/jobs", { cookie }));
      if (jobs.find((entry) => entry.id === job.id)?.state === "done") return job.id;
      if (Date.now() > deadline) throw new Error("the stream never settled");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  const firstCookie = cookieOf(await call("/api/guest", { method: "POST" }));
  const jobId = await stream(firstCookie);
  let tallyAfter = await tally();
  assert.equal(tallyAfter.tracks, start.tracks + 1);
  assert.equal(tallyAfter.guests, start.guests + 1);

  // Pulling the same track a second time is not another download.
  const again = await fetch(`${BASE}/api/jobs/${jobId}/stream/1`, { headers: { cookie: firstCookie } });
  await again.text();
  tallyAfter = await tally();
  assert.equal(tallyAfter.tracks, start.tracks + 1, "a re-stream must not count twice");
  assert.equal(tallyAfter.guests, start.guests + 1);

  // A different browser is a different guest.
  const secondCookie = cookieOf(await call("/api/guest", { method: "POST" }));
  await stream(secondCookie);
  tallyAfter = await tally();
  assert.equal(tallyAfter.tracks, start.tracks + 2);
  assert.equal(tallyAfter.guests, start.guests + 2);
});

test("a job queued without track numbers saves files without them", async () => {
  const guestCookie = cookieOf(await call("/api/guest", { method: "POST" }));
  const created = await call("/api/jobs", {
    method: "POST",
    cookie: guestCookie,
    body: {
      url: "https://93.184.216.34/album",
      kind: "playlist",
      title: "Naming Test",
      trackPrefix: false,
      selection: [1, 2],
      rows: [
        { i: 1, title: "First" },
        { i: 2, title: "Second" },
      ],
    },
  });
  assert.equal(created.status, 201);
  const { job } = await json(created);
  const res = await fetch(`${BASE}/api/jobs/${job.id}/stream/1`, { headers: { cookie: guestCookie } });
  assert.equal(res.status, 200);
  await res.text();
  const name = res.headers.get("content-disposition") || "";
  assert.match(name, /filename="First\.m4a"/);
  assert.doesNotMatch(name, /01/);
});

test("the owner can reset the guest tally, a guest cannot", async () => {
  const login = await call("/api/login", {
    method: "POST",
    body: { username: "owner", password: "testpassword" },
  });
  const ownerCookie = cookieOf(login);

  const before = (await json(await call("/api/me"))).stats;
  assert.ok(before.tracks > 0, "the tally test above leaves something to clear");

  const guestCookie = cookieOf(await call("/api/guest", { method: "POST" }));
  const denied = await call("/api/stats/reset", { method: "POST", cookie: guestCookie });
  assert.equal(denied.status, 403);

  // A reset must not lift a daily limit: the quota is a different file.
  await call("/api/settings", {
    method: "PUT",
    cookie: ownerCookie,
    body: { guestQuota: 2 },
  });

  const reset = await call("/api/stats/reset", { method: "POST", cookie: ownerCookie });
  assert.equal(reset.status, 200);
  assert.deepEqual((await json(reset)).stats, { guests: 0, tracks: 0 });
  assert.deepEqual((await json(await call("/api/me"))).stats, { guests: 0, tracks: 0 });
  assert.equal((await json(await call("/api/settings", { cookie: ownerCookie }))).guestQuota, 2);

  await call("/api/settings", {
    method: "PUT",
    cookie: ownerCookie,
    body: { guestQuota: 0 },
  });
});

test("a reset reaches open pages as a stats event", async () => {
  const login = await call("/api/login", {
    method: "POST",
    body: { username: "owner", password: "testpassword" },
  });
  const ownerCookie = cookieOf(login);

  const sse = await fetch(`${BASE}/api/stream`, { headers: { cookie: ownerCookie } });
  assert.equal(sse.status, 200);
  const reader = sse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const waitFor = async (name, timeout = 4000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
      const at = buffer.indexOf(`event: ${name}`);
      if (at >= 0) return buffer.slice(at);
    }
    return null;
  };

  assert.ok(await waitFor("jobs"), "the connection opens with a snapshot");
  buffer = "";

  const reset = await call("/api/stats/reset", { method: "POST", cookie: ownerCookie });
  assert.equal(reset.status, 200);

  const frame = await waitFor("stats");
  await reader.cancel().catch(() => {});
  assert.ok(frame, "a reset must be pushed to open pages");
  assert.match(frame, /"guests":0/);
  assert.match(frame, /"tracks":0/);
});

test("switching guests off closes their live stream and stops the encoder", async () => {
  const login = await call("/api/login", {
    method: "POST",
    body: { username: "owner", password: "testpassword" },
  });
  const ownerCookie = cookieOf(login);
  await call("/api/settings", {
    method: "PUT",
    cookie: ownerCookie,
    body: { guestEnabled: true },
  });

  const guestCookie = cookieOf(await call("/api/guest", { method: "POST" }));
  const created = await call("/api/jobs", {
    method: "POST",
    cookie: guestCookie,
    body: {
      url: "https://93.184.216.34/slow",
      kind: "track",
      title: "Slow One",
      rows: [{ i: 1, title: "Slow One" }],
    },
  });
  assert.equal(created.status, 201);
  const { job } = await json(created);

  // The live queue connection the queue page holds open.
  const sse = await fetch(`${BASE}/api/stream`, { headers: { cookie: guestCookie } });
  assert.equal(sse.status, 200);
  const reader = sse.body.getReader();
  await reader.read();

  // A transfer that is still encoding: the fake binary sleeps before its byte.
  const download = fetch(`${BASE}/api/jobs/${job.id}/stream/1`, { headers: { cookie: guestCookie } });
  await new Promise((resolve) => setTimeout(resolve, 300));

  const off = await call("/api/settings", {
    method: "PUT",
    cookie: ownerCookie,
    body: { guestEnabled: false },
  });
  assert.equal(off.status, 200);

  // The open connection ends instead of going quiet.
  const closedByServer = (async () => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 5000) {
      const { done } = await reader.read();
      if (done) return true;
    }
    return false;
  })();
  assert.equal(await closedByServer, true, "a guest stream must end when access is switched off");

  // The encoder is stopped and the job explains why.
  let settled;
  const deadline = Date.now() + 5000;
  for (;;) {
    const { jobs } = await json(await call("/api/jobs", { cookie: ownerCookie }));
    settled = jobs.find((entry) => entry.id === job.id);
    if (settled && (settled.state === "cancelled" || settled.state === "failed")) break;
    if (Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await download.catch(() => {});
  assert.equal(settled?.state, "cancelled");
  assert.match(settled?.error ?? "", /Guest access was turned off/);

  await call("/api/settings", {
    method: "PUT",
    cookie: ownerCookie,
    body: { guestEnabled: true },
  });
});

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of input.toUpperCase().replace(/[^A-Z2-7]/g, "")) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totpCode(secret, steps = 0) {
  const counter = Math.floor(Date.now() / 30_000) + steps;
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

test("duplicate detection is owner-only", async () => {
  const login = await call("/api/login", {
    method: "POST",
    body: { username: "owner", password: "testpassword" },
  });
  const ownerCookie = cookieOf(login);
  const plan = await json(
    await call("/api/plan", {
      method: "POST",
      cookie: ownerCookie,
      body: { url: "https://example.com/x", kind: "track" },
    }),
  );
  assert.equal(plan.duplicates?.length, 1, "the library copy should be reported");
  assert.equal(plan.duplicates[0].source, "library");
  assert.equal(plan.duplicates[0].i, 1);

  const guest = await call("/api/guest", { method: "POST" });
  const guestPlan = await json(
    await call("/api/plan", {
      method: "POST",
      cookie: cookieOf(guest),
      body: { url: "https://93.184.216.34/x", kind: "track" },
    }),
  );
  assert.equal("duplicates" in guestPlan, false, "guests never get duplicate hints");
});

test("a full URL behind the host opens the composer", async () => {
  const target = "https://soundcloud.com/fabitekk/souls-in-outerspace";
  const response = await fetch(`${BASE}/${target}`, { redirect: "manual" });
  assert.equal(response.status, 302);
  const location = response.headers.get("location") ?? "";
  assert.ok(location.startsWith("/?url="), `unexpected redirect: ${location}`);
  assert.equal(decodeURIComponent(location.slice("/?url=".length)), target);
});

test("the server clock is public", async () => {
  const time = await json(await call("/api/time"));
  assert.ok(Math.abs(time.now - Date.now()) < 5000);
});

test("two-factor adds a code step to login", async () => {
  const login = await call("/api/login", {
    method: "POST",
    body: { username: "owner", password: "testpassword" },
  });
  const cookie = cookieOf(login);

  const setup = await json(await call("/api/2fa/setup", { method: "POST", cookie }));
  assert.match(setup.secret, /^[A-Z2-7]{16,}$/);
  assert.ok(setup.otpauth.startsWith("otpauth://totp/"));

  // Reopening the setup must not replace the secret behind an already scanned QR.
  const again = await json(await call("/api/2fa/setup", { method: "POST", cookie }));
  assert.equal(again.secret, setup.secret);

  const rejected = await call("/api/2fa/enable", {
    method: "POST",
    cookie,
    body: { code: "000000" },
  });
  assert.equal(rejected.status, 400);

  // A code from six steps away is refused, but the error says how far off the
  // device is instead of only "wrong".
  const shifted = await call("/api/2fa/enable", {
    method: "POST",
    cookie,
    body: { code: totpCode(setup.secret, 6) },
  });
  assert.equal(shifted.status, 400);
  const shiftedBody = await json(shifted);
  assert.equal(shiftedBody.skewSeconds, 180);
  assert.match(shiftedBody.error, /ahead of this server's clock/i);

  // Two steps (a minute) of drift is inside the accepted window.
  const enabled = await call("/api/2fa/enable", {
    method: "POST",
    cookie,
    body: { code: totpCode(setup.secret, -2) },
  });
  assert.equal(enabled.status, 200);

  // The remember choice is made with the password and must survive the code step.
  const step = await json(
    await call("/api/login", {
      method: "POST",
      body: { username: "owner", password: "testpassword", remember: 30 },
    }),
  );
  assert.equal(step.twoFactor, true);
  assert.ok(step.challenge);

  const wrong = await call("/api/login/2fa", {
    method: "POST",
    body: { challenge: step.challenge, code: "000001" },
  });
  assert.equal(wrong.status, 401);

  const ok = await call("/api/login/2fa", {
    method: "POST",
    body: { challenge: step.challenge, code: totpCode(setup.secret) },
  });
  assert.equal(ok.status, 200);
  assert.equal((await json(ok)).role, "owner");
  assert.match(ok.headers.getSetCookie().join("\n"), /Max-Age=2592000/);

  const off = await call("/api/2fa/disable", {
    method: "POST",
    cookie,
    body: { code: totpCode(setup.secret) },
  });
  assert.equal(off.status, 200);

  const plain = await json(
    await call("/api/login", {
      method: "POST",
      body: { username: "owner", password: "testpassword" },
    }),
  );
  assert.equal(plain.twoFactor, undefined);
  assert.equal(plain.role, "owner");
});

test("a remembered device outlives a restart, a browser window does not", async () => {
  const remembered = await call("/api/login", {
    method: "POST",
    body: { username: "owner", password: "testpassword", remember: 90 },
  });
  const rememberedCookie = cookieOf(remembered);
  assert.match(remembered.headers.getSetCookie().join("\n"), /Max-Age=7776000/);

  const windowed = await call("/api/login", {
    method: "POST",
    body: { username: "owner", password: "testpassword" },
  });
  const windowCookie = cookieOf(windowed);
  // No Max-Age at all: the browser drops the cookie when it quits.
  assert.equal(/Max-Age/.test(windowed.headers.getSetCookie().join("\n")), false);

  // The saved file holds digests, never a token that could be pasted as one.
  const file = path.join(DATA, "sessions.json");
  const saved = fs.readFileSync(file, "utf8");
  assert.equal(saved.includes(rememberedCookie.split("=")[1]), false);
  assert.ok(JSON.parse(saved).every((row) => /^[a-f0-9]{64}$/.test(row.key)));

  // Visiting the app re-sends the cookie with the time that is left, so the
  // browser's 400-day cap cannot silently end a longer sign-in.
  const refreshed = await call("/api/me", { cookie: rememberedCookie });
  const refreshAge = Number(/Max-Age=(\d+)/.exec(refreshed.headers.getSetCookie().join(" "))?.[1]);
  assert.ok(refreshAge > 89 * 24 * 3600 && refreshAge <= 90 * 24 * 3600, String(refreshAge));
  const plainMe = await call("/api/me", { cookie: windowCookie });
  assert.equal(plainMe.headers.getSetCookie().length, 0);

  await stopServer();
  await startServer();

  assert.equal((await call("/api/settings", { cookie: rememberedCookie })).status, 200);
  assert.equal((await call("/api/settings", { cookie: windowCookie })).status, 401);
});

test("an interrupted owner job resumes after a restart, a guest stream does not", async () => {
  const now = Date.now();
  await stopServer();

  // What a crash leaves behind: one owner job mid-download, one guest stream
  // that belongs to a browser session nobody can return to.
  const file = path.join(DATA, "jobs.json");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  saved.push(
    {
      id: "resume-owner",
      url: "https://example.com/resume",
      kind: "track",
      thumb: "",
      title: "Resume Me",
      artist: "",
      album: "",
      lufs: -9,
      quality: 2,
      format: "m4a",
      onePass: false,
      art: true,
      trackPrefix: false,
      policy: "skip",
      selection: [1],
      total: 1,
      completed: 0,
      conflicts: 0,
      owner: "owner",
      host: "example.com",
      dir: path.join(DATA, "music"),
      state: "running",
      createdAt: now,
      startedAt: now,
      tracks: [{ i: 1, title: "Resume Me", duration: 10, state: "running", stage: "download", pct: 40 }],
      log: [],
    },
    {
      id: "resume-guest",
      url: "https://example.com/guest",
      kind: "track",
      thumb: "",
      title: "Guest Stream",
      artist: "",
      album: "",
      lufs: -9,
      quality: 2,
      format: "m4a",
      onePass: false,
      art: true,
      trackPrefix: false,
      policy: "skip",
      selection: [1],
      total: 1,
      completed: 0,
      conflicts: 0,
      owner: "guest-token-xyz",
      guestId: "guest-xyz",
      stream: true,
      host: "example.com",
      state: "running",
      createdAt: now,
      startedAt: now,
      tracks: [{ i: 1, title: "Guest Stream", duration: 10, state: "running", stage: "download", pct: 10 }],
      log: [],
    },
  );
  fs.writeFileSync(file, JSON.stringify(saved));

  await startServer();

  const login = await call("/api/login", {
    method: "POST",
    body: { username: "owner", password: "testpassword" },
  });
  const ownerCookie = cookieOf(login);

  // Give the resumed job a moment to reach the stub downloader.
  let resumed;
  const deadline = Date.now() + 4000;
  for (;;) {
    const { jobs } = await json(await call("/api/jobs", { cookie: ownerCookie }));
    resumed = jobs.find((job) => job.id === "resume-owner");
    if (resumed && resumed.state !== "queued" && resumed.state !== "running") break;
    if (Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.ok(resumed, "the interrupted owner job is still there");
  assert.notEqual(resumed.state, "failed", "a restart must not fail an owner job");
  assert.equal(resumed.tracks[0].state === "running", false);

  const { jobs } = await json(await call("/api/jobs", { cookie: ownerCookie }));
  const guestJob = jobs.find((job) => job.id === "resume-guest");
  assert.equal(guestJob.state, "failed");
  assert.match(guestJob.error, /guest session ended/);
});

// ---------------------------------------------------------------- cookie jar
// A source that only offers a track to a signed-in session is the one failure
// the owner can actually fix from the UI, so the jar, its privacy and the
// offer that points at it are all tested here.

test("the cookie jar is stored, described without its contents, and owner-only", async () => {
  const ownerCookie = cookieOf(
    await call("/api/login", { method: "POST", body: { username: "owner", password: "testpassword" } }),
  );
  const jar = [
    "# Netscape HTTP Cookie File",
    "#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1790000000\tSID\tSECRETVALUE",
  ].join("\n");

  const saved = await call("/api/cookies", { method: "PUT", cookie: ownerCookie, body: { text: jar } });
  assert.equal(saved.status, 200);
  const savedBody = await json(saved);
  assert.equal(savedBody.cookies.set, true);
  assert.equal(savedBody.cookies.domains, 1, "an #HttpOnly_ line is a cookie, not a comment");
  assert.equal(savedBody.cookies.bytes > 0, true);

  // The jar reaches disk owner-readable only, and its contents never come back.
  const file = path.join(DATA, "cookies.txt");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const settingsText = await (await call("/api/settings", { cookie: ownerCookie })).text();
  assert.equal(settingsText.includes("SECRETVALUE"), false, settingsText);
  assert.equal(JSON.parse(settingsText).cookies.set, true);
  assert.equal(settingsText.includes("youtube.com"), false, "not even the domains are echoed");

  const guestCookie = cookieOf(await call("/api/guest", { method: "POST" }));
  const guestSettings = await json(await call("/api/settings", { cookie: guestCookie }));
  assert.equal(guestSettings.cookies, undefined, "a guest is not told a jar exists");
  assert.equal(
    (await call("/api/cookies", { method: "PUT", cookie: guestCookie, body: { text: jar } })).status,
    403,
  );
  assert.equal((await call("/api/cookies", { method: "DELETE", cookie: guestCookie })).status, 403);

  const bad = await call("/api/cookies", {
    method: "PUT",
    cookie: ownerCookie,
    body: { text: "<html>this is not a cookie jar</html>" },
  });
  assert.equal(bad.status, 400);
  assert.match((await json(bad)).error, /cookies\.txt/);
});

test("the jar reaches owner downloads and never a guest's", async () => {
  const ownerCookie = cookieOf(
    await call("/api/login", { method: "POST", body: { username: "owner", password: "testpassword" } }),
  );
  const jar = path.join(DATA, "cookies.txt");

  const created = await call("/api/jobs", {
    method: "POST",
    cookie: ownerCookie,
    body: {
      url: "https://example.com/jarprobe",
      kind: "track",
      title: "Jar Probe",
      rows: [{ i: 1, title: "Jar Probe", duration: 90 }],
    },
  });
  assert.equal(created.status, 201);

  const log = path.join(DATA, "args.log");
  const waitFor = async (needle) => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const line = fs.existsSync(log)
        ? fs.readFileSync(log, "utf8").split("\n").find((entry) => entry.includes(needle)) ?? ""
        : "";
      if (line || Date.now() > deadline) return line;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  const ownerLine = await waitFor("jarprobe");
  assert.ok(ownerLine, "the downloader never ran");
  assert.ok(ownerLine.includes(`--cookies ${jar}`), ownerLine);

  // A guest stream is a separate spawn: it must never carry the owner's jar.
  const guestCookie = cookieOf(await call("/api/guest", { method: "POST" }));
  const streamed = await call("/api/jobs", {
    method: "POST",
    cookie: guestCookie,
    body: {
      url: "https://93.184.216.34/jarguest",
      kind: "track",
      title: "Jar Guest",
      rows: [{ i: 1, title: "Jar Guest", duration: 60 }],
    },
  });
  assert.equal(streamed.status, 201);
  const { job } = await json(streamed);
  const audio = await fetch(`${BASE}/api/jobs/${job.id}/stream/1`, { headers: { cookie: guestCookie } });
  assert.equal(audio.status, 200);
  await audio.text();

  const guestLine = await waitFor("jarguest");
  assert.ok(guestLine, "the guest stream never ran");
  assert.doesNotMatch(guestLine, /--cookies/, guestLine);
});

test("a sign-in failure offers the jar, and only to the owner", async () => {
  const ownerCookie = cookieOf(
    await call("/api/login", { method: "POST", body: { username: "owner", password: "testpassword" } }),
  );
  const denied = await call("/api/inspect", {
    method: "POST",
    cookie: ownerCookie,
    body: { url: "https://example.com/authwall" },
  });
  assert.equal(denied.status, 502);
  const body = await json(denied);
  assert.equal(body.needsCookies, true, JSON.stringify(body));

  const guest = await call("/api/inspect", {
    method: "POST",
    cookie: cookieOf(await call("/api/guest", { method: "POST" })),
    body: { url: "https://93.184.216.34/authwall" },
  });
  assert.equal(guest.status, 502);
  assert.equal((await json(guest)).needsCookies, false, "a guest cannot paste a jar");

  // The same failure inside a queued job is flagged on the job, which is what
  // puts the offer in the queue row.
  const created = await call("/api/jobs", {
    method: "POST",
    cookie: ownerCookie,
    body: {
      url: "https://example.com/authwall",
      kind: "track",
      title: "Auth Wall",
      rows: [{ i: 1, title: "Auth Wall", duration: 60 }],
    },
  });
  assert.equal(created.status, 201);
  const { job } = await json(created);

  let finished;
  const deadline = Date.now() + 5000;
  for (;;) {
    const { jobs } = await json(await call("/api/jobs", { cookie: ownerCookie }));
    finished = jobs.find((entry) => entry.id === job.id);
    if (finished && finished.state !== "queued" && finished.state !== "running") break;
    if (Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(finished?.state, "failed");
  assert.equal(finished.needsCookies, true);
});

test("a plan's own duplicate hint is owner-only", async () => {
  const ownerCookie = cookieOf(
    await call("/api/login", { method: "POST", body: { username: "owner", password: "testpassword" } }),
  );
  const ownerPlan = await json(
    await call("/api/plan", {
      method: "POST",
      cookie: ownerCookie,
      body: { url: "https://example.com/dups", kind: "track" },
    }),
  );
  const hint = ownerPlan.duplicates?.find((match) => match.path.endsWith("Fresh Song.m4a"));
  assert.ok(hint, JSON.stringify(ownerPlan.duplicates));
  assert.equal(hint.source, "library");
  assert.equal(hint.i, 1);

  const guestCookie = cookieOf(await call("/api/guest", { method: "POST" }));
  const guestPlan = await json(
    await call("/api/plan", {
      method: "POST",
      cookie: guestCookie,
      body: { url: "https://93.184.216.34/dups", kind: "track" },
    }),
  );
  assert.equal("duplicate" in guestPlan.tracks[0], false, "a library path must not leak");
  assert.equal("duplicates" in guestPlan, false);
});

test("the jar can be removed again", async () => {
  const ownerCookie = cookieOf(
    await call("/api/login", { method: "POST", body: { username: "owner", password: "testpassword" } }),
  );
  const removed = await call("/api/cookies", { method: "DELETE", cookie: ownerCookie });
  assert.equal(removed.status, 200);
  assert.equal((await json(removed)).cookies.set, false);
  assert.equal(fs.existsSync(path.join(DATA, "cookies.txt")), false);
  const settings = await json(await call("/api/settings", { cookie: ownerCookie }));
  assert.equal(settings.cookies.set, false);
});

// A cover uploaded in the review card is a file on this machine, but the script
// downloads artwork with curl: the browser sends the short /api/covers path and
// the downloader is handed an absolute loopback URL instead.
test("an uploaded cover is served back and reaches the script as a URL", async () => {
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c636000000200010005fe02fea7c4b1f0000000049454e44ae426082",
    "hex",
  );
  const anonymous = await fetch(`${BASE}/api/covers`, {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: png,
  });
  assert.equal(anonymous.status, 401, "only a signed-in browser may store a cover");

  const ownerCookie = cookieOf(
    await call("/api/login", { method: "POST", body: { username: "owner", password: "testpassword" } }),
  );
  const upload = await fetch(`${BASE}/api/covers`, {
    method: "POST",
    headers: { "content-type": "image/png", cookie: ownerCookie },
    body: png,
  });
  assert.equal(upload.status, 201);
  const { url } = await json(upload);
  assert.match(url, /^\/api\/covers\/[a-f0-9]{32}\.png$/);

  const served = await fetch(BASE + url);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.equal(Buffer.from(await served.arrayBuffer()).length, png.length);

  // A file that is not an image is refused by its bytes, not its name.
  const text = await fetch(`${BASE}/api/covers`, {
    method: "POST",
    headers: { "content-type": "text/plain", cookie: ownerCookie },
    body: "definitely not a png",
  });
  assert.equal(text.status, 415);

  const created = await call("/api/jobs", {
    method: "POST",
    cookie: ownerCookie,
    body: {
      url: "https://example.com/coverprobe",
      kind: "track",
      title: "Cover Probe",
      thumb: url,
      rows: [{ i: 1, title: "Cover Probe", duration: 60, art: url }],
    },
  });
  assert.equal(created.status, 201);
  const { job } = await json(created);
  assert.equal(job.thumb, url, "the queue should be able to show the uploaded cover");

  const meta = path.join(DATA, `meta-${job.id}.json`);
  assert.ok(fs.existsSync(meta), "no metadata was handed to the script");
  const rows = JSON.parse(fs.readFileSync(meta, "utf8"));
  assert.equal(rows["1"].art, `http://127.0.0.1:${PORT}${url}`);
});

// /library reads the folder layout rather than tags, so these tests use the
// seeded Lib Artist/Lib Album/Known Song.m4a on disk.
test("the library browser lists artists, albums and tracks from the folder", async () => {
  const ownerCookie = cookieOf(
    await call("/api/login", {
      method: "POST",
      body: { username: "owner", password: "testpassword" },
    }),
  );

  const all = await json(await call("/api/library/browse", { cookie: ownerCookie }));
  assert.equal(all.root, path.join(DATA, "music"));
  const artist = all.artists.find((entry) => entry.name === "Lib Artist");
  assert.ok(artist, "the seeded artist is listed");
  assert.ok(artist.albums >= 1);

  const one = await json(
    await call(`/api/library/browse?artist=${encodeURIComponent("Lib Artist")}`, {
      cookie: ownerCookie,
    }),
  );
  assert.ok(one.albums.some((entry) => entry.name === "Lib Album"));
  const track = one.tracks.find((entry) => entry.title === "Known Song");
  assert.ok(track, "the file is listed by its name, without the extension");
  assert.equal(track.album, "Lib Album");
  assert.equal(track.track, null, "a file without a number stays unnumbered");

  // Every word has to match, and case does not matter.
  const search = await json(
    await call("/api/library/browse?q=LIB%20known", { cookie: ownerCookie }),
  );
  assert.equal(search.tracks.length, 1);
  assert.equal(search.tracks[0].title, "Known Song");
  assert.equal(search.matched, 1);

  // The library is the owner's, tags or no tags.
  const guestCookie = cookieOf(await call("/api/guest", { method: "POST" }));
  assert.equal((await call("/api/library/browse", { cookie: guestCookie })).status, 403);
});

test("library playback serves ranges and refuses anything outside the folder", async () => {
  const ownerCookie = cookieOf(
    await call("/api/login", {
      method: "POST",
      body: { username: "owner", password: "testpassword" },
    }),
  );
  const file = path.join(DATA, "music", "Lib Artist", "Lib Album", "Known Song.m4a");
  const encoded = encodeURIComponent(file);

  const full = await fetch(`${BASE}/api/library/track?path=${encoded}`, {
    headers: { cookie: ownerCookie },
  });
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("accept-ranges"), "bytes");
  assert.equal(full.headers.get("content-type"), "audio/mp4");
  assert.equal(await full.text(), "x");

  const part = await fetch(`${BASE}/api/library/track?path=${encoded}`, {
    headers: { cookie: ownerCookie, range: "bytes=0-0" },
  });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), `bytes 0-0/${fs.statSync(file).size}`);
  assert.equal(await part.text(), "x");

  const beyond = await fetch(`${BASE}/api/library/track?path=${encoded}`, {
    headers: { cookie: ownerCookie, range: "bytes=99-120" },
  });
  assert.equal(beyond.status, 416, "a range past the end is refused");

  // Outside the library, and a non-audio file inside it: neither is served.
  for (const outside of ["/etc/hostname", path.join(DATA, "music", "notes.txt")]) {
    assert.equal(
      (await call(`/api/library/track?path=${encodeURIComponent(outside)}`, {
        cookie: ownerCookie,
      })).status,
      404,
    );
  }

  const guestCookie = cookieOf(await call("/api/guest", { method: "POST" }));
  assert.equal(
    (await call(`/api/library/track?path=${encoded}`, { cookie: guestCookie })).status,
    403,
  );
});
