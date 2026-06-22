# KoolBot Web UI

The Web UI is the **only** admin surface for KoolBot from v1.0 onward.
Everything that used to live behind `/config set`, `/permissions`, `/setup`,
`/announce`, `/poll`, `/reactrole`, `/notice`, `/dbtrunk`, `/vc`, and
`/botstats` is now reached by running a single Discord slash command,
`/config`, which DMs you a one-time sign-in link.

Since #481 the same `/config` flow also opens a **user self-service
surface** at `/me/*` — non-admin guild members can manage their own
preferences (notifications, Rewind, etc.) without ever touching the
admin panel, while admins can hop between the two surfaces using a
single redeemed session.

This document explains how to enable it, expose it, and operate it.

---

## 📋 Table of Contents

- [TL;DR](#tldr)
- [Two surfaces: `/admin` and `/me`](#two-surfaces-admin-and-me)
- [How the magic-link flow works](#how-the-magic-link-flow-works)
- [Configuration boundary: env vs. database](#configuration-boundary-env-vs-database)
- [Bootstrap environment variables](#bootstrap-environment-variables)
- [Enabling the Web UI](#enabling-the-web-ui)
- [Docker Compose recipes](#docker-compose-recipes)
- [Reverse-proxy guidance](#reverse-proxy-guidance)
- [Public-internet exposure](#public-internet-exposure)
- [DM-closed fallback](#dm-closed-fallback)
- [Session lifecycle and revocation](#session-lifecycle-and-revocation)
- [Prometheus / OpenMetrics endpoint](#prometheus--openmetrics-endpoint)
- [What the Web UI lets you do](#what-the-web-ui-lets-you-do)
- [Troubleshooting](#troubleshooting)

---

## TL;DR

1. Set `WEBUI_ENABLED=true` plus the four other `WEBUI_*` bootstrap env vars
   in `.env` (see [Bootstrap environment variables](#bootstrap-environment-variables)).
2. Publish or reverse-proxy port `3000` so the URL in `WEBUI_BASE_URL`
   actually reaches the container.
3. Restart the bot.
4. In Discord, run `/config`. The bot DMs you a single-use link.
5. Click the link, configure the bot, click **Finish** when you're done.

The Web UI mounts on the **same Express server** that already serves
`/health` (port `3000` inside the container) — no new container, no new
port to learn. It is dark unless `WEBUI_ENABLED=true`.

---

## Two surfaces: `/admin` and `/me`

The Web UI ships two parallel surfaces on the same Express server, both
gated by the same magic-link flow:

| Surface | Mount     | Who can reach it           | What it's for                                            |
| ------- | --------- | -------------------------- | -------------------------------------------------------- |
| Admin   | `/admin/` | sessions with `role:admin` | Server-wide config — Settings, Permissions, Wizard, etc. |
| Self    | `/me/`    | both `admin` and `user`    | The signed-in **user's own** preferences and Rewind      |

What changes per session:

- **Non-admin guild member runs `/config`.** They get a session with
  `role:user`, the DM points at `/me/`, and `/admin/*` returns 403
  (the page tells them to head to `/me`).
- **Administrator runs `/config`.** They get a session with `role:admin`.
  The DM mentions both entry points. They land on `/admin/` by default,
  but every admin page header carries a "My preferences" link that takes
  them to `/me/` without re-running `/config`. The `/me/*` layout in turn
  carries a "Back to admin panel" link.
- **A `/me/*` handler can only read/write the signed-in user's own rows.**
  This is enforced by the `assertSelfScope` helper (see
  `src/web/user-routes.ts`) and applies to admin-role sessions too — an
  admin on `/me/notifications` sees *their* prefs, not the guild's. Admins
  who need to act on another user's data do so via the admin panel's
  audit/user tooling, not by impersonating them on `/me/*`.

> **v1 is foundations only.** Today `/me/` is a stub index page that
> announces the surface; the per-user features (notifications, Rewind,
> achievements, etc.) land in the dependent sub-issues of #480. The
> session model, layout, and self-scope helper are all in place so those
> issues can bolt on without touching auth, routing, or layout.

The role is decided **server-side** at `/config` time from the invoker's
live guild permissions (`Administrator` bit → `admin`, anything else →
`user`) and baked into the redeemed session row + signed cookie. The
slash-command itself is not gated by `default_member_permissions` —
that would hide the command from non-admins entirely, defeating the
user surface.

Audit-log rows produced through the Web UI now record the role the
session was acting under, so the admin audit page can filter by `admin`
vs. `user` writes. An admin acting on their own `/me/*` is logged with
`role: "admin"` (the role is the session's, not the URL surface's).

---

## How the magic-link flow works

```text
┌──────────┐                ┌──────────┐               ┌──────────┐
│  Admin   │ /config        │  KoolBot │ create        │ MongoDB  │
│ (Discord)│ ─────────────► │ (bot)    │ ────────────► │ (session)│
└──────────┘                └──────────┘               └──────────┘
                                 │
                                 │ DM single-use URL
                                 ▼
                            ┌──────────┐
                            │   Admin  │
                            │ (DM)     │
                            └──────────┘
                                 │
                                 │ open link in browser
                                 ▼
                            ┌──────────────────┐
                            │ GET /admin/s/    │
                            │ - validate token │
                            │ - mark used      │
                            │ - issue cookie   │
                            │ - 302 → /admin/  │
                            │   (role=admin)   │
                            │   or /me/        │
                            │   (role=user)    │
                            └──────────────────┘
                                 │
                                 │ authenticated by signed cookie
                                 ▼
                            ┌──────────────────┐
                            │ /admin/* (admin) │
                            │ /me/*   (either) │
                            │ permissions re-  │
                            │ checked each req │
                            └──────────────────┘
                                 │
                                 ├─ click "Finish" or re-run /config
                                 │  → session revoked server-side,
                                 │    cookie cleared, /admin/* → 401
                                 │
                                 └─ idle past the inactivity window,
                                    or reach the hard expiresAt
                                    → cookie rejected on the next request;
                                      the DB row stays until TTL or
                                      explicit revoke
```

Key properties:

- **Single-use.** Each link is bound to one Discord user ID and one token
  hash. Redeeming it marks `usedAt` server-side. A second click 404s.
- **Short TTL.** Default `WEBUI_SESSION_TTL_MINUTES=10`. Tokens expire
  whether or not they're used.
- **Sliding inactivity.** Once redeemed, the cookie has a sliding
  inactivity window (default `WEBUI_INACTIVITY_TIMEOUT_MINUTES=30`)
  hard-capped at the session's server-side `expiresAt`. On redemption
  that hard cap is bumped to `now + WEBUI_SESSION_LIFETIME_HOURS`
  (default 24h) so an active operator isn't kicked out at the much
  shorter link TTL.
- **Re-issuing kills the prior session.** Running `/config` again revokes
  all of *your* unrevoked sessions and mints a new one. Other admins'
  sessions are untouched.
- **Permissions re-checked every request.** The cookie-session middleware
  re-runs `PermissionsService.checkCommandPermission(uid, gid, "config")`
  on every hit. That check returns `false` (and the middleware logs the
  user out) when the user has lost Administrator **and** the bot's
  Permissions page has explicit role gating configured for `config` that
  no longer matches the user's roles. With no explicit gating configured,
  a re-check after demotion still passes — the magic-link gate at
  `/admin/s/<token>` is the primary defense, not this revalidation.
- **No persistent OAuth.** The bot is the trust anchor. If you can run
  `/config` in Discord, you can configure the bot — no separate login.

---

## Configuration boundary: env vs. database

KoolBot has a hard rule: **bootstrap settings live in `.env`, everything
else lives in MongoDB and is edited via the Web UI.**

| Setting tier         | Where it lives | How it's edited                                  | Picked up                  |
| -------------------- | -------------- | ------------------------------------------------ | -------------------------- |
| Bootstrap / secrets  | `.env`         | Edit the file on the host                        | Bot restart                |
| Feature config       | MongoDB        | Web UI **Settings**, **Permissions**, etc.       | Saved immediately (note ↓) |
| Discord command list | MongoDB        | Web UI Settings → **Reload commands to Discord** | Click the button           |

> ↓ Plain feature toggles take effect on the next read. Cron-scheduled
> services (announcements, polls, cleanup) and channel managers cache
> derived state and need a manual reload via their per-page button to
> fully apply.

The Web UI's **Bootstrap** page surfaces every `.env` value the bot
reads (see `BOOTSTRAP_VARS` in `src/web/read-only-routes.ts`),
read-only, with secrets masked (last 4 characters only). You can verify
what the process saw at startup, but you cannot change it from the
browser.

YAML import/export covers the MongoDB tier only. Imports apply
**per-key**: the protected-keys list (`PROTECTED_KEYS` in
`src/web/write-routes.ts`) flags any row that targets a bootstrap key
as `rejected: protected key`, but other valid rows in the same file
still apply. The result page shows per-key outcomes plus a top-level
`ok` / `partial` / `failed` status — a mixed YAML produces a partial
import, not an atomic failure.

---

## Bootstrap environment variables

These are read at startup and never edited from the Web UI. Change them
by editing `.env` and restarting the container.

### Required for the bot itself

| Variable        | Required | Example                                  |
| --------------- | -------- | ---------------------------------------- |
| `DISCORD_TOKEN` | yes      | `MTIzNDU2Nzg5MDEy...`                    |
| `CLIENT_ID`     | yes      | `1234567890123456789`                    |
| `GUILD_ID`      | yes      | `9876543210987654321`                    |
| `MONGODB_URI`   | yes      | `mongodb://mongodb:27017/koolbot`        |
| `NODE_ENV`      | no       | `production` (default) / `development`   |
| `DEBUG`         | no       | `false` (default) / `true`               |

### Required when the Web UI is enabled

| Variable                            | Required          | Default | Notes                                                                                            |
| ----------------------------------- | ----------------- | ------- | ------------------------------------------------------------------------------------------------ |
| `WEBUI_ENABLED`                     | yes (to turn on)  | `false` | `true` mounts `/admin/*`; anything else leaves it 404.                                           |
| `WEBUI_BASE_URL`                    | yes when enabled  | —       | Public URL the DM'd link points at, e.g. `https://bot.example.com`. No trailing slash needed.    |
| `WEBUI_SESSION_SECRET`              | yes when enabled  | —       | HMAC key for token hashes and signed cookies. Use 32+ random bytes (`openssl rand -base64 32`).  |
| `WEBUI_SESSION_TTL_MINUTES`         | no                | `10`    | TTL of the DM'd link from issuance.                                                              |
| `WEBUI_SESSION_LIFETIME_HOURS`      | no                | `24`    | Hard cap on a redeemed session, measured from redemption. Bounds the sliding inactivity window.  |
| `WEBUI_INACTIVITY_TIMEOUT_MINUTES`  | no                | `30`    | Sliding cookie window after redemption.                                                          |
| `WEBUI_TRUST_PROXY`                 | no                | (off)   | Set to a hop count (e.g. `1`) when running behind a reverse proxy that sets `X-Forwarded-*`.     |

> ⚠️ **Treat `WEBUI_SESSION_SECRET` like `DISCORD_TOKEN`.** Anyone who
> can read it can forge sign-in cookies. Rotating it invalidates every
> existing session and outstanding magic link.

Generate a strong secret:

```bash
openssl rand -base64 32
```

### Prometheus metrics (optional)

These two vars are independent of the Web UI — the `/metrics` endpoint is
served on the same port (3000) as `/health` whether or not the Web UI is
enabled. See [Prometheus / OpenMetrics endpoint](#prometheus--openmetrics-endpoint)
below for the full rundown.

| Variable          | Required | Default | Notes                                                                 |
| ----------------- | -------- | ------- | --------------------------------------------------------------------- |
| `METRICS_ENABLED` | no       | `false` | `true` mounts `/metrics`; anything else leaves it 404.                |
| `METRICS_TOKEN`   | no       | (empty) | When set, requests must send `Authorization: Bearer <token>` or 401.  |

---

## Enabling the Web UI

### 1. Set the env vars

Append to `.env`:

```env
WEBUI_ENABLED=true
WEBUI_BASE_URL=https://bot.example.com
WEBUI_SESSION_SECRET=replace-with-openssl-rand-base64-32-output
# Optional tuning
WEBUI_SESSION_TTL_MINUTES=10
WEBUI_SESSION_LIFETIME_HOURS=24
WEBUI_INACTIVITY_TIMEOUT_MINUTES=30
```

If you don't have a real domain yet and just want to try it locally:

```env
WEBUI_ENABLED=true
WEBUI_BASE_URL=http://localhost:3000
WEBUI_SESSION_SECRET=replace-with-openssl-rand-base64-32-output
```

### 2. Make port 3000 reachable

Pick **one** of:

- **Publish the port directly** (simplest, but no HTTPS — this is what
  the shipped compose does). See the
  [Direct port publish (the shipped default)](#direct-port-publish-the-shipped-default)
  recipe below.
- **Reverse-proxy it** (recommended for any deployment users will visit
  from a real browser). See [Reverse-proxy guidance](#reverse-proxy-guidance).
- **Tunnel it** (Tailscale, WireGuard, Cloudflare Tunnel, etc.). Same
  config as the reverse-proxy case — set `WEBUI_BASE_URL` to the URL
  your tunnel exposes.

### 3. Restart and verify

```bash
docker compose up -d --force-recreate
docker compose logs -f bot | grep -i webui
```

Look for:

```text
WebUI mounted at /admin
```

If you see `WEBUI_ENABLED=true but missing required env vars: ...`, the
bot started without the Web UI mounted — fix the env vars and restart.

### 4. Run `/config`

Run `/config` in Discord. The bot replies ephemerally:

> ✅ I've DMed you a single-use sign-in link. Check your direct messages.

Open the DM, click the link, and you're in.

---

## Docker Compose recipes

The production `docker-compose.yml` shipped in the repo **publishes
port 3000 by default** so the quick-start magic link is reachable on
`http://your-host:3000` out of the box. That's the right default for a
local or LAN install but it has no HTTPS — for anything reachable from
the public internet, swap the direct publish for a reverse proxy. The
recipes below are starting points; pick one and drop it into your own
`docker-compose.yml`.

### Direct port publish (the shipped default)

The simplest setup, and what the repo's `docker-compose.yml` does
already. The bot listens on port `3000`; you map it to the host.

```yaml
services:
  bot:
    image: ghcr.io/lonix/koolbot:latest
    container_name: koolbot
    restart: unless-stopped
    env_file: .env
    depends_on:
      - mongodb
    stop_grace_period: 30s
    stop_signal: SIGTERM
    ports:
      - "3000:3000"   # /health and /admin (when WEBUI_ENABLED=true)

  mongodb:
    image: mongo:latest
    container_name: koolbot-mongodb
    restart: unless-stopped
    volumes:
      - mongodb_data:/data/db
    # Intentionally no `ports:` — the bot reaches MongoDB over the
    # internal Docker network. The default mongo image has NO auth, so
    # do not publish 27017 to a public interface. If you need host
    # access for mongosh, bind explicitly to loopback:
    #   ports:
    #     - "127.0.0.1:27017:27017"
    stop_grace_period: 30s
    stop_signal: SIGTERM

volumes:
  mongodb_data:
```

With this, `WEBUI_BASE_URL=http://your-host:3000`.

⚠️ **No HTTPS — read this before using this recipe in production.**

The Web UI sets the session cookie's `Secure` flag whenever
`NODE_ENV=production` (see `shouldUseSecureCookies()` in
`src/web/csrf.ts`). Browsers refuse to send `Secure` cookies over plain
HTTP, so a production-mode bot reached at `http://your-host:3000`
**will not maintain a session** — every page click logs you back out.

Pick one:

- Set `NODE_ENV=development` while you accept plain HTTP (the cookie
  drops the `Secure` flag), **or**
- Put a reverse proxy in front of the bot and terminate TLS there
  (recommended — see [Caddy reverse proxy](#caddy-reverse-proxy-recommended)
  below).

Either way, plain HTTP exposes the magic-link bearer token in transit
and the session cookie in subsequent requests. Don't run plain HTTP on
the public internet.

### Bind to localhost only

If you only want to reach the Web UI from the host machine (and SSH-tunnel
or VPN in), bind to the loopback:

```yaml
services:
  bot:
    # ...other fields...
    ports:
      - "127.0.0.1:3000:3000"
```

`WEBUI_BASE_URL=http://localhost:3000`, then open it locally or via
`ssh -L 3000:localhost:3000 host`.

### Caddy reverse proxy (recommended)

Caddy gives you HTTPS with a one-line config and a public-domain DNS
record. The bot stays on a private Docker network and is not directly
exposed.

```yaml
services:
  bot:
    image: ghcr.io/lonix/koolbot:latest
    container_name: koolbot
    restart: unless-stopped
    env_file: .env
    depends_on:
      - mongodb
    stop_grace_period: 30s
    stop_signal: SIGTERM
    networks:
      - koolbot-net
    # No `ports:` — Caddy is the only public surface.

  mongodb:
    image: mongo:latest
    container_name: koolbot-mongodb
    restart: unless-stopped
    volumes:
      - mongodb_data:/data/db
    stop_grace_period: 30s
    stop_signal: SIGTERM
    networks:
      - koolbot-net

  caddy:
    image: caddy:2-alpine
    container_name: koolbot-caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    networks:
      - koolbot-net
    depends_on:
      - bot

volumes:
  mongodb_data:
  caddy_data:
  caddy_config:

networks:
  koolbot-net:
    driver: bridge
```

`Caddyfile`:

```text
bot.example.com {
    encode zstd gzip
    reverse_proxy bot:3000
}
```

In `.env`:

```env
WEBUI_ENABLED=true
WEBUI_BASE_URL=https://bot.example.com
WEBUI_SESSION_SECRET=...
WEBUI_TRUST_PROXY=1
```

Caddy provisions the TLS certificate automatically via Let's Encrypt and
forwards `X-Forwarded-For` to the bot. `WEBUI_TRUST_PROXY=1` tells the
bot's rate limiter to trust exactly one hop (Caddy) when reading client
IPs.

⚠️ **Trust-proxy is a footgun if the bot is *also* directly reachable.**
By default the bot ignores `X-Forwarded-*` headers, so a direct client
cannot spoof its IP. Setting `WEBUI_TRUST_PROXY=1` flips that: any
request reaching the bot — including a direct one that bypasses Caddy
— can now set `X-Forwarded-For` to anything it wants. **Block direct
access to `bot:3000` from outside the Docker network** (the recipe
above does this by not declaring a `ports:` on the bot service) before
trusting forwarded headers.

> **We do not bundle Caddy.** The recipe above is the easy path; your
> existing nginx, Traefik, or HAProxy works equally well as long as it
> terminates TLS and forwards `Host` and `X-Forwarded-*` faithfully.

### Tailscale / Cloudflare Tunnel

Set `WEBUI_BASE_URL` to whatever URL your tunnel hands out and *don't*
publish port `3000` to the public internet. The bot only needs to be
reachable from the tunnel sidecar's network namespace.

---

## Reverse-proxy guidance

The Web UI is a plain HTTP server. Any reverse proxy works. The
requirements are:

1. **Terminate TLS at the proxy.** The bot itself does not speak HTTPS.
2. **Forward `Host`** so URL generation inside the app matches
   `WEBUI_BASE_URL`. Most proxies do this by default.
3. **Run the bot with `NODE_ENV=production`.** That's what flips the
   session cookie's `Secure` flag on (`shouldUseSecureCookies()` in
   `src/web/csrf.ts`). The bot does not look at `X-Forwarded-Proto` —
   the decision is `NODE_ENV`-only. You can still forward
   `X-Forwarded-Proto` for your own logging, it just doesn't affect
   cookie flagging.
4. **Set `WEBUI_TRUST_PROXY`** to the hop count of trusted proxies in
   front of the bot. `1` for "one Caddy/nginx", larger for chained
   setups. Without this, the bot ignores `X-Forwarded-*` headers
   entirely; with this, **make sure the bot is not also directly
   reachable** so attackers can't bypass the proxy and spoof
   `X-Forwarded-For` against the rate limiter.

The Caddy config above is intentionally minimal. nginx equivalent:

```nginx
server {
    listen 443 ssl http2;
    server_name bot.example.com;

    ssl_certificate     /etc/letsencrypt/live/bot.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bot.example.com/privkey.pem;

    location / {
        proxy_pass         http://bot:3000;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

Traefik (compose labels):

```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.koolbot.rule=Host(`bot.example.com`)"
  - "traefik.http.routers.koolbot.entrypoints=websecure"
  - "traefik.http.routers.koolbot.tls.certresolver=letsencrypt"
  - "traefik.http.services.koolbot.loadbalancer.server.port=3000"
```

---

## Public-internet exposure

Because every `/admin/*` route returns 401 (or 404 for the redemption
endpoint) without a valid token or cookie, **putting the Web UI on the
open internet is acceptable** — there is no login form to brute-force.

That said:

- **Always run behind HTTPS.** The session cookie is HMAC-signed but
  cleartext, and the magic link itself is a bearer token. TLS is
  non-negotiable on the public internet.
- **The health endpoints are unauthenticated.** The server exposes
  `/live` (liveness — always `OK` once the process is up), `/ready`
  (readiness — `OK` only when MongoDB and Discord are reachable, `503`
  otherwise), and `/health` (a backward-compatible alias of `/ready`).
  They are intentionally minimal, but `/ready`/`/health` *do* report
  whether MongoDB and Discord are reachable. Restrict them to your
  monitoring system if you'd rather not advertise that. Kubernetes
  deployments should use `/live` for the livenessProbe and `/ready` for
  the readinessProbe.
- **Mind the magic-link TTL.** A leaked link is useless after redemption
  or expiry, but if the admin who ran `/config` shares the URL before
  redeeming it, anyone with the URL becomes that admin until the TTL
  fires. The default 10-minute window is short enough that this rarely
  bites in practice.
- **`/admin/s/<token>` is rate-limited** to 10 attempts per minute per
  IP. Set `WEBUI_TRUST_PROXY` correctly so this rate-limiting actually
  applies per real client and not per proxy.
- **No analytics, no third-party assets.** Every page is rendered
  server-side from `src/web/` with inline CSS. There is no JS bundle to
  pin or CDN to allowlist.

---

## DM-closed fallback

If you've disabled DMs from server members, the bot can't deliver the
link via direct message. The current behavior:

1. `/config` first tries to DM you.
2. On failure, the bot falls back to **posting the link as the ephemeral
   reply to the slash command itself** — visible only to you, not to
   other users in the channel.
3. The reply text is identical to the DM body.

This means an admin with DMs closed can still configure the bot — they
just see the link inline in Discord instead of in their DM tab. Re-enable
DMs at any time to switch back to the cleaner experience.

You'll see this warning in the logs whenever the fallback fires:

```text
Could not DM web sign-in link to <user-id>; falling back to ephemeral reply
```

---

## Session lifecycle and revocation

| Trigger                            | Effect                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------- |
| Run `/config`                      | Revokes all your prior unrevoked sessions server-side; mints new                        |
| Click DM link                      | Marks token `usedAt`; sets signed session cookie                                        |
| Idle longer than inactivity window | Cookie is rejected on the next request; the DB row remains until TTL or explicit revoke |
| Reach session's hard `expiresAt`   | Cookie is rejected on the next request; the DB row is past its TTL                      |
| Click **Finish** in the UI         | Session revoked server-side; cookie cleared                                             |
| Admin role removed in Discord      | Next request re-runs the permission check — caveat ↓                                    |
| Bot restart                        | Sessions survive (stored in MongoDB)                                                    |
| `WEBUI_SESSION_SECRET` rotated     | All existing sessions and outstanding tokens invalid                                    |

> **Caveat on the "admin role removed" row.** The permission re-check
> only returns `false` when there's explicit role gating configured for
> `config` on the Web UI's Permissions page that no longer matches the
> user's roles. With no explicit gating, the check returns `true` and
> the session continues. If you want demotions to log existing sessions
> out, configure Permissions → `config` to an admin-only role, then
> the role removal will kick the session on the next request.

Two admins can be in the Web UI at the same time. Re-running `/config`
only invalidates **your own** sessions.

To hard-revoke every session right now without restarting:

```bash
# Drop just the active sessions; existing rows have revokedAt set.
docker compose exec mongodb mongosh koolbot --eval '
  db.websessions.updateMany(
    { revokedAt: null },
    { $set: { revokedAt: new Date() } }
  )
'
```

Or rotate `WEBUI_SESSION_SECRET` in `.env` and restart — that
invalidates every signed cookie and every outstanding magic link as a
side effect, since the HMAC key changes.

---

## Prometheus / OpenMetrics endpoint

KoolBot can expose a pull-based `/metrics` endpoint for Prometheus (or any
OpenMetrics-compatible collector). It lives on the same Express server as
`/health` — port 3000 — so no new process, container, or port is needed.

It is **opt-in and disabled by default**:

```env
# Turn it on
METRICS_ENABLED=true

# Optional: require a bearer token on every scrape. Leave blank to rely
# on network-level ACLs instead (e.g. only your Prometheus host can reach
# port 3000).
METRICS_TOKEN=replace-with-a-long-random-string
```

- When `METRICS_ENABLED` is anything other than `true`, the route is never
  registered and `/metrics` returns **404**.
- When `METRICS_TOKEN` is set, a scrape without a matching
  `Authorization: Bearer <token>` header receives **401**. The comparison
  is constant-time.

Verify it locally:

```bash
# Without a token
curl -s http://localhost:3000/metrics | head

# With a token
curl -s -H "Authorization: Bearer $METRICS_TOKEN" http://localhost:3000/metrics | head
```

A matching Prometheus scrape config:

```yaml
scrape_configs:
  - job_name: koolbot
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials: "replace-with-METRICS_TOKEN" # omit when no token is set
    static_configs:
      - targets: ["koolbot:3000"]
```

### Exposed metrics

| Metric                              | Type    | Description                                                            |
| ----------------------------------- | ------- | ---------------------------------------------------------------------- |
| `koolbot_command_invocations_total` | Counter | Slash commands run, labelled by `command` and `status` (`ok`/`error`). |
| `koolbot_discord_events_total`      | Counter | Discord gateway events received, labelled by `event`.                  |
| `koolbot_voice_sessions_active`     | Gauge   | Current number of active managed voice channels.                       |
| `koolbot_up`                        | Gauge   | `1` while connected to Discord, `0` after a disconnect or shutdown.    |
| `process_*` / `nodejs_*`            | various | Node.js process metrics provided automatically by `prom-client`.       |

### Suggested Grafana panels

No dashboard JSON ships with the bot — wire these up to taste:

- **Commands per minute** — `rate(koolbot_command_invocations_total[5m])`.
- **Command error rate** — `sum(rate(koolbot_command_invocations_total{status="error"}[5m])) / sum(rate(koolbot_command_invocations_total[5m]))`.
- **Active voice sessions** — Gauge panel on `koolbot_voice_sessions_active`.
- **Connectivity** — Stat/State-timeline panel on `koolbot_up` (alert when `koolbot_up == 0`).
- **Event throughput** — `sum by (event) (rate(koolbot_discord_events_total[5m]))`.
- **Memory usage** — `process_resident_memory_bytes`.

> ⚠️ **Don't expose `/metrics` to the public internet unprotected.** Set
> `METRICS_TOKEN`, restrict port 3000 to your monitoring host, or both. The
> same reverse-proxy guidance that applies to `/admin` applies here.

---

## What the Web UI lets you do

### Admin panel (`/admin/*`, admin-role sessions only)

| Page               | Replaces                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| **Dashboard**      | `/botstats`                                                                                         |
| **Settings**       | `/config list`, `get`, `set`, `reset`, `reset-all` (Danger zone), `import`, `export`, `reload`      |
| **Permissions**    | `/permissions set`, `add`, `remove`, `clear`, `list`, `view`                                        |
| **Setup Wizard**   | `/setup wizard`                                                                                     |
| **Announcements**  | `/announce create`, `list`, `delete`                                                                |
| **Polls**          | `/poll create`, `list`, `add-item`, `delete`, `delete-item`, `test`, `list-items`                   |
| **Reaction Roles** | `/reactrole create`, `archive`, `unarchive`, `delete`, `list`, `status`                             |
| **Notices**        | `/notice add`, `edit`, `delete`, `sync`                                                             |
| **Bot Status**     | (new — edit the "Watching …" presence message pools)                                                |
| **Voice Channels** | `/vc force-reload` (single **Force VC cleanup** button)                                             |
| **Database**       | `/dbtrunk status`, `/dbtrunk run`                                                                   |
| **Command Audit**  | (new — read-only Discord slash-command audit log)                                                   |
| **Command Metrics**| (new — historical per-command usage / error-rate / latency dashboard)                               |
| **Bootstrap**      | (new — read-only env diagnostics)                                                                   |

Feature pages (Announcements, Polls, Reaction Roles, Notices, Voice
Channels) are gated by their `<feature>.enabled` config key. When a
feature is **off**, its sidebar link is still shown — greyed with an
"off" badge — rather than hidden, so the page stays discoverable (#610);
hiding it created a chicken-and-egg where the natural place to enable a
feature was the very page you couldn't reach. Opening a disabled feature's
page renders a banner explaining the state with an inline **Enable** button
(flips the flag via `/admin/settings/set` and returns you to the page) plus
an **Open Settings** link.

The **Bot Status** page (`/admin/bot-status`) edits the three "Watching …"
presence message pools the bot rotates through, picked by how many users
are in voice: the *empty*, *one user*, and *multiple users* pools. Each
pool has an add / edit / remove / reorder list plus a paste-a-list
import/export box (newline- or JSON-encoded), built on a reusable
string-array editor. Entries are stored per-guild in MongoDB and take
effect immediately — no redeploy or `/config reload` needed. A pool with
no stored rows falls back to the built-in defaults in
`src/content/statuses.ts`, so behaviour is unchanged on a fresh install;
use **Seed defaults into store** to start editing from those defaults.
Entries in the *multiple users* pool must contain the `{count}`
placeholder (replaced with the live user count); the editor rejects saves
that omit it.

The **Command Metrics** page (`/admin/metrics`) is a read-only analytics
dashboard for slash-command usage over a trailing window (7- or 30-day
toggle). `MonitoringService` accumulates per-command counters in memory and
flushes them in batches to MongoDB as daily `{command, date, guildId}`
buckets, so the data survives restarts (unlike the live in-memory view) and
is pruned automatically by a TTL index. The page shows commands by usage,
an error spotlight (commands at or above a 10% error rate), the slowest
commands by average response time, and a per-day usage trend. The 7d/30d
toggle only selects the view window over already-persisted data; it is not a
config key. Persistence is governed by `monitoring.metrics_persistence.enabled`
(default on), while `monitoring.metrics_retention_days` (default 30) controls
how long buckets are kept before the TTL index prunes them. This is
complementary to the Prometheus `/metrics` endpoint, which exposes
process-level gauges (uptime, memory) rather than historical per-command
counters.

### User self-service (`/me/*`, both admin and user roles)

| Page                                    | What it's for                                                                                                                                              |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Overview** (`/me/`)                   | Index for your own settings — links to the available per-user pages.                                                                                       |
| **Notifications** (`/me/notifications`) | Opt in or out of DM nudges from Koolbot (achievements, weekly digest, Rewind nudge). Each toggle records a `WebAuditLog` row.                              |
| **Voice** (`/me/voice`)                 | Manage your channel name pattern and saved voice-channel presets (rename, edit, set-default, delete). Gated by `voicechannels.presets.enabled`.            |
| **Rewind** (`/me/rewind`)               | Personal year-in-review: voice time, top voice companions, peak day, longest session, streak, badges, annual rank, weekly-rank journey, and text activity. |

Notification preferences are scoped per `(userId, guildId)`. The page
lists every notification type with the current state and a checkbox;
toggling one row is a single POST that records the diff in the audit
log and PRG-redirects back to the page.

The whole feature is gated by `rewind.enabled` (`#608`). When it is off
the route returns a 404 "feature disabled" state and the nav link is
suppressed on every `/me/*` page; the end-of-year DM nudge is a separate
toggle (`rewind.nudge.enabled`).

The **Voice** page (`/me/voice`, `#656`) lets a member manage the
per-user voice preferences that back the Discord control panel's
**Presets** button. It exposes two things: a **channel name pattern**
(applied to every channel you spawn from the lobby — use `{username}` as a
placeholder for your display name; leave blank for the server default
naming) and your **saved presets**. Presets themselves are still *created*
in Discord by snapshotting a live channel (control panel → Presets → Save
current as preset); the web page lets you **edit** a preset's name, channel
name, user limit, and bitrate, **set-default** (the default auto-applies on
your next lobby spawn), and **delete**. Every write goes through the same
`UserVoicePrefsService` validation as the Discord modal — so the
max-per-user cap, name/limit/bitrate bounds, and name-pattern length are
identical on both surfaces — and records a `WebAuditLog` row
(`user.voice.namepattern.set`, `user.voice.preset.edit|default|delete`).
The whole page is gated by `voicechannels.presets.enabled`: when off it
returns a 404 "feature disabled" state and its nav link is suppressed.

The bare **Rewind** page (`/me/rewind`) lands on the most recent year you
actually have data for, so visiting right after the year rolls over shows
a finished recap rather than the empty new year (`#573`); a brand-new user
with no activity anywhere still sees the current year's empty state.
`/me/rewind/:year` is an exact deep link — it always renders the requested
year, including the empty state for a year with no data. A small year
picker at the top of the page only offers years for which you have data
(voice sessions, text-message activity, or badges), plus any year that has
been snapshotted (see below), and highlights the year actually shown.
Years with no data render a friendly empty state.
Aggregation is on-demand and not cached in v1 — see [`SETTINGS.md`](SETTINGS.md#-rewind-year-in-review)
for the `rewind.*` keys that gate the feature and the end-of-year DM nudge.

The in-progress current year is always computed live from raw activity.
**Completed years are served from an immutable snapshot** (`#574`): the
end-of-year nudge cron (default Dec 30) runs while the current year is
wrapping up, and alongside the nudge `RewindNudgeService` writes one
`RewindSnapshot` per qualifying user for that year. The page keeps
computing the year live until it rolls over; from the next year onward,
that frozen copy is served verbatim — unaffected by the voice-session /
message-detail truncation that later prunes the source data. Because the
snapshot is taken on the cron's December run, activity in the final day
or two of the year isn't captured. Snapshot creation is idempotent
(re-running the cron never duplicates or mutates an existing record) and
runs as part of the nudge cron, so it follows `rewind.nudge.enabled`
(with the legacy `rewind.enabled` fallback). A `schemaVersion` is stored so the view can
render older snapshots even after the summary shape gains new fields.

User-facing commands (`/ping`, `/voicestats`, `/seen`, `/quote`,
`/achievements`, `/help`) are **not** affected and stay in
Discord exactly as before. The per-voice-channel control panel (rename,
privacy, invite, transfer, live, waiting room) also stays in Discord —
it's a member-facing feature, not an admin tool.

---

## Troubleshooting

### `/config` says "The web UI is disabled"

`WEBUI_ENABLED` is not `true` (case-insensitive). Update `.env` and
restart the bot.

### `/config` says "missing env vars: WEBUI_BASE_URL, WEBUI_SESSION_SECRET"

Exactly what it says. Set both in `.env` and restart.

### The DM link 404s when I click it

One of:

- It was already redeemed (single-use). Run `/config` again.
- It expired (default 10 minutes). Run `/config` again.
- You ran `/config` a second time and got a *newer* link, which revoked
  this one. Use the most recent DM.
- `WEBUI_SESSION_SECRET` changed between issuance and redemption.

### "Sign in required" on every page

Possible causes (in roughly decreasing likelihood):

- Your cookie expired (idle past `WEBUI_INACTIVITY_TIMEOUT_MINUTES`).
- The DB session row passed its hard cap (`WEBUI_SESSION_LIFETIME_HOURS`
  from redemption).
- You ran `/config` again and revoked this session server-side.
- Permission re-check failed: someone configured Web UI Permissions →
  `config` to restrict the command, and your roles no longer match.
- The bot was restarted with a new `WEBUI_SESSION_SECRET`, invalidating
  the cookie signature.

Run `/config` again to mint a fresh link.

The cookie is **not** bound to your client IP — switching networks does
not by itself end a session.

### The Web UI URL loads but won't accept my cookie

Browsers refuse `Secure`-flagged cookies over plain HTTP. The Web UI
flags its session cookie `Secure` whenever `NODE_ENV=production`
(see `shouldUseSecureCookies()` in `src/web/csrf.ts`). Pick one:

- Run behind HTTPS via a reverse proxy (recommended), **or**
- Set `NODE_ENV=development` in `.env` and restart, so the cookie is
  not flagged `Secure`. Only do this for local testing.

Changing only `WEBUI_BASE_URL` to `http://...` is **not** enough — the
URL scheme does not influence cookie flagging.

### Behind a proxy, rate limits trigger on the proxy's IP

Set `WEBUI_TRUST_PROXY` to your hop count (usually `1`) and restart.
Without it, every request appears to come from the proxy and they all
share one rate-limit bucket.

### I want to disable the Web UI entirely

Set `WEBUI_ENABLED=false` (or remove the line) and restart. All
`/admin/*` paths 404 again. The `/health` endpoint is unaffected.

### I locked myself out

Edit `.env` on the host: set a fresh `WEBUI_SESSION_SECRET` and restart.
Then run `/config` in Discord with an account that has the
Administrator permission. The bootstrap path is "if you can run
`/config` in Discord, you can configure the bot" — there is no
forgotten-password flow because there is no password.

---

## 📚 Related documentation

- [README.md](README.md) — Quick start
- [SETTINGS.md](SETTINGS.md) — DB-backed setting catalog (what each
  Web UI form field actually does)
- [COMMANDS.md](COMMANDS.md) — User-facing slash commands
- [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md) — `src/web/` architecture
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — General troubleshooting

---

<div align="center">

**Questions?** [Open an issue](https://github.com/lonix/koolbot/issues)

</div>
