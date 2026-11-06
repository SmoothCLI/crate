import type { AdminLook } from "./lib/appearance";

export type PreviewTrack = {
  i: number;
  id: string;
  title: string;
  url: string;
  duration: number;
  path: string;
  exists: boolean;
  artist: string;
  album: string;
  track: number;
  date: string;
  // Owner-only: where the import index says an earlier run of this same upload
  // put its file. Absent unless that copy exists and this run would write a
  // different path.
  duplicate?: string;
};

export type PreviewDefaults = {
  artist: string;
  album: string;
  genre: string;
  date: string;
  thumbnail: string;
  lufs: number;
  quality: number;
  format: string;
  trackPrefix: boolean;
  musicDir: string;
};

export type DuplicateMatch = {
  i: number;
  title: string;
  source: "library" | "history";
  path: string;
  artist: string;
  album: string;
};

export type Preview = {
  v: 1;
  // Owner-only: tracks that already exist in the library or the history.
  duplicates?: DuplicateMatch[];
  event: "inspect" | "plan";
  kind: "track" | "playlist";
  url: string;
  playlist: { id: string; title: string; count: number };
  defaults: PreviewDefaults;
  conflicts: number;
  // Owner-only: the genre vocabulary from the shipped artist map, offered as
  // suggestions in the review card.
  genres?: string[];
  tracks: PreviewTrack[];
};

export type Row = {
  i: number;
  sourceTitle: string;
  title: string;
  track: number;
  date: string;
  art: string;
  duration: number;
  selected: boolean;
};

export type Draft = {
  url: string;
  kind: "track" | "playlist";
  title: string;
  thumbnail: string;
  artist: string;
  album: string;
  genre: string;
  date: string;
  lufs: number;
  quality: number;
  format: string;
  onePass: boolean;
  art: boolean;
  trackPrefix: boolean;
  policy: "skip" | "overwrite";
  rows: Row[];
};

export type JobTrack = {
  i: number;
  title: string;
  duration: number;
  state: "queued" | "running" | "done" | "failed" | "skipped";
  stage: string | null;
  pct: number;
  path?: string;
  size?: number;
  error?: string;
  // Set when the track was skipped because the library already has it: the
  // copy that was found, so the row can say which one.
  duplicatePath?: string;
};

export type Job = {
  id: string;
  url: string;
  // Cover art URL reported by the source, shown beside the job.
  thumb?: string;
  kind: "track" | "playlist";
  // Guest jobs stream each track to the browser instead of writing a file.
  stream?: boolean;
  title: string;
  artist: string;
  album: string;
  // Written into every finished file; empty means no genre tag.
  genre?: string;
  lufs: number;
  quality: number;
  format: string;
  onePass: boolean;
  art: boolean;
  trackPrefix: boolean;
  policy: "skip" | "overwrite";
  total: number;
  completed: number;
  skipped?: number;
  failed?: number;
  conflicts: number;
  state: "queued" | "running" | "cancelling" | "done" | "failed" | "cancelled";
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  expiresAt?: number;
  expired?: boolean;
  stagedBytes?: number;
  error?: string;
  // Owner-only: the failure was a source asking for a signed-in session, so a
  // cookie jar in Settings is what fixes it.
  needsCookies?: boolean;
  log: string[];
  tracks: JobTrack[];
};

export type Role = "owner" | "guest";

export type GuestProfile = {
  preset: string;
  format: string;
  quality: number;
  lufs: number;
  art: boolean;
};

// Owner-only: the last background check of the project's releases.
export type UpdateInfo = {
  current: string;
  latest: string;
  // The release page, or the releases list when the check had no answer yet.
  url: string;
  // The release body, trimmed; empty until a check succeeds.
  notes: string;
  available: boolean;
  checkedAt: number;
};

