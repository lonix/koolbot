import {
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from "discord.js";

/** What replaces a channel name the caller is not allowed to see (#1153). */
export const HIDDEN_CHANNEL_LABEL = "a voice channel";

/**
 * Decide whether a channel's name may be shown to the member who ran the
 * command. A channel is nameable when it exists in the guild and the member
 * has `ViewChannel` on it (administrators always do).
 *
 * `whenUnresolved` covers a channel the bot cannot look up, either because it
 * was deleted (a finished dynamic room in the stats history) or because the
 * guild is not cached: `"hide"` fails closed, `"show"` keeps the stored name.
 */
export function visibleChannelName(
  interaction: ChatInputCommandInteraction,
  channelId: string | undefined,
  channelName: string,
  whenUnresolved: "show" | "hide",
): string {
  const channel =
    channelId && interaction.guild
      ? interaction.guild.channels.cache.get(channelId)
      : undefined;
  if (!channel) {
    return whenUnresolved === "show" ? channelName : HIDDEN_CHANNEL_LABEL;
  }
  const canView = channel
    .permissionsFor(interaction.user.id)
    ?.has(PermissionFlagsBits.ViewChannel);
  return canView ? channelName : HIDDEN_CHANNEL_LABEL;
}
