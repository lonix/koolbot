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
import { Buffer } from "buffer";
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
import { formatInTimeZone } from "date-fns-tz";
import { formatDateTimeInZone, resolveTimezone } from "../../utils/timezone.js";
import { readMemberZone } from "../member-timezone.js";
import {
  EDIT_MESSAGES,
  editModeOf,
  eventEditVersion,
  isSeriesRow,
  parseEditScope,
  parseRenderedMode,
  type EditMode,
} from "../../services/event-edit.js";
import {
  renderEventEditBody,
  type EventEditRefused,
  type EventEditCover,
} from "../event-edit-view.js";
import {
  COVER_TOO_LARGE_TEXT,
  coverUploadBody,
} from "../event-cover-upload.js";
import {
  coverIneligibleReason,
  removeEventCover,
  setEventCover,
} from "../../services/event-cover.js";
import { validateEventForm } from "../event-form.js";
import { renderErrorPage } from "../views.js";
import { scriptTag } from "../html.js";
import { isEventHost } from "../event-host.js";
import {
  hostControlsAvailable,
  hostPanelPath,
  isEventRunning,
} from "../host-panel-shared.js";
import {
  hostEditPermissionFeatures,
  hostPanelPermissionFeatures,
  hostPanelShownWarnings,
  renderHostPanelBody,
  type HostPanelEvent,
  type HostSectionId,
} from "../host-panel-view.js";
import {
  inFeatures,
  loadPermissionNotice,
  type PermissionNotice,
} from "../permission-notice.js";
import {
  FLASH_MAX,
  readSignedFlash,
  signFlash,
  truncateFlash,
  wantsJson,
} from "../http-flash.js";
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
import { type RandomiseMode } from "../../services/event-group-plan.js";
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
  renderHostBoard,
  HOST_BOARD_SCRIPT,
  type BoardDestinationView,
  type BoardLeadersView,
  type BoardMovePersonView,
  type BoardPersonView,
  type BoardTeamView,
} from "../host-board-view.js";
import { END_CONFIRM_FIELD, renderEndSection } from "../event-end-view.js";
import { summariseEnd } from "../../services/event-teardown.js";
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
import {
  hasCaptainsLobby,
  validateLeaderLabel,
} from "../../services/event-groups.js";
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
  parseSubmission,
  REFUSAL_MESSAGE,
  runLiveEdit,
  signConfirmation,
  verifyConfirmation,
  type ConfirmationCheck,
  type LiveEditDeps,
} from "../../services/event-live-edit.js";
import { seriesSetupRow } from "../../services/event-live-edit-series.js";
import {
  renderConfirmBody,
  renderEventSettings,
  renderGroupChanges,
  renderResultBody,
  type LeaderEditView,
  type SettingsViewData,
} from "../host-settings-view.js";
import {
  CONFIRM_ONLY_HEADER,
  CONFIRM_ONLY_VALUE,
  CONFIRM_PAGE_HEADER,
  CONFIRM_PAGE_VALUE,
} from "../confirm-fetch.js";
import { leadersTagsViewOf } from "../host-settings-leaders-tags-view.js";
import { prepareSettingsBody } from "../host-settings-rows.js";
import {
  buildGroupsSwitchView,
  prepareGroupsSwitchBody,
} from "../host-settings-groups-switch.js";
import { createLiveEditEffects } from "../../services/event-live-edit-effects.js";
import {
  buildGroupEditView,
  prepareGroupEditBody,
} from "../host-settings-groups.js";

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
  /** The member's own zone, read once per request (#1538). */
  zone: string;
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
        product: "KoolBot",
        bodyHtml:
          `<p>This event is not yours to host, or it does not exist. ` +
          `Back to <a href="/me/events">your events</a>.</p>`,
      }),
    );
}

/** Redirect to `path` with a signed flash (not a bare query-string flash, #1149). */
function redirectWithFlash(
  res: Response,
  path: string,
  flash: UserFlashMessage,
  extra?: Record<string, string>,
): void {
  const text = truncateFlash(flash.text);
  const qs = new globalThis.URLSearchParams({
    flash: flash.type,
    msg: text,
    sig: signFlash(flash.type, text),
    ...extra,
  }).toString();
  res.redirect(303, `${path}?${qs}`);
}

/** Redirect to the panel with a signed flash. */
export function hostPanelRedirect(
  res: Response,
  eventId: string,
  flash: UserFlashMessage,
  extra?: Record<string, string>,
): void {
  redirectWithFlash(res, hostPanelPath(eventId), flash, extra);
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
  /**
   * `page` is the live edit's confirmation page (#1344): the response carries
   * `CONFIRM_PAGE_HEADER`, which the panel script requires before it opens a
   * dialog from a fetched answer. Set by nothing else.
   */
  confirmPage?: boolean;
  /**
   * Redirect (with the same signed flash) to this fixed `/me/events` path
   * instead of the panel; used by Cancel, whose panel is then only a summary.
   */
  redirectTo?: string;
}

