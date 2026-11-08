// Tests for the MusicBrainz lookup in dlAudio.sh.
//
// Nothing here touches the network: a stand-in `curl` serves canned MusicBrainz
// responses from a per-test directory and records every request, and the one
// end-to-end test also swaps in a stand-in `yt-dlp`. The script is sourced with
// AUDIODL_SOURCE_ONLY=1, so only its functions run.
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
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const SCRIPT = path.join(ROOT, "dlAudio.sh");
const USER_AGENT = "audioDL-test/1.0 (test@example.invalid)";

// Stand-in curl: prints the status code only when the real caller asked for it
// with --write-out, so a lyrics lookup cannot leak bytes into --json output.
const FAKE_CURL = `#!/usr/bin/env bash
set -u
out=""; hdr=""; ua=""; url=""; want_code=0
while [ $# -gt 0 ]; do
  case "$1" in
    --output) out="$2"; shift 2 ;;
    --dump-header) hdr="$2"; shift 2 ;;
    --data-urlencode)
      printf '%s\\n' "$2" >>"$MOCK_DIR/data.log"
      shift 2 ;;
    --user-agent) ua="$2"; shift 2 ;;
    --write-out) want_code=1; shift 2 ;;
    --url) url="$2"; shift 2 ;;
    --connect-timeout | --max-time | --header) shift 2 ;;
    --silent | --show-error | --location | --globoff | --get) shift ;;
    *) url="$1"; shift ;;
  esac
done
mkdir -p "$MOCK_DIR"
n=1
case "$url" in
*/ws/2/recording*)
  n=$(( $(cat "$MOCK_DIR/count" 2>/dev/null || printf 0) + 1 ))
  printf '%s' "$n" >"$MOCK_DIR/count"
  printf '%s\\n' "$url" >>"$MOCK_DIR/urls.log"
  printf '%s\\n' "$ua" >>"$MOCK_DIR/agents.log"
  ;;
esac
code="\${FAKE_CODE:-200}"
body="\${FAKE_BODY:-}"
[ -f "$MOCK_DIR/attempt-$n.code" ] && code="$(cat "$MOCK_DIR/attempt-$n.code")"
[ -f "$MOCK_DIR/attempt-$n.body" ] && body="$MOCK_DIR/attempt-$n.body"
if [ -f "$MOCK_DIR/attempt-$n.headers" ]; then cp "$MOCK_DIR/attempt-$n.headers" "\${hdr:-/dev/null}"; else : >"\${hdr:-/dev/null}"; fi
if [ -n "$body" ] && [ -s "$body" ]; then cp "$body" "\${out:-/dev/null}"; else : >"\${out:-/dev/null}"; fi
[ "$want_code" -eq 1 ] && printf '%s' "$code"
exit 0
`;

// Stand-in yt-dlp for the end-to-end test: answers --flat-playlist/--print and
// copies the generated tone into the library instead of downloading.
const FAKE_YTDLP = `#!/usr/bin/env bash
set -u
SEP=$'\\x1f'
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
  const res = spawnSync(command, args, { stdio: "ignore" });
  return res.status === 0;
}

function harness(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "audiodl-mb-"));
  const bin = path.join(dir, "bin");
  const mock = path.join(dir, "mock");
  const cache = path.join(dir, "cache");
  const tmp = path.join(dir, "tmp");
  for (const d of [bin, mock, cache, tmp]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(bin, "curl"), FAKE_CURL, { mode: 0o755 });
  writeFileSync(path.join(bin, "yt-dlp"), FAKE_YTDLP, { mode: 0o755 });
  if (t) t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, bin, mock, cache, tmp };
}

function env(h, extra = {}) {
  return {
    ...process.env,
    PATH: `${h.bin}${path.delimiter}${process.env.PATH}`,
    AUDIODL_SOURCE_ONLY: "1",
    MOCK_DIR: h.mock,
    MUSICBRAINZ_API: "https://musicbrainz.invalid/ws/2",
    MUSICBRAINZ_CACHE_DIR: h.cache,
    MUSICBRAINZ_MIN_INTERVAL: "1",
    MUSICBRAINZ_RETRIES: "1",
    MUSICBRAINZ_MAX_WAIT: "5",
    MUSICBRAINZ_USER_AGENT: USER_AGENT,
    XDG_STATE_HOME: h.dir,
    ...extra,
  };
}

function serve(h, fixture, extraEnv = {}) {
  const body = path.join(h.mock, "body.json");
  writeFileSync(body, JSON.stringify(fixture));
  return { FAKE_BODY: body, FAKE_CODE: "200", ...extraEnv };
}

function calls(h) {
  const file = path.join(h.mock, "count");
  return existsSync(file) ? Number(readFileSync(file, "utf8")) : 0;
}

const RESULT_FIELDS = [
  "status",
  "score",
  "title",
  "artist",
  "album",
  "albumFallback",
  "track",
  "trackTotal",
  "recordingId",
  "releaseId",
  "genre",
  "fetchedDate",
];

function lookup(h, vars, extraEnv = {}, options = {}) {
  const body = `
