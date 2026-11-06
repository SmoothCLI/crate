import express from "express";
import { spawn } from "node:child_process";
import { clip, webhookKind, webhookPayload } from "./notify.mjs";
import dns from "node:dns";
import net from "node:net";
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const scryptAsync = promisify(scrypt);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, "..");
const DATA_DIR = process.env.AUDIODL_DATA || path.join(WEB_ROOT, "data");
const DIST = path.join(WEB_ROOT, "dist");
const BIN = process.env.AUDIODL_BIN || path.resolve(WEB_ROOT, "..", "dlAudio.sh");
const PORT = Number(process.env.AUDIODL_PORT || 8080);
const HOST = process.env.AUDIODL_HOST || "0.0.0.0";

// The release this UI belongs to, and where it comes from. The script and the
// web UI ship together, and the script is where the version is stamped, so it
// is read from there once at boot instead of being kept in a second place that
// could drift. A missing or unreadable script is not fatal: the page just says
// "dev" instead of naming a release.
const PROJECT_URL = "https://github.com/SmoothCLI/crate";
const VERSION = (() => {
  try {
    const stamp = fs.readFileSync(BIN, "utf8").match(/^VERSION="([^"]+)"/m);
    if (stamp) return stamp[1];
  } catch {
    /* not a checkout: leave the version unnamed */
  }
  return "dev";
})();

// Whether a newer Crate has been published. The answer is fetched in the
// background, at most every few hours, so an instance without outbound access
// or a slow GitHub never delays a page: the settings route only reads the last
// answer. Unauthenticated GitHub API calls are rate-limited generously enough
// for one every six hours.
const RELEASES_URL = `${PROJECT_URL}/releases`;
// A seam for the layout audit: it points this at a local stand-in so the hint
// can be tested without the network or depending on what is published today.
const RELEASES_API =
  process.env.AUDIODL_RELEASE_API || "https://api.github.com/repos/SmoothCLI/crate/releases/latest";
const UPDATE_EVERY = 6 * 60 * 60 * 1000;
const releaseCheck = { latest: "", url: "", notes: "", at: 0, checking: false };

// Numeric on purpose: a string compare puts 3.10 below 3.9. A leading "v" and
// anything after the numbers are ignored, so "v3.2.0" and "3.2.0-beta" both
// read as 3.2.0.
function versionParts(value) {
  return String(value || "")
    .replace(/^v/i, "")
    .split(/[.+-]/)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : 0));
}

function isNewer(candidate, current) {
  const left = versionParts(candidate);
  const right = versionParts(current);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

async function checkRelease() {
  if (releaseCheck.checking) return;
  releaseCheck.checking = true;
  const controller = new AbortController();
  // Unref'd: a check that never answers must not hold the process open, so the
  // container still stops when it is told to and the tests still exit.
  const timer = setTimeout(() => controller.abort(), 8000);
  timer.unref();
  try {
    const res = await fetch(RELEASES_API, {
      headers: { accept: "application/vnd.github+json", "user-agent": `crate/${VERSION}` },
      signal: controller.signal,
    });
    if (res.ok) {
      const data = await res.json();
      const tag = String(data.tag_name || "").trim();
      releaseCheck.latest = tag.replace(/^v/i, "");
      releaseCheck.url = String(data.html_url || "") || RELEASES_URL;
      // Enough to read in the hint without shipping a whole changelog; the
      // release page keeps the complete notes.
      releaseCheck.notes = String(data.body || "").slice(0, 4000);
    }
  } catch {
    // Offline, rate-limited or GitHub is down: keep the previous answer.
  } finally {
    clearTimeout(timer);
    releaseCheck.checking = false;
    releaseCheck.at = Date.now();
  }
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, "sessions"), { recursive: true });

// Updated tools live on the data volume instead of /usr/local/bin: the server
// runs as the host user there, so "Update yt-dlp" works without root and the
// download survives a rebuilt image. Every script run gets this directory
// first on PATH, where it shadows the copy baked into the image.
const TOOL_DIR = path.join(DATA_DIR, "bin");
fs.mkdirSync(TOOL_DIR, { recursive: true });
const TOOL_PATH = [TOOL_DIR, process.env.PATH || ""].filter(Boolean).join(path.delimiter);
const TOOL_STATE_FILE = path.join(DATA_DIR, "tools.json");
const toolState = readJson(TOOL_STATE_FILE, {});
const YTDLP_RELEASE = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";

// ---------------------------------------------------------------- persistence

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  // Settings hold the password hash; keep the file private to this account.
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------- passwords
//
// Passwords are never stored or compared directly. A salted scrypt hash is
// kept instead, so a leaked settings.json cannot be replayed as a password and
// guessing costs real work per attempt.

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT.keylen, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

