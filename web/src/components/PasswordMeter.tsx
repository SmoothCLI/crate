// Client-side guidance only: the server's rule is the 8-character minimum, so
// the meter must never make a password look required when it is not.
const LABELS = ["", "Weak", "Fair", "Good", "Strong"];
const COLORS = ["transparent", "var(--danger)", "#c98a12", "#4b8f5a", "#2f7d4f"];

function strength(value: string): number {
  if (value.length < 8) return 0;
  let points = 0;
  if (value.length >= 12) points += 1;
  if (value.length >= 16) points += 1;
  if (value.length >= 24) points += 1;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) points += 1;
  if (/\d/.test(value)) points += 1;
  if (/[^A-Za-z0-9]/.test(value)) points += 1;
  if (new Set(value).size >= Math.min(10, value.length)) points += 1;
  if (points >= 5) return 4;
  if (points >= 3) return 3;
  if (points >= 1) return 2;
  return 1;
}

export function PasswordMeter({ value }: { value: string }) {
  const longEnough = value.length >= 8;
  const level = strength(value);
  const label = !value ? "" : longEnough ? LABELS[level] : "Too short";
  const color = longEnough ? COLORS[level] : "var(--danger)";

  return (
    <div className="mt-2">
      <div className="flex gap-1" aria-hidden="true">
        {[1, 2, 3, 4].map((segment) => (
          <span
            key={segment}
            className="h-1 flex-1 rounded-full"
            style={{
              background: longEnough && segment <= level ? COLORS[level] : "var(--line-strong)",
              transition: "background 160ms ease",
            }}
          />
        ))}
      </div>
      <div className="mt-1.5 flex items-baseline justify-between gap-3 text-[11.5px]">
        <span
          className="inline-flex items-center gap-1.5"
          style={{ color: longEnough ? "var(--ink-2)" : "var(--ink-3)" }}
        >
          <span aria-hidden="true" style={{ color: longEnough ? COLORS[3] : "var(--ink-3)" }}>
            {longEnough ? "✓" : "•"}
          </span>
          At least 8 characters
        </span>
        <span aria-live="polite" style={{ color }}>
          {label}
        </span>
      </div>
      {longEnough && level < 3 && (
        <p className="mt-1 text-[11.5px]" style={{ color: "var(--ink-3)" }}>
          Longer passphrases beat short scrambles.
        </p>
      )}
    </div>
  );
}
