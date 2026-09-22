/**
 * Coordinates a per-user purge for `/me/privacy` (#916).
 *
 * Deliberately shaped like `user-data-export-service.ts`: the registry
 * (`user-data-registry.ts`) decides *what* is touched and *how*, this file
 * holds exactly one deleter per registry collection, and
 * `__tests__/config/user-data-registry-drift.test.ts` fails the build when
 * the two drift apart — in either direction, and per policy rather than only
 * per collection, because `quote` and `channel-invite` each carry two.
 *
 * Nothing calls this yet; the route, the confirmation flow and the config
 * keys are the web-surface issue's.
 *
 * ## There are no transactions
 *
 * `docker-compose.yml` runs a standalone `mongo:8` — no replica set — and
 * there is no `startSession`/`withTransaction` anywhere in `src/`.
 * Multi-document transactions are **not available**, and roughly eighteen
 * collections plus Discord side-effects could not be made atomic even if
 * they were. A partial purge is therefore a reachable state, and the design
 * owns it rather than pretending otherwise:
 *
 * - **Every step is idempotent**, so a retry is always safe: a member who
 *   hits an error and clicks again cannot make things worse.
 * - **One step's failure never aborts the rest.** It lands in the report
 *   with its message and the purge continues; `ok` goes false.
 * - **Ordering is part of the contract** (see `PURGE_ORDER` below), not an
 *   implementation detail.
 * - **The report is the audit record.** An operator has to be able to see a
 *   purge that half-completed, which is why every step reports counts even
 *   when it did nothing.
 *
 * ## No raw model access for anything with a side-effect
 *
 * Leaderboard role revokes, quote-channel message deletes and RSVP
 * re-renders go through the owning services' purge methods (#914), which
 * carry the ordering and recovery rules those side-effects need. Only inert
 * collections are touched directly here.
 *
 * ## Consequences encoded rather than hidden
 *
 * - **`poll-turnout`**: the `$pull` from `voterIds` retroactively lowers the
 *   public weekly recap for everyone, because `getTopPollTurnout` counts
 *   distinct voters as `$size: voterIds` at read time
 *   (`poll-participation-tracker.ts`). Accepted — the rows age out anyway.
 *   `votesCast` counts vote *events*, not people, and is deliberately left
 *   alone: decrementing it to compensate would corrupt a different number.
 * - **`user-achievements`**: accolades are "earned once" only because that
 *   row remembers them, so deleting it makes every marquee accolade
 *   re-earnable — and `announceMilestones` `@`-mentions the member publicly
 *   when they are. The cooldown that bounds this belongs to the web surface;
 *   this coordinator must not make it worse, which is why nothing here
 *   re-runs an achievement evaluation.
 * - **Cross-guild**: `voice-channel-tracking`, `user-achievements`,
 *   `user-voice-preferences`, `quote` and `channel-invite` have no `guildId`
 *   at all (the registry's `guildScoped: false` entries). Their filters are
 *   keyed on the user id alone, which is correct while the bot is
 *   single-guild via `GUILD_ID` and is the exact list a multi-guild change
 *   has to revisit.
 */

import { Client } from "discord.js";
import { EventService } from "./event-service.js";
import { LeaderboardRoleService } from "./leaderboard-role-service.js";
import { QuoteChannelManager } from "./quote-channel-manager.js";
import { quoteService } from "./quote-service.js";
import { ANONYMISED_USER_ID } from "./user-data-registry.js";
import { VoiceChannelTracker } from "./voice-channel-tracker.js";
import { WebSessionService } from "./web-session-service.js";
import { ChannelInvite } from "../models/channel-invite.js";
import { DigestState } from "../models/digest-state.js";
import { MessageActivityTracking } from "../models/message-activity-tracking.js";
import { PollParticipationTracking } from "../models/poll-participation-tracking.js";
import { PollTurnout } from "../models/poll-turnout.js";
import { ReactionActivityTracking } from "../models/reaction-activity-tracking.js";
import { Reminder } from "../models/reminder.js";
import { RewindNudgeState } from "../models/rewind-nudge-state.js";
import { RewindSnapshot } from "../models/rewind-snapshot.js";
import { UserAchievements } from "../models/user-achievements.js";
import { UserBirthday } from "../models/user-birthday.js";
import { UserNotificationPrefs } from "../models/user-notification-prefs.js";
import { UserVoicePreferences } from "../models/user-voice-preferences.js";
import { VoiceChannelTracking } from "../models/voice-channel-tracking.js";
import logger from "../utils/logger.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";

