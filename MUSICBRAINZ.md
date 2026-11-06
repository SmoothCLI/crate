# MusicBrainz lookup

`dlAudio.sh` checks each track against [MusicBrainz](https://musicbrainz.org/)
before it is tagged, and fills in the metadata the download source did not
provide. It is on by default, uses the public API (`https://musicbrainz.org/ws/2/`),
and needs no account, API key or token.

The goal is to improve incomplete tags without inventing data: a match has to
agree with the title and artist that were actually downloaded, and a field that
already holds a real value is not replaced by a guess.

## Requirements

| Tool | Why |
|---|---|
| `curl` | the API request |
| `jq` | reading the JSON answer (already required by `--json`) |
| `python3` + `mutagen` | optional: MBIDs in M4A and Opus, which ffmpeg cannot write |

Without `curl` or `jq` the lookup disables itself with a warning and a download
behaves exactly as before. Without `mutagen`, M4A and Opus files keep all the
other tags but get no MBIDs (MP3 and FLAC get them from ffmpeg directly).

## What a match does

One search request is made per track, using the cleaned title (upload noise like
`(Official Video)`, `[HD]` or `(Lyrics)` is removed first) and the artist. If the
artist is an uploader name that matches nothing, one retry searches the title
alone. The request asks for releases, artist credits, media and tags.

Candidates are ranked with a score that combines:

- MusicBrainz's own relevance score,
- title similarity (exact, contained, or token overlap),
- artist similarity (the `- Topic` / `VEVO` suffix is ignored),
- duration (within 3 s is strong evidence, over 30 s is a red flag),
- album similarity when the source reported a real album,
- a small preference for official albums over compilations and live records.

The outcome is one of:

| Status | Meaning | Tags |
|---|---|---|
| `matched` | title and artist agree, duration does not contradict it | gaps filled, MBIDs added |
| `ambiguous` | two equally plausible recordings, or only a weak match | source metadata kept |
| `unmatched` | not in MusicBrainz, or nothing close enough | source metadata kept |
| `conflict` | matched, but the source album is a different real album | source album and numbering kept, recording MBID added |
| `failed` | network error or API error after the retry budget | source metadata kept |

On a **strong** match (score ≥ 80, same title, same artist) the canonical
MusicBrainz title and artist replace the extractor's spelling, and the release
date replaces the upload date. On an ordinary match only missing values are
filled.

Filled when missing or when the source had only a placeholder:

- album (only a plain official album/single/EP is used — never a greatest-hits
  or live record just because the track appears on one),
- album artist,
- track number, track total, disc number, disc total,
- year/release date,
- genre (from the recording's MusicBrainz genres, falling back to its most used
  community tag),
- `MUSICBRAINZ_TRACKID`, `MUSICBRAINZ_ALBUMID`, `MUSICBRAINZ_RELEASEGROUPID`,
  `MUSICBRAINZ_ARTISTID`, `MUSICBRAINZ_ALBUMARTISTID`,
  `MUSICBRAINZ_RELEASETRACKID`.

The writer for each container is the one the script already used: ffmpeg for
MP3 and FLAC, mutagen for Opus and M4A. Audio is never re-encoded by the lookup;
no cover art is downloaded, and the existing cover-art flow is untouched.

## What is never overwritten

- `--title`, `--artist`, `--album`, `--genre`, `--track`, `--date` and
  `--meta-json` overrides are applied after the lookup and always win. When an
  album override points at a different release, the release-level MBIDs are
  dropped so the file does not claim a release it is not in.
- A real source album that differs from the MusicBrainz release is kept, along
  with its track numbering.
- A track number that the source already reported is kept.
- An existing genre or date is kept unless the match is strong and the date was
  only the upload date.
- Ambiguous, unmatched and failed lookups do not change any tag.

## Options

```
--no-mb              turn the lookup off for this run
--mb-refresh         ignore the cached responses for this run
--mb-report FILE     write one line per track to FILE
```

`MUSICBRAINZ_LOOKUP=0` (or `no`, `off`, `false`) disables it from the
environment, which is easier inside a container.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `MUSICBRAINZ_LOOKUP` | `1` | `0` disables lookups |
| `MUSICBRAINZ_USER_AGENT` | `audioDL/<version>` | sent as the User-Agent; set a contact URL or e-mail |
| `MUSICBRAINZ_API` | `https://musicbrainz.org/ws/2` | API root, for a mirror/proxy |
| `MUSICBRAINZ_CACHE_DIR` | `<state dir>/musicbrainz` | response cache |
| `MUSICBRAINZ_CACHE_DAYS` | `30` | how long a cached response is used |
| `MUSICBRAINZ_MIN_INTERVAL` | `1` | seconds between requests; values below 1 are raised to 1 |
| `MUSICBRAINZ_TIMEOUT` | `15` | total request timeout, seconds |
| `MUSICBRAINZ_CONNECT_TIMEOUT` | `5` | connection timeout, seconds |
| `MUSICBRAINZ_RETRIES` | `3` | attempts for a retryable failure |
| `MUSICBRAINZ_MAX_WAIT` | `30` | longest Retry-After delay honoured, seconds |

The default User-Agent identifies the application but has no contact detail.
MusicBrainz asks every client to provide one; set `MUSICBRAINZ_USER_AGENT` to
something like `audioDL/3.1.0 ( https://example.com/audiodl )` before running
large batches.

## Rate limiting, caching and failures

MusicBrainz allows one request per second per IP address, and answers `429` or
`503` when that is exceeded.

- Requests are spaced by `MUSICBRAINZ_MIN_INTERVAL` (at least 1 s) using a
  timestamp and a short-lived lock in the cache directory. Playlist workers
  share it, so `--jobs 4` still makes one request per second in total. No
  requests are made in parallel.
- A successful response is cached for `MUSICBRAINZ_CACHE_DAYS` days and reused
  by later runs; `--mb-refresh` bypasses it. Negative answers (an empty result)
  are cached too, so a track MusicBrainz does not know is not queried on every
  run.
- A `429`, `503`, `5xx` or a network failure is retried with exponential
  backoff, or after the `Retry-After` delay when the server sends one, up to
  `MUSICBRAINZ_RETRIES` attempts and never longer than `MUSICBRAINZ_MAX_WAIT`.
- Any failure is reported as `failed` for that track and the download continues
  with the source metadata. No lookup error stops a batch. Offline operation is
  the same path.

## Summary and report

At the end of a run a short summary is printed:

```
 MusicBrainz
  Matched      2
  Kept source  1
  Ambiguous    1
  Unmatched    3
```

The tracks that were not a clean match are listed by title with their score.
`--mb-report FILE` writes the same information as TSV
(`status`, `score`, `recording id`, `entry`, `title`, `note`), which is handy
for fixing a playlist's leftovers afterwards.

In `--json` mode the lookup emits one extra event per track and one summary
event; the web queue ignores both:

```json
{"v":1,"event":"mb","i":1,"status":"matched","score":97,"recording_id":"...","release_id":"...","note":""}
{"v":1,"event":"mb_summary","matched":1,"ambiguous":0,"unmatched":0,"conflict":0,"failed":0}
```

## Limitations

- Only the search endpoint is used (one request per track), so genre comes from
  the recording's tags/genres in that response, and the chosen release is the
  best-scoring one MusicBrainz returned rather than a full release browse.
- `--inspect` and `--plan` never call MusicBrainz: previews stay offline and
  fast. A real run can therefore file a track under the album the lookup found.
- SoundCloud exclusives, unreleased tracks and bootlegs usually have no entry;
  they fall back to the source metadata, which is the intended behaviour.
- Files streamed with `--stream-fd` are not given MBIDs (the hand-written ID3
  tag in that path is unchanged), and WAV has no place for them.
- MusicBrainz data is community-maintained. A wrong match is possible when the
  source title and artist exactly match another recording; the duration and
  album checks make it unlikely, and `--no-mb` turns the feature off.

## Tests

```
node --test test/musicbrainz.test.mjs
```

The tests never touch the network: a stand-in `curl` serves fixed MusicBrainz
answers and records every request. They cover confident and ambiguous matches, a
track that is absent, a SoundCloud-style exclusive, conflicting and preserved
tags, caching, the one-request-per-second limit, `Retry-After`, API failures and
offline mode. Two end-to-end runs execute the real script with a stand-in
`yt-dlp` and check the written tags with `ffprobe`; the M4A/Opus MBID test runs
when `python3` has mutagen and is skipped otherwise.
