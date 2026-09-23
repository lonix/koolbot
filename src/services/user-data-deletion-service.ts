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
import { BirthdayService } from "./birthday-service.js";
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
import { UserNotificationPrefs } from "../models/user-notification-prefs.js";
import { UserVoicePreferences } from "../models/user-voice-preferences.js";
import { VoiceChannelTracking } from "../models/voice-channel-tracking.js";
import { getErrorMessage } from "../utils/error-guards.js";
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
  /**
   * Present when the step could not finish: it threw, or it left work
   * plainly owed. The purge continued regardless, and `ok` goes false.
   */
  error?: string;
  /** Free-text detail for the audit, when the counts do not tell it all. */
  note?: string;
}

export interface PurgeReport {
  steps: PurgeStep[];
  /**
   * True only when the purge finished *in full*: nothing threw, and no step
   * left part of what it matched behind. A step that quietly reports
   * `removed < matched` — a leaderboard role whose Discord revoke failed, a
   * quote post still visible in the channel — is an incomplete erasure, so
   * it must not be handed to the caller as a success (#916).
   */
  ok: boolean;
}

/** What a deleter is handed. */
export interface PurgeContext {
  userId: string;
  guildId: string;
  client: Client;
}

/** One entry in a step a deleter produced; the coordinator adds the label. */
export type PurgeOutcome = Omit<PurgeStep, "collection">;

/** How a deleter hands back each outcome as soon as it has one. */
export type PurgeEmit = (outcome: PurgeOutcome) => void;

export interface CollectionDeleter {
  /**
   * The policies this deleter implements, declared rather than inferred so
   * the parity test can compare them against the registry without running a
   * purge. A collection carrying two policies (`quote`, `channel-invite`)
   * declares both and emits one step for each.
   */
  actions: readonly CollectionPurgeAction[];
  /**
   * Outcomes are **emitted as they happen** rather than returned in a batch.
   * A deleter with two policies does real work between them — `channel-invite`
   * deletes the invites the member received and only then anonymises the ones
   * they sent — so a throw in the second operation must not erase the record
   * of the first, and must be reported against the policy that actually
   * failed rather than the first one declared.
   */
  run(ctx: PurgeContext, emit: PurgeEmit): Promise<void>;
}