/**
 * A registry delete policy that a deleter implements. The registry's other
 * two policies (`retain`, `expires`) give a purge nothing to do and so never
 * reach this file.
 */
export type CollectionPurgeAction = "hard-delete" | "pull-member" | "anonymise";

/**
 * What a purge step did.
 *
 * The three collection policies come straight from the registry. The other
 * two are the steps that are not a registry collection at all but still have
 * to be auditable: evicting the in-memory voice session, and revoking the
 * member's web sessions (which the registry classifies `retain` precisely
 * because `WebSessionService.revokeForUser` soft-revokes rather than
 * deleting).
 */
export type PurgeAction = CollectionPurgeAction | "evict" | "revoke";

export interface PurgeStep {
  /** Registry collection label, or the pseudo-collection of a non-DB step. */
  collection: string;
  action: PurgeAction;
  /** Rows (or roles, or sessions) the step found. */
  matched: number;
  /**
   * How many of those it actually dealt with. Lower than `matched` means a
   * partial step — a leaderboard role whose Discord revoke failed, say. For
   * a delete the two are equal by construction: a `deleteMany` either
   * removed the row it matched or did not match it.
   */
  removed: number;
  /** Present when the step threw. The purge continued regardless. */
  error?: string;
  /** Free-text detail for the audit, when the counts do not tell it all. */
  note?: string;
}

export interface PurgeReport {
  steps: PurgeStep[];
  /** True when every step completed without an error. */
  ok: boolean;
}

/** What a deleter is handed. */
export interface PurgeContext {
  userId: string;
  guildId: string;
  client: Client;
}

/** One entry in a step a deleter produced; the coordinator adds the label. */
export type PurgeOutcome = Omit<PurgeStep, "collection" | "error">;

export interface CollectionDeleter {
  /**
   * The policies this deleter implements, declared rather than inferred so
   * the parity test can compare them against the registry without running a
   * purge. A collection carrying two policies (`quote`, `channel-invite`)
   * declares both and emits one step for each.
   */
  actions: readonly CollectionPurgeAction[];
  run(ctx: PurgeContext): Promise<PurgeOutcome[]>;
}

/** `deleteMany` reports one number; matched and removed are the same thing. */
function deleted(count: number | undefined, note?: string): PurgeOutcome[] {
  const n = count ?? 0;
  return [{ action: "hard-delete", matched: n, removed: n, note }];
}

/**
 * One deleter per registry collection a purge acts on. Keys are the
 * registry's `collection` labels, exactly as `READERS` in the export service
 * is keyed — the two tables are meant to be read side by side.
 */