async function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  const salt = Buffer.from(saltB64, "base64url");
  const expected = Buffer.from(keyB64, "base64url");
  if (!salt.length || !expected.length) return false;
  const actual = await scryptAsync(password, salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
// The owner's cookie jar for sources that want a signed-in session. A file
// rather than a setting: the script reads it by path, it never leaves the
// server, and it is written 0600.
const COOKIES_FILE = path.join(DATA_DIR, "cookies.txt");
const JOBS_FILE = path.join(DATA_DIR, "jobs.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");

// Hand-written owner config, kept in the data folder next to the password hash
// and never sent to the browser:
//
//   { "concurrency": 2, "perHost": 2,
//     "webhook": { "url": "https://discord.com/api/webhooks/…", "guest": false } }
//
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const config = readJson(CONFIG_FILE, {});

// How many jobs may run at once, and how many of those may hit the same source
// host. The second cap keeps a five-track playlist from opening five
// connections to one site and getting rate-limited.
// These are only the starting values; the owner can change both in Settings,
// which keeps them in settings.json from then on.
const DEFAULT_MAX_JOBS = clampInt(config.concurrency ?? process.env.AUDIODL_CONCURRENCY, 1, 8, 2);
const DEFAULT_PER_HOST = clampInt(config.perHost ?? process.env.AUDIODL_PER_HOST, 1, DEFAULT_MAX_JOBS, 2);

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function hostOf(value) {
  try {
    return new URL(String(value)).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return "";
  }
}

// The webhook only ever travels server-to-server: the browser is told whether
// one is set and which host it points at, never the URL itself. config.json (or
// AUDIODL_WEBHOOK) supplies the starting value; after that it lives in
// settings.json and is edited in Settings.
function webhookFrom(config) {
  const raw = typeof config === "string" ? config : config && config.url;
  try {
    const url = new URL(String(raw || ""));
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

const INITIAL_WEBHOOK_URL = webhookFrom(config.webhook) || webhookFrom(process.env.AUDIODL_WEBHOOK) || "";
const INITIAL_WEBHOOK_GUESTS = Boolean(config.webhook && config.webhook.guest);

const defaultMusicDir = process.env.MUSIC_DIR || (fs.existsSync("/media/music") ? "/media/music" : path.join(os.homedir(), "Music"));
const DEFAULT_SITE_NAME = "Crate";
const DEFAULT_USERNAME = "admin";
// Guest audio is encoded on demand and streamed to the browser; the server never
// produces a guest file, so there is no staging folder and no expiry to run.
const GUEST_PREVIEW_DIR = path.join(DATA_DIR, "preview");
fs.mkdirSync(GUEST_PREVIEW_DIR, { recursive: true });
// Cover art uploaded from the review card. The file is written here and served
// back over loopback, because the download script fetches artwork with curl and
// only understands http(s).

// Containers the script can write and tag itself. Opus is owner-only: it needs
// mutagen to write its tags, and it cannot be streamed for the same reason.
const FORMATS = new Set(["m4a", "mp3", "opus", "flac", "wav"]);
const GUEST_FORMATS = new Set(["m4a", "mp3", "flac", "wav"]);
function clampFormat(value, fallback = "m4a") {
  const v = String(value || "").toLowerCase();
  return FORMATS.has(v) ? v : fallback;
}
function clampGuestFormat(value, fallback = "m4a") {
  const v = clampFormat(value, fallback);
  return GUEST_FORMATS.has(v) ? v : "m4a";
}
function formatFor(role, requested, fallback) {
  return role === "guest" ? clampGuestFormat(requested, fallback) : clampFormat(requested, fallback);
}

// Instance name: what the header and the PWA manifest show. Anything that is
// not blank works; whitespace is collapsed and it is capped at 40 characters.
function cleanSiteName(value) {
  const name = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  return name || DEFAULT_SITE_NAME;
}

// Public contact line: an email address or a link the owner is willing to hand
// out. Free text is fine; control characters are dropped and whitespace is
// collapsed so it stays one line on the contact page.
function cleanContact(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

// Owner username: 2-32 characters from a conservative set, case preserved but
// matched case-insensitively at login.
function cleanUsername(value) {
  const name = String(value ?? "").trim();
  return /^[A-Za-z0-9._-]{2,32}$/.test(name) ? name : "";
}

// Guest preferences live on the session, never in settings.json: one visitor
// must not be able to change what the next visitor gets. The presets are the
// only place where a named bundle of values exists.
const GUEST_PRESETS = {
  phone: { format: "m4a", quality: 3, lufs: -11, art: true },
  small: { format: "m4a", quality: 5, lufs: -14, art: true },
  lossless: { format: "flac", quality: 2, lufs: -14, art: true },
};
const GUEST_DEFAULT_PROFILE = { preset: "phone", ...GUEST_PRESETS.phone };

// Preferences are per browser, not per session: the session token is thrown
// away on restart, so a long-lived id cookie is what makes them survive one.
const GUEST_PROFILES_FILE = path.join(DATA_DIR, "guest-profiles.json");
const guestProfiles = readJson(GUEST_PROFILES_FILE, {});
const GUEST_PROFILE_LIMIT = 200;

function storedProfile(id) {
  const saved = id ? guestProfiles[id] : null;
  if (!saved) return null;
  return {
    preset: typeof saved.preset === "string" ? saved.preset : "custom",
    format: clampGuestFormat(saved.format),
    quality: Number.isInteger(saved.quality) ? Math.min(5, Math.max(1, saved.quality)) : GUEST_DEFAULT_PROFILE.quality,
    lufs: Number.isFinite(Number(saved.lufs)) ? Number(saved.lufs) : GUEST_DEFAULT_PROFILE.lufs,
    art: saved.art !== false,
  };
}

function saveGuestProfile(id, profile) {
  if (!id) return;
  guestProfiles[id] = { ...profile, lastSeen: Date.now() };
  const ids = Object.keys(guestProfiles);
  if (ids.length > GUEST_PROFILE_LIMIT) {
    ids
      .sort((a, b) => (guestProfiles[a].lastSeen || 0) - (guestProfiles[b].lastSeen || 0))
      .slice(0, ids.length - GUEST_PROFILE_LIMIT)
      .forEach((old) => delete guestProfiles[old]);
  }
  writeJson(GUEST_PROFILES_FILE, guestProfiles);
}

// --------------------------------------------------------------- two-factor
// RFC 6238 TOTP: HMAC-SHA1, six digits, 30-second steps. Time zones play no
// part - every authenticator counts UTC seconds since the epoch - so the only
// thing that can make a correct-looking code fail is a clock that is actually
// set wrong. Two steps of slack either side cover a minute of drift, and a
// rejected code is compared against a much wider window so the error can say
// how far off the device is. The secret is base32, as authenticator apps
// expect, and only ever leaves the server during its own setup call.
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_PERIOD = 30;
const TOTP_WINDOW = 2;
const TOTP_SCAN = 20;

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(input) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of String(input).toUpperCase().replace(/[^A-Z2-7]/g, "")) {
    const index = BASE32.indexOf(char);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totpAt(secret, counter) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, "0");
}

function totpStep(ms = Date.now()) {
  return Math.floor(ms / (TOTP_PERIOD * 1000));
}

// Nearest step whose code matches, up to `window` steps away; null if none.
function totpOffset(secret, value, base, window) {
  for (let distance = 0; distance <= window; distance += 1) {
    for (const offset of distance === 0 ? [0] : [distance, -distance]) {
      if (totpAt(secret, base + offset) === value) return offset;
    }
  }
  return null;
}

// Returns { ok, skewSeconds }. skewSeconds is only filled in on a failure: it
// is how far the authenticator's clock is from this server's, when the code
// belongs to another moment within the wider scan.
function verifyTotp(secret, code) {
  const value = String(code || "").replace(/\s+/g, "");
  if (!secret || !/^\d{6}$/.test(value)) {
    return { ok: false, skewSeconds: null };
  }
  const base = totpStep();
  if (totpOffset(secret, value, base, TOTP_WINDOW) !== null) return { ok: true, skewSeconds: 0 };
  const wide = totpOffset(secret, value, base, TOTP_SCAN);
  return {
    ok: false,
    skewSeconds: wide === null ? null : Math.round(wide * TOTP_PERIOD),
  };
}

// A rejected code is almost always a clock problem, not a typing problem, so
// the message names the gap instead of only saying "wrong". The screens show
// the server clock next to the field, so the message does not repeat it.
function totpError(check) {
  if (Number.isFinite(check.skewSeconds) && check.skewSeconds !== 0) {
    const seconds = Math.abs(check.skewSeconds);
    const gap = seconds >= 60 ? `${Math.round(seconds / 60)} min` : `${seconds} s`;
    const side = check.skewSeconds > 0 ? "ahead of" : "behind";
    return `That code is ${gap} ${side} this server's clock. Set the device with the authenticator to automatic time and try the next code.`;
  }
  return "Wrong or expired code. The authenticator and this server have to agree on the time - compare your app with the server clock under the field.";
}

function newTotpSecret() {
  return base32Encode(randomBytes(20));
}

function otpauthUrl(secret, account) {
  const issuer = settings.siteName;
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// A secret waiting for its first valid code, and a signed-in-but-not-verified
// login. Both are short-lived and kept in memory only.
const pendingTotp = new Map();
const loginChallenges = new Map();

// Guest quota: one counter per browser id per calendar day, so the on/off
// switch can become "N downloads a day" without touching job ownership.
const QUOTA_FILE = path.join(DATA_DIR, "guest-quota.json");
const guestQuota = readJson(QUOTA_FILE, {});
const QUOTA_ENTRIES = 500;

function today() {
  return new Date().toISOString().slice(0, 10);
}

function quotaUsed(guestId) {
  const entry = guestId ? guestQuota[guestId] : null;
  return entry && entry.day === today() ? entry.count : 0;
}

function useQuota(guestId) {
  if (!guestId) return;
  const day = today();
  const entry = guestQuota[guestId];
  guestQuota[guestId] = { day, count: entry && entry.day === day ? entry.count + 1 : 1 };
  const ids = Object.keys(guestQuota);
  if (ids.length > QUOTA_ENTRIES) {
    ids
      .filter((id) => guestQuota[id].day !== day)
      .slice(0, ids.length - QUOTA_ENTRIES)
      .forEach((id) => delete guestQuota[id]);
  }
  writeJson(QUOTA_FILE, guestQuota);
}

// A small public tally of what the guest side has done: how many browsers and
// how many songs, counted only when a guest track actually finishes streaming.
// Owner downloads never touch it - it is there to show the public side, not the
// library. Guest ids are the same opaque cookie ids the quota uses, kept so a
// return visitor is not counted twice.
const STATS_FILE = path.join(DATA_DIR, "stats.json");
const GUEST_IDS_KEPT = 5000;
const guestStats = readJson(STATS_FILE, { tracks: 0, guests: [] });
guestStats.tracks = Math.max(0, Math.floor(Number(guestStats.tracks) || 0));
guestStats.guests = Array.isArray(guestStats.guests)
  ? guestStats.guests.filter((id) => typeof id === "string").slice(-GUEST_IDS_KEPT)
  : [];

// Called whenever a job settles. `guestCounted` tracks how many of this job's
// tracks have already been added, so a retry or a second stream of the same
// track cannot count twice.
function countGuestTracks(job) {
  if (job.owner === "owner") return;
  const done = job.tracks.filter((track) => track.state === "done").length;
  const counted = job.guestCounted || 0;
  if (done <= counted) return;
  job.guestCounted = done;
  guestStats.tracks += done - counted;
  if (job.guestId && !guestStats.guests.includes(job.guestId)) {
    guestStats.guests.push(job.guestId);
    if (guestStats.guests.length > GUEST_IDS_KEPT) {
      guestStats.guests = guestStats.guests.slice(-GUEST_IDS_KEPT);
    }
  }
  writeJson(STATS_FILE, guestStats);
  broadcastStats();
}

// Finished jobs leave a short record behind so /admin can show what was
// fetched recently even after the queue entry is removed. Only the owner's
// jobs belong here: guests stream their files without touching the library.
const HISTORY_FILE = path.join(DATA_DIR, "history.json");
const HISTORY_LIMIT = 200;
const isGuestEntry = (entry) => entry?.owner === "guest";
let history = readJson(HISTORY_FILE, []).filter((entry) => !isGuestEntry(entry));

function recordHistory(job) {
  countGuestTracks(job);
  if (job.historyWritten) return;
  job.historyWritten = true;
  if (job.owner !== "owner") return;
  history.unshift({
    id: job.id,
    title: job.title,
    artist: job.artist,
    album: job.album,
    kind: job.kind,
    format: job.format,
    stream: Boolean(job.stream),
    total: job.total,
    completed: job.completed || 0,
    skipped: job.skipped || 0,
    failed: job.failed || 0,
    state: job.state,
    owner: job.owner === "owner" ? "owner" : "guest",
    finishedAt: job.finishedAt || Date.now(),
  });
  history = history.slice(0, HISTORY_LIMIT);
  writeJson(HISTORY_FILE, history);
}

function guestProfile(token) {
  const entry = sessions.get(token);
  if (!entry) return { ...GUEST_DEFAULT_PROFILE };
  if (!entry.profile) {
    entry.profile = storedProfile(entry.guestId) ?? { ...GUEST_DEFAULT_PROFILE };
  }
  return entry.profile;
}

function normalizeProfile(body, current) {
  const preset = typeof body.preset === "string" && GUEST_PRESETS[body.preset] ? body.preset : "custom";
  const base = preset === "custom" ? current : GUEST_PRESETS[preset];
  return {
    preset,
    format: clampGuestFormat(body.format, base.format),
    quality: Number.isInteger(body.quality) ? Math.min(5, Math.max(1, body.quality)) : base.quality,
    lufs: clampLufs(body.lufs ?? base.lufs),
    art: body.art === undefined ? base.art : Boolean(body.art),
  };
}

const settings = {
  siteName: DEFAULT_SITE_NAME,
  username: DEFAULT_USERNAME,
  musicDir: defaultMusicDir,
  lufs: -9,
  quality: 2,
  format: "m4a",
  ...readJson(SETTINGS_FILE, {}),
};
settings.format = clampFormat(settings.format);
settings.siteName = cleanSiteName(settings.siteName);
settings.contact = cleanContact(settings.contact);
settings.totpSecret = typeof settings.totpSecret === "string" ? settings.totpSecret : "";
settings.totpEnabled = Boolean(settings.totpEnabled && settings.totpSecret);
settings.username = cleanUsername(settings.username) || DEFAULT_USERNAME;
settings.guestQuota = clampInt(settings.guestQuota, 0, 100, 0);
settings.maxJobs = clampInt(settings.maxJobs ?? DEFAULT_MAX_JOBS, 1, 8, DEFAULT_MAX_JOBS);
settings.perHost = clampInt(
  settings.perHost ?? DEFAULT_PER_HOST,
  1,
  settings.maxJobs,
  Math.min(DEFAULT_PER_HOST, settings.maxJobs),
);
// A stored empty string means the owner removed the webhook on purpose, so the
// config.json value must not come back on the next start.
settings.webhookUrl =
  typeof settings.webhookUrl === "string" ? webhookFrom(settings.webhookUrl) ?? "" : INITIAL_WEBHOOK_URL;
settings.webhookGuests =
  typeof settings.webhookGuests === "boolean" ? settings.webhookGuests : INITIAL_WEBHOOK_GUESTS;
delete settings.guestDir; // older files carried a server-side guest folder

// Guests can be switched off from Settings without editing compose; the
// environment variable is the initial value, the stored setting wins after.
let guestEnabled =
  typeof settings.guestEnabled === "boolean" ? settings.guestEnabled : process.env.AUDIODL_GUEST !== "0";
settings.guestEnabled = guestEnabled;

// Migrate a settings file from before hashed passwords.
if (typeof settings.password === "string" && settings.password) {
  settings.passwordHash = await hashPassword(settings.password);
  delete settings.password;
  writeJson(SETTINGS_FILE, settings);
}

// The password comes from the environment or is chosen on first run at
// /setup. It is stored as a scrypt hash in data/settings.json - there is no
// plaintext copy to recover, so nobody has to read a log line to get in.
// A changed env password counts as a password change, so remembered devices are
// signed out with it; an unchanged one is left alone (no re-hash on every
// start, and "remember this device" keeps working across restarts).
if (
  process.env.AUDIODL_PASSWORD &&
  !(await verifyPassword(process.env.AUDIODL_PASSWORD, settings.passwordHash))
) {
  settings.passwordHash = await hashPassword(process.env.AUDIODL_PASSWORD);
  fs.rmSync(SESSIONS_FILE, { force: true });
}
writeJson(SETTINGS_FILE, settings);
let passwordHash = settings.passwordHash || "";
// No password yet: the UI sends the first visitor to /setup, and the owner
// login stays closed until one is chosen (guests are unaffected).
let setupNeeded = !passwordHash;
let setupLock = false;

// ---------------------------------------------------------------- sessions
//
// The map is keyed by the SHA-256 of the cookie token, never the token itself.
// Remembered sign-ins are also written to data/sessions.json in that form, so a
// container restart does not sign every phone and laptop out while a copy of
// the file still cannot be replayed as a cookie.
const MAX_SESSIONS = 50;
const SESSION_TTL = 12 * 3600 * 1000; // one browser session, at most
const FOREVER_TTL = 10 * 365 * 24 * 3600 * 1000;
const REMEMBER_TTLS = new Map([
  [7, 7 * 24 * 3600 * 1000],
  [30, 30 * 24 * 3600 * 1000],
  [90, 90 * 24 * 3600 * 1000],
]);

const sessions = new Map(); // sha256(token) -> { role, expires, created, guestId? }

for (const row of readJson(SESSIONS_FILE, [])) {
  if (!row?.key || !Number.isFinite(row.expires) || row.expires < Date.now()) continue;
  if (sessions.size >= MAX_SESSIONS) break;
  sessions.set(row.key, {
    role: "owner",
    expires: row.expires,
    created: row.created || 0,
    remembered: true,
  });
}

function sessionKey(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

// "Remember this device": 7, 30 or 90 days, or "forever" (ten years). Zero
// means the cookie lives with the browser window instead.
function rememberTtl(remember) {
  if (remember === "forever") return FOREVER_TTL;
  return REMEMBER_TTLS.get(Number(remember)) ?? 0;
}

function saveSessions() {
  const rows = [];
  // Only remembered devices: a browser-window session is meant to end with the
  // browser, so keeping it in a file would make the checkbox meaningless.
  for (const [key, entry] of sessions) {
    if (entry.role !== "owner" || !entry.remembered || entry.expires < Date.now()) continue;
    rows.push({ key, expires: entry.expires, created: entry.created });
  }
  rows.sort((a, b) => b.created - a.created);
  writeJson(SESSIONS_FILE, rows.slice(0, MAX_SESSIONS));
}

// Newest device wins the last slot: an old forgotten token should not keep one.
function pruneSessions() {
  const remembered = [...sessions].filter(([, entry]) => entry.role === "owner" && entry.remembered);
  if (remembered.length <= MAX_SESSIONS) return;
  remembered
    .sort((a, b) => (a[1].created || 0) - (b[1].created || 0))
    .slice(0, remembered.length - MAX_SESSIONS)
    .forEach(([key]) => sessions.delete(key));
}

// Creates the session and returns the Set-Cookie value for it. `remember` is a
// TTL in ms: zero means a browser-session cookie that is not kept on disk, so
// quitting the browser signs the device out.
function createSession(req, { role, ttl, remember = 0, guestId }) {
  const token = randomBytes(role === "owner" ? 32 : 24).toString("base64url");
  const now = Date.now();
  const remembered = remember > 0;
  const entry = { role, expires: now + ttl, created: now, remembered, guestId };
  // Drop what already expired, so a long-running server does not keep every
  // cookie it ever handed out.
  for (const [key, stale] of sessions) {
    if (stale.expires < now) sessions.delete(key);
  }
  sessions.set(sessionKey(token), entry);
  if (role === "owner") {
    pruneSessions();
    saveSessions();
  }
  return sessionCookie(req, token, remembered ? Math.floor(ttl / 1000) : null);
}

// Live queue feed. Declared up here because the boot-time sweep can emit to it.
const streamClients = new Set();
const pendingPush = new Map();

// ------------------------------------------------------------------- job model

/** @type {Array<object>} */
let jobs = readJson(JOBS_FILE, []);
const queue = [];

// A restart is not a failure. An owner job that was running or waiting goes
// back into the queue: the downloader skips the tracks already written, so only
// what is missing is fetched again. Guest stream jobs belong to a browser
// session that no longer exists, so those are closed out instead of resumed.
for (const job of jobs) {
  const unfinished =
    job.state === "running" || job.state === "queued" || job.state === "cancelling";
  if (!unfinished) continue;
  if (job.owner !== "owner" || job.stream) {
    job.state = "failed";
    job.error =
      job.owner === "owner"
        ? "The server stopped before this finished."
        : "The guest session ended before this finished.";
    continue;
  }
  job.state = "queued";
  job.error = undefined;
  delete job.needsCookies;
  job.completed = 0;
  job.tracks = job.tracks.map((track) => ({
    ...track,
    state: "queued",
    pct: 0,
    stage: null,
    error: undefined,
  }));
  queue.push(job.id);
}
if (queue.length) persistJobs();

// Jobs that currently own a downloader process. Several may run at once, up to
// settings.maxJobs; each is keyed by id so a stale entry can never be mistaken
// for a finished one.
const active = new Map();

function persistJobs() {
  writeJson(
    JOBS_FILE,
    jobs.map(({ child, streamChild, ...j }) => ({ ...j, log: j.log.slice(-120) })),
  );
}

// The live child process must never reach JSON.stringify or a response body.
function publicJob(job) {
  // `guestId` and `guestCounted` belong to the tally, not to the queue view.
  const { child, streamChild, metaPath, owner, guestId, guestCounted, ...rest } = job;
  return rest;
}

// One re-tag at a time per job, held outside the job so a crash cannot leave a
// stale "retagging" flag in jobs.json.
const retagging = new Set();

function findJob(id) {
  return jobs.find((j) => j.id === id);
}

// ------------------------------------------------------------------ inspector

function toolEnv(extra = {}) {
  return { ...process.env, PATH: TOOL_PATH, ...extra };
}

const RETAG_EXT = new Set([".m4a", ".mp3", ".flac", ".wav", ".opus", ".ogg", ".oga"]);
const OGG_EXT = new Set([".opus", ".ogg", ".oga"]);
// A collaboration arrives as one string ("A, B"); tags hold a list, so the
// separators become separate values. Trimmed and de-duplicated, and the album
// artist stays one readable name.
function splitArtists(artist) {
  const names = [];
  for (const part of String(artist || "").split(/[,;，；、]/)) {
    const name = part.replace(/^[\s\u3000]+|[\s\u3000]+$/g, "");
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

// Curated artist -> genre map, shipped beside the server so a download is
// tagged with a genre by default. It is plain data in the same shape the
// library backfill used: edit the file and restart, no code change needed.
const GENRE_DATA = readJson(path.join(HERE, "artist-genres.json"), {});
const GENRE_MAP =
  GENRE_DATA && typeof GENRE_DATA.artists === "object" && GENRE_DATA.artists
    ? GENRE_DATA.artists
    : {};
const GENRE_NAMES = Array.isArray(GENRE_DATA?.genres) ? GENRE_DATA.genres : [];

// Genre arrives as free text from the browser, so it is flattened into one
// clean line before it reaches a tag writer or a command line.
function cleanGenre(value, max = 60) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

// The first credited artist decides, exactly like the folder the file is
// written into does, so a collaboration lands in its lead act's genre.
function genreForArtist(artist) {
  for (const name of splitArtists(artist)) {
    const genre = GENRE_MAP[name]?.genre;
    if (genre) return genre;
  }
  return "";
}

const OGG_RETAG = `
import json, sys
from mutagen import File

audio = File(sys.argv[1])
if audio is None:
    sys.exit("unsupported container")
tags = json.loads(sys.argv[2])
names = json.loads(sys.argv[3])
for name, key in (("title", "title"), ("album", "album"), ("genre", "genre")):
    value = tags.get(name)
    if value:
        audio[key] = [value]
    elif key in audio:
        del audio[key]
for key in ("artist", "albumartist"):
    if names:
        audio[key] = names
    elif key in audio:
        del audio[key]
audio.save()
`;

// ffmpeg writes a single artist string, so a file that names several artists is
// rewritten afterwards with mutagen: one value per artist in the container's
// own way (repeated Vorbis comments, MP4 data atoms, an ID3 text frame).
const ARTIST_RETAG = `
import os, re, sys

path, artist = sys.argv[1], sys.argv[2]
names = []
for name in re.split(r"[,;，；、]", artist):
    name = name.strip(" \\t\\u3000")
    if name and name not in names:
        names.append(name)
if len(names) < 2:
    sys.exit(0)

ext = os.path.splitext(path)[1].lower()

if ext == ".mp3":
    from mutagen.id3 import ID3, TPE1, TPE2

    audio = ID3(path)
    audio.delall("TPE1")
    audio.add(TPE1(encoding=3, text=names))
    audio.delall("TPE2")
    audio.add(TPE2(encoding=3, text=names))
    audio.save(v2_version=3)
elif ext == ".m4a":
    from mutagen.mp4 import MP4, MP4FreeForm

    audio = MP4(path)
    audio["\\xa9ART"] = names
    audio["----:com.apple.iTunes:ARTISTS"] = [MP4FreeForm(n.encode("utf-8")) for n in names]
    audio["aART"] = names
    audio.save()
elif ext == ".flac":
    from mutagen.flac import FLAC

    audio = FLAC(path)
    audio["ARTIST"] = names
    audio["ALBUMARTIST"] = names
    audio.save()
`;

// Re-tagging rewrites the tags of a file that is already on disk without
// touching the audio: ffmpeg copies every stream and replaces the metadata, so
// there is no second encode and no quality loss. Ogg and Opus go through
// mutagen because ffmpeg's Ogg muxer drops -metadata (same reason the
// downloader writes Opus tags in Python). The file keeps its name and folder.
async function retagFile(file, tags) {
  const ext = path.extname(file).toLowerCase();
  if (!RETAG_EXT.has(ext)) {
    throw new Error(`${ext || "that"} files cannot be re-tagged`);
  }
  const names = splitArtists(tags.artist);
  if (OGG_EXT.has(ext)) {
    const result = await runCommand(findTool("python3") || "python3", [
      "-c",
      OGG_RETAG,
      file,
      JSON.stringify(tags),
      JSON.stringify(names),
    ]);
    if (result.code !== 0) throw new Error(lastLine(result.stderr) || "mutagen failed");
    return;
  }

  const ffmpeg = findTool("ffmpeg");
  if (!ffmpeg) throw new Error("ffmpeg is not available");
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.retag-${randomBytes(4).toString("hex")}${ext}`,
  );
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    file,
    // Every stream, untouched: the audio and any attached cover art come along.
    "-map",
    "0",
    "-c",
    "copy",
    "-map_metadata",
    "-1",
  ];
  for (const [key, value] of Object.entries(tags)) {
    if (value) args.push("-metadata", `${key}=${value}`);
  }
  const result = await runCommand(ffmpeg, [...args, tmp], { timeout: 120_000 });
  if (result.code !== 0) {
    fs.rmSync(tmp, { force: true });
    throw new Error(lastLine(result.stderr) || "ffmpeg failed");
  }
  if (names.length > 1) {
    // The tags are on the file either way, but this is the reason the artist
    // was edited: without the list the players show one made-up name.
    const split = await runCommand(findTool("python3") || "python3", [
      "-c",
      ARTIST_RETAG,
      tmp,
      tags.artist,
    ]);
    if (split.code !== 0) {
      fs.rmSync(tmp, { force: true });
      throw new Error(
        lastLine(split.stderr) || "could not write the separate artists (mutagen missing?)",
      );
    }
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

function lastLine(text) {
  const lines = String(text || "")
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "";
}

function runCommand(file, args, { timeout = 30_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { env: toolEnv(), stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: -1, stdout: "", stderr: err.message });
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${err.message}` });
    });
  });
}

// First match on the PATH the script itself will see, so the version shown is
// the version a download would actually use.
function findTool(name) {
  for (const dir of TOOL_PATH.split(path.delimiter).filter(Boolean)) {
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {
      /* try the next directory */
    }
  }
  return "";
}

