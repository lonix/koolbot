# KoolBot Web UI

KoolBot: Keeper Of Our Lore. Quotes, stats, history and logs, all yours.

The Web UI is the **only** admin surface for KoolBot. The old admin slash
commands (`/config set`, `/permissions`, `/setup`, `/announce`, `/poll`,
`/reactrole`, `/notice`, `/dbtrunk`, `/vc` and `/botstats`) were retired; their
jobs now live here. You reach the Web UI by running a single Discord slash
command, `/config` (Administrators only), which DMs you a one-time sign-in link.

A **user self-service surface** at `/me/*` lets guild members manage their
own preferences (notifications, timezone, birthday, voice presets, Rewind,
privacy) without ever touching the admin panel. Members reach it with `/me`;
admins can hop between the two surfaces from their `/config` session.

This document explains how to enable it, expose it, and operate it. How its pages look and are put
together is defined in [DESIGN.md](DESIGN.md).

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
- [Accessibility](#accessibility)
- [Troubleshooting](#troubleshooting)

---

## TL;DR

1. Set `WEBUI_ENABLED=true`, `WEBUI_BASE_URL` and `WEBUI_SESSION_SECRET` in
   `.env` (the other `WEBUI_*` variables are optional tuning; see
   [Bootstrap environment variables](#bootstrap-environment-variables)).
2. Publish or reverse-proxy port `3000` so the URL in `WEBUI_BASE_URL`
   actually reaches the container.
3. Restart the bot.
4. In Discord, run `/config` (Administrators only). The bot DMs you a single-use link.
5. Click the link, configure the bot, click **Finish** when you're done.

The Web UI mounts on the **same Express server** that already serves
`/health` (port `3000` inside the container) — no new container, no new
port to learn. It is dark unless `WEBUI_ENABLED=true`.

---

## Two surfaces: `/admin` and `/me`

The Web UI ships two parallel surfaces on the same Express server, both
gated by the same magic-link flow:

| Surface | Mount     | Who can reach it           | What it's for                                             |
| ------- | --------- | -------------------------- | --------------------------------------------------------- |
| Admin   | `/admin/` | sessions with `role:admin` | Server-wide config — Settings, Permissions, Wizard, etc.  |
| Self    | `/me/`    | both `admin` and `user`    | The signed-in **user's own** preferences, Rewind, privacy |

What changes per session:

- **Any guild member runs `/me`.** They get a session with
  `role:user` (even if they are an administrator, so a personal link never
  carries admin scope), the DM points at `/me/`, and `/admin/*` returns 403
  (the page tells them to head to `/me`). `/me` has no `me.enabled` key:
  it is registered when the Web UI is on and at least one `/me/*` surface
  is enabled (see `src/web/me-surfaces.ts`).
- **A non-admin runs `/config`.** `/config` is hidden from them in the
  command picker and, if reached anyway, replies pointing them to `/me`.
- **Administrator runs `/config`.** They get a session with `role:admin`.
  The DM mentions both entry points. They land on `/admin/` by default,
  but every admin page header carries a "My preferences" link that takes
  them to `/me/` without re-running `/config`. The `/me/*` top bar in turn
  carries an "Admin console" link (admins only).
- **A `/me/*` handler can only read/write the signed-in user's own rows.**
  This is enforced by the `assertSelfScope` helper (see
  `src/web/user-routes.ts`) and applies to admin-role sessions too — an
  admin on `/me/notifications` sees _their_ prefs, not the guild's. Admins
  who need to act on another user's data do so via the admin panel's
  audit/user tooling, not by impersonating them on `/me/*`.

**Scopes on `/me` (#1316).** A `user` session is `member` and may also be an **Event host** and/or a **Moderator**, depending on
the member's role groups. The scopes are resolved from the role groups **on every request** (the same live member lookup the
`me` re-check uses, so it adds no extra Discord call), never stored: the `scopes` column on the session row is not read. Removing
someone from the group removes the scope on their next request, within the same ~15 s window as the other live checks when the
Server Members intent is off.

| Scope      | Granted by (role group capability)                | Reaches                                          |
| ---------- | ------------------------------------------------- | ------------------------------------------------ |
| Member     | being allowed `/me` (Command permissions)         | `/me/*` self-service                             |
| Event host | `host` (shown **Event host**); `admin` implies it | `/me/events*`; still only events they created    |
| Moderator  | `staff` (shown **Moderator**); `admin` implies it | `/me/moderation*`: Mod log, cases, Command audit |

**The app shell (#1317).** Every signed-in page has the same top bar: the KoolBot name and version, then who you are (an
avatar initial and your server display name) with a badge for each scope above Member (**Event host**, **Moderator**, **Admin**),
the session timer, and **Sign out** (**Finish** in the admin console). An admin on `/me` also gets an **Admin console** link;
the console links back to **My preferences**. The display name comes from the member the session check already fetched
(the client cache), so the bar adds no Discord call; if it is not cached the bar says "Signed in".

On `/me` the sidebar has one section per scope, headed by the scope's icon and name: **You** (My preferences), **Hosting**
(Your events, New event and Event presets) and **Moderation** (Mod log and Command audit; Tickets once
it has a page and is on). A section appears when the person holds the scope and it has at least one page that exists. A
person with one section has **no sidebar**: My preferences keeps its tabs in one centred column. So a Moderator sees You
and Moderation with a sidebar, a host and moderator sees You, Hosting and Moderation, and a plain member sees no sidebar.
The case page (`/me/moderation/cases/:id`) has no entry of its own: it is reached from the Mod log, which stays marked
there. Below 760px the sidebar sits above the content and the top bar wraps (#855).

Every page in the Hosting or Moderation area opens with a line saying why you can see it: "You can host because you are in
@Event hosts" names the Discord roles that grant the scope (the same role-group snapshot as the scope check, read from the
cache), "...because you are an Administrator" for admins and the server owner, and "...because you hold the Event host role"
when no role name is available.

- A host reaches only events they created (`isEventHost`); an admin session reaches every event. A member who is not in a host group gets 403
  on `/me/events*`, even for an event they created earlier.
- **No scope opens `/admin`.** The admin console is gated by the session role alone (`requireAdminRoleMiddleware`); a host or
  moderator signs in with `/me` and holds a `user` session. A test walks every registered `/admin` route with each scope combination
  and expects 403.
- Fails closed, all or nothing: both capabilities come from one read of the role groups. If the groups or the member cannot be read
  (Discord or database error), the session is plain `member` for that request, never a partial set, and the
  event and moderation pages answer 403. The request is still served as `me` otherwise.
- **Moderator scope (#1320).** `/me/moderation` is the Mod log for people who moderate but are not admins. The header says why they see it
  (the Moderator role groups they are in; an administrator session says so instead). It shows three tiles (open cases, actions in the last
  7 days, timeouts running now), the **Open cases** with a **Review** link, and the **Actions** list, filterable by kind (All, Warnings,
  Timeouts, Bans; a kick shows under All), 50 per page. Each row links to its case at `/me/moderation/cases/:id`, where the four decisions
  (Keep out for now, Decide later, Keep out for good, Let back in) are the same ones the admin Moderation page offers: the same service call, and an audit row
  (`moderation.case.<decision>`) for every attempt. `/me/moderation/audit` is the Command audit, read only (no settings card, no write
  route). A moderator cannot open a case, run the review-date check, change a moderation setting or reach any `/admin` page. The log shows what
  the admin log shows (member, moderator, action, reason); message content and attachments are never stored there. "Timeouts running now"
  counts members whose Discord timeout has not ended, from the member cache, so it needs the Server Members intent and shows a dash
  without it (the log does not record how long a timeout lasts). Mod-log rows carry no channel; channels appear in the Command audit.
  Tickets will join this section when it is switched on.
- Nothing grants the scope automatically. The **Event host** preset on the Role Groups page only pre-fills the form, and an existing
  server gains no host members from this change.

The role is fixed by the command: `/config` always issues `admin` (and
re-checks the invoker's live `Administrator` bit, besides registering with
`default_member_permissions = Administrator`), `/me` always issues `user`.
It is baked into the redeemed session row + signed cookie.

Audit-log rows produced through the Web UI record the role the session was
acting under, so `admin` and `user` writes can be told apart. An admin acting
on their own `/me/*` is logged with `role: "admin"` (the role is the
session's, not the URL surface's).

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
                            │ GET /admin/s/…   │
                            │ - peek token     │
                            │ - consent page   │
                            │   (Sign in btn)  │
                            └──────────────────┘
                                 │
                                 │ click "Sign in" (POST, CSRF-checked)
                                 ▼
                            ┌──────────────────┐
                            │ POST /admin/s/…  │
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
                                 ├─ click "Finish" or re-run /config or /me
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
- **Opening the link does not burn it.** `GET /admin/s/<token>` only checks
  the token and shows a consent page, so link previewers (Discord, Slack)
  can't consume it. The token is spent when you click **Sign in**, a `POST`
  that also requires a CSRF token, so another site can't sign your browser
  in to an attacker's session (login CSRF).
- **Role is fixed by the command.** `/config` issues an `admin` link; `/me`
  always issues a `user` link, even for administrators, so a `/me` link
  never carries admin scope.
- **Short TTL.** Default `WEBUI_SESSION_TTL_MINUTES=10`. Tokens expire
  whether or not they're used.
- **Sliding inactivity.** Once redeemed, the cookie has a sliding
  inactivity window (default `WEBUI_INACTIVITY_TIMEOUT_MINUTES=30`)
  hard-capped at the session's server-side `expiresAt`. On redemption
  that hard cap is bumped to `now + WEBUI_SESSION_LIFETIME_HOURS`
  (default 24h) so an active operator isn't kicked out at the much
  shorter link TTL.
- **Dead rows are purged.** Sign-in rows hold only a token hash and
  timestamps. MongoDB removes each one a week after its `expiresAt` (a TTL
  index on the `WebSession` model, created automatically on first start after
  upgrading), so a row lives at most `WEBUI_SESSION_LIFETIME_HOURS` plus seven
  days. The grace is fixed, not a setting. Revoking a session only marks it;
  the row is purged on the same schedule.
- **Re-issuing kills the prior session.** Running `/me` or `/config` again revokes
  all of _your_ unrevoked sessions and mints a new one. Other admins'
  sessions are untouched.
- **Permissions re-checked every request.** The cookie-session middleware
  re-validates the session on every hit, per role: an `admin` session
  requires the user's **live Administrator permission**
  (`PermissionsService.isAdministrator`, a forced REST lookup reused for
  ~15 s), so a demoted admin is logged out within seconds; a `user` session must pass the `me` command's role
  gating on the Permissions page (with none configured, every member
  passes). When the optional `GUILD_MEMBERS_INTENT` is off (the default) the
  bot never hears about kicks, bans or role changes, so a `user` session
  re-reads the member from Discord (reused for ~15 s) instead of trusting the
  member cache: a member who left, was kicked or banned, or lost the role loses
  `/me` within seconds. With the intent on, the gateway keeps the cache current
  and no extra REST call is made. On top of that the bot revokes the member's
  sessions as soon as it sees them go: a kick or ban through the audit-log
  entry or the ban event (neither needs the Server Members intent; the audit-log
  entry needs the bot's View Audit Log permission), and a plain leave through
  the member-remove event (which does need the intent; without it the live
  re-check above ends the session on the member's next request, and the bot
  warns once at startup). Revoking is a soft revoke of the session row, stores
  no new member data, and a failure to revoke is logged and never affects
  the bot. A timeout does not end a session. `/config` is fixed Administrator-only and is
  not editable on the Permissions page.
  Every `/me` route, including `/me/session/ping`, is rate limited per client IP
  (600 requests per 10 minutes overall, plus 60 non-GET requests and 30 Rewind
  loads per 10 minutes, on top of the tighter export and reset limits), and audit rows written from `/me` store only bounded text: a
  rejected timezone is recorded by length, never by value.
  If the check itself cannot be performed (Discord API hiccup, rate
  limit), the request fails with a 503 and the session is left intact —
  only a definitive denial revokes it.
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
read-only. Secrets (`DISCORD_TOKEN`, `MONGODB_URI`, `WEBUI_SESSION_SECRET`)
show as configured or unset only, never any part of their value, because a
guild Administrator is not necessarily the host operator. You can verify
what the process saw at startup, but you cannot change it from the
browser.

YAML import/export covers the MongoDB tier only. Imports apply
**per-key**: the protected-keys list (`PROTECTED_KEYS` in
`src/web/bootstrap-vars.ts`, enforced by `src/web/routes/write/settings.ts`) flags any row that targets a bootstrap key
as `rejected: protected key`, but other valid rows in the same file
still apply. The result page shows per-key outcomes plus a top-level
`ok` / `partial` / `failed` status — a mixed YAML produces a partial
import, not an atomic failure.

Any Web UI write that changes a scheduled feature's enable flag or cron — a
Settings or feature-card save, the Enable banner, a per-key Reset, a YAML
import or Reset to defaults — re-arms that feature's job immediately (digest,
leaderboard roles, birthdays, rewind nudge, events, reminders, LFG). A single
save that re-posts the same value leaves the running job alone; a YAML import
re-arms every job whose keys it wrote, and Reset to defaults re-arms them all.

---

## Bootstrap environment variables

These are read at startup and never edited from the Web UI. Change them
by editing `.env` and restarting the container.

### Required for the bot itself

| Variable               | Required | Example                              |
| ---------------------- | -------- | ------------------------------------ |
| `DISCORD_TOKEN`        | yes      | `MTIzNDU2Nzg5MDEy...`                |
| `CLIENT_ID`            | yes      | `1234567890123456789`                |
| `GUILD_ID`             | yes      | `9876543210987654321`                |
| `MONGODB_URI`          | yes      | `mongodb://mongodb:27017/koolbot`    |
| `NODE_ENV`             | no       | `development` (unset) / `production` |
| `DEBUG`                | no       | `false` (default) / `true`           |
| `GUILD_MEMBERS_INTENT` | no       | `false` (default) / `true`           |

`NODE_ENV` defaults to `development` when unset (`src/config/env.ts`). The published Docker image
(`Dockerfile`) sets `NODE_ENV=production`, and `.env.example` ships `NODE_ENV=production`, so containers run as
production unless you override it; a bare `npm run dev` or `node dist/index.js` does not. Set it to `production`
for any real deployment.

### Required when the Web UI is enabled

| Variable                           | Required         | Default | Notes                                                                                           |
| ---------------------------------- | ---------------- | ------- | ----------------------------------------------------------------------------------------------- |
| `WEBUI_ENABLED`                    | yes (to turn on) | `false` | `true` mounts `/admin/*`; anything else leaves it 404.                                          |
| `WEBUI_BASE_URL`                   | yes when enabled | —       | Public URL the DM'd link points at, e.g. `https://bot.example.com`. No trailing slash needed.   |
| `WEBUI_SESSION_SECRET`             | yes when enabled | —       | HMAC key for token hashes and signed cookies. Use 32+ random bytes (`openssl rand -base64 32`). |
| `WEBUI_SESSION_TTL_MINUTES`        | no               | `10`    | TTL of the DM'd link from issuance.                                                             |
| `WEBUI_SESSION_LIFETIME_HOURS`     | no               | `24`    | Hard cap on a redeemed session, measured from redemption. Bounds the sliding inactivity window. |
| `WEBUI_INACTIVITY_TIMEOUT_MINUTES` | no               | `30`    | Sliding cookie window after redemption.                                                         |
| `WEBUI_TRUST_PROXY`                | no               | (off)   | Set to a hop count (e.g. `1`) when running behind a reverse proxy that sets `X-Forwarded-*`.    |

`WEBUI_TRUST_PROXY=true` trusts every proxy hop, so clients can spoof `X-Forwarded-For`
and evade the per-IP rate limits. It still works but logs a warning at startup; prefer a hop count.

`WEBUI_SESSION_SECRET` must be at least 32 bytes; a shorter value is
rejected at startup and the Web UI is not mounted.

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

| Variable          | Required | Default | Notes                                                                |
| ----------------- | -------- | ------- | -------------------------------------------------------------------- |
| `METRICS_ENABLED` | no       | `false` | `true` mounts `/metrics`; anything else leaves it 404.               |
| `METRICS_TOKEN`   | no       | (empty) | When set, requests must send `Authorization: Bearer <token>` or 401. |

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

- **Publish the port directly** (simplest, but no HTTPS). The shipped
  compose binds to loopback only; change the `ports:` entry to `3000:3000`
  (or a specific LAN/VPN IP) for access from other machines. See the
  [Direct port publish](#direct-port-publish) recipe below.
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
WebUI mounted at /admin and user surface at /me
```

If you see `WEBUI_ENABLED=true but its configuration is invalid: ...`, the
bot started without the Web UI mounted — fix the env vars and restart.

### 4. Run `/config`

Run `/config` in Discord. The bot replies ephemerally:

> ✅ I've DMed you a single-use sign-in link. Check your direct messages.

Open the DM, click the link, and you're in.

---

## Docker Compose recipes

The production `docker-compose.yml` shipped in the repo **publishes
port 3000 on the host's loopback only** (`127.0.0.1:3000`), so the
quick-start magic link works on the machine itself and nothing is exposed
to the network by default (a loopback bind is not reachable over the host's
VPN address either). For access from other machines, use the direct publish
recipe below on a trusted LAN or VPN, or a reverse proxy for anything
reachable from the public internet. The recipes below are starting points;
pick one and drop it into your own `docker-compose.yml`.

### Direct port publish

The simplest way to reach the Web UI from other machines. The repo's
`docker-compose.yml` binds to loopback instead (see
[Bind to localhost only](#bind-to-localhost-only)); to use this recipe,
change the publish to `3000:3000`. The bot listens on port `3000`; you map
it to the host on all interfaces.

```yaml
services:
  bot:
    # newest release; `:nightly` follows main, `:X.Y.Z` pins a version
    image: ghcr.io/lonix/koolbot:latest
    container_name: koolbot
    restart: unless-stopped
    env_file: .env
    depends_on:
      - mongodb
    stop_grace_period: 30s
    stop_signal: SIGTERM
    ports:
      - "3000:3000" # /health and /admin (when WEBUI_ENABLED=true)

  mongodb:
    image: mongo:8
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

The Web UI decides the session cookie's `Secure` flag from the scheme of
`WEBUI_BASE_URL` (see `shouldUseSecureCookies()` in `src/web/cookies.ts`):
`https://` sets it, `http://` does not, so a plain-HTTP `WEBUI_BASE_URL`
such as `http://your-host:3000` works regardless of `NODE_ENV`. Startup
refuses to enable the Web UI when `WEBUI_BASE_URL` does not start with a lower-case `http://` or `https://`
(`validateWebUIEnvVars`), so a missing or malformed value never silently falls back to `NODE_ENV`. Keep `WEBUI_BASE_URL` matching the URL you actually
browse to, or the browser will drop the cookie and every page click will
log you back out.

Plain HTTP is fine on a trusted LAN. For anything else, put a reverse proxy
in front of the bot and terminate TLS there (recommended — see
[Caddy reverse proxy](#caddy-reverse-proxy-recommended) below).

Either way, plain HTTP exposes the magic-link bearer token in transit
and the session cookie in subsequent requests. Don't run plain HTTP on
the public internet.

### Bind to localhost only

This is the shipped default. If you only want to reach the Web UI from the
host machine, or through an SSH tunnel or a reverse proxy on the host, bind to
the loopback. A loopback bind is not reachable over the host's VPN address; for
that, change the `ports:` entry to the VPN IP (`"<vpn-ip>:3000:3000"`) or
`3000:3000`:

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
    # newest release; `:nightly` follows main, `:X.Y.Z` pins a version
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
    image: mongo:8
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

⚠️ **Trust-proxy is a footgun if the bot is _also_ directly reachable.**
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

Set `WEBUI_BASE_URL` to whatever URL your tunnel hands out and _don't_
publish port `3000` to the public internet. The bot only needs to be
reachable from the tunnel sidecar's network namespace.

---

## Reverse-proxy guidance

The Web UI is a plain HTTP server. Any reverse proxy works. The
requirements are:

1. **Terminate TLS at the proxy.** The bot itself does not speak HTTPS.
2. **Forward `Host`** so URL generation inside the app matches
   `WEBUI_BASE_URL`. Most proxies do this by default.
3. **Set `WEBUI_BASE_URL` to the public `https://` URL.** That's what flips
   the session cookie's `Secure` flag on (`shouldUseSecureCookies()` in
   `src/web/csrf.ts`); it falls back to `NODE_ENV=production` only when
   `WEBUI_BASE_URL` is missing or malformed. The bot does not look at
   `X-Forwarded-Proto`. You can still forward it for your own logging, it
   just doesn't affect cookie flagging.
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
  They are intentionally minimal, but `/ready`/`/health` _do_ report
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
- **Response headers.** Every `/admin/*` and `/me/*` response carries a
  `Content-Security-Policy`, `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and
  `Cache-Control: no-store`, and `X-Powered-By` is off (`src/web/security-headers.ts`).
  The CSP is `default-src 'none'` with `script-src` limited to a per-request
  nonce (trusted templates emit scripts through `scriptTag()`, which the
  response middleware stamps with the nonce, so a `<script>` injected through
  unescaped content gets none and does not run; there is no inline event
  handler, destructive buttons use `data-confirm`), `style-src
'self' 'unsafe-inline'` (`'self'` for the two shared stylesheets, `'unsafe-inline'` because the pages use `style=` attributes), same-origin
  `connect-src`/`img-src`/`form-action`, and `frame-ancestors 'none'`.
  `Strict-Transport-Security: max-age=15552000` (180 days, no
  `includeSubDomains`, no `preload`) is sent only when `WEBUI_BASE_URL` is
  `https://`. Add `includeSubDomains`/`preload` at your reverse proxy if you
  own the whole domain and want them. If you extend the UI, never add an
  inline `on*=` handler or an external script/style/image source: the policy
  blocks them.
- **Flash banners are signed.** The `?flash=…&msg=…` text a page shows after
  an action carries an HMAC signature, so a hand-crafted link cannot put
  text in front of an admin. Unsigned or altered banners are dropped. (The
  `/me/*` pages and the adoption pages still show unsigned query flashes.)
- **CSRF is bound to the session.** While signed in, the CSRF token is
  derived from the session (`HMAC(WEBUI_SESSION_SECRET, session id)`), so a
  cookie planted from a sibling sub-domain cannot pass it. Before sign-in
  (the consent page) a double-submit cookie is used. Over HTTPS both the
  session and that CSRF cookie use the `__Host-` prefix, and duplicate
  cookies resolve first-wins. On upgrade, existing sessions keep working
  (the token needs nothing new); a page opened before the upgrade must be
  reloaded once, and deployments with an `https://` `WEBUI_BASE_URL` sign in
  again once because the session cookie was renamed to `__Host-koolbot_session`.
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
| Run `/config` or `/me`             | Revokes all your prior unrevoked sessions server-side; mints new                        |
| Click DM link                      | Marks token `usedAt`; sets signed session cookie                                        |
| Idle longer than inactivity window | Cookie is rejected on the next request; the DB row remains until TTL or explicit revoke |
| Reach session's hard `expiresAt`   | Cookie is rejected on the next request; the DB row is past its TTL                      |
| Click **Finish** in the UI         | Session revoked server-side; cookie cleared                                             |
| Administrator removed in Discord   | Next request revokes the admin session (live Administrator check)                       |
| Member is kicked or banned         | All their sessions are revoked as soon as the bot sees the audit-log entry or ban event |
| Member leaves the server           | Revoked on the leave event (needs `GUILD_MEMBERS_INTENT`); else on their next request   |
| Bot restart                        | Sessions survive (stored in MongoDB)                                                    |
| `WEBUI_SESSION_SECRET` rotated     | All existing sessions and outstanding tokens invalid                                    |

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

| Page                    | Replaces                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| **Dashboard**           | `/botstats`                                                                                         |
| **All settings**        | `/config list`, `get`, `set`, `reset`, `reset-all` (Danger zone), `import`, `export`, `reload`      |
| **Command permissions** | `/permissions set`, `add`, `remove`, `clear`, `list`, `view`                                        |
| **Setup wizard**        | `/setup wizard`                                                                                     |
| **Announcements**       | `/announce create`, `list`, `delete` + editable `announcements.enabled`                             |
| **Birthdays**           | (new — upcoming list, edit/remove, message preview, **Run now**) + editable `birthdays.*` settings  |
| **Events**              | `/event create`, `list`, `cancel`, `start` + editable `events.*` settings                           |
| **Polls**               | `/poll create`, `list`, `add-item`, `delete`, `delete-item`, `test`, `list-items` + `polls.*` edits |
| **Reaction roles**      | `/reactrole` create, archive, unarchive, delete, list, status + editable `reactionroles.*` settings |
| **Notices**             | `/notice add`, `edit`, `delete`, `sync` + editable `notices.*` settings                             |
| **Quotes**              | (new — list/search/edit/delete quotes, **Resync**, JSON export) + editable `quotes.*` settings      |
| **Bot permissions**     | (new — which Discord permissions the bot is missing for the enabled features, and where)            |
| **Presence**            | (new — edit the "Watching …" presence message pools)                                                |
| **Voice channels**      | `/vc force-reload` (**Force VC cleanup** button) + editable `voicechannels.*` settings              |
| **Weekly digest**       | (new — **Preview** dry-run, **Send now** button + editable `digest.*` settings)                     |
| **Leaderboard roles**   | (new — tier editor, current holders, **Run now**) + editable `leaderboard_roles.*` settings         |
| **Role groups**         | (new — admin-defined, ranked role groups with capabilities; plan → preview → apply)                 |
| **Rules**               | (new — post the rules message, preview/apply the acceptance-role rollout; gated by `rules.enabled`) |
| **Channel claims**      | (new — read-only, group-gated, sync-to-category and bind-to-feature claims; plan → preview → apply) |
| **Channel manager**     | (new — create, rename, reorder and delete categories and text/voice channels; see below)            |
| **Adopt Events**        | (new — adopt existing Discord scheduled events as KoolBot events; plan → preview → apply)           |
| **Voice analytics**     | (new — guild-wide voice-activity heatmap; gated by `voicetracking.enabled`)                         |
| **Database**            | `/dbtrunk status`, `/dbtrunk run`                                                                   |
| **Command audit**       | (new — slash-command audit log) + editable `core.*_audit.*` settings                                |
| **Command metrics**     | (new — per-command usage dashboard) + editable `monitoring.*` settings                              |
| **Moderation**          | `/modlog` (server-wide; surfaces `/warn` entries) + editable `moderation.*` / log-channel settings  |
| **Tickets**             | (new — `/ticket` overview: claim / close / reopen) + editable `tickets.*` settings                  |
| **Environment**         | (new — read-only env diagnostics)                                                                   |

The sidebar groups the pages by what you are trying to do (#1296), in this order:
**Dashboard** on its own at the top; **Features** (the switched-on features, A to Z:
Announcements, Birthdays, Events, Leaderboard roles, Moderation, Notices, Polls, Quotes,
Reaction roles, Rules, Tickets, Voice analytics, Voice channels, Weekly digest);
**Access** (Command permissions, Role groups, Bot permissions); **Server setup**
(Setup wizard, Server scan, Channel claims, Channel manager, Adoption history); **Bot**
(Presence, Database, Environment, Command audit, Command metrics); and **All settings**
pinned at the bottom. Features that are switched off are not listed with the others: they
fold into **N turned off** under Features, so each one stays one click from being enabled.
The folded list opens on a switched-off feature's own page, and is otherwise remembered
open or closed per browser. The routes did not change with the names (Command permissions
is still `/admin/permissions`, Presence `/admin/bot-status`, Environment `/admin/bootstrap`).

The **Dashboard** (#1322) opens with four tiles, each linking to the page where you act:
Version, Discord (connected, members, in voice now), Database (connected, a few counts) and
Permissions (the number of missing bot permissions, warned when above zero). **Needs you**
lists the problems from Bot permissions and the last Server scan, one row each with a button
to the page that fixes it, and is left out when there is nothing. **This week in voice** is
the last 7 days by weekday (only when voice tracking is on) and links to Voice analytics.
**Features** lists every feature with On or Off and its config key, each linking to its own
page: nothing is switched on the Dashboard. Every source is read on its own with a time
limit, so one that fails or is slow says "unavailable" in its own card and never takes the
page down or reads as zero. The Dashboard never starts a Server scan: it lists what the last
scan found for up to 30 minutes after it finished, each row saying how long ago that scan was
read (for example "Found by a Server scan 12 minutes ago"), and the Server scan page is where
you run a new one. The scan page itself still shares one scan for a minute (#1415).

The Dashboard's **Version** panel (#1029) shows the running version
next to the latest KoolBot release, with its state: _up to date_, _update
available_ (with the kind: major, minor or patch), or _couldn't check_. It also
links to the release notes and has a **Check now** button. When an update is
available, the card shows how to update for Docker Compose, plain Docker and
source installs, and warns that a major update may include breaking changes.
Every admin page shows the running version in the top bar, plus an _Update
available_ badge when the instance is behind.

The check runs at startup, every 12 hours and on **Check now** (at most once a
minute). The result is cached, so no page waits on GitHub. A failed check
(offline, air-gapped, rate-limited) never breaks the page. The card shows
_couldn't check_ with the reason and the last successful result.

- **What is sent:** one anonymous `GET` of
  `https://api.github.com/repos/lonix/koolbot/releases/latest`, public release
  metadata. Nothing about the instance is sent: no version, guild or
  identifiers, and no headers beyond a generic `User-Agent` and `Accept`.
- **Turning it off:** set `core.updatecheck.enabled` to `false` in Settings.
  The card and banner then show only the running version, and no request is
  made.
- **Discord note (optional):** `core.updates.enabled` + `core.updates.channel_id`
  post a one-time note to a log channel when a newer release is first seen. It
  is off by default.

Feature pages (Announcements, Birthdays, Events, Polls, Reaction Roles,
Notices, Quotes, Voice Channels, Weekly Digest, Leaderboard Roles, Moderation,
Tickets, Voice Analytics) are gated by their `<feature>.enabled` config key
(`voicetracking.enabled` for Voice Analytics). When a feature is **off**, its sidebar link is
still shown — greyed with an "off" badge — rather than hidden, so the page stays
discoverable (#610);
hiding it created a chicken-and-egg where the natural place to enable a
feature was the very page you couldn't reach. Opening a disabled feature's
page renders a banner explaining the state with an inline **Enable** button
(flips the flag via `/admin/settings/set` and returns you to the page) plus
an **Open Settings** link.

Every feature page reads in the same order (#1301): a **status line** (an On or Off badge and chips for
the facts worth knowing, with a warning chip that links to the setting or the permission when something
is missing), then the usable part (what the feature holds and its main actions), then the **Settings**,
folded. The summary reads `Settings` with the number of settings and how many differ from the default.
The settings open by themselves when the feature is off or a required value is missing (no channel, no
category), and after a save or a reset, with the flash shown inside them. Otherwise they stay folded,
and the browser remembers per page whether you left them open (`localStorage`; the page works the same
without it, and without JavaScript the fold is the browser's own `details` element).

Every feature page also has a **Settings** card (#970) that edits all of that
feature's config keys in place, with the same controls, validation, dependency
locks and accessibility wiring as the Settings page. The card saves through the
shared `/admin/settings/save-section` route, is audited as
`settings.save-section`, and returns you to the page with a flash message. The
Settings page still lists and edits every key; the card is a second view of the
same values, not a copy. When the card includes the feature's
`<feature>.enabled` toggle, that toggle is the form's cascade master: unticking
it greys out the rest (the other rows sit nested under the switch), and saving writes only `<feature>.enabled = false`, so
turning a feature off from its page never blanks its other settings. Saving
normally shows the result inside the card without reloading. A save that turns
a feature on or off reloads the page instead, so the disabled banner, the Status
card, the sidebar badge and the page's action buttons all match the new state.
Auto-managed keys (`notices.header_message_id`, `quotes.header_message_id`) are
never editable here. Both pages have a **Header post** card with a **Re-post the header** button (see
_Re-posting a bot-managed message_ below).

The **Announcements** page lists the scheduled announcements, each with a
**Post now** button that sends it to its channel immediately, off schedule, plus
enable/disable and delete. **Post weekly VC stats now** triggers the weekly
voice-stats announcement on demand, and **Compose & send once** posts a one-off
announcement without storing a schedule. Every action is CSRF-protected and audited.

The **Announcements** page's card is a single `announcements.enabled` toggle, so
scheduled announcements can be switched off as well as on without leaving the
page.

The **Notices** page's card (#972) edits `notices.enabled`, the notices channel
(`notices.channel_id`, a text-channel picker), the header post
(`notices.header_enabled`) and whether it is pinned
(`notices.header_pin_enabled`). Changing the channel does not move notices that
are already posted: after saving, use **Resync notices to channel** to repost
them in the new channel. The status line keeps the total notice count.

The **Polls** page manages poll schedules and the question library. Questions
are imported from a file you upload or a YAML/JSON document you paste into the
box (`{ polls: [{ question, answers, multiselect?, tags? }] }`); the content goes
from your browser straight to the bot. There is no import-from-URL option and no
host allowlist.

The **Polls** page's card (#973) edits every `polls.*` key: the enable flag, the
default duration, the cooldown, participation tracking and the retention periods
for weekly participation and turnout.

The **Voice Channels** page's card (#979) edits every `voicechannels.*` key: the
enable flag, the category (a category picker), the lobby names, the channel
prefix and suffix, the control panel and the per-user preset limit. Next to it,
**Force VC cleanup** removes empty unmanaged channels in the category and makes
sure the lobby exists. Turn on **Only clean up channels KoolBot created**
(`voicechannels.cleanup.managed_only`, #1032) when the category is an existing,
shared one: startup, periodic and forced cleanup then delete only empty channels
KoolBot created itself, and the card also lets you pick the lobby channel by ID.

The **Reaction Roles** page offers two ways to add a mapping (#813). _Create a
reaction role_ mints a brand-new Discord role and posts a picker message; the
_Create a private category + channel_ checkbox is on by default (preserving the
original behaviour) — untick it to opt out and get a plain self-assign role with
no attached channel. _Bind an existing role_ maps an
emoji to a role you already manage (no role/category/channel is created) and,
when given an existing message ID, adds the mapping to that message — so one
picker message can carry many emoji→role mappings. Both paths validate the role
hierarchy up front (the bot needs **Manage Roles** and a role ranked above the
target) and surface an actionable error instead of silently failing at reaction
time. Rows are tagged **managed** (bot-created; delete tears down the role +
category + channel) or **bound** (points at a pre-existing role; _Remove_ only
unbinds the mapping and never deletes the role).

A third path, _Create a role group_, posts one shared message with two or more
role options and an assignment mode: **unique** (pick exactly one, the default
for groups), **sticky** (add-only, removing the reaction never revokes the role)
or **toggle** (each option independently added and removed). The two single-role
paths accept **toggle** or **sticky**. How a new message lets members pick
(emoji reactions, buttons or a select menu) comes from the surface style,
`reactionroles.style`; existing messages keep the style they were created with.

**Generate a grouped set** (#1064) creates a whole group of roles and one picker
message in one step, from a preset (**Region**: seven world regions; **Country**:
twenty common countries with flag emoji, Nordics first) or a custom group (a name
plus role/emoji rows, up to 20 options per group, which is Discord's reaction limit
per message). Preset lists live in `src/content/reaction-role-groups.ts`. The
generator is idempotent and non-destructive: a role with the same name
(case-insensitive) is reused and left untouched, roles it creates get no
permissions and aren't mentionable (colour from `reactionroles.group_role_colour`,
Discord's default), and running a group again only adds the missing options by
editing the existing picker message. It never removes roles, mappings or
reactions. If the picker message was deleted in Discord, the run stops and changes
nothing: remove the group on this page and generate it again. Changing the
reaction-role channel after generating groups is not supported (this is the same for
every reaction role, since startup reconciliation looks in the configured channel);
regenerate the group instead. The mode defaults to
**unique** (pick exactly one, e.g. one region);
choose sticky or toggle if members may hold several. Deleting a generated group
removes only roles the bot created, so reused roles survive.

Its **Settings** card (#974) edits `reactionroles.enabled`, the message channel
(`reactionroles.message_channel_id`, a text-channel picker) and the surface
style (`reactionroles.style`) in place. Turning the feature off from here leaves
its channel and style untouched. Each new mapping remembers the channel its
picker was posted in (#1207, shown under the message ID), so changing the message
channel only decides where the next picker goes; existing pickers keep working,
and deleting a group or mapping removes the picker from its own channel. Mappings
created before this are not remembered: they are still looked up in the configured
channel, the page shows a warning only while such mappings are active, and startup
keeps them (with a logged warning) only while none of them is found there; once one
resolves, the older ones whose picker is not found are archived. Delete those older
pickers and mappings before switching channels, or switch back before cleaning up.

The **Quotes** page (#984) is where moderators manage stored quotes without
going through `/quote` in Discord. The list is newest first, 25 per page, and
shows each quote's author, who added it, when, its 👍/👎 tally and the message
ID of its channel post. The search box matches the quote text literally (case
insensitive) and also an exact quote, message or member ID. Per row:

- **Edit** changes the text and/or the author (a Discord user ID). The channel
  post is redrawn first, so if the post can't be reached the quote is left
  unchanged; if the post no longer exists the quote is saved and the flash
  points you at Resync. If saving the quote then fails, the post is put back
  to the stored text. Text longer than `quotes.max_length` is refused.
  While `quotes.enabled` is off only the stored quote changes.
- **Delete** removes the channel post and the quote. If the post can't be
  removed the quote is still deleted and the flash says the post is left
  over, so you can remove it in Discord or with Resync.

**Resync quote channel** is the same rebuild as `/quote reset`: it clears the
channel, posts a fresh header and reposts every quote with its saved votes. If
fewer quotes are reposted than are stored, the result is a warning, not a
success.
**Export quotes (JSON)** downloads the `/quote export` backup; restoring one is
still done with `/quote import` in Discord. Every action is CSRF-protected and
written to the Web UI audit log (`quote.edit`, `quote.delete`, `quote.sync`,
`quote.header-repost`, `quote.export`).

Its **Settings** card edits every `quotes.*` key in place: the enable toggle
(the cascade master, so switching quotes off keeps the rest), the quote
channel, the header and pin toggles, `quotes.clear_on_sync`, the cooldown,
maximum length and vote-history retention, and the roles allowed to delete
quotes. The auto-managed `quotes.header_message_id` is shown read-only in the
status line.

The **Birthdays** page (#986) is for the admin side of birthdays; members still
set their own date on `/me/birthday`. It lists every stored birthday, soonest
first by each member's own timezone, 25 per page, with the next celebration
date, whether a birth year is on file, whether a birthday-role grant is on
record (not yet swept) and the year the check last handled them (it posted,
or skipped them because they had left). The birth year itself is never shown: members share it only to have
their age in the post. Per row:

- **Edit** corrects the month and day, and can remove a stored birth year (an
  admin can never add one). Only an existing entry can be edited. Moving the
  date lets it be announced again this year; removing only the year does not.
- **Remove** runs the same erasure as the member's own data reset (#916): it
  takes back a live birthday role and deletes the bot's birthday posts about
  the member before the entry goes. If either cannot be undone, the entry is
  kept and the page says so, so you can try again. That includes an old grant
  that names no role while `birthdays.role_id` is unset: the entry stays until
  a role is configured again, so the grant can still be taken back.

The **Message preview** card renders the saved `birthdays.message` with you as
the member (a sample age of 30, plus the no-year variant when the template uses
`{age}`), and says whether the member is pinged and which role they get.
**Run now** runs the scheduled check through `ScheduledService.runNow()`; it
never announces anyone twice, because the once-a-year guard still applies.
Every action is CSRF-protected and written to the Web UI audit log
(`birthday.edit`, `birthday.remove`, `birthday.run-now`), recording whether a
birth year is on file but never the year.

Its **Settings** card edits every `birthdays.*` key in place, with
`birthdays.enabled` as the cascade master. Saving a new `birthdays.cron` or
flipping the feature re-arms the birthday job straight away.

**Setting rows (#1318).** The Settings page and every feature card lay each key
out as a row: the name and a one-line description on the left, the control on
the right, and the rest of a long description plus the dotted key behind a
_More_ disclosure. A boolean is a **switch** (a real checkbox with
`role="switch"`, with _On_ or _Off_ beside it); an enum of two to four short
options is a **segmented control** (a radio group), and anything longer stays a
select. A value that differs from its default gets a dot after the name and a
reset button that names the default (_"Reset Period to its default, This
month"_); the type badge and the Default column are gone. Everything is a plain
form control, so it works without JavaScript: an unchecked switch posts nothing
and the save handlers read a listed-but-absent key as `false`. A reset button
posts to a small sibling form (it is not a button of the save form, so pressing
Enter in a text field saves rather than resets).

**Numbers that cannot be wrong (#1304).** Every `number` setting declares a `min` and a `max` in `settingsMetadata`
(a drift test fails on a key without both, or on a default outside its range). The control is a text box with
`inputmode="numeric"` and `pattern="[0-9]*"`, not `type="number"`, because Safari and Firefox let letters into
`type="number"` and ignore `pattern` on it. A small script (`src/web/number-input.ts`) drops anything but digits as
they are typed or pasted and keeps the form from submitting outside `data-min`..`data-max`. The server checks again in
`coerceConfigValue`, which every write path shares (single save, section save, YAML import, wizard, adoption plans): a
word, a decimal, `1e3` or an out-of-range value is refused with a message such as "must be at most 25" and nothing is
stored. A value already stored above a newly declared maximum shows as invalid and blocks the save of its section
until it is fixed.

**Steppers and preset durations (#1427).** Two optional `settingsMetadata` fields on a `number` key choose a control that
cannot be wrong for common values; both are rendered by `src/web/setting-pickers.ts` on the Settings page, the feature
cards and the wizard, and neither adds a server rule: `min` and `max` stay the rule, and the stored value stays a plain
number.

- `stepper: true` (for ranges under about 30 values: `events.groups.default_count`, `events.groups.max_count`,
  `lfg.default_size`) renders minus and plus buttons around the same bounded box. The buttons are hidden until the script
  runs and are disabled at the bounds, so without JavaScript the box is all there is.
- `presets: [...]` (the selected duration keys configured with presets; the retention keys and
  `moderation.raid.join_threshold`, a count of 2 to 1000, stay the box) renders a radio group of the common values with a last
  _Custom…_ and the bounded box. `presetZeroLabel` names a `0` that is not a number (_Off_, _None_). The group posts
  `preset_<key>`, the box `value_<key>`; `readSettingField` takes a ticked numeric preset, and otherwise the box
  (Custom…, or no radio at all), so a browser without JavaScript posts what a script would, with the box shown next to
  _Custom…_. With the script the box is hidden unless _Custom…_ is ticked, and ticking a preset copies it into the box.
  Presets are a shortcut, not a whitelist: any number inside `min`..`max` still saves, so a stored `45` shows under
  _Custom…_ and posts unchanged. A drift test checks that every preset is in range and that the default is one.
  Each preset is labelled in the largest unit that divides it evenly (`30 s`, `5 min`, `1 h`, `7 days`) and the key's own
  unit (`seconds`, `minutes`, `hours`, `days`, from the end of its name) follows the box, so _Custom…_ reads "45 minutes".
  No key needs a `step` field, so none was added.

**Pickers for known value sets (#1426).** A free-text setting whose values are a known set declares a `format` in
`settingsMetadata`, and the Settings page, the feature cards and the wizard render it as a picker
(`src/web/setting-pickers.ts`):

- `events.timezone` is a searchable select of IANA zones. Its first option is _Default (the server's zone)_ and posts
  nothing, because blank means "the server zone". UTC is in the list once (the runtime's own list omits it). With
  JavaScript a search box filters the zones (`new york` finds `America/New_York`, Enter picks the first match). The
  event forms (the admin form, `/me/events/new` and the edit page) use the same select.
- `reactionroles.group_role_colour` is a colour input with a _Use default_ checkbox. A colour input cannot hold an empty
  value and `""` is how the key says "Discord's default", so the checkbox posts `use_default_<key>=true`. A stored value
  that is not `#RRGGBB` gets a second, ticked checkbox, _Keep the stored value_ (`keep_<key>=true`). The save paths turn
  the boxes into the value with `readSettingField` (Use default wins over Keep, which wins over the swatch), so a browser
  without JavaScript posts what a script would. The colour field keeps no state of its own: the swatch and both boxes are
  ordinary controls, so the save bar's baseline, commit on a saved response and Discard apply to them as to any control,
  and the small script only keeps them exclusive and disables the swatch while the section's feature is off.
- `voicechannels.channel.prefix`, `voicechannels.channel.suffix` and `events.channel_prefix` are free text (#1435: not emoji-only, so
  `Looking for group:` or `'s last resort` are fine). The text box is the field, and the event group marker's emoji grid beside it is only
  a convenience. A pick replaces the value.
- `welcome.roles_message_id` (#1433) is a select of the bot's own reaction-role messages for this server, never a typed
  id. The stored value stays the message id. The first option is empty, _Link the channel instead_ (`{roles}` then
  mentions the reaction-role channel); each message is listed by where it is and what it hands out
  (`# roles · 🎮 Gamer, 🎨 Artist +2`), newest first, at most 50 (a line under the select says when the list is cut).
  The labels come from the stored mapping rows and the channel names the page already holds, so there is no Discord call
  per option, and a channel that is gone shows as `(unavailable)`. A stored id that is not in the list (the message was
  archived or deleted, or is older than the cap) is a selected `<id> (not found)` option, and one that cannot be checked
  because the list could not be read is `<id> (could not check)`. With no messages the select keeps the empty choice and
  the stored value, and a line points at the Reaction Roles page. No option is ever `disabled`.

The server checks every value again in `coerceConfigValue` (`src/utils/setting-formats.ts`): a timezone must be one
`Intl.DateTimeFormat` knows, a colour `#RRGGBB` (stored as `#rrggbb`), and a prefix or suffix
at most 32 characters (so a 32-character display name plus both still fit Discord's 100-character channel name) with no control characters
and no custom Discord emoji markup. A value that is **already stored** is exempt: the Settings page and
the wizard pass the stored value, so an old custom timezone, a colour that is not `#RRGGBB` or a prefix over the 32-character cap
still shows, posts unchanged and never blocks saving the rest of its section (a stored custom zone is shown as a
selected "(custom)" option, a stored non-colour is kept by the ticked Keep box and noted under the control). Anything else
that is not what a picker could produce is refused with a message. YAML import, the import preview and adoption plans
read the stored value of each such key (and of each number with a minimum or maximum) strictly and compare with it, so
re-importing an export of the same server keeps a legacy value that is posted unchanged and the preview shows it as
"no change"; a changed value is still checked. If the stored value cannot be read, that key is refused for that import
with a message and nothing is written for it.

`welcome.roles_message_id` adds a database rule on top (`coerceConfigValueForGuild`): a non-empty id must be one of this
server's active (not archived) reaction-role messages, on `/admin/settings/set`, a section save, the wizard step and
YAML import alike. The set is loaded only when it is needed (an empty choice or an unchanged value never needs it), is
never capped, and a failed load refuses the save. The unchanged stored value is exempt, so one old id never blocks the
rest of its section, and that stored value comes from `ConfigService.getStringStrict`: a failed read refuses the save
instead of falling back to the default, and the same read is both the baseline and the value the post is compared with
(in the wizard it is the database's value, never one staged earlier in the run). The wizard's apply checks each staged
choice again against the stored value and the active set before any write, so a message archived while the wizard was
open applies nothing. A stored id with surrounding spaces round-trips unchanged (the select posts it as stored). A
message's channel in the label is any recorded picker channel of its mappings, archived siblings included. An adoption plan passes no set and is
refused for a non-empty id.

**Bot-managed values (#1304).** `quotes.header_message_id`, `notices.header_message_id` and `rules.message_id` hold the
id of a message the bot posted. The Settings page shows them as text with a _Jump to message_ link (built from the
setting that names the channel), without a field and without an entry in the form's `keys`, so saving the section
cannot blank them. The write routes refuse them, a YAML export leaves them out, and a per-key reset is refused. The
feature pages already showed them read-only. `welcome.roles_message_id` is not one of them: an operator sets it, by
picking one of the bot's reaction-role messages from a select (#1433).

**Re-posting a bot-managed message (#1428).** Each managed id has a **Re-post** action on the page of the feature that
owns the message, where the old message can be seen and judged. A managed row on All settings only links there (a
_Re-post_ chip next to _Jump to message_, shown once a message exists), so the action has one home:

| Message                | Page and card                        | Audit action           | What Update/refresh already does                                                  |
| ---------------------- | ------------------------------------ | ---------------------- | --------------------------------------------------------------------------------- |
| Quote channel header   | Quotes, **Header post**              | `quote.header-repost`  | The bot edits the header in place when its wording changes                        |
| Notices channel header | Notices, **Header post**             | `notice.header-repost` | The same, for the notices header                                                  |
| Rules message          | Rules, **Re-post the rules message** | `rules.repost`         | **Update the rules message** edits it in place (a new one only if it was deleted) |

Re-post is a form POST behind the confirm dialog (red, with the consequences listed: a new message at the bottom of the
channel, the old one deleted if the bot can find it in this channel, nothing else touched), CSRF and the admin check,
and it is audited with the old and new ids and what happened to the old message. The order is what keeps there from
ever being two live copies:

1. The new message is sent (and pinned, where pinning is on). If that fails, for example because the bot lacks View
   Channel, Send Messages or Embed Links there, nothing has changed, the old message stays live and the flash names the
   permissions.
2. The new id is stored. If that fails, the new message is deleted again and the old one stays live.
3. The old message is deleted last, and only if the bot wrote it. A message that is already gone counts as done. One
   the bot can't find in the current channel (it was deleted, or it is still in the channel it was posted in before a
   channel change; the old channel id is not stored) is reported as a warning so the admin can delete it by hand. A
   delete that fails is a warning too, with the old message id. The old Accept button on the rules message stops
   working as soon as step 2 is done, because the accept handler only honours the stored id.

The form carries the id the page showed (`expectedId`). A second submit of the same form, or one from a stale tab, finds
a different stored id and does nothing ("already re-posted"). The service also queues a re-post behind a channel rebuild
(Resync quote channel, Resync notices to channel, `/quote reset`) and behind another re-post, so two clicks at once
produce one new message and a resync can't delete the new header. The button is off, with the reason shown, when the
feature or its header is switched off or no channel is set. `welcome.roles_message_id` is a different case (an operator
points it at a reaction-role message, chosen from a select) and is not re-posted.

On the **Settings** page and the feature cards, a setting whose feature declares
a hard dependency (`dependsOn` in `settingsMetadata`) **nests under its parent**
(an indent and a rule) instead of greying in place. While the parent is off the
child is disabled with an inline _"Requires X enabled"_ hint, and the parent is
always right above it (#666, #1299). A dependency that lives on another card
cannot nest, so the row has no control at all: it names what to turn on (linked
to its section on the Settings page) and keeps its stored value in the form, so a
save never changes it. This is the friendly front for the write-time validator
(#663): both read the same `dependsOn` graph, so the row and the server-side
rejection never disagree. The lock survives an enabled parent section (a
dependency lock wins over the per-section cascade), and Rewind toggles are never
locked this way because Rewind is a graceful aggregator that declares no
`dependsOn`. The Setup Wizard keeps its own row layout and gets the same
switch and segmented controls.

**Channels, categories and roles are labelled the way Discord labels them** (#1303), on every admin page that shows
one. A text channel reads `# general`, an announcement channel `📢 news`, a voice channel `🔊 Lobby`, a stage
`🎙️ Town hall`, a forum `💬 ideas`, a thread `🧵 name`, a category `📁 Events` (shown in capitals in tables) and a role
`@Moderators`. Nothing but a text channel gets a `#`, so a category or voice channel is no longer taken for a text
channel. A stored id that no longer resolves to a channel (deleted, or the bot cannot see it) reads
`⚠ 1234 (unavailable)`, and stays selected in its picker so a save does not clear it. Pickers are native selects, grouped by kind
(`Text channels`, `Voice channels`, `Categories`), with the category after the name (`🔊 Lobby · SCRATCH`);
tables and sentences use an icon with the kind as its accessible name. One module, `src/web/discord-labels.ts`,
decides all of this, and `__tests__/web/discord-labels.test.ts` fails when a page writes its own `#` in front of a name.
The Rewind page (`/me/rewind`) uses the same labels.

With JavaScript, the single-value channel, category and role settings become a searchable picker (#1394): a button showing
the current value, and a popover with a search box, a header per kind, an icon in front of each row, the category muted on
the right and a check on the chosen row. Typing `#` lists text channels, `#!` voice channels and `@` roles, as in Discord's
composer; the rest filters by name and category. The arrow keys, Home, End, Enter and Escape work from the search box. The
native select underneath stays the field, so it posts the same stored id, a save that did not touch it changes nothing, an
id that is no longer listed stays selected as `⚠ 1234 (unavailable)`, and without JavaScript the select is all there is.
Lists that take several values (`channel_list`, `role_list`) are still native multi-selects. The rest of #1394 (the searchable multi-select, and labels
on voice stats, the bot permissions page, the events and host pages, the server scan pages and the Voice Channels status line) is not done yet.

The **Setup Wizard** (`/admin/wizard`) walks through the features you pick,
one step each: voice channels, voice tracking, quotes, achievements, reaction
roles, announcements, notices, polls, LFG, name history, moderation, events,
weekly digest, birthdays, reminders, tickets and leaderboard roles. It renders each
step's fields through the
same shared control renderer the Settings page uses (#702), so a channel /
role / category key gets a real picker dropdown instead of a raw-ID text box,
fixed-option keys get a `<select>`, and each field is titled by its
human-readable label (`SettingMetadata.label`) with the dotted config key kept
only as monospace helper text. The cascade-disable behaviour and the
_"Requires X enabled"_ dependency hints/locks (including cross-feature targets
that live on another wizard step) carry over as well, so the two surfaces stay
in lockstep and can't drift apart.

The wizard runs **Features, Access, Channels, Review** (#1321), with a step indicator on every page. The **Access**
step comes right after you pick features and maps Discord roles to who can do what: one card each for Admins
(`/config`), Moderators and Event hosts (`/me`), with what they can and cannot do and a multi-select of roles, and a
Members card that points to Command permissions to narrow `/me`. Re-running the wizard shows the current mapping.
It writes the same role groups as the Role groups page, with the `admin`, `staff` (shown as Moderator) and `host`
capabilities, and only links existing roles: it does not change a role in Discord. The one role it can create is the
Event host (below). Nothing is written when
you save the step. The picks wait in the wizard session and are applied from **Review**, which lists the role
groups it will create or change. Apply checks the roles against Discord again, refuses if the role groups changed since Review,
writes the groups one at a time with an audit entry each, and undoes them if a write fails or the settings that follow fail to apply, so a mapping is
never reported as saved while half of it is. It refuses a managed role, a role at or above the bot's, a role behind
a bot group, a role a feature hands out to members (rules, birthday, leaderboard tiers, raid quarantine, reaction roles),
and removing `admin` from a group (that goes through Role groups, where it is reviewed). A callout says when Events or
Moderation is on and no role is mapped to run it.

When no Event host role exists (no role of that name in Discord, no group carrying `host`), the Event hosts card offers
**Create @Event host**: a role with no Discord permissions and nobody in it, mapped to the `host` capability. Ticking it
only saves the choice in the wizard session. **Review** lists what the adoption engine would do (a single role create) and
carries the plan id. Roles are only ever created through the engine, never with a direct Discord call: Apply recomputes
the plan from the live server and refuses, before writing anything, if the plan id no longer matches, if the plan holds
anything besides that one role (drift or reorders on other groups belong on Role groups), or if the bot lacks Manage
Roles (the card and the Access step refuse it up front as well). The role is created last: after the role mapping and the
settings have applied, Apply saves the Event host group (with no role yet), plans again from the saved groups, starts the
engine's background job only if that plan is the one Review showed, and goes to `/admin/role-groups?job=…`, which shows
the job's outcome and links the group to the new role when it finishes. Apply waits until the job is committed (past
the busy-server lock and the live checks, before the first Discord write). If the group can't be saved or the job can't
start, the group is removed again; once the job is committed it is never removed. The new group ranks strictly below
every other group, so it is never inside another group's "group and above"; if a group already has rank 0 the card
refuses until the order is re-saved on Role groups. A new group is only ever linked to a role created after it was
saved. When the role was not created, the message says the settings and mapping are live.
A job that fails in Discord leaves the group without a role, which does not count as mapped; finish it on Role groups.
The group write and the role creation each get an audit entry.

The **Bot permissions** page (`/admin/bot-permissions`, #1217) says which Discord
permissions the bot is missing for the features you have switched on, so you do
not have to guess why a feature does nothing. It is read-only and writes nothing
to Discord. When something is missing, the first card is **How to fix**: a numbered
list with one step per place (one step for everything missing server-wide, one per
category or channel, one for roles above the bot's role). When nothing is missing it
is one green line instead. Below it, **Permissions** is a matrix with one row per
Discord permission, in the order of Discord's role editor: its status (an icon and a
word: Missing, Not checked, Has), where it applies (server-wide, or the configured
category or channel) and the features that need it, with switched-off features
greyed and marked _(off)_. Rows are sorted Missing, Not checked, Has; a permission
with different results in different places gets one row per result. **Role position**
is a row of its own for roles the bot must be able to hand out. Permissions only
switched-off features would use are folded under _Not needed_. What each feature needs is listed in one place in
the code (`src/services/bot-permission-registry.ts`), and the services that act
(event group channels, clan tags, Events list sync, member moves, voice rooms) take
their permission bits and warning texts from the same list. It covers voice
channels and temporary rooms, events (channels, host access, the leaders-only
channel, moves, clan tags, the Events list), reaction roles, leaderboard roles,
role groups and the rules role (including a role that sits above the bot's
highest role). The channel-posting features (View Channel, Send Messages, Embed
Links) are not covered yet.

- **Effective permissions.** A category or channel is checked with the bot's
  permissions _in that channel_, so an overwrite that denies a permission the bot's
  role has server-wide shows as missing. Permissions a channel cannot grant (Manage
  Roles, Manage Nicknames, Create Events) are checked server-wide and shown as such.
- **Only features in use count.** A feature is listed as affected only while its
  `*.enabled` setting is on and its category or channel is set. A permission that
  only a switched-off feature would need is folded under _Not needed_, not a
  problem. An enabled feature with no category set is shown as _Not checked_, with a note.
  Role groups have no switch of their own, so they count as in use when the server
  has at least one role group. If a setting cannot be read, the page says the check
  is unavailable instead of treating features as off.
- **Fresh, with a short cache.** The bot's member, roles and channels are re-read
  from Discord when the page opens (through the same timeout and rate-limit helpers
  as other Discord calls) and the read is shared for 30 seconds. If Discord cannot
  be reached the page says it is using the bot's cached view; a feature that cannot
  be checked is shown as _Not checked_, never as fine.
- **All Discord permissions.** A folded card at the bottom of the page lists every Discord
  permission with whether the bot's role holds it (the managed role's own server-wide list, without
  channel overwrites, and not widened by Administrator) and what KoolBot does with it:
  _checked in the table above_, _used, not checked on this page_ (posting, moderation and
  the overwrite permissions of read-only channels, each with what for), or _only needed if a Role group grants it_
  (KoolBot does not use it itself, but the bot can only hand out permissions it holds, so no permission is ever
  labelled plainly unused). A permission that is not classified yet (a flag Discord added later) is shown as
  such, never as safe to remove. Administrator is not required for the bot's own features, but without it a
  Role group cannot grant Administrator (the Admin preset does; the Event host and VIP presets grant no permissions and need
  none here). If the role holds it, the row names
  the permissions the switched-on features need that the role itself lacks, to be given
  before Administrator is removed, and says to check the permissions that are used but not
  checked here and any channel overwrite that denies something (they apply again once
  Administrator is gone). The list is the bot's managed role only, not @everyone or other
  roles; it is left out when that role is not known. The classification is in
  `src/services/bot-permission-flags.ts`; a test fails when discord.js gains a flag that is
  not listed. There is no re-authorise link yet: whether Discord applies new bits to the
  bot's existing role is not verified (#1366).
- **Status indicator.** The **Bot permissions** entry in the sidebar shows a badge
  with the number of missing permissions that affect enabled features. It comes from
  the last check (any admin page load refreshes it in the background), so a page is
  never held up for it.
- **Not built yet.** A "Re-authorise" invite link (it is not verified that Discord
  applies new permission bits to the bot's existing role) and a "Show all Discord
  permissions" toggle. Channel names are plain; Discord-style channel-type labels come with
  #1303.

The **Presence** page (`/admin/bot-status`, formerly Bot Status) edits the three "Watching …"
presence message pools the bot rotates through, picked by how many users
are in voice: the _empty_, _one user_, and _multiple users_ pools. Each
pool has an add / edit / remove / reorder list plus a paste-a-list
import/export box (newline- or JSON-encoded), built on a reusable
string-array editor. Entries are stored per-guild in MongoDB and take
effect immediately — no redeploy or restart needed. A pool with
no stored rows falls back to the built-in defaults in
`src/content/statuses.ts`, so behaviour is unchanged on a fresh install;
use **Seed defaults into store** to start editing from those defaults.
Entries in the _multiple users_ pool must contain the `{count}`
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
how long buckets are kept before the TTL index prunes them; both are edited in
place on the page's **Settings** card, which saves back to `/admin/metrics`.
The **Command Audit** page (`/admin/audit/commands`) carries the same kind of
card for `core.command_audit.enabled`, `core.command_audit.retention_days` and
the WebUI audit's `core.web_audit.retention_days`. This is
complementary to the Prometheus `/metrics` endpoint, which is a live
scrape target (command counters since the last restart, process metrics)
rather than a persisted per-day history.

A command run in a voice room stores the room's name with its audit row, because
most voice rooms are deleted when they empty. Once the room is gone (Discord's channel list was read and no longer has it), the
page shows it by that name with a muted `(deleted)` instead of `(unavailable)`. If the channel list could not be read, rooms stay
`(unavailable)`; rows from before this, and rows from other channel types, read as before.

The **Weekly Digest** page (`/admin/digest`) lets an admin **preview** the
weekly voice digest before it sends (#539). **Preview** is a read-only dry run:
it reuses the exact qualifying-users query and embed builder the cron job uses
and renders an HTML approximation of the embeds for the most recent complete
week, plus a summary line (how many members qualify, how many opted in vs.
opted out, and whether a digest has already gone out this week) — **without
sending any DMs or writing anything**. It's GET-driven, so it's safe to refresh.
Users who have DMs closed can't be detected without actually sending, so those
skips only surface on a real run. The page is gated by `digest.enabled`
(the #610 disabled-feature pattern). A **Send now** button force-fires the
digest immediately — the same path the cron runs, including DM delivery and
streak/state updates; concurrent runs coalesce, so clicking it during a
scheduled tick can't double-deliver. There is intentionally **no `/digest`
slash command** — the Web UI is the admin surface.

Its **Settings** card (#976) edits every `digest.*` key in place: the enable
toggle, the schedule (`digest.cron`, the same cron builder as Settings), the
qualifying and streak thresholds, and whether achievements are included. It
saves through the shared `/admin/settings/save-section` route and returns to
the page. The enable toggle is the form's cascade master, so turning the digest
off from here writes only `digest.enabled = false` and keeps the other values.
A save that changes `digest.enabled` or `digest.cron` — from this card, the
Settings page, the Enable banner or a per-key Reset — re-arms the digest job
immediately, so a new schedule takes effect without a restart. A cron value the
scheduler can't parse is refused at save time, so a typo can't stop the job.
If the stored config can't be read, the card shows a notice instead of
controls pre-filled with defaults.

The **Leaderboard Roles** page (`/admin/leaderboard-roles`, #985) manages the
voice-leaderboard role rewards. Its settings card edits `leaderboard_roles.enabled`
(on and off), the period (week / month / all time), the recalculation cron and the
role-change announcement channel; a save that changes the enable flag or the cron
re-arms the recalculation job immediately, as on the Digest page. The **Tiers** card edits `leaderboard_roles.tiers`
as rows — a _Top N_ number plus a role picker, with **Add tier** / **Remove** (without
JavaScript, one spare row is rendered and clearing a row removes it). On save each
Top N must be unique and between 1 and 1000, each tier needs its own role, and every
role must exist, not be integration-managed, sit below the bot's highest role, and not
carry Administrator or another powerful permission (Manage Server, Manage Roles, Manage
Channels, Manage Webhooks, Kick, Ban, Timeout or Mention @everyone; the message names them);
the rows are then serialised back to the same `topN:roleId` string the service reads,
so the stored format does not change. Saving the tiers unchanged writes nothing, so
an existing config's string round-trips untouched. Stored entries the service ignores
(malformed, or shadowed by a later entry with the same Top N) are listed in a warning
and dropped by the next change. When a tier is removed or given a different role, the
next recalculation takes the old role back from the members the bot recorded and drops
that roster (a failed revoke is kept and retried), including when every tier is removed.
If the stored config can't be read, the editor is replaced by a notice so a save can't
overwrite the real tiers. A tier saved before this check keeps its role in the config (an
unrelated save is not blocked), but the recalculation never grants it: it logs one warning per
role, skips new grants for that tier (members who hold it are only revoked as they drop out),
and the tier is flagged on the page. **Current holders** lists, per tier, the members the
bot recorded on its last recalculation (the bot has no GuildMembers intent, so this
roster — not a live read of the role — is the source of truth), and flags roles that
are missing or above the bot's role. **Run now** recalculates immediately through
`ScheduledService.runNow()`, the same run the cron triggers (including the
announcement); concurrent runs coalesce, and the per-tier grant/revoke counts are
reported in the flash message. Tier saves and runs are audited. **All settings** leaves
`leaderboard_roles.tiers` out (`editedElsewhere` in `settingsMetadata`, #1428): the raw `topN:roleId` string is easy
to break, so the tier editor is the only place it is edited. The key is still stored, exported, imported and reset
like any other, so a YAML backup carries the tiers. The Setup Wizard's Leaderboard Roles step does not ask for it either (#1433): the
step says the tiers are set in the tier editor once the wizard is applied, and links to it.

The **Role Groups** page (`/admin/role-groups`, #1020, part of the server-adoption epic #1017)
lets admins name the roles that matter on their server and rank them: as many or as few as
they like (Admin, Mod, Helper, VIP, Friends, Bots …). Groups are optional; with none defined
every feature keeps its current behaviour.

- **Create / edit / reorder / delete.** A group is backed by an _existing role_ (picked from the
  server's roles, with its member count) or by a _new role_ the engine creates when the plan is
  applied. Rank is edited with the ↑ / ↓ buttons; the list is shown highest first, and role
  positions in Discord follow it when applied. **Presets** (Admin, Moderator, Helper, Event host, VIP, Bots)
  pre-fill the permission and capability boxes, which stay editable. The **Event host** preset ticks only the
  Event host capability and no Discord permission, and adds nobody.
- **Capabilities** are what features query instead of hard-coding role ids: `admin`, `staff`
  (shown as **Moderator** in the UI; the stored key stays `staff`; `admin` implies it), `host` (shown as
  **Event host**: lets members open the host panel of events they created, from `/me`; `admin` implies it; it opens no admin page)
  and `bot` (bot accounts only: humans can't be in a bot
  group, and member-facing features such as leaderboards, digest, achievements and welcome
  ignore it). Groups without a capability are still usable for gating (a "Friends" or regional
  role). The guild owner and members with the Administrator permission always count as `admin`,
  with or without a group. Developers: use `RoleGroupService.getGroupsWith(guildId, "staff")`,
  `memberHasCapability(member, "staff")` and `memberIsAtOrAbove(member, groupId)`.
- **Linking an existing role never moves anyone.** Its current holders keep it, and its
  permissions and colour are left alone unless you explicitly tick _Set the role's permissions_
  or enter a colour. Large cosmetic groups work: counts come from Discord without loading members.
- **Locked roles.** @everyone and roles at or above the bot's highest role can't be picked.
  Integration-managed roles (Server Booster, subscriptions, bot roles) can be linked only as
  **gate-only** groups: they can be referenced for gating, never edited, and carry no capability.
- **Roles other features hold can't newly back a group (#1023).** A role that is a Leaderboard
  Roles tier, a Reaction Roles role or the birthday role is shown disabled in the add form
  ("used by …") and left out of the re-link choices; creating or re-linking a group with one is
  refused with the feature named. This is the mirror of the check that stops those features from
  picking a group's role. Nothing stored is changed: a role that already backs a group and is
  also used by a feature keeps working. If the features' settings can't be read, the choice is
  allowed (the page doesn't filter, the save isn't refused). Deleting a group's role is blocked
  while the birthday role names it too, as it already was for tiers and reaction roles.
- **Plan → preview → apply → snapshot.** Saving a group only records what you want. The **Plan**
  card shows what applying would change in Discord (role creates and edits, including position to
  match rank, and bot-group grants) using the shared adoption diff, with blocking errors and
  warnings. **Apply plan** runs it through the adoption engine as a background job: a snapshot is
  saved first, the page shows progress, and the apply can be rolled back. If the server changed
  since the preview, the apply is refused and the new plan is shown.
- **Bots.** When a `bot` group exists, bots not yet holding its role are listed in the plan and
  added to the shared role on apply; their own managed roles are untouched. Listing bots needs the
  Server Members intent; without it the page says so and plans no bot grants.
- **Deleting a group** unlinks it by default and keeps the Discord role. Deleting the role too (#1184)
  goes through the standard flow: **Review deleting the group and its Discord role** opens a preview
  at `/admin/role-groups/<id>/delete-role` with the shared adoption diff, where the delete is listed
  in its own **Destructive steps** section. To apply it you type the role's name. The approval text
  says that the role's ID and its member assignments can't be restored by a rollback. The apply
  checks that the plan is the one you reviewed, and that the review is one this server issued for your
  session, this group and this plan (a keyed MAC over those and the review time, using
  `WEBUI_SESSION_SECRET`, so the time can't be edited); the review stays valid for 15 minutes. It is refused
  while a feature such as Leaderboard Roles or Reaction Roles still uses the role. A role KoolBot
  created needs no separate approval, but still the typed name.

- **Staying in sync with Discord (#1021).** People can still rename, re-permission, move or delete
  a group's role in Discord. KoolBot notices (role edit and delete events, plus a periodic
  reconcile that catches changes made while the bot was offline) and shows the **drift** on each
  group: _permissions_ (only where the group sets a permission set), _name_ (the role no longer
  carries the name it was linked or created with; older groups start tracking the role's current name
  the first time the page loads or a reconcile runs), _position_ (relative order against rank, so
  adding an unrelated role never counts), and _deleted_. What happens next is the **sync policy**:
  `adoption.role_groups.sync_policy`, overridable per group on its edit form.
  - **Flag only** (default): show it and post it to the `core.role_groups.*` log channel, once per
    change. Nothing else happens; applying the plan restores the definition when you want it.
  - **Adopt**: the group follows Discord (permissions, tracked name, rank order). Database only.
  - **Enforce**: the definition is re-applied through the adoption engine, so it is planned,
    snapshotted and audited like a manual apply. It restores what you defined and never widens
    access by itself. If an enforce plan can't be applied (a locked role, the bot can't grant a
    permission) or fails, that group drops back to flag-only and stays there, so nothing retries
    in a loop.
  - Sync pauses while an adoption apply or rollback is running, so the engine's own edits are
    never mistaken for drift. `adoption.role_groups.reconcile_enabled` / `reconcile_cron` control only
    the periodic and startup runs; role edits and deletes in Discord are always checked. Every
    automatic change (unlink, adopt, recreate, fallback to flag-only) is written to the audit log
    under the bot as a system actor.
- **A deleted role unlinks its group.** The group keeps its definition, is marked _unlinked_, and an
  alert is logged. It is never silently recreated: on the page you choose **Create a new role** (the
  next plan creates it) or **Link another role**. Only the _enforce_ policy recreates it on its own,
  and never for a gate-only group.
- **Admin group and Administrator.** The group flagged `admin` is meant to carry Discord's
  Administrator permission. A role that lacks it is flagged as drift, but it is **never added as part
  of the normal plan**: linking an existing role doesn't change its permissions on its own, and the
  grant widens access for everyone holding the role. Tick **Give the admin group Administrator** in
  the **Administrators and the admin group** card and review that plan separately (KoolBot itself
  must hold Administrator to grant it). The same card lists members who hold Administrator through
  _another_ role. Pick members to **move into the admin group** (adds the role, removes nothing)
  and/or roles to **drop Administrator from**; nothing is pre-selected, and you review a plan before
  applying it. Managed roles, KoolBot's own role, the admin group's own role, any role a bot holds
  Administrator through, and any role whose own group defines Administrator are never dropped, and
  a drop that would remove your own Administrator access is blocked. Bots (KoolBot included) are never
  counted as out-of-group administrators; they're listed apart as "Bots with Administrator" so you
  can reduce them to the permissions they need. With no admin group the report is skipped (the server
  owner counts as admin on their own), and without the Server Members intent the card says the member
  list is unavailable.
- **Web sign-in accepts either.** An admin web session is allowed for members with the Administrator
  permission _or_ in the admin group, and always for the server owner; it is re-checked on every
  request, so removing someone from the group ends their session. If the groups can't be read it
  falls back to the Administrator permission alone. `/config` applies the same rule when it issues
  the sign-in link, but Discord hides it from members without Administrator in the command picker,
  so an admin-group member who lacks the permission sees it only once the group carries it (the
  point of the sync) or command permissions are re-scoped in the server's Integrations settings.

Every write is audited. There is no slash command for this page: role groups are admin
configuration and live in the Web UI only.

**Other features use the groups too (#1023).** Each of these keeps its current behaviour when no
groups are defined:

- **Permissions** page: the role picker for each command offers every group, and _group and above_
  (that group plus every group ranked higher), under a _Role groups_ heading above the roles. A
  group entry resolves to the group's role at check time, so re-ranking or re-linking a group takes
  effect without editing the command. A group with no role (unlinked) grants nothing, and the
  command stays restricted. While at least one Moderator (`staff`) or Admin group exists, the moderation
  commands (`/warn`, `/timeout`, `/ban`, `/modlog`, `/raidmode`) default to Moderators unless you set a restriction
  for them on this page; the page marks them _staff only (default)_. Members with the Administrator
  permission still bypass every check. If the groups can't be read, the check is refused (the user
  is told permissions can't be verified) rather than opening the command.
- **Quotes**: the _Roles allowed to delete quotes_ picker (`quotes.delete_roles`) offers the same
  group entries. Left empty, it means the Moderator (`staff`) and Admin groups once one exists. With no such
  group the setting works as before.
- **Birthday role and leaderboard tiers, powerful roles (#1145)**: saving a role with Administrator,
  Manage Server, Manage Roles, Manage Channels, Manage Webhooks, Kick, Ban, Timeout or Mention
  @everyone as the birthday role or a tier is refused, naming the permissions (on the Settings page,
  section saves, imports and the Setup Wizard too). A role already saved is kept, not changed, and not granted: the
  birthday run still announces but skips the role, and a tier skips new grants, each logging one
  warning per role. A role that backs any role group (Admins, Moderators or Event hosts) is refused at
  grant time as well, by the birthday role, leaderboard tiers, the Rules acceptance role and the raid
  quarantine role (#1375), so a combination saved earlier or created some other way can't hand a group's
  access to everyone the feature reaches. The log names the group; if the groups can't be read nothing is
  granted. If the guild's roles can't be read, the save is refused.
- **Leaderboard Roles, Reaction Roles, birthday role**: a role that already backs a group can't be
  chosen for another feature (a leaderboard tier would take it back from members, a birthday role
  would hand it out). The save is refused with a message naming the group. Choices made earlier are
  never cleared. If the groups can't be read, the pick is allowed, since this guards a choice
  rather than access. The Role Groups page lists these roles as used by a feature and leaves them
  out of group linking; the server scan's role table lists them under "Used by" too (reaction roles
  included, read from the database). If the reaction roles can't be read, the scan says so rather
  than showing their roles as free.
- **Group pickers**: the Settings page offers role groups for `quotes.delete_roles`, like the Quotes
  page, and shows a stored group by name. The Setup Wizard renderer supports the same picker, but the
  Quotes wizard step does not list this key, so it is not offered there. Other role lists only take
  roles. Group support for quote deletion is in the service and the picker; deletion
  itself is an admin action in the Web UI and its route is unchanged.

The **Rules** page (`/admin/rules`, #1024, part of the server-adoption epic #1017) manages the
optional rules / terms acceptance gate. It is off by default (`rules.enabled`) and is the one
case where KoolBot gives a role to everyone: a role that means "has accepted the rules". The
settings (`rules.channel_id`, `rules.role_id`, `rules.message`, `rules.button_label`) live on
**Settings** and in the Setup Wizard; this page does the work around them.

- **Post the rules message.** KoolBot posts the text with an **Accept** button in the rules
  channel (and edits that same message when you change the text). Make the channel read-only for
  members in Discord. A press grants the acceptance role and records _accepted at_ for the member.
  Removing the role again, for example when the rules change and you want re-acceptance, is up
  to you; KoolBot never takes the role back on its own.
- **Re-post the rules message (#1428).** **Update** edits the posted message in place. **Re-post the rules message**
  makes a brand new one and deletes the old one (confirm dialog, audited as `rules.repost`); see _Re-posting a
  bot-managed message_ under Settings for the order of steps and the double-submit guard. The old message's Accept
  button stops working at once, so members must use the new one; those who already accepted keep their role.
- **Use an existing role.** Pick any role as the acceptance role (for example a "verified" role
  you already use as a gate), or tick _Create a role_ in the rollout to have the engine make one.
  Members who already hold the role count as accepted: **Record current role holders as
  accepted** stores them as _adopted_ without touching Discord, and a holder who clicks Accept
  isn't asked again.
- **Roll out (plan → preview → apply → snapshot).** Optionally: create the role, **grant it to all
  current members** (so adopting the gate doesn't lock the existing community out; batched and
  resumable by the engine), and **gate channels** (deny View Channel for @everyone, allow it for
  the role). The preview shows the shared adoption diff plus how many members hold the role and
  how many would lose sight of the gated channels; the owner and administrators always see
  everything. Nothing is written until **Apply plan**, every apply saves a snapshot (rolling back
  from the Web UI isn't available yet), and re-running on an adopted server gives an empty plan. The rules channel itself
  can't be gated, and the plan refuses changes to managed roles or roles at or above the bot's.
- **Native Discord gate.** On Community servers Discord has its own rules channel, Membership
  Screening and Onboarding. Use the native gate there; the KoolBot role is for non-Community
  servers, or when you want a custom message or button flow. The page warns when Membership
  Screening is on or the server is a Community, because two gates make new members accept the
  rules twice.
- **Welcome message.** Set `welcome.rules_channel_id` to the same channel so `{rules}` in the
  welcome message (#767) points new members at the rules.
- **Privacy.** _Accepted at_ is the member's own data: it is in their `/me/privacy` export and is
  deleted by a data reset (the Discord role is left alone).

Every write is audited. There is no slash command: this is admin configuration and lives in the
Web UI only.

The **Voice Analytics** page (`/admin/analytics`) is a read-only, guild-wide
voice-activity heatmap (#675, Part B). It aggregates the already-stored
`VoiceChannelTracking` sessions into a 24×7 (hour × weekday) grid of total
voice minutes — a colour-intensity matrix where darker cells are busier — plus
per-weekday and per-hour bar breakdowns and a "busiest slot" callout. Use it to
pick high-reach times for digests, announcements, and polls. A 7d/30d/90d
window toggle selects the trailing date range over already-persisted data (it
is not a config key); the default is 90 days so weekly patterns read clearly.
Sessions are bucketed by their **start** hour/weekday in the **server**
timezone and weighted by the whole session duration — no new data capture, no
new writes, just a single server-side aggregation over existing sessions. (The per-member
Rewind heatmap is more precise, splitting each session across the hour/midnight
boundaries it crosses; the guild aggregate keeps a single group-by to stay
cheap across every member's full history.) The page is gated by
`voicetracking.enabled` (the #610 disabled-feature pattern): when tracking is
off the page still renders but shows a notice and only whatever was captured
before it was disabled.

The **Events** page (`/admin/events`) is the Web UI surface for the event
scheduler: events are created, cancelled and started here (the `/event` command was removed), and members see them in
Discord's Events list and the announcement channel (the bot needs Create Events or Manage Events for the event card) — events that spin up a
temporary voice channel shortly before they start, are announced with a Discord
event link, remind attendees, and clean themselves up afterward. A status line shows whether the
feature, the `events.category_id` channel category, and the
`events.announcement_channel_id` are configured (with warning chips that link to the setting when a
category or announcement channel is missing, since event channels and
announcements won't be created without them, or to Bot Permissions when the bot lacks Create Events) plus the resolved event timezone.
A **Schedule event** button at the top jumps to the form. The
events table lists each event's title, start time, lifecycle state
(_scheduled_ / _active_ / _ended_ / _cancelled_), and, when at least one event has something in it, an **Expected to show up** column, channel
and cover image; empty columns are left out and the raw event id is not shown. Ended and cancelled events are folded under
**Past events (n)**; a finished occurrence that still holds a live series stays in the main list, since its row has the only
**Cancel series** button. For each upcoming event
(the next ten) that column lists who marked **Interested** on its native Discord
event, with the count, read live from Discord when the page is opened and
never stored; it shows a short message when the event is not on Discord's Events
list yet or Discord cannot be read, and "N+" when more than a few hundred
members are interested. Events posted before native-only events also show their
old RSVP tally until they end. Events that are still open get two
lifecycle controls — **Start now** (spin the event up immediately) and
**Cancel** (a confirm-guarded stop) — and a running (`active`) event also gets
**End now** (#1193, below), while finished events show no lifecycle
actions. Every row has a **Host panel** link (see below). A
**Schedule a new event** form (native date and time inputs) creates events without leaving the page. The page
is gated by `events.enabled` (the #610 disabled-feature pattern).

**When** (#1305). The form opens with a **When** choice: **Now**, **In 15 min**, **In 30 min**, **In 1 hour** or **Pick date & time**
(the default, so a planned event is created exactly as before; the date and time fields hide for the other choices). The minute options
create a planned event that starts that long from now. **Now** creates the event and runs Start now at once: the event voice channel and
the group channels are created straight away (the `events.create_lead_minutes` lead time is skipped), the announcement reads "Happening
now" instead of a time, no reminder is sent, and you land on the host panel. The start is stored 30 seconds ahead, because Discord refuses
a scheduled event that starts in the past; the Discord event is created with that start and its description begins "Happening now." and
Discord starts it on its own. If no channel category is set, nothing is created and the page says so; if the event is created but its
channels cannot be made, the host panel opens with an error and the bot keeps trying every minute. An event that starts now cannot
repeat. The duration defaults to `events.default_duration_minutes`; **End now** on the host panel ends it early as usual.

**Hosts create events too** (#1305). An event host (the `host` capability) creates events of their own at `/me/events/new` (the
**New event** link in the Hosting section, shown while Events is on; the page answers 404 while it is off). It is the same form and the
same Groups block, without **Repeat** (a host's events do not repeat) and without an announcement-channel choice (the server's
`events.announcement_channel_id` is used). The event is owned by the signed-in host (`createdBy` and the server come from the session, never
from the form), the scope is checked on every request, and the host reaches only events they created. Both forms use one create pipeline
(`src/web/event-create.ts`), and every create is audited as `event.create` with `via` (`admin` or `host`) and `when`.

**Limit on open events** (#1408). `events.max_active_per_host` (Settings, Events) is the most events a host who is not an administrator may
have open at once; `0`, the default, means no limit. Open means scheduled or running, the same events **Your events** lists under Live now
and Upcoming; ended and cancelled events do not count, nor do events an admin adopted. A host at the limit who tries **New event** or
**Start now** (a Now event) gets a plain message naming the limit, nothing is created, and the refusal is audited as `event.host.limit`.
Administrators are never limited: a person who holds the Administrator permission is exempt even when they signed in through `/me`, which is
checked live with Discord only when a limit is set; if that check cannot be made they are treated as not an administrator and the limit
applies. The setting is read at each attempt, so a change applies at once with no restart; if it cannot be read, the attempt is refused
and nothing is created, rather than treated as no limit. Counting and creating run one at a time per host, so two overlapping requests
(a double click, two tabs) cannot both pass the limit. A host cannot make a repeating series, so the limit never meets one.

**Your events** (#1319) is the home of the Hosting section, at `/me/events`. It lists the events the signed-in person created, never anyone
else's (the query is filtered on the session's server and user, an admin session included): **Live now**, **Upcoming** with **Edit** and
**Cancel** per row, and **Past events** folded. The header has **Start now**, which opens the New event form with **When: Now** already chosen
(`/me/events/new?when=now`; any other value of `when` is ignored), and **New event**; both are left out while Events is switched off, and the page then
says so and still lists earlier events. The scope line under the title says why the person can host ("You can host because you are in @Event
hosts"). **Cancel** asks for confirmation and posts to `/me/events/<id>/host/cancel`, behind the same gate as every host action (CSRF, then
creator-or-admin, 403 otherwise, a refused write audited as `event.host.denied`); it cancels this event only, is audited as `event.host.cancel`, and
is refused for a running event, which is ended from its host panel instead. **Running** means the event is active and its start has arrived: an event
whose channel was prepared ahead of its start (the lead time) is still Upcoming, with Edit and Cancel. The refusal is made inside the cancel's own
atomic claim, so an activation that lands after the page was read cannot be cancelled by it. (A planned event a host starts early stays Upcoming until
its start time, since the event does not record an early start.) Nothing on the page links to `/admin` or shows a server-wide setting.

The **Groups** section of the schedule form (#1188, reshaped in #1299) is optional and
folded to one line, "Split into groups", until that switch is ticked; a plain event is created exactly as before.
It sets up a list of groups for the event, such as quiz teams, clan-match squads,
breakout rooms or raid parties. The setups come first, as cards: the built-in 2, 3 and 4 teams, the
server's and the host's own presets, and Custom. Choosing a card fills the rows and shows a one-line
summary ("2 groups · Red 🔴, Blue 🔵 · 5 each") with **Customise** to open them; **Max per group**
sets the size of every group in one click. For Custom, **Build groups** makes N groups of S
(named Red, Blue, Green… or Team 1…N, with a colour marker each). Each group is one row: marker (an emoji
picker of coloured circles and squares and common team icons, Unicode only and never longer than the
marker limit), name, size (1 to 99, the voice user limit, copied down from the first row), tag (up to 8
characters, so a nickname keeps room within Discord's 32; it starts as the name in capitals while clan tags
are on) and, behind **More**, the kind (**team**: members belong to it; **open**: anyone can join, such as
spectators). **Advanced** holds what a group is called (Team, Squad, Room, Party), and a **channel
creation time** in minutes before the start (empty uses `events.create_lead_minutes`). Without
JavaScript everything is shown open, the marker is a text box and the kind a select, and the same fields
are posted. A separate switch, **Group
leaders**, switches on one leader per team group for this event (off by default; see
**Leaders** below); **What a leader is called**, **Leaders can customise** (#1196, off by default; see
**Team names and tags** below) and **Captains lobby** (#1251, off by
default; see **Captains lobby** below) appear under it only while it is on. The captains lobby is a
separate voice channel that only the host and the current leaders can join, and **Clan tags** (#1194) puts each team's tag on its members'
server nicknames while the event runs (off by default; see **Clan tags** below).
The leaders-only channel is no longer a kind of group in the list: a preset (or a
draft) that still has a `leads` group ticks the **Captains lobby** box instead of
adding a row, and an event or preset saved before keeps its `leads` group as it is.
The preset editor has the same tick (#1263, see **Captains lobby in presets** below).
Names must be unique within an
event and the number of groups is capped by `events.groups.max_count`; a preset with
more groups than the cap is greyed out in the picker and refused by the server
(choose Custom or raise the cap). While "Use groups" is off, the section's number
fields are not checked by the browser and the server ignores them. With scripts
on, choosing a preset fills in the rows, "Add a group" adds a row and mistakes are
shown next to the fields before sending; the server checks everything again, names
the group and field in its message, and the page puts the entered values back after
a refused submit. The events table shows the group count, and a recurring
series keeps the setup (not members) for its next occurrences (see **Repeating events keep the group setup** below). The preset picker
lists the presets that are switched on for the server (see the next section),
plus Custom, which is always available.

**Group presets** (`/admin/events/presets`, #1200; linked from the Groups section,
the Events page and the **Event presets** entry under Features in the sidebar) is the server-wide preset library. It lists the built-in
presets and the server's own, each with an on/off switch: **any** preset,
built-in or your own, can be switched off for the whole server, and the event
form then no longer offers it. Built-ins stay in code and cannot be edited, but
**Duplicate** copies one into the editor as a new preset of your own. Your own
presets can be added, edited, duplicated and deleted. A preset has a name (at
most 50 characters, unique ignoring case, and not the name of a built-in), an
optional description, what a group and a leader are called, an optional channel
creation time and the groups (name, kind, size, tag, marker). Every preset goes
through the same validator as the event form, so the library cannot hold a
setup the form would refuse; it is checked against `events.groups.max_count`,
and a library preset bigger than the cap is greyed out in the picker like a
built-in one. A server can keep up to 50 presets. On the Events table, **Save as
server preset** opens the editor prefilled with an event's groups (names, kinds,
sizes, tags, markers, labels and lead time; never members, captains or channels);
the event is not changed. Choosing a preset fills in its labels and channel
creation time with scripts on; without scripts only the group and leader labels
fall back to the preset's. A preset can carry a default for the **Clan tags** box
(#1194): the editor has a tick box for it, **Save as server preset** copies the
event's setting, and choosing the preset on the schedule form (with scripts on) sets the
box to the preset's default, which the host can still change for that event. A preset
without the field (every preset saved before it existed, and every built-in) means off,
and choosing one puts the box back to off. The tag format (before or after the name) is
set per event, not on a preset. There is no default for the leaders switch (#1195), so
a preset never turns leaders on. The leader label is part of a preset, as before.

**Captains lobby in presets** (#1263). The preset editor (the server's library page and the hosts'
own page, one shared form) has a **Captains lobby** tick instead of a "Leads" choice in a group's
kind: the kind list offers only Team and Open, and a preset has at most one lobby. The tick stands
alone: a preset has no leaders setting of its own (above), so it is not tied to anything on the
page. It says "this setup has a captains lobby", and choosing the preset on the schedule form ticks
**Captains lobby** there, where the box only takes effect while **Group leaders** is ticked (the host
can untick it for the event). The lobby counts toward the group limit because it is a channel. The
preset list shows it as a **captains lobby** tag next to the groups, not as a group. A preset saved
before keeps working unchanged: its `leads` row is shown as the ticked box, and the row's own name,
size, tag, marker and place in the list are carried in hidden fields and written back as they were,
so opening and saving an old preset changes nothing; unticking the box removes the row, ticking it
on a preset without one adds a row named from the leader label ("Leader lobby"). A lobby alone is
not a preset (at least one other group is needed). The stored shape is unchanged, there is no new
setting, and a draft kept in the browser from before the tick (it can hold a "Leads" row) gets its
option back and the tick set, so a retry keeps the lobby. How a preset with a lobby is applied:

- **Schedule form.** With scripts on, the preset ticks the box (never adds a row). Without scripts, a
  preset with all rows left empty uses the preset's groups, and the lobby is added only when
  **Group leaders** is ticked, like the box itself, named from the leader label.
- **Host panel, groups on.** The groups are created without the preset's lobby: leaders are off after
  a switch-on, and the lobby is only used while they are on. Switch leaders and the **Captains
  lobby** switch on afterwards in Live settings. The picker counts the visible groups only.
- **Host panel, Switch preset.** The captains lobby is left out on both sides: a preset fits when its
  groups and kinds match the event's visible groups, with or without a lobby on either side. Applying
  it never creates, deletes, renames or resizes the event's lobby (so no channel is made or removed
  by it); the **Captains lobby** switch of Live settings owns that, with its own rules. A page shown
  before an update that still holds the old preset value is refused as out of date and reloads.

Everything on these pages is admin-only and audited
(`event-preset.create`, `.update`, `.delete`, `.toggle`, `.publish`, `.unpublish`).

An event keeps its own copy of its groups, and the preset's id is only a
reference: editing, renaming, switching off or deleting a preset never changes an
event that already used it, or the next occurrence of a recurring series.
Presets are identified as `builtin:<name>` (built-ins) and `lib:<id>` (the
server's own, an id that never changes when the preset is renamed or edited). A
submit naming a preset that is switched off or deleted is refused with a clear
message, never silently accepted. If the library cannot be read (database
trouble), the form fails closed: when the switches cannot be read no preset is
offered, when only the server's own presets cannot be read just the built-ins
that are on are, with a notice either way; Custom always works. A server that
never opens the page has every built-in on. The server's presets hold no member data, so
they are not part of the member data export (a host's personal presets are, see below).

**My event presets** (`/me/events/presets`, #1216) are a host's own pool of presets, next to
the server's. The host panel's **Live settings** section has **Save these groups as my
preset**, which opens the editor prefilled with the event's groups (names, kinds, sizes, tags,
markers, labels, lead time and the clan tags default; never members, leaders or channel ids).
Only the event's host can prefill from an event (its creator, or an admin, the same check as
the host panel). The page also lists the host's presets with **Edit** and **Delete**, and the
editor is the same as the server library's, so the same validation applies. A host keeps at
most 10 presets and a name is unique among their own (ignoring case); a built-in's name is
refused. Other hosts cannot see a host's presets, but server admins can see every host's
unpublished presets (name, description and groups) on the Hosts' presets card, because they need
that to publish one; the page tells the host so. A host sees only their own: another host's
preset is "not found" on this page, in the
panel's **Switch preset** list and in a posted preset id. Their own presets are offered next to
the server's, marked **(yours)**, in the host panel's preset switch (the same fit rules as
before) and, for an admin, in the schedule form's picker. Saving, editing and deleting are
audited as `event-preset.create`, `.update` and `.delete` with `scope: personal`.

An admin sees every host's presets under **Hosts' presets** on `/admin/events/presets` and can
**Publish** one (the card shows 100 presets a page, with Previous and Next). Publishing **copies** it into the server's presets (on, so everyone can pick
it), after the editor's validation is run again against the current group cap, and with the
library's own limit of 50 and unique-name rule. The copy has no owner: it keeps working, and
stays, when the host later deletes their preset or resets their data. A preset can have one
copy at a time; **Unpublish** deletes the copy (and any change an admin made to it; events
that used it keep their groups) and leaves the host's own preset alone. Both are audited
(`event-preset.publish`, `.unpublish`).

A host's personal presets are their own data: they are in the **member data export** and are
deleted by a **reset** (`/me/privacy`), through the per-user data registry. A host's own presets
are also offered where the host panel turns groups on for an event (**Groups**, under Live
settings), so a host who is not an admin can start an event's groups from their own preset.

**Clan tags** (#1194) are a per-event option on the schedule form (**Clan tags**, with an
optional **Put the tag after the name**), off unless ticked, and only for an event with
groups. While the event is **active**, each member of a **team** group that has a tag gets
it on their **server nickname**: `[RED] Alice` by default, `Alice [RED]` with the suffix
option. A team with no tag, and the open and leaders-only groups, are never tagged.
Members cannot opt out. Nothing is a command: the host only ticks the box.

- **When it applies:** when someone is assigned (Assign people, joining a group's channel,
  Randomise), moved to another team (the tag follows, built from their original
  nickname, never from the already tagged one), and when the event goes active with people
  already assigned. A pass after every scan (about once a minute) tags anyone still
  missing a tag. It needs `events.enabled`: with Events off nothing is tagged. That pass runs in
  the background, never inside the Events scan, so a slow Discord cannot delay starts, reminders
  or scheduled ends. Restoring runs on its own worker, once a minute, whether or not Events is on
  (it never tags): switching Events off therefore takes the tags off within a minute, and they
  come back when Events is switched on again. A tag typed with its own brackets (`[RED]`) is used
  as it is, never wrapped twice.
- **The original is always kept.** Before the first edit the bot stores the member's
  nickname (or "none", meaning their display name shows) in its own `event-nickname-backups`
  collection, and the tagged name is always built from that stored name. If the name is too
  long, the **name** is shortened, never the tag, to fit Discord's 32 characters. The backup
  also keeps every nickname the bot has set or may have set (a team move adds the new tag and
  keeps the old one), so a tag whose edit was never confirmed is still recognised as the bot's.
  A backup means the nickname may carry a tag; it is deleted as soon as the nickname is restored.
  An edit that timed out is not assumed to have failed: for a minute after the request was
  actually sent (not after it queued) the backup is left alone (it may still be in flight at
  Discord), then the nickname is read again and decides. A restore is treated the same way, so a
  restore whose answer was lost is never recorded as done.
- **Who cannot be tagged:** the server owner and anyone whose highest role is at or above the
  bot's role (Discord does not let a bot rename them). They are listed under **Clan tags**
  in the Groups card of the host panel, with the reason, and are not retried more than every
  ten minutes. Without the **Manage Nicknames** permission nothing is applied and the card
  says so; it applies the tags within a minute of the permission being given. One person
  can carry one event's tag at a time: someone still wearing another event's tag is listed
  as waiting and is tagged once that is restored.
- **When it is restored:** when the event ends (manual or scheduled; this is the
  end-of-event hook), when it is cancelled, when the member is unassigned or leaves the
  team (also after the event is over), and for a member data reset on `/me/privacy`. If the
  bot crashes, a restore that failed, or an event that ended while the bot was down, the
  startup reconcile and the pass after every scan restore every backup of an event that is
  not running any more, whatever its state. A restore that is refused (missing permission)
  or times out keeps the backup and is retried on every pass of the restore worker (a refused
  one with no waiting; the 10-minute pause between tries applies to tagging only); a person who left the server just loses
  the backup. The same happens when the group channels are cleaned up, because the scan
  that removes them runs the restore pass too.
- **A nickname the member changed themselves** is left alone: at restore, if the nickname is
  neither the tag the bot set nor the original, the backup is dropped and nothing is edited.
  The bot reads the member fresh from Discord for that decision, never from its cache. "The tag
  the bot set" is compared after one conservative normalisation (Unicode NFC, trimmed, runs of
  spaces collapsed; capital letters are never folded), because Discord may store a nickname in a
  slightly different spelling than the one requested. When an edit was never confirmed and the
  nickname then matches nothing the bot knows, it cannot tell a rename from a spelling it does
  not know, so it keeps the backup and looks again on the next passes; after three such reads
  (or a day) it treats the nickname as the member's own and leaves it alone. A stuck backup is
  safer than a lost original.
- **Pacing:** nickname edits go through `CommandManager.makeDiscordApiCall` and are queued
  600 ms apart, so a team of forty takes about half a minute. The wait comes BEFORE the bot
  reads the member's nickname, never between that read and the edit, so a nickname the member
  changes while the edit is waiting is seen and left alone (restore) or tagged from the new
  name (apply). The edit itself never waits either: if Discord rate-limits it, it is rejected
  and the whole decision is taken again from a fresh read on the next pass. One edit runs at a
  time, so a team cannot burst into Discord's limits. Once per pass the bot also checks that it
  still has Manage Nicknames, so a permission revoked mid-event shows on the host panel even
  when nobody needed an edit.
- **Member data:** the backup is the member's own data (`event-nickname-backup` in the
  member data export and reset). A reset restores the nickname first, then deletes the backup;
  if Discord refuses, the backup is deleted anyway and the reset reports that a tag may
  remain.
- **No privileged intent is needed.** The bot reads a member with a single REST call; the
  Server Members Intent is not used.

**Group voice channels** (#1190). At the event's channel creation time (its own, else
`events.create_lead_minutes`; "Start now" at once) the bot creates the main channel and
then one voice channel per group in the category the main channel is in (read from
Discord each time, so changing `events.category_id` while an event runs does not move
later channels, and nothing is created if that cannot be verified), in the group order, named
`<prefix> <colour marker> <group name>` (at most 100 characters; the prefix is
`events.channel_prefix`). A group's size is the channel's user limit; no size means no
limit. The event's host (its creator) gets View, Connect and Move Members on the main
channel and on every group channel, on top of whatever the category already grants (the
category's own permissions are copied, so a private category stays private). The channel
of the **Captains lobby** (a hidden `leads` group) is created restricted (see **Leaders-only channel** below). The channels
go when the event does: right away on cancel, and as soon as they are empty once it has ended
(through **End event now** or the scheduled end, both of which record when the event ended, see
"End the event" below); the main channel keeps `events.channel_grace_minutes` after that end. An
event that was ended before the end was recorded (an older row) keeps the old rule: the group
channels wait for the grace period after the scheduled end, like the main channel. A channel with
someone in it is never removed; it is left and tried again on the next scan. Only channels the bot recorded on
a group are ever deleted, and each is read from Discord just before. After a restart the
scan makes the record and the server agree: a group whose channel was deleted is created
again while the event is open, and channels recorded for a finished or cancelled event are
removed. Every pass collects what it could not do (a full category, a rate limit, a missing
permission) instead of stopping: the bot logs a standing problem once, and the last result is
shown as a warning in the Groups section of the host panel. Without **Manage Channels** the group channels are skipped and
the event runs with its main channel only; without **Manage Roles** or **Move Members** the
channels are created without the host's extra access. A create Discord refuses (a full
category, say) or rate limits is not repeated for a few minutes, so it cannot fire every scan.
A create that times out may still have gone through: it is not repeated for ten minutes, and
if Discord did make it, the unrecorded extra channel is not deleted by the bot (it only
deletes channels it recorded), so remove it by hand. Events without groups are created and cleaned up exactly as before.

**Group channel order** (#1214). The group channels belong directly below the main channel, in
the group order. They are created in that order, but Discord puts a new channel at the bottom of
its category, so after a pass that created channels (the first time, or one created again after
someone deleted it) the bot reads the whole server fresh from Discord and, if the voice channels
of the main channel's category are not in that order (equal positions are read by id, as discord.js does), writes the new positions with one bulk
request, after the same short pause the creates use. Only the event's own channels are placed. Another channel is
sent in that request only when it has to move down to make room, and then keeps its place relative
to the other channels. Voice and stage channels are ordered among themselves (text channels are
never touched). When a pass runs, a group channel found in another category is left there and the
host panel says so (that alone does not start a pass). Nothing is written, and the host panel says why, when the server or one of the
recorded channels cannot be read, or when the bot lacks Manage Channels in the category (it looks again after five minutes). The scan
also compares the order in the bot's own cache every minute (no Discord call) and starts a pass
when a group channel has been moved out of place, so a channel someone drags away is put back
within a minute or two; that also means a deliberate manual move of a group channel is undone.
A rate limit, a refusal or a timeout is shown in the Groups section of the host panel and the
write is tried again later (after the wait Discord gave, at least a minute; five minutes after a
refusal; ten after a timeout or any answer that was lost, since the outcome is then unknown), always after reading again first. If
a write went through but Discord still reports another order, the bot waits five minutes before it
tries again instead of repeating the request every scan. When the order is already right nothing
is written; and while the cache shows the order right the bot makes no Discord call for it.

The voice channel sweeps never delete a recorded event channel, even when the events feature is
switched off (turning it off only stops the scan), and they leave a channel alone for two minutes
after it is created, which covers a group channel that exists but is not recorded yet. This only
matters when events share the voice channels' category and managed-only cleanup is off.

The **host panel** (#1189) is the page where the person running an event manages
it, at `/me/events/<event id>/host`. It lives on the member surface (`/me`), not
under `/admin`, because the host is the event's creator, who may have signed in with `/me`
rather than `/config`. The creator signs in with `/me` like any member and finds their events
under **Your events** (Hosting), and their open ones under **Events you host** on the overview; admins open it from the **Host panel**
link on each row of the Events page. Who may open it:

- the member who created the event (through the schedule form), and
- an admin session, for any event of this server. An admin who signed in with
  `/me` instead of `/config` holds a member session and sees only their own events.

Everyone else gets a 403, with the same page whether the event does not exist,
belongs to another server or belongs to someone else. Every request is checked
against the live session, a state-changing request also needs the CSRF token, and
anything that cannot be read counts as "not the host". An event adopted from an
existing Discord event records the adopting admin as its creator but is not listed
under Events you host, and the panel never changes the Discord event itself.

The page shows a summary (state, start, duration, repeat, main voice channel) and the
event's groups. Scheduled and active events also show the team board and its toolbar (#1424, below), **End the event**, and two
folded sections at the bottom of the page (#1319, #1424): **Event settings** and **Change the groups**. Each summary states the current
values (the channel lead time, whether leaders and clan tags are on, and the number and names of the groups), and both open by themselves
after a settings save, so the result is in view (a board action such as an assignment does not open them). The page is part of the Hosting
section: its breadcrumb returns to **Your events**. Ended and cancelled events show the read-only summary only. Each action a host takes is
recorded in the audit log with the event id. The Web UI must be on and the member must be able to get a sign-in link (`/me`) to reach the page.

**The team board and toolbar** (#1424) replace the cards **Assign people**, **Move people**, **Leaders** and **Team names and tags** of the
host panel. No route, gate or audit row changed: every control is a plain form that posts to the action it always posted to, so the board works
with JavaScript off, and the same CSRF, creator-or-admin check and one audit row (`event.host.<action>`) apply. An event host with no other
rights can assign, randomise, move and send people from it, and gets a 403 on another host's event.

- **Toolbar**, in this order: the lock state (**Unlocked** or **Locked**, with **Lock groups** or **Unlock groups**, `lock`), **Randomise…**
  (`randomise`) and **Move people…** (`return-to-main` and `move-one`, and `pull-leaders` while leaders are on), then **Send to teams**
  (`send-to-groups`). **Randomise…** and **Move people…** are disclosures that work without script; with script each opens in a dialog (focus
  starts on _Go back_, Escape closes and focus returns to the button). A switched-off control stays visible, disabled, and the line under the
  toolbar says why (the bot cannot move members, the voice state cannot be read, no team has a channel yet). The same line says what the lock does.
- **Board**: one column per team group, then **Not in a team** for people connected to the event's voice channels who are in no team. Open and
  leaders-only groups are not columns. Each person shows where they are connected now (the main channel, or a team's channel) or _Not connected_
  (an assigned member who left voice stays in their team's column so they can still be taken out), and a leader carries a visible label.
- **Moving a person**: every person has a **Move** menu with a labelled team select (a full team is disabled, except for its own members) and two
  buttons, **Add to / Move to team** (`assign`) and **Not in a team** (`unassign`, posted with `formaction`). This is the keyboard and no-JavaScript
  path and the baseline. With JavaScript a person can also be dragged to another column: a drop fills in that person's own select and submits the same
  form, so a drop is exactly one `assign` or `unassign` and a refused drop (a full team) is announced in a live region. Moving a person between teams
  never moves them in voice; **Send to teams** is the explicit, separate action for that.
- **Leaders** (only while leaders are on): **Make leader** or **Remove as leader** in a person's menu (`set-leader`). The leader label rename
  (`leader-label`) and the last edits leaders made are under **Event settings**. A team a leader renamed shows **Reset name and tag**
  (`reset-team`) in its column.
- **Event settings** (fold) holds the channel lead time, **Group leaders** and **Clan tags** (children nested) and the leader label; **Change the
  groups** (fold) holds names and sizes, **Switch preset**, add and remove groups, and switching groups on or off. They are separate forms that
  post to `settings`, so saving one never touches the other's rows. The lock row of the settings form moved to the toolbar.

The sections below describe what each action does. Since #1424 the cards **Assign people**, **Move people**, **Leaders** and **Team names and tags**
are the board and toolbar above (same actions, same rules), and **Live settings** is the two folds **Event settings** and **Change the groups**.

**Assign people** (#1191) puts members into the `team` groups of an event. Open and
leaders-only groups never take members. The section lists everyone connected to the
event's voice channels (the main channel and any group channel; bots left out) with
their group, plus anyone already assigned who has left voice, so they can still be
unassigned. Each group shows how full it is, for example "Heli 2/2" or "Assault 5"
when it has no size.

- **Assign / move / unassign:** pick a group for a person, or take them out. A group
  that has reached its size refuses with a clear message. You can only add someone
  who is connected right now; if the bot cannot read who is in the voice channels,
  adding and randomising are off and you are told so (unassigning still works).
- **Self-join:** a member who joins a team group's voice channel is recorded as a
  member of that group, and moving to another team channel moves them. Joining the
  main channel, an open channel or any other channel changes nothing. A full group
  does not take them. A member who has opted out of tracking, or is being reset, is
  not recorded. (The group channels are created by the event's channel lifecycle, see
  **Group voice channels** above; until a group has a channel there is nothing to join.)
  Self-joins are not audited.
- **Lock groups:** a switch for this event. While locked, joining a group's voice
  channel does not record or change anyone's group: a member who hops channels keeps
  their stored group, and a newcomer is not recorded. Nobody is moved either: the
  person stays in the channel they joined, unassigned, and you assign them by hand
  on this panel. The host's own changes still work. A repeating event's next
  occurrence starts unlocked.
- **Randomise:** deals the people connected right now into the team groups, either
  only those who are not in a group yet or everyone again (people who are assigned
  but not connected stay where they are and keep using their group's room). The
  split is always even: groups end up within one person of each other. A group's size
  is a hard limit: a full group is skipped, and once every group is full the rest stay
  unassigned and are listed in the result. The deal uses a random
  seed that is written to the audit row, so a result can be reproduced.
- **Limits:** a person is in at most one group; a group holds at most its size, or 99
  without one; an event holds at most 500 assigned people.
- **Leaders:** when the event has leaders switched on, a person who leads the group they
  are in shows a badge with the event's leader label. Taking a leader out of their group,
  or moving them to another group, ends their role (see **Leaders** below).
- **Kept:** an assignment is kept when someone leaves voice, until they are
  unassigned. Assignments stay on a finished event as history. A member's data
  export lists their own group of each event, and resetting their data on
  `/me/privacy` removes them from every group of every event, finished ones too.
- **Audit:** each host change is one audit entry (a randomise is one entry with
  counts, not names).

Assigning only changes KoolBot's own records; it moves nobody and writes nothing to
Discord, so it also works for adopted events.

**Move people** (#1192) moves members between the event's voice channels: the quiz
and workshop flow of splitting into groups and coming back. It needs the bot to hold
**Move Members**; without it (or when the bot cannot read who is in the voice
channels) the buttons are disabled and the section says why, and the same checks run
again when a button is pressed. It only runs while `events.enabled` is on and the
event is scheduled or active.

- **Send to groups:** every person assigned to a team group who is connected to one
  of the event's voice channels goes to that group's own channel. Open and
  leaders-only channels are never targets. Assigned people whose group has no
  channel yet are not moved (the result says how many). Connected people who are
  not assigned stay where they are.
- **Return to main:** everyone connected to a group channel goes to the main
  channel, `open` and leaders-only channels included. Tick **Leave people in open and
  leader-only channels where they are** to skip those. People already in the main
  channel are not touched.
- **Move one person:** pick a connected person and the main channel or any group
  channel that exists. A channel that has reached its size refuses. The
  leaders-only channel takes only the host and a current leader: asking for anyone
  else is refused (the channel's own upkeep would move them straight out again).
- **Who is skipped:** only people connected to voice can be moved, and only out of
  the event's own channels: someone who is not connected, or who is in a channel
  that is not part of the event, is skipped and listed. The size check reads who is in
  the channel at that moment, after the person's voice state was read and again
  just before the move, so someone who joined or left meanwhile counts. People
  moved there earlier in the same run count even before the bot sees them arrive,
  and a move Discord did not confirm keeps a place at the destination but does not
  free the person's old one. Those bookkeeping entries last only until the bot's
  voice cache shows the change, so anything a person does afterwards (going back
  to where they were) counts as it happens. The count is the bot's voice cache
  plus these entries, not Discord's own count, so a join or leave the bot has not
  heard about yet is not in it; Discord has the last word when the move is sent.
  The event's creator and the person pressing the button are never moved by Send to
  groups or Return to main (they can join any channel themselves); Move one person
  does move the person you pick, you included.
- **The result** is one message, kept inside the Web UI's 500-character flash. It
  starts with how many were moved, then the warning for any move Discord did not
  answer in time ("may or may not have moved: check Discord before trying
  again"), then how many were skipped for each reason (not connected, in another
  channel, group full, missing permission, error), then any extra note, and last
  as many error explanations and names as still fit (explanations first, then names,
  people whose move was not confirmed first). A long explanation or list of names
  is shortened ("and N more") or left out, never the counts, the warning or the
  extra note. A rate limit that Discord says would last more than 20 seconds stops the
  run (the request is not sent or repeated; shorter waits are waited out)
  and lists the rest as not attempted. One run reads the voice state of, and moves, at most 60
  people, so the page does not wait for minutes; the rest are listed as not
  attempted and you press the button again. People the bot already sees in the
  right channel, not connected, in a channel outside the event, or aimed at a
  channel that is full right now, or one the bot cannot connect to or move out of
  according to its cached permissions, are skipped without a request and do not count
  towards the 60, so the second press gets past the people the first one moved.
- **Pacing and safety:** each person who still has to move is checked against Discord's own voice state and
  moved one at a time, about half a second apart, through the bot's rate-limited
  request path. A move is never repeated after a timeout. Every destination is
  read from Discord before anyone is moved into it, and the person's channel is
  checked once more against the live voice state just before the move. The
  voice-state read is the raw answer from Discord and never overwrites the bot's
  own gateway state, so a person who has since moved to another channel is not
  pulled back out of it. A move that has to wait for a short rate limit is checked
  again at the moment its request really goes out (the person still in one of the
  event's channels and not already in the destination, the destination not full), and
  dropped if that no longer holds. A person who joined the destination on their own
  while the bot was reading their state is listed as already there, not moved.
- **One run at a time:** while a run is going for an event, a second press answers
  "a move is already in progress" and moves nobody. Live edits of a running event
  will share this lock.
- **Moving never changes a group.** A move is not a self-join: the bot marks the move
  before it asks Discord, and the voice join it causes is ignored by the group
  self-join (whether groups are locked or not), once, for that channel. Every move
  attempt has its own mark, so a later attempt for the same member, to the same
  channel or another one, never cancels the mark of an earlier move that Discord
  did not confirm, and an attempt that Discord refuses clears only its own mark.
  Each mark covers one join. Which group
  a person is assigned to changes only on **Assign people**, so moving someone into
  another group's channel leaves them assigned to their own group, and Send to
  groups always moves people to the room of the group they are in now. The mark
  lives about 90 seconds, in memory: after a restart in the middle of a run the
  remaining joins count as the members' own.
- **Audit:** each press is one audit entry with counts (moved, skipped by reason,
  not confirmed), no names. Move one person also records the person's id.

**Leaders** (#1195) is a section of the host panel, and a column of the Groups card, only while
the event has groups and **Group leaders** was ticked on the schedule form. With it off
nothing about leaders shows, and setting a leader, renaming the label and pulling leaders
refuse. (Leaders can be switched on or off at any time in **Live settings** below. A repeating
event's next occurrences keep the switch the series was made with, or the one saved with the tick
**Also for the next occurrences** (see **Repeating events keep the group setup**), never the leaders.) It
also needs `events.enabled`: setting a leader and pulling leaders refuse while it is off.

- **Set the leader:** each team group has a picker of the people assigned to it, with a
  "no leader" choice. The leader must be a member of that group, so assign people first
  (they do not have to be connected). There is at most one leader per team group; an open or
  leaders-only group has none; choosing someone else replaces the leader in one change. The
  check is repeated inside the same per-event lock as every membership change, against the
  event as it is at that moment, and again in the database write itself, so a person who
  was unassigned a moment earlier is refused ("a leader must be a member of the group").
  A member whose data reset is running is refused, like adding them to a group.
- **What leaders are called:** the event's leader label (Leader by default, from the form or
  a preset) is used on the page. **Rename** changes it for this event only (up to 20
  characters, empty goes back to "Leader").
- **Unassigning ends the role.** A leader stops being leader when they leave their group:
  the host unassigns them or moves them to another group, a randomise deals them elsewhere
  or nowhere, they join another group's channel, or they reset their data. This is a step
  that runs right after the membership change and decides from the event as it is then,
  under the same lock: a person who was put back into the group before it ran stays
  leader. If that step ever fails, the stored id is still ignored: a leader who is not a
  member of the group is not shown as a leader and is never pulled.
- **Pull leaders only:** moves every connected leader to one channel, for a briefing.
  Everyone else stays where they are. **To:** the default is the leaders-only channel
  when the event has a `leads` group with a channel (see **Leaders-only channel**
  below), otherwise the main channel, otherwise the channel you are in; or choose the main channel, **the channel I am in**
  (the event channel you are connected to now), or any group's channel. The destination is
  posted as a word or a group key, never a channel id. It is the same mover as **Move
  people**, so everything there applies: it needs **Move Members** and `events.enabled`,
  checks the person's real voice state first, moves one person at a time through the
  rate-limited path, moves at most 60 per run, never replays a timed-out move, skips and
  lists a leader who is not connected, is in a channel outside the event, or is in a full
  destination, and reports the result in one message. The event's creator and you are never
  moved, even as a leader. A pull and a **Move people** run share one lock: a second press
  answers "already in progress". The plan is made from the event as it is when the run
  starts: someone unassigned before that is not moved, and someone unassigned while the
  run is waiting on Discord is still moved once (the move is not a group change, so they
  are not put back).
- **Moving changes no group or leader.** A pull marks each move like any other move, so
  pulling a leader into another team's channel does not record them in that team, and
  they stay leader of the group they are assigned to.
- **The leaders-only channel follows leader changes (#1199):** every leader change (host
  set or clear, the unassign step, a reset, the end of the event) is announced to a hook
  (`onLeaderChange`) after it is written, and the leaders-only channel listens (see
  **Leaders-only channel** below; a pass ignores an event that is not open). The hook
  names the id that was stored as leader before the change,
  even a member who left the group an instant earlier and whose cleanup had not run, so a
  replacement made in between still reports who lost the role. After a randomise or other
  burst of unassigns the clearing step runs as one pass, not once per person.
- **Not shown in the event post.** Leaders appear on the host panel only.
- **Member data:** a leader's id is the member's own data: their export lists the event and
  the group they lead (never other leaders), and resetting their data on `/me/privacy`
  clears it in every event, finished ones too. Ending the event (**End the event**, below, and
  the scheduled end) clears every leader of that event; a cancelled event, and an event that
  ended before the end cleared leaders, keep theirs until that member resets.
- **Audit:** `event.host.set-leader` (with the group and the person's id),
  `event.host.leader-label` and `event.host.pull-leaders` (counts and the destination
  word, no names). The step that ends a role after an unassign is not audited on its own;
  it follows an audited unassign, an audited randomise, an unaudited self-join or a reset.

**Team names and tags** (#1196) is a section of the host panel for every event with groups. It
is about the **Leaders can customise** switch of the schedule form (off by default, and only
used while **Group leaders** is on). With it on, each team's own leader can rename the team and
set its clan tag from Discord; the host can put any team back at any time.

- **The button.** While the event is open and both switches are on, the bot posts one
  **Customise team** message in the chat of each team group's voice channel. It names nobody
  and pings nobody. The bot finds its own message again after a restart instead of posting a
  second one, and removes it (and forgets it) when leaders or customising are switched off, so
  no button is left behind (switches can only be changed after creation once live settings,
  #1197, land; until then this happens when the event ends and its channels go). The scan posts
  a missing message and removes an extra one; it checks that a recorded message still exists
  once per run of the bot, so a message a moderator deletes by hand comes back after the next
  restart. While `events.enabled` is off the scan does not run, so a button stays but only
  answers that events are off. A post Discord refuses (the bot cannot send messages in that
  channel) is shown in the group notices and tried again later.
- **Who may use it.** Only that team's current leader, for that team only. Anyone else (another
  team's leader, a team member, a stranger, a host who is not the leader) gets a private
  message saying so. The check made when the button is pressed is only a courtesy: it is made
  again when the form is **sent**, from the event as it is then, inside the same per-event lock
  as every leader and membership change, and the database write carries the same conditions
  (this team, this leader a member of it, leaders on, customising on, event open). A leader
  removed, a switch turned off or an event that ended while the form was open is refused, and
  nothing is stored.
- **What can be changed.** The team's name and, while the event uses **Clan tags**, its tag.
  Same rules as the schedule form: names 1 to 50 characters and unique within the event
  (case does not matter), tags up to 8 characters or empty, no control characters, spaces
  collapsed. A team a leader renamed keeps its original name reserved, so no other team can take
  it (a reset can then always go back). Mistakes are explained privately and nothing is stored.
- **Renaming the channel.** The stored name is what counts; the team's channel is renamed after
  it. Discord allows about 2 renames per channel every 10 minutes, so a leader who has used
  them is told when to try again ("about 7 minutes") and nothing is stored; if only the tag
  changed too, the tag still applies. Nothing ever waits for the limit inside the form. If the
  rename itself fails (Discord refuses, or does not answer), the name stays stored, the host
  panel shows "channel rename pending" and every scan tries again; a rename that did go
  through is recognised by reading the channel, not by renaming it twice.
- **Tags.** A changed tag moves the nicknames of the team's members through the same step as
  every other tag change (always from the stored original nickname, never from the current
  one), in the background; the leader is told it can take a little while. The server owner,
  and anyone whose top role is not below the bot's, can never be tagged by a bot.
- **The host's reset.** The section lists each team with what the host set before a leader
  changed it. **Reset** puts the original name and tag back (also with the leader switches off, but
  only while `events.enabled` is on, otherwise it refuses and changes nothing),
  renames the channel and moves the nicknames back. The original is
  stored the first time a leader changes the team, so it works for Custom events as well as
  presets. A reset is refused when another team now has that name; reset that team first. A
  team nobody changed says so and writes nothing. Names and tags a leader chose are kept when
  leaders or customising are switched off.
- **A repeating event's next occurrence** starts from the names and tags the host set, not from
  a leader's changes (see **Repeating events keep the group setup**).
- **Who changed what.** Each change a leader makes from Discord is one audit entry
  (`event.leader.customise`, under the leader's own id, with the team's key and the old and new
  name and tag), and the section lists the ten most recent. The host's reset is
  `event.host.reset-team`.
- **Member data.** Nothing new is stored per member: the name and tag belong to the team. The
  audit entry carries the leader's id like any other audit entry (the audit log is kept; see
  the data registry note on `web-audit-log`).
- **Changing the switches after creation** is done in **Live settings** (#1240, see **Leaders
  and tags in Live settings** below). The checks above already read both switches at the moment
  of use, so flipping them while a form is open is safe.

**Live settings** (#1239) is the section of the host panel where the host changes the settings of
a running event and saves once. It is the first step of live editing (#1197); the rows below work
today, and a later step adds a group's kind as another row of the same form. Leaders and clan tags are described under **Leaders and tags in Live
settings** below,
names, sizes and presets under **Group names, sizes and presets** (#1241), and adding and removing
groups under **Adding and removing groups** (#1242), and switching groups on or off under
**Groups on or off** (#1243).

- **What can be changed now.** The **channel creation time** (minutes before the start, empty
  for the server default) while no channel of the event exists yet; once the main channel or any
  group channel exists it is shown as text and cannot be changed. **Lock groups** on or off (the
  same switch as in Assign people), for an event with groups. The leaders and tag fields are
  described under **Leaders and tags in Live settings**; the **name** and the **size** of each
  group, and a **preset switch**, under **Group names, sizes and presets** below, and **adding and
  removing groups** under **Adding and removing groups**, and **groups on or off** under **Groups on
  or off**. A group's kind is not editable here yet.
- **One save, one result.** Save plans from the event as it is at that moment, inside the same
  per-event lock as host moves and membership changes, so a save and a bulk move never run at
  the same time (the second answers that one is already in progress). Only the fields you
  changed are written: each field of the form carries the value it showed, so saving an
  unrelated field never puts back a value somebody else changed meanwhile. A field somebody
  else changed while the form was open is reported ("was changed by someone else") and left
  alone; the other fields still save. The result lists what was saved and anything that was
  not, and saving the same form again converges: what is already applied reads "already
  applied", and a form with nothing to change says so. A change that is stored but whose
  follow-up is not finished (a later step's channel rename that Discord refused, for example)
  is listed as "saved but not finished" with what is still owed, and saving the same form
  again finishes it.
- **The channel creation time and channel creation.** The save is refused once a channel
  exists. A channel that is being created at that very moment is handled too: the scan only
  records a new channel when the creation time is still the one it decided from, so a shorter
  or longer time you saved meanwhile wins, the new channel is removed again and the next scan
  decides from the saved time.
- **Refused, and nothing changed,** while `events.enabled` is off (or cannot be read), for an
  ended or cancelled event, and for an event that is being ended. The section then shows why
  instead of the form.
- **Confirmation.** A change that needs confirmation (switching a preset that renames groups,
  removing a group, and switching groups off) is answered with a confirmation page that lists exactly what will change and
  why, and nothing is applied until you confirm. The page carries a signed token, made with the
  Web UI session secret, that binds the event, the server, your sign-in, a ten minute expiry
  and the exact set of changes. Confirming plans again from the event as it is then and applies
  only when that is exactly the confirmed set: a token for another event, another person or
  another change, an expired one, one used a second time (also after the value was changed back
  in between: every save through Live settings counts on a revision number stored on the event,
  and a token only works at the revision it was issued at), and one for an event that changed
  since the page was shown all apply nothing. Without a session secret a change that needs
  confirmation is refused. There is no browser-only confirm dialog: with JavaScript, the two forms
  that the server always confirms ("Switch groups off" and "Remove selected") show that same
  confirmation in a dialog instead of a page. The script posts the form with `fetch` and the
  header `X-Kb-Confirm-Only`, and the server then either answers with the confirmation page or
  changes nothing (it refuses a plan that needs no confirmation before it claims the revision or
  writes). The script opens the dialog only for the expected page (status 200, HTML, the
  server-only response header `X-Kb-Confirm-Page` and the page marker), reads the reasons and
  changes from it as text, and the dialog's confirm button posts the page's own `_csrf` and
  `token` to `settings-confirm`. Any other answer shows a message and posts nothing. Without
  JavaScript (or `<dialog>`) the form posts as before and you get the confirmation page.
- **Groups over their size** (more people than the size, after a size is lowered) are
  shown with an "over size" mark in the section's table. That state is worked out each time from
  the member count and the size; it is never stored.
- **Audit.** Each save is one audit entry, `event.host.settings`, with the outcome (`applied`,
  `partial`, `not-applied`, `nothing-to-do`, `invalid`, a refusal code or `needs-confirmation`)
  and the changed fields with their old and new values; confirming is one entry,
  `event.host.settings-confirm`. A repeating event's next occurrence starts from the creation
  time saved here (with or without groups); unlike the rest of the group setup, that time is not
  part of the tick **Also for the next occurrences**.
- **Nothing new is stored per member.** The only new stored value is that revision counter on the
  event itself; the confirmation token is checked and then compared with the event.
- **While an end or cancel holds the event** the section shows that instead of the form.

**Leaders and tags in Live settings** (#1240) are six more fields of the Live settings form,
shown for an event with groups. They can be changed at any time while the event is scheduled or
active, by the host, and none of them asks for a confirmation (they are switches, and each can be
switched back).

- **Leaders** on or off. On makes the Leaders section and the leaders column appear and leaders
  appointable. Off hides all of that, removes the leaders-only channel access at once (the same
  pass the scan runs: overwrites first, then anyone who must leave is moved out) and removes the
  Customise buttons. **Who was chosen is kept** and comes back when leaders are switched on again;
  nothing is cleared. **What leaders are called** ("Captain", "Squad Lead") is a field of its
  own; it can be set in the same save that turns leaders on.
- **Leaders may rename their team and set its tag** (customisation) on or off. Off removes the
  Customise button at once, and a form a leader already has open is refused when it is
  submitted ("customisation is off", checked from the event as it is then, see **Team names and
  tags**). The names and tags leaders chose are **kept**; the host's reset in the Customise
  section is what puts the originals back. The switch only has an effect while leaders are on, so
  it can be set before or together with leaders (a save that turns both on is valid in any
  order, and one that turns leaders off ends customisation too without changing its stored
  value).
- **Clan tags on server nicknames** on or off, **where the tag goes** (before or after the name)
  and **the tag of each team** (empty means none). Turning tags on backs up each member's original
  nickname and then tags them; turning them off restores the originals now; changing a tag or the
  position re-tags from the stored original, so a name is `[SKY] Alice` and never
  `[SKY] [RED] Alice`. This is the one nickname logic of **Clan tags** (it never builds a name
  from the current nickname). A tag edited here on a team a leader customised also becomes that
  team's original tag, so the host's reset does not bring back a tag the host has replaced.
- **Nicknames follow in the background.** The save stores the switch or tag and answers; the
  nickname work then runs on its own, paced at about two edits per second, so a big team takes a
  moment and the result text says "nicknames follow in the background". No lock is held while
  it runs, so a bulk move or a membership change never waits for it. A member whose last edit
  has an unknown outcome stays untouched for a minute (the **Clan tags** settle window) and is
  finished by the next pass, which the Events scan also requests every minute: a switch flipped
  back and forth, or a tag changed twice in a minute, ends with the right tag, once. Tag edits
  never use the channel rename queue (that is for channel names only).
- **The Discord passes follow the save, after its locks are released.** A leaders save asks for one
  leaders-only channel pass and one pass over the Customise buttons; a customisation save asks
  for the buttons pass. They decide from the event as it is then, not from what changed, and a
  pass that fails is logged and repeated by the scan (it never turns a stored switch into a
  failed save).
- **Same rules as the rest of Live settings.** Each field posts the value it showed with the new
  one and only changes when the host changed it; the write is conditional on that value, on the
  event being open and on its server, from a fresh read inside the locks; saving the same form
  again says "already applied"; one save is one result and one `event.host.settings` audit
  entry; everything is refused while `events.enabled` is off or while the event is being ended.
  The team tags of one save are written together or not at all (a tag somebody changed while
  the form was open is reported and none of the save's tags is written).
- **Nothing new is stored per member.** The fields already existed on the event; there is no new
  member data (nicknames are backed up in the existing nickname backup, which the data export and
  reset already cover).

**Group names, sizes and presets** (#1241) are rows of the Live settings form. The form shows one
name field and one size field per group, with the people count next to them, and a separate **Switch
preset** form under it.

- **Rename a group.** The group keeps its members, its leader and its channel; the channel is renamed
  in place. Discord allows about 2 renames of one channel per 10 minutes, and KoolBot never waits for
  that: the shared rename budget (the one a leader's rename uses) answers at once. If the budget is
  used up, or Discord refuses (a missing permission) or does not confirm, the new name is saved
  anyway and the result says so, with the time to wait: "Saved but not finished: Name of group 2 is
  now ... (the channel is not renamed yet: ... about 7 minutes ...)". The scan renames the channel
  by itself when the budget is back, and saving the same form again tries at once. A name another
  group has, or another group goes back to when its leader's rename is reset, is refused (compared
  without regard to case). Two renames in one save to the same name give the first and refuse the
  second.
- **What happens to the stored original of a renamed group.** The host's edit becomes the new
  original: when a leader had renamed the group (it has an original name), the original name is set
  to the name you typed and the original tag is kept, so the host's "Reset" of that team goes back
  to your name; when nobody had renamed it, there is no original and the stored name is the
  original, which is the name a repeating event's next occurrences get once the setup is saved for
  them with the tick **Also for the next occurrences**.
- **Change a size.** The size is the most people the group takes and its channel's user limit (1 to
  99, empty for no limit). The channel's limit follows through the same kind of pass as the rename
  (one attempt, never waiting on a rate limit, finished by the scan if Discord refused). Lowering
  a size below the number of people moves nobody: they stay where they are and the group is marked
  **over size**. Over size is worked out on every page load from the people count and the size and
  is never stored. An over-size group takes nobody new (host Assign people, a join to its channel
  and Randomise all see it as full) until it is below its size again; people can still leave it.
- **Switch preset.** Choose a preset (the server's enabled presets that have the same number of
  groups and the same kinds as the event, not counting the captains lobby on either side; a preset
  never changes the event's lobby, #1263) and its names, sizes and default tags are applied to the
  existing groups by position, in one write. The presets are read from the server's library when the
  page is shown and again when you save; what you confirm is exactly that content, bound into the
  signed confirmation, and nothing a browser posts is taken as the content of a preset. Every name
  that would change is shown on the confirmation page first, including names the host or a leader
  chose by hand. A group's leader customisation (its original name and tag) is cleared by the
  switch, because the preset is the new baseline, and the nicknames of its members are brought in
  line with the new tag in the background when tags are on and the event is running. A preset with
  another number of groups, or one that would change a group's kind, is refused: adding and removing
  groups (see **Adding and removing groups**) and changing a kind also move members and change
  channel access, and are separate changes.
  Do not change names or sizes in the same save as a preset switch: the switch applies only to groups
  as they were when you looked, so it is listed as not saved and you run it again.
- **Counted like every save.** A leader's rename or tag change, and the host's reset of one, also
  move the event's revision number, so a confirmation page shown before such a change can never be
  used afterwards (not even when the leader's change was reversed in between).
- **Audit.** One entry per save (`event.host.settings`, or `event.host.settings-confirm`), with the
  changed names, sizes and the preset content as old and new values (one flat line per group), and
  what is still owed to a channel. A save of more than 45 rows (every name and size of 25 groups)
  continues its lists in `changes2`, `stored2` and so on, with the full count in `changesTotal`:
  nothing is dropped by the audit bound.
- **Long results.** A result too long for the one-line message after a save (a large preset
  switch with channels still to finish) is shown on a full result page, with every unfinished
  channel and when to retry, and a link back to the panel.
- **A scan that finishes first.** If the scan renames a channel or sets its user limit between
  your save and the follow-up, the save reports it as done, not as unfinished.

**Adding and removing groups** (#1242) are two more forms under the Live settings table, shown for
an event with groups. Each is its own form, so it never shares a save with the name and size fields
(which are addressed by position; these name a group by its key). The size fields also remember which
group they were shown for: a size form that was open while a group was added or removed, and whose
position now holds another group, is reported as changed by someone else instead of resizing the group
that moved there.

- **Add a group.** Give it a name, a kind (team or open; the leaders-only channel is the **Captains
  lobby** switch below), a size and a tag, with the same limits as when the event was made (a name
  another group has, or goes back to when its leader's rename is reset, is refused;
  `events.groups.max_count` applies). It goes
  last. Its voice channel is made by the same pass as the other group channels, next to them and in
  order, and every other group, every
  assignment and every leader stays exactly as it was. Nothing is confirmed: it destroys nothing. Each
  page load mints the new group's key, so posting the same form twice is one group: the second post
  says "Nothing to change" (or finishes a channel that was still owed). If the channel could not be made
  (a full category, a missing permission) the group is saved and the result says "Saved but not
  finished: ... its channel is not created yet ...": the scan keeps trying every minute, and posting
  the form again tries at once. An event whose channels do not exist yet makes the new group's channel
  with the others later.
- **Remove groups.** Tick the groups and submit. You are always asked to confirm first; the page names
  each group, how many people are assigned and whether it has a channel, and says what happens. Per
  group, in this order: **(1)** everybody connected to the group's channel, you included, is moved to
  the main channel (the same mover as **Move people**, one at a time, never replayed; the bot needs
  Move Members, in the events category is enough); **(2)** the group's members are unassigned, which
  is the same step as a host unassign, so their clan tags are taken off their nicknames by the one
  tag function from the stored original (a nickname is put back once, never tagged twice and never
  lost; one the member changed by hand is left alone) and a leader of the group stops leading, losing
  access to the leaders-only channel; **(3)** the channel is deleted and the group is taken out of the
  event, in one step under the channel lock, only with nobody connected and only under the channel id
  that is recorded (a channel the scan recreated in the meantime is not orphaned: the removal is then
  reported as changed meanwhile and a second try deletes that one).
- **If somebody cannot be moved** (missing permission, Discord rate limiting, more than 60 people
  in one run, a bot that is connected) **nothing is removed for that group**: it stays with its
  members, its leader and its channel, and the result names how many and why. Save again to move the
  next batch, or ask them to leave. (The issue asked for the channel to stay "until empty"; the group
  stays with it, because a channel of a removed group would have no record and no pass could delete it
  later.)
- **If the channel cannot be deleted after the members were unassigned** the group stays, empty, and
  the result says "Saved but not finished"; posting the same removal again moves anyone who came back,
  announces nobody twice and finishes it. A group is never removed from the event before its channel
  has been deleted, and the last group of an event is never removed (turning groups off is **Groups on or
  off**, below).
- **Counted like every save, and one audit row.** The removal is confirmed through the signed token
  of the other confirmations, which names the group keys, and a replay applies nothing. One
  `event.host.settings` entry per post (`event.host.settings-confirm` for the confirmation) lists the
  keys (or the added group as one flat line) and what is still owed.
- **Nothing new is stored per member.** A removed group takes its member list with it, like an unassign;
  the member data export and reset already cover the member lists and leaders of the groups that
  remain.

**Captains lobby** (#1251) is one switch, off by default, on the schedule form (a tick box next
to **Group leaders**) and in **Live settings** (next to the leader settings). It is the
leaders-only channel of the next section, set up as what it is: an automatic lobby for the host and
the captains, not a team that people join. Nobody is assigned to it: who may join is always derived
from the host and the current leaders.

- **Needs leaders.** The switch is only used while **Group leaders** is on. On the schedule form the
  box is disabled until leaders is ticked, and the server ignores it without leaders. In Live
  settings turning it **on** is judged against leaders as the same save leaves them: leaders on and
  the lobby on can be saved together (leaders are applied first), and the lobby on with leaders
  off, or leaders switched off in the same save, is refused. Turning it **off** is always possible.
- **Nothing to configure, nothing visible in the group list.** The lobby is stored as a hidden group
  of kind `leads` in the event's groups (so the channel pass, the cleanup and the repeating series
  keep working unchanged), and the switch is read from the presence of that group: there is no
  separate stored flag and no setting. The group is not listed in the Groups card of the host
  panel (one line under it says whether the lobby is on and whether its channel exists), has no name or
  size field in Live settings, no remove tick box, no kind choice, and does not count as the group
  an event keeps. It is named after what leaders are called ("Leader lobby", "Captain lobby"), and
  counts toward `events.groups.max_count` because it is a channel.
- **On** creates the restricted channel at once on a running event, through the same pass as every
  group channel. Its name and the group limit are decided from the event as it is after the other
  changes of the same save (a leader label or rename in the same save is taken into account, a
  group added in the same save counts toward the limit), and the write holds "leaders still on",
  "this many groups" and "no leaders-only group yet", so there can never be two. Then brings the channel's access
  in line: only the host and the current leaders can join. An event that has not started makes it
  with the other channels later. If the channel could not be made (a full category, a missing
  permission) the result says "Saved but not finished" and the same form saved again finishes it.
- **Off** moves everybody connected to the lobby, you included, to the main channel (the same mover
  as **Remove groups**), then deletes the channel and the group in one step. You are asked to confirm
  first when anybody is connected to a voice channel of the event (its main channel, any group's or
  the lobby's), read from the gateway's voice states with no extra Discord request; with nobody
  connected it is removed without asking, even though the channel exists. The confirmation is bound
  to that answer: if somebody connects between the page and your confirmation that needed none,
  nothing is applied and you are asked again, and a channel recorded meanwhile that the page did
  not show is not touched (save again to be asked). If somebody cannot be moved, or the channel cannot be deleted, **nothing
  is removed**: the lobby stays, the result says why, and saving again plans the removal again. Turning
  it on again later makes a new, empty channel. If an end or cancel takes hold of the event during the
  removal, the group's record is left for the end to clean up.
- **An old event with only a leaders-only group.** An event saved with nothing but a `leads` group
  keeps it when the lobby is turned off, because an event keeps at least one group; the result says
  so. Add a group first, or use **Groups on or off**, which removes everything.
- **Leaders turned off while the lobby exists.** The lobby is kept (stored data is kept, the
  switches hide it), but with leaders off nobody but you is let in, and any leader connected to it
  is moved out by the usual pass. Turn leaders on again and the current leaders get access again;
  turn the lobby off to remove its channel.
- **Presets and old events.** A preset or event that already has a `leads` group keeps working
  unchanged: the switch shows on, the group is the lobby, and at most one `leads` group is allowed
  (the form, the add-group form and the write itself all refuse a second). Choosing such a preset on
  the schedule form ticks **Captains lobby** instead of adding a row for it, and the preset editor
  shows its `leads` row as the same tick (#1263). Applying a preset in Live settings compares the
  visible groups only, so a preset with a lobby fits an event without one and the reverse, and it
  never creates, removes or renames the lobby.
- **Same rules as the rest of Live settings.** The event is read again inside the locks, the switch
  is written conditionally on what it was decided from with an explicit outcome, a re-save is
  "nothing to change", one result and one `event.host.settings` audit entry per save, and nothing
  changes while `events.enabled` is off.

**Groups on or off** (#1243) is the last step of live editing: the host switches the groups of a running
event on or off. It has its own forms at the end of the Live settings section, so it never shares a save
with the name and size fields, and it is shown whether or not the event has groups (an adopted Discord
event, which KoolBot only reads, never gets groups). The row is applied after the other rows of a save.

- **Groups off, always confirmed.** The confirmation page lists the groups, who is assigned and which
  have a voice channel. Then, in this order: **(1)** everybody connected to any group channel, you
  included, is moved to the main channel (the same mover as **Move people**, one at a time, never
  replayed; Move Members in the events category is enough); **(2)** only when every group channel is
  empty, all of them are deleted and the groups are stored as off, in one step under the channel lock,
  each channel only with nobody connected and under the id that is recorded; **(3)** the clan tags come
  off the nicknames, started in the background as soon as the groups are off (the tag function reads the
  stored state, so it cannot restore before the switch, and it needs no channel). The issue words the
  order as "return everyone, restore tags, delete the channels"; the tags follow the switch by a few
  seconds because of this, and nothing depends on the channels.
- **Assignments are kept as history.** The groups stay in the event with their members, leaders, names,
  sizes, tags and markers; only the channel ids are cleared. While groups are off nobody counts as in a
  group: no assignment, no tag, no leaders-only channel and no group channel pass looks at them. The
  member data export and reset still cover those lists. The switch, the confirmation, the revision
  count and the audit row work like every other Live settings save.
- **If somebody cannot be moved, nothing is deleted and groups stay on.** This is the rule of removing a
  group, applied to the whole event: a channel deleted while the groups are still on would be made again
  by the next scan, and a channel left behind once the groups are off would never be deleted by
  anything (every pass that removes group channels, including the end of the event, only runs for an
  event with groups on, and only a channel that is recorded is ever deleted). The result names the
  group and how many people could not be moved and why (missing permission, Discord rate limiting, more
  than 60 in one run, a bot that is connected); everybody who could be moved has been. Save again to move
  the rest, or ask them to leave. (The issue asked for a channel to stay "until empty"; the groups stay
  on with it.)
- **If a delete fails halfway** (Discord refuses or cannot be reached) the groups stay on, the channels
  already deleted are not made again for ten minutes (the scan is held off; a restart or the end of
  that time makes it create them again), and the result says how many are gone. Save again to finish.
  The flag is stored off only once no group has a channel, so a channel is never left that nobody
  would delete.
- **Groups on, groups kept from before.** If the event was switched off earlier, the forms offer to
  bring the groups back as they were, **with the people assigned to them and their leaders** (nothing was
  destroyed on the way off). Their voice channels are made by the same pass as the other group
  channels, next to the main channel and in order (a leaders-only channel is created restricted). When
  tagging is on and the event is running the nicknames are tagged again in the background, and the
  leaders-only channel's access and the "Customise team" messages follow.
- **Groups on, an event that never had groups.** Pick a **preset** or set up **your own groups**.
  A preset is chosen by id: the page offers the presets that are on for the server, and the server turns
  the id into the preset's groups (names, kinds, sizes, tags, markers, labels and its default for clan
  tags) at the moment you save; nothing about a preset's groups is taken from the browser. Your own groups
  are up to six starter rows (name, kind, size, tag; a row with no name is skipped) checked with the
  event form's rules (name rules, size 1 to 99, tag length, at most one leaders-only group,
  `events.groups.max_count`), and the whole result is validated again as the edited setup; a chosen
  preset wins over the rows, and the rows are the way in when no preset is available. Add, rename,
  resize or remove groups afterwards with the other forms. The groups are stored with new keys and nobody
  assigned. Leaders, leader customisation, the tag position and the lock stay at their stored values (off
  for an event made without groups): switch them on afterwards with the other rows. Clan tags follow the
  preset's default (off for your own groups). A preset's channel creation time is not applied (the
  event keeps its own). Nothing is confirmed: it destroys nothing.
- **Channels, partial results and posting again.** With no main channel yet nothing is owed: the channels
  are made together when it exists. If a channel could not be made (a full category, a missing
  permission) the groups are on and the result says "Saved but not finished: ... a group's channel is not
  created yet ...": the scan keeps trying every minute, and **Create the missing channels** (or posting
  the form again) tries at once. Posting the same switch-on twice is one switch (the second says
  "Nothing to change"), and posting the switch-off again after it went through changes nothing.
- **A repeating event.** Switching groups on or off changes this occurrence only, unless the same save
  carries the tick **Also for the next occurrences** (see **Repeating events keep the group setup**
  below). The confirmation page says so for a repeating event.
- **When the event ends** the group leaders are cleared whether the groups are on or were switched off
  (the kept groups keep their member lists as history until a member resets their data, as for any
  ended event), and the next occurrence of a repeating event is made without members or leaders.
- **Known limits.** The main channel of an event made without groups has no host overwrites (they are
  added only when a group event's main channel is created); switching groups on later does not add
  them.

**Repeating events keep the group setup** (#1266). The host's group setup is what every following
occurrence of a repeating event starts with, until the host changes it. Nothing is a slash command:
it is the tick **Also for the next occurrences** on the forms of the host panel's **Live settings**.

- **What is kept.** Whether groups are on, the number of groups, their kinds, sizes, names and default
  tags, the group label, the leader label, **Group leaders**, leader customisation, tagging
  and the tag position, and the Captains lobby as a structural group. The setup is stored on the event as the series' setup and every occurrence
  hands it on to the next one.
- **What is not kept.** People in groups, leaders, channels and clan tags on nicknames: each occurrence
  starts with nobody assigned, no leaders (not even as defaults) and new channels. The channel creation
  time still follows the occurrence that ended, as before. The lock stays per occurrence: every
  occurrence starts unlocked, whatever the series setup or the event before it had.
- **The host's names, not a team's.** If a leader renamed a group during the event (for example
  "Caldari" became "Quizzzzbois"), or changed its tag, the next occurrence gets the host's name
  "Caldari" and tag again. The host's name is already stored: the first change a leader makes keeps the
  host's name and tag in the group's original name and tag, and a rename by the host replaces them. So
  no new field is needed for this.
- **Where the tick is.** It is shown on every form of the group settings (the save form, the preset
  form, add and remove groups, and switching groups on or off) of an event that repeats, and is off
  by default. Without the tick a change applies to this occurrence only. With it, the same save also
  stores the group setup of this event, as that save leaves it, as the series' setup: it is the whole
  setup the page shows, not only the field you just changed. Saving with the tick alone stores the
  setup as it is now. The tick is part of the save: one result, one audit entry (`event.host.settings`,
  the row **Group setup of the next occurrences**), and when another change of the same save needs confirmation the tick
  is part of the confirmed change set.
- **Where it can be set.** On the running occurrence, or on an upcoming one (the next occurrence is
  created when the running one ends or is cancelled, from the setup the series has at that moment). A
  series that was cancelled has no next occurrence, so the tick is refused there.
- **Series made before this.** An event from before the series' setup existed has none stored: its next
  occurrence is made from the event as it is (with the host's names, and unlocked), and
  from then on carries a stored setup like any other series.
- **Member data.** The stored setup holds no person, so nothing is added to the member export or reset.

**Leaders-only channel** (#1199) is the voice channel of the **Captains lobby** (the event's `leads`
group): a command channel for the host and the leaders of the team groups, which everyone else can
see but not join. It is made with the other group channels (#1190) and removed with them.

- **Who gets what.** @everyone is denied **Connect**; **View** is allowed so people can
  see that it exists, unless the events category already hides channels from @everyone
  (a private category stays private, and that is never lifted). The host (the event
  creator) gets View, Connect and Speak, plus Move Members as on every group channel.
  Each current leader gets View, Connect and Speak. The bot gets its own View, Connect
  and Move Members (with @everyone denied, a bot that only had Connect from its role
  could not connect to move anyone). Admins keep access through their roles: nothing
  adds a deny for anyone but @everyone, and an admin role (one with the Administrator
  permission, or the role of a KoolBot admin group, which is who the Web UI treats as
  admins) is not stripped. The category's own overwrites are copied first. On every pass
  (a new channel, an existing one, after a restart) the Connect and Speak **allow** of every
  other role is removed, because Discord applies a role's allow after @everyone's deny and
  the role's holders would otherwise walk in; only allow bits are removed, never a deny
  added. That includes a role you add to the channel by hand: to let a role in, make it an
  admin group's role. The role of each KoolBot admin group gets an explicit allow
  (View, Connect and Speak), because its holders may get Connect only from their server
  permissions, which the @everyone deny overrides; a deny the category already has (View
  for @everyone, or any deny on that role) is never lifted, and View is not added while
  @everyone's View is denied. While the admin groups cannot be read nothing is stripped
  or granted on a guess, the channel is not marked verified, the Groups section says so, and
  the next pass after a few minutes does it.
- **Leaders** here are the event's current leaders (a team group's leader who is also
  a member of it, only while the event's leaders switch is on), read from the event as it
  is when the channel is written, never from the change that asked for it.
- **When a leader changes** (set, replaced, cleared, ended by an unassign, cleared by a
  member data reset) the bot compares the channel's overwrites, read from Discord, with
  who should have access and writes the difference: one request per person, access taken
  away first, paced, under the same per-event lock as creating and removing the group
  channels. It decides from a fresh read of the event and of the channel, so a change
  that lands while earlier overwrites are being written is simply the next pass (passes
  for one event are merged into one when several changes arrive together), and a channel
  that was deleted and made again meanwhile is handled from the new record. Nothing is
  written when the event or the channel cannot be read, or when the bot lacks **Manage
  Roles** on the channel: the Groups section of the host panel says why.
- **A leader who loses access is moved out** (after the overwrites, never inside the
  channel lock): if they are connected to the leaders-only channel they go to the channel
  of the team group they are in, or to the main channel if they have none or it has no
  channel yet. The host, current leaders, the server's owner, anyone with the Administrator
  permission and anyone holding the role of a KoolBot admin group are never moved (nobody
  is moved while the admin groups cannot be read). The move only happens if the person is still in
  the leaders-only channel when it is sent (someone who walked elsewhere is left alone),
  uses the same mover as **Move people** (Move Members, one at a time, never replayed; for
  this move it is enough that the bot holds Move Members in the events category, not
  server-wide) and
  is skipped while a **Move people** run is going and tried again later. A person who
  could not be moved is remembered and tried again about five minutes later, and the host
  panel says how many are still in the channel. Such a person is forgotten only after a
  definitive outcome (moved, refused for good, or the event no longer exists): a failed
  read of the event, or a server the bot cannot read at that moment, keeps them for the
  retry. The scan keeps looking after an open event past its scheduled end (that end
  waits while people are in its channels), until the event is ended.
- **After a restart, and every minute** the scan asks whether the channel needs a pass
  (cache only): it has never been verified since it was created or since the restart, its
  overwrites differ from who should have access, someone who cannot connect is sitting
  in it, or a move is still owed. A pass reads Discord again before it writes, removes a
  stale member overwrite (a leader who is no longer one, a member whose data was reset, an
  entry added by hand), adds a missing one and restores @everyone's Connect deny and View
  (View only where the category does not deny it: a pass reads the events category fresh,
  never grants View, to @everyone or to an admin group's role, over a deny the category
  has, enforces that deny (it is copied onto the channel's own @everyone entry, or the
  admin group's role entry, and a View allow that contradicts it is removed, which is what
  makes a category that became private hide the channel). For every role other than
  @everyone, in the channel or in the category, View follows the category's own entry for
  that role: a category deny is copied (and any allow removed), a category allow is copied
  (also when the channel has no entry for the role yet), and with no category entry the
  channel keeps what it had, except that a View allow goes while the category hides the
  channel from @everyone and an admin group's role is given View only while @everyone's View
  is not denied. The host and the leaders keep the View that goes with their access, and the
  bot its own. A category's View deny for a single member is copied onto the channel's
  entry for that member the same way (for anyone but the host, the bot and the leaders,
  who keep their View). Writes go out restrictive first: whatever takes access away (a
  role's allow removed, a deny added, the @everyone restriction) is sent before anything
  that gives access (a new admin group's role), and an entry that does both is split into
  a restrictive write and a granting write, so a refused grant cannot leave a former admin
  role with access. This holds the same way when the channel is created, in a pass and in the
  scan's check. While the category cannot be
  read grants no View, enforces nothing and leaves the channel
  unverified with a note in the Groups section). Each scan also reads the admin groups'
  roles again, so a role that became or stopped being an admin group's role gets its allow
  or loses it without anyone touching the event. A pass that fails marks the channel
  unverified, so one more check runs after the wait and clears what was reported. Someone who
  becomes an admin while a move out of the channel is waiting on Discord is not moved. A write
  Discord did not take is not repeated every minute: the bot waits and says so. A
  pass leaves a member entry that only denies, and any deny, as it is.
- **Without the permissions.** Creating the restricted channel needs **Manage Channels**
  (as for every group channel) and **Manage Roles** plus the permissions it grants (View
  Channel, Connect, Speak and Move Members) in the events category. If any is missing, or
  Discord refuses the overwrites anyway, the channel is created **without** the
  restriction, so anyone who can see it can join, and the Groups section of the host
  panel says so, naming what is missing, until a later pass has restricted it. Later
  changes need **Manage Roles** on the channel. While `events.enabled` is off a pass only
  takes access away, never gives it.
- **Data.** Nothing is stored for this in the database. The overwrites on the channel are
  derived from the event's host and leader ids (the leader id is already member data,
  exported and erased on a reset; the host id is the event creator) and live only on
  the Discord channel, which goes with the event. A member data reset clears the leader id,
  which takes the member's overwrite away from a running event's channel; an event that is
  already over is not changed (its channel is removed by the cleanup).
- **Moves.** Send to groups never targets it; Return to main includes it unless you tick
  the box to leave people in open and leaders-only channels; Pull leaders only aims at it
  by default; Move one person accepts only the host or a leader for it.

**End the event** (#1193) ends a running event now. It is the **End the event** section of
the host panel (shown for every open event; the form only for an `active` one, a scheduled
event says it can be ended once it has started) and an **End now** control on every
`active` row of the Events table (admin only). Both are one small form with a required tick
box, "I want to end this event now", that the server checks again: a post without it changes
nothing, so the confirmation holds without scripts. An event with group channels needs no extra choice: a host end
always moves everyone in a group channel back to the main channel first (there is no option to skip it). A
group channel that still holds someone afterwards (for example when the bot may not move members) is left
(never deleted while occupied) and goes within a minute of the last person leaving. The main channel follows
the usual grace period after the end, once it is empty.
Only an `active` event can be ended: a scheduled one (not started) and a cancelled one are
refused with a message, and an event that has already ended answers "already ended" and
changes nothing (pressed twice, or by two people, or while the scheduled end runs: exactly
one of them runs the teardown). The action follows `events.enabled`: while events are off, or
the switch cannot be read, it is refused. Ending an event adopted from Discord ends the row
only; the Discord event is never changed by KoolBot.

Manual and scheduled ends run the **same teardown** (`event-teardown.ts`), in this order:

1. **Mark ended.** One atomic update, only if the event is still in an allowed state (manual:
   `active`; scheduled: `scheduled` or `active`, and the start and duration the scan decided
   from unchanged), records `ended` and the end time (`endedAt`: the moment of the press, or the
   scheduled end). If this cannot be saved nothing else happens. This comes first, unlike the
   order the issue lists, because it is what makes the teardown run once, because from then on
   host actions, assignment and self-join refuse the event (so nothing re-assigns or re-moves
   people while the later steps run), and because the group channel cleanup and the mover are
   written for an event that is already ended.
2. The announcement post is refreshed (it no longer shows a running event).
3. **Pull back** (manual end, always, only for an event with group channels; there is no option
   to skip it, and a posted `pullBack` field from an older form is ignored): everyone
   connected to a group, open or leader-only channel goes to the main channel with the
   **Move people** helper, the host included (someone left in a channel that is about to go
   would be stranded as much as anyone). At most 60 people per run, 500 ms apart, only people
   connected to voice; the rest, and anything Discord did not confirm, are listed in the result.
   Without **Move Members**, or while another move runs, nobody is moved and the result says so;
   the group channels then stay until empty. The pull-back is not retried by the scan.
4. **End-of-event hooks.** A list that features register work on; today it holds the clan
   tags' nickname restore (#1194, see **Clan tags**). A hook that fails or takes over a minute
   is reported and the teardown goes on. Hooks run once, after the event is already saved as
   ended; a restore that did not finish is not lost, because the nickname backups stay until
   they are restored and the scan finishes them.
5. **Group channels** are removed now, empty ones only (each is read from Discord just before);
   one with people in it stays and the scan tries again every minute. The **main channel**
   stays for `events.channel_grace_minutes` after the end (counted from `endedAt`, so an event
   ended early gives people the full grace period from the press, not from the scheduled
   end) and the scan removes it once it is empty, as before.
6. **Per-user data:** group leaders (`captainId`) are cleared by `clearLeadersOnEnd` in the
   leaders module: under the same per-event lock as every membership change, from a fresh read
   of an event that reads `ended`, with one conditional update that matches each group's stored
   leader (the shape of the unassign step). Each cleared leader is announced to
   `onLeaderChange` with source `ended` and the stored id as `fromUserId`, so the leaders-only
   channel (#1199) can take their access away; a cancel does not clear leaders. Assignments
   (`memberIds`) stay as history until the member resets their data (owner decision, see the
   member data export). Nothing here adds or changes anyone's group.
7. **Discord event:** a manual end closes it the way the scheduled end does (an unstarted one
   is deleted, a running one is completed; an adopted one is only let go of). The scheduled end
   leaves this to the scan's own sync right after the teardown. If the server cannot be reached,
   or the Discord event (or a create that timed out and is still being looked for) is still
   linked afterwards, the result says so and the scan tries again. The confirmation text says
   which of the two applies: "the Discord event is closed", or for an adopted event "KoolBot
   stops tracking the Discord event; the Discord event is left as it is" (host panel and Events
   table alike).

Every step after the first is attempted whatever an earlier one did (a group channel pass that
cannot read the event is reported as a failure, not as an empty success). A step that fails is
logged and listed, never thrown: the host sees one message (at most 500 characters) that puts
what needs attention first. Empty group channels, the main channel and the Discord event are
retried by the scan; the pull-back and the hooks are not. One audit entry per press
(`event.host.end` on the host panel, `event.end-now` on the Events table) records the outcome
(`ended`, `ended-with-problems`, `already-ended`, `not-running`, `not-found`, `refused`), the
number of steps that needed attention and counts such as people moved, never names. Who ended
the event is only in the audit log; the event row keeps no user id for it.

The scheduled end differs from a manual one in four ways. It **waits while anyone is in a voice
channel of the event**: the main channel and every group channel (bots do not count). The
event then stays live, nothing is deleted or moved, and the next scan asks again, so an event
ends on its schedule only once its channels are empty; the wait is logged once, not every scan.
Occupancy is decided from the stored event, not from the scan's older copy: the channel ids
are read from it now, every channel is read from Discord first (a forced read, then the
gateway's voice cache, like the channel cleanup uses), and only then are all the member lists
looked at together, so someone moving between channels is not missed. The ids it looked at go
into the end's own claim, which refuses a change (a group channel recorded since), and the next
scan checks again. An event or a channel that cannot be read counts as occupied. Only the host's manual **End event now** may end an event with people
present. The scheduled end also never pulls people back, it does not close the Discord event inside the
teardown (the scan does, next), and it only acts on the event as the scan read it, so a cancel
or an edited schedule made meanwhile is not overwritten.
A scan that loaded an event just before a manual end skips it instead of acting on its older
copy: for at least five minutes after the end landed, and for as long as any scan that started
before it landed (including one that started while the end was still being saved) is still
running, so the hold does not rely on a timeout. A cancel takes the same hold. If saving the end or the cancel fails (the database is
unreachable), the hold is not kept forever: it becomes a finite one (the write may have landed),
so once it is over a scan carries on with the event as usual. An announcement edit that is
skipped because of such a hold counts as NOT refreshed: a member's RSVP removal keeps the RSVP
for a retry and reports the failure, and the link refresh tries again. The scan's step from
scheduled to active is a conditional write, so a cancel that landed first is never turned back
into active. Event ids taken
from a request are normalised to lower-case hex once, so an upper-case id cannot key a second,
unseen set of holds, and it does not touch the event at all while a teardown is running
(so a grace period of 0 cannot remove the main channel before the pull-back has used it); an
open copy never edits the announcement post once an end has begun. A cancel is saved first and
only if the event is still in the state it was decided from, so a cancel decided on an older copy
(an adopted event reported gone in Discord, say) can neither turn an ended event into a cancelled
one nor delete its channel. A cancel keeps the event's main channel id on the record until Discord
confirms the channel is gone (deleted, or already missing), and takes the id from the row as it is
at the claim; if the delete fails or the bot restarts, the scan finishes it within a minute. Cancelling reports whether it really cancelled: an event that has
ended, or is being ended, answers "could not be cancelled: it is ended" (admin page), is not counted by a series cancel and
spawns no successor. A recurring event's next occurrence is created by the next scan,
as after a scheduled end.

**Edit** (#1298) opens the create form pre-filled, on the host panel's own address (`/me/events/<id>/host/edit`), for an upcoming or running event,
one-off or an occurrence of a recurring series. An administrator can edit any event; a host with the Event host role only the events they created. A
scheduled event with no channel yet takes a new title, description, date, time, timezone and duration, with the same checks as the create form. The
Discord event is patched in place (so the people who marked Interested are kept), the announcement is edited in place, and a moved start moves the
lead-time channel creation and sends the reminder again. An event that has started (running, its channel already created, or past its start) can only
change its description and duration. Finished, cancelled and adopted events cannot be edited (an adopted one is edited in Discord). A recurring
event's form first asks how far the change reaches, with no option pre-chosen: **This occurrence** leaves the next occurrences as they were (the
series' title, description, duration and timezone are kept in a stored template that the next occurrence is built from), and **This and following**
changes this one and every later one (only the fields the edit changed are written to the template, and a moved start moves the series' schedule so
this occurrence stays on the new time). A save without a scope is refused. A change of start or duration is refused when the event
would still be running when the next occurrence is due (that occurrence would be skipped). "This and following" is refused when no schedule
reproduces the new start (a monthly date that some months lack; a change of time alone keeps the series' day), and an occurrence whose
successor has already been created is refused. The scope is recorded in the audit entry. A save made on an out-of-date form (the event started, ended,
was cancelled or edited meanwhile) changes nothing and asks you to reload. That includes a form opened before the start with the title and start
editable and saved after it: the whole save is refused ("This event has started since you opened the form"), never saved without the title and start.
The same holds for events turned off, a Discord event still being created (a new title or start is refused, and nothing else from that save is
applied) and a running Discord event that holds the start. Every save is audited as `event.edit` with the changed fields before and after; a refusal
is audited as a failure.

The **Cover image** column (#1181) sets, replaces and removes an optional cover
for a scheduled or active event. The image is mirrored to the native Discord event
within a minute: sent when it is new or changed (never on every scan) and cleared
when removed. A recurring series has one cover, shared by every occurrence (each
mirrored occurrence uses it), and the control says so. Accepted: PNG, JPEG or GIF
up to 2 MB, checked on the server by the file's real signature (not its name or
declared type), with a clear message when a file is rejected. The image is stored
in KoolBot's own database (`event-images` collection, one document per event or
series; event rows hold only its hash) and deleted when the event or series
finishes or is cancelled. The upload is the raw file sent by the page script with
the CSRF token in a header (it needs JavaScript; there is no multipart parser).
A failed send to Discord is logged and retried a few times, never blocking the rest
of the sync. Events adopted from an existing Discord event (Adopt Events) show no
control: they keep the cover they have in Discord and KoolBot never changes it.
A one-off event whose Discord event was deleted by someone is no longer mirrored,
so it shows a note instead of a control; a recurring series stays editable for its
future occurrences.
A host who is not an administrator sets, replaces and removes the cover on the event's edit page
(`/me/events/<id>/host/edit`, #1393), in a panel of its own below the details form (it is not part of
"Save changes"). It posts to `/me/events/<id>/host/cover` and `/cover/remove`, behind the same gate as the
other host routes (CSRF, the host scope, creator or administrator), and uses the same storage and checks
(2 MB, PNG, JPEG or GIF by signature, the same refusal of adopted, no longer mirrored and finished events;
refused too while Events is off). The cover is shared by the whole series, so choosing "this occurrence" in
the details form does not limit it; the panel says so. Audited as `event.host.cover-set` and
`event.host.cover-remove`. A saved or removed cover reloads the page, so if the details form has unsaved changes the page
asks before uploading or removing; a rejected upload shows its message next to the control and never reloads.
An administrator sees the same panel plus a link to Events in the admin area.
No new stored field: the member data export and reset are unchanged (the image holds no member data).
Events scheduled without a cover behave exactly as before.

Its **Settings** card (#975) edits every `events.*` key in place: the enable
toggle, the channel category (`events.category_id`, a category picker), the
announcement channel (`events.announcement_channel_id`, a text-channel picker),
the timezone, the channel prefix, and the default duration, channel lead time,
grace period and reminder timings. It saves through the shared
`/admin/settings/save-section` route and returns to the page. The enable toggle
is the form's cascade master, so turning events off from here writes only
`events.enabled = false` and keeps the other values. If the stored config can't
be read, the card shows a notice instead of controls pre-filled with defaults.

The same card holds the native event's location text (`events.native.location`, #1034). Every event is created in the server's native Events list (there is no
switch any more, #1175); the bot needs the Create Events or Manage Events
permission, and the page warns when it is missing. The location text is shown until the event's main voice room is created; with **Link the native
event to the voice room** (`events.native.link_room`, on by default) the native event then points at that room (also for events with groups: the main
room, never a group room; a linked event is started at its start time). Untested risk: Discord may mark a linked card finished early when its room
empties, which for grouped events can happen while the teams play in their own rooms; KoolBot cannot undo it, and the switch is the rollback. If
Discord refuses the change the text stays and the bot retries on the next scan; turn the switch off to keep the text only. Turning the switch off
stops new links and puts an existing link back to the text only while the Discord event is still Scheduled and before its start time; once the start
has passed the link stays (and a link still Scheduled then is still started), so it is not a rollback for a running event.

The **Moderation** page (`/admin/moderation`) is a read-only, server-wide
history of moderation actions — the Web UI counterpart to per-user `/modlog`.
Each row shows the timestamp, target user, action, acting moderator, reason, and
source; user and moderator snowflakes are resolved to display names when the
members are still in the guild (a page of 50 rows is resolved with a single
batched member fetch rather than one request per id) and fall back to the raw id
otherwise. `warn` rows are KoolBot's own record written by `/warn`, while
`kick` / `ban` / `unban` / `timeout` / `untimeout` rows are mirrored from the
guild audit log — so the `source` column reads `command` or `audit` accordingly.
Two filters narrow the view — an **action** dropdown (warn, kick, ban, unban,
timeout, untimeout) and a **user** filter — and results are paginated 50 rows
per page. The page is gated by `moderation.enabled` (the #610 disabled-feature
pattern): when moderation is off it renders the disabled banner and an empty
table without querying the moderation log. A **Settings** card on the page edits
`moderation.enabled`, `moderation.retention_days` and the Discord log channel
(`core.moderation.enabled` / `core.moderation.channel_id`, which also stay in the
Core section of Settings); saving returns to the page with a flash message, and
unticking `moderation.enabled` writes only that flag so the other values are kept.

The same Settings card holds the **anti-raid** keys (`moderation.raid.*`, #1045): the master switch, the **dry
run** switch, the join threshold and window, the lockdown and new-account actions, the minimum account age, the
timeout length, the quarantine role, the optional auto-expiry and the alert channel. Anti-raid starts as a dry
run, so you can watch the alert channel and `/raidmode status` for what it would do before it touches anyone.
Its actions show in the table above like any other: `kick` and `timeout` rows against the member, `quarantine`
rows for the role action, and `raid lockdown` / `raid cleared` rows for each lockdown (their user column shows the
server id, since they concern the server rather than a member), all with source `raid`. A raid kick can have a case
opened on it like any kick, which is the place to record a review or letting the member back in. The action filter lists every action.

With `moderation.cases.enabled` on, the page also gains a **Cases** section and a **Case** column (#908).
In the column, a kick or ban row without a case offers an **Open case** form (review in N days, pre-filled from
`moderation.cases.default_review_days`; clear it for a case with no review date), and a row with one shows its
number and status. The section groups cases into **Needs a decision** (review date passed), **Review in the next 7 days**,
**Review later** (review date further out), **No review date** and **Closed in the last 30 days**. Each card shows the member, the original reason,
who acted, the member's **earlier actions** (newest 10 entries) and the case's decision trail. A live card
offers **Keep out for now** (the member stays out, schedule the next review), **Decide later** (new review date, required),
**Keep out for good** and **Let back in**; staff may decide a case before its review date. Let back in records the decision only, it does not
lift the ban in Discord. A **Check review dates now** button runs the review-date job on demand. Every decision is written to the
Web UI audit log. A decision on a case someone else already resolved from another tab is refused with a message
naming the status it found.

**Server scan** (`/admin/adopt`, #1019) is a read-only inventory of the guild: it has no write routes, and never
writes to Discord. Since #1323 it opens on an **Overview**: the verdict (ready, or how many blockers), tiles for
Readiness, Roles, Channels and Other bots, what needs fixing, and suggestions that each link to the page that acts
(Channel claims, Voice channels, and the voice tracking settings). Readiness and permission detail link to **Bot permissions** instead of
repeating its table. The inventories are tabs (`?tab=roles`, `channels`, `bots`, `discord`; an unknown value is the
Overview), plain links that work without JavaScript. The **Channel ownership hints** switch in the header is a GET form
and the only form on the page. The tabs share one scan for a minute per admin and hints setting, so clicking through them
does not rescan Discord, and a tab click served from that scan does not count against the page's rate limit, which
only counts scans that start. The header says when Discord was read and **Scan again** bypasses the cache.
The **Channels** tab lists the channels as Discord does: those outside a category first, then each category in
capitals with its channels under it (text before voice). Each row shows what uses the channel (green chips), what it
looks like it could be (for example _looks like Quotes_), Discord's own flags and **Custom permissions** when it is
not synced to its category; its overwrites open on demand. **Claim** appears on a _looks like_ row where KoolBot has
one feature that fits that kind of channel (Quotes, Voice stats, Birthdays, Tickets category, Looking for group,
Moderation log, Notices, Reaction roles, Voice lobby), never on a channel Discord uses for rules, system messages
or public updates, and opens **Channel claims** with the channel and feature filled in. The filters (`?filter=used`,
`claimable` or `custom`; anything else is _All_) are plain links that keep the tab and the ownership hints. All of
it is links: the tab still has no write route. What follows describes the data each tab shows.
It lists **roles** (position, colour, cached member count, `managed` flag,
whether KoolBot can manage the role, and which feature uses it), **categories and channels** (type, parent,
whether permissions are synced to the parent, every overwrite as allow/deny, and which feature is bound to the
channel by a `*.channel_id` / `*.category_id` / `*_channels` setting), **other bots** (integration role and the
channels where they have overwrites) and **bot readiness**: the bot's guild permissions, its role-hierarchy
position, and actionable warnings (for example "move the KoolBot role above X") that link to
[TROUBLESHOOTING.md](TROUBLESHOOTING.md#bot-cant-manage-roles-or-channels). It also shows what Discord already
handles (Community, rules/system/public-updates channels, Onboarding prompts and the roles they hand out), the
AFK channel, webhook-fed and followed channels (reading webhooks needs the Manage Webhooks permission; without
it the scan warns that these marks are missing instead of showing none, and never edits a webhook), role-gated
categories, the server's channel naming convention and native scheduled events. The scan never pages through the member list: role member counts come from the
cache (a `+` marks a possibly low count unless the GuildMembers intent is on). **Channel ownership
hints** (`?sample=1`) additionally samples recent message authors to spot channels one bot posts in; it costs a
REST call per channel, so it is off by default. The same data is available to code as
`ServerScanService.scan()`, whose `scanned` member is the `ScannedState` the adoption planner diffs against.

**Bot replacement report** (a section of `/admin/adopt`, #1026) compares the bots found in the guild with a static catalogue
shipped in the repo (`src/content/known-bots.ts`). Bots are matched by their Discord id, never by name, and nothing is
sent to any outside service. Each catalogued bot gets a summary (_Can fully replace_, _Can replace N of M features_, _No
overlap_ or _Keep_), a table of its capabilities with KoolBot's coverage (**Full**, **Partial** with what is missing,
**Planned** with the issue link, **Not covered**, or **Keep** with the reason), whether the matching KoolBot feature is
currently enabled, and numbered switch-over steps with a link to the right page. A _Left over when it is removed_ list shows
the bot's locked integration role, channels it mostly writes to (needs channel ownership hints), channels with a
member-specific overwrite for the bot, and KoolBot features already bound to its channels. A combined view groups
capabilities KoolBot covers, capabilities several bots provide (so one of them may already be free to remove) and
capabilities nothing covers, and lists which bots you could consider removing after the switch. A bot that is not in the catalogue is
shown as **custom** when Discord does not list it as a verified app (KoolBot does not try to replace it) and as **unknown**
otherwise, with a link to suggest a catalogue entry. If the GuildMembers intent is off, the report warns that a bot without
an integration role may be missing. The report is read-only: removing a bot stays manual in Discord, KoolBot never kicks
it, and data from other bots cannot be imported. Every catalogued card says the match is by id and the capability list may be
out of date, and carries an _unverified entry_ note until the entry records what it was checked against (`verifiedAgainst`).

**Clean up after a removed bot** (`/admin/adopt/cleanup`, #1179, part of the server-adoption work #1017) is the part that
comes after you have removed a bot in Discord yourself. KoolBot never removes another bot, and the page never does.
The **Other bots** tab lists _Removed bots with leftovers_: a bot that is no longer in the server but whose catalogue id,
a channel it mostly wrote to (needs channel ownership hints) or a member-specific permission overwrite still shows up in
the scan. A bare overwrite for an account that may be a person who left is listed last, and the plan refuses any account
Discord does not say is a bot. Discord removes the bot's managed role when it leaves, but not those overwrites.
**Review cleanup** lists, per channel, the overwrite that still names the removed bot. Nothing is ticked for you.
**Preview changes** shows the plan, and **Apply plan** runs it through the adoption engine like any other plan: a
snapshot is saved first, one `adopt.cleanup.apply` audit entry is written, and the result can be restored from **Adoption
history**. The engine counts removing an overwrite as a destructive step, so the preview lists it in its own section and
the apply form asks for the separate confirmation. Before it plans, and again right before the step runs, KoolBot asks
Discord whether the account is a bot and no longer a member; if either read fails, or the bot is back, nothing is planned
or applied. Settings still bound to a channel the bot touched are flagged as warnings and are not changed. Channels it
mostly wrote to link to **Channel claims** (with the feature prefilled where one fits) for the actual claim, which has its
own preview. A Restore puts the removed overwrite back with the same permissions; whether Discord accepts a member
overwrite for an account that has left is not confirmed on a real server yet.

Not part of this yet: claiming a removed bot's channels inside the same plan, and archiving or deleting its channels
(destructive, to be opt-in with explicit approval). Neither is offered today.

**Channel Manager** (`/admin/channels`, #1065) lists the server's categories and their text and voice channels
live from Discord and lets an admin create, rename, reorder and delete them. It is Web UI admin management, so it
has no on/off setting: it is always available to admins, behind the same admin sign-in, CSRF check and audit log
as the other admin pages. It edits structure only; permission overwrites stay in Discord (or the Channel Claims page).

- **Create** a text channel, voice channel or category. Per-channel basics: name, topic (text), user limit and
  bitrate in kbps (voice), and the parent category. New channels get no overrides of their own.
- **Edit** the same fields, including moving a channel to another category (permissions are not rewritten on a move).
  Only fields you changed are sent to Discord, so a no-op save never spends a rename. A field posted back as the
  form showed it (a name, a topic, a bitrate shown rounded to whole kbps) counts as unchanged and is never rewritten.
  The form remembers what it displayed: only fields you changed are saved, and if a field you changed was altered
  elsewhere (another admin, Discord) since you opened the page, the save is refused instead of overwriting it.
- **Reorder** with Up and Down. Text and voice channels order separately inside a category, as in Discord. Each
  button is drawn for the neighbour it swaps with; if the order changed since the page was opened, the move is refused.
- **Delete** always goes through a confirmation page. The page and the delete itself both re-check, so a stale
  tab or a hand-made request cannot skip it. KoolBot **refuses** to delete a channel it manages and names why:
  a channel set in any `*.channel_id` or `*.category_id` setting (quotes, notices, log channels, the voice
  category and lobby, ticket and event categories, ...), the voice lobby and offline lobby (also found by name, with the same quote and
  legacy-setting handling as the voice feature), active temporary voice channels and waiting rooms (including ones the voice feature
  holds only in memory while a database write is pending), the legacy "New Channel" join-to-create trigger, ticket channels, channels of events that
  have not ended,
  open looking-for-group channels, the private channels and categories of active reaction roles, poll schedule
  destinations, scheduled announcement channels, and the server's rules, updates and system channels. A category must be empty
  before it can be deleted, because Discord would otherwise drop its channels to the top level and break
  features that look for them under a category. If the managed-channel lookup fails, the delete is refused. The
  confirmation is tied to the channel as the page showed it (type, name, parent, and a category's contents): if
  it was renamed, moved or changed after the page was opened, the delete is refused until you confirm again.
- **Limits** are checked before Discord is called: names up to 100 characters, topics up to 1024, user limit 0 to
  99, bitrate from 8 kbps up to your server's boost-level maximum, 500 channels per server and 50 per category.
- **Manage Channels**: the bot needs this permission. Without it the page shows a warning and disables every
  control, and any request is refused with the same message.

Only text channels, voice channels and categories are managed; announcement, stage and forum channels are listed
but left alone. Every change is recorded in the audit log (`channels.create`, `channels.edit`, `channels.move`,
`channels.delete`, refused deletes included) and goes through the bot's Discord request wrapper (timeout and
backoff). Creates, edits and moves are not retried after a timeout, because Discord may still apply the original
request and a retry could rename or create twice. The page's **Recent changes** panel lists the latest of these
entries (the web audit log has no page of its own).

Discord allows only a few renames and edits per channel every 10 minutes, and the bot's shared Discord client
would otherwise hold a request behind that limit and apply it minutes later, and re-send a create whose response
was lost. The page therefore writes (create, edit, move, delete) with its own Discord client: no automatic
retries, a 30 second limit, and a rate-limit wait longer than 20 seconds is refused at once. If Discord asks for a
long wait, nothing was sent or applied and the page says when to try again. If the request times out the outcome
is unknown (Discord may have accepted it before the answer was lost; the same goes for a lost connection or a server
error), so the page says to check Discord before trying again. Only an answer Discord gave (a refused permission or
value) is a definite refusal. Writes to one server also run one at a time, each from a fresh read, so two saves of
the same page cannot overwrite each other. A request that gives up is cancelled here, so nothing queued is applied
later. Other features keep using the shared client unchanged.

**Adopt Discord events** (`/admin/adopt/events`, #1034, part of the server-adoption epic #1017; linked from the
Scheduled events card of Server Scan) takes over native scheduled events the server already uses, so KoolBot
announces them, reminds people and handles their voice channel. The Discord event stays the single source of truth for
members: they keep marking Interested on it, and KoolBot has no RSVP list of its own for it. The page lists every
scheduled event with a checkbox, and states why an event cannot be adopted instead of hiding it:

- already linked to a KoolBot event (adopting twice is refused, also if two admins race);
- not waiting to start (running, finished or cancelled; only scheduled events are adopted) or its start has passed;
- it repeats through a Discord recurrence rule (KoolBot runs repeats itself and does not map those rules);
- created by KoolBot itself (the Discord copy of a KoolBot event) or by another bot, which manages it;
- a KoolBot event with the same name and start already exists (it would be announced twice);
- the bot lacks **Manage Events**, which it needs for events members created.

**Preview changes** (a GET with the choice in the query) shows the shared adoption diff: one additive step per event,
naming the KoolBot event, the times, the link announcement and whether a temporary voice channel is made. A blocking
error shows when `events.enabled` is off; a warning shows when `events.announcement_channel_id` is not set. **Apply
plan** re-plans the same choice, refuses if anything changed since the preview, and runs it through the adoption engine
as a background job (snapshot first, audited). It creates one one-off KoolBot event per Discord event, linked to it
(`nativeEventId`, the same unique link the outbound sync uses). The Events scan then posts the link announcement within a
minute, sends the reminder and, unless the Discord event has a voice or stage channel of its own, creates the temporary
voice channel before the start. **Nothing writes to the Discord event**: not on apply, not while it is adopted, not on
rollback. KoolBot follows later edits to the event's name, description, start and length (while it has not started),
cancels its own event when the Discord one is deleted or cancelled before it starts (a running event
finishes on its own end time), and when the KoolBot event ends or is cancelled in
the Web UI it only lets go of the link. **Roll back** from **Adoption** removes only the KoolBot events that step
created, with their announcement and an empty temporary channel (a channel in use makes the rollback stop and be
retried), and leaves the Discord event untouched.

**Channel Claims** (`/admin/adopt/claims`, #1022, part of the server-adoption epic #1017) takes over existing
categories and channels. Every row defaults to **Leave alone**; nothing is touched unless you pick an action:

- **Read-only (bot posts)** denies `SendMessages`, `SendMessagesInThreads`, thread creation and (unless
  "members may still react" is ticked) `AddReactions` for `@everyone`, allows the bot, and can let chosen roles
  or groups post. The rules follow the channel type: a **forum** stops new posts but keeps replies open (tick
  "also stop replies" to lock them), an **announcement** channel behaves like text, a **stage** gates
  `RequestToSpeak`, and a **voice** channel gates `Speak`. A read-only claim never grants `@everyone` anything, so
  it cannot undo a gate. Overwrites for other roles and members are kept, so
  one of them that already allows posting (or, for a gate, viewing) can bypass the claim: the plan names them
  ("only partly read-only / gated") instead of calling the channel exclusive.
- **Group-gated** hides the channel from `@everyone` and shows it to the roles you choose, or to "group X and
  above" by rank. Voice and stage channels also lose `Connect`, so visibility and joining agree. Managed roles
  such as Server Booster or a subscription role are valid targets; the role itself is never edited. Roles that
  belong to a bot integration are refused. Gating a category also gates the channels in it that are synced to it.
- **Sync to category** makes a channel's overwrites match its category. It is the one action that replaces
  existing permissions, so it is flagged, never pre-selected, and removing a channel's own overwrites needs a
  per-channel approval box. Those removals are listed as destructive steps and run last. Overwrites that belong
  to other bots (or that cannot be told apart from them while the Server Members intent is off) are kept, and the
  plan says the channel will not read as fully synced.
- **Bind to a feature** writes the feature's `*.channel_id` / `*.category_id` key (quotes, notices,
  announcements, birthdays, welcome, LFG, the `core.*` log channels, reaction-role picker, voice lobby, event and
  ticket categories) and gives the bot the permissions that feature expects. Binding the notices channel applies
  the same read-only permissions the notices channel manager sets. Binding an existing channel reuses it: KoolBot
  does not create a second lobby or category afterwards. The plan itself never deletes messages, pins or
  webhooks. The quotes and notices features do, once enabled: their cleanup job removes the latest messages
  KoolBot didn't post, and quote sync can clear the channel. Binding either channel is therefore **blocked**
  while its feature is on, and carries a warning while it is off.
- **Bulk select**: a category row has a "for every channel here left alone" choice that applies one action to
  all of its channels (each row's own choice wins). A sync approval is never carried over by a bulk choice: each
  channel needs its own tick.
- **Prefill from the Server scan** (#1364): `/admin/adopt/claims?channel=<id>&feature=<config key>` opens the form with
  that feature already chosen on that channel's row, scrolls to the row and says where it came from. It is only a
  starting point: it is ignored unless the channel is in the scan and the feature is one the form offers for that
  kind of channel, it changes no other row, and nothing is written until you preview the plan and apply it.

**Suggestions** at the top of the Channel Claims form (nothing is selected for you):

- **Game-role categories.** A category hidden from `@everyone` and visible to exactly one role (another bot's
  integration role and KoolBot's own role are not counted) is listed as a game-role pairing. Ticking **Register**
  (or "Register all N detected pairs") makes that existing role pickable: KoolBot posts a new picker in
  `reactionroles.message_channel_id` (reaction style, one picker per role, with the emoji shown, default 🎮) and stores
  the mapping with the category. The role and the category are reused as they are: no role, category or overwrite is
  created or edited, so the category stays gated. A picker another bot runs is left alone. The same checks as the
  Reaction Roles page apply and are repeated when the step runs: a role with Administrator, Manage Roles, Manage
  Server and the other dangerous permissions, a managed or role-group role, or one at or above KoolBot's highest role is
  **refused** and listed with the reason, and so is a plain role whose own overwrite on any channel (the category or
  an unsynced child) grants such permissions (Manage Channels, Manage Webhooks, Manage Roles there), checked again
  against the live channels when the step runs; a role that is already a reaction role is shown as such. The plan is blocked
  until the reaction-role message channel is set and KoolBot can post and react there (as the plan leaves it), and
  warns when reaction roles are off. The step records the channel it will post in, so changing
  `reactionroles.message_channel_id` after the preview makes it a different plan (preview again).
  Each mapping carries the step that made it, so a plan only ever removes its own picker: a mapping another plan or the
  Reaction Roles page made is reused, not owned. A rollback also recovers a registration saved before a crash that was never recorded
  (looked up by the step's key, never posted again). The picker's footer carries that key, so a picker posted before its
  mapping was saved is found again: a retry completes it instead of posting a second one, and a rollback deletes it.
  The search reads the channel back to when the snapshot was created (and says so, changing nothing, if it can't finish).
  Deletions run under the guild lock until they finish, and a retry also removes this step's own unsaved picker when it
  finds another plan's mapping for the same pair.
  A rollback deletes only the picker this plan posted, from the channel it was posted to, never the role or the category; if Discord fails while deleting it,
  the rollback step fails and stays open for a retry (only "unknown channel" or "unknown message" count as already gone). If another mapping was added to
  the picker since (on the Reaction Roles page), the picker is kept and only this mapping and its reaction are removed.
  A picker channel rebound in the same plan is the destination. Removing the mapping later on
  the Reaction Roles page never deletes the category either.
- **Feeds.** Channels fed by an incoming webhook or a followed announcement channel (from the scan's webhook list;
  application webhooks don't count) can be made a read-only **feed** (combining it with another action such as Gate is refused, since it would promise
  read-only and apply something else): read-only for everyone, reactions open (posting roles or a group are refused for a feed). Their
  webhooks and follower integrations are never modified or removed (webhook messages ignore channel permissions, so they
  keep posting), and the plan warns if a feed is still visible through its own overwrite in a gated category. When KoolBot
  lacks Manage Webhooks the webhook data is **unavailable**: the page says so, suggests no feed, and refuses a feed claim
  rather than guessing.
- **Stage speakers.** A group-gated stage channel can also limit who may _request to speak_: pick the speaker roles in
  Options (they are let in too); everyone else who can see it is denied `RequestToSpeak`. Stage moderators (Mute
  Members, Move Members, Manage Channels) can still invite anyone to speak: the plan says so, and KoolBot never grants
  or removes those permissions. Existing `RequestToSpeak` allows on other roles or members are kept (they may belong to
  another bot) and are named in the plan, since they let a viewer who holds them request to speak anyway.
  An **announcement** channel is only labelled "read-only is suggested"; it is not selected for you.
- Gating a category warns about channels in it that are not synced and still allow `@everyone` to see or join them through
  their own overwrites.

Binding `voicechannels.category_id` to a category that holds other voice channels is **blocked** while legacy
cleanup could delete them. The error lists the empty channels it would remove. Either use a dedicated category,
or tick "also turn on managed-only cleanup", which sets `voicechannels.cleanup.managed_only` before the category
is bound so only channels KoolBot created are ever deleted. Managed-only cleanup first records the voice channels
whose names follow the voice prefix or suffix as KoolBot's own, so the plan is also **blocked** (listing the
channels) when another bot's channels in that category already follow the naming it would use, including a prefix
adopted from this server. A warning reminds you to disable another
join-to-create bot before enabling `voicechannels.enabled`. "Use this server's naming prefix" pre-fills
`voicechannels.channel.prefix` from the scan.

Preview first, then apply: **Preview changes** shows the same diff as Role Groups (blocking errors, warnings,
before and after), and **Apply plan** runs it through the adoption engine, which snapshots everything it touches
and can roll it back. Only `@everyone`, the bot and the roles you chose are written; overwrites for other bots,
other roles and members stay as they are, and unrelated bits on a changed overwrite are preserved. The planner
refuses (as errors, not warnings) any step that would remove your own access, lock the bot out of a channel a
feature needs, or touch another bot's overwrite. Planning an adopted server again gives an empty plan.

**Destructive steps and rate limits** (#1184). Every adoption preview lists additive changes first and puts
destructive steps (deleting a role or channel, removing an overwrite) in a section of their own, with the
warning that IDs, messages and member assignments can't be restored. When a plan has any, its apply form
carries a separate required confirmation (Channel Claims), or asks you to type the role's name (deleting a
group's role); the server checks it again on apply. Adoption writes (everything under `/admin/adopt`,
`/admin/role-groups` and `/admin/rules` that isn't a plain page read) share a limit of 30 requests a minute
per client IP, and the pages that scan the server (`/admin/adopt`, `/admin/adopt/claims`, `/admin/adopt/events`, `/admin/adopt/cleanup`)
a limit of 15 a minute. Over the limit the answer is HTTP 429 with a `Retry-After` header. Like the sign-in
limits it is in memory and per IP, so set `WEBUI_TRUST_PROXY` correctly behind a reverse proxy.

**Adopting an existing server, step by step** (#1025, the guided flow of the server-adoption epic #1017). Adoption lets
KoolBot take over roles, categories and channels that already exist, instead of creating new ones. It is
non-destructive by default: it creates, adds and edits, every apply saves a snapshot first, and nothing is deleted
unless you approve that specific step. A fresh server can skip all of this. The Setup Wizard (`/admin/wizard`) opens with an
**Adopting an existing server?** card that links to each step in order, and the **Adoption** entry in the navigation
opens the snapshot history.

1. **Scan** (`/admin/adopt`). Read-only. Fix the red blockers first (for example the KoolBot role must sit above the roles
   it manages; see [TROUBLESHOOTING.md](TROUBLESHOOTING.md#adopting-a-server-role-hierarchy-missing-permissions-and-rollback)).
   The bot replacement report on the same page shows which other bots KoolBot can replace, and, once you have removed one in
   Discord, **Clean up after a removed bot** (`/admin/adopt/cleanup`) tidies its leftover permission overwrites.
2. **Role groups** (`/admin/role-groups`). Optional. Tie your existing Admin, Mod or VIP roles to groups, preview the plan
   and apply it.
3. **Rules role** (`/admin/rules`). Optional. Only if you want a rules acceptance gate.
4. **Channel claims** (`/admin/adopt/claims`). Choose, per category or channel, to leave it alone (the default), make it
   read-only, gate it to groups, or bind it to a feature. **Preview changes** shows the diff; **Apply plan** runs it.
5. **Check the result.** Planning again gives an empty plan when the server already matches.
6. **Adoption history** (`/admin/adopt/history`). Every apply is listed with its status and what it changed. **Restore…**
   opens a confirmation page that lists the steps that will be reverted, newest first. Only steps that were applied are
   reverted, from the state saved before the apply. Roles the plan created are kept unless you tick **Also delete the roles
   this plan created**. For a plan that deleted something, the page repeats that messages, pins, threads, webhooks and
   IDs cannot be restored. Restore runs in the background and the page shows its progress; a snapshot that stopped part-way
   can be restored again to finish. Each accepted restore writes a started entry (`adopt.rollback.start`) to the audit log
   before it runs, and its outcome (`adopt.rollback`) when it ends; if KoolBot restarts in between, only the started entry
   exists. A refused restore is written as a failed `adopt.rollback`. Snapshots are kept for
   `adoption.snapshot.retention_days` (default 90, `0` keeps them forever).

   **Restore checks the live server first** (#1134). A snapshot can be months old, so before anything is written Restore
   scans the server as it is now and works out what it would look like after the remaining steps are undone, using the same
   safety rules as an apply. It is refused, with a message naming the cause and with nothing changed, when it would:
   remove your own access to a channel or your Administrator permission (you are the admin who clicked Restore, not the one
   who applied); lock the bot out of a channel a feature uses; leave the bot without the Manage Roles permission that the role and
   permission-overwrite changes in the restore need, including a role or overwrite that already has the saved value,
   because the restore still writes it (a restore of settings only does not need it); or edit a role that is
   managed by an integration or sits at or above the bot's highest role. Roles the plan granted to members are revoked by a
   restore, so if you or the bot are among the members it granted a role to, the check treats that role as lost; for a plan
   that granted a role to many members only whether _you_ and _the bot_ were among them matters, and no member names are shown.
   Every role the restore takes back from members is also judged like a role change, even when neither of you received it:
   the bot needs Manage Roles, and a role that is managed by an integration or sits at or above the bot's highest role
   refuses the restore.
   Choosing **Also delete the roles this plan created** is checked too, because deleting a role you hold can remove your access. This includes a role whose
   creation was interrupted: any role on the server with the same name, colour and permissions is judged as if it
   would be deleted, so a lookalike can refuse the restore. The
   engine runs the same check again after it claims the snapshot and before its first write. If the live server can't be
   read, Restore is refused. For a snapshot that was already partly restored, only the steps still to be reverted are
   checked; what was restored earlier is part of the live state. The check never approves anything the planner can't judge:
   recreating a deleted channel or role and putting settings back are not part of it. If the saved list of who was granted
   a role is not in the shape KoolBot expects, Restore is refused. There is no
   extra warning for old snapshots: the check looks at the live server, so a snapshot's age does not change the result.

**Milestone celebrations** (`#657`, Part 2) have no dedicated page: they are
configured entirely under **Settings** (`celebrations.enabled`,
`celebrations.channel_id`). When enabled, the bot posts a loud, server-wide
shout-out to the configured channel the first time anyone crosses a marquee
accolade (Voice Legend, 1000 hours, a 30-day streak, 100 quotes), reusing the
existing achievements award detection. `celebrations.enabled` depends on
`achievements.enabled`, so Settings shows it as waiting for achievements until they are on.

### User self-service (`/me/*`, both admin and user roles)

| Page                                    | What it's for                                                                                                                                             |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Overview** (`/me/`)                   | Index for your own settings — links to the available per-user pages.                                                                                      |
| **Notifications** (`/me/notifications`) | Opt in to DM nudges (achievements, weekly digest, Rewind). Off by default — Koolbot never DMs you until you opt in here. Records a `WebAuditLog` row.     |
| **Voice** (`/me/voice`)                 | Manage your channel name pattern and saved voice-channel presets (rename, edit, set-default, delete). Gated by `voicechannels.presets.enabled`.           |
| **Timezone** (`/me/timezone`)           | Pick the IANA timezone Koolbot renders your times in with a searchable select (_Server default_ clears it); also used for your birthday.                  |
| **Birthday** (`/me/birthday`)           | Set your birthday (month/day, optional year) so Koolbot can celebrate it on the day in your own timezone. Saving or removing records a `WebAuditLog` row. |
| **Rewind** (`/me/rewind`)               | Personal year-in-review: voice time, top voice companions, peak day, longest session, streak, badges, rank, weekly journey, text & reaction activity.     |
| **Privacy** (`/me/privacy`)             | See what Koolbot stores about you, download it as one JSON file, and (if `privacy.delete.enabled`) reset it. Gated by `privacy.enabled`; audited.         |

**A switched-off feature is not shown on `/me/*` (#1292, extending #1066).**
Voice, Birthday, Rewind and Privacy each follow their feature switch
(`voicechannels.presets.enabled`, `birthdays.enabled`, `rewind.enabled`,
`privacy.enabled`). While one is off it has no tab, no Overview card and no
mention in other pages' text, and its page answers `404` for every `GET` and
`POST` (Rewind and Privacy's export are refused before their rate limiters, so
a bookmark spends no allowance). Nothing a member saved is deleted: turn the
feature back on and the tab, the page and the saved name pattern, presets,
birthday and notification choices are back on the next request. If the switch
cannot be read (a database error) the page answers an error rather than a
`404`, so a hiccup never takes away a page that is on. The one list of what
gates `/me` is `GATED_ME_SURFACES` in `src/web/me-surfaces.ts`.

When `polls.participation.enabled` is on and you have voted on at least
one poll, the **Overview** page also shows a read-only **Poll
participation** card — lifetime votes, this-year votes, this-week votes,
and when you last voted (#655, #816). The same per-year count surfaces on
**Rewind** as the **Poll votes cast** stat, hidden in any year you cast no
votes. The weekly figure comes from per-ISO-week buckets kept for
`polls.participation.weekly_retention_weeks`, so it reads 0 for a member
whose only votes predate the weekly capture.

Notification preferences are scoped per `(userId, guildId)`. The page
lists the notification types whose DM can actually be sent, each with the
current state and a checkbox: **Achievement DMs** need `achievements.enabled`
and `achievements.dm_notifications.enabled`, **Weekly digest** needs
`digest.enabled`, and **Year-in-review** needs `rewind.enabled` and the
nudge (`rewind.nudge.enabled`). A row that is not offered keeps its stored
value and is skipped when the form is saved. With none on, the page says so
and shows no form;
toggling one row is a single POST that records the diff in the audit
log and PRG-redirects back to the page.

The **Birthday** page (`#657`) stores a month/day and an optional year
per `(userId, guildId)`. The year is optional by design — many people
share the date but not the age — and when omitted no age is computed or
shown. The page is gated by `birthdays.enabled` and answers `404` while it
is off. A "Remove my birthday" button clears the stored date. The daily birthday
announcement itself is evaluated in the member's `/me/timezone`
preference so it fires on their local day (`#524`).

The whole feature is gated by `rewind.enabled` (`#608`). When it is off
the page (and `/me/rewind/:year`) answers `404` and skips the data work
(`#1292`); the end-of-year DM nudge is a separate toggle
(`rewind.nudge.enabled`), offered on Notifications only while Rewind is on
too.

The **Voice** page (`/me/voice`, `#656`) lets a member manage the
per-user voice preferences that back the Discord control panel's
**Presets** button. It exposes two things: a **channel name pattern**
(applied to every channel you spawn from the lobby — use `{username}` as a
placeholder for your display name; leave blank for the server default
naming) and your **saved presets**. Presets themselves are still _created_
in Discord by snapshotting a live channel (control panel → Presets → Save
current as preset); the web page lets you **edit** a preset's name, channel
name, user limit, and bitrate, **set-default** (the default auto-applies on
your next lobby spawn), and **delete**. Every write goes through the same
`UserVoicePrefsService` validation as the Discord modal — so the
max-per-user cap, name/limit/bitrate bounds, and name-pattern length are
identical on both surfaces — and records a `WebAuditLog` row
(`user.voice.namepattern.set`, `user.voice.preset.edit|default|delete`).
The whole page is gated by `voicechannels.presets.enabled` and answers
`404` (its writes too) while it is off; saved presets stay stored.

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

The **"when you're online"** block (#675) shows two duration-weighted
distributions computed from your existing voice sessions — a 24-bar
hour-of-day histogram and a 7-bar day-of-week breakdown — with your peak hour
and day called out (e.g. _"Most active: Friday · 10 PM"_). Both are bucketed
in **your** timezone (set it on the Timezone page), and each session is split
across the local hour and midnight boundaries it crosses so long and overnight
sessions land in the right hours/weekdays. The block hides itself when you have
no voice activity for the year. No new data is captured — it reuses the
`startTime` and `duration` already stored on every session.

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

### Privacy and the "my data" export (`/me/privacy`, #719)

The **Privacy** page describes what Koolbot has stored about the signed-in
member and hands it over as a single JSON file from
`GET /me/privacy/export`. It is a _record_, not a recap — Rewind is the
narrative version.

What the file contains is decided by an explicit allowlist registry in
`src/services/user-data-registry.ts`, not by whatever the export code
happened to remember to query. Every field in the codebase that carries a
Discord user id is classified there as included or excluded, with the
reason, and a drift test
(`__tests__/config/user-data-registry-drift.test.ts`) scans `src/models/*.ts`
and `src/database/schema.ts` and fails the build when a user-id-shaped
field is not classified. A new per-user model therefore has to be triaged
before it can ship — the same forcing function `SETTINGS.md` has for config
keys. The page renders its two tables straight from that registry, so the
description and the file cannot drift apart.

**Included:** voice history, message and reaction activity, poll
participation, achievements and accolades, birthday, timezone and
notification opt-ins, voice presets, Rewind snapshots and nudge state,
digest state, reminders, event RSVPs, leaderboard role membership, quotes
(both the ones attributed to you and the ones you saved), and channel
invites.

**Excluded, deliberately:** the moderation log, the Discord command audit
log, the Web UI audit log, session rows, ephemeral channel-ownership state,
and admin-authored config objects that merely record who created them. A
warned member must not be able to read their own moderation history — or
learn which moderator acted — out of a self-service endpoint.

Three collections are shared aggregates (poll turnout, event RSVPs,
leaderboard role rosters). Their rows are projected down to the member's
own slice before they reach the file, so an export can never become a
roster of everyone else on the server.

Operationally: the response is served as an attachment with
`X-Content-Type-Options: nosniff` and `Cache-Control: no-store`, never
rendered as a page; it is emitted as a stream of chunks rather than
buffered into one string; append-only histories are capped at
`privacy.export.max_items` per collection with anything clipped named under
`truncated` in the file; the route has its own rate-limit bucket (3 per
minute per client); and every attempt — including one refused because the
feature is off — writes a `user.privacy.export` row to the Web UI audit
log.

#### Resetting your data (`POST /me/privacy/delete`, #917)

When `privacy.delete.enabled` is also on, the page ends with a **Reset my
data** danger-zone card. The export button is repeated above the reset
button — download first, then reset. The card is explicit that:

1. tracking starts again on the next message, reaction or voice join, so
   this is a **reset, not a deletion** — unless the member has opted out of
   tracking (below), in which case the card calls it a deletion instead;
2. moderation records and audit logs are **kept**;
3. other members' voice records may still mention the member as co-present;
4. timezone and notification preferences go back to defaults.

The handler is CSRF-checked and self-scoped like every other `/me/*` write,
and runs its steps in a fixed order: feature gate (refused with a `403` and a
`feature-disabled` audit row when off) → typed confirmation (the member must
type `RESET`; a JS `confirm()` guards the click too) → persisted per-member
cooldown (`privacy.delete.cooldown_hours`, read back from the audit log and
keyed on the intent row, so only a recorded failure lifts it; a per-member
in-process lock refuses a second concurrent request) →
an **intent** audit row, written with `recordAuditOrThrow` so the purge is
refused if the row cannot be stored → the purge coordinator
(`UserDataDeletionService`) → a **completed** audit row carrying its per-step
`PurgeReport` → session revoke and the signed-out page. The route also has
its own in-memory rate-limit bucket (5 per 15 minutes per client), separate
from the export's; that is only an outer layer, the cooldown is the real
once-per-member limit. `web-audit-log` stays out of the member's export, so
the reset trail is admin-only.

#### Opting out of tracking (`POST /me/privacy/tracking`, #918)

When `privacy.tracking_opt_out.enabled` is also on, an **Activity tracking**
card sits between the export tables and the reset card. `action=opt-out`
writes a row to `tracking-opt-out`; `action=opt-in` deletes it. While the row
exists, the message, reaction, poll-participation and voice trackers record
nothing about the member, and the member is no longer added to other members'
voice co-presence. Mentions already stored in other members' rows are kept, as
with a reset. The check is an in-memory lookup loaded at startup, not a query.

The card says plainly that existing data stays visible on leaderboards,
digests and Rewind until the member resets it, and that the opt-out is itself
stored — it is the one row a reset keeps. Opting back in restores nothing, and
voice time resumes from the next channel the member joins, not one they are
already in.
The reset card reads the opt-out state: an opted-out member's reset is
described as a **deletion**, anyone else's as a reset with a link to opt out
first.

The setting gates only the offer. An opt-out already on file is always
honoured, and the card (with its opt-in button) always renders for an
opted-out member, even with the setting or `privacy.enabled` off. Opt-out
refusals return `403` with a `feature-disabled` audit row, and every change
writes a `user.privacy.tracking` row to the Web UI audit log.

User-facing commands (`/ping`, `/voicestats`, `/seen`, `/quote`,
`/achievements`, `/help`) are **not** affected and stay in
Discord exactly as before. The per-voice-channel control panel (rename,
privacy, invite, transfer, live, waiting room) also stays in Discord —
it's a member-facing feature, not an admin tool.

---

## Accessibility

The admin panel is plain server-rendered HTML with no client-side framework,
and the conventions below are what keep it usable with a screen reader. Follow
them when adding a page or a control.

**Every control is named.** A control's caption must be a real `<label for>`
(or a wrapping `<label>`), not adjacent text. On the Settings page each row's
control carries `id="set-<config key>"` and its caption is a `<label for>`
pointing at it; the Setup Wizard uses `id="wiz-<config key>"` the same way.
Where a control's meaning comes from a column header rather than text of its
own — the Permissions role picker, for instance — add a `class="visually-hidden"`
label that names it explicitly.

**Help text is linked, not just adjacent.** Descriptions, "minimum
recommended value" warnings and dependency hints each render with an `id`, and
the control lists those ids in `aria-describedby`. Text that merely sits next
to a field is never announced with it.

**Multi-input controls are groups.** The cron picker has no single element to
label, so it renders as `role="group"` with `aria-labelledby` pointing at the
row caption, and each inner input keeps its own `aria-label`.

**Rejected values are pointed at.** When a save is refused, the server echoes
the offending config keys — as `invalidKeys` in the JSON reply for the AJAX
save, and as `?invalid=<keys>` on the no-JS redirect. Those controls render
`aria-invalid="true"` with an inline "Rejected" note, their `aria-describedby`
is extended to the flash banner carrying the reason, and focus moves to the
first of them. A page-level "something was invalid" banner on its own is not
enough on a page with hundreds of fields.

**Outcomes are announced.** The inline flash the AJAX Settings save inserts is
a `role="status"` live region, so success, CSRF failure, rate-limit and
network-error results are all read out. A flash rendered after a
redirect is not announced on its own (a live region that is part of a fresh
document never is), so `renderFlash` gives it `role="status" tabindex="-1"
data-flash` and the layout script focuses it on load when nothing is
`aria-invalid`.

**Keyboard focus is visible.** Both layouts (and the pre-auth / error shell
in `views.ts`) ship one `:focus-visible` ring (`--focus`, 2px, offset 2px)
for every link, button and form control, and the admin and `/me` layouts
mirror the sidebar / button hover surfaces for focus. Every navigated admin
and `/me` page starts with a "Skip to content" link targeting
`<main id="main" tabindex="-1">`, and the active nav item carries
`aria-current="page"`. Never add a `:hover` affordance without its
`:focus-visible` twin, and never suppress the ring on an interactive element.
The one deliberate `outline:none` is `#main:focus-visible`: `<main>` is only
focusable so the skip link can land on it, and drawing a ring around the whole
content column would be noise rather than a cue.

**Tables are tables.** Every `<th>` has a `scope` (`col` in `<thead>`, `row`
for a row header such as the command name in the Permissions matrix), and a
table whose heading doesn't sit directly above it gets a `visually-hidden`
`<caption>`. A cell must never be a glyph alone: pair `✓` / `—` / emoji with
`visually-hidden` text (or plain words) and mark the glyph `aria-hidden`.
Where a chart's only data carrier is a hover `title` (the analytics heatmap),
expose it as `role="img"` with an `aria-label` that points at the text lists
that repeat the values.

**Colours come from the design tokens.** `docs/design/tokens.json` holds the
palette and documents each token's contrast ratios; `src/web/design-assets.ts`
turns it into `tokens.css`, which the layouts link next to `kb.css` (served from
`/admin/_assets/` and `/me/_assets/`, public and cached by content hash, so the
sign-in and error pages are styled too). Write `var(--name)`, never a hex
literal. Form-control borders use `var(--control)` (3.97:1, the WCAG 1.4.11
floor is 3:1), secondary text uses `var(--muted)` (6.8:1 on a card — the 4.5:1
floor applies to small text), and destructive buttons use `var(--danger)`
(white text reaches 4.8:1). Edit a value in `tokens.json` (or `kb.css`) and
restart the bot to change it on every page; `npm run dev` does not watch those two files. Don't
introduce a new grey for "less important" text — the previous ones
(`#6b7280`, `#64748b`, `#b45309`) all failed.

**Pages reflow.** The admin sidebar collapses into a wrapping row above the
content below 760px, and `main` / `.card` scroll wide tables inside themselves
(`overflow-x:auto`) so the page never scrolls sideways at 320px. Error
responses (401 / 403 / 503) render through `renderErrorPage` in `views.ts` so
they carry `lang`, a viewport, a `<main>` landmark and the dark palette like
every other page.

**Landmarks are named.** Both layouts wrap the top bar in a `<header>` so the
session countdown and Finish button aren't stranded outside every landmark,
and each `<nav>` carries an `aria-label` (`Admin sections`,
`My preferences sections`, `Rewind year`) so a page that introduces a second
nav stays navigable.

### Automated checks (#856)

The conventions above are gated in CI by three Jest suites, so a page that
breaks one fails the build rather than being found by a user:

| Suite                                 | What it gates                                                                                                                                                        |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `__tests__/web/a11y-axe.test.ts`      | Runs [axe-core](https://github.com/dequelabs/axe-core) over every page renderer's output — labels, landmarks, heading order, `lang`, table semantics, ARIA validity. |
| `__tests__/web/a11y-routes.test.ts`   | Runs axe over pages served through the real router (consent, the 401 error page, the `/me` surface) so the wiring around the renderers is gated too.                 |
| `__tests__/web/a11y-contrast.test.ts` | Computes the WCAG contrast ratio for every colour-token foreground/background pair: 4.5:1 for text, 3:1 for control borders and the focus ring.                      |

The page list the axe scan walks lives in `__tests__/web/a11y-pages.ts`.
**When you add a page renderer, add a fixture for it there** — a page that
isn't in that list isn't gated, which is exactly how the violations fixed in
issues #853 / #855 accumulated unnoticed. Likewise, add a pair to the contrast
suite whenever you add a colour token.

Two notes on the setup. axe needs a DOM, so those two suites run under
`__tests__/jsdom-node-env.cjs` — jsdom with Node's web globals restored,
because `discord.js` pulls in undici, which jsdom alone can't satisfy. And
axe's own `color-contrast` rule is disabled there: jsdom does no layout, so
the rule cannot run — which is precisely why the palette is gated separately
by computing the ratios from the tokens.

---

## Troubleshooting

### `/config` says "The web UI is disabled"

`WEBUI_ENABLED` is not `true` (case-insensitive). Update `.env` and
restart the bot.

### `/config` says "Web UI is enabled but its configuration is invalid"

The reason follows, e.g. `WEBUI_BASE_URL is missing`,
`WEBUI_SESSION_SECRET is missing` or a `WEBUI_SESSION_SECRET` shorter than
32 bytes. Fix it in `.env` and restart.

### The DM link 404s when I click it

One of:

- It was already redeemed (single-use). Run `/me` again (administrators: `/config`).
- It expired (default 10 minutes). Run `/me` again (administrators: `/config`).
- You ran `/me` or `/config` a second time and got a _newer_ link, which revoked
  this one. Use the most recent DM.
- `WEBUI_SESSION_SECRET` changed between issuance and redemption.

### "Sign in required" on every page

Possible causes (in roughly decreasing likelihood):

- Your cookie expired (idle past `WEBUI_INACTIVITY_TIMEOUT_MINUTES`).
- The DB session row passed its hard cap (`WEBUI_SESSION_LIFETIME_HOURS`
  from redemption).
- You ran `/me` or `/config` again and revoked this session server-side.
- Permission re-check failed: an admin session lost the Administrator
  permission, or (user sessions) Web UI Permissions → `me` now restricts
  the command to roles you no longer have.
- The bot was restarted with a new `WEBUI_SESSION_SECRET`, invalidating
  the cookie signature.

Run `/me` again to mint a fresh link (administrators: `/config`).

The cookie is **not** bound to your client IP — switching networks does
not by itself end a session.

### The Web UI URL loads but won't accept my cookie

Browsers refuse `Secure`-flagged cookies over plain HTTP. The Web UI
flags its session cookie `Secure` when `WEBUI_BASE_URL` starts with
`https://` (see `shouldUseSecureCookies()` in `src/web/csrf.ts`). So:

- If you browse over HTTPS, make sure `WEBUI_BASE_URL` is the `https://`
  URL, **or**
- If you browse over plain HTTP (LAN or local testing), make sure
  `WEBUI_BASE_URL` starts with `http://`.

A mismatch between `WEBUI_BASE_URL` and the URL in your browser is the
usual cause. `NODE_ENV` is not used for the cookie flag once `WEBUI_BASE_URL` is valid,
and startup rejects an invalid one.

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
