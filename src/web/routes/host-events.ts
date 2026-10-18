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

/** A request that has passed the host gate. */
export type HostRequest = AuthenticatedRequest & {
  /** The event, loaded once by the gate. */
  hostEvent: IEvent;
  /** The session, read once by the gate. */
  hostSession: WebSessionContext;
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
      hostPanelRedirect(res, eventId, {
        type: result.ok ? "ok" : "err",
        text: result.message,
      });
    })().catch(next);
  });
}

function toPanelEvent(client: Client, event: IEvent): HostPanelEvent {
  const channelId = event.channelId ?? null;
  const channelName = channelId
    ? (client.guilds?.cache?.get(event.guildId)?.channels?.cache?.get(channelId)
        ?.name ?? null)
    : null;
  const groupsEnabled = event.groupsEnabled === true;
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
    channelLeadMinutes: event.channelLeadMinutes ?? null,
    groups: groupsEnabled
      ? (event.groups ?? []).map((g) => ({
          name: g.name,
          marker: g.marker ?? "",
          kind: g.kind,
          size: g.size ?? null,
          tag: g.tag ?? "",
          hasChannel: !!g.channelId,
          memberCount: (g.memberIds ?? []).length,
        }))
      : [],
    groupNotices: groupsEnabled ? groupNoticesFor(client, event) : [],
    adopted: event.nativeAdopted === true,
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