const DELETERS: Record<string, CollectionDeleter> = {
  // ---------------------------------------------------------------
  // Discord side-effects, via the owning services (#914)
  // ---------------------------------------------------------------

  // Revokes on Discord first and only then pulls the id: `reconcileTier`
  // treats the persisted roster as its only source of truth, so a bare
  // `$pull` would leave the reward role on the member permanently. A role
  // whose revoke failed is deliberately left on the roster for the next
  // reconcile to retry — and reported here as a partial step, because a
  // member who asked to be forgotten is still wearing the role.
  "leaderboard-role-assignment": {
    actions: ["pull-member"],
    run: async ({ userId, guildId, client }) => {
      const result = await LeaderboardRoleService.getInstance(
        client,
      ).revokeForUser(guildId, userId);
      const matched = result.revoked.length + result.retained.length;
      return [
        {
          action: "pull-member",
          matched,
          removed: result.revoked.length,
          note:
            result.retained.length > 0
              ? `Discord revoke failed for role(s) ${result.retained.join(", ")}; left on the roster for the next reconcile to retry`
              : undefined,
        },
      ];
    },
  },

  // Two user fields, two policies, one call: quotes the member *said* are
  // deleted together with the bot's post in the quote channel (nothing else
  // ever collects an orphaned bot post), while quotes they merely *saved*
  // keep standing with the saver attribution cleared to the sentinel.
  quote: {
    actions: ["hard-delete", "anonymise"],
    run: async ({ userId, client }) => {
      const result = await quoteService.purgeForUser(
        userId,
        QuoteChannelManager.getInstance(client),
      );
      return [
        {
          action: "hard-delete",
          matched: result.deleted,
          removed: result.deleted,
          note: `${result.messagesDeleted} quote-channel post(s) deleted`,
        },
        {
          action: "anonymise",
          matched: result.anonymised,
          removed: result.anonymised,
        },
      ];
    },
  },

  // ---------------------------------------------------------------
  // Owning-service call with a side-effect on someone else's message
  // ---------------------------------------------------------------

  // `$pull`s the RSVP server-side across every event state and re-renders
  // the announcement of the non-terminal ones.
  "event-rsvp": {
    actions: ["pull-member"],
    run: async ({ userId, guildId, client }) => {
      const removed = await EventService.getInstance(client).removeRsvp(
        guildId,
        userId,
      );
      return [{ action: "pull-member", matched: removed, removed }];
    },
  },

  // ---------------------------------------------------------------
  // Inert collections
  // ---------------------------------------------------------------

  // No `guildId` on the schema at all — a global unique index on `userId`.
  "voice-channel-tracking": {
    actions: ["hard-delete"],
    run: async ({ userId }) =>
      deleted((await VoiceChannelTracking.deleteMany({ userId })).deletedCount),
  },

  "message-activity-tracking": {
    actions: ["hard-delete"],
    run: async ({ userId, guildId }) =>
      deleted(
        (await MessageActivityTracking.deleteMany({ userId, guildId }))
          .deletedCount,
      ),
  },

  "reaction-activity-tracking": {
    actions: ["hard-delete"],
    run: async ({ userId, guildId }) =>
      deleted(
        (await ReactionActivityTracking.deleteMany({ userId, guildId }))
          .deletedCount,
      ),
  },

  "poll-participation-tracking": {
    actions: ["hard-delete"],
    run: async ({ userId, guildId }) =>
      deleted(
        (await PollParticipationTracking.deleteMany({ userId, guildId }))
          .deletedCount,
      ),
  },

  // Shared per-poll aggregate: pull the id and nothing else. `votesCast`
  // counts vote events rather than people (a multiselect poll legitimately
  // reports more events than voters), so decrementing it here would replace
  // one known consequence with a wrong number.
  "poll-turnout": {
    actions: ["pull-member"],
    run: async ({ userId, guildId }) => {
      const result = await PollTurnout.updateMany(
        { guildId, voterIds: userId },
        { $pull: { voterIds: userId } },
      );
      return [
        {
          action: "pull-member",
          matched: result?.matchedCount ?? 0,
          removed: result?.modifiedCount ?? 0,
        },
      ];
    },
  },

  // Deleting this row makes every marquee accolade re-earnable; see the
  // module docstring. Nothing here re-runs an achievement evaluation.
  "user-achievements": {
    actions: ["hard-delete"],
    run: async ({ userId }) =>
      deleted((await UserAchievements.deleteMany({ userId })).deletedCount),
  },

  "user-birthday": {
    actions: ["hard-delete"],
    run: async ({ userId, guildId }) =>
      deleted(
        (await UserBirthday.deleteMany({ userId, guildId })).deletedCount,
      ),
  },

  "user-notification-prefs": {
    actions: ["hard-delete"],
    run: async ({ userId, guildId }) =>
      deleted(
        (await UserNotificationPrefs.deleteMany({ userId, guildId }))
          .deletedCount,
      ),
  },

  "user-voice-preferences": {
    actions: ["hard-delete"],
    run: async ({ userId }) =>
      deleted((await UserVoicePreferences.deleteMany({ userId })).deletedCount),
  },

  "rewind-snapshot": {
    actions: ["hard-delete"],
    run: async ({ userId, guildId }) =>
      deleted(
        (await RewindSnapshot.deleteMany({ userId, guildId })).deletedCount,
      ),
  },

  "rewind-nudge-state": {
    actions: ["hard-delete"],
    run: async ({ userId, guildId }) =>
      deleted(
        (await RewindNudgeState.deleteMany({ userId, guildId })).deletedCount,
      ),
  },

  "digest-state": {
    actions: ["hard-delete"],
    run: async ({ userId, guildId }) =>
      deleted((await DigestState.deleteMany({ userId, guildId })).deletedCount),
  },

  reminder: {
    actions: ["hard-delete"],
    run: async ({ userId, guildId }) =>
      deleted((await Reminder.deleteMany({ userId, guildId })).deletedCount),
  },

  // Both halves of the same schema, and no `guildId` on it. Invites the
  // member received go outright; invites they *sent* keep the recipient's
  // access and lose only the sender attribution — the field is
  // `required: true`, so it takes the sentinel rather than a null. Deleting
  // first means a row matching both ends up deleted rather than anonymised.
  "channel-invite": {
    actions: ["hard-delete", "anonymise"],
    run: async ({ userId }) => {
      const removal = await ChannelInvite.deleteMany({ userId });
      const anonymisation = await ChannelInvite.updateMany(
        { invitedBy: userId },
        { $set: { invitedBy: ANONYMISED_USER_ID } },
      );
      return [
        ...deleted(removal?.deletedCount),
        {
          action: "anonymise",
          matched: anonymisation?.matchedCount ?? 0,
          removed: anonymisation?.modifiedCount ?? 0,
        },
      ];
    },
  },
};

