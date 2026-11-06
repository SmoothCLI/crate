import { useState } from "react";
import type { UpdateInfo } from "../types";
import { CloseIcon, SparkleIcon } from "./Icons";

// Per browser, per release: dismissing 3.2.0 keeps it quiet on this device until
// something newer is published. The stored value is the version that was
// dismissed, so an old dismissal never silences a new release.
const DISMISS_KEY = "audiodl-update-dismissed";

function readDismissed(): string {
  try {
    return localStorage.getItem(DISMISS_KEY) ?? "";
  } catch {
    return "";
  }
}

export function UpdateHint({ update, className = "" }: { update?: UpdateInfo; className?: string }) {
  const [dismissed, setDismissed] = useState(readDismissed);
  if (!update?.available || !update.latest || dismissed === update.latest) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, update.latest);
    } catch {
      // Private mode: the dismissal still holds for this visit.
    }
    setDismissed(update.latest);
  };

  return (
    <div
      className={`card flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3 text-[12.5px] ${className}`.trim()}
      role="status"
      aria-label="Update available"
      style={{ color: "var(--ink-2)" }}
    >
      <span className="shrink-0" style={{ color: "var(--ink-3)" }}>
        <SparkleIcon size={14} />
      </span>
      <span className="font-medium" style={{ color: "var(--ink)" }}>
        Crate {update.latest} is available.
      </span>
      <span>You are on {update.current}.</span>
      <a className="underline underline-offset-2" href={update.url} target="_blank" rel="noreferrer">
        Release notes
      </a>
      <span aria-hidden="true">·</span>
      <span>
        update with <span className="mono">docker compose pull</span>.
      </span>
      <button
        type="button"
        onClick={dismiss}
        className="ml-auto rounded-md p-1"
        style={{ color: "var(--ink-3)" }}
        aria-label="Dismiss update notice"
        title="Dismiss until a newer release is published"
      >
        <CloseIcon size={12} />
      </button>
    </div>
  );
}
