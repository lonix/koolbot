/**
 * Pure planning of event group membership (#1191): who ends up in which group
 * when the host assigns, unassigns or randomises, and when a member joins a
 * group's channel. No database, no Discord, no clock: callers read the groups,
 * ask for a plan, and write the returned `changes` themselves (see
 * `event-group-assignment.ts`). That keeps every rule here testable with plain
 * objects, including the seeded shuffle.
 *
 * Rules, in one place:
 * - Only `team` groups hold members. `open` and `leads` groups are never a
 *   target and never hold anyone.
 * - A member is in at most one group. Every plan removes the member from every
 *   group first, so even a row that somehow lists a member twice ends clean.
 * - A group holds at most `size` members; an unsized group at most
 *   `GROUP_MEMBER_MAX` (the most a voice channel can hold). An event holds at
 *   most `EVENT_MEMBER_MAX` assigned members in total.
 */

import type { EventGroupKind } from "../models/event-group-kinds.js";

/** Most members of one group; also the cap of an unsized group (a voice channel holds at most 99). */
export const GROUP_MEMBER_MAX = 99;

/** Most assigned members across all groups of one event. */
export const EVENT_MEMBER_MAX = 500;

/** The part of a group the planner reads. */
export interface PlanGroup {
  key: string;
  kind: EventGroupKind | string;
  size: number | null;
  memberIds: string[];
}

/** New member lists of the groups a plan changes, by group key. */
export type MemberChanges = Record<string, string[]>;

export type PlanFailure =
  "no-group" | "not-team" | "full" | "event-full" | "no-teams";

export type AssignPlan =
  | {
      ok: true;
      changed: boolean;
      /** The group the member was in before, or null. */
      fromKey: string | null;
      /** The group the member is in after, or null. */
      toKey: string | null;
      changes: MemberChanges;
    }
  | { ok: false; reason: PlanFailure };

/** How many members a group can hold. */
export function groupCapacity(group: Pick<PlanGroup, "size">): number {
  const size = group.size;
  if (typeof size === "number" && Number.isFinite(size) && size >= 1) {
    return Math.min(Math.floor(size), GROUP_MEMBER_MAX);
  }
  return GROUP_MEMBER_MAX;
}

function isTeam(group: Pick<PlanGroup, "kind">): boolean {
  return group.kind === "team";
}

/** The key of the first group listing the member, or null. */
export function groupKeyOf(
  groups: readonly PlanGroup[],
  userId: string,
): string | null {
  for (const group of groups) {
    if ((group.memberIds ?? []).includes(userId)) return group.key;
  }
  return null;
}

function totalMembers(groups: readonly PlanGroup[]): number {
  let n = 0;
  for (const group of groups) n += (group.memberIds ?? []).length;
  return n;
}

/**
 * Put one member into a group, or take them out (`targetKey` null). Moving
 * into the group they are already in changes nothing. The member is taken out
 * of every other group in the same plan, so a move is one atomic change set.
 */
export function planAssign(
  groups: readonly PlanGroup[],
  userId: string,
  targetKey: string | null,
): AssignPlan {
  const fromKey = groupKeyOf(groups, userId);
  const changes: MemberChanges = {};

  let target: PlanGroup | undefined;
  if (targetKey !== null) {
    target = groups.find((g) => g.key === targetKey);
    if (!target) return { ok: false, reason: "no-group" };
    if (!isTeam(target)) return { ok: false, reason: "not-team" };
  }

  // Already exactly where they should be (and nowhere else).
  const holders = groups.filter((g) => (g.memberIds ?? []).includes(userId));
  if (
    (target && holders.length === 1 && holders[0].key === target.key) ||
    (!target && holders.length === 0)
  ) {
    return { ok: true, changed: false, fromKey, toKey: targetKey, changes };
  }

  if (target) {
    const alreadyIn = (target.memberIds ?? []).includes(userId);
    if (!alreadyIn) {
      if ((target.memberIds ?? []).length >= groupCapacity(target)) {
        return { ok: false, reason: "full" };
      }
      if (fromKey === null && totalMembers(groups) >= EVENT_MEMBER_MAX) {
        return { ok: false, reason: "event-full" };
      }
    }
  }

  for (const group of groups) {
    const members = group.memberIds ?? [];
    const has = members.includes(userId);
    if (target && group.key === target.key) {
      if (!has) changes[group.key] = [...members, userId];
      else if (members.filter((m) => m === userId).length > 1) {
        // A duplicate inside the target itself: collapse it.
        changes[group.key] = [...members.filter((m) => m !== userId), userId];
      }
    } else if (has) {
      changes[group.key] = members.filter((m) => m !== userId);
    }
  }
  return { ok: true, changed: true, fromKey, toKey: targetKey, changes };
}

