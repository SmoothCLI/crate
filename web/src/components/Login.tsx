import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import type { Role } from "../types";
import { EffectsToggle } from "./EffectsToggle";
import { ArrowIcon } from "./Icons";
import { ServerClock } from "./ServerClock";

type Props = {
  siteName?: string;
  guestEnabled: boolean;
  onAuthed: (role: Role) => void;
  onCancel?: () => void;
};

export function Login({ siteName, guestEnabled, onAuthed, onCancel }: Props) {
  // Kept in memory only: the field starts empty on every visit, so neither a
  // browser password store nor an earlier session puts a name in it.
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  // On by default: a self-hosted library on your own phone should not ask for
  // the password every morning. Unticking it keeps the cookie in the browser
  // window, so quitting the browser signs the device out.
  const [remember, setRemember] = useState(true);
  const [rememberDays, setRememberDays] = useState<"7" | "30" | "90" | "forever">("30");
  const [step, setStep] = useState<"password" | "code">("password");
  const [challenge, setChallenge] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"password" | "guest" | "code" | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!password || busy) return;
    setBusy("password");
    setError(null);
    try {
      const res = await api.login(
        username.trim(),
        password,
        remember ? (rememberDays === "forever" ? "forever" : Number(rememberDays)) : null,
      );
      if (res.twoFactor && res.challenge) {
        setChallenge(res.challenge);
        setPassword("");
        setCode("");
        setStep("code");
        setBusy(null);
        return;
      }
      onAuthed((res.role ?? "owner") as Role);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in.");
      setBusy(null);
    }
  }

  async function submitCode(value: string) {
    if (!challenge || busy) return;
    setBusy("code");
    setError(null);
    try {
      const res = await api.loginTwoFactor(challenge, value);
      onAuthed(res.role);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not verify the code.";
      setError(message);
      setCode("");
      setBusy(null);
      // A challenge only lasts two minutes; ask for the password again then.
      if (/expired/i.test(message)) {
        setChallenge("");
        setStep("password");
      }
    }
  }

  // Six digits is the whole code, so no button press is needed once it is full.
  useEffect(() => {
    if (step === "code" && code.length === 6 && busy === null) void submitCode(code);
    // submitCode is recreated per render on purpose: it only reads current state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, step, busy]);

  function backToPassword() {
    setStep("password");
    setChallenge("");
    setCode("");
    setError(null);
    setBusy(null);
  }

  // This card also stands at /admin, and that page's look is stored on the
  // server: the switch must change that, not write this browser's own copy for
  // a page that is not going to read it.
  const atAdmin = (window.location.pathname.replace(/\/+$/, "") || "/") === "/admin";

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-5 py-12">
      <div className="fixed right-4 top-4">
        <EffectsToggle scope={atAdmin ? "server" : "local"} />
      </div>
      <div className="card w-full max-w-[380px] p-6 sm:p-7">
        <div className="mb-6 text-center">
          <div className="text-[15px] tracking-[0.02em] font-semibold">{siteName || "Owner"}</div>
          <p className="mt-1 text-[13px]" style={{ color: "var(--ink-3)" }}>
            {step === "code"
              ? "Enter the code from your authenticator app."
              : "Owner sign in - needed to write into the library and change settings."}
          </p>
        </div>

        {step === "code" ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submitCode(code);
            }}
            className="space-y-3"
          >
            {/* The name, id and autocomplete attributes are what password
                managers look for before they offer the stored TOTP. */}
            <input
              autoFocus
              id="totp-code"
              name="totp"
              className="field mono text-center text-[20px] tracking-[0.35em]"
              placeholder="000000"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              autoComplete="one-time-code"
              autoCapitalize="off"
              spellCheck={false}
              aria-label="Six-digit code"
              disabled={busy !== null}
            />
            <ServerClock className="px-1" />
            <button className="btn btn-primary w-full" disabled={busy !== null || code.length !== 6}>
              {busy === "code" ? "Checking…" : "Verify"}
              {busy === null && <ArrowIcon />}
            </button>
          </form>
        ) : (
          <form onSubmit={submit} className="space-y-3" autoComplete="off">
            <input
              className="field"
              placeholder="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              disabled={busy !== null}
              autoFocus
            />
            <input
              className="field"
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              disabled={busy !== null}
            />
            <div
              className="flex items-center justify-between gap-2 text-[12.5px]"
              style={{ color: "var(--ink-2)" }}
            >
              <label className="flex cursor-pointer select-none items-center gap-2">
                <input
                  type="checkbox"
                  className="h-[15px] w-[15px] accent-[var(--ink)]"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  disabled={busy !== null}
                />
                Keep me signed in
              </label>
              {remember && (
                <select
                  className="cursor-pointer rounded-[7px] px-1.5 py-0.5 text-[12px]"
                  style={{
                    background: "var(--surface-2)",
                    border: "1px solid var(--line)",
                    color: "var(--ink-2)",
                  }}
                  value={rememberDays}
                  onChange={(e) =>
                    setRememberDays(e.target.value as "7" | "30" | "90" | "forever")
                  }
                  aria-label="How long to stay signed in"
                  disabled={busy !== null}
                >
                  <option value="7">for 7 days</option>
                  <option value="30">for 30 days</option>
                  <option value="90">for 90 days</option>
                  <option value="forever">forever</option>
                </select>
              )}
            </div>
            <button
              className="btn btn-primary w-full"
              disabled={busy !== null || !password || !username.trim()}
            >
              {busy === "password" ? "Signing in…" : "Sign in"}
              {busy === null && <ArrowIcon />}
            </button>
          </form>
        )}

        {error && (
          <p className="mt-3 text-[13px] text-center" role="alert" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        )}

        {step === "code" ? (
          <button
            className="btn btn-ghost w-full mt-4 text-[12.5px]"
            onClick={backToPassword}
            disabled={busy !== null}
          >
            Use a different account
          </button>
        ) : (
          <>
            {guestEnabled && (
              <div className="mt-6 pt-5" style={{ borderTop: "1px solid var(--line)" }}>
                <button
                  className="btn w-full"
                  onClick={async () => {
                    setBusy("guest");
                    setError(null);
                    try {
                      const res = await api.guest();
                      onAuthed(res.role);
                    } catch (err) {
                      setError(err instanceof Error ? err.message : "Guest access is unavailable.");
                      setBusy(null);
                    }
                  }}
                  disabled={busy !== null}
                >
                  {busy === "guest" ? "Starting…" : "Continue as guest"}
                </button>
                <p
                  className="mt-2 text-center text-[11.5px] leading-relaxed"
                  style={{ color: "var(--ink-3)" }}
                >
                  Finished files are sent to the browser. The music library stays untouched.
                </p>
              </div>
            )}

            {onCancel && (
              <button
                className="btn btn-ghost w-full mt-4 text-[12.5px]"
                onClick={onCancel}
                disabled={busy !== null}
              >
                Back
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
