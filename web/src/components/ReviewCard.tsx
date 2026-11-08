import { useEffect, useRef, useState, type ReactNode } from "react";
import * as Checkbox from "@radix-ui/react-checkbox";
import * as Collapsible from "@radix-ui/react-collapsible";
import type { Draft, Preview, Row } from "../types";
import { formatDuration } from "../lib/format";
import { AlertIcon, CheckIcon, CloseIcon, PencilIcon } from "./Icons";
import { CoverPicker } from "./CoverPicker";

// A long playlist is paged rather than printed as one endless column. Paging
// only changes what is drawn: selection, *all* and *none* cover every row.
const PAGE_SIZE = 50;

type Props = {
  draft: Draft;
  onChange: (patch: Partial<Draft>) => void;
  onRowChange: (i: number, patch: Partial<Row>) => void;
  onToggle: (i: number, shiftKey: boolean) => void;
  onToggleAll: (selected: boolean) => void;
  onSelectRange: (spec: string) => void;
  plan: Preview | null;
  planBusy: boolean;
  planError: string | null;
  showTargets: boolean;
  allowOpus: boolean;
  artists: string[];
  // Genre vocabulary for the field's suggestions; free text is still allowed.
  genres: string[];
  queuing: boolean;
  activeJobs: boolean;
  onQueue: () => void;
  onDiscard: () => void;
  onReinspect: () => void;
};

