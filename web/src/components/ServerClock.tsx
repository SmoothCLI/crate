import { useEffect, useState } from "react";

// One-time codes are UTC counters, so a time zone never breaks them - only a
// clock that is actually set wrong does. The sign-in and setup screens show
// the server's clock in this device's local time next to the code field, so an
// authenticator that is out of step is visible instead of just "wrong code".
export function ServerClock({ className = "" }: { className?: string }) {
  const [offset, setOffset] = useState<number | null>(null);
  const [tick, setTick] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    fetch("/api/time", { credentials: "same-origin" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!alive || !data || typeof data.now !== "number") return;
        setOffset(data.now - Date.now());
      })
      .catch(() => {});
    const timer = window.setInterval(() => setTick(Date.now()), 1000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  const serverNow = tick + (offset ?? 0);
  const clock = new Date(serverNow).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const drift = offset === null ? 0 : Math.round(offset / 1000);

  return (
    <div className={className}>
      <p className="text-[11.5px] leading-relaxed" style={{ color: "var(--ink-3)" }}>
        Server clock {clock}
      </p>
      {Math.abs(drift) >= 10 && (
        <p className="text-[11.5px] leading-relaxed" style={{ color: "var(--danger)" }}>
          This device is {Math.abs(drift)} s {drift > 0 ? "behind" : "ahead of"} the server - turn
          on automatic time where the authenticator runs.
        </p>
      )}
    </div>
  );
}
