/**
 * Create the channel or category a setting points at (#1659), as a plan that is
 * shown first and an apply that must match it, in the way `reviewHostRole` /
 * `startHostRole` do for the Event host role.
 *
 *  1. `planChannels(entries, liveChannels)` validates each entry and says, per
 *     entry, whether it would create a channel or select one that already
 *     exists. It is pure: it writes nothing and returns a `planId`.
 *  2. `applyChannelPlan(deps, entries, reviewedPlanId)` reads the live server
 *     again, plans again, and writes only if the new plan has the `planId` that
 *     Review showed. Otherwise nothing is written.
 *  3. Entries are created one at a time. When one fails, every channel this
 *     call already created is deleted again; the result names the ids it
 *     removed and any it could not remove (`stuck`), so nothing is left
 *     behind unreported.
 *
 * Rules, each in one place so a change is one edit:
 *  - Names: trimmed, 1 to 100 characters (checked again after normalising). A
 *    text channel name is lower-cased with spaces turned to hyphens
 *    (`normaliseChannelName`), the part of Discord's rule that is certain;
 *    hyphens stay as typed. A name that matches an existing channel of the same
 *    kind in the same parent, both sides normalised alike and compared ignoring
 *    case, is selected, not created. Two entries that resolve to the same
 *    channel are refused.
 *  - A failed read of the channels before the first write reports that nothing
 *    was created; only a failed write asks the admin to check Discord.
 *  - Parent: `parentId` must be an existing category and is only for text and
 *    voice. A created category has no parent. Nothing here chooses a parent: the
 *    caller passes what the setting's kind decides (no parent by default).
 *  - Permissions: a created channel gets NO permission overwrites. It inherits
 *    what Discord gives it from its category, or the server defaults. The one
 *    place to change that is `overwritesFor`.
 *
 * An apply runs inside the shared per-server lock (`channel-write-lock.ts`, #1714),
 * which the Channel Manager's writes take too, so two applies, or an apply and a
 * Channel Manager write, cannot both pass the re-check and both create the same
 * name. Do not call it from inside work that holds that lock.
 * The bot-permission check is the caller's; a refusal from Discord (missing permission, rate limit) is reported here.
 * A create that timed out is in neither `removed` nor `stuck`: whether it exists
 * is unknown, and the error tells the admin to check Discord.
 * A failure `makeDiscordApiCall` wrapped (`Error(..., { cause })`) is classified by
 * its cause (`unwrapWriteError`, bounded).
 * Once an earlier create succeeded, the error names any channel that is still there
 * (`stuck`) and never says nothing was changed or offers a retry while one exists.
 *
 * Writes use the write-REST client and `cancellableCall` from
 * `channel-write-rest.ts` (timeout, no automatic retry of a create). A create is
 * never retried after a timeout; deleting is, as it is idempotent.
 */

import { createHash } from "node:crypto";
import {
  ChannelType,
  DiscordAPIError,
  RateLimitError,
  Routes,
  type REST,
} from "discord.js";
import {
  CHANNEL_LIMITS,
  cleanName,
  resolveParent,
  type ManageableKind,
  type ManagedChannelView,
} from "./channel-manager.js";
import {
  CHANNEL_LOCK_BUSY_MESSAGE,
  readWithin,
  withChannelLock,
} from "./channel-write-lock.js";
import { describeWriteFailure } from "./channel-write-rest.js";
import logger from "../utils/logger.js";

export interface ChannelPlanEntry {
  kind: ManageableKind;
  name: string;
  /** An existing category; text and voice only. `null` or absent: top level. */
  parentId?: string | null;
}

export interface PlannedChannel {
  kind: ManageableKind;
  /** The name as Discord will have it. */
  name: string;
  parentId: string | null;
  action: "create" | "existing";
  /** Set when `action` is `existing`. */
  existingId?: string;
}

export type ChannelPlan =
  | { ok: true; entries: PlannedChannel[]; planId: string }
  | { ok: false; errors: string[] };

const CHANNEL_TYPES = {
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  category: ChannelType.GuildCategory,
} as const;

