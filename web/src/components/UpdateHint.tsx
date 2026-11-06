import { useState } from "react";
import type { UpdateInfo } from "../types";
import { CloseIcon, SparkleIcon } from "./Icons";

// Both values store the release they apply to, so neither can silence a newer
// release: dismissing 3.2.0 hides that version, skipping it hides it for good,
// and the next release is shown either way.
const DISMISS_KEY = "audiodl-update-dismissed";
const SKIP_KEY = "audiodl-update-skipped";

function readStored(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

export function UpdateHint({ update, className = "" }: { update?: UpdateInfo; className?: string }) {
  const [dismissed, setDismissed] = useState(() => readStored(DISMISS_KEY));
  const [skipped, setSkipped] = useState(() => readStored(SKIP_KEY));
  if (!update?.available || !update.latest) return null;
  if (dismissed === update.latest || skipped === update.latest) return null;

  const remember = (key: string, done: (value: string) => void) => {
    try {
      localStorage.setItem(key, update.latest);
    } catch {
      // Private mode: the choice still holds for this visit.
    }
    done(update.latest);
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
        onClick={() => remember(DISMISS_KEY, setDismissed)}
        className="ml-auto rounded-md p-1"
        style={{ color: "var(--ink-3)" }}
        aria-label="Dismiss update notice"
        title="Dismiss until a newer release is published"
      >
        <CloseIcon size={12} />
      </button>

      <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]">
        <button
          type="button"
          onClick={() => remember(SKIP_KEY, setSkipped)}
          className="underline underline-offset-2"
          style={{ color: "var(--ink-3)" }}
        >
          Skip this version
        </button>
        {update.notes && (
          <details className="min-w-0">
            <summary className="cursor-pointer select-none" style={{ color: "var(--ink-3)" }}>
              What&apos;s new
            </summary>
            <p className="mt-1 whitespace-pre-wrap" style={{ color: "var(--ink-3)" }}>
              {update.notes}
            </p>
          </details>
        )}
      </div>
    </div>
  );
}
