# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 3.1.x | Yes |
| Older | No |

Security fixes land on the latest release line. If you run an older tag, upgrade
before reporting.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting for this
repository: *Security* tab → *Report a vulnerability*. That opens a draft
advisory only the maintainers can see.

Please include:

- What the attacker can do, and what they need first (a guest session, a link,
  local access).
- The version, and whether you ran the script, `npm start`, or the container.
- Steps to reproduce, with a minimal request or command sequence.
- Anything you already tried.

You can expect an acknowledgement within a few days and a fix or a mitigation
plan in the advisory. Credit is given in the release notes unless you ask
otherwise.

## What counts as a vulnerability

- Bypassing the owner password, two-factor step, or a guest quota/limit.
- Reading or writing files outside the configured music library, `data/` or a
  job's workspace - for example through `/api/covers/:file`, a cover upload, or
  a crafted download URL.
- Leaking stored cookies, the password hash, TOTP secrets or another guest's
  session.
- Command injection through a URL, a tag field, a webhook target, or a job
  argument.
- A guest reaching owner-only endpoints (`/api/settings`, `/admin`, the library
  scan and prune routes, the diagnostics).

Bug reports that need an already-compromised host, a malicious `yt-dlp`
release, or physical access are usually out of scope, but say so and it will be
considered.

## Hardening an instance

- Set a strong owner password at `/setup` or through `AUDIODL_PASSWORD`; never
  leave an instance on the setup screen on a public address.
- Put the app behind TLS if it is reachable from the internet. The session
  cookie is `HttpOnly` but the app does not terminate TLS itself.
- Set `AUDIODL_GUEST=0` if downloads should be owner-only.
- Treat `data/` as secret: it holds the password hash, TOTP secret, the cookie
  jar for signed-in sources, the queue and guest preferences. It is ignored by
  git and must not be baked into an image.
- Keep the image up to date; `yt-dlp` is updated from the admin page or at
  container start.
