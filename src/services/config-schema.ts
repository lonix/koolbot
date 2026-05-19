export interface ConfigSchema {
  // Voice Channel Management
  "voicechannels.enabled": boolean;
  "voicechannels.category.name": string;
  "voicechannels.lobby.name": string;
  "voicechannels.lobby.offlinename": string;
  "voicechannels.channel.prefix": string;
  "voicechannels.channel.suffix": string;
  "voicechannels.controlpanel.enabled": boolean;
  "voicechannels.ownership.grace_period_seconds": number;
  "voicechannels.presets.enabled": boolean;
  "voicechannels.presets.max_per_user": number;

  // Voice Activity Tracking
  "voicetracking.enabled": boolean;
  "voicetracking.stats.top.enabled": boolean; // Enable /voicestats top subcommand
  "voicetracking.stats.user.enabled": boolean; // Enable /voicestats user subcommand
  "voicetracking.seen.enabled": boolean;
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

  // Individual Features
  "ping.enabled": boolean;

  // Quote System Settings
  "quotes.enabled": boolean;
  "quotes.channel_id": string; // Channel ID for quote messages
  "quotes.delete_roles": string; // Comma-separated role IDs
  "quotes.max_length": number; // Maximum quote length
  "quotes.cooldown": number; // Cooldown in seconds between quote additions
  "quotes.cleanup_interval": number; // Cleanup interval in minutes (default: 5)
  "quotes.header_enabled": boolean; // Enable header post in quote channel
  "quotes.header_message_id": string; // Message ID of the header post
  "quotes.header_pin_enabled": boolean; // Pin the header post

  // Core Bot Logging (Discord) - only cleanup is wired up; other core.* keys
  // were declared but never read and have been removed. See issues #440/#443.
  "core.cleanup.channel_id": string;

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
  // Reaction Roles
  "reactionroles.enabled": boolean;
  "reactionroles.message_channel_id": string; // Channel for reaction role messages

  // Setup Wizard
  "wizard.enabled": boolean;

  // Notices System
  "notices.enabled": boolean;
  "notices.channel_id": string; // Channel ID for notice messages
  "notices.cleanup_interval": number; // Cleanup interval in minutes
  "notices.header_enabled": boolean; // Enable header post in notices channel
  "notices.header_message_id": string; // Message ID of the header post
  "notices.header_pin_enabled": boolean; // Pin the header post

  // Poll System
  "polls.enabled": boolean;
  "polls.default_duration_hours": number; // Default poll duration in hours (1-768)
  "polls.cooldown_days": number; // Minimum days between reusing same poll

  // Leaderboard Role Rewards
  "leaderboard_roles.enabled": boolean;
  "leaderboard_roles.period": string; // "week" | "month" | "alltime"
  "leaderboard_roles.update_cron": string; // Cron schedule for recalculation
  "leaderboard_roles.tiers": string; // Comma-separated "topN:roleId" pairs, e.g. "1:111,3:222,10:333"
  "leaderboard_roles.announcement_channel_id": string; // Optional channel ID for role-change announcements
}

