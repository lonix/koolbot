/**
 * Resolve emoji *shortcodes* (e.g. `:green_circle:`) to their Unicode
 * codepoints (🟢) for config values that feed Discord channel names
 * (issue #558).
 *
 * Discord only converts `:shortcode:` → emoji inside user-typed messages in
 * its own client; it does **not** convert shortcodes in channel names or in
 * names the bot sets via the API. So a prefix/lobby name typed as
 * `:green_circle:` would otherwise be stored and applied verbatim, producing
 * a channel literally named `:green_circle: Lobby` instead of `🟢 Lobby`.
 *
 * This module covers the common standard-Unicode shortcodes (status dots,
 * squares, and the handful of voice/gaming-flavoured emoji a server admin is
 * likely to reach for). It deliberately does **not** bundle the full emoji
 * set — unknown shortcodes are left untouched so nothing is silently blanked.
 *
 * LIMITATION: Discord **custom/server** emoji (`:myserveremoji:`) cannot
 * appear in channel names at all — they render as literal `:name:` text even
 * for Discord itself. This resolver only handles standard Unicode shortcodes;
 * an unrecognised `:name:` is passed through unchanged.
 */

/**
 * Static `shortcode` → Unicode map. Keys are the bare shortcode name without
 * the surrounding colons. Aliases (multiple names for the same glyph) are
 * intentional — admins reach for different spellings.
 */
export const EMOJI_SHORTCODES: Readonly<Record<string, string>> = {
  // Status dots — the primary motivation for this feature.
  red_circle: "🔴",
  orange_circle: "🟠",
  yellow_circle: "🟡",
  green_circle: "🟢",
  blue_circle: "🔵",
  purple_circle: "🟣",
  brown_circle: "🟤",
  black_circle: "⚫",
  white_circle: "⚪",

  // Squares.
  red_square: "🟥",
  orange_square: "🟧",
  yellow_square: "🟨",
  green_square: "🟩",
  blue_square: "🟦",
  purple_square: "🟪",
  brown_square: "🟫",
  black_large_square: "⬛",
  white_large_square: "⬜",
  black_medium_square: "◼️",
  white_medium_square: "◻️",
  black_small_square: "▪️",
  white_small_square: "▫️",

  // Diamonds / shapes.
  large_blue_diamond: "🔷",
  large_orange_diamond: "🔶",
  small_blue_diamond: "🔹",
  small_orange_diamond: "🔸",

  // Stars / sparkle.
  star: "⭐",
  star2: "🌟",
  sparkles: "✨",
  dizzy: "💫",

  // Voice / gaming flavour (matches the raw-Unicode defaults in code).
  video_game: "🎮",
  joystick: "🕹️",
  microphone: "🎤",
  studio_microphone: "🎙️",
  headphones: "🎧",
  musical_note: "🎵",
  notes: "🎶",
  speaker: "🔈",
  sound: "🔉",
  loud_sound: "🔊",
  mute: "🔇",
  bell: "🔔",
  no_bell: "🔕",

  // Locks / privacy.
  lock: "🔒",
  unlock: "🔓",
  key: "🔑",

  // Common decorative.
  fire: "🔥",
  zap: "⚡",
  high_voltage: "⚡",
  boom: "💥",
  rocket: "🚀",
  tada: "🎉",
  confetti_ball: "🎊",
  crown: "👑",
  trophy: "🏆",
  medal: "🏅",
  gem: "💎",
  heart: "❤️",
  green_heart: "💚",
  blue_heart: "💙",
  purple_heart: "💜",
  yellow_heart: "💛",
  orange_heart: "🧡",
  black_heart: "🖤",
  white_heart: "🤍",
  eyes: "👀",
  wave: "👋",
  robot: "🤖",
  ghost: "👻",
  skull: "💀",
  alien: "👽",
  gear: "⚙️",
  wrench: "🔧",
  hammer: "🔨",
  shield: "🛡️",
  crossed_swords: "⚔️",
  dart: "🎯",
  game_die: "🎲",
  hourglass: "⌛",
  hourglass_flowing_sand: "⏳",
  warning: "⚠️",
  no_entry: "⛔",
  no_entry_sign: "🚫",
  white_check_mark: "✅",
  heavy_check_mark: "✔️",
  x: "❌",
  question: "❓",
  exclamation: "❗",
  hash: "#️⃣",
  hourglass_done: "⏳",
} as const;

/**
 * Matches a `:shortcode:` token. The inner name is `[a-z0-9_+-]+` — the
 * character class used by standard emoji shortcode sets — so arbitrary text
 * between colons (URLs, timestamps like `12:34`, `::`) is not treated as a
 * candidate and is left exactly as typed.
 */
const SHORTCODE_RE = /:([a-z0-9_+-]+):/gi;

/**
 * Replace every recognised `:shortcode:` in `input` with its Unicode emoji.
 * Unknown shortcodes are returned untouched (no data loss). Lookup is
 * case-insensitive on the shortcode name. A non-string input is coerced to
 * a string so callers can pass raw config values directly.
 */
export function resolveEmojiShortcodes(input: unknown): string {
  const str = typeof input === "string" ? input : String(input ?? "");
  if (!str.includes(":")) return str;
  return str.replace(SHORTCODE_RE, (match, name: string) => {
    const unicode = EMOJI_SHORTCODES[name.toLowerCase()];
    return unicode ?? match;
  });
}

/**
 * Return the list of `:shortcode:` tokens in `input` that did **not** resolve
 * to a known emoji, in order of appearance (deduplicated). Lets a caller
 * surface a "these weren't recognised" hint — e.g. a typo'd `:greencircle:`
 * or a custom server emoji that can't appear in channel names — without
 * blocking the save. Returns an empty array when everything resolved (or
 * there were no shortcodes at all).
 */
export function findUnknownShortcodes(input: unknown): string[] {
  const str = typeof input === "string" ? input : String(input ?? "");
  if (!str.includes(":")) return [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const m of str.matchAll(SHORTCODE_RE)) {
    const token = m[0];
    const name = m[1].toLowerCase();
    if (name in EMOJI_SHORTCODES) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    unknown.push(token);
  }
  return unknown;
}