function runScript(args, { timeout = 180_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(BIN, args, { env: toolEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${err.message}` });
    });
  });
}

function parseJsonOutput(stdout) {
  const line = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .pop();
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function firstErrorLine(stderr) {
  const lines = stderr.split("\n");
  const hit = [...lines].reverse().find((l) => l.includes("[x]"));
  return (hit || lines.filter(Boolean).pop() || "The downloader failed.").replace(/^\[x\]\s*/, "").replace(/\x1b\[[0-9;]*m/g, "");
}

function validateUrl(value) {
  try {
    const u = new URL(String(value));
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

function isPrivateAddress(address) {
  const ip = String(address).replace(/^\[|\]$/g, "").toLowerCase();
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (net.isIPv6(ip)) {
    return (
      ip === "::1" ||
      ip === "::" ||
      ip.startsWith("fc") ||
      ip.startsWith("fd") ||
      ip.startsWith("fe80") ||
      ip.startsWith("::ffff:127.") ||
      ip.startsWith("::ffff:10.") ||
      ip.startsWith("::ffff:192.168.")
    );
  }
  return false;
}

// Guests may only reach the public internet: the server sits inside the LAN,
// so an unauthenticated URL fetch must not become a port scanner.
async function isPublicTarget(url) {
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (net.isIP(host)) return !isPrivateAddress(host);
  const records = await dns.promises.lookup(host, { all: true }).catch(() => []);
  // An unresolvable name is the extractor's problem to report, not a bypass:
  // by the time it downloads, the name could resolve to anything, so resolve
  // failures are refused for guests.
  if (records.length === 0) return false;
  return records.every((record) => !isPrivateAddress(record.address));
}

function clampLufs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < -70 || n > -5) return settings.lufs;
  return n;
}

function metaFile(jobId, rows) {
  const file = path.join(DATA_DIR, `meta-${jobId}.json`);
  writeJson(file, rows);
  return file;
}

// ----------------------------------------------------------------- cover art
//
// A cover chosen in the review card is either a remote URL, which the script
// downloads itself, or an image uploaded through the browser, which lives here
// under an opaque name. The browser is given the short path; the script is
// handed an absolute loopback URL, because that is all it can fetch.
const COVERS_DIR = path.join(DATA_DIR, "covers");
fs.mkdirSync(COVERS_DIR, { recursive: true });
const COVER_NAME = /^[a-f0-9]{32}\.(?:jpg|png|webp|gif)$/;
const COVER_PATH = /^\/api\/covers\/[a-f0-9]{32}\.(?:jpg|png|webp|gif)$/;
const COVER_MAX_BYTES = 8 * 1024 * 1024;
const COVER_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
// "0.0.0.0" means every interface, not an address anything can connect to.
const SELF_HOST = !HOST || HOST === "0.0.0.0" || HOST === "::" ? "127.0.0.1" : HOST;

// The extension comes from the bytes, not the name or the content type the
// browser claimed: a text file renamed to .png must not become a served image.
function coverExtension(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (
    buf.length > 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return "png";
  }
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    return "webp";
  }
  if (buf.length > 6 && buf.toString("ascii", 0, 3) === "GIF") return "gif";
  return "";
}

function artForScript(value) {
  const art = String(value || "").trim();
  return COVER_PATH.test(art) ? `http://${SELF_HOST}:${PORT}${art}` : art;
}

// Covers only have to outlive the job that references them, so a week is
// generous. Pruned on upload rather than on a timer: no schedule to maintain.
function pruneCovers() {
  const cutoff = Date.now() - COVER_KEEP_MS;
  let names = [];
  try {
    names = fs.readdirSync(COVERS_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    if (!COVER_NAME.test(name)) continue;
    const file = path.join(COVERS_DIR, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
    } catch {
      // Already gone, which is the state we wanted.
    }
  }
}

// ----------------------------------------------------------------------- auth

// Login throttling: scrypt makes each guess cost work, and the window stops a
// password from being ground down over the LAN.
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILURES = 8;
const LOGIN_BLOCK_MS = 60 * 1000;
const loginFailures = new Map(); // ip -> { count, first, blockedUntil }

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

function blockedFor(ip) {
  const entry = loginFailures.get(ip);
  if (!entry?.blockedUntil) return 0;
  return Math.max(0, entry.blockedUntil - Date.now());
}

function recordFailure(ip) {
  const now = Date.now();
  const entry = loginFailures.get(ip) ?? { count: 0, first: now, blockedUntil: 0 };
  if (now - entry.first > LOGIN_WINDOW_MS) {
    entry.count = 0;
    entry.first = now;
    entry.blockedUntil = 0;
  }
  entry.count += 1;
  if (entry.count >= LOGIN_MAX_FAILURES) entry.blockedUntil = now + LOGIN_BLOCK_MS;
  loginFailures.set(ip, entry);
  if (loginFailures.size > 1000) loginFailures.clear();
}

function cookieFor(req, name, value, maxAge) {
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
  ];
  // No Max-Age at all makes it a session cookie: the browser drops it on quit,
  // which is what signing in without "remember this device" should mean.
  if (maxAge !== null) parts.push(`Max-Age=${Math.floor(maxAge)}`);
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function sessionCookie(req, token, maxAge) {
  return cookieFor(req, "audiodl_session", token, maxAge);
}

function cookieToken(req) {
  const match = (req.headers.cookie || "").match(/(?:^|;\s*)audiodl_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

// Browsers cap any cookie at 400 days, so a "forever" sign-in would still end
// there. Sending the same cookie again with the session's remaining life on
// every visit keeps that date rolling forward; a 7-day choice keeps shrinking
// instead, because only the cookie is refreshed and never the deadline.
function refreshRememberedCookie(req, res) {
  const token = cookieToken(req);
  const entry = token ? sessions.get(sessionKey(token)) : null;
  if (!entry?.remembered) return;
  const seconds = Math.floor((entry.expires - Date.now()) / 1000);
  if (seconds > 0) res.setHeader("Set-Cookie", sessionCookie(req, token, seconds));
}

function sessionFor(req) {
  const token = cookieToken(req);
  if (!token) return null;
  const key = sessionKey(token);
  const entry = sessions.get(key);
  if (!entry) return null;
  if (entry.expires < Date.now()) {
    sessions.delete(key);
    return null;
  }
  // Turning guest access off also ends the guest sessions already out there.
  // Otherwise the switch only closed the door to new visitors while a browser
  // that arrived earlier kept queueing and streaming. The cookie is left to
  // expire on its own; the owner is never affected.
  if (entry.role === "guest" && !guestEnabled) return null;
  return { token: key, role: entry.role, expires: entry.expires };
}

// ------------------------------------------------------------------------ app

const app = express();
app.disable("x-powered-by");
// Behind a local TLS proxy the client address arrives in X-Forwarded-For;
// trusting only loopback peers keeps direct LAN clients from spoofing it.
app.set("trust proxy", "loopback");
app.use(express.json({ limit: "256kb" }));

app.get("/api/me", (req, res) => {
  const session = sessionFor(req);
  // Every load of the app passes through here, which is often enough to keep a
  // remembered device remembered.
  refreshRememberedCookie(req, res);
  res.json({
    authed: Boolean(session),
    role: session?.role ?? null,
    guestEnabled,
    setupNeeded,
    siteName: settings.siteName,
    // The release and its source, for the quiet line under the queue. Both are
    // public and say nothing about this instance.
    version: VERSION,
    repo: PROJECT_URL,
    // What the contact page may show; the owner's username stays private.
    contact: settings.contact,
    // Aggregate guest activity for the counter under the queue. Counts guest
    // streams only, never the owner's own downloads.
    stats: { guests: guestStats.guests.length, tracks: guestStats.tracks },
  });
});

// The clock the one-time codes run on, without any secret. The sign-in and
// setup screens show it next to the code field, so a device whose clock is
// out of step is visible rather than just "wrong code". TOTP steps are UTC,
// so no time zone is involved.
app.get("/api/time", (_req, res) => {
  res.json({ now: Date.now() });
});

// For uptime monitors and the image healthcheck. Public on purpose, and shaped
// so it can be scraped: enough to tell a busy instance from a broken one, and
// nothing about the library path, sessions or credentials.
app.get("/api/health", (_req, res) => {
  let freeBytes = null;
  let totalBytes = null;
  let libraryWritable = false;
  try {
    const stat = fs.statfsSync(settings.musicDir);
    freeBytes = Number(stat.bavail) * Number(stat.bsize);
    totalBytes = Number(stat.blocks) * Number(stat.bsize);
    fs.accessSync(settings.musicDir, fs.constants.W_OK);
    libraryWritable = true;
  } catch {
    // A missing or read-only library is reported, not thrown: the server still
    // answers so a monitor can say what is wrong.
  }
  res.json({
    ok: libraryWritable,
    version: VERSION,
    uptimeSeconds: Math.round(process.uptime()),
    setupNeeded,
    queue: {
      running: jobs.filter((job) => job.state === "running").length,
      queued: jobs.filter((job) => job.state === "queued").length,
      total: jobs.length,
    },
    library: { writable: libraryWritable, freeBytes, totalBytes },
  });
});

// First run: no password has been chosen yet. The page redirects here, the
// owner picks a name and a username along with the password, and the same
// settings.json that /api/settings writes holds all of it from then on.
app.get("/api/setup", (_req, res) => {
  res.json({
    needed: setupNeeded,
    siteName: settings.siteName,
    username: settings.username,
    guestEnabled,
  });
});

app.post("/api/setup", async (req, res) => {
  if (!setupNeeded || setupLock) {
    res.status(409).json({ error: "A password is already set." });
    return;
  }
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (password.length < 8) {
    res.status(400).json({ error: "Use at least 8 characters." });
    return;
  }
  if (password.length > 200) {
    res.status(400).json({ error: "Keep it under 200 characters." });
    return;
  }
  const username = cleanUsername(req.body?.username);
  if (typeof req.body?.username === "string" && req.body.username.trim() && !username) {
    res.status(400).json({ error: "Use 2–32 letters, digits, dots, dashes or underscores." });
    return;
  }
  const siteName = cleanSiteName(req.body?.siteName);
  const contact = cleanContact(req.body?.contact);

  setupLock = true;
  try {
    passwordHash = await hashPassword(password);
    settings.passwordHash = passwordHash;
    settings.username = username || DEFAULT_USERNAME;
    settings.siteName = siteName;
    settings.contact = contact;
    writeJson(SETTINGS_FILE, settings);
    setupNeeded = false;
  } catch (err) {
    setupLock = false;
    res.status(500).json({ error: `Could not save the password: ${err.message}` });
    return;
  }
  setupLock = false;

  // Chosen and signed in in one step: no second trip through the login form.
  // A fresh install is remembered for 30 days, like the login form's default.
  const ttl = rememberTtl(30);
  res.setHeader("Set-Cookie", createSession(req, { role: "owner", ttl, remember: ttl }));
  res.json({ ok: true, role: "owner" });
});

// A guest gets a real session, just without a password: it can queue its own
// downloads into its own staging folder and can never see or touch anything else.
app.post("/api/guest", (req, res) => {
  if (!guestEnabled) {
    res.status(403).json({ error: "Guest access is turned off." });
    return;
  }
  const cookie = req.headers.cookie || "";
  const found = cookie.match(/(?:^|;\s*)audiodl_guest_id=([a-f0-9]{24})/);
  const guestId = found ? found[1] : randomBytes(12).toString("hex");
  res.setHeader("Set-Cookie", [
    createSession(req, { role: "guest", ttl: SESSION_TTL, guestId }),
    // A year: preferences outlive the 12-hour session they were set in.
    cookieFor(req, "audiodl_guest_id", guestId, 365 * 24 * 3600),
  ]);
  res.json({ ok: true, role: "guest" });
});

// These are mounted before the auth middleware (next to /api/guest), so they
// read the session themselves instead of relying on req.auth.
app.get("/api/guest/settings", (req, res) => {
  const session = sessionFor(req);
  if (!session || session.role !== "guest") {
    res.status(403).json({ error: "Sign in as a guest to use guest settings." });
    return;
  }
  res.json({ settings: guestProfile(session.token), presets: GUEST_PRESETS });
});

app.put("/api/guest/settings", (req, res) => {
  const session = sessionFor(req);
  if (!session || session.role !== "guest") {
    res.status(403).json({ error: "Sign in as a guest to use guest settings." });
    return;
  }
  const entry = sessions.get(session.token);
  if (!entry) {
    res.status(401).json({ error: "Session expired." });
    return;
  }
  entry.profile = normalizeProfile(req.body || {}, guestProfile(session.token));
  saveGuestProfile(entry.guestId, entry.profile);
  res.json({ settings: entry.profile, presets: GUEST_PRESETS });
});

app.post("/api/login", async (req, res) => {
  const ip = clientIp(req);
  const wait = blockedFor(ip);
  if (wait > 0) {
    res.setHeader("Retry-After", String(Math.ceil(wait / 1000)));
    res.status(429).json({
      error: `Too many attempts. Try again in ${Math.max(1, Math.ceil(wait / 1000))} s.`,
    });
    return;
  }

  if (!passwordHash) {
    res.status(409).json({ error: "No password yet - open /setup to choose one." });
    return;
  }
  const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  // The username is not a secret, but checking it before hashing keeps the
  // constant-time comparison for the password itself unchanged.
  const userOk = username.toLowerCase() === settings.username.toLowerCase();
  const ok = userOk && password.length > 0 && (await verifyPassword(password, passwordHash));
  if (!ok) {
    recordFailure(ip);
    res.status(401).json({ error: "Wrong username or password." });
    return;
  }

  loginFailures.delete(ip);
  // "Remember this device" is chosen with the password, so the code step
  // carries it along in the challenge rather than asking twice.
  const remember = rememberTtl(req.body?.remember);

  // Password accepted, but the owner has an authenticator: hand out a
  // two-minute challenge instead of a session.
  if (settings.totpEnabled) {
    const challenge = randomBytes(24).toString("base64url");
    loginChallenges.set(challenge, { expires: Date.now() + 2 * 60 * 1000, remember });
    res.json({ ok: true, twoFactor: true, challenge });
    return;
  }

  res.setHeader(
    "Set-Cookie",
    createSession(req, { role: "owner", ttl: remember || SESSION_TTL, remember }),
  );
  res.json({ ok: true, role: "owner", remembered: remember > 0 });
});

// Second step: a one-time code for an accepted password. The challenge is
// single-use, short-lived, and rate-limited like a failed password.
app.post("/api/login/2fa", (req, res) => {
  const ip = clientIp(req);
  const wait = blockedFor(ip);
  if (wait > 0) {
    res.setHeader("Retry-After", String(Math.ceil(wait / 1000)));
    res.status(429).json({
      error: `Too many attempts. Try again in ${Math.max(1, Math.ceil(wait / 1000))} s.`,
    });
    return;
  }
  const challenge = typeof req.body?.challenge === "string" ? req.body.challenge : "";
  const entry = loginChallenges.get(challenge);
  if (!entry || entry.expires < Date.now() || !settings.totpEnabled) {
    loginChallenges.delete(challenge);
    res.status(401).json({ error: "That sign-in attempt expired - enter the password again." });
    return;
  }
  const check = verifyTotp(settings.totpSecret, req.body?.code);
  if (!check.ok) {
    recordFailure(ip);
    res.status(401).json({ error: totpError(check), skewSeconds: check.skewSeconds });
    return;
  }

  loginChallenges.delete(challenge);
  loginFailures.delete(ip);
  const remember = entry.remember || 0;
  res.setHeader(
    "Set-Cookie",
    createSession(req, { role: "owner", ttl: remember || SESSION_TTL, remember }),
  );
  res.json({ ok: true, role: "owner", remembered: remember > 0 });
});

app.post("/api/logout", (req, res) => {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/(?:^|;\s*)audiodl_session=([^;]+)/);
  if (match) {
    sessions.delete(sessionKey(decodeURIComponent(match[1])));
    // A remembered device must not come back after the server is restarted.
    saveSessions();
  }
  res.setHeader("Set-Cookie", sessionCookie(req, "", 0));
  res.json({ ok: true });
});

// A guest whose session was ended by the master switch is not the same as a
// browser that never signed in: the queue asks again on a download click and
// the ZIP path reads this message, so it has to say what happened.
function endedBySwitch(req) {
  if (guestEnabled) return false;
  const token = cookieToken(req);
  const entry = token ? sessions.get(sessionKey(token)) : null;
  return entry?.role === "guest";
}

const GUEST_OFF_MESSAGE =
  "Guest access has been turned off, so guest downloads are paused. Ask the owner to switch it back on in Settings.";

// Uploaded cover art is served without a session: the download script fetches
// it over loopback with no cookie, and the name carries 128 random bits, so it
// can be neither guessed nor listed.
app.get("/api/covers/:file", (req, res) => {
  const name = String(req.params.file || "");
  if (!COVER_NAME.test(name)) {
    res.status(404).end();
    return;
  }
  const file = path.join(COVERS_DIR, name);
  if (!fs.existsSync(file)) {
    res.status(404).end();
    return;
  }
  // The bytes behind a name never change, so the browser may cache it hard.
  res.set("Cache-Control", "public, max-age=31536000, immutable");
  res.sendFile(file);
});

app.use("/api", (req, res, next) => {
  const session = sessionFor(req);
  if (!session) {
    if (endedBySwitch(req)) {
      res.status(403).json({ error: GUEST_OFF_MESSAGE, guestAccessOff: true });
      return;
    }
    res.status(401).json({ error: "Not signed in." });
    return;
  }
  req.auth = session;
  next();
});

// ------------------------------------------------------------------ cookies
//
// yt-dlp can be handed a Netscape cookie jar, which is the only way past a
// source that insists on a signed-in session (age gates, members-only uploads,
// the "Sign in to confirm you're not a bot" check). The jar belongs to the
// owner: it is used for owner downloads only, and its contents are never sent
// to a browser - the settings page is told its shape, nothing more.
function isCookieComment(line) {
  // Netscape marks HttpOnly cookies with a leading "#HttpOnly_" that is part of
  // the cookie, not a comment.
  return line.startsWith("#") && !line.startsWith("#HttpOnly_");
}

function cookieDomain(line) {
  return line
    .replace(/^#HttpOnly_/, "")
    .split("\t")[0]
    .trim()
    .replace(/^\./, "");
}

function cookiesView() {
  try {
    const stat = fs.statSync(COOKIES_FILE);
    const text = fs.readFileSync(COOKIES_FILE, "utf8");
    const domains = new Set();
    for (const line of text.split("\n")) {
      if (!line.trim() || isCookieComment(line)) continue;
      const domain = cookieDomain(line);
      if (domain) domains.add(domain);
    }
    return { set: true, bytes: stat.size, updatedAt: stat.mtimeMs, domains: domains.size };
  } catch {
    return { set: false, bytes: 0, updatedAt: 0, domains: 0 };
  }
}

// Only a jar yt-dlp can actually read is accepted: a broken one would fail
// every download with an unrelated-looking error, and this paste box is the
// only place that can catch it.
function parseCookies(text) {
  const raw = String(text || "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!raw) return { error: "Paste the contents of a cookies.txt file." };
  if (raw.length > 512 * 1024) return { error: "That jar is too large (512 KB at most)." };
  const valid = raw
    .split("\n")
    .filter((line) => line.trim() && !isCookieComment(line))
    .filter((line) => {
      const fields = line.replace(/^#HttpOnly_/, "").split("\t");
      return fields.length >= 6 && fields[0].trim() && fields[5].trim();
    });
  if (!valid.length) {
    return {
      error:
        "That does not look like a cookies.txt file. Each line needs tab-separated fields - export it with a browser extension.",
    };
  }
  return { text: `${raw}\n`, rows: valid.length };
}

// A sign-in wall, recognised from the script's own message or yt-dlp's line, so
// the queue can offer the jar instead of a bare "failed".
const AUTH_FAILURE = /sign[- ]?in to confirm|log ?in required|use --cookies|asked for a sign-?in/i;

function wantsCookies(job) {
  return AUTH_FAILURE.test(`${job.error || ""}\n${(job.log || []).slice(-30).join("\n")}`);
}

app.get("/api/settings", (req, res) => {
  const guest = req.auth.role === "guest" ? guestProfile(req.auth.token) : null;
  res.json({
    // A guest has no library to name; their values come from their own profile.
    musicDir: guest ? "" : settings.musicDir,
    lufs: guest ? guest.lufs : settings.lufs,
    quality: guest ? guest.quality : settings.quality,
    format: guest ? guest.format : settings.format,
    binary: req.auth.role === "owner" ? BIN : "",
    canEdit: req.auth.role === "owner",
    // The instance name is public (header, manifest), the credentials are not.
    siteName: settings.siteName,
    contact: settings.contact,
    guestEnabled,
    username: req.auth.role === "owner" ? settings.username : "",
    maxJobs: settings.maxJobs,
    perHost: settings.perHost,
    guestQuota: settings.guestQuota,
    // A guest only sees their own counter; the owner sees the limit alone.
    guestQuotaUsed:
      req.auth.role === "guest" ? quotaUsed(sessions.get(req.auth.token)?.guestId) : 0,
    twoFactor: Boolean(settings.totpEnabled),
    // Owner-only: the newer release the background check saw, if any. There is
    // nothing for a guest to upgrade, so they never receive the field.
    update:
      req.auth.role === "owner"
        ? {
            current: VERSION,
            latest: releaseCheck.latest,
            url: releaseCheck.url || RELEASES_URL,
            notes: releaseCheck.notes,
            available: Boolean(releaseCheck.latest) && isNewer(releaseCheck.latest, VERSION),
            checkedAt: releaseCheck.at,
          }
        : undefined,
    // The look of /admin, which is stored here rather than in a cookie. It is
    // no secret: only colours, and the page that shows it is owner-only.
    adminLook: adminLook(),
    // Whether a jar is stored, and nothing about what is in it.
    cookies: req.auth.role === "owner" ? cookiesView() : undefined,
    ...webhookView(req.auth.role),
  });
});

// The one appearance choice that is not per browser. Set on the Settings page
// and saved with the rest of the instance settings, so a different device does
// not have to pick it again.
app.put("/api/admin/look", (req, res) => {
  if (req.auth.role !== "owner") {
    res.status(403).json({ error: "Only the owner can change the settings page look." });
    return;
  }
  const body = req.body && typeof req.body === "object" ? req.body : {};
  // A partial update: the dialog sends a new theme, the palette row sends flavor
  // and accent, the header switch sends effects. Only values from the lists are
  // taken - anything else is left as it was rather than reset - and
  // `flavor: null` is how "Default" comes back, so that key is kept as sent.
  const patch = {};
  if (THEMES.includes(body.theme)) patch.theme = body.theme;
  if (EFFECTS.includes(body.effects)) patch.effects = body.effects;
  if (body.flavor === null || FLAVORS.includes(body.flavor)) patch.flavor = body.flavor;
  if (ACCENTS.includes(body.accent)) patch.accent = body.accent;
  settings.adminLook = cleanAdminLook({ ...adminLook(), ...patch });
  writeJson(SETTINGS_FILE, settings);
  res.json({ ok: true, adminLook: adminLook() });
});

app.get("/api/2fa", (req, res) => {
  if (req.auth.role !== "owner") {
    res.status(403).json({ error: "Only the owner can change two-factor." });
    return;
  }
  res.json({ enabled: Boolean(settings.totpEnabled) });
});

// The secret exists only in memory until a code from the authenticator proves
// the app has it, so a half-finished setup can never lock the owner out.
app.post("/api/2fa/setup", (req, res) => {
  if (req.auth.role !== "owner") {
    res.status(403).json({ error: "Only the owner can set up two-factor." });
    return;
  }
  if (settings.totpEnabled) {
    res.status(409).json({ error: "Two-factor is already on. Turn it off first." });
    return;
  }
  // Reopening the dialog hands back the secret that is already waiting, so a
  // code from the QR that was scanned a minute ago still matches. Only after
  // ten minutes, or once two-factor is on, does a new one start.
  const pending = pendingTotp.get(req.auth.token);
  const secret =
    pending && pending.expires > Date.now() ? pending.secret : newTotpSecret();
  pendingTotp.set(req.auth.token, { secret, expires: Date.now() + 10 * 60 * 1000 });
  res.json({ secret, otpauth: otpauthUrl(secret, settings.username) });
});

app.post("/api/2fa/enable", (req, res) => {
  if (req.auth.role !== "owner") {
    res.status(403).json({ error: "Only the owner can set up two-factor." });
    return;
  }
  const pending = pendingTotp.get(req.auth.token);
  if (!pending || pending.expires < Date.now()) {
    pendingTotp.delete(req.auth.token);
    res.status(400).json({ error: "The setup expired - start again." });
    return;
  }
  const check = verifyTotp(pending.secret, req.body?.code);
  if (!check.ok) {
    res.status(400).json({ error: totpError(check), skewSeconds: check.skewSeconds });
    return;
  }
  settings.totpSecret = pending.secret;
  settings.totpEnabled = true;
  pendingTotp.delete(req.auth.token);
  writeJson(SETTINGS_FILE, settings);
  res.json({ ok: true, enabled: true });
});

app.post("/api/2fa/disable", (req, res) => {
  if (req.auth.role !== "owner") {
    res.status(403).json({ error: "Only the owner can turn two-factor off." });
    return;
  }
  if (!settings.totpEnabled) {
    res.json({ ok: true, enabled: false });
    return;
  }
  const check = verifyTotp(settings.totpSecret, req.body?.code);
  if (!check.ok) {
    res.status(400).json({ error: totpError(check), skewSeconds: check.skewSeconds });
    return;
  }
  settings.totpEnabled = false;
  settings.totpSecret = "";
  writeJson(SETTINGS_FILE, settings);
  res.json({ ok: true, enabled: false });
});

// What the browser may know about the webhook: that it exists, where it points
// and whether guest jobs are reported. The URL itself stays on the server.
function webhookView(role) {
  if (role !== "owner") return { webhookSet: false, webhookHost: "", webhookGuests: settings.webhookGuests };
  return {
    webhookSet: Boolean(settings.webhookUrl),
    webhookHost: settings.webhookUrl ? hostOf(settings.webhookUrl) : "",
    webhookGuests: settings.webhookGuests,
  };
}

app.put("/api/settings", async (req, res) => {
  if (req.auth.role !== "owner") {
    res.status(403).json({ error: "Guests cannot change settings." });
    return;
  }
  const body = req.body || {};
  if (typeof body.musicDir === "string" && body.musicDir.startsWith("/") && body.musicDir !== "/") {
    settings.musicDir = body.musicDir;
  }
  if (typeof body.siteName === "string") {
    settings.siteName = cleanSiteName(body.siteName);
  }
  if (typeof body.contact === "string") {
    settings.contact = cleanContact(body.contact);
  }
  if (typeof body.username === "string" && body.username.trim()) {
    const username = cleanUsername(body.username);
    if (!username) {
      res.status(400).json({ error: "Use 2–32 letters, digits, dots, dashes or underscores." });
      return;
    }
    settings.username = username;
  }
  if (typeof body.guestEnabled === "boolean") {
    const wasOn = guestEnabled;
    guestEnabled = body.guestEnabled;
    settings.guestEnabled = guestEnabled;
    // Off is not just a door for new visitors: what is already running stops too.
    if (wasOn && !guestEnabled) endGuestAccess();
  }
  if (body.guestQuota !== undefined) {
    settings.guestQuota = clampInt(body.guestQuota, 0, 100, settings.guestQuota);
  }
  // Order matters: the per-host cap is clamped against the job cap, so the
  // job cap has to be settled first.
  if (body.maxJobs !== undefined) {
    settings.maxJobs = clampInt(body.maxJobs, 1, 8, settings.maxJobs);
    settings.perHost = Math.min(settings.perHost, settings.maxJobs);
  }
  if (body.perHost !== undefined) {
    settings.perHost = clampInt(body.perHost, 1, settings.maxJobs, settings.perHost);
  }
  // null removes the webhook; a blank string leaves it alone, like the password.
  if (body.webhookUrl === null) {
    settings.webhookUrl = "";
  } else if (typeof body.webhookUrl === "string" && body.webhookUrl.trim()) {
    const url = webhookFrom(body.webhookUrl.trim());
    if (!url) {
      res.status(400).json({ error: "Use a full http:// or https:// webhook URL." });
      return;
    }
    settings.webhookUrl = url;
  }
  if (typeof body.webhookGuests === "boolean") settings.webhookGuests = body.webhookGuests;
  if (body.lufs !== undefined) settings.lufs = clampLufs(body.lufs);
  if (Number.isInteger(body.quality)) settings.quality = Math.min(5, Math.max(1, body.quality));
  if (body.format !== undefined) settings.format = clampFormat(body.format, settings.format);
  if (typeof body.password === "string" && body.password) {
    if (body.password.length < 8) {
      res.status(400).json({ error: "Use at least 8 characters." });
      return;
    }
    passwordHash = await hashPassword(body.password);
    settings.passwordHash = passwordHash;
    sessions.clear();
    saveSessions();
  }
  writeJson(SETTINGS_FILE, settings);
  res.json({
    ok: true,
    musicDir: settings.musicDir,
    lufs: settings.lufs,
    quality: settings.quality,
    format: settings.format,
    siteName: settings.siteName,
    contact: settings.contact,
    username: settings.username,
    guestEnabled,
    maxJobs: settings.maxJobs,
    perHost: settings.perHost,
    guestQuota: settings.guestQuota,
    guestQuotaUsed: 0,
    ...webhookView("owner"),
  });
});

// A one-off message so the owner can see the webhook work without waiting for
// a job to finish.
app.post("/api/webhook/test", async (req, res) => {
  if (req.auth.role !== "owner") {
    res.status(403).json({ error: "Only the owner can test the webhook." });
    return;
  }
  if (!settings.webhookUrl) {
    res.status(400).json({ error: "Add a webhook URL first." });
    return;
  }
  try {
    const host = await postWebhook(
      webhookPayload(webhookKind(settings.webhookUrl), {
        title: "Test notification",
        subtitle: "A finished job will look like this",
        state: "done",
        summary: "3 of 3 saved",
        format: `${settings.format.toUpperCase()} · q${settings.quality} · ${settings.lufs} LUFS`,
        error: "",
        url: "",
        thumb: "",
        finishedAt: Date.now(),
        site: settings.siteName,
        guest: false,
        saved: 3,
        failed: 0,
        skipped: 0,
      }),
    );
    res.json({ ok: true, host });
  } catch (err) {
    res.status(502).json({ error: `Could not reach the webhook: ${err.message}` });
  }
});

// What the owner's library looks like right now: three levels deep, which is
// ARTIST/ALBUM/file. A huge library stops counting rather than blocking the
// server on a recursive stat of the whole disk.
function libraryStats() {
  const root = settings.musicDir;
  const out = {
    path: root,
    artists: 0,
    albums: 0,
    tracks: 0,
    bytes: 0,
    writable: false,
    freeBytes: null,
    totalBytes: null,
    truncated: false,
  };
  try {
    fs.accessSync(root, fs.constants.W_OK);
    out.writable = true;
  } catch {
    /* missing or read-only: reported to the browser below */
  }
  try {
    const stat = fs.statfsSync(root);
    out.freeBytes = Number(stat.bavail) * Number(stat.bsize);
    out.totalBytes = Number(stat.blocks) * Number(stat.bsize);
  } catch {
    /* not every filesystem reports free space */
  }

  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    let found = false;
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 2 && out.tracks < 100000) {
          if (walk(full, depth + 1)) {
            if (depth === 0) out.artists += 1;
            else out.albums += 1;
            found = true;
          }
        }
        continue;
      }
      if (!AUDIO_EXT.has(path.extname(entry.name).toLowerCase())) continue;
      out.tracks += 1;
      found = true;
      try {
        out.bytes += fs.statSync(full).size;
      } catch {
        /* a file that vanished mid-walk still counts */
      }
    }
    if (out.tracks > 100000) out.truncated = true;
    return found;
  };
  walk(root, 0);
  return out;
}

// Track titles are compared after stripping the noise that makes two copies of
// the same song look different: "(Official Video)", "[HD]", "feat. …",
// punctuation and case. Only equality is accepted - a fuzzy match would flag
// live versions and covers as duplicates.
function normTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\((?:official|lyrics?|audio|video|visuali[sz]er|hd|hq|4k|explicit|remaster(?:ed)?)[^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\b(?:feat|ft)\.?\s+[^-–]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// The index is rebuilt lazily: the library walk is the expensive part, and a
// draft edit must not stat the whole folder every keystroke.
let duplicateIndex = { at: 0, items: [] };

function buildDuplicateIndex() {
  if (Date.now() - duplicateIndex.at < 30_000) return duplicateIndex.items;
  const items = [];
  const walk = (dir, depth, artist, album) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 2 && items.length < 50_000) {
          walk(
            full,
            depth + 1,
            depth === 0 ? entry.name : artist,
            depth === 1 ? entry.name : album,
          );
        }
        continue;
      }
      if (!AUDIO_EXT.has(path.extname(entry.name).toLowerCase())) continue;
      const title = path
        .basename(entry.name, path.extname(entry.name))
        .replace(/^\d{1,3}\s*[-.]\s*/, "");
      items.push({
        title,
        norm: normTitle(title),
        artist: normTitle(artist),
        artistRaw: artist || "",
        album: album || "",
        path: full,
        source: "library",
      });
      if (items.length >= 50_000) return;
    }
  };
  walk(settings.musicDir, 0, "", "");

  const seen = new Set();
  for (const entry of history.slice(0, 200)) {
    const norm = normTitle(entry.title);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    items.push({
      title: entry.title,
      norm,
      artist: normTitle(entry.artist),
      artistRaw: entry.artist || "",
      album: entry.album || "",
      path: "",
      source: "history",
    });
  }

  duplicateIndex = { at: Date.now(), items };
  return items;
}

function findDuplicates(tracks) {
  const index = buildDuplicateIndex();
  const found = [];
  for (const track of tracks || []) {
    // A path the script's import index already knows for this exact upload is
    // a stronger hint than a title match, and it survives a renamed folder.
    if (track.duplicate) {
      found.push({
        i: track.i,
        title: track.title,
        source: "library",
        path: track.duplicate,
        artist: track.artist || "",
        album: track.album || "",
      });
      continue;
    }
    const norm = normTitle(track.title);
    if (norm.length < 3) continue;
    const artist = normTitle(track.artist);
    const match = index.find(
      (item) => item.norm === norm && (!artist || !item.artist || item.artist === artist),
    );
    if (!match) continue;
    found.push({
      i: track.i,
      title: track.title,
      source: match.source,
      path: match.path,
      artist: match.artistRaw,
      album: match.album,
    });
  }
  return found;
}

app.get("/api/library", (req, res) => {
  if (req.auth.role !== "owner") {
    res.status(403).json({ error: "Only the owner can see the library." });
    return;
  }
  const last = jobs
    .filter((job) => job.owner === "owner" && job.finishedAt)
    .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0))[0];
  res.json({
    ...libraryStats(),
    lastJob: last
      ? { title: last.title, state: last.state, finishedAt: last.finishedAt, completed: last.completed }
      : null,
  });
});

