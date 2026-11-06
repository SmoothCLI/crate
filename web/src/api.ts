import type {
  AudioDuplicateGroup,
  CookiesState,
  Diagnostics,
  Draft,
  DuplicateReport,
  GuestProfile,
  GuestTally,
  HistoryEntry,
  Job,
  LibraryBrowse,
  LibraryHealth,
  LibrarySort,
  LibraryStats,
  Preview,
  Role,
  Settings,
} from "./types";
import type { AdminLook } from "./lib/appearance";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    // The flag travels with the error so a caller can offer the fix (a cookie
    // jar) instead of only printing the message.
    const failure = new Error(data.error || `Request failed (${res.status}).`) as Error & {
      needsCookies?: boolean;
    };
    if (data.needsCookies) failure.needsCookies = true;
    throw failure;
  }
  return data as T;
}

export const api = {
  me: () =>
    request<{
      authed: boolean;
      role: Role | null;
      guestEnabled: boolean;
      setupNeeded: boolean;
      siteName: string;
      // The release this UI is part of and where its source lives, shown in
      // the footer under the queue.
      version: string;
      repo: string;
      contact: string;
      stats: GuestTally;
    }>("/api/me"),
  setup: () =>
    request<{ needed: boolean; siteName: string; username: string; guestEnabled: boolean }>("/api/setup"),
  finishSetup: (body: {
    siteName: string;
    username: string;
    contact: string;
    password: string;
    guestEnabled: boolean;
  }) => request<{ ok: true; role: Role }>("/api/setup", { method: "POST", body: JSON.stringify(body) }),
  // `remember` is how many days the device stays signed in, or "forever";
  // null keeps the cookie to this browser window only.
  login: (username: string, password: string, remember: number | "forever" | null) =>
    request<{
      ok: true;
      role?: Role;
      twoFactor?: boolean;
      challenge?: string;
      remembered?: boolean;
    }>("/api/login", {
      method: "POST",
      body: JSON.stringify({ username, password, remember }),
    }),
  loginTwoFactor: (challenge: string, code: string) =>
    request<{ ok: true; role: Role }>("/api/login/2fa", {
      method: "POST",
      body: JSON.stringify({ challenge, code }),
    }),
  twoFactorSetup: () =>
    request<{ secret: string; otpauth: string }>("/api/2fa/setup", { method: "POST" }),
  enableTwoFactor: (code: string) =>
    request<{ ok: true; enabled: boolean }>("/api/2fa/enable", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),
  disableTwoFactor: (code: string) =>
    request<{ ok: true; enabled: boolean }>("/api/2fa/disable", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),
  guest: () => request<{ ok: true; role: Role }>("/api/guest", { method: "POST" }),
  guestSettings: () =>
    request<{ settings: GuestProfile; presets: Record<string, Omit<GuestProfile, "preset">> }>(
      "/api/guest/settings",
    ),
  saveGuestSettings: (body: Partial<GuestProfile>) =>
    request<{ settings: GuestProfile }>("/api/guest/settings", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  logout: () => request<{ ok: true }>("/api/logout", { method: "POST" }),
  settings: () => request<Settings>("/api/settings"),
  // The look of /admin, which lives on the server rather than in a cookie.
  saveAdminLook: (body: Partial<AdminLook>) =>
    request<{ ok: true; adminLook: AdminLook }>("/api/admin/look", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  saveSettings: (
    body: Partial<
      Omit<Settings, "canEdit" | "binary" | "username" | "webhookSet" | "webhookHost">
    > & {
      username?: string;
      password?: string;
      // null removes the stored webhook; a blank string keeps it.
      webhookUrl?: string | null;
    },
  ) =>
    request<{ ok: true }>("/api/settings", { method: "PUT", body: JSON.stringify(body) }),
  testWebhook: () => request<{ ok: true; host: string }>("/api/webhook/test", { method: "POST" }),
  // The owner's cookie jar for sources that want a signed-in session. The
  // contents go up and never come back: the reply only describes the jar.
  saveCookies: (text: string) =>
    request<{ ok: true; rows: number; cookies: CookiesState }>("/api/cookies", {
      method: "PUT",
      body: JSON.stringify({ text }),
    }),
  removeCookies: () =>
    request<{ ok: true; cookies: CookiesState }>("/api/cookies", { method: "DELETE" }),
  library: () => request<LibraryStats>("/api/library"),
  browseLibrary: (
    params: { q?: string; artist?: string; album?: string; sort?: LibrarySort } = {},
  ) => {
    const query = new URLSearchParams();
    if (params.q) query.set("q", params.q);
    if (params.artist) query.set("artist", params.artist);
    if (params.album) query.set("album", params.album);
    if (params.sort) query.set("sort", params.sort);
    const suffix = query.toString();
    return request<LibraryBrowse>(`/api/library/browse${suffix ? `?${suffix}` : ""}`);
  },
  // A URL for <audio>: the server answers ranges, so the element can scrub.
  libraryTrack: (file: string) => `/api/library/track?path=${encodeURIComponent(file)}`,
  // One cover per album folder, read from a cover.jpg or the embedded picture.
  libraryCover: (dir: string) => `/api/library/cover?dir=${encodeURIComponent(dir)}`,
  libraryHealth: () => request<LibraryHealth>("/api/library/health"),
  pruneEmptyFolders: (dirs: string[]) =>
    request<{ removed: string[]; failed: { dir: string; reason: string }[] }>(
      "/api/library/health/prune",
      { method: "POST", body: JSON.stringify({ dirs }) },
    ),
  audioDuplicates: () => request<DuplicateReport>("/api/library/duplicates"),
  scanAudioDuplicates: (limit = 12) =>
    request<{ scanned: number; pending: number; total: number; groups: AudioDuplicateGroup[] }>(
      "/api/library/duplicates/scan",
      { method: "POST", body: JSON.stringify({ limit }) },
    ),
  removeAudioDuplicates: (paths: string[]) =>
    request<{ removed: string[]; failed: { path: string; reason: string }[] }>(
      "/api/library/duplicates/remove",
      { method: "POST", body: JSON.stringify({ paths }) },
    ),
  history: () => request<{ history: HistoryEntry[] }>("/api/history"),
  diagnostics: () => request<Diagnostics>("/api/diagnostics"),
  updateYtdlp: () =>
    request<{ ok: true; version: string; updatedAt: number }>("/api/tools/ytdlp/update", {
      method: "POST",
    }),
  resetStats: () =>
    request<{ ok: true; stats: GuestTally }>("/api/stats/reset", { method: "POST" }),
  importSettings: (payload: unknown) =>
    request<{ ok: true; siteName: string; contact: string }>("/api/settings/import", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  artists: () => request<{ artists: string[] }>("/api/artists"),
  inspect: (url: string) =>
    request<Preview>("/api/inspect", { method: "POST", body: JSON.stringify({ url }) }),
  // Raw bytes rather than JSON: the image goes up as it is and the server
  // sniffs its type, then hands back the path the review card should show.
  uploadCover: async (file: File) => {
    const res = await fetch("/api/covers", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(data.error || `Upload failed (${res.status}).`);
    return data as { url: string };
  },
  plan: (draft: Draft) =>
    request<Preview>("/api/plan", {
      method: "POST",
      body: JSON.stringify({
        url: draft.url,
        kind: draft.kind,
        lufs: draft.lufs,
        format: draft.format,
        artist: draft.artist,
        album: draft.album,
        genre: draft.genre,
        trackPrefix: draft.trackPrefix,
        selection: draft.rows.filter((r) => r.selected).map((r) => r.i),
        rows: draft.rows
          .filter((r) => r.selected)
          .map((r) => ({ i: r.i, title: r.title, track: r.track, date: r.date, art: r.art })),
      }),
    }),
  jobs: () => request<{ jobs: Job[] }>("/api/jobs"),
  queue: (draft: Draft, conflicts: number) =>
    request<{ job: Job }>("/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        url: draft.url,
        thumb: draft.thumbnail,
        kind: draft.kind,
        title:
          draft.kind === "playlist"
            ? draft.title || draft.album || "Playlist"
            : draft.rows[0]?.title || "Single track",
        artist: draft.artist,
        album: draft.album,
        genre: draft.genre,
        lufs: draft.lufs,
        quality: draft.quality,
        format: draft.format,
        onePass: draft.onePass,
        art: draft.art,
        trackPrefix: draft.trackPrefix,
        policy: draft.policy,
        conflicts,
        selection: draft.rows.filter((r) => r.selected).map((r) => r.i),
        rows: draft.rows
          .filter((r) => r.selected)
          .map((r) => ({
            i: r.i,
            title: r.title,
            track: r.track,
            date: r.date,
            art: r.art,
            duration: r.duration,
            sourceTitle: r.sourceTitle,
          })),
      }),
    }),
  cancel: (id: string) => request<{ job: Job }>(`/api/jobs/${id}/cancel`, { method: "POST" }),
  retry: (id: string) => request<{ job: Job }>(`/api/jobs/${id}/retry`, { method: "POST" }),
  retag: (id: string, tags: { title?: string; artist: string; album: string; genre: string }) =>
    request<{ ok: true; retagged: number; job: Job; warning?: string }>(`/api/jobs/${id}/tags`, {
      method: "PATCH",
      body: JSON.stringify(tags),
    }),
  remove: (id: string) => request<{ ok: true }>(`/api/jobs/${id}`, { method: "DELETE" }),
};
