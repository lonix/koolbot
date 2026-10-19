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
  EmptyChannelsOutcome,
  GroupChannelSyncOutcome,
  GroupRemoveResult,
  GroupsOffResult,
  LiveEditEffects,
} from "./event-live-edit.js";

/**
 * Move everyone connected to one group's channel to the main channel, inside
 * the live edit's move lock, and say whether the channel is empty afterwards.
 * The host is not spared (the channel is going: they would be stranded as much
 * as anyone, the rule of the end teardown's pull-back). Who is still there is
 * read from the gateway cache after a short wait (at most `MOVE_SETTLE_MS`) for
 * it to show the confirmed moves, which it can lag by a moment; everybody the
 * cache then still shows counts as present, so a person who moved back in is
 * never taken for one who left (the host saves again). Bots count as present.
 */
export const MOVE_SETTLE_MS = 1500;
const MOVE_SETTLE_STEP_MS = 100;

/** What one run over several group channels did (see `emptyGroupChannelsOf`). */
type EmptyRun =
  | { status: "failed"; reason: string }
  | {
      status: "done";
      moved: string[];
      /** Per channel id: how many people the cache still shows in it. */
      present: Map<string, number>;
      unconfirmed: number;
      /** Why people could not be moved, counted for the whole run. */
      detail: string;
    };

/**
 * ONE mover run over every channel in `targets`: everybody connected to any of
 * them goes to the main channel. One run means one attempt budget
 * (`MAX_MOVES_PER_RUN`) and one pacing for the whole call: a switch-off over
 * many groups cannot multiply the bound that keeps the request short. People the
 * budget did not reach stay where they are and are reported by channel; a
 * re-save moves the next batch.
 */
async function emptyGroupChannelsOf(
  client: Client,
  guildId: string,
  eventId: string,
  targets: ReadonlyArray<{ groupKey: string; channelId: string }>,
  ending: () => boolean,
): Promise<EmptyRun> {
  // Loaded on first use, like `EventService`: the mover pulls in the Discord
  // write client, which a live edit that never removes a group does not need.
  const { MOVE_SKIP_LABEL, moveEventMembersHoldingLock } =
    await import("./event-member-moves.js");
  const channelIds = new Set(targets.map((t) => t.channelId));
  const outcome = await moveEventMembersHoldingLock({
    client,
    guildId,
    eventId,
    excludeUserIds: [],
    // The bot's Move Members may be granted in the events category only: the
    // per-move checks decide.
    channelScopedPermissions: true,
    plan: ({ event, presence }) => {
      for (const t of targets) {
        const group = (event.groups ?? []).find((g) => g.key === t.groupKey);
        if (!group || group.channelId !== t.channelId) {
          return { refuse: "The group changed, so nobody was moved." };
        }
      }
      const inside = presence.members.filter((m) =>
        channelIds.has(m.channelId ?? ""),
      );
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
        fromChannelId: m.channelId as string,
        // Asked right before each request: the batch stops once an end or
        // cancel holds the event.
        skipIf: ending,
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
  const channelsOf = (): Array<{ id: string; members: string[] }> =>
    targets.flatMap((t) => {
      const channel = client.guilds?.cache
        ?.get(guildId)
        ?.channels?.cache?.get(t.channelId);
      return channel && channel.isVoiceBased()
        ? [{ id: t.channelId, members: [...channel.members.keys()] }]
        : [{ id: t.channelId, members: [] }];
    });
  // Give the gateway a moment to show the moves Discord confirmed.
  for (
    let waited = 0;
    waited < MOVE_SETTLE_MS &&
    channelsOf().some((c) => c.members.some((id) => moved.includes(id)));
    waited += MOVE_SETTLE_STEP_MS
  ) {
    await new Promise((resolve) => setTimeout(resolve, MOVE_SETTLE_STEP_MS));
  }
  // Everybody the cache then still shows counts as present, so a person who
  // moved back in is never taken for one who left (the host saves again).
  const present = new Map(channelsOf().map((c) => [c.id, c.members.length]));
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
  const unconfirmed = outcome.report.unconfirmed.length;
  if (unconfirmed > 0) {
    parts.push(`${unconfirmed} not confirmed by Discord (check Discord)`);
  }
  return {
    status: "done",
    moved: [...moved],
    present,
    unconfirmed,
    detail:
      parts.length > 0
        ? parts.join("; ")
        : "somebody is still connected, perhaps a bot",
  };
}

async function emptyGroupChannelOf(
  client: Client,
  guildId: string,
  eventId: string,
  groupKey: string,
  channelId: string,
  ending: () => boolean,
): Promise<EmptyChannelOutcome> {
  const run = await emptyGroupChannelsOf(
    client,
    guildId,
    eventId,
    [{ groupKey, channelId }],
    ending,
  );
  if (run.status === "failed") return run;
  const remaining = run.present.get(channelId) ?? 0;
  if (remaining === 0 && run.unconfirmed === 0) {
    return { status: "empty", moved: run.moved };
  }
  return {
    status: "occupied",
    moved: run.moved,
    remaining: Math.max(remaining, run.unconfirmed, 1),
    detail: run.detail,
  };
}

async function emptyGroupChannelsOutcome(
  client: Client,
  guildId: string,
  eventId: string,
  targets: ReadonlyArray<{ groupKey: string; channelId: string }>,
  ending: () => boolean,
): Promise<EmptyChannelsOutcome> {
  const run = await emptyGroupChannelsOf(
    client,
    guildId,
    eventId,
    targets,
    ending,
  );
  if (run.status === "failed") return run;
  return {
    status: "done",
    moved: run.moved,
    occupied: targets.flatMap((t) => {
      const remaining = run.present.get(t.channelId) ?? 0;
      return remaining > 0 ? [{ groupKey: t.groupKey, remaining }] : [];
    }),
    unconfirmed: run.unconfirmed,
    detail: run.detail,
  };
}

export function createLiveEditEffects(client: Client): LiveEditEffects {
  return {
    eventVoiceInUse(guildId, channelIds): boolean {
      const guild = client.guilds?.cache?.get(guildId);
      // Not shown by the gateway: unknown, so treated as in use.
      if (!guild) return true;
      return channelIds.some((id) => {
        const channel = guild.channels?.cache?.get(id);
        return !!channel && channel.isVoiceBased() && channel.members.size > 0;
      });
    },
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
      ending,
    ): Promise<EmptyChannelOutcome> {
      try {
        return await emptyGroupChannelOf(
          client,
          guildId,
          eventId,
          groupKey,
          channelId,
          ending,
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
    async emptyGroupChannels(
      guildId,
      eventId,
      targets,
      ending,
    ): Promise<EmptyChannelsOutcome> {
      try {
        return await emptyGroupChannelsOutcome(
          client,
          guildId,
          eventId,
          targets,
          ending,
        );
      } catch (err) {
        logger.error(
          `Event ${sanitizeForLog(eventId)}: moving people out of the group channels failed:`,
          err,
        );
        return {
          status: "failed",
          reason: "the people in the channels could not be moved (see the log)",
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
    async removeAllGroupChannels(
      guildId,
      eventId,
      opts,
    ): Promise<GroupsOffResult | null> {
      try {
        const { EventService } = await import("./event-service.js");
        return await EventService.getInstance(client).removeAllGroupChannels(
          eventId,
          guildId,
          { ignore: opts.ignore, ending: opts.ending },
        );
      } catch (err) {
        logger.error(
          `Event ${sanitizeForLog(eventId)}: switching the groups off failed:`,
          err,
        );
        return { status: "failed", reason: "see the log", deleted: 0 };
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