// ------------------------------------------------------------ library health
// Structural checks only: they are cheap enough to answer in a request, and
// every finding names a file or folder the owner can act on. Tag-level checks
// (missing genre, folder name against tag) need ffprobe per file, which is far
// too slow for a page load, so they are not part of this pass.
const HEALTH_LIMIT = 200;
// "01 - Title", "1. Title", "12 Title": the shapes the script writes.
const NUMBERED_NAME = /^\d{1,3}\s*(?:-|\.)?\s+(?=\S)/;

function scanLibraryHealth() {
  const root = settings.musicDir;
  const emptyDirs = [];
  const loose = [];
  const nested = [];
  const mixed = [];
  const counts = { artists: 0, albums: 0, tracks: 0 };
  let emptyTotal = 0;
  let looseTotal = 0;
  let nestedTotal = 0;
  let mixedTotal = 0;

  const listDir = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  const isAudio = (name) => AUDIO_EXT.has(path.extname(name).toLowerCase());

  // A folder is empty when no audio lives anywhere below it.
  const hasAudioBelow = (dir, depth = 0) => {
    for (const entry of listDir(dir)) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 4 && hasAudioBelow(full, depth + 1)) return true;
      } else if (isAudio(entry.name)) return true;
    }
    return false;
  };

  // Every folder that holds no audio anywhere below it, parents included: the
  // cleanup sorts them deepest first, so removing a chain works in one pass.
  const markEmpty = (dir, depth) => {
    emptyTotal += 1;
    if (emptyDirs.length < HEALTH_LIMIT) emptyDirs.push(dir);
    if (depth >= 4) return;
    for (const entry of listDir(dir)) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (hasAudioBelow(full)) continue;
      markEmpty(full, depth + 1);
    }
  };

  for (const artist of listDir(root)) {
    if (artist.name.startsWith(".")) continue;
    const artistPath = path.join(root, artist.name);
    if (!artist.isDirectory()) {
      if (isAudio(artist.name)) {
        looseTotal += 1;
        if (loose.length < HEALTH_LIMIT) loose.push(artistPath);
      }
      continue;
    }
    if (!hasAudioBelow(artistPath)) {
      markEmpty(artistPath, 0);
      continue;
    }
    counts.artists += 1;
    for (const album of listDir(artistPath)) {
      if (album.name.startsWith(".")) continue;
      const albumPath = path.join(artistPath, album.name);
      if (!album.isDirectory()) {
        if (isAudio(album.name)) {
          looseTotal += 1;
          if (loose.length < HEALTH_LIMIT) loose.push(albumPath);
        }
        continue;
      }
      if (!hasAudioBelow(albumPath)) {
        markEmpty(albumPath, 1);
        continue;
      }
      counts.albums += 1;
      const names = [];
      for (const entry of listDir(albumPath)) {
        if (entry.name.startsWith(".")) continue;
        const full = path.join(albumPath, entry.name);
        if (entry.isDirectory()) {
          nestedTotal += 1;
          if (nested.length < HEALTH_LIMIT) nested.push(full);
          continue;
        }
        if (!isAudio(entry.name)) continue;
        counts.tracks += 1;
        if (names.length < 60) names.push(entry.name);
      }
      // Half an album numbered and half not: what a download queued with the
      // box ticked next to one queued without leaves behind.
      if (names.length > 1) {
        const numbered = names.filter((name) => NUMBERED_NAME.test(name)).length;
        if (numbered > 0 && numbered < names.length) {
          mixedTotal += 1;
          if (mixed.length < HEALTH_LIMIT) mixed.push({ dir: albumPath, files: names.slice(0, 12) });
        }
      }
    }
  }

  // A job remembers where it wrote; a file removed outside the app leaves the
  // job pointing at nothing.
  const orphans = [];
  let orphanTotal = 0;
  for (const job of jobs) {
    if (job.owner !== "owner") continue;
    for (const track of job.tracks || []) {
      if (track.state !== "done" || !track.path) continue;
      if (fs.existsSync(track.path)) continue;
      orphanTotal += 1;
      if (orphans.length < HEALTH_LIMIT) orphans.push({ title: track.title, path: track.path });
    }
  }

  return {
    at: Date.now(),
    path: root,
    counts,
    emptyDirs,
    emptyDirsTotal: emptyTotal,
    loose,
    looseTotal,
    nested,
    nestedTotal,
    mixed,
    mixedTotal,
    orphans,
    orphansTotal: orphanTotal,
  };
}

