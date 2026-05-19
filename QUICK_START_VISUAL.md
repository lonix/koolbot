# KoolBot Quick Start Visual Guide

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                          KOOLBOT QUICK START                            │
│                    (3 Steps - 5 Minutes to Deploy)                      │
└─────────────────────────────────────────────────────────────────────────┘

STEP 1: Get the Files
════════════════════════════════════════════════════════════════════════════
┌─────────────────────────────────────────────────────────────────────────┐
│ $ mkdir koolbot && cd koolbot                                           │
│                                                                         │
│ Download docker-compose.yml:                                            │
│ $ curl -O https://raw.githubusercontent.com/lonix/koolbot/main/\        │
│   docker-compose.yml                                                    │
│                                                                         │
│ Download .env.example:                                                  │
│ $ curl -O https://raw.githubusercontent.com/lonix/koolbot/main/\        │
│   .env.example                                                          │
│                                                                         │
│ Or download manually from GitHub.                                       │
└─────────────────────────────────────────────────────────────────────────┘

STEP 2: Configure
════════════════════════════════════════════════════════════════════════════
┌─────────────────────────────────────────────────────────────────────────┐
│ $ cp .env.example .env                                                  │
│ $ nano .env  # or use your favorite editor                              │
│                                                                         │
│ Edit these required values:                                             │
│   DISCORD_TOKEN=your_bot_token_here     ← Discord Developer Portal      │
│   CLIENT_ID=your_application_id_here    ← Application ID                │
│   GUILD_ID=your_server_id_here          ← Your Discord Server ID        │
│   MONGODB_URI=mongodb://mongodb:27017/koolbot  ← leave as-is for Docker │
│                                                                         │
│ Enable the admin Web UI (recommended):                                  │
│   WEBUI_ENABLED=true                                                    │
│   WEBUI_BASE_URL=http://localhost:3000                                  │
│   WEBUI_SESSION_SECRET=<paste output of: openssl rand -base64 32>       │
│                                                                         │
│ Note: dotenv does not run shell substitutions — run                     │
│   openssl rand -base64 32                                               │
│ separately on your host, then paste the output into the value.          │
│                                                                         │
│ For plain-HTTP localhost testing, also set NODE_ENV=development         │
│ (the Web UI cookie is Secure-flagged whenever NODE_ENV=production,      │
│ and browsers refuse Secure cookies over http://...).                    │
└─────────────────────────────────────────────────────────────────────────┘

Where to get credentials:
┌─────────────────────────────────────────────────────────────────────────┐
│ 1. https://discord.com/developers/applications                          │
│ 2. Create/Select Application                                            │
│ 3. Bot tab → Copy Token                                                 │
│ 4. General Info → Copy Application ID                                   │
│ 5. Discord Server → Right-click icon → Copy ID                          │
└─────────────────────────────────────────────────────────────────────────┘

STEP 3: Start with Docker
════════════════════════════════════════════════════════════════════════════
┌─────────────────────────────────────────────────────────────────────────┐
│ $ docker compose up -d                                                  │
│                                                                         │
│ ✓ Bot starts automatically                                              │
│ ✓ MongoDB configured automatically                                      │
│ ✓ Commands registered with Discord                                      │
│ ✓ Web UI mounted at /admin (only when WEBUI_ENABLED=true)               │
└─────────────────────────────────────────────────────────────────────────┘

THAT'S IT! 🎉
════════════════════════════════════════════════════════════════════════════

Your bot is now online! Configure it from a browser:

┌─────────────────────────────────────────────────────────────────────────┐
│ FROM DISCORD                                                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   /config                                                               │
│                                                                         │
│ The bot DMs you a single-use sign-in link. Click it.                    │
│                                                                         │
│ FROM THE WEB UI (browser, after clicking the link)                      │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│ • Dashboard       — Live counts and status                              │
│ • Settings        — Edit every DB-backed setting (Export/Import YAML)   │
│ • Permissions     — Per-command role gating                             │
│ • Setup Wizard    — Guided multi-feature configuration                  │
│ • Announcements   — Schedule posts; run weekly stats now                │
│ • Polls           — Schedules + question library                        │
│ • Reaction Roles  — Create / archive / unarchive / delete               │
│ • Notices         — Server rules / info / help / game-server posts      │
│ • Voice Channels  — Cleanup, currently-managed channels                 │
│ • Database        — Cleanup status, run now                             │
│ • Bootstrap       — Read-only .env diagnostics                          │
│                                                                         │
│ Click [Finish] when done. The link is dead after that.                  │
└─────────────────────────────────────────────────────────────────────────┘

MAGIC-LINK FLOW (under the hood)
════════════════════════════════════════════════════════════════════════════
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│   You (Discord)                                                         │
│        │                                                                │
│        │  /config                                                       │
│        ▼                                                                │
│   KoolBot ───► MongoDB (insert web_session: tokenHash, expires_at, ...) │
│        │                                                                │
│        │  DM single-use URL                                             │
│        ▼                                                                │
│   You (DM tab)                                                          │
│        │                                                                │
│        │  click the link in browser                                     │
│        ▼                                                                │
│   GET /admin/s/<token>                                                  │
│        │   ✓ token unused, not expired, not revoked                     │
│        │   → mark used, issue signed cookie, 302 → /admin/              │
│        ▼                                                                │
│   /admin/* pages (re-check permissions every request)                   │
│        │                                                                │
│        │  click [Finish]                                                │
│        ▼                                                                │
│   session revoked, cookie cleared, /admin/* → 401                       │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘

DOCKER COMMANDS
════════════════════════════════════════════════════════════════════════════
┌─────────────────────────────────────────────────────────────────────────┐
│ View logs:     docker compose logs -f bot                               │
│ Restart:       docker compose restart bot                               │
│ Stop:          docker compose down                                      │
│ Update:        docker compose pull && docker compose up -d              │
│ Force-recreate after .env edits:                                        │
│                docker compose up -d --force-recreate                    │
└─────────────────────────────────────────────────────────────────────────┘

EXPOSING THE WEB UI
════════════════════════════════════════════════════════════════════════════
┌─────────────────────────────────────────────────────────────────────────┐
│ The default docker-compose.yml publishes port 3000 to the host         │
│ already (LAN/VPN-only, no HTTPS). To change that, edit the bot         │
│ service's ports: block:                                                │
│                                                                         │
│  Direct port publish (shipped default):                                 │
│    ports:                                                               │
│      - "3000:3000"                                                      │
│                                                                         │
│  Localhost only (SSH tunnel in):                                        │
│    ports:                                                               │
│      - "127.0.0.1:3000:3000"                                            │
│                                                                         │
│  Caddy reverse proxy (recommended for internet-facing, HTTPS free):    │
│    Remove the ports: block; let Caddy forward to bot:3000.             │
│    See WEBUI.md → Docker Compose recipes for a full example.           │
│                                                                         │
│  Tailscale / Cloudflare Tunnel:                                         │
│    Remove the ports: block. Point WEBUI_BASE_URL at your tunnel URL.   │
└─────────────────────────────────────────────────────────────────────────┘

TROUBLESHOOTING
════════════════════════════════════════════════════════════════════════════
┌─────────────────────────────────────────────────────────────────────────┐
│ Bot not starting?                                                       │
│   → Check logs:        docker compose logs bot                          │
│   → Verify .env has DISCORD_TOKEN, CLIENT_ID, GUILD_ID, MONGODB_URI     │
│                                                                         │
│ /config says "the web UI is disabled"?                                  │
│   → Set WEBUI_ENABLED=true and restart                                  │
│                                                                         │
│ /config says "missing env vars"?                                        │
│   → Set WEBUI_BASE_URL and WEBUI_SESSION_SECRET in .env, restart        │
│                                                                         │
│ DM link 404s when clicked?                                              │
│   → Already used, expired, or superseded by a newer /config call        │
│   → Run /config again                                                   │
│                                                                         │
│ Commands not appearing?                                                 │
│   → Web UI → Settings → set <command>.enabled = true                    │
│   → Click "Reload commands to Discord"                                  │
│   → Wait 2-5 minutes                                                    │
│                                                                         │
│ Need help?                                                              │
│   → See WEBUI.md, TROUBLESHOOTING.md                                    │
│   → https://github.com/lonix/koolbot/issues                             │
└─────────────────────────────────────────────────────────────────────────┘

ARCHITECTURE (What Gets Deployed)
════════════════════════════════════════════════════════════════════════════
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│    ┌───────────────┐    ┌────────────────┐    ┌──────────────┐          │
│    │   Discord     │◄──►│   KoolBot      │◄──►│   MongoDB    │          │
│    │   Server      │    │  Container     │    │  Container   │          │
│    │               │    │  • Bot         │    └──────────────┘          │
│    │  Slash cmds   │    │  • /health     │            ▲                 │
│    │  +DM messages │    │  • /admin (UI) │            │                 │
│    └──────┬────────┘    └────────┬───────┘            │                 │
│           │                      │                    │                 │
│           │                      │ port 3000          │ persistent      │
│           │                      ▼                    │ volume          │
│           │             ┌────────────────┐            │                 │
│           │             │ Your Browser   │            │                 │
│           │             │ (admin Web UI) │            │                 │
│           │             └────────────────┘            │                 │
│           │                                           │                 │
│           └────── DM with sign-in link ───────────────┘                 │
│                                                                         │
│    Files you need:                                                      │
│    • docker-compose.yml and .env                                        │
│    • Docker (and optionally a reverse proxy for HTTPS)                  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘

DOCUMENTATION
════════════════════════════════════════════════════════════════════════════
┌─────────────────────────────────────────────────────────────────────────┐
│ README.md           → Overview, quick start, examples                   │
│ WEBUI.md            → Web UI setup, magic-link flow, reverse proxies    │
│ COMMANDS.md         → All slash commands with usage examples            │
│ SETTINGS.md         → All configuration options explained               │
│ DEVELOPER_GUIDE.md  → Architecture, src/web/, services pattern          │
│ TROUBLESHOOTING.md  → Common issues and solutions                       │
│ .env.example        → Environment variable template                     │
└─────────────────────────────────────────────────────────────────────────┘
```
