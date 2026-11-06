import { useEffect, useState } from "react";
import { api } from "../api";
import { writePref } from "../lib/prefs";
import { SparkleIcon } from "./Icons";

const KEY = "audiodl-effects";

// The glass, the auras and the motion are the look, but they cost GPU time and
// some people simply do not want moving backgrounds. This is the one switch:
// it drops every blur, animation and gradient wash, leaving the same layout in
// flat, opaque form. The attribute is server-rendered from the same choice's
// cookie and set in main.tsx before the first paint either way, so a reload does
// not flash the effects back in.
//
// On the settings page the choice is not this browser's: `scope="server"` sends
// it to the stored admin look instead, so every device gets the same page.
export function EffectsToggle({ scope = "local" }: { scope?: "local" | "server" }) {
  const [on, setOn] = useState(() => document.documentElement.dataset.effects !== "off");

  useEffect(() => {
    document.documentElement.dataset.effects = on ? "on" : "off";
    if (scope === "local") writePref(KEY, on ? "on" : "off");
  }, [on, scope]);

  const toggle = () => {
    const next = !on;
    setOn(next);
    if (scope !== "server") return;
    // A failed save puts the switch back where it was, rather than leaving the
    // page in a state the server does not know about.
    api.saveAdminLook({ effects: next ? "on" : "off" }).catch(() => setOn(!next));
  };

  return (
    <button
      type="button"
      className="btn btn-ghost px-2"
      onClick={toggle}
      aria-pressed={on}
      aria-label={on ? "Turn effects off" : "Turn effects on"}
      title={on ? "Effects on: glass and motion" : "Effects off: plain and still"}
      style={on ? undefined : { opacity: 0.55 }}
    >
      <SparkleIcon />
    </button>
  );
}