export interface HostActionOptions {
  /**
   * Come back to the panel with its two folds at the bottom open (`open=folds`),
   * so a settings save shows its result (#1424). Off for the board's actions: a
   * move or an assignment must not open the settings.
   */
  reopenFolds?: boolean;
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
        if (result.confirmPage === true) {
          res.set(CONFIRM_PAGE_HEADER, CONFIRM_PAGE_VALUE);
        }
        res
          .status(200)
          .set("Cache-Control", "no-store")
          .type("text/html")
          .send(result.page);
        return;
      }
      const flash: UserFlashMessage = {
        type: result.ok ? "ok" : "err",
        text: result.message,
      };
      if (result.redirectTo !== undefined) {
        redirectWithFlash(res, result.redirectTo, flash);
        return;
      }
      hostPanelRedirect(
        res,
        eventId,
        flash,
        options.reopenFolds ? { open: "folds" } : undefined,
      );
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

const EVENTS_OFF =
  "Events are switched off on this server, so nobody can be added to a group. An admin can switch Events on.";

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

/**
 * The toolbar and the team board (#1424): one section that replaced the cards
 * "Assign people", "Move people", "Leaders" and "Team names and tags". It only
 * reads; every control posts to the action routes below, unchanged.
 */
function createBoardSection(client: Client): HostSectionRenderer {
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
    const labelOf = (g: { marker?: string; name: string }): string =>
      `${g.marker ? `${g.marker} ` : ""}${g.name}`;
    // Where each channel is, in words: the one map the board and Move people share.
    const channelLabel = new Map<string, string>();
    const destinations: BoardDestinationView[] = [];
    if (event.channelId) {
      channelLabel.set(event.channelId, "Main channel");
      destinations.push({
        value: "main",
        label: "Main channel",
        ...channelFacts(client, event.guildId, event.channelId),
      });
    }
    for (const g of groups) {
      if (!g.channelId) continue;
      channelLabel.set(g.channelId, labelOf(g));
      destinations.push({
        value: g.key,
        label: labelOf(g),
        ...channelFacts(client, event.guildId, g.channelId),
      });
    }
    // Leaders are marked only while the event has them switched on (#1195).
    const leaderIds = new Set(
      event.captainsEnabled === true
        ? effectiveLeaders(event.groups).map((l) => l.userId)
        : [],
    );
    const leaderLabel = event.leaderLabel || "Leader";
    const connected = new Map(presence.members.map((m) => [m.id, m]));
    const personOf = (id: string, name: string): BoardPersonView => {
      const m = connected.get(id);
      return {
        id,
        name,
        connected: m !== undefined,
        where: m ? (channelLabel.get(m.channelId) ?? "an event channel") : null,
        leaderLabel: leaderIds.has(id) ? leaderLabel : null,
      };
    };
    const teamGroups = groups.filter((g) => g.kind === "team");
    const inTeam = new Set<string>();
    const teams: BoardTeamView[] = teamGroups.map((g) => {
      const people = (g.memberIds ?? []).map((id) => {
        inTeam.add(id);
        return personOf(
          id,
          connected.get(id)?.name ??
            cachedMemberName(client, event.guildId, id),
        );
      });
      return {
        key: g.key,
        name: g.name,
        marker: g.marker ?? "",
        tag: (g.tag ?? "").trim(),
        size: g.size ?? null,
        hasChannel: !!g.channelId,
        customised: !!g.originalName,
        people,
      };
    });
    // Connected people who are in no team (the leaders-only lobby is not a team).
    const loose = presence.members
      .filter((m) => !inTeam.has(m.id))
      .map((m) => personOf(m.id, m.name));
    const movePeople: BoardMovePersonView[] = presence.members.map((m) => ({
      id: m.id,
      name: m.name,
      where: channelLabel.get(m.channelId) ?? "an event channel",
    }));
    let leaders: BoardLeadersView | undefined;
    if (event.captainsEnabled === true) {
      const leads = groups.find(
        (g) => g.channelId && g.channelId === resolveLeadsChannel(event),
      );
      const defaultWhere = leads
        ? `the ${labelOf(leads)} channel.`
        : event.channelId
          ? "the main channel (the event has no leaders-only channel yet)."
          : "the channel you are in (the event has no main channel yet).";
      const dests = [{ value: PULL_DEFAULT, label: "Default" }];
      if (event.channelId) {
        dests.push({ value: PULL_MAIN, label: "Main channel" });
      }
      dests.push({ value: PULL_HERE, label: "The channel I am in" });
      for (const g of groups) {
        if (g.channelId) dests.push({ value: g.key, label: labelOf(g) });
      }
      leaders = { defaultWhere, destinations: dests };
    }
    return (
      renderHostBoard({
        csrfToken: ctx.csrfToken,
        actionPath: ctx.actionPath,
        groupLabel: event.groupLabel || "Group",
        leaderLabel,
        locked: event.groupsLocked === true,
        presenceOk: presence.ok,
        teams,
        loose,
        connectedCount: presence.members.length,
        moveBlocker: blocker,
        sendableTeams: teamGroups.filter((g) => !!g.channelId).length,
        waitingForChannel: teamGroups
          .filter((g) => !g.channelId)
          .reduce((n, g) => n + (g.memberIds ?? []).length, 0),
        hasMain: !!event.channelId,
        destinations,
        movePeople,
        leaders,
      }) + scriptTag(HOST_BOARD_SCRIPT)
    );
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
      hasGroupChannels:
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
      );
      const summary = summariseEnd(outcome);
      return {
        ok: summary.ok,
        message: summary.message,
        details: summary.details,
        errorMessage: summary.errorMessage,
      };
    },
    { allowFinished: true },
  );
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

