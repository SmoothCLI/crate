import { useEffect, useId, useRef, useState } from "react";
import { api } from "../api";
import * as Collapsible from "@radix-ui/react-collapsible";
import { Zip, ZipPassThrough } from "fflate";
import type { Job, JobTrack, Role } from "../types";
import { formatBytes, formatClock, formatDuration, formatRate } from "../lib/format";
import { AlertIcon, CheckIcon, ChevronIcon, CloseIcon, CopyIcon, DownloadIcon, RetryIcon } from "./Icons";
import { Artwork } from "./Artwork";
import { EditTagsDialog } from "./EditTagsDialog";
import { CookiesDialog } from "./CookiesDialog";

function triggerBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export type SaveState = { bytes: number; total: number; series: number[]; rate: number };

// Same-origin link with `download`: the response goes to the browser's own
// download manager and the page never navigates to the API URL.
function triggerDownload(href: string, name: string) {
  const link = document.createElement("a");
  link.href = href;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

// The owner can switch guest access off while this list is open. The browser's
// own download manager would save the server's JSON refusal as a broken audio
// file, so the page says it in words instead.
const GUEST_OFF_TEXT =
  "Guest access has been turned off, so downloads are paused. Ask the owner to turn it back on in Settings.";

// 36 px of the source's cover art. The job keeps the URL, not a copy, so the
// image comes from the same CDN the audio did; a broken or missing URL falls
// back to the first letter, like the draft card does.
function JobArt({ job }: { job: Job }) {
  return <Artwork src={job.thumb} title={job.title} className="h-9 w-9 rounded-[7px]" />;
}

function trackUrl(job: Job, i: number): string {
  return job.stream ? `/api/jobs/${job.id}/stream/${i}` : `/api/jobs/${job.id}/file/${i}`;
}

function trackFilename(job: Job, track: JobTrack): string {
  if (!job.stream && track.path) return track.path.split("/").pop() || `track.${job.format}`;
  const prefix = job.trackPrefix && job.kind === "playlist" ? `${String(track.i).padStart(2, "0")} - ` : "";
  const base =
    `${prefix}${track.title}`
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "track";
  return `${base}.${job.format}`;
}

// One file for a single track. For an album the zip is assembled in the page
// with fflate, so the server never buffers an archive: guests receive audio
// encoded on demand, the owner fetches the files already on disk. Every byte
// that arrives is counted here, so the queue can show a rate and a graph even
// when the browser is not the one doing the transfer (owner files on disk).
async function saveJob(job: Job, report?: (state: SaveState | null) => void) {
  const tracks = job.stream
    ? (() => {
        const pending = job.tracks.filter((track) => track.state !== "done");
        return pending.length ? pending : job.tracks;
      })()
    : job.tracks.filter((track) => track.state === "done" && track.path);
  if (tracks.length === 0) return;

  let bytes = 0;
  let total = 0;
  let rate = 0;
  let series: number[] = [];
  let mark = { t: Date.now(), bytes: 0 };

  const publish = () => {
    const now = Date.now();
    const dt = now - mark.t;
    if (dt < 120) return;
    rate = Math.max(0, ((bytes - mark.bytes) * 1000) / dt);
    series = [...series, rate].slice(-60);
    mark = { t: now, bytes };
    report?.({ bytes, total, series, rate });
  };

  // A guest's single track goes straight to the browser: the server counts
  // those bytes for us. Everything else is fetched here so it can be metered.
  if (tracks.length === 1 && job.stream) {
    // One cheap check first: if guests were switched off since this job was
    // queued, the download would land as an unreadable file in the browser's
    // download list. Say it plainly instead.
    try {
      const me = await api.me();
      if (!me.guestEnabled) {
        window.alert(GUEST_OFF_TEXT);
        return;
      }
    } catch {
      // /api/me is public; failing it means the network is gone, and the
      // download attempt will surface that on its own.
    }
    triggerDownload(trackUrl(job, tracks[0].i), trackFilename(job, tracks[0]));
    return;
  }

  if (tracks.length === 1) {
    const track = tracks[0];
    try {
      const res = await fetch(trackUrl(job, track.i));
      if (!res.ok || !res.body) throw new Error(await failureMessage(res));
      total = Number(res.headers.get("content-length") || 0);
      const blob = await readMetered(res, (size) => {
        bytes += size;
        publish();
      });
      triggerBlob(blob, trackFilename(job, track));
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "The download failed.");
    } finally {
      report?.(null);
    }
    return;
  }

  const parts: Uint8Array[] = [];
  const state = { error: null as Error | null };
  let finish!: () => void;
  const complete = new Promise<void>((resolve) => (finish = resolve));
  const zip = new Zip((err, chunk, final) => {
    if (err) {
      state.error = err;
      finish();
      return;
    }
    if (chunk) parts.push(chunk);
    if (final) finish();
  });

  try {
    for (const track of tracks) {
      const res = await fetch(trackUrl(job, track.i));
      if (!res.ok || !res.body) throw new Error(await failureMessage(res));
      total += Number(res.headers.get("content-length") || 0);
      const entry = new ZipPassThrough(trackFilename(job, track));
      zip.add(entry);
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          bytes += value.length;
          entry.push(value, false);
          publish();
        }
      }
      entry.push(new Uint8Array(0), true);
    }
    zip.end();
    await complete;
    if (state.error) throw state.error;
    triggerBlob(new Blob(parts as BlobPart[], { type: "application/zip" }), `${job.title}.zip`);
  } catch (err) {
    window.alert(err instanceof Error ? err.message : "The download failed.");
  } finally {
    report?.(null);
  }
}