app.get("/api/library/health", (req, res) => {
  if (req.auth.role !== "owner") {
    res.status(403).json({ error: "Only the owner can inspect the library." });
    return;
  }
  res.json(scanLibraryHealth());
});

// Only folders that are still empty are removed: the check happens here, not
// in the browser, so a folder that filled up in between is left alone.
app.post("/api/library/health/prune", (req, res) => {
  if (req.auth.role !== "owner") {
    res.status(403).json({ error: "Only the owner can clean the library." });
    return;
  }
  const wanted = Array.isArray(req.body?.dirs) ? req.body.dirs.filter((dir) => typeof dir === "string") : [];
  const root = path.resolve(settings.musicDir);
  const removed = [];
  const failed = [];
  // Deepest first: an empty album inside an empty artist must go before its
  // parent, or the parent still holds a folder when its turn comes.
  const ordered = wanted
    .slice(0, 1000)
    .sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
  for (const dir of ordered) {
    const full = path.resolve(dir);
    if (!full.startsWith(root + path.sep)) {
      failed.push({ dir, reason: "outside the library" });
      continue;
    }
    try {
      if (fs.readdirSync(full).length > 0) {
        failed.push({ dir, reason: "not empty" });
        continue;
      }
      fs.rmdirSync(full);
      removed.push(full);
    } catch (err) {
      failed.push({ dir, reason: err.code || err.message });
    }
  }
  res.json({ removed, failed });
});

// ------------------------------------------- audio duplicates by fingerprint
// Titles lie; the audio does not. fpcalc (chromaprint) turns a file into a list
// of integers, and two copies of the same recording share almost all of them
// even when tags, bitrate and filename differ. The cache is keyed by path plus
// size and mtime, so a re-tagged file keeps its print and a re-download is
// measured again. Owner-only: guests may download the same track as often as
// they like, and nothing here ever touches their queue.
const FINGERPRINT_FILE = path.join(DATA_DIR, "fingerprints.json");
const FP_VALUES = 160;
const FP_MIN_VALUES = 20;
const FP_SIMILAR = 0.55;
const FP_SCAN_CAP = 5000;
const fingerprints = readJson(FINGERPRINT_FILE, {});
let fpScanning = false;

const fpKey = (stat) => `${stat.size}:${Math.round(stat.mtimeMs / 1000)}`;

function libraryAudioFiles(cap = FP_SCAN_CAP) {
  const files = [];
  const walk = (dir, depth) => {
    if (files.length >= cap) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= cap) return;
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 4) walk(full, depth + 1);
        continue;
      }
      if (AUDIO_EXT.has(path.extname(entry.name).toLowerCase())) files.push(full);
    }
  };
  walk(settings.musicDir, 0);
  return files;
}

function fingerprintGroups() {
  const items = [];
  for (const [file, entry] of Object.entries(fingerprints)) {
    if (!Array.isArray(entry?.fp) || entry.fp.length < FP_MIN_VALUES) continue;
    if (!fs.existsSync(file)) continue;
    items.push({ file, duration: Number(entry.duration) || 0, set: new Set(entry.fp) });
  }
  // Sorted by duration so the comparison can stop as soon as the next file is
  // too long to be the same recording: most pairs are never looked at.
  items.sort((a, b) => a.duration - b.duration);
  const parent = items.map((_, index) => index);
  const find = (index) => {
    let at = index;
    while (parent[at] !== at) {
      parent[at] = parent[parent[at]];
      at = parent[at];
    }
    return at;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i];
      const b = items[j];
      const span = Math.max(3, 0.03 * Math.max(a.duration, b.duration));
      if (b.duration - a.duration > span) break;
      let shared = 0;
      for (const value of a.set) if (b.set.has(value)) shared += 1;
      if (shared / (a.set.size + b.set.size - shared) >= FP_SIMILAR) union(i, j);
    }
  }
  const buckets = new Map();
  items.forEach((item, index) => {
    const root = find(index);
    if (!buckets.has(root)) buckets.set(root, []);
    buckets.get(root).push(item);
  });
  const groups = [];
  for (const members of buckets.values()) {
    if (members.length < 2) continue;
    const files = [];
    for (const member of members) {
      let stat;
      try {
        stat = fs.statSync(member.file);
      } catch {
        continue;
      }
      files.push({
        path: member.file,
        name: path.basename(member.file),
        bytes: stat.size,
        format: path.extname(member.file).slice(1).toLowerCase(),
        duration: Math.round(member.duration),
      });
    }
    if (files.length < 2) continue;
    files.sort((a, b) => b.bytes - a.bytes);
    groups.push({ files });
  }
  groups.sort((a, b) => (b.files[0]?.bytes || 0) - (a.files[0]?.bytes || 0));
  return groups;
}

app.get("/api/library/duplicates", (req, res) => {
  if (req.auth.role !== "owner") {
    res.status(403).json({ error: "Only the owner can check the library." });
    return;
  }
  res.json({
    at: Date.now(),
    fpcalc: Boolean(findTool("fpcalc")),
    measured: Object.keys(fingerprints).length,
    groups: fingerprintGroups(),
  });
});

// A scan reads every pending file, so it runs in slices: the browser calls this
// until `pending` is 0 and gets progress for free.
app.post("/api/library/duplicates/scan", async (req, res) => {
  if (req.auth.role !== "owner") {
    res.status(403).json({ error: "Only the owner can check the library." });
    return;
  }
  const fpcalc = findTool("fpcalc");
  if (!fpcalc) {
    res.status(503).json({
      error: "fpcalc is not installed here, so audio cannot be fingerprinted. Rebuild the image to add it.",
    });
    return;
  }
  if (fpScanning) {
    res.status(409).json({ error: "A scan is already running." });
    return;
  }
  const limit = Math.min(40, Math.max(1, Number(req.body?.limit) || 12));
  fpScanning = true;
  try {
    const files = libraryAudioFiles();
    const pending = [];
    for (const file of files) {
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (fingerprints[file]?.key === fpKey(stat)) continue;
      pending.push({ file, stat });
    }
    let scanned = 0;
    for (const { file, stat } of pending.slice(0, limit)) {
      // -raw is essential: without it fpcalc answers with one base64 string
      // instead of the list of integers the comparison works on.
      const { code, stdout } = await runCommand(fpcalc, ["-json", "-raw", "-length", "60", file], {
        timeout: 60_000,
      });
      if (code !== 0) {
        // Cached as empty so a file fpcalc cannot read is not retried on every
        // scan; a replaced file gets a new key and is measured again.
        fingerprints[file] = { key: fpKey(stat), duration: 0, fp: [] };
        scanned += 1;
        continue;
      }
      try {
        const data = JSON.parse(stdout);
        const fp = Array.isArray(data.fingerprint) ? data.fingerprint.slice(0, FP_VALUES) : [];
        fingerprints[file] = { key: fpKey(stat), duration: Number(data.duration) || 0, fp };
      } catch {
        fingerprints[file] = { key: fpKey(stat), duration: 0, fp: [] };
      }
      scanned += 1;
    }
    writeJson(FINGERPRINT_FILE, fingerprints);
    res.json({
      scanned,
      pending: Math.max(0, pending.length - scanned),
      total: files.length,
      groups: fingerprintGroups(),
    });
  } finally {
    fpScanning = false;
  }
});

// Deleting a file is the one irreversible action here: the path must resolve
// inside the library and still be an audio file, checked on the server.
app.post("/api/library/duplicates/remove", (req, res) => {
  if (req.auth.role !== "owner") {
    res.status(403).json({ error: "Only the owner can change the library." });
    return;
  }
  const wanted = Array.isArray(req.body?.paths) ? req.body.paths.filter((p) => typeof p === "string") : [];
  const root = path.resolve(settings.musicDir);
  const removed = [];
  const failed = [];
  for (const file of wanted.slice(0, 200)) {
    const full = path.resolve(file);
    if (!full.startsWith(root + path.sep)) {
      failed.push({ path: file, reason: "outside the library" });
      continue;
    }
    if (!AUDIO_EXT.has(path.extname(full).toLowerCase())) {
      failed.push({ path: file, reason: "not an audio file" });
      continue;
    }
    try {
      fs.unlinkSync(full);
      delete fingerprints[full];
      removed.push(full);
    } catch (err) {
      failed.push({ path: file, reason: err.code || err.message });
    }
  }
  if (removed.length) writeJson(FINGERPRINT_FILE, fingerprints);
  res.json({ removed, failed });
});

app.get("/api/history", (req, res) => {
  if (req.auth.role !== "owner") {
    res.status(403).json({ error: "Only the owner can see the history." });
    return;
  }
  res.json({ history: history.slice(0, 100) });
});

// -------------------------------------------------------------- diagnostics
// The versions a download would actually use, plus enough of the machine to
// tell a broken install from a broken link. Extractors age quickly, so the
// yt-dlp copy can be replaced from here without rebuilding the image.
let ytdlpUpdating = false;

async function toolReport() {
  const ytdlp = findTool("yt-dlp");
  const ffmpeg = findTool("ffmpeg");
  const ytdlpVersion = ytdlp
    ? (await runCommand(ytdlp, ["--version"], { timeout: 20_000 })).stdout.trim().split("\n")[0]
    : "";
  const ffmpegLine = ffmpeg
    ? (await runCommand(ffmpeg, ["-version"], { timeout: 20_000 })).stdout.split("\n")[0]
    : "";
  const scriptLine = (await runCommand(BIN, ["--version"], { timeout: 10_000 })).stdout.trim();
  return {
    ytdlp: {
      path: ytdlp,
      version: ytdlpVersion,
      private: Boolean(ytdlp) && ytdlp.startsWith(TOOL_DIR + path.sep),
      updatedAt: Number(toolState.ytdlpUpdatedAt) || 0,
      updating: ytdlpUpdating,
    },
    ffmpeg: {
      path: ffmpeg,
      version: ffmpegLine.replace(/^ffmpeg version\s*/i, "").split(" Copyright")[0],
    },
    script: { path: BIN, version: scriptLine.replace(/^\S+\s*/, "") },
    system: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      uptimeSeconds: Math.round(process.uptime()),
    },
    disk: (() => {
      try {
        const stat = fs.statfsSync(settings.musicDir);
        return {
          freeBytes: Number(stat.bavail) * Number(stat.bsize),
          totalBytes: Number(stat.blocks) * Number(stat.bsize),
        };
      } catch {
        return null;
      }
    })(),
  };
}

app.get("/api/diagnostics", async (req, res) => {
  if (req.auth.role !== "owner") {
    res.status(403).json({ error: "Only the owner can see the diagnostics." });
    return;
  }
  res.json(await toolReport());
});

