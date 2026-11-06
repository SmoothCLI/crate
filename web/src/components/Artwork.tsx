import { useEffect, useState, type CSSProperties } from "react";

// Cover art with a blurred copy underneath. The browser paints that copy the
// moment the bytes arrive, so the sharp image fades in from soft to crisp
// instead of popping into an empty grey tile. The wrapper owns the size and
// radius (including responsive classes); it clips the blurred layer.
export function Artwork({
  src,
  title,
  className = "",
  initialClassName = "text-[13px] font-medium",
  style,
}: {
  src?: string;
  title: string;
  className?: string;
  initialClassName?: string;
  style?: CSSProperties;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  // A different cover means starting over, or a stale "loaded" flashes the old one.
  useEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [src]);

  const initial = title.trim().slice(0, 1).toUpperCase() || "♪";
  const usable = Boolean(src) && !failed;

  return (
    <div className={`relative shrink-0 overflow-hidden ${className}`} style={style}>
      {usable ? (
        <>
          <img
            src={src}
            alt=""
            aria-hidden="true"
            referrerPolicy="no-referrer"
            loading="lazy"
            onError={() => setFailed(true)}
            className="pointer-events-none absolute inset-0 h-full w-full scale-110 object-cover blur-lg"
          />
          <img
            src={src}
            alt=""
            aria-hidden="true"
            referrerPolicy="no-referrer"
            loading="lazy"
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
            className={`relative h-full w-full object-cover transition-[opacity,filter] duration-500 ease-out ${
              loaded ? "opacity-100 blur-0" : "opacity-0 blur-sm"
            }`}
          />
        </>
      ) : (
        <div
          className={`flex h-full w-full items-center justify-center ${initialClassName}`}
          style={{ background: "var(--surface-3)", color: "var(--ink-3)" }}
          aria-hidden="true"
        >
          {initial}
        </div>
      )}
    </div>
  );
}
