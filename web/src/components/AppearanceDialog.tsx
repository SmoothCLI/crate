import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tooltip from "@radix-ui/react-tooltip";
import type { Theme } from "../types";
import { ACCENTS, FLAVORS, type Accent, type Appearance, type Flavor } from "../lib/appearance";
import { CloseIcon, PaletteIcon } from "./Icons";

const THEMES: { id: Theme; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

function title(value: string) {
  return value[0].toUpperCase() + value.slice(1);
}

// One dialog for everything that changes how the page looks. The theme choice
// lives here (rather than a one-click cycle in the header) so the Catppuccin
// flavor can switch light/dark off when it is active without a second control
// disagreeing with it. Every choice applies immediately - there is nothing to
// save. The Settings page opens the same dialog with a different note, because
// there the choice is stored on the server instead of in this browser.
export function AppearanceDialog({
  theme,
  onTheme,
  appearance,
  onChange,
  note = "Only this browser. Every guest picks their own.",
}: {
  theme: Theme;
  onTheme: (theme: Theme) => void;
  appearance: Appearance;
  onChange: (appearance: Appearance) => void;
  note?: string;
}) {
  const [open, setOpen] = useState(false);
  const flavored = appearance.flavor !== null;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          className="btn btn-ghost px-2"
          aria-label="Appearance"
          title="Appearance: theme and colors"
        >
          <PaletteIcon />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-40"
          style={{ background: "rgb(0 0 0 / 32%)", backdropFilter: "blur(2px)" }}
        />

        <Dialog.Content
          className="card fixed z-50 left-1/2 top-1/2 w-[min(92vw,460px)] max-h-[calc(100dvh-2rem)] overflow-y-auto -translate-x-1/2 -translate-y-1/2 p-6"
          aria-describedby={undefined}
        >
          <div className="flex items-start justify-between mb-5">
            <div>
              <Dialog.Title className="text-[17px] font-semibold">Appearance</Dialog.Title>
              <p className="text-[12.5px] mt-0.5" style={{ color: "var(--ink-3)" }}>
                {note}
              </p>
            </div>
            <Dialog.Close asChild>
              <button className="btn btn-ghost px-2" aria-label="Close appearance">
                <CloseIcon />
              </button>
            </Dialog.Close>
          </div>

          <div className="space-y-5">
            <div>
              <span className="chip">Theme</span>
              <div className="mt-1.5 grid grid-cols-3 gap-2">
                {THEMES.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={`btn text-[12px] ${theme === option.id ? "btn-primary" : ""}`}
                    aria-pressed={theme === option.id}
                    disabled={flavored}
                    onClick={() => onTheme(option.id)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[11.5px]" style={{ color: "var(--ink-3)" }}>
                {flavored
                  ? "The flavor is light or dark on its own, so these are off while one is chosen."
                  : "Auto follows this device's setting."}
              </p>
            </div>

            <div>
              <span className="chip">Color scheme</span>
              <div className="mt-1.5 grid grid-cols-3 gap-2">
                {/* Fixed neutrals, not the live tokens: while a flavor is on,
                    var(--surface) and var(--ink) are the flavor's own colours,
                    so the card would inherit them and stop reading as neutral. */}
                <button
                  type="button"
                  className="flavor-card flex flex-col items-stretch gap-2 rounded-[11px] border p-2.5 text-left"
                  aria-pressed={!flavored}
                  onClick={() => onChange({ ...appearance, flavor: null })}
                  style={{
                    background: "#f4f5f8",
                    color: "#2b2f3a",
                    borderColor: "var(--line)",
                  }}
                >
                  <span className="flex items-center gap-1" aria-hidden="true">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: "#dfe2ea" }} />
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: "#a6abb8" }} />
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: "#22252c" }} />
                  </span>
                  <span className="text-[11.5px] font-medium leading-none">Default</span>
                </button>

                {FLAVORS.map((flavor) => (
                  <FlavorCard
                    key={flavor.id}
                    flavor={flavor.id}
                    label={flavor.label}
                    accent={appearance.accent}
                    selected={appearance.flavor === flavor.id}
                    onSelect={() => onChange({ ...appearance, flavor: flavor.id })}
                  />
                ))}
              </div>
            </div>

            <div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="chip">Accent</span>
                {/* The name stays on screen for touch and for anyone who cannot
                    tell the shades apart in a 28px circle. */}
                {flavored && (
                  <span className="text-[11.5px]" style={{ color: "var(--ink-2)" }}>
                    {title(appearance.accent)}
                  </span>
                )}
              </div>
              {/* Mocha's tones stand in until a flavor is chosen: the swatches
                  are disabled then, but showing them says what is on offer. */}
              <Tooltip.Provider delayDuration={200}>
                <div
                  className="mt-2 flex flex-wrap gap-2"
                  data-catppuccin={appearance.flavor ?? "mocha"}
                  role="group"
                  aria-label="Accent color"
                >
                  {ACCENTS.map((accent) => (
                    <Tooltip.Root key={accent}>
                      <Tooltip.Trigger asChild>
                        <button
                          type="button"
                          className="accent-dot h-7 w-7 rounded-full"
                          aria-label={`${title(accent)} accent`}
                          aria-pressed={appearance.accent === accent}
                          disabled={!flavored}
                          onClick={() => onChange({ ...appearance, accent })}
                          style={{
                            background: `var(--ctp-${accent})`,
                            opacity: flavored ? 1 : 0.45,
                          }}
                        />
                      </Tooltip.Trigger>
                      <Tooltip.Portal>
                        <Tooltip.Content
                          sideOffset={7}
                          className="z-[60] rounded-[8px] border px-2 py-1 text-[11.5px] font-medium"
                          style={{
                            background: "var(--surface-3)",
                            color: "var(--ink)",
                            borderColor: "var(--line-strong)",
                            boxShadow: "0 10px 24px -16px var(--shadow-deep)",
                          }}
                        >
                          {title(accent)}
                        </Tooltip.Content>
                      </Tooltip.Portal>
                    </Tooltip.Root>
                  ))}
                </div>
              </Tooltip.Provider>
              <p className="mt-2 text-[11.5px]" style={{ color: "var(--ink-3)" }}>
                {flavored
                  ? "Tints the auras, progress, focus rings and the overview chart."
                  : "Pick a flavor to use an accent."}
              </p>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function FlavorCard({
  flavor,
  label,
  accent,
  selected,
  onSelect,
}: {
  flavor: Flavor;
  label: string;
  accent: Accent;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      data-catppuccin={flavor}
      className="flavor-card flex flex-col items-stretch gap-2 rounded-[11px] border p-2.5 text-left"
      aria-pressed={selected}
      onClick={onSelect}
      style={{
        background: "var(--ctp-base)",
        color: "var(--ctp-text)",
        borderColor: selected ? "var(--ink)" : "var(--line)",
      }}
    >
      <span className="flex items-center gap-1" aria-hidden="true">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: "var(--ctp-surface0)" }} />
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: "var(--ctp-surface2)" }} />
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: `var(--ctp-${accent})` }} />
      </span>
      <span className="text-[11.5px] font-medium leading-none">{label}</span>
    </button>
  );
}
