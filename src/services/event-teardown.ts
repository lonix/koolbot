/**
 * The one teardown of an ending event (#1193). "End event now" (host panel and
 * admin Events list) and the scheduled end (`EventService.processEvent`) both
 * run `EventTeardown.run`; nothing else ends an event.
 *
 * ## Order, and why it is not the order of the issue's list
 *
 * 1. **Claim.** The event is saved as `ended` (with `endedAt`) by one atomic
 *    update that only matches an event still in an allowed state. Whoever wins
 *    runs the rest; everyone else gets "already ended" (idempotency, also
 *    between a double click, two admins and the scan). The issue lists "mark
 *    ended" third; it is first here because
 *    - it is the claim that makes the teardown run once,
 *    - from here on host actions, assignment writes and self-join refuse the
 *      event, so nothing re-assigns, re-tags or re-moves people while the later
 *      steps run, and
 *    - #1213 (`cleanupGroupChannels` acts only on an event it reads back as
 *      ended) and #1221 (`moveEventMembers` with `allowFinished`) are written
 *      for it.
 *    If the claim cannot be saved nothing else happens.
 * 2. The announcement post is refreshed (it no longer shows a running event).
 * 3. **Pull back** (manual end, when asked): everyone connected to a group
 *    channel goes to the main channel, through `moveEventMembers`. Nobody is
 *    left out, the host included.
 * 4. **End-of-event hooks** (`event-end-hooks.ts`; none registered yet).
 * 5. **Group channels** are deleted now (`EventGroupChannels.cleanup`: empty
 *    ones only; an occupied one stays and the scan retries it every minute).
 *    The **main channel** stays until `events.channel_grace_minutes` after
 *    `endedAt`; the scan removes it (existing behaviour).
 * 6. **Per-user data**: group leaders (`captainId`) are cleared; assignments
 *    (`memberIds`) stay as history by owner decision.
 * 7. **Native event** is closed out the way the scheduled end does it
 *    (`NativeEventSync.syncEvent`); on the scheduled path the scan's own sync
 *    right after this call does that.
 *
 * Every step after the claim is attempted whatever the earlier ones did. A
 * failure is logged and listed in the result, never thrown. Pull-back and
 * hooks run once and are not retried; empty group channels, the main channel
 * and the native event are retried by the scan.
 */

import type { Client, Guild } from "discord.js";
import { Event, type IEvent } from "../models/event.js";
import logger from "../utils/logger.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";
import {
  MOVE_SKIP_LABEL,
  moveEventMembers,
  planReturnToMain,
  type MoveReport,
  type MoveSkipReason,
} from "./event-member-moves.js";
import { clearLeadersOnEnd } from "./event-group-leaders.js";
import { runEventEndHooks, type EventEndTrigger } from "./event-end-hooks.js";
import type { GroupChannelReport } from "./event-group-channels.js";
import { FLASH_MAX, truncateFlash } from "../web/http-flash.js";

export type TeardownStepId =
  | "announcement"
  | "pull-back"
  | "hooks"
  | "group-channels"
  | "captains"
  | "native"
  | "main-channel";

export interface TeardownStep {
  id: TeardownStepId;
  /** False: something did not go through; `note` says what. */
  ok: boolean;
  /** Plain text for the host, already safe to display. */
  note: string;
  /** Numbers for the audit row (never names). */
  counts?: Record<string, number>;
}

export type EndEventOutcome =
  /** Not the guild's event, or it does not exist. */
  | { status: "not-found" }
  /** Cannot be ended from this state (a scheduled event, or a cancelled one). */
  | { status: "not-running"; state: string }
  /** Another press, admin or the scan got there first: nothing was done. */
  | { status: "already-ended"; endedAt: Date | null }
  /** Scheduled path only: the row changed after the scan read it. */
  | { status: "changed" }
  /** The claim could not be saved; nothing was done. */
  | { status: "failed"; message: string }
  /** `events.enabled` is off (or unreadable): nothing was done. */
  | { status: "refused"; message: string }
  | { status: "ended"; steps: TeardownStep[]; endedAt: Date; event: IEvent };

