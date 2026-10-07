/**
 * Does a channel name look like one KoolBot would have generated? Generated
 * names are `<prefix> <name><suffix>`, so the prefix (and its space) must lead
 * and the suffix must trail (a live channel carries a trailing " 🔴" on top).
 * A suffix merely appearing mid-name is a foreign channel: adopting it would
 * make it deletable on first enable.
 *
 * Shared by the voice manager's one-time managed-set migration and by channel
 * claims (#1022), which uses it to block a naming change that would make
 * another bot's channels look like KoolBot's.
 */
export function matchesVoiceNamingPattern(
  name: string,
  prefix: string,
  suffix: string,
): boolean {
  if (!prefix && !suffix) return false;
  // The generator always puts a space after the prefix; "Gamer Bob's Room"
  // is not a "Game" room.
  if (prefix && !name.startsWith(`${prefix} `)) return false;
  if (suffix) {
    const liveSuffix = " 🔴";
    const base = name.endsWith(liveSuffix)
      ? name.slice(0, -liveSuffix.length)
      : name;
    if (!base.endsWith(suffix)) return false;
    if (prefix && base.length < prefix.length + suffix.length) return false;
  }
  return true;
}
