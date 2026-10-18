/**
 * Temporary clan tags on server nicknames (#1194, event groups epic #1187).
 *
 * While an event is `active` and has `tagsEnabled`, each member of a team
 * group whose tag is not empty carries that tag on their SERVER nickname
 * ("[RED] Alice", or "Alice [RED]" with `tagsSuffix`). The original nickname
 * is always put back afterwards.
 *
 * ## One decision function
 *
 * Every trigger (assignment change, event start, event end, cancel, member data
 * reset, startup, the periodic sweep) calls the same function,
 * `syncMember(event, member)`. It does not act on what the trigger says
 * happened. It reads the event and the member's backup FRESH, inside the
 * per-member lock, works out whether a tag is wanted NOW (event active, tags on,
 * member in a team group with a tag, events enabled) and brings the nickname in
 * line with that. That is what makes it safe to run twice, concurrently, late,
 * or from a stale caller: the answer depends only on the stored state.
 *
 * ## What the bot may have put on a nickname: a persisted SET, never one field
 *
 * A backup row records `original` (what to put back) and `owned`: EVERY
 * nickname the bot has set or may have set (most recent last), appended BEFORE
 * each edit and never overwritten by a later one. `intended` is the target of
 * the latest edit; `confirmedTarget` is the target whose edit Discord confirmed
 * (null while the latest edit is unconfirmed); `attemptedAt` is when the latest
 * edit was started. A nickname read fresh from Discord is classified, always the
 * same way:
 *
 * - in `owned`            : the bot's own tag is on it (restore it, retag it);
 * - equal to `original`   : nothing of ours is on it;
 * - anything else         : the member changed it on purpose; leave it alone.
 *
 * "In `owned`" is decided after ONE normalisation, `normalizeNickname` (NFC,
 * trimmed, runs of whitespace collapsed; case is NOT folded, a case change is a
 * deliberate edit), used for every comparison of a nickname read from Discord
 * with one the bot sent: Discord may store a nickname in a slightly different
 * spelling than the one requested, and when the answer is lost or the
 * confirmation write fails the row only knows the requested spelling.
 *
 * An UNRESOLVED row (unconfirmed latest edit) whose nickname is neither owned
 * nor the original is ambiguous: a deliberate rename, or a spelling the
 * normalisation does not know. It is not decided on the first read: the row is
 * kept (`mismatches` counts the settled re-reads) and only after
 * `MISMATCH_READS_BEFORE_RENAME` such reads, or a day-long unresolved age, is it
 * treated as the member's own rename (left alone, backup dropped, never
 * restored over). A CONFIRMED row has the nickname Discord reported recorded in
 * `owned`, so a mismatch there is a deliberate rename at once. A stuck-but-safe
 * row beats a lost original.
 *
 * `null` (no server nickname) is never "owned": the bot never sets null while
 * tagging, so a member who clears their nickname is "anything else" (or
 * "original", when the original was none), never mistaken for the bot.
 *
 * ### State machine of a backup row
 *
 * | State | Row | Reached by | Crash here leaves |
 * | --- | --- | --- | --- |
 * | NONE | no row | start; after a confirmed restore or "nothing of ours" | nothing to do |
 * | CLAIMED | owned=[T], confirmed=null | the claim (upsert), BEFORE any edit | a row; the nickname is still original |
 * | SENT | same fields as CLAIMED | the PATCH is on its way, outcome unknown | a row; the nickname is original or T |
 * | CONFIRMED | confirmed=T=intended | Discord confirmed the PATCH | a row; the nickname is T |
 * | RETARGETED | owned=[..,T2], intended=T2, confirmed=null | a team move: T2 is APPENDED to owned (T stays), before the edit | a row; the nickname is original, T or T2 |
 *
 * Transitions: NONE to CLAIMED (apply); CLAIMED/SENT to CONFIRMED (confirm);
 * CONFIRMED to RETARGETED (team move) to CONFIRMED; any state to NONE only by
 * restore, and restore deletes the row only after a confirmed restore edit or a
 * fresh read classifying the nickname as "nothing of ours" / "changed by the
 * member". A row that is not CONFIRMED is UNRESOLVED: whether its last edit
 * landed is unknown, so it is resolved only by a fresh read taken after
 * `OUTCOME_SETTLE_MS` from `attemptedAt` (a PATCH that timed out locally may
 * still be in flight at Discord); until then every decision on it is "kept".
 *
 * ### The attempt is stamped in the same step as the dispatch
 *
 * The stamp is written AFTER the read and the classification, immediately before
 * the PATCH (restore, retarget via `advance`/stamp, apply), as a conditional
 * write on the row decided from; if the row changed, nothing is sent. A slow
 * read therefore cannot use up the settle window before the edit is even sent,
 * and the member read has a single attempt (no retry budget of its own).
 *
 * ### Nothing is queued or waited for between a read and its PATCH
 *
 * The question for every nickname edit: between the moment a decision is made
 * from a READ and the moment the PATCH leaves, can anything be queued or
 * awaited? Everything that can wait is entered BEFORE the read:
 *
 * - the per-member lock, then the SLOT: one shared serial queue that runs the
 *   work from the fresh read through the PATCH as one job and keeps `paceMs`
 *   between one job's end and the next job's start. Spacing is in front of the
 *   read, never after it, and two jobs can never be in their read-to-PATCH part
 *   at the same time, so PATCHes cannot burst;
 * - inside the slot: **restore** reads, classifies, stamps the attempt
 *   (unresolved), PATCHes; **retarget** re-reads the event ("still wanted?", the
 *   wait can be long), reads the member, classifies, makes ONE conditional write
 *   (`advance`, or the attempt stamp) and PATCHes; **apply** reads, classifies,
 *   claims, re-checks the event (invariant 5), stamps the attempt and PATCHes;
 * - the PATCH itself cannot wait either: the nickname REST client is FAIL-FAST
 *   (`createFailFastRest`: no retries, and any rate-limit wait is rejected, never
 *   slept), and the call gets one attempt. A rate-limit rejection means "not
 *   sent": the stamp goes back to settled, the row stays, and a later pass starts
 *   again from a fresh read.
 *
 * What remains between a read and its PATCH is bounded database round trips
 * (milliseconds, no queue), and Discord has no conditional nickname edit, so a
 * change made inside that window cannot be told apart from one made just after
 * the PATCH; it is the same window every bot has and is accepted. A change made
 * while the work was QUEUED or rate-limited can no longer be overwritten.
 *
 * ### When an attempt is recorded
 *
 * `attemptedAt` is stamped AFTER the pacing queue, immediately before the PATCH
 * is dispatched (`stampDispatch`, a conditional write on the row decided from,
 * which also clears `confirmedTarget`): the settle window is measured from the
 * moment a request can actually be in flight, not from when it queued. The
 * claim and `advance` still happen BEFORE the edit (they record what the bot
 * may put on the nickname). A RESTORE is stamped the same way, so a restore
 * whose response is lost leaves the row unresolved instead of "confirmed".
 *
 * ### The worker (nothing here runs on the Events scan's clock)
 *
 * - `requestSweep` (called by the scan) is cheap and non-blocking: one full
 *   pass (restore + tag) at a time, coalesced, errors logged.
 * - `startWorker` (called at startup, `destroy()` stops it) runs a RESTORE-ONLY
 *   pass every minute whether or not `events.enabled` is on: bounded batch, never
 *   applies a tag, never touches a member whose tag is still wanted.
 * - The skip cooldown applies to TAGGING jobs only; a restore is retried on every
 *   pass.
 *
 * ## Invariants (read before changing anything here)
 *
 * 1. **A backup row means "the nickname MAY be tagged".** It is written BEFORE
 *    the first edit (`claim`, an upsert on (guild, member): one tag owner per
 *    member, see the model) and deleted only after the nickname is confirmed
 *    restored or confirmed not to need restoring. A crash at any point leaves a
 *    row that the startup reconcile and the sweep finish. Nothing here ever
 *    deletes a row because an edit failed with an unknown outcome, and nothing
 *    resolves an unconfirmed edit before it has settled (see the table).
 * 2. **The tagged name is always built from the stored `base`** (the original
 *    nickname, or the display name when there was none), never from the current
 *    nickname, so a name is never double-tagged or lost. Only the base is
 *    truncated (to fit 32 characters); the tag never is.
 * 3. **Per (guild, member) lock.** Apply, retarget and restore for one member
 *    run one at a time, and each decides from a fresh read taken inside the
 *    lock. No state is carried over from the caller: scan copies of an event go
 *    stale, so the sweep passes ids only and this module reads the event itself.
 *    A nickname PATCH goes through the cancellable write client (no automatic
 *    retries; the request is aborted when it times out), and the lock is held
 *    until the call has settled or been aborted.
 * 4. **Conditional writes with an outcome.** The claim is an upsert that
 *    reports whether this call created the row; a delete or an update matches
 *    the row's `eventId` and `intended` value it decided from, so a row that
 *    changed meanwhile is never removed on an old reading.
 * 5. **Check the world again after the claim.** The end hook lists backups
 *    after the event is saved as `ended`; a claim that lands after that would be
 *    missed. So after the claim the event is read again, and if the tag is no
 *    longer wanted the (still unedited) row is dropped instead of edited.
 * 6. **Never trust the gateway cache for the current nickname.** The member is
 *    fetched with `force` before every decision and classified as above.
 * 7. **Restore is never gated on `events.enabled`**; applying is. Turning
 *    events off must not leave tags behind.
 * 8. **Failure handling.** Member gone (10007): drop the row. Missing
 *    permission on a RESTORE: keep the row, report, retry later. Missing
 *    permission on an APPLY: nothing changed, so a first claim is dropped and
 *    the member is reported as skipped (a row that may already carry a tag is
 *    kept). Rate limit, timeout or anything unknown: keep the row, retry later.
 * 9. **Member data in memory.** The skipped-member report and the sweep
 *    cooldown are keyed by user id; a member data reset clears them
 *    (`forgetMemberInMemory`), and so does an unassignment. That state is only
 *    ever written inside `syncMember`'s member lock (from fresh reads), never
 *    from a sweep snapshot: a reset that finishes between a snapshot and a
 *    write could otherwise leave an entry for an erased member.
 *
 * Edits are paced through one queue (`NICKNAME_PACE_MS` apart) and go through
 * `CommandManager.makeDiscordApiCall`. Fetching one member by id is a REST
 * call: no privileged intent is needed (the Server Members Intent is for the
 * gateway member list, which this module never reads).
 */

