export interface ConfigSchema {
  // Voice Channel Management
  "voicechannels.enabled": boolean;
  "voicechannels.category.name": string;
  "voicechannels.lobby.name": string;
  "voicechannels.lobby.offlinename": string;
  "voicechannels.channel.prefix": string;
  "voicechannels.channel.suffix": string;

  // Voice Activity Tracking
  "voicetracking.enabled": boolean;
  "voicetracking.seen.enabled": boolean;
  "voicetracking.excluded_channels": string; // Comma-separated channel IDs
  "voicetracking.announcements.enabled": boolean;
  "voicetracking.announcements.schedule": string; // Cron schedule
  "voicetracking.announcements.channel": string;
  "voicetracking.admin_roles": string; // Comma-separated role names

  // Voice Channel Cleanup
  "voicetracking.cleanup.enabled": boolean;
  "voicetracking.cleanup.schedule": string; // Cron schedule for cleanup
  "voicetracking.cleanup.retention.detailed_sessions_days": number;
  "voicetracking.cleanup.retention.monthly_summaries_months": number;
  "voicetracking.cleanup.retention.yearly_summaries_years": number;

  // Individual Features
  "ping.enabled": boolean;
  "amikool.enabled": boolean;
  "amikool.role.name": string; // Role name required for amikool

  // Quote System Settings
  "quotes.enabled": boolean;
  "quotes.add_roles": string; // Comma-separated role IDs
  "quotes.delete_roles": string; // Comma-separated role IDs
  "quotes.max_length": number; // Maximum quote length
  "quotes.cooldown": number; // Cooldown in seconds between quote additions

  // Core Bot Logging (Discord) - Defaults to disabled
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
}

export const defaultConfig: ConfigSchema = {
  // Voice Channel Management
  "voicechannels.enabled": false,
  "voicechannels.category.name": "Voice Channels",
  "voicechannels.lobby.name": "Lobby",
  "voicechannels.lobby.offlinename": "Offline Lobby",
  "voicechannels.channel.prefix": "🎮",
  "voicechannels.channel.suffix": "",

  // Voice Activity Tracking
  "voicetracking.enabled": false,
  "voicetracking.seen.enabled": false,
  "voicetracking.excluded_channels": "",
  "voicetracking.announcements.enabled": false,
  "voicetracking.announcements.schedule": "0 16 * * 5", // Every Friday at 16:00
  "voicetracking.announcements.channel": "voice-stats",
  "voicetracking.admin_roles": "",

  // Voice Channel Cleanup
  "voicetracking.cleanup.enabled": false,
  "voicetracking.cleanup.schedule": "0 0 * * *", // Every day at midnight
  "voicetracking.cleanup.retention.detailed_sessions_days": 30,
  "voicetracking.cleanup.retention.monthly_summaries_months": 6,
  "voicetracking.cleanup.retention.yearly_summaries_years": 1,

  // Individual Features
  "ping.enabled": false,
  "amikool.enabled": false,
  "amikool.role.name": "",

  // Quote System Defaults
  "quotes.enabled": false,
  "quotes.add_roles": "", // Empty means all users can add
  "quotes.delete_roles": "", // Empty means only admins can delete
  "quotes.max_length": 1000,
  "quotes.cooldown": 60,

  // Core Bot Logging (Discord) - Defaults to disabled
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
};