/** The last edits leaders made from Discord, for "Event settings" (#1196). */
async function recentLeaderEdits(
  client: Client,
  event: IEvent,
  zone: string,
): Promise<LeaderEditView[]> {
  const edits: LeaderEditView[] = [];
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
        at: formatDateTimeInZone(new Date(r.createdAt), zone),
        who: cachedMemberName(client, event.guildId, r.discordUserId),
        text: describeEdit((r.details ?? {}) as Record<string, unknown>),
      });
    }
  } catch (err) {
    logger.warn("Could not read the leader edits for the host panel:", err);
  }
  return edits;
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
 * What the two folds at the bottom of the panel (#1239, split in two by #1424)
 * render from. It reads the event FRESH (the form's base values must be what is
 * stored now, not the gate's copy) and fails closed: an unreadable event or a
 * switched-off Events feature shows a notice and no form. One read per request
 * serves both folds (cached on the request's section context).
 */
const settingsViews = new WeakMap<
  HostSectionContext,
  Promise<SettingsViewData>
>();

function loadSettingsView(
  client: Client,
  ctx: HostSectionContext,
): Promise<SettingsViewData> {
  const cached = settingsViews.get(ctx);
  if (cached) return cached;
  const built = buildSettingsView(client, ctx);
  settingsViews.set(ctx, built);
  return built;
}

async function buildSettingsView(
  client: Client,
  ctx: HostSectionContext,
): Promise<SettingsViewData> {
  const empty = {
    csrfToken: ctx.csrfToken,
    actionPath: ctx.actionPath,
    leadMinutes: null,
    leadReadOnly: null,
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
    return {
      ...empty,
      blocker: "The event could not be read, so it cannot be edited now.",
    };
  }
  if (!hostControlsAvailable(fresh)) {
    return { ...empty, blocker: REFUSAL_MESSAGE["not-open"] };
  }
  // Every save is refused while an end or cancel holds the event, so no form.
  if (EventService.getInstance(client).isEventBeingEnded(String(fresh._id))) {
    return { ...empty, blocker: REFUSAL_MESSAGE.ending };
  }
  if ((await createLiveEditDeps(client).isEventsEnabled()) !== true) {
    return { ...empty, blocker: REFUSAL_MESSAGE["events-off"] };
  }
  const hasGroups =
    fresh.groupsEnabled === true && (fresh.groups ?? []).length > 0;
  return {
    ...empty,
    blocker: null,
    leadMinutes: leadTimeRow.read(fresh) as number | null,
    leadReadOnly: channelsExist(fresh)
      ? (leadTimeRow.applicable(fresh) ?? null)
      : null,
    groupLabel: fresh.groupLabel || "Group",
    // The tick "also for the next occurrences" (#1266) is for a series only.
    seriesTick: seriesSetupRow.applicable(fresh) === null,
    leadersTags: leadersTagsViewOf(fresh),
    // The leader label and what leaders changed (#1195, #1196): only while
    // leaders are on for this event.
    leaderExtras:
      hasGroups && fresh.captainsEnabled === true
        ? {
            leaderLabel: fresh.leaderLabel || "Leader",
            edits: await recentLeaderEdits(client, fresh, ctx.zone),
          }
        : undefined,
    groups: hasGroups
      ? (fresh.groups ?? [])
          .filter((g) => g.kind !== "leads")
          .map((g) => ({
            name: g.name,
            marker: g.marker ?? "",
            size: g.size ?? null,
            memberCount: (g.memberIds ?? []).length,
            overSize: isGroupOverSize(g),
          }))
      : [],
    // Names, sizes and the preset switch (#1241).
    groupEdit: hasGroups
      ? await buildGroupEditView(fresh, ctx.session.discordUserId)
      : undefined,
    // Groups on or off (#1243): shown whether or not the event has groups.
    groupsSwitch: await buildGroupsSwitchView(fresh, ctx.session.discordUserId),
  };
}

/** The "Event settings" fold (#1239, #1424). */
function createSettingsSection(client: Client): HostSectionRenderer {
  return async (ctx) =>
    renderEventSettings(await loadSettingsView(client, ctx));
}

/** The "Change the groups" fold (#1424). */
function createGroupChangesSection(client: Client): HostSectionRenderer {
  return async (ctx) => renderGroupChanges(await loadSettingsView(client, ctx));
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

/**
 * A save whose result is too long for the flash line (cut at `FLASH_MAX`) is
 * answered with the full result page instead: otherwise the affected channels
 * and retry times of a large partial save are cut off. The audit row is still
 * written once, by `hostAction`.
 */
function withFullResult(
  handler: (ctx: {
    req: HostRequest;
    event: IEvent;
    session: WebSessionContext;
  }) => Promise<HostActionResult>,
): (ctx: {
  req: HostRequest;
  event: IEvent;
  session: WebSessionContext;
}) => Promise<HostActionResult> {
  return async (ctx) => {
    const result = await handler(ctx);
    if (result.page !== undefined || result.message.length <= FLASH_MAX) {
      return result;
    }
    const { req, event, session } = ctx;
    const csrfToken = getCsrfToken(req);
    const flags = await readMeSurfaceFlags();
    return {
      ...result,
      page: renderUserPage({
        title: `Settings: ${event.title}`,
        active: "/me/events",
        body: renderResultBody({
          ok: result.ok,
          message: result.message,
          panelPath: hostPanelPath(String(event._id)),
        }),
        csrfToken,
        remainingMs: getDisplayedRemainingMs(session),
        isAdmin: session.role === "admin",
        flash: null,
        ...flags,
      }),
    };
  };
}

/** Save the Settings form, and confirm a change that needs it (#1239). */
function registerSettingsActions(router: Router, client: Client): void {
  hostAction(
    router,
    "settings",
    "/settings",
    withFullResult(async ({ req, event, session }) => {
      // Everything taken from the request and the session before the first await.
      const rawBody = req.body;
      const csrfToken = getCsrfToken(req);
      const eventId = String(event._id);
      // The panel script's fetch asks for a confirmation or nothing (#1344).
      const confirmOnly = req.get(CONFIRM_ONLY_HEADER) === CONFIRM_ONLY_VALUE;
      // A chosen preset is resolved from the server's catalog (#1241): the
      // content of a preset is never taken from the client.
      const prepared = await prepareGroupEditBody(
        rawBody,
        event.guildId,
        session.discordUserId,
      );
      if (!prepared.ok) {
        return {
          ok: false,
          message: `Nothing was changed. ${prepared.error}`,
          details: { outcome: "invalid", errors: [prepared.error] },
          errorMessage: "invalid",
        };
      }
      // The same for the groups switch (#1243): the content of a preset that
      // creates groups is never taken from the client either.
      const switched = await prepareGroupsSwitchBody(
        prepared.body,
        event.guildId,
        session.discordUserId,
      );
      if (!switched.ok) {
        return {
          ok: false,
          message: `Nothing was changed. ${switched.error}`,
          details: { outcome: "invalid", errors: [switched.error] },
          errorMessage: "invalid",
        };
      }
      const parsed = parseSubmission(prepareSettingsBody(switched.body));
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
        requireConfirmation: confirmOnly,
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
          guard: c.guard,
        })),
        revision: outcome.revision,
        voiceInUse: outcome.voiceInUse,
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
        confirmPage: true,
        page: renderUserPage({
          title: `Confirm changes: ${event.title}`,
          active: "/me/events",
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
    }),
    { reopenFolds: true },
  );

  hostAction(
    router,
    "settings-confirm",
    "/settings-confirm",
    withFullResult(async ({ req, event, session }) => {
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
        confirmedVoiceInUse: check.voiceInUse,
      });
      return describeLiveEditOutcome(outcome);
    }),
    { reopenFolds: true },
  );
}

function toPanelEvent(
  client: Client,
  event: IEvent,
  zone: string,
): HostPanelEvent {
  const channelId = event.channelId ?? null;
  const channel = channelId
    ? client.guilds?.cache?.get(event.guildId)?.channels?.cache?.get(channelId)
    : undefined;
  const channelName = channel?.name ?? null;
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
    running: isEventRunning(event, new Date()),
    when: formatDateTimeInZone(event.startTime, zone),
    durationMinutes: event.durationMinutes,
    recurrence: isRecurring(event) ? recurrenceLabel(event.recurrence) : null,
    channel: channelId ? (channelName ?? channelId) : null,
    channelType: channel ? channel.type : null,
    groupsEnabled,
    groupLabel: event.groupLabel || "Group",
    leaderLabel: event.leaderLabel || "Leader",
    captainsEnabled,
    channelLeadMinutes: event.channelLeadMinutes ?? null,
    // The hidden captains lobby (#1251) is not listed as a group.
    captainsLobby: groupsEnabled
      ? hasCaptainsLobby(event.groups)
        ? {
            hasChannel: (event.groups ?? []).some(
              (g) => g.kind === "leads" && !!g.channelId,
            ),
          }
        : null
      : null,
    groups: groupsEnabled
      ? (event.groups ?? [])
          .filter((g) => g.kind !== "leads")
          .map((g) => ({
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
            // "2/2" for a sized group, "5" for an unsized one (#1191).
            fill:
              g.size == null
                ? String((g.memberIds ?? []).length)
                : `${(g.memberIds ?? []).length}/${g.size}`,
          }))
      : [],
    groupNotices: groupsEnabled ? groupNoticesFor(client, event) : [],
    ...tagStatusFor(client, event, groupsEnabled),
    adopted: event.nativeAdopted === true,
    nativeDetached: event.nativeDetached === true,
    recordedChannels: {
      main: channelId,
      groups: groupsEnabled
        ? (event.groups ?? [])
            .filter((g) => g.kind !== "leads")
            .map((g) => g.channelId ?? null)
        : [],
      lobby:
        groupsEnabled && hasCaptainsLobby(event.groups)
          ? (event.groups ?? [])
              .filter((g) => g.kind === "leads")
              .map((g) => g.channelId ?? null)
          : null,
    },
    editable: editModeOf(event, new Date()).mode !== "refused",
  };
}

