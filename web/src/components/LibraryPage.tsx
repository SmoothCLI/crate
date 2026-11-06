import { useEffect, useRef, useState, type CSSProperties } from "react";
import { api } from "../api";
import type { LibraryBrowse, LibrarySort, LibraryTrack } from "../types";
import { formatBytes } from "../lib/format";
import { Artwork } from "./Artwork";
import {
  ArrowIcon,
  CloseIcon,
  DiscIcon,
  MuteIcon,
  PauseIcon,
  PlayIcon,
  VolumeIcon,
} from "./Icons";

const SORTS: { value: LibrarySort; label: string }[] = [
  { value: "track", label: "Album order" },
  { value: "title", label: "Title" },
  { value: "artist", label: "Artist" },
  { value: "album", label: "Album" },
  { value: "added", label: "Recently added" },
  { value: "size", label: "Largest first" },
];

// The owner's library, read from the folder layout rather than from tags: the
// paths already are ARTIST/ALBUM/[NN - ]TITLE.ext, which is what a download
// writes, so what this page lists is exactly what is on disk. Covers come from
// the same place, so a file that was copied in by hand has one too.
export function LibraryPage() {
  const [browse, setBrowse] = useState<LibraryBrowse | null>(null);
  const [artist, setArtist] = useState<string | null>(null);
  const [album, setAlbum] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<LibrarySort>("track");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Playback is a snapshot of the list that was showing when play was pressed:
  // searching on does not cut the queue off mid-album.
  const [queue, setQueue] = useState<LibraryTrack[]>([]);
  const [index, setIndex] = useState(-1);
  // The bar drives a hidden <audio> rather than wearing the browser's own
  // controls, so it has to hold what those would have told it.
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [paused, setPaused] = useState(false);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const seq = useRef(0);
  const audio = useRef<HTMLAudioElement>(null);

  const playing = index >= 0 ? queue[index] ?? null : null;

  // One request per pause in typing, not per keystroke: the server caches its
  // walk, but the request itself would still be wasted.
  useEffect(() => {
    const q = query.trim();
    const handle = window.setTimeout(
      () => {
        const mine = ++seq.current;
        setLoading(true);
        api
          .browseLibrary({
            q: q || undefined,
            artist: artist ?? undefined,
            album: album ?? undefined,
            sort,
          })
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
  }, [query, artist, album, sort]);

  // A folder removed outside the app must not leave the page filtering on an
  // artist that no longer exists.
  useEffect(() => {
    if (!browse || query.trim() || !artist) return;
    if (!browse.artists.some((entry) => entry.name === artist)) setArtist(null);
  }, [browse, artist, query]);

  // The click that picked the row is still the user gesture, so this is allowed
  // to start on its own. A new track starts from zero: the browser keeps the
  // last position otherwise, and the bar would open on the previous song's
  // minute.
  useEffect(() => {
    if (!playing) return;
    setTime(0);
    setDuration(0);
    audio.current?.play().catch(() => {
      /* the browser refused; the bar's own button still works */
    });
  }, [playing]);

  const togglePlay = () => {
    const element = audio.current;
    if (!element) return;
    if (element.paused) element.play().catch(() => {});
    else element.pause();
  };

  const seekTo = (value: number) => {
    const element = audio.current;
    if (element && Number.isFinite(element.duration)) element.currentTime = value;
    setTime(value);
  };

  const changeVolume = (value: number) => {
    setVolume(value);
    setMuted(value === 0);
    if (!audio.current) return;
    audio.current.volume = value;
    audio.current.muted = value === 0;
  };

  const startAt = (list: LibraryTrack[], track: LibraryTrack) => {
    const at = list.findIndex((entry) => entry.path === track.path);
    setQueue(list);
    setIndex(at < 0 ? 0 : at);
  };

  const step = (delta: number) => {
    setIndex((current) => {
      const next = current + delta;
      return next >= 0 && next < queue.length ? next : current;
    });
  };

  const searching = query.trim().length > 0;
  const artists = browse?.artists ?? [];
  const albums = browse?.albums ?? [];
  const tracks = browse?.tracks ?? [];
  const currentAlbum = album ? (albums.find((entry) => entry.name === album) ?? null) : null;
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
          <div className="flex min-w-0 items-center gap-2.5">
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
          </div>
          <div className="ml-auto flex items-center gap-1">
            <a className="btn btn-ghost px-2 text-[12.5px]" href="/" title="Back to the queue">
              Queue
            </a>
            <a className="btn btn-ghost px-2 text-[12.5px]" href="/admin#library" title="Health and duplicates">
              Health
            </a>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1080px] space-y-5 px-5 py-8">
        <div className="card p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="field min-w-0 flex-1"
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
            <select
              className="field shrink-0 text-[12.5px]"
              style={{ width: "auto" }}
              value={sort}
              onChange={(event) => setSort(event.target.value as LibrarySort)}
              aria-label="Sort tracks"
              title="Sort tracks"
            >
              {SORTS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {tracks.length > 0 && (
              <button
                className="btn shrink-0 text-[12.5px]"
                onClick={() => startAt(tracks, tracks[0])}
                title="Play everything in this list"
              >
                <PlayIcon />
                Play all
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
          <TrackList
            tracks={tracks}
            playing={playing}
            onPlay={(track) => startAt(tracks, track)}
            showArtist
          />
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
                  {album !== null ? (
                    // One album in view means the rest are noise: the grid gives
                    // way to the album itself, and the arrow is the way out of it.
                    <div className="card flex items-center gap-3 p-2.5">
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon shrink-0"
                        onClick={() => setAlbum(null)}
                        aria-label="All albums"
                        title="All albums"
                      >
                        <ArrowIcon className="rotate-180" />
                      </button>
                      <Artwork
                        src={currentAlbum?.dir ? api.libraryCover(currentAlbum.dir) : undefined}
                        title={album}
                        className="h-11 w-11 rounded-[8px]"
                        initialClassName="text-[14px] font-medium"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium">{album}</span>
                        <span
                          className="block truncate text-[11px]"
                          style={{ color: "var(--ink-3)" }}
                        >
                          {tracks.length} {tracks.length === 1 ? "track" : "tracks"}
                          {currentAlbum ? ` · ${formatBytes(currentAlbum.bytes)}` : ""}
                        </span>
                      </span>
                    </div>
                  ) : (
                  <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3" aria-label="Albums">
                    {albums.map((entry) => {
                      const active = album === entry.name;
                      return (
                        <button
                          key={`${entry.artist}/${entry.name}`}
                          type="button"
                          className="card flex items-center gap-2.5 p-2 text-left"
                          aria-pressed={active}
                          style={
                            active
                              ? { borderColor: "var(--ink-3)", background: "var(--surface-2)" }
                              : undefined
                          }
                          onClick={() => setAlbum(active ? null : entry.name)}
                        >
                          <Artwork
                            src={api.libraryCover(entry.dir)}
                            title={entry.name}
                            className="h-12 w-12 rounded-[8px]"
                            initialClassName="text-[15px] font-medium"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[12.5px]">{entry.name}</span>
                            <span
                              className="mt-0.5 block truncate text-[11px]"
                              style={{ color: "var(--ink-3)" }}
                            >
                              {entry.tracks} {entry.tracks === 1 ? "track" : "tracks"} ·{" "}
                              {formatBytes(entry.bytes)}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  )}
                  <TrackList
                    tracks={tracks}
                    playing={playing}
                    onPlay={(track) => startAt(tracks, track)}
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
          <div className="card mx-auto max-w-[1080px] px-3.5 py-3" data-player>
            <div className="flex items-center gap-3">
              <Artwork
                src={api.libraryCover(playing.dir)}
                title={playing.album || playing.title}
                className="h-11 w-11 rounded-[8px]"
                initialClassName="text-[13px] font-medium"
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-medium">{playing.title}</div>
                <div className="truncate text-[11px]" style={{ color: "var(--ink-3)" }}>
                  {playing.artist || "Unknown artist"}
                  {playing.album ? ` · ${playing.album}` : ""}
                </div>
              </div>
              <span className="num hidden shrink-0 text-[11px] sm:block" style={{ color: "var(--ink-3)" }}>
                {index + 1} / {queue.length}
              </span>
              <button
                className="btn btn-ghost shrink-0 px-2"
                onClick={() => {
                  audio.current?.pause();
                  setIndex(-1);
                  setQueue([]);
                }}
                aria-label="Stop playing"
                title="Stop playing"
              >
                <CloseIcon />
              </button>
            </div>

            <div className="mt-2.5 flex items-center gap-2.5">
              <button
                className="btn btn-ghost btn-icon shrink-0"
                onClick={() => step(-1)}
                disabled={index <= 0}
                aria-label="Previous track"
                title="Previous track"
              >
                <ArrowIcon className="rotate-180" />
              </button>
              <button
                className="btn btn-primary btn-icon btn-icon-lg shrink-0"
                onClick={togglePlay}
                aria-label={paused ? "Resume" : "Pause"}
                title={paused ? "Resume" : "Pause"}
              >
                {paused ? <PlayIcon size={15} /> : <PauseIcon size={16} />}
              </button>
              <button
                className="btn btn-ghost btn-icon shrink-0"
                onClick={() => step(1)}
                disabled={index + 1 >= queue.length}
                aria-label="Next track"
                title="Next track"
              >
                <ArrowIcon />
              </button>

              <span className="num shrink-0 text-[10.5px]" style={{ color: "var(--ink-3)" }}>
                {clock(time)}
              </span>
              <input
                type="range"
                className="seek min-w-0 flex-1"
                min={0}
                max={duration || 0}
                step={0.5}
                value={Math.min(time, duration || 0)}
                onChange={(event) => seekTo(Number(event.target.value))}
                style={
                  {
                    "--seek-fill": `${duration ? (Math.min(time, duration) / duration) * 100 : 0}%`,
                  } as CSSProperties
                }
                disabled={!duration}
                aria-label="Seek"
              />
              <span className="num shrink-0 text-[10.5px]" style={{ color: "var(--ink-3)" }}>
                {clock(duration)}
              </span>

              <div className="hidden shrink-0 items-center gap-1.5 sm:flex">
                <button
                  className="btn btn-ghost btn-icon"
                  onClick={() => {
                    const next = !muted;
                    setMuted(next);
                    if (audio.current) audio.current.muted = next;
                  }}
                  aria-label={muted ? "Unmute" : "Mute"}
                  title={muted ? "Unmute" : "Mute"}
                >
                  {muted || volume === 0 ? <MuteIcon /> : <VolumeIcon />}
                </button>
                <input
                  type="range"
                  className="seek w-[64px]"
                  min={0}
                  max={1}
                  step={0.05}
                  value={muted ? 0 : volume}
                  onChange={(event) => changeVolume(Number(event.target.value))}
                  style={
                    { "--seek-fill": `${(muted ? 0 : volume) * 100}%` } as CSSProperties
                  }
                  aria-label="Volume"
                />
              </div>
            </div>

            <audio
              ref={audio}
              autoPlay
              preload="metadata"
              src={api.libraryTrack(playing.path)}
              onLoadedMetadata={(event) => {
                const value = event.currentTarget.duration;
                setDuration(Number.isFinite(value) ? value : 0);
                event.currentTarget.volume = volume;
                event.currentTarget.muted = muted;
              }}
              onDurationChange={(event) => {
                const value = event.currentTarget.duration;
                setDuration(Number.isFinite(value) ? value : 0);
              }}
              onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
              onPlay={() => setPaused(false)}
              onPause={() => setPaused(true)}
              onEnded={() => {
                if (index + 1 < queue.length) setIndex(index + 1);
                else setPaused(true);
              }}
              className="hidden"
            />
          </div>
        </div>
      )}
    </div>
  );
}

// The bar reads as a clock, not as a duration field: "3:07", never "187".
function clock(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
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
            aria-current={active ? "true" : undefined}
          >
            {/* The cover is the play control: a second triangle next to it was
                a row of two nearly identical buttons, and the art is the
                bigger target anyway. It only shows the triangle on hover, so
                a list of covers stays a list of covers. */}
            <button
              type="button"
              className="group relative h-9 w-9 shrink-0 overflow-hidden rounded-[7px] border-0 bg-transparent p-0"
              onClick={() => onPlay(track)}
              aria-label={`Play ${track.title}`}
              title="Play"
            >
              <Artwork
                src={api.libraryCover(track.dir)}
                title={track.album || track.title}
                className="h-full w-full"
                initialClassName="text-[11px] font-medium"
              />
              <span
                className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
                style={{ background: "rgb(0 0 0 / 42%)" }}
                aria-hidden="true"
              >
                <PlayIcon size={12} className="text-white" />
              </span>
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
