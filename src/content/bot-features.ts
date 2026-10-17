/**
 * Display copy (emoji, label, one-line blurb) and the listing decision for the
 * auto-maintained "KoolBot Features & Commands" notice (#1007).
 *
 * Keyed by the feature prefix of a top-level `<feature>.enabled` config key.
 * The notice lists a feature only when it has an entry here with
 * `listed: true` (#1131). A feature with no entry stays hidden, and
 * `__tests__/config/bot-features-drift.test.ts` fails until every top-level
 * feature gate is classified, so the decision is made when a feature ships.
 *
 * `listed: true` means a member can act on the feature (a slash command, a
 * button or a Web UI page) and would not find it just by being in the server.
 * The notice also requires the feature's gate to be enabled. Hidden entries
 * keep their copy, so flipping one to listed is a one-line change.
 */

export interface BotFeatureInfo {
  emoji: string;
  label: string;
  description: string;
  /** Show this feature in the notice while its gate is enabled. */
  listed: boolean;
}

export const BOT_FEATURES: Readonly<Record<string, BotFeatureInfo>> = {
  voicechannels: {
    emoji: "🎤",
    label: "Voice Channels",
    description: "Dynamic voice channels — join the lobby to create your own",
    listed: true,
  },
  voicetracking: {
    emoji: "📊",
    label: "Voice Tracking",
    description: "Track your voice activity with `/voicestats`",
    listed: true,
  },
  // Not member-facing: passive, nothing a member acts on (owner, #1131).
  messagetracking: {
    emoji: "💬",
    label: "Message Tracking",
    description: "Text-message activity counts toward your stats",
    listed: false,
  },
  // Passive, like message tracking.
  reactiontracking: {
    emoji: "😀",
    label: "Reaction Tracking",
    description: "Reactions given and received count toward your stats",
    listed: false,
  },
  quotes: {
    emoji: "📝",
    label: "Quotes",
    description: 'Save memorable quotes with `/quote text:"..." author:@user`',
    listed: true,
  },
  // Owner decision (#1131): hidden, the poll posts are self-evident.
  polls: {
    emoji: "🗳️",
    label: "Polls",
    description: "Vote in server polls posted to the polls channel",
    listed: false,
  },
  events: {
    emoji: "📅",
    label: "Events",
    description:
      "Scheduled server events announced with a Discord event link via `/event`",
    listed: true,
  },
  lfg: {
    emoji: "🎮",
    label: "Looking for Group",
    description: "Find people to play with right now using `/lfg`",
    listed: true,
  },
  reminders: {
    emoji: "⏰",
    label: "Reminders",
    description: "Set personal reminders with `/remind`",
    listed: true,
  },
  tickets: {
    emoji: "🎫",
    label: "Support Tickets",
    description: "Get private help from staff with `/ticket open`",
    listed: true,
  },
  birthdays: {
    emoji: "🎂",
    label: "Birthdays",
    description:
      "Set your birthday on the Web UI and get a shout-out on the day",
    listed: true,
  },
  achievements: {
    emoji: "🏆",
    label: "Achievements",
    description: "Earn badges for activity milestones with `/achievements`",
    listed: true,
  },
  // Automatic posts.
  celebrations: {
    emoji: "🎉",
    label: "Celebrations",
    description: "Milestones and anniversaries are celebrated in chat",
    listed: false,
  },
  // Owner: only visible as the resulting posts and roles.
  leaderboard_roles: {
    emoji: "🥇",
    label: "Leaderboard Roles",
    description: "Top members on the leaderboard earn reward roles",
    listed: false,
  },
  // Read-only posts.
  digest: {
    emoji: "📰",
    label: "Digest",
    description: "Regular activity digest posted to the server",
    listed: false,
  },
  rewind: {
    emoji: "⏪",
    label: "Rewind",
    description: "Your personal year-in-review on the Web UI",
    listed: true,
  },
  // Owner decision (#1131): hidden, the role messages are self-evident.
  reactionroles: {
    emoji: "⭐",
    label: "Reaction Roles",
    description: "Pick your own roles from the server's role messages",
    listed: false,
  },
  // Read-only posts.
  announcements: {
    emoji: "📢",
    label: "Announcements",
    description: "Scheduled automated announcements",
    listed: false,
  },
  // The member is already reading it.
  notices: {
    emoji: "📌",
    label: "Notices",
    description: "Server information kept up to date in this channel",
    listed: false,
  },
  // Staff tools.
  moderation: {
    emoji: "🛡️",
    label: "Moderation",
    description: "Moderator tools such as `/warn` and `/modlog`",
    listed: false,
  },
  privacy: {
    emoji: "🔒",
    label: "Data Export",
    description: "Download the data KoolBot stores about you from the Web UI",
    listed: true,
  },
  // Not something a member acts on.
  ratelimit: {
    emoji: "🚦",
    label: "Rate Limiting",
    description: "Commands are rate-limited to keep things fair",
    listed: false,
  },
  // Automatic.
  welcome: {
    emoji: "👋",
    label: "Welcome",
    description: "New members get a welcome message when they join",
    listed: false,
  },
  // The accept button is obvious where it appears.
  rules: {
    emoji: "📜",
    label: "Server Rules",
    description: "Accept the server rules with a button to unlock the rest",
    listed: false,
  },
  namehistory: {
    emoji: "🪪",
    label: "Name History",
    description: "See what a member used to be called with `/aka @user`",
    listed: true,
  },
  // Owner decision (#1131, comment): show ping.
  ping: {
    emoji: "🏓",
    label: "Ping",
    description: "Check the bot's latency with `/ping`",
    listed: true,
  },
};