// Downloads the current release into the data volume, proves it runs, and only
// then swaps it into place. The previous copy is kept until the new one has
// answered --version, so a broken download cannot take the app down with it.
app.post("/api/tools/ytdlp/update", async (req, res) => {
  if (req.auth.role !== "owner") {
    res.status(403).json({ error: "Only the owner can update yt-dlp." });
    return;
  }
  if (ytdlpUpdating) {
    res.status(409).json({ error: "An update is already running." });
    return;
  }

  ytdlpUpdating = true;
  const target = path.join(TOOL_DIR, "yt-dlp");
  const backup = `${target}.old`;
  const temp = path.join(TOOL_DIR, `.yt-dlp-${randomBytes(6).toString("hex")}`);
  try {
    const response = await fetch(YTDLP_RELEASE, {
      redirect: "follow",
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) throw new Error(`the release server answered ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 1_000_000) throw new Error("the downloaded file is too small to be yt-dlp");
    if (bytes.length > 80_000_000) throw new Error("the downloaded file is unexpectedly large");

    fs.writeFileSync(temp, bytes, { mode: 0o755 });
    const probe = await runCommand(temp, ["--version"], { timeout: 60_000 });
    const version = probe.stdout.trim().split("\n")[0];
    if (probe.code !== 0 || !/^\d{4}\.\d{2}\.\d{2}/.test(version)) {
      throw new Error(`the new copy did not run: ${(probe.stderr || "no answer").trim().slice(-160)}`);
    }

    if (fs.existsSync(target)) fs.renameSync(target, backup);
    try {
      fs.renameSync(temp, target);
      const check = await runCommand(target, ["--version"], { timeout: 60_000 });
      if (check.code !== 0) throw new Error("the new copy stopped working once installed");
    } catch (err) {
      try {
        if (fs.existsSync(backup)) {
          fs.rmSync(target, { force: true });
          fs.renameSync(backup, target);
        }
      } catch {
        /* the old copy stays as .old rather than being lost */
      }
      throw err;
    }
    fs.rmSync(backup, { force: true });

    toolState.ytdlpUpdatedAt = Date.now();
    toolState.ytdlpVersion = version;
    writeJson(TOOL_STATE_FILE, toolState);
    res.json({ ok: true, version, updatedAt: toolState.ytdlpUpdatedAt });
  } catch (err) {
    res.status(502).json({ error: `Could not update yt-dlp: ${err.message}` });
  } finally {
    ytdlpUpdating = false;
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* already renamed or never written */
    }
  }
});

// Settings backup: everything except the two secrets (password hash and
// webhook URL), so the file is safe to keep next to a copy of the library.
app.get("/api/settings/export", (req, res) => {
  if (req.auth.role !== "owner") {
    res.status(403).json({ error: "Only the owner can export settings." });
    return;
  }
  res.setHeader("Content-Disposition", 'attachment; filename="crate-settings.json"');
  res.json({
    v: 1,
    exportedAt: new Date().toISOString(),
    settings: {
      siteName: settings.siteName,
      contact: settings.contact,
      musicDir: settings.musicDir,
      lufs: settings.lufs,
      quality: settings.quality,
      format: settings.format,
      maxJobs: settings.maxJobs,
      perHost: settings.perHost,
      guestEnabled,
      guestQuota: settings.guestQuota,
      webhookGuests: settings.webhookGuests,
    },
  });
});

// Owner-only: zero the public guest counter. The opaque per-browser ids the
// quota uses are a different file, so a reset never lifts anyone's daily limit -
// it only starts the bragging rights over.
app.post("/api/stats/reset", (req, res) => {
  if (req.auth.role !== "owner") {
    res.status(403).json({ error: "Only the owner can reset the guest counter." });
    return;
  }
  guestStats.tracks = 0;
  guestStats.guests = [];
  writeJson(STATS_FILE, guestStats);
  broadcastStats();
  res.json({ ok: true, stats: { guests: 0, tracks: 0 } });
});

app.post("/api/settings/import", (req, res) => {
  if (req.auth.role !== "owner") {
    res.status(403).json({ error: "Only the owner can import settings." });
    return;
  }
  const incoming = req.body && typeof req.body === "object" ? req.body.settings || req.body : null;
  if (!incoming || typeof incoming !== "object") {
    res.status(400).json({ error: "That file does not look like a settings export." });
    return;
  }
  // Only the non-secret keys an export carries; anything else is ignored, so a
  // hand-edited file cannot set a password hash or a webhook URL.
  if (typeof incoming.siteName === "string") settings.siteName = cleanSiteName(incoming.siteName);
  if (typeof incoming.contact === "string") settings.contact = cleanContact(incoming.contact);
  if (typeof incoming.musicDir === "string" && incoming.musicDir.startsWith("/") && incoming.musicDir !== "/") {
    settings.musicDir = incoming.musicDir;
  }
  if (incoming.lufs !== undefined) settings.lufs = clampLufs(incoming.lufs);
  if (Number.isInteger(incoming.quality)) settings.quality = Math.min(5, Math.max(1, incoming.quality));
  if (incoming.format !== undefined) settings.format = clampFormat(incoming.format, settings.format);
  if (incoming.maxJobs !== undefined) settings.maxJobs = clampInt(incoming.maxJobs, 1, 8, settings.maxJobs);
  if (incoming.perHost !== undefined) {
    settings.perHost = clampInt(incoming.perHost, 1, settings.maxJobs, settings.perHost);
  } else {
    settings.perHost = Math.min(settings.perHost, settings.maxJobs);
  }
  if (typeof incoming.guestEnabled === "boolean") {
    const wasOn = guestEnabled;
    guestEnabled = incoming.guestEnabled;
    settings.guestEnabled = guestEnabled;
    if (wasOn && !guestEnabled) endGuestAccess();
  }
  if (incoming.guestQuota !== undefined) {
    settings.guestQuota = clampInt(incoming.guestQuota, 0, 100, settings.guestQuota);
  }
  if (typeof incoming.webhookGuests === "boolean") settings.webhookGuests = incoming.webhookGuests;
  writeJson(SETTINGS_FILE, settings);
  res.json({
    ok: true,
    siteName: settings.siteName,
    contact: settings.contact,
    musicDir: settings.musicDir,
    lufs: settings.lufs,
    quality: settings.quality,
    format: settings.format,
    maxJobs: settings.maxJobs,
    perHost: settings.perHost,
    guestEnabled,
    guestQuota: settings.guestQuota,
  });
});

app.put("/api/cookies", (req, res) => {
  if (req.auth.role !== "owner") {
    res.status(403).json({ error: "Only the owner can add cookies." });
    return;
  }
  const parsed = parseCookies(req.body?.text);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(COOKIES_FILE, parsed.text, { mode: 0o600 });
    // A jar that was put there by hand may be world-readable.
    fs.chmodSync(COOKIES_FILE, 0o600);
  } catch (err) {
    res.status(500).json({ error: `Could not save the cookies: ${err.message}` });
    return;
  }
  res.json({ ok: true, rows: parsed.rows, cookies: cookiesView() });
});

app.delete("/api/cookies", (req, res) => {
  if (req.auth.role !== "owner") {
    res.status(403).json({ error: "Only the owner can remove the cookies." });
    return;
  }
  fs.rmSync(COOKIES_FILE, { force: true });
  res.json({ ok: true, cookies: cookiesView() });
});

app.get("/api/artists", (req, res) => {
  if (req.auth.role === "guest") {
    res.json({ artists: [] });
    return;
  }
  let artists = [];
  try {
    artists = fs
      .readdirSync(settings.musicDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 500);
  } catch {
    artists = [];
  }
  res.json({ artists });
});

// A cover image handed over by the browser. It is stored under an opaque name
// and served back from /api/covers, so the review card can preview it and the
// script can fetch it later; nothing about it is trusted to be a URL.
app.post("/api/covers", express.raw({ type: () => true, limit: COVER_MAX_BYTES }), (req, res) => {
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!body.length) {
    res.status(400).json({ error: "No image in that upload." });
    return;
  }
  const extension = coverExtension(body);
  if (!extension) {
    res.status(415).json({ error: "Use a JPEG, PNG, WebP or GIF image." });
    return;
  }
  const name = `${randomBytes(16).toString("hex")}.${extension}`;
  try {
    pruneCovers();
    fs.writeFileSync(path.join(COVERS_DIR, name), body);
  } catch (err) {
    res.status(500).json({ error: `Could not save that image: ${err.message}` });
    return;
  }
  res.status(201).json({ url: `/api/covers/${name}` });
});

app.post("/api/inspect", async (req, res) => {
  const url = validateUrl(req.body?.url);
  if (!url) {
    res.status(400).json({ error: "That does not look like a link." });
    return;
  }
  if (req.auth.role === "guest" && !(await isPublicTarget(url))) {
    res.status(403).json({ error: "Guests can only reach the public internet - local and private addresses are blocked." });
    return;
  }
  const outDir = req.auth.role === "guest" ? GUEST_PREVIEW_DIR : settings.musicDir;
  const guest = req.auth.role === "guest" ? guestProfile(req.auth.token) : null;
  const format = formatFor(req.auth.role, req.body?.format, guest?.format ?? settings.format);
  const args = ["--inspect", "-o", outDir, "--output-format", format];
  if (guest) {
    args.push("--lufs", String(guest.lufs));
    if (!guest.art) args.push("--no-art");
  } else if (fs.existsSync(COOKIES_FILE)) {
    // The jar makes a members-only or age-gated link reviewable, not just
    // downloadable. Guests never get it.
    args.push("--cookies", COOKIES_FILE);
  }
  args.push("--", url);
  const { code, stdout, stderr } = await runScript(args, { timeout: 300_000 });
  const data = parseJsonOutput(stdout);
  if (!data) {
    res.status(502).json({ error: firstErrorLine(stderr) });
    return;
  }
  if (data.event === "error") {
    res.status(502).json({
      error: data.message || "Could not read that link.",
      // Only the owner can do anything about it, so only the owner is told.
      needsCookies: req.auth.role === "owner" && AUTH_FAILURE.test(data.message || ""),
    });
    return;
  }
  // Only the owner's library is worth checking against; guests never see paths.
  if (req.auth.role === "owner") {
    const duplicates = findDuplicates(data.tracks);
    if (duplicates.length) data.duplicates = duplicates;
  }
  if (data?.defaults) {
    // Starting value for the genre field: the entry of the first credited
    // artist in the shipped map, which the user can overwrite before queueing.
    data.defaults.genre = genreForArtist(data.defaults.artist || data.tracks?.[0]?.artist || "");
  }
  data.genres = GENRE_NAMES;
  res.json(data);
});

app.post("/api/plan", async (req, res) => {
  const url = validateUrl(req.body?.url);
  if (!url) {
    res.status(400).json({ error: "That does not look like a link." });
    return;
  }
  if (req.auth.role === "guest" && !(await isPublicTarget(url))) {
    res.status(403).json({ error: "Guests can only reach the public internet - local and private addresses are blocked." });
    return;
  }
  const { selection = [], rows = [], artist = "", album = "", kind = "track", trackPrefix } = req.body || {};
  const outDir = req.auth.role === "guest" ? GUEST_PREVIEW_DIR : settings.musicDir;
  const guest = req.auth.role === "guest" ? guestProfile(req.auth.token) : null;
  const args = [
    "--plan",
    "-o",
    outDir,
    "--lufs",
    String(clampLufs(req.body?.lufs ?? guest?.lufs)),
    "--output-format",
    formatFor(req.auth.role, req.body?.format, guest?.format ?? settings.format),
  ];
  if (guest && !guest.art) args.push("--no-art");
  if (!guest && fs.existsSync(COOKIES_FILE)) args.push("--cookies", COOKIES_FILE);
  if (artist) args.push("--artist", String(artist));
  if (album) args.push("--album", String(album));
  if (kind === "playlist" && selection.length) args.push("--tracks", selection.join(","));
  args.push(trackPrefix ? "--track-prefix" : "--no-track-prefix");
  let metaPath = null;
  if (rows.length) {
    const rowsByIdx = {};
    for (const row of rows) {
      const entry = {};
      if (row.title) entry.title = String(row.title);
      if (Number.isInteger(row.track) && row.track > 0) entry.track = row.track;
      if (row.date) entry.date = String(row.date);
      if (row.art) entry.art = artForScript(row.art);
      if (Object.keys(entry).length) rowsByIdx[String(row.i)] = entry;
    }
    if (Object.keys(rowsByIdx).length) {
      metaPath = metaFile(`plan-${process.pid}-${Date.now()}`, rowsByIdx);
      args.push("--meta-json", metaPath);
    }
  }
  args.push("--", url);
  const { stdout, stderr } = await runScript(args, { timeout: 300_000 });
  if (metaPath) fs.rm(metaPath, { force: true }, () => {});
  const data = parseJsonOutput(stdout);
  if (!data || data.event === "error") {
    const message = data?.message || firstErrorLine(stderr);
    res.status(502).json({
      error: message,
      needsCookies: req.auth.role === "owner" && AUTH_FAILURE.test(message || ""),
    });
    return;
  }
  if (req.auth.role === "owner") {
    const duplicates = findDuplicates(data.tracks);
    if (duplicates.length) data.duplicates = duplicates;
  } else {
    // The plan knows where an earlier download of this upload went. That is a
    // path in the owner's library, so a guest is never told about it.
    for (const track of data.tracks || []) delete track.duplicate;
  }
  if (data?.defaults) {
    // Starting value for the genre field: the entry of the first credited
    // artist in the shipped map, which the user can overwrite before queueing.
    data.defaults.genre = genreForArtist(data.defaults.artist || data.tracks?.[0]?.artist || "");
  }
  data.genres = GENRE_NAMES;
  res.json(data);
});

// Guests only ever see their own jobs; the owner sees the whole house.
function visibleJobs(req) {
  if (req.auth.role === "owner") return jobs;
  return jobs.filter((job) => job.owner === req.auth.token);
}

function canTouch(req, job) {
  return req.auth.role === "owner" || job.owner === req.auth.token;
}

// ------------------------------------------------------------------ live feed
//
// The queue is streamed instead of polled: one connection per open tab, a
// snapshot on connect, then a job object whenever something about it changes.
// Progress ticks are coalesced so a running encode does not flood the socket.

function streamSees(client, job) {
  return client.role === "owner" || job.owner === client.token;
}

function writeEvent(client, event, data) {
  try {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    streamClients.delete(client);
  }
}

// The public tally lives on /api/me, but it changes while pages are open: push
// it down the same queue stream so the footer under the queue and the overview
// card move without a reload. Available to everyone; the numbers are public.
function broadcastStats() {
  if (streamClients.size === 0) return;
  const stats = { guests: guestStats.guests.length, tracks: guestStats.tracks };
  for (const client of streamClients) writeEvent(client, "stats", stats);
}

function sendJob(job) {
  for (const client of streamClients) {
    if (streamSees(client, job)) writeEvent(client, "job", { job: publicJob(job) });
  }
}

function notifyJob(job, { immediate = false } = {}) {
  if (!job || streamClients.size === 0) return;
  if (immediate) {
    const timer = pendingPush.get(job.id);
    if (timer) clearTimeout(timer);
    pendingPush.delete(job.id);
    sendJob(job);
    return;
  }
  if (pendingPush.has(job.id)) return;
  pendingPush.set(
    job.id,
    setTimeout(() => {
      pendingPush.delete(job.id);
      sendJob(job);
    }, 250),
  );
}

function notifyRemoved(job) {
  for (const client of streamClients) {
    if (streamSees(client, job)) writeEvent(client, "remove", { id: job.id });
  }
}

app.get("/api/jobs", (req, res) => {
  res.json({ jobs: visibleJobs(req).map(publicJob) });
});

app.get("/api/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");

  const client = { res, role: req.auth.role, token: req.auth.token };
  streamClients.add(client);

  // An idle connection through a proxy gets dropped without traffic, so ping.
  const beat = setInterval(() => res.write(": ping\n\n"), 20_000);
  const drop = () => {
    clearInterval(beat);
    streamClients.delete(client);
  };
  req.on("close", drop);
  req.on("aborted", drop);

  writeEvent(client, "jobs", { jobs: visibleJobs(req).map(publicJob) });
});

// Guest access was switched off: close their live queue connections and stop
// anything still encoding, instead of only refusing new arrivals. Their next
// request lands on the sign-in form, and the list in front of them stops
// pretending a download is on its way. The owner is untouched.
// Signal the whole group a stream was spawned in, falling back to the child
// alone if it was not detached. Escalates once, eight seconds later.
function stopChildTree(child) {
  if (!child) return;
  const signal = (name) => {
    try {
      process.kill(-child.pid, name);
    } catch {
      try {
        child.kill(name);
      } catch {
        /* already gone */
      }
    }
  };
  signal("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signal("SIGKILL");
  }, 8000);
}

function endGuestAccess() {
  for (const client of [...streamClients]) {
    if (client.role !== "guest") continue;
    streamClients.delete(client);
    try {
      client.res.end();
    } catch {
      /* already gone */
    }
  }
  for (const job of jobs) {
    if (!job.stream || !job.streamChild) continue;
    stoppedBySwitch.add(job.id);
    job.state = "cancelling";
    stopChildTree(job.streamChild);
    notifyJob(job, { immediate: true });
  }
}

function isInside(file, dir) {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// The owner's files are already on this machine; this only allows pulling a
// copy through the browser from another device. Guests stream instead.
app.get("/api/jobs/:id/file/:i", (req, res) => {
  const job = findJob(req.params.id);
  if (!job || !canTouch(req, job)) {
    res.status(404).json({ error: "No such job." });
    return;
  }
  if (req.auth.role !== "owner") {
    res.status(403).json({ error: "Guests download through the stream endpoint." });
    return;
  }
  const track = job.tracks.find((t) => t.i === Number(req.params.i));
  if (!track?.path || !fs.existsSync(track.path) || !isInside(track.path, settings.musicDir)) {
    res.status(404).json({ error: "That file is not ready." });
    return;
  }
  res.download(track.path, path.basename(track.path));
});

// ------------------------------------------------------------------ streaming

// One guest download at a time: the encode runs for the length of the
// transfer, so two would pin two encoders and share the same uplink.
const STREAM_MAX_PER_SESSION = 1;
const activeStreams = new Map();
// Jobs whose encoder was stopped by the switch, so settle() can say why instead
// of reusing the cancellation message.
const stoppedBySwitch = new Set();

const STREAM_MIME = {
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  flac: "audio/flac",
  wav: "audio/wav",
};

function safeFilename(text) {
  return (
    String(text || "track")
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "track"
  );
}

// GET rather than POST so the browser's own download manager can drive it:
// the response is a chunked audio file with no Content-Length, produced by the
// script's --stream-fd mode. Nothing is written to the library or to staging.
app.get("/api/jobs/:id/stream/:i", (req, res) => {
  const job = findJob(req.params.id);
  if (!job || !canTouch(req, job)) {
    res.status(404).json({ error: "No such job." });
    return;
  }
  if (!job.stream) {
    res.status(409).json({ error: "That job was saved to the library, not streamed." });
    return;
  }
  const index = Number(req.params.i);
  const track = job.tracks.find((t) => t.i === index);
  if (!track) {
    res.status(404).json({ error: "No such track." });
    return;
  }
  if (job.state === "cancelled") {
    res.status(409).json({ error: "That job was cancelled." });
    return;
  }

  const token = req.auth.token;
  const running = activeStreams.get(token) || 0;
  if (running >= STREAM_MAX_PER_SESSION) {
    res.status(429).json({ error: "One download at a time - wait for the current one to finish." });
    return;
  }

  const workDir = path.join(DATA_DIR, "streams", `${job.id}-${track.i}`);
  fs.rmSync(workDir, { recursive: true, force: true });

  const format = job.format || "m4a";
  const args = [
    "--json",
    "--no-lock",
    "--stream-fd",
    "3",
    "--output-format",
    format,
    "--lufs",
    String(job.lufs),
    "--session-dir",
    workDir,
    "--one-pass",
    job.trackPrefix ? "--track-prefix" : "--no-track-prefix",
  ];
  if (!job.art) args.push("--no-art");
  if (job.artist) args.push("--artist", job.artist);
  if (job.album) args.push("--album", job.album);
  if (job.genre) args.push("--genre", job.genre);
  if (job.metaPath) args.push("--meta-json", job.metaPath);
  if (job.kind === "playlist") args.push("--tracks", String(track.i));
  args.push("--", job.url);

  const env = {
    ...toolEnv(),
    AAC_QUALITY: String(job.quality),
    OUTPUT_FORMAT: format,
    // Keep the import index out of the way, exactly like the staged path.
    XDG_STATE_HOME: path.join(DATA_DIR, "guest-state"),
  };

  let child;
  try {
    // Its own process group: the script starts its own children (`sleep`,
    // yt-dlp, ffmpeg), and stopping only the shell would leave those encoding
    // into a pipe nobody reads.
    child = spawn(BIN, args, { env, stdio: ["ignore", "pipe", "pipe", "pipe"], detached: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
    return;
  }

  const audio = child.stdio[3];
  job.streamChild = child;
  let started = false;
  let closed = false;
  let bytes = 0;

  activeStreams.set(token, running + 1);
  track.state = "running";
  track.stage = "download";
  track.pct = 0;
  track.error = undefined;
  job.state = "running";
  job.startedAt = job.startedAt || Date.now();
  job.error = undefined;
  notifyJob(job, { immediate: true });

  const settle = (ok, message) => {
    if (closed) return;
    closed = true;
    delete job.streamChild;
    activeStreams.set(token, Math.max(0, (activeStreams.get(token) || 1) - 1));
    track.state = ok ? "done" : "failed";
    track.stage = null;
    track.path = undefined;
    track.size = ok ? bytes : 0;
    if (!ok) track.error = message || "The download failed.";
    const done = job.tracks.filter((t) => t.state === "done").length;
    job.completed = done;
    if (job.state === "cancelling") {
      job.state = "cancelled";
      job.error = stoppedBySwitch.delete(job.id)
        ? "Guest access was turned off while this was streaming."
        : "Cancelled.";
    } else {
      job.state = ok ? (done >= job.total ? "done" : "queued") : "failed";
      if (!ok) job.error = message || "The download failed.";
    }
    if (job.state === "done") job.finishedAt = Date.now();
    if (job.state === "done" || job.state === "failed") recordHistory(job);
    persistJobs();
    notifyJob(job, { immediate: true });
    fs.rm(workDir, { recursive: true, force: true }, () => {});
  };

  audio.on("data", (chunk) => {
    bytes += chunk.length;
    // Shown in the queue as it flows; notifyJob coalesces to ~4 updates/s.
    track.size = bytes;
    notifyJob(job);
  });

  // Headers only once there is audio: a failure before the first byte must
  // still be a JSON error, not a 200 with an empty body.
  audio.once("data", (chunk) => {
    if (closed) return;
    started = true;
    // The name the browser saves must match the naming the job was queued
    // with, so a job without track numbers never gets a prefixed file.
    const prefix =
      job.trackPrefix && job.kind === "playlist" ? `${String(track.i).padStart(2, "0")} - ` : "";
    res.setHeader("Content-Type", STREAM_MIME[format] || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFilename(prefix + track.title)}.${format}"`);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Accel-Buffering", "no");
    res.write(chunk);
    audio.pipe(res);
  });

  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const text = line.trim();
      if (!text.startsWith("{")) continue;
      let evt;
      try {
        evt = JSON.parse(text);
      } catch {
        continue;
      }
      if (evt.event === "stage" && evt.stage) {
        track.stage = evt.stage;
        track.pct = Number(evt.pct) || 0;
      } else if (evt.event === "error" && evt.message) {
        track.error = String(evt.message);
      }
    }
  });

  let logged = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    logged += chunk;
    const lines = logged.split("\n");
    logged = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
      if (!line) continue;
      job.log.push(line);
      if (job.log.length > 400) job.log.shift();
    }
  });

  child.on("error", (err) => {
    if (!started && !res.headersSent) res.status(500).json({ error: err.message });
    settle(false, err.message);
  });

  child.on("close", (code) => {
    if (code === 0 && started) {
      settle(true);
      return;
    }
    const reason =
      code === 0
        ? "The downloader produced no audio."
        : lastError(job) || `The downloader exited with code ${code}.`;
    if (!started && !res.headersSent) res.status(502).json({ error: reason });
    else res.end();
    settle(false, reason);
  });

  res.on("close", () => {
    // A finished pipe closes the response too; only an early close is an abort.
    if (closed || res.writableFinished || child.exitCode !== null) return;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 2000).unref();
    settle(false, "The download was interrupted.");
  });
});

