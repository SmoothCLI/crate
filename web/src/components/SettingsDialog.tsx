import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { api } from "../api";
import type { GuestProfile } from "../types";
import { CloseIcon, GearIcon } from "./Icons";

type Preset = Omit<GuestProfile, "preset">;

// Guests get this small dialog; the owner's settings live on /admin instead, so
// the gear in the header opens different things depending on who is looking.
export function SettingsDialog() {
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState("m4a");
  const [quality, setQuality] = useState("3");
  const [lufs, setLufs] = useState("-11");
  const [art, setArt] = useState(true);
  const [preset, setPreset] = useState("phone");
  const [presets, setPresets] = useState<Record<string, Preset>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    api
      .guestSettings()
      .then(({ settings: profile, presets: available }) => {
        setFormat(profile.format);
        setQuality(String(profile.quality));
        setLufs(String(profile.lufs));
        setArt(profile.art);
        setPreset(profile.preset);
        setPresets(available);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Could not load your settings.");
      });
  }, [open]);

  function choosePreset(name: string) {
    const picked = presets[name];
    if (!picked) return;
    setPreset(name);
    setFormat(picked.format);
    setQuality(String(picked.quality));
    setLufs(String(picked.lufs));
    setArt(picked.art);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.saveGuestSettings({
        preset,
        format,
        quality: Number(quality),
        lufs: Number(lufs),
        art,
      });
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button className="btn btn-ghost px-2" aria-label="Download settings" title="Download settings">
          <GearIcon />
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
            <div>
              <Dialog.Title className="text-[17px] font-semibold">Download settings</Dialog.Title>
              <p className="text-[12.5px] mt-0.5" style={{ color: "var(--ink-3)" }}>
                Applies to guest downloads.
              </p>
            </div>
            <Dialog.Close asChild>
              <button className="btn btn-ghost px-2" aria-label="Close settings">
                <CloseIcon />
              </button>
            </Dialog.Close>
          </div>

          <div className="space-y-4">
            {Object.keys(presets).length > 0 && (
              <div>
                <span className="chip">Preset</span>
                <div className="mt-1.5 grid grid-cols-3 gap-2">
                  {(
                    [
                      ["phone", "Phone"],
                      ["small", "Small"],
                      ["lossless", "Lossless"],
                    ] as const
                  ).map(([name, label]) =>
                    presets[name] ? (
                      <button
                        key={name}
                        type="button"
                        className={`btn text-[12px] ${preset === name ? "btn-primary" : ""}`}
                        onClick={() => choosePreset(name)}
                      >
                        {label}
                      </button>
                    ) : null,
                  )}
                </div>
                <span className="block mt-1 text-[11.5px]" style={{ color: "var(--ink-3)" }}>
                  Presets fill the values below; change any of them for a custom mix.
                </span>
              </div>
            )}

            <label className="block">
              <span className="chip">Output format</span>
              <select
                className="field mt-1.5"
                value={format}
                onChange={(e) => {
                  setFormat(e.target.value);
                  setPreset("custom");
                }}
              >
                <option value="m4a">M4A (AAC)</option>
                <option value="mp3">MP3</option>
                <option value="flac">FLAC (lossless)</option>
                <option value="wav">WAV (uncompressed)</option>
              </select>
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="chip">Target LUFS</span>
                <input
                  className="field num mt-1.5"
                  value={lufs}
                  onChange={(e) => {
                    setLufs(e.target.value);
                    setPreset("custom");
                  }}
                  inputMode="numeric"
                />
              </label>
              <label className="block">
                <span className="chip">Quality</span>
                <select
                  className="field mt-1.5"
                  value={quality}
                  onChange={(e) => {
                    setQuality(e.target.value);
                    setPreset("custom");
                  }}
                >
                  <option value="1">High (q1)</option>
                  <option value="2">Balanced (q2)</option>
                  <option value="3">Small (q3)</option>
                  <option value="4">Smaller (q4)</option>
                  <option value="5">Smallest (q5)</option>
                </select>
              </label>
            </div>

            <label className="flex items-center gap-2 text-[12.5px]">
              <input
                type="checkbox"
                checked={art}
                onChange={(e) => {
                  setArt(e.target.checked);
                  setPreset("custom");
                }}
              />
              Embed cover art
            </label>
          </div>

          {error && (
            <p className="mt-4 text-[13px]" role="alert" style={{ color: "var(--danger)" }}>
              {error}
            </p>
          )}

          <div className="mt-6 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button className="btn">Cancel</button>
            </Dialog.Close>
            <button className="btn btn-primary" onClick={save} disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
