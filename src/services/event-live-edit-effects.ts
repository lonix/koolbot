/**
 * What a live-edit row's follow-up may do in the real world (#1240): the leads
 * channel pass, the "Customise team" messages and the nickname tags. Built once
 * per request by the host routes (`createLiveEditDeps`) and handed to the
 * executor as `deps.effects`; the rows never import `EventService` or Discord.
 *
 * Every function decides from a fresh read of the event (it is told which event,
 * never what changed), so it is safe to repeat, and the scan repeats it anyway.
 */

import type { Client } from "discord.js";
import logger from "../utils/logger.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";
import { EventNicknameTags } from "./event-nickname-tags.js";
import type { MoveSkipReason } from "./event-member-moves.js";
import type {
  EmptyChannelOutcome,
  GroupChannelSyncOutcome,
  GroupRemoveResult,
  LiveEditEffects,
} from "./event-live-edit.js";

/**
 * Move everyone connected to one group's channel to the main channel, inside
 * the live edit's move lock, and say whether the channel is empty afterwards.
 * The host is not spared (the channel is going: they would be stranded as much
 * as anyone, the rule of the end teardown's pull-back). Who is still there is
 * read from the gateway cache minus the people Discord confirmed moving, since
 * the cache can lag a confirmed move by a moment; bots count as present (the
 * channel is only deleted when nothing is connected).
 */
async function emptyGroupChannelOf(
  client: Client,
  guildId: string,
  eventId: string,
  groupKey: string,
  channelId: string,
): Promise<EmptyChannelOutcome> {
  // Loaded on first use, like `EventService`: the mover pulls in the Discord
  // write client, which a live edit that never removes a group does not need.
  const { MOVE_SKIP_LABEL, moveEventMembersHoldingLock } =
    await import("./event-member-moves.js");
  const outcome = await moveEventMembersHoldingLock({
    client,
    guildId,
    eventId,
    excludeUserIds: [],
    // The bot's Move Members may be granted in the events category only: the
    // per-move checks decide.
    channelScopedPermissions: true,
    plan: ({ event, presence }) => {
      const group = (event.groups ?? []).find((g) => g.key === groupKey);
      if (!group || group.channelId !== channelId) {
        return { refuse: "The group changed, so nobody was moved." };
      }
      const inside = presence.members.filter((m) => m.channelId === channelId);
      if (inside.length === 0) return [];
      const main = event.channelId;
      if (!main) {
        return {
          refuse:
            "The event's main channel does not exist, so nobody was moved.",
        };
      }
      return inside.map((m) => ({
        userId: m.id,
        toChannelId: main,
        // Only out of THIS channel: somebody who walked elsewhere is left be.
        fromChannelId: channelId,
      }));
    },
  });
  if (outcome.status === "busy") {
    return { status: "failed", reason: "a move is already running" };
  }
  if (outcome.status === "refused") {
    return { status: "failed", reason: outcome.message };
  }
  const moved = outcome.report.moved;
  const channel = client.guilds?.cache
    ?.get(guildId)
    ?.channels?.cache?.get(channelId);
  const present =
    channel && channel.isVoiceBased() ? [...channel.members.keys()] : [];
  const remaining = present.filter((id) => !moved.includes(id));
  if (remaining.length === 0 && outcome.report.unconfirmed.length === 0) {
    return { status: "empty", moved: [...moved] };
  }
  const reasons = new Map<MoveSkipReason, number>();
  for (const skip of outcome.report.skipped) {
    // "Not connected", "elsewhere" and "moved on" mean they are not in it.
    if (
      skip.reason === "not-connected" ||
      skip.reason === "elsewhere" ||
      skip.reason === "moved-on" ||
      skip.reason === "already-there"
    ) {
      continue;
    }
    reasons.set(skip.reason, (reasons.get(skip.reason) ?? 0) + 1);
  }
  const parts = [...reasons.entries()].map(
    ([reason, n]) => `${n} ${MOVE_SKIP_LABEL[reason]}`,
  );
  if (outcome.report.unconfirmed.length > 0) {
    parts.push(
      `${outcome.report.unconfirmed.length} not confirmed by Discord (check Discord)`,
    );
  }
  const left = Math.max(remaining.length, outcome.report.unconfirmed.length, 1);
  return {
    status: "occupied",
    moved: [...moved],
    remaining: left,
    detail:
      parts.length > 0
        ? parts.join("; ")
        : "somebody is still connected, perhaps a bot",
  };
}

