/**
 * Server-side rules for the settings that the Web UI renders as pickers
 * (#1426): a timezone select, a colour input and an emoji grid beside the text
 * box of a channel name prefix or suffix.
 *
 * The pickers are a convenience, never the check: every value is validated
 * here again, so a crafted post gets the same refusal as a typo. The rules are
 * deliberately no stricter than what the pickers and the runtime accept, so
 * nothing the picker can produce is refused:
 *
 * - `timezone`: empty (the server zone) or a zone `Intl.DateTimeFormat` knows;
 * - `colour`: empty (Discord's default) or `#RRGGBB`;
 * - `affix`: free text for a channel name prefix or suffix (#1435: the owner
 *   decided these are not emoji-only, so `Looking for group: ` is fine), at
 *   most `CHANNEL_AFFIX_MAX_CHARS` code points, with no control characters and
 *   no custom emoji markup, neither of which can go in a Discord channel name.
 *   The emoji grid beside the box is only a convenience;
 * - `reaction_role_message` (#1433): empty ("link the channel instead") or the
 *   id of a message. This file only checks the shape. Whether the id is one of
 *   the bot's own reaction-role messages needs the database, so
 *   `coerceConfigValue` checks that against a set its caller loads.
 *
 * A value a picker cannot produce but that is already stored must keep saving
 * unchanged (an old custom timezone, a prefix that is not an emoji); that
 * exception is made by the caller, which knows the stored value.
 */

import { isValidTimezone } from "./timezone.js";

export type SettingFormat =
  "timezone" | "colour" | "affix" | "reaction_role_message";

/**
 * Longest channel name prefix or suffix, in code points.
 *
 * Why 32: the room name is `<prefix> <display name><suffix>` and Discord caps a
 * channel name at 100 characters, while a member's display name (nickname,
 * global name or username) is at most 32. 32 + 1 + 32 + 32 = 97, so even a full
 * length prefix, a full length name and a full length suffix still fit, with
 * 3 to spare. Voice room creation does not trim the name (only a reserved-name
 * collision does), so anything longer could make the create call fail for a
 * member with a long name. Event channel names are cut to 100 anyway.
 */
export const CHANNEL_AFFIX_MAX_CHARS = 32;

/**
 * Discord's default role colour. A colour input cannot be empty, so the swatch
 * of a key set to "default" shows this; it is data about Discord, not styling.
 */
export const DEFAULT_COLOUR_SWATCH = "#99aab5";

const COLOUR = /^#?([0-9A-Fa-f]{6})$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
const CUSTOM_EMOJI = /<a?:\w+:\d+>/;
const MESSAGE_ID = /^\d{17,20}$/;

export type FormatResult =
  { ok: true; value: string } | { ok: false; reason: string };

/**
 * Validate `value` for `format`. Returns the value to store: timezone and
 * colour are trimmed and a colour is normalised to `#rrggbb`; an affix
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
    case "affix": {
      if (Array.from(value).length > CHANNEL_AFFIX_MAX_CHARS) {
        return {
          ok: false,
          reason: `at most ${CHANNEL_AFFIX_MAX_CHARS} characters, so the whole channel name fits Discord's 100`,
        };
      }
      if (CONTROL_CHARS.test(value)) {
        return { ok: false, reason: "control characters are not allowed" };
      }
      if (hasCustomEmojiMarkup(value)) {
        return {
          ok: false,
          reason:
            "custom server emoji cannot be used in channel names, pick a standard emoji",
        };
      }
      return { ok: true, value };
    }
    case "reaction_role_message": {
      const id = value.trim();
      if (id === "") return { ok: true, value: "" };
      if (!MESSAGE_ID.test(id)) {
        return {
          ok: false,
          reason:
            "pick one of the reaction-role messages, or leave empty to link the channel",
        };
      }
      return { ok: true, value: id };
    }
  }
}

/**
 * True when `value` holds custom Discord emoji markup (`<:name:id>`). Shortcode
 * resolution turns the `:name:` inside it into a Unicode emoji, which would
 * leave text that no longer matches, so the write boundary checks the value as
 * submitted too.
 */
export function hasCustomEmojiMarkup(value: string): boolean {
  return CUSTOM_EMOJI.test(value);
}

/** True when `value` is valid for `format`. */
export function fitsSettingFormat(
  format: SettingFormat,
  value: string,
): boolean {
  return validateSettingFormat(format, value).ok;
}
