/**
 * Display metadata for every accolade (persistent badge).
 *
 * Logic for awarding each accolade lives in
 * `src/services/achievements-service.ts` keyed by the same id. Adding a
 * new accolade is a two-step change: add the entry here, then add a
 * matching `checkFunction` in the service. Forgetting the second step
 * is a TypeScript error — the service's logic record is keyed by the
 * union derived from this object.
 */

export const ACCOLADE_METADATA = {
  first_hour: {
    emoji: "🎉",
    name: "First Steps",
    description: "Spent your first hour in voice chat",
  },
  voice_veteran_100: {
    emoji: "🎖️",
    name: "Voice Veteran",
    description: "Reached 100 hours in voice chat",
  },
  voice_veteran_500: {
    emoji: "🏅",
    name: "Voice Elite",
    description: "Reached 500 hours in voice chat",
  },
  voice_veteran_1000: {
    emoji: "🏆",
    name: "Voice Master",
    description: "Reached 1000 hours in voice chat",
  },
  voice_legend_8765: {
    emoji: "👑",
    name: "Voice Legend",
    description: "Reached 8765 hours (1 year) in voice chat",
  },
  marathon_runner: {
    emoji: "🏃",
    name: "Marathon Runner",
    description: "Completed a 4+ hour voice session",
  },
  ultra_marathoner: {
    emoji: "🦸",
    name: "Ultra Marathoner",
    description: "Completed an 8+ hour voice session",
  },
  social_butterfly: {
    emoji: "🦋",
    name: "Social Butterfly",
    description: "Voiced with 10+ unique users",
  },
  connector: {
    emoji: "🤝",
    name: "Connector",
    description: "Voiced with 25+ unique users",
  },
  night_owl: {
    emoji: "🦉",
    name: "Night Owl",
    description: "Accumulated 50+ hours during late night (10 PM - 6 AM)",
  },
  early_bird: {
    emoji: "🐦",
    name: "Early Bird",
    description: "Accumulated 50+ hours during early morning (6 AM - 10 AM)",
  },
  weekend_warrior: {
    emoji: "🎮",
    name: "Weekend Warrior",
    description: "Accumulated 100+ hours during weekends",
  },
  weekday_warrior: {
    emoji: "💼",
    name: "Weekday Warrior",
    description: "Accumulated 100+ hours during weekdays",
  },
  consistent_week: {
    emoji: "🔥",
    name: "On a Roll",
    description: "Connected for 7 consecutive days (5+ min/day)",
  },
  consistent_fortnight: {
    emoji: "⚡",
    name: "Dedicated AF",
    description: "Connected for 14 consecutive days (5+ min/day)",
  },
  consistent_month: {
    emoji: "💀",
    name: "No-Lifer",
    description: "Connected for 30 consecutive days (5+ min/day)",
  },
  quotable: {
    emoji: "🗣️",
    name: "Quotable",
    description: "Been quoted for the first time",
  },
  quote_master: {
    emoji: "📝",
    name: "Quote Master",
    description: "Added 10 quotes to the collection",
  },
  quote_collector: {
    emoji: "📚",
    name: "Quote Collector",
    description: "Added 50 quotes to the collection",
  },
  quote_legend: {
    emoji: "🏆",
    name: "Quote Legend",
    description: "Added 100 quotes to the collection",
  },
  widely_quoted: {
    emoji: "⭐",
    name: "Widely Quoted",
    description: "Been quoted 25 times",
  },
  quote_icon: {
    emoji: "💫",
    name: "Quote Icon",
    description: "Been quoted 50 times",
  },
  viral_quote: {
    emoji: "🔥",
    name: "Viral Quote",
    description: "Have a quote with 10+ likes",
  },
  // Engagement accolades for the now-tracked text/reaction/poll signals.
  // Each is gated behind its capture key (see ACCOLADE_ENABLED_KEYS in
  // achievements-service.ts) so it stays dark while capture is off.
  chatterbox: {
    emoji: "🗨️",
    name: "Chatterbox",
    description: "Sent 1,000 messages",
  },
  reactor: {
    emoji: "👍",
    name: "Reactor",
    description: "Gave 500 reactions",
  },
  poll_regular: {
    emoji: "🗳️",
    name: "Poll Regular",
    description: "Cast 25 poll votes",
  },
} as const;

export type AccoladeType = keyof typeof ACCOLADE_METADATA;