source ${JSON.stringify(SCRIPT)}
TMP_DIR=${JSON.stringify(h.tmp)}
HAVE_JQ=1
MB_ENABLED=${options.enabled ?? 1}
JSON=0
${vars}
musicbrainz_lookup
printf 'RESULT\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' \\
  "$MB_STATUS" "$MB_SCORE" "$TITLE" "$ARTIST" "$ALBUM" "$ALBUM_FALLBACK" "$TRACK" "$MB_TRACK_TOTAL" \\
  "$MB_RECORDING_ID" "$MB_RELEASE_ID" "$GENRE" "$FETCHED_DATE"
`;
  const res = spawnSync("bash", ["-c", body], { env: env(h, extraEnv), encoding: "utf8" });
  assert.equal(res.status, 0, `lookup failed: ${res.stderr}`);
  const line = res.stdout.split("\n").find((l) => l.startsWith("RESULT\t"));
  assert.ok(line, `no RESULT line in:\n${res.stdout}\n${res.stderr}`);
  const fields = line.slice("RESULT\t".length).split("\t");
  return Object.fromEntries(RESULT_FIELDS.map((name, i) => [name, fields[i] ?? ""]));
}

// ---------------------------------------------------------------- fixtures ---

const RECORDING_ID = "11111111-1111-4111-8111-111111111111";
const RELEASE_ID = "22222222-2222-4222-8222-222222222222";
const RELEASE_GROUP_ID = "33333333-3333-4333-8333-333333333333";
const TRACK_ID = "44444444-4444-4444-8444-444444444444";
const ARTIST_ID = "55555555-5555-4555-8555-555555555555";
const ALBUM_ARTIST_ID = "66666666-6666-4666-8666-666666666666";

function release(overrides = {}) {
  const {
    id = RELEASE_ID,
    title = "Night Roads",
    status = "Official",
    date = "1999-05-04",
    primaryType = "Album",
    secondaryTypes = [],
    trackNumber = "3",
    trackCount = 10,
    position = 1,
    mediaCount = 1,
    artistCredit = "Nova Lane",
    artistId = ALBUM_ARTIST_ID,
    length = 214500,
  } = overrides;
  const media = [];
  for (let i = 1; i <= mediaCount; i++) {
    media.push({
      position: i,
      format: "CD",
      "track-count": trackCount,
      track: [
        {
          id: i === position ? TRACK_ID : `${TRACK_ID}-${i}`,
          number: i === position ? trackNumber : "1",
          title: "Midnight Drive",
          length,
        },
      ],
    });
  }
  return {
    id,
    title,
    status,
    date,
    country: "US",
    "artist-credit": [{ name: artistCredit, artist: { id: artistId, name: artistCredit } }],
    "release-group": {
      id: RELEASE_GROUP_ID,
      title,
      "primary-type": primaryType,
      "secondary-types": secondaryTypes,
    },
    "track-count": trackCount,
    media,
  };
}

function recording(overrides = {}) {
  const {
    id = RECORDING_ID,
    title = "Midnight Drive",
    score = 100,
    length = 214500,
    artistCredit = "Nova Lane",
    artistId = ARTIST_ID,
    tags = [],
    genres = null,
    firstReleaseDate = "1999-05-04",
    releases = [release()],
  } = overrides;
  return {
    id,
    title,
    score,
    length,
    "first-release-date": firstReleaseDate,
    "artist-credit": [{ name: artistCredit, artist: { id: artistId, name: artistCredit } }],
    ...(genres ? { genres } : {}),
    ...(tags.length ? { tags } : {}),
    releases,
  };
}

function search(recordings) {
  return { created: "2026-01-01T00:00:00.000Z", count: recordings.length, recordings };
}

const SOURCE = {
  TITLE: "Midnight Drive (Official Video)",
  ARTIST: "Nova Lane - Topic",
  ALBUM: "Midnight Drive (Official Video)",
  ALBUM_FALLBACK: 1,
  FETCHED_DURATION: 214,
};

function source(overrides = {}) {
  const vars = { ...SOURCE, ...overrides };
  return Object.entries(vars)
    .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`)
    .join("\n");
}