export type Settings = {
  musicDir: string;
  lufs: number;
  quality: number;
  format: string;
  binary: string;
  canEdit: boolean;
  siteName: string;
  // Public: shown on /contact, optional.
  contact: string;
  guestEnabled: boolean;
  username: string;
  maxJobs: number;
  perHost: number;
  // 0 means no daily cap; the used counter is only filled in for guests.
  guestQuota: number;
  guestQuotaUsed: number;
  // The webhook URL itself never leaves the server; this is what the browser
  // is allowed to know about it.
  webhookSet: boolean;
  webhookHost: string;
  webhookGuests: boolean;
  // TOTP on the owner account.
  twoFactor: boolean;
  // Whether a cookie jar is stored, and nothing about what is in it. Owner
  // only; a guest never receives the field.
  cookies?: CookiesState;
  // The look of /admin, kept on the server instead of in this browser's
  // cookies: one choice, every device.
  adminLook: AdminLook;
  // Owner-only: a newer release, when the last check found one.
  update?: UpdateInfo;
};

// A stored cookie jar, described without its contents: how many sites it
// covers, how big it is and when it was last written.
export type CookiesState = { set: boolean; bytes: number; updatedAt: number; domains: number };

export type LibraryStats = {
  path: string;
  artists: number;
  albums: number;
  tracks: number;
  bytes: number;
  writable: boolean;
  freeBytes: number | null;
  totalBytes: number | null;
  truncated: boolean;
  lastJob: { title: string; state: string; finishedAt: number; completed: number } | null;
};

// Structural problems in the folder, found with a cheap walk rather than a tag
// read per file. Every entry is a path the owner can act on.
export type LibraryHealth = {
  at: number;
  path: string;
  counts: { artists: number; albums: number; tracks: number };
  emptyDirs: string[];
  emptyDirsTotal: number;
  loose: string[];
  looseTotal: number;
  nested: string[];
  nestedTotal: number;
  mixed: { dir: string; files: string[] }[];
  mixedTotal: number;
  orphans: { title: string; path: string }[];
  orphansTotal: number;
};

// One file that is the same recording as another, found by fingerprint.
export type AudioDuplicateFile = {
  path: string;
  name: string;
  bytes: number;
  format: string;
  duration: number;
};

export type AudioDuplicateGroup = { files: AudioDuplicateFile[] };

export type DuplicateReport = {
  at: number;
  // False when fpcalc is missing from the image, so the UI can say why.
  fpcalc: boolean;
  measured: number;
  groups: AudioDuplicateGroup[];
};

// Public, aggregate: guest browsers and the songs they finished streaming.
export type GuestTally = { guests: number; tracks: number };

export type HistoryEntry = {
  id: string;
  title: string;
  artist: string;
  album: string;
  kind: "track" | "playlist";
  format: string;
  stream: boolean;
  total: number;
  completed: number;
  skipped: number;
  failed: number;
  state: string;
  owner: "owner" | "guest";
  finishedAt: number;
};

export type Diagnostics = {
  ytdlp: {
    path: string;
    version: string;
    // True when the copy in the data folder shadows the one in the image.
    private: boolean;
    updatedAt: number;
    updating: boolean;
  };
  ffmpeg: { path: string; version: string };
  script: { path: string; version: string };
  system: { node: string; platform: string; uptimeSeconds: number };
  disk: { freeBytes: number; totalBytes: number } | null;
};

// One file in the owner's library, described from its path rather than by
// reading its tags: the downloader already writes ARTIST/ALBUM/[NN - ]TITLE.
export type LibraryTrack = {
  path: string;
  name: string;
  artist: string;
  album: string;
  title: string;
  track: number | null;
  ext: string;
  bytes: number;
  mtime: number;
};

export type LibraryArtist = { name: string; tracks: number; bytes: number; albums: number };

export type LibraryAlbum = { name: string; artist: string; tracks: number; bytes: number };

// One endpoint answers all three views: the artist list always, the albums and
// tracks of the chosen artist, or a flat result list when `q` is set.
export type LibraryBrowse = {
  root: string;
  scannedAt: number;
  truncated: boolean;
  total: number;
  q: string;
  matched: number;
  artists: LibraryArtist[];
  albums: LibraryAlbum[];
  tracks: LibraryTrack[];
};

export type Theme = "auto" | "light" | "dark";
