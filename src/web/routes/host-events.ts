/**
 * Event host panel routes (#1189), mounted on the member surface at
 * `/me/events/:id/host` (see `createUserRouter`).
 *
 * Why `/me` and not `/admin`: the host is the event creator, who is often not
 * a Web UI admin, and the whole `/admin` write surface is behind the admin
 * role check. `/me` accepts both session roles and already carries the
 * session check, the general rate limit and the write rate limit.
 *
 * Every request under the prefix passes one gate, in this order:
 *   1. CSRF (state-changing methods only; GET passes),
 *   2. the event is loaded ONCE and checked with `isEventHost`
 *      (session read synchronously, before the first await),
 *   3. otherwise 403, with the same body whether the event does not exist,
 *      belongs to another guild, or belongs to someone else, so ids cannot be
 *      probed. A refused write is audited.
 * Because the gate is `router.use` on the prefix, any path under it (case,
 * trailing or repeated slashes included) is matched by the same Express rules
 * as the handlers, so no variant reaches a handler without the gate.
 *
 * Extension points for later issues: add a section body to
 * `HOST_SECTION_RENDERERS`, and add an action with `hostAction`.
 * Leaders (#1195) are the `leaders` section: `set-leader`, `leader-label`,
 * `pull-leaders`.
 */

import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { Client } from "discord.js";
import logger from "../../utils/logger.js";
import {
  EventService,
  formatEventWhen,
  isRecurring,
  recurrenceLabel,
} from "../../services/event-service.js";
import type { IEvent } from "../../models/event.js";
import { requireCsrf } from "../csrf.js";
import type { AuthenticatedRequest, WebSessionContext } from "../session.js";
import { getDisplayedRemainingMs } from "../admin-layout.js";
import { boundAuditEntry, recordAudit, type AuditEntry } from "../audit.js";
import { readMeSurfaceFlags } from "../me-surfaces.js";
import { renderUserPage, type UserFlashMessage } from "../user-layout.js";
import { renderErrorPage } from "../views.js";
import { isEventHost } from "../event-host.js";
import { hostControlsAvailable, hostPanelPath } from "../host-panel-shared.js";
import {
  renderHostPanelBody,
  type HostPanelEvent,
  type HostSectionId,
} from "../host-panel-view.js";
import { readSignedFlash, signFlash, truncateFlash } from "../http-flash.js";
import { sanitizeForLog } from "../../utils/log-sanitize.js";
import { randomBytes } from "node:crypto";
import { ConfigService } from "../../services/config-service.js";
import { EventNicknameTags } from "../../services/event-nickname-tags.js";
import { TrackingOptOutService } from "../../services/tracking-opt-out-service.js";
import {
  assignMember,
  randomiseMembers,
  setGroupsLocked,
} from "../../services/event-group-assignment.js";
import {
  cachedMemberName,
  readEventPresence,
} from "../../services/event-group-presence.js";
import {
  groupKeyOf,
  type RandomiseMode,
} from "../../services/event-group-plan.js";
import {
  describeMoveReport,
  moveEventMembers,
  moveMembersBlocker,
  planMoveOne,
  planReturnToMain,
  planSendToGroups,
  type MoveOutcome,
  type MoveSkipReason,
} from "../../services/event-member-moves.js";
import {
  renderMovesSection,
  type MoveDestinationView,
  type MovePersonView,
} from "../host-moves-view.js";
import {
  END_CONFIRM_FIELD,
  END_PULL_BACK_FIELD,
  renderEndSection,
} from "../event-end-view.js";
import { summariseEnd } from "../../services/event-teardown.js";
import {
  groupFill,
  renderAssignmentSection,
  type AssignmentGroupView,
  type AssignmentPersonView,
} from "../host-assignment-view.js";
import {
  effectiveLeaders,
  planPullLeaders,
  resolveLeadsChannel,
  setGroupLeader,
  setLeaderLabel,
  PULL_DEFAULT,
  PULL_HERE,
  PULL_MAIN,
} from "../../services/event-group-leaders.js";
import { validateLeaderLabel } from "../../services/event-groups.js";
import { customisationOn } from "../../services/event-customise-rules.js";
import {
  LEADER_AUDIT_ACTION,
  createCustomiseDeps,
  resetGroupCustomisation,
} from "../../services/event-leader-customise.js";
import { WebAuditLog } from "../../models/web-audit-log.js";
import {
  channelsExist,
  describeLiveEditOutcome,
  describeRowValue,
  isGroupOverSize,
  leadTimeRow,
  lockGroupsRow,
  parseSubmission,
  REFUSAL_MESSAGE,
  runLiveEdit,
  signConfirmation,
  verifyConfirmation,
  type ConfirmationCheck,
  type LiveEditDeps,
} from "../../services/event-live-edit.js";
import {
  renderConfirmBody,
  renderSettingsSection,
} from "../host-settings-view.js";
import { leadersTagsViewOf } from "../host-settings-leaders-tags-view.js";
import { createLiveEditEffects } from "../../services/event-live-edit-effects.js";
import {
  buildGroupEditView,
  prepareGroupEditBody,
} from "../host-settings-groups.js";
import {
  renderCustomiseSection,
  type CustomiseEditView,
} from "../host-customise-view.js";
import {
  renderLeadersSection,
  type LeaderDestinationView,
  type LeaderGroupView,
} from "../host-leaders-view.js";

/** A request that has passed the host gate. */
export type HostRequest = AuthenticatedRequest & {
  /** The event, loaded once by the gate. */
  hostEvent: IEvent;
  /** The session, read once by the gate. */
  hostSession: WebSessionContext;
  /**
   * The member-reset admission ticket (`TrackingOptOutService.admission()`),
   * taken synchronously at the start of the gate, BEFORE its asynchronous
   * event lookup. A write that adds a member passes it on, so a reset of that
   * member that completes while the request waits in the gate still refuses
   * the add.
   */
  hostAdmission: number;
};

/**
 * What a section renderer receives. One object, so a field can be added later
 * without changing every renderer. A form needs `csrfToken` (a hidden `_csrf`
 * input) and `actionPath(name)`, the URL of an action registered with
 * `hostAction(router, ..., name, ...)`.
 */
export interface HostSectionContext {
  event: IEvent;
  session: WebSessionContext;
  csrfToken: string;
  actionPath: (name: string) => string;
}

