import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import type { Job } from "../types";
import { CloseIcon, PencilIcon } from "./Icons";

// Fixing tags after the fact: the files are already on disk, so this rewrites
// their metadata in place (no re-download, no re-encode) and leaves them in the
// folder they were written to.
export function EditTagsDialog({
  job,
  onSave,
}: {
  job: Job;
  onSave: (
    id: string,
    tags: { title?: string; artist: string; album: string; genre: string },
  ) => Promise<{ warning?: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(job.title);
  const [artist, setArtist] = useState(job.artist);
  const [album, setAlbum] = useState(job.album);
  const [genre, setGenre] = useState(job.genre ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const single = job.total === 1;

  // Start from what the job has now each time it opens, not from a stale draft.
  useEffect(() => {
    if (!open) return;
    setTitle(job.title);
    setArtist(job.artist);
    setAlbum(job.album);
    setGenre(job.genre ?? "");
    setError(null);
    setWarning(null);
  }, [open, job.title, job.artist, job.album, job.genre]);

  async function save() {
    setBusy(true);
    setError(null);
    setWarning(null);
    try {
      const result = await onSave(job.id, {
        ...(single ? { title } : {}),
        artist,
        album,
        genre,
      });
      if (result.warning) {
        // Part of the job was left alone; keep the dialog up so it is visible.
        setWarning(result.warning);
        return;
      }
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not re-tag those files.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button className="btn mt-3 w-full text-[12.5px]">
          <PencilIcon />
          Edit tags
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-40"
          style={{ background: "rgb(0 0 0 / 32%)", backdropFilter: "blur(2px)" }}
        />
        <Dialog.Content
          className="card fixed z-50 left-1/2 top-1/2 w-[min(92vw,440px)] max-h-[calc(100dvh-2rem)] overflow-y-auto -translate-x-1/2 -translate-y-1/2 p-6"
          aria-describedby={undefined}
        >
          <div className="flex items-start justify-between mb-5">
            <div className="min-w-0">
              <Dialog.Title className="text-[17px] font-semibold">Edit tags</Dialog.Title>
              <p className="text-[12.5px] mt-0.5" style={{ color: "var(--ink-3)" }}>
                Rewrites the tags in the files on disk. Nothing is downloaded again and the folder stays put.
              </p>
            </div>
            <Dialog.Close asChild>
              <button className="btn btn-ghost px-2" aria-label="Close tag editor">
                <CloseIcon />
              </button>
            </Dialog.Close>
          </div>

          <div className="space-y-4">
            {single && (
              <label className="block">
                <span className="chip">Title</span>
                <input
                  className="field mt-1.5"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  disabled={busy}
                />
              </label>
            )}
            <label className="block">
              <span className="chip">Artist</span>
              <input
                className="field mt-1.5"
                value={artist}
                onChange={(e) => setArtist(e.target.value)}
                disabled={busy}
              />
            </label>
            <label className="block">
              <span className="chip">Album</span>
              <input
                className="field mt-1.5"
                value={album}
                onChange={(e) => setAlbum(e.target.value)}
                disabled={busy}
              />
            </label>
            <label className="block">
              <span className="chip">Genre</span>
              <input
                className="field mt-1.5"
                value={genre}
                onChange={(e) => setGenre(e.target.value)}
                disabled={busy}
                placeholder="Leave empty for no genre tag"
                spellCheck={false}
              />
            </label>
            {!single && (
              <p className="text-[11.5px]" style={{ color: "var(--ink-3)" }}>
                {job.tracks.filter((track) => track.state === "done").length} finished files get this artist,
                album and genre. Track titles stay as the source reported them.
              </p>
            )}
          </div>

          {error && (
            <p className="mt-4 text-[13px]" role="alert" style={{ color: "var(--danger)" }}>
              {error}
            </p>
          )}
          {warning && (
            <p className="mt-4 text-[12.5px]" role="status" style={{ color: "var(--ink-2)" }}>
              {warning}
            </p>
          )}

          <div className="mt-6 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button className="btn" disabled={busy}>
                {warning ? "Close" : "Cancel"}
              </button>
            </Dialog.Close>
            <button className="btn btn-primary" onClick={save} disabled={busy}>
              {busy ? "Writing…" : "Save tags"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
