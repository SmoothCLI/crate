# Subsonic API

Crate serves a **read-only** subset of the [Subsonic API](https://subsonic.org/pages/api.jsp)
(protocol `1.16.1`) from `/rest`, so a phone or desktop player can browse and
stream the same library the web UI shows. Point Symfonium, DSub, Feishin,
substreamer or Amperify at the instance and the albums, artists, covers and
tracks are already there.

Read-only is deliberate. The API reads the library walk the `/library` page uses
and hands out the owner's files; it never writes tags, ratings, stars,
playlists or scrobbles. Downloads still happen in Crate.

## Connecting

`/admin → Subsonic API` holds everything a player needs: the switch, the server
URL, an API key and a Subsonic password. Both credentials are generated on first
start and can be regenerated there; regenerating one signs out whatever used it.

| Field | Value |
|---|---|
| Server | `http://your-host:8099` (or the URL behind your reverse proxy) |
| Username | the owner username from `/setup`, `admin` unless you changed it |
| Password | the **Subsonic password** from `/admin` |
| Path prefix | leave empty — the endpoints are at `/rest` directly |

Some players ask for an API key instead: paste it where the password goes, or
send it as `apiKey=`. A key needs no username and cannot sign in to the web UI.

## Authentication

- **API key** — `apiKey=<key>`, the simplest option and the one that keeps a
  password out of the URL.
- **Username and password** — `u` and `p`, as the protocol defines. `p` may be
  plain text or the `enc:` hex form some clients use. Either the Subsonic
  password or the web password is accepted here.
- **Token auth** — `t` + `s`, which is `md5(password + salt)`. This works with
  the Subsonic password, because that one is stored (encrypted at rest by being
  readable to the server only — see below) rather than hashed. The web password
  is still only a scrypt hash, so token auth cannot be checked against it.
- **Session cookie** — a browser already signed in to Crate is accepted, which
  is what makes a player opened on this machine work without a second login.

Switching the API off in `/admin` answers error **50** to every request,
whatever credential it carried.

The Subsonic password is a separate credential on purpose: it is the only one
that can be checked against an md5 token, and it opens nothing but this
read-only API.

Because the password can travel in a query string, **put the instance behind
HTTPS** for anything beyond a trusted LAN. See
[reverse-proxy.md](reverse-proxy.md).

## Endpoints

| Endpoint | What it answers |
|---|---|
| `ping` | status and protocol version |
| `getMusicFolders` | one folder, named after the instance |
| `getIndexes`, `getArtists` | artists grouped into alphabetical buckets |
| `getArtist` | one artist with its albums |
| `getAlbum` | one album with its songs |
| `getSong` | one song |
| `getAlbumList2` | `newest`, `recent`, `alphabeticalByName`, `alphabeticalByArtist`, `random` |
| `search3` | artists, albums and songs matching every word of `query` |
| `stream` | the file, with `Range` support for seeking |
| `download` | the same bytes, as an attachment |
| `getCoverArt` | the album cover, folder image or art embedded in the file |
| `getScanStatus` | `scanning=false` and the track count |
| `getStarred2`, `getPlaylists` | empty collections, honestly |
| `scrobble` | accepted and forgotten |
| `getLicense` | valid |

Both spellings work: `/rest/getArtists` and `/rest/getArtists.view`. Responses
are XML unless the request says `f=json`.

Not implemented, because there is nothing behind them on a read-only server:
transcoding (`format` is ignored, the original file is sent), playlists, stars,
ratings, sharing, lyrics, chat and user management.

## Trying it

```sh
# Status, as XML:
curl -u admin:your-password 'http://localhost:8099/rest/ping'

# The same, as JSON:
curl 'http://localhost:8099/rest/ping?u=admin&p=your-password&v=1.16.1&c=curl&f=json'

# What is in the library:
curl 'http://localhost:8099/rest/getArtists?u=admin&p=your-password&v=1.16.1&c=curl&f=json'

# Search, then stream the first hit:
curl 'http://localhost:8099/rest/search3?u=admin&p=your-password&v=1.16.1&c=curl&f=json&query=sonnenrausch'
curl -o track.m4a 'http://localhost:8099/rest/stream?u=admin&p=your-password&v=1.16.1&c=curl&id=<songId>'
```

Ids are opaque: keep the one the server gave you rather than building your own.
A song id resolves only to a file the library walk found, so a crafted id cannot
read outside the music folder.

## What a player will and will not show

- Albums, artists, track titles, track numbers, sizes, formats and cover art are
  real, taken from the folder layout the downloader writes.
- **Durations are measured with `ffprobe` and cached** in `data/durations.json`
  by path and mtime, so each file is probed once and re-probed only when it
  changes. The first request that mentions a file pays for the probe; later ones
  read the cache. At most 60 probes are started per response, so opening a large
  album fills remaining lengths on the next request rather than blocking.
- Genres, years, bitrates and replay-gain values are absent: they would need a
  full tag read per file, which is a different order of cost.
- Likes, play counts and playlists stay empty: nothing writes them.

Guest access is not extended to this API. A guest session is not the owner, so a
player needs the owner's credentials; `/admin` still controls the web queue's
guest rules independently.
