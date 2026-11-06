// A read-only Subsonic-compatible API (protocol 1.16.1), so a third-party
// player - Symfonium, DSub, Feishin, Amperify - can browse and stream the
// owner's library without the web UI.
//
// Read-only is the point, not a limitation to apologise for: nothing here
// writes tags, stars, ratings, playlists or scrobbles, so the downloader and
// the web UI stay the only things that change files. A player may call
// scrobble; it is answered and forgotten.
//
// Auth reuses the owner's existing credentials. A session cookie is accepted so
// a tool running in the same browser works, and `u`/`p` (plain, or the hex
// `enc:` form clients use) is checked against the stored scrypt hash. Token
// auth (`t`+`s`, md5(password+salt)) cannot be verified from a scrypt hash
// without keeping the password itself, so it is refused with the protocol's own
// error code 41 instead of being quietly accepted.
//
// The library model comes from the same folder walk the /library page uses, so
// an album's artist, name and cover cannot disagree between the two views.

import fs from "node:fs";
import path from "node:path";

const PROTOCOL = "1.16.1";
const XMLNS = "http://subsonic.org/restapi";
const IGNORED_ARTICLES = "The A An";
// The pages a read-only server can honestly answer. Anything absent is a 404
// from Express, which is what a client expects for an unimplemented extension.
const MAX_SEARCH_SONGS = 100;

// --------------------------------------------------------------- serialising
//
// One response object feeds both formats: primitives become XML attributes (the
// Subsonic XML style) and children become elements, arrays repeat their key.
// That keeps the JSON and XML views of a payload from drifting apart, which is
// the usual way a hand-written second serialiser goes wrong.

const escapeXml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character],
  );

const scalar = (value) => (typeof value === "boolean" ? (value ? "true" : "false") : String(value));

function toXml(name, value) {
  if (Array.isArray(value)) return value.map((item) => toXml(name, item)).join("");
  if (value && typeof value === "object") {
    const attributes = [];
    const children = [];
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined || item === null) continue;
      if (typeof item === "object") children.push(toXml(key, item));
      else attributes.push(` ${key}="${escapeXml(scalar(item))}"`);
    }
    const open = `<${name}${attributes.join("")}`;
    return children.length ? `${open}>${children.join("")}</${name}>` : `${open}/>`;
  }
  return `<${name}>${escapeXml(scalar(value))}</${name}>`;
}