import {
  PermissionFlagsBits,
  Routes,
  type Client,
  type Guild,
  type GuildMember,
  type REST,
} from "discord.js";
import { Event } from "../models/event.js";
import { EventNicknameBackup } from "../models/event-nickname-backup.js";
import { createKeyedLock } from "../utils/keyed-lock.js";
import logger from "../utils/logger.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";
import { waitForClientReady } from "../utils/discord.js";
import {
  cancellableCall,
  createFailFastRest,
} from "../web/channel-write-rest.js";
import { ConfigService } from "./config-service.js";
import { NICKNAME_MAX } from "./event-groups.js";
import { onGroupAssignmentChange } from "./event-group-assignment.js";
import { registerEventEndHook } from "./event-end-hooks.js";
import { TrackingOptOutService } from "./tracking-opt-out-service.js";

/** Pause between two nickname edits, so a big team stays under Discord's limits. */
export const NICKNAME_PACE_MS = 600;
/**
 * How long after an edit was started its outcome stays "unknown": a PATCH that
 * timed out locally may still be in flight at Discord (the write client aborts
 * its own request at 30 s, but one already delivered may still apply).
 */
export const OUTCOME_SETTLE_MS = 60_000;
/** After a skip or a refused edit, the sweep leaves the member alone this long. */
export const SKIP_COOLDOWN_MS = 10 * 60 * 1000;
/** How often the restore-only worker looks for backups to finish. */
export const RESTORE_RETRY_MS = 60_000;
/** The most members one restore-only pass works on (the rest wait for the next). */
export const RESTORE_BATCH_MAX = 100;
/**
 * How many settled re-reads of an unresolved row whose nickname matches nothing
 * we know are tolerated before it is taken for the member's own rename.
 */
export const MISMATCH_READS_BEFORE_RENAME = 3;
/** An unresolved row older than this is resolved as a rename on its next mismatch. */
export const MISMATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Name of the end-of-event hook. */
export const TAGS_END_HOOK = "nickname-tags";
const REASON = "KoolBot event tag";

const DISCORD_UNKNOWN_MEMBER = 10007;
const DISCORD_UNKNOWN_USER = 10013;
const DISCORD_MISSING_ACCESS = 50001;
const DISCORD_MISSING_PERMISSIONS = 50013;

// ---------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------

/** Cut `text` to at most `max` UTF-16 units without splitting a surrogate pair. */
function truncateUnits(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = max;
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return text.slice(0, cut);
}

/**
 * The tagged nickname: "[TAG] base" (or "base [TAG]"), at most 32 characters.
 * The BASE is truncated to fit, never the tag. Null when nothing sensible fits
 * (an empty tag or base, or a tag so long no base character is left).
 */
export function buildTaggedName(
  base: string,
  tag: string,
  suffix: boolean,
): string | null {
  // A tag typed with its own brackets ("[RED]") is not wrapped twice.
  const cleanTag = tag
    .trim()
    .replace(/^\[(.*)\]$/, "$1")
    .trim();
  const cleanBase = base.trim();
  if (!cleanTag || !cleanBase) return null;
  const tagText = `[${cleanTag}]`;
  const room = NICKNAME_MAX - tagText.length - 1; // the space between
  if (room < 1) return null;
  const shortened = truncateUnits(cleanBase, room).trimEnd();
  if (!shortened) return null;
  return suffix ? `${shortened} ${tagText}` : `${tagText} ${shortened}`;
}

/** The part of a stored event the tag rules read. */
export interface TagEventRow {
  _id?: unknown;
  state?: string;
  tagsEnabled?: boolean;
  tagsSuffix?: boolean;
  groupsEnabled?: boolean;
  groups?: Array<{
    key?: string;
    kind?: string;
    tag?: string;
    memberIds?: string[];
  }>;
}

export interface WantedTag {
  groupKey: string;
  tag: string;
  suffix: boolean;
}

/**
 * The tag a member should carry right now, or null: only an `active` event with
 * tags and groups on, and only a member of a TEAM group whose tag is not empty.
 */
export function wantedTag(
  event: TagEventRow | null | undefined,
  userId: string,
): WantedTag | null {
  if (!event) return null;
  if (event.state !== "active") return null;
  if (event.tagsEnabled !== true || event.groupsEnabled !== true) return null;
  for (const g of event.groups ?? []) {
    if (g.kind !== "team") continue;
    const tag = (g.tag ?? "").trim();
    if (!tag) continue;
    if ((g.memberIds ?? []).includes(userId)) {
      return {
        groupKey: String(g.key ?? ""),
        tag,
        suffix: event.tagsSuffix === true,
      };
    }
  }
  return null;
}

