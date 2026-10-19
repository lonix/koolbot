/**
 * The leader customiser (#1196): a team's own leader renames the team and sets
 * its clan tag from Discord, and the host resets any team from the panel.
 *
 * Two entry points write: `customiseGroup` (a leader, from the modal) and
 * `resetGroupCustomisation` (the host). Both write a group's `name` and `tag`
 * and nothing else of the group except the bookkeeping named below.
 *
 * ## Invariants (read before changing anything here)
 *
 * 1. **The authorisation IS the write.** "Is this person this team's current
 *    leader, are leaders and customisation both on, is the event open" is
 *    decided from a FRESH read inside the per-event group lock (the lock of
 *    every membership and leader change) and repeated in the filter of the one
 *    conditional `updateOne` that stores the change (`$elemMatch` on key, kind,
 *    `captainId` and `memberIds`, plus the three event switches and the open
 *    states). A leader removed, unassigned, or a switch turned off between the
 *    read and the write matches nothing and is refused (`write-failed`); nothing
 *    is stored on a stale decision. The decision never uses `captainId` alone
 *    (`effectiveLeaders`), the toggles are read at submit and never cached, and
 *    nothing is queued or awaited between the read and the write but the write.
 * 2. **Fail closed.** An unreadable event or `events.enabled` refuses; unknown
 *    is never "allowed". A custom id carries only the event id and group key
 *    (`event-customise-rules.ts`); the event, group, guild, channel and person
 *    are all checked against the fresh row and the interaction.
 * 3. **The stored name is the truth, the channel follows.** The write sets
 *    `nameSyncPending`; the channel rename comes after, in the channel pass
 *    (`EventGroupChannels.syncNames`, under the per-event channel lock, through
 *    the shared rename queue), and clears the flag only after a confirmed
 *    rename. A failed, refused, rate-limited or timed-out rename leaves the flag
 *    set and the scan finishes it; there is never a silent mismatch. The group
 *    lock and the channel lock are never held together.
 * 4. **Rate limits are reported, never slept on.** A leader whose rename does
 *    not fit Discord's budget for that channel (about 2 per 10 minutes) is told
 *    when to try again BEFORE anything is written, so what they see in the
 *    channel is what is saved. If only the tag changed too, the tag still
 *    applies and the name is reported as not changed. If the budget runs out
 *    between that check and the rename (the host renamed too), the name is
 *    saved, marked pending and the person is told it will follow.
 * 5. **The host's values are kept once.** The first leader edit stores the
 *    host's name and tag in `originalName` / `originalTag` in the SAME write
 *    (filtered on them still being absent), so the host panel's reset has
 *    something to go back to for a Custom event as well as a preset one, and a
 *    recurring series' next occurrence starts from them (`copyGroupSetup`).
 *    Reset restores them and clears them.
 * 6. **Tags follow through the one tag function.** After a tag change lands the
 *    members of the group are brought in line by `EventNicknameTags.syncMember`
 *    (never computed here, never from the current nickname), in the background:
 *    it is paced and the interaction must not wait for it. A sweep is also
 *    requested, so a restart in the middle converges.
 * 7. **Same rules as the form.** Name and tag go through `checkGroupName` and
 *    `checkGroupTag` (`event-groups.ts`), the rules of the event form; a name
 *    must be unique (case-insensitive) among the event's groups, checked inside
 *    the lock.
 * 8. **No per-person state.** Nothing here is keyed by user id in memory (the
 *    rename queue is keyed by channel). The audit row of a leader's edit carries
 *    the leader's id like any other audit row (`web-audit-log` is the retained
 *    admin audit trail in the registry), with the group key and what changed.
 */

