import { GUILD_MEMBERS_INTENT_HOWTO } from "../utils/guild-members-intent.js";
import type { SettingFormat } from "../utils/setting-formats.js";
import {
  GROUP_WORDING_OPTIONS,
  LEADER_WORDING_OPTIONS,
} from "./event-group-wording.js";

export interface ConfigSchema {
  // Voice Channel Management
  "voicechannels.enabled": boolean;
  "voicechannels.category_id": string;
  "voicechannels.lobby.channel_id": string;
  "voicechannels.lobby.name": string;
  "voicechannels.lobby.offlinename": string;
  "voicechannels.lobby.max_rooms": number; // Rooms per member per window; 0 = no limit (#1147)
  "voicechannels.lobby.room_window_seconds": number;
  "voicechannels.channel.prefix": string;
  "voicechannels.channel.suffix": string;
  "voicechannels.cleanup.managed_only": boolean;
  "voicechannels.controlpanel.enabled": boolean;
  "voicechannels.owner.grant_status": boolean;
  "voicechannels.presets.enabled": boolean;
  "voicechannels.presets.max_per_user": number;

  // Voice Activity Tracking
  "voicetracking.enabled": boolean;
  "voicetracking.stats.top.enabled": boolean; // Enable /voicestats top subcommand
  "voicetracking.stats.user.enabled": boolean; // Enable /voicestats user subcommand
  "voicetracking.stats.leaderboard_max_results": number; // Server-side cap on /voicestats top rows
  "voicetracking.seen.enabled": boolean;
  "voicetracking.companions.enabled": boolean; // Capture precise per-companion overlap + voice "firsts" (#570)
  "voicetracking.excluded_channels": string; // Comma-separated channel IDs
  "voicetracking.announcements.enabled": boolean;
  "voicetracking.announcements.schedule": string; // Cron schedule
  "voicetracking.announcements.channel_id": string; // Channel ID for voice-stats announcements
  // Weekly recap section toggles (#777) — admins can turn each part of the
  // scheduled recap on/off independently. A section also stays hidden unless
  // the feature that produces its data is itself enabled.
  "voicetracking.announcements.include_voice_stats": boolean;
  "voicetracking.announcements.include_accolades": boolean;
  "voicetracking.announcements.include_quote_of_week": boolean;
  "voicetracking.announcements.include_poll_turnout": boolean;

  // Voice Channel Cleanup
  "voicetracking.cleanup.enabled": boolean;
  "voicetracking.cleanup.schedule": string; // Cron schedule for cleanup
  "voicetracking.cleanup.retention.detailed_sessions_days": number;
  "voicetracking.cleanup.retention.monthly_summaries_months": number;
  "voicetracking.cleanup.retention.yearly_summaries_years": number;

  // Text-Message Activity Tracking (#495)
  "messagetracking.enabled": boolean; // Master switch — turning this off stops the listener entirely
  "messagetracking.excluded_channels": string; // Comma-separated channel IDs to skip
  "messagetracking.cleanup.enabled": boolean; // Master switch for the cleanup job
  "messagetracking.cleanup.schedule": string; // Cron schedule for the cleanup job
  "messagetracking.cleanup.retention.detailed_days": number; // Drop recentMessages older than N days

  // Reaction Activity Tracking (#570)
  "reactiontracking.enabled": boolean; // Master switch — turning this off stops the listener entirely
  "reactiontracking.excluded_channels": string; // Comma-separated channel IDs to skip

  // Individual Features
  "ping.enabled": boolean;

  // Quote System Settings
  "quotes.enabled": boolean;
  "quotes.channel_id": string; // Channel ID for quote messages
  "quotes.delete_roles": string; // Comma-separated role IDs
  "quotes.max_length": number; // Maximum quote length
  "quotes.cooldown": number; // Cooldown in seconds between quote additions
  "quotes.header_enabled": boolean; // Enable header post in quote channel
  "quotes.header_message_id": string; // Message ID of the header post
  "quotes.header_pin_enabled": boolean; // Pin the header post
  "quotes.clear_on_sync": boolean; // Wipe and re-post the entire channel on quote sync
  "quotes.vote_history_days": number; // Retention for per-vote like timing (days)

  // Rate Limiting
  "ratelimit.enabled": boolean;
  "ratelimit.max_commands": number; // Maximum commands per time window
  "ratelimit.window_seconds": number; // Time window in seconds
  "ratelimit.bypass_admin": boolean; // Bypass rate limit for admins
  "ratelimit.max_components": number; // Maximum button/select/modal interactions per time window

  // Scheduled Announcements
  "announcements.enabled": boolean;

  // Achievements System
  "achievements.enabled": boolean;
  "achievements.announcements.enabled": boolean;
  "achievements.dm_notifications.enabled": boolean;

  // Marquee Milestone Celebrations (#657, Part 2)
  "celebrations.enabled": boolean;
  "celebrations.channel_id": string; // Channel for server-wide milestone shout-outs

  // Weekly Personal Voice-Activity Digest (#483)
  "digest.enabled": boolean;
  "digest.cron": string; // Cron schedule, default Monday 09:00
  "digest.min_active_minutes": number; // Min weekly minutes to qualify
  "digest.streak_min_minutes": number; // Per-week minutes that count toward a streak
  "digest.include_achievements": boolean;

  // Annual Personal Year-in-Review (Rewind) (#484)
  "rewind.enabled": boolean; // Gates the /me/rewind feature (page + nav)
  "rewind.nudge.enabled": boolean; // Gates the end-of-year DM nudge only (#608)
  "rewind.cron": string; // Cron schedule for the end-of-year DM nudge
  "rewind.min_minutes": number; // Min annual minutes to qualify for the nudge

  // Birthdays (#657)
  "birthdays.enabled": boolean;
  "birthdays.cron": string; // Cron schedule for the birthday check (sub-daily)
  "birthdays.channel_id": string; // Channel ID for birthday announcements
  "birthdays.message": string; // Template; {user} mention, {username}, {age}
  "birthdays.mention": boolean; // Whether the announcement pings the member
  "birthdays.role_id": string; // Optional temporary "birthday" role
  "birthdays.role_duration_hours": number; // How long the temp role is held
  "birthdays.change_cooldown_seconds": number; // Min seconds between a member changing their birthday date (0 = off)
  "welcome.enabled": boolean;
  "welcome.channel_id": string; // Channel for new-member welcome messages
  "welcome.message": string; // Template; {user}, {username}, {server}, {roles}, {rules}
  "welcome.mention": boolean; // Whether {user} pings the new member
  "welcome.roles_message_id": string; // Optional reaction-role message to deep-link as {roles}
  "welcome.rules_channel_id": string; // Optional rules channel mentioned as {rules}

  "rules.enabled": boolean;
  "rules.channel_id": string; // Read-only channel holding the rules message
  "rules.role_id": string; // Role granted when a member accepts
  "rules.message": string; // Rules text shown above the Accept button
  "rules.button_label": string; // Accept button text
  "rules.message_id": string; // Managed by KoolBot: the posted rules message

  // Events — scheduled/temporary voice channels (#708)
  "events.enabled": boolean;
  "events.category_id": string; // Category the temp event voice channels are created under
  "events.announcement_channel_id": string; // Channel where event announcements + reminders post
  "events.timezone": string; // IANA zone used to interpret event start times (empty → server tz)
  "events.channel_prefix": string; // Prefix for auto-created event channel names
  "events.reminder_minutes": number; // How long before start the reminder is posted
  "events.create_lead_minutes": number; // How long before start the temp channel is created
  "events.default_duration_minutes": number; // Default event length when none is given
  "events.channel_grace_minutes": number; // How long after end an empty channel lingers before cleanup
  "events.recurrence_enabled": boolean; // Allow recurring events (weekly/biweekly/monthly series)
  "events.native.location": string; // Location text shown on the mirrored native event
  "events.native.link_room": boolean; // Point the native event at the event's voice room once it exists
  "events.groups.default_count": number; // Group rows the event form offers up front
  "events.groups.max_count": number; // Most groups one event may have
  "events.groups.group_label": string; // What a group is called when an event names none (a listed word)
  "events.groups.leader_label": string; // What a group leader is called when an event names none (a listed word)
  "events.max_active_per_host": number; // Most open events one non-admin host may have at once (0 = no limit)

  // LFG — ad-hoc "looking for group" posts (#957)
  "lfg.enabled": boolean;
  "lfg.channel_id": string; // Channel LFG posts go to (empty → the channel /lfg was run in)
  "lfg.expiry_minutes": number; // How long a post stays open before the sweep closes it
  "lfg.default_size": number; // Party size used when the member doesn't give one
  "lfg.max_active_per_user": number; // Cap on a member's simultaneously open posts (0 = no cap)
  "lfg.voice_channel.enabled": boolean; // Attach a dynamic voice channel to each post
  "reminders.enabled": boolean;
  "reminders.max_pending": number; // Per-member cap on undelivered reminders
  "tickets.enabled": boolean;
  "tickets.category_id": string; // Category private ticket channels are created under
  "tickets.staff_role_id": string; // Role that sees and handles every ticket
  "tickets.transcript_on_close": boolean; // Attach a plain-text message log when a ticket closes
  "tickets.max_open_per_member": number; // Cap on a member's simultaneously open tickets (0 = no cap)
  "tickets.open_cooldown_seconds": number; // Min seconds between a member's /ticket open (0 = off)

  // Self-service data export (#719)
  "privacy.enabled": boolean; // Gates the /me/privacy page and its export route
  "privacy.export.max_items": number; // Per-collection ceiling on exported rows
  "privacy.delete.enabled": boolean; // Gates the self-service "Reset my data" action
  "privacy.delete.cooldown_hours": number; // Per-member wait from the start of one reset to the next
  "privacy.tracking_opt_out.enabled": boolean; // Offers the member tracking opt-out on /me/privacy (#918)

  // Reaction Roles
  "reactionroles.enabled": boolean;
  "reactionroles.message_channel_id": string; // Channel for reaction role messages
  "reactionroles.group_role_colour": string; // #RRGGBB for generated group roles ("" = default)
  "reactionroles.max_toggles": number; // Role flips one member may make per window (0 = no limit)
  "reactionroles.toggle_window_seconds": number; // Length of that window in seconds
  "reactionroles.style": string; // Surface style for new role messages: reaction | button | select

  // Notices System
  "notices.enabled": boolean;
  "notices.channel_id": string; // Channel ID for notice messages
  "notices.header_enabled": boolean; // Enable header post in notices channel
  "notices.header_message_id": string; // Message ID of the header post
  "notices.header_pin_enabled": boolean; // Pin the header post

  // Poll System
  "polls.enabled": boolean;
  "polls.default_duration_hours": number; // Default poll duration in hours (1-768)
  "polls.cooldown_days": number; // Minimum days between reusing same poll
  "polls.participation.enabled": boolean; // Capture per-user votes cast for a future Rewind (#570)
  "polls.participation.weekly_retention_weeks": number; // Keep per-ISO-week vote buckets this long (0 = forever) (#816)
  "polls.turnout.retention_days": number; // Keep per-poll turnout rows this long (0 = forever) (#816)

  // Leaderboard Role Rewards
  "leaderboard_roles.enabled": boolean;
  "leaderboard_roles.period": string; // "week" | "month" | "alltime"
  "leaderboard_roles.update_cron": string; // Cron schedule for recalculation
  "leaderboard_roles.tiers": string; // Comma-separated "topN:roleId" pairs, e.g. "1:111,3:222,10:333"
  "leaderboard_roles.announcement_channel_id": string; // Optional channel ID for role-change announcements

  // Discord-channel logging categories consumed by DiscordLogger (#844).
  // Each `core.<type>.enabled` toggle pairs with a `core.<type>.channel_id`
  // that names the text channel the embeds are posted to.
  "core.webui.link_delivery": string; // How /me and /config deliver the sign-in link: dm | ephemeral
  "core.guild_scope.leave_other_guilds": boolean; // Leave any guild other than GUILD_ID (#1144)
  "core.webui.signin_cooldown_seconds": number; // Min seconds between sign-in links per member (0 = off)
  "core.startup.enabled": boolean;
  "core.startup.channel_id": string;
  "core.errors.enabled": boolean;
  "core.errors.channel_id": string;
  "core.cleanup.enabled": boolean;
  "core.cleanup.channel_id": string;
  "core.config.enabled": boolean;
  "core.config.channel_id": string;
  "core.cron.enabled": boolean;
  "core.cron.channel_id": string;
  "core.moderation.enabled": boolean;
  "core.moderation.channel_id": string;
  // Case review-due notice (#908): same category machinery as above.
  "core.moderation_review.enabled": boolean;
  "core.moderation_review.channel_id": string;
  // Update-available note (#1029): a DiscordLogger category like the above.
  "core.updates.enabled": boolean;
  "core.updates.channel_id": string;

  // Web UI update check (#1029)
  "core.updatecheck.enabled": boolean;

  // Discord slash-command audit log (issue #459)
  "core.command_audit.enabled": boolean;
  "core.command_audit.retention_days": number;

  // WebUI audit log retention (issue #756)
  "core.web_audit.retention_days": number; // 0 = keep history forever

  // Persisted command metrics (issue #648)
  "monitoring.metrics_persistence.enabled": boolean;
  "monitoring.metrics_retention_days": number;

  // Moderation log (issue #728)
  "moderation.enabled": boolean;
  "moderation.retention_days": number; // 0 = keep history forever (issue #742)
  // Case lifecycle on top of the log (issue #908)
  "moderation.cases.enabled": boolean;
  "moderation.cases.review_cron": string; // Cron schedule for the due-review job
  "moderation.cases.default_review_days": number; // Pre-filled review window
  "moderation.cases.retention_days": number; // Resolved cases; 0 = keep forever
  "moderation.cases.history_grace_days": number; // 0 = protect forever
  // Anti-raid protection (issue #1045)
  "moderation.raid.enabled": boolean;
  "moderation.raid.dry_run": boolean; // Preview: detect and alert, never act on a member
  "moderation.raid.join_threshold": number; // Lockdown when MORE than this many join in the window
  "moderation.raid.window_seconds": number;
  "moderation.raid.lockdown_action": string; // kick | timeout | quarantine
  "moderation.raid.min_account_age_hours": number; // 0 = new-account gate off
  "moderation.raid.new_account_action": string; // kick | timeout | quarantine
  "moderation.raid.timeout_minutes": number;
  "moderation.raid.quarantine_role_id": string;
  "moderation.raid.lockdown_max_minutes": number; // 0 = until a moderator clears it
  "moderation.raid.alert_channel_id": string;

  // Name history + /aka (issue #1038)
  "aka.enabled": boolean;
  "namehistory.enabled": boolean;
  "namehistory.retention_days": number; // 0 = keep forever

