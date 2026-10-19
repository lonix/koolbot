/**
 * The pure rules of the leader customiser (#1196): which button belongs to
 * which group, when a group's channel carries the control message, and who may
 * use it. No database or Discord import, so the channel pass, the handler, the
 * writer and the tests all read one rule.
 *
 * Every decision made from these functions must be made from a FRESH read, as
 * close to its write as possible; the callers say so where they use them.
 */

import { effectiveLeaders, type LeaderGroup } from "./event-leader-roles.js";

// ---------------------------------------------------------------------
// Custom ids: only the event id and the group key, never anything else
// ---------------------------------------------------------------------

/** Both interactions start with this; `src/index.ts` routes on it. */
export const CUSTOMISE_ID_PREFIX = "evcust:";

const CUSTOMISE_ID_RE = /^evcust:(btn|modal):([0-9a-f]{24}):(g_[0-9a-f]{8})$/;

export type CustomiseInteractionKind = "btn" | "modal";

export function customiseCustomId(
  kind: CustomiseInteractionKind,
  eventId: string,
  groupKey: string,
): string {
  return `${CUSTOMISE_ID_PREFIX}${kind}:${eventId}:${groupKey}`;
}

/**
 * Read a custom id. A group key contains an underscore, so this is one anchored
 * pattern, never a split. Null for anything that does not match exactly: the
 * caller trusts nothing else from the id (the event, the group and the person
 * are all checked against a fresh read).
 */
export function parseCustomiseCustomId(customId: string): {
  kind: CustomiseInteractionKind;
  eventId: string;
  groupKey: string;
} | null {
  const m = CUSTOMISE_ID_RE.exec(customId);
  if (!m) return null;
  return {
    kind: m[1] as CustomiseInteractionKind,
    eventId: m[2],
    groupKey: m[3],
  };
}

// ---------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------

/** The fields of an event the rules read (a lean row may lack any). */
export interface CustomiseEvent {
  state?: string;
  groupsEnabled?: boolean;
  captainsEnabled?: boolean;
  captainCustomisationEnabled?: boolean;
  leaderLabel?: string;
  groups?: readonly (LeaderGroup & { name?: string })[] | null;
}

export const OPEN_STATES = ["scheduled", "active"] as const;

/** Whether a state is one an event can still be customised in. */
export function isOpenState(state: string | null | undefined): boolean {
  return (OPEN_STATES as readonly string[]).includes(state ?? "");
}

/** Both switches, as the writer, the channel pass and the panel all read them. */
export function customisationOn(
  event: CustomiseEvent | null | undefined,
): boolean {
  return (
    !!event &&
    event.groupsEnabled === true &&
    event.captainsEnabled === true &&
    event.captainCustomisationEnabled === true
  );
}

/**
 * Whether a group's channel should carry the control message: customisation on
 * (leaders too), the event open, a team group with a channel. `eventsEnabled`
 * is `events.enabled`, read by the caller; anything but true is off (fails
 * closed).
 */
export function controlWanted(
  event: CustomiseEvent,
  group: LeaderGroup,
  eventsEnabled: boolean | null,
): boolean {
  return (
    eventsEnabled === true &&
    isOpenState(event.state) &&
    customisationOn(event) &&
    group.kind === "team" &&
    !!group.channelId
  );
}

export type CustomiseRefusal =
  | "events-off"
  | "not-found"
  | "closed"
  | "no-groups"
  | "leaders-off"
  | "customise-off"
  | "no-group"
  | "not-team"
  | "not-leader"
  | "wrong-channel";

export function refusalMessage(
  code: CustomiseRefusal,
  leaderLabel = "Leader",
): string {
  const label = (leaderLabel || "Leader").toLowerCase();
  switch (code) {
    case "events-off":
      return "Events are switched off on this server right now, so team changes are paused.";
    case "not-found":
    case "closed":
      return "This event is no longer running, so its teams cannot be changed.";
    case "no-groups":
      return "This event has no teams any more.";
    case "leaders-off":
      return "Team leaders are switched off for this event.";
    case "customise-off":
      return `The host has not allowed ${label}s to customise their team (or has switched it off).`;
    case "no-group":
      return "This team does not exist any more.";
    case "not-team":
      return "Only a team can be customised.";
    case "not-leader":
      return `Only the current ${label} of this team can change its name and tag.`;
    case "wrong-channel":
      return "This button does not belong to this channel any more.";
  }
}

/**
 * Whether `actorId` may customise group `groupKey` NOW, judged from `event`
 * (which must be a fresh read) and `eventsEnabled` (null = unreadable, which
 * refuses). Null means allowed. The leader is read through `effectiveLeaders`,
 * never from `captainId` alone, and only that team's own leader passes.
 * `channelId`, when given (the channel the interaction came from), must be the
 * group's current channel.
 */
export function customiseRefusal(opts: {
  event: CustomiseEvent | null | undefined;
  eventsEnabled: boolean | null;
  groupKey: string;
  actorId: string;
  channelId?: string | null;
}): CustomiseRefusal | null {
  const { event, groupKey, actorId } = opts;
  if (opts.eventsEnabled !== true) return "events-off";
  if (!event) return "not-found";
  if (!isOpenState(event.state)) return "closed";
  if (event.groupsEnabled !== true || (event.groups ?? []).length === 0) {
    return "no-groups";
  }
  if (event.captainsEnabled !== true) return "leaders-off";
  if (event.captainCustomisationEnabled !== true) return "customise-off";
  const group = (event.groups ?? []).find((g) => g.key === groupKey);
  if (!group) return "no-group";
  if (group.kind !== "team") return "not-team";
  const leads = effectiveLeaders(event.groups).some(
    (l) => l.groupKey === groupKey && l.userId === actorId,
  );
  if (!leads) return "not-leader";
  if (
    opts.channelId !== undefined &&
    opts.channelId !== null &&
    group.channelId !== opts.channelId
  ) {
    return "wrong-channel";
  }
  return null;
}

/**
 * Case-insensitive name another group of the event has, or HAS RESERVED: a
 * team a leader renamed keeps its original name reserved (`originalName`), so
 * a leader can never take the name another team's reset must go back to.
 * Without that, valid edits could swap names around (Red to Green, Blue to
 * Red, Green to Blue) until every team's original is held by another and no
 * reset could ever succeed.
 */
export function nameTakenByOther(
  groups:
    | readonly { key: string; name?: string; originalName?: string }[]
    | null
    | undefined,
  groupKey: string,
  name: string,
): boolean {
  const folded = name.toLowerCase();
  return (groups ?? []).some(
    (g) =>
      g.key !== groupKey &&
      ((g.name ?? "").toLowerCase() === folded ||
        (g.originalName ?? "").toLowerCase() === folded),
  );
}