// ------------------------------------------------------------------- tests ---

test("a confident match fills the missing album, numbering, genre and date", (t) => {
  const h = harness(t);
  const res = lookup(
    h,
    source(),
    serve(h, search([recording({ tags: [{ count: 3, name: "synthpop" }] })])),
  );

  assert.equal(res.status, "matched");
  assert.equal(res.title, "Midnight Drive", "upload noise is dropped from the title");
  assert.equal(res.artist, "Nova Lane", "the '- Topic' uploader suffix is dropped");
  assert.equal(res.album, "Night Roads");
  assert.equal(res.albumFallback, "0");
  assert.equal(res.track, "3");
  assert.equal(res.trackTotal, "10");
  assert.equal(res.recordingId, RECORDING_ID);
  assert.equal(res.releaseId, RELEASE_ID);
  assert.equal(res.genre, "synthpop");
  assert.equal(res.fetchedDate, "19990504", "yt-dlp's YYYYMMDD date shape is kept");
});

test("a live or compilation release is not used as the album", (t) => {
  const h = harness(t);
  const res = lookup(
    h,
    source(),
    serve(h, search([recording({ releases: [release({ secondaryTypes: ["Live"] })] })])),
  );

  assert.equal(res.status, "matched");
  assert.equal(res.album, "Midnight Drive (Official Video)", "the source placeholder is kept");
  assert.equal(res.albumFallback, "1");
  assert.equal(res.releaseId, "", "release-level metadata is not applied");
  assert.equal(res.recordingId, RECORDING_ID, "the recording itself still matched");
  assert.equal(res.track, "", "a compilation's track numbering is meaningless here");
});

test("equally plausible releases are reported as ambiguous and change nothing", (t) => {
  const h = harness(t);
  const other = recording({
    id: "77777777-7777-4777-8777-777777777777",
    releases: [release({ id: "88888888-8888-4888-8888-888888888888", title: "Night Roads (Single)", primaryType: "Single" })],
  });
  const res = lookup(h, source(), serve(h, search([recording(), other])));

  assert.equal(res.status, "ambiguous");
  assert.equal(res.title, SOURCE.TITLE);
  assert.equal(res.artist, SOURCE.ARTIST);
  assert.equal(res.album, SOURCE.ALBUM);
  assert.equal(res.albumFallback, "1");
  assert.equal(res.recordingId, "");
  assert.equal(res.releaseId, "");
});

test("a track that is not in MusicBrainz keeps the source metadata", (t) => {
  const h = harness(t);
  const res = lookup(h, source(), serve(h, search([])));

  assert.equal(res.status, "unmatched");
  assert.equal(res.title, SOURCE.TITLE);
  assert.equal(res.artist, SOURCE.ARTIST);
  assert.equal(res.album, SOURCE.ALBUM);
  assert.equal(res.albumFallback, "1");
  assert.equal(res.recordingId, "");
  assert.ok(calls(h) >= 1, "the API failure-free empty answer is not an error");
});

