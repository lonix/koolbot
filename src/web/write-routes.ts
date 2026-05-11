/**
 * Write route handlers for #383. These mount onto the WebUI router built by
 * `createWebRouter` and are guarded by both the session middleware and
 * `requireCsrf`. Every write goes through the existing services in
 * `src/services/` — no duplicate data access or validation logic.
 */

import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { Client } from "discord.js";
import * as yaml from "js-yaml";
import logger from "../utils/logger.js";
import { ConfigService } from "../services/config-service.js";
import { PermissionsService } from "../services/permissions-service.js";
import { WizardService } from "../services/wizard-service.js";
import { defaultConfig, settingsMetadata } from "../services/config-schema.js";
import { AuditLog } from "../models/audit-log.js";
import { requireCsrf } from "./csrf.js";
import type { AuthenticatedRequest } from "./session.js";
import { getDisplayedRemainingMs } from "./admin-layout.js";
import {
  renderImportDiffPage,
  renderWizardPage,
  renderWizardStepPage,
  renderWizardConfirmPage,
  type ImportDiffRow,
} from "./admin-views.js";

/**
 * Environment / bootstrap keys that must never appear in YAML import payloads
 * or YAML export output (defense in depth — they're never exported in the first
 * place, but we also refuse them on import).
 */
const PROTECTED_KEYS = new Set([
  "DISCORD_TOKEN",
  "CLIENT_ID",
  "GUILD_ID",
  "MONGODB_URI",
  "NODE_ENV",
  "DEBUG",
  "WEBUI_ENABLED",
  "WEBUI_BASE_URL",
  "WEBUI_SESSION_SECRET",
  "WEBUI_SESSION_TTL_MINUTES",
  "WEBUI_INACTIVITY_TIMEOUT_MINUTES",
]);

/** Settings shown per wizard feature (key order determines form order). */
const WIZARD_FEATURE_SETTINGS: Record<string, string[]> = {
  voicechannels: [
    "voicechannels.enabled",
    "voicechannels.category.name",
    "voicechannels.lobby.name",
    "voicechannels.lobby.offlinename",
    "voicechannels.channel.prefix",
    "voicechannels.channel.suffix",
    "voicechannels.controlpanel.enabled",
  ],
  voicetracking: [
    "voicetracking.enabled",
    "voicetracking.stats.top.enabled",
    "voicetracking.stats.user.enabled",
    "voicetracking.seen.enabled",
    "voicetracking.announcements.enabled",
    "voicetracking.announcements.channel",
  ],
  quotes: [
    "quotes.enabled",
    "quotes.channel_id",
    "quotes.max_length",
    "quotes.cooldown",
    "quotes.header_enabled",
  ],
  achievements: [
    "achievements.enabled",
    "achievements.announcements.enabled",
    "achievements.dm_notifications.enabled",
  ],
  logging: [
    "core.startup.enabled",
    "core.startup.channel_id",
    "core.errors.enabled",
    "core.errors.channel_id",
    "core.config.enabled",
    "core.config.channel_id",
  ],
  amikool: ["amikool.enabled", "amikool.role.name"],
  reactionroles: ["reactionroles.enabled", "reactionroles.message_channel_id"],
  announcements: ["announcements.enabled"],
  notices: ["notices.enabled", "notices.channel_id", "notices.header_enabled"],
  polls: [
    "polls.enabled",
    "polls.default_duration_hours",
    "polls.cooldown_days",
  ],
};

/** All wizard feature keys in display order. */
const WIZARD_FEATURE_ORDER = [
  "voicechannels",
  "voicetracking",
  "quotes",
  "achievements",
  "logging",
  "amikool",
  "reactionroles",
  "announcements",
  "notices",
  "polls",
];

function asyncHandler(
  fn: (req: AuthenticatedRequest, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next: NextFunction): void => {
    fn(req as AuthenticatedRequest, res).catch(next);
  };
}