  // Server adoption snapshots (#1018)
  "adoption.snapshot.retention_days": number; // 0 = keep snapshots forever

  // Role group sync with Discord (#1021)
  "adoption.role_groups.sync_policy": string; // flag | adopt | enforce
  "adoption.role_groups.reconcile_enabled": boolean;
  "adoption.role_groups.reconcile_cron": string;
  "core.role_groups.enabled": boolean;
  "core.role_groups.channel_id": string;
}

/**
 * Defaults applied to a fresh deployment. Two rules govern booleans:
 *
 *   1. **Top-level feature gates default to `false`.** Every
 *      `<feature>.enabled` key that controls whether a feature runs at
 *      all (voicechannels, voicetracking, quotes, polls, notices,
 *      announcements, achievements, reactionroles, leaderboard_roles,
 *      ratelimit, ping) ships off. Operators opt in via the Setup
 *      Wizard or Settings page — consistent with #438's "wizard starts
 *      blank" semantics and #445's broader audit.
 *
 *   2. **Sub-feature defaults may be `true` if they're inert until the
 *      parent feature is enabled and the operator who turns the parent
 *      on almost certainly wants them.** Examples:
 *      - `voicechannels.controlpanel.enabled` — the in-channel control
 *        panel is the headline UX of voice channels; nobody enabling
 *        voicechannels wants it hidden.
 *      - `quotes.header_enabled` / `notices.header_enabled` /
 *        `*.header_pin_enabled` — pinned informational headers in the
 *        managed channels; helpful by default, harmless when the
 *        parent feature is off.
 *      - `achievements.announcements.enabled` /
 *        `achievements.dm_notifications.enabled` — silent achievements
 *        are pointless; enabling achievements implies wanting at least
 *        one notification path.
 *
 * If you add a new `<feature>.enabled` key, default it to `false`. If
 * you add a sub-feature toggle, apply rule 2 deliberately and add a
 * brief comment so the next reader can audit the choice.
 */
export const defaultConfig: ConfigSchema = {
  // Voice Channel Management
  "voicechannels.enabled": false,
  "voicechannels.category_id": "",
  "voicechannels.lobby.channel_id": "",
  "voicechannels.lobby.name": "Lobby",
  "voicechannels.lobby.offlinename": "Offline Lobby",
  "voicechannels.lobby.max_rooms": 5,
  "voicechannels.lobby.room_window_seconds": 60,
  "voicechannels.channel.prefix": "🎮",
  "voicechannels.channel.suffix": "",
  "voicechannels.cleanup.managed_only": false,
  "voicechannels.controlpanel.enabled": true,
  "voicechannels.owner.grant_status": true,
  "voicechannels.presets.enabled": false,
  "voicechannels.presets.max_per_user": 3,

  // Voice Activity Tracking
  "voicetracking.enabled": false,
  "voicetracking.stats.top.enabled": false,
  "voicetracking.stats.user.enabled": false,
  "voicetracking.stats.leaderboard_max_results": 50,
  "voicetracking.seen.enabled": false,
  // Companion overlap + voice "firsts" capture (#570). Off by default
  // (rule 1): turning it on makes voice sessions persist precise
  // per-companion co-presence seconds and join-order metadata. The base
  // session shape is unchanged while this is off.
  "voicetracking.companions.enabled": false,
  "voicetracking.excluded_channels": "",
  "voicetracking.announcements.enabled": false,
  "voicetracking.announcements.schedule": "0 16 * * 5", // Every Friday at 16:00
  "voicetracking.announcements.channel_id": "",
  // Recap sections default on; each is inert until its own feature is enabled.
  "voicetracking.announcements.include_voice_stats": true,
  "voicetracking.announcements.include_accolades": true,
  "voicetracking.announcements.include_quote_of_week": true,
  "voicetracking.announcements.include_poll_turnout": true,

  // Voice Channel Cleanup
  "voicetracking.cleanup.enabled": false,
  "voicetracking.cleanup.schedule": "0 0 * * *", // Every day at midnight
  "voicetracking.cleanup.retention.detailed_sessions_days": 400, // Full Rewind year + buffer (mirrors messagetracking.cleanup.retention.detailed_days)
  "voicetracking.cleanup.retention.monthly_summaries_months": 6,
  "voicetracking.cleanup.retention.yearly_summaries_years": 1,

  // Text-Message Activity Tracking defaults (#495). Master gate off,
  // follows rule 1 — the listener does nothing until an operator opts in.
  // This is the data-capture foundation; surfacing lives in the Rewind
  // text-stats follow-up.
  "messagetracking.enabled": false,
  "messagetracking.excluded_channels": "",
  "messagetracking.cleanup.enabled": false,
  "messagetracking.cleanup.schedule": "0 3 * * *", // Daily at 03:00 host timezone
  "messagetracking.cleanup.retention.detailed_days": 400, // Full Rewind year + buffer

  // Reaction Activity Tracking defaults (#570). Master gate off, follows
  // rule 1 — the messageReactionAdd listener does nothing until an operator
  // opts in. Data-capture foundation only; only lifetime + per-year counts
  // are stored, so no cleanup job is needed.
  "reactiontracking.enabled": false,
  "reactiontracking.excluded_channels": "",

  // Individual Features
  "ping.enabled": false,

  // Quote System Defaults
  "quotes.enabled": false,
  "quotes.channel_id": "",
  "quotes.delete_roles": "", // Empty means only admins can delete
  "quotes.max_length": 1000,
  "quotes.cooldown": 60,
  "quotes.header_enabled": true, // Enable informational header post
  "quotes.header_message_id": "", // Stores header message ID
  "quotes.header_pin_enabled": true, // Pin header for easy access
  // Destructive — off by default (rule 1: operator must explicitly opt in)
  "quotes.clear_on_sync": false,
  // How long timestamped 👍 events are kept so the weekly recap can rank by
  // votes cast this week rather than quotes added this week (#817).
  "quotes.vote_history_days": 30,

  // Rate Limiting defaults
  "ratelimit.enabled": false,
  "ratelimit.max_commands": 5, // 5 commands
  "ratelimit.window_seconds": 10, // per 10 seconds
  "ratelimit.bypass_admin": true, // Admins bypass rate limits
  "ratelimit.max_components": 15, // 15 button/select/modal interactions per window

  // Scheduled Announcements defaults
  "announcements.enabled": false,

  // Achievements defaults
  "achievements.enabled": false,
  "achievements.announcements.enabled": true,
  "achievements.dm_notifications.enabled": true,

  // Marquee milestone celebrations (#657, Part 2). Master gate off,
  // follows rule 1 — when on, the bot posts a loud, server-wide shout-out
  // to `celebrations.channel_id` the first time anyone crosses a curated
  // rare accolade (Voice Legend, 1000 hours, etc.). Reuses the existing
  // session-end award detection, so it's inert without achievements
  // (hard dependency below) and stays silent until a channel is set.
  "celebrations.enabled": false,
  "celebrations.channel_id": "",

  // Weekly digest defaults (#483). Master gate off, follows rule 1. The
  // achievements sub-toggle defaults on so an operator who flips the
  // master switch gets the richer embed without an extra step (parent
  // gate keeps it inert until they do).
  "digest.enabled": false,
  "digest.cron": "0 9 * * 1", // Mondays at 09:00 in the host timezone
  "digest.min_active_minutes": 30,
  "digest.streak_min_minutes": 30,
  "digest.include_achievements": true,

  // Rewind year-in-review defaults (#484, #608). Master gate off,
  // follows rule 1 — the /me/rewind page, its data aggregation, and the
  // nav link are all gated by `rewind.enabled`. The end-of-year DM nudge
  // has its own independent toggle (`rewind.nudge.enabled`).
  "rewind.enabled": false,
  "rewind.nudge.enabled": false,
  "rewind.cron": "0 10 30 12 *", // Dec 30 at 10:00 in the host timezone
  "rewind.min_minutes": 60,

  // Birthday defaults (#657). Master gate off, follows rule 1 — the
  // hourly check does nothing until an operator opts in and points it at
  // a channel. The hourly cadence (rather than once-daily) lets the post
  // fire on each member's *local* day across timezones; the per-row
  // `lastAnnouncedYear` guard keeps it to one announcement per year.
  "birthdays.enabled": false,
  "birthdays.cron": "0 * * * *", // Top of every hour (host timezone)
  "birthdays.channel_id": "",
  "birthdays.message": "🎂 Happy birthday, {user}! 🎉",
  "birthdays.mention": true,
  "birthdays.role_id": "", // Empty → no temporary role granted
  "birthdays.role_duration_hours": 24,
  "birthdays.change_cooldown_seconds": 300,

  // Welcome messages (#767)
  "welcome.enabled": false,
  "welcome.channel_id": "",
  "welcome.message": "👋 Welcome to {server}, {user}!",
  "welcome.mention": true,
  "welcome.roles_message_id": "",
  "welcome.rules_channel_id": "",

  // Rules / TOS acceptance role (#1024) — off by default
  "rules.enabled": false,
  "rules.channel_id": "",
  "rules.role_id": "",
  "rules.message":
    "Please read the server rules above, then press the button to accept them and unlock the rest of the server.",
  "rules.button_label": "I accept the rules",
  "rules.message_id": "",

  // Events (#708) — feature gate off by default (rule 1)
  "events.enabled": false,
  "events.category_id": "",
  "events.announcement_channel_id": "",
  "events.timezone": "", // Empty → host/server timezone
  "events.channel_prefix": "📅",
  "events.reminder_minutes": 30,
  "events.create_lead_minutes": 15,
  "events.default_duration_minutes": 120,
  "events.channel_grace_minutes": 15,
  "events.recurrence_enabled": true,
  "events.native.location":
    "Voice channel in this server (see the event announcement)",
  "events.native.link_room": true,
  "events.groups.default_count": 2,
  "events.groups.max_count": 15,
  "events.groups.group_label": "Team",
  "events.groups.leader_label": "Leader",
  "events.max_active_per_host": 0, // 0 = no limit

  // LFG (#957) — feature gate off by default (rule 1)
  "lfg.enabled": false,
  "lfg.channel_id": "", // Empty → post in the channel /lfg was run in
  "lfg.expiry_minutes": 60,
  "lfg.default_size": 4,
  "lfg.max_active_per_user": 1,
  "lfg.voice_channel.enabled": true, // Still gated on voicechannels.enabled
  "reminders.enabled": false,
  "reminders.max_pending": 10,
  "tickets.enabled": false,
  "tickets.category_id": "",
  "tickets.staff_role_id": "",
  "tickets.transcript_on_close": true,
  "tickets.max_open_per_member": 1,
  "tickets.open_cooldown_seconds": 300,

  // Self-service data export defaults (#719). Master gate off, rule 1 —
  // the Privacy section is hidden from /me and /me/privacy plus the export
  // route return 404 until an operator opts in (#1066). The ceiling bounds the most
  // expensive read a member can trigger; it is per collection, and the
  // payload names anything it clipped.
  "privacy.enabled": false,
  "privacy.export.max_items": 5000,
  // Self-service data reset (#917). Its own gate, off by default — it is
  // destructive, so an operator who turned the export on has not thereby
  // agreed to the reset. The cooldown is persisted (read back from the Web
  // UI audit log), unlike the in-memory, per-IP rate limiter in front of it.
  "privacy.delete.enabled": false,
  "privacy.delete.cooldown_hours": 168,
  // Member tracking opt-out (#918). Gates only the *offer*: opt-outs already
  // on file are always honoured, and opting back in is always allowed.
  "privacy.tracking_opt_out.enabled": false,

  // Reaction Roles defaults
  "reactionroles.enabled": false,
  "reactionroles.message_channel_id": "",
  "reactionroles.style": "reaction",
  "reactionroles.group_role_colour": "",
  "reactionroles.max_toggles": 10,
  "reactionroles.toggle_window_seconds": 30,

  // Notices System defaults
  "notices.enabled": false,
  "notices.channel_id": "",
  "notices.header_enabled": true, // Enable informational header post
  "notices.header_message_id": "", // Stores header message ID
  "notices.header_pin_enabled": true, // Pin header for easy access

  // Poll System defaults
  "polls.enabled": false,
  "polls.default_duration_hours": 24, // Default 24 hours
  "polls.cooldown_days": 7, // Minimum 7 days between reusing same poll
  // Poll-participation capture (#570). Off by default (rule 1): when on, a
  // messagePollVoteAdd listener records per-user "votes cast" for a future
  // Rewind. Independent of whether the bot created the poll.
  "polls.participation.enabled": false,
  // Retention for the two time-scoped participation stores (#816). 12 weeks
  // of per-member week buckets comfortably covers the weekly recap plus a
  // quarter of history; 90 days of per-poll turnout rows matches the other
  // detail-level retention defaults and bounds how long the per-poll voter
  // ids are kept. Either set to 0 keeps that store forever.
  "polls.participation.weekly_retention_weeks": 12,
  "polls.turnout.retention_days": 90,

  // Leaderboard Role Rewards defaults
  "leaderboard_roles.enabled": false,
  "leaderboard_roles.period": "alltime",
  "leaderboard_roles.update_cron": "0 0 * * 1", // Every Monday at 00:00
  "leaderboard_roles.tiers": "",
  "leaderboard_roles.announcement_channel_id": "",

  // Discord slash-command audit log defaults (#459). On by default so
  // fresh installs get operator visibility out of the box; retention
  // matches the proposal in the issue (90 days).
  "core.command_audit.enabled": true,
  "core.command_audit.retention_days": 90,

  // Discord-channel logging categories (#844). Off by default: posting
  // bot lifecycle/error/cron embeds into a guild channel is an operator
  // opt-in, and each category needs a channel id before it does anything.
  "core.webui.link_delivery": "dm",
  "core.guild_scope.leave_other_guilds": false,
  "core.webui.signin_cooldown_seconds": 60,
  "core.startup.enabled": false,
  "core.startup.channel_id": "",
  "core.errors.enabled": false,
  "core.errors.channel_id": "",
  "core.cleanup.enabled": false,
  "core.cleanup.channel_id": "",
  "core.config.enabled": false,
  "core.config.channel_id": "",
  "core.cron.enabled": false,
  "core.cron.channel_id": "",
  // Moderation context notices (#907) ride the same category machinery: off
  // until an operator names a mod-log channel to post them to.
  "core.moderation.enabled": false,
  "core.moderation.channel_id": "",
  // Case review-due notice (#908): off until an operator names a channel.
  "core.moderation_review.enabled": false,
  "core.moderation_review.channel_id": "",
  // One-time "update available" note (#1029). Off like every other log
  // category: posting into a guild channel is an operator opt-in.
  "core.updates.enabled": false,
  "core.updates.channel_id": "",

  // Web UI update check (#1029). On by default so operators notice a stale
  // instance; it is an anonymous GET of public release metadata that sends
  // nothing about the instance. Air-gapped or privacy-strict operators turn
  // it off and the Web UI then shows only the running version.
  "core.updatecheck.enabled": true,

  // WebUI audit log retention default (#756). WebAuditLog rows are written
  // unconditionally on every state-changing WebUI request, so there's no
  // enabled toggle — retention alone governs pruning. 90 days matches
  // command_audit; set to 0 to keep history forever.
  "core.web_audit.retention_days": 90,

  // Persisted command metrics defaults (#648). On by default so fresh
  // installs get historical command analytics in the Admin → Command
  // Metrics dashboard out of the box; 30-day window matches the issue.
  "monitoring.metrics_persistence.enabled": true,
  "monitoring.metrics_retention_days": 30,

  // Moderation log defaults (#728). Master gate off, follows rule 1 — the
  // /warn + /modlog commands, the GuildAuditLogEntryCreate mirroring, and the
  // /admin/moderation page are all inert until an operator opts in.
  // Retention (#742) defaults to a year, the value proposed in the issue;
  // 0 disables pruning entirely for operators who want the log kept forever.
  "moderation.enabled": false,
  "moderation.retention_days": 365,

  // Case lifecycle (#908). Gate off (rule 1): an upgrade changes nothing
  // until an operator opts in. The review job nudges at 09:00 by default.
  // Resolved cases are kept forever (0) because a decision record is the
  // point; a case protects its member's log history from pruning for a year
  // after it resolves (0 = for as long as the case exists).
  "moderation.cases.enabled": false,
  "moderation.cases.review_cron": "0 9 * * *",
  "moderation.cases.default_review_days": 90,
  "moderation.cases.retention_days": 0,
  "moderation.cases.history_grace_days": 365,

  // Anti-raid protection (#1045). Off by default (rule 1), and a first
  // enablement is a dry run: it detects and alerts but never touches a member
  // until an operator has seen what it would do and switches `dry_run` off.
  // Defaults are conservative for a small community: more than 10 joins in 30
  // seconds, and the reversible action (a timeout) rather than a kick.
  "moderation.raid.enabled": false,
  "moderation.raid.dry_run": true,
  "moderation.raid.join_threshold": 10,
  "moderation.raid.window_seconds": 30,
  "moderation.raid.lockdown_action": "timeout",
  "moderation.raid.min_account_age_hours": 0,
  "moderation.raid.new_account_action": "timeout",
  "moderation.raid.timeout_minutes": 60,
  "moderation.raid.quarantine_role_id": "",
  "moderation.raid.lockdown_max_minutes": 0,
  "moderation.raid.alert_channel_id": "",

  // Name history (#1038). Both gates off (rule 1). `namehistory.enabled`
  // records names even while the command is off, so history can build up
  // before the community turns /aka on. 0 = keep forever.
  "aka.enabled": false,
  "namehistory.enabled": false,
  "namehistory.retention_days": 365,

  // Server adoption (#1018). Snapshots are the rollback safety net, so the
  // default keeps them for a quarter; 0 keeps them forever.
  "adoption.snapshot.retention_days": 90,

  // Role group sync (#1021). Flag-only is the non-destructive default:
  // drift is shown and logged, nothing is changed on its own.
  "adoption.role_groups.sync_policy": "flag",
  "adoption.role_groups.reconcile_enabled": true,
  "adoption.role_groups.reconcile_cron": "*/30 * * * *",
  "core.role_groups.enabled": false,
  "core.role_groups.channel_id": "",
};