/**
 * A text channel name as far as the rule is certain: lower case and spaces to
 * hyphens. Hyphens stay as typed (Discord allows repeated, leading and
 * trailing ones) and nothing else is removed (emoji stay);
 * Discord applies any further rule itself and the name it returns is used.
 * Voice channels and categories keep what was typed (control characters and
 * extra spaces aside).
 */
export function normaliseChannelName(
  kind: ManageableKind,
  raw: string,
): string {
  const clean = cleanName(raw);
  if (kind !== "text") return clean;
  return clean.toLowerCase().replace(/\s/g, "-");
}

/** Both sides go through the same normalisation, so a name matches a channel as Discord stores it. */
const sameName = (
  kind: ManageableKind,
  typed: string,
  stored: string,
): boolean =>
  normaliseChannelName(kind, typed).toLowerCase() ===
  normaliseChannelName(kind, stored).toLowerCase();

/** Validate the entries against the live channels. Pure: nothing is written. */
export function planChannels(
  entries: readonly ChannelPlanEntry[],
  liveChannels: readonly ManagedChannelView[],
): ChannelPlan {
  const errors: string[] = [];
  const planned: PlannedChannel[] = [];
  const seen = new Set<string>();
  let creating = 0;

  for (const entry of entries) {
    const label = `${entry.kind === "category" ? "category" : `${entry.kind} channel`} "${String(entry.name).trim().slice(0, 40)}"`;
    const cleaned = cleanName(entry.name);
    if (cleaned.length === 0) {
      errors.push("The name cannot be blank.");
      continue;
    }
    if (cleaned.length > CHANNEL_LIMITS.nameMax) {
      errors.push(
        `The name can be at most ${CHANNEL_LIMITS.nameMax} characters.`,
      );
      continue;
    }
    const name = normaliseChannelName(entry.kind, cleaned);
    // Lower-casing can lengthen a Unicode string, so the limit applies to the
    // normalised name too (a category keeps its case, so it cannot grow).
    if (name.length > CHANNEL_LIMITS.nameMax) {
      errors.push(
        `The name can be at most ${CHANNEL_LIMITS.nameMax} characters.`,
      );
      continue;
    }
    let parentId: string | null = null;
    if (entry.kind === "category") {
      if (entry.parentId) {
        errors.push("A category has no parent.");
        continue;
      }
    } else {
      const parent = resolveParent(liveChannels, entry.parentId);
      if (!parent.ok) {
        errors.push(parent.error);
        continue;
      }
      parentId = parent.value;
    }
    const key = `${entry.kind}|${parentId ?? ""}|${name.toLowerCase()}`;
    if (seen.has(key)) {
      errors.push(`${label} appears more than once in this plan.`);
      continue;
    }
    seen.add(key);
    const found = liveChannels.find(
      (c) =>
        c.kind === entry.kind &&
        c.parentId === (entry.kind === "category" ? null : parentId) &&
        sameName(entry.kind, name, c.name),
    );
    if (found) {
      planned.push({
        kind: entry.kind,
        name: found.name,
        parentId,
        action: "existing",
        existingId: found.id,
      });
    } else {
      creating += 1;
      planned.push({ kind: entry.kind, name, parentId, action: "create" });
    }
  }

  if (errors.length === 0 && creating > 0) {
    if (liveChannels.length + creating > CHANNEL_LIMITS.guildChannels) {
      errors.push(
        `This server has ${liveChannels.length} channels and categories; Discord's limit is ${CHANNEL_LIMITS.guildChannels}.`,
      );
    }
    for (const parentId of new Set(
      planned.filter((p) => p.action === "create").map((p) => p.parentId),
    )) {
      if (!parentId) continue;
      const adding = planned.filter(
        (p) => p.action === "create" && p.parentId === parentId,
      ).length;
      const inside = liveChannels.filter(
        (c) => c.kind !== "category" && c.parentId === parentId,
      ).length;
      if (inside + adding > CHANNEL_LIMITS.perCategory) {
        errors.push(
          `That category already holds ${inside} channels; Discord allows ${CHANNEL_LIMITS.perCategory} per category.`,
        );
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  const planId = createHash("sha256")
    .update(JSON.stringify(planned))
    .digest("hex")
    .slice(0, 16);
  return { ok: true, entries: planned, planId };
}

/**
 * The permission overwrites of a created channel. None, so it inherits from its
 * category or the server defaults (owner decision, #1659). If private log
 * channels are chosen instead, this is the one place to add them.
 */
function overwritesFor(): Record<string, unknown>[] | undefined {
  return undefined;
}

export interface ChannelCreateDeps {
  guildId: string;
  /** The write-REST client (`createWriteRest`). */
  rest: Pick<REST, "post" | "delete">;
  /** `cancellableCall` bound to the CommandManager. */
  call: <T>(
    fn: (signal: AbortSignal) => Promise<T>,
    opName: string,
    retryOnTimeout: boolean,
  ) => Promise<T>;
  /** The live channels, read fresh (`fetchChannelViews(guild)`). */
  listChannels: () => Promise<ManagedChannelView[]>;
  /** The audit-log reason Discord records. */
  reason: string;
  /**
   * Abandons the apply while it still waits for the lock (a closed request).
   * An apply that has started is never cut off by it.
   */
  signal?: AbortSignal;
  /**
   * A check the caller makes on the live channels read inside the lock, before
   * the re-plan. Returning false means what the caller decided its entries
   * from has changed, and the apply refuses ("changed since Review") with
   * nothing created. Absent: no check (the Channel Manager and every other
   * caller are unaffected).
   */
  liveUnchanged?: (live: readonly ManagedChannelView[]) => boolean;
}

export interface AppliedChannel {
  id: string;
  name: string;
  /** False when the name already existed and was selected. */
  created: boolean;
}

export type ChannelApplyResult =
  | { ok: true; channels: AppliedChannel[] }
  | {
      ok: false;
      error: string;
      /** Channels this call created and deleted again. */
      removed: string[];
      /** Channels this call created and could not delete: they still exist. */
      stuck: string[];
    };

/**
 * Plan again from the live server and create only if that is the plan Review
 * showed. On a failure, what this call created is deleted again. The whole
 * apply, the re-read included, runs inside the shared per-server lock
 * (`channel-write-lock.ts`); a caller that waits too long for it gets
 * `CHANNEL_LOCK_BUSY_MESSAGE` and nothing is written. A name another
 * writer created since Review changes the re-plan, so the apply refuses
 * ("changed since Review") and creates nothing.
 */
export async function applyChannelPlan(
  deps: ChannelCreateDeps,
  entries: readonly ChannelPlanEntry[],
  reviewedPlanId: string,
): Promise<ChannelApplyResult> {
  const held = await withChannelLock(
    deps.guildId,
    () => applyLocked(deps, entries, reviewedPlanId),
    deps.signal,
  );
  if (held.ok) return held.value;
  return {
    ok: false,
    error: CHANNEL_LOCK_BUSY_MESSAGE,
    removed: [],
    stuck: [],
  };
}

async function applyLocked(
  deps: ChannelCreateDeps,
  entries: readonly ChannelPlanEntry[],
  reviewedPlanId: string,
): Promise<ChannelApplyResult> {
  const nothing = (error: string): ChannelApplyResult => ({
    ok: false,
    error,
    removed: [],
    stuck: [],
  });
  let live: ManagedChannelView[];
  try {
    live = await readWithin(() => deps.listChannels());
  } catch (error) {
    logger.warn("channel create: could not read the channels", error);
    return nothing(
      "KoolBot couldn't read the channels from Discord, so nothing was created. Try again.",
    );
  }
  const CHANGED =
    "The channels on the server changed since Review, so nothing was created. Review the changes again.";
  if (deps.liveUnchanged && !deps.liveUnchanged(live)) return nothing(CHANGED);
  const plan = planChannels(entries, live);
  if (!plan.ok) return nothing(plan.errors.join(" "));
  if (plan.planId !== reviewedPlanId) return nothing(CHANGED);

  const done: AppliedChannel[] = [];
  const createdIds: string[] = [];
  for (const entry of plan.entries) {
    if (entry.action === "existing") {
      done.push({
        id: entry.existingId as string,
        name: entry.name,
        created: false,
      });
      continue;
    }
    try {
      const body: Record<string, unknown> = {
        name: entry.name,
        type: CHANNEL_TYPES[entry.kind],
      };
      if (entry.parentId) body.parent_id = entry.parentId;
      const overwrites = overwritesFor();
      if (overwrites) body.permission_overwrites = overwrites;
      // A create is not idempotent: never retry it after a timeout.
      const created = (await deps.call(
        (signal) =>
          deps.rest.post(Routes.guildChannels(deps.guildId), {
            body,
            reason: deps.reason,
            signal,
          }),
        "create channel",
        false,
      )) as { id: string; name: string };
      createdIds.push(created.id);
      done.push({ id: created.id, name: created.name, created: true });
    } catch (error) {
      const { removed, stuck } = await removeAgain(deps, createdIds);
      return {
        ok: false,
        error: failureMessage(error, createdIds.length, removed, stuck),
        removed,
        stuck,
      };
    }
  }
  return { ok: true, channels: done };
}

/** How many `cause` links are followed; a cyclic chain cannot loop. */
const MAX_CAUSE_DEPTH = 5;

/**
 * The error to classify. `makeDiscordApiCall` wraps a failure it gave up on in
 * `Error("Failed to ... after N attempts", { cause })`, so the Discord error
 * that says what happened is on `.cause`. Follows the chain (bounded) and
 * returns the first rate limit, else the first Discord API error, else the
 * error as thrown. Every classification in this file goes through here.
 */
export function unwrapWriteError(error: unknown): unknown {
  let firstApi: unknown;
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let i = 0; i < MAX_CAUSE_DEPTH; i += 1) {
    if (current instanceof RateLimitError) return current;
    if (current instanceof DiscordAPIError) firstApi ??= current;
    if (!(current instanceof Error) || seen.has(current)) break;
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return firstApi ?? error;
}

/**
 * The admin-facing message for a failed apply. With nothing created yet it is
 * `describeWriteFailure` as it is. Once an earlier create succeeded, the cause
 * is scoped to the failed request, and the message says what happened to the
 * earlier channels: removed again, or still there (ids) to check before any
 * retry. It never says "nothing was changed" or offers a retry while a
 * channel this call created still exists.
 */
function failureMessage(
  error: unknown,
  createdBefore: number,
  removed: readonly string[],
  stuck: readonly string[],
): string {
  const root = unwrapWriteError(error);
  if (createdBefore === 0) return describeWriteFailure(root);
  const cause =
    root instanceof RateLimitError
      ? "Discord is limiting changes right now, so the request to create the next channel was cancelled."
      : describeWriteFailure(root);
  if (stuck.length > 0) {
    return `${cause} These channels were created earlier in this request and could not be removed again, so they still exist: ${stuck.join(", ")}. Check them in Discord before trying again.`;
  }
  return `${cause} The ${removed.length === 1 ? "channel" : "channels"} created earlier in this request ${removed.length === 1 ? "was" : "were"} removed again.`;
}

/** Delete what one apply created, newest first. A channel already gone counts as removed. */
async function removeAgain(
  deps: ChannelCreateDeps,
  ids: readonly string[],
): Promise<{ removed: string[]; stuck: string[] }> {
  const removed: string[] = [];
  const stuck: string[] = [];
  for (const id of [...ids].reverse()) {
    try {
      await deps.call(
        (signal) =>
          deps.rest.delete(Routes.channel(id), {
            reason: deps.reason,
            signal,
          }),
        "remove created channel",
        true,
      );
      removed.push(id);
    } catch (error) {
      const cause = unwrapWriteError(error);
      if (cause instanceof DiscordAPIError && cause.status === 404) {
        removed.push(id);
      } else {
        logger.error(
          "channel create: could not remove a created channel",
          error,
        );
        stuck.push(id);
      }
    }
  }
  return { removed, stuck };
}
