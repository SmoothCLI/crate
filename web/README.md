# Crate

A small self-hosted web UI and queue for `dlAudio.sh`, the yt-dlp + ffmpeg
audio downloader that sits next to it. The instance name is chosen on first run
and can be changed later; `Crate` is only the default. Paste a link, review what the downloader
found, fix tags, queue it. The script still does all the real work - probing,
path resolution, downloading, normalising and tagging - so files land in
`MUSIC_DIR/ARTIST/ALBUM/[NN - ]TITLE.<format>` exactly as they do from the terminal,
plus an `ALBUM.m3u8` beside them once a job finishes. An upload that carries no
album of its own is filed under its track name - `ARTIST/TITLE/TITLE.<format>` -
instead of a shared `Single` folder, while a playlist entry without an album
inherits the album already found for that batch when there is one.

Nobody meets a login wall: an unauthenticated visit becomes a **guest** session,
which only ever sees its own queue. Guest downloads are encoded on demand and
**streamed straight to that computer** - one file, or a ZIP assembled in the
browser for an album - so nothing is written to the library or left on the
server. The owner signs in from the **key button** in the header - icon only, so
it does not look like a login for the guest's own downloads - to write into the
library folder and change settings.

Settings are a page of their own at **/admin**: the gear in the header links
there for the owner. Guests see a small download-settings dialog from the same
icon instead - presets, format, LUFS, quality, cover art - and are sent back to
the queue if they open `/admin` directly.

