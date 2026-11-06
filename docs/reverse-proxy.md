# Running Crate behind a reverse proxy

Crate speaks plain HTTP and keeps its own session cookies. A proxy in front of it
adds TLS, a hostname and, if you want one, an extra layer of access control.

The short version:

- keep the app on loopback: `AUDIODL_HOST=127.0.0.1`
- terminate TLS at the proxy
- leave response buffering **off** so the queue's live events arrive
- give uploads room (cover art is the only upload, 8 MB at most)

## Caddy

Caddy obtains and renews certificates on its own.

```caddyfile
crate.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8099
}
```

`reverse_proxy` flushes immediately by default, so Server-Sent Events
(`/api/stream`) work without extra settings.

## nginx

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name crate.example.com;

    ssl_certificate     /etc/letsencrypt/live/crate.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/crate.example.com/privkey.pem;

    # Cover uploads are capped at 8 MB by the app; leave a little headroom.
    client_max_body_size 12m;

    location / {
        proxy_pass http://127.0.0.1:8099;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP         $remote_addr;

        # The queue is a live stream. Buffering it turns progress bars into a
        # slideshow, and a short read timeout drops idle connections.
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
        add_header X-Accel-Buffering no;
    }
}
```

Keep the proxy on the same host as the app. The server only trusts
`X-Forwarded-For` from loopback peers, so a proxy running in another container or
on another machine will not have its client addresses accepted.

## compose.yaml next to the proxy

```yaml
services:
  crate:
    image: ghcr.io/smoothcli/crate:latest
    ports:
      - "127.0.0.1:8099:8080"
    environment:
      AUDIODL_HOST: 0.0.0.0
      AUDIODL_PASSWORD: ${AUDIODL_PASSWORD}
      MUSIC_DIR: /media/music
    volumes:
      - /srv/music:/media/music
      - ./data:/app/data
```

Publishing on `127.0.0.1` means the port is reachable by the proxy and by
nothing else on the network.

## Checklist for a public instance

- **TLS everywhere.** Session cookies are `HttpOnly` and `SameSite=Lax`; without
  HTTPS they are readable on the wire.
- **A real password.** `/setup` enforces at least 10 characters; enable 2FA at
  `/admin#general` if the instance is on the open internet.
- **Decide about guests.** Guest downloads are streamed, never written to the
  library, but they are still traffic. Turn guest access off, or set a daily
  quota, at `/admin#guests`.
- **Keep uploads bounded.** The proxy limit above matches the app's own cap.
- **Monitor it.** `GET /api/health` answers without a session and returns
  `ok`, the version, uptime, queue depth and library writability — enough for
  uptime checks without exposing the library path.

```bash
curl -fsS https://crate.example.com/api/health
```

- **Back up `./data`.** It holds the password hash, remembered sessions, the
  saved queue and per-job workspaces. `/admin#system` can export the settings
  without the hash or the webhook URL.
