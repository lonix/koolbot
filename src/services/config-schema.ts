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

  // Individual Features
  "ping.enabled": boolean;
  "amikool.enabled": boolean;
  "amikool.role.name": string; // Role name required for amikool
  "plexprice.enabled": boolean;

  // Quote System Settings
  "quotes.enabled": boolean;
  "quotes.add_roles": string; // Comma-separated role IDs
  "quotes.delete_roles": string; // Comma-separated role IDs
  "quotes.max_length": number; // Maximum quote length
  "quotes.cooldown": number; // Cooldown in seconds between quote additions
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

  // Individual Features
  "ping.enabled": false,
  "amikool.enabled": false,
  "amikool.role.name": "",
  "plexprice.enabled": false,

  // Quote System Defaults
  "quotes.enabled": false,
  "quotes.add_roles": "", // Empty means all users can add
  "quotes.delete_roles": "", // Empty means only admins can delete
  "quotes.max_length": 1000,
  "quotes.cooldown": 60,
};