function discordErrorCode(err: unknown): number | undefined {
  let e: unknown = err;
  for (let i = 0; i < 3 && e && typeof e === "object"; i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "number") return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

type FailureKind = "gone" | "permission" | "not-sent" | "transient";

/** A rate-limit rejection (fail-fast client): the request was never sent. */
function isRateLimitRejection(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 3 && e && typeof e === "object"; i++) {
    const o = e as { name?: unknown; status?: unknown };
    if (o.name === "RateLimitError" || o.status === 429) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

export function classifyDiscordFailure(err: unknown): FailureKind {
  const code = discordErrorCode(err);
  if (code === DISCORD_UNKNOWN_MEMBER || code === DISCORD_UNKNOWN_USER) {
    return "gone";
  }
  if (code === DISCORD_MISSING_PERMISSIONS || code === DISCORD_MISSING_ACCESS) {
    return "permission";
  }
  if (isRateLimitRejection(err)) return "not-sent";
  return "transient";
}

// ---------------------------------------------------------------------
// Ports (the database and Discord), replaceable in tests
// ---------------------------------------------------------------------

export interface BackupRow {
  eventId: string;
  memberId: string;
  original: string | null;
  base: string;
  /** The target of the latest edit (what the nickname should be now). */
  intended: string;
  /** Every nickname the bot has set or may have set, most recent last. */
  owned: string[];
  /** The target whose edit Discord confirmed; null while the latest is unconfirmed. */
  confirmedTarget: string | null;
  /** When the latest edit was started (ms since the epoch). */
  attemptedAt: number;
  /** Settled re-reads of this unresolved row that matched nothing we know. */
  mismatches: number;
}

export interface TagStore {
  readEvent(guildId: string, eventId: string): Promise<TagEventRow | null>;
  readBackup(guildId: string, memberId: string): Promise<BackupRow | null>;
  listBackups(guildId: string): Promise<BackupRow[]>;
  listBackupsOfEvent(guildId: string, eventId: string): Promise<BackupRow[]>;
  /** Active events with tags on (the sweep's apply candidates). */
  listTaggedEvents(guildId: string): Promise<TagEventRow[]>;
  /** Create the row if the member has none. "exists": someone else holds it. */
  claim(guildId: string, row: BackupRow): Promise<"claimed" | "exists">;
  /**
   * The target moves (a team move): APPEND `intended` to `owned` (everything
   * already there stays), clear the confirmation and stamp the attempt, while
   * the row still reads `row.intended`. Written BEFORE the edit.
   */
  advance(
    guildId: string,
    row: BackupRow,
    intended: string,
    attemptedAt: number,
  ): Promise<boolean>;
  /**
   * Stamp an attempt (a PATCH about to be dispatched) at the row's current
   * target and clear the confirmation, while the row still reads `row.intended`.
   */
  markAttempt(
    guildId: string,
    row: BackupRow,
    attemptedAt: number,
  ): Promise<boolean>;
  /**
   * Count one settled re-read of an UNRESOLVED row whose nickname matched
   * nothing we know, while the row still reads `row.intended`.
   */
  noteMismatch(guildId: string, row: BackupRow): Promise<boolean>;
  /**
   * The edit of `row.intended` is confirmed: record it, and the nickname Discord
   * reported (it can differ from what was sent) into `owned`.
   */
  confirm(
    guildId: string,
    row: BackupRow,
    shown: string | null,
  ): Promise<boolean>;
  /** Delete the row, only while it still reads as `row` was read. */
  drop(guildId: string, row: BackupRow): Promise<boolean>;
}

export interface MemberView {
  nickname: string | null;
  displayName: string;
  isOwner: boolean;
  /** The bot's top role is above the member's (and the member is not the owner). */
  manageable: boolean;
}

export interface TagDiscord {
  /** Fetched fresh from Discord (never the cache). "gone": not in the server. */
  fetchMember(guildId: string, userId: string): Promise<MemberView | "gone">;
  /** Whether the bot holds Manage Nicknames; null when that cannot be read. */
  canManageNicknames(guildId: string): Promise<boolean | null>;
  /** Set (or clear, with null) the server nickname; returns the nickname Discord now shows. */
  setNickname(
    guildId: string,
    userId: string,
    nickname: string | null,
  ): Promise<string | null>;
}

function rowOf(doc: unknown): BackupRow {
  const d = doc as Record<string, unknown>;
  return {
    eventId: String(d.eventId),
    memberId: String(d.memberId),
    original: typeof d.original === "string" ? d.original : null,
    base: typeof d.base === "string" ? d.base : "",
    intended: String(d.intended ?? ""),
    owned: Array.isArray(d.owned)
      ? d.owned.filter((n): n is string => typeof n === "string")
      : [],
    confirmedTarget:
      typeof d.confirmedTarget === "string" ? d.confirmedTarget : null,
    attemptedAt: d.attemptedAt ? new Date(d.attemptedAt as Date).getTime() : 0,
    mismatches: typeof d.mismatches === "number" ? d.mismatches : 0,
  };
}

function isDuplicateKey(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === 11000
  );
}

/** The real store: the Event model and the backup collection. */
export const mongoTagStore: TagStore = {
  async readEvent(guildId, eventId) {
    if (!/^[0-9a-f]{24}$/i.test(eventId)) return null;
    return (await Event.findOne({ _id: eventId, guildId })
      .select(
        "state tagsEnabled tagsSuffix groupsEnabled groups.key groups.kind groups.tag groups.memberIds",
      )
      .lean()) as TagEventRow | null;
  },
  async readBackup(guildId, memberId) {
    const doc = await EventNicknameBackup.findOne({ guildId, memberId }).lean();
    return doc ? rowOf(doc) : null;
  },
  async listBackups(guildId) {
    return (await EventNicknameBackup.find({ guildId }).lean()).map(rowOf);
  },
  async listBackupsOfEvent(guildId, eventId) {
    return (await EventNicknameBackup.find({ guildId, eventId }).lean()).map(
      rowOf,
    );
  },
  async listTaggedEvents(guildId) {
    return (await Event.find({
      guildId,
      state: "active",
      tagsEnabled: true,
      groupsEnabled: true,
    })
      .select(
        "state tagsEnabled tagsSuffix groupsEnabled groups.key groups.kind groups.tag groups.memberIds",
      )
      .lean()) as TagEventRow[];
  },
  async claim(guildId, row) {
    try {
      const result = await EventNicknameBackup.updateOne(
        { guildId, memberId: row.memberId },
        {
          $setOnInsert: {
            guildId,
            eventId: row.eventId,
            memberId: row.memberId,
            original: row.original,
            base: row.base,
            intended: row.intended,
            owned: row.owned,
            confirmedTarget: null,
            attemptedAt: new Date(row.attemptedAt),
            mismatches: 0,
          },
        },
        { upsert: true },
      );
      return (result?.upsertedCount ?? 0) === 1 ? "claimed" : "exists";
    } catch (err) {
      // Two claims for one member raced on the unique index: the other won.
      if (isDuplicateKey(err)) return "exists";
      throw err;
    }
  },
  async advance(guildId, row, intended, attemptedAt) {
    const result = await EventNicknameBackup.updateOne(
      {
        guildId,
        memberId: row.memberId,
        eventId: row.eventId,
        intended: row.intended,
      },
      {
        $set: {
          intended,
          confirmedTarget: null,
          attemptedAt: new Date(attemptedAt),
          mismatches: 0,
        },
        // Appended, never replaced: the earlier targets stay recognisable.
        $addToSet: { owned: intended },
      },
    );
    return (result?.matchedCount ?? 0) === 1;
  },
  async markAttempt(guildId, row, attemptedAt) {
    const result = await EventNicknameBackup.updateOne(
      {
        guildId,
        memberId: row.memberId,
        eventId: row.eventId,
        intended: row.intended,
      },
      // A new attempt is unconfirmed by definition.
      {
        $set: {
          attemptedAt: new Date(attemptedAt),
          confirmedTarget: null,
          mismatches: 0,
        },
      },
    );
    return (result?.matchedCount ?? 0) === 1;
  },
  async noteMismatch(guildId, row) {
    const result = await EventNicknameBackup.updateOne(
      {
        guildId,
        memberId: row.memberId,
        eventId: row.eventId,
        intended: row.intended,
      },
      { $inc: { mismatches: 1 } },
    );
    return (result?.matchedCount ?? 0) === 1;
  },
  async confirm(guildId, row, shown) {
    const result = await EventNicknameBackup.updateOne(
      {
        guildId,
        memberId: row.memberId,
        eventId: row.eventId,
        intended: row.intended,
      },
      {
        $set: { confirmedTarget: row.intended },
        ...(shown ? { $addToSet: { owned: shown } } : {}),
      },
    );
    return (result?.matchedCount ?? 0) === 1;
  },
  async drop(guildId, row) {
    const result = await EventNicknameBackup.deleteOne({
      guildId,
      memberId: row.memberId,
      eventId: row.eventId,
      intended: row.intended,
    });
    return (result?.deletedCount ?? 0) === 1;
  },
};

/** The real Discord side: REST through `CommandManager.makeDiscordApiCall`. */
export function createClientDiscord(client: Client): TagDiscord {
  const call = async <T>(
    fn: () => Promise<T>,
    name: string,
    attempts = 2,
  ): Promise<T> => {
    const { CommandManager } = await import("./command-manager.js");
    // Short timeout and one retry: a nickname edit is idempotent, and the
    // hook that restores nicknames has a 60 second budget.
    return CommandManager.getInstance(client).makeDiscordApiCall(
      fn,
      name,
      10000,
      attempts,
    );
  };
  // The edit goes through the write client: no automatic retries, and the
  // request is aborted when it times out (see `cancellableCall`).
  let writeRest: REST | null = null;
  const rest = (): REST => {
    if (!writeRest) {
      if (!client.token) throw new Error("The bot is not logged in");
      writeRest = createFailFastRest(client.token);
    }
    return writeRest;
  };
  const guildOf = async (guildId: string): Promise<Guild> =>
    client.guilds.cache.get(guildId) ??
    (await call(() => client.guilds.fetch(guildId), "fetch guild for tags"));
  const meOf = async (guildId: string): Promise<GuildMember> => {
    const guild = await guildOf(guildId);
    return (
      guild.members.me ??
      (await call(() => guild.members.fetchMe(), "fetch bot member for tags"))
    );
  };
  return {
    async fetchMember(guildId, userId): Promise<MemberView | "gone"> {
      const guild = await guildOf(guildId);
      // Make sure the bot's own member is known: `manageable` needs it.
      await meOf(guildId);
      try {
        // One attempt: the read must not have a retry budget of its own that
        // could use up the settle window before the PATCH is stamped and sent.
        const member = await call(
          () => guild.members.fetch({ user: userId, force: true }),
          "fetch member for tags",
          1,
        );
        return {
          nickname: member.nickname ?? null,
          displayName: member.displayName,
          isOwner: member.id === guild.ownerId,
          manageable: member.manageable,
        };
      } catch (err) {
        if (classifyDiscordFailure(err) === "gone") return "gone";
        throw err;
      }
    },
    async canManageNicknames(guildId): Promise<boolean | null> {
      try {
        const me = await meOf(guildId);
        return me.permissions.has(PermissionFlagsBits.ManageNicknames);
      } catch (err) {
        logger.warn("Could not read the bot's permissions for tags:", err);
        return null;
      }
    },
    async setNickname(guildId, userId, nickname): Promise<string | null> {
      const { CommandManager } = await import("./command-manager.js");
      // One PATCH, no fetch first (the caller has just read the member). Not
      // retried on a timeout: the request is aborted and the outcome stays
      // "unknown" in the backup row until it has settled.
      const updated = (await cancellableCall(
        CommandManager.getInstance(client),
        (signal) =>
          rest().patch(Routes.guildMember(guildId, userId), {
            body: { nick: nickname },
            reason: REASON,
            signal,
          }),
        "set nickname for tags",
        false,
        // One attempt: a rate limit is rejected, never slept on or retried here.
        1,
      )) as { nick?: string | null } | undefined;
      return updated?.nick ?? nickname;
    },
  };
}

// ---------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------

export type MemberOutcome =
  "none" | "tagged" | "retagged" | "restored" | "dropped" | "skipped" | "kept";

/** What the last passes could not do for an event (host panel, #1189). */
export interface TagReport {
  /** Members who are not tagged, with the reason (plain text, no names). */
  skipped: Array<{ userId: string; reason: string }>;
  warnings: string[];
}

export interface RestoreSummary {
  restored: number;
  /** Backups still held after the attempt (retried by the sweep). */
  kept: number;
  warnings: string[];
}

export interface TagDeps {
  store?: TagStore;
  discord?: TagDiscord;
  eventsEnabled?: () => Promise<boolean>;
  paceMs?: number;
  now?: () => number;
  /** Interval of the restore-only worker (tests). */
  retryMs?: number;
}

const memberLock = createKeyedLock();

/**
 * The one normalisation behind every comparison of a nickname read from Discord
 * with one the bot sent: Unicode NFC, trimmed, runs of whitespace collapsed to a
 * single space. Deliberately conservative: case is not folded and nothing else
 * is touched, so a deliberate edit is never mistaken for a spelling difference.
 */
export function normalizeNickname(name: string): string {
  return name.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** The same nickname, up to `normalizeNickname`. */
export function sameNickname(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return normalizeNickname(a) === normalizeNickname(b);
}

/** Whether a nickname read from Discord is one the bot has set or may have set. */
export function isOwnedNickname(
  row: Pick<BackupRow, "owned">,
  current: string | null,
): boolean {
  return current !== null && row.owned.some((o) => sameNickname(o, current));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RESTORE_PERMISSION_WARNING =
  "The bot does not have the Manage Nicknames permission, so nicknames could not be restored yet. Give the bot that permission; KoolBot keeps trying every minute.";
const WAITING_REASON =
  "Still carrying the tag of another event; tagged once that is restored.";

const MANAGE_NICKNAMES_WARNING =
  "The bot does not have the Manage Nicknames permission, so clan tags are not applied. Give the bot that permission and they will be applied within a minute.";

export class EventNicknameTags {
  private static instance: EventNicknameTags | undefined;
  private readonly store: TagStore;
  private readonly discord: TagDiscord;
  private readonly eventsEnabledFn: () => Promise<boolean>;
  private readonly paceMs: number;
  private readonly now: () => number;
  private slotChain: Promise<unknown> = Promise.resolve();
  private lastSlotEnd = 0;
  private readonly retryMs: number;
  /** The member the restore-only worker stopped at (rotating batches). */
  private restoreCursor = "";
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private readonly sweeps = new Map<
    "full" | "restore",
    Promise<{ attempted: number }>
  >();
  private readonly reports = new Map<
    string,
    { skipped: Map<string, string>; warnings: Set<string> }
  >();
  /** `${eventId}:${userId}` to the time before which the sweep leaves them be. */
  private readonly cooldowns = new Map<string, number>();

  constructor(
    private readonly client: Client,
    deps: TagDeps = {},
  ) {
    this.store = deps.store ?? mongoTagStore;
    this.discord = deps.discord ?? createClientDiscord(client);
    this.eventsEnabledFn =
      deps.eventsEnabled ??
      (async (): Promise<boolean> => {
        try {
          return await ConfigService.getInstance().getBoolean(
            "events.enabled",
            false,
          );
        } catch (err) {
          logger.warn("Could not read events.enabled for event tags:", err);
          return false;
        }
      });
    this.paceMs = deps.paceMs ?? NICKNAME_PACE_MS;
    this.now = deps.now ?? Date.now;
    this.retryMs = deps.retryMs ?? RESTORE_RETRY_MS;
  }

  public static getInstance(client: Client): EventNicknameTags {
    if (!EventNicknameTags.instance) {
      EventNicknameTags.instance = new EventNicknameTags(client);
    }
    return EventNicknameTags.instance;
  }

  public static reset(): void {
    EventNicknameTags.instance = undefined;
  }

  /** Tests: make `instance` the one `getInstance` returns. */
  public static setInstanceForTests(instance: EventNicknameTags): void {
    EventNicknameTags.instance = instance;
  }

  // ---- report -------------------------------------------------------

  private report(eventId: string): {
    skipped: Map<string, string>;
    warnings: Set<string>;
  } {
    let r = this.reports.get(eventId);
    if (!r) {
      r = { skipped: new Map(), warnings: new Set() };
      this.reports.set(eventId, r);
    }
    return r;
  }

  private skip(
    eventId: string,
    userId: string,
    reason: string,
    cooldown = true,
  ): void {
    this.report(eventId).skipped.set(userId, reason);
    if (cooldown) {
      this.cooldowns.set(`${eventId}:${userId}`, this.now() + SKIP_COOLDOWN_MS);
    }
  }

  /**
   * Record that a PATCH is about to be dispatched (after the pacing queue):
   * a conditional write on the row decided from. Null when the row changed
   * meanwhile, in which case nothing is sent.
   */
  private async stampDispatch(
    guildId: string,
    row: BackupRow,
  ): Promise<BackupRow | null> {
    const at = this.now();
    if (!(await this.store.markAttempt(guildId, row, at))) return null;
    return { ...row, confirmedTarget: null, attemptedAt: at };
  }

  private clearSkip(eventId: string, userId: string): void {
    this.reports.get(eventId)?.skipped.delete(userId);
    this.cooldowns.delete(`${eventId}:${userId}`);
  }

  /**
   * Forget everything held in memory about one member (a data reset, an
   * unassignment): their entry in every event's skipped list and their sweep
   * cooldowns. It is keyed by user id, so it is user data too.
   */
  public forgetMemberInMemory(userId: string): void {
    for (const r of this.reports.values()) r.skipped.delete(userId);
    for (const key of [...this.cooldowns.keys()]) {
      if (key.endsWith(`:${userId}`)) this.cooldowns.delete(key);
    }
  }

  /**
   * A nickname that is neither owned (after normalisation) nor the original.
   * On a CONFIRMED row that is the member's own rename. On an UNRESOLVED row it
   * is ambiguous (a rename, or a spelling Discord changed that we do not know):
   * the row is kept and the re-read counted, and only after a few settled reads
   * (or a day) is it taken for a rename. "wait": keep the row, change nothing.
   */
  private async mismatchVerdict(
    guildId: string,
    row: BackupRow,
  ): Promise<"wait" | "rename"> {
    if (!this.unresolved(row)) return "rename";
    if (
      row.attemptedAt > 0 &&
      this.now() - row.attemptedAt >= MISMATCH_MAX_AGE_MS
    ) {
      return "rename";
    }
    if (row.mismatches + 1 >= MISMATCH_READS_BEFORE_RENAME) return "rename";
    await this.store.noteMismatch(guildId, row);
    return "wait";
  }

  /**
   * The tag the member should carry according to a FRESH read, or null. Used
   * after a pacing wait, which can be long enough for the answer to change.
   */
  private async wantsNow(
    guildId: string,
    eventId: string,
    userId: string,
  ): Promise<WantedTag | null> {
    const want = wantedTag(
      await this.store.readEvent(guildId, eventId),
      userId,
    );
    if (want && !(await this.eventsEnabledFn())) return null;
    return want;
  }

  /** The latest edit of this row has not been confirmed (its outcome is unknown). */
  private unresolved(row: BackupRow): boolean {
    return row.confirmedTarget !== row.intended;
  }

  /** Unresolved and recent enough that the edit may still be in flight. */
  private settling(row: BackupRow): boolean {
    return (
      this.unresolved(row) && this.now() - row.attemptedAt < OUTCOME_SETTLE_MS
    );
  }

  /** What the passes could not do for an event; null when nothing is recorded. */
  public getReport(eventId: string): TagReport | null {
    const r = this.reports.get(eventId);
    if (!r || (r.skipped.size === 0 && r.warnings.size === 0)) return null;
    return {
      skipped: [...r.skipped].map(([userId, reason]) => ({ userId, reason })),
      warnings: [...r.warnings],
    };
  }

  private coolingDown(eventId: string, userId: string): boolean {
    const until = this.cooldowns.get(`${eventId}:${userId}`);
    if (until === undefined) return false;
    if (until <= this.now()) {
      this.cooldowns.delete(`${eventId}:${userId}`);
      return false;
    }
    return true;
  }

  // ---- pacing -------------------------------------------------------

  /**
   * The SLOT: one shared serial queue for the work from a fresh nickname read
   * through its PATCH. A job starts `paceMs` after the previous one ended (the
   * wait is in front of the read), and jobs never overlap, so PATCHes cannot
   * burst. `work` must not call `slot` again.
   */
  private slot<T>(work: () => Promise<T>): Promise<T> {
    const job = this.slotChain
      .catch(() => undefined)
      .then(async () => {
        if (this.paceMs > 0) {
          const wait = this.lastSlotEnd + this.paceMs - Date.now();
          if (wait > 0) await sleep(wait);
        }
        try {
          return await work();
        } finally {
          this.lastSlotEnd = Date.now();
        }
      });
    this.slotChain = job.catch(() => undefined);
    return job;
  }

  // ---- the decision -------------------------------------------------

  /**
   * Bring one member's nickname in line with what the stored event wants NOW.
   * `admission` is the `TrackingOptOutService.admission()` ticket the caller
   * took before its first await; with it, a tag is not applied to a member whose
   * data reset is running (or ran since).
   */
  public syncMember(opts: {
    guildId: string;
    eventId: string;
    userId: string;
    admission?: number;
  }): Promise<MemberOutcome> {
    const { guildId, userId } = opts;
    return memberLock.run(`${guildId}:${userId}`, () => this.syncLocked(opts));
  }

  private async syncLocked(opts: {
    guildId: string;
    eventId: string;
    userId: string;
    admission?: number;
  }): Promise<MemberOutcome> {
    const { guildId, eventId, userId } = opts;
    const [event, backup] = await Promise.all([
      this.store.readEvent(guildId, eventId),
      this.store.readBackup(guildId, userId),
    ]);
    const ours = backup && backup.eventId === eventId ? backup : null;
    const foreign = backup !== null && ours === null;

    let want = wantedTag(event, userId);
    if (want && !(await this.eventsEnabledFn())) want = null;
    // A tag that cannot be built (no base, a tag too long) is not wanted.
    if (want && ours) {
      if (!buildTaggedName(ours.base, want.tag, want.suffix)) want = null;
    }

    if (!ours) {
      if (!want) {
        // Not (or no longer) in a tagged team: nothing to report about them.
        this.clearSkip(eventId, userId);
        return "none";
      }
      if (foreign) {
        this.skip(eventId, userId, WAITING_REASON, false);
        return "skipped";
      }
      return this.applyFresh(opts, want, null);
    }

    if (!want) {
      return this.restoreRow(guildId, ours, eventId);
    }

    const desired = buildTaggedName(ours.base, want.tag, want.suffix) as string;
    // Only a CONFIRMED edit of exactly this target is "already done".
    if (ours.confirmedTarget === desired && ours.intended === desired) {
      return "none";
    }
    return this.retargetRow(opts, ours, want, desired);
  }

  /** The member has a row that is unconfirmed, or points at another tag. */
  private async retargetRow(
    opts: {
      guildId: string;
      eventId: string;
      userId: string;
      admission?: number;
    },
    row: BackupRow,
    want: WantedTag,
    desired: string,
  ): Promise<MemberOutcome> {
    // An earlier edit may still be in flight: nothing is decided until it has
    // settled (otherwise a late PATCH could land after this decision).
    if (this.settling(row)) return "kept";
    // Queue FIRST, read after: the wait can be long, so a change the member
    // makes meanwhile is seen by the read below, and "is this tag still wanted"
    // is decided again from a fresh read of the event.
    return this.slot(() => this.retargetSegment(opts, row, want, desired));
  }

  /** Runs inside the slot: fresh reads through the PATCH. */
  private async retargetSegment(
    opts: {
      guildId: string;
      eventId: string;
      userId: string;
      admission?: number;
    },
    row: BackupRow,
    want: WantedTag,
    desired: string,
  ): Promise<MemberOutcome> {
    const { guildId, eventId, userId } = opts;
    const now = await this.wantsNow(guildId, eventId, userId);
    if (!now || buildTaggedName(row.base, now.tag, now.suffix) !== desired) {
      return "none"; // the next pass decides again
    }
    let member: MemberView | "gone";
    try {
      member = await this.discord.fetchMember(guildId, userId);
    } catch (err) {
      return this.keepAfterFailure(eventId, userId, err, "read the member");
    }
    if (member === "gone") {
      await this.store.drop(guildId, row);
      this.clearSkip(eventId, userId);
      return "dropped";
    }
    const current = member.nickname;
    const owned = isOwnedNickname(row, current);
    const atOriginal = current === row.original;
    if (!owned && !atOriginal) {
      if ((await this.mismatchVerdict(guildId, row)) === "wait") return "kept";
      // The member changed their nickname themselves: leave it, drop the old
      // backup, and tag the new name from scratch (participants cannot opt out).
      await this.store.drop(guildId, row);
      return this.applyFresh(opts, want, member);
    }
    // ONE conditional write between the read and the PATCH: it records the new
    // target (every earlier target stays in `owned`) or stamps the attempt, and
    // either way clears the confirmation.
    let working = row;
    if (row.intended !== desired) {
      if (!(await this.store.advance(guildId, row, desired, this.now()))) {
        return "none";
      }
      working = {
        ...row,
        intended: desired,
        owned: row.owned.includes(desired)
          ? row.owned
          : [...row.owned, desired],
        confirmedTarget: null,
        attemptedAt: this.now(),
      };
    } else if (!sameNickname(current, desired)) {
      const sent = await this.stampDispatch(guildId, row);
      if (!sent) return "none";
      working = sent;
    }
    if (sameNickname(current, desired)) {
      // Already shows the wanted name (an edit that landed unconfirmed).
      await this.store.confirm(guildId, working, current);
      this.clearSkip(eventId, userId);
      return "none";
    }
    try {
      const shown = await this.discord.setNickname(guildId, userId, desired);
      await this.store.confirm(guildId, working, shown);
      this.clearSkip(eventId, userId);
      return "retagged";
    } catch (err) {
      // Nothing of ours was on the nickname before this edit (it still showed
      // the original), so an outright refusal changed nothing.
      return this.afterFailedApplyEdit(
        guildId,
        working,
        eventId,
        userId,
        err,
        !owned,
      );
    }
  }

  /** Tag a member who has no backup. `known` is a member just fetched fresh, if any. */
  private async applyFresh(
    opts: {
      guildId: string;
      eventId: string;
      userId: string;
      admission?: number;
    },
    want: WantedTag,
    known: MemberView | null,
  ): Promise<MemberOutcome> {
    const { guildId, eventId } = opts;
    const can = await this.discord.canManageNicknames(guildId);
    if (can === false) {
      this.report(eventId).warnings.add(MANAGE_NICKNAMES_WARNING);
      return "skipped";
    }
    if (can === true)
      this.report(eventId).warnings.delete(MANAGE_NICKNAMES_WARNING);
    // Queue FIRST, read after: a change made while waiting is seen. A member
    // handed in by `retargetSegment` was read a moment ago inside the slot.
    if (known) return this.applySegment(opts, want, known);
    return this.slot(() => this.applySegment(opts, want, null));
  }

  /** Runs inside the slot: fresh read through the PATCH. */
  private async applySegment(
    opts: {
      guildId: string;
      eventId: string;
      userId: string;
      admission?: number;
    },
    want: WantedTag,
    known: MemberView | null,
  ): Promise<MemberOutcome> {
    const { guildId, eventId, userId } = opts;
    let member: MemberView | "gone";
    if (known) {
      member = known;
    } else {
      try {
        member = await this.discord.fetchMember(guildId, userId);
      } catch (err) {
        logger.warn(
          `Event tags: could not read member ${sanitizeForLog(userId)}:`,
          err,
        );
        return "skipped";
      }
    }
    if (member === "gone") return "none";
    if (member.isOwner) {
      this.skip(
        eventId,
        userId,
        "The server owner's nickname cannot be changed by a bot.",
      );
      return "skipped";
    }
    if (!member.manageable) {
      this.skip(
        eventId,
        userId,
        "Their highest role is at or above the bot's role, so the bot cannot change their nickname.",
      );
      return "skipped";
    }
    const original = member.nickname;
    const base = original ?? member.displayName;
    const intended = buildTaggedName(base, want.tag, want.suffix);
    if (!intended) {
      this.skip(eventId, userId, "The tag does not fit in a nickname.");
      return "skipped";
    }
    if (original === intended) {
      // Already shows exactly the tagged name (set by hand): nothing to do and
      // nothing to restore to.
      return "none";
    }

    const row: BackupRow = {
      eventId,
      memberId: userId,
      original,
      base,
      intended,
      owned: [intended],
      confirmedTarget: null,
      attemptedAt: this.now(),
      mismatches: 0,
    };
    // The backup is written BEFORE the edit. A member whose data reset runs (or
    // ran since the caller's ticket) is not tagged: the barrier does not run the
    // write at all, and `claimed` stays "exists".
    let claimed: "claimed" | "exists" = "exists";
    if (opts.admission !== undefined) {
      await TrackingOptOutService.getInstance().resetAwareWrite(
        [userId],
        guildId,
        async () => {
          claimed = await this.store.claim(guildId, row);
        },
        opts.admission,
      );
    } else {
      claimed = await this.store.claim(guildId, row);
    }
    if (claimed === "exists") {
      // Another claim got there first (another event's, or a retry of ours), or
      // a data reset is running; the next pass reads the row and decides.
      return "none";
    }

    // Invariant 5: look again now that the row is there.
    const event2 = await this.store.readEvent(guildId, eventId);
    let still = wantedTag(event2, userId);
    if (still && !(await this.eventsEnabledFn())) still = null;
    if (!still || buildTaggedName(base, still.tag, still.suffix) !== intended) {
      // No longer wanted (or the tag changed): nothing was edited yet, so the
      // row is simply dropped; a later pass applies whatever is wanted then.
      await this.store.drop(guildId, row);
      return "none";
    }

    // The attempt is stamped now, in the same step as the dispatch (the claim
    // carried the time of the read; the re-check above may have taken a while).
    const sent = await this.stampDispatch(guildId, row);
    if (!sent) return "none";
    try {
      const shown = await this.discord.setNickname(guildId, userId, intended);
      await this.store.confirm(guildId, sent, shown);
      this.clearSkip(eventId, userId);
      return "tagged";
    } catch (err) {
      return this.afterFailedApplyEdit(
        guildId,
        sent,
        eventId,
        userId,
        err,
        true,
      );
    }
  }

  /**
   * An edit that was meant to TAG failed. `nothingApplied`: the nickname did
   * not carry anything of ours before this edit, so an outright refusal leaves
   * it as it was and the backup can go; otherwise the row is kept for the
   * restore. An unknown outcome (timeout, lost connection) always keeps the row.
   */
  private async afterFailedApplyEdit(
    guildId: string,
    row: BackupRow,
    eventId: string,
    userId: string,
    err: unknown,
    nothingApplied: boolean,
  ): Promise<MemberOutcome> {
    const kind = classifyDiscordFailure(err);
    if (kind === "gone") {
      await this.store.drop(guildId, row);
      return "dropped";
    }
    if (kind === "not-sent") {
      // Rate-limited: the request never left. The attempt counts as settled
      // again and the row stays; a later pass starts from a fresh read.
      await this.store.markAttempt(guildId, row, 0);
      return this.keepAfterFailure(eventId, userId, err, "send the nickname");
    }
    if (kind === "permission") {
      // Discord refused outright: nothing changed by this edit.
      if (nothingApplied) await this.store.drop(guildId, row);
      this.skip(
        eventId,
        userId,
        "Discord refused to change their nickname (missing permission).",
      );
      return "skipped";
    }
    return this.keepAfterFailure(eventId, userId, err, "set the nickname");
  }

  private keepAfterFailure(
    eventId: string,
    userId: string,
    err: unknown,
    what: string,
  ): MemberOutcome {
    logger.warn(
      `Event tags: could not ${what} of ${sanitizeForLog(userId)} (event ${sanitizeForLog(eventId)}); the backup is kept and this is retried:`,
      err,
    );
    return "kept";
  }

  /**
   * Put one member's nickname back (the tag is no longer wanted). Deletes the
   * row only after the edit is confirmed, or a fresh read shows nothing of ours
   * on the nickname; never while an earlier edit may still be in flight.
   */
  private async restoreRow(
    guildId: string,
    row: BackupRow,
    eventId: string,
  ): Promise<MemberOutcome> {
    // An unconfirmed edit may still land: resolve it by a read after it settled.
    if (this.settling(row)) return "kept";
    const can = await this.discord.canManageNicknames(guildId);
    if (can === false) {
      this.report(eventId).warnings.add(RESTORE_PERMISSION_WARNING);
      return "kept";
    }
    if (can === true) {
      this.report(eventId).warnings.delete(RESTORE_PERMISSION_WARNING);
    }
    // Queue FIRST (a member's change during the wait must be seen): inside the
    // slot the member is read, classified, the attempt is stamped (unresolved,
    // so a lost response never leaves the old tag marked as confirmed) and the
    // PATCH is sent.
    return this.slot(() => this.restoreSegment(guildId, row, eventId));
  }

  /** Runs inside the slot: fresh read, classify, stamp, PATCH. */
  private async restoreSegment(
    guildId: string,
    row: BackupRow,
    eventId: string,
  ): Promise<MemberOutcome> {
    const userId = row.memberId;
    let member: MemberView | "gone";
    try {
      member = await this.discord.fetchMember(guildId, userId);
    } catch (err) {
      return this.keepAfterFailure(eventId, userId, err, "read the member");
    }
    if (member === "gone") {
      await this.store.drop(guildId, row);
      this.clearSkip(eventId, userId);
      return "dropped";
    }
    const current = member.nickname;
    const ownedNow = isOwnedNickname(row, current);
    if (!ownedNow && current !== row.original) {
      if ((await this.mismatchVerdict(guildId, row)) === "wait") return "kept";
    }
    if (!ownedNow || current === row.original) {
      // The member changed it themselves, or an edit never landed: nothing of
      // ours is on the nickname. Leave it, drop the backup.
      await this.store.drop(guildId, row);
      this.clearSkip(eventId, userId);
      return "dropped";
    }
    // Unresolved from here on, stamped in the same step as the dispatch: a slow
    // read above cannot use up the settle window before the PATCH is sent.
    const sent = await this.stampDispatch(guildId, row);
    if (!sent) return "kept";
    // The PATCH was refused or never left: put the row back as it was, so a
    // restore that did not happen does not leave a confirmed tag "unresolved".
    const unsend = (): Promise<boolean> =>
      row.confirmedTarget === row.intended
        ? this.store.confirm(guildId, sent, null)
        : this.store.markAttempt(guildId, sent, 0);
    try {
      await this.discord.setNickname(guildId, userId, row.original);
    } catch (err) {
      const kind = classifyDiscordFailure(err);
      if (kind === "gone") {
        await this.store.drop(guildId, sent);
        return "dropped";
      }
      if (kind === "not-sent") {
        // Rate-limited: the PATCH never left; a later pass reads again.
        await unsend();
        return this.keepAfterFailure(eventId, userId, err, "send the restore");
      }
      if (kind === "permission") {
        // Refused outright: this PATCH is known not to be in flight, and the
        // row was confirmed or already settled before it, so the attempt counts
        // as settled again (the confirmation stays cleared: the next pass reads
        // the nickname again and decides).
        await unsend();
        this.skip(
          eventId,
          userId,
          "Their nickname could not be restored (missing permission); KoolBot keeps trying.",
        );
        return "kept";
      }
      // Unknown outcome: the row stays; the next read finds the nickname still
      // ours (retry) or back at the original (drop).
      return this.keepAfterFailure(
        eventId,
        userId,
        err,
        "restore the nickname",
      );
    }
    await this.store.drop(guildId, sent);
    this.clearSkip(eventId, userId);
    return "restored";
  }

  // ---- triggers -----------------------------------------------------

  /**
   * Restore every backup of an event (end hook, cancel, group channel cleanup).
   * Whatever is not restored stays as a row and is finished by the sweep.
   */
  public async restoreEvent(
    guildId: string,
    eventId: string,
  ): Promise<RestoreSummary> {
    const rows = await this.store.listBackupsOfEvent(guildId, eventId);
    let restored = 0;
    for (const row of rows) {
      try {
        const outcome = await this.syncMember({
          guildId,
          eventId,
          userId: row.memberId,
        });
        if (outcome === "restored" || outcome === "dropped") restored += 1;
      } catch (err) {
        logger.error(
          `Event tags: restoring ${sanitizeForLog(row.memberId)} of event ${sanitizeForLog(eventId)} failed:`,
          err,
        );
      }
    }
    const left = await this.store.listBackupsOfEvent(guildId, eventId);
    const warnings: string[] = [];
    if (left.length === 0) {
      // Nothing is owed any more: the restore warning no longer applies.
      this.reports.get(eventId)?.warnings.delete(RESTORE_PERMISSION_WARNING);
    }
    if (left.length > 0) {
      warnings.push(
        `${left.length} nickname${left.length === 1 ? "" : "s"} could not be restored yet. KoolBot keeps the original${left.length === 1 ? "" : "s"} and tries again every minute.`,
      );
    }
    for (const w of this.reports.get(eventId)?.warnings ?? []) {
      if (!warnings.includes(w)) warnings.push(w);
    }
    return { restored, kept: left.length, warnings };
  }

  /**
   * Bring every member of an event in line (event goes active, startup): the
   * members of its team groups and everyone who still has a backup of it.
   */
  public async syncEvent(guildId: string, eventId: string): Promise<void> {
    const [event, backups] = await Promise.all([
      this.store.readEvent(guildId, eventId),
      this.store.listBackupsOfEvent(guildId, eventId),
    ]);
    const ids = new Set<string>(backups.map((b) => b.memberId));
    if (event && wantedTagEvent(event)) {
      for (const g of event.groups ?? []) {
        if (g.kind !== "team" || !(g.tag ?? "").trim()) continue;
        for (const m of g.memberIds ?? []) ids.add(m);
      }
    }
    for (const userId of ids) {
      try {
        await this.syncMember({
          guildId,
          eventId,
          userId,
          admission: TrackingOptOutService.getInstance().admission(),
        });
      } catch (err) {
        logger.error(
          `Event tags: syncing ${sanitizeForLog(userId)} of event ${sanitizeForLog(eventId)} failed:`,
          err,
        );
      }
    }
  }

  /**
   * Ask for a full pass (restore and tag) without waiting for it: what the
   * Events scan calls. One pass runs at a time; a request while one is running
   * joins it. Errors are logged, never thrown.
   */
  public requestSweep(guildId: string): void {
    void this.sweep(guildId).catch((err: unknown) =>
      logger.error("Event nickname tag sweep failed:", err),
    );
  }

  /**
   * One pass: restore backups whose event is no longer running, finish pending
   * ones, and (unless `restoreOnly`) tag team members of a running event who
   * have no tag yet. Works from ids; every decision is re-read inside
   * `syncMember`. Single-flight per mode: a call while the same mode is running
   * returns that run.
   *
   * `restoreOnly` is the worker's pass: bounded to `RESTORE_BATCH_MAX` members,
   * it never applies a tag and leaves alone every member whose tag is still
   * wanted (the full pass owns those).
   */
  public sweep(
    guildId: string,
    opts: { restoreOnly?: boolean } = {},
  ): Promise<{ attempted: number }> {
    const mode = opts.restoreOnly ? "restore" : "full";
    const running = this.sweeps.get(mode);
    if (running) return running;
    const run = this.sweepOnce(guildId, opts.restoreOnly === true).finally(
      () => {
        this.sweeps.delete(mode);
      },
    );
    this.sweeps.set(mode, run);
    return run;
  }

  private async sweepOnce(
    guildId: string,
    restoreOnly: boolean,
  ): Promise<{ attempted: number }> {
    const [backups, events] = await Promise.all([
      this.store.listBackups(guildId),
      restoreOnly
        ? Promise.resolve([] as TagEventRow[])
        : this.store.listTaggedEvents(guildId),
    ]);
    // Applying is gated on events.enabled (restoring never is): with Events off
    // nothing is wanted, so a restart restores the tags of a running event too.
    const eventsOn = await this.eventsEnabledFn();
    let eventById = new Map(events.map((e) => [String(e._id), e]));
    if (restoreOnly && eventsOn) {
      // The worker must not restore a tag that is still wanted: read the events
      // its backups belong to.
      const running = await this.store.listTaggedEvents(guildId);
      eventById = new Map(running.map((e) => [String(e._id), e]));
    }
    const backupOf = new Map(backups.map((b) => [b.memberId, b]));
    // A restore warning of an event that owes nothing any more is stale.
    const owing = new Set(backups.map((b) => b.eventId));
    for (const [eventId, r] of this.reports) {
      if (!owing.has(eventId)) r.warnings.delete(RESTORE_PERMISSION_WARNING);
    }
    // The permission is checked once per pass, whether or not anyone needs an
    // edit: a revoked Manage Nicknames must reach the host panel of every
    // running tagged event (and of every event that owes a restore), and the
    // warning clears when it is back.
    if (backups.length > 0 || (eventsOn && events.length > 0)) {
      const can = await this.discord.canManageNicknames(guildId);
      if (can !== null) {
        if (eventsOn) {
          for (const ev of events) {
            const w = this.report(String(ev._id)).warnings;
            if (can) w.delete(MANAGE_NICKNAMES_WARNING);
            else w.add(MANAGE_NICKNAMES_WARNING);
          }
        }
        for (const eventId of owing) {
          const w = this.report(eventId).warnings;
          if (can) w.delete(RESTORE_PERMISSION_WARNING);
          else w.add(RESTORE_PERMISSION_WARNING);
        }
      }
    }
    // member to the event and whether the job TAGS (and so honours the cooldown)
    const jobs = new Map<string, { eventId: string; applying: boolean }>();
    // Members whose tag waits for another event's restore: explained on the host
    // panel by `syncMember` (under the member lock, from fresh reads), never by
    // a write from this snapshot.
    const waiting: Array<{ userId: string; eventId: string }> = [];

    for (const b of backups) {
      const ev = eventById.get(b.eventId);
      const want = ev && eventsOn ? wantedTag(ev, b.memberId) : null;
      const desired = want
        ? buildTaggedName(b.base, want.tag, want.suffix)
        : null;
      // Already confirmed and still exactly right: nothing to do, no calls.
      if (
        want &&
        desired &&
        b.confirmedTarget === desired &&
        b.intended === desired
      ) {
        continue;
      }
      // The restore-only worker never touches a member whose tag is wanted.
      if (restoreOnly && want) continue;
      jobs.set(b.memberId, { eventId: b.eventId, applying: want !== null });
    }
    if (!restoreOnly) {
      for (const ev of eventsOn ? events : []) {
        const eventId = String(ev._id);
        for (const g of ev.groups ?? []) {
          if (g.kind !== "team" || !(g.tag ?? "").trim()) continue;
          for (const m of g.memberIds ?? []) {
            const held = backupOf.get(m);
            if (held && held.eventId !== eventId) {
              // Another event's tag: explained through `syncMember` below.
              waiting.push({ userId: m, eventId });
              continue;
            }
            if (!jobs.has(m) && !held) {
              jobs.set(m, { eventId, applying: true });
            }
          }
        }
      }
    }

    // The restore-only worker works through the jobs in a rotating order: it
    // starts after the member it stopped at, so members whose restore keeps
    // failing cannot use up every batch and starve the ones that could be done.
    let order = [...jobs.entries()];
    if (restoreOnly) {
      order.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      const at = order.findIndex(([id]) => id > this.restoreCursor);
      if (at > 0) order = [...order.slice(at), ...order.slice(0, at)];
    }
    let attempted = 0;
    let last: string | null = null;
    for (const [userId, job] of order) {
      if (restoreOnly && attempted >= RESTORE_BATCH_MAX) break;
      // The cooldown is for TAGGING only: a restore is retried on every pass.
      if (job.applying && this.coolingDown(job.eventId, userId)) continue;
      attempted += 1;
      last = userId;
      try {
        await this.syncMember({
          guildId,
          eventId: job.eventId,
          userId,
          admission: TrackingOptOutService.getInstance().admission(),
        });
      } catch (err) {
        logger.error(
          `Event tags: sweep of ${sanitizeForLog(userId)} (event ${sanitizeForLog(job.eventId)}) failed:`,
          err,
        );
      }
    }
    for (const w of waiting) {
      try {
        await this.syncMember({
          guildId,
          eventId: w.eventId,
          userId: w.userId,
          admission: TrackingOptOutService.getInstance().admission(),
        });
      } catch (err) {
        logger.error(
          `Event tags: sweep of ${sanitizeForLog(w.userId)} (event ${sanitizeForLog(w.eventId)}) failed:`,
          err,
        );
      }
    }
    if (restoreOnly)
      this.restoreCursor = order.length > attempted && last ? last : "";
    return { attempted };
  }

  /**
   * Start the restore-only worker: every `RESTORE_RETRY_MS`, whether or not
   * `events.enabled` is on, finish the backups that are owed (a restart inside
   * the settle window, a refused or failed restore). It never applies a tag.
   * Idempotent; `destroy()` stops it. Errors are logged, never thrown.
   */
  public startWorker(guildId: string): void {
    if (this.retryTimer) return;
    this.retryTimer = setInterval(() => {
      void this.sweep(guildId, { restoreOnly: true }).catch((err: unknown) =>
        logger.error("Event nickname tag restore retry failed:", err),
      );
    }, this.retryMs);
    this.retryTimer.unref?.();
  }

  /** Stop the worker (shutdown). */
  public destroy(): void {
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.retryTimer = null;
  }

  /**
   * Startup reconcile: once the gateway is ready, restore every backup that
   * belongs to an ended, cancelled or missing event (and finish pending ones),
   * so a crash cannot leave tags behind, then start the restore worker.
   */
  public async reconcileOnStartup(): Promise<void> {
    await waitForClientReady(this.client, "Event nickname tags");
    let guildId = "";
    try {
      guildId = await ConfigService.getInstance().getString("GUILD_ID", "");
    } catch (err) {
      logger.warn(
        "Event tags: could not read GUILD_ID for the reconcile:",
        err,
      );
    }
    if (!guildId) return;
    this.startWorker(guildId);
    const { attempted } = await this.sweep(guildId);
    if (attempted > 0) {
      logger.info(
        `Event tags: startup reconcile looked at ${attempted} member(s)`,
      );
    }
  }

  /**
   * Member data reset: put the member's nickname back (whatever event holds
   * the backup) and delete the row. If the nickname cannot be restored the
   * row is deleted anyway (the reset owes the erasure) and the shortfall is
   * counted in `failed`: the tag may remain on their nickname.
   */
  public restoreForMember(
    guildId: string,
    userId: string,
  ): Promise<{ matched: number; removed: number; failed: number }> {
    return memberLock.run(`${guildId}:${userId}`, async () => {
      try {
        const row = await this.store.readBackup(guildId, userId);
        if (!row) return { matched: 0, removed: 0, failed: 0 };
        let outcome: MemberOutcome = "kept";
        try {
          outcome = await this.restoreRow(guildId, row, row.eventId);
        } catch (err) {
          logger.error(
            `Event tags: restoring ${sanitizeForLog(userId)} for a data reset failed:`,
            err,
          );
        }
        if (outcome === "restored" || outcome === "dropped") {
          return { matched: 1, removed: 1, failed: 0 };
        }
        const dropped = await this.store.drop(guildId, row);
        return { matched: 1, removed: dropped ? 1 : 0, failed: 1 };
      } finally {
        // Whatever happened (no row, a failed restore): the in-memory skipped
        // entry and cooldown of this member are user data too.
        this.forgetMemberInMemory(userId);
      }
    });
  }
}

function wantedTagEvent(event: TagEventRow): boolean {
  return (
    event.state === "active" &&
    event.tagsEnabled === true &&
    event.groupsEnabled === true
  );
}

// ---------------------------------------------------------------------
// Wiring (called once at startup from src/index.ts)
// ---------------------------------------------------------------------

let installed: (() => void) | null = null;

/**
 * Subscribe the tags to what drives them: every assignment change (host, self
 * join, randomise, member data reset) and the end of an event. Idempotent.
 * Returns the unsubscribe function (tests).
 */
export function installEventNicknameTags(client: Client): () => void {
  if (installed) return installed;
  const tags = EventNicknameTags.getInstance(client);
  const offAssign = onGroupAssignmentChange((change) => {
    // The ticket is taken before the first await, like every reset-aware write.
    const admission = TrackingOptOutService.getInstance().admission();
    return tags
      .syncMember({
        guildId: change.guildId,
        eventId: change.eventId,
        userId: change.userId,
        admission,
      })
      .then(() => undefined);
  });
  const offHook = registerEventEndHook(TAGS_END_HOOK, async (ctx) => {
    const summary = await tags.restoreEvent(ctx.guildId, ctx.eventId);
    return summary.warnings;
  });
  installed = (): void => {
    offAssign();
    offHook();
    installed = null;
  };
  return installed;
}
