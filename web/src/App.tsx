import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { Draft, GuestTally, Job, Preview, Role, Row, Settings, Theme } from "./types";
import { AdminPage } from "./components/AdminPage";
import { Dashboard } from "./components/Dashboard";
import { LibraryPage } from "./components/LibraryPage";
import { Composer } from "./components/Composer";
import { ContactPage } from "./components/ContactPage";
import { ConfirmOverwrite } from "./components/ConfirmOverwrite";
import { Login } from "./components/Login";
import { Setup } from "./components/Setup";
import { Queue } from "./components/Queue";
import { ReviewCard } from "./components/ReviewCard";
import { SettingsDialog } from "./components/SettingsDialog";
import { EffectsToggle } from "./components/EffectsToggle";
import { AppearanceDialog } from "./components/AppearanceDialog";
import { CookiesDialog } from "./components/CookiesDialog";
import { applyAppearance, readAppearance, saveAppearance, type Appearance } from "./lib/appearance";
import { applyTheme, readTheme, saveTheme } from "./lib/theme";
import {
  AlertIcon,
  BellIcon,
  CloseIcon,
  DiscIcon,
  GearIcon,
  GridIcon,
  KeyIcon,
  SignOutIcon,
  UsersIcon,
} from "./components/Icons";
import { UpdateHint } from "./components/UpdateHint";

const DRAFT_KEY = "audiodl-draft";
const NOTIFY_KEY = "audiodl-notify";

function draftFrom(preview: Preview): Draft {
  const d = preview.defaults;
  return {
    url: preview.url,
    kind: preview.kind,
    title:
      preview.kind === "playlist"
        ? preview.playlist.title || "Playlist"
        : preview.tracks[0]?.title || "Track",
    thumbnail: d.thumbnail,
    artist: d.artist,
    album: d.album,
    genre: d.genre,
    date: d.date,
    lufs: d.lufs,
    quality: d.quality,
    format: d.format,
    onePass: false,
    art: true,
    trackPrefix: d.trackPrefix,
    policy: "skip",
    rows: preview.tracks.map((t) => ({
      i: t.i,
      sourceTitle: t.title,
      title: t.title,
      track: t.track,
      date: d.date,
      art: "",
      duration: t.duration,
      selected: true,
    })),
  };
}

