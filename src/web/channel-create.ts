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
 * This helper does not serialise anything: two applies, or an apply and another
 * write to the same server (the Channel Manager), can both pass the re-check and
 * both create, giving a duplicate name. The bot-permission check is the caller's;
 * a refusal from Discord (missing permission, rate limit) is reported here.
 * A create that timed out is in neither `removed` nor `stuck`: whether it exists
 * is unknown, and the error tells the admin to check Discord.
 *
 * Writes use the write-REST client and `cancellableCall` from
 * `channel-write-rest.ts` (timeout, no automatic retry of a create). A create is
 * never retried after a timeout; deleting is, as it is idempotent.
 */

import { createHash } from "node:crypto";
import { ChannelType, DiscordAPIError, Routes, type REST } from "discord.js";
import {
  CHANNEL_LIMITS,
  cleanName,
  resolveParent,
  type ManageableKind,
  type ManagedChannelView,
} from "./channel-manager.js";
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
 * showed. On a failure, what this call created is deleted again.
 */
export async function applyChannelPlan(
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
    live = await deps.listChannels();
  } catch (error) {
    logger.warn("channel create: could not read the channels", error);
    return nothing(
      "KoolBot couldn't read the channels from Discord, so nothing was created. Try again.",
    );
  }
  const plan = planChannels(entries, live);
  if (!plan.ok) return nothing(plan.errors.join(" "));
  if (plan.planId !== reviewedPlanId) {
    return nothing(
      "The channels on the server changed since Review, so nothing was created. Review the changes again.",
    );
  }

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
      return { ok: false, error: describeWriteFailure(error), removed, stuck };
    }
  }
  return { ok: true, channels: done };
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
      if (error instanceof DiscordAPIError && error.status === 404) {
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
