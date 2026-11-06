#!/usr/bin/env node
/**
 * Record the README's web UI demo.
 *
 *   cd web && npm run demo
 *
 * A throwaway instance is seeded with a small library (real audio, real covers,
 * made with ffmpeg) and a few finished jobs, then a scripted tour is recorded
 * and turned into `assets/demo.gif`. Nothing here touches the owner's data
 * folder or their library: every file is made in a temp folder and deleted
 * afterwards.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..");
const ROOT = path.resolve(WEB, "..");
const SERVER = path.join(WEB, "server", "index.mjs");
const OUT = path.join(ROOT, "assets", "demo.gif");
const OWNER = { username: "owner", password: "demo-password-1234" };

// A small, plausible library. The audio is a sine so the player really plays;
// the covers are gradients so the album tiles are not grey squares.
const ALBUMS = [
  {
    artist: "Aurora Fields",
    album: "Night Transit",
    cover: ["0x8b5cf6", "0x22d3ee"],
    tracks: ["Midnight Platform", "Signal Lights", "Last Train Home"],
  },
  {
    artist: "Aurora Fields",
    album: "Paper Lanterns",
    cover: ["0xf59e0b", "0xef4444"],
    tracks: ["Slow River", "Paper Lanterns"],
  },
  {
    artist: "Hollow Coast",
    album: "Tidal Rooms",
    cover: ["0x0ea5e9", "0x1e293b"],
    tracks: ["Salt Air", "Undertow"],
  },
  {
    artist: "Nine Volt Sky",
    album: "Static Bloom",
    cover: ["0xa3e635", "0x14b8a6"],
    tracks: ["Neon Garden", "Static Bloom"],
  },
];

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "crate-demo-"));
const MUSIC = path.join(DATA, "music");
const WORK = path.join(DATA, "work");

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

const ffmpeg = (...args) => execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args]);

function seed() {
  fs.mkdirSync(WORK, { recursive: true });
  const files = [];
  for (const [albumIndex, entry] of ALBUMS.entries()) {
    const dir = path.join(MUSIC, entry.artist, entry.album);
    fs.mkdirSync(dir, { recursive: true });
    ffmpeg(
      "-f",
      "lavfi",
      "-i",
      `gradients=s=420x420:c0=${entry.cover[0]}:c1=${entry.cover[1]}:x0=0:y0=0:x1=420:y1=420`,
      "-frames:v",
      "1",
      path.join(dir, "cover.jpg"),
    );
    for (const [index, title] of entry.tracks.entries()) {
      const name = `${String(index + 1).padStart(2, "0")} - ${title}.m4a`;
      const file = path.join(dir, name);
      ffmpeg(
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=${220 + albumIndex * 90 + index * 40}:duration=45`,
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        file,
      );
      files.push({ path: file, title, bytes: fs.statSync(file).size });
    }
  }

  const now = Date.now();
  const done = (entry, age, state = "done") => ({
    id: `demo-${age}`,
    url: "https://soundcloud.com/example/set",
    kind: "playlist",
    thumb: "",
    title: entry.album,
    artist: entry.artist,
    album: entry.album,
    genre: "",
    lufs: -14,
    quality: 2,
    format: "m4a",
    onePass: false,
    art: true,
    trackPrefix: true,
    policy: "skip",
    selection: entry.tracks.map((_, index) => index + 1),
    total: entry.tracks.length,
    completed: state === "failed" ? 0 : entry.tracks.length,
    failed: state === "failed" ? entry.tracks.length : 0,
    conflicts: 0,
    owner: "owner",
    host: "soundcloud.com",
    dir: MUSIC,
    state,
    createdAt: now - age,
    startedAt: now - age,
    finishedAt: now - age + 40_000,
    log:
      state === "failed"
        ? ["[1/2] Neon Garden", "ERROR: the source returned 403"]
        : entry.tracks.map((title, index) => `[${index + 1}/${entry.tracks.length}] ${title}`),
    tracks: entry.tracks.map((title, index) => ({
      i: index + 1,
      title,
      artist: entry.artist,
      album: entry.album,
      duration: 45,
      state: state === "failed" ? "failed" : "done",
      stage: null,
      pct: state === "failed" ? 0 : 100,
      path: path.join(MUSIC, entry.artist, entry.album, `${String(index + 1).padStart(2, "0")} - ${title}.m4a`),
      size: 240_000,
      ...(state === "failed" ? { error: "HTTP 403 from the source" } : {}),
    })),
  });

  fs.writeFileSync(
    path.join(DATA, "jobs.json"),
    JSON.stringify([
      done(ALBUMS[0], 8 * 60_000),
      done(ALBUMS[1], 46 * 60_000),
      done(ALBUMS[2], 3 * 3600_000),
      done(ALBUMS[3], 26 * 3600_000, "failed"),
    ]),
  );
  fs.writeFileSync(
    path.join(DATA, "history.json"),
    JSON.stringify(
      [
        { entry: ALBUMS[0], at: 9 * 60_000 },
        { entry: ALBUMS[1], at: 47 * 60_000 },
        { entry: ALBUMS[2], at: 3.1 * 3600_000 },
      ].map(({ entry, at }, index) => ({
        id: `history-${index}`,
        title: entry.album,
        artist: entry.artist,
        album: entry.album,
        kind: "playlist",
        format: "m4a",
        stream: false,
        total: entry.tracks.length,
        completed: entry.tracks.length,
        skipped: 0,
        failed: 0,
        state: "done",
        owner: "owner",
        finishedAt: now - at,
      })),
    ),
  );
  fs.writeFileSync(
    path.join(DATA, "stats.json"),
    JSON.stringify({ tracks: 96, guests: ["g1", "g2", "g3", "g4", "g5", "g6", "g7"] }),
  );
  const bin = path.join(DATA, "fake-dlAudio.sh");
  fs.writeFileSync(bin, "#!/bin/sh\nsleep 600\n", { mode: 0o755 });
  return { bin, files };
}

async function waitForServer(base) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/me`)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("the server never answered");
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

const hold = (page, ms) => page.waitForTimeout(ms);

async function main() {
  if (!fs.existsSync(path.join(WEB, "dist", "index.html"))) {
    throw new Error("no built UI: run `npm run build` in web/ first");
  }
  const { bin } = seed();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      AUDIODL_DATA: DATA,
      AUDIODL_PORT: String(port),
      AUDIODL_HOST: "127.0.0.1",
      AUDIODL_BIN: bin,
      MUSIC_DIR: MUSIC,
      XDG_STATE_HOME: path.join(DATA, "state"),
      AUDIODL_GUEST: "1",
      // A closed port, so the release check fails quietly: the demo must not
      // show "you are on dev" because the throwaway copy has a fake version.
      AUDIODL_RELEASE_API: "http://127.0.0.1:9/releases/latest",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let browser;
  try {
    await waitForServer(base);
    await fetch(`${base}/api/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        siteName: "Crate",
        username: OWNER.username,
        contact: "",
        password: OWNER.password,
      }),
    });
    const login = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...OWNER, remember: null }),
    });
    const raw = login.headers.getSetCookie?.()[0] ?? login.headers.get("set-cookie") ?? "";
    const [name, value] = raw.split(";")[0].split("=");

    browser = await chromium.launch({
      args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
    });
    const context = await browser.newContext({
      viewport: { width: 1180, height: 760 },
      recordVideo: { dir: path.join(WORK, "video"), size: { width: 1180, height: 760 } },
    });
    await context.addCookies([{ name, value, url: base }]);
    await context.addInitScript(() => {
      // Dark, with the aura on: the moving background is half of what the
      // screenshot is showing off.
      localStorage.setItem("audiodl-theme", "dark");
      localStorage.setItem("audiodl-effects", "on");
      localStorage.setItem("audiodl-2fa-nudge", "dismissed");
    });

    const page = await context.newPage();
    page.on("dialog", (dialog) => dialog.dismiss());

    // The queue, with finished and failed jobs.
    await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
    await hold(page, 2600);

    // The overview: library size, guests, tool versions.
    await page.goto(`${base}/dashboard`, { waitUntil: "domcontentloaded" });
    await hold(page, 2900);

    // The library: browse, pick an album, play it through.
    await page.goto(`${base}/library`, { waitUntil: "domcontentloaded" });
    await hold(page, 1500);
    await page.getByRole("button", { name: /Aurora Fields/ }).first().click();
    await hold(page, 1300);
    await page.getByRole("button", { name: /Night Transit/ }).first().click();
    await hold(page, 1100);
    await page.getByRole("button", { name: /^Play / }).first().click();
    await hold(page, 1900);
    // A little scroll shows the covers in the rows, not just the player bar.
    await page.mouse.wheel(0, 220);
    await hold(page, 2200);

    // And the settings page, to show there is one.
    await page.goto(`${base}/admin#general`, { waitUntil: "domcontentloaded" });
    await hold(page, 2100);

    const video = await page.video().path();
    await page.close();
    await context.close();

    ffmpeg(
      "-i",
      video,
      "-vf",
      "fps=12,scale=880:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=200:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle",
      "-loop",
      "0",
      OUT,
    );
    const { size } = fs.statSync(OUT);
    process.stdout.write(`wrote ${path.relative(ROOT, OUT)} (${(size / 1024 / 1024).toFixed(2)} MB)\n`);
    if (size > 9 * 1024 * 1024) {
      process.stdout.write("That is big for a README; lower fps in this script or shorten the tour.\n");
    }
  } finally {
    await browser?.close();
    child.kill("SIGTERM");
    fs.rmSync(DATA, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
