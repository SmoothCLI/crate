export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatDuration(seconds?: number): string {
  if (!seconds || seconds <= 0) return "-";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "-";
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return formatDuration(total);
}

export function encodePath(path: string): string {
  return path.replace(/\s+/g, " ");
}