function commonFromReq(req: AuthenticatedRequest): {
  userId: string;
  guildId: string;
  csrfToken: string;
  remainingMs: number;
} {
  const session = req.webSession;
  if (!session) throw new Error("requireSession middleware must run first");
  return {
    userId: session.discordUserId,
    guildId: session.guildId,
    csrfToken: (req as Request & { csrfToken?: string }).csrfToken ?? "",
    remainingMs: getDisplayedRemainingMs(session),
  };
}

/**
 * Coerce a raw form value to match the expected type of `key` in `defaultConfig`.
 * Returns the coerced value on success, or `null` if coercion fails.
 */
function coerceValue(
  key: string,
  raw: unknown,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (!(key in defaultConfig)) {
    return { ok: false, reason: "unknown key" };
  }
  const expectedType = typeof defaultConfig[key as keyof typeof defaultConfig];

  if (expectedType === "boolean") {
    // HTML checkboxes send "true" when checked; absent field → false.
    return { ok: true, value: raw === "true" || raw === true };
  }
  if (expectedType === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) return { ok: false, reason: "invalid number" };
    return { ok: true, value: n };
  }
  // string
  return { ok: true, value: String(raw ?? "") };
}

export function createWriteRouter(
  client: Client,
  requireSession: RequestHandler,
): Router {
  const router = Router();

  // Body parsing is handled by the parent router (createWebRouter) which
  // sets a 256 KB limit — large enough for YAML imports of any realistic
  // configuration file.
  router.use(requireSession);
  router.use(requireCsrf);

  // ------------------------------------------------------------------ //
  //  Settings writes                                                      //
  // ------------------------------------------------------------------ //

  /** POST /settings/set — set a single setting by key. */
  router.post(
    "/settings/set",
    asyncHandler(async (req, res) => {
      const { userId, guildId } = commonFromReq(req);
      const key = String(req.body?.key ?? "").trim();
      const raw = req.body?.value;

      const coerced = coerceValue(key, raw);
      if (!coerced.ok) {
        res.status(400).type("text/plain").send(coerced.reason);
        return;
      }

      const config = ConfigService.getInstance();
      let before: unknown;
      try {
        before = await config.get(key);
      } catch {
        before = defaultConfig[key as keyof typeof defaultConfig];
      }
      const meta = settingsMetadata[key as keyof typeof settingsMetadata];
      await config.set(
        key,
        coerced.value,
        meta?.description ?? "",
        meta?.category ?? key.split(".")[0],
      );

      await AuditLog.create({
        action: "setting.set",
        userId,
        guildId,
        key,
        before,
        after: coerced.value,
      });
      logger.info(`WebUI: ${userId} set ${key}`);

      res.redirect(302, "/admin/settings");
    }),
  );

  /** POST /settings/reset — reset a single setting to its default. */
  router.post(
    "/settings/reset",
    asyncHandler(async (req, res) => {
      const { userId, guildId } = commonFromReq(req);
      const key = String(req.body?.key ?? "").trim();

      if (!(key in defaultConfig)) {
        res.status(400).type("text/plain").send("Unknown setting key");
        return;
      }

      const config = ConfigService.getInstance();
      let before: unknown;
      try {
        before = await config.get(key);
      } catch {
        before = undefined;
      }
      await config.delete(key);

      await AuditLog.create({
        action: "setting.reset",
        userId,
        guildId,
        key,
        before,
        after: defaultConfig[key as keyof typeof defaultConfig],
      });
      logger.info(`WebUI: ${userId} reset ${key}`);

      res.redirect(302, "/admin/settings");
    }),
  );

  /** POST /settings/reload — reload registered commands via CommandManager. */
  router.post(
    "/settings/reload",
    asyncHandler(async (req, res) => {
      const { userId, guildId } = commonFromReq(req);

      const { BotStatusService } =
        await import("../services/bot-status-service.js");
      const botStatus = BotStatusService.getInstance(client);
      botStatus.setConfigReloadStatus();

      try {
        const { CommandManager } =
          await import("../services/command-manager.js");
        const commandManager = CommandManager.getInstance(client);
        await commandManager.registerCommands();
        await commandManager.populateClientCommands();
        botStatus.setOperationalStatus();

        await AuditLog.create({ action: "commands.reload", userId, guildId });
        logger.info(`WebUI: ${userId} triggered command reload`);
      } catch (err) {
        botStatus.setOperationalStatus();
        throw err;
      }

      res.redirect(302, "/admin/settings");
    }),
  );

  // ------------------------------------------------------------------ //
  //  YAML export (GET — no CSRF required, safe idempotent read)          //
  // ------------------------------------------------------------------ //

  /** GET /settings/export — download all DB-backed settings as YAML. */
  router.get(
    "/settings/export",
    // Override the global requireCsrf (which skips GET automatically).
    asyncHandler(async (req, res) => {
      const config = ConfigService.getInstance();
      const all = await config.getAll();
      const exportObj: Record<string, unknown> = {};

      // Start from defaults so every key has a value even if not yet in DB.
      for (const [k, v] of Object.entries(defaultConfig)) {
        if (!PROTECTED_KEYS.has(k)) exportObj[k] = v;
      }
      // Overlay with actual DB values.
      for (const entry of all) {
        if (!PROTECTED_KEYS.has(entry.key)) exportObj[entry.key] = entry.value;
      }

      const yamlContent = yaml.dump(exportObj, { sortKeys: true });
      const filename = `koolbot-config-${new Date().toISOString().slice(0, 10)}.yaml`;
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      );
      res.type("application/x-yaml").send(yamlContent);
    }),
  );

  // ------------------------------------------------------------------ //
  //  YAML import — two-step (preview then apply)                         //
  // ------------------------------------------------------------------ //

  /** POST /settings/import — parse YAML textarea and render a diff preview. */
  router.post(
    "/settings/import",
    asyncHandler(async (req, res) => {
      const common = commonFromReq(req);
      const yamlText = String(req.body?.yaml ?? "").trim();

      if (!yamlText) {
        res.redirect(302, "/admin/settings");
        return;
      }

      let parsed: unknown;
      try {
        parsed = yaml.load(yamlText);
      } catch {
        res
          .status(400)
          .type("text/plain")
          .send("Invalid YAML syntax — please check your input.");
        return;
      }

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        res
          .status(400)
          .type("text/plain")
          .send("YAML must be a key→value mapping, not a list or scalar.");
        return;
      }

      const config = ConfigService.getInstance();
      const all = await config.getAll();
      const currentByKey = new Map(all.map((e) => [e.key, e.value]));

      const rows: ImportDiffRow[] = [];
      for (const [key, value] of Object.entries(
        parsed as Record<string, unknown>,
      )) {
        if (PROTECTED_KEYS.has(key)) {
          rows.push({ key, status: "rejected", reason: "protected key" });
          continue;
        }
        if (!(key in defaultConfig)) {
          rows.push({ key, status: "rejected", reason: "unknown key" });
          continue;
        }
        const before = currentByKey.has(key)
          ? currentByKey.get(key)
          : defaultConfig[key as keyof typeof defaultConfig];
        rows.push({ key, status: "pending", before, after: value });
      }

      res.type("text/html").send(
        renderImportDiffPage({
          ...common,
          rows,
          yamlText,
        }),
      );
    }),
  );

  /** POST /settings/import/apply — apply a previously previewed YAML import. */
  router.post(
    "/settings/import/apply",
    asyncHandler(async (req, res) => {
      const { userId, guildId } = commonFromReq(req);
      const yamlText = String(req.body?.yaml ?? "").trim();

      let parsed: unknown;
      try {
        parsed = yaml.load(yamlText);
      } catch {
        res.status(400).type("text/plain").send("Invalid YAML");
        return;
      }

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        res.status(400).type("text/plain").send("YAML must be a mapping");
        return;
      }

      const config = ConfigService.getInstance();
      let applied = 0;

      for (const [key, value] of Object.entries(
        parsed as Record<string, unknown>,
      )) {
        if (PROTECTED_KEYS.has(key)) continue;
        if (!(key in defaultConfig)) continue;

        const coerced = coerceValue(key, value);
        if (!coerced.ok) continue;

        const meta = settingsMetadata[key as keyof typeof settingsMetadata];
        await config.set(
          key,
          coerced.value,
          meta?.description ?? "",
          meta?.category ?? key.split(".")[0],
        );
        applied++;
      }

      await AuditLog.create({
        action: "settings.import",
        userId,
        guildId,
        extra: { applied },
      });
      logger.info(`WebUI: ${userId} imported ${applied} settings`);

      res.redirect(302, "/admin/settings");
    }),
  );

  // ------------------------------------------------------------------ //
  //  Permissions writes                                                   //
  // ------------------------------------------------------------------ //

  /**
   * POST /permissions/set — replace the role list for a single command.
   * Sending an empty role list clears the restriction (command becomes open).
   */
  router.post(
    "/permissions/set",
    asyncHandler(async (req, res) => {
      const { userId, guildId } = commonFromReq(req);
      const command = String(req.body?.command ?? "").trim();

      if (!command) {
        res.status(400).type("text/plain").send("Missing command");
        return;
      }

      // `<select multiple>` posts an array; a single value posts a string.
      const rawRoleIds = req.body?.roleIds;
      let roleIds: string[];
      if (Array.isArray(rawRoleIds)) {
        roleIds = rawRoleIds.map(String).filter(Boolean);
      } else if (typeof rawRoleIds === "string" && rawRoleIds) {
        roleIds = rawRoleIds
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      } else {
        roleIds = [];
      }

      const permissions = PermissionsService.getInstance(client);
      const before = await permissions
        .getCommandPermissions(guildId, command)
        .catch(() => null);

      if (roleIds.length === 0) {
        await permissions.clearCommandPermissions(guildId, command);
      } else {
        await permissions.setCommandPermissions(guildId, command, roleIds);
      }

      await AuditLog.create({
        action: "permissions.set",
        userId,
        guildId,
        key: command,
        before,
        after: roleIds,
      });
      logger.info(
        `WebUI: ${userId} set permissions for /${command} → [${roleIds.join(", ")}]`,
      );

      res.redirect(302, "/admin/permissions");
    }),
  );

  // ------------------------------------------------------------------ //
  //  Setup Wizard                                                         //
  // ------------------------------------------------------------------ //

  /** GET /wizard — step 0: feature selection (or resume existing session). */
  router.get(
    "/wizard",
    asyncHandler(async (req, res) => {
      const { userId, guildId, csrfToken, remainingMs } = commonFromReq(req);
      const wizard = WizardService.getInstance();
      const existing = wizard.getSession(userId, guildId);

      if (existing && Number(req.query.reset) !== 1) {
        // Resume: redirect to the current step.
        const features = existing.selectedFeatures;
        const stepParam = req.query.step;
        const step =
          stepParam !== undefined ? parseInt(String(stepParam), 10) : -1;

        if (step >= 0 && step < features.length) {
          const featureKey = features[step];
          const settingKeys = WIZARD_FEATURE_SETTINGS[featureKey] ?? [];
          const config = ConfigService.getInstance();
          const currentValues: Record<string, unknown> = {};
          for (const k of settingKeys) {
            const fromWizard = wizard.getConfiguration(userId, guildId, k);
            if (fromWizard !== undefined) {
              currentValues[k] = fromWizard;
            } else {
              try {
                currentValues[k] = await config.get(k);
              } catch {
                currentValues[k] =
                  defaultConfig[k as keyof typeof defaultConfig];
              }
            }
          }
          res.type("text/html").send(
            renderWizardStepPage({
              csrfToken,
              remainingMs,
              stepIndex: step,
              totalSteps: features.length,
              featureKey,
              settingKeys,
              currentValues,
              metadata: settingsMetadata,
              defaultValues: defaultConfig as unknown as Record<
                string,
                unknown
              >,
            }),
          );
          return;
        }

        if (String(stepParam) === "confirm") {
          const pending = Object.entries(existing.configuration);
          res.type("text/html").send(
            renderWizardConfirmPage({
              csrfToken,
              remainingMs,
              pending,
              metadata: settingsMetadata,
            }),
          );
          return;
        }
      }

      // Step 0: show feature selection.
      const config = ConfigService.getInstance();
      const featureStatus: Record<string, boolean> = {};
      for (const fk of WIZARD_FEATURE_ORDER) {
        const keys = WIZARD_FEATURE_SETTINGS[fk] ?? [];
        const enabledKey = keys.find((k) => k.endsWith(".enabled"));
        featureStatus[fk] = enabledKey
          ? await config.getBoolean(enabledKey, false)
          : false;
      }

      res.type("text/html").send(
        renderWizardPage({
          csrfToken,
          remainingMs,
          featureOrder: WIZARD_FEATURE_ORDER,
          featureStatus,
        }),
      );
    }),
  );

  /** POST /wizard/start — create a wizard session from selected features. */
  router.post(
    "/wizard/start",
    asyncHandler(async (req, res) => {
      const { userId, guildId } = commonFromReq(req);
      const rawFeatures = req.body?.features;
      const features: string[] = (
        Array.isArray(rawFeatures) ? rawFeatures : [rawFeatures]
      )
        .map(String)
        .filter((f) => WIZARD_FEATURE_ORDER.includes(f));

      if (features.length === 0) {
        res.redirect(302, "/admin/wizard");
        return;
      }

      const wizard = WizardService.getInstance();
      wizard.createSession(userId, guildId, features);
      res.redirect(302, "/admin/wizard?step=0");
    }),
  );

  /** POST /wizard/step/:n — save configuration for step n, advance. */
  router.post(
    "/wizard/step/:n",
    asyncHandler(async (req, res) => {
      const { userId, guildId } = commonFromReq(req);
      const wizard = WizardService.getInstance();
      const state = wizard.getSession(userId, guildId);
      if (!state) {
        res.redirect(302, "/admin/wizard");
        return;
      }

      const stepIndex = parseInt(String(req.params.n), 10);
      if (
        !Number.isFinite(stepIndex) ||
        stepIndex < 0 ||
        stepIndex >= state.selectedFeatures.length
      ) {
        res.redirect(302, "/admin/wizard");
        return;
      }

      const featureKey = state.selectedFeatures[stepIndex];
      const settingKeys = WIZARD_FEATURE_SETTINGS[featureKey] ?? [];

      for (const k of settingKeys) {
        const raw = req.body?.[k];
        const coerced = coerceValue(k, raw);
        if (coerced.ok) {
          wizard.addConfiguration(
            userId,
            guildId,
            k,
            coerced.value as string | number | boolean,
          );
        }
      }

      const nextStep = stepIndex + 1;
      if (nextStep >= state.selectedFeatures.length) {
        res.redirect(302, "/admin/wizard?step=confirm");
      } else {
        res.redirect(302, `/admin/wizard?step=${nextStep}`);
      }
    }),
  );

  /** POST /wizard/apply — apply the pending wizard configuration. */
  router.post(
    "/wizard/apply",
    asyncHandler(async (req, res) => {
      const { userId, guildId } = commonFromReq(req);
      const wizard = WizardService.getInstance();
      const state = wizard.getSession(userId, guildId);

      if (!state) {
        res.redirect(302, "/admin/wizard");
        return;
      }

      const applied = await wizard.applyConfiguration(userId, guildId);
      if (applied) {
        await AuditLog.create({
          action: "wizard.apply",
          userId,
          guildId,
          extra: { keys: Object.keys(state.configuration) },
        });
        logger.info(
          `WebUI: ${userId} applied wizard (${Object.keys(state.configuration).length} settings)`,
        );
      }

      wizard.endSession(userId, guildId);
      res.redirect(302, "/admin/settings");
    }),
  );

  /** POST /wizard/cancel — discard wizard session. */
  router.post(
    "/wizard/cancel",
    asyncHandler(async (req, res) => {
      const { userId, guildId } = commonFromReq(req);
      WizardService.getInstance().endSession(userId, guildId);
      res.redirect(302, "/admin/");
    }),
  );

  return router;
}

/** Keys that must never appear in YAML export or import (re-exported for tests). */
export { PROTECTED_KEYS };
