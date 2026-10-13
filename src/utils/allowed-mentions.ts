import type { MessageMentionOptions } from "discord.js";

/**
 * Client-level `allowedMentions` default (#1146).
 *
 * discord.js falls back to this for every send, reply, edit and webhook call
 * that does not carry its own `allowedMentions`. Without a default, Discord
 * resolves user, role and `@everyone` / `@here` mentions from any text the bot
 * echoes, including member-controlled text such as a nickname. A member called
 * `@everyone` could then make the bot ping the whole channel.
 *
 * `parse: ["users"]` is deliberate rather than `parse: []`: several existing
 * messages ping a single member through a plain `<@id>` and rely on the default
 * to do it (voice-channel control panel, waiting-room and live-channel notices,
 * the weekly voice recap). Users-only still removes the part that matters,
 * `@everyone`, `@here` and role mentions. A call that sets `allowedMentions`
 * replaces this default outright (discord.js does not merge the two), so every
 * existing per-call allow-list behaves exactly as before.
 *
 * `repliedUser: true` keeps `Message.reply` pinging its author; once Discord
 * receives any `allowed_mentions` object, `replied_user` otherwise defaults to
 * false.
 *
 * Anything that needs to ping a role or `@everyone` must say so itself, e.g.
 * `{ roles: [roleId] }`.
 */
export const DEFAULT_ALLOWED_MENTIONS: MessageMentionOptions = {
  parse: ["users"],
  repliedUser: true,
};