export const defaultConfig: ConfigSchema = {
  // Voice Channel Management
  "voicechannels.enabled": false,
  "voicechannels.category.name": "Voice Channels",
  "voicechannels.lobby.name": "Lobby",
  "voicechannels.lobby.offlinename": "Offline Lobby",
  "voicechannels.channel.prefix": "🎮",
  "voicechannels.channel.suffix": "",
  "voicechannels.controlpanel.enabled": true,
  "voicechannels.ownership.grace_period_seconds": 30,
  "voicechannels.presets.enabled": false,
  "voicechannels.presets.max_per_user": 3,

  // Voice Activity Tracking
  "voicetracking.enabled": false,
  "voicetracking.stats.top.enabled": false,
  "voicetracking.stats.user.enabled": false,
  "voicetracking.seen.enabled": false,
  "voicetracking.excluded_channels": "",
  "voicetracking.announcements.enabled": false,
  "voicetracking.announcements.schedule": "0 16 * * 5", // Every Friday at 16:00
  "voicetracking.announcements.channel_id": "",

  // Voice Channel Cleanup
  "voicetracking.cleanup.enabled": false,
  "voicetracking.cleanup.schedule": "0 0 * * *", // Every day at midnight
  "voicetracking.cleanup.retention.detailed_sessions_days": 30,
  "voicetracking.cleanup.retention.monthly_summaries_months": 6,
  "voicetracking.cleanup.retention.yearly_summaries_years": 1,

  // Individual Features
  "ping.enabled": false,

  // Quote System Defaults
  "quotes.enabled": false,
  "quotes.channel_id": "",
  "quotes.delete_roles": "", // Empty means only admins can delete
  "quotes.max_length": 1000,
  "quotes.cooldown": 60,
  "quotes.cleanup_interval": 5, // Clean up unauthorized messages every 5 minutes
  "quotes.header_enabled": true, // Enable informational header post
  "quotes.header_message_id": "", // Stores header message ID
  "quotes.header_pin_enabled": true, // Pin header for easy access

  // Core Bot Logging (Discord) - only cleanup is wired up.
  "core.cleanup.channel_id": "",

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
  // Reaction Roles defaults
  "reactionroles.enabled": false,
  "reactionroles.message_channel_id": "",

  // Setup Wizard defaults
  "wizard.enabled": true,

  // Notices System defaults
  "notices.enabled": false,
  "notices.channel_id": "",
  "notices.cleanup_interval": 5, // Clean up unauthorized messages every 5 minutes
  "notices.header_enabled": true, // Enable informational header post
  "notices.header_message_id": "", // Stores header message ID
  "notices.header_pin_enabled": true, // Pin header for easy access

  // Poll System defaults
  "polls.enabled": false,
  "polls.default_duration_hours": 24, // Default 24 hours
  "polls.cooldown_days": 7, // Minimum 7 days between reusing same poll

  // Leaderboard Role Rewards defaults
  "leaderboard_roles.enabled": false,
  "leaderboard_roles.period": "alltime",
  "leaderboard_roles.update_cron": "0 0 * * 1", // Every Monday at 00:00
  "leaderboard_roles.tiers": "",
  "leaderboard_roles.announcement_channel_id": "",
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

export interface SettingMetadata {
  label: string;
  description: string;
  category: string;
  type: SettingType;
}

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
  ping: {
    title: "Ping",
    description: "The /ping latency check command.",
  },
  quotes: {
    title: "Quotes",
    description: "Collect and curate memorable quotes in a dedicated channel.",
  },
  core: {
    title: "Core Logging",
    description:
      "Discord-channel notifications for selected bot events. Most of this namespace was retired in #440 / #443; only the cleanup-job notification channel remains.",
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
  reactionroles: {
    title: "Reaction Roles",
    description:
      "Let users self-assign roles by reacting to a configured message.",
  },
  wizard: {
    title: "Setup Wizard",
    description:
      "The /setup slash command that walks new admins through feature configuration.",
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
  "voicechannels.category.name": {
    label: "Managed category name",
    description:
      "Name of the Discord category that contains managed voice channels.",
    category: "voicechannels",
    type: "string",
  },
  "voicechannels.lobby.name": {
    label: "Lobby channel display name",
    description:
      "Display name of the lobby channel users join to spawn a personal channel. Cosmetic; the bot sets this on the managed channel rather than looking it up by name.",
    category: "voicechannels",
    type: "string",
  },
  "voicechannels.lobby.offlinename": {
    label: "Lobby display name (bot offline)",
    description:
      "Display name shown on the lobby channel while the bot is offline. Cosmetic.",
    category: "voicechannels",
    type: "string",
  },
  "voicechannels.channel.prefix": {
    label: "Per-user channel name prefix",
    description: "Prefix prepended to dynamically created voice channel names.",
    category: "voicechannels",
    type: "string",
  },
  "voicechannels.channel.suffix": {
    label: "Per-user channel name suffix",
    description: "Suffix appended to dynamically created voice channel names.",
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
  "voicechannels.ownership.grace_period_seconds": {
    label: "Ownership transfer grace period (seconds)",
    description:
      "Seconds to wait before transferring ownership when the channel owner leaves.",
    category: "voicechannels",
    type: "number",
  },
  "voicechannels.presets.enabled": {
    label: "Per-user channel presets enabled",
    description:
      "Enable per-user channel presets (saved channel name + privacy).",
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
  "voicetracking.seen.enabled": {
    label: "/seen command enabled",
    description: "Enable last-seen tracking and the /seen command.",
    category: "voicetracking",
    type: "boolean",
  },
  "voicetracking.excluded_channels": {
    label: "Excluded channel IDs",
    description:
      "Comma-separated channel IDs to exclude from voice activity tracking.",
    category: "voicetracking",
    type: "channel_list",
  },
  "voicetracking.announcements.enabled": {
    label: "Scheduled voice-stats announcements enabled",
    description: "Enable scheduled voice-stats announcements.",
    category: "voicetracking",
    type: "boolean",
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
      "Days to keep detailed session rows before they are summarised away.",
    category: "voicetracking",
    type: "number",
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
  "quotes.cleanup_interval": {
    label: "Channel cleanup interval (minutes)",
    description:
      "Interval in minutes between sweeps for unauthorised messages in the quote channel.",
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

  // Core Bot Logging (Discord)
  "core.cleanup.channel_id": {
    label: "Cleanup-job notifications channel",
    description: "Channel ID for cleanup-job notifications.",
    category: "core",
    type: "channel",
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

  // Setup Wizard
  "wizard.enabled": {
    label: "/setup wizard command enabled",
    description: "Enable the /setup wizard command.",
    category: "wizard",
    type: "boolean",
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
  "notices.cleanup_interval": {
    label: "Channel cleanup interval (minutes)",
    description:
      "Interval in minutes between sweeps for unauthorised messages in the notices channel.",
    category: "notices",
    type: "number",
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

  // Leaderboard Role Rewards
  "leaderboard_roles.enabled": {
    label: "Leaderboard role rewards enabled",
    description:
      "Auto-assign Discord roles to users based on their voice-leaderboard position.",
    category: "leaderboard_roles",
    type: "boolean",
  },
  "leaderboard_roles.period": {
    label: "Leaderboard period",
    description:
      'Leaderboard period to evaluate: "week", "month", or "alltime".',
    category: "leaderboard_roles",
    type: "string",
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
};
