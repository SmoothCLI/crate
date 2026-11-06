// The look (theme, effects, palette) is picked per browser, but the first paint
// is the server's: it cannot read localStorage, so each choice is mirrored into
// a cookie as well. The server writes the attributes onto <html> per request and
// the page keeps reading localStorage, so a stored light theme or a paused
// effects switch never flashes the wrong colours in. Both stores are written
// together, which is what keeps them from disagreeing.

// Browsers drop anything older than 400 days; a taste can live that long.
const MAX_AGE = 400 * 24 * 60 * 60;

export function readCookie(name: string): string {
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    // A hand-edited or truncated cookie is worth nothing, not an error.
    return "";
  }
}

export function writeCookie(name: string, value: string) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${MAX_AGE}`,
    "SameSite=Lax",
  ];
  // Same rule the session cookie follows: only claim Secure where it is true.
  if (location.protocol === "https:") parts.push("Secure");
  document.cookie = parts.join("; ");
}

export function readPref(name: string): string | null {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(name);
  } catch {
    /* storage disabled: the cookie is still there */
  }
  return stored ?? (readCookie(name) || null);
}

export function writePref(name: string, value: string) {
  try {
    localStorage.setItem(name, value);
  } catch {
    /* the cookie below still carries it */
  }
  writeCookie(name, value);
}