import type { Client } from "discord.js";
import { Event } from "../models/event.js";
import { EventNicknameTags } from "./event-nickname-tags.js";
import { TrackingOptOutService } from "./tracking-opt-out-service.js";
import logger from "../utils/logger.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";
import { escapeDisplayText } from "../utils/allowed-mentions.js";
import { ConfigService } from "./config-service.js";
import { withGroupLock } from "./event-group-assignment.js";
import { checkGroupName, checkGroupTag } from "./event-groups.js";
import {
  OPEN_STATES,
  customiseRefusal,
  isOpenState,
  nameTakenByOther,
  refusalMessage,
  type CustomiseRefusal,
} from "./event-customise-rules.js";
import type { NameSyncOutcome } from "./event-group-channels.js";
import { describeRetryIn, getRenameQueue } from "./event-rename-queue.js";
import { recordAudit, boundAuditEntry } from "../web/audit.js";
import type { WebSessionContext } from "../web/session.js";

const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

/** Read the row the customiser decides from (the button reads it too). */
export const readCustomiseRow = (
  guildId: string,
  eventId: string,
): Promise<CustomiseRow | null> => readRow(guildId, eventId);

export interface CustomiseDeps {
  /** `events.enabled`; null when it could not be read (refuses). */
  eventsEnabled: () => Promise<boolean | null>;
  /** Finish the pending channel rename of one group (channel pass). */
  syncName: (
    guildId: string,
    eventId: string,
    groupKey: string,
  ) => Promise<NameSyncOutcome | null>;
  /** Bring these members' nicknames in line; must not block the caller. */
  retag: (guildId: string, eventId: string, memberIds: string[]) => void;
}

export async function readEventsEnabled(): Promise<boolean | null> {
  try {
    return await ConfigService.getInstance().getBoolean(
      "events.enabled",
      false,
    );
  } catch (err) {
    logger.warn("Could not read events.enabled for a customise edit:", err);
    return null;
  }
}

interface CustomiseRow {
  state: string;
  groupsEnabled?: boolean;
  captainsEnabled?: boolean;
  captainCustomisationEnabled?: boolean;
  tagsEnabled?: boolean;
  leaderLabel?: string;
  groups?: Array<{
    key: string;
    name: string;
    tag?: string;
    kind?: string;
    channelId?: string | null;
    memberIds?: string[];
    captainId?: string | null;
    originalName?: string;
    originalTag?: string;
  }>;
}

async function readRow(
  guildId: string,
  eventId: string,
): Promise<CustomiseRow | null> {
  if (!OBJECT_ID_RE.test(eventId)) return null;
  return (await Event.findOne({ _id: eventId, guildId })
    .select(
      "state groupsEnabled captainsEnabled captainCustomisationEnabled tagsEnabled leaderLabel groups",
    )
    .lean()) as CustomiseRow | null;
}

export type CustomiseFailure =
  | CustomiseRefusal
  | "invalid"
  | "name-taken"
  | "rename-limited"
  | "write-failed"
  | "unreadable";

export type CustomiseResult =
  | {
      ok: true;
      changed: boolean;
      nameChanged: boolean;
      tagChanged: boolean;
      /** Lines for the person, in order. */
      lines: string[];
      /** What the audit row records. */
      details: Record<string, unknown>;
    }
  | {
      ok: false;
      code: CustomiseFailure;
      message: string;
      /** Field errors of `invalid`. */
      errors?: string[];
      retryAfterMs?: number;
    };

function refuse(
  code: CustomiseFailure,
  message: string,
  extra: { errors?: string[]; retryAfterMs?: number } = {},
): CustomiseResult {
  return { ok: false, code, message, ...extra };
}

/** The sentence about the channel after a rename was attempted. */
export function describeNameOutcome(
  rawName: string,
  outcome: NameSyncOutcome | null,
): string {
  // Member-supplied text goes into a Discord message: shown as plain text.
  const name = escapeDisplayText(rawName);
  if (!outcome || outcome.status === "skipped") {
    return `The team is now called "${name}". Its channel will use the new name.`;
  }
  switch (outcome.status) {
    case "applied":
      return `The team and its channel are now called "${name}".`;
    case "limited":
      return `The team is now called "${name}". Discord only allows about 2 renames per channel every 10 minutes, so the channel will be renamed in ${describeRetryIn(outcome.retryAfterMs ?? 0)} (KoolBot does it by itself).`;
    case "failed":
    case "unconfirmed":
      return `The team is now called "${name}", but Discord did not confirm renaming the channel yet. KoolBot keeps trying.`;
  }
}