async function failureMessage(res: Response): Promise<string> {
  if (res.ok) return "The download failed.";
  try {
    const data = await res.json();
    if (data?.error) return String(data.error);
  } catch {
    /* not a JSON error */
  }
  return `Download failed (${res.status}).`;
}

async function readMetered(res: Response, onChunk: (size: number) => void): Promise<Blob> {
  const chunks: Uint8Array[] = [];
  const reader = res.body!.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      onChunk(value.length);
    }
  }
  return new Blob(chunks as BlobPart[], { type: "application/octet-stream" });
}

// The server reports how many bytes of the response have gone out; the page
// turns those updates into a rate and a small history for the speed graph.
// The encoder's position in the song (pct) gives the time remaining.
function useTransfer(bytes: number, pct: number, active: boolean) {
  const last = useRef<{ t: number; bytes: number } | null>(null);
  const lastPct = useRef<{ t: number; pct: number } | null>(null);
  const [state, setState] = useState<{ rate: number; series: number[]; eta: number | null }>({
    rate: 0,
    series: [],
    eta: null,
  });

  useEffect(() => {
    if (!active) {
      last.current = null;
      lastPct.current = null;
      setState({ rate: 0, series: [], eta: null });
      return;
    }
    if (bytes > 0) {
      const now = Date.now();
      const prev = last.current;
      last.current = { t: now, bytes };
      if (prev && now - prev.t >= 60) {
        const rate = Math.max(0, ((bytes - prev.bytes) * 1000) / (now - prev.t));
        setState((s) => ({ ...s, rate, series: [...s.series, rate].slice(-60) }));
      }
    }

    if (pct <= 0 || pct >= 100) {
      lastPct.current = null;
      return;
    }
    const now = Date.now();
    const prev = lastPct.current;
    lastPct.current = { t: now, pct };
    if (!prev) return;
    const gained = pct - prev.pct;
    const elapsed = (now - prev.t) / 1000;
    if (gained <= 0 || elapsed <= 0) return;
    const eta = (100 - pct) / (gained / elapsed);
    setState((s) => ({ ...s, eta: eta > 0 && eta < 7200 ? eta : null }));
  }, [bytes, pct, active]);

  return state;
}

function Sparkline({ series, width, height }: { series: number[]; width: number; height: number }) {
  const max = Math.max(1, ...series);
  const step = series.length > 1 ? width / (series.length - 1) : width;
  const base = height - 1;
  const points = series
    .map((value, i) => `${(i * step).toFixed(1)},${(base - (value / max) * (height - 4)).toFixed(1)}`)
    .join(" ");
  // useId keeps two graphs on one page from sharing a fill; colons are not safe
  // inside an SVG url(#...) reference, so drop them.
  const fillId = `spark-${useId().replace(/[:]/g, "")}`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      aria-hidden="true"
      style={{ color: "var(--ink-2)" }}
    >
      <defs>
        {/* The area under the line fades into the card instead of ending in a
            solid block of ink at the baseline. */}
        <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.34" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <line x1="0" y1={base} x2={width} y2={base} stroke="var(--line)" strokeWidth="1" />
      {series.length > 1 && (
        <>
          <polygon points={`0,${base} ${points} ${width},${base}`} fill={`url(#${fillId})`} />
          <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" />
        </>
      )}
    </svg>
  );
}