// One paste can carry a whole batch of links; keep their order and drop repeats.
function extractLinks(text: string): string[] {
  const found = String(text).match(/https?:\/\/[^\s<>"']+/g) ?? [];
  const seen = new Set<string>();
  const links: string[] = [];
  for (const raw of found) {
    const url = raw.replace(/[,;]+$/, "");
    if (!url || seen.has(url)) continue;
    seen.add(url);
    links.push(url);
  }
  return links;
}

// "1-3,7" selects exactly those tracks, mirroring the script's --tracks flag.
function rowsForRange(spec: string, rows: Row[]): Row[] {
  const wanted = new Set<number>();
  for (const part of spec.split(/[,\s]+/)) {
    if (!part) continue;
    const span = part.match(/^(\d+)\s*(?:-|–|\.\.)\s*(\d+)$/);
    if (span) {
      const from = Number(span[1]);
      const to = Number(span[2]);
      const low = Math.min(from, to);
      const high = Math.max(from, to);
      for (let n = low; n <= high && n - low <= 1000; n += 1) wanted.add(n);
    } else if (/^\d+$/.test(part)) {
      wanted.add(Number(part));
    }
  }
  return rows.filter((row) => wanted.has(row.track));
}

function mergeJob(list: Job[], job: Job): Job[] {
  const at = list.findIndex((item) => item.id === job.id);
  if (at < 0) return [job, ...list];
  const next = list.slice();
  next[at] = job;
  return next;
}

// One quiet line, the same for the owner and for guests: what the public side
// of this instance has pulled so far. Owner downloads are never counted.
function GuestTallyLine({ stats }: { stats: GuestTally }) {
  if (stats.tracks <= 0) return null;
  return (
    <div className="mb-1">
      <span className="num" style={{ color: "var(--ink-2)" }}>
        {stats.guests}
      </span>{" "}
      {stats.guests === 1 ? "guest has" : "guests have"} downloaded{" "}
      <span className="num" style={{ color: "var(--ink-2)" }}>
        {stats.tracks}
      </span>{" "}
      {stats.tracks === 1 ? "song" : "songs"}
    </div>
  );
}

export default function App() {
  // Owner settings are a page of their own; the gear in the header links to it.
  const path = window.location.pathname.replace(/\/+$/, "");
  const atAdmin = path === "/admin";
  const atDashboard = path === "/dashboard";
  const atContact = path === "/contact";
  const atLibrary = path === "/library";
  const [setup, setSetup] = useState<"checking" | "needed" | "done">("checking");
  const [role, setRole] = useState<Role | null>(null);
  // Two sources: /api/me answers before sign-in, Settings keeps it current.
  const [siteName, setSiteName] = useState("");
  // The release and its source, from /api/me: a quiet line in the footer.
  const [project, setProject] = useState<{ version: string; repo: string } | null>(null);
  const [contact, setContact] = useState("");
  const [guestEnabled, setGuestEnabled] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [artists, setArtists] = useState<string[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  // Aggregate guest activity, shown as one line under the queue.
  const [stats, setStats] = useState<GuestTally>({ guests: 0, tracks: 0 });
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [appearance, setAppearance] = useState<Appearance>(readAppearance);

  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, setPending] = useState<string[]>([]);
  const [plan, setPlan] = useState<Preview | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const [inspecting, setInspecting] = useState(false);
  const [queuing, setQueuing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The last failure was a source asking for a signed-in session: the fix is a
  // cookie jar, so the error line offers one instead of just the message.
  const [cookiesHint, setCookiesHint] = useState(false);
  const [cookiesOpen, setCookiesOpen] = useState(false);
  const authLink = useRef<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // A discarded draft is held for a few seconds so the click can be undone.
  const [undoable, setUndoable] = useState(false);

  const [notifyOn, setNotifyOn] = useState(
    () => localStorage.getItem(NOTIFY_KEY) === "1" && "Notification" in window && Notification.permission === "granted",
  );

  const planSeq = useRef(0);
  const inspectSeq = useRef(0);
  // What discard put aside, and the link it advanced to so undo can requeue it.
  const discarded = useRef<{
    draft: Draft;
    preview: Preview | null;
    url: string;
    next: string | null;
  } | null>(null);
  const undoTimer = useRef<number | null>(null);
  const lastIndex = useRef<number | null>(null);
  const hydrated = useRef(false);
  const composerInput = useRef<HTMLInputElement>(null);

  // Cmd/Ctrl+K (or "/" outside a field) puts the cursor in the link box.
  // The queue handles j/k and Enter itself.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const typing = Boolean(target?.closest("input, textarea, select, [contenteditable='true']"));
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && key === "k") {
        event.preventDefault();
        composerInput.current?.focus();
        composerInput.current?.select();
        return;
      }
      if (!event.metaKey && !event.ctrlKey && !typing && event.key === "/") {
        event.preventDefault();
        composerInput.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const activeJobs = jobs.some((j) => j.state === "running" || j.state === "queued" || j.state === "cancelling");
  const notificationsAvailable = "Notification" in window;

  // /admin is the server's page, and its look is the server's too: applying this
  // browser's stored choices here would undo what the server rendered and, worse,
  // save them over it. AdminPage holds that look in its own state instead.
  useEffect(() => {
    if (atAdmin) return;
    applyTheme(theme);
    saveTheme(theme);
  }, [theme, atAdmin]);

  useEffect(() => {
    if (atAdmin) return;
    applyAppearance(appearance);
    saveAppearance(appearance);
  }, [appearance, atAdmin]);

  // The instance name is the owner's, so the tab and any home-screen shortcut
  // follow it instead of the built-in default.
  useEffect(() => {
    if (!siteName) return;
    document.title = siteName;
    document
      .querySelector('meta[name="apple-mobile-web-app-title"]')
      ?.setAttribute("content", siteName);
  }, [siteName]);

  // First run: no password exists yet, so send the browser to /setup (a real
  // redirect, so the address bar shows it). Once a password is stored the app
  // loads normally and /setup sends itself back to the root.
  useEffect(() => {
    let alive = true;
    api
      .setup()
      .then(({ needed }) => {
        if (!alive) return;
        const atSetup = window.location.pathname.replace(/\/+$/, "") === "/setup";
        if (needed && !atSetup) {
          window.location.replace("/setup");
          return;
        }
        if (!needed && atSetup) {
          window.location.replace("/");
          return;
        }
        setSetup(needed ? "needed" : "done");
      })
      .catch(() => {
        if (alive) setSetup("done");
      });
    return () => {
      alive = false;
    };
  }, []);

  // Nobody is stopped at a gate: an unauthenticated visit quietly becomes a
  // guest session, and the password lives behind the "Log in" button.
  useEffect(() => {
    if (setup !== "done") return;
    let alive = true;
    api
      .me()
      .then(async (res) => {
        if (!alive) return;
        setGuestEnabled(res.guestEnabled);
        setSiteName(res.siteName);
        setProject({ version: res.version, repo: res.repo });
        setContact(res.contact);
        setStats(res.stats);
        if (res.authed && res.role) {
          setRole(res.role);
          return;
        }
        // /admin is the owner's page: a visitor without a session gets the
        // sign-in form, not a silent guest session and a bounce to the queue.
        if (atAdmin || atDashboard || atLibrary) {
          setShowLogin(true);
          return;
        }
        if (res.guestEnabled) {
          try {
            const guest = await api.guest();
            if (alive) setRole(guest.role);
            return;
          } catch {
            /* fall through to the login view */
          }
        }
        if (alive) setShowLogin(true);
      })
      .catch(() => {
        if (alive) setShowLogin(true);
      });
    return () => {
      alive = false;
    };
  }, [setup, atAdmin, atDashboard, atLibrary]);

  // /admin and /dashboard are the owner's pages; a guest who types one is sent
  // back to the queue.
  useEffect(() => {
    if (role && role !== "owner" && (atAdmin || atDashboard || atLibrary)) {
      window.location.replace("/");
    }
  }, [role, atAdmin, atDashboard, atLibrary]);

  // The guest tally only changes when a download settles, so that is the only
  // time worth asking for it again.
  const settledIds = jobs
    .filter((job) => job.state === "done")
    .map((job) => job.id)
    .join(",");
  useEffect(() => {
    if (!role || !settledIds) return;
    api
      .me()
      .then((res) => setStats(res.stats))
      .catch(() => {});
  }, [role, settledIds]);

  useEffect(() => {
    if (!role) return;
    api
      .settings()
      .then((fresh) => {
        setSettings(fresh);
        if (fresh.siteName) setSiteName(fresh.siteName);
        setContact(fresh.contact);
      })
      .catch(() => {});
    if (role !== "owner") return;
    api
      .artists()
      .then((res) => setArtists(res.artists))
      .catch(() => {});
  }, [role]);

  // A half-picked album survives a reload, a locked phone or a wrong tap.
  useEffect(() => {
    if (!role || hydrated.current) return;
    hydrated.current = true;
    const file = localStorage.getItem(DRAFT_KEY);
    if (!file) return;
    try {
      const saved = JSON.parse(file) as Draft;
      if (!saved?.url || !Array.isArray(saved.rows) || saved.rows.length === 0) return;
      setDraft(saved);
      setUrl(saved.url);
    } catch {
      localStorage.removeItem(DRAFT_KEY);
    }
  }, [role]);

  useEffect(() => {
    if (!hydrated.current) return;
    if (draft) localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    else localStorage.removeItem(DRAFT_KEY);
  }, [draft]);

  // The queue arrives over one stream; polling is only the fallback for a proxy
  // that buffers Server-Sent Events or a browser that closes the connection.
  useEffect(() => {
    if (!role) return;
    let alive = true;
    let poll: number | null = null;

    // Turning guest access off ends a guest's stream on the server, so the
    // events stop arriving. Rather than falling back to a poll that answers
    // 403, ask once whether the door is shut and put the sign-in form up: no
    // reload, no stale queue pretending a download is on its way.
    let checking = false;
    const leaveIfGuestsClosed = async () => {
      if (checking) return;
      checking = true;
      try {
        const res = await api.me();
        if (alive && role === "guest" && !res.guestEnabled) {
          setGuestEnabled(false);
          setRole(null);
          setShowLogin(true);
        }
      } catch {
        /* offline: the queue will keep its last snapshot */
      } finally {
        checking = false;
      }
    };

    const load = () =>
      api
        .jobs()
        .then((res) => {
          if (alive) setJobs(res.jobs);
        })
        .catch(() => {
          void leaveIfGuestsClosed();
        });
    const startPolling = () => {
      if (poll !== null || !alive) return;
      load();
      poll = window.setInterval(load, 1500);
    };
    const stopPolling = () => {
      if (poll === null) return;
      window.clearInterval(poll);
      poll = null;
    };

    // A browser without EventSource (or a proxy that never flushes) still works:
    // the same UI updates from the poll below.
    if (typeof EventSource === "undefined") {
      startPolling();
      return () => {
        alive = false;
        stopPolling();
      };
    }

    const source = new EventSource("/api/stream");
    let gotSnapshot = false;

    source.addEventListener("jobs", (event) => {
      gotSnapshot = true;
      stopPolling();
      if (!alive) return;
      try {
        setJobs((JSON.parse((event as MessageEvent).data) as { jobs: Job[] }).jobs);
      } catch {
        /* a torn frame is replaced by the next one */
      }
    });
    source.addEventListener("job", (event) => {
      stopPolling();
      if (!alive) return;
      try {
        const { job } = JSON.parse((event as MessageEvent).data) as { job: Job };
        setJobs((current) => mergeJob(current, job));
      } catch {
        /* ignore */
      }
    });
    // The public tally, pushed whenever a guest stream finishes or the owner
    // resets it, so the footer under the queue never lags behind.
    source.addEventListener("stats", (event) => {
      if (!alive) return;
      try {
        setStats(JSON.parse((event as MessageEvent).data) as GuestTally);
      } catch {
        /* ignore */
      }
    });
    source.addEventListener("remove", (event) => {
      if (!alive) return;
      try {
        const { id } = JSON.parse((event as MessageEvent).data) as { id: string };
        setJobs((current) => current.filter((job) => job.id !== id));
      } catch {
        /* ignore */
      }
    });
    source.onopen = () => stopPolling();
    source.onerror = () => {
      // Ask on the first error, not just when the browser gives up: the server
      // answers 403 as soon as guests are off, and the tab should not sit on a
      // frozen queue through a retry cycle.
      void leaveIfGuestsClosed();
      if (source.readyState === EventSource.CLOSED) startPolling();
    };

    // Nothing arrived: assume the stream is blocked and poll instead.
    const guard = window.setTimeout(() => {
      if (!gotSnapshot) startPolling();
    }, 2500);

    return () => {
      alive = false;
      stopPolling();
      window.clearTimeout(guard);
      source.close();
    };
  }, [role]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 7000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // Nothing else clears the undo window, so a page left open does not keep a
  // discarded draft in memory forever.
  useEffect(
    () => () => {
      if (undoTimer.current) window.clearTimeout(undoTimer.current);
    },
    [],
  );

  // A long download usually finishes while the tab is in the background.
  const lastStates = useRef(new Map<string, Job["state"]>());
  useEffect(() => {
    const seen = lastStates.current;
    for (const job of jobs) {
      const before = seen.get(job.id);
      const settled = job.state === "done" || job.state === "failed";
      if (notifyOn && settled && before && before !== job.state && document.hidden) {
        try {
          new Notification(job.state === "done" ? `${job.title} is ready` : `${job.title} failed`, {
            body:
              job.state === "done"
                ? `${job.completed} of ${job.total} saved${job.expiresAt ? " - save before it expires" : ""}`
                : job.error || "The download did not finish.",
            tag: job.id,
          });
        } catch {
          /* notification constructor blocked */
        }
      }
      seen.set(job.id, job.state);
    }
  }, [jobs, notifyOn]);

  // Resolve real targets through the script, so the preview can never disagree
  // with what a run would write.
  const planKey = draft
    ? JSON.stringify({
        url: draft.url,
        artist: draft.artist,
        album: draft.album,
        lufs: draft.lufs,
        prefix: draft.trackPrefix,
        rows: draft.rows.filter((r) => r.selected).map((r) => [r.i, r.title, r.track, r.date, r.art]),
      })
    : "";

  useEffect(() => {
    if (!draft) return;
    // Guests never see server paths or conflict policies: every guest job
    // writes into its own fresh staging folder and is handed to the browser.
    if (role !== "owner") {
      setPlan(null);
      setPlanBusy(false);
      setPlanError(null);
      return;
    }
    const selected = draft.rows.filter((r) => r.selected);
    if (selected.length === 0) {
      setPlan(null);
      setPlanBusy(false);
      return;
    }
    const seq = ++planSeq.current;
    setPlanBusy(true);
    const timer = window.setTimeout(() => {
      api
        .plan(draft)
        .then((result) => {
          if (planSeq.current !== seq) return;
          setPlan(result);
          setPlanError(null);
        })
        .catch((err: unknown) => {
          if (planSeq.current !== seq) return;
          setPlan(null);
          setPlanError(err instanceof Error ? err.message : "Could not resolve the target paths.");
        })
        .finally(() => {
          if (planSeq.current === seq) setPlanBusy(false);
        });
    }, 320);
    return () => window.clearTimeout(timer);
    // planKey is the stable digest of everything that changes a path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey, role]);

  const inspectOne = useCallback(async (value: string) => {
    // A late answer from a link that has since been taken back must not land
    // on the restored draft.
    const seq = ++inspectSeq.current;
    setInspecting(true);
    setError(null);
    setCookiesHint(false);
    authLink.current = null;
    setPlanError(null);
    try {
      const result = await api.inspect(value);
      if (inspectSeq.current !== seq) return;
      setPreview(result);
      setDraft(draftFrom(result));
      setPlan(null);
      setUrl(value);
    } catch (err) {
      if (inspectSeq.current !== seq) return;
      setPreview(null);
      setDraft(null);
      setError(err instanceof Error ? err.message : "Could not read that link.");
      const needs = err instanceof Error && Boolean((err as Error & { needsCookies?: boolean }).needsCookies);
      setCookiesHint(needs);
      authLink.current = needs ? value : null;
    } finally {
      if (inspectSeq.current === seq) setInspecting(false);
    }
  }, []);

  // Inspect the first link and hold the rest in line, so a pasted batch is
  // reviewed one album at a time instead of being silently dropped.
  const inspect = useCallback(
    (raw: string) => {
      const links = extractLinks(raw);
      if (links.length === 0) {
        setPreview(null);
        setDraft(null);
        setError("That does not look like a link - paste a track or playlist URL.");
        setCookiesHint(false);
        return;
      }
      setPending(links.slice(1));
      void inspectOne(links[0]);
    },
    [inspectOne],
  );

  // A shared shortcut (/https://… redirects to /?url=…) opens the review card
  // straight away; the query is dropped so a reload does not inspect again.
  const sharedLink = useRef<string | null>(new URLSearchParams(window.location.search).get("url"));
  useEffect(() => {
    if (!role || !sharedLink.current) return;
    const value = sharedLink.current;
    sharedLink.current = null;
    window.history.replaceState(null, "", window.location.pathname);
    inspect(value);
  }, [role, inspect]);

  // Mirrored in a ref so the next link can be started without touching state
  // from inside an updater (StrictMode runs those twice).
  const pendingRef = useRef<string[]>([]);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  const advancePending = useCallback(() => {
    const [next, ...rest] = pendingRef.current;
    if (!next) return;
    pendingRef.current = rest;
    setPending(rest);
    void inspectOne(next);
  }, [inspectOne]);

  const patchDraft = useCallback((patch: Partial<Draft>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }, []);

  const patchRow = useCallback((i: number, patch: Partial<Row>) => {
    setDraft((current) =>
      current
        ? { ...current, rows: current.rows.map((row) => (row.i === i ? { ...row, ...patch } : row)) }
        : current,
    );
  }, []);

  const toggleRow = useCallback((i: number, shiftKey: boolean) => {
    setDraft((current) => {
      if (!current) return current;
      const rows = current.rows.map((row) => ({ ...row }));
      const target = rows.findIndex((row) => row.i === i);
      if (target < 0) return current;
      const value = !rows[target].selected;
      if (shiftKey && lastIndex.current !== null) {
        const from = Math.min(lastIndex.current, target);
        const to = Math.max(lastIndex.current, target);
        for (let k = from; k <= to; k += 1) rows[k].selected = value;
      } else {
        rows[target].selected = value;
      }
      lastIndex.current = target;
      return { ...current, rows };
    });
  }, []);

  const toggleAll = useCallback((selected: boolean) => {
    setDraft((current) => (current ? { ...current, rows: current.rows.map((row) => ({ ...row, selected })) } : current));
  }, []);

  const selectRange = useCallback(
    (spec: string) => {
      if (!draft) return;
      const picked = rowsForRange(spec, draft.rows);
      if (picked.length === 0) {
        setNotice(`No track matches “${spec.trim()}”.`);
        return;
      }
      const ids = new Set(picked.map((row) => row.i));
      setDraft({ ...draft, rows: draft.rows.map((row) => ({ ...row, selected: ids.has(row.i) })) });
      setNotice(`${picked.length} ${picked.length === 1 ? "track" : "tracks"} selected.`);
    },
    [draft],
  );

  const clearDraft = useCallback(() => {
    setDraft(null);
    setPreview(null);
    setPlan(null);
    setUrl("");
    setError(null);
  }, []);

  const submitDraft = useCallback(
    async (conflicts: number) => {
      if (!draft) return;
      setQueuing(true);
      setError(null);
      try {
        await api.queue(draft, conflicts);
        setNotice(
          activeJobs
            ? "Added to the queue - it starts as soon as the current download finishes."
            : "Queued - the download starts now.",
        );
        setConfirmOpen(false);
        clearDraft();
        const fresh = await api.jobs();
        setJobs(fresh.jobs);
        advancePending();
      } catch (err) {
        setConfirmOpen(false);
        setError(err instanceof Error ? err.message : "Could not queue that download.");
        setCookiesHint(false);
      } finally {
        setQueuing(false);
      }
    },
    [draft, activeJobs, clearDraft, advancePending],
  );

  // Discard is the one destructive click in the review flow, so the draft is
  // kept for a moment and the notice offers to put it back.
  const discardDraft = useCallback(() => {
    if (!draft) return;
    discarded.current = { draft, preview, url, next: pendingRef.current[0] ?? null };
    setUndoable(true);
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => setUndoable(false), 10_000);
    clearDraft();
    advancePending();
  }, [draft, preview, url, clearDraft, advancePending]);

  const undoDiscard = useCallback(() => {
    const saved = discarded.current;
    if (!saved) return;
    discarded.current = null;
    setUndoable(false);
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
    // The link that followed was only inspected to fill the gap: drop that
    // answer and put it back in line for its own review.
    inspectSeq.current += 1;
    setInspecting(false);
    setPending((current) => {
      const seen = new Set(current);
      const restore: string[] = [];
      for (const link of [saved.next, draft?.url]) {
        if (link && !seen.has(link)) {
          seen.add(link);
          restore.push(link);
        }
      }
      return [...restore, ...current];
    });
    setDraft(saved.draft);
    setPreview(saved.preview);
    setUrl(saved.url);
    setError(null);
  }, [draft]);

  const queue = useCallback(() => {
    if (!draft) return;
    // Overwriting deletes library files, so it always asks first.
    if (role === "owner" && (plan?.conflicts ?? 0) > 0 && draft.policy === "overwrite") {
      setConfirmOpen(true);
      return;
    }
    void submitDraft(plan?.conflicts ?? 0);
  }, [draft, role, plan, submitDraft]);

  const cancelJob = useCallback(async (id: string) => {
    try {
      await api.cancel(id);
      const fresh = await api.jobs();
      setJobs(fresh.jobs);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not cancel.");
    }
  }, []);

  const retryJob = useCallback(async (id: string) => {
    try {
      await api.retry(id);
      const fresh = await api.jobs();
      setJobs(fresh.jobs);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not retry.");
    }
  }, []);

  const retagJob = useCallback(
    async (id: string, tags: { title?: string; artist: string; album: string; genre: string }) => {
      const res = await api.retag(id, tags);
      setJobs((current) => current.map((job) => (job.id === res.job.id ? res.job : job)));
      return { warning: res.warning };
    },
    [],
  );

  const removeJob = useCallback(async (id: string) => {
    try {
      await api.remove(id);
      setJobs((current) => current.filter((job) => job.id !== id));
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not remove that job.");
    }
  }, []);

  const clearFinished = useCallback(async () => {
    const finished = jobs.filter((j) => j.state === "done" || j.state === "failed" || j.state === "cancelled");
    await Promise.all(finished.map((job) => api.remove(job.id).catch(() => {})));
    setJobs((current) => current.filter((j) => !finished.some((f) => f.id === j.id)));
  }, [jobs]);

  const toggleNotify = useCallback(async () => {
    if (!notificationsAvailable) return;
    if (notifyOn) {
      setNotifyOn(false);
      localStorage.setItem(NOTIFY_KEY, "0");
      return;
    }
    let permission = Notification.permission;
    if (permission === "default") permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setNotice("This browser blocks notifications for the app - allow them in the site settings.");
      return;
    }
    setNotifyOn(true);
    localStorage.setItem(NOTIFY_KEY, "1");
  }, [notifyOn, notificationsAvailable]);

  if (setup === "checking") {
    return <div className="min-h-dvh" />;
  }

  if (setup === "needed") {
    return <Setup onDone={() => window.location.replace("/")} />;
  }

  // Public: no session required, not even a guest one.
  if (atContact) {
    return <ContactPage siteName={siteName} contact={contact} />;
  }

  if (showLogin) {
    return (
      <Login
        siteName={siteName}
        guestEnabled={!atAdmin && !atDashboard && !atLibrary && guestEnabled && role === null}
        onAuthed={(next) => {
          setRole(next);
          setShowLogin(false);
        }}
        onCancel={role ? () => setShowLogin(false) : undefined}
      />
    );
  }

  if (!role) {
    return <div className="min-h-dvh" />;
  }

  if (atAdmin) {
    return role === "owner" ? <AdminPage /> : <div className="min-h-dvh" />;
  }

  if (atDashboard) {
    return role === "owner" ? <Dashboard stats={stats} /> : <div className="min-h-dvh" />;
  }

  if (atLibrary) {
    return role === "owner" ? <LibraryPage /> : <div className="min-h-dvh" />;
  }

  const overwritePaths = (plan?.tracks ?? []).filter((t) => t.exists && t.path).map((t) => t.path);

  return (
    <div className="min-h-dvh pb-16">
      <header
        className="sticky top-0 z-30"
        style={{
          background: "color-mix(in srgb, var(--canvas) 58%, transparent)",
          backdropFilter: "blur(26px) saturate(160%)",
          WebkitBackdropFilter: "blur(26px) saturate(160%)",
          borderBottom: "1px solid var(--line)",
        }}
      >
        <div className="mx-auto flex h-14 max-w-[980px] items-center justify-between px-5">
          <div className="flex min-w-0 items-center gap-2.5">
            <img
              src="/icon.svg"
              alt=""
              aria-hidden="true"
              width={22}
              height={22}
              className="h-[22px] w-[22px] shrink-0 rounded-[6px]"
            />
            {/* Truncates rather than pushing the controls over the header: on a
                phone a long instance name has nowhere to go. */}
            <span className="truncate text-[14px] font-semibold tracking-[0.01em]">
              {siteName || "Crate"}
            </span>
            {settings && (
              <span className="mono hidden truncate sm:inline" style={{ color: "var(--ink-3)", fontSize: "11px" }}>
                {settings.musicDir}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {role === "guest" && <span className="tag">guest</span>}
            {notificationsAvailable && (
              // Below 640px the header is already down to icons; the finish
              // notification is the one control a phone can live without. The
              // wrapper hides it because `.btn` sets its own display and would
              // beat a bare `hidden` on the button.
              <span className="hidden sm:inline-flex">
                <button
                  className="btn btn-ghost px-2"
                  onClick={toggleNotify}
                  aria-pressed={notifyOn}
                  aria-label={notifyOn ? "Turn off finish notifications" : "Notify me when a download finishes"}
                  title={notifyOn ? "Notifications on" : "Notify me when a download finishes"}
                >
                  <BellIcon filled={notifyOn} />
                </button>
              </span>
            )}
            <AppearanceDialog
              theme={theme}
              onTheme={setTheme}
              appearance={appearance}
              onChange={setAppearance}
            />
            <EffectsToggle />
            {role === "owner" && (
              <a className="btn btn-ghost px-2" href="/library" aria-label="Library" title="Library">
                <DiscIcon />
              </a>
            )}
            {role === "owner" && (
              // Stays at every width: on a phone it is the only way through to
              // the overview page.
              <a className="btn btn-ghost px-2" href="/dashboard" aria-label="Overview" title="Overview">
                <GridIcon />
              </a>
            )}
            {role === "guest" ? (
              <SettingsDialog />
            ) : (
              <a
                className="btn btn-ghost relative px-2"
                href="/admin"
                aria-label={settings?.update?.available ? "Settings (update available)" : "Settings"}
                title={settings?.update?.available ? "Settings - a newer release is available" : "Settings"}
              >
                <GearIcon />
                {settings?.update?.available && (
                  <span
                    data-update-badge
                    aria-hidden="true"
                    className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full"
                    style={{ background: "var(--accent-strong)" }}
                  />
                )}
              </a>
            )}
            {role === "guest" ? (
              // Icon only on purpose: a visible "Log in" reads like the guest's
              // own account, and there is nothing for a guest to sign in to.
              <button
                className="btn btn-ghost px-2"
                onClick={() => setShowLogin(true)}
                aria-label="Owner sign in"
                title="Owner sign in"
              >
                <KeyIcon />
              </button>
            ) : (
              <button
                className="btn btn-ghost px-2 text-[12.5px]"
                title="Sign out"
                aria-label="Sign out"
                onClick={() => {
                  api.logout().then(async () => {
                    setRole(null);
                    setSettings(null);
                    if (guestEnabled) {
                      try {
                        const guest = await api.guest();
                        setRole(guest.role);
                        return;
                      } catch {
                        /* fall through to the login view */
                      }
                    }
                    setShowLogin(true);
                  });
                }}
              >
                {/* At phone width the header is a row of icons; the word only
                    fits from 640px up. */}
                <span className="hidden sm:inline">Sign out</span>
                <SignOutIcon className="sm:hidden" />
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[980px] px-5 py-8 space-y-8">
        <Composer
          value={url}
          onChange={setUrl}
          onSubmit={inspect}
          busy={inspecting}
          error={preview || draft ? null : error}
          inputRef={composerInput}
        />

        {pending.length > 0 && (
          <section className="card px-4 py-3" aria-label="Links waiting">
            <p className="text-[12px] mb-2" style={{ color: "var(--ink-3)" }}>
              {pending.length} more {pending.length === 1 ? "link" : "links"} waiting - each is inspected after the
              current one is queued or discarded.
            </p>
            <ul className="space-y-1">
              {pending.map((link, index) => (
                <li key={`${link}-${index}`} className="flex items-center gap-2">
                  <button
                    className="mono flex-1 min-w-0 truncate text-left text-[11.5px]"
                    style={{ color: "var(--ink-2)" }}
                    title={link}
                    onClick={() => {
                      setPending((current) => current.filter((_, k) => k !== index));
                      void inspectOne(link);
                    }}
                  >
                    {link}
                  </button>
                  <button
                    className="btn btn-ghost px-1.5 shrink-0"
                    aria-label={`Drop ${link}`}
                    onClick={() => setPending((current) => current.filter((_, k) => k !== index))}
                  >
                    <CloseIcon size={12} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {inspecting && <InspectingCard />}

        {draft && (
          <>
            <ReviewCard
              draft={draft}
              onChange={patchDraft}
              onRowChange={patchRow}
              onToggle={toggleRow}
              onToggleAll={toggleAll}
              onSelectRange={selectRange}
              plan={plan}
              planBusy={planBusy}
              planError={planError}
              showTargets={role === "owner"}
              allowOpus={role === "owner"}
              artists={artists}
              genres={preview?.genres ?? []}
              defaults={preview?.defaults ?? null}
              queuing={queuing}
              activeJobs={activeJobs}
              onQueue={queue}
              onDiscard={discardDraft}
              onReinspect={() => void inspectOne(draft.url)}
            />
            {error && (
              <p
                className="text-[13px] flex flex-wrap items-center gap-1.5"
                role="alert"
                style={{ color: "var(--danger)" }}
              >
                <AlertIcon size={13} /> {error}
                {cookiesHint && role === "owner" && (
                  <button
                    type="button"
                    className="btn btn-ghost px-2 text-[11.5px]"
                    onClick={() => setCookiesOpen(true)}
                  >
                    Paste cookies…
                  </button>
                )}
              </p>
            )}
          </>
        )}

        {undoable && (
          <div className="flex flex-wrap items-center gap-2 text-[13px]" role="status">
            <span style={{ color: "var(--ink-2)" }}>Draft discarded.</span>
            <button type="button" className="btn btn-ghost px-2 text-[12px]" onClick={undoDiscard}>
              Undo
            </button>
          </div>
        )}

        {notice && (
          <p className="text-[13px]" style={{ color: "var(--ink-2)" }}>
            {notice}
          </p>
        )}

        {/* The owner can leave the house locked by accident. It is not an
            error, so it stays a quiet note: who can get in, and the one link
            that changes it. */}
        {role === "owner" && !guestEnabled && (
          <section
            className="card flex items-start gap-3 px-4 py-3"
            role="status"
            aria-label="Guest access is off"
          >
            <span className="mt-0.5 shrink-0" style={{ color: "var(--ink-3)" }}>
              <UsersIcon size={16} />
            </span>
            <p className="min-w-0 text-[12.5px] leading-relaxed" style={{ color: "var(--ink-2)" }}>
              <span className="font-medium" style={{ color: "var(--ink)" }}>
                Guests are blocked.
              </span>{" "}
              Everyone who opens this address sees the sign-in form, so only you can download.{" "}
              <a className="underline underline-offset-2" href="/admin#guests">
                Turn guest access back on
              </a>{" "}
              in Settings.
            </p>
          </section>
        )}

        {/* The one piece of news the owner cannot get from the page itself: a
            newer release. Dismissal is remembered per browser and per release. */}
        {role === "owner" && <UpdateHint update={settings?.update} />}

        {role === "owner" && (
          <CookiesDialog
            open={cookiesOpen}
            onOpenChange={setCookiesOpen}
            onSaved={() => {
              const link = authLink.current;
              setCookiesOpen(false);
              setCookiesHint(false);
              if (link) void inspectOne(link);
            }}
          />
        )}

        <Queue
          jobs={jobs}
          role={role}
          onCancel={cancelJob}
          onRetry={retryJob}
          onRemove={removeJob}
          onRetag={retagJob}
          onClearFinished={clearFinished}
        />

        <footer className="pt-4 text-[11.5px] leading-relaxed" style={{ color: "var(--ink-3)" }}>
          <GuestTallyLine stats={stats} />
          {role === "guest" ? (
            <>
              {settings && settings.guestQuota > 0 && (
                <div className="mb-1">
                  {Math.max(0, settings.guestQuota - settings.guestQuotaUsed)} of {settings.guestQuota} guest
                  downloads left today.
                </div>
              )}
              Guest downloads are encoded on the server and streamed straight to the browser - one file, or one ZIP
              for an album - so they land in the browser's download folder. Nothing is written to the music library.{" "}
              <a className="underline" href="/contact">
                About &amp; contact
              </a>
            </>
          ) : (
            <>
              Files are written as <span className="mono">ARTIST/ALBUM/[NN - ]TITLE.{settings?.format ?? "m4a"}</span> and
              tagged with loudness normalisation, cover art and date - the same pipeline as the terminal script.
              Finished files can also be pulled through the browser with ↓.
            </>
          )}

          {/* Provenance rather than decoration: which release this page is,
              and the one link to its source. */}
          <div className="mt-2 flex flex-wrap items-center gap-x-2">
            <span className="mono">{project?.version ? `Crate v${project.version}` : "Crate"}</span>
            {project?.repo && (
              <>
                <span aria-hidden="true">·</span>
                <a
                  className="underline underline-offset-2"
                  href={project.repo}
                  target="_blank"
                  rel="noreferrer"
                >
                  {project.repo.replace(/^https?:\/\//, "")}
                </a>
              </>
            )}
          </div>
        </footer>
      </main>

      <ConfirmOverwrite
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        paths={overwritePaths}
        count={plan?.conflicts ?? overwritePaths.length}
        busy={queuing}
        onConfirm={() => void submitDraft(plan?.conflicts ?? 0)}
      />
    </div>
  );
}

function InspectingCard() {
  return (
    <div className="card p-5" aria-busy="true" aria-label="Reading link">
      <div className="flex gap-4">
        <div className="skeleton h-[72px] w-[72px] shrink-0" />
        <div className="flex-1 space-y-2 py-1">
          <div className="skeleton h-[14px] w-[46%]" />
          <div className="skeleton h-[11px] w-[30%]" />
          <div className="skeleton h-[11px] w-[64%]" />
        </div>
      </div>
      <p className="mt-4 text-[12.5px]" style={{ color: "var(--ink-3)" }}>
        Reading the link with yt-dlp…
      </p>
    </div>
  );
}