export function ReviewCard({
  draft,
  onChange,
  onRowChange,
  onToggle,
  onToggleAll,
  onSelectRange,
  plan,
  planBusy,
  planError,
  showTargets,
  allowOpus,
  artists,
  genres,
  queuing,
  activeJobs,
  onQueue,
  onDiscard,
  onReinspect,
}: Props) {
  const [query, setQuery] = useState("");
  const [range, setRange] = useState("");
  const [page, setPage] = useState(0);
  // A new link starts at the top instead of wherever the last draft was left.
  useEffect(() => setPage(0), [draft.url]);
  const selected = draft.rows.filter((r) => r.selected);
  const allSelected = selected.length === draft.rows.length && draft.rows.length > 0;
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? draft.rows.filter((row) => `${row.title} ${row.sourceTitle}`.toLowerCase().includes(needle))
    : draft.rows;
  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  // Clamped rather than stored: filtering can leave the remembered page past
  // the end, and an empty result still needs one page to show its message on.
  const current = Math.min(page, pages - 1);
  const paged = visible.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  const conflicts = showTargets ? (plan?.conflicts ?? 0) : 0;
  // Guests never receive these; the server only computes them for the owner.
  const duplicates = showTargets ? (plan?.duplicates ?? []) : [];
  const totalDuration = selected.reduce((sum, row) => sum + row.duration, 0);
  const firstPath = showTargets ? (plan?.tracks[0]?.path ?? "") : "";
  const targetDir = firstPath ? firstPath.slice(0, firstPath.lastIndexOf("/") + 1) : "";
  const single = draft.kind === "track";
  // What "Use source cover" goes back to, as the plan last reported it.
  const sourceCover = plan?.defaults.thumbnail ?? draft.thumbnail;

  // One cover for the whole draft: the tile previews it and every selected row
  // carries it into its own file. An empty url restores the source's image.
  function applyCover(url: string) {
    onChange(url ? { thumbnail: url, art: true } : { thumbnail: sourceCover });
    draft.rows.forEach((row) => onRowChange(row.i, { art: url }));
  }

  return (
    <section className="card unfold relative isolate overflow-hidden" aria-label="Review download">
      <div className="relative flex gap-4 p-4 sm:p-5">
        <CoverPicker
          src={draft.thumbnail}
          title={draft.title}
          source={sourceCover}
          onChange={applyCover}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-[17px] font-semibold tracking-[-0.01em] truncate">{draft.title}</h2>
              <p className="text-[13px] truncate" style={{ color: "var(--ink-2)" }}>
                {draft.kind === "playlist"
                  ? `${draft.rows.length} tracks${totalDuration ? ` · ${formatDuration(totalDuration)}` : ""}`
                  : "Single track"}
                {draft.artist ? ` · ${draft.artist}` : ""}
              </p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button className="btn btn-ghost px-2 text-[12.5px]" onClick={onReinspect} title="Inspect the link again">
                re-inspect
              </button>
              <button className="btn btn-ghost px-2" onClick={onDiscard} aria-label="Discard draft">
                <CloseIcon />
              </button>
            </div>
          </div>

          {single && (
            <label className="block mt-3">
              <span className="chip">Title</span>
              <input
                className="field mt-1"
                value={draft.rows[0]?.title ?? ""}
                onChange={(e) => onRowChange(draft.rows[0].i, { title: e.target.value })}
              />
            </label>
          )}
        </div>
      </div>

      <div className="px-4 sm:px-5 pb-4">
        {duplicates.length > 0 && (
          <div
            className="mb-4 flex items-start gap-2 rounded-lg px-3 py-2.5 text-[12px]"
            style={{ background: "var(--surface-3)", border: "1px solid var(--line-strong)" }}
          >
            <AlertIcon size={13} />
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                Possible duplicate{duplicates.length === 1 ? "" : "s"}
              </div>
              <ul className="mt-1 space-y-0.5" style={{ color: "var(--ink-2)" }}>
                {duplicates.slice(0, 4).map((match) => (
                  <li
                    key={`${match.i}-${match.source}-${match.path || match.title}`}
                    className="truncate"
                    title={match.path || match.title}
                  >
                    {match.title} · {match.source === "library" ? "already in the library" : "downloaded before"}
                    {match.path ? ` (${match.path.slice(match.path.lastIndexOf("/") + 1)})` : ""}
                  </li>
                ))}
              </ul>
              {duplicates.length < draft.rows.length && (
                <button
                  type="button"
                  className="btn btn-ghost mt-1.5 px-2 text-[11.5px]"
                  onClick={() =>
                    duplicates.forEach((match) => onRowChange(match.i, { selected: false }))
                  }
                >
                  Deselect {duplicates.length === 1 ? "it" : "them"}
                </button>
              )}
            </div>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <span className="chip">Artist</span>
            <div className="mt-1.5">
              <ArtistField
                value={draft.artist}
                options={artists}
                onChange={(artist) => onChange({ artist })}
              />
            </div>
          </div>
          <Field label="Album">
            <input
              className="field"
              value={draft.album}
              onChange={(e) => onChange({ album: e.target.value })}
              placeholder="Album"
            />
          </Field>
          <div>
            <span className="chip">Genre</span>
            <div className="mt-1.5">
              <GenreField
                value={draft.genre}
                options={genres}
                onChange={(genre) => onChange({ genre })}
              />
            </div>
          </div>
          <Field label="Date">
            <input
              className="field num"
              type="date"
              value={draft.date}
              onChange={(e) => {
                onChange({ date: e.target.value });
                draft.rows.forEach((row) => {
                  if (row.date === draft.date) onRowChange(row.i, { date: e.target.value });
                });
              }}
            />
          </Field>
          <Field label="Target LUFS">
            <input
              className="field num"
              value={draft.lufs}
              onChange={(e) => onChange({ lufs: Number(e.target.value) || 0 })}
              inputMode="numeric"
            />
          </Field>
          <Field label="Format">
            <select
              className="field"
              value={draft.format}
              onChange={(e) => onChange({ format: e.target.value })}
            >
              <option value="m4a">M4A (AAC)</option>
              <option value="mp3">MP3</option>
              {allowOpus && <option value="opus">Opus</option>}
              <option value="flac">FLAC (lossless)</option>
              <option value="wav">WAV (uncompressed)</option>
            </select>
          </Field>
          <Field label="Quality">
            <select
              className="field"
              value={draft.quality}
              onChange={(e) => onChange({ quality: Number(e.target.value) })}
            >
              <option value={1}>High (q1)</option>
              <option value={2}>Balanced (q2)</option>
              <option value={3}>Small (q3)</option>
              <option value={4}>Smaller (q4)</option>
              <option value={5}>Smallest (q5)</option>
            </select>
          </Field>
          <div className="flex flex-col justify-end gap-2 pb-0.5">
            <Toggle checked={draft.art} onChange={(art) => onChange({ art })} label="Cover art" />
            <Toggle
              checked={draft.trackPrefix}
              onChange={(trackPrefix) => onChange({ trackPrefix })}
              label="Track numbers in filenames"
            />
          </div>
        </div>

        {!single && (
          <div className="mt-4">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-0.5 mb-2">
              <span className="chip">
                Tracks · {selected.length} of {draft.rows.length}
                {needle ? ` · ${visible.length} shown` : ""}
                {pages > 1 ? ` · page ${current + 1}/${pages}` : ""}
              </span>
              <div className="flex flex-wrap items-center gap-1.5">
                {draft.rows.length > 8 && (
                  <input
                    className="field h-8 w-[150px] text-[12px]"
                    placeholder="Filter titles"
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setPage(0);
                    }}
                    aria-label="Filter tracks by title"
                  />
                )}
                <form
                  className="flex items-center gap-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    onSelectRange(range);
                  }}
                >
                  <input
                    className="field num h-8 w-[92px] text-[12px]"
                    placeholder="1-3,7"
                    value={range}
                    onChange={(e) => setRange(e.target.value)}
                    aria-label="Select tracks by number"
                    title="Select exactly these tracks, e.g. 1-3,7"
                  />
                  <button className="btn btn-ghost h-8 px-2 text-[12px]" type="submit" disabled={!range.trim()}>
                    pick
                  </button>
                </form>
                <button
                  className="btn btn-ghost px-2 text-[12.5px]"
                  onClick={() => onToggleAll(true)}
                  disabled={allSelected}
                >
                  all
                </button>
                <button
                  className="btn btn-ghost px-2 text-[12.5px]"
                  onClick={() => onToggleAll(false)}
                  disabled={selected.length === 0}
                >
                  none
                </button>
              </div>
            </div>
            <div className="inset rows overflow-hidden scroll-thin">
              {paged.map((row) => (
                <TrackRow
                  key={row.i}
                  row={row}
                  albumCover={draft.thumbnail}
                  edited={row.title !== row.sourceTitle}
                  onToggle={(shiftKey) => onToggle(row.i, shiftKey)}
                  onChange={(patch) => onRowChange(row.i, patch)}
                />
              ))}
              {visible.length === 0 && (
                <p className="px-3 py-6 text-center text-[12.5px]" style={{ color: "var(--ink-3)" }}>
                  No track matches “{query.trim()}”.
                </p>
              )}
            </div>
            {pages > 1 && (
              <div className="mt-2 flex items-center justify-between gap-2 px-0.5">
                <button
                  type="button"
                  className="btn btn-ghost h-8 px-2 text-[12px]"
                  onClick={() => setPage(current - 1)}
                  disabled={current === 0}
                >
                  ← Previous
                </button>
                <span className="num text-[12px]" style={{ color: "var(--ink-3)" }}>
                  {current * PAGE_SIZE + 1}–{Math.min(visible.length, (current + 1) * PAGE_SIZE)} of {visible.length}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost h-8 px-2 text-[12px]"
                  onClick={() => setPage(current + 1)}
                  disabled={current >= pages - 1}
                >
                  Next →
                </button>
              </div>
            )}
          </div>
        )}

        <div className="mt-4 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] min-h-[18px]">
            {planError ? (
              <span style={{ color: "var(--danger)" }}>{planError}</span>
            ) : planBusy && !plan ? (
              <span className="skeleton inline-block h-[12px] w-[240px]" />
            ) : targetDir ? (
              <>
                <span style={{ color: "var(--ink-3)" }}>Saves to</span>
                <span className="mono truncate max-w-full" title={firstPath}>
                  {targetDir}
                </span>
              </>
            ) : null}
            {conflicts > 0 && (
              <span className="tag" style={{ color: "var(--ink)" }}>
                <AlertIcon size={12} />
                {conflicts} already {conflicts === 1 ? "exists" : "exist"}
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            {conflicts > 0 ? (
              <div className="flex items-center gap-1">
                <Segment active={draft.policy === "skip"} onClick={() => onChange({ policy: "skip" })}>
                  Skip existing
                </Segment>
                <Segment active={draft.policy === "overwrite"} onClick={() => onChange({ policy: "overwrite" })}>
                  Overwrite
                </Segment>
              </div>
            ) : (
              <span className="text-[12px]" style={{ color: "var(--ink-3)" }}>
                {selected.length === 0
                  ? "Nothing selected"
                  : `${selected.length} ${selected.length === 1 ? "track" : "tracks"} ready`}
              </span>
            )}

            <button
              className="btn btn-primary h-10 px-5"
              onClick={onQueue}
              disabled={queuing || selected.length === 0}
            >
              {queuing
                ? "Queueing…"
                : `${activeJobs ? "Add to queue" : "Download"} ${selected.length === 1 ? "1 track" : `${selected.length} tracks`}`}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="chip">{label}</span>
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-2 text-[13px] cursor-pointer select-none" style={{ color: "var(--ink-2)" }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-[15px] w-[15px] accent-[var(--ink)]"
      />
      {label}
    </label>
  );
}