test("a SoundCloud exclusive with no MusicBrainz entry falls back", (t) => {
  const h = harness(t);
  const unrelated = recording({
    id: "99999999-9999-4999-8999-999999999999",
    title: "Midnight Drive (Bootleg Remix)",
    artistCredit: "Some DJ",
    score: 42,
    length: 431000,
    releases: [
      release({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        title: "White Label Edits",
        status: "Bootleg",
        primaryType: "Album",
        secondaryTypes: ["Bootleg"],
      }),
    ],
  });
  const res = lookup(
    h,
    source({
      TITLE: "Midnight Drive (Exclusive Premiere)",
      ARTIST: "Some DJ",
      ALBUM: "Midnight Drive (Exclusive Premiere)",
    }),
    serve(h, search([unrelated])),
  );

  assert.equal(res.status, "unmatched");
  assert.equal(res.title, "Midnight Drive (Exclusive Premiere)");
  assert.equal(res.artist, "Some DJ");
  assert.equal(res.album, "Midnight Drive (Exclusive Premiere)");
  assert.equal(res.recordingId, "");
});

test("a real source album is never replaced by a different release", (t) => {
  const h = harness(t);
  const res = lookup(
    h,
    source({ ALBUM: "Night Roads (Deluxe)", ALBUM_FALLBACK: 0, TRACK: "7" }),
    serve(h, search([recording()])),
  );

  assert.equal(res.status, "conflict");
  assert.equal(res.album, "Night Roads (Deluxe)");
  assert.equal(res.albumFallback, "0");
  assert.equal(res.track, "7", "the source numbering is kept with the source album");
  assert.equal(res.releaseId, "");
  assert.equal(res.recordingId, RECORDING_ID);
  assert.equal(res.trackTotal, "");
});

test("existing tags are preserved and only gaps are filled", (t) => {
  const h = harness(t);
  const res = lookup(
    h,
    source({
      TITLE: "Midnight Drive",
      ARTIST: "Nova Lane",
      ALBUM: "Night Roads",
      ALBUM_FALLBACK: 0,
      TRACK: "7",
      FETCHED_DATE: "20240302",
    }),
    serve(h, search([recording({ firstReleaseDate: "1999-05-04" })])),
  );

  assert.equal(res.status, "matched");
  assert.equal(res.title, "Midnight Drive");
  assert.equal(res.album, "Night Roads");
  assert.equal(res.track, "7", "only a missing track number is filled");
  assert.equal(res.trackTotal, "10");
  assert.equal(res.releaseId, RELEASE_ID, "the album did match this release");
});

test("the same query is served from the cache", (t) => {
  const h = harness(t);
  const server = serve(h, search([recording()]));
  lookup(h, source(), server);
  lookup(h, source(), server);

  assert.equal(calls(h), 1, "the second lookup must not hit the API");
  assert.ok(existsSync(path.join(h.cache)), "the response is cached on disk");
});

test("--mb-refresh bypasses the cached response", (t) => {
  const h = harness(t);
  const server = serve(h, search([recording()]));
  lookup(h, source(), server);
  lookup(h, `${source()}\nMB_REFRESH=1`, server);

  assert.equal(calls(h), 2);
});

test("requests are at least one second apart", (t) => {
  const h = harness(t);
  const server = serve(h, search([recording()]));
  const started = Date.now();
  lookup(h, source({ TITLE: "First Song" }), server);
  lookup(h, source({ TITLE: "Second Song" }), server);
  const elapsed = Date.now() - started;

  assert.equal(calls(h), 2);
  assert.ok(elapsed >= 950, `two requests took ${elapsed}ms, expected >= 1000ms`);
});

test("a 429 is retried after the Retry-After delay", (t) => {
  const h = harness(t);
  writeFileSync(path.join(h.mock, "attempt-1.code"), "429");
  writeFileSync(
    path.join(h.mock, "attempt-1.headers"),
    "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 1\r\n\r\n",
  );
  const started = Date.now();
  const res = lookup(
    h,
    source(),
    serve(h, search([recording()]), { MUSICBRAINZ_RETRIES: "2" }),
  );
  const elapsed = Date.now() - started;

  assert.equal(res.status, "matched");
  assert.equal(res.recordingId, RECORDING_ID);
  assert.equal(calls(h), 2);
  assert.ok(elapsed >= 1000, `Retry-After of 1s was not honoured (${elapsed}ms)`);
});

