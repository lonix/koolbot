import { escapeMarkdown, type MessageMentionOptions } from "discord.js";

/**
 * Client-level `allowedMentions` default (#1146).
 *
 * discord.js falls back to this for every send, reply, edit and webhook call
 * that does not carry its own `allowedMentions`. Without a default, Discord
 * resolves user, role and `@everyone` / `@here` mentions from any text the bot
 * echoes, including member-controlled text such as a nickname. A member called
 * `@everyone` could then make the bot ping the whole channel.
 *
 * `parse: []` means a plain message pings nobody. A message that is meant to
 * ping someone says so itself with {@link pingUsers} (or a role list), naming
 * exactly who may be pinged, so a nickname that contains `<@id>` can never
 * widen the audience. A call that sets `allowedMentions` replaces this default
 * outright (discord.js does not merge the two).
 *
 * `repliedUser: true` keeps `Message.reply` pinging its author; once Discord
 * receives any `allowed_mentions` object, `replied_user` otherwise defaults to
 * false.
 */
export const DEFAULT_ALLOWED_MENTIONS: MessageMentionOptions = {
  parse: [],
  repliedUser: true,
};

/** A message that must not ping anyone (the same as the client default). */
export const NO_MENTIONS: MessageMentionOptions = { parse: [] };

/**
 * Per-call `allowedMentions` that pings exactly these users and nobody else.
 * Pass the ids the message text is meant to mention, never ids taken from
 * member-controlled text.
 */
export function pingUsers(...userIds: string[]): MessageMentionOptions {
  return { users: [...new Set(userIds)] };
}

/**
 * Make a member-controlled name (display name, nickname, username, tag or a
 * channel name derived from one) safe to put in message content or an embed
 * body, so it renders as plain text:
 *
 * - `<` is escaped, which disarms `<@id>`, `<@&id>`, `<#id>`, `</cmd:id>` and
 *   `<:emoji:id>` as well as `<https://...>` auto-links;
 * - `[` and `]` are escaped, so a name cannot become a masked link;
 * - `>` and Markdown, including headings, lists and spoilers, are escaped.
 *
 * `@everyone` and `@here` get a zero-width space after the `@` as a second
 * line of defence: they stay readable, and they never ping because a plain
 * message carries `allowedMentions: { parse: [] }` anyway.
 *
 * Do not use this for button labels, select-menu options, channel names the
 * bot creates, or log lines: those are not rendered as Markdown and would show
 * the backslashes.
 */
export function escapeDisplayText(text: string): string {
  // Backslash, brackets, `<` and `>` first; the library pass must not
  // re-escape the backslashes added here.
  const escaped = escapeMarkdown(text.replace(/[\\[\]<>]/g, "\\$&"), {
    escape: false,
    heading: true,
    bulletedList: true,
    numberedList: true,
  });
  return escaped.replace(/@(?=everyone|here)/gi, "@\u200b");
}