app.post("/api/jobs", async (req, res) => {
  const body = req.body || {};
  const url = validateUrl(body.url);
  if (!url) {
    res.status(400).json({ error: "That does not look like a link." });
    return;
  }

  if (req.auth.role === "guest") {
    if (!(await isPublicTarget(url))) {
      res.status(403).json({ error: "Guests can only reach the public internet - local and private addresses are blocked." });
      return;
    }
    // Nothing runs until the guest presses save, so only their list length is
    // bounded here; concurrent transfers are limited per session separately.
    const unfinished = jobs.filter(
      (job) => job.owner === req.auth.token && ["queued", "running"].includes(job.state),
    );
    if (unfinished.length >= 20) {
      res.status(429).json({ error: "Too many downloads in your list - save or remove a few first." });
      return;
    }
    // The quota counts jobs, playlist or single, queued when they are created
    // so nobody can sit on twenty and download them all.
    const guestId = sessions.get(req.auth.token)?.guestId;
    if (settings.guestQuota > 0 && quotaUsed(guestId) >= settings.guestQuota) {
      res.status(429).json({
        error: `Guest limit reached - ${settings.guestQuota} download${settings.guestQuota === 1 ? "" : "s"} a day. Try again tomorrow.`,
      });
      return;
    }
  }

  const kind = body.kind === "playlist" ? "playlist" : "track";
  const selection = Array.isArray(body.selection) ? body.selection.filter((n) => Number.isInteger(n) && n > 0) : [];
  if (kind === "playlist" && selection.length === 0) {
    res.status(400).json({ error: "Pick at least one track." });
    return;
  }
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const id = randomBytes(6).toString("hex");
  let metaPath = null;
  if (rows.length) {
    const rowsByIdx = {};
    for (const row of rows) {
      const entry = {};
      if (row.title) entry.title = String(row.title);
      if (Number.isInteger(row.track) && row.track > 0) entry.track = row.track;
      if (row.date) entry.date = String(row.date);
      if (row.art) entry.art = artForScript(row.art);
      if (Object.keys(entry).length) rowsByIdx[String(row.i)] = entry;
    }
    if (Object.keys(rowsByIdx).length) metaPath = metaFile(id, rowsByIdx);
  }

  const tracks = (kind === "playlist" ? selection : [1]).map((i) => {
    const info = rows.find((r) => r.i === i) || {};
    return {
      i,
      title: info.title || info.sourceTitle || `Track ${i}`,
      duration: Number(info.duration) || 0,
      state: "queued",
      pct: 0,
      stage: null,
    };
  });

  const guest = req.auth.role === "guest" ? guestProfile(req.auth.token) : null;
  // Stored on the job so the public counter still knows who it was after the
  // session that created it has expired.
  const guestId = req.auth.role === "guest" ? sessions.get(req.auth.token)?.guestId : undefined;
  // Shown beside the job in the queue. Only a plain remote image URL is kept;
  // the browser loads it from the source, never through this server.
  const thumbRequest = typeof body.thumb === "string" ? body.thumb.trim() : "";
  const thumb = /^https?:\/\//i.test(thumbRequest)
    ? thumbRequest.slice(0, 500)
    : COVER_PATH.test(thumbRequest)
      ? thumbRequest
      : "";
  const job = {
    id,
    url,
    kind,
    thumb,
    title: String(body.title || (kind === "playlist" ? "Playlist" : "Single track")),
    artist: String(body.artist || ""),
    album: String(body.album || ""),
    genre: cleanGenre(body.genre),
    lufs: clampLufs(body.lufs ?? guest?.lufs),
    quality: Number.isInteger(body.quality) ? Math.min(5, Math.max(1, body.quality)) : (guest?.quality ?? settings.quality),
    format: formatFor(req.auth.role, body.format, guest?.format ?? settings.format),
    onePass: Boolean(body.onePass),
    art: body.art === undefined ? (guest ? guest.art : true) : Boolean(body.art),
    // Guest jobs are never rendered onto the server: each track is encoded
    // straight to the browser when the guest asks for it.
    stream: Boolean(guest),
    trackPrefix: Boolean(body.trackPrefix),
    policy: body.policy === "overwrite" ? "overwrite" : "skip",
    selection,
    metaPath,
    total: tracks.length,
    completed: 0,
    conflicts: Number(body.conflicts) || 0,
    // Guests are confined to their own staging folder and their own queue.
    owner: req.auth.role === "guest" ? req.auth.token : "owner",
    guestId,
    // Cached so the scheduler can bound per-site parallelism without parsing
    // the URL again while holding the queue.
    host: hostOf(url),
    dir: guest ? undefined : settings.musicDir,
    state: "queued",
    createdAt: Date.now(),
    tracks,
    log: [],
  };
  jobs.unshift(job);
  if (req.auth.role === "guest") useQuota(sessions.get(req.auth.token)?.guestId);
  // Stream jobs wait for a download click, so they never enter the queue.
  if (!job.stream) queue.push(job.id);
  persistJobs();
  notifyJob(job, { immediate: true });
  pump();
  res.status(201).json({ job: publicJob(job) });
});

app.post("/api/jobs/:id/cancel", (req, res) => {
  const job = findJob(req.params.id);
  if (!job || !canTouch(req, job)) {
    res.status(404).json({ error: "No such job." });
    return;
  }
  if (job.state === "queued") {
    job.state = "cancelled";
    job.error = "Cancelled before it started.";
    const at = queue.indexOf(job.id);
    if (at >= 0) queue.splice(at, 1);
    persistJobs();
    notifyJob(job, { immediate: true });
    res.json({ job: publicJob(job) });
    return;
  }
  if (job.state === "running" && job.streamChild) {
    // Stream jobs have no queue entry and no staging folder: the only thing to
    // stop is the encoder writing to the guest's connection.
    job.state = "cancelling";
    stopChildTree(job.streamChild);
    notifyJob(job, { immediate: true });
    res.json({ job: publicJob(job) });
    return;
  }
  if (job.state === "running" && job.child) {
    job.state = "cancelling";
    job.child.kill("SIGTERM");
    setTimeout(() => {
      if (job.child && job.child.exitCode === null) job.child.kill("SIGKILL");
    }, 8000);
    notifyJob(job, { immediate: true });
    res.json({ job: publicJob(job) });
    return;
  }
  res.status(409).json({ error: "That job is not running." });
});

// Owner-only: fix the tags of a finished job in place. The audio is copied, not
// re-encoded, and the files stay where they are - a changed album name does not
// move the folder.
app.patch("/api/jobs/:id/tags", async (req, res) => {
  if (req.auth.role !== "owner") {
    res.status(403).json({ error: "Only the owner can re-tag files." });
    return;
  }
  const job = findJob(req.params.id);
  if (!job || job.owner !== "owner") {
    res.status(404).json({ error: "No such job." });
    return;
  }
  if (job.stream) {
    res.status(409).json({ error: "Guest streams have no files to re-tag." });
    return;
  }
  if (job.state !== "done") {
    res.status(409).json({ error: "Only a finished job can be re-tagged." });
    return;
  }
  if (retagging.has(job.id)) {
    res.status(409).json({ error: "That job is already being re-tagged." });
    return;
  }

  const clean = (value, max = 200) =>
    typeof value === "string"
      ? value
          .replace(/[\u0000-\u001f]/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, max)
      : null;
  const artist = clean(req.body?.artist);
  const album = clean(req.body?.album);
  const title = clean(req.body?.title);
  // Genre is free text rather than a fixed id: an absent field keeps whatever
  // the job carries, an empty string clears the tag.
  const genre = req.body?.genre === undefined ? null : cleanGenre(req.body.genre);
  if (artist === null && album === null && title === null && genre === null) {
    res.status(400).json({ error: "Send a title, artist, album or genre." });
    return;
  }

  // Only tracks that produced a file can be re-tagged; skipped duplicates have
  // nothing of their own to rewrite.
  const files = job.tracks.filter((track) => track.state === "done" && track.path);
  if (files.length === 0) {
    res.status(409).json({ error: "This job has no files to re-tag." });
    return;
  }

  const single = job.total === 1;
  retagging.add(job.id);
  const failures = [];
  let retagged = 0;
  try {
    for (const track of files) {
      const root = job.dir || settings.musicDir;
      if (!isInside(track.path, root) || !fs.existsSync(track.path)) {
        failures.push(`${path.basename(track.path)} is no longer in the library`);
        continue;
      }
      // A playlist keeps each track's own title; only a single download has one
      // title to change.
      const nextTitle = single && title !== null ? title || track.title : track.title;
      try {
        await retagFile(track.path, {
          title: nextTitle,
          artist: artist ?? job.artist,
          album: album ?? job.album,
          genre: genre ?? job.genre,
        });
        track.title = nextTitle;
        retagged += 1;
      } catch (err) {
        failures.push(`${path.basename(track.path)}: ${err.message}`);
      }
    }

    if (retagged > 0) {
      // Label the job the way the files were filed: every artist in the tag
      // list, joined with ", ", not whatever separators were typed.
      if (artist !== null) job.artist = splitArtists(artist).join(", ") || artist;
      if (album !== null) job.album = album;
      if (genre !== null) job.genre = genre;
      if (single && title) job.title = title;
      job.log.push(`Re-tagged ${retagged} ${retagged === 1 ? "file" : "files"} from the queue.`);
      const entry = history.find((item) => item.id === job.id);
      if (entry) {
        entry.title = job.title;
        entry.artist = job.artist;
        entry.album = job.album;
        writeJson(HISTORY_FILE, history);
      }
      persistJobs();
      notifyJob(job, { immediate: true });
    }
  } finally {
    retagging.delete(job.id);
  }

  if (retagged === 0) {
    res.status(409).json({ error: failures[0] || "The files could not be re-tagged." });
    return;
  }
  res.json({
    ok: true,
    retagged,
    job: publicJob(job),
    warning: failures.length ? `Left alone: ${failures.join("; ")}` : undefined,
  });
});

app.post("/api/jobs/:id/retry", (req, res) => {
  const job = findJob(req.params.id);
  if (!job || !canTouch(req, job)) {
    res.status(404).json({ error: "No such job." });
    return;
  }
  if (job.state === "running" || job.state === "queued" || job.state === "cancelling") {
    res.status(409).json({ error: "That job is still active." });
    return;
  }
  job.state = "queued";
  job.error = undefined;
  delete job.needsCookies;
  job.completed = 0;
  job.tracks = job.tracks.map((t) => ({ ...t, state: "queued", pct: 0, stage: null, error: undefined }));
  // A stream job is started by the download click, not by pump().
  if (!job.stream) queue.push(job.id);
  persistJobs();
  notifyJob(job, { immediate: true });
  pump();
  res.json({ job: publicJob(job) });
});

app.delete("/api/jobs/:id", (req, res) => {
  const job = findJob(req.params.id);
  if (!job || !canTouch(req, job)) {
    res.status(404).json({ error: "No such job." });
    return;
  }
  if (job.state === "running" || job.state === "cancelling") {
    res.status(409).json({ error: "Cancel it first." });
    return;
  }
  jobs = jobs.filter((j) => j.id !== job.id);
  persistJobs();
  notifyRemoved(job);
  res.json({ ok: true });
});

// ------------------------------------------------------------------- executor

function pump() {
  while (active.size < settings.maxJobs && queue.length) {
    // Count what is already running per host so the loop can skip a job whose
    // site is at its limit and start a later one instead.
    const perHost = new Map();
    for (const job of active.values()) perHost.set(job.host, (perHost.get(job.host) || 0) + 1);

    let pick = -1;
    for (let i = 0; i < queue.length; i += 1) {
      const job = findJob(queue[i]);
      // A queued id with no job (or one cancelled meanwhile) is dropped.
      if (!job || job.state !== "queued") {
        queue.splice(i, 1);
        i -= 1;
        continue;
      }
      // Driven by a guest's download click rather than by the scheduler.
      if (job.stream) continue;
      if ((perHost.get(job.host) || 0) < settings.perHost) {
        pick = i;
        break;
      }
    }
    if (pick < 0) return; // everything left is waiting on its host

    const [id] = queue.splice(pick, 1);
    const job = findJob(id);
    if (job) start(job);
  }
}

function start(job) {
  active.set(job.id, job);
  job.state = "running";
  job.startedAt = Date.now();
  job.log = [];
  job.tracks = job.tracks.map((t) => ({ ...t, state: "queued", pct: 0, stage: null, error: undefined }));
  persistJobs();
  notifyJob(job, { immediate: true });

  const jobDir = path.join(DATA_DIR, "sessions", job.id);
  const args = [
    "--json",
    "-o",
    job.dir || settings.musicDir,
    "--lufs",
    String(job.lufs),
    "--session-dir",
    jobDir,
    job.trackPrefix ? "--track-prefix" : "--no-track-prefix",
  ];
  if (job.onePass) args.push("--one-pass");
  if (!job.art) args.push("--no-art");
  // The script's single-instance lock exists to protect the import index; with
  // more than one job at a time the queue is the serialiser, and each job has
  // its own --session-dir.
  if (settings.maxJobs > 1) args.push("--no-lock");
  if (job.policy === "overwrite") args.push("--force");
  if (job.kind === "playlist") args.push("--tracks", job.selection.join(","));
  if (job.artist) args.push("--artist", job.artist);
  if (job.album) args.push("--album", job.album);
  if (job.genre) args.push("--genre", job.genre);
  if (job.metaPath) args.push("--meta-json", job.metaPath);
  // The owner's cookie jar, and only for the owner's own jobs: a guest download
  // must never run against the owner's signed-in account.
  if (job.owner === "owner" && fs.existsSync(COOKIES_FILE)) args.push("--cookies", COOKIES_FILE);
  args.push("--", job.url);

  const env = toolEnv({ AAC_QUALITY: String(job.quality), OUTPUT_FORMAT: job.format || "m4a" });
  if (job.owner !== "owner") {
    // Keep guest downloads out of the library's import index (and its lock),
    // so a guest run can never mark a library track as already imported.
    env.XDG_STATE_HOME = path.join(DATA_DIR, "guest-state");
  }
  const child = spawn(BIN, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  job.child = child;

  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const text = line.trim();
      if (!text.startsWith("{")) continue;
      let evt;
      try {
        evt = JSON.parse(text);
      } catch {
        continue;
      }
      applyEvent(job, evt);
    }
  });

  let errBuffer = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    errBuffer += chunk;
    const lines = errBuffer.split("\n");
    errBuffer = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
      if (!line) continue;
      job.log.push(line);
      if (job.log.length > 400) job.log.shift();
    }
  });

  // A spawn failure also closes the child, so the completion path below stays
  // the only caller of finish() - otherwise a single job could notify twice.
  child.on("error", (err) => {
    job.error = err.message;
  });

  child.on("close", (code) => {
    if (buffer.trim().startsWith("{")) {
      try {
        applyEvent(job, JSON.parse(buffer.trim()));
      } catch {
        /* ignore a torn final line */
      }
    }
    job.child = null;
    if (job.state === "cancelling" || code === 130) {
      job.state = "cancelled";
    } else if (code === 0 && job.tracks.some((t) => t.state === "done" || t.state === "skipped")) {
      job.state = "done";
    } else if (code === 0) {
      job.state = "done";
    } else {
      job.state = "failed";
      job.error = job.error || lastError(job) || `The downloader exited with code ${code}.`;
    }
    finish(job);
  });
}

function lastError(job) {
  const line = [...job.log].reverse().find((l) => l.includes("[x]"));
  return line ? line.replace(/^\[x\]\s*/, "") : "";
}