function SpeedGraph({ series, rate, eta }: { series: number[]; rate: number; eta?: number | null }) {
  return (
    <div className="mt-3 flex items-center gap-3" aria-live="off">
      <Sparkline series={series} width={120} height={24} />
      <span className="mono" style={{ color: "var(--ink-3)", fontSize: "11px" }}>
        {formatRate(rate)}
        {eta ? ` · ${formatClock(eta * 1000)} left` : ""}
      </span>
    </div>
  );
}

const STAGES = ["download", "analyse", "encode", "art", "tags", "verify"] as const;
const STAGE_LABEL: Record<string, string> = {
  download: "download",
  analyse: "analyse",
  encode: "encode",
  art: "cover art",
  tags: "tags",
  verify: "verify",
};

// The job that is running right now, at the size its artwork deserves. The
// queue row below keeps its compact readout (log, tracks, cancel); this is the
// one glanceable answer to "what is it doing?".
function NowDownloading({
  job,
  extra,
  leaving = false,
  onCancel,
}: {
  job: Job;
  extra: number;
  // Kept on screen for a beat after it settles, shrinking away with a check.
  leaving?: boolean;
  onCancel: (id: string) => void;
}) {
  const live = job.tracks.find((track) => track.state === "running");
  const streaming = Boolean(job.stream);
  const { rate, eta } = useTransfer(live?.size ?? 0, live?.pct ?? 0, job.state === "running");
  const pct = overallPct(job);
  const waiting = streaming && pct <= 0;
  const stage = live?.stage ? (STAGE_LABEL[live.stage] ?? live.stage) : "";
  const detail = [
    `track ${Math.min(job.completed + 1, job.total)} of ${job.total}`,
    stage,
    job.kind === "playlist" ? live?.title ?? "" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const transfer = [rate > 0 ? formatRate(rate) : "", eta ? `${formatClock(eta * 1000)} left` : ""]
    .filter(Boolean)
    .join(" · ");
  const readout = streaming
    ? live?.size
      ? formatBytes(live.size)
      : "…"
    : `${Math.round(pct)}%`;

  return (
    <section
      className={`card relative isolate mb-5 flex flex-col gap-4 overflow-hidden p-4 sm:flex-row sm:items-center ${
        leaving ? "hero-out" : ""
      }`}
      aria-label={leaving ? `Finished ${job.title}` : `Downloading ${job.title}`}
    >
      {/* The cover's own colour, thrown wide and soft behind the card. */}
      {job.thumb && (
        <img
          src={job.thumb}
          alt=""
          aria-hidden="true"
          referrerPolicy="no-referrer"
          className="pointer-events-none absolute -left-12 -top-20 -z-10 h-64 w-64 rounded-full object-cover opacity-30 blur-3xl saturate-150"
        />
      )}
      <Artwork
        src={job.thumb}
        title={job.title}
        className="relative h-[104px] w-[104px] rounded-[12px]"
        initialClassName="text-[30px] font-medium"
        style={{ boxShadow: "var(--art-shadow)" }}
      />

      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
          <span className="chip" style={{ letterSpacing: "0.04em" }}>
            {leaving ? (
              job.state === "failed" ? (
                <AlertIcon size={12} />
              ) : (
                <CheckIcon />
              )
            ) : (
              <span className="dot dot-live" />
            )}
            {leaving
              ? job.state === "failed"
                ? "stopped"
                : "saved"
              : streaming
                ? "sending"
                : "downloading"}
          </span>
          {extra > 0 && (
            <span className="text-[11px]" style={{ color: "var(--ink-3)" }}>
              +{extra} more running
            </span>
          )}
        </div>

        <div className="truncate text-[19px] font-semibold leading-tight tracking-[-0.01em]">
          {job.title}
        </div>
        <div className="mt-0.5 truncate text-[12.5px]" style={{ color: "var(--ink-2)" }}>
          {[job.artist, job.album].filter(Boolean).join(" · ") ||
            (job.kind === "playlist" ? `${job.total} tracks` : job.format.toUpperCase())}
        </div>

        <div className="mt-3 flex items-center gap-3">
          <div
            className={`bar flex-1 ${waiting ? "bar-indeterminate" : ""}`}
            style={{ height: 4 }}
          >
            <i style={{ width: waiting ? "100%" : `${Math.max(pct, 1)}%` }} />
          </div>
          <span className="mono shrink-0" style={{ color: "var(--ink-2)", fontSize: "11.5px" }}>
            {readout}
          </span>
        </div>
        <div
          className="mt-1 flex items-center justify-between gap-3 text-[11.5px]"
          style={{ color: "var(--ink-3)" }}
        >
          <span className="truncate">{detail}</span>
          <span className="shrink-0">{transfer}</span>
        </div>
      </div>

      {!leaving && (
        <button
          className="btn btn-ghost shrink-0 self-start px-2 text-[12.5px] sm:self-center"
          onClick={() => onCancel(job.id)}
          aria-label="Cancel download"
          title="Cancel"
        >
          <CloseIcon />
          Cancel
        </button>
      )}
    </section>
  );
}

export function Queue({
  jobs,
  role,
  onCancel,
  onRetry,
  onRemove,
  onRetag,
  onClearFinished,
}: {
  jobs: Job[];
  role: Role;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
  onRetag: (
    id: string,
    tags: { title?: string; artist: string; album: string; genre: string },
  ) => Promise<{ warning?: string }>;
  onClearFinished: () => void;
}) {
  // A queued stream job is idle until someone saves it, so it is not "active".
  const active = jobs.filter(
    (j) => j.state === "running" || (!j.stream && (j.state === "queued" || j.state === "cancelling")),
  ).length;

  // Bytes the page itself is pulling for this job, so owner downloads get the
  // same live readout as guest streams (whose bytes the server counts).
  // j / k move through the queue, Enter opens the highlighted job, Escape
  // clears the highlight. Nothing here changes the job itself.
  const [cursor, setCursor] = useState(-1);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (event.key === "Escape") {
        setCursor(-1);
        return;
      }
      if (event.key === "Enter") {
        if (cursor < 0) return;
        document
          .querySelector<HTMLElement>(`[data-job-index="${cursor}"]`)
          ?.querySelector<HTMLButtonElement>("button[aria-expanded]")
          ?.click();
        return;
      }
      if ((event.key !== "j" && event.key !== "k") || jobs.length === 0) return;
      event.preventDefault();
      setCursor((current) => {
        if (event.key === "j") return current >= jobs.length - 1 ? current : current + 1;
        return current <= 0 ? 0 : current - 1;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [jobs.length, cursor]);

  useEffect(() => {
    if (cursor < 0) return;
    document
      .querySelector<HTMLElement>(`[data-job-index="${cursor}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const [saves, setSaves] = useState<Record<string, SaveState>>({});
  const onSaveState = (id: string, state: SaveState | null) =>
    setSaves((all) => {
      if (!state) {
        const { [id]: _dropped, ...rest } = all;
        return rest;
      }
      return { ...all, [id]: state };
    });
  const running = jobs.find((job) => job.state === "running");
  const alsoRunning = jobs.filter((job) => job.state === "running").length - 1;

  // Hold the card for one beat after its job settles, so it shrinks away with
  // a check rather than being swapped out mid-paint by the next poll.
  const [ghost, setGhost] = useState<Job | null>(null);
  const lastRunning = useRef<string | null>(null);
  // Kept outside the effect: the queue updates again while the card is leaving,
  // and an effect cleanup would cancel the timer that removes it.
  const ghostTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (ghostTimer.current) window.clearTimeout(ghostTimer.current);
    },
    [],
  );
  useEffect(() => {
    if (running) {
      lastRunning.current = running.id;
      setGhost(null);
      return;
    }
    const id = lastRunning.current;
    if (!id) return;
    lastRunning.current = null;
    const settled = jobs.find((job) => job.id === id);
    if (!settled || (settled.state !== "done" && settled.state !== "failed")) return;
    setGhost(settled);
    if (ghostTimer.current) window.clearTimeout(ghostTimer.current);
    ghostTimer.current = window.setTimeout(() => {
      ghostTimer.current = null;
      setGhost(null);
    }, 620);
  }, [running, jobs]);

  const hero = running ?? ghost ?? undefined;

  // Which job (if any) opened the cookie jar. Saving it retries that job, which
  // is the whole point of the offer: the failure was the missing jar.
  const [cookiesFor, setCookiesFor] = useState<string | null>(null);

  return (
    <section aria-labelledby="queue-label">
      {hero && (
        <NowDownloading
          job={hero}
          extra={running ? Math.max(0, alsoRunning) : 0}
          leaving={!running}
          onCancel={onCancel}
        />
      )}
      <div className="flex items-baseline justify-between mb-3">
        <h2 id="queue-label" className="text-[17px] font-semibold tracking-[-0.01em] flex items-center gap-2">
          Queue
          {active > 0 && (
            <span className="chip" style={{ letterSpacing: "0.04em" }}>
              {active} active
            </span>
          )}
        </h2>
        {jobs.some((j) => j.state === "done" || j.state === "failed" || j.state === "cancelled") && (
          <button className="btn btn-ghost px-2 text-[12.5px]" onClick={onClearFinished}>
            Clear finished
          </button>
        )}
      </div>

      {jobs.length === 0 ? (
        <div
          className="card px-4 py-8 text-center text-[13px]"
          style={{ color: "var(--ink-3)", borderStyle: "dashed" }}
        >
          Nothing queued yet. Paste a link above and the finished files show up here.
        </div>
      ) : (
        <div className="card rows overflow-hidden">
          {jobs.map((job, index) => (
            <JobRow
              key={job.id}
              job={job}
              index={index}
              active={index === cursor}
              showPaths={role === "owner"}
              canEdit={role === "owner"}
              saving={saves[job.id]}
              onSaveState={onSaveState}
              onCancel={onCancel}
              onRetry={onRetry}
              onRemove={onRemove}
              onRetag={onRetag}
              onAddCookies={role === "owner" ? () => setCookiesFor(job.id) : undefined}
            />
          ))}
        </div>
      )}

      {role === "owner" && (
        <CookiesDialog
          open={cookiesFor !== null}
          onOpenChange={(next) => {
            if (!next) setCookiesFor(null);
          }}
          onSaved={() => {
            const id = cookiesFor;
            setCookiesFor(null);
            if (id) onRetry(id);
          }}
        />
      )}
    </section>
  );
}

function remainingLabel(expiresAt: number): string {
  const left = expiresAt - Date.now();
  if (left <= 0) return "expired";
  const minutes = Math.floor(left / 60_000);
  if (minutes >= 1) return `${minutes} min`;
  return `${Math.max(1, Math.ceil(left / 1000))} s`;
}

function overallPct(job: Job): number {
  if (job.state === "done") return 100;
  if (job.total === 0) return 0;
  const settled = job.tracks.filter((t) => t.state === "done" || t.state === "skipped").length;
  const running = job.tracks.find((t) => t.state === "running");
  return Math.min(100, ((settled + (running ? (running.pct || 0) / 100 : 0)) / job.total) * 100);
}

function statusLine(job: Job, rate = 0, eta: number | null = null, saving?: SaveState): string {
  if (saving) {
    const of = saving.total > 0 ? ` of ${formatBytes(saving.total)}` : "";
    const speed = saving.rate > 0 ? ` · ${formatRate(saving.rate)}` : "";
    return `saving ${formatBytes(saving.bytes)}${of}${speed}`;
  }
  switch (job.state) {
    case "queued":
      if (job.stream) {
        return job.completed
          ? `${job.completed} of ${job.total} saved - press save for the rest`
          : "ready - save it when you want it";
      }
      return "queued - starts after the current download";
    case "running": {
      if (job.stream) {
        const live = job.tracks.find((t) => t.state === "running");
        const sent = live?.size ? ` · ${formatBytes(live.size)}` : "";
        const speed = rate > 0 ? ` · ${formatRate(rate)}` : "";
        const left = eta ? ` · ${formatClock(eta * 1000)} left` : "";
        return `sending ${Math.min(job.completed + 1, job.total)}/${job.total} to the browser${sent}${speed}${left}`;
      }
      const track = job.tracks.find((t) => t.state === "running");
      const stage = track?.stage ? ` · ${STAGE_LABEL[track.stage] ?? track.stage}` : "";
      return `downloading ${Math.min(job.completed + 1, job.total)}/${job.total}${stage}`;
    }
    case "cancelling":
      return "stopping - the partial file is kept";
    case "done": {
      const size = job.tracks.reduce((sum, t) => sum + (t.size || 0), 0);
      const bits = [`${job.completed} of ${job.total} saved`];
      if (job.skipped) bits.push(`${job.skipped} skipped`);
      if (job.failed) bits.push(`${job.failed} failed`);
      if (size) bits.push(formatBytes(size));
      if (job.expired) bits.push("files removed");
      else if (job.expiresAt) bits.push(`available for ${remainingLabel(job.expiresAt)}`);
      return bits.join(" · ");
    }
    case "failed":
      return job.error || "failed";
    case "cancelled":
      return job.error || "cancelled - re-run to continue the partial download";
  }
}

function JobRow({
  job,
  index,
  active,
  showPaths,
  canEdit,
  saving,
  onSaveState,
  onCancel,
  onRetry,
  onRemove,
  onRetag,
  onAddCookies,
}: {
  job: Job;
  index: number;
  active: boolean;
  showPaths: boolean;
  canEdit: boolean;
  saving?: SaveState;
  onSaveState: (id: string, state: SaveState | null) => void;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
  onAddCookies?: () => void;
  onRetag: (
    id: string,
    tags: { title?: string; artist: string; album: string; genre: string },
  ) => Promise<{ warning?: string }>;
}) {
  const [open, setOpen] = useState(false);
  const pct = overallPct(job);
  const streaming = Boolean(job.stream) && job.state === "running";
  const liveTrack = streaming ? job.tracks.find((track) => track.state === "running") : undefined;
  const sent = liveTrack?.size ?? 0;
  const { rate, series, eta } = useTransfer(sent, liveTrack?.pct ?? 0, streaming);
  const savePct = saving && saving.total > 0 ? Math.min(100, (saving.bytes / saving.total) * 100) : null;
  const live = job.state === "running" || job.state === "queued" || job.state === "cancelling";
  // Both guests and the owner can pull finished files through the browser; the
  // owner can also copy the path because the files are on their own disk.
  const remaining = job.stream ? job.tracks.filter((t) => t.state !== "done").length : 0;
  const canStream = Boolean(job.stream) && job.state !== "running" && remaining > 0;
  // Saving needs at least one track that actually produced a file: a job whose
  // tracks were all skipped as "already in the library" has nothing to send.
  const available = job.tracks.some((t) => t.state === "done" && t.path);
  const canDownload =
    !saving && (job.stream ? canStream : job.state === "done" && !job.expired && available);
  const save = () => void saveJob(job, (state) => onSaveState(job.id, state));

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} data-job-index={index}>
      <div
        className="job-row flex items-center gap-3 px-4 py-3"
        style={active ? { background: "var(--surface-3)" } : undefined}
      >
        <StatusGlyph job={job} />
        <JobArt job={job} />

        <Collapsible.Trigger asChild>
          <button className="flex-1 min-w-0 text-left" aria-expanded={open}>
            <div className="truncate text-[13.5px] font-medium">{job.title}</div>
            <div className="truncate text-[12px] mt-0.5" style={{ color: job.state === "failed" ? "var(--danger)" : "var(--ink-3)" }}>
              {statusLine(job, streaming ? rate : 0, streaming ? eta : null, saving)}
            </div>
          </button>
        </Collapsible.Trigger>

        <div className="hidden sm:flex flex-col items-end gap-1 w-[92px] shrink-0">
          <span className="mono" style={{ color: "var(--ink-3)", fontSize: "11px" }}>
            {job.state === "done" && !saving
              ? "100%"
              : saving
                ? savePct !== null
                  ? `${Math.round(savePct)}%`
                  : formatBytes(saving.bytes)
                : job.stream
                  ? streaming
                    ? sent
                      ? formatBytes(sent)
                      : "sending"
                    : "ready"
                  : `${Math.round(pct)}%`}
          </span>
          {saving ? (
            saving.series.length > 1 ? (
              <span className="w-full flex justify-end" style={{ color: "var(--ink-3)" }}>
                <Sparkline series={saving.series} width={92} height={18} />
              </span>
            ) : (
              <div className="bar w-full">
                <i style={{ width: `${savePct ?? 0}%` }} />
              </div>
            )
          ) : job.stream ? (
            streaming &&
            (series.length > 1 ? (
              <span className="w-full flex justify-end" style={{ color: "var(--ink-3)" }}>
                <Sparkline series={series} width={92} height={18} />
              </span>
            ) : (
              <div className="bar w-full bar-indeterminate">
                <i style={{ width: "100%" }} />
              </div>
            ))
          ) : (
            <div className={`bar w-full ${job.state === "queued" ? "bar-indeterminate" : ""}`}>
              <i style={{ width: `${job.state === "running" ? Math.max(pct, 2) : pct}%` }} />
            </div>
          )}
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          {canDownload && (
            <button
              className="btn btn-ghost px-2"
              title="Save"
              aria-label="Save job"
              onClick={save}
            >
              <DownloadIcon />
            </button>
          )}
          {live && job.state !== "cancelling" && (
            <button
              className="btn btn-ghost px-2"
              title="Cancel"
              aria-label="Cancel job"
              onClick={() => onCancel(job.id)}
            >
              <CloseIcon />
            </button>
          )}
          {!live && (job.state !== "done" || job.expired) && (
            <button
              className="btn btn-ghost px-2"
              title={job.expired ? "Download again" : "Retry - continues from the kept partial"}
              aria-label={job.expired ? "Download again" : "Retry job"}
              onClick={() => onRetry(job.id)}
            >
              <RetryIcon />
            </button>
          )}
          {!live && (
            <button
              className="btn btn-ghost px-2"
              title="Remove from list"
              aria-label="Remove job"
              onClick={() => onRemove(job.id)}
            >
              <CloseIcon />
            </button>
          )}
          <Collapsible.Trigger asChild>
            <button className="btn btn-ghost px-1.5" aria-label={open ? "Collapse job" : "Expand job"}>
              <ChevronIcon className={open ? "rotate-180 transition-transform" : "transition-transform"} />
            </button>
          </Collapsible.Trigger>
        </div>
      </div>

      <Collapsible.Content className="unfold">
        <div className="px-4 pb-4">
          <div className="inset p-3">
            {job.needsCookies && (
              <div
                className="mb-3 rounded-lg px-3 py-2.5 text-[12px]"
                style={{ background: "var(--surface-3)", border: "1px solid var(--line-strong)" }}
                role="status"
              >
                <div className="flex items-center gap-1.5 font-medium">
                  <AlertIcon size={12} /> This source wanted a signed-in session
                </div>
                <p className="mt-1 leading-relaxed" style={{ color: "var(--ink-2)" }}>
                  Paste a cookies.txt and the download can run with your account. Guests never get
                  this offer, and the jar is never used for their downloads.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {onAddCookies && (
                    <button
                      type="button"
                      className="btn btn-ghost px-2 text-[11.5px]"
                      onClick={onAddCookies}
                    >
                      Add cookies…
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-ghost px-2 text-[11.5px]"
                    onClick={() => onRetry(job.id)}
                  >
                    Retry
                  </button>
                </div>
              </div>
            )}
            <div className="flex items-center justify-between mb-2">
              <span className="chip">
                {job.kind === "playlist" ? `${job.total} tracks` : "Single track"}
                {job.artist ? ` · ${job.artist}` : ""}
                {job.genre ? ` · ${job.genre}` : ""}
              </span>
              <span className="mono" style={{ color: "var(--ink-3)", fontSize: "11px" }}>
                {job.startedAt
                  ? `${formatClock((job.finishedAt ?? Date.now()) - job.startedAt)}`
                  : job.stream
                    ? "not started"
                    : "waiting"}
              </span>
            </div>

            <div className="space-y-1.5">
              {job.tracks.map((track) => (
                <TrackLine
                  key={track.i}
                  track={track}
                  showPath={showPaths}
                  stream={Boolean(job.stream)}
                  downloadHref={job.stream || canDownload ? trackUrl(job, track.i) : undefined}
                />
              ))}
            </div>

            {streaming && series.length > 1 && <SpeedGraph series={series} rate={rate} eta={eta} />}
            {saving && saving.series.length > 1 && (
              <SpeedGraph series={saving.series} rate={saving.rate} />
            )}

            {canEdit && job.state === "done" && <EditTagsDialog job={job} onSave={onRetag} />}

            {canDownload && (
              <button className="btn mt-3 w-full text-[12.5px]" onClick={save}>
                <DownloadIcon />
                {job.stream
                  ? remaining === 1
                    ? "Save"
                    : `Save ${remaining} tracks as ZIP`
                  : job.tracks.filter((t) => t.state === "done").length === 1
                    ? "Save"
                    : `Save ${job.tracks.filter((t) => t.state === "done").length} tracks as ZIP`}
              </button>
            )}

            {job.expiresAt && !job.expired && (
              <p className="mt-2 text-[11.5px]" style={{ color: "var(--ink-3)" }}>
                Staged on the server for {remainingLabel(job.expiresAt)} more - save it before then, or it is
                deleted automatically.
              </p>
            )}

            {job.expired && (
              <p className="mt-2 text-[11.5px]" style={{ color: "var(--ink-3)" }}>
                The staged files were deleted on schedule. Use ↻ to download them again.
              </p>
            )}

            {job.kind === "playlist" && job.tracks.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {STAGES.map((stage) => (
                  <span key={stage} className="tag" style={{ fontSize: "10.5px" }}>
                    {STAGE_LABEL[stage]}
                  </span>
                ))}
              </div>
            )}
          </div>

          {job.log.length > 0 && (
            <Collapsible.Root>
              <Collapsible.Trigger asChild>
                <button className="btn btn-ghost px-2 text-[12px] mt-2">Show log</button>
              </Collapsible.Trigger>
              <Collapsible.Content>
                <pre className="log inset mt-2 p-3">{job.log.slice(-120).join("\n")}</pre>
              </Collapsible.Content>
            </Collapsible.Root>
          )}

          <div className="mt-2 flex items-center gap-3 text-[11.5px] mono" style={{ color: "var(--ink-3)" }}>
            <span className="truncate" title={job.url}>
              {job.url}
            </span>
          </div>
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

function TrackLine({
  track,
  downloadHref,
  showPath,
  stream,
}: {
  track: JobTrack;
  downloadHref?: string;
  showPath: boolean;
  stream: boolean;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!track.path) return;
    try {
      await navigator.clipboard.writeText(track.path);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked (plain http on some browsers) */
    }
  }

  return (
    <div className="flex items-center gap-2.5 text-[12.5px]">

      <span className="flex-1 min-w-0" style={{ color: track.state === "queued" ? "var(--ink-3)" : "var(--ink)" }}>
        <span className="block truncate">{track.title}</span>
        {track.state === "failed" && track.error && (
          <span className="block truncate text-[11.5px]" style={{ color: "var(--danger)" }} title={track.error}>
            {track.error}
          </span>
        )}
      </span>

      {track.state === "running" && (
        <span className="chip shrink-0" style={{ letterSpacing: "0.03em" }}>
          {track.size
            ? `${formatBytes(track.size)} sent`
            : `${STAGE_LABEL[track.stage ?? ""] ?? track.stage ?? "working"} ${track.pct ? `${track.pct}%` : ""}`}
        </span>
      )}
      {track.state === "queued" && <span className="chip shrink-0">{stream ? "not saved" : "queued"}</span>}
      {track.state === "skipped" && (
        <span
          className="chip shrink-0"
          title={track.duplicatePath ? `Already in the library: ${track.duplicatePath}` : undefined}
        >
          {track.duplicatePath ? "duplicate · skipped" : "exists · skipped"}
        </span>
      )}
      {track.state === "failed" && (
        <span className="chip shrink-0 inline-flex items-center gap-1" style={{ color: "var(--danger)" }}>
          <AlertIcon size={11} /> failed
        </span>
      )}
      {downloadHref && track.state !== "done" && (
        <a
          href={downloadHref}
          download
          className="rounded p-1 shrink-0"
          style={{ color: "var(--ink-3)" }}
          title="Save this track"
          aria-label={`Save ${track.title}`}
        >
          <DownloadIcon size={12} />
        </a>
      )}
      {track.state === "done" && (
        <span className="flex items-center gap-1.5 shrink-0">
          {track.size ? (
            <span className="mono" style={{ color: "var(--ink-3)", fontSize: "11px" }}>
              {formatBytes(track.size)}
            </span>
          ) : (
            <span className="mono" style={{ color: "var(--ink-3)", fontSize: "11px" }}>
              {formatDuration(track.duration)}
            </span>
          )}
          {showPath && track.path && (
            <button
              type="button"
              onClick={copy}
              className="rounded p-1"
              style={{ color: copied ? "var(--ink)" : "var(--ink-3)" }}
              title={track.path}
              aria-label="Copy file path"
            >
              {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
            </button>
          )}
          {downloadHref && (
            <a
              href={downloadHref}
              className="rounded p-1"
              style={{ color: "var(--ink-3)" }}
              title="Save this track"
              aria-label={`Save ${track.title}`}
            >
              <DownloadIcon size={12} />
            </a>
          )}
        </span>
      )}
    </div>
  );
}

function StatusGlyph({ job }: { job: Job }) {
  if (job.state === "running") return <span className="dot dot-live" aria-label="running" />;
  if (job.state === "queued") return <span className="dot" aria-label="queued" />;
  if (job.state === "done") {
    return (
      <span style={{ color: "var(--ink)" }} aria-label="done">
        <CheckIcon size={14} />
      </span>
    );
  }
  if (job.state === "failed") {
    return (
      <span style={{ color: "var(--danger)" }} aria-label="failed">
        <AlertIcon size={14} />
      </span>
    );
  }
  return (
    <span style={{ color: "var(--ink-3)" }} aria-label="cancelled">
      <CloseIcon size={13} />
    </span>
  );
}