/**
 * A leader changes their team's name and/or tag. `rawName` / `rawTag` are the
 * submitted texts, or null for a field that was not part of the form (left
 * unchanged). Never throws.
 */
export async function customiseGroup(
  opts: {
    guildId: string;
    eventId: string;
    groupKey: string;
    actorId: string;
    /** The channel the interaction came from. */
    channelId: string | null;
    rawName: string | null;
    rawTag: string | null;
  },
  deps: CustomiseDeps,
): Promise<CustomiseResult> {
  const { guildId, eventId, groupKey, actorId } = opts;

  // Input first: pure, no I/O, the form's own rules.
  const errors: string[] = [];
  const nameCheck = opts.rawName === null ? null : checkGroupName(opts.rawName);
  const tagCheck = opts.rawTag === null ? null : checkGroupTag(opts.rawTag);
  if (nameCheck && !nameCheck.ok) errors.push(`Name: ${nameCheck.error}`);
  if (tagCheck && !tagCheck.ok) errors.push(`Tag: ${tagCheck.error}`);
  if (errors.length > 0) {
    return refuse("invalid", errors.join(" "), { errors });
  }

  type Locked =
    | { done: CustomiseResult }
    | {
        done: null;
        group: NonNullable<CustomiseRow["groups"]>[number];
        nameChanged: boolean;
        tagChanged: boolean;
        newName: string;
        newTag: string;
        nameDeferredMs: number | null;
        pending: boolean;
        tagsEnabled: boolean;
        state: string;
        memberIds: string[];
      };

  const locked = await withGroupLock(
    guildId,
    eventId,
    async (): Promise<Locked> => {
      const eventsEnabled = await deps.eventsEnabled();
      let row: CustomiseRow | null;
      try {
        row = await readRow(guildId, eventId);
      } catch (err) {
        logger.error(
          `Could not read event ${sanitizeForLog(eventId)} for a customise edit:`,
          err,
        );
        return {
          done: refuse(
            "unreadable",
            "The event could not be read, so nothing was changed. Try again in a moment.",
          ),
        };
      }
      const refusal = customiseRefusal({
        event: row,
        eventsEnabled,
        groupKey,
        actorId,
        channelId: opts.channelId,
      });
      if (refusal) {
        return {
          done: refuse(refusal, refusalMessage(refusal, row?.leaderLabel)),
        };
      }
      const ev = row as CustomiseRow;
      const group = (ev.groups ?? []).find((g) => g.key === groupKey)!;
      const newName = nameCheck ? nameCheck.value : group.name;
      const newTag = tagCheck ? tagCheck.value : (group.tag ?? "");
      if (nameCheck && nameTakenByOther(ev.groups, groupKey, newName)) {
        return {
          done: refuse(
            "name-taken",
            `Another team is already called "${escapeDisplayText(newName)}". Pick a different name.`,
          ),
        };
      }
      let nameChanged = newName !== group.name;
      const tagChanged = newTag !== (group.tag ?? "");
      if (!nameChanged && !tagChanged) {
        return {
          done: {
            ok: true,
            changed: false,
            nameChanged: false,
            tagChanged: false,
            lines: ["Nothing changed: that is already the name and tag."],
            details: { group: groupKey, changed: false },
          },
        };
      }
      // The rename budget, checked BEFORE anything is written (invariant 4).
      let nameDeferredMs: number | null = null;
      if (nameChanged && group.channelId) {
        const slot = getRenameQueue().check(group.channelId);
        if (!slot.ok) {
          if (!tagChanged) {
            return {
              done: refuse(
                "rename-limited",
                `Discord only allows about 2 renames per channel every 10 minutes. The team was not renamed: try again in ${describeRetryIn(slot.retryAfterMs)}.`,
                { retryAfterMs: slot.retryAfterMs },
              ),
            };
          }
          nameChanged = false;
          nameDeferredMs = slot.retryAfterMs;
        }
      }
      const firstEdit = !group.originalName;
      const $set: Record<string, unknown> = {};
      if (nameChanged) {
        $set["groups.$[g].name"] = newName;
        if (group.channelId) $set["groups.$[g].nameSyncPending"] = true;
      }
      if (tagChanged) $set["groups.$[g].tag"] = newTag;
      if (firstEdit) {
        $set["groups.$[g].originalName"] = group.name;
        $set["groups.$[g].originalTag"] = group.tag ?? "";
      }
      const result = await Event.updateOne(
        {
          _id: eventId,
          guildId,
          state: { $in: [...OPEN_STATES] },
          groupsEnabled: true,
          captainsEnabled: true,
          captainCustomisationEnabled: true,
          groups: {
            $elemMatch: {
              key: groupKey,
              kind: "team",
              captainId: actorId,
              memberIds: actorId,
              name: group.name,
              ...(firstEdit ? { originalName: { $in: [null, ""] } } : {}),
            },
          },
        },
        { $set },
        { arrayFilters: [{ "g.key": groupKey }] },
      );
      if ((result?.modifiedCount ?? 0) !== 1) {
        return {
          done: refuse(
            "write-failed",
            "The team changed while this was being saved (or you are no longer its leader). Nothing was changed; open the button again.",
          ),
        };
      }
      return {
        done: null,
        group,
        nameChanged,
        tagChanged,
        newName,
        newTag,
        nameDeferredMs,
        pending: nameChanged && !!group.channelId,
        tagsEnabled: ev.tagsEnabled === true,
        state: ev.state,
        memberIds: [...(group.memberIds ?? [])],
      };
    },
  );
  if (locked.done) return locked.done;

  // From here on the change is stored. The channel and the nicknames follow,
  // outside the group lock (invariant 3).
  const lines: string[] = [];
  if (locked.pending) {
    let outcome: NameSyncOutcome | null;
    try {
      outcome = await deps.syncName(guildId, eventId, groupKey);
    } catch (err) {
      logger.error(
        `Renaming the channel of group ${sanitizeForLog(groupKey)} failed:`,
        err,
      );
      outcome = { groupKey, status: "unconfirmed" };
    }
    lines.push(describeNameOutcome(locked.newName, outcome));
  } else if (locked.nameChanged) {
    lines.push(describeNameOutcome(locked.newName, null));
  }
  if (locked.nameDeferredMs !== null) {
    lines.push(
      `The name was not changed: Discord only allows about 2 renames per channel every 10 minutes. Try again in ${describeRetryIn(locked.nameDeferredMs)}.`,
    );
  }
  if (locked.tagChanged) {
    lines.push(
      locked.newTag
        ? `The tag is now "${escapeDisplayText(locked.newTag)}".`
        : "The team has no tag now.",
    );
    if (locked.tagsEnabled && locked.state === "active") {
      lines.push("Nicknames are being updated; it can take a little while.");
      try {
        deps.retag(guildId, eventId, locked.memberIds);
      } catch (err) {
        logger.error("Could not start the nickname update:", err);
      }
    }
  }
  return {
    ok: true,
    changed: true,
    nameChanged: locked.nameChanged,
    tagChanged: locked.tagChanged,
    lines,
    details: {
      group: groupKey,
      changed: true,
      nameFrom: locked.nameChanged ? locked.group.name : undefined,
      nameTo: locked.nameChanged ? locked.newName : undefined,
      tagFrom: locked.tagChanged ? (locked.group.tag ?? "") : undefined,
      tagTo: locked.tagChanged ? locked.newTag : undefined,
      nameDeferred: locked.nameDeferredMs !== null || undefined,
    },
  };
}

