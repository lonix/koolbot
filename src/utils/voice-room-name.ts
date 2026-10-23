import { ChannelType } from "discord.js";

/**
 * The name to store for the channel an interaction ran in, or null. Only voice
 * and stage rooms are named: they are the channels that vanish, so the audit
 * page can still show which room it was (#1420). Read from the interaction's
 * cached channel; no Discord request is made.
 */
export function voiceRoomNameOf(
  channel: { type?: unknown; name?: unknown } | null | undefined,
): string | null {
  if (!channel) return null;
  if (
    channel.type !== ChannelType.GuildVoice &&
    channel.type !== ChannelType.GuildStageVoice
  ) {
    return null;
  }
  return typeof channel.name === "string" && channel.name
    ? channel.name.slice(0, 100)
    : null;
}