export interface TeardownDeps {
  client: Client;
  updateAnnouncement(event: IEvent): Promise<boolean>;
  syncNative(event: IEvent, guild: Guild): Promise<void>;
  cleanupGroupChannels(
    event: IEvent,
    guild: Guild,
    now: Date,
  ): Promise<GroupChannelReport>;
  logLifecycle(event: IEvent): Promise<void>;
  getGraceMinutes(): Promise<number>;
  /**
   * The scan must leave this event alone from now on (see EventService).
   * Returns the caller's own hold: another caller's hold on the same event is
   * never affected by this one being given up.
   */
  beginEnding(eventId: string): number;
  /** The claim was not won: give up this caller's own hold, and only that one. */
  abortEnding(eventId: string, hold: number): void;
  /**
   * The teardown that won the claim has finished (whatever happened): the event
   * is no longer "in progress". The recently-ended hold stays until it expires.
   */
  finishEnding(eventId: string, hold: number): void;
  /** Pause after a pull-back so the gateway shows the moves (tests: 0). */
  settleMs?: number;
}

export interface ExpectChannels {
  main: string | null;
  groups: Array<{ key: string; channelId: string | null }>;
}

export interface TeardownInput {
  eventId: string;
  guildId: string;
  trigger: EventEndTrigger;
  /** Manual end only; ignored (false) for the scheduled end. */
  pullBack: boolean;
  now: Date;
  /** The instant recorded as `endedAt` (the press, or the scheduled end). */
  endedAt: Date;
  /** States the claim accepts: manual `["active"]`, scheduled both open ones. */
  fromStates: readonly string[];
  /** Scheduled end: the claim also requires the times the scan decided from. */
  expectTimes?: { startTime: Date; durationMinutes: number };
  /**
   * Scheduled end: the voice channels the occupancy check looked at (the main
   * channel and each group's channel, as stored when it was read). The claim
   * also requires them unchanged, so a channel recorded since (a group pass) is
   * never ended over unchecked: the claim then says `changed` and the next scan
   * checks again.
   */
  expectChannels?: ExpectChannels;
  guild: Guild | null;
  /**
   * The scheduled end passes the scan's own copy of the row, which is synced
   * with the claim and kept as the object the rest of the scan works on. The
   * manual end passes nothing and works on the row the claim returns.
   */
  event?: IEvent;
  /** Close the native event here (manual end); the scan does it for its own end. */
  syncNative: boolean;
}

const DEFAULT_SETTLE_MS = 1500;

/** What each skip reason of the pull-back means for "nobody stranded". */
const QUIET_SKIPS: ReadonlySet<MoveSkipReason> = new Set([
  "already-there",
  "not-connected",
]);

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const handle = setTimeout(resolve, ms);
    handle.unref?.();
  });
}

export class EventTeardown {
  constructor(private readonly deps: TeardownDeps) {}

  public async run(input: TeardownInput): Promise<EndEventOutcome> {
    const { eventId } = input;

    // Taken synchronously, before the first await, and undone below when the
    // claim is not won: the scan skips an event that is being ended.
    const hold = this.deps.beginEnding(eventId);
    const claimed = await this.claim(input);
    if (!("doc" in claimed)) {
      // Only this caller's hold: the caller that won the claim (and may be
      // minutes into a pull-back) keeps its own.
      this.deps.abortEnding(eventId, hold);
      return claimed;
    }

    try {
      return await this.afterClaim(input, claimed.doc);
    } finally {
      this.deps.finishEnding(eventId, hold);
    }
  }

  /** Everything after the claim: the steps, each attempted whatever the last did. */
  private async afterClaim(
    input: TeardownInput,
    claimedDoc: IEvent,
  ): Promise<EndEventOutcome> {
    const { eventId } = input;
    const event = input.event ?? claimedDoc;
    if (input.event) {
      // The scan's copy follows the claim, so the rest of its tick sees an
      // ended event.
      event.state = "ended";
      event.endedAt = input.endedAt;
      // The claim already wrote both. The scan's later `save()` must not write
      // them again: if a cancel lands in between, an "ended" written from this
      // copy would overwrite it. (A plain object in a test has no `$ignore`.)
      const doc = event as { $ignore?: (path: string) => void };
      doc.$ignore?.("state");
      doc.$ignore?.("endedAt");
    }

    const steps: TeardownStep[] = [];
    const guild = input.guild;
    const push = (step: TeardownStep | null): void => {
      if (!step) return;
      steps.push(step);
      if (!step.ok) {
        logger.warn(
          `Event ${sanitizeForLog(eventId)} ended (${input.trigger}), step ${step.id} not completed: ${sanitizeForLog(step.note)}`,
        );
      }
    };

    push(await this.announce(event));

    let movedBack = 0;
    if (input.trigger === "manual" && input.pullBack) {
      const pulled = await this.pullBack(event);
      movedBack = pulled?.counts?.moved ?? 0;
      push(pulled);
    }

    push(await this.hooks(event, input.trigger));

    if (event.groupsEnabled === true) {
      if (movedBack > 0) {
        await sleep(this.deps.settleMs ?? DEFAULT_SETTLE_MS);
      }
      push(await this.groupChannels(event, guild, input.now));
      push(await this.captains(event));
    }

    if (input.syncNative) {
      push(await this.native(event, guild));
    }

    push(await this.mainChannel(event));

    if (input.trigger === "manual") {
      await this.deps.logLifecycle(event).catch(() => undefined);
    }
    logger.info(
      `Event ${sanitizeForLog(eventId)} ended (${input.trigger}); ${steps.filter((s) => !s.ok).length} step(s) need attention`,
    );
    return { status: "ended", steps, endedAt: input.endedAt, event };
  }

