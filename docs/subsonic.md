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

| Field | Value |
|---|---|
| Server | `http://your-host:8099` (or the URL behind your reverse proxy) |
| Username | the owner username from `/setup`, `admin` unless you changed it |
| Password | your Crate password |
| Path prefix | leave empty — the endpoints are at `/rest` directly |

The API is on by default and needs no toggle: it accepts the owner's existing
credentials, and nothing else.

## Authentication

- **Username and password** — `u` and `p`, as the protocol defines. `p` may be
  plain text or the `enc:` hex form some clients use.
- **Session cookie** — a browser already signed in to Crate is accepted, which
  is what makes a player opened on this machine work without a second login.
- **Token auth (`t` + `s`) is refused** with error code **41**. That scheme is
  `md5(password + salt)`, and Crate stores only a scrypt hash, so it cannot be
  verified without keeping your password in recoverable form — which it does
  not do. Pick the password method in your player.

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
- **Durations are `0`.** Reading them needs a per-file probe, which is far too
  slow for a library of thousands of tracks; the web UI does not wait for it
  either.
- Genres, years, bitrates and replay-gain values are absent for the same reason.
- Likes, play counts and playlists stay empty: nothing writes them.

Guest access is not extended to this API. A guest session is not the owner, so a
player needs the owner's credentials; `/admin` still controls the web queue's
guest rules independently.
