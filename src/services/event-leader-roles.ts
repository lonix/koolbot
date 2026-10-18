/**
 * Who leads what, as pure reads of an event's groups (#1195, #1199). Kept free
 * of any database or Discord import so the channel code (which must not pull
 * in the leader writer) uses the same rule as every other reader.
 */

/** The part of a group the leader rules read (lean rows may lack any field). */
export interface LeaderGroup {
  key: string;
  kind?: string;
  channelId?: string | null;
  memberIds?: string[];
  captainId?: string | null;
}

export interface EffectiveLeader {
  groupKey: string;
  userId: string;
}

/**
 * The leaders of an event as every reader must see them: a team group's
 * `captainId` that is also in that group's `memberIds`. A stored id that fails
 * this (the member was unassigned and the cleanup has not run, or never ran)
 * is not a leader.
 */
export function effectiveLeaders(
  groups: readonly LeaderGroup[] | null | undefined,
): EffectiveLeader[] {
  const leaders: EffectiveLeader[] = [];
  for (const g of groups ?? []) {
    const id = g.captainId;
    if (!id || g.kind !== "team") continue;
    if (!(g.memberIds ?? []).includes(id)) continue;
    leaders.push({ groupKey: g.key, userId: id });
  }
  return leaders;
}

/**
 * The channel "Pull leaders only" aims at by default: the `leads` group's
 * channel when that group exists and has one, else null. It is the
 * leaders-only channel (#1199).
 */
export function resolveLeadsChannel(event: {
  groups?: readonly LeaderGroup[] | null;
}): string | null {
  for (const g of event.groups ?? []) {
    if (g.kind === "leads" && g.channelId) return g.channelId;
  }
  return null;
}
