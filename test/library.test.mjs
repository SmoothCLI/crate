// Tests for the parts of dlAudio.sh that touch the library rather than a
// source: ReplayGain tags, the duplicate guard and the cookie jar.
//
// A stand-in `yt-dlp` copies a generated tone into the library and records its
// own arguments, so nothing here touches the network. `--no-mb --no-lyrics`
// keeps the MusicBrainz and LRCLIB clients out of the run.
//
//   node --test test/*.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const SCRIPT = path.join(ROOT, "dlAudio.sh");
const URL = "https://example.invalid/watch?v=e1";

// Stand-in yt-dlp: answers the probe, the metadata call and the download, and
// appends every invocation's arguments to $ARGS_LOG so a test can see which
// options the script actually passed.
const FAKE_YTDLP = `#!/usr/bin/env bash
set -u
SEP=$'\\x1f'
printf '%s\\n' "$*" >>"$ARGS_LOG"
for a in "$@"; do
  case "$a" in
    --flat-playlist)
      printf '%s\\n' "set-1\${SEP}Test Set\${SEP}e1\${SEP}Midnight Drive (Official Video)\${SEP}https://example.invalid/watch?v=e1\${SEP}\${SEP}214"
      exit 0 ;;
  esac
done
for a in "$@"; do
  case "$a" in
    --print)
      printf '%s\\n' "Nova Lane - Topic\${SEP}\${SEP}Midnight Drive (Official Video)\${SEP}SomeChannel\${SEP}20240302\${SEP}\${SEP}\${SEP}e1\${SEP}214"
      exit 0 ;;
  esac
done
out=""; pathfile=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    --print-to-file) pathfile="$3"; shift 3 ;;
    *) shift ;;
  esac
done
out="\${out//\\%(ext)s/flac}"
cp "$TONE_FILE" "$out"
[ -n "$pathfile" ] && printf '%s\\n' "$out" >"$pathfile"
exit 0
`;

function have(command, args = ["--version"]) {
  return spawnSync(command, args, { stdio: "ignore" }).status === 0;
}

function harness(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "audiodl-lib-"));
  const bin = path.join(dir, "bin");
  const music = path.join(dir, "music");
  for (const d of [bin, music]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(bin, "yt-dlp"), FAKE_YTDLP, { mode: 0o755 });
  const argsLog = path.join(dir, "args.log");
  writeFileSync(argsLog, "");

  const tone = path.join(dir, "tone.flac");
  const made = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=5", tone],
    { stdio: "ignore" },
  );
  if (made.status !== 0) throw new Error("could not generate the test tone");

  if (t) t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, bin, music, tone, argsLog };
}

function env(h, extra = {}) {
  return {
    ...process.env,
    PATH: `${h.bin}${path.delimiter}${process.env.PATH}`,
    TONE_FILE: h.tone,
    ARGS_LOG: h.argsLog,
    AUDIODL_SOURCE_ONLY: "0",
    XDG_STATE_HOME: h.dir,
    ...extra,
  };
}

// A full run of the script for one URL, with the network-facing extras off.
function run(h, args, extra = {}) {
  return spawnSync(SCRIPT, ["--no-mb", "--no-lyrics", ...args, "--", URL], {
    cwd: h.dir,
    env: env(h, extra),
    encoding: "utf8",
  });
}

// The folder name comes from the source, which --no-mb does not clean up, so
// the tests look for audio files rather than guessing a path.
function audioFiles(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(flac|mp3|m4a|opus)$/i.test(entry.name)) found.push(full);
    }
  };
  if (existsSync(dir)) walk(dir);
  return found.sort();
}

function canTag(t) {
  if (!have("ffmpeg", ["-version"]) || !have("ffprobe", ["-version"]) || !have("jq")) {
    t.skip("ffmpeg, ffprobe and jq are needed for an end-to-end run");
    return false;
  }
  return true;
}

function tagsOf(file) {
  const probe = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format_tags", "-of", "default=nw=1", file],
    { encoding: "utf8" },
  );
  return Object.fromEntries(
    probe.stdout
      .trim()
      .split("\n")
      .map((line) => line.replace(/^TAG:/, "").split("="))
      .map(([key, ...value]) => [key, value.join("=")]),
  );
}

const GAIN = /^-?\d+\.\d{2} dB$/;

