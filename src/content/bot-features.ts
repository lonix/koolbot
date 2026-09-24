/**
 * Display copy (emoji, label, one-line blurb) for the feature list in the
 * auto-maintained "KoolBot Features & Commands" notice (#1007).
 *
 * Keyed by the feature prefix of a top-level `<feature>.enabled` config key.
 * This table only decorates the list: which features appear is derived from
 * `defaultConfig`, so a feature shipped without an entry here still shows up
 * (with a generic emoji, a label built from its prefix and the key's Settings
 * description). Add an entry to give a new feature nicer copy.
 */

export interface BotFeatureInfo {
  emoji: string;
  label: string;
  description: string;
}

export const BOT_FEATURES: Readonly<Record<string, BotFeatureInfo>> = {
  voicechannels: {
    emoji: "🎤",
    label: "Voice Channels",
    description: "Dynamic voice channels — join the lobby to create your own",
  },
  voicetracking: {
    emoji: "📊",
    label: "Voice Tracking",
    description: "Track your voice activity with `/voicestats`",
  },
  messagetracking: {
    emoji: "💬",
    label: "Message Tracking",
    description: "Text-message activity counts toward your stats",
  },
  reactiontracking: {
    emoji: "😀",
    label: "Reaction Tracking",
    description: "Reactions given and received count toward your stats",
  },
  quotes: {
    emoji: "📝",
    label: "Quotes",
    description: 'Save memorable quotes with `/quote text:"..." author:@user`',
  },
  polls: {
    emoji: "🗳️",
    label: "Polls",
    description: "Vote in server polls posted to the polls channel",
  },
  events: {
    emoji: "📅",
    label: "Events",
    description: "Scheduled server events with RSVPs via `/event`",
  },
  lfg: {
    emoji: "🎮",
    label: "Looking for Group",
    description: "Find people to play with right now using `/lfg`",
  },
  reminders: {
    emoji: "⏰",
    label: "Reminders",
    description: "Set personal reminders with `/remind`",
  },
  birthdays: {
    emoji: "🎂",
    label: "Birthdays",
    description:
      "Set your birthday on the Web UI and get a shout-out on the day",
  },
  achievements: {
    emoji: "🏆",
    label: "Achievements",
    description: "Earn badges for activity milestones with `/achievements`",
  },
  celebrations: {
    emoji: "🎉",
    label: "Celebrations",
    description: "Milestones and anniversaries are celebrated in chat",
  },
  leaderboard_roles: {
    emoji: "🥇",
    label: "Leaderboard Roles",
    description: "Top members on the leaderboard earn reward roles",
  },
  digest: {
    emoji: "📰",
    label: "Digest",
    description: "Regular activity digest posted to the server",
  },
  rewind: {
    emoji: "⏪",
    label: "Rewind",
    description: "Your personal year-in-review on the Web UI",
  },
  reactionroles: {
    emoji: "⭐",
    label: "Reaction Roles",
    description: "Pick your own roles from the server's role messages",
  },
  announcements: {
    emoji: "📢",
    label: "Announcements",
    description: "Scheduled automated announcements",
  },
  notices: {
    emoji: "📌",
    label: "Notices",
    description: "Server information kept up to date in this channel",
  },
  moderation: {
    emoji: "🛡️",
    label: "Moderation",
    description: "Moderator tools such as `/warn` and `/modlog`",
  },
  privacy: {
    emoji: "🔒",
    label: "Data Export",
    description: "Download the data KoolBot stores about you from the Web UI",
  },
  ratelimit: {
    emoji: "🚦",
    label: "Rate Limiting",
    description: "Commands are rate-limited to keep things fair",
  },
  ping: {
    emoji: "🏓",
    label: "Ping",
    description: "Check the bot's latency with `/ping`",
  },
};