test("API failures fall back to the source metadata and stop after the retry budget", (t) => {
  const h = harness(t);
  const res = lookup(
    h,
    source(),
    serve(h, search([recording()]), { FAKE_CODE: "500", MUSICBRAINZ_RETRIES: "2" }),
  );

  assert.equal(res.status, "failed");
  assert.equal(res.recordingId, "");
  assert.equal(res.title, SOURCE.TITLE);
  assert.equal(res.album, SOURCE.ALBUM);
  assert.equal(calls(h), 2, "bounded retries");
});

test("offline (curl cannot connect) is not an error", (t) => {
  const h = harness(t);
  const res = lookup(
    h,
    source(),
    serve(h, search([recording()]), { FAKE_CODE: "000" }),
  );

  assert.equal(res.status, "failed");
  assert.equal(res.album, SOURCE.ALBUM);
});

test("the configured User-Agent is sent with every request", (t) => {
  const h = harness(t);
  lookup(h, source(), serve(h, search([recording()])));

  const sent = readFileSync(path.join(h.mock, "agents.log"), "utf8").trim().split("\n");
  assert.deepEqual(sent, [USER_AGENT]);
});

test("Lucene special characters are escaped and upload noise is searched away", (t) => {
  const h = harness(t);
  lookup(
    h,
    source({ TITLE: "AC/DC: Live (Official Video)", ARTIST: "AC/DC" }),
    serve(h, search([recording()])),
  );

  const data = readFileSync(path.join(h.mock, "data.log"), "utf8");
  assert.ok(data.includes('recording:"AC\\/DC\\: Live"'), data);
  assert.ok(data.includes('artist:"AC\\/DC"'), data);
  assert.ok(!data.includes("Official Video"), data);
  assert.ok(data.includes("inc=releases+artist-credits+tags+media"), data);
});

test("--no-mb skips the lookup entirely", (t) => {
  const h = harness(t);
  const res = lookup(h, source(), serve(h, search([recording()])), { enabled: 0 });

  assert.equal(res.status, "");
  assert.equal(res.title, SOURCE.TITLE);
  assert.equal(res.album, SOURCE.ALBUM);
  assert.equal(calls(h), 0);
});

test("--mb-report lists what happened to every track", (t) => {
  const h = harness(t);
  const report = path.join(h.dir, "report.tsv");
  const body = `
source ${JSON.stringify(SCRIPT)}
TMP_DIR=${JSON.stringify(h.tmp)}
MB_REPORT_FILE=${JSON.stringify(report)}
HAVE_JQ=1
MB_ENABLED=1
JSON=0
${source()}
ENTRY_NUM=2
musicbrainz_lookup
`;
  const res = spawnSync("bash", ["-c", body], {
    env: env(h, serve(h, search([recording()]))),
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr);

  const rows = readFileSync(report, "utf8").trim().split("\n").map((l) => l.split("\t"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0][0], "matched");
  assert.equal(rows[0][1], "97.5");
  assert.equal(rows[0][2], RECORDING_ID);
  assert.equal(rows[0][3], "2");
  assert.equal(rows[0][4], "Midnight Drive");
});

test("a matched track is tagged end to end without touching the audio", (t) => {
  if (!have("ffmpeg", ["-version"]) || !have("ffprobe", ["-version"]) || !have("jq")) {
    t.skip("ffmpeg, ffprobe and jq are needed for the end-to-end run");
    return;
  }
  const h = harness(t);
  const tone = path.join(h.dir, "tone.flac");
  const made = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=5", tone],
    { stdio: "ignore" },
  );
  assert.equal(made.status, 0, "could not generate the test tone");

  const music = path.join(h.dir, "music");
  const res = spawnSync(
    SCRIPT,
    [
      "-y",
      "--output-format",
      "flac",
      "--out",
      music,
      "--session-dir",
      path.join(h.dir, "session"),
      "https://example.invalid/watch?v=e1",
    ],
    {
      cwd: h.dir,
      env: env(h, {
        ...serve(h, search([recording({ length: 5000, tags: [{ count: 3, name: "synthpop" }] })])),
        AUDIODL_SOURCE_ONLY: "0",
        TONE_FILE: tone,
        MUSICBRAINZ_MIN_INTERVAL: "0.2",
      }),
      encoding: "utf8",
    },
  );
  assert.equal(res.status, 0, res.stderr);

  const file = path.join(music, "Nova Lane", "Night Roads", "Midnight Drive.flac");
  assert.ok(existsSync(file), `expected ${file}\n${res.stdout}\n${res.stderr}`);

  const probe = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format_tags", "-of", "default=nw=1", file],
    { encoding: "utf8" },
  );
  const tags = Object.fromEntries(
    probe.stdout
      .trim()
      .split("\n")
      .map((l) => l.replace(/^TAG:/, "").split("="))
      .map(([k, ...v]) => [k, v.join("=")]),
  );

  assert.equal(tags.album, "Night Roads");
  assert.equal(tags.artist, "Nova Lane");
  assert.equal(tags.title, "Midnight Drive");
  assert.equal(tags.track, "3/10");
  assert.equal(tags.genre, "synthpop");
  assert.equal(tags.date, "1999-05-04");
  assert.equal(tags.MUSICBRAINZ_TRACKID, RECORDING_ID);
  assert.equal(tags.MUSICBRAINZ_ALBUMID, RELEASE_ID);
  assert.ok(res.stdout.includes("Matched      1"), res.stdout);
  assert.equal(calls(h), 1);
});

