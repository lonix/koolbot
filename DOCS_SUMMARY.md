# KoolBot Documentation Summary

This file provides an overview of the complete documentation structure.

## 📚 Documentation Files

### Core Documentation

1. **README.md**
   - Quick start guide (3 steps: download files, edit `.env` with Web UI vars, `docker compose up -d`)
   - Feature overview
   - Web UI launcher walkthrough
   - Docker management (incl. direct port publish, localhost-only, Caddy reverse proxy)
   - Backup & restore (Settings page Export/Import + `mongodump`)
   - Troubleshooting

2. **WEBUI.md** (NEW)
   - Magic-link flow diagram and lifecycle
   - Env-vs-DB configuration boundary
   - Bootstrap env vars (`WEBUI_*` + secrets)
   - Enabling the Web UI
   - Docker Compose recipes (direct publish, localhost-only, Caddy)
   - Reverse-proxy guidance (Caddy / nginx / Traefik / tunnels)
   - Public-internet exposure caveats
   - DM-closed fallback
   - Session lifecycle and revocation
   - Web UI page → legacy slash command mapping
   - Troubleshooting

3. **DEVELOPER_GUIDE.md**
   - Architecture overview including `src/web/`
   - The "no business logic outside services" rule
   - Magic-link auth flow
   - CSRF and rate-limiting patterns
   - Bot-controlled channel header posts (reusable pattern)
   - Service singleton pattern
   - Configuration management (two-tier model)
   - Feature development checklist
   - Testing guidelines
   - Code style standards

4. **COMMANDS.md**
   - User-facing slash commands (`/ping`, `/help`, `/voicestats`, `/seen`, `/achievements`, `/quote`, `/amikool`)
   - Admin launcher (`/config`) — the only admin slash command, opens the Web UI
   - Voice channel control panel
   - Permission requirements
   - Quick reference
   - Page → legacy slash command mapping

5. **SETTINGS.md**
   - Environment variables (bootstrap, read-only in Web UI)
   - WebUI env vars (`WEBUI_*`)
   - All DB-backed configuration options (edited in the Web UI)
   - Quick reference table

6. **QUICK_START_VISUAL.md**
   - Visual / ASCII flow of the 3-step quick start
   - Magic-link flow diagram
   - Docker exposure options
   - Updated architecture diagram (includes Web UI)

7. **TROUBLESHOOTING.md**
   - Initial setup issues
   - Docker problems
   - Discord connection issues
   - Command troubleshooting
   - Web UI / magic-link troubleshooting (see also WEBUI.md)
   - Voice channel issues
   - Database problems
   - Configuration issues
   - Performance optimization
   - Emergency procedures

8. **RELEASE_NOTES.md**
   - Version history
   - Feature changes
   - Migration notes (v1.0 admin commands → Web UI)

### Configuration Files

1. **.env.example**
   - Clear, commented template
   - Discord credentials instructions
   - Docker-optimized MongoDB URI
   - Web UI bootstrap env vars (`WEBUI_ENABLED`, `WEBUI_BASE_URL`,
     `WEBUI_SESSION_SECRET`, optional `WEBUI_SESSION_TTL_MINUTES`,
     `WEBUI_INACTIVITY_TIMEOUT_MINUTES`, `WEBUI_TRUST_PROXY`)
   - Debug mode options

2. **docker-compose.yml**
   - Production deployment
   - MongoDB with persistent volume
   - Operators choose how to expose port 3000 (see README + WEBUI.md
     for direct-publish, localhost-only, and Caddy recipes)

3. **docker-compose.dev.yml**
   - Development setup
   - Hot reloading
   - Volume mounts

## 🎯 Key Themes Emphasized

### User-First Deployment

- **Only 2 files needed:** `.env` and `docker-compose.yml`
- **3-step quick start:** download, configure, deploy
- **No manual builds** required for users

### Web UI as the only admin surface

- All admin configuration is browser-based, magic-link gated
- Slash command surface stays focused on member-facing actions
- One source of truth (`src/services/`) — the Web UI is a thin client

### Bootstrap-vs-DB boundary

