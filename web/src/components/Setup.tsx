import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { EffectsToggle } from "./EffectsToggle";
import { ArrowIcon } from "./Icons";
import { PasswordMeter } from "./PasswordMeter";

// Keep in step with the server's rule; the meter uses the same number.
const MIN_PASSWORD = 10;
const USERNAME = /^[A-Za-z0-9._-]{2,32}$/;

type Errors = { username?: string; password?: string; confirm?: string; form?: string };

export function Setup({ onDone }: { onDone: () => void }) {
  const [siteName, setSiteName] = useState("");
  const [contact, setContact] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [guestAccess, setGuestAccess] = useState(true);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);

  // The server hands back its defaults; they are the "autofill if empty"
  // values, so the form is already complete apart from the password.
  useEffect(() => {
    let alive = true;
    api
      .setup()
      .then((info) => {
        if (!alive) return;
        setSiteName((current) => current || info.siteName);
        setUsername((current) => current || info.username);
        setGuestAccess(info.guestEnabled);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  function validate(): Errors {
    const next: Errors = {};
    const name = username.trim();
    if (name && !USERNAME.test(name)) {
      next.username = "Use 2-32 letters, digits, dots, dashes or underscores.";
    }
    if (password.length < MIN_PASSWORD) {
      next.password = `Use at least ${MIN_PASSWORD} characters.`;
    }
    if (confirm !== password) {
      next.confirm = "The two passwords do not match.";
    }
    return next;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    try {
      await api.finishSetup({
        siteName: siteName.trim(),
        username: username.trim(),
        contact: contact.trim(),
        password,
        guestEnabled: guestAccess,
      });
      onDone();
    } catch (err) {
      setErrors({ form: err instanceof Error ? err.message : "Could not save the password." });
      setBusy(false);
    }
  }

  const name = siteName.trim() || "This server";

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-5 py-12">
      <div className="fixed right-4 top-4">
        <EffectsToggle />
      </div>
      <div className="card w-full max-w-[440px] p-6 sm:p-7">
        <div className="mb-6 text-center">
          <span className="chip">First run</span>
          <h1 className="mt-3 text-[20px] font-semibold tracking-[-0.01em]">{name}</h1>
          <p className="mt-1.5 text-[12.5px] leading-relaxed" style={{ color: "var(--ink-3)" }}>
            Name the instance and choose the owner account. This is the only account with a
            password; everything here can be changed later at{" "}
            <span className="mono">/admin</span>.
          </p>
        </div>

        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="space-y-3">
            <label className="block">
              <span className="chip">Instance name</span>
              <input
                className="field mt-1.5"
                value={siteName}
                onChange={(e) => setSiteName(e.target.value)}
                placeholder="Crate"
                maxLength={40}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
              />
              <span className="block mt-1 text-[11.5px]" style={{ color: "var(--ink-3)" }}>
                The header, the tab and a home-screen shortcut.
              </span>
            </label>

            <label className="block">
              <span className="chip">Contact (optional)</span>
              <input
                className="field mt-1.5"
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                placeholder="you@example.com or a link"
                maxLength={200}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
              />
              <span className="block mt-1 text-[11.5px]" style={{ color: "var(--ink-3)" }}>
                Shown only on the public <span className="mono">/contact</span> page.
              </span>
            </label>
          </div>

          <div className="pt-1" style={{ borderTop: "1px solid var(--line)" }}>
            <p className="mb-3 mt-3 text-[11.5px] font-medium" style={{ color: "var(--ink-2)" }}>
              Owner account
            </p>

            <label className="block">
              <span className="chip">Username</span>
              <input
                autoFocus
                className="field mt-1.5"
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value);
                  if (errors.username) setErrors((current) => ({ ...current, username: undefined }));
                }}
                placeholder="admin"
                maxLength={32}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                disabled={busy}
                aria-invalid={Boolean(errors.username)}
                aria-describedby={errors.username ? "username-error" : undefined}
              />
              {errors.username && (
                <span id="username-error" className="mt-1 block text-[11.5px]" style={{ color: "var(--danger)" }}>
                  {errors.username}
                </span>
              )}
            </label>

            <label className="mt-3 block">
              <span className="chip">Password</span>
              <span className="relative mt-1.5 flex">
                <input
                  className="field pr-[64px]"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (errors.password) setErrors((current) => ({ ...current, password: undefined }));
                  }}
                  placeholder={`At least ${MIN_PASSWORD} characters`}
                  autoComplete="new-password"
                  disabled={busy}
                  aria-invalid={Boolean(errors.password)}
                  aria-describedby={errors.password ? "password-error" : undefined}
                />
                <button
                  type="button"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-[11px]"
                  style={{ color: "var(--ink-2)" }}
                  onClick={() => setShowPassword((current) => !current)}
                  disabled={busy}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  aria-pressed={showPassword}
                >
                  {showPassword ? "Hide" : "Show"}
                </button>
              </span>
              <PasswordMeter value={password} />
              {errors.password && (
                <span id="password-error" className="mt-1 block text-[11.5px]" style={{ color: "var(--danger)" }}>
                  {errors.password}
                </span>
              )}
            </label>

            <label className="mt-3 block">
              <span className="chip">Repeat password</span>
              <input
                className="field mt-1.5"
                type={showPassword ? "text" : "password"}
                value={confirm}
                onChange={(e) => {
                  setConfirm(e.target.value);
                  if (errors.confirm) setErrors((current) => ({ ...current, confirm: undefined }));
                }}
                placeholder="Repeat password"
                autoComplete="new-password"
                disabled={busy}
                aria-invalid={Boolean(errors.confirm)}
                aria-describedby={errors.confirm ? "confirm-error" : undefined}
              />
              {errors.confirm && (
                <span id="confirm-error" className="mt-1 block text-[11.5px]" style={{ color: "var(--danger)" }}>
                  {errors.confirm}
                </span>
              )}
            </label>
          </div>

          <div className="pt-1" style={{ borderTop: "1px solid var(--line)" }}>
            <label className="mt-3 flex items-start gap-2 text-[12.5px]">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={guestAccess}
                onChange={(e) => setGuestAccess(e.target.checked)}
                disabled={busy}
              />
              <span>
                Let guests download without the password
                <span className="block text-[11.5px]" style={{ color: "var(--ink-3)" }}>
                  Their audio is streamed to the browser and never written into the library. You can
                  change this, and add a daily limit, at <span className="mono">/admin#guests</span>.
                </span>
              </span>
            </label>
          </div>

          <button
            className="btn btn-primary w-full"
            disabled={busy || !password || !confirm}
          >
            {busy ? "Creating instance…" : "Create instance and sign in"}
            {!busy && <ArrowIcon />}
          </button>
        </form>

        {errors.form && (
          <p className="mt-3 text-[13px] text-center" role="alert" style={{ color: "var(--danger)" }}>
            {errors.form}
          </p>
        )}

        <p className="mt-5 text-center text-[11.5px] leading-relaxed" style={{ color: "var(--ink-3)" }}>
          The password is stored only as a scrypt hash in{" "}
          <span className="mono">data/settings.json</span>.
        </p>
      </div>
    </div>
  );
}
