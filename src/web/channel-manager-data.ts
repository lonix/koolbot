/**
 * Reads for the Channel Manager (#1065): the live guild as a flat list of
 * channel views, the bot's Manage Channels permission, and the stores that say
 * which channels KoolBot manages itself.
 */

import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type GuildBasedChannel,
} from "discord.js";
import { readEffectiveConfig } from "../services/server-scan-service.js";
import { ConfigService } from "../services/config-service.js";
import {
  isNewChannelTriggerName,
  resolveLobbyChannelName,
  resolveOfflineLobbyNames,
  VoiceChannelManager,
} from "../services/voice-channel-manager.js";
import { ManagedVoiceChannel } from "../models/managed-voice-channel.js";
import { VoiceChannelOwnership } from "../models/voice-channel-ownership.js";
import { Ticket } from "../models/ticket.js";
import { Event } from "../models/event.js";
import { LfgPost } from "../models/lfg-post.js";
import { ReactionRoleConfig } from "../models/reaction-role-config.js";
import { PollSchedule } from "../models/poll-schedule.js";
import { ScheduledAnnouncement } from "../models/scheduled-announcement.js";
import {
  buildProtectionMap,
  CHANNEL_LIMITS,
  type ChannelKind,
  type ManagedChannelView,
} from "./channel-manager.js";

function kindOf(type: ChannelType): ChannelKind {
  switch (type) {
    case ChannelType.GuildText:
      return "text";
    case ChannelType.GuildVoice:
      return "voice";
    case ChannelType.GuildCategory:
      return "category";
    default:
      return "other";
  }
}

export function viewOf(c: GuildBasedChannel): ManagedChannelView {
  const kind = kindOf(c.type);
  return {
    id: c.id,
    name: c.name,
    kind,
    typeLabel: kind === "other" ? (ChannelType[c.type] ?? "Other") : kind,
    parentId: "parentId" in c ? (c.parentId ?? null) : null,
    position: "rawPosition" in c ? (c.rawPosition ?? 0) : 0,
    topic: "topic" in c && typeof c.topic === "string" ? c.topic : null,
    userLimit:
      "userLimit" in c && typeof c.userLimit === "number" ? c.userLimit : null,
    bitrate: "bitrate" in c && typeof c.bitrate === "number" ? c.bitrate : null,
  };
}

/** The server's channels, threads left out (they count toward no limit here). */
export async function fetchChannelViews(
  guild: Guild,
): Promise<ManagedChannelView[]> {
  const fetched = await guild.channels.fetch();
  return [...fetched.values()].flatMap((c) =>
    c && !c.isThread() ? [viewOf(c)] : [],
  );
}

/** Highest bitrate this server's boost level allows, in bits per second. */
export function maxBitrateOf(guild: Guild): number {
  const max = (guild as { maximumBitrate?: unknown }).maximumBitrate;
  return typeof max === "number" && max >= CHANNEL_LIMITS.bitrateMin
    ? max
    : CHANNEL_LIMITS.bitrateDefaultMax;
}

/** Whether the bot holds Manage Channels server-wide. */
export async function botCanManageChannels(guild: Guild): Promise<boolean> {
  try {
    const me = guild.members.me ?? (await guild.members.fetchMe());
    return me.permissions.has(PermissionFlagsBits.ManageChannels);
  } catch {
    return false;
  }
}

/**
 * Channel id -> why KoolBot manages it. Throws when any source can't be read,
 * so a delete fails closed instead of going ahead on a partial picture.
 */
export async function loadProtection(
  guild: Guild,
  channels: readonly ManagedChannelView[],
): Promise<Map<string, string[]>> {
  const guildId = guild.id;
  // What the voice service holds in memory (rooms, waiting rooms, writes that
  // failed and are queued for retry). Throws if the service isn't there, so a
  // delete fails closed.
  const voiceInMemory = VoiceChannelManager.getInstance(
    guild.client,
  ).getInMemoryManagedChannels();
  const [
    config,
    managedVoice,
    owned,
    tickets,
    events,
    lfg,
    reactionRoles,
    polls,
    announcements,
    lobbyNames,
  ] = await Promise.all([
    readEffectiveConfig(),
    ManagedVoiceChannel.find({ guildId }).lean(),
    VoiceChannelOwnership.find({ guildId }).lean(),
    Ticket.find({ guildId }).select("channelId").lean(),
    Event.find({ guildId, state: { $in: ["scheduled", "active"] } }).lean(),
    LfgPost.find({
      guildId,
      state: { $in: ["creating", "open"] },
    }).lean(),
    // Archived mappings no longer own their channel.
    ReactionRoleConfig.find({ guildId, archivedAt: null }).lean(),
    PollSchedule.find({ guildId }).lean(),
    ScheduledAnnouncement.find({ guildId }).lean(),
    effectiveLobbyNames(),
  ]);
  return buildProtectionMap({
    config,
    managedVoice: managedVoice.map((r) => ({
      channelId: r.channelId,
      kind: r.kind,
    })),
    ownedVoiceIds: owned.map((r) => r.channelId),
    tickets: tickets.map((t) => ({
      id: String(t._id),
      channelId: t.channelId,
    })),
    events: events.map((e) => ({
      id: String(e._id),
      channelId: e.channelId ?? null,
      categoryId: e.categoryId ?? "",
      announcementChannelId: e.announcementChannelId ?? null,
    })),
    lfg: lfg.map((l) => ({
      voiceChannelId: l.voiceChannelId ?? null,
      channelId: l.channelId,
    })),
    reactionRoles: reactionRoles.map((r) => ({
      id: String(r._id),
      channelId: r.channelId ?? null,
      categoryId: r.categoryId ?? null,
    })),
    pollSchedules: polls.map((p) => ({
      id: String(p._id),
      channelId: p.channelId,
    })),
    announcements: announcements.map((a) => ({
      id: String(a._id),
      channelId: a.channelId,
    })),
    discord: [
      {
        label: "the server's rules channel (Discord)",
        id: guild.rulesChannelId,
      },
      {
        label: "the server's community updates channel (Discord)",
        id: guild.publicUpdatesChannelId,
      },
      {
        label: "the server's system messages channel (Discord)",
        id: guild.systemChannelId,
      },
    ].map((d) => ({ label: d.label, channelId: d.id ?? null })),
    lobbyNames,
    isTriggerName: isNewChannelTriggerName,
    voiceInMemory,
    channels,
  });
}

/**
 * The names the voice service may treat as the lobby or offline lobby, from
 * its own resolution (quotes removed, legacy keys applied). Strict reads, so a
 * database failure rejects instead of reading as "not set".
 */
async function effectiveLobbyNames(): Promise<string[]> {
  const config = ConfigService.getInstance();
  const read = (key: string, defaultValue?: string): Promise<string> =>
    config.getStringStrict(key, defaultValue);
  return [
    await resolveLobbyChannelName(read),
    ...(await resolveOfflineLobbyNames(read)),
  ];
}