function Segment({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-[7px] px-2.5 py-1.5 text-[12px] transition-colors"
      style={
        active
          ? { background: "var(--ink)", color: "var(--canvas)", border: "1px solid var(--ink)" }
          : { border: "1px solid var(--line-strong)", color: "var(--ink-2)" }
      }
      aria-pressed={active}
    >
      {children}
    </button>
  );
}

// The same separators the script uses, so what the chips show and what the
// tag writer splits never disagree.
const ARTIST_SPLIT = /[,;，；、]/;

// Genre is a single tag on the other end, so the chips are written as one
// semicolon-separated value - the convention tag readers split on - and a comma
// stays part of a name like "Folk, World, & Country".
const GENRE_SPLIT = /[;；]/;

// Two spellings of one artist fold together when only case, accents,
// punctuation, full-width forms or spacing differ, so "ARTIST1", "artist-1"
// and "Artist1" all reduce to the same name.
function foldArtist(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    // Letters and digits of any script: a Cyrillic or Japanese folder name must
    // stay searchable instead of folding away to nothing.
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Identity is the folded name with its word breaks removed as well, so
// "Artist1", "artist-1" and "Artist 1" are the same entry rather than three.
function foldKey(value: string): string {
  return foldArtist(value).replace(/ /g, "");
}

function splitList(value: string, separator: RegExp): string[] {
  const names: string[] = [];
  for (const part of String(value || "").split(separator)) {
    const name = part.trim();
    if (name && !names.some((seen) => foldKey(seen) === foldKey(name))) names.push(name);
  }
  return names;
}

function splitArtists(value: string): string[] {
  return splitList(value, ARTIST_SPLIT);
}

function splitGenres(value: string): string[] {
  return splitList(value, GENRE_SPLIT);
}

// Levenshtein, only ever called with short names. Every option is scored on
// each keystroke, which stays cheap for the few hundred the API returns.
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

// Higher is a closer match; -1 means no match. An exact spelling wins, then a
// prefix of the whole name, then a prefix of any word, then a substring, and
// finally a name one or two edits away ("beatls" -> "Beatles").
function scoreArtist(candidate: string, needle: string): number {
  const name = foldArtist(candidate);
  if (!needle) return 0;
  if (name === needle) return 100;
  if (name.replace(/ /g, "") === needle.replace(/ /g, "")) return 95;
  if (name.startsWith(needle)) return 80;
  if (name.split(" ").some((word) => word.startsWith(needle))) return 70;
  if (name.includes(needle)) return 60;
  const allowance = needle.length <= 4 ? 1 : needle.length <= 8 ? 2 : 3;
  const closest = Math.min(
    editDistance(name, needle),
    ...name.split(" ").map((word) => editDistance(word, needle)),
  );
  return closest <= allowance ? 50 - closest : -1;
}

// The library's own spellings, best match first, never one already in the
// field. Everything is folded before it is compared.
function rankArtists(options: string[], typed: string, taken: string[]): string[] {
  const needle = foldArtist(typed);
  const already = new Set(taken.map(foldKey));
  return options
    .filter((name) => !already.has(foldKey(name)))
    .map((name) => ({ name, score: scoreArtist(name, needle) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 8)
    .map((entry) => entry.name);
}

// What Enter commits when no suggestion is highlighted: the library's spelling
// of an exact match, otherwise what was typed. So "artist1" becomes "Artist1",
// while a genuinely new name is still accepted as it stands.
function canonicalArtist(options: string[], typed: string): string {
  const key = foldKey(typed);
  return options.find((name) => foldKey(name) === key) ?? typed.trim();
}

// One component for both list fields: names come from what already exists
// (the library's artists, the shipped genre vocabulary), so a value is reused
// instead of creating a near-duplicate ("The Beatles" vs "Beatles",
// "hardtekk" vs "Hardtekk"). A name becomes a chip on Enter or by picking a
// suggestion, the × beside it removes it, and the value stays the plain string
// the rest of the app already sends.
type TokenFieldProps = {
  value: string;
  options: string[];
  onChange: (value: string) => void;
  split: (value: string) => string[];
  // What several chips become in the one value the tag writer receives.
  join: string;
  // Ids must differ: both fields live on the same page.
  listId: string;
  label: string;
  placeholder: string;
  emptyPlaceholder: string;
  createText: (name: string) => string;
};

function TokenField({
  value,
  options,
  onChange,
  split,
  join,
  listId,
  label,
  placeholder,
  emptyPlaceholder,
  createText,
}: TokenFieldProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [typing, setTyping] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const names = split(value);
  const key = foldKey(typing);
  // A name that already exists in the library keeps its stored spelling; only
  // a name the library has never seen is offered as a new one.
  const known = Boolean(key) && options.some((name) => foldKey(name) === key);
  const repeated = Boolean(key) && names.some((name) => foldKey(name) === key);
  const canCreate = Boolean(key) && !known && !repeated;
  const rows: { name: string; create: boolean }[] = rankArtists(options, typing, names)
    .slice(0, canCreate ? 7 : 8)
    .map((name) => ({ name, create: false }));
  if (canCreate) rows.push({ name: typing.trim(), create: true });
  const showing = open && rows.length > 0;

  // What was typed can itself be a list (a pasted "A, B"), and a name already
  // in the field is never added twice - "artist1" and "Artist1" count as one.
  function add(raw: string) {
    const next = [...names];
    for (const part of split(raw)) {
      const name = canonicalArtist(options, part);
      if (!next.some((taken) => foldKey(taken) === foldKey(name))) next.push(name);
    }
    setTyping("");
    setOpen(false);
    setActive(-1);
    if (next.length !== names.length) onChange(next.join(join));
  }

  function remove(name: string) {
    onChange(names.filter((taken) => taken !== name).join(join));
  }

  return (
    <div className="relative">
      <div
        className="field flex flex-wrap items-center gap-1.5"
        style={{ paddingTop: 8, paddingBottom: 6 }}
        onClick={() => inputRef.current?.focus()}
      >
        {names.map((name) => (
          <span key={name} className="tag relative" style={{ fontSize: 12, padding: "3px 14px 3px 9px" }}>
            {name}
            <button
              type="button"
              className="absolute flex h-[14px] w-[14px] items-center justify-center rounded-full leading-none"
              style={{
                top: -5,
                right: -5,
                background: "var(--surface)",
                border: "1px solid var(--line-strong)",
                color: "var(--ink-2)",
              }}
              aria-label={`Remove ${name}`}
              title={`Remove ${name}`}
              onClick={(event) => {
                event.stopPropagation();
                remove(name);
              }}
            >
              <CloseIcon size={9} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          className="min-w-[80px] flex-1 bg-transparent text-[13.5px] outline-none"
          style={{ color: "var(--ink)" }}
          value={typing}
          onChange={(e) => {
            setTyping(e.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            setOpen(false);
            setActive(-1);
            // Leaving the field keeps what was typed rather than discarding it.
            if (typing.trim()) add(canonicalArtist(options, typing));
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" && rows.length) {
              event.preventDefault();
              setOpen(true);
              setActive((current) => (current + 1) % rows.length);
            } else if (event.key === "ArrowUp" && rows.length) {
              event.preventDefault();
              setOpen(true);
              setActive((current) => (current <= 0 ? rows.length - 1 : current - 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (showing && active >= 0 && rows[active]) add(rows[active].name);
              else if (typing.trim()) add(canonicalArtist(options, typing));
            } else if (event.key === "Backspace" && !typing && names.length) {
              // An empty box makes Backspace take the last chip back.
              remove(names[names.length - 1]);
            } else if (event.key === "Escape") {
              setOpen(false);
              setActive(-1);
            }
          }}
          placeholder={names.length ? placeholder : emptyPlaceholder}
          role="combobox"
          aria-expanded={showing}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-label={label}
          aria-activedescendant={active >= 0 ? `${listId}-option-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      {showing && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 w-full overflow-hidden rounded-[9px] py-1"
          style={{
            background: "var(--surface)",
            border: "1px solid var(--line)",
            boxShadow: "0 8px 24px rgb(0 0 0 / 16%)",
          }}
        >
          {rows.map((row, index) => (
            <li
              key={row.create ? `create:${row.name}` : row.name}
              id={`${listId}-option-${index}`}
              role="option"
              aria-selected={index === active}
              className="cursor-pointer truncate px-3 py-1.5 text-[12.5px]"
              style={{ background: index === active ? "var(--surface-3)" : "transparent" }}
              onMouseEnter={() => setActive(index)}
              onMouseDown={(event) => {
                // Keep the input focused so its blur does not close the list first.
                event.preventDefault();
                add(row.name);
              }}
            >
              {row.create ? (
                <span style={{ color: "var(--ink-2)" }}>{createText(row.name)}</span>
              ) : (
                row.name
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ArtistField(props: {
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <TokenField
      {...props}
      split={splitArtists}
      join=", "
      listId="artist-suggestions"
      label="Artists"
      placeholder="Add another…"
      emptyPlaceholder="Artist, then Enter"
      createText={(name) => `Use “${name}” as a new artist`}
    />
  );
}

function GenreField(props: {
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <TokenField
      {...props}
      split={splitGenres}
      join="; "
      listId="genre-suggestions"
      label="Genres"
      placeholder="Add another…"
      emptyPlaceholder="Genre, then Enter"
      createText={(name) => `Add “${name}” as a new genre`}
    />
  );
}

function TrackRow({
  row,
  albumCover,
  edited,
  onToggle,
  onChange,
}: {
  row: Row;
  // The draft's cover, which a row keeps using until it is given its own.
  albumCover: string;
  edited: boolean;
  onToggle: (shiftKey: boolean) => void;
  onChange: (patch: Partial<Row>) => void;
}) {
  const [open, setOpen] = useState(false);
  const shift = useRef(false);
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="row-in">
      <div
        className="flex items-center gap-3 px-3 py-2 transition-colors"
        style={{ background: row.selected ? "transparent" : "var(--surface-2)" }}
      >
        <Checkbox.Root
          checked={row.selected}
          onPointerDown={(e) => {
            shift.current = e.shiftKey;
          }}
          onCheckedChange={() => onToggle(shift.current)}
          className="h-[17px] w-[17px] shrink-0 rounded-[5px] border flex items-center justify-center data-[state=checked]:bg-[var(--ink)] data-[state=checked]:border-[var(--ink)] data-[state=checked]:text-[var(--btn-ink)]"
          style={{ borderColor: "var(--line-strong)", background: row.selected ? undefined : "var(--surface)" }}
          aria-label={`Select ${row.title}`}
        >
          <Checkbox.Indicator>
            <CheckIcon size={11} />
          </Checkbox.Indicator>
        </Checkbox.Root>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex-1 min-w-0 text-left text-[13.5px] truncate"
          style={{ color: row.selected ? "var(--ink)" : "var(--ink-2)" }}
          title={row.title}
        >
          {row.title}
          {edited && (
            <span className="ml-1.5 align-middle" style={{ color: "var(--ink-3)", fontSize: "11px" }}>
              edited
            </span>
          )}
        </button>

        <span className="mono shrink-0" style={{ color: "var(--ink-3)", fontSize: "11px" }}>
          {formatDuration(row.duration)}
        </span>

        <Collapsible.Trigger asChild>
          <button
            className="rounded-md p-1 shrink-0"
            style={{ color: open ? "var(--ink)" : "var(--ink-3)" }}
            aria-label={`Edit ${row.title}`}
          >
            <PencilIcon />
          </button>
        </Collapsible.Trigger>
      </div>

      <Collapsible.Content className="unfold">
        <div className="grid gap-3 px-3 pb-3 pl-[46px] sm:grid-cols-2">
          <Field label="Title">
            <input className="field" value={row.title} onChange={(e) => onChange({ title: e.target.value })} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Track #">
              <input
                className="field num"
                value={row.track}
                onChange={(e) => onChange({ track: Number(e.target.value) || 1 })}
                inputMode="numeric"
              />
            </Field>
            <Field label="Date">
              <input
                className="field num"
                type="date"
                value={row.date}
                onChange={(e) => onChange({ date: e.target.value })}
              />
            </Field>
          </div>
          <div>
            <span className="chip">Cover</span>
            <div className="mt-1.5">
              <CoverPicker
                variant="row"
                src={row.art || albumCover}
                title={row.title}
                source={albumCover}
                resetLabel="Use album cover"
                description="Used for this track only - the rest of the download keeps the album's cover."
                onChange={(art) => onChange({ art })}
              />
            </div>
          </div>
          <div className="flex items-end">
            <button
              type="button"
              className="btn btn-ghost px-2 text-[12px]"
              onClick={() => onChange({ title: row.sourceTitle, art: "" })}
            >
              Reset row
            </button>
          </div>
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
