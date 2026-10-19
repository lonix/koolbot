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
import type {
  GroupChannelSyncOutcome,
  LiveEditEffects,
} from "./event-live-edit.js";

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