test("the tag writer adds MBIDs to Opus and MP4 and keeps the existing tags", (t) => {
  if (!have("ffmpeg", ["-version"])) {
    t.skip("ffmpeg is needed to build the test containers");
    return;
  }
  if (!have("python3", ["-c", "import mutagen"])) {
    t.skip("mutagen is not installed for python3");
    return;
  }
  const h = harness(t);
  const payload = `
source ${JSON.stringify(SCRIPT)}
MB_RECORDING_ID=rec-1
MB_RELEASE_ID=rel-1
MB_RELEASE_GROUP_ID=rg-1
MB_ARTIST_ID=art-1
MB_ALBUM_ARTIST_ID=albart-1
MB_TRACK_ID=trid-1
MB_TRACK_TOTAL=9
TRACK=3
MB_DISC_NUMBER=1
MB_DISC_TOTAL=1
tag_musicbrainz "$1"
`;

  for (const [ext, codec] of [
    ["opus", "libopus"],
    ["m4a", "aac"],
  ]) {
    const file = path.join(h.dir, `tagged.${ext}`);
    const made = spawnSync(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
        "-c:a", codec, "-metadata", "artist=Existing Artist", "-metadata", "title=Existing Title",
        file,
      ],
      { stdio: "ignore" },
    );
    assert.equal(made.status, 0, `could not build ${ext}`);

    const ran = spawnSync("bash", ["-c", payload, "_", file], { env: env(h), encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);

    const read = spawnSync(
      "python3",
      [
        "-c",
        `import sys
from mutagen.mp4 import MP4
from mutagen.oggopus import OggOpus

def clean(v):
    if isinstance(v, list):
        v = v[0]
    if isinstance(v, bytes):
        v = v.decode("utf-8", "replace")
    return str(v)

p = sys.argv[1]
a = MP4(p) if p.endswith(".m4a") else OggOpus(p)
vals = {k.split(":")[-1].lower(): v for k, v in a.tags.items()}
print(clean(vals.get("musicbrainz track id") or vals.get("musicbrainz_trackid")))
print(clean(vals.get("musicbrainz album id") or vals.get("musicbrainz_albumid")))
print(clean(vals.get("\\xa9art") or vals.get("artist")))
print(clean(vals.get("\\xa9nam") or vals.get("title")))`,
        file,
      ],
      { encoding: "utf8" },
    );
    assert.equal(read.status, 0, read.stderr);
    const [trackId, albumId, artist, title] = read.stdout.trim().split("\n");
    assert.equal(trackId, "rec-1", `${ext} MBID`);
    assert.equal(albumId, "rel-1", `${ext} release MBID`);
    assert.equal(artist, "Existing Artist", `${ext} kept the existing artist`);
    assert.equal(title, "Existing Title", `${ext} kept the existing title`);
  }
});

