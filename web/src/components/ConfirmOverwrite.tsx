import * as Dialog from "@radix-ui/react-dialog";
import { AlertIcon, CloseIcon } from "./Icons";

// Overwriting is the one irreversible action in the app, so it never happens
// from a single click: the exact files that will be replaced are listed first.
export function ConfirmOverwrite({
  open,
  onOpenChange,
  paths,
  count,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  paths: string[];
  count: number;
  busy: boolean;
  onConfirm: () => void;
}) {
  const shown = paths.slice(0, 40);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-40"
          style={{ background: "rgb(0 0 0 / 32%)", backdropFilter: "blur(2px)" }}
        />
        <Dialog.Content
          className="card fixed z-50 left-1/2 top-1/2 w-[min(92vw,520px)] -translate-x-1/2 -translate-y-1/2 p-6"
          aria-describedby={undefined}
        >
          <div className="flex items-start justify-between gap-4 mb-4">
            <div>
              <Dialog.Title className="text-[17px] font-semibold flex items-center gap-2">
                <span style={{ color: "var(--danger)" }}>
                  <AlertIcon size={15} />
                </span>
                Overwrite {count === 1 ? "1 file" : `${count} files`}?
              </Dialog.Title>
              <p className="text-[12.5px] mt-1 leading-relaxed" style={{ color: "var(--ink-2)" }}>
                These files already exist and will be replaced. The old versions are deleted, not moved aside.
              </p>
            </div>
            <Dialog.Close asChild>
              <button className="btn btn-ghost px-2" aria-label="Close">
                <CloseIcon />
              </button>
            </Dialog.Close>
          </div>

          <div className="inset scroll-thin max-h-[38vh] overflow-auto p-3">
            <ul className="space-y-1">
              {shown.map((file) => (
                <li key={file} className="mono text-[11.5px] break-all" style={{ color: "var(--ink-2)" }}>
                  {file}
                </li>
              ))}
            </ul>
            {paths.length > shown.length && (
              <p className="mt-2 text-[11.5px]" style={{ color: "var(--ink-3)" }}>
                and {paths.length - shown.length} more
              </p>
            )}
          </div>

          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button className="btn">Keep existing</button>
            </Dialog.Close>
            <button
              className="btn"
              onClick={onConfirm}
              disabled={busy}
              style={{ background: "var(--danger)", borderColor: "var(--danger)", color: "#fff" }}
            >
              {busy ? "Queueing…" : `Overwrite ${count === 1 ? "file" : `${count} files`}`}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