- `.env` holds secrets and startup config only
- MongoDB holds feature settings, edited via the Web UI
- YAML import/export covers the MongoDB tier only

### Comprehensive examples

- Every feature has Web UI navigation breadcrumbs
- Real docker-compose snippets including Caddy
- Expected outputs shown

## 📊 Documentation Map (where to go for what)

| You want to…                     | Read                                |
| -------------------------------- | ----------------------------------- |
| Stand up the bot in 5 minutes    | README.md                           |
| Understand the magic-link flow   | WEBUI.md                            |
| Put the Web UI behind HTTPS      | WEBUI.md → Reverse-proxy            |
| Run `/config` and find a setting | SETTINGS.md                         |
| Look up a slash command          | COMMANDS.md                         |
| Contribute code                  | DEVELOPER_GUIDE.md, CONTRIBUTING.md |
| Debug a problem                  | TROUBLESHOOTING.md                  |
| See the visual diagram           | QUICK_START_VISUAL.md               |

## 🔗 Cross-References

All documentation files cross-reference each other:

- README → WEBUI, COMMANDS, SETTINGS, TROUBLESHOOTING, DEVELOPER_GUIDE
- WEBUI → README, COMMANDS, SETTINGS, DEVELOPER_GUIDE, TROUBLESHOOTING
- COMMANDS → README, WEBUI, SETTINGS, TROUBLESHOOTING
- SETTINGS → README, WEBUI, COMMANDS, TROUBLESHOOTING
- DEVELOPER_GUIDE → CONTRIBUTING, SETTINGS, COMMANDS, TESTING
- TROUBLESHOOTING → README, WEBUI, COMMANDS, SETTINGS

## 🎨 Formatting Standards

- **Headers:** Emoji + title for easy scanning
- **Code blocks:** Syntax highlighting with `bash`, `env`, `yaml`, `text`
- **Examples:** Real, copy-paste ready
- **Warnings:** Clearly marked with ⚠️
- **Navigation:** Table of contents in long docs
- **Visual aids:** Tables for settings and command-to-page mappings

## 🚀 User Journey

### First-time user

1. Read README Quick Start
2. Copy `.env.example` → `.env`, fill in Discord credentials and WebUI vars
3. `docker compose up -d`
4. Run `/config` in Discord → click DM link → configure in browser
5. Reference WEBUI.md if they need HTTPS / a real domain

### Troubleshooting user

1. Check TROUBLESHOOTING.md index
2. For Web UI / magic-link issues → WEBUI.md → Troubleshooting
3. Follow step-by-step solutions
4. Reference SETTINGS.md for what each key does
5. Check logs as directed

### Advanced user / operator

1. Review SETTINGS.md for all options
2. Read WEBUI.md for reverse-proxy / threat-model details
3. Use the Web UI Bootstrap page to verify env values
4. Export / import YAML for migrations and backups

### Contributor

1. Read DEVELOPER_GUIDE.md for architecture and `src/web/` layout
2. Note the "no business logic outside services" rule before adding routes
3. Run `npm run check:all` before opening a PR
4. Update the relevant docs for any user-visible change

## 📝 Notes for Maintainers

### When Adding Features

- [ ] Update README.md (features section)
- [ ] Add command to COMMANDS.md (only if user-facing slash command — admin features go in the Web UI)
- [ ] Add settings to SETTINGS.md
- [ ] Add Web UI page/section to WEBUI.md if applicable
- [ ] Add to DEVELOPER_GUIDE.md if you established a reusable pattern
- [ ] Add troubleshooting to TROUBLESHOOTING.md
- [ ] Update examples
- [ ] Add a Conventional Commits footer that release-please understands

### When Changing Configuration

- [ ] Update SETTINGS.md
- [ ] Update `.env.example` if it's an env var
- [ ] Update `PROTECTED_KEYS` in `src/web/write-routes.ts` if it's a new env var
- [ ] Update examples in README.md
- [ ] Add migration notes if breaking

### Documentation Review Checklist

- [ ] All links work
- [ ] Examples are current (no references to removed slash commands)
- [ ] Code blocks have syntax highlighting
- [ ] Cross-references are accurate
- [ ] No outdated information
- [ ] Consistent formatting