/** A small seedable generator (mulberry32). Same seed, same sequence. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle of a copy of `items`. */
export function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export type RandomiseMode = "unassigned" | "everyone";

export interface RandomisePlacement {
  userId: string;
  groupKey: string;
}

export type RandomisePlan =
  | {
      ok: true;
      changes: MemberChanges;
      placed: RandomisePlacement[];
      /** Candidates that fitted nowhere; they are unassigned. */
      unplaced: string[];
      /** Every member's group before, for members that moved or were removed. */
      before: Record<string, string | null>;
    }
  | { ok: false; reason: "no-teams" };

/**
 * Deal `candidates` (the people connected right now) into the `team` groups.
 *
 * - `unassigned`: only candidates who are in no group are dealt; everyone
 *   already placed stays.
 * - `everyone`: every candidate is taken out of their group and dealt again.
 *   Members who are assigned but not connected stay where they are (they may
 *   come back) and keep using up their group's room.
 *
 * Dealing, one shuffled candidate at a time:
 * 1. the first group (in the event's order) that has a size and still has
 *    room, so a sized group is filled up to its size;
 * 2. else the unsized group with the fewest members (ties go to the earlier
 *    group), so unsized groups end up within one member of each other;
 * 3. else the candidate stays unassigned and is listed.
 *
 * With only unsized groups this is the even split (sizes differ by at most
 * one); with only sized groups it fills them in order and the overflow is
 * unplaced. Pass the same `random` for a reproducible result.
 */
export function planRandomise(
  groups: readonly PlanGroup[],
  candidates: readonly string[],
  mode: RandomiseMode,
  random: () => number,
): RandomisePlan {
  const teams = groups.filter(isTeam);
  if (teams.length === 0) return { ok: false, reason: "no-teams" };

  const pool = [...new Set(candidates.filter((c) => c.length > 0))];
  const working = new Map<string, string[]>(
    teams.map((g) => [g.key, [...(g.memberIds ?? [])]]),
  );
  const before: Record<string, string | null> = {};
  for (const id of pool) before[id] = groupKeyOf(groups, id);

  const dealt: string[] = [];
  for (const id of pool) {
    const held = before[id] !== null;
    if (mode === "unassigned" && held) continue;
    if (held) {
      for (const [key, members] of working) {
        working.set(
          key,
          members.filter((m) => m !== id),
        );
      }
    }
    dealt.push(id);
  }

  let total = 0;
  for (const members of working.values()) total += members.length;
  // Members of open/leads groups never exist, but count them if a row has any.
  for (const g of groups) if (!isTeam(g)) total += (g.memberIds ?? []).length;

  const placed: RandomisePlacement[] = [];
  const unplaced: string[] = [];
  for (const id of shuffle(dealt, random)) {
    if (total >= EVENT_MEMBER_MAX) {
      unplaced.push(id);
      continue;
    }
    let chosen: PlanGroup | undefined;
    for (const g of teams) {
      if (
        g.size !== null &&
        (working.get(g.key) ?? []).length < groupCapacity(g)
      ) {
        chosen = g;
        break;
      }
    }
    if (!chosen) {
      let fewest = Infinity;
      for (const g of teams) {
        if (g.size !== null) continue;
        const n = (working.get(g.key) ?? []).length;
        if (n < groupCapacity(g) && n < fewest) {
          fewest = n;
          chosen = g;
        }
      }
    }
    if (!chosen) {
      unplaced.push(id);
      continue;
    }
    working.get(chosen.key)?.push(id);
    placed.push({ userId: id, groupKey: chosen.key });
    total++;
  }

  const changes: MemberChanges = {};
  for (const g of teams) {
    const next = working.get(g.key) ?? [];
    const prev = g.memberIds ?? [];
    if (next.length !== prev.length || next.some((m, i) => m !== prev[i])) {
      changes[g.key] = next;
    }
  }
  return { ok: true, changes, placed, unplaced, before };
}
