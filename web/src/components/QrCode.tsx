import qrcode from "qrcode-generator";

// Drawn here rather than fetched from a QR service: the value contains the
// two-factor secret, which must never leave the browser.
//
// Two things matter for a phone camera to read it: the quiet zone of light
// modules around the code (scanners look for that edge and fail without it),
// and whole pixels per module. A fractional scale, or a rounded corner cutting
// into the corner finder patterns, is enough for "unable to scan".
export function QrCode({ value, size = 164 }: { value: string; size?: number }) {
  let qr: ReturnType<typeof qrcode> | null = null;
  try {
    qr = qrcode(0, "M");
    qr.addData(value);
    qr.make();
  } catch {
    return null;
  }
  if (!qr) return null;

  const count = qr.getModuleCount();
  const quiet = 4;
  const total = count + quiet * 2;
  // At least one device pixel per module, and a whole number of them.
  const px = Math.max(2, Math.floor(size / total)) * total;

  const parts: string[] = [];
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) parts.push(`M${col} ${row}h1v1h-1z`);
    }
  }

  return (
    <svg
      width={px}
      height={px}
      viewBox={`${-quiet} ${-quiet} ${total} ${total}`}
      role="img"
      aria-label="Two-factor setup QR code"
      shapeRendering="crispEdges"
    >
      <rect x={-quiet} y={-quiet} width={total} height={total} fill="#fff" />
      <path d={parts.join("")} fill="#111" />
    </svg>
  );
}
