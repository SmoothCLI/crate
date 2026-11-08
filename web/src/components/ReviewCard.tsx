import { useEffect, useRef, useState, type ReactNode } from "react";
import * as Checkbox from "@radix-ui/react-checkbox";
import * as Collapsible from "@radix-ui/react-collapsible";
import type { Draft, Preview, PreviewDefaults, Row } from "../types";
import { formatDuration } from "../lib/format";
import { AlertIcon, CheckIcon, CloseIcon, PencilIcon } from "./Icons";
import { CoverPicker } from "./CoverPicker";
import { ArtistField, GenreField } from "./TokenField";

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
  // The source's own values, so an edited field can be put back.
  defaults: PreviewDefaults | null;
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
  defaults,
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
  const single = draft.kind === "track";
  // What "Use source cover" goes back to, as the plan last reported it.
  const sourceCover = plan?.defaults.thumbnail ?? draft.thumbnail;

  // One cover for the whole draft: the tile previews it and every selected row
  // carries it into its own file. An empty url restores the source's image.
  function applyCover(url: string) {
    onChange(url ? { thumbnail: url, art: true } : { thumbnail: sourceCover });
    draft.rows.forEach((row) => onRowChange(row.i, { art: url }));
  }

  // Resetting the date follows the same rule as editing it: rows that still
  // carry the old date move with the card.
  function resetDate() {
    if (!defaults) return;
    onChange({ date: defaults.date });
    draft.rows.forEach((row) => {
      if (row.date === draft.date) onRowChange(row.i, { date: defaults.date });
    });
  }

  // Ctrl/Cmd+Enter is the card's one action: queue what is selected.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !(event.metaKey || event.ctrlKey) || event.key !== "Enter") return;
      if (queuing || selected.length === 0) return;
      event.preventDefault();
      onQueue();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onQueue, queuing, selected.length]);

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
            <div className="flex items-center gap-1">
              <span className="chip">Artist</span>
              {defaults && draft.artist !== defaults.artist && (
                <ResetButton label="Artist" onClick={() => onChange({ artist: defaults.artist })} />
              )}
            </div>
            <div className="mt-1.5">
              <ArtistField
                value={draft.artist}
                options={artists}
                onChange={(artist) => onChange({ artist })}
              />
            </div>
          </div>
          <Field
            label="Album"
            onReset={defaults && draft.album !== defaults.album ? () => onChange({ album: defaults.album }) : undefined}
          >
            <input
              className="field"
              aria-label="Album"
              value={draft.album}
              onChange={(e) => onChange({ album: e.target.value })}
              placeholder="Album"
            />
          </Field>
          <div>
            <div className="flex items-center gap-1">
              <span className="chip">Genre</span>
              {defaults && draft.genre !== defaults.genre && (
                <ResetButton label="Genre" onClick={() => onChange({ genre: defaults.genre })} />
              )}
            </div>
            <div className="mt-1.5">
              <GenreField
                value={draft.genre}
                options={genres}
                onChange={(genre) => onChange({ genre })}
              />
            </div>
          </div>
          <Field
            label="Date"
            onReset={defaults && draft.date !== defaults.date ? resetDate : undefined}
          >
            <input
              className="field num"
              type="date"
              aria-label="Date"
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
              aria-label="Target LUFS"
              value={draft.lufs}
              onChange={(e) => onChange({ lufs: Number(e.target.value) || 0 })}
              inputMode="numeric"
            />
          </Field>
          <Field label="Format">
            <select
              className="field"
              aria-label="Format"
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
              aria-label="Quality"
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
            ) : firstPath ? (
              <>
                <span style={{ color: "var(--ink-3)" }}>Saves to</span>
                <span className="mono truncate max-w-full" title={firstPath}>
                  {firstPath}
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

function Field({
  label,
  children,
  onReset,
}: {
  label: string;
  children: ReactNode;
  // Present only while the value differs from the source's own.
  onReset?: () => void;
}) {
  return (
    <div className="block">
      <div className="flex items-center gap-1">
        <span className="chip">{label}</span>
        {onReset && <ResetButton label={label} onClick={onReset} />}
      </div>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

// Puts one edited field back to what the link itself offered.
function ResetButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="rounded-[6px] px-1 text-[11px] leading-none"
      style={{ color: "var(--ink-3)" }}
      title={`Reset ${label} to the source value`}
      aria-label={`Reset ${label} to the source value`}
      onClick={onClick}
    >
      ↺
    </button>
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
