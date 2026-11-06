import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { api } from "../api";
import type { CookiesState } from "../types";
import { CloseIcon, KeyIcon } from "./Icons";

function ago(ms: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} d ago`;
}

// The one way past a source that wants a signed-in session. yt-dlp is handed a
// Netscape cookie jar, which is what a "Sign in to confirm you're not a bot"
// wall is asking for - so this dialog is also where a failed job or a link that
// would not load sends the owner.
//
// The jar is the owner's own account: it is stored on the server, used only for
// owner downloads, and never handed to a guest. The contents are never sent
// back to a browser either - the page only learns how many sites it covers.
export function CookiesDialog({
  open,
  onOpenChange,
  current,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current?: CookiesState;
  onSaved?: (state: CookiesState) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removeAsk, setRemoveAsk] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // Every open starts blank: a jar is pasted in one go, and leaving the last
  // one in the box invites re-saving it by accident.
  useEffect(() => {
    if (!open) return;
    setText("");
    setError(null);
    setNote(null);
    setRemoveAsk(false);
  }, [open]);

  async function save() {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.saveCookies(text);
      onSaved?.(result.cookies);
      setText("");
      setNote(`Saved ${result.rows} cookie${result.rows === 1 ? "" : "s"} for ${result.cookies.domains} site${result.cookies.domains === 1 ? "" : "s"}.`);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the cookies.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy) return;
    if (!removeAsk) {
      setRemoveAsk(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.removeCookies();
      onSaved?.(result.cookies);
      setRemoveAsk(false);
      setNote("Cookies removed. Downloads are back to signing in anonymously.");
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove the cookies.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-40"
          style={{ background: "rgb(0 0 0 / 32%)", backdropFilter: "blur(2px)" }}
        />
        <Dialog.Content
          className="card fixed z-50 left-1/2 top-1/2 w-[min(92vw,540px)] max-h-[calc(100dvh-2rem)] overflow-y-auto -translate-x-1/2 -translate-y-1/2 p-6"
          aria-describedby={undefined}
        >
          <div className="flex items-start justify-between mb-4">
            <div className="min-w-0">
              <Dialog.Title className="flex items-center gap-2 text-[17px] font-semibold">
                <KeyIcon size={16} />
                Source sign-in
              </Dialog.Title>
              <p className="text-[12.5px] mt-0.5" style={{ color: "var(--ink-3)" }}>
                A cookies.txt for sites that ask for a signed-in session.
              </p>
            </div>
            <Dialog.Close asChild>
              <button className="btn btn-ghost px-2" aria-label="Close source sign-in">
                <CloseIcon />
              </button>
            </Dialog.Close>
          </div>

          <p className="text-[12px] leading-relaxed" style={{ color: "var(--ink-2)" }}>
            Some sources answer a download with “Sign in to confirm you're not a bot”, or only offer a
            track to an account. Export your cookies in Netscape format (a browser extension that saves
            <span className="mono"> cookies.txt</span> does this), open the site, and paste the file
            here. It is stored on the server and used only for your own downloads - guests never touch
            it, and the contents are never sent back to a browser.
          </p>

          {current?.set && (
            <div
              className="mt-4 flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-[12px]"
              style={{ background: "var(--surface-3)", border: "1px solid var(--line-strong)" }}
            >
              <span className="min-w-0 truncate" style={{ color: "var(--ink-2)" }}>
                Stored: {current.domains} site{current.domains === 1 ? "" : "s"} · {ago(current.updatedAt)}
              </span>
              <button
                type="button"
                className="btn btn-ghost shrink-0 px-2 text-[11.5px]"
                onClick={() => void remove()}
                disabled={busy}
              >
                {removeAsk ? "Really remove?" : "Remove"}
              </button>
            </div>
          )}

          <label className="mt-4 block">
            <span className="chip">cookies.txt</span>
            <textarea
              className="field mono mt-1.5 w-full text-[11.5px]"
              rows={8}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setError(null);
              }}
              spellCheck={false}
              autoComplete="off"
              placeholder={
                "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1790000000\tSID\t…"
              }
              style={{ resize: "vertical", minHeight: "140px" }}
            />
          </label>

          {error && (
            <p className="mt-2 text-[12px]" role="alert" style={{ color: "var(--danger)" }}>
              {error}
            </p>
          )}
          {note && !error && (
            <p className="mt-2 text-[12px]" role="status" style={{ color: "var(--ink-2)" }}>
              {note}
            </p>
          )}

          <div className="mt-4 flex items-center justify-end gap-2">
            <Dialog.Close asChild>
              <button type="button" className="btn px-3 text-[12.5px]">
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              className="btn btn-primary px-3 text-[12.5px]"
              onClick={() => void save()}
              disabled={busy || !text.trim()}
            >
              {busy ? "Saving…" : current?.set ? "Replace jar" : "Save jar"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
