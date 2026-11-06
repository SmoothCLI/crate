import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { LibraryBrowse, LibraryTrack } from "../types";
import { formatBytes } from "../lib/format";
import { ArrowIcon, CloseIcon, DiscIcon, PlayIcon } from "./Icons";

// The owner's library, read from the folder layout rather than from tags: the
// paths already are ARTIST/ALBUM/[NN - ]TITLE.ext, which is what a download
// writes, so what this page lists is exactly what is on disk.
export function LibraryPage() {
  const [browse, setBrowse] = useState<LibraryBrowse | null>(null);
  const [artist, setArtist] = useState<string | null>(null);
  const [album, setAlbum] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState<LibraryTrack | null>(null);
  const seq = useRef(0);
  const audio = useRef<HTMLAudioElement>(null);

  // One request per pause in typing, not per keystroke: the server caches its
  // walk, but the request itself would still be wasted.
  useEffect(() => {
    const q = query.trim();
    const handle = window.setTimeout(
      () => {
        const mine = ++seq.current;
        setLoading(true);
        api
          .browseLibrary(q ? { q } : { artist: artist ?? undefined, album: album ?? undefined })
          .then((result) => {
            if (seq.current !== mine) return;
            setBrowse(result);
            setError(null);
          })
          .catch((err: unknown) => {
            if (seq.current !== mine) return;
            setError(err instanceof Error ? err.message : "Could not read the library.");
          })
          .finally(() => {
            if (seq.current === mine) setLoading(false);
          });
      },
      q ? 220 : 0,
    );
    return () => window.clearTimeout(handle);
  }, [query, artist, album]);

  // A folder removed outside the app must not leave the page filtering on an
  // artist that no longer exists.
  useEffect(() => {
    if (!browse || query.trim() || !artist) return;
    if (!browse.artists.some((entry) => entry.name === artist)) setArtist(null);
  }, [browse, artist, query]);

  // The click that picked the row is still the user gesture, so this is allowed
  // to start on its own.
  useEffect(() => {
    if (!playing) return;
    audio.current?.play().catch(() => {
      /* the browser refused; its own controls still work */
    });
  }, [playing]);

  const searching = query.trim().length > 0;
  const artists = browse?.artists ?? [];
  const albums = browse?.albums ?? [];
  const tracks = browse?.tracks ?? [];
  const bytes = artists.reduce((sum, entry) => sum + entry.bytes, 0);

  return (
    <div className="min-h-dvh pb-32">
      <header
        className="sticky top-0 z-30"
        style={{
          background: "color-mix(in srgb, var(--canvas) 58%, transparent)",
          backdropFilter: "blur(26px) saturate(160%)",
          WebkitBackdropFilter: "blur(26px) saturate(160%)",
          borderBottom: "1px solid var(--line)",
        }}
      >
        <div className="mx-auto flex h-14 max-w-[1080px] items-center gap-2.5 px-5">
          <a
            className="btn btn-ghost px-2"
            href="/"
            aria-label="Back to the queue"
            title="Back to the queue"
          >
            <ArrowIcon className="rotate-180" />
          </a>
          <span className="truncate text-[14px] font-semibold tracking-[0.01em]">Library</span>
          {browse && (
            <span
              className="mono hidden truncate sm:inline"
              style={{ color: "var(--ink-3)", fontSize: "11px" }}
            >
              {browse.total} {browse.total === 1 ? "track" : "tracks"}
              {artist ? ` · ${artist}` : ""}
              {album ? ` · ${album}` : ""}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            <a className="btn btn-ghost px-2 text-[12.5px]" href="/admin#library" title="Health and duplicates">
              Health
            </a>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1080px] space-y-5 px-5 py-8">
        <div className="card p-4 sm:p-5">
          <div className="flex items-center gap-2">
            <input
              className="field"
              placeholder="Search titles, artists, albums"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search the library"
              autoFocus
              autoCapitalize="none"
              spellCheck={false}
            />
            {query && (
              <button
                className="btn btn-ghost shrink-0 px-2"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                title="Clear search"
              >
                <CloseIcon />
              </button>
            )}
          </div>
          {browse && (
            <p className="mt-2 text-[11.5px] leading-relaxed" style={{ color: "var(--ink-3)" }}>
              {searching
                ? `${browse.matched} ${browse.matched === 1 ? "match" : "matches"}${
                    browse.matched > browse.tracks.length
                      ? `, showing the first ${browse.tracks.length}`
                      : ""
                  }`
                : `${artists.length} ${artists.length === 1 ? "artist" : "artists"} · ${
                    browse.total
                  } ${browse.total === 1 ? "track" : "tracks"} · ${formatBytes(bytes)}`}
              {browse.truncated ? " · counted the first 50,000 files only" : ""}
            </p>
          )}
        </div>

        {error && (
          <p className="text-[13px]" role="alert" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        )}

        {loading && !browse && (
          <p className="text-[12.5px]" style={{ color: "var(--ink-3)" }}>
            Reading the library…
          </p>
        )}

        {searching ? (
          <TrackList tracks={tracks} playing={playing} onPlay={setPlaying} showArtist />
        ) : (
          <div className="grid items-start gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
            <section className="card p-2.5" aria-label="Artists">
              <h2
                className="px-2 pb-2 pt-1 text-[10.5px] uppercase tracking-[0.08em]"
                style={{ color: "var(--ink-3)" }}
              >
                Artists
              </h2>
              <ul className="max-h-[62vh] overflow-y-auto">
                {artists.map((entry) => {
                  const active = artist === entry.name;
                  return (
                    <li key={entry.name}>
                      <button
                        type="button"
                        className="flex w-full items-baseline justify-between gap-2 rounded-[9px] px-2 py-1.5 text-left text-[12.5px]"
                        style={{
                          background: active ? "var(--surface-2)" : "transparent",
                          color: active ? "var(--ink)" : "var(--ink-2)",
                        }}
                        aria-pressed={active}
                        onClick={() => {
                          setAlbum(null);
                          setArtist(active ? null : entry.name);
                        }}
                      >
                        <span className="min-w-0 truncate">{entry.name}</span>
                        <span className="num shrink-0 text-[11px]" style={{ color: "var(--ink-3)" }}>
                          {entry.tracks}
                        </span>
                      </button>
                    </li>
                  );
                })}
                {artists.length === 0 && !loading && (
                  <li className="px-2 py-2 text-[12px]" style={{ color: "var(--ink-3)" }}>
                    Nothing in the library yet.
                  </li>
                )}
              </ul>
            </section>

            <section className="min-w-0 space-y-4">
              {!artist ? (
                <div className="card flex items-center gap-3 p-5">
                  <span className="shrink-0" style={{ color: "var(--ink-3)" }}>
                    <DiscIcon size={18} />
                  </span>
                  <p className="text-[12.5px] leading-relaxed" style={{ color: "var(--ink-2)" }}>
                    Pick an artist to see albums and tracks, or search across the whole
                    library above.
                  </p>
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap gap-1.5" aria-label="Albums">
                    <button
                      type="button"
                      className="tag"
                      aria-pressed={album === null}
                      style={
                        album === null
                          ? { borderColor: "var(--ink-3)", color: "var(--ink)" }
                          : undefined
                      }
                      onClick={() => setAlbum(null)}
                    >
                      All albums
                    </button>
                    {albums.map((entry) => (
                      <button
                        key={entry.name}
                        type="button"
                        className="tag"
                        aria-pressed={album === entry.name}
                        style={
                          album === entry.name
                            ? { borderColor: "var(--ink-3)", color: "var(--ink)" }
                            : undefined
                        }
                        onClick={() => setAlbum(album === entry.name ? null : entry.name)}
                      >
                        <span className="max-w-[180px] truncate">{entry.name}</span>
                        <span className="num" style={{ color: "var(--ink-3)" }}>
                          {entry.tracks}
                        </span>
                      </button>
                    ))}
                  </div>
                  <TrackList
                    tracks={tracks}
                    playing={playing}
                    onPlay={setPlaying}
                    showArtist={album === null}
                  />
                </>
              )}
            </section>
          </div>
        )}
      </main>

      {playing && (
        <div className="fixed inset-x-0 bottom-0 z-40 px-3 pb-3">
          <div className="card mx-auto flex max-w-[1080px] items-center gap-3 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12.5px] font-medium">{playing.title}</div>
              <div className="truncate text-[11px]" style={{ color: "var(--ink-3)" }}>
                {playing.artist || "Unknown artist"}
                {playing.album ? ` · ${playing.album}` : ""}
              </div>
            </div>
            <audio
              ref={audio}
              controls
              autoPlay
              preload="metadata"
              src={api.libraryTrack(playing.path)}
              className="h-9 w-[240px] max-w-[50vw]"
              aria-label={`Playing ${playing.title}`}
            />
            <button
              className="btn btn-ghost shrink-0 px-2"
              onClick={() => {
                audio.current?.pause();
                setPlaying(null);
              }}
              aria-label="Stop playing"
              title="Stop playing"
            >
              <CloseIcon />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function TrackList({
  tracks,
  playing,
  onPlay,
  showArtist = false,
}: {
  tracks: LibraryTrack[];
  playing: LibraryTrack | null;
  onPlay: (track: LibraryTrack) => void;
  showArtist?: boolean;
}) {
  if (tracks.length === 0) {
    return (
      <p className="px-1 text-[12.5px]" style={{ color: "var(--ink-3)" }}>
        No tracks here.
      </p>
    );
  }
  return (
    <ul className="card overflow-hidden">
      {tracks.map((track, index) => {
        const active = playing?.path === track.path;
        return (
          <li
            key={track.path}
            className="flex items-center gap-2.5 px-2.5 py-2"
            style={{
              borderTop: index === 0 ? undefined : "1px solid var(--line)",
              background: active ? "var(--surface-2)" : undefined,
            }}
          >
            <button
              type="button"
              className="btn btn-ghost h-8 w-8 shrink-0 rounded-full p-0"
              onClick={() => onPlay(track)}
              aria-label={`Play ${track.title}`}
              title="Play"
            >
              <PlayIcon />
            </button>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px]">{track.title}</div>
              <div className="truncate text-[11px]" style={{ color: "var(--ink-3)" }}>
                {showArtist
                  ? `${track.artist || "Unknown artist"} · ${track.album || "Unknown album"}`
                  : `${track.track ? `${track.track}. ` : ""}${track.ext.toUpperCase()}`}
              </div>
            </div>
            <span
              className="num hidden shrink-0 text-[11px] sm:inline"
              style={{ color: "var(--ink-3)" }}
            >
              {track.bytes ? formatBytes(track.bytes) : ""}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