test("ReplayGain tags describe the file that was written", (t) => {
  if (!canTag(t)) return;
  const h = harness(t);
  const res = run(h, ["-y", "--output-format", "flac", "-o", h.music, "--session-dir", path.join(h.dir, "s1")]);
  assert.equal(res.status, 0, res.stderr);

  const [file] = audioFiles(h.music);
  assert.ok(file, `no file was written\n${res.stdout}\n${res.stderr}`);
  const tags = tagsOf(file);

  assert.match(tags.REPLAYGAIN_TRACK_GAIN, GAIN);
  // The same target the encoder aimed at, so the tag is neutral for a player
  // that uses it: the library is already normalised.
  const gain = Number.parseFloat(tags.REPLAYGAIN_TRACK_GAIN);
  assert.ok(Math.abs(gain) <= 2, `gain should be near zero, got ${tags.REPLAYGAIN_TRACK_GAIN}`);
  const peak = Number.parseFloat(tags.REPLAYGAIN_TRACK_PEAK);
  assert.ok(peak > 0 && peak <= 1.5, `peak should be a linear amplitude, got ${tags.REPLAYGAIN_TRACK_PEAK}`);
  assert.equal(tags.REPLAYGAIN_REFERENCE_LOUDNESS, "-9.0 LUFS");
});

test("--no-replaygain leaves the tags out", (t) => {
  if (!canTag(t)) return;
  const h = harness(t);
  const res = run(h, [
    "-y",
    "--no-replaygain",
    "--output-format",
    "flac",
    "-o",
    h.music,
    "--session-dir",
    path.join(h.dir, "s1"),
  ]);
  assert.equal(res.status, 0, res.stderr);
  const [file] = audioFiles(h.music);
  assert.ok(file, res.stderr);
  const tags = tagsOf(file);
  assert.equal(tags.REPLAYGAIN_TRACK_GAIN, undefined);
  assert.equal(tags.REPLAYGAIN_REFERENCE_LOUDNESS, undefined);
});

test("MP3 gets the ReplayGain frames from ffmpeg", (t) => {
  if (!canTag(t)) return;
  const h = harness(t);
  const res = run(h, ["-y", "--output-format", "mp3", "-o", h.music, "--session-dir", path.join(h.dir, "s1")]);
  assert.equal(res.status, 0, res.stderr);
  const [file] = audioFiles(h.music);
  assert.match(file ?? "", /\.mp3$/, res.stderr);
  const tags = tagsOf(file);
  assert.match(tags.REPLAYGAIN_TRACK_GAIN, GAIN);
  assert.ok(Number.parseFloat(tags.REPLAYGAIN_TRACK_PEAK) > 0);
});

test("M4A and Opus carry ReplayGain in the tags mutagen writes", (t) => {
  if (!canTag(t)) return;
  if (!have("python3", ["-c", "import mutagen"])) {
    t.skip("mutagen is not installed for python3");
    return;
  }
  const read = `
import sys
from mutagen.mp4 import MP4
from mutagen.oggopus import OggOpus

path, ext = sys.argv[1], sys.argv[2]
if ext == "m4a":
    audio = MP4(path)
    values = [
        audio["----:com.apple.iTunes:REPLAYGAIN_TRACK_GAIN"][0].decode(),
        audio["----:com.apple.iTunes:REPLAYGAIN_TRACK_PEAK"][0].decode(),
        audio["----:com.apple.iTunes:REPLAYGAIN_REFERENCE_LOUDNESS"][0].decode(),
    ]
else:
    audio = OggOpus(path)
    values = [
        audio["REPLAYGAIN_TRACK_GAIN"][0],
        audio["REPLAYGAIN_TRACK_PEAK"][0],
        audio["REPLAYGAIN_REFERENCE_LOUDNESS"][0],
    ]
print("|".join(values))
`;

  for (const format of ["m4a", "opus"]) {
    const h = harness(t);
    const res = run(h, [
      "-y",
      "--output-format",
      format,
      "-o",
      h.music,
      "--session-dir",
      path.join(h.dir, "s1"),
    ]);
    assert.equal(res.status, 0, res.stderr);
    const [file] = audioFiles(h.music);
    assert.ok(file, `no file was written for ${format}\n${res.stderr}`);

    const readBack = spawnSync("python3", ["-c", read, file, format], { encoding: "utf8" });
    assert.equal(readBack.status, 0, readBack.stderr);
    const [gain, peak, reference] = readBack.stdout.trim().split("|");
    assert.match(gain, GAIN);
    assert.ok(Number.parseFloat(peak) > 0);
    assert.equal(reference, "-9.0 LUFS");
  }
});

