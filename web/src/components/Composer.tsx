import { useRef, useState, type FormEvent } from "react";
import { ArrowIcon } from "./Icons";

type Props = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (url: string) => void;
  busy: boolean;
  error: string | null;
  // Owned by the page so a keyboard shortcut can put the cursor here.
  inputRef?: React.RefObject<HTMLInputElement | null>;
};

export function Composer({ value, onChange, onSubmit, busy, error, inputRef: outerRef }: Props) {
  const [dragging, setDragging] = useState(false);
  const localRef = useRef<HTMLInputElement>(null);
  const inputRef = outerRef ?? localRef;

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const text = value.trim();
    if (text && !busy) onSubmit(text);
  }

  function useDropped(event: React.DragEvent) {
    event.preventDefault();
    setDragging(false);
    const text = event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain");
    if (text) {
      onChange(text.trim());
      onSubmit(text);
    }
  }

  // Pasting a list of links is one gesture: hand the whole block to the app,
  // which inspects the first and holds the rest in line.
  function paste(event: React.ClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData.getData("text");
    const links = text.match(/https?:\/\/\S+/g) ?? [];
    if (links.length > 1) {
      event.preventDefault();
      onChange(links.join("\n"));
      onSubmit(text);
    }
  }

  return (
    <section aria-labelledby="composer-label" className="pt-2">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1
            id="composer-label"
            className="text-[30px] font-semibold leading-[1.04] tracking-[-0.03em] sm:text-[36px]"
          >
            Paste a link.
            <span className="block" style={{ color: "var(--ink-3)" }}>
              Get a tagged file.
            </span>
          </h1>
          <p className="mt-2.5 max-w-[48ch] text-[13px]" style={{ color: "var(--ink-3)" }}>
            Tracks and playlists, loudness-normalised and filed as Artist / Album / Title, with cover art
            and lyrics.
          </p>
        </div>
        <span className="chip hidden shrink-0 pt-1.5 sm:inline">yt-dlp + ffmpeg</span>
      </div>

      <form
        onSubmit={submit}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={useDropped}
        className="flex flex-col sm:flex-row gap-2"
      >
        <div className="relative flex-1">
          <input
            ref={inputRef}
            className="field h-12 text-[15px] pr-10"
            style={dragging ? { borderColor: "var(--ink)", background: "var(--surface-3)" } : undefined}
            placeholder="https://soundcloud.com/artist/sets/album"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onPaste={paste}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label="Track or playlist link"
            disabled={busy}
          />
          {value && !busy && (
            <button
              type="button"
              aria-label="Clear"
              onClick={() => {
                onChange("");
                inputRef.current?.focus();
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-[12px]"
              style={{ color: "var(--ink-3)" }}
            >
              Clear
            </button>
          )}
        </div>
        <button className="btn btn-primary h-12 px-5" disabled={busy || !value.trim()}>
          {busy ? "Reading…" : "Inspect"}
          {!busy && <ArrowIcon />}
        </button>
      </form>

      <p className="mt-2.5 text-[12.5px]" style={{ color: "var(--ink-3)" }}>
        Paste or drop a link - a track, a set, or several links at once. Nothing downloads until you confirm.
      </p>

      {error && (
        <p
          role="alert"
          className="mt-3 rounded-[10px] px-3 py-2 text-[13px]"
          style={{ background: "var(--surface-3)", color: "var(--ink)" }}
        >
          {error}
        </p>
      )}
    </section>
  );
}
