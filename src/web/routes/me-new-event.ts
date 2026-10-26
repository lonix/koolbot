/**
 * "New event" for event hosts (#1305): `/me/events/new`.
 *
 * Mounted by `createUserRouter` under `/events`, AFTER the host-scope guard
 * (`requireScopeMiddleware("host")`, resolved from role groups on every
 * request), the session check and the `/me` write limiter. This router adds
 * CSRF on every unsafe method itself. It answers 404 while Events is switched
 * off, as the other feature-gated `/me` pages do.
 *
 * Everything that matters for who owns the event comes from the session: the
 * pipeline (`createEventFromForm`) sets `createdBy` and `guildId` from it and
 * never reads them from the body. A host's events do not repeat.
 */

import { Router, type Request, type Response } from "express";
import type { Client } from "discord.js";
import { ConfigService } from "../../services/config-service.js";
import {
  catalogNotice,
  enabledPresets,
  loadPresetCatalog,
} from "../../services/event-group-preset-service.js";
import { resolveGroupCountLimits } from "../../services/event-groups.js";
import { loadGroupPrefill } from "../../services/event-last-setup-service.js";
import { parseEventWhen } from "../event-when.js";
import { resolveTimezone } from "../../utils/timezone.js";
import {
  createdFlash,
  createEventFromForm,
  redirectToHostPanel,
} from "../event-create.js";
import { renderNewEventBody } from "../event-new-view.js";
import { inAreas, loadPermissionNotice } from "../permission-notice.js";
import { boundAuditEntry, recordAudit, type AuditEntry } from "../audit.js";
import { requireCsrf } from "../csrf.js";
import { getDisplayedRemainingMs } from "../admin-layout.js";
import { readMeSurfaceFlags } from "../me-surfaces.js";
import { renderUserPage } from "../user-layout.js";
import { renderErrorPage } from "../views.js";
import { readSignedFlash, signFlash, truncateFlash } from "../http-flash.js";
import type { AuthenticatedRequest, WebSessionContext } from "../session.js";

const PAGE = "/me/events/new";

// A host's strings are member-supplied, so every row written here is bounded first (#1142).
const auditBounded = (
  session: WebSessionContext,
  entry: AuditEntry,
): Promise<void> => recordAudit(session, boundAuditEntry(entry));

function csrfOf(req: Request): string {
  return (req as Request & { csrfToken?: string }).csrfToken ?? "";
}

function redirectWith(
  res: Response,
  flash: { type: "ok" | "err"; text: string },
): void {
  const text = truncateFlash(flash.text);
  const qs = new globalThis.URLSearchParams({
    flash: flash.type,
    msg: text,
    sig: signFlash(flash.type, text),
  }).toString();
  res.redirect(303, `${PAGE}?${qs}`);
}

function notFound(res: Response): void {
  res
    .status(404)
    .type("text/html")
    .send(
      renderErrorPage({
        title: "Not found",
        heading: "Not found",
        bodyHtml:
          '<p>Events are switched off on this server. Visit <a href="/me/">/me</a> for your own preferences.</p>',
        product: "KoolBot",
      }),
    );
}

export function createMeNewEventRouter(client: Client): Router {
  const router = Router();
  router.use(requireCsrf);

  // A strict read: a failed read is a 500, not "Events are off".
  router.use((req, res, next) => {
    void ConfigService.getInstance()
      .getBooleanStrict("events.enabled", false)
      .then((on) => {
        if (on) next();
        else notFound(res);
      })
      .catch(next);
  });

  router.get("/", (req, res, next) => {
    const session = (req as AuthenticatedRequest).webSession;
    if (!session) {
      res.status(500).type("text/plain").send("session missing");
      return;
    }
    void (async (): Promise<void> => {
      const config = ConfigService.getInstance();
      const [
        tz,
        defaultDuration,
        defaultCount,
        configuredMax,
        categoryId,
        announcementChannelId,
        flags,
        catalog,
      ] = await Promise.all([
        config.getString("events.timezone", ""),
        config.getNumber("events.default_duration_minutes", 120),
        config.getNumber("events.groups.default_count", 2),
        config.getNumber("events.groups.max_count", 15),
        config.getString("events.category_id", ""),
        config.getString("events.announcement_channel_id", ""),
        readMeSurfaceFlags(),
        // The host's own presets are offered too (#1216).
        loadPresetCatalog(session.guildId, { ownerId: session.discordUserId }),
      ]);
      const limits = resolveGroupCountLimits(defaultCount, configuredMax);
      const presets = enabledPresets(catalog);
      const startNow = req.query.when === "now";
      // The host's last setup (#1406), unless they asked for the defaults. A
      // failed read is "no prefill" and never blocks the form.
      const prefill =
        req.query.defaults === "1"
          ? null
          : await loadGroupPrefill(session.guildId, session.discordUserId, {
              maxCount: limits.maxCount,
              presets,
            });
      const setupNotice = !categoryId
        ? "No channel category is set, so event channels cannot be created yet."
        : !announcementChannelId
          ? "No announcement channel is set, so events will not be announced."
          : null;
      // Only the Events entries; the channel category and announcement channel
      // being unset is the setup notice's to say (the check skips an unset one).
      const permissionNotice = await loadPermissionNotice({
        client,
        guildId: session.guildId,
        enabled: true,
        filter: inAreas("Events"),
      });
      res.type("text/html").send(
        renderUserPage({
          title: "New event",
          active: PAGE,
          body: renderNewEventBody({
            permissionNotice,
            canLinkToPermissions: session.role === "admin",
            csrfToken: csrfOf(req),
            timezone: resolveTimezone(tz),
            defaultDurationMinutes: defaultDuration,
            groupLimits: limits,
            groupPresets: presets,
            groupPresetsNotice: catalogNotice(
              catalog.state,
              catalog.personalUnreadable,
            ),
            groupRemembered: prefill
              ? {
                  prefill,
                  resetHref: `${PAGE}?${startNow ? "when=now&" : ""}defaults=1`,
                }
              : null,
            setupNotice,
            // `?when=now` is Start now on Your events; anything else is the default.
            initialWhen:
              req.query.when === "now" && parseEventWhen("now") === "now"
                ? "now"
                : "pick",
          }),
          csrfToken: csrfOf(req),
          remainingMs: getDisplayedRemainingMs(session),
          isAdmin: session.role === "admin",
          flash: readSignedFlash(req.query),
          ...flags,
        }),
      );
    })().catch(next);
  });

  router.post("/", (req, res, next) => {
    const session = (req as AuthenticatedRequest).webSession;
    if (!session) {
      res.status(500).type("text/plain").send("session missing");
      return;
    }
    void (async (): Promise<void> => {
      const result = await createEventFromForm(client, session, req.body, {
        allowRecurrence: false,
        via: "host",
        audit: auditBounded,
      });
      if (!result.ok) {
        redirectWith(res, { type: "err", text: result.error });
        return;
      }
      // Every new event opens on its host panel: the one place a host runs it.
      redirectToHostPanel(res, String(result.event._id), createdFlash(result));
    })().catch(next);
  });

  return router;
}