test("a second copy of the same upload is skipped and the reason is reported", (t) => {
  if (!canTag(t)) return;
  const h = harness(t);
  const first = run(h, ["-y", "--output-format", "flac", "-o", h.music, "--session-dir", path.join(h.dir, "s1")]);
  assert.equal(first.status, 0, first.stderr);

  // A different artist means a different path, so only the import index can
  // tell that this upload is already in the library.
  const [firstFile] = audioFiles(h.music);
  assert.ok(firstFile, first.stderr);

  const second = run(h, [
    "--json",
    "--output-format",
    "flac",
    "--artist",
    "Other Artist",
    "-o",
    h.music,
    "--session-dir",
    path.join(h.dir, "s2"),
  ]);
  assert.equal(second.status, 0, second.stderr);

  const events = second.stdout
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line));
  const skipped = events.find((event) => event.event === "track" && event.stage === "skipped");
  assert.ok(skipped, second.stdout);
  assert.equal(skipped.reason, "duplicate");
  assert.equal(skipped.path, firstFile);

  // Nothing was written at the new path.
  assert.deepEqual(audioFiles(h.music), [firstFile]);
  assert.equal(existsSync(path.join(h.music, "Other Artist")), false);
  assert.match(second.stderr, /Already downloaded, skipping/);
});

test("--force writes the second copy anyway", (t) => {
  if (!canTag(t)) return;
  const h = harness(t);
  const first = run(h, ["-y", "--output-format", "flac", "-o", h.music, "--session-dir", path.join(h.dir, "s1")]);
  assert.equal(first.status, 0, first.stderr);

  const second = run(h, [
    "-y",
    "--force",
    "--output-format",
    "flac",
    "--artist",
    "Other Artist",
    "-o",
    h.music,
    "--session-dir",
    path.join(h.dir, "s2"),
  ]);
  assert.equal(second.status, 0, second.stderr);
  const files = audioFiles(h.music);
  assert.equal(files.length, 2, files.join("\n"));
  assert.ok(files.some((file) => file.includes(`${path.sep}Other Artist${path.sep}`)), files.join("\n"));
});

test("--plan names the copy that is already in the library", (t) => {
  if (!canTag(t)) return;
  const h = harness(t);
  const first = run(h, ["-y", "--output-format", "flac", "-o", h.music, "--session-dir", path.join(h.dir, "s1")]);
  assert.equal(first.status, 0, first.stderr);

  const plan = run(h, [
    "--plan",
    "--output-format",
    "flac",
    "--artist",
    "Other Artist",
    "-o",
    h.music,
    "--session-dir",
    path.join(h.dir, "s3"),
  ]);
  assert.equal(plan.status, 0, plan.stderr);
  const data = JSON.parse(plan.stdout.trim().split("\n").filter(Boolean).pop());
  assert.equal(data.event, "plan");
  const [file] = audioFiles(h.music);
  assert.ok(file, first.stderr);
  assert.equal(data.tracks[0].duplicate, file);
  assert.notEqual(data.tracks[0].path, file);
});

test("--cookies reaches every yt-dlp call", (t) => {
  if (!canTag(t)) return;
  const h = harness(t);
  const jar = path.join(h.dir, "cookies.txt");
  writeFileSync(jar, "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1790000000\tSID\tabc\n");

  const res = run(h, [
    "-y",
    "--cookies",
    jar,
    "--output-format",
    "flac",
    "-o",
    h.music,
    "--session-dir",
    path.join(h.dir, "s1"),
  ]);
  assert.equal(res.status, 0, res.stderr);

  const calls = readFileSync(h.argsLog, "utf8").trim().split("\n").filter(Boolean);
  assert.ok(calls.length >= 3, `expected probe, metadata and download calls, got:\n${calls.join("\n")}`);
  for (const call of calls) {
    assert.match(call, /--cookies/, call);
    assert.ok(call.includes(jar), call);
  }
});

test("an unreadable cookie file is a warning, not a failure", (t) => {
  if (!canTag(t)) return;
  const h = harness(t);
  const res = run(h, [
    "-y",
    "--cookies",
    path.join(h.dir, "missing.txt"),
    "--output-format",
    "flac",
    "-o",
    h.music,
    "--session-dir",
    path.join(h.dir, "s1"),
  ]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /Cookie file not readable/);
  const calls = readFileSync(h.argsLog, "utf8").trim().split("\n").filter(Boolean);
  for (const call of calls) assert.doesNotMatch(call, /--cookies/, call);
});
