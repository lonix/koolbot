/**
 * State-changing route handlers for the WebUI (issues #383 and #384).
 * Mounted onto the WebUI router behind `requireSession` and
 * `requireCsrf`. Every handler is a thin wrapper around an existing
 * service — there is no business logic here. Each write records exactly
 * one audit entry via `recordAudit()`.
 *
 * The handlers themselves are split by domain into `./routes/write/*`
 * (#850); this module is the mount point that composes them behind the
 * shared middleware so the security properties stay in one obvious place.
 * The pure helpers (`coerceConfigValue`, `TEXT_LIMITS`, …) live in
 * `./routes/write/helpers.js` and are re-exported here for existing callers.
 */

import { Router, type RequestHandler } from "express";
import { Client } from "discord.js";
import { requireCsrf } from "./csrf.js";
import { requireAdminRoleMiddleware } from "./session.js";
import { createSettingsRouter } from "./routes/write/settings.js";
import { createPermissionsRouter } from "./routes/write/permissions.js";
import { createWizardRouter } from "./routes/write/wizard.js";
import { createAnnouncementsRouter } from "./routes/write/announcements.js";
import { createEventsRouter } from "./routes/write/events.js";
import { createPollsRouter } from "./routes/write/polls.js";
import { createReactionRolesRouter } from "./routes/write/reaction-roles.js";
import { createNoticesRouter } from "./routes/write/notices.js";
import { createDatabaseRouter } from "./routes/write/database.js";
import { createVoiceChannelsRouter } from "./routes/write/voice-channels.js";
import { createDigestRouter } from "./routes/write/digest.js";
import { createBotStatusRouter } from "./routes/write/bot-status.js";

export * from "./routes/write/helpers.js";

export function createWriteRouter(
  client: Client,
  requireSession: RequestHandler,
): Router {
  const router = Router();
  router.use(requireSession);
  // Every write handler below targets the admin panel. User-role
  // sessions hitting these routes get a 403 from the role middleware;
  // their own writes (when #482/#484 add them) live on `/me/*`.
  router.use(requireAdminRoleMiddleware());
  router.use(requireCsrf);

  router.use(createSettingsRouter(client));
  router.use(createPermissionsRouter(client));
  router.use(createWizardRouter(client));
  router.use(createAnnouncementsRouter(client));
  router.use(createEventsRouter(client));
  router.use(createPollsRouter(client));
  router.use(createReactionRolesRouter(client));
  router.use(createNoticesRouter(client));
  router.use(createDatabaseRouter(client));
  router.use(createVoiceChannelsRouter(client));
  router.use(createDigestRouter(client));
  router.use(createBotStatusRouter(client));

  return router;
}
