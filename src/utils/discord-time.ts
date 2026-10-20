/**
 * The one place Discord timestamp markup is built (#1331, epic #1314).
 *
 * `<t:UNIX:style>` makes Discord render the instant in each reader's own
 * timezone and locale, so a message never carries a preformatted date string
 * (`docs/design/discord.md`, "Time"). Use this instead of `toLocaleString()`,
 * `toLocaleDateString()` or a hand-built `<t:...>`;
 * `__tests__/utils/discord-style-guard.test.ts` fails on the former.
 *
 * Styles: `t` short time, `T` long time, `d` short date, `D` long date,
 * `f` short date and time, `F` long date and time, `R` relative ("in 2 hours").
 * Only embed field values and descriptions (and message content) render the
 * markup, not embed titles or footers; use `setTimestamp()` for those.
 */
export type DiscordTimestampStyle = "t" | "T" | "d" | "D" | "f" | "F" | "R";

export function discordTimestamp(
  date: Date,
  style: DiscordTimestampStyle = "F",
): string {
  return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
}
