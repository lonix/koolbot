# KoolBot 2.0 🎉

**Your community, your data, your bot, now with a place for everyone.**

KoolBot 2.0 is the biggest release since 1.0. The bot stopped being only a voice-channel manager and became a full
community toolkit: events, birthdays, reminders, moderation, looking-for-group posts and a much richer
year-in-review. Members get their own self-service space, and your community gets real control over its own data.

Everything is still self-hosted. Your Discord application, your MongoDB, no telemetry, no hosted service.

> This page is the highlight reel. The complete, generated list of every change lives in
> [CHANGELOG.md](CHANGELOG.md).

---

## ⚠️ Before you upgrade

Three things behave differently. Skim these first.

| What changed | Who it affects | What to do |
| --- | --- | --- |
| **`/config` is now Administrator-only.** Members use the new **`/me`** instead. | Anyone who told members to run `/config` for their birthday, timezone or notification settings. | Point members to `/me`. Admins keep `/config` for the admin panel. |
| **Notification DMs are opt-in.** KoolBot never DMs a member who has not switched a channel on under `/me/notifications`. | Members who used to get accolade, digest or Rewind-nudge DMs by default. | Nothing breaks, but those DMs stop until each member opts in. Worth a heads-up in your server. |
| **Poll import by URL is gone.** Import is now file upload or paste only. `POLL_IMPORT_ALLOWED_HOSTS` is removed. | Anyone who hosted a poll library at a URL. | Use **Polls → Import questions** in the Web UI. Same format, same validation. |

---

## ✨ What's new

### 🙋 `/me`: a home for every member

Every member can now run `/me` to get a private sign-in link to their own corner of the Web UI: birthday, timezone,
notification opt-ins, voice channel presets, their Rewind, and privacy tools. A `/me` link never carries admin
scope, even if an administrator opens it.

### 🔒 Privacy you can actually use

2.0 treats member data as the member's own.

- **Export** everything KoolBot holds about you from `/me/privacy`.
- **Reset** your data from the same page.
- **Opt out of tracking**, so a reset becomes a real deletion and nothing new is recorded. Admins switch the offer on with
  `privacy.tracking_opt_out.enabled`.
- **No unprompted DMs**, ever (see the upgrade notes above).

Retention is your community's choice, and `0` keeps data forever.

### 🎪 Events with their own voice channels

Schedule an event and KoolBot creates a temporary voice channel shortly before it starts, collects RSVPs, reminds
attendees, and cleans the channel up once the event is over. Great for communities that don't keep static voice
channels around. Manage it from `/event` or the **Events** admin page.

### 🎮 Looking for group, in one command

`/lfg game:"Helldivers 2" size:4` posts a call to play right now, and people join from the post itself.

### 🎂 Birthdays, in the right timezone

Members set their birthday once, and KoolBot celebrates it on their day in their own timezone. Time-of-day and
day-of-week accolades are now timezone-aware too. There's a **Birthdays** admin page, and members can clear their
birthday any time from `/me`.

### ⏰ Personal reminders

`/remind set message:"renew server sub" in:2h` and KoolBot DMs it back when it's due. Reminders are a request the
member made, so they work even with notification DMs switched off.

### 🛡️ Lightweight moderation log

`/warn`, `/timeout`, `/ban` and `/modlog` give moderators one searchable history per member. Native kicks, bans and
timeouts from the audit log are mirrored in, and the mod channel can show a member's prior history the moment a new
action is recorded. Retention is configurable and cleanup runs daily. See the **Moderation** admin page.

### 📊 Rewind, weekly recaps and achievements got richer

- Rewind gains an hour-of-day and day-of-week **voice heatmap**, reaction activity and poll participation.
- The weekly recap now includes **quote of the week** and **poll turnout**.
- **Achievements** show progress, and the reserved weekly achievements are now live.
- Marquee accolade milestones can be **celebrated server-wide**.
- Polls track weekly votes and turnout.

### 🎭 Reaction roles, much more capable

Beyond emoji reactions you can now use **buttons and select menus**, choose an **assignment mode**, put **several
mappings on one message**, and **bind to roles that already exist**. Mappings reconcile at startup and when a message
or channel disappears.

### 📣 Announcements, polls and quotes

- **Post now** for one-off announcements, with a bigger placeholder set.
- Edit poll questions and schedules in place.
- Quote of the week is ranked by votes cast that week.
- `/aka` shows a member's previously known names.

### 🧭 A Web UI that feels finished

- The **Setup Wizard** now covers moderation, events, digest, birthdays, reminders and leaderboard roles, and it renders
  channel, category and role pickers properly.
- Feature pages edit their own settings in place, with an enable/disable toggle.
- Settings that depend on another feature are greyed out with a "requires X" hint, and dependencies are enforced on
  write.
- New admin pages: **Quotes**, **Leaderboard Roles**, **Birthdays**, **Digest** (preview and send now) and a
  **command metrics** dashboard.
- The admin sidebar is grouped into sections, and enabled features sort above disabled ones.
- The Web UI shows the version you're running next to the latest release.
- Accessibility work brings the admin and `/me` pages to WCAG 2.1 AA, with automated checks in CI.

---

## 🛠️ Solid underneath

- **Security:** CSRF protection on magic-link sign-in, permissions fail closed when the cache can't load, and many
  dependency advisories cleared.
- **Reliability:** scheduled jobs share one lifecycle (`ScheduledService`) and re-arm when you save a schedule in the Web
  UI. Atomic updates fix lost RSVPs and cleanup races. The voice cleanup sweep never deletes the lobby or an occupied
  channel.
- **Docker:** `node:24-alpine` base image, a non-root numeric user, an exec-form healthcheck, and a dev container that
  really hot-reloads.
- **Tooling:** a sample-data seeder for dev databases, and 200+ test suites guarding the whole thing.

---

## 🚀 Upgrading

1. Read the upgrade table at the top of this page.
2. Pull the new image (or `git pull` and rebuild) and restart.
3. Reload commands so Discord picks up `/me` and the admin-only `/config`.
4. Tell your members about `/me`, and that DMs are now opt-in.
5. Optionally open the **Setup Wizard** to see the new features.

Something off? Open an issue on [GitHub](https://github.com/lonix/koolbot/issues).

Thank you to everyone who filed issues, reviewed pull requests and ran KoolBot in their own corner of Discord. 💙