export function createLiveEditEffects(client: Client): LiveEditEffects {
  return {
    async syncLeadsAccess(guildId, eventId, revoked): Promise<void> {
      const { EventService } = await import("./event-service.js");
      await EventService.getInstance(client).syncLeadsAccess(
        guildId,
        eventId,
        revoked && revoked.length > 0
          ? (): readonly string[] => revoked
          : undefined,
      );
    },
    async syncGroupControls(eventId): Promise<void> {
      const { EventService } = await import("./event-service.js");
      await EventService.getInstance(client).syncGroupControls(eventId);
    },
    async syncGroupName(
      guildId,
      eventId,
      groupKey,
    ): Promise<GroupChannelSyncOutcome | null> {
      const { EventService } = await import("./event-service.js");
      const outcomes = await EventService.getInstance(client).syncGroupNames(
        eventId,
        guildId,
        groupKey,
      );
      return outcomes?.find((o) => o.groupKey === groupKey) ?? null;
    },
    async syncGroupUserLimit(
      guildId,
      eventId,
      groupKey,
    ): Promise<GroupChannelSyncOutcome | null> {
      const { EventService } = await import("./event-service.js");
      const outcomes = await EventService.getInstance(
        client,
      ).syncGroupUserLimits(eventId, guildId, groupKey);
      return outcomes?.find((o) => o.groupKey === groupKey) ?? null;
    },
    retagMembers(guildId, eventId, memberIds): void {
      // The one tag function, loaded on first use (the leader customiser's
      // background path: paced per member, then a sweep as the backstop).
      void import("./event-leader-customise.js")
        .then((m) =>
          m.createCustomiseDeps(client).retag(guildId, eventId, memberIds),
        )
        .catch((err: unknown) =>
          logger.error(
            `Event ${sanitizeForLog(eventId)}: the nickname update after a live edit failed:`,
            err,
          ),
        );
    },
    async createGroupChannels(
      guildId,
      eventId,
    ): Promise<{ failures: Array<{ key: string; reason: string }> } | null> {
      try {
        const { EventService } = await import("./event-service.js");
        const report = await EventService.getInstance(
          client,
        ).reconcileGroupChannels(eventId, guildId);
        return report
          ? {
              failures: report.failures.map((f) => ({
                key: f.key,
                reason: f.reason,
              })),
            }
          : null;
      } catch (err) {
        logger.error(
          `Event ${sanitizeForLog(eventId)}: creating the group channels after a live edit failed:`,
          err,
        );
        return null;
      }
    },
    async emptyGroupChannel(
      guildId,
      eventId,
      groupKey,
      channelId,
    ): Promise<EmptyChannelOutcome> {
      try {
        return await emptyGroupChannelOf(
          client,
          guildId,
          eventId,
          groupKey,
          channelId,
        );
      } catch (err) {
        logger.error(
          `Event ${sanitizeForLog(eventId)}: moving people out of a group channel failed:`,
          err,
        );
        return {
          status: "failed",
          reason: "the people in its channel could not be moved (see the log)",
        };
      }
    },
    async removeGroupChannel(
      guildId,
      eventId,
      groupKey,
      channelId,
      opts,
    ): Promise<GroupRemoveResult | null> {
      try {
        const { EventService } = await import("./event-service.js");
        return await EventService.getInstance(client).removeGroupChannel(
          eventId,
          guildId,
          { groupKey, channelId, ignore: opts.ignore, ending: opts.ending },
        );
      } catch (err) {
        logger.error(
          `Event ${sanitizeForLog(eventId)}: removing a group channel failed:`,
          err,
        );
        return { status: "failed", reason: "see the log" };
      }
    },
    async syncTags(guildId, eventId, mode): Promise<void> {
      try {
        const tags = EventNicknameTags.getInstance(client);
        if (mode === "sync") await tags.syncEvent(guildId, eventId);
        else await tags.restoreEvent(guildId, eventId);
        // The backstop: a restart in the middle, or a member inside the settle
        // window, converges through the sweep.
        tags.requestSweep(guildId);
      } catch (err) {
        logger.error(
          `Event ${sanitizeForLog(eventId)}: nickname tags (${mode}) after a live edit failed:`,
          err,
        );
      }
    },
  };
}