`/admin` holds everything the owner can change, split into six tabs of a
vertical rail on desktop (a swipeable strip on a phone), each with its icon and
a one-line description: the tab lives in the URL hash, so `/admin#downloads` is
a real bookmark, and `/admin` alone reopens the last tab used in that browser.
**General** - instance name, public contact line, owner username and password;
**Guests** - whether guests may download at all, the daily limit per browser,
and the public tally of guest browsers and finished tracks (with **Reset
counter**);
**Downloads** - library root, format / LUFS / quality defaults, how many
downloads run at once and per source host;
**Sources** - the cookie jar for sites that only hand a track to a signed-in
session (see [Sign-in and cookies](#sign-in-and-cookies));
**Library** - a library overview (artists, albums, tracks, size, free space,
writability) and a short history of your own finished jobs (guest streams are
not listed);
**System** - the webhook (with **Send test notification**), diagnostics
(yt-dlp/ffmpeg versions, the script and Node versions, disk space, and **Update
yt-dlp**) and a settings backup you can download and import. Switching tabs keeps
every form mounted, so a half-edited field is not lost, and the save bar floats
at the bottom of the viewport on every tab. A dot beside a rail row's name marks
a tab with unsaved edits, and the bar reads *Unsaved changes* instead of
*Applies to the next download*, so nothing can be edited on one tab and
forgotten behind another.

The public page at **/contact** carries the instance name, an optional contact
line the owner sets at `/admin` (an email address or a link), a short note about
guest downloads, and a **Notice & takedowns** section: the installation is not
affiliated with yt-dlp, ffmpeg or the sites it downloads from, the person running
it decides what is kept, and rights holders should write to that contact address
rather than to the authors of those tools. Guest footers link to it.

The queue is pushed over a single Server-Sent Events connection (polling is the
fallback), several links can be pasted at once, an unfinished draft survives a
reload, and overwriting existing library files always asks first and names
them.

## Run

```sh
cd web
npm install
npm run build
AUDIODL_PASSWORD=choose-something node server/index.mjs
```

Then open `http://localhost:8080`. With no password stored yet, every page
redirects to **/setup**, where the owner names the instance, may add a public
contact line, and picks a username and a password; that also signs them in. Only a salted scrypt hash is kept, in
`data/settings.json` - the password itself is never written to disk or logged.
Change it later at `/admin`; if you lose it, see
[Losing the password](#losing-the-password).

For development, `npm run dev` starts both halves from the working tree:

```sh
npm run dev               # API on 8081, UI on http://localhost:5173
```

Edits under `src/` hot-reload in the browser and edits under `server/` restart
the API, so a change can be looked at before it is committed - this path never
builds an image or touches a release. The API takes 8081 rather than 8080
because the published container usually holds 8080 on the same machine; set
`AUDIODL_PORT` to move it, `AUDIODL_DATA` to use a throwaway data folder, and
`CRATE_UI_PORT` for the Vite port. The dev API listens on loopback and uses
`web/data`, seeded with the password `crate-dev`, so it starts signed in rather
than at the setup wizard. To run the halves yourself, use `npm run dev:api` and
`npm run dev:ui`.

## Subsonic API

A read-only subset of the Subsonic API (protocol 1.16.1) is served from `/rest`,
so a phone or desktop player can browse and stream the library without this UI.

`/admin → Subsonic API` has the switch, the server URL and two generated
credentials: an **API key** (send it as `apiKey=`, needs no username) and a
**Subsonic password** (use it with your username). Both can be regenerated
there, which signs out whatever used the old value. The web password works with
`u`/`p` too.

```text
Server    http://your-host:8099
Username  admin (or the username chosen at /setup)
Password  the Subsonic password from /admin
```

`ping`, `getMusicFolders`, `getIndexes`, `getArtists`, `getArtist`, `getAlbum`,
`getSong`, `getAlbumList2`, `search3`, `stream`, `download`, `getCoverArt`,
`getScanStatus` and `getLicense` are implemented; playlists and stars answer
empty and scrobbles are accepted and forgotten. Token authentication (`t`/`s`)
works against the Subsonic password, which is the one credential the server
stores; the web password stays a scrypt hash and is accepted by `u`/`p` only.
Track durations are measured with `ffprobe` and cached in `data/durations.json`.
Use HTTPS for anything beyond a trusted LAN. Both `/rest/name` and
`/rest/name.view` work, XML is the default and `f=json` gives JSON.

[`docs/subsonic.md`](../docs/subsonic.md) has the endpoint table, curl examples
and the limits worth knowing before pointing a player at it.

## Tests

```sh
cd web
npm test
```

The suite starts the real server against a temporary data folder and a stub
downloader, then drives setup, login (including the two-factor code step),
settings, the webhook, duplicate hints, the share shortcut, export/import, the
library and history routes, and the guest quota over HTTP. Nothing touches the
real `data/` or music library.

### Layout smoke tests

```sh
npx playwright install chromium   # once
cd web && npm run test:layout
```

The same two suites run on every push in `.github/workflows/check.yml`, offline:
a stand-in `yt-dlp` copies a generated tone, so nothing is downloaded from the
internet. `publish.yml` calls that workflow as its `test` job and the image job
needs it, so a failing check cannot produce a release.

A real browser at 390, 768 and 1440 px, against the built UI and a seeded
server. It asserts that nothing scrolls sideways, that the header's title and
controls do not overlap, and that no card or tab strip leaves the viewport on
every owner page, the guest queue and the sign-in card. The audit is itself
tested by forcing an overlap and expecting it to be reported.
There are no screenshot baselines on purpose - those break on font rendering and
need re-approving after every restyle. Build first (`npm run build`); this is a
separate command, so `npm test` stays fast and browser-free.

## Docker

From the folder that holds `dlAudio.sh` (one level above this one), the
published image is pulled:

```sh
docker compose up -d
```

To build the image from the checkout instead, for example while changing the
server or the UI:

```sh
docker compose -f compose.dev.yaml up --build
```

The image builds the UI, installs the latest `yt-dlp` release plus `ffmpeg`,
`jq` and `python3`, and runs the server as uid `1000` so files are not owned by
root. The UI is on **http://localhost:8099**.

On the first start, open **http://localhost:8099/setup** and choose the instance
name, the owner username and a password; the root and any other page redirects
there until one exists. Setting `AUDIODL_PASSWORD` in `.env` skips the form. The hash lands in
`./data/settings.json`:

The library is `/media/music` inside the container, bind-mounted from the host
folder named by `MUSIC_DIR` (the same path the script uses by default), and the
server's state sits next to `compose.yaml`:

| Path | Contents |
|---|---|
| `/media/music` → `/media/music` | The library the script writes into, mounted at the same path so paths in the UI match the host. |
| `./data` → `/app/data` | Settings (password hash), saved queue, per-job workspaces, guest preferences, guest tally. |

The defaults are overridable without editing anything, either on the command
line or in a `.env` file next to `compose.yaml`:

| Variable | Default | Meaning |
|---|---|---|
| `HOST_PORT` | `8099` | Host port to publish (8080 is often already taken). |
| `MUSIC_DIR` | `/media/music` | Host folder for the library, e.g. `/srv/music` or `./music`. |
| `DATA_DIR` | `./data` | Host folder for the server's state. |
| `PUID` / `PGID` | `1000` | Owner of the files that are written. |
| `AUDIODL_PASSWORD` | unset | Set the password from the environment instead of using /setup. Leave it empty afterwards - a changed value replaces the password and signs remembered devices out; an unchanged one is left alone. |
| `AUDIODL_GUEST` | `1` | `0` requires the password for all downloads. |

```sh
MUSIC_DIR=/srv/music docker compose up -d
```

A relative `MUSIC_DIR` counts from the folder holding `compose.yaml`; leave it
unset to use the system library.

If the library folder already has a different owner, set `PUID`/`PGID` to that
owner instead of changing the folder's permissions; the container logs a
warning at start when it cannot write there. `docker compose down` keeps both
folders; `docker compose up -d --build` rebuilds after pulling new code.

`yt-dlp` only needs the app: `/admin` → **Diagnostics** → **Update yt-dlp**
downloads the current release, checks that it runs, and puts it in
`data/bin/yt-dlp`, which is ahead of the copy baked into the image on the
script's `PATH`. It works without root, and the old binary is restored if the
new one fails.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `AUDIODL_PASSWORD` | unset (use /setup) | The one password that unlocks the owner view. |
| `AUDIODL_GUEST` | on | Set to `0` to require the password for all downloads. |

| `AUDIODL_CONCURRENCY` | `2` | Initial jobs that may run at once; `/admin` overrides it. |
| `AUDIODL_PER_HOST` | `2` | Initial cap per source host; `/admin` overrides it. |
| `AUDIODL_WEBHOOK` | none | Initial webhook URL; changeable at `/admin`. |
| `AUDIODL_PORT` | `8080` | HTTP port. |
| `AUDIODL_HOST` | `0.0.0.0` | Bind address; use `127.0.0.1` to stay local-only. |
| `AUDIODL_DATA` | `web/data` | Settings, saved jobs, per-job session workspaces. |
| `AUDIODL_BIN` | `../dlAudio.sh` | Path to the downloader script. |
| `MUSIC_DIR` | `/media/music`, else `~/Music` | Initial library root (changeable at `/admin`). |
| `MUSICBRAINZ_USER_AGENT` | `audioDL/<version>` | Sent to MusicBrainz; set a contact URL or e-mail. |

## How it talks to the script

- `dlAudio.sh --inspect URL` - one JSON object: playlist or single, every entry
  with title and duration, the metadata defaults, and the resolved default paths.
- `dlAudio.sh --plan ...` - the same, but for the entries and overrides the form
  currently holds, including which target files already exist.
- `dlAudio.sh --json ...` - NDJSON events on stdout (`job`, `track`, `stage`,
  `summary`, `error`) with human output on stderr. The server turns those into
  the per-track stage chips in the queue.

Per-track edits are passed as `--meta-json` (keyed by 1-based entry), so one
process still handles the whole batch. Each job gets its own `--session-dir`,
which is what makes an interrupted download resumable from the Retry button.
The container is passed as `OUTPUT_FORMAT` (or `--output-format`), so the
script's filename, tagger and `.m3u8` writer all follow it. Guest downloads use
`--stream-fd 3`: the script writes the encoded audio to descriptor 3 while JSON
events stay on stdout, and the server pipes that descriptor to the response.
Nothing is written to `MUSIC_DIR`, the import index or a staging folder; the
script's temp workspace is deleted when the transfer ends.

## Formats

Settings holds a default format; every job can override it in the review card
(alongside quality), and the choice is stored per job so Retry keeps it.

| Format | Codec | Quality knob | Cover art |
|---|---|---|---|
| `m4a` (default) | AAC | `-q:a` 1–5 | embedded |
| `mp3` | LAME VBR | 1–5 mapped to V0/V2/V4/V5/V7 | embedded (ID3v2.3) |
| `flac` | FLAC, `-compression_level 8` | ignored | embedded |
| `opus` | libopus, 48 kHz | bitrate step 160k→64k | embedded by mutagen |
| `wav` | PCM 16-bit | ignored | no (WAV takes no picture stream) |

The queue shows each job's cover art at 36 px, loaded from the source's URL
(the job stores the link, not a copy), falling back to the first letter when the
source sent no artwork or the image fails.

Cover art is resized to `ARTWORK_SIZE` (1000 px longest side) and re-encoded as
JPEG. ImageMagick is used when it is installed, otherwise ffmpeg does the same
job, so cover art does not depend on `magick`/`convert` being present - for
example in the container image, which ships ffmpeg only.

Lyrics are looked up on [LRCLIB](https://lrclib.net/) after the title, artist and
album are known, and embedded as plain text when found: `USLT` for MP3, `©lyr`
for M4A, `LYRICS` for FLAC and Opus. Synced lyrics are flattened to plain text,
because those tags cannot carry timestamps; WAV has nowhere to put them, and
guest streams skip the lookup since nothing is written to disk. `--no-lyrics`
turns it off, a missing or busy service never fails a download, and a failed
tag write is a warning rather than a lost track.

Before tagging, each track is checked against [MusicBrainz](https://musicbrainz.org/)
and only missing values (album, track/disc numbering, year, genre) and MBIDs are
filled from a match that agrees with the source title and artist; uncertain or
absent matches keep the source metadata. The queue inherits this, so a job can
end up in a different folder than the review card showed. `--no-mb` turns it
off, `--mb-report FILE` keeps a per-track log, and the run ends with a short
matched/ambiguous/unmatched summary. See [MUSICBRAINZ.md](../MUSICBRAINZ.md) for
the matching rules, cache and rate limits.

Every file also carries ReplayGain track values, measured from the loudnorm
analysis the encoder was already running: `REPLAYGAIN_TRACK_GAIN`,
`REPLAYGAIN_TRACK_PEAK` and `REPLAYGAIN_REFERENCE_LOUDNESS`. The gain is relative
to the run's own target (the same LUFS the encoder aimed at, `-9` by default), so
a player set to that reference plays the library exactly as it was written while
one with a different reference still gets an honest number for the file. MP3 and
FLAC are tagged by ffmpeg, M4A gets freeform atoms and Opus Vorbis comments from
mutagen (so those two need it installed), and WAV has nowhere to put them.
`--one-pass` and a guest stream measure nothing and write none; `--no-replaygain`
turns them off. Album gain and `R128_TRACK_GAIN` are deliberately absent: album
gain would need every track of the album measured before the first file is
tagged, and R128 is defined against `-23` LUFS, so writing it beside a `-9`
reference would make Opus play 14 dB quieter than the rest of the library.

A source that names a collaboration in one artist field - `Ruppi van Daline， LuuZz`,
`A, B`, `A; B` - is written as an artist **list**, so players show two artists
instead of one name with a comma in it: repeated `ARTIST` comments for FLAC and
Opus, several `©ART` atoms plus the `ARTISTS` freeform tag for M4A, and several
values in `TPE1` for MP3
(ID3v2.3's `/` separator). Commas (ASCII or full-width), semicolons and `、` split
the names, each is trimmed and duplicates are dropped. The album artist gets the
same list (`ALBUMARTIST` comments, several `aART` atoms, several `TPE2` values),
so Jellyfin lists every credited artist under **Album Artists** instead of one
joined `A & B` entry. The library folder is named after
the **main artist** - the first credited one - so a source's `Fabitekk， Schillah，
Luzzifer` is filed as `MUSIC_DIR/Fabitekk/Outlaw Gasmaske/`, which is what the
review card's **Saves to** line shows. The rest of the names live in the tags and
in the queue label, not in a second folder. Files that are already on disk keep
their folder. WAV is the exception: its `LIST INFO` chunk
holds a single value, so the whole string stays. The list is written by mutagen
after ffmpeg, so on a host without it the artist stays one string (with a
warning).

Quality is one 1–5 step for every format: literal `-q:a` for AAC, the LAME
equivalent for MP3 (a much finer 0–9 scale underneath) and a bitrate step
(160k→64k) for Opus. FLAC and WAV ignore quality. `wav` writes its tags as a
`LIST INFO` chunk, which most taggers read; players that only understand ID3
will show nothing.

Opus is **owner-only**: ffmpeg's Ogg muxer writes no comments and cannot mux a
picture stream, so the tags and cover are written afterwards by
[mutagen](https://mutagen.readthedocs.io/) (`python3-mutagen`, installed in the
image). That also means Opus cannot be streamed - a pipe cannot be reopened to
add tags - and the script refuses `--output-format opus` with `--stream-fd`.
On a host without mutagen it exits with the install command instead of writing
an untagged file.

Guest jobs run with `XDG_STATE_HOME` pointed at `data/guest-state`, so they
never write into the library or mark a library track as already imported, and
their `-o` folder is a scratch path. Finished owner files can be pulled through
`GET /api/jobs/:id/file/:i` (owner only, and only for paths inside the library);
guests use `GET /api/jobs/:id/stream/:i`, which encodes on demand.

A streamed response has no `Content-Length`, so there is no percentage to show.
Instead the server counts the bytes it has written and reports them on the job
(`tracks[i].size`), and the queue shows the running total with the transfer
rate plus a sparkline of the last second-by-second samples. For that to be live
the encoder must not buffer the whole file: piped MP4 is fragmented every second
(`-frag_duration`), and every format flushes packets (`-flush_packets 1`) instead
of waiting for a full buffer.

Fragmented MP4 normally has nowhere to put cover art, so the stream uses
`+delay_moov` rather than `+empty_moov`: the muxer waits for the first fragment,
then writes a `moov` that includes the `covr` atom (players and Jellyfin read
that). The trade-off is a placeholder video track in the file, which players
ignore. Library files are written non-fragmented with `+faststart`, so they get
the `covr` atom and no placeholder track.

The script also reports ffmpeg's position in the song as `encode` stage
percentages, which the queue turns into a time remaining.

Owner downloads are files on the machine, so nothing on the server can count
them: the page fetches each track itself, meters the bytes as they arrive
(`saving 3.5 MB of 18 MB · 1.4 MB/s`, with the same sparkline and a real
percentage from `Content-Length`), and hands the result to the browser as a
blob. A guest's single track still goes straight through the browser's own
download manager - the server counts those bytes.

## The queue

`GET /api/stream` is an event stream: a `jobs` snapshot on connect, a `job`
object whenever one changes (progress ticks coalesced to about four per
second), and `remove` when a job is deleted. Each connection only receives jobs
it is allowed to see. If the stream cannot be established - no `EventSource`,
or a proxy that buffers responses - the client falls back to polling
`/api/jobs` every 1.5 s. For nginx, `proxy_buffering off;` (or the
`X-Accel-Buffering: no` header the server already sends) keeps events flowing.

The queue survives a restart. On boot, owner jobs that were running or waiting
are put back in the queue (`jobs.json` is rewritten before anything is spawned)
and started once the server is listening; the downloader skips tracks already on
disk, so only the missing ones are fetched again. A track that was half-written
when the process died still counts as present, so that one file may need a
retry. Guest stream jobs are not resumed: their browser session is gone, and
they are closed with *The guest session ended before this finished.*

## Parallel downloads, playlists and notifications

**The queue.** *Downloads at once* and *Per source host* at `/admin` (1–8 and
1–that number). The queue starts the next job as soon as one finishes, and skips
a job whose site is at its limit to start a later one instead. A fresh install
can be seeded from `data/config.json` or the environment:

```json
{ "concurrency": 2, "perHost": 2 }
```

- `concurrency` - initial number of jobs that may run at the same time (1–8,
  default 2).
- `perHost` - initial number of those that may hit the same source host
  (1–`concurrency`, default 2), so a five-track playlist does not open five
  connections to one site and get rate-limited.

**The webhook**, set at `/admin` (owner-only): paste a URL to add or replace it,
press *Remove* to clear it. One message is sent per finished job. The body is
shaped for the service behind the URL:

- **Discord** (a `discord.com` or `discordapp.com` URL) gets one embed: the
  source site as a small author line above the title, the title linking back to
  the source, the artist (and the album, playlist or error) underneath, then
  *Tracks* and *Format* as two inline fields, the cover art as a thumbnail and
  `Crate · library` in the footer. The stripe is green when everything saved,
  amber when some tracks were skipped or failed, red when the job failed - in
  which case the error takes the place of the count when nothing was saved.
- **Slack** (`hooks.slack.com`) gets a header, a section and one context line.
- **Anything else** (ntfy, a script) keeps a plain `{"content": "…"}` body with
  the same information as text.

Mentions are disabled in every case, so a track called `@everyone` cannot ping a
server. A checkbox decides whether guest downloads are reported too.

There is also a **Send test notification** button next to the field, so the
webhook can be checked without waiting for a job.

The URL lives in `data/settings.json`, is used only by the server, and is never
sent back to the browser - the page is told only whether one exists and which
host it points at. A Discord webhook URL is a credential, so treat the settings
file like the password hash. `data/config.json` (`webhook.url`, `webhook.guest`)
and `AUDIODL_WEBHOOK` only seed the value on the first start; removing a webhook
at `/admin` is not undone by either, and an empty value there leaves a stored
webhook alone.

`data/config.json` is read once at start, `chmod 600`, and never returned by an
API or bundled into the UI; `data/` is in `.gitignore`. `AUDIODL_CONCURRENCY`,
`AUDIODL_PER_HOST` and `AUDIODL_WEBHOOK` do the same job as environment
variables when you would rather not keep a file.

Each finished owner job also writes an **album playlist** next to the files:
`ARTIST/ALBUM/ALBUM.m3u8`, listing every audio file in that folder with
`#EXTINF` durations where they are known. It is built from the folder, so
tracks that were skipped because they already existed are included, and a
playlist that spans several albums gets one `.m3u8` per album folder.

## Guest downloads

- **Nothing is stored.** Each track is encoded the moment the guest asks for it
  and streamed to the browser, so there is no staged file to expire and no
  server-side archive to build. The temp download is removed when the transfer
  ends (or is killed if the browser disconnects).
- **Preferences** live on the guest's session, never in `settings.json`: three
  presets - *Phone* (m4a q3, −11 LUFS), *Small* (m4a q5, −14 LUFS) and
  *Lossless* (flac, −14 LUFS) - plus an advanced set of format, quality, target
  LUFS and cover-art controls. A guest sees only their own values, and they are
  gone when the session ends. Per-job changes in the review card still win.
- **One at a time.** A second simultaneous download from the same guest gets
  `429`; queued-but-not-downloaded jobs are capped at **20** and do not count
  towards the running-job limit, since they cost nothing until fetched.
- **ZIP in the browser.** An album is fetched one track at a time and packaged
  with `fflate` in the page, so the server never buffers an archive. There is no
  `Content-Length`, so the browser shows an indeterminate progress bar and a
disconnected download has to start over from that track.
- A streamed **FLAC** has no total-sample count in its `STREAMINFO` (a pipe
  cannot be seeked back to patch it), so some players show an unknown duration
  until the file has fully arrived. Streamed WAV files carry no cover art.
- **Public tally.** A single line under the queue reads like *12 guests have
  downloaded 340 songs*: the number of distinct browsers that have finished at
  least one stream, and how many tracks they pulled between them. It lives in
  `data/stats.json` (`tracks` plus the opaque guest ids the quota already uses) and
  is served by `/api/me`, so guests and the owner see the same numbers. A track
  counts once, when its transfer finishes; a re-download or a retry does not add
  to it, and the owner's own downloads never touch it. Deleting the file resets
  the line, and **Reset counter** at `/admin#guests` zeroes it deliberately - the
  per-browser daily quota lives in a different file, so a reset never lifts a
  limit.

## Guest limits

Guest access is convenient but unauthenticated, so it is bounded:

- **one transfer at a time** per guest session (`429` for a second), and at most
  **20** unfinished downloads in a guest's list;
- an optional **daily quota** (`/admin#guests` → *Downloads per day, per
  browser*, 0 = no limit) counted per browser and per calendar day in
  `data/guest-quota.json`. The guest footer shows how many are left; the next
  queue attempt gets `429` until the day rolls over;
- a **master switch**. With it off, the sign-in form drops *Continue as guest*,
  a guest session that was already open stops resolving: the browser lands on
  the sign-in form, and any request it still makes is refused with `403` and
  *Guest access has been turned off, so guest downloads are paused…* rather than
  a bare *Not signed in*. A download click on an open queue checks first and says
  the same in a dialog, instead of letting the browser save the refusal as  a broken audio file. Their open queue connections are closed at the same
  moment, which moves an open guest tab to the sign-in form without a reload,
  and any stream still encoding is stopped with *Guest access was turned off
  while this was streaming.* Only the owner gets in.
  While the owner is signed in, the queue shows a quiet *Guests are blocked* note
  linking straight back to `/admin#guests`, so the instance cannot stay locked
  by accident;
- only **public internet targets**: `localhost`, private ranges (10/8, 172.16/12,
  192.168/16, 100.64/10, link-local incl. cloud metadata) and names resolving
  to them are refused with `403`. The owner is not restricted.
- nothing is stored, so there is no disk to bound; each transfer's temporary
  download is deleted when it ends.

The address check happens before yt-dlp runs, on the host the link names. A
redirect or a site whose own media host is internal is still followed by the
extractor, so this is a guard rail against port scanning, not a sandbox.

## Duplicate hints and sharing links

- **Possible duplicates** - in the review card, the owner sees tracks whose
  title (after dropping `(Official Video)`, `[HD]`, `feat. …`, punctuation and
  case) already appears in the library or in `data/history.json`, with the file
  that matches. A playlist gets a **Deselect them** button; a single track just
  gets the warning. Guests never receive these hints, and the comparison is
  exact after normalisation - a live version or a cover is a different title.
- **The same upload is never written twice** - the script keeps an import index
  of what it has downloaded, keyed by the source's own id, so a track that is
  already in the library is recognised even after its folder was renamed or a
  MusicBrainz match moved it. The plan reports that copy (`duplicate`), so the
  review card lists it as an already-downloaded match and leaves the entry out
  of the selection; a run that still reaches it says *Already downloaded,
  skipping* and the queue row shows **duplicate · skipped** with the file it
  found. `--force` (the queue's **Overwrite** choice) writes the second copy
  anyway, and a track that is merely moved between formats still replaces the
  old file instead of being skipped.
- **Share shortcut** - `http://host/https://soundcloud.com/artist/track` redirects
  to the app with the link already in the composer and inspected, so a full URL
  can be handed out behind a short host name. The query is dropped after it is
  used, so a reload does not inspect twice.
- **Phone share sheet** - the manifest declares a `share_target`, so on Android
  Chrome "Share → Crate" posts the link to `/share` and the review card opens
  with it. Safari has no share target, so iOS uses a Shortcut instead: *Get URLs
  from Input* → *Open URLs* with `https://host/share?url=<the shared URL>`, added
  to the share sheet. Both routes only redirect - `/share` answers 400 when the
  shared text carries no link.

## Overwriting

Choosing **Overwrite** and pressing Download opens a confirmation listing every
library file that will be replaced, with a final count; nothing is queued until
that is confirmed. Skipping is the default and never asks.

## Library health and audio duplicates

Both live in `/admin#library`, are owner-only, and never involve guests: a guest
may download whatever they like, twice, and nothing on these screens changes
that.

- **Library health** - one walk of the folder (no tag reads) counting what is
  structurally wrong: folders with no audio anywhere below them, audio files
  outside `ARTIST/ALBUM/`, folders nested below an album, albums where only some
  files carry the `NN - ` prefix, and finished jobs whose file has since
disappeared. **Clean up…** removes the empty folders, deepest first, and only
  after re-checking each one is still empty on the server - a folder that filled
  up between the scan and the click is left alone. The other findings are shown
  with their paths; moving files around is left to you.
- **Same audio twice** - titles lie, so `fpcalc` (chromaprint, from
  `libchromaprint-tools` in the image) fingerprints the audio itself: two copies
  of one recording share almost every number even when tags, bitrate and
  filename differ. **Scan the library** measures in slices (12 files per request)
  so the page stays responsive and shows progress; results are cached in
  `data/fingerprints.json` keyed by path, size and mtime, so only new or changed
  files are read on the next scan. A group is two files whose prints overlap by
  at least 55% and whose lengths are within 3% (plus 3 seconds) of each other;
  the largest file is listed first. **Delete** is per file and asks once - the
  path must resolve inside the library and still be audio, checked server-side.
  Deleting a file drops it from the cache; the empty folder it leaves behind is
  what the health screen cleans up.

## Browsing the library

`/library` is the owner's view of what the downloads actually produced - the
folder itself, not a list of jobs. The header carries the disc icon on the queue
page; a guest who opens the address is sent back to the queue, and the API
answers 403 for every request behind it.

The page reads the layout rather than the tags. `ARTIST/ALBUM/[NN - ]TITLE.ext`
is what the downloader writes, so a walk is enough to name, group and size every
file, and a listing can never disagree with the paths on disk. Three levels are
walked (so an artist and its albums), the walk stops at 50,000 files and says so,
and it is cached for 20 seconds - searching fires a request per pause in typing
and must not re-stat a large library each time. The cache also checks the root
folder's own mtime, so an artist folder that appeared since the last walk (a
download landing in a new folder) shows up on the next look instead of up to 20
seconds later.

- **Search** matches any words against `artist album title` together, so `aphex
  ambient` narrows the list rather than widening it, and at most 200 rows come
  back with the true match count beside them.
- **Sorting** happens on the server, because the page only ever holds one
  artist, one album or one page of results: album order (the numeric prefix),
  title, artist, album, recently added, or largest first.
- **Covers** come from the album folder - a `cover`, `folder`, `front`, `album`,
  `albumart` or `artwork` image beside the tracks, or the picture embedded in the
  first audio file, extracted with ffmpeg and cached under the data folder. That
  is deliberately not tied to this app's download log, so a file copied into the
  library by hand still shows its art. A folder with no picture simply has none.
- **Artists and albums** are the folder names, sorted by name; a file that sits
  directly in the library root or in an artist folder is filed under *Unknown
  album*, and one outside the two-level layout under *Unknown artist*, so
  nothing is hidden because of where it landed.
- **Playback** streams the file with HTTP `Range`, so the browser can scrub and
  starts before the whole file is read. Only the owner may ask for it, only audio
extensions are served, and the resolved path must sit inside the music folder -
  a path outside it is a 404, not a file.
- **The player bar** is Crate's own, not the browser's `<audio controls>`: the
  cover, previous/play/next, a seek slider with the elapsed and total time, a
  mute button and a volume slider, all driving a hidden `<audio>`. The native
  controls change height and shade in every browser and cannot show the album
  art, which is most of what the bar is for. Volume and mute are remembered per
  browser (`localStorage`, like the palette), and the bar listens for Space to
  play or pause and the arrow keys to skip - except while the cursor is in a
  text field, where Space is just a space.
- **The queue** is whatever list play was pressed on: next, previous and the end
  of a track move through it, so an album plays straight through. Searching on
  while it plays does not cut it off - the queue is a snapshot of the list from
  when it started.

The header's **Health** link jumps to `/admin#library`, where the structural
findings and the duplicate scanner live.

## Working in the UI

- **Several links at once** - pasting or dropping a block of links inspects the
  first and holds the rest in a "waiting" list; each one opens for review after
  the current draft is queued or discarded. Click a waiting link to jump to it.
- **Format per job** - the default comes from `/admin`, and the review card can
  switch this job to MP3, FLAC or WAV without touching it.
- **Your own cover art** - the tile beside the title in the review card is the
  cover that gets written: click it to pick a file, drop an image straight onto
  the tile, or paste a link to one. It replaces the source's artwork for every
  selected track, switches *Cover art* on if it was off, and **Use source
  cover** puts the original back. Opened track rows carry the same control in
  miniature: a dropped or uploaded image there belongs to that one track, and
  **Use album cover** hands it back to the download's cover. An upload is stored in `data/covers/` under a random name, served
  back from `/api/covers/…` and fetched by the script over loopback; old files
  are pruned on the next upload. JPEG, PNG, WebP or GIF up to 8 MB, and the
  type is sniffed from the bytes rather than trusted from the file name.
- **Long playlists** - filter by title, `Shift`-click to select a range, or type
  `1-3,7` in the range box to select exactly those track numbers (the same rule
  as the script's `--tracks`). The list shows 50 rows at a time with
  **Previous** / **Next** and a visible position ("51–100 of 213"); paging only
  changes what is drawn - selection, *all* and *none* still cover the whole
  playlist, and filtering starts again at page one.
- **Artist suggestions and collaborations** - the artist box searches the
  names already in the library as you type (`↑`/`↓`, `Enter`, `Esc`) and matches
  them loosely: case, accents, punctuation, full-width forms and spacing are
  ignored, so `ARTIST1`, `artist-1` and `Artist1` all find the stored `Artist1`,
  and a one- or two-letter slip (`beatls`) still ranks `Beatles` first. Picking a
  suggestion uses the library's spelling, so a track lands in the existing
  folder instead of a near-duplicate next to it; `Enter` on an exact spelling
  does the same. A name the library has never seen is offered as *Use "…" as a
  new artist* at the end of the list. Multi-artist releases are supported: a
  typed name becomes a pill on `Enter` (so does a pasted `A, B`), each pill
  carries a small ✕ in its top-right corner, and `Backspace` in the empty box
  takes the last one back. The pills are stored as one comma-separated artist,
  which is the form the script splits into separate tag values; the first pill
  also decides the folder and the default genre.
- **Genre** - the genre box starts filled in from the curated artist map that
  ships with the image (`web/server/artist-genres.json`: one genre per artist,
  the same file the library backfill used). Those names are offered as you type,
  anything else can be typed instead, and an empty box writes no genre tag at
  all. The genre is written in the same pass as the title and album, in every
  output format, so a queued download is never tagless; an artist the map does
  not know starts empty rather than guessing, and adding it to that file (then
  rebuilding the image) is how a new act gets its default. The genre box in
  *Edit tags* is the same input with the same vocabulary, served by
  `GET /api/genres`.
- **Keyboard** - `Ctrl`/`Cmd`+`K` (or `/` outside a field) jumps to the link box;
  in the review card `Ctrl`/`Cmd`+`Enter` queues what is selected, and in the
  queue `j`/`k` move the highlight, `Enter` opens the highlighted job and `Esc`
  clears it. Dialogs close with `Esc` on their own.
- **Take an edit back** - a field that differs from what the link offered (artist,
  album, genre, date) carries a ↺ beside its label that restores the source
  value; a row's date moves with the card when the date is reset. *Saves to*
  shows the first file's full path, not just the folder. Discarding a draft
  keeps it for ten seconds and offers **Undo**, which also puts the link that
  was opened in its place back in the waiting list.
- **Drafts survive reloads** - the review card is kept in `localStorage`, so a
  half-picked album comes back after a refresh or a locked phone.
- **Save** - the owner gets the same ↓ transfer as guests, on top of the
  copy-path button, which is useful when browsing from another machine.
- **Edit tags after the fact** - a finished owner job opens *Edit tags* in the
  expanded row: title (single downloads), artist, album and genre. The server rewrites
  the tags inside the files that are already on disk (`PATCH /api/jobs/:id/tags`)
  without re-downloading or re-encoding - ffmpeg copies every stream, including
  attached cover art, and replaces the metadata; Opus/Ogg go through mutagen
  because ffmpeg's Ogg muxer drops tags. An artist typed with commas or
  semicolons becomes that many artists in the file, the same split a download
  gets. Track titles in a playlist stay as the
  source reported them, and **the files are not moved**: a corrected album name
  changes the tags, not the folders. Failures are reported per file, and the job,
  queue row and history entry are updated to match.
- **Finish notifications** - the bell in the header asks for permission once and
  then raises a browser notification when a download completes while the tab is
  in the background. The page is installable to a phone home screen via a
  `manifest.webmanifest` the server builds from the configured instance name,
  with a 180 px `apple-touch-icon` and 192/512 px PNG icons beside the SVG (no
  service worker; it is not an offline app).
- **Glass and motion, switchable** - surfaces are translucent (`--glass` plus a
  24 px backdrop blur), the page sits on three slow colour auras with a faint
  grain, buttons lift on hover and each page's blocks rise in on entry. The
  sparkle button in the header (also on the sign-in and setup screens) turns all
  of it off: auras hidden, grain gone, blurs dropped to opaque surfaces and all
  animation disabled. Remembered as `audiodl-effects`, applied before the first
  paint and written onto `<html>` by the server (see the next bullet). A browser
  asking for reduced motion starts in the off state.
- **Catppuccin, per browser** - the palette button in the header opens
  *Appearance*, for guests and the owner alike: Auto / Light / Dark, the four
  Catppuccin flavors (Latte, Frappé, Macchiato, Mocha) and any of their
  fourteen accents. Each swatch names itself on hover or keyboard focus
  (`Esc` dismisses the tip, not the dialog), and the chosen accent is written
  beside the heading for touch. A flavor supplies every surface, text and border colour and
  decides light or dark itself, so the theme row is disabled while one is
  chosen; the accent tints the auras, progress, focus rings, the overview chart
  and the primary button. *Default* returns to Crate's own palette, and every
  guest keeps their own.
- **The first frame is already the right one** - all three choices (theme,
  effects, palette) are kept in `localStorage` as `audiodl-theme`,
  `audiodl-effects` and `audiodl-catppuccin`, and mirrored into cookies of the
  same names. A cookie is the only one of the two stores the server can read, so
  it rebuilds the opening tag on every request: `data-theme`, `data-effects`,
  `data-catppuccin` and `data-accent` are on `<html>` in the raw HTML, before
  any script runs (only the listed flavors and accents are ever written, so a
  hand-edited cookie cannot put anything else there). `main.tsx` applies the
  same values before the first render, which is what covers the dev server and a
  page served from somewhere else. The look cookies hold a taste, not a secret:
  they are readable by scripts, they do not sign anyone in, and signing out does
  not touch them.
- **Settings has one look for the whole instance** - `/admin` is the exception
  to the per-browser rule: its theme, effects switch and palette are stored with
  the rest of the instance settings (`adminLook` in `data/settings.json`) and
  written onto `<html>` for whoever opens it, so a new laptop, a phone or a
  fresh browser arrives to the same page without picking anything. The palette
  button and the sparkle switch in that page's header change the stored look for
  everyone (`PUT /api/admin/look`, owner only, every value checked against the
  lists), and the queue, the sign-in screen and every other page keep following
  each browser as before. A hand-edited settings file is cleaned on read, so the
  page can only ever carry a known theme, flavor and accent.
- **Overview** - `/dashboard` (owner only; the grid icon beside the gear) is the
  read-at-a-glance page: library counts and disk use with a used/free bar, a
  14-day bar chart of finished tracks, the guest tally, yt-dlp/ffmpeg/script
  versions, and the last six downloads. Every card carries a one-line
  explanation, empty states point at the queue, and `/admin` links back to it.
- **Link previews** - sharing the address in Discord, Slack, iMessage or X shows
  a card with the instance name, a one-line description and a 1200x630 image
  (`public/og.png`). The tags are written per request, so a renamed instance and
  an address behind a proxy (`X-Forwarded-Proto` / `X-Forwarded-Host`) both
  preview correctly; the page itself is still the single app shell, so every
  path serves the same card. The image is deliberately generic - the name is in
  the title, not baked into the picture.
- A failed track shows the reason under its title, not just "failed".

## Sign-in and cookies

Some sources answer a download with “Sign in to confirm you're not a bot”, or
only serve a track to an account. yt-dlp fixes that with a Netscape
`cookies.txt`, and **Settings → Sources** is where the owner pastes one: export
it from the browser with an extension that saves `cookies.txt`, open the site
first, and paste the file. The jar is stored at `data/cookies.txt`, mode `0600`,
and used for the owner's downloads only - a guest stream never runs against it -
and `/api/settings` reports only whether one exists, how many sites it covers
and when it changed, never a line of it.

The failure is offered as a fix rather than a dead end: a job that dies on a
sign-in wall is flagged `needsCookies`, and its expanded row says so with **Add
cookies…** (which opens the paste box and retries the job once it is saved) and
**Retry**. A link that will not inspect at all gets **Paste cookies…** beside the
error and is inspected again as soon as the jar is saved. Guests are told the
source wants a sign-in and nothing else; the offer never appears for them.

On the command line the same jar is `--cookies FILE` (or `AUDIODL_COOKIES`), and
it is passed to every yt-dlp call, the probe included. A cookie file can also be
mounted into the container by hand. It is deliberately not part of the settings
backup: it is a set of live sessions, not a preference.

## Security

- Passwords are verified against a salted **scrypt** hash (N=16384, r=8, p=1),
  compared in constant time; the plain password is never stored or logged.
  Existing settings files with a plain `password` field are migrated on start.
- Choosing a password (first run, and `/admin`) shows a four-step strength bar
  next to the **At least 8 characters** requirement. Eight characters is the
  only rule the server enforces; the bar is advice, not a second gate.
- The instance name is public (header, tab, manifest, `/contact`); the owner
  **username is not** - it is returned only to a signed-in owner and never
  rendered to guests, and `/api/me`, the footer and the contact page carry the
  optional contact line instead. Matching the username at login is
  case-insensitive and the password is still checked in constant time.
- The sign-in form does not prefill or autocomplete the username: it is not
  stored in the browser, and the field asks the browser not to remember it.
  A password manager can still offer to save the credentials after a login.
- **Two-factor authentication** is optional: `/admin` → *Owner account* →
  *Set up two-factor* shows a QR code (drawn in the page, the secret never goes
  to a QR service) and a base32 secret, then asks for one code before switching
  on. Reopening the dialog reuses the same waiting secret for ten minutes, so a
  QR scanned earlier still matches. Once on, the password is followed by a
  single-use 6-digit code (`RFC 6238`, SHA1, 30 s, ±2 steps, so a clock up to a
  minute out still works); a sign-in attempt is valid for two minutes and
  counts against the same rate limit as a wrong password. Time zones never
  matter here - codes count UTC seconds - but the two clocks must agree, so the
  code field shows the server's clock in your own time zone and a warning when
  this browser's clock is off. The field is marked as a one-time code
  (`autocomplete="one-time-code"`, `name`/`id` of `totp`) so password managers
  offer the stored code. A code outside the window is compared against
  ±10 minutes, and the error then says how far the authenticator's clock is
  from the server's. The account is not switched on until the first code
  verifies, so a half-finished setup cannot lock anyone out, and `/admin` shows
  a one-time prompt that can be put off.
  **Lost authenticator:** stop the server, delete `totpSecret` and set
  `totpEnabled` to `false` in `data/settings.json`, then start it again.
- `GET /api/setup` reports whether a password exists, and `POST /api/setup`
  accepts a name, username and password only while none is stored (409
  otherwise), so the form cannot be used to overwrite a password on a running
  server.
- Sessions are 32-byte random tokens in an `HttpOnly`, `SameSite=Lax` cookie
  (adds `Secure` when the request arrives over TLS). The server stores only a
  SHA-256 digest of each token.
- **Keeping the owner signed in** - the sign-in form has *Keep me signed in*,
  on by default, with a choice of **7 days**, **30 days**, **90 days** or
  **forever** (a ten-year session). Unticking it leaves the cookie without a
  `Max-Age`, so it is a browser-session cookie: quitting the browser signs the
  device out, and the server drops the session 12 hours later regardless.
  Remembered devices are written to `data/sessions.json` (digests only, capped
  at 50) so a container restart no longer signs every phone and laptop out;
  a window-only session is never persisted. Since browsers drop any cookie after
  400 days, each visit re-sends the cookie with the time that is left - enough
  for *forever* to keep rolling, while *7 days* still ends seven days after the
  password was entered. The choice made at the password step is carried through
  the two-factor step, so the code screen does not ask again. Changing the
  password - through `/admin`, or by a different `AUDIODL_PASSWORD` - or
  signing out invalidates the session, and the password change clears every
  remembered device as well. The three look cookies (`audiodl-theme`,
  `audiodl-effects`, `audiodl-catppuccin`) are written by the page itself, so
  they are deliberately not `HttpOnly`: they hold a taste, carry no identity and
  are only ever echoed back as validated `data-` attributes.
- Guests may download **without any password** when `AUDIODL_GUEST` is on
  (the default); they see only their own jobs, and only public hosts, but anyone
  who can reach the port can use the downloader. Set `AUDIODL_GUEST=0` on an
  untrusted network.
- Guest audio is streamed, not stored: the encoded bytes go straight to the
  guest's browser and the temporary download is deleted when the transfer ends.
  Guest output never enters the library.
- Guest preferences are kept in `data/guest-profiles.json` (one entry per
  browser, keyed by a random id cookie, capped at 200 entries); they contain no
  identifying information beyond the random id.
- A webhook URL is treated as a secret: it stays in `data/settings.json`, is
  only used server-side, and `/api/settings` returns the host and whether it is
  set, never the path or token. A Discord webhook URL is a credential - anyone
  holding it can post to that channel.
- Still no TLS of its own: this is meant for a trusted LAN, and traffic is in
  clear text on the wire. Put it behind a reverse proxy with TLS where that
  matters.

### Losing the password

There is nothing to recover: only the hash exists. Either set
`AUDIODL_PASSWORD=new-password` (and clear it again afterwards), or delete the
hash so /setup comes back:

```sh
docker compose exec -u root crate node -e "const f='/app/data/settings.json';
const j=JSON.parse(require('fs').readFileSync(f));delete j.passwordHash;
require('fs').writeFileSync(f,JSON.stringify(j,null,2))"
docker compose restart crate
```

On a bare host, delete `passwordHash` from `web/data/settings.json` and restart.
The owner login answers `409` (not "wrong password") while no password exists,
and every page redirects to /setup.
