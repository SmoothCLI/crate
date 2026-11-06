import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { EffectsToggle } from "./EffectsToggle";
import { ArrowIcon } from "./Icons";
import { PasswordMeter } from "./PasswordMeter";

export function Setup({ onDone }: { onDone: () => void }) {
  const [siteName, setSiteName] = useState("");
  const [contact, setContact] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
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
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (password.length < 8) {
      setError("Use at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    if (username.trim() && !/^[A-Za-z0-9._-]{2,32}$/.test(username.trim())) {
      setError("The username takes 2–32 letters, digits, dots, dashes or underscores.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.finishSetup({
        siteName: siteName.trim(),
        username: username.trim(),
        contact: contact.trim(),
        password,
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the password.");
      setBusy(false);
    }
  }

  const title = siteName.trim() || "This server";

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center px-5 py-12">
      <div className="fixed right-4 top-4">
        <EffectsToggle />
      </div>
      <div className="card w-full max-w-[400px] p-6 sm:p-7">
        <div className="mb-6 text-center">
          <div className="text-[15px] tracking-[0.02em] font-semibold">{title}</div>
          <p className="mt-1 text-[13px] leading-relaxed" style={{ color: "var(--ink-3)" }}>
            First run - name this instance and choose the owner account. The password is stored only
            as a hash, in <span className="mono">data/settings.json</span>.
          </p>
        </div>

        <form onSubmit={submit} className="space-y-3">
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
              Shown in the header and on a home-screen shortcut.
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
              Shown on the public <span className="mono">/contact</span> page. You can add it later;
              leave it empty to show no address.
            </span>
          </label>

          <label className="block">
            <span className="chip">Owner username</span>
            <input
              autoFocus
              className="field mt-1.5"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin"
              maxLength={32}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              disabled={busy}
            />
          </label>

          <label className="block">
            <span className="chip">Password</span>
            <input
              className="field mt-1.5"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="New password"
              autoComplete="new-password"
              disabled={busy}
            />
          </label>
          <PasswordMeter value={password} />

          <label className="block">
            <span className="chip">Repeat password</span>
            <input
              className="field mt-1.5"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Repeat password"
              autoComplete="new-password"
              disabled={busy}
            />
          </label>

          <button className="btn btn-primary w-full" disabled={busy || !password || !confirm}>
            {busy ? "Saving…" : "Save and sign in"}
            {!busy && <ArrowIcon />}
          </button>
        </form>

        {error && (
          <p className="mt-3 text-[13px] text-center" role="alert" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        )}

        <p className="mt-5 text-center text-[11.5px] leading-relaxed" style={{ color: "var(--ink-3)" }}>
          Name, contact and password can be changed later at <span className="mono">/admin</span>.
          Guests can keep downloading without signing in.
        </p>
      </div>
    </div>
  );
}