/**
 * The identity a leader's Discord-side edit is audited under: not a web
 * session, so a synthetic one shaped like the role-group sync's, with the
 * leader's own id (the row is how the host sees who changed what).
 */
export function leaderAuditSession(
  guildId: string,
  actorId: string,
): WebSessionContext {
  return {
    sessionId: "discord:event-leader",
    discordUserId: actorId,
    guildId,
    role: "user",
    scopes: [],
    lastActivityAt: Date.now(),
    expiresAt: new Date(Date.now() + 60_000),
  };
}

export const LEADER_AUDIT_ACTION = "event.leader.customise";

/** Record a leader's edit (or refused attempt on a real event) once. Never throws. */
export async function auditLeaderEdit(opts: {
  guildId: string;
  eventId: string;
  actorId: string;
  result: CustomiseResult;
  groupKey: string;
}): Promise<void> {
  const { result } = opts;
  try {
    await recordAudit(
      leaderAuditSession(opts.guildId, opts.actorId),
      boundAuditEntry({
        action: LEADER_AUDIT_ACTION,
        targetId: opts.eventId,
        details: result.ok
          ? (result.details as Record<string, unknown>)
          : { group: opts.groupKey, code: result.code },
        result: result.ok ? "success" : "failure",
        errorMessage: result.ok ? null : result.code,
      }),
    );
  } catch (err) {
    logger.error("Could not record a leader customise audit entry:", err);
  }
}