/**
 * Section HTML supplied by later issues; see `HOST_SECTIONS`. May be async
 * (member names, voice state). Return `undefined` to keep the placeholder.
 * Only called for scheduled and active events.
 */
export type HostSectionRenderer = (
  ctx: HostSectionContext,
) => string | undefined | Promise<string | undefined>;

/**
 * Bodies of the control sections, keyed by section id. Later issues add their
 * entry here (#1191 `assignment`, #1192 `moves`, #1193 `end`, #1197
 * `settings`); a section without an entry shows its placeholder. A renderer
 * returns HTML, or `undefined` to keep the placeholder.
 */
export const HOST_SECTION_RENDERERS: Partial<
  Record<HostSectionId, HostSectionRenderer>
> = {};

function getCsrfToken(req: Request): string {
  return (req as Request & { csrfToken?: string }).csrfToken ?? "";
}

function forbidden(res: Response): void {
  res
    .status(403)
    .type("text/html")
    .send(
      renderErrorPage({
        title: "Forbidden",
        heading: "Forbidden",
        product: "Koolbot",
        bodyHtml:
          `<p>This event is not yours to host, or it does not exist. ` +
          `Back to <a href="/me/">your overview</a>.</p>`,
      }),
    );
}

/** Redirect to the panel with a signed flash (not a bare query-string flash, #1149). */
export function hostPanelRedirect(
  res: Response,
  eventId: string,
  flash: UserFlashMessage,
): void {
  const text = truncateFlash(flash.text);
  const qs = new globalThis.URLSearchParams({
    flash: flash.type,
    msg: text,
    sig: signFlash(flash.type, text),
  }).toString();
  res.redirect(303, `${hostPanelPath(eventId)}?${qs}`);
}

export interface HostActionResult {
  ok: boolean;
  /** Shown to the host in the flash. */
  message: string;
  /** Audit details (bounded before storing). */
  details?: Record<string, unknown>;
  /** Audit error text when `ok` is false. */
  errorMessage?: string | null;
  /**
   * A full HTML page to answer with instead of the flash redirect (the live
   * edit's confirmation page, #1239). The audit row is still written once,
   * here, before the page is sent. The page is never cached (it has a token).
   */
  page?: string;
}

export interface HostActionOptions {
  /**
   * Run the handler for an ended or cancelled event too. Off by default: only
   * scheduled and active events have host controls, so a write against a
   * finished event is refused unless the action says otherwise.
   */
  allowFinished?: boolean;
}

/**
 * Register a host write action at `POST <panel>/<path>`. The gate (CSRF, host
 * check) has already run; this refuses the write when the event is no longer
 * scheduled or active (unless `allowFinished`), records exactly one audit row
 * (`event.host.<name>`, target = event id) and answers with a signed flash.
 * A thrown error is audited as a failure and passed on.
 */
