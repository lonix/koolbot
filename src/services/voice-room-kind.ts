import logger from "../utils/logger.js";
import { ManagedVoiceChannel } from "../models/managed-voice-channel.js";
import { Event } from "../models/event.js";
import type { VoiceRoomKind } from "../utils/voice-room-kinds.js";

/**
 * Classify a voice channel for the session record (#1420). Read while the room
 * still exists: a managed-channel row is deleted with its room and an event's
 * channel ids are cleared at cleanup, so this cannot be recovered afterwards.
 *
 * Returns undefined when the lookup fails, so an outage records "unknown"
 * rather than a wrong kind.
 */
export async function classifyVoiceRoom(
  guildId: string | undefined,
  channelId: string,
): Promise<VoiceRoomKind | undefined> {
  if (!guildId) return undefined;
  try {
    const managed = await ManagedVoiceChannel.findOne(
      { channelId },
      { kind: 1 },
    ).lean<{ kind?: string }>();
    if (managed) return managed.kind === "lobby" ? "lobby" : "dynamic";
    const event = await Event.exists({
      guildId,
      $or: [{ "groups.channelId": channelId }, { channelId }],
    });
    return event ? "event" : "permanent";
  } catch (error) {
    logger.warn("Could not classify voice room kind:", error);
    return undefined;
  }
}
