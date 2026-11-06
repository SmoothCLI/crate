import { useRef, useState, type DragEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { api } from "../api";
import { Artwork } from "./Artwork";
import { CloseIcon } from "./Icons";

const ACCEPTED = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_BYTES = 8 * 1024 * 1024;

// Cover art for a download or for one track in it. The trigger is either the
// big tile beside the title or a compact row inside a track's editor; both drop
// an image straight onto themselves and open the same dialog for file, link or
// a reset back to the cover above it.
export function CoverPicker({
  src,
  title,
  source,
  variant = "tile",
  resetLabel = "Use source cover",
  description = "Used for every selected track in this download.",
  onChange,
}: {
  src: string;
  title: string;
  // What the reset goes back to: the source's image, or the album's cover.
  source: string;
  variant?: "tile" | "row";
  resetLabel?: string;
  description?: string;
  // An empty string means "go back to the cover above".
  onChange: (url: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // dragenter/dragleave fire for every child, so a counter is what tells a real
  // departure from moving across the trigger.
  const dragDepth = useRef(0);

  const custom = Boolean(src) && src !== source;

  async function takeFile(file: File | undefined) {
    if (!file || busy) return;
    if (!ACCEPTED.includes(file.type)) {
      setError("Use a JPEG, PNG, WebP or GIF image.");
      setOpen(true);
      return;
    }
    if (file.size > MAX_BYTES) {
      setError("That image is larger than 8 MB - try a smaller one.");
      setOpen(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { url } = await api.uploadCover(file);
      onChange(url);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not upload that image.");
      setOpen(true);
    } finally {
      setBusy(false);
    }
  }

  function applyLink() {
    const value = link.trim();
    if (!/^https?:\/\//i.test(value)) {
      setError("A cover link has to start with http:// or https://.");
      return;
    }
    setError(null);
    setLink("");
    onChange(value);
    setOpen(false);
  }

  function openDialog() {
    setError(null);
    setOpen(true);
  }

  function onDragEnter(event: DragEvent) {
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }

  function onDragOver(event: DragEvent) {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  }

  function onDragLeave(event: DragEvent) {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    void takeFile(event.dataTransfer?.files?.[0]);
  }

  const dragProps = {
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
  };

  return (
    <>
      {variant === "row" ? (
        <button
          type="button"
          onClick={openDialog}
          {...dragProps}
          disabled={busy}
          className="flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-left text-[12.5px] transition-colors"
          style={{
            border: `1px solid ${dragging ? "var(--ink)" : "var(--line-strong)"}`,
            background: dragging ? "var(--surface-3)" : "transparent",
            color: "var(--ink-2)",
          }}
          aria-label={`Cover art for ${title}`}
          title="Change this track's cover - drop an image, pick a file or paste a link"
        >
          <Artwork
            src={src}
            title={title}
            className="h-[30px] w-[30px] rounded-[5px]"
            initialClassName="text-[11px] font-medium"
          />
          <span className="min-w-0 flex-1 truncate">
            {busy ? "Uploading…" : custom ? "Your cover" : "Album cover"}
          </span>
          <span className="shrink-0 text-[11.5px]" style={{ color: "var(--ink-3)" }}>
            {dragging ? "Drop it" : "Change"}
          </span>
        </button>
      ) : (
        <button
          type="button"
          onClick={openDialog}
          {...dragProps}
          disabled={busy}
          className="group relative isolate shrink-0 overflow-hidden rounded-[10px] text-left"
          style={{ boxShadow: dragging ? "0 0 0 2px var(--ink)" : "var(--art-shadow)" }}
          aria-label={`Cover art for ${title}`}
          title="Change cover art - drop an image, pick a file or paste a link"
        >
          <Artwork
            src={src}
            title={title}
            className="h-[72px] w-[72px] sm:h-[84px] sm:w-[84px]"
            initialClassName="text-[18px] font-semibold"
          />
          <span
            aria-hidden="true"
            className={`pointer-events-none absolute inset-x-0 bottom-0 pt-3 pb-1 text-center text-[10px] font-medium transition-opacity ${
              dragging || busy
                ? "opacity-100"
                : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
            }`}
            style={{ background: "linear-gradient(transparent, rgb(0 0 0 / 62%))", color: "#fff" }}
          >
            {busy ? "Uploading…" : dragging ? "Drop it" : "Change"}
          </span>
        </button>
      )}

      <input
        ref={fileRef}
        type="file"
        accept={ACCEPTED.join(",")}
        className="hidden"
        onChange={(event) => {
          void takeFile(event.target.files?.[0]);
          event.target.value = "";
        }}
      />

      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay
            className="fixed inset-0 z-40"
            style={{ background: "rgb(0 0 0 / 32%)", backdropFilter: "blur(2px)" }}
          />
          <Dialog.Content
            className="card fixed z-50 left-1/2 top-1/2 w-[min(92vw,420px)] max-h-[calc(100dvh-2rem)] overflow-y-auto -translate-x-1/2 -translate-y-1/2 p-6"
            aria-describedby={undefined}
          >
            <div className="flex items-start justify-between gap-3 mb-5">
              <div className="min-w-0">
                <Dialog.Title className="text-[17px] font-semibold">Cover art</Dialog.Title>
                <p className="text-[12.5px] mt-0.5" style={{ color: "var(--ink-3)" }}>
                  {description}
                </p>
              </div>
              <Dialog.Close asChild>
                <button className="btn btn-ghost px-2" aria-label="Close cover picker">
                  <CloseIcon />
                </button>
              </Dialog.Close>
            </div>

            <div className="flex items-center gap-4">
              <Artwork
                src={src}
                title={title}
                className="h-[96px] w-[96px] rounded-[10px]"
                initialClassName="text-[24px] font-semibold"
                style={{ boxShadow: "var(--art-shadow)" }}
              />
              <p className="text-[12px] min-w-0" style={{ color: "var(--ink-3)" }}>
                {custom ? "Your own image." : source ? "The source's image." : "No cover yet."}
                <br />
                It is resized and embedded once the download finishes.
              </p>
            </div>

            <div
              role="button"
              tabIndex={0}
              onClick={() => fileRef.current?.click()}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  fileRef.current?.click();
                }
              }}
              {...dragProps}
              className="mt-5 flex cursor-pointer flex-col items-center justify-center rounded-[10px] px-3 py-6 text-center text-[12.5px] transition-colors"
              style={{
                border: `1px dashed ${dragging ? "var(--ink)" : "var(--line-strong)"}`,
                background: dragging ? "var(--surface-3)" : "transparent",
                color: "var(--ink-2)",
              }}
            >
              <span>{busy ? "Uploading…" : dragging ? "Drop the image" : "Drop an image here"}</span>
              <span className="mt-1 text-[11.5px]" style={{ color: "var(--ink-3)" }}>
                or click to choose a file · JPEG, PNG, WebP, GIF up to 8 MB
              </span>
            </div>

            <form
              className="mt-4 flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                applyLink();
              }}
            >
              <input
                className="field mono text-[12px]"
                value={link}
                onChange={(event) => setLink(event.target.value)}
                placeholder="https://example.com/cover.jpg"
                aria-label="Cover image link"
                spellCheck={false}
                disabled={busy}
              />
              <button className="btn shrink-0" type="submit" disabled={!link.trim() || busy}>
                Use link
              </button>
            </form>

            {error && (
              <p className="mt-3 text-[12.5px]" role="alert" style={{ color: "var(--danger)" }}>
                {error}
              </p>
            )}

            <div className="mt-6 flex justify-between gap-2">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy || !custom}
                onClick={() => {
                  onChange("");
                  setOpen(false);
                }}
              >
                {resetLabel}
              </button>
              <Dialog.Close asChild>
                <button className="btn">Done</button>
              </Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