export function hostAction(
  router: Router,
  name: string,
  path: string,
  handler: (ctx: {
    req: HostRequest;
    event: IEvent;
    session: WebSessionContext;
  }) => Promise<HostActionResult>,
  options: HostActionOptions = {},
): void {
  router.post(path, (req, res, next: NextFunction) => {
    const hreq = req as HostRequest;
    const { hostEvent: event, hostSession: session } = hreq;
    const eventId = String(event._id);
    const audit = (entry: AuditEntry): Promise<void> =>
      recordAudit(session, boundAuditEntry(entry));
    void (async (): Promise<void> => {
      if (!options.allowFinished && !hostControlsAvailable(event)) {
        const text = `This event is ${event.state}, so it can no longer be changed.`;
        await audit({
          action: `event.host.${name}`,
          targetId: eventId,
          result: "failure",
          errorMessage: `event is ${event.state}`,
        });
        hostPanelRedirect(res, eventId, { type: "err", text });
        return;
      }
      let result: HostActionResult;
      try {
        result = await handler({ req: hreq, event, session });
      } catch (err) {
        await audit({
          action: `event.host.${name}`,
          targetId: eventId,
          result: "failure",
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        next(err);
        return;
      }
      await audit({
        action: `event.host.${name}`,
        targetId: eventId,
        details: result.details,
        result: result.ok ? "success" : "failure",
        errorMessage: result.ok
          ? null
          : (result.errorMessage ?? result.message),
      });
      if (result.page !== undefined) {
        res
          .status(200)
          .set("Cache-Control", "no-store")
          .type("text/html")
          .send(result.page);
        return;
      }
      hostPanelRedirect(res, eventId, {
        type: result.ok ? "ok" : "err",
        text: result.message,
      });
    })().catch(next);
  });
}

/** A Discord user id as posted by the panel's forms. */
const USER_ID_RE = /^\d{15,25}$/;

const NO_VOICE_STATE =
  "The bot could not read who is in the voice channels, so nobody was assigned.";

function bodyString(req: Request, name: string): string {
  const body = req.body as Record<string, unknown> | undefined;
  const value = body?.[name];
  return typeof value === "string" ? value : "";
}

/** At most `limit` names, then "and N more". */
function nameList(names: string[], limit = 10): string {
  if (names.length <= limit) return names.join(", ");
  return `${names.slice(0, limit).join(", ")} and ${names.length - limit} more`;
}

function groupViews(event: IEvent): AssignmentGroupView[] {
  return (event.groups ?? []).map((g) => ({
    key: g.key,
    name: g.name,
    marker: g.marker ?? "",
    size: g.size ?? null,
    memberCount: (g.memberIds ?? []).length,
    isTeam: g.kind === "team",
  }));
}

/** The "Assign people" section (#1191). */
function createAssignmentSection(client: Client): HostSectionRenderer {
  return (ctx) => {
    const { event } = ctx;
    if (event.groupsEnabled !== true) return undefined;
    const presence = readEventPresence(client, event);
    const people: AssignmentPersonView[] = [];
    const listed = new Set<string>();
    // Leaders are marked only while the event has them switched on (#1195).
    const leaderIds = new Set(
      event.captainsEnabled === true
        ? effectiveLeaders(event.groups).map((l) => l.userId)
        : [],
    );
    const leaderLabelOf = (id: string): string | null =>
      leaderIds.has(id) ? event.leaderLabel || "Leader" : null;
    for (const m of presence.members) {
      listed.add(m.id);
      people.push({
        id: m.id,
        name: m.name,
        connected: true,
        groupKey: groupKeyOf(event.groups ?? [], m.id),
        leaderLabel: leaderLabelOf(m.id),
      });
    }
    // Assigned but not connected: still listed so they can be unassigned.
    for (const g of event.groups ?? []) {
      for (const id of g.memberIds ?? []) {
        if (listed.has(id)) continue;
        listed.add(id);
        people.push({
          id,
          name: cachedMemberName(client, event.guildId, id),
          connected: false,
          groupKey: groupKeyOf(event.groups ?? [], id),
          leaderLabel: leaderLabelOf(id),
        });
      }
    }
    return renderAssignmentSection({
      csrfToken: ctx.csrfToken,
      actionPath: ctx.actionPath,
      groups: groupViews(event),
      people,
      presenceOk: presence.ok,
      locked: event.groupsLocked === true,
      groupLabel: event.groupLabel || "Group",
    });
  };
}

const EVENTS_OFF =
  "Events are turned off, so nobody can be added to a group. Turn on events.enabled first.";

/**
 * The Events master switch (CLAUDE.md: a feature gates on its `*.enabled`
 * key). Fails closed: a failed read counts as off. Adding people is gated;
 * unassigning and the lock stay available.
 */
async function eventsEnabled(): Promise<boolean> {
  try {
    return await ConfigService.getInstance().getBoolean(
      "events.enabled",
      false,
    );
  } catch (err) {
    logger.warn("Could not read events.enabled for a host action:", err);
    return false;
  }
}

/** Assign, unassign, randomise and lock (#1191), each one audited change. */
function registerAssignmentActions(router: Router, client: Client): void {
  const assignTo = async (
    event: IEvent,
    userId: string,
    groupKey: string | null,
    admission: number,
  ): Promise<HostActionResult> => {
    if (!USER_ID_RE.test(userId)) {
      return { ok: false, message: "Pick a person from the list." };
    }
    const result = await assignMember({
      guildId: event.guildId,
      eventId: String(event._id),
      userId,
      groupKey,
      admission,
      // Asked by the service, inside the event lock, only for a real add.
      isConnected: () => {
        const presence = readEventPresence(client, event);
        return presence.ok
          ? presence.members.some((m) => m.id === userId)
          : null;
      },
    });
    if (!result.ok) {
      return {
        ok: false,
        message: result.message,
        details: { userId, group: groupKey },
        errorMessage: result.code,
      };
    }
    const who = cachedMemberName(client, event.guildId, userId);
    const group = groupKey
      ? (event.groups ?? []).find((g) => g.key === groupKey)
      : undefined;
    const message = !result.changed
      ? groupKey
        ? `${who} is already in ${group?.name ?? "that group"}.`
        : `${who} was not in a group.`
      : groupKey
        ? `${who} is now in ${group?.name ?? "the group"}.`
        : `${who} was taken out of their group.`;
    return {
      ok: true,
      message,
      details: {
        userId,
        from: result.fromKey,
        to: result.toKey,
        changed: result.changed,
      },
    };
  };

  // Each write action takes its reset-admission ticket as its very first
  // step, before any await, so a member data reset that engages while the
  // action waits (the voice read, the event lock) refuses the add.
  hostAction(router, "assign", "/assign", async ({ req, event }) => {
    const admission = req.hostAdmission;
    if (!(await eventsEnabled())) return { ok: false, message: EVENTS_OFF };
    const group = bodyString(req, "group");
    if (group.length === 0 || group.length > 32) {
      return {
        ok: false,
        message: "Choose a group to put the person in.",
      };
    }
    return assignTo(event, bodyString(req, "userId"), group, admission);
  });

  hostAction(router, "unassign", "/unassign", ({ req, event }) =>
    assignTo(event, bodyString(req, "userId"), null, req.hostAdmission),
  );

  hostAction(router, "randomise", "/randomise", async ({ req, event }) => {
    const admission = req.hostAdmission;
    if (!(await eventsEnabled())) return { ok: false, message: EVENTS_OFF };
    const rawMode = bodyString(req, "mode");
    if (rawMode !== "unassigned" && rawMode !== "everyone") {
      return { ok: false, message: "Choose who to randomise." };
    }
    const mode: RandomiseMode = rawMode;
    const presence = readEventPresence(client, event);
    if (!presence.ok) return { ok: false, message: NO_VOICE_STATE };
    if (presence.members.length === 0) {
      return { ok: false, message: "Nobody is connected to deal into groups." };
    }
    const seed = randomBytes(4).readUInt32BE(0);
    const result = await randomiseMembers({
      guildId: event.guildId,
      eventId: String(event._id),
      candidateIds: presence.members.map((m) => m.id),
      mode,
      seed,
      admission,
    });
    if (!result.ok) {
      return { ok: false, message: result.message, errorMessage: result.code };
    }
    const names = new Map(presence.members.map((m) => [m.id, m.name]));
    const perGroup = new Map<string, number>();
    for (const p of result.placed) {
      perGroup.set(p.groupKey, (perGroup.get(p.groupKey) ?? 0) + 1);
    }
    const parts = (event.groups ?? [])
      .filter((g) => perGroup.has(g.key))
      .map((g) => `${g.name} ${perGroup.get(g.key)}`);
    const n = result.placed.length;
    let message = `Placed ${n} ${n === 1 ? "person" : "people"}${parts.length ? ` (${parts.join(", ")})` : ""}.`;
    if (result.unplaced.length > 0) {
      const u = result.unplaced.length;
      message += ` ${u} did not fit and ${u === 1 ? "is" : "are"} unassigned: ${nameList(result.unplaced.map((id) => names.get(id) ?? id))}.`;
    }
    return {
      ok: true,
      message,
      // Counts and the seed, not names: one audit row for the whole deal.
      details: {
        mode,
        seed,
        candidates: presence.members.length,
        placed: n,
        unplaced: result.unplaced.length,
      },
    };
  });

  hostAction(router, "lock", "/lock", async ({ req, event }) => {
    const raw = bodyString(req, "locked");
    if (raw !== "1" && raw !== "0") {
      return { ok: false, message: "Choose lock or unlock." };
    }
    const locked = raw === "1";
    const result = await setGroupsLocked({
      guildId: event.guildId,
      eventId: String(event._id),
      locked,
    });
    if (!result.ok) {
      return { ok: false, message: result.message, errorMessage: result.code };
    }
    return {
      ok: true,
      message: locked
        ? "Groups are locked. Joining a channel no longer changes anyone's group."
        : "Groups are unlocked. Joining a group's channel puts people in that group.",
      details: { locked },
    };
  });
}

/** Voice channel facts from the gateway cache, for labels and fill. */
function channelFacts(
  client: Client,
  guildId: string,
  channelId: string,
): { occupants: number; limit: number } {
  const channel = client.guilds?.cache
    ?.get(guildId)
    ?.channels?.cache?.get(channelId);
  if (!channel || !channel.isVoiceBased()) return { occupants: 0, limit: 0 };
  return {
    occupants: channel.members?.size ?? 0,
    limit: (channel as { userLimit?: number }).userLimit ?? 0,
  };
}

/** The "Move people" section (#1192). */
function createMovesSection(client: Client): HostSectionRenderer {
  return (ctx) => {
    const { event } = ctx;
    if (event.groupsEnabled !== true) return undefined;
    const guild = client.guilds?.cache?.get(event.guildId);
    const presence = readEventPresence(client, event);
    let blocker = moveMembersBlocker(guild);
    if (!blocker && !presence.ok) {
      blocker =
        "The bot could not read who is in the voice channels, so moving people is switched off.";
    }
    const groups = event.groups ?? [];
    const labelOf = new Map<string, string>();
    const destinations: MoveDestinationView[] = [];
    if (event.channelId) {
      labelOf.set(event.channelId, "Main channel");
      destinations.push({
        value: "main",
        label: "Main channel",
        ...channelFacts(client, event.guildId, event.channelId),
      });
    }
    for (const g of groups) {
      if (!g.channelId) continue;
      const label = `${g.marker ? `${g.marker} ` : ""}${g.name}`;
      labelOf.set(g.channelId, label);
      destinations.push({
        value: g.key,
        label,
        ...channelFacts(client, event.guildId, g.channelId),
      });
    }
    const people: MovePersonView[] = presence.members.map((m) => ({
      id: m.id,
      name: m.name,
      where: labelOf.get(m.channelId) ?? "an event channel",
    }));
    const teams = groups.filter((g) => g.kind === "team");
    return renderMovesSection({
      csrfToken: ctx.csrfToken,
      actionPath: ctx.actionPath,
      blocker,
      sendableGroups: teams.filter((g) => !!g.channelId).length,
      waitingForChannel: teams
        .filter((g) => !g.channelId)
        .reduce((n, g) => n + (g.memberIds ?? []).length, 0),
      hasMain: !!event.channelId,
      destinations,
      people,
      groupLabel: event.groupLabel || "Group",
    });
  };
}

const MOVE_BUSY =
  "A move is already in progress for this event. Wait for it to finish, then try again.";

/** Turn a mover outcome into the host's result and its audit details. */
function moveResult(
  client: Client,
  event: IEvent,
  action: string,
  outcome: MoveOutcome,
  extra: string[] = [],
): HostActionResult {
  if (outcome.status === "busy") {
    return { ok: false, message: MOVE_BUSY, errorMessage: "busy" };
  }
  if (outcome.status === "refused") {
    return {
      ok: false,
      message: outcome.message,
      details: { action },
      errorMessage: outcome.code,
    };
  }
  const { report } = outcome;
  const skippedBy: Partial<Record<MoveSkipReason, number>> = {};
  for (const s of report.skipped) {
    skippedBy[s.reason] = (skippedBy[s.reason] ?? 0) + 1;
  }
  const nothingToDo = outcome.considered === 0;
  const message = nothingToDo
    ? ["Nobody needed to be moved.", ...extra].join(" ")
    : describeMoveReport(
        report,
        (id) => cachedMemberName(client, event.guildId, id),
        extra,
      );
  const anyDone = report.moved.length + report.unconfirmed.length > 0;
  const onlyQuiet =
    report.skipped.length > 0 &&
    report.skipped.every((s) => s.reason === "already-there");
  return {
    ok: nothingToDo || anyDone || onlyQuiet,
    message,
    // Counts only: no names, no ids.
    details: {
      action,
      considered: outcome.considered,
      moved: report.moved.length,
      unconfirmed: report.unconfirmed.length,
      skipped: skippedBy,
    },
    errorMessage: "nobody was moved",
  };
}

/** People never moved by a bulk run: the event's host and whoever is acting. */
function hostIds(event: IEvent, actingId: string): string[] {
  return [event.createdBy, actingId].filter((id): id is string => !!id);
}

/** Send to groups, return to main and move one person (#1192). */
function registerMoveActions(router: Router, client: Client): void {
  hostAction(
    router,
    "send-to-groups",
    "/send-to-groups",
    async ({ event, session }) => {
      let waiting = 0;
      const outcome = await moveEventMembers({
        client,
        guildId: event.guildId,
        eventId: String(event._id),
        excludeUserIds: hostIds(event, session.discordUserId),
        plan: ({ event: fresh }) => {
          for (const g of fresh.groups ?? []) {
            if (g.kind === "team" && !g.channelId) {
              waiting += (g.memberIds ?? []).length;
            }
          }
          return planSendToGroups(fresh);
        },
      });
      return moveResult(
        client,
        event,
        "send-to-groups",
        outcome,
        waiting > 0
          ? [
              `${waiting} assigned ${waiting === 1 ? "person is" : "people are"} in a group without a channel yet and ${waiting === 1 ? "was" : "were"} not moved.`,
            ]
          : [],
      );
    },
  );

  hostAction(
    router,
    "return-to-main",
    "/return-to-main",
    async ({ req, event, session }) => {
      const leaveSpecial = bodyString(req, "skipSpecial") === "1";
      const outcome = await moveEventMembers({
        client,
        guildId: event.guildId,
        eventId: String(event._id),
        excludeUserIds: hostIds(event, session.discordUserId),
        plan: ({ event: fresh, presence }) =>
          planReturnToMain(fresh, presence, leaveSpecial),
      });
      return moveResult(client, event, "return-to-main", outcome);
    },
  );

  hostAction(router, "move-one", "/move-one", async ({ req, event }) => {
    const userId = bodyString(req, "userId");
    const to = bodyString(req, "to");
    if (!USER_ID_RE.test(userId)) {
      return { ok: false, message: "Pick a person from the list." };
    }
    if (to.length === 0 || to.length > 32) {
      return { ok: false, message: "Choose where to move the person." };
    }
    const outcome = await moveEventMembers({
      client,
      guildId: event.guildId,
      eventId: String(event._id),
      // Moving one person is the host's explicit choice, host included.
      excludeUserIds: [],
      plan: ({ event: fresh }) => planMoveOne(fresh, userId, to),
    });
    const result = moveResult(client, event, "move-one", outcome);
    if (result.details) result.details.userId = userId;
    return result;
  });
}

/** The "End the event" section (#1193): shown for every open event. */
function createEndSection(): HostSectionRenderer {
  return (ctx) =>
    renderEndSection({
      state: ctx.event.state,
      actionPath: ctx.actionPath("end"),
      csrfToken: ctx.csrfToken,
      // Only an event with group channels has anyone to move back.
      offerPullBack:
        ctx.event.groupsEnabled === true &&
        (ctx.event.groups ?? []).some((g) => !!g.channelId),
      adopted: ctx.event.nativeAdopted === true,
    });
}

/**
 * End event now (#1193). `allowFinished`: an already-ended event is the
 * idempotent "nothing changed" answer of the teardown, not the generic "can no
 * longer be changed" refusal. The state is decided by the teardown's atomic
 * claim from a fresh row, never from the gate's copy of the event.
 */
function registerEndAction(router: Router, client: Client): void {
  hostAction(
    router,
    "end",
    "/end",
    async ({ req, event }) => {
      // The body is read here, before the first await.
      const confirmed = bodyString(req, END_CONFIRM_FIELD) === "1";
      const pullBack = bodyString(req, END_PULL_BACK_FIELD) === "1";
      if (!confirmed) {
        return {
          ok: false,
          message:
            "Tick the box to confirm that you want to end the event. Nothing was changed.",
          details: { outcome: "not-confirmed" },
          errorMessage: "not confirmed",
        };
      }
      const outcome = await EventService.getInstance(client).endEventNow(
        String(event._id),
        event.guildId,
        { pullBack },
      );
      const summary = summariseEnd(outcome);
      return {
        ok: summary.ok,
        message: summary.message,
        details: { ...summary.details, pullBack },
        errorMessage: summary.errorMessage,
      };
    },
    { allowFinished: true },
  );
}

/** The "Leaders" section (#1195); only rendered while leaders are on. */
function createLeadersSection(client: Client): HostSectionRenderer {
  return (ctx) => {
    const { event } = ctx;
    if (event.groupsEnabled !== true || event.captainsEnabled !== true) {
      return undefined;
    }
    const guild = client.guilds?.cache?.get(event.guildId);
    const presence = readEventPresence(client, event);
    let blocker = moveMembersBlocker(guild);
    if (!blocker && !presence.ok) {
      blocker =
        "The bot could not read who is in the voice channels, so pulling people is switched off.";
    }
    const leaderOf = new Map(
      effectiveLeaders(event.groups).map((l) => [l.groupKey, l.userId]),
    );
    const groups: LeaderGroupView[] = (event.groups ?? [])
      .filter((g) => g.kind === "team")
      .map((g) => ({
        key: g.key,
        name: g.name,
        marker: g.marker ?? "",
        leaderId: leaderOf.get(g.key) ?? null,
        members: (g.memberIds ?? []).map((id) => ({
          id,
          name: cachedMemberName(client, event.guildId, id),
        })),
      }));
    const labelOf = (g: { marker?: string; name: string }): string =>
      `${g.marker ? `${g.marker} ` : ""}${g.name}`;
    const leads = (event.groups ?? []).find(
      (g) => g.channelId && g.channelId === resolveLeadsChannel(event),
    );
    const defaultWhere = leads
      ? `the ${labelOf(leads)} channel.`
      : event.channelId
        ? "the main channel (the event has no leaders-only channel yet)."
        : "the channel you are in (the event has no main channel yet).";
    const destinations: LeaderDestinationView[] = [
      { value: PULL_DEFAULT, label: "Default" },
    ];
    if (event.channelId) {
      destinations.push({ value: PULL_MAIN, label: "Main channel" });
    }
    destinations.push({ value: PULL_HERE, label: "The channel I am in" });
    for (const g of event.groups ?? []) {
      if (g.channelId) {
        destinations.push({ value: g.key, label: labelOf(g) });
      }
    }
    return renderLeadersSection({
      csrfToken: ctx.csrfToken,
      actionPath: ctx.actionPath,
      leaderLabel: event.leaderLabel || "Leader",
      groupLabel: event.groupLabel || "Group",
      groups,
      defaultWhere,
      destinations,
      blocker,
    });
  };
}

/** How many recent leader edits the panel lists. */
const RECENT_EDITS = 10;

function quoted(value: unknown): string {
  return `"${String(value ?? "")}"`;
}

/** One audited leader edit as a line of text (plain; the view escapes it). */
function describeEdit(details: Record<string, unknown>): string {
  const parts: string[] = [];
  if (details.nameTo !== undefined) {
    parts.push(`name ${quoted(details.nameFrom)} to ${quoted(details.nameTo)}`);
  }
  if (details.tagTo !== undefined) {
    parts.push(`tag ${quoted(details.tagFrom)} to ${quoted(details.tagTo)}`);
  }
  return parts.length > 0 ? parts.join(", ") : "no change";
}

/** The "Team names and tags" section (#1196). */
function createCustomiseSectionRenderer(client: Client): HostSectionRenderer {
  return async (ctx) => {
    const { event } = ctx;
    if (event.groupsEnabled !== true) return undefined;
    const teams = (event.groups ?? [])
      .filter((g) => g.kind === "team")
      .map((g) => ({
        key: g.key,
        name: g.name,
        marker: g.marker ?? "",
        tag: g.tag ?? "",
        originalName: g.originalName ? g.originalName : null,
        originalTag: g.originalTag ?? "",
        renamePending: g.nameSyncPending === true,
      }));
    const edits: CustomiseEditView[] = [];
    try {
      const rows = await WebAuditLog.find({
        guildId: event.guildId,
        targetId: String(event._id),
        action: LEADER_AUDIT_ACTION,
        result: "success",
      })
        .sort({ createdAt: -1 })
        .limit(RECENT_EDITS)
        .lean();
      for (const r of rows) {
        edits.push({
          at: new Date(r.createdAt).toISOString(),
          who: cachedMemberName(client, event.guildId, r.discordUserId),
          text: describeEdit((r.details ?? {}) as Record<string, unknown>),
        });
      }
    } catch (err) {
      logger.warn("Could not read the leader edits for the host panel:", err);
    }
    return renderCustomiseSection({
      csrfToken: ctx.csrfToken,
      actionPath: ctx.actionPath,
      on: customisationOn(event),
      groupLabel: event.groupLabel || "Group",
      leaderLabel: event.leaderLabel || "Leader",
      teams,
      edits,
    });
  };
}

/** The host puts a team's name and tag back (#1196). */
function registerCustomiseActions(router: Router, client: Client): void {
  hostAction(router, "reset-team", "/reset-team", async ({ req, event }) => {
    const group = bodyString(req, "group");
    if (!/^g_[0-9a-f]{8}$/.test(group)) {
      return { ok: false, message: "Choose a team." };
    }
    const result = await resetGroupCustomisation(
      { guildId: event.guildId, eventId: String(event._id), groupKey: group },
      createCustomiseDeps(client),
    );
    if (!result.ok) {
      return {
        ok: false,
        message: result.message,
        details: { group },
        errorMessage: result.code,
      };
    }
    return { ok: true, message: result.message, details: result.details };
  });
}

/** Set a leader, rename the label and pull the leaders (#1195). */
function registerLeaderActions(router: Router, client: Client): void {
  hostAction(router, "set-leader", "/set-leader", async ({ req, event }) => {
    // The member-reset ticket, before any await (see the assignment actions).
    const admission = req.hostAdmission;
    const label = (event.leaderLabel || "Leader").toLowerCase();
    const group = bodyString(req, "group");
    if (group.length === 0 || group.length > 32) {
      return { ok: false, message: "Choose a group." };
    }
    const rawUser = bodyString(req, "userId");
    if (rawUser !== "" && !USER_ID_RE.test(rawUser)) {
      return { ok: false, message: "Pick a person from the list." };
    }
    const userId = rawUser === "" ? null : rawUser;
    const result = await setGroupLeader({
      guildId: event.guildId,
      eventId: String(event._id),
      groupKey: group,
      userId,
      admission,
    });
    if (!result.ok) {
      return {
        ok: false,
        message: result.message,
        details: { group, userId },
        errorMessage: result.code,
      };
    }
    const groupName =
      (event.groups ?? []).find((g) => g.key === group)?.name ?? "the group";
    const who = userId ? cachedMemberName(client, event.guildId, userId) : "";
    const message = !result.changed
      ? userId
        ? `${who} is already the ${label} of ${groupName}.`
        : `${groupName} had no ${label}.`
      : userId
        ? `${who} is now the ${label} of ${groupName}.`
        : `${groupName} no longer has a ${label}.`;
    return {
      ok: true,
      message,
      details: {
        group,
        userId,
        from: result.fromUserId,
        to: result.toUserId,
        changed: result.changed,
      },
    };
  });

  hostAction(
    router,
    "leader-label",
    "/leader-label",
    async ({ req, event }) => {
      const parsed = validateLeaderLabel(bodyString(req, "label"));
      if (!parsed.ok) return { ok: false, message: parsed.error };
      const result = await setLeaderLabel({
        guildId: event.guildId,
        eventId: String(event._id),
        label: parsed.value,
      });
      if (!result.ok) {
        return {
          ok: false,
          message: result.message,
          errorMessage: result.code,
        };
      }
      return {
        ok: true,
        message: `Leaders are now called "${parsed.value}".`,
        details: { label: parsed.value },
      };
    },
  );

  hostAction(
    router,
    "pull-leaders",
    "/pull-leaders",
    async ({ req, event, session }) => {
      // Everything taken from the request and the session before the first await.
      const to = bodyString(req, "to");
      const actingId = session.discordUserId;
      if (to.length === 0 || to.length > 32) {
        return { ok: false, message: "Choose where to pull the leaders." };
      }
      const outcome = await moveEventMembers({
        client,
        guildId: event.guildId,
        eventId: String(event._id),
        excludeUserIds: hostIds(event, actingId),
        // Pure, on the fresh row inside the mover's lock: no other lock here.
        plan: ({ event: fresh, presence }) =>
          planPullLeaders(fresh, presence, to, actingId),
      });
      const result = moveResult(client, event, "pull-leaders", outcome);
      if (result.details) result.details.destination = to;
      return result;
    },
  );
}

/** What the live edit asks of the world (#1239): config and the end hold. */
function createLiveEditDeps(client: Client): LiveEditDeps {
  return {
    isEventsEnabled: async (): Promise<boolean | null> => {
      try {
        return await ConfigService.getInstance().getBoolean(
          "events.enabled",
          false,
        );
      } catch (err) {
        logger.warn("Could not read events.enabled for a live edit:", err);
        return null;
      }
    },
    maxGroups: async (): Promise<number | null> => {
      try {
        // Strict: a failed read must be null (fail closed), not the default.
        return await ConfigService.getInstance().getNumberStrict(
          "events.groups.max_count",
          15,
        );
      } catch (err) {
        logger.warn("Could not read events.groups.max_count:", err);
        return null;
      }
    },
    isEnding: (eventId) =>
      EventService.getInstance(client).isEventBeingEnded(eventId),
    effects: createLiveEditEffects(client),
  };
}

/**
 * The "Live settings" section (#1239). It reads the event FRESH (the form's
 * base values must be what is stored now, not the gate's copy) and fails
 * closed: an unreadable event or a switched-off Events feature shows a notice
 * and no form.
 */
function createSettingsSection(client: Client): HostSectionRenderer {
  return async (ctx) => {
    const empty = {
      csrfToken: ctx.csrfToken,
      actionPath: ctx.actionPath,
      leadMinutes: null,
      leadReadOnly: null,
      locked: null,
      groupLabel: ctx.event.groupLabel || "Group",
      groups: [],
    };
    let fresh: IEvent | null = null;
    try {
      fresh = await EventService.getInstance(client).getEvent(
        String(ctx.event._id),
      );
    } catch (err) {
      logger.warn("Could not read the event for the settings section:", err);
    }
    if (!fresh || fresh.guildId !== ctx.event.guildId) {
      return renderSettingsSection({
        ...empty,
        blocker: "The event could not be read, so it cannot be edited now.",
      });
    }
    if (!hostControlsAvailable(fresh)) {
      return renderSettingsSection({
        ...empty,
        blocker: REFUSAL_MESSAGE["not-open"],
      });
    }
    // Every save is refused while an end or cancel holds the event, so no form.
    if (EventService.getInstance(client).isEventBeingEnded(String(fresh._id))) {
      return renderSettingsSection({
        ...empty,
        blocker: REFUSAL_MESSAGE.ending,
      });
    }
    if ((await createLiveEditDeps(client).isEventsEnabled()) !== true) {
      return renderSettingsSection({
        ...empty,
        blocker: REFUSAL_MESSAGE["events-off"],
      });
    }
    const hasGroups =
      fresh.groupsEnabled === true && (fresh.groups ?? []).length > 0;
    return renderSettingsSection({
      ...empty,
      blocker: null,
      leadMinutes: leadTimeRow.read(fresh) as number | null,
      leadReadOnly: channelsExist(fresh)
        ? (leadTimeRow.applicable(fresh) ?? null)
        : null,
      locked: hasGroups ? (lockGroupsRow.read(fresh) as boolean) : null,
      groupLabel: fresh.groupLabel || "Group",
      leadersTags: leadersTagsViewOf(fresh),
      groups: hasGroups
        ? (fresh.groups ?? []).map((g) => ({
            name: g.name,
            marker: g.marker ?? "",
            size: g.size ?? null,
            memberCount: (g.memberIds ?? []).length,
            overSize: isGroupOverSize(g),
          }))
        : [],
      // Names, sizes and the preset switch (#1241).
      groupEdit: hasGroups ? await buildGroupEditView(fresh) : undefined,
    });
  };
}

const CONFIRM_FAILURE: Record<
  Extract<ConfirmationCheck, { ok: false }>["reason"],
  string
> = {
  invalid: "That confirmation is not valid. Nothing was changed.",
  mismatch:
    "That confirmation was issued for something else. Nothing was changed.",
  expired:
    "That confirmation has expired. Nothing was changed; review the form again.",
  "no-secret": REFUSAL_MESSAGE["no-secret"],
};

/** Save the Settings form, and confirm a change that needs it (#1239). */
function registerSettingsActions(router: Router, client: Client): void {
  hostAction(
    router,
    "settings",
    "/settings",
    async ({ req, event, session }) => {
      // Everything taken from the request and the session before the first await.
      const rawBody = req.body;
      const csrfToken = getCsrfToken(req);
      const eventId = String(event._id);
      // A chosen preset is resolved from the server's catalog (#1241): the
      // content of a preset is never taken from the client.
      const prepared = await prepareGroupEditBody(rawBody, event.guildId);
      if (!prepared.ok) {
        return {
          ok: false,
          message: `Nothing was changed. ${prepared.error}`,
          details: { outcome: "invalid", errors: [prepared.error] },
          errorMessage: "invalid",
        };
      }
      const parsed = parseSubmission(prepared.body);
      if (parsed.errors.length > 0) {
        return {
          ok: false,
          message: `Nothing was changed. ${parsed.errors.join(" ")}`,
          details: { outcome: "invalid", errors: parsed.errors },
          errorMessage: "invalid",
        };
      }
      const outcome = await runLiveEdit({
        guildId: event.guildId,
        eventId,
        deps: createLiveEditDeps(client),
        submission: parsed.entries,
      });
      const result = describeLiveEditOutcome(outcome);
      if (outcome.status !== "needs-confirmation") return result;
      const token = signConfirmation({
        eventId,
        guildId: event.guildId,
        userId: session.discordUserId,
        changes: outcome.changes.map((c) => ({
          rowId: c.rowId,
          from: c.from,
          to: c.to,
          reconcile: c.reconcile,
        })),
        revision: outcome.revision,
      });
      if (!token) {
        return {
          ok: false,
          message: REFUSAL_MESSAGE["no-secret"],
          details: { outcome: "no-secret" },
          errorMessage: "no-secret",
        };
      }
      const flags = await readMeSurfaceFlags();
      return {
        ...result,
        page: renderUserPage({
          title: `Confirm changes: ${event.title}`,
          active: "/me/",
          body: renderConfirmBody({
            csrfToken,
            actionPath: `${hostPanelPath(eventId)}/settings-confirm`,
            panelPath: hostPanelPath(eventId),
            token,
            changes: outcome.changes.map((c) => ({
              label: c.label,
              from: describeRowValue(c.rowId, c.from),
              to: describeRowValue(c.rowId, c.to),
            })),
            reasons: outcome.reasons,
          }),
          csrfToken,
          remainingMs: getDisplayedRemainingMs(session),
          isAdmin: session.role === "admin",
          flash: null,
          ...flags,
        }),
      };
    },
  );

  hostAction(
    router,
    "settings-confirm",
    "/settings-confirm",
    async ({ req, event, session }) => {
      const token = bodyString(req, "token");
      const eventId = String(event._id);
      const check = verifyConfirmation(token, {
        eventId,
        guildId: event.guildId,
        userId: session.discordUserId,
      });
      if (!check.ok) {
        return {
          ok: false,
          message: CONFIRM_FAILURE[check.reason],
          details: { outcome: `token-${check.reason}` },
          errorMessage: `token ${check.reason}`,
        };
      }
      const outcome = await runLiveEdit({
        guildId: event.guildId,
        eventId,
        deps: createLiveEditDeps(client),
        confirmed: check.changes,
        confirmedRevision: check.revision,
      });
      return describeLiveEditOutcome(outcome);
    },
  );
}

function toPanelEvent(client: Client, event: IEvent): HostPanelEvent {
  const channelId = event.channelId ?? null;
  const channelName = channelId
    ? (client.guilds?.cache?.get(event.guildId)?.channels?.cache?.get(channelId)
        ?.name ?? null)
    : null;
  const groupsEnabled = event.groupsEnabled === true;
  const captainsEnabled = groupsEnabled && event.captainsEnabled === true;
  const leaderOf = new Map(
    captainsEnabled
      ? effectiveLeaders(event.groups).map((l) => [l.groupKey, l.userId])
      : [],
  );
  return {
    id: String(event._id),
    title: event.title,
    description: event.description ?? "",
    state: event.state,
    when: formatEventWhen(event),
    durationMinutes: event.durationMinutes,
    recurrence: isRecurring(event) ? recurrenceLabel(event.recurrence) : null,
    channel: channelId ? (channelName ?? channelId) : null,
    groupsEnabled,
    groupLabel: event.groupLabel || "Group",
    leaderLabel: event.leaderLabel || "Leader",
    captainsEnabled,
    channelLeadMinutes: event.channelLeadMinutes ?? null,
    groups: groupsEnabled
      ? (event.groups ?? []).map((g) => ({
          leaderName: leaderOf.has(g.key)
            ? cachedMemberName(
                client,
                event.guildId,
                leaderOf.get(g.key) as string,
              )
            : null,
          name: g.name,
          marker: g.marker ?? "",
          kind: g.kind,
          size: g.size ?? null,
          tag: g.tag ?? "",
          hasChannel: !!g.channelId,
          memberCount: (g.memberIds ?? []).length,
          fill: groupFill({
            size: g.size ?? null,
            memberCount: (g.memberIds ?? []).length,
          }),
        }))
      : [],
    groupNotices: groupsEnabled ? groupNoticesFor(client, event) : [],
    ...tagStatusFor(client, event, groupsEnabled),
    adopted: event.nativeAdopted === true,
  };
}

/** The clan tags (#1194) as the panel shows them; nothing while they are off. */
function tagStatusFor(
  client: Client,
  event: IEvent,
  groupsEnabled: boolean,
): Pick<
  HostPanelEvent,
  "tagsEnabled" | "tagsSuffix" | "tagNotices" | "tagSkipped"
> {
  if (!groupsEnabled || event.tagsEnabled !== true) return {};
  const report = EventNicknameTags.getInstance(client).getReport(
    String(event._id),
  );
  return {
    tagsEnabled: true,
    tagsSuffix: event.tagsSuffix === true,
    tagNotices: report?.warnings ?? [],
    tagSkipped: (report?.skipped ?? []).map((s) => ({
      name: cachedMemberName(client, event.guildId, s.userId),
      reason: s.reason,
    })),
  };
}

/** The last group-channel pass's warnings and failures for the panel (#1190). */
function groupNoticesFor(client: Client, event: IEvent): string[] {
  const report = EventService.getInstance(client).getGroupChannelReport(
    String(event._id),
  );
  if (!report) return [];
  return [
    ...report.warnings,
    ...report.failures.map((f) => `${f.name}: ${f.reason}`),
  ];
}

export function createHostEventsRouter(client: Client): Router {
  const router = Router({ mergeParams: true });

  // The gate. Everything below this line runs only for the event's host.
  router.use(requireCsrf);
  router.use((req: Request, res: Response, next: NextFunction) => {
    // Take the session in one synchronous step, before the first await, and
    // use this copy from here on.
    const session = (req as AuthenticatedRequest).webSession;
    const admission = TrackingOptOutService.getInstance().admission();
    const rawId = req.params.id;
    const id = typeof rawId === "string" ? rawId : "";
    const deny = async (reason: string): Promise<void> => {
      if (session && req.method !== "GET" && req.method !== "HEAD") {
        await recordAudit(
          session,
          boundAuditEntry({
            action: "event.host.denied",
            targetId: id,
            details: { method: req.method, reason },
            result: "failure",
            errorMessage: "not the host of this event",
          }),
        );
      }
      forbidden(res);
    };
    if (!session || !id) {
      void deny("no session or id").catch(next);
      return;
    }
    EventService.getInstance(client)
      .getEvent(id)
      .then(async (event) => {
        if (!event || !isEventHost(session, event)) {
          await deny(event ? "not host" : "no such event");
          return;
        }
        const h = req as HostRequest;
        h.hostEvent = event;
        h.hostSession = session;
        h.hostAdmission = admission;
        next();
      })
      .catch((err: unknown) => {
        // Unexpected failure while checking: nothing is let through. (A failed
        // event read is already turned into "not found" by `getEvent`, which
        // answers 403, so this is only reached by something unforeseen.)
        logger.error(`Host panel gate failed for ${sanitizeForLog(id)}`, err);
        next(err);
      });
  });

  // The "Assign people" section and its actions (#1191).
  HOST_SECTION_RENDERERS.assignment = createAssignmentSection(client);
  registerAssignmentActions(router, client);
  // The "Move people" section and its actions (#1192).
  HOST_SECTION_RENDERERS.moves = createMovesSection(client);
  registerMoveActions(router, client);
  // The "Leaders" section and its actions (#1195).
  HOST_SECTION_RENDERERS.leaders = createLeadersSection(client);
  registerLeaderActions(router, client);
  // The "Team names and tags" section and the host's reset (#1196).
  HOST_SECTION_RENDERERS.customise = createCustomiseSectionRenderer(client);
  registerCustomiseActions(router, client);
  // The "End the event" section and its action (#1193).
  HOST_SECTION_RENDERERS.end = createEndSection();
  registerEndAction(router, client);
  // The "Live settings" section and its save and confirm actions (#1239).
  HOST_SECTION_RENDERERS.settings = createSettingsSection(client);
  registerSettingsActions(router, client);

  router.get("/", (req, res, next: NextFunction) => {
    const { hostEvent: event, hostSession: session } = req as HostRequest;
    const flash = readSignedFlash(req.query);
    const csrfToken = getCsrfToken(req);
    const ctx: HostSectionContext = {
      event,
      session,
      csrfToken,
      actionPath: (action) => `${hostPanelPath(String(event._id))}/${action}`,
    };
    void (async (): Promise<void> => {
      const flags = await readMeSurfaceFlags();
      const controls: Partial<Record<HostSectionId, string>> = {};
      if (hostControlsAvailable(event)) {
        for (const [id, render] of Object.entries(
          HOST_SECTION_RENDERERS,
        ) as Array<[HostSectionId, HostSectionRenderer]>) {
          const html = await render(ctx);
          if (html !== undefined) controls[id] = html;
        }
      }
      res.type("text/html").send(
        renderUserPage({
          title: `Host panel: ${event.title}`,
          active: "/me/",
          body: renderHostPanelBody({
            event: toPanelEvent(client, event),
            controls,
          }),
          csrfToken,
          remainingMs: getDisplayedRemainingMs(session),
          isAdmin: session.role === "admin",
          flash,
          ...flags,
        }),
      );
    })().catch(next);
  });

  return router;
}
