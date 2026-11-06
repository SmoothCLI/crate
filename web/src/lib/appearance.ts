import type { Theme } from "../types";
import { readPref, writePref } from "./prefs";
import { applyTheme } from "./theme";

// Catppuccin is a per-browser taste, not an instance setting: a guest should
// not need the owner's password to pick a palette, and one guest's choice must
// not follow another to a different device. localStorage is the store the page
// reads; the same value also goes into a cookie, which is how the server can
// color the first frame (see lib/prefs.ts).
//
// The colours themselves live in theme.css, keyed by the same names, so the
// picker's swatches and the real page cannot drift apart.

export const FLAVORS = [
  { id: "latte", label: "Latte" },
  { id: "frappe", label: "Frappé" },
  { id: "macchiato", label: "Macchiato" },
  { id: "mocha", label: "Mocha" },
] as const;

export type Flavor = (typeof FLAVORS)[number]["id"];

export const ACCENTS = [
  "rosewater",
  "flamingo",
  "pink",
  "mauve",
  "red",
  "maroon",
  "peach",
  "yellow",
  "green",
  "teal",
  "sky",
  "sapphire",
  "blue",
  "lavender",
] as const;

export type Accent = (typeof ACCENTS)[number];

export type Appearance = { flavor: Flavor | null; accent: Accent };

export const DEFAULT_APPEARANCE: Appearance = { flavor: null, accent: "mauve" };

const KEY = "audiodl-catppuccin";

function isFlavor(value: unknown): value is Flavor {
  return FLAVORS.some((flavor) => flavor.id === value);
}

export function readAppearance(): Appearance {
  try {
    const stored = JSON.parse(readPref(KEY) ?? "null") as Partial<Appearance> | null;
    if (!stored) return DEFAULT_APPEARANCE;
    return {
      flavor: isFlavor(stored.flavor) ? stored.flavor : null,
      accent: ACCENTS.includes(stored.accent as Accent)
        ? (stored.accent as Accent)
        : DEFAULT_APPEARANCE.accent,
    };
  } catch {
    // Corrupt or unreadable storage is not worth an error: the default look.
    return DEFAULT_APPEARANCE;
  }
}

export function saveAppearance(value: Appearance) {
  // The cookie is not optional here: it is the only reason the flavor survives
  // as far as the server, and a browser that refuses localStorage still gets
  // the palette on the next load.
  writePref(KEY, JSON.stringify(value));
}

// An empty string would still match [data-catppuccin], so the attribute is
// removed outright when the default palette is chosen.
export function applyAppearance(value: Appearance) {
  const root = document.documentElement;
  if (value.flavor) root.dataset.catppuccin = value.flavor;
  else delete root.dataset.catppuccin;
  root.dataset.accent = value.accent;
}

// /admin is the one page whose look is the server's rather than the browser's.
// The owner picks it once on the Settings page, the server stores it with the
// rest of the instance settings and writes it onto <html> for every device
// (server/index.mjs, adminLook). Nothing here reads or writes a cookie, which
// is what keeps a laptop's own theme from following it onto the server's page.
export type AdminLook = {
  theme: Theme;
  effects: "on" | "off";
  flavor: Flavor | null;
  accent: Accent;
};

export const DEFAULT_ADMIN_LOOK: AdminLook = {
  theme: "auto",
  effects: "on",
  flavor: null,
  accent: DEFAULT_APPEARANCE.accent,
};

export function applyAdminLook(look: AdminLook) {
  applyTheme(look.theme);
  applyAppearance({ flavor: look.flavor, accent: look.accent });
  document.documentElement.dataset.effects = look.effects;
}
