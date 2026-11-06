import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { api } from "../api";
import { formatBytes } from "../lib/format";
import type {
  CookiesState,
  Diagnostics,
  DuplicateReport,
  GuestTally,
  HistoryEntry,
  LibraryHealth,
  LibraryStats,
  Settings,
} from "../types";
import { EffectsToggle } from "./EffectsToggle";
import { AppearanceDialog } from "./AppearanceDialog";
import { DEFAULT_ADMIN_LOOK, applyAdminLook, type AdminLook } from "../lib/appearance";
import {
  ArrowIcon,
  CloseIcon,
  DiscIcon,
  DownloadIcon,
  GearIcon,
  KeyIcon,
  PulseIcon,
  UsersIcon,
} from "./Icons";
import { UpdateHint } from "./UpdateHint";
import { CookiesDialog } from "./CookiesDialog";
import { PasswordMeter } from "./PasswordMeter";
import { QrCode } from "./QrCode";
import { ServerClock } from "./ServerClock";

const TABS = ["general", "guests", "downloads", "sources", "library", "system"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = {
  general: "General",
  guests: "Guests",
  downloads: "Downloads",
  sources: "Sources",
  library: "Library",
  system: "System",
};

// The rail's second line: what the tab actually holds, in the same plain
// language as the dashboard cards.
const TAB_HINT: Record<Tab, string> = {
  general: "Name, contact, account",
  guests: "Access, daily limit, tally",
  downloads: "Format, loudness, limits",
  sources: "Sign-in for private sites",
  library: "Folder, stats, history",
  system: "Diagnostics, alerts, backup",
};

const TAB_ICON: Record<Tab, (props: { size?: number; className?: string }) => ReactNode> = {
  general: GearIcon,
  guests: UsersIcon,
  downloads: DownloadIcon,
  sources: KeyIcon,
  library: DiscIcon,
  system: PulseIcon,
};

const TAB_STORE = "audiodl-settings-tab";

function tabFromHash(): Tab | null {
  const raw = window.location.hash.replace(/^#/, "");
  return TABS.includes(raw as Tab) ? (raw as Tab) : null;
}

function storedTab(): Tab | null {
  try {
    const raw = window.localStorage.getItem(TAB_STORE);
    return TABS.includes(raw as Tab) ? (raw as Tab) : null;
  } catch {
    return null;
  }
}

// A hash link wins (so /admin#system is shareable), then the last tab this
// browser used, then General for a first visit.
function initialTab(): Tab {
  return tabFromHash() ?? storedTab() ?? "general";
}

// Same card as the overview page: a 15px title, one line explaining the
// section, then the controls - so /admin and /dashboard read as one app. Every
// card carries its tab; the grid shows the active group and hides the rest.
function Section({
  title,
  hint,
  tab,
  className = "",
  children,
}: {
  title: string;
  hint?: string;
  tab: Tab;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section data-tab={tab} className={`card p-5 ${className}`}>
      <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
      {hint && (
        <p className="mt-1 text-[11.5px] leading-relaxed" style={{ color: "var(--ink-3)" }}>
          {hint}
        </p>
      )}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

// The saved values of every editable field, so a tab can say whether it has
// work in it. Webhook and password are "dirty" the moment they are non-empty:
// the stored URL never comes back, and a typed password always means a change.
type CleanValues = {
  siteName: string;
  contact: string;
  username: string;
  guestEnabled: boolean;
  guestQuota: string;
  musicDir: string;
  format: string;
  lufs: string;
  quality: string;
  maxJobs: string;
  perHost: string;
  webhookGuests: boolean;
};

function since(ms: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} d ago`;
}

// Owner-only page at /admin. Everything the server keeps in settings.json is
// edited here; guests get a small dialog instead, so this never renders for
// them (App sends a guest back to the queue).
export function AdminPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [siteName, setSiteName] = useState("");
  const [contact, setContact] = useState("");
  const [username, setUsername] = useState("");
  const [guestAccess, setGuestAccess] = useState(true);
  const [musicDir, setMusicDir] = useState("");
  const [format, setFormat] = useState("m4a");
  const [lufs, setLufs] = useState("-9");
  const [quality, setQuality] = useState("2");
  const [maxJobs, setMaxJobs] = useState("2");
  const [perHost, setPerHost] = useState("2");
  // The stored URL never reaches the browser, so the field only carries a
  // replacement and "Remove" clears the stored one on save.
  const [webhook, setWebhook] = useState("");
  const [webhookSet, setWebhookSet] = useState(false);
  const [webhookHost, setWebhookHost] = useState("");
  const [webhookGuests, setWebhookGuests] = useState(false);
  const [webhookRemove, setWebhookRemove] = useState(false);
  const [quota, setQuota] = useState("0");
  const [testing, setTesting] = useState(false);
  const [testOk, setTestOk] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [tally, setTally] = useState<GuestTally>({ guests: 0, tracks: 0 });
  const [resetAsk, setResetAsk] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetNote, setResetNote] = useState<string | null>(null);
  const [library, setLibrary] = useState<LibraryStats | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [health, setHealth] = useState<LibraryHealth | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [healthBusy, setHealthBusy] = useState(false);
  const [pruneAsk, setPruneAsk] = useState(false);
  const [healthNote, setHealthNote] = useState<string | null>(null);
  const [dupes, setDupes] = useState<DuplicateReport | null>(null);
  const [dupesError, setDupesError] = useState<string | null>(null);
  const [dupesBusy, setDupesBusy] = useState(false);
  const [dupeProgress, setDupeProgress] = useState<{ done: number; total: number } | null>(null);
  const [dupeNote, setDupeNote] = useState<string | null>(null);
  const [deleteAsk, setDeleteAsk] = useState<string | null>(null);
  const [cookies, setCookies] = useState<CookiesState | undefined>(undefined);
  const [cookiesOpen, setCookiesOpen] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [toolBusy, setToolBusy] = useState(false);
  const [toolMessage, setToolMessage] = useState<string | null>(null);
  const [toolError, setToolError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [twoFactor, setTwoFactor] = useState(false);
  const [twoFactorOpen, setTwoFactorOpen] = useState(false);
  const [twoFactorMode, setTwoFactorMode] = useState<"enable" | "disable">("enable");
  const [totpSecret, setTotpSecret] = useState("");
  const [totpUri, setTotpUri] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [tab, setTab] = useState<Tab>(initialTab);
  const [look, setLook] = useState<AdminLook>(DEFAULT_ADMIN_LOOK);
  const [clean, setClean] = useState<CleanValues | null>(null);
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});

  // The active tab lives in the URL hash, so a reload or a bookmark lands on
  // the same screen; replaceState keeps it out of the back-button history. The
  // last tab is also remembered per browser, so /admin alone resumes there.
  useEffect(() => {
    const onHash = () => {
      const next = tabFromHash();
      if (next) setTab(next);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const selectTab = (next: Tab) => {
    setTab(next);
    window.history.replaceState(null, "", `${window.location.pathname}#${next}`);
    try {
      window.localStorage.setItem(TAB_STORE, next);
    } catch {
      // Private mode: the hash still carries the choice for this visit.
    }
  };

  // Roving focus: arrows, Home and End move the selection and the focus
  // together, the way a vertical tablist is expected to behave.
  const moveTab = (step: number | "first" | "last") => {
    const next =
      step === "first"
        ? TABS[0]
        : step === "last"
          ? TABS[TABS.length - 1]
          : TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length];
    selectTab(next);
    tabRefs.current[next]?.focus();
  };
  const [totpBusy, setTotpBusy] = useState(false);
  const [totpError, setTotpError] = useState<string | null>(null);
  const [nudge, setNudge] = useState(false);
  // The Subsonic API's switch and credentials. Both credentials arrive as
  // plain strings because this page is the one place the owner can read them.
  const [subsonicOn, setSubsonicOn] = useState(true);
  const [subsonicKey, setSubsonicKey] = useState("");
  const [subsonicSecret, setSubsonicSecret] = useState("");
  const [subsonicKeyReset, setSubsonicKeyReset] = useState(false);
  const [subsonicSecretReset, setSubsonicSecretReset] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  // The stored URL is never sent back, so a blank input cannot mean "kept":
  // the saved state is shown as a line, and the input only appears on Replace.
  const [webhookEditing, setWebhookEditing] = useState(false);
  const [password, setPassword] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  function hydrate(fresh: Settings) {
    setSettings(fresh);
    // The look of this page is the server's, so it arrives with the settings
    // rather than from this browser's storage; applying it here also covers a
    // page the server did not build (the dev server).
    setLook(fresh.adminLook);
    applyAdminLook(fresh.adminLook);
    setSiteName(fresh.siteName);
    setContact(fresh.contact);
    setUsername(fresh.username);
    setGuestAccess(fresh.guestEnabled);
    setMusicDir(fresh.musicDir);
    setFormat(fresh.format);
    setLufs(String(fresh.lufs));
    setQuality(String(fresh.quality));
    setMaxJobs(String(fresh.maxJobs));
    setPerHost(String(fresh.perHost));
    setWebhookSet(fresh.webhookSet);
    setWebhookHost(fresh.webhookHost);
    setWebhookGuests(fresh.webhookGuests);
    setSubsonicOn(fresh.subsonic?.enabled ?? true);
    setSubsonicKey(fresh.subsonic?.key ?? "");
    setSubsonicSecret(fresh.subsonic?.secret ?? "");
    setSubsonicKeyReset(false);
    setSubsonicSecretReset(false);
    setQuota(String(fresh.guestQuota));
    setTwoFactor(fresh.twoFactor);
    setCookies(fresh.cookies);
    setWebhook("");
    setWebhookRemove(false);
    setWebhookEditing(false);
    setClean({
      siteName: fresh.siteName,
      contact: fresh.contact,
      username: fresh.username,
      guestEnabled: fresh.guestEnabled,
      guestQuota: String(fresh.guestQuota),
      musicDir: fresh.musicDir,
      format: fresh.format,
      lufs: String(fresh.lufs),
      quality: String(fresh.quality),
      maxJobs: String(fresh.maxJobs),
      perHost: String(fresh.perHost),
      webhookGuests: fresh.webhookGuests,
    });
  }

  // Which tabs hold an edit that has not been saved. Recomputed on every
  // keystroke, which is cheap next to the form itself. Lives below every
  // useState it reads, so the hook sees initialised values.
  const dirtyTabs = useMemo(() => {
    const dirty = new Set<Tab>();
    if (!clean) return dirty;
    if (
      siteName !== clean.siteName ||
      contact !== clean.contact ||
      username !== clean.username ||
      password !== ""
    ) {
      dirty.add("general");
    }
    if (guestAccess !== clean.guestEnabled || quota !== clean.guestQuota) dirty.add("guests");
    if (
      musicDir !== clean.musicDir ||
      format !== clean.format ||
      lufs !== clean.lufs ||
      quality !== clean.quality ||
      maxJobs !== clean.maxJobs ||
      perHost !== clean.perHost
    ) {
      dirty.add("downloads");
    }
    if (
      webhook.trim() !== "" ||
      webhookRemove ||
      webhookGuests !== clean.webhookGuests ||
      subsonicOn !== (settings?.subsonic?.enabled ?? true) ||
      subsonicKeyReset ||
      subsonicSecretReset
    ) {
      dirty.add("system");
    }
    return dirty;
  }, [
    clean,
    siteName,
    contact,
    username,
    password,
    guestAccess,
    quota,
    musicDir,
    format,
    lufs,
    quality,
    maxJobs,
    perHost,
    webhook,
    webhookRemove,
    webhookGuests,
    settings,
    subsonicOn,
    subsonicKeyReset,
    subsonicSecretReset,
  ]);
  const dirty = dirtyTabs.size > 0;

  async function copyText(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      window.setTimeout(() => setCopied((current) => (current === label ? null : current)), 1600);
    } catch {
      setError("Could not copy. Select the text instead.");
    }
  }

  async function resetTally() {
    setResetBusy(true);
    setResetNote(null);
    try {
      const result = await api.resetStats();
      setTally(result.stats);
      setResetAsk(false);
      setResetNote("Counter reset. The queue footer and the overview pick it up on their next load.");
    } catch (err) {
      setResetNote(err instanceof Error ? err.message : "Could not reset the counter.");
    } finally {
      setResetBusy(false);
    }
  }

  async function refreshLibrary() {
    try {
      setLibrary(await api.library());
      setLibraryError(null);
    } catch (err) {
      setLibraryError(err instanceof Error ? err.message : "Could not read the library.");
    }
  }

  async function refreshHealth() {
    setHealthBusy(true);
    setHealthError(null);
    setPruneAsk(false);
    try {
      setHealth(await api.libraryHealth());
    } catch (err) {
      setHealthError(err instanceof Error ? err.message : "Could not scan the library.");
    } finally {
      setHealthBusy(false);
    }
  }

  async function pruneEmpty() {
    if (!health) return;
    setHealthBusy(true);
    setHealthNote(null);
    try {
      const result = await api.pruneEmptyFolders(health.emptyDirs);
      setHealthNote(
        `${result.removed.length} empty ${result.removed.length === 1 ? "folder" : "folders"} removed` +
          (result.failed.length ? `, ${result.failed.length} left alone.` : "."),
      );
      setPruneAsk(false);
      setHealth(await api.libraryHealth());
    } catch (err) {
      setHealthNote(err instanceof Error ? err.message : "Could not remove the folders.");
    } finally {
      setHealthBusy(false);
    }
  }

  async function refreshDupes() {
    setDupesError(null);
    try {
      setDupes(await api.audioDuplicates());
    } catch (err) {
      setDupesError(err instanceof Error ? err.message : "Could not read the duplicate report.");
    }
  }

  // Measuring reads the audio itself, so the server does it in slices and the
  // page keeps asking until nothing is pending.
  async function scanDupes() {
    setDupesBusy(true);
    setDupesError(null);
    setDupeNote(null);
    setDupeProgress(null);
    try {
      for (let guard = 0; guard < 1000; guard += 1) {
        const step = await api.scanAudioDuplicates(12);
        setDupeProgress({ done: step.total - step.pending, total: step.total });
        if (step.scanned === 0 || step.pending === 0) break;
      }
      await refreshDupes();
    } catch (err) {
      setDupesError(err instanceof Error ? err.message : "The scan stopped.");
    } finally {
      setDupesBusy(false);
      setDupeProgress(null);
    }
  }

  async function removeDupe(file: string) {
    setDupesBusy(true);
    setDupeNote(null);
    try {
      const result = await api.removeAudioDuplicates([file]);
      setDeleteAsk(null);
      setDupeNote(
        result.removed.length
          ? `Deleted ${file.split("/").pop()}.`
          : `Could not delete it: ${result.failed[0]?.reason || "unknown error"}.`,
      );
      await refreshDupes();
      await refreshHealth();
    } catch (err) {
      setDupeNote(err instanceof Error ? err.message : "Could not delete that file.");
    } finally {
      setDupesBusy(false);
    }
  }

  async function refreshHistory() {
    try {
      setHistory((await api.history()).history);
    } catch {
      /* the section simply stays empty */
    }
  }

  async function refreshDiagnostics() {
    try {
      setDiagnostics(await api.diagnostics());
    } catch {
      /* the section simply stays empty */
    }
  }

  async function updateYtdlp() {
    setToolBusy(true);
    setToolError(null);
    setToolMessage(null);
    try {
      const result = await api.updateYtdlp();
      setToolMessage(`yt-dlp ${result.version} is installed - new downloads use it.`);
      await refreshDiagnostics();
    } catch (err) {
      setToolError(err instanceof Error ? err.message : "Could not update yt-dlp.");
    } finally {
      setToolBusy(false);
    }
  }

  useEffect(() => {
    let alive = true;
    api
      .settings()
      .then((fresh) => {
        if (!alive) return;
        hydrate(fresh);
        document.title = `${fresh.siteName} · Settings`;
        if (!fresh.twoFactor && localStorage.getItem("audiodl-2fa-nudge") !== "dismissed") {
          setNudge(true);
        }
        void refreshLibrary();
        void refreshHealth();
        void refreshDupes();
        void refreshHistory();
        void refreshDiagnostics();
        // The same counter the queue footer and the overview show: guests are
        // counted when a stream settles, so once on load is enough.
        api
          .me()
          .then((me) => {
            if (alive) setTally(me.stats);
          })
          .catch(() => {
            /* the tally simply stays at zero */
          });
      })
      .catch((err) => {
        if (alive) setLoadError(err instanceof Error ? err.message : "Could not load settings.");
      });
    return () => {
      alive = false;
    };
  }, []);

  // The look of this page is saved the moment it changes - there is no Save
  // button for it, and it belongs to the server, so the next device that opens
  // Settings sees it too. A failed save is undone here rather than left on the
  // page as a colour the server does not have.
  async function changeLook(patch: Partial<AdminLook>) {
    const before = look;
    const next = { ...look, ...patch };
    setLook(next);
    applyAdminLook(next);
    try {
      const result = await api.saveAdminLook(patch);
      setLook(result.adminLook);
      applyAdminLook(result.adminLook);
      setError(null);
    } catch (err) {
      setLook(before);
      applyAdminLook(before);
      setError(err instanceof Error ? err.message : "Could not save the look.");
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api.saveSettings({
        siteName: siteName.trim(),
        contact,
        username: username.trim(),
        guestEnabled: guestAccess,
        musicDir,
        format,
        lufs: Number(lufs),
        quality: Number(quality),
        maxJobs: Number(maxJobs),
        perHost: Number(perHost),
        guestQuota: Number(quota),
        webhookGuests,
        subsonicEnabled: subsonicOn,
        ...(subsonicKeyReset ? { subsonicKeyReset: true } : {}),
        ...(subsonicSecretReset ? { subsonicSecretReset: true } : {}),
        ...(webhookRemove || webhook.trim()
          ? { webhookUrl: webhookRemove ? null : webhook.trim() }
          : {}),
        ...(password ? { password } : {}),
      });
      const fresh = await api.settings();
      const changedPassword = Boolean(password);
      hydrate(fresh);
      setPassword("");
      document.title = `${fresh.siteName} · Settings`;
      if (changedPassword) {
        // Every session was invalidated, so this browser has to sign in again.
        setSigningOut(true);
        window.setTimeout(() => window.location.replace("/"), 1200);
        return;
      }
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await api.logout().catch(() => {});
    window.location.replace("/");
  }

  function dismissNudge() {
    localStorage.setItem("audiodl-2fa-nudge", "dismissed");
    setNudge(false);
  }

  async function openTwoFactor() {
    setTotpError(null);
    setTotpCode("");
    setTotpSecret("");
    setTotpUri("");
    setTwoFactorMode(twoFactor ? "disable" : "enable");
    setTwoFactorOpen(true);
    if (twoFactor) return;
    setTotpBusy(true);
    try {
      const res = await api.twoFactorSetup();
      setTotpSecret(res.secret);
      setTotpUri(res.otpauth);
    } catch (err) {
      setTotpError(err instanceof Error ? err.message : "Could not start the setup.");
    } finally {
      setTotpBusy(false);
    }
  }

  async function confirmTwoFactor() {
    if (totpCode.length !== 6) return;
    setTotpBusy(true);
    setTotpError(null);
    try {
      if (twoFactorMode === "enable") {
        await api.enableTwoFactor(totpCode);
        setTwoFactor(true);
        localStorage.setItem("audiodl-2fa-nudge", "dismissed");
        setNudge(false);
      } else {
        await api.disableTwoFactor(totpCode);
        setTwoFactor(false);
      }
      setTwoFactorOpen(false);
      setTotpCode("");
      setTotpSecret("");
      setTotpUri("");
      setNotice(
        twoFactorMode === "enable"
          ? "Two-factor is on. The next sign-in asks for a code."
          : "Two-factor is off.",
      );
    } catch (err) {
      setTotpError(err instanceof Error ? err.message : "Could not verify the code.");
      setTotpCode("");
    } finally {
      setTotpBusy(false);
    }
  }

  async function testWebhook() {
    setTesting(true);
    setTestOk(null);
    setTestError(null);
    try {
      const res = await api.testWebhook();
      setTestOk(`Test message sent to ${res.host}.`);
    } catch (err) {
      setTestError(err instanceof Error ? err.message : "Could not send the test message.");
    } finally {
      setTesting(false);
    }
  }

  async function importFile(file: File) {
    setImporting(true);
    setError(null);
    setNotice(null);
    try {
      const parsed = JSON.parse(await file.text());
      await api.importSettings(parsed);
      hydrate(await api.settings());
      await refreshLibrary();
      setNotice("Settings imported. The password and webhook were left untouched.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that file.");
    } finally {
      setImporting(false);
    }
  }

  if (loadError) {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center px-5 text-center">
        <p className="text-[13px]" role="alert" style={{ color: "var(--danger)" }}>
          {loadError}
        </p>
        <a className="btn mt-4" href="/">
          Back to the queue
        </a>
      </div>
    );
  }

  if (!settings) {
    return <div className="min-h-dvh" />;
  }

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
        <div className="mx-auto flex h-14 max-w-[1180px] items-center justify-between gap-3 px-5">
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
              {settings.siteName}
            </span>
            {/* The page title repeats it; on a phone the room is needed for the
                controls, which were overlapping this word. */}
            <span className="hidden shrink-0 text-[12.5px] sm:inline" style={{ color: "var(--ink-3)" }}>
              Settings
            </span>
          </div>
          <div className="flex items-center gap-2">
            {saved && (
              <span className="text-[12px]" style={{ color: "var(--ink-3)" }}>
                Saved
              </span>
            )}
            {/* Both write the server's look, not this browser's: a phone and a
                laptop showing Settings must not disagree. */}
            <AppearanceDialog
              theme={look.theme}
              onTheme={(theme) => void changeLook({ theme })}
              appearance={{ flavor: look.flavor, accent: look.accent }}
              onChange={(appearance) =>
                void changeLook({ flavor: appearance.flavor, accent: appearance.accent })
              }
              note="One setting for the server: every device showing Settings uses it. The queue still follows each browser."
            />
            <EffectsToggle scope="server" />
            <a className="btn btn-ghost px-2 text-[12.5px]" href="/dashboard">
              Overview
            </a>
            <a className="btn btn-ghost px-2 text-[12.5px]" href="/">
              Queue
            </a>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1180px] px-5 py-8">
        <div className="mb-6">
          <h1 className="text-[26px] font-semibold tracking-[-0.02em]">Settings</h1>
          <p className="mt-1 text-[13px]" style={{ color: "var(--ink-3)" }}>
            Applies to this server. Changes take effect for the next download, and the save button sits at the
            bottom of the page.
          </p>
        </div>

        {/* The owner's own page carries the same release hint as the queue, so
            an admin who lives on /admin still sees it. */}
        <UpdateHint update={settings.update} className="mb-6" />

        <div className="lg:grid lg:grid-cols-[224px_minmax(0,1fr)] lg:items-start lg:gap-6">
          {/* One group per screen: a rail on desktop (sticky, so switching never
              needs a scroll back up), a swipeable strip of the same tabs on a
              phone. */}
          <div className="lg:sticky lg:top-[72px]">
            <div
              role="tablist"
              aria-label="Settings sections"
              aria-orientation="vertical"
              className="flex gap-1 overflow-x-auto rounded-[14px] p-1 lg:flex-col lg:overflow-visible"
              style={{
                border: "1px solid var(--line)",
                background: "color-mix(in srgb, var(--surface) 52%, transparent)",
                backdropFilter: "blur(16px) saturate(150%)",
                WebkitBackdropFilter: "blur(16px) saturate(150%)",
                boxShadow: "0 1px 2px var(--shadow), inset 0 1px 0 var(--hairline)",
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowRight") {
                  event.preventDefault();
                  moveTab(1);
                } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
                  event.preventDefault();
                  moveTab(-1);
                } else if (event.key === "Home") {
                  event.preventDefault();
                  moveTab("first");
                } else if (event.key === "End") {
                  event.preventDefault();
                  moveTab("last");
                }
              }}
            >
              {TABS.map((name) => {
                const active = name === tab;
                const Icon = TAB_ICON[name];
                return (
                  <button
                    key={name}
                    ref={(node) => {
                      tabRefs.current[name] = node;
                    }}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    aria-controls="settings-panel"
                    aria-label={dirtyTabs.has(name) ? `${TAB_LABEL[name]}, unsaved changes` : undefined}
                    tabIndex={active ? 0 : -1}
                    onClick={() => selectTab(name)}
                    className="rail-tab relative flex shrink-0 items-center gap-2.5 rounded-[10px] px-3 py-2 text-left lg:w-full lg:items-start lg:gap-2.5 lg:px-3 lg:py-2.5"
                    style={
                      active
                        ? {
                            background: "var(--surface)",
                            color: "var(--ink)",
                            boxShadow: "0 1px 2px var(--shadow), inset 0 1px 0 var(--hairline)",
                          }
                        : { color: "var(--ink-2)" }
                    }
                  >
                    <span
                      aria-hidden="true"
                      className="absolute left-0 top-1/2 hidden h-5 w-[2px] -translate-y-1/2 rounded-full lg:block"
                      style={{ background: "var(--ink)", opacity: active ? 1 : 0 }}
                    />
                    <Icon size={16} className="rail-icon mt-0.5 shrink-0" />
                    <span className="flex min-w-0 flex-col">
                      <span className="flex items-center gap-1.5 text-[12.5px] font-medium leading-tight">
                        {TAB_LABEL[name]}
                        {dirtyTabs.has(name) && (
                          <span className="dot" style={{ background: "var(--ink)" }} aria-hidden="true" />
                        )}
                      </span>
                      <span
                        className="mt-0.5 hidden truncate text-[11px] leading-tight lg:block"
                        style={{ color: "var(--ink-3)" }}
                      >
                        {TAB_HINT[name]}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div
            role="tabpanel"
            id="settings-panel"
            aria-label={TAB_LABEL[tab]}
            data-tab={tab}
            className="settings-grid mt-4 grid items-start gap-4 lg:mt-0 lg:grid-cols-2"
          >
        <Section tab="general" title="This instance" hint="How the app introduces itself to everyone who opens it.">
          <label className="block">
            <span className="chip">Instance name</span>
            <input
              className="field mt-1.5"
              value={siteName}
              onChange={(e) => setSiteName(e.target.value)}
              placeholder="Crate"
              maxLength={40}
              spellCheck={false}
            />
            <span className="block mt-1 text-[11.5px]" style={{ color: "var(--ink-3)" }}>
              Shown in the header, the browser tab and a home-screen shortcut.
            </span>
          </label>

          <label className="block">
            <span className="chip">Contact (public)</span>
            <input
              className="field mt-1.5"
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              placeholder="you@example.com or a link"
              maxLength={200}
              autoComplete="off"
              spellCheck={false}
            />
            <span className="block mt-1 text-[11.5px]" style={{ color: "var(--ink-3)" }}>
              Shown on the public <span className="mono">/contact</span> page. Leave it empty to
              show no address there.
            </span>
          </label>

          <label className="block">
            <span className="chip">Owner username</span>
            <input
              className="field mt-1.5"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin"
              maxLength={32}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
            />
            <span className="block mt-1 text-[11.5px]" style={{ color: "var(--ink-3)" }}>
              Signing in takes this name and the password, which is changed further down.
            </span>
          </label>

        </Section>

        <Section tab="guests" title="Guest access" hint="What someone can do without the password.">
          <label className="flex items-start gap-2 text-[12.5px]">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={guestAccess}
              onChange={(e) => setGuestAccess(e.target.checked)}
            />
            <span>
              Allow guests to download without signing in
              <span className="block text-[11.5px]" style={{ color: "var(--ink-3)" }}>
                Their files stream to the browser and never reach the library. The sign-in screen
                {guestAccess ? " keeps its Continue as guest button." : " asks for the password only."}
              </span>
            </span>
          </label>

          <label className="block">
            <span className="chip">Downloads per day, per browser</span>
            <input
              className="field num mt-1.5 max-w-[110px]"
              value={quota}
              onChange={(e) => setQuota(e.target.value)}
              inputMode="numeric"
              disabled={!guestAccess}
              aria-describedby={undefined}
            />
            <span className="block mt-1 text-[11.5px]" style={{ color: "var(--ink-3)" }}>
              0 means no limit. Counts queued jobs and resets at midnight UTC. Your own downloads
              are never limited by it.
            </span>
          </label>
        </Section>

        <Section
          tab="guests"
          title="Guest activity"
          hint="The same tally the queue footer shows. Your own downloads never count here."
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
          <p className="mt-4 text-[11.5px] leading-relaxed" style={{ color: "var(--ink-3)" }}>
            {tally.tracks === 0
              ? "Nothing has streamed through the guest side yet. A track is counted when its download finishes, not when it is queued."
              : `Counted when a stream finishes. One guest is one browser, so the same person on two devices counts twice.`}
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {resetAsk ? (
              <>
                <span className="text-[11.5px]" style={{ color: "var(--ink-2)" }}>
                  Zero both numbers? Counting starts over for everyone. Daily guest limits are not touched.
                </span>
                <button type="button" className="btn" onClick={() => setResetAsk(false)} disabled={resetBusy}>
                  Keep
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={resetTally}
                  disabled={resetBusy}
                  style={{ color: "var(--danger)" }}
                >
                  {resetBusy ? "Resetting…" : "Reset"}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setResetNote(null);
                  setResetAsk(true);
                }}
                disabled={tally.guests === 0 && tally.tracks === 0}
              >
                Reset counter
              </button>
            )}
          </div>
          {resetNote && (
            <p className="mt-2 text-[11.5px]" role="status" style={{ color: "var(--ink-2)" }}>
              {resetNote}
            </p>
          )}
        </Section>

        <Section tab="downloads" title="Downloads" hint="Defaults for every new job.">
          <label className="block">
            <span className="chip">Output format</span>
            <select className="field mt-1.5" value={format} onChange={(e) => setFormat(e.target.value)}>
              <option value="m4a">M4A (AAC)</option>
              <option value="mp3">MP3</option>
              <option value="opus">Opus</option>
              <option value="flac">FLAC (lossless)</option>
              <option value="wav">WAV (uncompressed)</option>
            </select>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="chip">Target LUFS</span>
              <input
                className="field num mt-1.5"
                value={lufs}
                onChange={(e) => setLufs(e.target.value)}
                inputMode="numeric"
              />
            </label>
            <label className="block">
              <span className="chip">Quality</span>
              <select className="field mt-1.5" value={quality} onChange={(e) => setQuality(e.target.value)}>
                <option value="1">High (q1)</option>
                <option value="2">Balanced (q2)</option>
                <option value="3">Small (q3)</option>
                <option value="4">Smaller (q4)</option>
                <option value="5">Smallest (q5)</option>
              </select>
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="chip">Downloads at once</span>
              <select
                className="field mt-1.5"
                value={maxJobs}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  setMaxJobs(e.target.value);
                  if (Number(perHost) > next) setPerHost(e.target.value);
                }}
              >
                {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="chip">Per source host</span>
              <select className="field mt-1.5" value={perHost} onChange={(e) => setPerHost(e.target.value)}>
                {Array.from({ length: Number(maxJobs) || 1 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <span className="block text-[11.5px]" style={{ color: "var(--ink-3)" }}>
            Jobs start immediately up to the first number; the second keeps one playlist from opening
            every connection to one site. Applies to the next job queued.
          </span>
        </Section>

        <Section tab="downloads" className="lg:order-first" title="Library" hint="Where finished files are written.">
          <label className="block">
            <span className="chip">Library root</span>
            <input
              className="field mono mt-1.5"
              value={musicDir}
              onChange={(e) => setMusicDir(e.target.value)}
              placeholder="/media/music"
              spellCheck={false}
            />
            <span className="block mt-1 text-[11.5px]" style={{ color: "var(--ink-3)" }}>
              Tracks land in <span className="mono">ARTIST/ALBUM/</span> below this folder.
            </span>
          </label>
        </Section>

        <Section
          tab="sources"
          title="Source sign-in"
          hint="A cookie jar for sites that only hand a track to a signed-in session."
        >
          <p className="text-[12px] leading-relaxed" style={{ color: "var(--ink-2)" }}>
            Some sources answer a download with “Sign in to confirm you're not a bot”, or keep a
            track behind an account. Paste a <span className="mono">cookies.txt</span> exported from
            your browser and your own downloads use it. Guests never do - it is your account, not
            the instance's.
          </p>
          <div
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg px-3 py-2.5"
            style={{ background: "var(--surface-3)", border: "1px solid var(--line-strong)" }}
          >
            <span className="min-w-0 text-[12px] leading-relaxed" style={{ color: "var(--ink-2)" }}>
              {cookies?.set
                ? `A jar for ${cookies.domains} site${cookies.domains === 1 ? "" : "s"} · updated ${since(cookies.updatedAt)}`
                : "No cookies stored. Downloads sign in anonymously."}
            </span>
            <button
              type="button"
              className="btn shrink-0 px-3 text-[12.5px]"
              onClick={() => setCookiesOpen(true)}
            >
              {cookies?.set ? "Replace…" : "Paste cookies…"}
            </button>
          </div>
          <CookiesDialog
            open={cookiesOpen}
            onOpenChange={setCookiesOpen}
            current={cookies}
            onSaved={setCookies}
          />
        </Section>

        <Section tab="library" className="lg:col-span-2" title="Library overview" hint="Counted from the folder when this page loads, not cached.">
          {libraryError ? (
            <p className="text-[12.5px]" role="alert" style={{ color: "var(--danger)" }}>
              {libraryError}
            </p>
          ) : !library ? (
            <p className="text-[12.5px]" style={{ color: "var(--ink-3)" }}>
              Counting…
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
                {[
                  { label: "Artists", value: library.artists.toLocaleString() },
                  { label: "Albums", value: library.albums.toLocaleString() },
                  { label: "Tracks", value: library.tracks.toLocaleString() },
                  { label: "Audio size", value: formatBytes(library.bytes) },
                ].map((stat) => (
                  <div key={stat.label}>
                    <span className="chip">{stat.label}</span>
                    <div className="mt-1.5 num text-[22px] font-semibold leading-none tracking-[-0.02em]">
                      {stat.value}
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px]" style={{ color: "var(--ink-3)" }}>
                <span className="mono break-all">{library.path}</span>
                <span>
                  {library.freeBytes === null ? "free space unknown" : `${formatBytes(library.freeBytes)} free`}
                </span>
                <span style={{ color: library.writable ? "var(--ink-3)" : "var(--danger)" }}>
                  {library.writable ? "writable" : "not writable"}
                </span>
                {library.lastJob && (
                  <span>
                    last job: {library.lastJob.title} ({library.lastJob.state}, {since(library.lastJob.finishedAt)})
                  </span>
                )}
                {library.truncated && <span>count stopped at 100,000 files</span>}
              </div>
              <button type="button" className="btn" onClick={() => void refreshLibrary()}>
                Recount
              </button>
            </>
          )}
        </Section>

        <Section
          tab="library"
          className="lg:col-span-2"
          title="Library health"
          hint="Structural problems in the folder, found by walking it without reading a single tag."
        >
          {healthError ? (
            <p role="alert" className="text-[12.5px]" style={{ color: "var(--danger)" }}>
              {healthError}
            </p>
          ) : !health ? (
            <p className="text-[12.5px]" style={{ color: "var(--ink-3)" }}>
              Scanning…
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
                {[
                  { label: "Empty folders", value: health.emptyDirsTotal },
                  { label: "Misplaced files", value: health.looseTotal },
                  { label: "Nested folders", value: health.nestedTotal },
                  { label: "Half-numbered", value: health.mixedTotal },
                ].map((stat) => (
                  <div key={stat.label}>
                    <span className="chip">{stat.label}</span>
                    <div className="mt-1.5 num text-[22px] font-semibold leading-none tracking-[-0.02em]">
                      {stat.value.toLocaleString()}
                    </div>
                  </div>
                ))}
              </div>

              {health.orphansTotal > 0 && (
                <div className="text-[12.5px]">
                  <span className="chip">
                    {health.orphansTotal} finished {health.orphansTotal === 1 ? "file is" : "files are"} gone
                  </span>
                  <ul className="mono mt-1 space-y-0.5 break-all text-[11.5px]" style={{ color: "var(--ink-2)" }}>
                    {health.orphans.slice(0, 3).map((entry) => (
                      <li key={entry.path}>{entry.path}</li>
                    ))}
                  </ul>
                  {health.orphansTotal > 3 && (
                    <span className="text-[11.5px]" style={{ color: "var(--ink-3)" }}>
                      and {health.orphansTotal - 3} more
                    </span>
                  )}
                </div>
              )}

              {health.emptyDirsTotal > 0 && (
                <div className="text-[12.5px]">
                  <span className="chip">Empty folders</span>
                  <ul className="mono mt-1 space-y-0.5 break-all text-[11.5px]" style={{ color: "var(--ink-2)" }}>
                    {health.emptyDirs.slice(0, 3).map((dir) => (
                      <li key={dir}>{dir}</li>
                    ))}
                  </ul>
                  {health.emptyDirsTotal > 3 && (
                    <span className="text-[11.5px]" style={{ color: "var(--ink-3)" }}>
                      and {health.emptyDirsTotal - 3} more
                    </span>
                  )}
                </div>
              )}

              {health.looseTotal > 0 && (
                <div className="text-[12.5px]">
                  <span className="chip">Files outside ARTIST/ALBUM</span>
                  <ul className="mono mt-1 space-y-0.5 break-all text-[11.5px]" style={{ color: "var(--ink-2)" }}>
                    {health.loose.slice(0, 3).map((file) => (
                      <li key={file}>{file}</li>
                    ))}
                  </ul>
                </div>
              )}

              {health.nestedTotal > 0 && (
                <div className="text-[12.5px]">
                  <span className="chip">Folders below an album</span>
                  <ul className="mono mt-1 space-y-0.5 break-all text-[11.5px]" style={{ color: "var(--ink-2)" }}>
                    {health.nested.slice(0, 3).map((dir) => (
                      <li key={dir}>{dir}</li>
                    ))}
                  </ul>
                </div>
              )}

              {health.mixedTotal > 0 && (
                <div className="text-[12.5px]">
                  <span className="chip">Half-numbered albums</span>
                  <ul className="mt-1 space-y-0.5 text-[11.5px]" style={{ color: "var(--ink-2)" }}>
                    {health.mixed.slice(0, 3).map((album) => (
                      <li key={album.dir} className="truncate" title={album.files.join(", ")}>
                        {album.dir.split("/").slice(-2).join(" / ")}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="btn"
                  onClick={() => void refreshHealth()}
                  disabled={healthBusy}
                >
                  {healthBusy ? "Scanning…" : "Scan again"}
                </button>
                {health.emptyDirsTotal > 0 &&
                  (pruneAsk ? (
                    <>
                      <button
                        type="button"
                        className="btn"
                        style={{ background: "var(--danger)", borderColor: "var(--danger)", color: "#fff" }}
                        disabled={healthBusy}
                        onClick={() => void pruneEmpty()}
                      >
                        Remove {health.emptyDirsTotal} empty{" "}
                        {health.emptyDirsTotal === 1 ? "folder" : "folders"}
                      </button>
                      <button type="button" className="btn btn-ghost" onClick={() => setPruneAsk(false)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button type="button" className="btn" onClick={() => setPruneAsk(true)}>
                      Clean up…
                    </button>
                  ))}
              </div>
              {healthNote && (
                <p className="text-[12px]" style={{ color: "var(--ink-2)" }}>
                  {healthNote}
                </p>
              )}
              {health.emptyDirsTotal === 0 &&
                health.looseTotal === 0 &&
                health.nestedTotal === 0 &&
                health.mixedTotal === 0 &&
                health.orphansTotal === 0 && (
                  <p className="text-[12.5px]" style={{ color: "var(--ink-3)" }}>
                    Nothing to fix.
                  </p>
                )}
            </>
          )}
        </Section>

        <Section
          tab="library"
          className="lg:col-span-2"
          title="Same audio twice"
          hint="Files whose fingerprints match: one recording under another name, bitrate or tag. Owner only - guests may download whatever they like."
        >
          {dupesError ? (
            <p role="alert" className="text-[12.5px]" style={{ color: "var(--danger)" }}>
              {dupesError}
            </p>
          ) : !dupes ? (
            <p className="text-[12.5px]" style={{ color: "var(--ink-3)" }}>
              Reading…
            </p>
          ) : !dupes.fpcalc ? (
            <p className="text-[12.5px]" style={{ color: "var(--ink-3)" }}>
              fpcalc (chromaprint) is not part of this image, so audio cannot be compared. Rebuild the
              container to add it.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className="btn" onClick={() => void scanDupes()} disabled={dupesBusy}>
                  {dupesBusy
                    ? dupeProgress
                      ? `Measuring ${dupeProgress.done} of ${dupeProgress.total}…`
                      : "Measuring…"
                    : dupes.measured
                      ? "Scan again"
                      : "Scan the library"}
                </button>
                <span className="text-[11.5px]" style={{ color: "var(--ink-3)" }}>
                  {dupes.measured.toLocaleString()} measured · {dupes.groups.length}{" "}
                  {dupes.groups.length === 1 ? "group" : "groups"}
                </span>
              </div>

              {dupes.groups.length === 0 ? (
                <p className="text-[12.5px]" style={{ color: "var(--ink-3)" }}>
                  {dupes.measured
                    ? "No two files are the same recording."
                    : "Nothing measured yet - a scan reads every file once and remembers the result."}
                </p>
              ) : (
                <ul className="space-y-3">
                  {dupes.groups.slice(0, 40).map((group) => (
                    <li key={group.files[0].path} className="inset p-3">
                      <ul className="space-y-1.5">
                        {group.files.map((file, index) => (
                          <li key={file.path} className="flex items-center gap-2 text-[12.5px]">
                            <span className="min-w-0 flex-1">
                              <span className="block truncate" title={file.path}>
                                {file.name}
                              </span>
                              <span className="block text-[11px]" style={{ color: "var(--ink-3)" }}>
                                {file.format.toUpperCase()} · {formatBytes(file.bytes)}
                                {index === 0 ? " · largest copy" : ""}
                              </span>
                            </span>
                            {deleteAsk === file.path ? (
                              <>
                                <button
                                  type="button"
                                  className="btn px-2 text-[11.5px]"
                                  style={{
                                    background: "var(--danger)",
                                    borderColor: "var(--danger)",
                                    color: "#fff",
                                  }}
                                  disabled={dupesBusy}
                                  onClick={() => void removeDupe(file.path)}
                                >
                                  Really delete
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-ghost px-2 text-[11.5px]"
                                  onClick={() => setDeleteAsk(null)}
                                >
                                  Cancel
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                className="btn btn-ghost px-2 text-[11.5px]"
                                onClick={() => setDeleteAsk(file.path)}
                              >
                                Delete
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}

              {dupeNote && (
                <p className="text-[12px]" style={{ color: "var(--ink-2)" }}>
                  {dupeNote}
                </p>
              )}
            </>
          )}
        </Section>

        <Section
          tab="system"
          title="Diagnostics"
          hint="The tools a download actually runs, as this server sees them."
        >
          <div className="grid grid-cols-[6.5rem_1fr] items-baseline gap-x-3 gap-y-1.5 text-[12.5px]">
            <span style={{ color: "var(--ink-3)" }}>yt-dlp</span>
            <span className="mono break-all">
              {diagnostics ? diagnostics.ytdlp.version || "not found" : "checking…"}
              {diagnostics?.ytdlp.path && (
                <span style={{ color: "var(--ink-3)" }}> · {diagnostics.ytdlp.path}</span>
              )}
              {diagnostics?.ytdlp.updatedAt ? (
                <span style={{ color: "var(--ink-3)" }}>
                  {" "}
                  · updated {since(diagnostics.ytdlp.updatedAt)}
                </span>
              ) : null}
            </span>
            <span style={{ color: "var(--ink-3)" }}>ffmpeg</span>
            <span className="mono break-all">
              {diagnostics ? diagnostics.ffmpeg.version || "not found" : "checking…"}
            </span>
            <span style={{ color: "var(--ink-3)" }}>script</span>
            <span className="mono break-all">
              {diagnostics ? diagnostics.script.version || "-" : "checking…"}
            </span>
            <span style={{ color: "var(--ink-3)" }}>server</span>
            <span className="mono break-all">
              {diagnostics
                ? `node ${diagnostics.system.node} · ${diagnostics.system.platform}`
                : "checking…"}
            </span>
            <span style={{ color: "var(--ink-3)" }}>release</span>
            <span className="mono break-all">
              {settings.update?.current ?? "unknown"}
              {settings.update?.latest ? ` · latest ${settings.update.latest}` : " · no release found"}
            </span>
            <span style={{ color: "var(--ink-3)" }}>checked</span>
            <span>
              {settings.update?.checkedAt
                ? `release check ${since(settings.update.checkedAt)}`
                : "not checked yet"}
            </span>
            <span style={{ color: "var(--ink-3)" }}>disk</span>
            <span>
              {diagnostics?.disk
                ? `${formatBytes(diagnostics.disk.freeBytes)} free of ${formatBytes(diagnostics.disk.totalBytes)}`
                : "-"}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn"
              onClick={() => void updateYtdlp()}
              disabled={toolBusy || Boolean(diagnostics?.ytdlp.updating)}
            >
              {toolBusy || diagnostics?.ytdlp.updating ? "Updating…" : "Update yt-dlp"}
            </button>
            <span className="text-[11.5px]" style={{ color: "var(--ink-3)" }}>
              Fetches the current release into the data folder; the rest of the image is left alone.
            </span>
          </div>
          {toolMessage && (
            <p className="text-[12px]" role="status" style={{ color: "var(--ink-2)" }}>
              {toolMessage}
            </p>
          )}
          {toolError && (
            <p className="text-[12px]" role="alert" style={{ color: "var(--danger)" }}>
              {toolError}
            </p>
          )}
        </Section>

        <Section
          tab="system"
          title="Subsonic API"
          hint="A read-only server for music players - Symfonium, DSub, Feishin and their kin."
        >
          <label className="flex items-start gap-2 text-[12.5px]">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={subsonicOn}
              onChange={(e) => setSubsonicOn(e.target.checked)}
            />
            <span>
              Let players read and stream the library
              <span className="block text-[11.5px]" style={{ color: "var(--ink-3)" }}>
                Read-only: no tag writes, stars or playlists. Guests cannot use it, and switching it
                off closes the endpoint for every client at once.
              </span>
            </span>
          </label>

          <div>
            <span className="chip">Server</span>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <code className="mono break-all text-[12px]">{`${window.location.origin}/rest`}</code>
              <button
                type="button"
                className="btn shrink-0"
                onClick={() => copyText("server", `${window.location.origin}/rest`)}
              >
                {copied === "server" ? "Copied" : "Copy"}
              </button>
            </div>
            <span className="block mt-1 text-[11.5px]" style={{ color: "var(--ink-3)" }}>
              Give the player that URL, the username <span className="mono">{username}</span>, and
              either credential below.
            </span>
          </div>

          <div>
            <span className="chip">API key</span>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <code className="mono break-all text-[12px]">{subsonicKey}</code>
              <button type="button" className="btn shrink-0" onClick={() => copyText("key", subsonicKey)}>
                {copied === "key" ? "Copied" : "Copy"}
              </button>
              <button
                type="button"
                className="btn shrink-0"
                onClick={() => setSubsonicKeyReset(true)}
                disabled={subsonicKeyReset}
              >
                {subsonicKeyReset ? "New key on save" : "New key"}
              </button>
            </div>
            <span className="block mt-1 text-[11.5px]" style={{ color: "var(--ink-3)" }}>
              {subsonicKeyReset
                ? "A new key is generated when you save. The old one stops working immediately."
                : "Sent as apiKey= instead of a username and password. Regenerating it signs every player out."}
            </span>
          </div>

          <div>
            <span className="chip">Subsonic password</span>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <code className="mono break-all text-[12px]">{subsonicSecret}</code>
              <button
                type="button"
                className="btn shrink-0"
                onClick={() => copyText("secret", subsonicSecret)}
              >
                {copied === "secret" ? "Copied" : "Copy"}
              </button>
              <button
                type="button"
                className="btn shrink-0"
                onClick={() => setSubsonicSecretReset(true)}
                disabled={subsonicSecretReset}
              >
                {subsonicSecretReset ? "New password on save" : "New password"}
              </button>
            </div>
            <span className="block mt-1 text-[11.5px]" style={{ color: "var(--ink-3)" }}>
              {subsonicSecretReset
                ? "A new password is generated when you save."
                : "Used with the username above, and the only credential md5 token auth can be checked against. Separate from the web password, and it opens nothing but this API."}
            </span>
          </div>

          <p className="text-[11.5px]" style={{ color: "var(--ink-3)" }}>
            Use HTTPS if this server is reachable from outside: a password in a URL is visible to
            everything in between.
          </p>
        </Section>

        <Section tab="system" title="Notifications" hint="One message per finished job, on the server.">
          <div>
            <span className="chip">Webhook</span>
            {webhookSet && !webhookEditing && !webhookRemove ? (
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <span className="text-[12.5px]">
                  Configured · <span className="mono">{webhookHost || "stored"}</span>
                </span>
                <button type="button" className="btn shrink-0" onClick={() => setWebhookEditing(true)}>
                  Replace
                </button>
                <button
                  type="button"
                  className="btn shrink-0"
                  onClick={() => {
                    setWebhook("");
                    setWebhookRemove(true);
                  }}
                >
                  Remove
                </button>
              </div>
            ) : (
              <div className="mt-1.5 flex items-start gap-2">
                <input
                  className="field"
                  value={webhook}
                  onChange={(e) => setWebhook(e.target.value)}
                  placeholder="https://discord.com/api/webhooks/…"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={webhookRemove}
                />
                {webhookEditing && (
                  <button
                    type="button"
                    className="btn shrink-0"
                    onClick={() => {
                      setWebhook("");
                      setWebhookEditing(false);
                    }}
                  >
                    Cancel
                  </button>
                )}
                {webhookRemove && (
                  <button
                    type="button"
                    className="btn shrink-0"
                    onClick={() => setWebhookRemove(false)}
                  >
                    Undo
                  </button>
                )}
              </div>
            )}
            <span className="block mt-1 text-[11.5px]" style={{ color: "var(--ink-3)" }}>
              {webhookRemove
                ? "The webhook is removed when you save. Undo keeps it."
                : webhookSet && !webhookEditing
                  ? `One message per finished job to ${webhookHost || "the configured host"}. The URL is stored on the server only.`
                  : webhookSet
                    ? "Paste the new URL and save; the old one stays until then."
                    : 'Discord, ntfy, Slack or anything that accepts {"content": "…"}. Kept on the server and never shown again.'}
            </span>
          </div>

          <label className="flex items-center gap-2 text-[12.5px]">
            <input
              type="checkbox"
              checked={webhookGuests}
              onChange={(e) => setWebhookGuests(e.target.checked)}
            />
            Also report guest downloads
          </label>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="btn"
              onClick={testWebhook}
              disabled={testing || !webhookSet}
            >
              {testing ? "Sending…" : "Send test notification"}
            </button>
            {testOk && (
              <span className="text-[11.5px]" style={{ color: "var(--ink-2)" }}>
                {testOk}
              </span>
            )}
          </div>
          {testError && (
            <p className="text-[12px]" role="alert" style={{ color: "var(--danger)" }}>
              {testError}
            </p>
          )}
        </Section>

        <Section
          tab="library"
          className="lg:col-span-2"
          title="History"
          hint="Your finished jobs, newest first - kept in data/history.json, last 200. Guest streams are not listed."
        >
          {history.length === 0 ? (
            <p className="text-[12.5px]" style={{ color: "var(--ink-3)" }}>
              Nothing has finished yet.
            </p>
          ) : (
            <ul>
              {history.slice(0, 10).map((entry, index) => (
                <li
                  key={`${entry.id}-${entry.finishedAt}`}
                  className="flex items-start justify-between gap-3 py-2"
                  style={{ borderTop: index === 0 ? "none" : "1px solid var(--line)" }}
                >
                  <div className="min-w-0">
                    <div className="truncate text-[12.5px]">{entry.title}</div>
                    <div className="text-[11px]" style={{ color: "var(--ink-3)" }}>
                      {[entry.artist, entry.album].filter(Boolean).join(" - ") || "no album"} ·{" "}
                      {entry.completed}/{entry.total} downloaded
                      {entry.failed ? ` · ${entry.failed} failed` : ""} ·{" "}
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
        </Section>

        <Section tab="system" className="lg:col-span-2" title="Backup" hint="A copy of the settings that are safe to carry around.">
          <div className="flex flex-wrap items-center gap-2">
            <a className="btn" href="/api/settings/export" download>
              Download settings
            </a>
            <label className="btn cursor-pointer">
              {importing ? "Reading…" : "Import settings"}
              <input
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void importFile(file);
                  e.currentTarget.value = "";
                }}
              />
            </label>
          </div>
          <span className="block text-[11.5px]" style={{ color: "var(--ink-3)" }}>
            The export leaves out the password hash and the webhook URL; importing never sets either.
          </span>
          {notice && (
            <p className="text-[12px]" style={{ color: "var(--ink-2)" }} role="status">
              {notice}
            </p>
          )}
        </Section>

        <Section tab="general" title="Owner account" hint="The password is stored only as a scrypt hash.">
          <div>
            <span className="chip">Two-factor authentication</span>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <span className="text-[12.5px]" style={{ color: twoFactor ? "var(--ink-2)" : "var(--ink-3)" }}>
                {twoFactor
                  ? "On - a 6-digit code is asked for after the password."
                  : "Off - the password alone signs in."}
              </span>
              <button type="button" className="btn" onClick={openTwoFactor}>
                {twoFactor ? "Turn off…" : "Set up…"}
              </button>
            </div>
          </div>

          <label className="block">
            <span className="chip">Change password</span>
            <input
              className="field mt-1.5"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Leave blank to keep it"
              autoComplete="new-password"
            />
            {password && <PasswordMeter value={password} />}
            <span className="block mt-1 text-[11.5px]" style={{ color: "var(--ink-3)" }}>
              Changing it signs out every device, including this one.
            </span>
          </label>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="mono text-[11px] break-all" style={{ color: "var(--ink-3)" }}>
              {settings.binary}
            </span>
            <button className="btn" onClick={signOut}>
              Sign out
            </button>
          </div>
        </Section>
          </div>
        </div>

        {error && (
          <p className="mt-5 text-[13px]" role="alert" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        )}
        {signingOut && (
          <p className="mt-5 text-[13px]" style={{ color: "var(--ink-2)" }}>
            Saved. Signing you out so the new password takes effect…
          </p>
        )}

        {/* Sits at the foot of the viewport while the page scrolls: settings
            pages are long, and hunting for save is the usual annoyance. */}
        <div className="sticky bottom-4 z-20 mt-4 flex justify-end">
          <div className="card flex items-center gap-2 p-2 pl-4">
            {dirty && (
              <span className="dot sm:hidden" style={{ background: "var(--ink)" }} aria-hidden="true" />
            )}
            <span
              className="hidden text-[11.5px] sm:inline"
              style={{ color: dirty ? "var(--ink-2)" : "var(--ink-3)" }}
              role="status"
            >
              {dirty ? "Unsaved changes." : "Applies to the next download."}
            </span>
            <a className="btn btn-ghost text-[12.5px]" href="/">
              Back to queue
            </a>
            <button
              className="btn btn-primary"
              onClick={save}
              disabled={busy || signingOut || !musicDir || !siteName.trim()}
            >
              {busy ? "Saving…" : "Save changes"}
              {!busy && <ArrowIcon />}
            </button>
          </div>
        </div>
      </main>

      <Dialog.Root open={twoFactorOpen} onOpenChange={setTwoFactorOpen}>
        <Dialog.Portal>
          <Dialog.Overlay
            className="fixed inset-0 z-40"
            style={{ background: "rgb(0 0 0 / 32%)", backdropFilter: "blur(2px)" }}
          />
          <Dialog.Content
            className="card fixed z-50 left-1/2 top-1/2 w-[min(92vw,420px)] max-h-[calc(100dvh-2rem)] overflow-y-auto -translate-x-1/2 -translate-y-1/2 p-6"
            aria-describedby={undefined}
          >
            <div className="flex items-start justify-between mb-4">
              <div>
                <Dialog.Title className="text-[16px] font-semibold">
                  {twoFactorMode === "enable" ? "Set up two-factor" : "Turn off two-factor"}
                </Dialog.Title>
                <p className="text-[12.5px] mt-0.5" style={{ color: "var(--ink-3)" }}>
                  {twoFactorMode === "enable"
                    ? "Add this secret to an authenticator app, then enter the code it shows."
                    : "Enter a current code to confirm it is you."}
                </p>
              </div>
              <Dialog.Close asChild>
                <button className="btn btn-ghost px-2" aria-label="Close">
                  <CloseIcon />
                </button>
              </Dialog.Close>
            </div>

            {twoFactorMode === "enable" && (
              <div className="space-y-3">
                {totpUri ? (
                  <div className="flex flex-col items-center gap-2">
                    <QrCode value={totpUri} />
                    <p className="mono text-[11px] break-all text-center" style={{ color: "var(--ink-3)" }}>
                      {totpSecret}
                    </p>
                  </div>
                ) : (
                  <p className="text-[12.5px]" style={{ color: "var(--ink-3)" }}>
                    {totpBusy ? "Preparing…" : "The secret could not be created."}
                  </p>
                )}
                <label className="block">
                  <span className="chip">Code from the app</span>
                  <input
                    id="totp-setup-code"
                    name="totp"
                    className="field mono mt-1.5 text-center text-[18px] tracking-[0.3em]"
                    value={totpCode}
                    onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    placeholder="000000"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={6}
                    autoComplete="one-time-code"
                    autoCapitalize="off"
                    spellCheck={false}
                  />
                </label>
                <ServerClock />
              </div>
            )}

            {twoFactorMode === "disable" && (
              <label className="block">
                <span className="chip">Current code</span>
                <input
                  id="totp-disable-code"
                  name="totp"
                  className="field mono mt-1.5 text-center text-[18px] tracking-[0.3em]"
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="000000"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  autoComplete="one-time-code"
                  autoCapitalize="off"
                  spellCheck={false}
                />
              </label>
            )}

            {totpError && (
              <p className="mt-3 text-[12.5px]" role="alert" style={{ color: "var(--danger)" }}>
                {totpError}
              </p>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <Dialog.Close asChild>
                <button className="btn">Cancel</button>
              </Dialog.Close>
              <button
                className="btn btn-primary"
                onClick={confirmTwoFactor}
                disabled={totpBusy || totpCode.length !== 6 || (twoFactorMode === "enable" && !totpUri)}
              >
                {totpBusy
                  ? "Checking…"
                  : twoFactorMode === "enable"
                    ? "Turn on two-factor"
                    : "Turn off"}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={nudge} onOpenChange={(open) => !open && dismissNudge()}>
        <Dialog.Portal>
          <Dialog.Overlay
            className="fixed inset-0 z-40"
            style={{ background: "rgb(0 0 0 / 32%)", backdropFilter: "blur(2px)" }}
          />
          <Dialog.Content
            className="card fixed z-50 left-1/2 top-1/2 w-[min(92vw,400px)] -translate-x-1/2 -translate-y-1/2 p-6"
            aria-describedby={undefined}
          >
            <Dialog.Title className="text-[16px] font-semibold">
              Add two-factor to the owner account?
            </Dialog.Title>
            <p className="mt-1.5 text-[12.5px] leading-relaxed" style={{ color: "var(--ink-2)" }}>
              A 6-digit code from an authenticator app would be asked for after the password,
              so a stolen password alone is not enough. You can do this later in Settings.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button className="btn" onClick={dismissNudge}>
                Later
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  dismissNudge();
                  void openTwoFactor();
                }}
              >
                Set it up
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