  // ---------------------------------------------------------------
  // 1. Claim
  // ---------------------------------------------------------------

  private async claim(
    input: TeardownInput,
  ): Promise<{ doc: IEvent } | EndEventOutcome> {
    const filter: Record<string, unknown> = {
      _id: input.eventId,
      guildId: input.guildId,
      state: { $in: [...input.fromStates] },
    };
    if (input.expectTimes) {
      filter.startTime = input.expectTimes.startTime;
      filter.durationMinutes = input.expectTimes.durationMinutes;
    }
    if (input.expectChannels) {
      // A null matches a stored null or a missing field.
      filter.channelId = input.expectChannels.main;
      const count = input.expectChannels.groups.length;
      filter.$and = [
        // `$size: 0` does not match a row that has no `groups` field at all (an
        // event made before groups existed); that row has no groups either.
        count === 0
          ? {
              $or: [{ groups: { $exists: false } }, { groups: { $size: 0 } }],
            }
          : { groups: { $size: count } },
        ...input.expectChannels.groups.map((g) => ({
          groups: { $elemMatch: { key: g.key, channelId: g.channelId } },
        })),
      ];
    }
    try {
      const doc = await Event.findOneAndUpdate(
        filter,
        { $set: { state: "ended", endedAt: input.endedAt } },
        { new: true },
      );
      if (doc) return { doc };
    } catch (error) {
      logger.error(
        `Event ${sanitizeForLog(input.eventId)}: could not save the end:`,
        error,
      );
      return {
        status: "failed",
        message: "The event could not be saved as ended.",
      };
    }
    // Not claimed: find out why, from a fresh read.
    let row: {
      guildId: string;
      state: string;
      endedAt?: Date | null;
    } | null;
    try {
      row = (await Event.findById(input.eventId).lean()) as typeof row;
    } catch (error) {
      logger.error(
        `Event ${sanitizeForLog(input.eventId)}: could not read the event after a refused end:`,
        error,
      );
      return {
        status: "failed",
        message: "The event could not be read.",
      };
    }
    if (!row || row.guildId !== input.guildId) return { status: "not-found" };
    if (row.state === "ended") {
      return { status: "already-ended", endedAt: row.endedAt ?? null };
    }
    if (input.fromStates.includes(row.state)) return { status: "changed" };
    return { status: "not-running", state: row.state };
  }

  // ---------------------------------------------------------------
  // Steps after the claim
  // ---------------------------------------------------------------

  private async announce(event: IEvent): Promise<TeardownStep | null> {
    let ok = false;
    try {
      ok = await this.deps.updateAnnouncement(event);
    } catch (error) {
      logger.error("Event end: announcement update threw:", error);
    }
    if (ok) return null;
    return {
      id: "announcement",
      ok: false,
      note: "The announcement post could not be updated and may still look like a running event.",
    };
  }

