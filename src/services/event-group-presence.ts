/**
 * Who is connected to an event's voice channels right now (#1191).
 *
 * These are the people a host can assign: members currently in the event's
 * main channel or in any of its group channels. It is read from the gateway
 * cache (no REST call), so it is as fresh as the voice state events the bot
 * has received. RSVPs are not used: new events take no KoolBot RSVPs (#1175),
 * and being in the room is what matters for a split.
 *
 * Fails closed: when the guild is not in the cache the result says it could
 * not be read, and callers refuse to assign or randomise on it.
 */

import type { Client } from "discord.js";
import type { IEvent } from "../models/event.js";

export interface PresentMember {
  id: string;
  name: string;
  /** The voice channel they are in. */
  channelId: string;
}

export interface EventPresence {
  /** False when the voice state could not be read. */
  ok: boolean;
  /** Connected people (bots left out), by id, in channel order. */
  members: PresentMember[];
}

/** The voice channel ids of an event: the main one, then each group's. */
export function eventVoiceChannelIds(
  event: Pick<IEvent, "channelId" | "groups">,
): string[] {
  const ids: string[] = [];
  if (event.channelId) ids.push(event.channelId);
  for (const group of event.groups ?? []) {
    if (group.channelId && !ids.includes(group.channelId)) {
      ids.push(group.channelId);
    }
  }
  return ids;
}

export function readEventPresence(
  client: Client,
  event: Pick<IEvent, "guildId" | "channelId" | "groups">,
): EventPresence {
  const guild = client.guilds?.cache?.get(event.guildId);
  if (!guild || !guild.channels?.cache) return { ok: false, members: [] };
  const seen = new Set<string>();
  const members: PresentMember[] = [];
  for (const channelId of eventVoiceChannelIds(event)) {
    const channel = guild.channels.cache.get(channelId);
    if (!channel || !channel.isVoiceBased()) continue;
    for (const member of channel.members.values()) {
      if (member.user?.bot || seen.has(member.id)) continue;
      seen.add(member.id);
      members.push({
        id: member.id,
        name: member.displayName || member.user?.username || member.id,
        channelId,
      });
    }
  }
  return { ok: true, members };
}

/**
 * Display name of a member by id from the cache, for people who are assigned
 * but no longer connected. Falls back to the id; nothing is fetched.
 */
export function cachedMemberName(
  client: Client,
  guildId: string,
  userId: string,
): string {
  const member = client.guilds?.cache
    ?.get(guildId)
    ?.members?.cache?.get(userId);
  return member?.displayName || member?.user?.username || userId;
}