function finish(job) {
  job.finishedAt = Date.now();
  job.child = null;
  // One extra field on the kind of failure a jar would fix, so the queue can
  // offer it. Guests are never offered it: the jar is the owner's account.
  if (job.state === "failed" && job.owner === "owner" && wantsCookies(job)) job.needsCookies = true;
  if (job.state === "done") job.completed = job.tracks.filter((t) => t.state === "done").length;
  if (job.state === "done" && job.owner === "owner") writePlaylists(job);
  persistJobs();
  active.delete(job.id);
  notifyJob(job, { immediate: true });
  notifyWebhook(job);
  if (job.state !== "queued" && job.state !== "running") recordHistory(job);
  pump();
}

// ------------------------------------------------------------------ finished

const AUDIO_EXT = new Set([".m4a", ".mp3", ".flac", ".opus", ".ogg", ".oga", ".wav"]);

// An album playlist beside the files, so players keep track order even when the
// tags are missing or the folder is copied elsewhere. Written per folder, so a
// playlist that spans several albums gets one list per album. Contents come
// from the folder itself, which means tracks that were skipped because they
// already existed still make it into the list.
function writePlaylists(job) {
  const dirs = [
    ...new Set(
      job.tracks
        .filter((track) => track.state === "done" && track.path)
        .map((track) => path.dirname(track.path)),
    ),
  ];
  const durations = new Map(
    job.tracks
      .filter((track) => track.path)
      .map((track) => [path.basename(track.path), Math.round(Number(track.duration) || 0)]),
  );

  for (const dir of dirs) {
    try {
      const names = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && AUDIO_EXT.has(path.extname(entry.name).toLowerCase()))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
      if (names.length < 2) continue;

      const lines = ["#EXTM3U"];
      for (const name of names) {
        const seconds = durations.get(name) ?? 0;
        lines.push(`#EXTINF:${seconds > 0 ? seconds : -1},${path.basename(name, path.extname(name))}`);
        lines.push(name);
      }
      fs.writeFileSync(path.join(dir, `${path.basename(dir)}.m3u8`), `${lines.join("\n")}\n`);
    } catch (err) {
      console.warn(`[audiodl] could not write playlist in ${dir}: ${err.message}`);
    }
  }
}

// ------------------------------------------------------------- notifications
// One finished job becomes a small, structured message. Discord gets a real
// embed (title, cover, colour and two fields), Slack gets a header plus a
// context line, and anything else keeps the generic {"content": "..."} body.
// Mentions are disabled everywhere: a track called "@everyone" must not ping.

// What a job looks like, before it is made into any service's own shape.
function notificationFor(job) {
  const count = (state) => job.tracks.filter((track) => track.state === state).length;
  const done = count("done");
  const skipped = count("skipped");
  const failed = count("failed");
  const playlist = job.kind === "playlist";
  // A playlist is known by its album; a single track by its own name.
  const title = playlist ? job.album || job.title : job.title;
  // Under the artist: the playlist name, or the album when it says something
  // the title does not (the album falls back to the title for singles).
  const second = playlist
    ? job.title !== title
      ? job.title
      : ""
    : job.album && job.album !== title
      ? job.album
      : "";
  const subtitle = [job.artist, second].filter(Boolean).join(" · ");
  // A failed job whose name never arrived (the source refused the URL) has no
  // title to show; a placeholder would be read as the track's name.
  const heading = job.state === "failed" && /^(Single track|Playlist|)$/.test(String(title))
    ? "Download failed"
    : title;
  // "0 of 1 saved" reads like an error; when everything was already there, say
  // that instead. The colour still marks it as a job with nothing new.
  const bits = [];
  if (done || !skipped) bits.push(`${done} of ${job.total} saved`);
  if (skipped) bits.push(`${skipped} already ${done ? "there" : "in the library"}`);
  if (failed) bits.push(`${failed} failed`);
  return {
    title: heading,
    subtitle,
    state: job.state,
    summary: bits.join(" · "),
    format: `${job.format.toUpperCase()} · q${job.quality} · ${job.lufs} LUFS`,
    error: job.state === "failed" ? clip(job.error || "The download failed.", 280) : "",
    url: job.url,
    thumb: job.thumb || "",
    finishedAt: job.finishedAt || Date.now(),
    site: settings.siteName,
    guest: job.owner !== "owner",
    saved: done,
    failed,
    skipped,
  };
}

// One POST to the webhook. Rejects on a non-2xx so the test button can say why.
async function postWebhook(payload) {
  const response = await fetch(settings.webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload.body,
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`The webhook answered ${response.status}.`);
  return hostOf(settings.webhookUrl);
}

// One message per finished job. Fire-and-forget: a webhook that is slow, down
// or misconfigured must never hold up the queue.
function notifyWebhook(job) {
  if (!settings.webhookUrl) return;
  if (!settings.webhookGuests && job.owner !== "owner") return;
  if (job.state !== "done" && job.state !== "failed") return;

  postWebhook(webhookPayload(webhookKind(settings.webhookUrl), notificationFor(job))).catch((err) => {
    console.warn(`[audiodl] webhook failed: ${err.message}`);
  });
}

// A caller that only handed over a URL (the API, the Telegram-shaped clients)
// does not know the title yet. The script reports the resolved names with the
// track, so the queue row and the webhook can name the file. Values the caller
// chose are never overwritten.
function adoptNames(job, track, evt) {
  if (!evt.title) return;
  if (job.kind === "track" && (!job.title || job.title === "Single track")) job.title = evt.title;
  if (evt.artist && !job.artist) job.artist = evt.artist;
  if (evt.album && !job.album) job.album = evt.album;
  if (!track.title || /^Track \d+$/.test(track.title)) track.title = evt.title;
}

function applyEvent(job, evt) {
  switch (evt.event) {
    case "job": {
      job.kind = evt.kind === "playlist" ? "playlist" : job.kind;
      break;
    }
    case "stage": {
      const track = job.tracks.find((t) => t.i === evt.i);
      if (!track) break;
      track.stage = evt.stage;
      if (typeof evt.pct === "number") track.pct = evt.pct;
      if (track.state === "queued") track.state = "running";
      // Progress ticks are not persisted: a restart marks live jobs failed anyway.
      notifyJob(job);
      break;
    }
    case "track": {
      const track = job.tracks.find((t) => t.i === evt.i) || (job.kind === "track" ? job.tracks[0] : null);
      if (!track) break;
      if (evt.stage === "start") {
        track.state = "running";
        adoptNames(job, track, evt);
      } else if (evt.stage === "done") {
        track.state = "done";
        track.pct = 100;
        track.error = undefined;
        track.path = evt.path;
        track.size = evt.size;
        track.duration = evt.duration || track.duration;
        adoptNames(job, track, evt);
        job.completed = job.tracks.filter((t) => t.state === "done").length;
      } else if (evt.stage === "skipped") {
        track.state = "skipped";
        track.pct = 100;
        // The duplicate guard reports the copy it found, so the row can name
        // it. A plain "already exists" skip carries no reason and leaves the
        // field alone.
        if (evt.reason === "duplicate" && evt.path) track.duplicatePath = evt.path;
      } else if (evt.stage === "failed") {
        track.state = "failed";
        if (job.log.length) track.error = lastError(job);
      }
      persistJobs();
      notifyJob(job, { immediate: true });
      break;
    }
    case "summary": {
      job.completed = evt.ok || 0;
      job.skipped = evt.skipped || 0;
      job.failed = evt.failed || 0;
      persistJobs();
      notifyJob(job, { immediate: true });
      break;
    }
    case "error": {
      job.error = evt.message || "The downloader reported an error.";
      persistJobs();
      notifyJob(job, { immediate: true });
      break;
    }
  }
}

// --------------------------------------------------------------------- static

// Build a preview card that a link unfurler (Discord, Slack, iMessage, X) can
// read without running any JavaScript, using the instance's own name.
const TAGLINE = "Download tracks and playlists into a tagged audio library.";

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Behind a reverse proxy the forwarded headers are the truth; a bad Host is
// ignored rather than written into a tag.
function originOf(req) {
  const proto = String(req.get("x-forwarded-proto") || req.protocol || "http")
    .split(",")[0]
    .trim();
  const host = String(req.get("x-forwarded-host") || req.get("host") || "")
    .split(",")[0]
    .trim();
  try {
    const origin = new URL(`${proto}://${host}`).origin;
    return origin === "null" ? "" : origin;
  } catch {
    return "";
  }
}

function previewTags(req, pathname) {
  const origin = originOf(req);
  const absolute = (file) => (origin ? `${origin}${file}` : file);
  const title = escapeAttr(settings.siteName);
  const description = escapeAttr(TAGLINE);
  const url = escapeAttr(origin ? `${origin}${pathname}` : pathname);
  const image = escapeAttr(absolute("/og.png"));
  return [
    `<title>${title}</title>`,
    `<meta name="description" content="${description}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${title}" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:image" content="${image}" />`,
    `<meta property="og:image:type" content="image/png" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="Paste a link. Get a tagged file." />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${description}" />`,
    `<meta name="twitter:image" content="${image}" />`,
    `<meta name="twitter:image:alt" content="Paste a link. Get a tagged file." />`,
  ].join("\n    ");
}

// ------------------------------------------------------------------- the look

// Theme, effects and palette are per-browser choices, so the server cannot know
// them from the request alone. The page mirrors each one into a cookie
// (web/src/lib/prefs.ts) and the opening tag is rebuilt from them on every
// request: a stored Light, a paused effects switch or a Catppuccin flavor is on
// <html> in the very first byte, before any script runs. Nothing outside these
// lists is ever written into the page.
//
// /admin is the one exception: its look belongs to the instance, not to the
// browser. The owner sets it once on the Settings page, it is stored in
// settings.json next to the rest, and every device opening Settings gets that
// same page - see adminLook below.
const THEMES = ["auto", "light", "dark"];
const EFFECTS = ["on", "off"];
const FLAVORS = ["latte", "frappe", "macchiato", "mocha"];
const ACCENTS = [
  "rosewater",
  "flamingo",
  "pink",
  "mauve",
  "red",
  "maroon",
  "peach",
  "yellow",
  "green",
  "teal",
  "sky",
  "sapphire",
  "blue",
  "lavender",
];

function requestCookie(req, name) {
  // The pattern is a string, so the whitespace class has to stay escaped in it.
  const match = (req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return "";
  }
}

// A browser's own look. A missing effects switch is left off <html> entirely so
// the browser's reduced-motion preference decides; nothing unrecognised is
// ever written back into the page.
function cookieLook(req) {
  const theme = requestCookie(req, "audiodl-theme");
  const effects = requestCookie(req, "audiodl-effects");
  let stored = null;
  try {
    stored = JSON.parse(requestCookie(req, "audiodl-catppuccin") || "null");
  } catch {
    stored = null; // a hand-edited cookie is ignored, never fatal
  }
  return {
    theme: THEMES.includes(theme) ? theme : "auto",
    effects: EFFECTS.includes(effects) ? effects : null,
    flavor: FLAVORS.includes(stored?.flavor) ? stored.flavor : null,
    accent: ACCENTS.includes(stored?.accent) ? stored.accent : null,
  };
}

// The look of /admin: picked by the owner on the Settings page, stored in
// settings.json and the same for every device from then on. Cleaning on the way
// out (and on the way in, below) is what makes a hand-edited settings file
// harmless - the page can only ever carry these values.
const DEFAULT_ADMIN_LOOK = { theme: "auto", effects: "on", flavor: null, accent: "mauve" };

function cleanAdminLook(value) {
  const look = value && typeof value === "object" ? value : {};
  return {
    theme: THEMES.includes(look.theme) ? look.theme : DEFAULT_ADMIN_LOOK.theme,
    effects: EFFECTS.includes(look.effects) ? look.effects : DEFAULT_ADMIN_LOOK.effects,
    flavor: FLAVORS.includes(look.flavor) ? look.flavor : null,
    accent: ACCENTS.includes(look.accent) ? look.accent : DEFAULT_ADMIN_LOOK.accent,
  };
}

function adminLook() {
  return cleanAdminLook(settings.adminLook);
}

function lookAttributes(look) {
  const attrs = [` data-theme="${look.theme}"`];
  if (look.effects) attrs.push(` data-effects="${look.effects}"`);
  if (look.flavor) attrs.push(` data-catppuccin="${look.flavor}"`);
  if (look.accent) attrs.push(` data-accent="${look.accent}"`);
  return attrs.join("");
}

// Settings reads the stored look; every other page reads this browser's
// cookies. A trailing slash must not fall through to the per-browser branch.
function lookFor(req) {
  return (req.path.replace(/\/+$/, "") || "/") === "/admin" ? adminLook() : cookieLook(req);
}

// Everything the built shell says about the look comes off first: the store for
// that page is the truth, so a stale attribute in the built HTML cannot win.
function withLook(html, look) {
  return html.replace(/<html\b([^>]*)>/, (_match, kept) =>
    `<html${String(kept).replace(
      /\s*data-(?:theme|effects|catppuccin|accent)(?:="[^"]*")?/g,
      "",
    )}${lookAttributes(look)}>`,
  );
}

// Built here rather than served from a file so an installed shortcut carries
// the name the owner chose, not a hard-coded one.
app.get("/manifest.webmanifest", (_req, res) => {
  res.type("application/manifest+json").json({
    name: settings.siteName,
    short_name: settings.siteName,
    description: TAGLINE,
    start_url: "/",
    scope: "/",
    display: "standalone",
    // Android's share sheet offers Crate for a link. iOS has no equivalent, so
    // the same /share endpoint is what a Shortcut calls there.
    share_target: {
      action: "/share",
      method: "POST",
      enctype: "application/x-www-form-urlencoded",
      params: { title: "title", text: "text", url: "url" },
    },
    background_color: "#f5f5f7",
    theme_color: "#1d1d1f",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  });
});

// Phone share sheet: Android sends the shared link here from the manifest's
// share_target, and a Shortcut on iOS can open /share?url=… directly (Safari has
// no share target). Either way the page opens with the link already inspected.
const SHARE_FIELDS = ["url", "text", "title"];
function sharedLink(body) {
  for (const key of SHARE_FIELDS) {
    const value = typeof body?.[key] === "string" ? body[key] : "";
    const match = value.match(/https?:\/\/[^\s<>"']+/);
    if (match) return match[0].replace(/[,;.]+$/, "");
  }
  return "";
}
function shareRedirect(req, res) {
  const link = sharedLink({ ...req.query, ...req.body });
  if (!link) {
    res.status(400).type("text").send("No link in that share.");
    return;
  }
  res.redirect(302, `/?url=${encodeURIComponent(link)}`);
}
// urlencoded only on these two routes: the rest of the API is JSON, and the
// share sheet posts a form rather than a body it expects an answer from.
app.get("/share", (req, res) => shareRedirect(req, res));
app.post("/share", express.urlencoded({ extended: false, limit: "16kb" }), (req, res) =>
  shareRedirect(req, res),
);

// Share shortcut: /https://soundcloud.com/… opens the app with that link already
// in the composer, so a full URL can be handed out behind a short host name.
app.get(/^\/https?:\/\/.+/, (req, res) => {
  const raw = req.originalUrl.split("?")[0].replace(/^\//, "");
  res.redirect(302, `/?url=${encodeURIComponent(raw)}`);
});

if (fs.existsSync(DIST)) {
  // First run: every page (root included) goes to /setup until a password is
  // stored. Once it is, /setup itself goes back to the root, so an old bookmark
  // cannot land on a form that would only answer 409. This runs before the
  // static handler, which would otherwise serve index.html for "/" directly.
  app.use((req, res, next) => {
    if (req.method !== "GET") return next();
    const clean = req.path.replace(/\/+$/, "") || "/";
    if (clean.includes(".")) return next(); // assets, manifest, icons
    if (setupNeeded && clean !== "/setup") return res.redirect(302, "/setup");
    if (!setupNeeded && clean === "/setup") return res.redirect(302, "/");
    next();
  });

  // Every page is the same app shell, but the preview tags are written per
  // request: the instance name and the absolute card URL are only known then.
  const shellPath = path.join(DIST, "index.html");
  let shell = "";
  try {
    shell = fs.readFileSync(shellPath, "utf8");
  } catch {
    shell = ""; // no build: serve whatever is there
  }
  app.get(/^\/(?!api\/)[^.]*$/, (req, res) => {
    if (!shell) return res.sendFile(shellPath);
    const clean = req.path.replace(/\/+$/, "") || "/";
    // A function replacement: a name containing `$&` or `$1` must not be read
    // as a replacement pattern.
    const html = shell.replace(
      /[ \t]*<!-- preview -->[\s\S]*?<!-- \/preview -->/,
      () => `    ${previewTags(req, clean)}`,
    );
    res.set("Cache-Control", "no-cache").type("html").send(withLook(html, lookFor(req)));
  });

  app.use(express.static(DIST, { index: "index.html" }));
  // Anything that gets this far is the same app shell; it carries the look too,
  // so even an odd path starts in the right theme.
  app.get(/^\/(?!api\/).*/, (req, res) => {
    if (!shell) return res.sendFile(path.join(DIST, "index.html"));
    res.set("Cache-Control", "no-cache").type("html").send(withLook(shell, lookFor(req)));
  });
}

app.listen(PORT, HOST, () => {
  // Honour the queue that survived the restart now that the server is up.
  pump();
  // The first release check starts with the server, so the hint is already
  // there when the owner's page loads; after that it refreshes on its own.
  void checkRelease();
  setInterval(checkRelease, UPDATE_EVERY).unref();
  console.log(`[audiodl] http://${HOST}:${PORT}  library=${settings.musicDir}`);
  console.log(`[audiodl] binary=${BIN}`);
  console.log(
    `[audiodl] jobs=${settings.maxJobs} (max ${settings.perHost} per host)  webhook=${
      settings.webhookUrl ? hostOf(settings.webhookUrl) : "off"
    }`,
  );
});