/**
 * What the bot lacks for this event (#1253), from the registry's check. Only
 * while events are on; never throws and never holds the page for long.
 */
async function hostPermissionNotice(
  client: Client,
  guildId: string,
  panelEvent: HostPanelEvent,
  event: Pick<
    IEvent,
    "categoryId" | "announcementChannelId" | "announcementMessageId"
  >,
  /** The registry entries the page uses; the panel's own choice by default. */
  featuresOf: (
    e: HostPanelEvent,
    present?: Readonly<Record<string, boolean>>,
  ) => string[] = hostPanelPermissionFeatures,
): Promise<PermissionNotice | null> {
  // Nothing to say for a finished event; the full choice needs the check.
  if (featuresOf(panelEvent).length === 0) return null;
  const enabled = await ConfigService.getInstance()
    .getBoolean("events.enabled", false)
    .catch(() => false);
  const recorded = panelEvent.recordedChannels;
  return loadPermissionNotice({
    client,
    guildId,
    enabled,
    // Which channels exist, and the category they sit in, are read by the check
    // from its own snapshot, so the features chosen here and the category
    // checked never come from a staler view than the permissions do.
    eventPlacement: {
      mainChannelId: recorded?.main ?? null,
      categoryId: event.categoryId,
      // Where the post really is (an edit updates it there), not where the
      // setting points now.
      announcementChannelId: event.announcementChannelId ?? null,
      channelIds: [
        ...(recorded?.groups ?? []),
        ...(recorded?.lobby ?? []),
      ].filter((id): id is string => !!id),
    },
    filter: inFeatures(...featuresOf(panelEvent)),
    filterFromReport: (report) =>
      inFeatures(...featuresOf(panelEvent, report.placement?.present)),
    shownWarnings: hostPanelShownWarnings(panelEvent),
  });
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

/**
 * Edit an upcoming event (#1298): `GET` the pre-filled form, `POST` the save.
 * Both sit behind the gate of `createHostEventsRouter` (CSRF, the `host` scope,
 * `isEventHost`: an admin edits any event, a host only their own), so nothing
 * here checks who is asking. The save is audited as `event.edit`.
 */
function registerEditRoutes(router: Router, client: Client): void {
  // Looked up per request, like the other sections: the router is built before
  // the service in some tests.
  const service = (): EventService => EventService.getInstance(client);
  const edit = (event: IEvent): EditMode =>
    editModeOf(
      event,
      new Date(),
      service().isEventBeingEnded(String(event._id)),
    );
  const zoneOf = (event: IEvent): string => resolveTimezone(event.timezone);

  // The form, for a fresh page (GET) and for a refused save (#1531), which is
  // answered in the same response so what was typed is not lost. `shown` is
  // what the form is rendered in: the stored state on GET, the posted version,
  // mode and start fields on a refusal, so the stale-form checks still see them.
  const sendEditForm = async (
    req: Request,
    res: Response,
    shown: {
      mode: "full" | "limited";
      version: string;
      startLocked: boolean;
    },
    refused?: EventEditRefused,
  ): Promise<void> => {
    const { hostEvent: event, hostSession: session } = req as HostRequest;
    const eventId = String(event._id);
    const csrfToken = getCsrfToken(req);
    const zone = zoneOf(event);
    const flags = await readMeSurfaceFlags();
    const permissionNotice = await hostPermissionNotice(
      client,
      event.guildId,
      // The panel event's start line is not shown here, so the event's own
      // zone does (#1538).
      toPanelEvent(client, event, zone),
      event,
      (e) =>
        hostEditPermissionFeatures(
          e,
          !!event.announcementChannelId && !!event.announcementMessageId,
        ),
    );
    res
      .set("Cache-Control", "no-store")
      .type("text/html")
      .send(
        renderUserPage({
          title: `Edit event: ${event.title}`,
          active: "/me/events",
          body: renderEventEditBody({
            permissionNotice,
            canLinkToPermissions: session.role === "admin",
            cover: coverViewOf(event),
            ...(session.role === "admin"
              ? { adminEventsHref: "/admin/events" }
              : {}),
            event: {
              id: eventId,
              title: event.title,
              description: event.description ?? "",
              durationMinutes: event.durationMinutes,
              timezone: zone,
              date: formatInTimeZone(event.startTime, zone, "yyyy-MM-dd"),
              time: formatInTimeZone(event.startTime, zone, "HH:mm"),
              when: formatEventWhen(event),
              version: shown.version,
              mode: shown.mode,
              startLocked: shown.startLocked,
              ...(isSeriesRow(event)
                ? {
                    series: {
                      cadence: isRecurring(event)
                        ? recurrenceLabel(event.recurrence)
                        : "regularly",
                    },
                  }
                : {}),
            },
            csrfToken,
            ...(refused ? { refused } : {}),
          }),
          csrfToken,
          remainingMs: getDisplayedRemainingMs(session),
          isAdmin: session.role === "admin",
          flash: refused ? null : readSignedFlash(req.query),
          ...flags,
        }),
      );
  };

  router.get("/edit", (req, res, next: NextFunction) => {
    const { hostEvent: event } = req as HostRequest;
    const eventId = String(event._id);
    const mode = edit(event);
    if (mode.mode === "refused") {
      hostPanelRedirect(res, eventId, { type: "err", text: mode.message });
      return;
    }
    void (async (): Promise<void> => {
      if (!(await service().editsAllowed())) {
        hostPanelRedirect(res, eventId, {
          type: "err",
          text: EDIT_MESSAGES.disabled,
        });
        return;
      }
      // A running Discord event keeps its start: show it as text, not a field.
      const startLocked =
        mode.mode === "full" && !(await service().startMayMove(event));
      await sendEditForm(req, res, {
        mode: mode.mode,
        version: eventEditVersion(event, mode.mode),
        startLocked,
      });
    })().catch(next);
  });

  router.post("/edit", (req, res, next: NextFunction) => {
    const { hostEvent: event, hostSession: session } = req as HostRequest;
    const eventId = String(event._id);
    const editPath = `${hostPanelPath(eventId)}/edit`;
    const back = (flash: UserFlashMessage, to: string = editPath): void => {
      const text = truncateFlash(flash.text);
      const qs = new globalThis.URLSearchParams({
        flash: flash.type,
        msg: text,
        sig: signFlash(flash.type, text),
      }).toString();
      res.redirect(303, `${to}?${qs}`);
    };
    const fail = async (
      message: string,
      to?: string,
      details?: Record<string, unknown>,
    ): Promise<void> => {
      await recordAudit(
        session,
        boundAuditEntry({
          action: "event.edit",
          targetId: eventId,
          details,
          result: "failure",
          errorMessage: message,
        }),
      );
      back({ type: "err", text: message }, to);
    };
    void (async (): Promise<void> => {
      const mode = edit(event);
      if (mode.mode === "refused") {
        await fail(mode.message, hostPanelPath(eventId));
        return;
      }
      // Everything that would make a save partial is refused here, before any
      // posted field is read or normalized: a save must either apply every
      // field the form offered or change nothing and say why.
      // Events off: the service would refuse too, but only after the form was
      // validated, so a bad field would hide the reason.
      if (!(await service().editsAllowed())) {
        await fail(EDIT_MESSAGES.disabled, hostPanelPath(eventId));
        return;
      }
      const field = (name: string): string => bodyString(req, name).trim();
      // The mode the form was rendered in. It is covered by the version token
      // (a forged value no longer matches), so it can be trusted to say which
      // fields the form offered. A form without one predates it: reload.
      const rendered = parseRenderedMode(field("mode"));
      if (rendered === null) {
        await fail(EDIT_MESSAGES.conflict);
        return;
      }
      // A recurring event's edit must say how far it reaches. A missing or
      // unknown value is refused, never read as one of the two.
      const scope = isSeriesRow(event) ? parseEditScope(field("scope")) : null;
      if (isSeriesRow(event) && scope === null) {
        await fail(EDIT_MESSAGES.scope);
        return;
      }
      // Rendered with the title (and start) editable, but the event is limited
      // now (the start passed, or the channel was created, and the stored state
      // may not have moved yet): refuse, or the title and start would be
      // dropped while the description and duration saved and the host saw
      // "saved".
      if (rendered === "full" && mode.mode === "limited") {
        await fail(EDIT_MESSAGES.started);
        return;
      }
      const zone = zoneOf(event);
      const shown = {
        date: formatInTimeZone(event.startTime, zone, "yyyy-MM-dd"),
        time: formatInTimeZone(event.startTime, zone, "HH:mm"),
      };
      // A form that was limited when rendered never had the title or start
      // fields: whatever was posted for them is forged and ignored.
      const full = rendered === "full";
      // Whether the start may move NOW, and whether the form that was submitted
      // offered it. A form that offered it while the Discord event has since
      // started (or cannot be read) is stale: refuse it before anything is
      // saved, or the other fields would be saved and the schedule change
      // silently dropped. A form rendered without the fields is a locked form:
      // whatever it posts for the start is ignored.
      const canMoveStart = full && (await service().startMayMove(event));
      const offeredStart = full && field("startEditable") === "1";
      if (offeredStart && !canMoveStart) {
        await fail(EDIT_MESSAGES.nativeActive);
        return;
      }
      const editStart = offeredStart && canMoveStart;
      const date = editStart ? field("date") : shown.date;
      const time = editStart ? field("time") : shown.time;
      const timezone = editStart ? field("timezone") || zone : zone;
      // An unchanged start keeps the stored instant, so a round trip through
      // the wall clock (a repeated hour at a DST change) cannot move it, and
      // an event that is about to start can still get a new description.
      const startUnchanged =
        date === shown.date && time === shown.time && timezone === zone;
      const parsed = await validateEventForm(
        {
          title: full ? field("title") : event.title,
          description: field("description"),
          date,
          time,
          duration: field("duration"),
          timezone,
        },
        { requireFuture: !startUnchanged },
      );
      if (!parsed.ok) {
        // A field refusal answers with the form itself (#1531): the posted
        // values back in their fields, the refused one marked. It is rendered
        // with the version, mode and start fields it was posted with, so the
        // stale-form checks above still decide the next save.
        await recordAudit(
          session,
          boundAuditEntry({
            action: "event.edit",
            targetId: eventId,
            result: "failure",
            errorMessage: parsed.error,
          }),
        );
        res.status(422);
        await sendEditForm(
          req,
          res,
          {
            mode: rendered,
            version: field("version"),
            startLocked: full && !offeredStart,
          },
          {
            refusal: {
              message: parsed.error,
              ...(parsed.field ? { field: parsed.field } : {}),
            },
            values: {
              title: full ? field("title") : event.title,
              description: field("description"),
              duration: field("duration"),
              date: editStart ? date : shown.date,
              time: editStart ? time : shown.time,
              timezone: editStart ? timezone : zone,
              scope: field("scope"),
            },
          },
        );
        return;
      }
      let result: Awaited<ReturnType<EventService["editEvent"]>>;
      try {
        result = await service().editEvent({
          eventId,
          guildId: session.guildId,
          expectedVersion: field("version"),
          renderedMode: rendered,
          scope,
          changes: {
            ...parsed.value,
            startTime: startUnchanged
              ? event.startTime
              : parsed.value.startTime,
            timezone: startUnchanged ? event.timezone : parsed.value.timezone,
          },
        });
      } catch (err) {
        // A rejected write is audited before the error goes on, as `hostAction`
        // does.
        await recordAudit(
          session,
          boundAuditEntry({
            action: "event.edit",
            targetId: eventId,
            result: "failure",
            errorMessage: err instanceof Error ? err.message : String(err),
          }),
        );
        throw err;
      }
      if (!result.ok) {
        // A conflict sends the host back to a fresh form; a refusal to the panel.
        await fail(
          result.message,
          result.code === "refused" ? hostPanelPath(eventId) : undefined,
        );
        return;
      }
      await recordAudit(
        session,
        boundAuditEntry({
          action: "event.edit",
          targetId: eventId,
          details: {
            before: result.diff.before,
            after: result.diff.after,
            ...(result.scope ? { scope: result.scope } : {}),
          },
          result: "success",
        }),
      );
      hostPanelRedirect(res, eventId, {
        type: "ok",
        text: "Event updated. The Discord event and the announcement were refreshed.",
      });
    })().catch(next);
  });
}

/** What the edit page's cover panel shows for this event (#1393). */
function coverViewOf(event: IEvent): EventEditCover {
  const reason = coverIneligibleReason(event);
  if (reason) return { kind: "unavailable", reason };
  return {
    kind: "editable",
    hasCover: !!event.coverHash,
    series: !!event.seriesId,
  };
}

/**
 * The host's cover image (#1393): `POST <panel>/cover` (raw bytes, CSRF in the
 * `X-CSRF-Token` header, like the admin route) and `POST <panel>/cover/remove`,
 * behind the same gate as the other host routes (CSRF, host scope, creator or
 * admin). Storage, the size cap, the signature check and the eligibility rules
 * (adopted, detached, finished events) are `services/event-cover.ts`, shared
 * with `/admin/events/:id/cover`. The cover belongs to the whole series, so a
 * host editing one occurrence changes the cover of every occurrence; the page
 * says so. Audited as `event.host.cover-set` / `event.host.cover-remove`.
 */
function registerCoverRoutes(router: Router, client: Client): void {
  const answer = (
    req: Request,
    res: Response,
    eventId: string,
    flash: UserFlashMessage,
  ): void => {
    const to = `${hostPanelPath(eventId)}/edit`;
    if (wantsJson(req)) {
      const text = truncateFlash(flash.text);
      const qs = new globalThis.URLSearchParams({
        flash: flash.type,
        msg: text,
        sig: signFlash(flash.type, text),
      }).toString();
      res.status(200).json({ type: flash.type, text, reload: `${to}?${qs}` });
      return;
    }
    redirectWithFlash(res, to, flash);
  };

  // A storage call that throws (Mongo down, a partial write) is audited as a
  // failure naming the actor before the error goes on, as the edit save does.
  // The service orders its writes so a throw never leaves a row naming a
  // missing image: a set stores the image first and then points the rows at it
  // (a throw in between leaves an unreferenced image, replaced by the next
  // upload or swept when the event finishes); a remove detaches the rows first
  // and then deletes the image (a throw leaves an unreferenced image, deleted
  // by a retry or the same sweep).
  const auditThrown = async (
    session: WebSessionContext,
    action: string,
    eventId: string,
    err: unknown,
  ): Promise<void> => {
    await recordAudit(
      session,
      boundAuditEntry({
        action,
        targetId: eventId,
        result: "failure",
        errorMessage: err instanceof Error ? err.message : String(err),
      }),
    );
  };

  // Everything both routes check after the body is read: Events on, and a
  // fresh read of the event (the gate's copy is from before the upload).
  const load = async (
    hreq: HostRequest,
  ): Promise<{ event: IEvent } | { refusal: string }> => {
    const service = EventService.getInstance(client);
    if (!(await service.editsAllowed())) {
      return { refusal: EDIT_MESSAGES.disabled };
    }
    const fresh = await service.getEvent(String(hreq.hostEvent._id));
    if (!fresh || !isEventHost(hreq.hostSession, fresh)) {
      return { refusal: "This event is no longer available." };
    }
    return { event: fresh };
  };

  router.post(
    "/cover",
    coverUploadBody((req, res) => {
      const { hostEvent } = req as HostRequest;
      answer(req, res, String(hostEvent._id), {
        type: "err",
        text: COVER_TOO_LARGE_TEXT,
      });
    }),
    (req, res, next: NextFunction) => {
      const hreq = req as HostRequest;
      const session = hreq.hostSession;
      const eventId = String(hreq.hostEvent._id);
      const body: unknown = req.body;
      const data = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
      void (async (): Promise<void> => {
        const loaded = await load(hreq);
        if ("refusal" in loaded) {
          await recordAudit(
            session,
            boundAuditEntry({
              action: "event.host.cover-set",
              targetId: eventId,
              details: { bytes: data.length },
              result: "failure",
              errorMessage: loaded.refusal,
            }),
          );
          answer(req, res, eventId, { type: "err", text: loaded.refusal });
          return;
        }
        let result: Awaited<ReturnType<typeof setEventCover>>;
        try {
          result = await setEventCover(loaded.event, data);
        } catch (err) {
          await auditThrown(session, "event.host.cover-set", eventId, err);
          throw err;
        }
        await recordAudit(
          session,
          boundAuditEntry({
            action: "event.host.cover-set",
            targetId: eventId,
            details: result.ok
              ? { mime: result.mime, bytes: result.bytes, hash: result.hash }
              : { bytes: data.length },
            result: result.ok ? "success" : "failure",
            errorMessage: result.ok ? null : result.error,
          }),
        );
        answer(req, res, eventId, {
          type: result.ok ? "ok" : "err",
          text: result.ok
            ? `Cover image saved${loaded.event.seriesId ? " for the whole series" : ""}. It reaches the Discord event within a minute.`
            : `Cover image rejected: ${result.error}`,
        });
      })().catch(next);
    },
  );

  router.post("/cover/remove", (req, res, next: NextFunction) => {
    const hreq = req as HostRequest;
    const session = hreq.hostSession;
    const eventId = String(hreq.hostEvent._id);
    void (async (): Promise<void> => {
      const loaded = await load(hreq);
      let result: Awaited<ReturnType<typeof removeEventCover>>;
      if ("refusal" in loaded) {
        result = { ok: false, error: loaded.refusal };
      } else {
        try {
          result = await removeEventCover(loaded.event);
        } catch (err) {
          await auditThrown(session, "event.host.cover-remove", eventId, err);
          throw err;
        }
      }
      await recordAudit(
        session,
        boundAuditEntry({
          action: "event.host.cover-remove",
          targetId: eventId,
          result: result.ok ? "success" : "failure",
          errorMessage: result.ok ? null : result.error,
        }),
      );
      const series = "event" in loaded && !!loaded.event.seriesId;
      answer(req, res, eventId, {
        type: result.ok ? "ok" : "err",
        text: result.ok
          ? `Cover image removed${series ? " for the whole series" : ""}. It is cleared on the Discord event within a minute.`
          : `Could not remove the cover: ${result.error}`,
      });
    })().catch(next);
  });
}

/**
 * `POST /cancel` (#1319): cancel a planned event from "Your events". Only this
 * event, never a series (a host's events do not repeat; an admin's series is
 * stopped from the admin Events page). A running event is ended from its
 * panel instead, so it is refused here. The outcome is what the service
 * reports: `cancelled` only when this call really cancelled it.
 */
function registerCancelAction(router: Router, client: Client): void {
  hostAction(router, "cancel", "/cancel", async ({ event, session }) => {
    const now = new Date();
    const running = {
      ok: false,
      message:
        "This event is running. End it from its host panel instead of cancelling it.",
      errorMessage: "event is running",
      redirectTo: "/me/events",
    };
    // Early answer from the gate's read; the real guard is the atomic claim.
    if (isEventRunning(event, now)) return running;
    const after = await EventService.getInstance(client).cancelEvent(
      String(event._id),
      session.guildId,
      { refuseRunningAt: now },
    );
    const ok = after !== null && after.state === "cancelled";
    // A refusal by the claim: the event became running after the gate's read.
    if (!ok && after !== null && isEventRunning(after, now)) return running;
    return {
      ok,
      message: ok
        ? `Cancelled '${event.title}'.`
        : `'${event.title}' could not be cancelled: it is ${after?.state ?? "gone"}.`,
      errorMessage: ok ? null : `event is ${after?.state ?? "missing"}`,
      redirectTo: "/me/events",
    };
  });
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

  // The toolbar and the team board (#1424) read; the actions below are the
  // routes of #1191 (assign, unassign, randomise, lock), #1192 (moves),
  // #1195 (leaders) and #1196 (reset a team), unchanged.
  HOST_SECTION_RENDERERS.board = createBoardSection(client);
  registerAssignmentActions(router, client);
  registerMoveActions(router, client);
  registerLeaderActions(router, client);
  registerCustomiseActions(router, client);
  // The "End the event" section and its action (#1193).
  HOST_SECTION_RENDERERS.end = createEndSection();
  registerEndAction(router, client);
  // The folded "Change the groups" section (#1424), built from the settings read.
  HOST_SECTION_RENDERERS.groupchanges = createGroupChangesSection(client);
  // The "Event settings" section and its save and confirm actions (#1239).
  HOST_SECTION_RENDERERS.settings = createSettingsSection(client);
  registerSettingsActions(router, client);
  // Editing the event itself (#1298): `GET` and `POST` `/edit`.
  registerEditRoutes(router, client);
  // The cover image on the edit page (#1393).
  registerCoverRoutes(router, client);
  // Cancelling a planned event from "Your events" (#1319).
  registerCancelAction(router, client);

  router.get("/", (req, res, next: NextFunction) => {
    const { hostEvent: event, hostSession: session } = req as HostRequest;
    const flash = readSignedFlash(req.query);
    const csrfToken = getCsrfToken(req);
    void (async (): Promise<void> => {
      const zone = await readMemberZone(session.discordUserId, session.guildId);
      const ctx: HostSectionContext = {
        event,
        session,
        csrfToken,
        actionPath: (action) => `${hostPanelPath(String(event._id))}/${action}`,
        zone,
      };
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
      const panelEvent = toPanelEvent(client, event, zone);
      const permissionNotice = await hostPermissionNotice(
        client,
        event.guildId,
        panelEvent,
        event,
      );
      res.type("text/html").send(
        renderUserPage({
          title: `Host panel: ${event.title}`,
          active: "/me/events",
          body: renderHostPanelBody({
            event: panelEvent,
            permissionNotice,
            canLinkToPermissions: session.role === "admin",
            controls,
            settingsOpen:
              flash !== null &&
              flash !== undefined &&
              req.query.open === "folds",
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