// ---------------------------------------------------------------------
// Host reset
// ---------------------------------------------------------------------

export type ResetResult =
  | {
      ok: true;
      changed: boolean;
      message: string;
      details: Record<string, unknown>;
    }
  | { ok: false; code: string; message: string };

/**
 * The host puts a team's name and tag back to what they were before a leader
 * changed them. Works whatever the leaders' switches say (the host can always
 * tidy up), on an open event only. Same discipline as `customiseGroup`: a
 * fresh read inside the group lock, one conditional write, the channel and the
 * nicknames follow outside the lock. A team nobody customised answers "already
 * the default" and writes nothing.
 */
export async function resetGroupCustomisation(
  opts: { guildId: string; eventId: string; groupKey: string },
  deps: Pick<CustomiseDeps, "syncName" | "retag">,
): Promise<ResetResult> {
  const { guildId, eventId, groupKey } = opts;
  type Locked =
    | { done: ResetResult }
    | {
        done: null;
        name: string;
        tag: string;
        from: { name: string; tag: string };
        hasChannel: boolean;
        tagChanged: boolean;
        tagsEnabled: boolean;
        active: boolean;
        memberIds: string[];
      };
  const locked = await withGroupLock(
    guildId,
    eventId,
    async (): Promise<Locked> => {
      let row: CustomiseRow | null;
      try {
        row = await readRow(guildId, eventId);
      } catch (err) {
        logger.error("Could not read an event for a team reset:", err);
        return {
          done: {
            ok: false,
            code: "unreadable",
            message: "The event could not be read. Try again in a moment.",
          },
        };
      }
      if (!row) {
        return {
          done: {
            ok: false,
            code: "not-found",
            message: "That event no longer exists.",
          },
        };
      }
      if (!isOpenState(row.state)) {
        return {
          done: {
            ok: false,
            code: "closed",
            message:
              "This event is no longer running, so its teams cannot be changed.",
          },
        };
      }
      const group = (row.groups ?? []).find((g) => g.key === groupKey);
      if (!group) {
        return {
          done: {
            ok: false,
            code: "no-group",
            message: "That team does not exist any more. Reload the page.",
          },
        };
      }
      if (!group.originalName) {
        return {
          done: {
            ok: true,
            changed: false,
            message: `${escapeDisplayText(group.name)} already has its original name and tag.`,
            details: { group: groupKey, changed: false },
          },
        };
      }
      const name = group.originalName;
      const tag = group.originalTag ?? "";
      if (nameTakenByOther(row.groups, groupKey, name)) {
        return {
          done: {
            ok: false,
            code: "name-taken",
            message: `Another team is now called "${escapeDisplayText(name)}". Reset that team first.`,
          },
        };
      }
      const nameChanged = name !== group.name;
      const result = await Event.updateOne(
        {
          _id: eventId,
          guildId,
          state: { $in: [...OPEN_STATES] },
          groups: {
            $elemMatch: {
              key: groupKey,
              name: group.name,
              originalName: name,
            },
          },
        },
        {
          $set: {
            "groups.$[g].name": name,
            "groups.$[g].tag": tag,
            // Never cleared here: a rename already pending stays pending.
            ...(nameChanged && group.channelId
              ? { "groups.$[g].nameSyncPending": true }
              : {}),
          },
          $unset: {
            "groups.$[g].originalName": "",
            "groups.$[g].originalTag": "",
          },
        },
        { arrayFilters: [{ "g.key": groupKey }] },
      );
      if ((result?.modifiedCount ?? 0) !== 1) {
        return {
          done: {
            ok: false,
            code: "write-failed",
            message:
              "The team changed while this was being saved. Reload the page and try again.",
          },
        };
      }
      return {
        done: null,
        name,
        tag,
        from: { name: group.name, tag: group.tag ?? "" },
        hasChannel: nameChanged && !!group.channelId,
        tagChanged: tag !== (group.tag ?? ""),
        tagsEnabled: row.tagsEnabled === true,
        active: row.state === "active",
        memberIds: [...(group.memberIds ?? [])],
      };
    },
  );
  if (locked.done) return locked.done;

  const parts: string[] = [`Team reset to "${escapeDisplayText(locked.name)}"`];
  if (locked.hasChannel) {
    let outcome: NameSyncOutcome | null;
    try {
      outcome = await deps.syncName(guildId, eventId, groupKey);
    } catch (err) {
      logger.error("Renaming a channel after a team reset failed:", err);
      outcome = { groupKey, status: "unconfirmed" };
    }
    if (outcome && outcome.status === "limited") {
      parts.push(
        `its channel will be renamed in ${describeRetryIn(outcome.retryAfterMs ?? 0)}`,
      );
    } else if (
      outcome &&
      (outcome.status === "failed" || outcome.status === "unconfirmed")
    ) {
      parts.push("its channel rename is pending and will be retried");
    }
  }
  if (locked.tagChanged && locked.tagsEnabled && locked.active) {
    try {
      deps.retag(guildId, eventId, locked.memberIds);
      parts.push("nicknames are being updated");
    } catch (err) {
      logger.error("Could not start the nickname update:", err);
    }
  }
  return {
    ok: true,
    changed: true,
    message: `${parts.join("; ")}.`,
    details: {
      group: groupKey,
      changed: true,
      nameFrom: locked.from.name,
      nameTo: locked.name,
      tagFrom: locked.from.tag,
      tagTo: locked.tag,
    },
  };
}