function toXmlDocument(response) {
  const { status, version, ...rest } = response;
  const children = Object.entries(rest)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => toXml(key, value))
    .join("");
  const head = `<subsonic-response xmlns="${XMLNS}" status="${status}" version="${version}"`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n${children ? `${head}>${children}</subsonic-response>` : `${head}/>`}`;
}

// --------------------------------------------------------------------- ids
//
// Opaque to the client, resolvable on this side: the prefix says what kind of
// thing it is and the payload is the folder or file path. Every id is checked
// against the library walk before it is used, so a crafted one can name a file
// but cannot reach outside the library or at a path the walk never returned.

const idFor = (prefix, value) => prefix + Buffer.from(String(value), "utf8").toString("base64url");

function fromId(prefix, value) {
  const text = String(value ?? "");
  if (!text.startsWith(prefix)) return null;
  try {
    const decoded = Buffer.from(text.slice(prefix.length), "base64url").toString("utf8");
    return decoded || null;
  } catch {
    return null;
  }
}

const songId = (item) => idFor("s", item.path);
const albumId = (dir) => idFor("d", dir);
const artistId = (name) => idFor("a", name);

const letterOf = (name) => {
  const bare = String(name).replace(/^(the|a|an)\s+/i, "").trim();
  const first = bare.charAt(0).toUpperCase();
  return /\p{L}/u.test(first) ? first : "#";
};

const unknownArtist = (name) => name || "Unknown artist";
const unknownAlbum = (name) => name || "Unknown album";

export function mountSubsonic(app, deps) {
  // ----------------------------------------------------------- the library

  function library() {
    const root = deps.musicDir();
    const items = deps.items();
    const artists = new Map();
    for (const item of items) {
      const name = unknownArtist(item.artist);
      if (!artists.has(name)) artists.set(name, { name, albums: new Map() });
      const artist = artists.get(name);
      if (!artist.albums.has(item.dir)) {
        artist.albums.set(item.dir, {
          dir: item.dir,
          name: unknownAlbum(item.album),
          artist: name,
          songs: [],
        });
      }
      artist.albums.get(item.dir).songs.push(item);
    }
    const sorted = [...artists.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const artist of sorted) {
      artist.list = [...artist.albums.values()].sort((a, b) => a.name.localeCompare(b.name));
    }
    return { root, items, artists: sorted };
  }

  function songOf(item, root) {
    const parent = albumId(item.dir);
    const song = {
      id: songId(item),
      parent,
      isDir: false,
      title: item.title,
      album: unknownAlbum(item.album),
      artist: unknownArtist(item.artist),
      size: item.bytes || 0,
      contentType: deps.mime[`.${item.ext}`] || "application/octet-stream",
      suffix: item.ext,
      path: path.relative(root, item.path).split(path.sep).join("/"),
      albumId: parent,
      artistId: artistId(unknownArtist(item.artist)),
      type: "music",
      isVideo: false,
      created: new Date(item.mtime || Date.now()).toISOString(),
      coverArt: parent,
    };
    // Not every file carries a track number; an absent attribute reads better
    // than a zero, and both JSON and XML leave it out when it is undefined.
    if (item.track) song.track = item.track;
    return song;
  }

  function albumOf(album, root, withSongs = false) {
    const id = albumId(album.dir);
    const created = album.songs.reduce((newest, item) => Math.max(newest, item.mtime || 0), 0);
    const entry = {
      id,
      name: album.name,
      artist: album.artist,
      artistId: artistId(album.artist),
      coverArt: id,
      songCount: album.songs.length,
      duration: 0,
      playCount: 0,
      created: new Date(created || Date.now()).toISOString(),
    };
    if (withSongs) entry.song = album.songs.map((item) => songOf(item, root));
    return entry;
  }

  function findAlbum(dir) {
    const { root, artists } = library();
    for (const artist of artists) {
      const album = artist.albums.get(dir);
      if (album) return { album, root, artist };
    }
    return null;
  }

  function findSong(id) {
    const { root, items } = library();
    const file = fromId("s", id);
    if (!file) return null;
    const item = items.find((entry) => entry.path === file);
    return item ? { item, root } : null;
  }

  // ------------------------------------------------------------- responses

  function send(req, res, payload = {}, { failed = null } = {}) {
    // Subsonic answers 200 with a status on the body even for a failure, so the
    // error is a field rather than an HTTP code.
    const response = failed
      ? { status: "failed", version: PROTOCOL, error: failed }
      : { status: "ok", version: PROTOCOL, ...payload };
    res.set("Cache-Control", "no-store");
    if (String(req.query.f || "").toLowerCase() === "json") {
      res.type("application/json; charset=utf-8").send(JSON.stringify({ "subsonic-response": response }));
    } else {
      res.type("application/xml; charset=utf-8").send(toXmlDocument(response));
    }
  }

  const fail = (req, res, code, message) => send(req, res, {}, { failed: { code, message } });

  // ---------------------------------------------------------------- auth

  async function authenticate(req) {
    // A browser already holding a session is the owner: the same rule the web
    // UI follows, so a player running on this machine needs no second password.
    if (deps.sessionFor(req)?.role === "owner") return null;

    const username = deps.username() || "";
    const given = String(req.query.u ?? "").trim();
    if (!given || given.toLowerCase() !== username.toLowerCase()) {
      return { code: 40, message: "Wrong username or password." };
    }

    if (req.query.t && req.query.s) {
      return {
        code: 41,
        message:
          "Token authentication is not supported: this server keeps only a scrypt hash of the password. Send the password directly over HTTPS (the enc: hex form is accepted).",
      };
    }

    const raw = String(req.query.p ?? "");
    if (!raw) return { code: 10, message: "Missing password." };

    const ip = deps.clientIp(req);
    if (deps.blockedFor(ip) > 0) {
      return { code: 40, message: "Too many attempts. Try again in a minute." };
    }

    // Clients that do not want to put a password in a URL send it hex-encoded
    // with an `enc:` prefix; that is obfuscation, not encryption, which is why
    // the docs insist on HTTPS.
    const password = raw.startsWith("enc:") ? Buffer.from(raw.slice(4), "hex").toString("utf8") : raw;
    const stored = deps.passwordHash();
    if (stored && password && (await deps.verifyPassword(password, stored))) return null;
    deps.recordFailure(ip);
    return { code: 40, message: "Wrong username or password." };
  }

  // ------------------------------------------------------------ file bytes

  function serveFile(req, res, file, attachment) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      fail(req, res, 70, "That file is not in the library.");
      return;
    }
    if (!stat.isFile()) {
      fail(req, res, 70, "That file is not in the library.");
      return;
    }
    const size = stat.size;
    const ext = path.extname(file).toLowerCase();
    res.set({
      "Content-Type": deps.mime[ext] || "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=0, must-revalidate",
      ...(attachment
        ? { "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}` }
        : {}),
    });

    let start = 0;
    let end = size - 1;
    let partial = false;
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
      const from = match?.[1] ?? "";
      const to = match?.[2] ?? "";
      if (!match || (!from && !to)) {
        res.status(416).set("Content-Range", `bytes */${size}`).end();
        return;
      }
      if (from) {
        start = Number(from);
        if (to) end = Math.min(Number(to), size - 1);
      } else {
        start = Math.max(0, size - Number(to));
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
        res.status(416).set("Content-Range", `bytes */${size}`).end();
        return;
      }
      partial = true;
      res.status(206).set({
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1),
      });
    } else {
      res.set("Content-Length", String(size));
    }

    const stream = fs.createReadStream(file, partial ? { start, end } : undefined);
    stream.on("error", () => {
      if (!res.headersSent) fail(req, res, 0, "Could not read that file.");
      else res.end();
    });
    stream.pipe(res);
  }

  // ------------------------------------------------------------- end points

  const routes = {
    ping: () => ({}),

    getLicense: () => ({ license: { valid: true } }),

    getMusicFolders: () => ({
      musicFolders: { musicFolder: [{ id: 1, name: deps.siteName() || "Crate" }] },
    }),

    getScanStatus: () => ({ scanStatus: { scanning: false, count: library().items.length } }),

    // Read-only: there is nothing to star and no playlist store, so both answer
    // with an empty collection rather than an error a client would log.
    getStarred2: () => ({ starred2: {} }),
    getPlaylists: () => ({ playlists: {} }),

    // Clients call this as playback starts. Accepting without storing keeps a
    // player quiet; it is not a claim that scrobbling exists.
    scrobble: () => ({}),

    getIndexes: () => {
      const { artists } = library();
      const buckets = new Map();
      for (const artist of artists) {
        const letter = letterOf(artist.name);
        if (!buckets.has(letter)) buckets.set(letter, []);
        buckets.get(letter).push({
          id: artistId(artist.name),
          name: artist.name,
          albumCount: artist.list.length,
        });
      }
      const index = [...buckets.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, entries]) => ({ name, artist: entries }));
      return { indexes: { ignoredArticles: IGNORED_ARTICLES, lastModified: Date.now(), index } };
    },

    getArtists: () => {
      const { artists } = library();
      const buckets = new Map();
      for (const artist of artists) {
        const letter = letterOf(artist.name);
        if (!buckets.has(letter)) buckets.set(letter, []);
        buckets.get(letter).push({
          id: artistId(artist.name),
          name: artist.name,
          albumCount: artist.list.length,
          coverArt: artist.list[0] ? albumId(artist.list[0].dir) : undefined,
        });
      }
      const index = [...buckets.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, entries]) => ({ name, artist: entries }));
      return { artists: { ignoredArticles: IGNORED_ARTICLES, index } };
    },

    getArtist: (req) => {
      const name = fromId("a", req.query.id);
      const { artists, root } = library();
      const artist = name ? artists.find((entry) => entry.name === name) : null;
      if (!artist) return { miss: true };
      return {
        artist: {
          id: artistId(artist.name),
          name: artist.name,
          albumCount: artist.list.length,
          album: artist.list.map((album) => albumOf(album, root)),
        },
      };
    },

    getAlbum: (req) => {
      const dir = fromId("d", req.query.id);
      const found = dir ? findAlbum(dir) : null;
      if (!found) return { miss: true };
      return { album: albumOf(found.album, found.root, true) };
    },

    getSong: (req) => {
      const found = findSong(req.query.id);
      if (!found) return { miss: true };
      return { song: songOf(found.item, found.root) };
    },

    getAlbumList2: (req) => {
      const { artists, root } = library();
      const albums = artists.flatMap((artist) => artist.list);
      const type = String(req.query.type || "newest").toLowerCase();
      const size = Math.min(500, Math.max(1, Number(req.query.size) || 10));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const newest = (album) => album.songs.reduce((newestAt, item) => Math.max(newestAt, item.mtime || 0), 0);

      let ordered;
      switch (type) {
        case "alphabeticalbyname":
          ordered = albums.sort((a, b) => a.name.localeCompare(b.name) || a.artist.localeCompare(b.artist));
          break;
        case "alphabeticalbyartist":
          ordered = albums.sort((a, b) => a.artist.localeCompare(b.artist) || a.name.localeCompare(b.name));
          break;
        case "random":
          ordered = [...albums].sort(() => Math.random() - 0.5);
          break;
        case "recent":
        case "newest":
          ordered = albums.sort((a, b) => newest(b) - newest(a) || a.name.localeCompare(b.name));
          break;
        default:
          // starred, highest, frequent, byYear and byGenre have no data behind
          // them on a read-only server: an empty list is the honest answer.
          ordered = [];
      }
      return { albumList2: { album: ordered.slice(offset, offset + size).map((album) => albumOf(album, root)) } };
    },

    search3: (req) => {
      const query = String(req.query.query ?? "").trim().toLowerCase().slice(0, 120);
      const { artists, root } = library();
      if (!query) return { searchResult3: { artist: [], album: [], song: [] } };
      const terms = query.split(/\s+/).filter(Boolean).slice(0, 6);
      const matches = (...parts) => {
        const hay = parts.join(" ").toLowerCase();
        return terms.every((term) => hay.includes(term));
      };

      const foundArtists = artists
        .filter((artist) => matches(artist.name))
        .slice(0, Math.min(20, Number(req.query.artistCount) || 20))
        .map((artist) => ({ id: artistId(artist.name), name: artist.name, albumCount: artist.list.length }));

      const albums = artists.flatMap((artist) => artist.list);
      const foundAlbums = albums
        .filter((album) => matches(album.name, album.artist))
        .slice(0, Math.min(20, Number(req.query.albumCount) || 20))
        .map((album) => albumOf(album, root));

      const foundSongs = [];
      for (const item of library().items) {
        if (!matches(item.title, unknownArtist(item.artist), unknownAlbum(item.album))) continue;
        foundSongs.push(songOf(item, root));
        if (foundSongs.length >= Math.min(MAX_SEARCH_SONGS, Number(req.query.songCount) || 20)) break;
      }

      return { searchResult3: { artist: foundArtists, album: foundAlbums, song: foundSongs } };
    },

    stream: (req, res) => {
      const found = findSong(req.query.id);
      if (!found) {
        fail(req, res, 70, "That song is not in the library.");
        return;
      }
      serveFile(req, res, found.item.path, false);
    },

    download: (req, res) => {
      const found = findSong(req.query.id) ?? (() => {
        const dir = fromId("d", req.query.id);
        const album = dir ? findAlbum(dir) : null;
        return album ? { item: { path: album.album.songs[0]?.path } } : null;
      })();
      if (!found?.item?.path) {
        fail(req, res, 70, "That song is not in the library.");
        return;
      }
      serveFile(req, res, found.item.path, true);
    },

    getCoverArt: async (req, res) => {
      const dir = fromId("d", req.query.id);
      const root = deps.musicDir();
      if (!dir || !(dir === root || deps.isInside(dir, root))) {
        fail(req, res, 70, "No cover art for that id.");
        return;
      }
      const file = await deps.coverFor(dir);
      if (!file) {
        fail(req, res, 70, "No cover art for that id.");
        return;
      }
      // The same short lifetime the /library page uses: a retagged cover has to
      // show up without the client throwing its cache away.
      res.set("Cache-Control", "private, max-age=300, must-revalidate");
      res.sendFile(file, (error) => {
        if (error && !res.headersSent) fail(req, res, 70, "No cover art for that id.");
      });
    },
  };

  // --------------------------------------------------------------- routing
  //
  // Both spellings are part of the protocol: `/rest/ping` is the modern form and
  // `/rest/ping.view` is what older clients still build.

  for (const [name, handler] of Object.entries(routes)) {
    const paths = [`/rest/${name}`, `/rest/${name}.view`];
    app.get(paths, async (req, res) => {
      try {
        const denied = await authenticate(req);
        if (denied) {
          fail(req, res, denied.code, denied.message);
          return;
        }
        const payload = await handler(req, res);
        if (payload === undefined) return; // the handler wrote the response itself
        if (payload?.miss) {
          fail(req, res, 70, "The requested data was not found.");
          return;
        }
        send(req, res, payload);
      } catch (error) {
        // A client should see a Subsonic error, not an HTML stack trace.
        if (!res.headersSent) fail(req, res, 0, `Server error: ${error?.message || "unknown"}`);
        else res.end();
      }
    });
  }
}
