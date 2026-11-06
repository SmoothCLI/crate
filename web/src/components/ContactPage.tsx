import { useEffect } from "react";

// Public page at /contact. It deliberately shows nothing about the owner
// account: no username, no paths, no settings.
export function ContactPage({ siteName, contact }: { siteName: string; contact: string }) {
  const name = siteName || "Crate";

  useEffect(() => {
    document.title = `${name} · Contact`;
  }, [name]);

  const trimmed = contact.trim();
  const isUrl = /^https?:\/\//i.test(trimmed);
  const isEmail = !isUrl && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
  const href = isUrl ? trimmed : isEmail ? `mailto:${trimmed}` : null;

  return (
    <div className="min-h-dvh">
      <header
        className="sticky top-0 z-30"
        style={{
          background: "color-mix(in srgb, var(--canvas) 58%, transparent)",
          backdropFilter: "blur(26px) saturate(160%)",
          WebkitBackdropFilter: "blur(26px) saturate(160%)",
          borderBottom: "1px solid var(--line)",
        }}
      >
        <div className="mx-auto flex h-14 max-w-[640px] items-center justify-between px-5">
          <div className="flex min-w-0 items-center gap-2.5">
            <img
              src="/icon.svg"
              alt=""
              aria-hidden="true"
              width={22}
              height={22}
              className="h-[22px] w-[22px] shrink-0 rounded-[6px]"
            />
            <span className="text-[14px] font-semibold tracking-[0.01em]">{name}</span>
          </div>
          <a className="btn btn-ghost px-2 text-[12.5px]" href="/">
            Queue
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-[640px] px-5 py-10 space-y-5">
        <div>
          <h1 className="text-[22px] font-semibold tracking-[-0.01em]">Contact</h1>
          <p className="mt-1 text-[13px] leading-relaxed" style={{ color: "var(--ink-3)" }}>
            {name} is a self-hosted queue for audio downloads.
          </p>
        </div>

        <section className="card p-5">
          {href ? (
            <>
              <p className="text-[13px] leading-relaxed">
                Questions, takedowns or access: reach the person running this server at{" "}
                {href.startsWith("mailto:") ? (
                  <a className="underline" href={href}>
                    {trimmed}
                  </a>
                ) : (
                  <a className="underline break-all" href={href} target="_blank" rel="noreferrer noopener">
                    {trimmed}
                  </a>
                )}
                .
              </p>
            </>
          ) : (
            <p className="text-[13px] leading-relaxed" style={{ color: "var(--ink-3)" }}>
              The owner has not added contact details to this server. If you were given this link,
              ask whoever shared it.
            </p>
          )}
        </section>

        <section className="card p-5">
          <h2 className="text-[13.5px] font-semibold">About guest downloads</h2>
          <p className="mt-2 text-[13px] leading-relaxed" style={{ color: "var(--ink-2)" }}>
            Tracks are encoded on the server and streamed straight to the browser - one file, or one
            ZIP for an album. Nothing is written to the music library, and no account is needed.
          </p>
        </section>

        <section className="card p-5">
          <h2 className="text-[13.5px] font-semibold">Notice &amp; takedowns</h2>
          <div className="mt-2 space-y-2 text-[13px] leading-relaxed" style={{ color: "var(--ink-2)" }}>
            <p>
              {name} is an independently run installation. It is not affiliated with, endorsed by, or
              operated by yt-dlp, ffmpeg, any site it can download from, or the people who wrote
              those tools - they provide software only and have no access to this server.
            </p>
            <p>
              Anything in the library was downloaded by the person running this instance, who decides
              what is kept here. If you hold the rights to something and want it taken down, contact
              the operator above; the authors of those tools cannot help and are not responsible for
              how this server is used.
            </p>
            <p style={{ color: "var(--ink-3)" }}>
              Guest downloads are streamed to the visitor's browser and not retained by the server.
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}