  private async pullBack(event: IEvent): Promise<TeardownStep | null> {
    if (
      event.groupsEnabled !== true ||
      !(event.groups ?? []).some((g) => !!g.channelId)
    ) {
      return null;
    }
    const guildId = event.guildId;
    let outcome;
    try {
      outcome = await moveEventMembers({
        client: this.deps.client,
        guildId,
        eventId: String(event._id),
        // Nobody is left out: a host in a channel that is about to go would be
        // stranded as much as anyone (the bulk moves of the panel spare them).
        excludeUserIds: [],
        allowFinished: true,
        plan: ({ event: fresh, presence }) =>
          planReturnToMain(fresh, presence, false),
      });
    } catch (error) {
      logger.error(
        `Event ${sanitizeForLog(String(event._id))}: pull-back failed:`,
        error,
      );
      return {
        id: "pull-back",
        ok: false,
        note: "People could not be moved back to the main channel.",
      };
    }
    if (outcome.status === "busy") {
      return {
        id: "pull-back",
        ok: false,
        note: "A move was already running, so nobody was moved back. Group channels with people in them stay until they are empty.",
      };
    }
    if (outcome.status === "refused") {
      return {
        id: "pull-back",
        ok: false,
        note: outcome.message,
      };
    }
    const report: MoveReport = outcome.report;
    const loud = report.skipped.filter((s) => !QUIET_SKIPS.has(s.reason));
    const counts: Record<string, number> = {
      moved: report.moved.length,
      unconfirmed: report.unconfirmed.length,
      skipped: loud.length,
    };
    const ok = report.unconfirmed.length === 0 && loud.length === 0;
    if (outcome.considered === 0) {
      return {
        id: "pull-back",
        ok: true,
        note: "Nobody was in a group channel.",
        counts,
      };
    }
    // The shared wording of the host moves, so the host reads the same thing
    // in both places; kept short, it goes into one flash.
    const by = new Map<MoveSkipReason, number>();
    for (const s of loud) by.set(s.reason, (by.get(s.reason) ?? 0) + 1);
    const parts = [`Moved ${report.moved.length} back to the main channel.`];
    if (report.unconfirmed.length > 0) {
      parts.push(
        `Discord did not confirm ${report.unconfirmed.length} (check Discord).`,
      );
    }
    if (by.size > 0) {
      parts.push(
        `Not moved: ${[...by.entries()]
          .map(([reason, n]) => `${n} ${MOVE_SKIP_LABEL[reason]}`)
          .join("; ")}.`,
      );
    }
    return { id: "pull-back", ok, note: parts.join(" "), counts };
  }

  private async hooks(
    event: IEvent,
    trigger: EventEndTrigger,
  ): Promise<TeardownStep | null> {
    const results = await runEventEndHooks({
      eventId: String(event._id),
      guildId: event.guildId,
      trigger,
      client: this.deps.client,
    });
    if (results.length === 0) return null;
    const problems = results.flatMap((r) => r.warnings);
    return {
      id: "hooks",
      ok: problems.length === 0,
      note:
        problems.length === 0
          ? `Ran ${results.length} end-of-event step(s).`
          : problems.join(" "),
      counts: {
        hooks: results.length,
        hooksFailed: results.filter((r) => !r.ok).length,
      },
    };
  }

  private async groupChannels(
    event: IEvent,
    guild: Guild | null,
    now: Date,
  ): Promise<TeardownStep | null> {
    if (!guild) {
      return {
        id: "group-channels",
        ok: false,
        note: "The server could not be reached, so group channels were not removed. The scan retries.",
      };
    }
    let report: GroupChannelReport;
    try {
      report = await this.deps.cleanupGroupChannels(event, guild, now);
    } catch (error) {
      logger.error(
        `Event ${sanitizeForLog(String(event._id))}: group channel cleanup failed:`,
        error,
      );
      return {
        id: "group-channels",
        ok: false,
        note: "Group channels could not be removed. The scan retries every minute.",
      };
    }
    if (
      report.removed === 0 &&
      report.occupied === 0 &&
      report.failures.length === 0
    ) {
      return null;
    }
    const parts: string[] = [];
    if (report.removed > 0) {
      parts.push(`Removed ${report.removed} group channel(s).`);
    }
    if (report.occupied > 0) {
      parts.push(
        `${report.occupied} group channel(s) still have people in them and are removed once they are empty.`,
      );
    }
    if (report.failures.length > 0) {
      parts.push(
        `${report.failures.length} could not be removed (${report.failures
          .map((f) => `${f.name}: ${f.reason}`)
          .join("; ")}); the scan retries.`,
      );
    }
    return {
      id: "group-channels",
      // Occupied is deliberate and retried, not a failure of the teardown.
      ok: report.failures.length === 0,
      note: parts.join(" "),
      counts: {
        removed: report.removed,
        occupied: report.occupied,
        failed: report.failures.length,
      },
    };
  }

  /**
   * Group leaders (`captainId`) are not needed once the event is over, so they
   * are cleared through the leaders module (`clearLeadersOnEnd`: the group
   * lock, a fresh read of the ended row, a conditional update per group, and an
   * `onLeaderChange` event with source `ended` for the leads-only channel).
   * Assignments (`memberIds`) are NOT: they stay as history until the member
   * resets their data (owner decision, see the registry entry
   * `event-group-member`). Nothing here adds or changes a member's group, so no
   * member-reset admission ticket is involved.
   */
  private async captains(event: IEvent): Promise<TeardownStep | null> {
    try {
      const cleared = await clearLeadersOnEnd(event.guildId, String(event._id));
      return cleared > 0
        ? {
            id: "captains",
            ok: true,
            note: "Group leaders were cleared.",
            counts: { captainsCleared: cleared },
          }
        : null;
    } catch (error) {
      logger.error(
        `Event ${sanitizeForLog(String(event._id))}: clearing group leaders failed:`,
        error,
      );
      return {
        id: "captains",
        ok: false,
        note: "Group leaders could not be cleared.",
      };
    }
  }