/**
 * Per-key metadata used by the WebUI Settings page and by future
 * `/config` description surfaces. Single source of truth so every key in
 * `defaultConfig` has a stable label/description even when the DB row hasn't
 * been written yet (e.g. on a fresh install).
 *
 * Categories match the existing values used by `migrateFromEnv()` and the
 * `Config` mongoose model's `category` enum, so a Settings group rendered
 * from this map looks identical to one rendered from a populated DB.
 *
 * `label` is the human-readable name displayed as the primary text for the
 * setting (e.g. "Voice Tracking enabled"). The raw dotted key is shown
 * de-emphasised next to it for technical reference.
 *
 * `type` drives input rendering on the Settings page. `boolean` / `number`
 * / `string` cover the bulk of keys with the obvious HTML controls. The
 * Discord-specific kinds (`channel`, `category`, `role`, `channel_list`,
 * `role_list`) render as `<select>` dropdowns populated from the live guild
 * cache so operators pick from real entities instead of typing IDs by
 * hand. `cron` currently renders as a text input — issue #444 will replace
 * it with a friendly schedule picker.
 */
export type SettingType =
  | "boolean"
  | "number"
  | "string"
  | "cron"
  | "channel"
  | "category"
  | "role"
  | "channel_list"
  | "role_list";

/**
 * A single choice in a fixed-options setting. `value` is the raw value
 * stored in the DB (and validated against on POST); `label` is the
 * human-readable text shown in the `<select>` option.
 */
export interface SettingOption {
  value: string;
  label: string;
}

/**
 * Minimum days of *detailed* data a full Rewind / year-in-review needs to
 * render a complete recap. The in-progress year is built live from detailed
 * voice sessions and per-message detail, so any retention shorter than this
 * silently degrades Rewind. Defined once here and referenced by the retention
 * defaults' `warnBelow` hints, the WebUI warning, and the docs so the
 * threshold can't drift. 366 covers a full leap year.
 */
export const REWIND_RETENTION_MIN_DAYS = 366;

/**
 * Soft "minimum recommended value" hint for a numeric setting. When the
 * current value is below `value`, the WebUI surfaces `message` as a
 * non-blocking inline warning — both on save and on first load — so operators
 * notice a degraded feature without having to edit anything. Purely advisory:
 * it never blocks the save (operators may legitimately want a lower value).
 */
export interface SettingWarnBelow {
  value: number;
  message: string;
  /**
   * When true, a value of exactly `0` never triggers the warning. Set on the
   * retention hints: `0` means "keep forever" on every retention key (#835),
   * which cannot degrade the feature the hint protects.
   */
  exemptZero?: boolean;
}

export interface SettingMetadata {
  label: string;
  description: string;
  category: string;
  type: SettingType;
  /**
   * When present, the WebUI renders this setting as a `<select>` whose
   * choices are exactly these options (instead of a free-text input), and
   * server-side POST validation refuses any value not in this whitelist.
   * Only meaningful for `string`-typed keys with a fixed enumerated set of
   * valid values (e.g. `leaderboard_roles.period`).
   */
  options?: SettingOption[];
  /**
   * The value set of a free-text `string` key, so the Web UI can offer a picker
   * and the write boundary can refuse a value the picker could not have
   * produced (#1426): `timezone` (IANA zone select), `colour` (`#RRGGBB`
   * colour input) or `affix` (free text for a channel name prefix or suffix, at most 32 characters, with an emoji grid beside the box) or `reaction_role_message` (a
   * select of the bot's own reaction-role messages, #1433). A stored
   * value that fails the rule still displays and saves unchanged.
   */
  format?: SettingFormat;
  /**
   * Optional "minimum recommended value" hint for `number`-typed keys. The
   * WebUI shows the warning when the current value drops below the threshold.
   * Reusable across settings; today it guards the Rewind-relevant retention
   * keys (see `REWIND_RETENTION_MIN_DAYS`).
   */
  warnBelow?: SettingWarnBelow;
  /**
   * Inclusive lower bound for `number`-typed keys (#835). Enforced at the
   * write boundary by `coerceConfigValue` (a value below it is rejected, not
   * clamped), rendered as the `min` attribute of the Settings input, and
   * checked by `validate-config`. Retention keys declare `min: 0` — `0` means
   * "keep forever" — so a negative window (whose cutoff would lie in the
   * future and prune everything) can never be stored.
   */
  min?: number;
  /**
   * Inclusive upper bound for `number`-typed keys (#1304). Declared on every
   * number key (a drift test enforces it) so the Settings input can refuse
   * `99999` in the browser and `coerceConfigValue` can refuse it again on the
   * server. A value above it is rejected with a message, never clamped.
   */
  max?: number;
  /**
   * Render a `number` key as a stepper (minus, the digit box, plus) instead of
   * the bare box (#1427). For ranges under about 30 values. No server rule
   * comes with it: `min` and `max` are the rule, the stepper only makes the
   * browser unable to leave them.
   */
  stepper?: boolean;
  /**
   * Common values of a duration `number` key (#1427), rendered as a radio group
   * with a final "Custom…" that reveals the bounded box. Each preset lies
   * inside `min`..`max` and the default is one of them (a drift test checks
   * both). Presets are a shortcut, never a whitelist: any number in range is
   * still accepted, so a stored `45` keeps saving.
   */
  presets?: number[];
  /** What the preset `0` is called when it means something other than a number ("Off", "None"). */
  presetZeroLabel?: string;
  /**
   * Set on values the bot writes and reads itself (the id of a message it
   * posted), which an admin must never type (#1304). The Settings page shows
   * them read-only with a link to the message instead of an input, and the
   * write boundary refuses them. `channelKey` names the setting holding the
   * channel the message was posted in, which the jump link needs.
   */
  managed?: { channelKey: keyof ConfigSchema };
  /**
   * Set on a key that is edited only through its own editor (the leaderboard
   * tiers), where the raw stored text is easy to break (#1428). The All
   * settings table leaves it out. The value is unchanged otherwise: it is
   * still stored, exported, imported and reset like any other key.
   */
  editedElsewhere?: boolean;
  /**
   * Set when the rest of the feature page renders from this value (beyond the
   * `*.enabled` flags, which always reload): saving it from a feature page's
   * card reloads the page so nothing keeps describing the old value (#1090).
   * Ignored on the Settings page, which renders nothing else from its values.
   */
  reloadOnSave?: boolean;
  /**
   * Which kind of Discord channel a `channel` / `channel_list` picker offers.
   * `"text"` (the default when omitted) lists text/announcement channels;
   * `"voice"` lists voice + stage channels. Set `"voice"` on keys that
   * exclude or target voice channels — e.g. `voicetracking.excluded_channels`,
   * which excludes voice channels a session could be tracked in — so the
   * picker doesn't offer text channels that can't host a voice session.
   * Ignored for non-channel types.
   */
  channelKind?: "text" | "voice";
  /**
   * Hard dependencies: this key may only be enabled when every listed key
   * is also enabled (truthy). Used by write-time validation and the Settings
   * UI to block/grey a toggle until its requirements are met. Only declare
   * *hard* data dependencies here — features that are broken/empty without
   * the target. Optional/graceful readers (e.g. rewind's per-section sources)
   * are intentionally NOT listed: rewind is a graceful aggregator that renders
   * only the sections that are tracked, so it must never be blocked on enable.
   * Sub-feature/parent gates may also be declared when it helps the UI.
   */
  dependsOn?: (keyof ConfigSchema)[];
}

/**
 * Whether `key` holds bot-managed state (the id of a message the bot posted)
 * that must never be typed or imported (#1304). Declared per key with
 * `managed` in `settingsMetadata`.
 */
export function isManagedSetting(key: string): boolean {
  return (
    settingsMetadata[key as keyof typeof settingsMetadata]?.managed !==
    undefined
  );
}

/**
 * Read the hard dependencies declared for a config key. Returns the keys that
 * must also be enabled before `key` may be turned on, or an empty array when
 * the key declares none. Typed against `ConfigSchema` so callers
 * (write-time validation #663, the Settings "requires X" hint #666) get a
 * checked list. The single source of truth is each key's `dependsOn` in
 * `settingsMetadata`.
 */
export function getDependencies(
  key: keyof ConfigSchema,
): (keyof ConfigSchema)[] {
  // Return a fresh copy so callers can't mutate the array stored in
  // settingsMetadata and silently corrupt the shared dependency graph.
  return [...(settingsMetadata[key]?.dependsOn ?? [])];
}

/**
 * Reverse of {@link getDependencies}: the keys that declare `key` as a hard
 * dependency — i.e. the dependents that may only be enabled while `key` is on.
 * Scans the `dependsOn` graph in `settingsMetadata`. Used by write-time
 * validation (#663) to block disabling a feature that something still needs.
 */
export function getDependents(key: keyof ConfigSchema): (keyof ConfigSchema)[] {
  const dependents: (keyof ConfigSchema)[] = [];
  for (const candidate of Object.keys(
    settingsMetadata,
  ) as (keyof ConfigSchema)[]) {
    if (settingsMetadata[candidate].dependsOn?.includes(key)) {
      dependents.push(candidate);
    }
  }
  return dependents;
}

/**
 * Own-property check that ignores inherited members. Dependency batches can be
 * built from user-controlled input (parsed YAML/JSON, form bodies), so plain
 * `key in obj` would treat inherited keys like `__proto__`/`constructor` as
 * real entries and could be abused for prototype-pollution-style inputs.
 */
