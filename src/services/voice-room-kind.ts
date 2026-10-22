import type { Guild } from "discord.js";
import logger from "../utils/logger.js";
import { ManagedVoiceChannel } from "../models/managed-voice-channel.js";
import { Event } from "../models/event.js";
import type { VoiceRoomKind } from "../utils/voice-room-kinds.js";

/** The joined channel, as the tracker snapshots it at join. */
export interface RoomToClassify {
  guildId: string | undefined;
  guild?: Guild;
  channelId: string;
  channelName: string;
}

/**
 * Is this the join-to-create lobby? Asks the voice manager's own lobby
 * identity (configured ID, else name), loaded lazily because the manager
 * imports the tracker. A lobby that was configured or name-matched and reused
 * has no registry row, so the registry alone cannot tell.
 */
async function isLobbyRoom(room: RoomToClassify): Promise<boolean> {
  const { isLobbyByIdentity } = await import("./voice-channel-manager.js");
  return isLobbyByIdentity({
    id: room.channelId,
    name: room.channelName,
    guild: room.guild,
  });
}

/**
 * Classify a voice channel for the session record (#1420). Read while the room
 * still exists: a managed-channel row is deleted with its room and an event's
 * channel ids are cleared at cleanup, so this cannot be recovered afterwards.
 *
 * Returns undefined when the lookup fails, so an outage records "unknown"
 * rather than a wrong kind.
 */
export async function classifyVoiceRoom(
  room: RoomToClassify,
  isLobby: (room: RoomToClassify) => Promise<boolean> = isLobbyRoom,
): Promise<VoiceRoomKind | undefined> {
  const { guildId, channelId } = room;
  if (!guildId) return undefined;
  try {
    const managed = await ManagedVoiceChannel.findOne(
      { channelId },
      { kind: 1 },
    ).lean<{ kind?: string }>();
    if (managed) return managed.kind === "lobby" ? "lobby" : "dynamic";
    if (await isLobby(room)) return "lobby";
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