/** Collection labels that have a deleter. Exported for the parity test. */
export const DELETER_COLLECTIONS: readonly string[] = Object.keys(DELETERS);

/**
 * The policies each deleter says it implements, so the parity test can hold
 * them against the registry per policy rather than only per collection —
 * without that, a `quote` deleter that forgot to anonymise `addedById`
 * would still look complete.
 */
export const DELETER_ACTIONS: Readonly<
  Record<string, readonly CollectionPurgeAction[]>
> = Object.fromEntries(
  Object.entries(DELETERS).map(([collection, deleter]) => [
    collection,
    deleter.actions,
  ]),
);

/**
 * The order the deleters run in. **Load-bearing, not cosmetic** — without
 * transactions, the order is the only thing standing between a crash and an
 * inconsistent state:
 *
 * 1. Discord side-effects go before the rows that record them, so a crash
 *    between the two leaves a record saying the cleanup is still owed rather
 *    than an orphaned role or message nothing will ever collect.
 * 2. The owning-service call that re-renders someone else's message follows,
 *    since it is a side-effect on a row that is not the member's.
 * 3. Inert collections last: nothing outside the database observes them, so
 *    losing them to a crash costs only a retry.
 *
 * The in-memory voice eviction, the post-purge voice re-check and the web
 * session revoke bracket this list; see `purge`.
 */
export const PURGE_ORDER: readonly string[] = [
  // Discord side-effects first.
  "leaderboard-role-assignment",
  "quote",
  // Then the owning-service call that edits an event announcement.
  "event-rsvp",
  // Then everything inert.
  "voice-channel-tracking",
  "message-activity-tracking",
  "reaction-activity-tracking",
  "poll-participation-tracking",
  "poll-turnout",
  "user-achievements",
  "user-birthday",
  "user-notification-prefs",
  "user-voice-preferences",
  "rewind-snapshot",
  "rewind-nudge-state",
  "digest-state",
  "reminder",
  "channel-invite",
];

/** Pseudo-collection label for the in-memory voice eviction step. */
export const VOICE_SESSION_CACHE = "voice-session-cache";

export class UserDataDeletionService {
  private static instance: UserDataDeletionService | null = null;

  private constructor(private readonly client: Client) {}

  public static getInstance(client: Client): UserDataDeletionService {
    if (!UserDataDeletionService.instance) {
      UserDataDeletionService.instance = new UserDataDeletionService(client);
    }
    return UserDataDeletionService.instance;
  }