export function hasOwn(obj: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Interpret a raw config value as an on/off state, matching
 * `ConfigService.getBoolean`: real booleans pass through, the strings
 * "true"/"false" coerce, and non-zero numbers count as on. Web forms submit
 * the string "true", so dependency validation must treat that as enabling.
 */
export function isEnabledValue(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value === "true";
  if (typeof value === "number") return value !== 0;
  return false;
}

/**
 * The schema default for `key`, or `undefined` when `key` is not declared in
 * `defaultConfig`. The single sanctioned way for migration code to learn a
 * default: hardcoding one alongside the migration is what let the boot-time
 * backfill drift from the documented schema and force-enable opt-in features
 * on fresh installs (#867).
 */
export function getSchemaDefault(
  key: string,
): ConfigSchema[keyof ConfigSchema] | undefined {
  return hasOwn(defaultConfig, key)
    ? defaultConfig[key as keyof ConfigSchema]
    : undefined;
}

/**
 * Coerce a raw string (a legacy flat env var) to the type the schema declares
 * for `key`.
 *
 * The *schema entry* decides the target type, never the shape of the string:
 * `QUOTE_MAX_LENGTH=1000` becomes the number `1000` because
 * `quotes.max_length` is a number, while a channel ID that happens to be all
 * digits stays a string because its schema entry is a string. Guessing from
 * the string alone silently retypes ID-like values.
 *
 * Booleans are matched leniently — trimmed and case-folded, so `TRUE`,
 * `False` and `true ` all migrate. `ConfigService.getBoolean` deliberately
 * stays strict (`value === "true"`), and that is not in tension: this runs
 * only at the migration boundary, translating a hand-edited `.env` string
 * into storage, and what it stores is a real boolean. The leniency never
 * reaches a read path. Being strict here would drop an operator's `TRUE` on
 * the floor, which is precisely how the legacy code lost it — it stored the
 * string `"TRUE"`, which every read path then evaluated as `false`.
 *
 * Strings are taken verbatim, whitespace included: for a string key an empty
 * or padded value is a value, not a typo to normalise away (#868).
 *
 * Returns `undefined` for a value that cannot be represented as that type (or
 * for an unknown key), so callers fall back to the schema default rather than
 * persisting something the rest of the app will misread.
 */
export function coerceToSchemaType(
  key: string,
  raw: string,
): ConfigSchema[keyof ConfigSchema] | undefined {
  const schemaDefault = getSchemaDefault(key);
  if (schemaDefault === undefined) return undefined;

  if (typeof schemaDefault === "boolean") {
    const normalised = raw.trim().toLowerCase();
    if (normalised === "true") return true;
    if (normalised === "false") return false;
    return undefined;
  }

  if (typeof schemaDefault === "number") {
    if (raw.trim() === "") return undefined;
    const num = Number(raw);
    return Number.isFinite(num) ? num : undefined;
  }

  return raw;
}

/** Human-friendly reference to a key: `"Label" (`dotted.key`)`. */
function describeKey(key: keyof ConfigSchema): string {
  const label = settingsMetadata[key]?.label;
  return label ? `"${label}" (\`${key}\`)` : `\`${key}\``;
}

function describeList(keys: (keyof ConfigSchema)[]): string {
  return keys.map(describeKey).join(", ");
}

/**
 * A single dependency-graph violation produced by {@link validateDependencies}.
 * `key` is the offending pending write; `message` is operator-friendly and
 * ready to surface (it already names the unmet dependency / blocking dependent
 * with both its human label and its dotted key).
 */
export interface DependencyIssue {
  key: keyof ConfigSchema;
  message: string;
}

/**
 * Thrown by `ConfigService.set` when a single write would violate the feature
 * dependency graph. Carries the structured `issues` so callers can inspect
 * them; `message` joins their human-readable text for direct display.
 */
export class DependencyError extends Error {
  readonly issues: DependencyIssue[];

  constructor(issues: DependencyIssue[]) {
    super(issues.map((issue) => issue.message).join(" "));
    this.name = "DependencyError";
    this.issues = issues;
  }
}

/**
 * Surface-agnostic feature-dependency check shared by every config write path
 * (#663): `ConfigService.set`, the Settings save handlers, and the Setup
 * Wizard apply. Given a batch of proposed writes (`pending`, keyed by dotted
 * config key) and a resolver for the *current* persisted state of any key not
 * in the batch, it returns the writes that would leave the hard-dependency
 * graph (`dependsOn`) violated. An empty array means the batch is consistent.
 *
 * Both directions are enforced, judged against the *resulting* state so an
 * intra-batch pair (enabling a feature and its dependency together in one
 * wizard apply) validates without ordering tricks:
 *
 *  - **Forward** — enabling a key whose `dependsOn` target is (and stays) off.
 *  - **Reverse** — disabling a key while something that depends on it stays on.
 *    We *block* (rather than silently cascade-disable across features) so a
 *    cross-feature disable can never quietly tear down another feature; the
 *    message names the dependents the operator must turn off first.
 *
 * `resolveCurrent` returns the effective on/off state of a key the caller backs
 * with `ConfigService.getBoolean`. Keys absent from the schema are ignored.
 */
export function validateDependencies(
  pending: Record<string, unknown>,
  resolveCurrent: (key: keyof ConfigSchema) => boolean,
): DependencyIssue[] {
  const effective = (key: keyof ConfigSchema): boolean =>
    hasOwn(pending, key) ? isEnabledValue(pending[key]) : resolveCurrent(key);

  const issues: DependencyIssue[] = [];
  for (const rawKey of Object.keys(pending)) {
    if (!hasOwn(settingsMetadata, rawKey)) continue;
    const key = rawKey as keyof ConfigSchema;

    if (isEnabledValue(pending[rawKey])) {
      const unmet = getDependencies(key).filter((dep) => !effective(dep));
      if (unmet.length > 0) {
        issues.push({
          key,
          message: `Cannot enable ${describeKey(key)}: requires ${describeList(
            unmet,
          )} to be enabled. Enable ${unmet.length === 1 ? "it" : "them"} first.`,
        });
      }
    } else {
      const blockers = getDependents(key).filter((dependent) =>
        effective(dependent),
      );
      if (blockers.length > 0) {
        issues.push({
          key,
          message: `Cannot disable ${describeKey(key)}: ${describeList(
            blockers,
          )} still ${
            blockers.length === 1 ? "depends" : "depend"
          } on it. Disable ${blockers.length === 1 ? "it" : "them"} first.`,
        });
      }
    }
  }
  return issues;
}

/**
 * Shared warning shown when a Rewind-relevant retention is below the year
 * threshold. Built from `REWIND_RETENTION_MIN_DAYS` so the number stays in
 * one place.
 */
const rewindRetentionWarning: SettingWarnBelow = {
  value: REWIND_RETENTION_MIN_DAYS,
  message: `⚠️ Rewind / year-in-review needs ≥ ${REWIND_RETENTION_MIN_DAYS} days of detailed data. At this value, recaps that reach further back will be incomplete. Lower it only if you don't need a full year-in-review.`,
  // `0` disables pruning entirely (#835), so it keeps every day of detail.
  exemptZero: true,
};

/**
 * Lower bound shared by every retention key (#835): `0` means "keep forever"
 * (the cleanup job skips pruning), anything negative is refused at the write
 * boundary. Declared once so the meaning of `0` can't drift between keys.
 */
const RETENTION_MIN = 0;

/**
 * Upper bound shared by the retention keys counted in days (#1304): one
 * hundred years, far past any real policy, so only a mistyped value (an extra
 * digit, a pasted ID) is refused.
 */
const RETENTION_MAX_DAYS = 36500;

/**
 * Per-category metadata for the WebUI Settings page section headers and
 * future `/config` surfaces. Keyed by the `category` slug used in
 * `SettingMetadata`.
 */
export interface CategoryMetadata {
  title: string;
  description: string;
}

export const categoryMetadata: Record<string, CategoryMetadata> = {
  voicechannels: {
    title: "Voice Channels",
    description:
      "Dynamic voice channel management: lobby, per-user channels, presets, control panel.",
  },
  voicetracking: {
    title: "Voice Tracking",
    description:
      "Time-in-voice tracking, leaderboards, last-seen, scheduled announcements, and DB cleanup.",
  },
  messagetracking: {
    title: "Message Tracking",
    description:
      "Per-user, per-channel text-message activity tracking with a retention-trimmed detail log. Data-capture foundation for text stats; surfacing lives in the Rewind follow-up.",
  },
  reactiontracking: {
    title: "Reaction Tracking",
    description:
      "Per-user counts of reactions given and received, stored as lifetime + per-year totals. Data-capture foundation for a future Rewind stat; surfacing lives in a follow-up.",
  },
  adoption: {
    title: "Server Adoption",
    description:
      "Taking over roles, categories and channel permissions on an existing server. Every change is planned first, snapshotted, and can be rolled back.",
  },
  namehistory: {
    title: "Name History",
    description:
      "Remember the usernames, display names and server nicknames members have used, and show them with /aka.",
  },
  ping: {
    title: "Ping",
    description: "The /ping latency check command.",
  },
  quotes: {
    title: "Quotes",
    description: "Collect and curate memorable quotes in a dedicated channel.",
  },
  ratelimit: {
    title: "Rate Limiting",
    description:
      "Per-user slash-command rate limiting to stop accidental flooding.",
  },
  announcements: {
    title: "Scheduled Announcements",
    description:
      "Schedule arbitrary messages to a Discord channel via cron expressions.",
  },
  achievements: {
    title: "Achievements",
    description:
      "Award badges based on voice activity, optionally with channel and DM notifications.",
  },
  celebrations: {
    title: "Milestone Celebrations",
    description:
      "Post a loud, server-wide shout-out the first time anyone crosses a marquee accolade (Voice Legend, 1000 hours, a month-long streak, 100 quotes). Reuses the achievements award path; no extra tracking.",
  },
  digest: {
    title: "Weekly Digest",
    description:
      "Personalised weekly DM summarising each user's voice activity, rank, streak, and new achievements. Opt-in (off by default) on the user's /me/notifications page.",
  },
  rewind: {
    title: "Rewind (Year-in-Review)",
    description:
      "Personalised end-of-year recap at /me/rewind plus a one-shot DM nudge in late December. The nudge is opt-in (off by default) on the user's /me/notifications page.",
  },
  birthdays: {
    title: "Birthdays",
    description:
      "Celebrate members' birthdays with a daily announcement in their own timezone, optionally granting a temporary birthday role. Members set their date on /me/birthday.",
  },
  welcome: {
    title: "Welcome Messages",
    description: `Greet new members in a configured channel, optionally pointing them at the self-assign role picker and the rules channel. Needs the privileged Server Members Intent so Discord delivers member-join events. ${GUILD_MEMBERS_INTENT_HOWTO}`,
  },
  rules: {
    title: "Rules Acceptance",
    description:
      "Optional rules / terms gate: KoolBot posts the rules with an Accept button in a read-only channel and grants an acceptance role. Off by default; manage the rollout (existing members, gated channels) on the Rules page. Discord's own Membership Screening or Onboarding does the same job on Community servers; don't run both.",
  },
  events: {
    title: "Events",
    description:
      "Schedule server events that spin up a temporary voice channel shortly before they start, announce each one with a Discord event link members can mark Interested on, post a reminder beforehand, and tear the channel down once it ends. For servers without static voice channels. Manage from the /admin/events page.",
  },
  lfg: {
    title: "LFG",
    description:
      'Ad-hoc "looking for group" posts: a member runs /lfg to say what they want to play right now, others join from the post\'s buttons, and the post closes once the party fills or its timer runs out. The immediate counterpart to scheduled Events.',
  },
  reminders: {
    title: "Reminders",
    description:
      "Personal one-off reminders members set for themselves with /remind. KoolBot DMs the reminder when it's due, falling back to the channel it was set in if the member's DMs are closed. Member self-service — the only admin control is the on/off switch and the per-member cap.",
  },
  tickets: {
    title: "Tickets",
    description:
      "Member support tickets: /ticket open creates a private channel visible only to the member and your staff role, staff claim and close it from Discord or the /admin/tickets page, and closed tickets are archived with an optional transcript.",
  },
  privacy: {
    title: "Privacy",
    description:
      "Self-service data export and reset. When enabled, members can see what KoolBot stores about them on /me/privacy and download all of it as one JSON file — and, if the reset is also enabled, wipe it. Moderation records, admin audit logs and session rows are never included in either.",
  },
  reactionroles: {
    title: "Reaction Roles",
    description:
      "Let users self-assign roles from a configured message — via a classic emoji reaction, or modern button / select-menu components.",
  },
  notices: {
    title: "Notices",
    description:
      "Curated channel where the bot maintains a pinned informational header and prunes unauthorised messages.",
  },
  polls: {
    title: "Polls",
    description:
      "Periodic icebreaker polls drawn from a configurable question library.",
  },
  leaderboard_roles: {
    title: "Leaderboard Role Rewards",
    description:
      "Auto-assign Discord roles based on a user's position in the voice-activity leaderboard.",
  },
  core: {
    title: "Core",
    description:
      "Core bot infrastructure: audit logging, retention, and other cross-cutting concerns.",
  },
  moderation: {
    title: "Moderation",
    description:
      "Lightweight moderation log: record actions via /warn, /timeout and /ban, copy in kicks, bans and timeouts made in Discord itself (from the server's audit log), and query per-member history with /modlog or the admin page.",
  },
  other: {
    title: "Other",
    description: "Keys present in the database without metadata in the schema.",
  },
};

export const settingsMetadata: Record<keyof ConfigSchema, SettingMetadata> = {
  // Voice Channel Management
  "voicechannels.enabled": {
    label: "Voice Channel Management enabled",
    description: "Enable voice channel management.",
    category: "voicechannels",
    type: "boolean",
  },
  "voicechannels.category_id": {
    label: "Managed category",
    description:
      "Discord category that contains the bot-managed voice channels (lobby + per-user spawns).",
    category: "voicechannels",
    type: "category",
  },
  "voicechannels.lobby.channel_id": {
    label: "Lobby channel",
    description:
      "The voice channel members join to spawn a personal channel, identified by ID. Optional: when empty, or when the channel no longer exists, the lobby is found by its display name instead. Set this when the managed category is shared, so a differently named or renamed channel is never mistaken for the lobby (and the lobby is never mistaken for another channel).",
    category: "voicechannels",
    type: "channel",
    channelKind: "voice",
  },
  "voicechannels.lobby.name": {
    label: "Lobby channel display name",
    description:
      "Display name of the lobby channel users join to spawn a personal channel. Used to find the lobby when no lobby channel is selected above. Emoji shortcodes like :green_circle: are converted to the emoji on save (custom server emoji aren't supported in channel names).",
    category: "voicechannels",
    type: "string",
  },
  "voicechannels.lobby.offlinename": {
    label: "Lobby display name (bot offline)",
    description:
      "Display name shown on the lobby channel while the bot is offline. Cosmetic. Emoji shortcodes like :red_circle: are converted to the emoji on save (custom server emoji aren't supported in channel names).",
    category: "voicechannels",
    type: "string",
  },
  "voicechannels.lobby.max_rooms": {
    label: "Lobby rooms per member per window",
    description:
      "How many rooms one member can open from the lobby within the window below. Past it the member stays in the lobby with a short notice in the lobby's text chat, and gets a room by leaving and rejoining once the window has passed. Set to 0 for no limit. Held in memory, so it resets on restart.",
    category: "voicechannels",
    type: "number",
    min: 0,
    max: 100,
  },
  "voicechannels.lobby.room_window_seconds": {
    label: "Lobby room limit window (seconds)",
    description:
      "The window, in seconds, for the lobby room limit above. Ignored when that limit is 0.",
    category: "voicechannels",
    type: "number",
    min: 1,
    max: 86400,
    presets: [30, 60, 300, 900, 3600, 86400],
  },
  "voicechannels.channel.prefix": {
    label: "Per-user channel name prefix",
    description:
      "Free text prepended to dynamically created voice channel names, for example an emoji, or 'Looking for group:' (up to 32 characters). Emoji shortcodes like :video_game: are converted to the emoji on save (custom server emoji aren't supported in channel names).",
    category: "voicechannels",
    type: "string",
    format: "affix",
  },
  "voicechannels.channel.suffix": {
    label: "Per-user channel name suffix",
    description:
      "Free text appended to dynamically created voice channel names, for example 's room (up to 32 characters). Emoji shortcodes like :sparkles: are converted to the emoji on save (custom server emoji aren't supported in channel names).",
    category: "voicechannels",
    type: "string",
    format: "affix",
  },
  "voicechannels.cleanup.managed_only": {
    label: "Only clean up channels KoolBot created",
    description:
      "Turn this on when the managed category above is an existing, shared category (for example one that already holds another bot's join-to-create channel or permanent voice rooms). Startup and periodic cleanup then delete only empty channels KoolBot created itself, tracked by ID, and never any other empty voice channel in the category. The first time it is on, existing channels in the category that match the KoolBot name prefix/suffix are adopted as KoolBot-created. Leave it off for a category that KoolBot owns exclusively: then every empty voice channel in it, except the lobby, is cleaned up.",
    category: "voicechannels",
    type: "boolean",
    // The Force cleanup confirmation and status card render from this value.
    reloadOnSave: true,
  },
  "voicechannels.controlpanel.enabled": {
    label: "In-channel control panel enabled",
    description:
      "Show the in-channel control panel (rename / privacy / live / transfer).",
    category: "voicechannels",
    type: "boolean",
  },
  "voicechannels.owner.grant_status": {
    label: "Let room owners set the channel status",
    description:
      "Grant the owner of a temporary voice room Discord's native Set Voice Channel Status permission, so they can set the channel status (the topic line under its name) in the Discord client. KoolBot only grants it when it holds the permission itself; otherwise the grant is skipped.",
    category: "voicechannels",
    type: "boolean",
  },
  "voicechannels.presets.enabled": {
    label: "Per-user voice preferences enabled",
    description:
      "Enable per-user voice preferences: a channel name pattern and saved presets (channel name, user limit, bitrate), managed from the Discord control panel and the /me/voice web page.",
    category: "voicechannels",
    type: "boolean",
  },
  "voicechannels.presets.max_per_user": {
    label: "Max presets per user",
    description: "Maximum number of presets a user can save.",
    category: "voicechannels",
    type: "number",
    min: 0,
    max: 100,
  },

  // Voice Activity Tracking
  "voicetracking.enabled": {
    label: "Voice Tracking enabled",
    description: "Enable voice activity tracking and the /voicestats command.",
    category: "voicetracking",
    type: "boolean",
  },
  "voicetracking.stats.top.enabled": {
    label: "/voicestats top subcommand enabled",
    description: "Enable the /voicestats top leaderboard subcommand.",
    category: "voicetracking",
    type: "boolean",
  },
  "voicetracking.stats.user.enabled": {
    label: "/voicestats user subcommand enabled",
    description: "Enable the /voicestats user personal-stats subcommand.",
    category: "voicetracking",
    type: "boolean",
  },
  "voicetracking.stats.leaderboard_max_results": {
    label: "Leaderboard max results",
    description:
      "Server-side cap on how many ranked users the /voicestats top leaderboard returns. Bounds the aggregation pipeline so a single request can never materialise the whole collection.",
    category: "voicetracking",
    type: "number",
    min: 1,
    max: 10000,
  },
  "voicetracking.seen.enabled": {
    label: "/seen command enabled",
    description: "Enable last-seen tracking and the /seen command.",
    category: "voicetracking",
    type: "boolean",
  },
  "voicetracking.companions.enabled": {
    label: "Companion overlap & voice firsts capture",
    description:
      "Persist precise per-companion co-presence seconds and join-order metadata (was-first, who you joined) on each voice session. Data-capture foundation for future Rewind companion stats; off by default. Requires voice tracking to be enabled.",
    category: "voicetracking",
    type: "boolean",
  },
  "voicetracking.excluded_channels": {
    label: "Excluded channel IDs",
    description:
      "Comma-separated channel IDs to exclude from voice activity tracking.",
    category: "voicetracking",
    type: "channel_list",
    channelKind: "voice",
  },
  "voicetracking.announcements.enabled": {
    label: "Scheduled weekly recap enabled",
    description:
      "Enable the scheduled weekly recap posted to a channel (top voice-time members plus, when their features are enabled, accolades earned, quote of the week, and poll turnout). Sections are toggled individually below.",
    category: "voicetracking",
    type: "boolean",
    dependsOn: ["voicetracking.enabled"],
  },
  "voicetracking.announcements.schedule": {
    label: "Announcement schedule (cron)",
    description: "Cron schedule for the recurring voice-stats announcement.",
    category: "voicetracking",
    type: "cron",
  },
  "voicetracking.announcements.channel_id": {
    label: "Announcement channel",
    description: "Discord channel ID where the weekly recap is posted.",
    category: "voicetracking",
    type: "channel",
  },
  "voicetracking.announcements.include_voice_stats": {
    label: "Recap: top voice-time members",
    description:
      "Include the weekly top voice-time leaderboard in the scheduled recap.",
    category: "voicetracking",
    type: "boolean",
  },
  "voicetracking.announcements.include_accolades": {
    label: "Recap: accolades earned",
    description:
      "Include accolades earned in the last week in the scheduled recap (also requires achievements and achievement announcements to be enabled).",
    category: "voicetracking",
    type: "boolean",
  },
  "voicetracking.announcements.include_quote_of_week": {
    label: "Recap: quote of the week",
    description:
      "Include the most-liked quote added in the last week in the scheduled recap (also requires the quotes feature to be enabled).",
    category: "voicetracking",
    type: "boolean",
  },
  "voicetracking.announcements.include_poll_turnout": {
    label: "Recap: poll participation",
    description:
      "Include how many members voted in polls in the last week in the scheduled recap (also requires poll participation tracking to be enabled).",
    category: "voicetracking",
    type: "boolean",
  },

  // Voice Channel Cleanup (dbtrunk)
  "voicetracking.cleanup.enabled": {
    label: "Scheduled DB cleanup enabled",
    description: "Enable scheduled database cleanup of voice tracking data.",
    category: "voicetracking",
    type: "boolean",
  },
  "voicetracking.cleanup.schedule": {
    label: "Cleanup schedule (cron)",
    description: "Cron schedule for the database cleanup job.",
    category: "voicetracking",
    type: "cron",
  },
  "voicetracking.cleanup.retention.detailed_sessions_days": {
    label: "Detailed-session retention (days)",
    description:
      "Days to keep detailed session rows before the cleanup job prunes them. Rewind reads these detailed sessions, so keep this at or above a full year. Set to 0 to keep every session forever.",
    category: "voicetracking",
    type: "number",
    min: RETENTION_MIN,
    max: RETENTION_MAX_DAYS,
    warnBelow: rewindRetentionWarning,
  },
  "voicetracking.cleanup.retention.monthly_summaries_months": {
    label: "Monthly-summary retention (months)",
    description:
      "Months to keep monthly summary rows. Set to 0 to keep them forever.",
    category: "voicetracking",
    type: "number",
    min: RETENTION_MIN,
    max: 1200,
  },
  "voicetracking.cleanup.retention.yearly_summaries_years": {
    label: "Yearly-summary retention (years)",
    description:
      "Years to keep yearly summary rows. Set to 0 to keep them forever.",
    category: "voicetracking",
    type: "number",
    min: RETENTION_MIN,
    max: 100,
  },

  // Text-Message Activity Tracking (#495)
  "messagetracking.enabled": {
    label: "Message Tracking enabled",
    description:
      "Enable per-user, per-channel text-message activity tracking. Turning this off stops the messageCreate listener entirely.",
    category: "messagetracking",
    type: "boolean",
  },
  "messagetracking.excluded_channels": {
    label: "Excluded channel IDs",
    description:
      "Comma-separated channel IDs to exclude from text-message tracking (mirrors voicetracking.excluded_channels).",
    category: "messagetracking",
    type: "channel_list",
  },
  "messagetracking.cleanup.enabled": {
    label: "Scheduled message-detail cleanup enabled",
    description:
      "Enable the scheduled job that prunes old per-message detail. All-time per-channel totals are always kept.",
    category: "messagetracking",
    type: "boolean",
  },
  "messagetracking.cleanup.schedule": {
    label: "Message cleanup schedule (cron)",
    description: "Cron schedule for the message-detail cleanup job.",
    category: "messagetracking",
    type: "cron",
  },
  "messagetracking.cleanup.retention.detailed_days": {
    label: "Message-detail retention (days)",
    description:
      "Days to keep per-message detail (recentMessages) before it is pruned. All-time per-channel totals are never pruned. Rewind reads this detail, so keep it at or above a full year. Set to 0 to keep every message forever.",
    category: "messagetracking",
    type: "number",
    min: RETENTION_MIN,
    max: RETENTION_MAX_DAYS,
    warnBelow: rewindRetentionWarning,
  },

  // Reaction Activity Tracking (#570)
  "reactiontracking.enabled": {
    label: "Reaction Tracking enabled",
    description:
      "Enable per-user reaction tracking (given + received counts). Turning this off stops the messageReactionAdd listener entirely.",
    category: "reactiontracking",
    type: "boolean",
  },
  "reactiontracking.excluded_channels": {
    label: "Excluded channel IDs",
    description:
      "Comma-separated channel IDs to exclude from reaction tracking (mirrors messagetracking.excluded_channels).",
    category: "reactiontracking",
    type: "channel_list",
  },

  // Individual Features
  "ping.enabled": {
    label: "/ping command enabled",
    description: "Enable the /ping latency check command.",
    category: "ping",
    type: "boolean",
  },

  // Quote System
  "quotes.enabled": {
    label: "Quote system enabled",
    description: "Enable the quotes system and the /quote command.",
    category: "quotes",
    type: "boolean",
  },
  "quotes.channel_id": {
    label: "Quote channel",
    description: "Channel ID where quote messages are posted.",
    category: "quotes",
    type: "channel",
    // The Quotes page's Re-post card renders from this value (#1428).
    reloadOnSave: true,
  },
  "quotes.delete_roles": {
    label: "Roles allowed to delete quotes",
    description:
      "Comma-separated roles or role groups allowed to delete quotes. Empty means the Moderator and Admin role groups once one exists.",
    category: "quotes",
    type: "role_list",
  },
  "quotes.max_length": {
    label: "Maximum quote length (characters)",
    description: "Maximum length of a single quote in characters.",
    category: "quotes",
    type: "number",
    min: 1,
    max: 4000,
  },
  "quotes.cooldown": {
    label: "Cooldown between quotes (seconds)",
    description: "Cooldown in seconds between quote additions per user.",
    category: "quotes",
    type: "number",
    min: 0,
    max: 86400,
  },
  "quotes.header_enabled": {
    label: "Pinned header post enabled",
    description:
      "Post and maintain a pinned informational header in the quote channel.",
    category: "quotes",
    type: "boolean",
    // The Quotes page's Re-post card renders from this value (#1428).
    reloadOnSave: true,
  },
  "quotes.header_message_id": {
    label: "Header message ID (auto-managed)",
    description: "Auto-managed message ID of the quote channel header post.",
    category: "quotes",
    type: "string",
    managed: { channelKey: "quotes.channel_id" },
  },
  "quotes.header_pin_enabled": {
    label: "Pin header post",
    description: "Pin the header post in the quote channel.",
    category: "quotes",
    type: "boolean",
  },
  "quotes.clear_on_sync": {
    label: "Clear channel on sync",
    description:
      "When enabled, the quote channel is wiped and all quotes are re-posted from scratch on each sync. " +
      "This is destructive and slow on large quote collections; leave off unless you need a full rebuild.",
    category: "quotes",
    type: "boolean",
  },
  "quotes.vote_history_days": {
    label: "Vote history retention (days)",
    description:
      "How long individual 👍 votes are timestamped and kept, so the weekly recap can pick the quote " +
      "that gained the most likes this week rather than the most-liked quote added this week. " +
      "Older vote records are pruned; the lifetime like tally is never affected.",
    category: "quotes",
    type: "number",
    min: 0,
    max: RETENTION_MAX_DAYS,
  },

  // Rate Limiting
  "ratelimit.enabled": {
    label: "Rate limiting enabled",
    description: "Enable per-user command rate limiting.",
    category: "ratelimit",
    type: "boolean",
  },
  "ratelimit.max_commands": {
    label: "Max commands per window",
    description: "Maximum number of commands a user can run per time window.",
    category: "ratelimit",
    type: "number",
    min: 1,
    max: 1000,
  },
  "ratelimit.window_seconds": {
    label: "Rate-limit window (seconds)",
    description: "Length of the rate-limit time window in seconds.",
    category: "ratelimit",
    type: "number",
    min: 1,
    max: 3600,
    presets: [1, 5, 10, 30, 60, 300],
  },
  "ratelimit.bypass_admin": {
    label: "Admins bypass rate limit",
    description: "Allow administrators to bypass rate limiting.",
    category: "ratelimit",
    type: "boolean",
  },
  "ratelimit.max_components": {
    label: "Max button/menu clicks per window",
    description:
      "Maximum number of button, select-menu and modal interactions a user can make per rate-limit window. Applies when rate limiting is enabled; kept higher than the command limit because several clicks in a row are normal.",
    category: "ratelimit",
    type: "number",
    min: 1,
    max: 1000,
  },

  // Scheduled Announcements
  "announcements.enabled": {
    label: "Scheduled announcements enabled",
    description:
      "Enable scheduled announcements. Manage them from the /admin/announcements page.",
    category: "announcements",
    type: "boolean",
  },

  // Achievements
  "achievements.enabled": {
    label: "Achievements enabled",
    description: "Enable the achievements / accolades system.",
    category: "achievements",
    type: "boolean",
    dependsOn: ["voicetracking.enabled"],
  },
  "achievements.announcements.enabled": {
    label: "Channel announcements for earned achievements",
    description: "Announce newly earned achievements in a Discord channel.",
    category: "achievements",
    type: "boolean",
  },
  "achievements.dm_notifications.enabled": {
    label: "DM notifications for earned achievements",
    description: "DM users when they earn a new achievement.",
    category: "achievements",
    type: "boolean",
  },

  // Marquee Milestone Celebrations (#657, Part 2)
  "celebrations.enabled": {
    label: "Milestone celebrations enabled",
    description:
      "Post a server-wide celebration in a configured channel the first time anyone crosses a marquee accolade (Voice Legend, 1000 hours, a 30-day streak, 100 quotes). Reuses the existing accolade award detection; requires achievements to be enabled.",
    category: "celebrations",
    type: "boolean",
    dependsOn: ["achievements.enabled"],
  },
  "celebrations.channel_id": {
    label: "Celebrations channel",
    description:
      "Channel where marquee milestone celebrations are posted. Leave empty to disable the announcement (the underlying accolade is still awarded).",
    category: "celebrations",
    type: "channel",
  },

  // Weekly Personal Voice-Activity Digest (#483)
  "digest.enabled": {
    label: "Weekly voice-activity digest enabled",
    description:
      "Send a personalised weekly DM summarising each eligible user's voice activity, rank, streak, and new achievements.",
    category: "digest",
    type: "boolean",
    dependsOn: ["voicetracking.enabled"],
  },
  "digest.cron": {
    label: "Digest schedule (cron)",
    description:
      "Cron expression for when the weekly digest job runs (defaults to Mondays 09:00 in the host timezone).",
    category: "digest",
    type: "cron",
  },
  "digest.min_active_minutes": {
    label: "Minimum active minutes to qualify",
    description:
      "Users with less than this many minutes of voice activity in the past 7 days are skipped.",
    category: "digest",
    type: "number",
    min: 0,
    max: 10080,
    presets: [0, 15, 30, 60, 120, 180, 300],
    presetZeroLabel: "None",
  },
  "digest.streak_min_minutes": {
    label: "Streak threshold (minutes per week)",
    description:
      "Minutes of voice activity that count a week toward the consecutive-weeks streak.",
    category: "digest",
    type: "number",
    min: 0,
    max: 10080,
    presets: [0, 15, 30, 60, 120, 180, 300],
    presetZeroLabel: "None",
  },
  "digest.include_achievements": {
    label: "Include weekly achievements in digest",
    description:
      "Embed the achievements earned during the past week alongside the activity summary.",
    category: "digest",
    type: "boolean",
    dependsOn: ["achievements.enabled"],
  },

  // Rewind year-in-review (#484, #608)
  "rewind.enabled": {
    label: "Rewind enabled",
    description:
      "Enable the personal year-in-review feature: the /me/rewind page, its data aggregation, and the nav link. When off, the page answers 404 and isn't linked. The end-of-year DM nudge has its own toggle below.",
    category: "rewind",
    type: "boolean",
  },
  "rewind.nudge.enabled": {
    label: "Rewind end-of-year nudge enabled",
    description:
      "Send a one-shot end-of-year DM linking eligible users to their personal year-in-review at /me/rewind. Only runs while the Rewind feature toggle above is on, because the page it links to is not available otherwise. Existing installs that set the old `rewind.enabled` key keep their nudge behaviour via a backward-compat fallback.",
    category: "rewind",
    type: "boolean",
  },
  "rewind.cron": {
    label: "Rewind nudge schedule (cron)",
    description:
      "Cron expression for when the end-of-year DM nudge runs (defaults to December 30 at 10:00 in the host timezone).",
    category: "rewind",
    type: "cron",
  },
  "rewind.min_minutes": {
    label: "Minimum annual minutes to qualify",
    description:
      "Users with less than this many minutes of voice activity in the year are skipped by the end-of-year DM nudge. The /me/rewind page itself is unaffected.",
    category: "rewind",
    type: "number",
    min: 0,
    max: 525600,
    presets: [0, 30, 60, 120, 300, 600, 1200],
    presetZeroLabel: "None",
  },

  // Reaction Roles
  "birthdays.enabled": {
    label: "Birthday celebrations enabled",
    description:
      "Post a birthday message in a configured channel on each member's birthday, evaluated in their own timezone. Members set their date on /me/birthday.",
    category: "birthdays",
    type: "boolean",
  },
  "birthdays.cron": {
    label: "Birthday check schedule (cron)",
    description:
      "How often the birthday check runs. Hourly by default so the post lands on each member's local day across timezones — a once-daily schedule can miss members several hours ahead of or behind the host.",
    category: "birthdays",
    type: "cron",
  },
  "birthdays.channel_id": {
    label: "Birthday announcement channel",
    description: "Channel where birthday messages are posted.",
    category: "birthdays",
    type: "channel",
  },
  "birthdays.message": {
    label: "Birthday message template",
    description:
      "Message posted on a member's birthday. Placeholders: {user} (mention), {username} (display name, no ping), {age} (blank when the member didn't share a birth year).",
    category: "birthdays",
    type: "string",
  },
  "birthdays.mention": {
    label: "Ping the birthday member",
    description:
      "When on, the {user} placeholder pings the member. When off, their name shows but no notification is sent.",
    category: "birthdays",
    type: "boolean",
  },
  "birthdays.role_id": {
    label: "Temporary birthday role",
    description:
      "Optional role granted on a member's birthday and removed automatically after the configured duration. Leave empty to skip the role. A role with Administrator or other powerful permissions (Manage Server, Manage Roles, Ban Members and similar) is refused, and one already saved is not granted.",
    category: "birthdays",
    type: "role",
  },
  "birthdays.role_duration_hours": {
    label: "Birthday role duration (hours)",
    description:
      "How long the temporary birthday role is held before the daily sweep removes it.",
    category: "birthdays",
    type: "number",
    min: 1,
    max: 8760,
    presets: [6, 12, 24, 48, 72, 168],
  },
  "birthdays.change_cooldown_seconds": {
    label: "Birthday change cooldown (seconds)",
    description:
      "Minimum time between a member changing the month/day of their own birthday. Stops a member re-arming the announcement and birthday role by flipping the date back and forth. Saving the same date, or only the year, is never limited. Set to 0 for no cooldown.",
    category: "birthdays",
    type: "number",
    min: 0,
    max: 2592000,
    presets: [0, 60, 300, 900, 3600, 86400],
    presetZeroLabel: "Off",
  },
  "welcome.enabled": {
    label: "Welcome messages enabled",
    description: `Post a welcome message in a configured channel when a new member joins. Requires the Server Members Intent, otherwise Discord never delivers join events (the bot logs a warning at startup). ${GUILD_MEMBERS_INTENT_HOWTO}`,
    category: "welcome",
    type: "boolean",
  },
  "welcome.channel_id": {
    label: "Welcome channel",
    description: "Channel where welcome messages are posted.",
    category: "welcome",
    type: "channel",
  },
  "welcome.message": {
    label: "Welcome message template",
    description:
      "Message posted when a member joins. Placeholders: {user} (mention), {username} (display name, no ping), {server} (server name), {roles} (link to the self-assign role picker, blank if none configured), {rules} (rules channel mention, blank if none configured).",
    category: "welcome",
    type: "string",
  },
  "welcome.mention": {
    label: "Ping the new member",
    description:
      "When on, the {user} placeholder pings the member. When off, their name shows but no notification is sent.",
    category: "welcome",
    type: "boolean",
  },
  "welcome.roles_message_id": {
    label: "Self-assign roles message",
    description:
      'Optional reaction-role message that {roles} links to, picked from the messages the bot posted (see Reaction Roles). Choose "Link the channel instead" to mention the reaction-role channel.',
    category: "welcome",
    type: "string",
    format: "reaction_role_message",
  },
  "welcome.rules_channel_id": {
    label: "Rules channel",
    description:
      "Optional channel mentioned by the {rules} placeholder in the welcome message.",
    category: "welcome",
    type: "channel",
  },
  "rules.enabled": {
    label: "Rules acceptance enabled",
    description:
      "Let members accept the server rules with a button and receive an acceptance role. Off by default. If Discord's Membership Screening or Onboarding is already active, new members would accept the rules twice; use one gate, not both.",
    category: "rules",
    type: "boolean",
  },
  "rules.channel_id": {
    label: "Rules channel",
    description:
      "Channel where KoolBot posts the rules message with the Accept button. Make it read-only for members.",
    category: "rules",
    type: "channel",
  },
  "rules.role_id": {
    label: "Acceptance role",
    description:
      "Role granted when a member presses Accept. Pick an existing role (for example a verified role) or create one on the Rules page. Its current holders count as already accepted.",
    category: "rules",
    type: "role",
  },
  "rules.message": {
    label: "Rules message text",
    description:
      "Text posted with the Accept button. Put the rules themselves in the channel above it, or write them here.",
    category: "rules",
    type: "string",
  },
  "rules.button_label": {
    label: "Accept button label",
    description: "Text on the Accept button (up to 80 characters).",
    category: "rules",
    type: "string",
  },
  "rules.message_id": {
    label: "Rules message ID",
    description:
      "Managed by KoolBot: the ID of the posted rules message. Shown here for reference. The Rules page's button edits the message, or posts a new one when it was deleted or the channel changed.",
    category: "rules",
    type: "string",
    managed: { channelKey: "rules.channel_id" },
  },
  "events.enabled": {
    label: "Events enabled",
    description:
      "Enable scheduled events and the /admin/events page. Events create a temporary voice channel shortly before they start and remove it once they end.",
    category: "events",
    type: "boolean",
  },
  "events.category_id": {
    label: "Event channel category",
    description:
      "Category under which temporary event voice channels are created. Required for channels to spin up.",
    category: "events",
    type: "category",
  },
  "events.announcement_channel_id": {
    label: "Event announcement channel",
    description:
      "Text channel where the event announcement (with the Discord event link) and the pre-start reminder are posted.",
    category: "events",
    type: "channel",
  },
  "events.timezone": {
    label: "Event timezone (IANA)",
    description:
      "IANA timezone (e.g. Europe/London) used to interpret the wall-clock start time entered for an event. Empty falls back to the host/server timezone.",
    category: "events",
    type: "string",
    format: "timezone",
  },
  "events.channel_prefix": {
    label: "Event channel name prefix",
    description:
      "Free text prepended to the event title when naming the temporary voice channel (up to 32 characters; an emoji is fine but not required).",
    category: "events",
    type: "string",
    format: "affix",
  },
  "events.reminder_minutes": {
    label: "Reminder lead time (minutes)",
    description:
      "How many minutes before an event starts the reminder is posted in the announcement channel. Set to 0 to disable reminders.",
    category: "events",
    type: "number",
    min: 0,
    max: 10080,
    presets: [0, 5, 10, 15, 30, 60],
    presetZeroLabel: "Off",
  },
  "events.create_lead_minutes": {
    label: "Channel creation lead time (minutes)",
    description:
      "How many minutes before an event starts its temporary voice channel is created.",
    category: "events",
    type: "number",
    min: 0,
    max: 1440,
    presets: [5, 10, 15, 30, 60],
  },
  "events.default_duration_minutes": {
    label: "Default event duration (minutes)",
    description:
      "Duration applied to an event when the organiser doesn't specify one.",
    category: "events",
    type: "number",
    min: 1,
    max: 1440,
    presets: [30, 60, 90, 120, 180],
  },
  "events.channel_grace_minutes": {
    label: "Channel cleanup grace (minutes)",
    description:
      "How long after an event ends (counted from when it actually ended, so ending it early with End now starts the clock then) the bot waits before deleting its (now empty) voice channel.",
    category: "events",
    type: "number",
    min: 0,
    max: 1440,
    presets: [0, 5, 10, 15, 30, 60],
    presetZeroLabel: "None",
  },
  "events.recurrence_enabled": {
    label: "Recurring events enabled",
    description:
      "Allow events to repeat weekly, every two weeks or monthly. When off, new events are one-off only and finished recurring events stop spawning their next occurrence (already-scheduled ones are unaffected).",
    category: "events",
    type: "boolean",
  },
  "events.native.location": {
    label: "Native event location text",
    description:
      "Location line shown on the mirrored Discord scheduled event (max 100 characters). The temporary voice channel only exists shortly before the start, so the native event is an external one with this text until the room is created (see the link switch below).",
    category: "events",
    type: "string",
  },
  "events.native.link_room": {
    label: "Link the native event to the voice room",
    description:
      "When the event's main voice room is created (shortly before the start), point the Discord scheduled event at that room instead of the location text. With event groups the main room is linked too, never a group room. A linked event is started at its start time. Untested risk: Discord may mark the card finished early when the room empties, and with groups the main room can empty while the teams play in their own rooms; KoolBot cannot undo that, so this switch is the rollback. If Discord refuses the change the text stays and the bot tries again on the next scan. Turn this off to keep new events external with the text only. Turning the switch off stops new links and puts an existing link back to the text only while the Discord event is still Scheduled and before its start time; once the start has passed the link stays (and a link still Scheduled then is still started), so it is not a rollback for a running event.",
    category: "events",
    type: "boolean",
  },
  "events.groups.default_count": {
    label: "Event groups offered by default",
    description:
      "How many empty group rows the Groups section of the event form shows up front (1 to the maximum below). Organisers can add more, and a preset fills in its own groups.",
    category: "events",
    type: "number",
    min: 1,
    max: 25,
    stepper: true,
    reloadOnSave: true,
  },
  "events.groups.max_count": {
    label: "Most groups per event",
    description:
      "The most groups one event may have (each becomes its own voice channel). At most 25, since a Discord category holds 50 channels. Anything over the maximum is refused.",
    category: "events",
    type: "number",
    min: 1,
    max: 25,
    stepper: true,
    reloadOnSave: true,
  },
  "events.groups.group_label": {
    label: "What a group is called",
    description:
      "The word an event's groups go by when the host picks none: Team, Squad, Room or Party. It shows on the event form as the server default, choosing a group preset there sets that preset's own word, and the host can pick another word, or type their own, for each event. Events already saved keep the word they have.",
    category: "events",
    type: "string",
    options: GROUP_WORDING_OPTIONS.map((w) => ({ value: w, label: w })),
  },
  "events.groups.leader_label": {
    label: "What a group leader is called",
    description:
      "The word a group leader goes by when the host picks none: Leader or Captain. It names the captains lobby and is used in the leader messages. Choosing a group preset on the form sets that preset's own word, and the host can pick another word, or type their own, for each event. Events already saved keep the word they have.",
    category: "events",
    type: "string",
    options: LEADER_WORDING_OPTIONS.map((w) => ({ value: w, label: w })),
  },

  "events.max_active_per_host": {
    label: "Most open events per host",
    description:
      "The most events a member who is not an administrator may have open at once, counting the ones scheduled and the ones running (finished and cancelled events do not count). Someone at the limit cannot create or start another until one ends or is cancelled. Administrators are never limited. Set to 0 for no limit.",
    category: "events",
    type: "number",
    min: 0,
    max: 100,
  },
  "lfg.enabled": {
    label: "LFG enabled",
    description:
      'Enable ad-hoc "looking for group" posts and the /lfg command. A member posts what they want to play right now; others join from the post\'s buttons.',
    category: "lfg",
    type: "boolean",
  },
  "lfg.channel_id": {
    label: "LFG channel",
    description:
      "Text channel LFG posts are sent to. Leave empty to post in whichever channel /lfg was run in.",
    category: "lfg",
    type: "channel",
  },
  "lfg.expiry_minutes": {
    label: "Post lifetime (minutes)",
    description:
      "How long an LFG post stays open before it closes itself. A post that fills up closes as soon as it does.",
    category: "lfg",
    type: "number",
    min: 1,
    max: 10080,
    presets: [15, 30, 60, 120, 240],
  },
  "lfg.default_size": {
    label: "Default party size",
    description:
      "Party size (host included) used when the member doesn't pass one to /lfg.",
    category: "lfg",
    type: "number",
    min: 2,
    max: 25,
    stepper: true,
  },
  "lfg.max_active_per_user": {
    label: "Open posts per member",
    description:
      "How many LFG posts one member may have open at a time. Set to 0 for no cap.",
    category: "lfg",
    type: "number",
    min: 0,
    max: 100,
  },
  "lfg.voice_channel.enabled": {
    label: "Attach a voice channel",
    description:
      "Create a dynamic voice channel for each LFG post and link it from the post. Only takes effect while voice channel management is enabled, since that feature owns the channel's cleanup; a host who already owns a dynamic channel gets theirs linked instead of a second one.",
    category: "lfg",
    type: "boolean",
  },
  "reminders.enabled": {
    label: "Reminders enabled",
    description:
      "Enable personal reminders and the /remind command. Members schedule their own one-off reminders; KoolBot DMs them when due and falls back to the channel the reminder was set in if DMs are closed.",
    category: "reminders",
    type: "boolean",
  },
  "tickets.enabled": {
    label: "Tickets enabled",
    description:
      "Enable member support tickets: the /ticket command opens a private channel only the member and your staff role can see, and the /admin/tickets page lists open and closed tickets. Also set the staff role; opening a ticket is refused until it is.",
    category: "tickets",
    type: "boolean",
  },
  "tickets.category_id": {
    label: "Ticket channel category",
    description:
      "Discord category new ticket channels are created under. Leave empty to create them at the top level of the server.",
    category: "tickets",
    type: "category",
  },
  "tickets.staff_role_id": {
    label: "Ticket staff role",
    description:
      "Role that can see every ticket channel and may claim, close and reopen tickets. Required: tickets are refused while it is empty, because a ticket nobody can see helps nobody. Changing it only affects new tickets: existing ticket channels keep the previous role's access until they are deleted or their permissions are edited by hand.",
    category: "tickets",
    type: "role",
  },
  "tickets.transcript_on_close": {
    label: "Save transcript on close",
    description:
      "When a ticket closes, post a plain-text log of its messages into the (now locked) ticket channel so staff can download it. The channel is archived, not deleted.",
    category: "tickets",
    type: "boolean",
  },
  "tickets.max_open_per_member": {
    label: "Open tickets per member",
    description:
      "How many tickets one member may have open (or claimed) at a time. Each ticket is a channel and pings the staff role, so this bounds how many a single member can create. Closed tickets do not count. Set to 0 for no cap. Staff are not exempt.",
    category: "tickets",
    type: "number",
    min: 0,
    max: 100,
  },
  "tickets.open_cooldown_seconds": {
    label: "Ticket open cooldown (seconds)",
    description:
      "Minimum time between one member opening tickets, counted from their last successful /ticket open. Set to 0 for no cooldown. The timer resets when the bot restarts.",
    category: "tickets",
    type: "number",
    min: 0,
    max: 86400,
    presets: [0, 60, 300, 900, 3600, 86400],
    presetZeroLabel: "Off",
  },
  "reminders.max_pending": {
    label: "Pending reminders per member",
    description:
      "How many undelivered reminders one member may hold at a time. Bounds abuse; a member must cancel one before adding another once at the cap.",
    category: "reminders",
    type: "number",
    min: 1,
    max: 1000,
  },
  "privacy.enabled": {
    label: "Self-service data export enabled",
    description:
      "Let members download everything KoolBot has stored about them from the /me/privacy page. Moderation records, admin audit logs and session rows are never included. When off, the Privacy section is hidden from /me (nav entry and Overview card) and /me/privacy and its download return 404.",
    category: "privacy",
    type: "boolean",
  },
  "privacy.export.max_items": {
    label: "Export rows per collection",
    description:
      "Ceiling on how many rows (and how many entries of an append-only array, e.g. voice sessions) a single export includes per collection. The export names anything it clipped so a member knows the file is partial.",
    category: "privacy",
    type: "number",
    min: 1,
    max: 1000000,
  },
  "privacy.delete.enabled": {
    label: "Self-service data reset enabled",
    description:
      'Add a "Reset my data" action to /me/privacy (also needs the data export enabled). It wipes the member\'s tracking history, achievements, preferences and other per-member rows, then signs them out. Moderation records and audit logs are kept. Tracking starts again on their next message, reaction or voice join, so this is a reset, not a deletion — unless the member has opted out of tracking (privacy.tracking_opt_out.enabled), in which case it is a real deletion. Note: achievements become re-earnable, and re-earning a marquee accolade @-mentions the member in the celebrations channel again — the cooldown bounds how often that can happen.',
    category: "privacy",
    type: "boolean",
  },
  "privacy.delete.cooldown_hours": {
    label: "Reset cooldown (hours)",
    description:
      "How long a member must wait after starting a reset before they can run another (a reset that recorded a failure lifts it, so they can retry). Persisted per member, so it survives restarts. 0 turns the cooldown off. Keep it below the Web UI audit retention (core.web_audit.retention_days), which is where the last reset is read back from.",
    category: "privacy",
    type: "number",
    min: 0,
    max: 8760,
    presets: [0, 24, 72, 168, 336, 720],
    presetZeroLabel: "Off",
  },
  "privacy.tracking_opt_out.enabled": {
    label: "Member tracking opt-out enabled",
    description:
      "Let members opt out of activity tracking from /me/privacy (also needs the data export enabled). An opted-out member's messages, reactions, poll votes and voice sessions are not recorded, and they are no longer added to other members' voice co-presence (older mentions in other members' rows are kept). Existing data is not hidden — combined with a data reset, the opt-out is what makes the reset a real deletion. The opt-out itself is a small stored flag the reset keeps; the member removes it by opting back in. Turning this off stops new opt-outs but existing ones stay honoured, and members can always opt back in.",
    category: "privacy",
    type: "boolean",
  },
  "reactionroles.enabled": {
    label: "Reaction roles enabled",
    description:
      "Enable the reaction-role system. Manage mappings from the admin Web UI (Reaction Roles page).",
    category: "reactionroles",
    type: "boolean",
  },
  "reactionroles.message_channel_id": {
    label: "Reaction-role message channel",
    description:
      "Channel ID where NEW reaction-role messages are posted. Each mapping remembers the channel its picker was posted in, so changing this never moves or breaks existing pickers: they keep working in their own channel. Only older mappings, created before pickers remembered their channel, are still looked up here; for those, delete the picker and mapping BEFORE switching channels, or switch back before cleaning up (startup keeps them while none of them is found in this channel, and archives the missing ones once another is).",
    category: "reactionroles",
    type: "channel",
  },
  "reactionroles.style": {
    label: "Self-assign surface style",
    description:
      "How new self-assign role messages let members pick a role. 'reaction' is the classic emoji reaction (legacy default). 'button' and 'select' post interactive components — no reaction intents or partials, and an ephemeral confirmation per click. Existing messages keep whichever style they were created with.",
    category: "reactionroles",
    type: "string",
    options: [
      { value: "reaction", label: "Emoji reaction (classic)" },
      { value: "button", label: "Button" },
      { value: "select", label: "Select menu" },
    ],
  },

  "reactionroles.group_role_colour": {
    label: "Generated group role colour",
    description:
      "Colour (#RRGGBB) given to roles the grouped-role generator creates on the Reaction Roles page. Leave empty for Discord's default. Generated roles never get any permissions, and existing roles of the same name are reused untouched.",
    category: "reactionroles",
    type: "string",
    format: "colour",
  },
  "reactionroles.max_toggles": {
    label: "Role flips per member per window",
    description:
      "How many times one member may add or remove self-assign roles (reactions, buttons and menus together) within the flip window. Over the limit, further flips are ignored until it passes. Set to 0 for no limit.",
    category: "reactionroles",
    type: "number",
    min: 0,
    max: 1000,
  },
  "reactionroles.toggle_window_seconds": {
    label: "Role flip window (seconds)",
    description:
      "Length of the window for the role flip limit, in seconds. The default allows 10 flips per 30 seconds.",
    category: "reactionroles",
    type: "number",
    min: 1,
    max: 3600,
    presets: [10, 15, 30, 60, 120, 300],
  },

  // Notices System
  "notices.enabled": {
    label: "Notices system enabled",
    description:
      "Enable the notices system. Manage notices from the /admin/notices page.",
    category: "notices",
    type: "boolean",
  },
  "notices.channel_id": {
    label: "Notices channel",
    description: "Channel ID where notice messages are posted.",
    category: "notices",
    type: "channel",
    // The Notices page's Re-post card renders from this value (#1428).
    reloadOnSave: true,
  },
  "notices.header_enabled": {
    label: "Pinned header post enabled",
    description:
      "Post and maintain a pinned informational header in the notices channel.",
    category: "notices",
    type: "boolean",
    // The Notices page's Re-post card renders from this value (#1428).
    reloadOnSave: true,
  },
  "notices.header_message_id": {
    label: "Header message ID (auto-managed)",
    description: "Auto-managed message ID of the notices channel header post.",
    category: "notices",
    type: "string",
    managed: { channelKey: "notices.channel_id" },
  },
  "notices.header_pin_enabled": {
    label: "Pin header post",
    description: "Pin the header post in the notices channel.",
    category: "notices",
    type: "boolean",
  },

  // Poll System
  "polls.enabled": {
    label: "Polls system enabled",
    description:
      "Enable the poll system. Create and manage polls from the /admin/polls page.",
    category: "polls",
    type: "boolean",
  },
  "polls.default_duration_hours": {
    label: "Default poll duration (hours)",
    description: "Default poll duration in hours (1–768).",
    category: "polls",
    type: "number",
    min: 1,
    max: 768,
    presets: [1, 6, 12, 24, 48, 72, 168, 336],
  },
  "polls.cooldown_days": {
    label: "Reuse cooldown (days)",
    description:
      "Minimum days before a question from the library can be reused.",
    category: "polls",
    type: "number",
    min: 0,
    max: 3650,
    presets: [0, 1, 3, 7, 14, 30, 90],
    presetZeroLabel: "None",
  },
  "polls.participation.enabled": {
    label: "Poll participation tracking enabled",
    description:
      "Record per-user 'votes cast' (lifetime + per-year + per-week) and per-poll turnout whenever a user votes on any guild poll. Powers the Rewind stat, the poll accolades and the weekly recap's poll line; off by default.",
    category: "polls",
    type: "boolean",
  },
  "polls.participation.weekly_retention_weeks": {
    label: "Weekly vote bucket retention (weeks)",
    description:
      "Weeks of per-member weekly vote counters to keep before the daily cleanup drops them. Lifetime and per-year totals are never pruned. Set to 0 to keep every week forever.",
    category: "polls",
    type: "number",
    min: RETENTION_MIN,
    max: 5200,
  },
  "polls.turnout.retention_days": {
    label: "Poll turnout retention (days)",
    description:
      "Days to keep the per-poll turnout rows (which polls ran and who voted on them) that back the weekly recap's 'across M polls' line. Set to 0 to keep them forever.",
    category: "polls",
    type: "number",
    min: RETENTION_MIN,
    max: RETENTION_MAX_DAYS,
  },

  // Leaderboard Role Rewards
  "leaderboard_roles.enabled": {
    label: "Leaderboard role rewards enabled",
    description:
      "Auto-assign Discord roles to users based on their voice-leaderboard position.",
    category: "leaderboard_roles",
    type: "boolean",
    dependsOn: ["voicetracking.enabled"],
  },
  "leaderboard_roles.period": {
    label: "Period",
    description:
      "Activity window the leaderboard role tiers are computed from.",
    category: "leaderboard_roles",
    type: "string",
    options: [
      { value: "week", label: "This week" },
      { value: "month", label: "This month" },
      { value: "alltime", label: "All time" },
    ],
  },
  "leaderboard_roles.update_cron": {
    label: "Recalculation schedule (cron)",
    description:
      "Cron schedule for recalculating leaderboard role assignments.",
    category: "leaderboard_roles",
    type: "cron",
  },
  "leaderboard_roles.tiers": {
    label: "Tier definitions",
    description:
      'Comma-separated "topN:roleId" pairs (e.g. "1:111,3:222,10:333"). Each tier independently assigns the role to users whose rank is ≤ N. Admins pick any positions; nothing is hardcoded.',
    category: "leaderboard_roles",
    type: "string",
    editedElsewhere: true,
  },
  "leaderboard_roles.announcement_channel_id": {
    label: "Role-change announcements channel",
    description:
      "Optional channel ID where role-change announcements are posted. Leave empty to disable announcements.",
    category: "leaderboard_roles",
    type: "channel",
  },

  // Discord-channel logging categories (#844). Consumed by DiscordLogger,
  // which routes each `logToChannel(<type>)` call to `core.<type>.channel_id`
  // when `core.<type>.enabled` is on.
  "core.webui.link_delivery": {
    label: "Web UI sign-in link delivery",
    description:
      "How /me and /config hand out the single-use Web UI sign-in link. 'dm' sends it as a direct message (falls back to an ephemeral reply when the member's DMs are closed). 'ephemeral' replies in the channel, visible only to the invoker — useful when members keep DMs closed.",
    category: "core",
    type: "string",
    options: [
      { value: "dm", label: "Direct message (ephemeral fallback)" },
      { value: "ephemeral", label: "Ephemeral reply" },
    ],
  },
  "core.guild_scope.leave_other_guilds": {
    label: "Leave other servers",
    description:
      "KoolBot only works for the server named by GUILD_ID and ignores events from any other server it has been added to. Turn this on to make it leave those servers (now, and whenever it is added to one). Off by default so a bot you deliberately keep in a second server is never removed. Turn off Public Bot in the Discord developer portal to stop others adding it.",
    category: "core",
    type: "boolean",
  },
  "core.webui.signin_cooldown_seconds": {
    label: "Web UI sign-in link cooldown (seconds)",
    description:
      "Minimum time between sign-in links for one member via /me or /config. Each new link replaces the previous one, so this bounds how fast one member can create sign-in sessions. Set to 0 for no cooldown.",
    category: "core",
    type: "number",
    min: 0,
    max: 3600,
    presets: [0, 10, 30, 60, 300, 900, 3600],
    presetZeroLabel: "Off",
  },
  "core.startup.enabled": {
    label: "Startup log to Discord",
    description:
      "Post bot lifecycle events (startup, shutdown, database connection, and whether the slash commands registered with Discord) as embeds to the startup log channel.",
    category: "core",
    type: "boolean",
  },
  "core.startup.channel_id": {
    label: "Startup log channel",
    description:
      "Text channel that receives startup log embeds. Nothing is posted while this is empty.",
    category: "core",
    type: "channel",
  },
  "core.errors.enabled": {
    label: "Error log to Discord",
    description:
      "Post errors that stop startup or fail a clean-up run (service initialisation, message activity clean-up, voice channel truncation) as embeds to the error log channel.",
    category: "core",
    type: "boolean",
  },
  "core.errors.channel_id": {
    label: "Error log channel",
    description:
      "Text channel that receives error log embeds. Nothing is posted while this is empty.",
    category: "core",
    type: "channel",
  },
  "core.cleanup.enabled": {
    label: "Cleanup log to Discord",
    description:
      "Post data-maintenance results (voice-session cleanup runs, rows removed/aggregated) as embeds to the cleanup log channel.",
    category: "core",
    type: "boolean",
  },
  "core.cleanup.channel_id": {
    label: "Cleanup log channel",
    description:
      "Text channel that receives cleanup log embeds. Nothing is posted while this is empty.",
    category: "core",
    type: "channel",
  },
  "core.config.enabled": {
    label: "Config log to Discord",
    description:
      "Nothing is posted to the config log at present: a settings reload is not reported. The category is kept so settings you already saved stay valid.",
    category: "core",
    type: "boolean",
  },
  "core.config.channel_id": {
    label: "Config log channel",
    description:
      "Text channel for config log embeds. Nothing is posted to it at present.",
    category: "core",
    type: "channel",
  },
  "core.cron.enabled": {
    label: "Cron log to Discord",
    description:
      "Post scheduled-job outcomes as embeds to the cron log channel: runs of the weekly digest, birthdays, Rewind nudge and events, and a run that crashed in a job on the shared scheduler (digest, birthdays, Rewind nudge, events, reminders, LFG, leaderboard roles, case review, role groups and the clean-up jobs). Polls, scheduled announcements and errors a job handles itself are not posted.",
    category: "core",
    type: "boolean",
  },
  "core.cron.channel_id": {
    label: "Cron log channel",
    description:
      "Text channel that receives cron log embeds. Nothing is posted while this is empty.",
    category: "core",
    type: "channel",
  },
  "core.moderation.enabled": {
    label: "Moderation log to Discord",
    description:
      "Post a summary embed to the moderation log channel whenever a moderation action is recorded (a /warn, or a kick, ban, lifted ban or timeout made in Discord and copied in from the audit log), including the member's earlier actions. Requires moderation.enabled.",
    category: "core",
    type: "boolean",
  },
  "core.moderation.channel_id": {
    label: "Moderation log channel",
    description:
      "Text channel that receives moderation action embeds. Nothing is posted while this is empty.",
    category: "core",
    type: "channel",
  },
  "core.moderation_review.enabled": {
    label: "Case review notices to Discord",
    description:
      "Post one summary embed to the review channel whenever moderation cases need a decision. Requires moderation.cases.enabled.",
    category: "core",
    type: "boolean",
  },
  "core.moderation_review.channel_id": {
    label: "Case review channel",
    description:
      "Text channel that receives the due-for-review summary. Nothing is posted while this is empty.",
    category: "core",
    type: "channel",
  },
  "core.updates.enabled": {
    label: "Update notes to Discord",
    description:
      "Post a one-time note to the updates log channel the first time the update check sees a newer KoolBot release. Needs the update check to be on.",
    category: "core",
    type: "boolean",
    dependsOn: ["core.updatecheck.enabled"],
  },
  "core.updates.channel_id": {
    label: "Updates log channel",
    description:
      "Text channel that receives the update-available note. Nothing is posted while this is empty.",
    category: "core",
    type: "channel",
  },

  // Web UI update check (#1029)
  "core.updatecheck.enabled": {
    label: "Check for updates",
    description:
      "Compare the running version with the latest KoolBot release on GitHub (at startup, every 12 hours and on demand) and show the result in the Web UI. The check is an anonymous request for public release data and sends nothing about this instance. Turn off for air-gapped or privacy-strict installs.",
    category: "core",
    type: "boolean",
  },

  // Discord slash-command audit log (#459)
  "core.command_audit.enabled": {
    label: "Slash-command audit log enabled",
    description:
      "Record one row per Discord slash-command invocation (who, what, when, outcome) so operators can audit command usage from the WebUI. Button, select-menu and modal interactions are recorded too, under a fixed component name. Raw command arguments, custom ids and submitted text are never recorded.",
    category: "core",
    type: "boolean",
  },
  "core.command_audit.retention_days": {
    label: "Slash-command audit retention (days)",
    description:
      "Days to keep slash-command audit rows before the daily cleanup job prunes them. Set to 0 to keep history forever.",
    category: "core",
    type: "number",
    min: RETENTION_MIN,
    max: RETENTION_MAX_DAYS,
  },
  "core.web_audit.retention_days": {
    label: "WebUI audit retention (days)",
    description:
      "Days to keep WebUI audit-log rows before the daily cleanup job prunes them. Set to 0 to keep history forever.",
    category: "core",
    type: "number",
    min: RETENTION_MIN,
    max: RETENTION_MAX_DAYS,
  },
  "monitoring.metrics_persistence.enabled": {
    label: "Persist command metrics",
    description:
      "Store per-command daily usage/error/latency buckets in MongoDB so command analytics survive restarts and feed the Admin → Command Metrics dashboard. When off, metrics remain in-memory only.",
    category: "core",
    type: "boolean",
  },
  "monitoring.metrics_retention_days": {
    label: "Command-metrics retention (days)",
    description:
      "Days to keep persisted command-metric buckets before MongoDB's TTL index prunes them. Must be at least 1: the TTL index needs a finite window, so 0 cannot mean 'forever' here.",
    category: "core",
    type: "number",
    min: 1,
    max: RETENTION_MAX_DAYS,
  },

  // Moderation log (#728)
  "moderation.enabled": {
    label: "Moderation log enabled",
    description:
      "Enable the moderation log: the /warn and /modlog commands, copying in kicks, bans and timeouts made in Discord itself (from the server's audit log), and the /admin/moderation page. Requires the bot to have the View Audit Log permission for actions made in Discord to be captured.",
    category: "moderation",
    type: "boolean",
  },
  "moderation.retention_days": {
    label: "Moderation log retention (days)",
    description:
      "Days to keep moderation-log rows before the daily cleanup job prunes them. Set to 0 to keep moderation history forever.",
    category: "moderation",
    type: "number",
    min: RETENTION_MIN,
    max: RETENTION_MAX_DAYS,
  },
  "moderation.cases.enabled": {
    label: "Moderation cases enabled",
    description:
      "Let staff open a case against a kick or ban with an optional review date, then record the decision (keep out for now, decide later, keep out for good, let back in) from the Moderation page. Requires moderation.enabled. Cases and the log history behind them are exempt from retention pruning.",
    category: "moderation",
    type: "boolean",
  },
  "moderation.cases.review_cron": {
    label: "Case review schedule (cron)",
    description:
      "When the job runs that marks cases whose review date has passed as needing a decision and posts the notice for them.",
    category: "moderation",
    type: "cron",
  },
  "moderation.cases.default_review_days": {
    label: "Default review window (days)",
    description:
      "Days from now pre-filled as the review date when staff open a case.",
    category: "moderation",
    type: "number",
    min: 1,
    max: 3650,
    presets: [7, 14, 30, 60, 90, 180, 365],
  },
  "moderation.cases.retention_days": {
    label: "Resolved case retention (days)",
    description:
      "Days to keep a resolved case, counted from its last decision rather than from when it was opened. Set to 0 to keep resolved cases forever. Open cases are never pruned. A resolved case is never removed sooner than the history protection window below, since it is what carries that protection.",
    category: "moderation",
    type: "number",
    min: RETENTION_MIN,
    max: RETENTION_MAX_DAYS,
  },
  "moderation.cases.history_grace_days": {
    label: "Case history protection (days)",
    description:
      "How long after a case resolves its member's moderation-log history stays exempt from retention pruning, so a later problem can still be read against it. Members with an open case are always protected. Set to 0 to protect them for as long as the case exists.",
    category: "moderation",
    type: "number",
    min: RETENTION_MIN,
    max: RETENTION_MAX_DAYS,
  },
  "moderation.raid.enabled": {
    label: "Anti-raid protection enabled",
    description: `Detect join floods and optionally act on new accounts. Needs moderation.enabled (every action is written to the moderation log) and the Server Members Intent so join events arrive. ${GUILD_MEMBERS_INTENT_HOWTO} Also enables the /raidmode command. Only ever acts on members who join while it is active, never on existing members.`,
    category: "moderation",
    type: "boolean",
    dependsOn: ["moderation.enabled"],
  },
  "moderation.raid.dry_run": {
    label: "Anti-raid dry run",
    description:
      "While on, anti-raid detects, enters lockdown and posts its alert, but never kicks, times out or role-changes anyone: it only counts and logs what it would have done (see /raidmode status). Turn off once the thresholds look right for your server.",
    category: "moderation",
    type: "boolean",
  },
  "moderation.raid.join_threshold": {
    label: "Raid join threshold",
    description:
      "Lockdown starts when MORE than this many members join within the window below. Minimum 2.",
    category: "moderation",
    type: "number",
    min: 2,
    max: 1000,
  },
  "moderation.raid.window_seconds": {
    label: "Raid window (seconds)",
    description:
      "The sliding window the join threshold is counted over. Must be 5 to 3600.",
    category: "moderation",
    type: "number",
    min: 5,
    max: 3600,
    presets: [10, 15, 30, 60, 120, 300],
  },
  "moderation.raid.lockdown_action": {
    label: "Lockdown action",
    description:
      "What happens to each member who joins while the server is in lockdown. A moderator needs the matching permission to start a lockdown with /raidmode on (timeout: Moderate Members; quarantine: Manage Roles; kick: Kick Members), judged on the stronger of this action and the new-account action when that gate is on; administrators always have it.",
    category: "moderation",
    type: "string",
    options: [
      {
        value: "timeout",
        label: "Timeout (reversible, needs Moderate Members)",
      },
      { value: "quarantine", label: "Quarantine role (needs Manage Roles)" },
      { value: "kick", label: "Kick (needs Kick Members)" },
    ],
  },
  "moderation.raid.min_account_age_hours": {
    label: "Minimum account age (hours)",
    description:
      "New-account gate, independent of lockdown: an account younger than this when it joins gets the new-account action. 0 turns the gate off.",
    category: "moderation",
    type: "number",
    min: 0,
    max: 8760,
    presets: [0, 1, 6, 24, 72, 168, 720],
    presetZeroLabel: "Off",
  },
  "moderation.raid.new_account_action": {
    label: "New-account action",
    description:
      "What happens to a member whose account is younger than the minimum age.",
    category: "moderation",
    type: "string",
    options: [
      {
        value: "timeout",
        label: "Timeout (reversible, needs Moderate Members)",
      },
      { value: "quarantine", label: "Quarantine role (needs Manage Roles)" },
      { value: "kick", label: "Kick (needs Kick Members)" },
    ],
  },
  "moderation.raid.timeout_minutes": {
    label: "Anti-raid timeout (minutes)",
    description:
      "How long the timeout action lasts. Must be 1 to 40320 (28 days, Discord's limit). A moderator can lift a timeout early from Discord.",
    category: "moderation",
    type: "number",
    min: 1,
    max: 40320,
    presets: [5, 10, 30, 60, 360, 720, 1440, 10080],
  },
  "moderation.raid.quarantine_role_id": {
    label: "Quarantine role",
    description:
      "Role assigned by the quarantine action. Give it no access to your channels (or deny it everywhere) and keep it below the bot's own role. Remove it from a member in Discord to let them in.",
    category: "moderation",
    type: "role",
  },
  "moderation.raid.lockdown_max_minutes": {
    label: "Lockdown auto-expiry (minutes)",
    description:
      "End a lockdown automatically this long after it started. 0 keeps it on until a moderator clears it with /raidmode off.",
    category: "moderation",
    type: "number",
    min: 0,
    max: 43200,
    presets: [0, 15, 30, 60, 180, 720, 1440],
    presetZeroLabel: "Until cleared",
  },
  "moderation.raid.alert_channel_id": {
    label: "Raid alert channel",
    description:
      "Text channel that receives a message when lockdown starts or ends. Nothing is posted while this is empty (actions are still logged).",
    category: "moderation",
    type: "channel",
  },
  "aka.enabled": {
    label: "/aka command enabled",
    description:
      "Enable the /aka command, which lists the names a member has previously gone by. Only shows history recorded while Name History recording is on.",
    category: "namehistory",
    type: "boolean",
  },
  "namehistory.enabled": {
    label: "Record name history",
    description:
      "Record usernames, display names and (with the GuildMembers intent) server nicknames as the bot sees them. Recording works even while /aka is off. History starts from when this is turned on.",
    category: "namehistory",
    type: "boolean",
  },
  "adoption.snapshot.retention_days": {
    label: "Adoption snapshot retention (days)",
    description:
      "Days to keep a server-adoption snapshot (the saved prior state used to roll a change back) before the daily cleanup job prunes it. Set to 0 to keep snapshots forever.",
    category: "adoption",
    type: "number",
    min: RETENTION_MIN,
    max: RETENTION_MAX_DAYS,
  },
  "adoption.role_groups.sync_policy": {
    label: "Role group sync policy",
    description:
      "What happens when a role group and its Discord role drift apart (permissions, name, order, or the role was deleted). 'flag' only shows the drift on the Role Groups page and logs it. 'adopt' makes the group follow the Discord change. 'enforce' re-applies the group through the adoption engine (snapshotted, never widens access on its own); a deleted role is recreated only under 'enforce'. A group can override this on its own edit form.",
    category: "adoption",
    type: "string",
    options: [
      { value: "flag", label: "Flag only (default)" },
      { value: "adopt", label: "Adopt: the group follows Discord" },
      { value: "enforce", label: "Enforce: re-apply the group" },
    ],
  },
  "adoption.role_groups.reconcile_enabled": {
    label: "Reconcile role groups on a schedule",
    description:
      "Periodically compare role groups with their Discord roles, to catch changes made while the bot was offline. Role edits and deletions in Discord are also checked as they happen.",
    category: "adoption",
    type: "boolean",
  },
  "adoption.role_groups.reconcile_cron": {
    label: "Role group reconcile schedule (cron)",
    description:
      "Cron schedule for the periodic role group reconcile. Default: every 30 minutes.",
    category: "adoption",
    type: "cron",
  },
  "core.role_groups.enabled": {
    label: "Role group drift log to Discord",
    description:
      "Post role group drift (a role edited or deleted in Discord) and what the sync did about it as embeds to the role group log channel.",
    category: "core",
    type: "boolean",
  },
  "core.role_groups.channel_id": {
    label: "Role group drift log channel",
    description:
      "Text channel that receives role group drift log embeds. Nothing is posted while this is empty.",
    category: "core",
    type: "channel",
  },
  "namehistory.retention_days": {
    label: "Name history retention (days)",
    description:
      "Days to keep a name that has not been seen again before the daily cleanup job prunes it. Set to 0 to keep name history forever.",
    category: "namehistory",
    type: "number",
    min: RETENTION_MIN,
    max: RETENTION_MAX_DAYS,
  },
};
