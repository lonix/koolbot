/**
 * Server-side rules for the settings that the Web UI renders as pickers
 * (#1426): a timezone select, a colour input and an emoji picker.
 *
 * The pickers are a convenience, never the check: every value is validated
 * here again, so a crafted post gets the same refusal as a typo. The rules are
 * deliberately no stricter than what the pickers and the runtime accept, so
 * nothing the picker can produce is refused:
 *
 * - `timezone`: empty (the server zone) or a zone `Intl.DateTimeFormat` knows;
 * - `colour`: empty (Discord's default) or `#RRGGBB`;
 * - `emoji`: at most `EMOJI_FORMAT_MAX_CHARS` code points of text that can go in
 *   a Discord channel name, so no control characters and no custom emoji markup.
 *   It is not required to be an emoji: the server scan suggests prefixes such as
 *   `🎮 | `, which the picker cannot produce but the bot has always accepted.
 *
 * A value a picker cannot produce but that is already stored must keep saving
 * unchanged (an old custom timezone, a prefix that is not an emoji); that
 * exception is made by the caller, which knows the stored value.
 */

import { isValidTimezone } from "./timezone.js";

export type SettingFormat = "timezone" | "colour" | "emoji";

/** Longest emoji-format value, in code points (the event group marker limit). */
export const EMOJI_FORMAT_MAX_CHARS = 4;

/**
 * Discord's default role colour. A colour input cannot be empty, so the swatch
 * of a key set to "default" shows this; it is data about Discord, not styling.
 */
export const DEFAULT_COLOUR_SWATCH = "#99aab5";

const COLOUR = /^#?([0-9A-Fa-f]{6})$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
const CUSTOM_EMOJI = /<a?:\w+:\d+>/;

export type FormatResult =
  { ok: true; value: string } | { ok: false; reason: string };

/**
 * Validate `value` for `format`. Returns the value to store: timezone and
 * colour are trimmed and a colour is normalised to `#rrggbb`; an emoji value
 * is kept exactly as given.
 */
export function validateSettingFormat(
  format: SettingFormat,
  value: string,
): FormatResult {
  switch (format) {
    case "timezone": {
      const zone = value.trim();
      if (zone === "") return { ok: true, value: "" };
      const shown = zone.slice(0, 64);
      if (!isValidTimezone(zone)) {
        return {
          ok: false,
          reason: `unknown timezone "${shown}" (use an IANA zone such as Europe/Oslo, or leave empty for the server's)`,
        };
      }
      return { ok: true, value: zone };
    }
    case "colour": {
      const text = value.trim();
      if (text === "") return { ok: true, value: "" };
      const match = COLOUR.exec(text);
      if (!match) {
        return {
          ok: false,
          reason: "must be a colour like #A95F55, or empty for the default",
        };
      }
      return { ok: true, value: `#${match[1].toLowerCase()}` };
    }
    case "emoji": {
      if (Array.from(value).length > EMOJI_FORMAT_MAX_CHARS) {
        return {
          ok: false,
          reason: `at most ${EMOJI_FORMAT_MAX_CHARS} characters, for example one emoji`,
        };
      }
      if (CONTROL_CHARS.test(value)) {
        return { ok: false, reason: "control characters are not allowed" };
      }
      if (CUSTOM_EMOJI.test(value)) {
        return {
          ok: false,
          reason:
            "custom server emoji cannot be used in channel names, pick a standard emoji",
        };
      }
      return { ok: true, value };
    }
  }
}

/** True when `value` is valid for `format`. */
export function fitsSettingFormat(
  format: SettingFormat,
  value: string,
): boolean {
  return validateSettingFormat(format, value).ok;
}