/** `deleteMany` reports one number; matched and removed are the same thing. */
function deleted(count: number | undefined, note?: string): PurgeOutcome {
  const n = count ?? 0;
  return { action: "hard-delete", matched: n, removed: n, note };
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
  //
  // **Known race, not closed here.** A scheduled reconcile that snapshotted
  // the rankings *before* this revoke can write them back afterwards and
  // re-grant the role. It is self-limiting — the member's voice data is gone
  // by then, so the following reconcile finds they no longer qualify and
  // revokes — but it means the role can survive one cron cycle past a purge
  // the report called complete. Closing it needs the reconcile to exclude
  // in-purge members at write time, which is a `LeaderboardRoleService`
  // change belonging with the route that will call this (see the web-surface
  // issue), not a coordinator one.
  "leaderboard-role-assignment": {
    actions: ["pull-member"],
    run: async ({ userId, guildId, client }, emit) => {
      const result = await LeaderboardRoleService.getInstance(
        client,
      ).revokeForUser(guildId, userId);
      const matched = result.revoked.length + result.retained.length;
      emit({
        action: "pull-member",
        matched,
        removed: result.revoked.length,
        // A retained role means the member is still on the roster for it,
        // whether the Discord revoke failed or the roster `$pull` that
        // follows it did — so this says what is true of both rather than
        // naming an operation that may well have succeeded. The next
        // reconcile retries, but the purge is not complete until it does,
        // so this is an error on the step and not just a note.
        error:
          result.retained.length > 0
            ? `Leaderboard cleanup incomplete for role(s) ${result.retained.join(", ")}; left on the roster for the next reconcile to retry`
            : undefined,
      });
    },
  },

  // Two user fields, two policies, one call: quotes the member *said* are
  // deleted together with the bot's post in the quote channel (nothing else
  // ever collects an orphaned bot post), while quotes they merely *saved*
  // keep standing with the saver attribution cleared to the sentinel.
  quote: {
    actions: ["hard-delete", "anonymise"],
    run: async ({ userId, client }, emit) => {
      const result = await quoteService.purgeForUser(
        userId,
        QuoteChannelManager.getInstance(client),
      );
      emit({
        action: "hard-delete",
        matched: result.authored,
        removed: result.deleted,
        error: result.deleteError,
      });
      // The Discord posts get a step of their own rather than a note on the
      // rows: they are a different thing being erased, they can fail on
      // their own, and a post still visible in the channel is the half a
      // member would actually notice. `QuoteService` deletes the row anyway
      // (a stale `messageId` must not block an erasure), so this is the only
      // place the shortfall is recorded.
      emit({
        action: "hard-delete",
        matched: result.messagesAttempted,
        removed: result.messagesDeleted,
        note: QUOTE_CHANNEL_POSTS,
        error:
          result.messagesFailed > 0
            ? `${result.messagesFailed} quote-channel post(s) could not be deleted and may still be visible`
            : undefined,
      });
      emit({
        action: "anonymise",
        // What it found, against what it actually cleared: a row that
        // changed mid-purge is kept rather than stranding a fresh post, and
        // that shortfall has to fail the report so the purge is run again.
        matched: result.saverMatched,
        removed: result.anonymised,
        note:
          result.attributionsRerendered > 0
            ? `${result.attributionsRerendered} quote post(s) re-rendered`
            : undefined,
        // The row is anonymised but the embed still prints their name, so
        // the erasure is not finished where anyone can actually see it.
        error:
          result.anonymiseError ??
          (result.attributionsStale > 0
            ? `${result.attributionsStale} quote post(s) still name this member as the saver`
            : undefined),
      });
    },
  },

  // Not an inert row: `UserBirthday.roleAssignedAt` is the *only* record
  // that a birthday role was granted, and `sweepExpiredRoles` queries it to
  // find grants to revoke. A raw delete while a grant is live would strand
  // the role on the member for good — the same trap the leaderboard rosters
  // have — so this goes through the owning service, which revokes first.
  "user-birthday": {
    actions: ["hard-delete"],
    run: async ({ userId, guildId, client }, emit) => {
      const result = await BirthdayService.getInstance(client).purgeForUser(
        guildId,
        userId,
      );
      // The posts get a step of their own: they are Discord side-effects
      // with their own failure mode, and rolling them into the row count
      // would hide a message that still names the member (#916).
      if (result.announcementsAttempted > 0) {
        emit({
          action: "hard-delete",
          matched: result.announcementsAttempted,
          removed: result.announcementsDeleted,
          note: "birthday announcements",
          error:
            result.announcementsFailed > 0
              ? `${result.announcementsFailed} birthday announcement(s) could not be deleted and may still name this member`
              : undefined,
        });
      }
      emit({
        action: "hard-delete",
        matched: result.matched,
        removed: result.removed,
        note: result.roleRevoked ? "birthday role revoked" : undefined,
        error: result.error,
      });
    },
  },

  // ---------------------------------------------------------------
  // Owning-service call with a side-effect on someone else's message
  // ---------------------------------------------------------------

  // `$pull`s the RSVP server-side across every event state and re-renders
  // the announcement of the non-terminal ones.
  "event-rsvp": {
    actions: ["pull-member"],
    run: async ({ userId, guildId, client }, emit) => {
      // Reports what it found as well as what it cleared, so an event whose
      // pull or re-render failed shows up as a shortfall rather than as a
      // silently smaller success.
      const { matched, removed, rendersFailed } =
        await EventService.getInstance(client).removeRsvp(guildId, userId);
      emit({
        action: "pull-member",
        matched,
        removed,
        // The row is gone but the announcement still shows the member as
        // attending, which is their data left publicly readable.
        error:
          rendersFailed > 0
            ? `${rendersFailed} event announcement(s) could not be refreshed and may still show this member's RSVP`
            : undefined,
      });
    },
  },

  // ---------------------------------------------------------------
  // Inert collections
  // ---------------------------------------------------------------

  // No `guildId` on the schema at all — a global unique index on `userId`.
  "voice-channel-tracking": {
    actions: ["hard-delete"],
    run: async ({ userId }, emit) => {
      emit(
        deleted(
          (await VoiceChannelTracking.deleteMany({ userId })).deletedCount,
        ),
      );
    },
  },

  "message-activity-tracking": {
    actions: ["hard-delete"],
    run: async ({ userId, guildId }, emit) => {
      emit(
        deleted(
          (await MessageActivityTracking.deleteMany({ userId, guildId }))
            .deletedCount,
        ),
      );
    },
  },

  "reaction-activity-tracking": {
    actions: ["hard-delete"],
    run: async ({ userId, guildId }, emit) => {
      emit(
        deleted(
          (await ReactionActivityTracking.deleteMany({ userId, guildId }))
            .deletedCount,
        ),
      );
    },
  },

  "poll-participation-tracking": {
    actions: ["hard-delete"],
    run: async ({ userId, guildId }, emit) => {
      emit(
        deleted(
          (await PollParticipationTracking.deleteMany({ userId, guildId }))
            .deletedCount,
        ),
      );
    },
  },

  // Shared per-poll aggregate: pull the id and nothing else. `votesCast`
  // counts vote events rather than people (a multiselect poll legitimately
  // reports more events than voters), so decrementing it here would replace
  // one known consequence with a wrong number.
  "poll-turnout": {
    actions: ["pull-member"],
    run: async ({ userId, guildId }, emit) => {
      const result = await PollTurnout.updateMany(
        { guildId, voterIds: userId },
        { $pull: { voterIds: userId } },
      );
      emit({
        action: "pull-member",
        matched: result?.matchedCount ?? 0,
        removed: result?.modifiedCount ?? 0,
      });
    },
  },

  // Deleting this row makes every marquee accolade re-earnable; see the
  // module docstring. Nothing here re-runs an achievement evaluation.
  "user-achievements": {
    actions: ["hard-delete"],
    run: async ({ userId }, emit) => {
      emit(
        deleted((await UserAchievements.deleteMany({ userId })).deletedCount),
      );
    },
  },

  "user-notification-prefs": {
    actions: ["hard-delete"],
    run: async ({ userId, guildId }, emit) => {
      emit(
        deleted(
          (await UserNotificationPrefs.deleteMany({ userId, guildId }))
            .deletedCount,
        ),
      );
    },
  },

  "user-voice-preferences": {
    actions: ["hard-delete"],
    run: async ({ userId }, emit) => {
      emit(
        deleted(
          (await UserVoicePreferences.deleteMany({ userId })).deletedCount,
        ),
      );
    },
  },

  "rewind-snapshot": {
    actions: ["hard-delete"],
    run: async ({ userId, guildId }, emit) => {
      emit(
        deleted(
          (await RewindSnapshot.deleteMany({ userId, guildId })).deletedCount,
        ),
      );
    },
  },

  "rewind-nudge-state": {
    actions: ["hard-delete"],
    run: async ({ userId, guildId }, emit) => {
      emit(
        deleted(
          (await RewindNudgeState.deleteMany({ userId, guildId })).deletedCount,
        ),
      );
    },
  },

  "digest-state": {
    actions: ["hard-delete"],
    run: async ({ userId, guildId }, emit) => {
      emit(
        deleted(
          (await DigestState.deleteMany({ userId, guildId })).deletedCount,
        ),
      );
    },
  },

  reminder: {
    actions: ["hard-delete"],
    run: async ({ userId, guildId }, emit) => {
      emit(
        deleted((await Reminder.deleteMany({ userId, guildId })).deletedCount),
      );
    },
  },

  // Both halves of the same schema, and no `guildId` on it. Invites the
  // member received go outright; invites they *sent* keep the recipient's
  // access and lose only the sender attribution — the field is
  // `required: true`, so it takes the sentinel rather than a null. Deleting
  // first means a row matching both ends up deleted rather than anonymised,
  // and emitting the delete before starting the anonymise means a failure in
  // the second half cannot erase the record of the first.
  "channel-invite": {
    actions: ["hard-delete", "anonymise"],
    run: async ({ userId }, emit) => {
      // Each policy gets its own catch: they are independent writes, and a
      // failed delete must not stop the sender attribution from being
      // cleared — nor leave the report with no row for it at all.
      try {
        const removal = await ChannelInvite.deleteMany({ userId });
        emit(deleted(removal?.deletedCount));
      } catch (error) {
        emit({
          action: "hard-delete",
          matched: 0,
          removed: 0,
          error: getErrorMessage(error),
        });
      }

      try {
        const anonymisation = await ChannelInvite.updateMany(
          { invitedBy: userId },
          { $set: { invitedBy: ANONYMISED_USER_ID } },
        );
        emit({
          action: "anonymise",
          matched: anonymisation?.matchedCount ?? 0,
          removed: anonymisation?.modifiedCount ?? 0,
        });
      } catch (error) {
        emit({
          action: "anonymise",
          matched: 0,
          removed: 0,
          error: getErrorMessage(error),
        });
      }
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
  "user-birthday",
  // Then the owning-service call that edits an event announcement.
  "event-rsvp",
  // Then everything inert.
  "voice-channel-tracking",
  "message-activity-tracking",
  "reaction-activity-tracking",
  "poll-participation-tracking",
  "poll-turnout",
  "user-achievements",
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

/** Note marking the quote step that covers the Discord posts, not the rows. */
export const QUOTE_CHANNEL_POSTS = "quote-channel posts";

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
    //    Evicting the maps is not on its own enough — a persist that already
    //    read its session is still to come — so `forgetActiveSession` also
    //    waits that persist out before returning.
    await this.runStep(steps, VOICE_SESSION_CACHE, "evict", async (emit) => {
      const { discarded, drained, timedOut } =
        await VoiceChannelTracker.getInstance(this.client).forgetActiveSession(
          userId,
        );
      const notes = [
        discarded
          ? "in-flight voice session discarded"
          : "no in-flight voice session",
      ];
      if (drained) notes.push("waited for a persist already in flight");
      emit({
        action: "evict",
        matched: discarded ? 1 : 0,
        removed: discarded ? 1 : 0,
        note: notes.join("; "),
        // A persist still running when the wait timed out can land after the
        // deletes below and resurrect the row. The re-check in step 5 may
        // still catch it, but the purge cannot claim to have closed the
        // window, so it says so rather than hanging on it.
        error: timedOut
          ? "timed out waiting for an in-flight voice session persist; a tracking row may be recreated after this purge"
          : undefined,
      });
    });

    // 2-4. The registry collections, in contract order.
    for (const collection of PURGE_ORDER) {
      const deleter = DELETERS[collection];
      if (!deleter) throw new Error(`No purge deleter for "${collection}"`);
      await this.runStep(
        steps,
        collection,
        deleter.actions[0],
        (emit) => deleter.run(ctx, emit),
        deleter.actions,
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
      async (emit) => {
        const count =
          (await VoiceChannelTracking.deleteMany({ userId })).deletedCount ?? 0;
        if (count > 0) {
          logger.warn(
            `Purge for ${sanitizeForLog(userId)}: a voice tracking row was recreated mid-purge and has been deleted again`,
          );
        }
        emit(deleted(count, "post-purge re-check"));
      },
    );

    // 6. Web sessions last: revoking earlier would kill the session the
    //    caller still needs to render its own result.
    await this.runStep(steps, "web-session", "revoke", async (emit) => {
      const revoked =
        await WebSessionService.getInstance().revokeForUser(userId);
      emit({ action: "revoke", matched: revoked, removed: revoked });
    });

    const report: PurgeReport = { steps, ok: steps.every(isComplete) };

    const failed = steps.filter((step) => !isComplete(step)).length;
    logger.info(
      `Purge for ${sanitizeForLog(userId)} finished: ${steps.length} step(s), ` +
        `${steps.reduce((sum, step) => sum + step.removed, 0)} item(s) removed, ${failed} incomplete step(s)`,
    );
    return report;
  }

  /**
   * Run one step and record it. A throw is recorded and swallowed: without
   * transactions there is nothing to roll back to, so the useful behaviour
   * is to keep going and hand the caller a report saying exactly which step
   * is still owed.
   *
   * **Outcomes already emitted are kept.** A deleter that deletes rows,
   * emits, and then throws while anonymising really has deleted those rows;
   * dropping that outcome because a later operation failed would report work
   * as owed that is in fact done, and send a retry hunting for rows that are
   * already gone.
   *
   * The failure row is labelled with the first declared policy the deleter
   * did *not* reach, falling back to `action` — so the `anonymise` half of
   * `channel-invite` failing is reported as an `anonymise` failure rather
   * than as a phantom `hard-delete` one.
   */
  private async runStep(
    steps: PurgeStep[],
    collection: string,
    action: PurgeAction,
    run: (emit: PurgeEmit) => Promise<void>,
    declared: readonly CollectionPurgeAction[] = [],
  ): Promise<void> {
    const seen = new Set<PurgeAction>();
    const emit: PurgeEmit = (outcome) => {
      seen.add(outcome.action);
      steps.push({ collection, ...outcome });
    };

    try {
      await run(emit);
    } catch (error) {
      logger.error(`Purge step "${collection}" failed:`, error);
      steps.push({
        collection,
        action: declared.find((candidate) => !seen.has(candidate)) ?? action,
        matched: 0,
        removed: 0,
        error: getErrorMessage(error),
      });
    }
  }
}

/**
 * Whether a step finished everything it found. A step that threw did not,
 * and neither did one that matched more than it removed: a partial step is
 * an erasure the member asked for and did not fully get, so it must not be
 * counted towards a successful purge.
 */
function isComplete(step: PurgeStep): boolean {
  return !step.error && step.removed >= step.matched;
}
