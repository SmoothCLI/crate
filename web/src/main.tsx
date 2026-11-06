import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
// After index.css on purpose: a Catppuccin flavor must beat the built-in
// [data-theme="dark"] block, and both have the same specificity.
import "./theme.css";
import { applyAppearance, readAppearance } from "./lib/appearance";
import { readPref } from "./lib/prefs";
import { applyTheme, readTheme } from "./lib/theme";

// The settings page is the one page whose look is stored on the server, and the
// server already wrote it onto <html>. Touching it here would put this device's
// own theme back on top of the shared one until the settings arrive.
const atAdmin = (window.location.pathname.replace(/\/+$/, "") || "/") === "/admin";

if (!atAdmin) {
  // Before the first paint: the effects toggle must not flash the glass and
  // animations back on for a reload where they were turned off.
  const storedEffects = readPref("audiodl-effects");
  const prefersStill = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.documentElement.dataset.effects =
    storedEffects === "off" || (!storedEffects && prefersStill) ? "off" : "on";

  // Same for the theme and a chosen palette: a Catppuccin page should arrive
  // already colored, and Light or Dark should be on <html> before the browser
  // paints the empty shell. The server writes both from the same cookies, so this
  // is only the path that did not go through it (the dev server).
  applyTheme(readTheme());
  applyAppearance(readAppearance());
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