// ---------------------------------------------------------------------
// The real dependencies
// ---------------------------------------------------------------------

/**
 * Bring the members of a group in line with the stored tag, in the background:
 * one `syncMember` each (the one tag function; paced and queued inside), then a
 * sweep as the backstop for a restart in the middle. Each member's reset
 * ticket is taken right before their own call. Errors are logged, never thrown.
 */
async function retagMembers(
  client: Client,
  guildId: string,
  eventId: string,
  memberIds: string[],
): Promise<void> {
  const tags = EventNicknameTags.getInstance(client);
  for (const userId of memberIds) {
    try {
      await tags.syncMember({
        guildId,
        eventId,
        userId,
        admission: TrackingOptOutService.getInstance().admission(),
      });
    } catch (err) {
      logger.error(
        `Event tags: syncing ${sanitizeForLog(userId)} after a tag change failed:`,
        err,
      );
    }
  }
  tags.requestSweep(guildId);
}

export function createCustomiseDeps(client: Client): CustomiseDeps {
  return {
    eventsEnabled: readEventsEnabled,
    async syncName(
      guildId,
      eventId,
      groupKey,
    ): Promise<NameSyncOutcome | null> {
      const { EventService } = await import("./event-service.js");
      const outcomes = await EventService.getInstance(client).syncGroupNames(
        eventId,
        guildId,
        groupKey,
      );
      return outcomes?.find((o) => o.groupKey === groupKey) ?? null;
    },
    retag(guildId, eventId, memberIds): void {
      void retagMembers(client, guildId, eventId, memberIds).catch(
        (err: unknown) =>
          logger.error("Nickname update after a tag change failed:", err),
      );
    },
  };
}