  private async native(
    event: IEvent,
    guild: Guild | null,
  ): Promise<TeardownStep | null> {
    // An event with no link and no create marker has nothing in Discord to
    // close. An adopted one is only let go of (never closed from here): the
    // sync still runs to release the link, but it is never a problem.
    const linked = (): boolean =>
      !!event.nativeEventId || !!event.nativeCreateStartedAt;
    const pending = (): boolean => event.nativeAdopted !== true && linked();
    if (!linked()) return null;
    const note =
      "The Discord event could not be closed yet. KoolBot tries again within a minute.";
    if (!guild) {
      return pending() ? { id: "native", ok: false, note } : null;
    }
    try {
      await this.deps.syncNative(event, guild);
    } catch (error) {
      logger.error("Event end: native sync threw:", error);
    }
    // `syncEvent` swallows its own errors; the link (or the marker of a create
    // that timed out and is still being looked for) still being there after
    // the sync is the only sign that closing it did not go through (it also
    // stays when native events are switched off or the bot may not manage
    // them). The scan's terminal-row query tries again.
    return pending() ? { id: "native", ok: false, note } : null;
  }

  private async mainChannel(event: IEvent): Promise<TeardownStep | null> {
    if (!event.channelId) return null;
    const minutes = await this.deps.getGraceMinutes().catch(() => 0);
    return {
      id: "main-channel",
      ok: true,
      note:
        minutes > 0
          ? `The main channel is removed ${minutes} minute(s) from now, once it is empty.`
          : "The main channel is removed within a minute, once it is empty.",
    };
  }
}

// -------------------------------------------------------------------
// What the host and the audit log are told
// -------------------------------------------------------------------

export interface EndSummary {
  /** The press did what was asked (an already-ended event counts: no-op). */
  ok: boolean;
  message: string;
  /** Counts and outcome labels only: no names, no ids. */
  details: Record<string, unknown>;
  errorMessage?: string;
}

export function summariseEnd(outcome: EndEventOutcome): EndSummary {
  switch (outcome.status) {
    case "not-found":
      return {
        ok: false,
        message: "That event could not be found.",
        details: { outcome: "not-found" },
        errorMessage: "not found or wrong guild",
      };
    case "not-running":
      return {
        ok: false,
        message:
          outcome.state === "cancelled"
            ? "The event was cancelled, so there is nothing to end."
            : "The event has not started, so it cannot be ended. Cancel it instead if it should not run.",
        details: { outcome: "not-running", state: outcome.state },
        errorMessage: `event is ${outcome.state}`,
      };
    case "already-ended":
      return {
        ok: true,
        message: "The event has already ended. Nothing was changed.",
        details: { outcome: "already-ended" },
      };
    case "changed":
      return {
        ok: false,
        message: "The event changed while it was being ended. Try again.",
        details: { outcome: "changed" },
        errorMessage: "event changed",
      };
    case "refused":
      return {
        ok: false,
        message: outcome.message,
        details: { outcome: "refused" },
        errorMessage: "events are turned off",
      };
    case "failed":
      return {
        ok: false,
        message: `${outcome.message} Nothing was done. Try again.`,
        details: { outcome: "failed" },
        errorMessage: outcome.message,
      };
    case "ended": {
      const bad = outcome.steps.filter((s) => !s.ok);
      const good = outcome.steps.filter((s) => s.ok);
      const counts: Record<string, number> = {};
      for (const step of outcome.steps) {
        for (const [k, v] of Object.entries(step.counts ?? {})) {
          counts[k] = (counts[k] ?? 0) + v;
        }
      }
      // The flash holds FLASH_MAX characters: what needs attention comes first
      // (each note clipped), the routine notes follow while they fit.
      const head =
        bad.length === 0
          ? "The event has ended."
          : `The event has ended, but ${bad.length === 1 ? "one thing needs" : `${bad.length} things need`} attention: ${bad
              .map((s) => clip(s.note, 140))
              .join(" ")}`;
      let message = head;
      for (const step of good) {
        if (message.length + 1 + step.note.length > FLASH_MAX) break;
        message += ` ${step.note}`;
      }
      message = truncateFlash(message);
      return {
        ok: true,
        message,
        details: {
          outcome: bad.length === 0 ? "ended" : "ended-with-problems",
          problems: bad.length,
          problemSteps: bad.map((s) => s.id),
          ...counts,
        },
      };
    }
  }
}
