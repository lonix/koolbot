export interface ConfigSchema {
  // Voice Channel Management
  "voice_channel.enabled": boolean;
  "voice_channel.category_name": string;
  "voice_channel.lobby_channel_name": string;
  "voice_channel.lobby_channel_name_offline": string;
  "voice_channel.channel_prefix": string;
  "voice_channel.suffix": string;

  // Voice Channel Tracking
  "tracking.enabled": boolean;
  "tracking.seen_enabled": boolean;
  "tracking.excluded_channels": string; // Comma-separated channel IDs
  "tracking.weekly_announcement_enabled": boolean;
  "tracking.weekly_announcement_schedule": string; // Cron schedule
  "tracking.weekly_announcement_channel": string;

  // Bot Features
  "features.ping_enabled": boolean;
  "features.amikool_enabled": boolean;
  "features.plex_checker_enabled": boolean;

  // Quote System Settings
  "quotes.enabled": boolean;
  "quotes.add_roles": string; // Comma-separated role IDs
  "quotes.delete_roles": string; // Comma-separated role IDs
  "quotes.max_length": number; // Maximum quote length
  "quotes.cooldown": number; // Cooldown in seconds between quote additions
}

export const defaultConfig: ConfigSchema = {
  // Voice Channel Management
  "voice_channel.enabled": false,
  "voice_channel.category_name": "Voice Channels",
  "voice_channel.lobby_channel_name": "Lobby",
  "voice_channel.lobby_channel_name_offline": "Offline Lobby",
  "voice_channel.channel_prefix": "🎮",
  "voice_channel.suffix": "",

  // Voice Channel Tracking
  "tracking.enabled": false,
  "tracking.seen_enabled": false,
  "tracking.excluded_channels": "",
  "tracking.weekly_announcement_enabled": false,
  "tracking.weekly_announcement_schedule": "0 16 * * 5", // Every Friday at 16:00
  "tracking.weekly_announcement_channel": "voice-stats",

  // Bot Features
  "features.ping_enabled": false,
  "features.amikool_enabled": false,
  "features.plex_checker_enabled": false,

  // Quote System Defaults
  "quotes.enabled": false,
  "quotes.add_roles": "", // Empty means all users can add
  "quotes.delete_roles": "", // Empty means only admins can delete
  "quotes.max_length": 1000,
  "quotes.cooldown": 60,
};
