import type { Theme } from "../types";
import { readPref, writePref } from "./prefs";

// Auto / Light / Dark is the one choice that used to be applied only after React
// mounted, which is exactly long enough to flash. It goes to a cookie so the
// server can put it on <html> for the first frame, and main.tsx applies it
// before the render for any path the server did not build (the dev server).
export const THEME_KEY = "audiodl-theme";

export function readTheme(): Theme {
  const stored = readPref(THEME_KEY);
  return stored === "light" || stored === "dark" ? stored : "auto";
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}

export function saveTheme(theme: Theme) {
  writePref(THEME_KEY, theme);
}