  /** Drop the singleton. Tests only. */
  public static reset(): void {
    UserDataDeletionService.instance = null;
  }

  /**
   * Erase a member from every collection the registry marks as theirs.
   *
   * Runs to completion whatever fails: each step is recorded in the returned
   * report, a thrown step is recorded with its message and the next step
   * still runs. Safe to call twice — the second run reports zeroes.
   */
  public async purge(userId: string, guildId: string): Promise<PurgeReport> {
    const ctx: PurgeContext = { userId, guildId, client: this.client };
    const steps: PurgeStep[] = [];

    logger.info(
      `Starting per-user purge for ${sanitizeForLog(userId)} in guild ${sanitizeForLog(guildId)}`,
    );

    // 1. Evict the in-memory voice session first. `endTracking` persists
    //    with `upsert: true`, so a member sitting in a voice channel when
    //    their row is deleted would have it recreated on disconnect —
    //    carrying the whole session's `totalTime`, including the hours
    //    before the purge, straight back into the accolade check.
    await this.runStep(steps, VOICE_SESSION_CACHE, "evict", async () => {
      const evicted = VoiceChannelTracker.getInstance(
        this.client,
      ).forgetActiveSession(userId);
      return [
        {
          action: "evict",
          matched: evicted ? 1 : 0,
          removed: evicted ? 1 : 0,
          note: evicted
            ? "in-flight voice session discarded"
            : "no in-flight voice session",
        },
      ];
    });

    // 2-4. The registry collections, in contract order.
    for (const collection of PURGE_ORDER) {
      const deleter = DELETERS[collection];
      if (!deleter) throw new Error(`No purge deleter for "${collection}"`);
      await this.runStep(steps, collection, deleter.actions[0], () =>
        deleter.run(ctx),
      );
    }

    // 5. Belt and braces against the `upsert: true` race: the eviction in
    //    step 1 closes the window, but a disconnect racing it could still
    //    have recreated the row after step 4 deleted it. A second delete is
    //    cheap and a non-zero count here is worth an operator's attention.
    await this.runStep(
      steps,
      "voice-channel-tracking",
      "hard-delete",
      async () => {
        const count =
          (await VoiceChannelTracking.deleteMany({ userId })).deletedCount ?? 0;
        if (count > 0) {
          logger.warn(
            `Purge for ${sanitizeForLog(userId)}: a voice tracking row was recreated mid-purge and has been deleted again`,
          );
        }
        return deleted(count, "post-purge re-check");
      },
    );

    // 6. Web sessions last: revoking earlier would kill the session the
    //    caller still needs to render its own result.
    await this.runStep(steps, "web-session", "revoke", async () => {
      const revoked =
        await WebSessionService.getInstance().revokeForUser(userId);
      return [{ action: "revoke", matched: revoked, removed: revoked }];
    });

    const report: PurgeReport = {
      steps,
      ok: steps.every((step) => !step.error),
    };

    const failed = steps.filter((step) => step.error).length;
    logger.info(
      `Purge for ${sanitizeForLog(userId)} finished: ${steps.length} step(s), ` +
        `${steps.reduce((sum, step) => sum + step.removed, 0)} item(s) removed, ${failed} failure(s)`,
    );
    return report;
  }

  /**
   * Run one step and record it. A throw is recorded and swallowed: without
   * transactions there is nothing to roll back to, so the useful behaviour
   * is to keep going and hand the caller a report saying exactly which step
   * is still owed.
   *
   * `action` is what the failure row is labelled with, since a throw tells
   * us nothing about how far the step got. A deleter carrying two policies
   * that fails therefore reports one failed step under the first of them
   * rather than two — the collection name is what an operator retries on.
   */
  private async runStep(
    steps: PurgeStep[],
    collection: string,
    action: PurgeAction,
    run: () => Promise<PurgeOutcome[]>,
  ): Promise<void> {
    try {
      for (const outcome of await run()) {
        steps.push({ collection, ...outcome });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Purge step "${collection}" failed:`, error);
      steps.push({
        collection,
        action,
        matched: 0,
        removed: 0,
        error: message,
      });
    }
  }
}