test("an unmatched track is tagged with its source metadata and no MBIDs", (t) => {
  if (!have("ffmpeg", ["-version"]) || !have("ffprobe", ["-version"]) || !have("jq")) {
    t.skip("ffmpeg, ffprobe and jq are needed for the end-to-end run");
    return;
  }
  const h = harness(t);
  const tone = path.join(h.dir, "tone.flac");
  spawnSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=5", tone],
    { stdio: "ignore" },
  );

  const music = path.join(h.dir, "music");
  const res = spawnSync(
    SCRIPT,
    [
      "-y",
      "--output-format",
      "flac",
      "--out",
      music,
      "--session-dir",
      path.join(h.dir, "session"),
      "https://example.invalid/watch?v=e1",
    ],
    {
      cwd: h.dir,
      env: env(h, {
        ...serve(h, search([])),
        AUDIODL_SOURCE_ONLY: "0",
        TONE_FILE: tone,
        MUSICBRAINZ_MIN_INTERVAL: "0.2",
      }),
      encoding: "utf8",
    },
  );
  assert.equal(res.status, 0, res.stderr);

  const file = path.join(
    music,
    "Nova Lane - Topic",
    "Midnight Drive (Official Video)",
    "Midnight Drive (Official Video).flac",
  );
  assert.ok(existsSync(file), `expected the source layout, got:\n${res.stdout}`);
  const probe = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format_tags", "-of", "default=nw=1", file],
    { encoding: "utf8" },
  );
  assert.doesNotMatch(probe.stdout, /MUSICBRAINZ/);
  assert.match(probe.stdout, /TAG:title=Midnight Drive \(Official Video\)/);
  assert.match(res.stdout, /Unmatched    1/);
});

test("the artist credit is stripped from titles and albums without case", (t) => {
  const h = harness(t);
  const body = `
source ${JSON.stringify(SCRIPT)}
strip_artist_name "DAFT PUNK - One More Time" "Daft Punk"
printf '\\n'
strip_artist_name "DAFT PUNK - Discovery" "Daft Punk"
printf '\\n'
strip_artist_name "One More Time - Daft Punk" "Daft Punk"
printf '\\n'
strip_artist_name "daft punk: One More Time" "Daft Punk"
printf '\\n'
strip_artist_name "Daft Punker - One More Time" "Daft Punk"
printf '\\n'
strip_artist_name "Daft Punk" "Daft Punk"
`;
  const res = spawnSync("bash", ["-c", body], { env: env(h), encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(res.stdout.trimEnd().split("\n"), [
    "One More Time",
    "Discovery",
    "One More Time",
    "One More Time",
    "Daft Punker - One More Time",
    "Daft Punk",
  ]);
});

test("an all-caps artist still matches MusicBrainz once the credit is removed", (t) => {
  const h = harness(t);
  const meta = [
    "DAFT PUNK",
    "DAFT PUNK - Discovery",
    "DAFT PUNK - One More Time",
    "DAFT PUNK",
    "20240302",
    "",
    "",
    "e1",
    "214",
  ].join("\x1f");
  writeFileSync(
    path.join(h.bin, "yt-dlp"),
    `#!/usr/bin/env bash\nprintf '%s\\n' '${meta}'\n`,
    { mode: 0o755 },
  );
  const body = `
source ${JSON.stringify(SCRIPT)}
TMP_DIR=${JSON.stringify(h.tmp)}
HAVE_JQ=1
MB_ENABLED=1
JSON=0
URL="https://example.invalid/watch?v=e1"
fetch_metadata >/dev/null 2>&1 || exit 1
musicbrainz_lookup
printf 'RESULT\\t%s\\t%s\\t%s\\t%s\\n' "$MB_STATUS" "$TITLE" "$ARTIST" "$ALBUM"
`;
  const res = spawnSync("bash", ["-c", body], {
    env: env(
      h,
      serve(
        h,
        search([
          recording({
            title: "One More Time",
            artistCredit: "Daft Punk",
            releases: [release({ title: "Discovery" })],
          }),
        ]),
      ),
    ),
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr);
  const line = res.stdout.split("\n").find((l) => l.startsWith("RESULT\t"));
  assert.ok(line, `no RESULT line in:\n${res.stdout}\n${res.stderr}`);
  assert.deepEqual(line.slice("RESULT\t".length).split("\t"), [
    "matched",
    "One More Time",
    "Daft Punk",
    "Discovery",
  ]);
});
