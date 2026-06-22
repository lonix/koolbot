export interface ConfigSchema {
  // Voice Channel Management
  "voicechannels.enabled": boolean;
  "voicechannels.category_id": string;
  "voicechannels.lobby.name": string;
  "voicechannels.lobby.offlinename": string;
  "voicechannels.channel.prefix": string;
  "voicechannels.channel.suffix": string;
  "voicechannels.controlpanel.enabled": boolean;
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

  // Rate Limiting
  "ratelimit.enabled": boolean;
  "ratelimit.max_commands": number; // Maximum commands per time window
  "ratelimit.window_seconds": number; // Time window in seconds
  "ratelimit.bypass_admin": boolean; // Bypass rate limit for admins

  // Scheduled Announcements
  "announcements.enabled": boolean;

  // Achievements System
  "achievements.enabled": boolean;
  "achievements.announcements.enabled": boolean;
  "achievements.dm_notifications.enabled": boolean;

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

  // Reaction Roles
  "reactionroles.enabled": boolean;
  "reactionroles.message_channel_id": string; // Channel for reaction role messages

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

  // Leaderboard Role Rewards
  "leaderboard_roles.enabled": boolean;
  "leaderboard_roles.period": string; // "week" | "month" | "alltime"
  "leaderboard_roles.update_cron": string; // Cron schedule for recalculation
  "leaderboard_roles.tiers": string; // Comma-separated "topN:roleId" pairs, e.g. "1:111,3:222,10:333"
  "leaderboard_roles.announcement_channel_id": string; // Optional channel ID for role-change announcements

  // Discord slash-command audit log (issue #459)
  "core.command_audit.enabled": boolean;
  "core.command_audit.retention_days": number;

  // Persisted command metrics (issue #648)
  "monitoring.metrics_persistence.enabled": boolean;
  "monitoring.metrics_retention_days": number;
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
  "voicechannels.lobby.name": "Lobby",
  "voicechannels.lobby.offlinename": "Offline Lobby",
  "voicechannels.channel.prefix": "🎮",
  "voicechannels.channel.suffix": "",
  "voicechannels.controlpanel.enabled": true,
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

  // Rate Limiting defaults
  "ratelimit.enabled": false,
  "ratelimit.max_commands": 5, // 5 commands
  "ratelimit.window_seconds": 10, // per 10 seconds
  "ratelimit.bypass_admin": true, // Admins bypass rate limits

  // Scheduled Announcements defaults
  "announcements.enabled": false,

  // Achievements defaults
  "achievements.enabled": false,
  "achievements.announcements.enabled": true,
  "achievements.dm_notifications.enabled": true,

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

  // Reaction Roles defaults
  "reactionroles.enabled": false,
  "reactionroles.message_channel_id": "",

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

  // Persisted command metrics defaults (#648). On by default so fresh
  // installs get historical command analytics in the Admin → Command
  // Metrics dashboard out of the box; 30-day window matches the issue.
  "monitoring.metrics_persistence.enabled": true,
  "monitoring.metrics_retention_days": 30,
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
   * Optional "minimum recommended value" hint for `number`-typed keys. The
   * WebUI shows the warning when the current value drops below the threshold.
   * Reusable across settings; today it guards the Rewind-relevant retention
   * keys (see `REWIND_RETENTION_MIN_DAYS`).
   */
  warnBelow?: SettingWarnBelow;
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
 * Shared warning shown when a Rewind-relevant retention is below the year
 * threshold. Built from `REWIND_RETENTION_MIN_DAYS` so the number stays in
 * one place.
 */
const rewindRetentionWarning: SettingWarnBelow = {
  value: REWIND_RETENTION_MIN_DAYS,
  message: `⚠️ Rewind / year-in-review needs ≥ ${REWIND_RETENTION_MIN_DAYS} days of detailed data. At this value, recaps that reach further back will be incomplete. Lower it only if you don't need a full year-in-review.`,
};

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
  digest: {
    title: "Weekly Digest",
    description:
      "Personalised weekly DM summarising each user's voice activity, rank, streak, and new achievements. Opt-out lives on the user's /me/notifications page.",
  },
  rewind: {
    title: "Rewind (Year-in-Review)",
    description:
      "Personalised end-of-year recap at /me/rewind plus a one-shot DM nudge in late December. Opt-out lives on the user's /me/notifications page.",
  },
  reactionroles: {
    title: "Reaction Roles",
    description:
      "Let users self-assign roles by reacting to a configured message.",
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
  "voicechannels.lobby.name": {
    label: "Lobby channel display name",
    description:
      "Display name of the lobby channel users join to spawn a personal channel. Cosmetic; the bot sets this on the managed channel rather than looking it up by name. Emoji shortcodes like :green_circle: are converted to the emoji on save (custom server emoji aren't supported in channel names).",
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
  "voicechannels.channel.prefix": {
    label: "Per-user channel name prefix",
    description:
      "Prefix prepended to dynamically created voice channel names. Emoji shortcodes like :video_game: are converted to the emoji on save (custom server emoji aren't supported in channel names).",
    category: "voicechannels",
    type: "string",
  },
  "voicechannels.channel.suffix": {
    label: "Per-user channel name suffix",
    description:
      "Suffix appended to dynamically created voice channel names. Emoji shortcodes like :sparkles: are converted to the emoji on save (custom server emoji aren't supported in channel names).",
    category: "voicechannels",
    type: "string",
  },
  "voicechannels.controlpanel.enabled": {
    label: "In-channel control panel enabled",
    description:
      "Show the in-channel control panel (rename / privacy / live / transfer).",
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
    label: "Scheduled voice-stats announcements enabled",
    description: "Enable scheduled voice-stats announcements.",
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
    description:
      "Discord channel ID where voice-stats announcements are posted.",
    category: "voicetracking",
    type: "channel",
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
      "Days to keep detailed session rows before they are summarised away. Rewind reads these detailed sessions, so keep this at or above a full year.",
    category: "voicetracking",
    type: "number",
    warnBelow: rewindRetentionWarning,
  },
  "voicetracking.cleanup.retention.monthly_summaries_months": {
    label: "Monthly-summary retention (months)",
    description: "Months to keep monthly summary rows.",
    category: "voicetracking",
    type: "number",
  },
  "voicetracking.cleanup.retention.yearly_summaries_years": {
    label: "Yearly-summary retention (years)",
    description: "Years to keep yearly summary rows.",
    category: "voicetracking",
    type: "number",
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
      "Days to keep per-message detail (recentMessages) before it is pruned. All-time per-channel totals are never pruned. Rewind reads this detail, so keep it at or above a full year.",
    category: "messagetracking",
    type: "number",
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
  },
  "quotes.delete_roles": {
    label: "Roles allowed to delete quotes",
    description:
      "Comma-separated role IDs allowed to delete quotes. Empty means only admins.",
    category: "quotes",
    type: "role_list",
  },
  "quotes.max_length": {
    label: "Maximum quote length (characters)",
    description: "Maximum length of a single quote in characters.",
    category: "quotes",
    type: "number",
  },
  "quotes.cooldown": {
    label: "Cooldown between quotes (seconds)",
    description: "Cooldown in seconds between quote additions per user.",
    category: "quotes",
    type: "number",
  },
  "quotes.header_enabled": {
    label: "Pinned header post enabled",
    description:
      "Post and maintain a pinned informational header in the quote channel.",
    category: "quotes",
    type: "boolean",
  },
  "quotes.header_message_id": {
    label: "Header message ID (auto-managed)",
    description: "Auto-managed message ID of the quote channel header post.",
    category: "quotes",
    type: "string",
  },
  "quotes.header_pin_enabled": {
    label: "Pin header post",
    description: "Pin the header post in the quote channel.",
    category: "quotes",
    type: "boolean",
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
  },
  "ratelimit.window_seconds": {
    label: "Rate-limit window (seconds)",
    description: "Length of the rate-limit time window in seconds.",
    category: "ratelimit",
    type: "number",
  },
  "ratelimit.bypass_admin": {
    label: "Admins bypass rate limit",
    description: "Allow administrators to bypass rate limiting.",
    category: "ratelimit",
    type: "boolean",
  },

  // Scheduled Announcements
  "announcements.enabled": {
    label: "Scheduled announcements enabled",
    description: "Enable scheduled announcements and the /announce command.",
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
  },
  "digest.streak_min_minutes": {
    label: "Streak threshold (minutes per week)",
    description:
      "Minutes of voice activity that count a week toward the consecutive-weeks streak.",
    category: "digest",
    type: "number",
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
      "Enable the personal year-in-review feature: the /me/rewind page, its data aggregation, and the nav link. When off, the page returns a disabled state and isn't linked. The end-of-year DM nudge has its own toggle below.",
    category: "rewind",
    type: "boolean",
  },
  "rewind.nudge.enabled": {
    label: "Rewind end-of-year nudge enabled",
    description:
      "Send a one-shot end-of-year DM linking eligible users to their personal year-in-review at /me/rewind. Independent of the Rewind feature toggle above. Existing installs that set the old `rewind.enabled` key keep their nudge behaviour via a backward-compat fallback.",
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
  },

  // Reaction Roles
  "reactionroles.enabled": {
    label: "Reaction roles enabled",
    description: "Enable the reaction-role system and the /reactrole command.",
    category: "reactionroles",
    type: "boolean",
  },
  "reactionroles.message_channel_id": {
    label: "Reaction-role message channel",
    description: "Channel ID where reaction-role messages are posted.",
    category: "reactionroles",
    type: "channel",
  },

  // Notices System
  "notices.enabled": {
    label: "Notices system enabled",
    description: "Enable the notices system and the /notice command.",
    category: "notices",
    type: "boolean",
  },
  "notices.channel_id": {
    label: "Notices channel",
    description: "Channel ID where notice messages are posted.",
    category: "notices",
    type: "channel",
  },
  "notices.header_enabled": {
    label: "Pinned header post enabled",
    description:
      "Post and maintain a pinned informational header in the notices channel.",
    category: "notices",
    type: "boolean",
  },
  "notices.header_message_id": {
    label: "Header message ID (auto-managed)",
    description: "Auto-managed message ID of the notices channel header post.",
    category: "notices",
    type: "string",
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
    description: "Enable the poll system and the /poll command.",
    category: "polls",
    type: "boolean",
  },
  "polls.default_duration_hours": {
    label: "Default poll duration (hours)",
    description: "Default poll duration in hours (1–768).",
    category: "polls",
    type: "number",
  },
  "polls.cooldown_days": {
    label: "Reuse cooldown (days)",
    description:
      "Minimum days before a question from the library can be reused.",
    category: "polls",
    type: "number",
  },
  "polls.participation.enabled": {
    label: "Poll participation tracking enabled",
    description:
      "Record per-user 'votes cast' (lifetime + per-year) whenever a user votes on any guild poll. Data-capture foundation for a future Rewind stat; off by default.",
    category: "polls",
    type: "boolean",
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
  },
  "leaderboard_roles.announcement_channel_id": {
    label: "Role-change announcements channel",
    description:
      "Optional channel ID where role-change announcements are posted. Leave empty to disable announcements.",
    category: "leaderboard_roles",
    type: "channel",
  },

  // Discord slash-command audit log (#459)
  "core.command_audit.enabled": {
    label: "Slash-command audit log enabled",
    description:
      "Record one row per Discord slash-command invocation (who, what, when, outcome) so operators can audit command usage from the WebUI. Raw command arguments are never recorded.",
    category: "core",
    type: "boolean",
  },
  "core.command_audit.retention_days": {
    label: "Slash-command audit retention (days)",
    description:
      "Days to keep slash-command audit rows before the cleanup job prunes them.",
    category: "core",
    type: "number",
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
      "Days to keep persisted command-metric buckets before MongoDB's TTL index prunes them.",
    category: "core",
    type: "number",
  },
};
