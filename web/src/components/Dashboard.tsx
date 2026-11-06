import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../api";
import type { Diagnostics, GuestTally, HistoryEntry, Job, LibraryStats, Settings } from "../types";
import { formatBytes } from "../lib/format";
import { AlertIcon, ArrowIcon, GearIcon } from "./Icons";
import { UpdateHint } from "./UpdateHint";
import { EffectsToggle } from "./EffectsToggle";

const DAILY = 14;
const RECENT = 6;

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

function since(ts: number): string {
  const minutes = Math.floor((Date.now() - ts) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// A quiet card: a title, one line saying what the numbers mean, then the body.
function Card({
  title,
  hint,
  aside,
  children,
}: {
  title: string;
  hint?: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card p-5">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
        {aside}
      </div>
      {hint && (
        <p className="mt-1 text-[11.5px]" style={{ color: "var(--ink-3)" }}>
          {hint}
        </p>
      )}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="card p-4">
      <span className="chip">{label}</span>
      <div className="mt-2 num text-[24px] font-semibold leading-none tracking-[-0.02em]">{value}</div>
      <div className="mt-1.5 text-[11.5px]" style={{ color: "var(--ink-3)" }}>
        {hint}
      </div>
    </div>
  );
}

function ToolRow({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="chip">{label}</dt>
      <dd className="min-w-0 truncate text-right">
        <span className="mono" style={{ color: "var(--ink-2)" }}>
          {value || "not found"}
        </span>
        {note && (
          <span className="ml-1 text-[11px]" style={{ color: "var(--ink-3)" }}>
            {note}
          </span>
        )}
      </dd>
    </div>
  );
}

// The owner's overview: what is in the library, what happened lately, and the
// state of the machine it runs on. Every card explains itself, because this is
// the page someone opens weeks later and wonders what they are looking at.
// `stats` comes from App, which holds the live queue stream: the same tally the
// queue footer shows, so a reset or a finished guest stream lands here without
// a reload.
export function Dashboard({ stats: tally }: { stats: GuestTally }) {
  const [library, setLibrary] = useState<LibraryStats | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  const load = useCallback(() => {
    setBusy(true);
    setError(null);
    Promise.all([api.library(), api.history(), api.diagnostics(), api.jobs(), api.settings()])
      .then(([lib, hist, diag, queue, config]) => {
        setLibrary(lib);
        setHistory(hist.history);
        setDiagnostics(diag);
        setJobs(queue.jobs);
        setSettings(config);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Could not read the library.");
      })
      .finally(() => setBusy(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of history) {
      if (!entry.finishedAt) continue;
      const key = dayKey(new Date(entry.finishedAt));
      map.set(key, (map.get(key) ?? 0) + Math.max(0, entry.completed));
    }
    return map;
  }, [history]);

  const days = useMemo(
    () =>
      Array.from({ length: DAILY }, (_, index) => {
        const date = new Date();
        date.setHours(0, 0, 0, 0);
        date.setDate(date.getDate() - (DAILY - 1 - index));
        return date;
      }),
    [],
  );

  const busiest = Math.max(0, ...days.map((date) => counts.get(dayKey(date)) ?? 0));
  const peak = Math.max(1, busiest);
  const lastSeven = days
    .slice(-7)
    .reduce((sum, date) => sum + (counts.get(dayKey(date)) ?? 0), 0);
  const running = jobs.filter((job) => job.state === "running").length;
  const queued = jobs.filter((job) => job.state === "queued").length;
  const usedPct =
    library && library.totalBytes ? Math.min(100, (library.bytes / library.totalBytes) * 100) : null;

  const header = (
    <header
      className="sticky top-0 z-30"        style={{
          background: "color-mix(in srgb, var(--canvas) 58%, transparent)",
          backdropFilter: "blur(26px) saturate(160%)",
          WebkitBackdropFilter: "blur(26px) saturate(160%)",
          borderBottom: "1px solid var(--line)",
        }}
    >
      <div className="mx-auto flex h-14 max-w-[980px] items-center justify-between gap-3 px-5">
        <div className="flex min-w-0 items-center gap-2.5">
          <img
            src="/icon.svg"
            alt=""
            aria-hidden="true"
            width={22}
            height={22}
            className="h-[22px] w-[22px] shrink-0 rounded-[6px]"
          />
          <span className="truncate text-[14px] font-semibold tracking-[0.01em]">
            {settings?.siteName || "Crate"}
          </span>
          <span className="shrink-0 text-[12.5px]" style={{ color: "var(--ink-3)" }}>
            Overview
          </span>
        </div>
        <div className="flex items-center gap-2">
          <EffectsToggle />
          <a className="btn btn-ghost px-2 text-[12.5px]" href="/">
            Queue
          </a>
          <a className="btn btn-ghost px-2" href="/admin" aria-label="Settings" title="Settings">
            <GearIcon />
          </a>
        </div>
      </div>
    </header>
  );

  if (busy && !library) {
    return (
      <div className="min-h-dvh">
        {header}
        <p className="mx-auto max-w-[980px] px-5 py-10 text-[13px]" style={{ color: "var(--ink-3)" }}>
          Reading the library…
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-dvh">
        {header}
        <div className="mx-auto max-w-[980px] px-5 py-10">
          <div className="card p-5">
            <p className="flex items-center gap-2 text-[13px]" role="alert" style={{ color: "var(--danger)" }}>
              <AlertIcon size={13} /> {error}
            </p>
            <button className="btn mt-4" onClick={load}>
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh pb-16">
      {header}

      <main className="mx-auto max-w-[980px] space-y-5 px-5 py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[26px] font-semibold tracking-[-0.02em]">Overview</h1>
            <p className="mt-1 text-[13px]" style={{ color: "var(--ink-3)" }}>
              {running || queued
                ? `${running} downloading now, ${queued} waiting`
                : "The queue is idle"}
              {" · "}
              {history.length
                ? `last download ${since(history[0].finishedAt)}`
                : "nothing downloaded yet"}
            </p>
          </div>
          <a className="btn btn-primary" href="/">
            New download
            <ArrowIcon />
          </a>
        </div>

        {/* The same release hint the queue shows. This page is where an owner
            looks at the machine, so a new version belongs here too. */}
        <UpdateHint update={settings?.update} />

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat
            label="Tracks"
            value={(library?.tracks ?? 0).toLocaleString()}
            hint="audio files in the library"
          />
          <Stat
            label="Albums"
            value={(library?.albums ?? 0).toLocaleString()}
            hint="folders the files live in"
          />
          <Stat
            label="Artists"
            value={(library?.artists ?? 0).toLocaleString()}
            hint="top-level folders"
          />
          <Stat
            label="On disk"
            value={formatBytes(library?.bytes ?? 0)}
            hint="size of everything written"
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <Card
              title="Activity"
              hint={`Finished tracks per day, counted from your last ${history.length || "few"} downloads.`}
              aside={<span className="tag">{lastSeven} this week</span>}
            >
              <div
                className="flex h-[96px] items-end gap-1"
                role="img"
                aria-label={`Tracks downloaded per day over the last ${DAILY} days`}
              >
                {days.map((date, index) => {
                  const count = counts.get(dayKey(date)) ?? 0;
                  const height = count ? Math.max(3, (count / peak) * 100) : 2;
                  return (
                    <div
                      key={dayKey(date)}
                      className="group flex h-full flex-1 items-end"
                      title={`${date.toLocaleDateString(undefined, {
                        weekday: "short",
                        month: "short",
                        day: "numeric",
                      })} · ${count} ${count === 1 ? "track" : "tracks"}`}
                    >
                      <div
                        className="chart-bar w-full rounded-[3px]"
                        style={{
                          height: `${height}%`,
                          background: count ? "var(--accent-strong)" : "var(--line-strong)",
                          opacity: count ? 0.85 : 0.6,
                          animationDelay: `${index * 18}ms`,
                        }}
                      />
                    </div>
                  );
                })}
              </div>
              <div className="mt-2 flex justify-between text-[11px]" style={{ color: "var(--ink-3)" }}>
                <span>{days[0].toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                <span>
                  {busiest === 0
                    ? "no downloads in this window"
                    : busiest === 1
                      ? "one track a day at most"
                      : `busiest day: ${busiest} tracks`}
                </span>
                <span>today</span>
              </div>
            </Card>

            <Card
              title="Recent downloads"
              hint="Newest first. Failed and cancelled jobs stay here too, so a bad link is not invisible."
            >
              {history.length === 0 ? (
                <p className="text-[12.5px]" style={{ color: "var(--ink-3)" }}>
                  Nothing has finished yet. Paste a link on the queue page and it will show up here.
                </p>
              ) : (
                <ul>
                  {history.slice(0, RECENT).map((entry, index) => (
                    <li
                      key={`${entry.id}-${entry.finishedAt}`}
                      className="flex items-start justify-between gap-3 py-2.5"
                      style={{ borderTop: index === 0 ? "none" : "1px solid var(--line)" }}
                    >
                      <div className="min-w-0">
                        <div className="truncate text-[13px]">{entry.title}</div>
                        <div className="truncate text-[11.5px]" style={{ color: "var(--ink-3)" }}>
                          {[entry.artist, entry.album].filter(Boolean).join(" · ") || "no album"}
                          {" · "}
                          {entry.completed}/{entry.total} saved
                          {entry.failed ? ` · ${entry.failed} failed` : ""}
                          {" · "}
                          {entry.format.toUpperCase()}
                        </div>
                      </div>
                      <div className="shrink-0 text-right text-[11px]" style={{ color: "var(--ink-3)" }}>
                        <div style={{ color: entry.state === "failed" ? "var(--danger)" : "var(--ink-2)" }}>
                          {entry.state}
                        </div>
                        <div>{since(entry.finishedAt)}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <div className="space-y-4">
            <Card title="Storage" hint="How much room the library takes on the disk it lives on.">
              <div className="flex items-baseline justify-between gap-3">
                <span className="num text-[24px] font-semibold leading-none tracking-[-0.02em]">
                  {formatBytes(library?.bytes ?? 0)}
                </span>
                {usedPct !== null && (
                  <span className="text-[11.5px]" style={{ color: "var(--ink-3)" }}>
                    {usedPct.toFixed(usedPct < 10 ? 1 : 0)}% of the disk
                  </span>
                )}
              </div>
              <div
                className="mt-3 h-[6px] w-full overflow-hidden rounded-full"
                style={{ background: "var(--surface-3)" }}
                role="img"
                aria-label="Disk used by the library"
              >
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.max(1, Math.min(100, usedPct ?? 0))}%`,
                    background: "linear-gradient(90deg, color-mix(in srgb, var(--ink) 55%, transparent), var(--ink))",
                  }}
                />
              </div>
              <dl className="mt-4 space-y-2 text-[12px]">
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="chip">Free</dt>
                  <dd className="mono" style={{ color: "var(--ink-2)" }}>
                    {library?.freeBytes != null ? formatBytes(library.freeBytes) : "unknown"}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="chip">Folder</dt>
                  <dd className="mono min-w-0 truncate text-right" style={{ color: "var(--ink-2)" }} title={library?.path}>
                    {library?.path || "—"}
                  </dd>
                </div>
              </dl>
              {library && !library.writable && (
                <p className="mt-3 text-[11.5px]" style={{ color: "var(--danger)" }}>
                  The music folder is not writable, so downloads will fail until that is fixed.
                </p>
              )}
              {library?.truncated && (
                <p className="mt-2 text-[11px]" style={{ color: "var(--ink-3)" }}>
                  Counted the first 50,000 tracks only.
                </p>
              )}
            </Card>

            <Card
              title="Guests"
              hint="People who downloaded without the password. Counted when a stream finishes."
              aside={
                settings && !settings.guestEnabled ? (
                  <span
                    className="tag shrink-0"
                    style={{
                      color: "var(--danger)",
                      borderColor: "color-mix(in srgb, var(--danger) 45%, transparent)",
                    }}
                  >
                    Blocked
                  </span>
                ) : undefined
              }
            >
              <div className="flex gap-8">
                <div>
                  <div className="num text-[24px] font-semibold leading-none tracking-[-0.02em]">
                    {tally.guests}
                  </div>
                  <span className="chip mt-1.5">Guests</span>
                </div>
                <div>
                  <div className="num text-[24px] font-semibold leading-none tracking-[-0.02em]">
                    {tally.tracks}
                  </div>
                  <span className="chip mt-1.5">Songs</span>
                </div>
              </div>
              <p className="mt-4 text-[11.5px]" style={{ color: "var(--ink-3)" }}>
                {settings?.guestEnabled ? (
                  <>
                    {settings.guestQuota > 0
                      ? `Guest access is on, limited to ${settings.guestQuota} download${
                          settings.guestQuota === 1 ? "" : "s"
                        } per browser a day.`
                      : "Guest access is on, with no daily limit."}{" "}
                    Your own downloads never count here.
                  </>
                ) : (
                  <>
                    Guest access is off — everyone needs the password.{" "}
                    <a
                      className="underline underline-offset-2"
                      style={{ color: "var(--ink-2)" }}
                      href="/admin#guests"
                    >
                      Turn it back on
                    </a>
                    .
                  </>
                )}
              </p>
            </Card>

            <Card title="Tools" hint="The versions a download would use right now.">
              <dl className="space-y-2.5 text-[12.5px]">
                <ToolRow
                  label="yt-dlp"
                  value={diagnostics?.ytdlp.version ?? "—"}
                  note={diagnostics?.ytdlp.private ? "updated copy" : undefined}
                />
                <ToolRow label="ffmpeg" value={diagnostics?.ffmpeg.version ?? "—"} />
                <ToolRow label="script" value={diagnostics?.script.version ?? "—"} />
              </dl>
              <a className="btn mt-4 w-full text-[12.5px]" href="/admin">
                <GearIcon />
                Manage settings
              </a>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}
