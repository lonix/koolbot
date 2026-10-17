import {
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type GuildBasedChannel,
} from "discord.js";

/** What replaces a channel name the caller is not allowed to see (#1153). */
export const HIDDEN_CHANNEL_LABEL = "a voice channel";

/**
 * Whether `@everyone` can view the channel right now. Fails closed: a channel
 * or guild that cannot be inspected counts as not public (#1162).
 */
export function isPublicToEveryone(
  channel: GuildBasedChannel | null | undefined,
): boolean {
  try {
    const everyone = channel?.guild?.roles?.everyone;
    if (!channel || !everyone) return false;
    return (
      channel.permissionsFor(everyone)?.has(PermissionFlagsBits.ViewChannel) ===
      true
    );
  } catch {
    return false;
  }
}

/** What `/voicestats` stored with a session, for naming a room that is gone. */
export interface StoredChannelInfo {
  name?: string;
  everyoneCanView?: boolean;
}

/**
 * Decide whether a channel's name may be shown to the member who ran the
 * command. A channel is nameable only when it exists in the guild and the
 * member has `ViewChannel` on it (administrators always do).
 *
 * Fails closed: a channel the bot cannot look up (deleted, e.g. a finished
 * dynamic room, or the guild is not cached) leaves nothing to prove the caller
 * could see it, so its name is hidden too. The one exception (#1162): a
 * deleted room whose stored session says `@everyone` could view it is named
 * with the name stored at that time. Private, unmarked and uncached-guild
 * cases stay hidden.
 */
export function visibleChannelName(
  interaction: ChatInputCommandInteraction,
  channelId: string | undefined,
  stored?: StoredChannelInfo,
): string {
  const channel =
    channelId && interaction.guild
      ? interaction.guild.channels.cache.get(channelId)
      : undefined;
  if (!channel) {
    // `interaction.guild` is required so an uncached guild never reaches the
    // stored name: "missing" then cannot be told apart from "not loaded".
    return interaction.guild && stored?.everyoneCanView === true && stored.name
      ? stored.name
      : HIDDEN_CHANNEL_LABEL;
  }
  const canView = channel
    .permissionsFor(interaction.user.id)
    ?.has(PermissionFlagsBits.ViewChannel);
  // The channel's current name, not the one stored with the session: a private
  // room renamed and later made visible must not leak its former name.
  return canView ? channel.name : HIDDEN_CHANNEL_LABEL;
}
