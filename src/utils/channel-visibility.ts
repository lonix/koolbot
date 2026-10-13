import {
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from "discord.js";

/** What replaces a channel name the caller is not allowed to see (#1153). */
export const HIDDEN_CHANNEL_LABEL = "a voice channel";

/**
 * Decide whether a channel's name may be shown to the member who ran the
 * command. A channel is nameable only when it exists in the guild and the
 * member has `ViewChannel` on it (administrators always do).
 *
 * Fails closed: a channel the bot cannot look up (deleted, e.g. a finished
 * dynamic room, or the guild is not cached) leaves nothing to prove the caller
 * could see it, so its name is hidden too.
 */
export function visibleChannelName(
  interaction: ChatInputCommandInteraction,
  channelId: string | undefined,
  channelName: string,
): string {
  const channel =
    channelId && interaction.guild
      ? interaction.guild.channels.cache.get(channelId)
      : undefined;
  if (!channel) {
    return HIDDEN_CHANNEL_LABEL;
  }
  const canView = channel
    .permissionsFor(interaction.user.id)
    ?.has(PermissionFlagsBits.ViewChannel);
  return canView ? channelName : HIDDEN_CHANNEL_LABEL;
}
