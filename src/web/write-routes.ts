/**
 * State-changing route handlers for the WebUI (issues #383 and #384).
 * Mounted onto the WebUI router behind `requireSession` and
 * `requireCsrf`. Every handler is a thin wrapper around an existing
 * service — there is no business logic here. Each write records exactly
 * one audit entry via `recordAudit()`.
 */

import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { Client } from "discord.js";
import { CronTime } from "cron";
import * as yaml from "js-yaml";
import logger from "../utils/logger.js";
import { ScheduledAnnouncementService } from "../services/scheduled-announcement-service.js";
import { PollService } from "../services/poll-service.js";
import { VoiceChannelAnnouncer } from "../services/voice-channel-announcer.js";
import { ReactionRoleService } from "../services/reaction-role-service.js";
import { NoticesChannelManager } from "../services/notices-channel-manager.js";
import { VoiceChannelTruncationService } from "../services/voice-channel-truncation.js";
import { VoiceChannelManager } from "../services/voice-channel-manager.js";
import { ConfigService } from "../services/config-service.js";
import { PermissionsService } from "../services/permissions-service.js";
import { WizardService } from "../services/wizard-service.js";
import { BotStatusService } from "../services/bot-status-service.js";
import { CommandManager } from "../services/command-manager.js";
import { defaultConfig, settingsMetadata } from "../services/config-schema.js";
import type { IScheduledAnnouncement } from "../models/scheduled-announcement.js";
import type { IPollSchedule } from "../models/poll-schedule.js";
import type { IPollItem } from "../models/poll-item.js";
import Notice from "../models/notice.js";
import { NOTICE_CATEGORIES } from "../content/notice-categories.js";
import { requireCsrf } from "./csrf.js";
import type { AuthenticatedRequest } from "./session.js";
import { recordAudit } from "./audit.js";
import { getDisplayedRemainingMs } from "./admin-layout.js";
import {
  renderImportDiffPage,
  renderWizardPage,
  renderWizardStepPage,
  renderWizardConfirmPage,
  type ImportDiffRow,
} from "./admin-views.js";

type Flash = { type: "ok" | "warn" | "err"; text: string };

const FLASH_MAX = 500;

function flashRedirect(res: Response, path: string, flash: Flash): void {
  // Mirror the renderer's 500-char cap on the way out so the redirect
  // URL itself can't balloon to header/URI limits on a noisy failure.
  const truncated =
    flash.text.length > FLASH_MAX
      ? `${flash.text.slice(0, FLASH_MAX - 1)}…`
      : flash.text;
  const qs = new globalThis.URLSearchParams({
    flash: flash.type,
    msg: truncated,
  }).toString();
  res.redirect(303, `${path}?${qs}`);
}

function getString(req: AuthenticatedRequest, name: string): string {
  const raw = (req.body as Record<string, unknown> | undefined)?.[name];
  if (typeof raw !== "string") return "";
  return raw.trim();
}

function getCheckbox(req: AuthenticatedRequest, name: string): boolean {
  const raw = (req.body as Record<string, unknown> | undefined)?.[name];
  return typeof raw === "string" && raw.length > 0;
}

function parseIntInRange(raw: string, min: number, max: number): number | null {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

/**
 * Normalize a cron expression: trim wrapping quotes so we validate and
 * persist the same form. Otherwise `"0 9 * * *"` would pass validation
 * (which strips quotes internally) but get stored verbatim, and later
 * fail when the cron job is actually scheduled from the database row.
 */
function normalizeCron(expr: string): string {
  return expr.replace(/^["']|["']$/g, "").trim();
}

function validCron(expr: string): boolean {
  try {
    new CronTime(expr);
    return true;
  } catch {
    return false;
  }
}

function parseHexColor(input: string): number | null {
  const match = input.match(/^#?([0-9A-Fa-f]{6})$/);
  if (!match) return null;
  return parseInt(match[1], 16);
}

function requireSessionContext(req: AuthenticatedRequest): {
  guildId: string;
  discordUserId: string;
  sessionId: string;
  scopes: string[];
  lastActivityAt: number;
  expiresAt: Date;
} {
  if (!req.webSession) {
    throw new Error("requireSession middleware must run first");
  }
  return req.webSession;
}

function asyncHandler(
  fn: (req: AuthenticatedRequest, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next: NextFunction): void => {
    fn(req as AuthenticatedRequest, res).catch(next);
  };
}

/**
 * Environment / bootstrap keys that must never appear in YAML import payloads
 * or YAML export output. Defense in depth — they're never put into the export
 * dictionary in the first place, and import/apply refuses them again.
 *
 * Hand-maintained: keep in lock-step with the `WEBUI_*` and bootstrap env
 * vars consumed in src/index.ts and src/web/index.ts. Adding a new env var
 * without updating this list will silently let admins overwrite it via YAML.
 */
export const PROTECTED_KEYS: ReadonlySet<string> = new Set([
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

/**
 * Settings shown per wizard feature. Key order determines form order.
 * Each list must reference real keys in `defaultConfig` — unknown keys
 * are silently dropped at apply.
 */
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
    "voicetracking.announcements.channel_id",
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
  reactionroles: ["reactionroles.enabled", "reactionroles.message_channel_id"],
  announcements: ["announcements.enabled"],
  notices: ["notices.enabled", "notices.channel_id", "notices.header_enabled"],
  polls: [
    "polls.enabled",
    "polls.default_duration_hours",
    "polls.cooldown_days",
  ],
};

const WIZARD_FEATURE_ORDER = [
  "voicechannels",
  "voicetracking",
  "quotes",
  "achievements",
  "reactionroles",
  "announcements",
  "notices",
  "polls",
];

/**
 * Coerce a raw form value to match the expected type of `key` in
 * `defaultConfig`. Returns the coerced value on success, or a typed
 * failure describing why coercion was refused.
 */
export function coerceConfigValue(
  key: string,
  raw: unknown,
):
  | { ok: true; value: string | number | boolean }
  | { ok: false; reason: string } {
  if (!(key in defaultConfig)) {
    return { ok: false, reason: "unknown key" };
  }
  const expected = typeof defaultConfig[key as keyof typeof defaultConfig];
  if (expected === "boolean") {
    // HTML checkboxes post "true" when checked, the field is absent when
    // unchecked. YAML may post a real boolean; honour both.
    return { ok: true, value: raw === "true" || raw === true };
  }
  if (expected === "number") {
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n)) return { ok: false, reason: "invalid number" };
    return { ok: true, value: n };
  }
  return { ok: true, value: String(raw ?? "") };
}

function getCsrfFromReq(req: AuthenticatedRequest): string {
  return (req as Request & { csrfToken?: string }).csrfToken ?? "";
}

export function createWriteRouter(
  client: Client,
  requireSession: RequestHandler,
): Router {
  const router = Router();
  router.use(requireSession);
  router.use(requireCsrf);

  // ============================================================
  // Settings — single-key set/reset + reload (issue #383)
  // ============================================================

  router.post(
    "/settings/set",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const key = getString(req, "key");
      const raw = (req.body as Record<string, unknown> | undefined)?.value;

      const coerced = coerceConfigValue(key, raw);
      if (!coerced.ok) {
        await recordAudit(session, {
          action: "setting.set",
          targetId: key || null,
          details: { reason: coerced.reason },
          result: "failure",
          errorMessage: coerced.reason,
        });
        flashRedirect(res, "/admin/settings", {
          type: "err",
          text: `Cannot set ${key || "(empty key)"}: ${coerced.reason}.`,
        });
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
      try {
        await config.set(
          key,
          coerced.value,
          meta?.description ?? "",
          meta?.category ?? key.split(".")[0],
        );
        await recordAudit(session, {
          action: "setting.set",
          targetId: key,
          details: { before, after: coerced.value },
          result: "success",
        });
        flashRedirect(res, "/admin/settings", {
          type: "ok",
          text: `Set ${key} = ${String(coerced.value)}.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Set setting failed", err);
        await recordAudit(session, {
          action: "setting.set",
          targetId: key,
          details: { before, attempted: coerced.value },
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/settings", {
          type: "err",
          text: `Failed to set ${key}: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/settings/reset",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const key = getString(req, "key");
      if (!(key in defaultConfig)) {
        await recordAudit(session, {
          action: "setting.reset",
          targetId: key || null,
          result: "failure",
          errorMessage: "unknown key",
        });
        flashRedirect(res, "/admin/settings", {
          type: "err",
          text: `Unknown setting: ${key || "(empty)"}.`,
        });
        return;
      }

      const config = ConfigService.getInstance();
      let before: unknown;
      try {
        before = await config.get(key);
      } catch {
        before = undefined;
      }
      try {
        await config.delete(key);
        await recordAudit(session, {
          action: "setting.reset",
          targetId: key,
          details: {
            before,
            after: defaultConfig[key as keyof typeof defaultConfig],
          },
          result: "success",
        });
        flashRedirect(res, "/admin/settings", {
          type: "ok",
          text: `Reset ${key} to default.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Reset setting failed", err);
        await recordAudit(session, {
          action: "setting.reset",
          targetId: key,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/settings", {
          type: "err",
          text: `Failed to reset ${key}: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/settings/reload",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const botStatus = BotStatusService.getInstance(client);
      botStatus.setConfigReloadStatus();
      try {
        const commandManager = CommandManager.getInstance(client);
        await commandManager.registerCommands();
        await commandManager.populateClientCommands();
        await recordAudit(session, {
          action: "commands.reload",
          result: "success",
        });
        flashRedirect(res, "/admin/settings", {
          type: "ok",
          text: "Reloaded slash commands.",
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Command reload failed", err);
        await recordAudit(session, {
          action: "commands.reload",
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/settings", {
          type: "err",
          text: `Reload failed: ${text}`,
        });
      } finally {
        // Always restore the operational status even if the reload threw —
        // otherwise the bot would be stuck in "config reloading" forever.
        botStatus.setOperationalStatus();
      }
    }),
  );

  // ============================================================
  // Settings — YAML export / import (issue #383)
  // ============================================================

  // GET is exempt from CSRF; mounted on this router so requireSession runs.
  router.get(
    "/settings/export",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      try {
        const config = ConfigService.getInstance();
        const all = await config.getAll();
        const exportObj: Record<string, unknown> = {};
        // Start from defaults so every public key has a value.
        for (const [k, v] of Object.entries(defaultConfig)) {
          if (!PROTECTED_KEYS.has(k)) exportObj[k] = v;
        }
        // Overlay with DB values.
        for (const entry of all) {
          if (!PROTECTED_KEYS.has(entry.key))
            exportObj[entry.key] = entry.value;
        }
        const yamlContent = yaml.dump(exportObj, { sortKeys: true });
        const filename = `koolbot-config-${new Date()
          .toISOString()
          .slice(0, 10)}.yaml`;
        await recordAudit(session, {
          action: "settings.export",
          details: { keys: Object.keys(exportObj).length },
          result: "success",
        });
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${filename}"`,
        );
        res.type("application/x-yaml").send(yamlContent);
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Settings export failed", err);
        await recordAudit(session, {
          action: "settings.export",
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/settings", {
          type: "err",
          text: `Export failed: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/settings/import",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const yamlText = getString(req, "yaml");
      if (!yamlText) {
        flashRedirect(res, "/admin/settings", {
          type: "err",
          text: "Paste YAML before previewing.",
        });
        return;
      }

      let parsed: unknown;
      try {
        parsed = yaml.load(yamlText);
      } catch (err) {
        const text = err instanceof Error ? err.message : "parse error";
        flashRedirect(res, "/admin/settings", {
          type: "err",
          text: `Invalid YAML: ${text}`,
        });
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        flashRedirect(res, "/admin/settings", {
          type: "err",
          text: "YAML must be a key→value mapping, not a list or scalar.",
        });
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
        // Surface type-mismatch in the preview so a silent drop at apply
        // isn't the first sign the user sees.
        const coerced = coerceConfigValue(key, value);
        if (!coerced.ok) {
          rows.push({
            key,
            status: "rejected",
            reason: `type mismatch (${coerced.reason})`,
          });
          continue;
        }
        const before = currentByKey.has(key)
          ? currentByKey.get(key)
          : defaultConfig[key as keyof typeof defaultConfig];
        rows.push({
          key,
          status: "pending",
          before,
          after: coerced.value,
        });
      }

      res.type("text/html").send(
        renderImportDiffPage({
          csrfToken: getCsrfFromReq(req),
          remainingMs: getDisplayedRemainingMs(session),
          rows,
          yamlText,
        }),
      );
    }),
  );

  router.post(
    "/settings/import/apply",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const yamlText = getString(req, "yaml");

      let parsed: unknown;
      try {
        parsed = yaml.load(yamlText);
      } catch (err) {
        const text = err instanceof Error ? err.message : "parse error";
        await recordAudit(session, {
          action: "settings.import",
          result: "failure",
          errorMessage: `parse: ${text}`,
        });
        flashRedirect(res, "/admin/settings", {
          type: "err",
          text: `Invalid YAML: ${text}`,
        });
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        await recordAudit(session, {
          action: "settings.import",
          result: "failure",
          errorMessage: "not a mapping",
        });
        flashRedirect(res, "/admin/settings", {
          type: "err",
          text: "YAML must be a mapping.",
        });
        return;
      }

      const config = ConfigService.getInstance();
      let applied = 0;
      const failed: Array<{ key: string; reason: string }> = [];

      for (const [key, value] of Object.entries(
        parsed as Record<string, unknown>,
      )) {
        if (PROTECTED_KEYS.has(key)) {
          failed.push({ key, reason: "protected" });
          continue;
        }
        if (!(key in defaultConfig)) {
          failed.push({ key, reason: "unknown" });
          continue;
        }
        const coerced = coerceConfigValue(key, value);
        if (!coerced.ok) {
          failed.push({ key, reason: coerced.reason });
          continue;
        }
        const meta = settingsMetadata[key as keyof typeof settingsMetadata];
        try {
          await config.set(
            key,
            coerced.value,
            meta?.description ?? "",
            meta?.category ?? key.split(".")[0],
          );
          applied++;
        } catch (err) {
          const text = err instanceof Error ? err.message : "set failed";
          logger.error(`Import: failed to set ${key}`, err);
          failed.push({ key, reason: text });
        }
      }

      // Tri-state outcome so an audit query for `result: "success"` doesn't
      // exclude partial imports (e.g. 99 keys applied with 1 type-mismatch).
      // `result` mirrors what the user-facing flash shows: `failure` only
      // when nothing landed; otherwise `success` with a `partial` flag in
      // the details for reporting.
      const outcome: "ok" | "partial" | "failed" =
        failed.length === 0 ? "ok" : applied > 0 ? "partial" : "failed";
      await recordAudit(session, {
        action: "settings.import",
        details: {
          applied,
          failed: failed.length,
          failedKeys: failed,
          outcome,
        },
        result: outcome === "failed" ? "failure" : "success",
        errorMessage:
          failed.length > 0
            ? failed
                .slice(0, 5)
                .map((f) => `${f.key}: ${f.reason}`)
                .join("; ")
            : null,
      });

      const summary =
        failed.length === 0
          ? `Imported ${applied} setting${applied === 1 ? "" : "s"}.`
          : `Imported ${applied}, skipped ${failed.length} (first: ${failed[0].key} — ${failed[0].reason}).`;
      flashRedirect(res, "/admin/settings", {
        type: failed.length === 0 ? "ok" : applied > 0 ? "warn" : "err",
        text: summary,
      });
    }),
  );

  // ============================================================
  // Permissions — replace allowed-role list per command (issue #383)
  // ============================================================

  router.post(
    "/permissions/set",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const command = getString(req, "command");
      if (!command) {
        flashRedirect(res, "/admin/permissions", {
          type: "err",
          text: "Missing command name.",
        });
        return;
      }

      // <select multiple> posts an array; a single value posts a string;
      // nothing selected posts no field at all.
      const rawRoleIds = (req.body as Record<string, unknown> | undefined)
        ?.roleIds;
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
        .getCommandPermissions(session.guildId, command)
        .catch(() => null);

      try {
        if (roleIds.length === 0) {
          await permissions.clearCommandPermissions(session.guildId, command);
        } else {
          await permissions.setCommandPermissions(
            session.guildId,
            command,
            roleIds,
          );
        }
        await recordAudit(session, {
          action: "permissions.set",
          targetId: command,
          details: { before, after: roleIds },
          result: "success",
        });
        flashRedirect(res, "/admin/permissions", {
          type: "ok",
          text:
            roleIds.length === 0
              ? `Cleared restriction on /${command} (now open).`
              : `Set /${command} → ${roleIds.length} role(s).`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Set permissions failed", err);
        await recordAudit(session, {
          action: "permissions.set",
          targetId: command,
          details: { before, attempted: roleIds },
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/permissions", {
          type: "err",
          text: `Failed to update /${command}: ${text}`,
        });
      }
    }),
  );

  // ============================================================
  // Setup Wizard (issue #383)
  // ============================================================

  router.get(
    "/wizard",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const csrfToken = getCsrfFromReq(req);
      const remainingMs = getDisplayedRemainingMs(session);
      const wizard = WizardService.getInstance();
      const existing = wizard.getSession(
        session.discordUserId,
        session.guildId,
      );

      // POST /wizard/step/:n redirects here with `?flash=warn&msg=…` when
      // coercion drops fields. Surface it via the renderer.
      const flashType = String(req.query.flash ?? "");
      const flashMsg = String(req.query.msg ?? "");
      const flash =
        flashMsg &&
        (flashType === "ok" || flashType === "warn" || flashType === "err")
          ? { type: flashType as "ok" | "warn" | "err", text: flashMsg }
          : null;

      if (existing && Number(req.query.reset) !== 1) {
        const features = existing.selectedFeatures;
        const stepParam = req.query.step;

        if (typeof stepParam === "string" && stepParam === "confirm") {
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

        const step =
          stepParam !== undefined ? parseInt(String(stepParam), 10) : -1;
        if (Number.isFinite(step) && step >= 0 && step < features.length) {
          const featureKey = features[step];
          const settingKeys = WIZARD_FEATURE_SETTINGS[featureKey] ?? [];
          const config = ConfigService.getInstance();
          const currentValues: Record<string, unknown> = {};
          for (const k of settingKeys) {
            const fromWizard = wizard.getConfiguration(
              session.discordUserId,
              session.guildId,
              k,
            );
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
              flash,
            }),
          );
          return;
        }
      }

      // Step 0: feature selection. Show the current feature.enabled state
      // alongside each card so the operator knows what's already on.
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

  router.post(
    "/wizard/start",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const rawFeatures = (req.body as Record<string, unknown> | undefined)
        ?.features;
      const features: string[] = (
        Array.isArray(rawFeatures) ? rawFeatures : [rawFeatures]
      )
        .map(String)
        .filter((f) => WIZARD_FEATURE_ORDER.includes(f));

      if (features.length === 0) {
        flashRedirect(res, "/admin/wizard", {
          type: "err",
          text: "Pick at least one feature to configure.",
        });
        return;
      }

      const wizard = WizardService.getInstance();
      // `createSession` silently replaces any pre-existing session for the
      // same user/guild. Snapshot the prior state first so the audit row
      // records what was discarded — an operator restarting their own
      // wizard is fine, but an admin clobbering someone else's progress
      // needs to be traceable.
      const prior = wizard.getSession(session.discordUserId, session.guildId);
      const replacedExisting = prior !== null;
      const discardedKeys = prior ? Object.keys(prior.configuration) : [];
      wizard.createSession(session.discordUserId, session.guildId, features);
      await recordAudit(session, {
        action: "wizard.start",
        details: { features, replacedExisting, discardedKeys },
        result: "success",
      });
      res.redirect(303, "/admin/wizard?step=0");
    }),
  );

  router.post(
    "/wizard/step/:n",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const wizard = WizardService.getInstance();
      const state = wizard.getSession(session.discordUserId, session.guildId);
      if (!state) {
        flashRedirect(res, "/admin/wizard", {
          type: "warn",
          text: "Wizard session expired. Please start again.",
        });
        return;
      }

      const stepIndex = parseInt(String(req.params.n), 10);
      if (
        !Number.isFinite(stepIndex) ||
        stepIndex < 0 ||
        stepIndex >= state.selectedFeatures.length
      ) {
        flashRedirect(res, "/admin/wizard", {
          type: "err",
          text: "Invalid wizard step.",
        });
        return;
      }

      const featureKey = state.selectedFeatures[stepIndex];
      const settingKeys = WIZARD_FEATURE_SETTINGS[featureKey] ?? [];
      const saved: Record<string, unknown> = {};
      const dropped: Array<{ key: string; reason: string }> = [];
      for (const k of settingKeys) {
        const raw = (req.body as Record<string, unknown> | undefined)?.[k];
        const coerced = coerceConfigValue(k, raw);
        if (coerced.ok) {
          wizard.addConfiguration(
            session.discordUserId,
            session.guildId,
            k,
            coerced.value,
          );
          saved[k] = coerced.value;
        } else {
          // Mirror the YAML-import principle: a coercion failure must not
          // be silent. The operator gets a flash on the *next* page and the
          // audit row records the dropped keys so misconfigured form input
          // is traceable.
          dropped.push({ key: k, reason: coerced.reason });
        }
      }

      await recordAudit(session, {
        action: "wizard.step",
        details: { stepIndex, featureKey, saved, dropped },
        result: dropped.length > 0 ? "failure" : "success",
        errorMessage:
          dropped.length > 0
            ? dropped.map((d) => `${d.key}: ${d.reason}`).join("; ")
            : null,
      });

      // On any coercion failure, keep the operator on the same step so they
      // can correct the input. Otherwise advance to the next step (or the
      // confirm page if this was the last one).
      if (dropped.length > 0) {
        const msg = `${dropped.length} field${dropped.length === 1 ? "" : "s"} ignored (invalid input): ${dropped
          .map((d) => `${d.key} (${d.reason})`)
          .join(", ")}.`;
        const truncated =
          msg.length > FLASH_MAX ? `${msg.slice(0, FLASH_MAX - 1)}…` : msg;
        const qs = new globalThis.URLSearchParams({
          step: String(stepIndex),
          flash: "warn",
          msg: truncated,
        }).toString();
        res.redirect(303, `/admin/wizard?${qs}`);
        return;
      }

      const nextStep = stepIndex + 1;
      if (nextStep >= state.selectedFeatures.length) {
        res.redirect(303, "/admin/wizard?step=confirm");
      } else {
        res.redirect(303, `/admin/wizard?step=${nextStep}`);
      }
    }),
  );

  router.post(
    "/wizard/apply",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const wizard = WizardService.getInstance();
      const state = wizard.getSession(session.discordUserId, session.guildId);
      if (!state) {
        flashRedirect(res, "/admin/wizard", {
          type: "warn",
          text: "Wizard session expired. Please start again.",
        });
        return;
      }

      // The wizard treats each run as a complete declaration of which
      // features should be enabled. Anything the admin didn't tick on the
      // landing page gets its `.enabled` flag explicitly set to false here,
      // so re-running the wizard is the supported way to turn things off.
      // Without this, unchecked features would silently retain their
      // pre-existing enabled state.
      const selectedSet = new Set(state.selectedFeatures);
      for (const fk of WIZARD_FEATURE_ORDER) {
        if (selectedSet.has(fk)) continue;
        const enabledKey = (WIZARD_FEATURE_SETTINGS[fk] ?? []).find((k) =>
          k.endsWith(".enabled"),
        );
        if (!enabledKey) continue;
        wizard.addConfiguration(
          session.discordUserId,
          session.guildId,
          enabledKey,
          false,
        );
      }

      const pendingKeys = Object.keys(state.configuration);
      try {
        const applied = await wizard.applyConfiguration(
          session.discordUserId,
          session.guildId,
        );
        await recordAudit(session, {
          action: "wizard.apply",
          details: { keys: pendingKeys, count: pendingKeys.length },
          result: applied ? "success" : "failure",
          errorMessage: applied ? null : "applyConfiguration returned false",
        });
        wizard.endSession(session.discordUserId, session.guildId);
        flashRedirect(res, "/admin/settings", {
          type: applied ? "ok" : "err",
          text: applied
            ? `Wizard applied ${pendingKeys.length} setting${pendingKeys.length === 1 ? "" : "s"}.`
            : "Wizard failed to apply some settings. Check the bot logs.",
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Wizard apply failed", err);
        await recordAudit(session, {
          action: "wizard.apply",
          details: { keys: pendingKeys },
          result: "failure",
          errorMessage: text,
        });
        wizard.endSession(session.discordUserId, session.guildId);
        flashRedirect(res, "/admin/settings", {
          type: "err",
          text: `Wizard failed: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/wizard/cancel",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const wizard = WizardService.getInstance();
      const state = wizard.getSession(session.discordUserId, session.guildId);
      const discardedKeys = state ? Object.keys(state.configuration) : [];
      wizard.endSession(session.discordUserId, session.guildId);
      await recordAudit(session, {
        action: "wizard.cancel",
        details: { discardedKeys, hadSession: state !== null },
        result: "success",
      });
      flashRedirect(res, "/admin/", {
        type: "ok",
        text: "Wizard cancelled. No changes were applied.",
      });
    }),
  );

  // ============================================================
  // Announcements
  // ============================================================

  router.post(
    "/announcements/create",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const channelId = getString(req, "channelId");
      const cron = normalizeCron(getString(req, "cron"));
      const message = getString(req, "message");
      const placeholders = getCheckbox(req, "placeholders");
      const embedTitle = getString(req, "embedTitle");
      const embedDescription = getString(req, "embedDescription");
      const embedColorHex = getString(req, "embedColor");

      if (!channelId || !cron || !message) {
        flashRedirect(res, "/admin/announcements", {
          type: "err",
          text: "Channel, cron and message are all required.",
        });
        return;
      }
      if (!validCron(cron)) {
        flashRedirect(res, "/admin/announcements", {
          type: "err",
          text: `Invalid cron expression: ${cron}`,
        });
        return;
      }

      let embedData: IScheduledAnnouncement["embedData"] | undefined;
      if (embedTitle || embedDescription || embedColorHex) {
        let color: number | undefined;
        if (embedColorHex) {
          const parsed = parseHexColor(embedColorHex);
          if (parsed === null) {
            flashRedirect(res, "/admin/announcements", {
              type: "err",
              text: `Invalid hex colour: ${embedColorHex}`,
            });
            return;
          }
          color = parsed;
        }
        embedData = {
          title: embedTitle || undefined,
          description: embedDescription || undefined,
          color,
        };
      }

      const service = ScheduledAnnouncementService.getInstance(client);
      try {
        const announcement = await service.createAnnouncement({
          guildId: session.guildId,
          channelId,
          cronSchedule: cron,
          message,
          embedData,
          placeholders,
          enabled: true,
          createdBy: session.discordUserId,
        } as Omit<IScheduledAnnouncement, "createdAt" | "updatedAt">);
        await recordAudit(session, {
          action: "announcement.create",
          targetId: String(announcement._id),
          details: { channelId, cron, placeholders, hasEmbed: !!embedData },
          result: "success",
        });
        flashRedirect(res, "/admin/announcements", {
          type: "ok",
          text: `Created announcement ${announcement._id}.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        await recordAudit(session, {
          action: "announcement.create",
          details: { channelId, cron, placeholders },
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/announcements", {
          type: "err",
          text: `Failed to create announcement: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/announcements/:id/delete",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const service = ScheduledAnnouncementService.getInstance(client);
      try {
        const ok = await service.deleteAnnouncement(id, session.guildId);
        await recordAudit(session, {
          action: "announcement.delete",
          targetId: id,
          result: ok ? "success" : "failure",
          errorMessage: ok ? null : "not found or wrong guild",
        });
        flashRedirect(res, "/admin/announcements", {
          type: ok ? "ok" : "err",
          text: ok
            ? `Deleted announcement ${id}.`
            : `Announcement ${id} not found.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Delete announcement failed", err);
        await recordAudit(session, {
          action: "announcement.delete",
          targetId: id,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/announcements", {
          type: "err",
          text: `Failed to delete announcement ${id}: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/announcements/:id/toggle",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const service = ScheduledAnnouncementService.getInstance(client);
      const current = await service.getAnnouncement(id);
      if (!current || current.guildId !== session.guildId) {
        await recordAudit(session, {
          action: "announcement.toggle",
          targetId: id,
          result: "failure",
          errorMessage: "not found or wrong guild",
        });
        flashRedirect(res, "/admin/announcements", {
          type: "err",
          text: `Announcement ${id} not found.`,
        });
        return;
      }
      const updated = await service.setAnnouncementEnabled(
        id,
        !current.enabled,
        session.guildId,
      );
      const ok = updated !== null;
      await recordAudit(session, {
        action: "announcement.toggle",
        targetId: id,
        details: { enabled: !current.enabled },
        result: ok ? "success" : "failure",
      });
      flashRedirect(res, "/admin/announcements", {
        type: ok ? "ok" : "err",
        text: ok
          ? `Announcement ${id} ${!current.enabled ? "enabled" : "disabled"}.`
          : `Failed to update announcement ${id}.`,
      });
    }),
  );

  router.post(
    "/announcements/post-vc-stats",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const announcer = VoiceChannelAnnouncer.getInstance(client);
      try {
        await announcer.makeAnnouncement();
        await recordAudit(session, {
          action: "announcement.post-vc-stats",
          result: "success",
        });
        flashRedirect(res, "/admin/announcements", {
          type: "ok",
          text: "Weekly VC stats announcement triggered. Check the configured channel.",
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Manual VC stats announcement failed", err);
        await recordAudit(session, {
          action: "announcement.post-vc-stats",
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/announcements", {
          type: "err",
          text: `Failed to post: ${text}`,
        });
      }
    }),
  );

  // ============================================================
  // Polls — schedules
  // ============================================================

  router.post(
    "/polls/schedules/create",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const channelId = getString(req, "channelId");
      const cron = normalizeCron(getString(req, "cron"));
      const durationRaw = getString(req, "durationHours");
      const pingRoleId = getString(req, "pingRoleId");

      if (!channelId || !cron) {
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: "Channel and cron are required.",
        });
        return;
      }
      const duration = Number.parseInt(durationRaw, 10);
      if (!Number.isFinite(duration) || duration < 1 || duration > 768) {
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: "Duration must be an integer between 1 and 768 hours.",
        });
        return;
      }
      if (!validCron(cron)) {
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: `Invalid cron expression: ${cron}`,
        });
        return;
      }

      const service = PollService.getInstance(client);
      try {
        const schedule = await service.createSchedule({
          guildId: session.guildId,
          channelId,
          cronSchedule: cron,
          pollDuration: duration,
          roleIdToPing: pingRoleId || null,
          enabled: true,
          createdBy: session.discordUserId,
        } as Omit<IPollSchedule, "createdAt" | "updatedAt" | "lastRun">);
        await recordAudit(session, {
          action: "poll-schedule.create",
          targetId: String(schedule._id),
          details: {
            channelId,
            cron,
            durationHours: duration,
            pingRoleId: pingRoleId || null,
          },
          result: "success",
        });
        flashRedirect(res, "/admin/polls", {
          type: "ok",
          text: `Created poll schedule ${schedule._id}.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        await recordAudit(session, {
          action: "poll-schedule.create",
          details: { channelId, cron },
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: `Failed to create schedule: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/polls/schedules/:id/delete",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const service = PollService.getInstance(client);
      try {
        const ok = await service.deleteSchedule(id, session.guildId);
        await recordAudit(session, {
          action: "poll-schedule.delete",
          targetId: id,
          result: ok ? "success" : "failure",
          errorMessage: ok ? null : "not found or wrong guild",
        });
        flashRedirect(res, "/admin/polls", {
          type: ok ? "ok" : "err",
          text: ok
            ? `Deleted poll schedule ${id}.`
            : `Schedule ${id} not found.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Delete poll schedule failed", err);
        await recordAudit(session, {
          action: "poll-schedule.delete",
          targetId: id,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: `Failed to delete schedule ${id}: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/polls/schedules/:id/toggle",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const service = PollService.getInstance(client);
      const current = await service.getSchedule(id);
      if (!current || current.guildId !== session.guildId) {
        await recordAudit(session, {
          action: "poll-schedule.toggle",
          targetId: id,
          result: "failure",
          errorMessage: "not found or wrong guild",
        });
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: `Schedule ${id} not found.`,
        });
        return;
      }
      const updated = await service.setScheduleEnabled(
        id,
        !current.enabled,
        session.guildId,
      );
      const ok = updated !== null;
      await recordAudit(session, {
        action: "poll-schedule.toggle",
        targetId: id,
        details: { enabled: !current.enabled },
        result: ok ? "success" : "failure",
      });
      flashRedirect(res, "/admin/polls", {
        type: ok ? "ok" : "err",
        text: ok
          ? `Schedule ${id} ${!current.enabled ? "enabled" : "disabled"}.`
          : `Failed to update schedule ${id}.`,
      });
    }),
  );

  router.post(
    "/polls/schedules/:id/test",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const service = PollService.getInstance(client);
      const current = await service.getSchedule(id);
      if (!current || current.guildId !== session.guildId) {
        await recordAudit(session, {
          action: "poll-schedule.test",
          targetId: id,
          result: "failure",
          errorMessage: "not found or wrong guild",
        });
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: `Schedule ${id} not found.`,
        });
        return;
      }
      try {
        await service.testSchedule(id);
        await recordAudit(session, {
          action: "poll-schedule.test",
          targetId: id,
          result: "success",
        });
        flashRedirect(res, "/admin/polls", {
          type: "ok",
          text: `Test poll posted from schedule ${id}. Check the configured channel.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        await recordAudit(session, {
          action: "poll-schedule.test",
          targetId: id,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: `Test failed: ${text}`,
        });
      }
    }),
  );

  // ============================================================
  // Polls — question library
  // ============================================================

  router.post(
    "/polls/items/create",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const question = getString(req, "question");
      const answersStr = getString(req, "answers");
      const tagsStr = getString(req, "tags");
      const multiSelect = getCheckbox(req, "multiSelect");

      if (!question) {
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: "Question is required.",
        });
        return;
      }
      if (question.length > 300) {
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: "Question must be 300 characters or fewer.",
        });
        return;
      }
      const answers = answersStr
        .split(",")
        .map((a) => a.trim())
        .filter((a) => a.length > 0);
      if (answers.length < 2 || answers.length > 10) {
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: "Provide 2–10 comma-separated answers.",
        });
        return;
      }
      const tags = tagsStr
        ? tagsStr
            .split(",")
            .map((t) => t.trim())
            .filter((t) => t.length > 0)
        : [];

      const service = PollService.getInstance(client);
      try {
        const item = await service.createPollItem({
          guildId: session.guildId,
          question,
          answers,
          multiSelect,
          tags,
          enabled: true,
          createdBy: session.discordUserId,
          source: "manual",
        } as Omit<
          IPollItem,
          "createdAt" | "updatedAt" | "usageCount" | "lastUsed"
        >);
        await recordAudit(session, {
          action: "poll-item.create",
          targetId: String(item._id),
          details: {
            answerCount: answers.length,
            multiSelect,
            tagCount: tags.length,
          },
          result: "success",
        });
        flashRedirect(res, "/admin/polls", {
          type: "ok",
          text: `Added poll question ${item._id}.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        await recordAudit(session, {
          action: "poll-item.create",
          details: { answerCount: answers.length },
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: `Failed to add question: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/polls/items/:id/delete",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const service = PollService.getInstance(client);
      try {
        const ok = await service.deletePollItem(id, session.guildId);
        await recordAudit(session, {
          action: "poll-item.delete",
          targetId: id,
          result: ok ? "success" : "failure",
          errorMessage: ok ? null : "not found or wrong guild",
        });
        flashRedirect(res, "/admin/polls", {
          type: ok ? "ok" : "err",
          text: ok
            ? `Deleted poll question ${id}.`
            : `Question ${id} not found.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Delete poll item failed", err);
        await recordAudit(session, {
          action: "poll-item.delete",
          targetId: id,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: `Failed to delete question ${id}: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/polls/items/:id/toggle",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const service = PollService.getInstance(client);
      const items = await service.listPollItems(session.guildId);
      const current = items.find((it) => String(it._id) === id);
      if (!current) {
        await recordAudit(session, {
          action: "poll-item.toggle",
          targetId: id,
          result: "failure",
          errorMessage: "not found or wrong guild",
        });
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: `Question ${id} not found.`,
        });
        return;
      }
      const updated = await service.setPollItemEnabled(
        id,
        !current.enabled,
        session.guildId,
      );
      const ok = updated !== null;
      await recordAudit(session, {
        action: "poll-item.toggle",
        targetId: id,
        details: { enabled: !current.enabled },
        result: ok ? "success" : "failure",
      });
      flashRedirect(res, "/admin/polls", {
        type: ok ? "ok" : "err",
        text: ok
          ? `Question ${id} ${!current.enabled ? "enabled" : "disabled"}.`
          : `Failed to update question ${id}.`,
      });
    }),
  );

  router.post(
    "/polls/items/import",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const url = getString(req, "url");
      if (!url) {
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: "URL is required.",
        });
        return;
      }
      const service = PollService.getInstance(client);
      try {
        const results = await service.importFromUrl(
          url,
          session.guildId,
          session.discordUserId,
        );
        const errCount = results.errors.length;
        const type: Flash["type"] =
          results.imported > 0 && errCount === 0
            ? "ok"
            : results.imported > 0
              ? "warn"
              : "err";
        const summary = `Imported ${results.imported}, skipped ${results.skipped}, errors ${errCount}.`;
        const firstError =
          errCount > 0 ? ` First error: ${results.errors[0]}` : "";
        await recordAudit(session, {
          action: "poll-item.import",
          details: {
            url,
            imported: results.imported,
            skipped: results.skipped,
            errors: errCount,
          },
          result:
            errCount > 0 && results.imported === 0 ? "failure" : "success",
          errorMessage:
            errCount > 0 ? results.errors.slice(0, 5).join("; ") : null,
        });
        flashRedirect(res, "/admin/polls", {
          type,
          text: `${summary}${firstError}`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Poll import failed", err);
        await recordAudit(session, {
          action: "poll-item.import",
          details: { url },
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: `Import failed: ${text}`,
        });
      }
    }),
  );

  // ============================================================
  // Reaction Roles (issue #384)
  // ============================================================

  router.post(
    "/reaction-roles/create",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const name = getString(req, "name");
      const emoji = getString(req, "emoji");

      if (!name || !emoji) {
        flashRedirect(res, "/admin/reaction-roles", {
          type: "err",
          text: "Role name and emoji are both required.",
        });
        return;
      }
      // Discord caps role names at 100 chars. Validate here so we surface a
      // clean flash instead of letting the Discord API reject the create
      // mid-rollback.
      if (name.length > 100) {
        flashRedirect(res, "/admin/reaction-roles", {
          type: "err",
          text: "Role name must be 100 characters or fewer.",
        });
        return;
      }
      // Emoji input is either a single Unicode codepoint cluster or a custom
      // emoji markup like `<:name:id>` / `<a:name:id>`. 100 chars is well past
      // any legitimate input and matches the form's `maxlength`.
      if (emoji.length > 100) {
        flashRedirect(res, "/admin/reaction-roles", {
          type: "err",
          text: "Emoji input must be 100 characters or fewer.",
        });
        return;
      }

      const service = ReactionRoleService.getInstance(client);
      try {
        const result = await service.createReactionRole(
          session.guildId,
          name,
          emoji,
        );
        await recordAudit(session, {
          action: "reactionrole.create",
          targetId: result.roleId ?? null,
          details: {
            roleName: name,
            emoji,
            categoryId: result.categoryId,
            channelId: result.channelId,
            messageId: result.messageId,
          },
          result: result.success ? "success" : "failure",
          errorMessage: result.success ? null : result.message,
        });
        flashRedirect(res, "/admin/reaction-roles", {
          type: result.success ? "ok" : "err",
          text: result.message,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Create reaction role failed", err);
        await recordAudit(session, {
          action: "reactionrole.create",
          details: { roleName: name, emoji },
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/reaction-roles", {
          type: "err",
          text: `Failed to create reaction role: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/reaction-roles/archive",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const roleName = getString(req, "roleName");
      if (!roleName) {
        flashRedirect(res, "/admin/reaction-roles", {
          type: "err",
          text: "Role name is required.",
        });
        return;
      }
      const service = ReactionRoleService.getInstance(client);
      try {
        const result = await service.archiveReactionRole(
          session.guildId,
          roleName,
        );
        await recordAudit(session, {
          action: "reactionrole.archive",
          targetId: roleName,
          details: { roleName },
          result: result.success ? "success" : "failure",
          errorMessage: result.success ? null : result.message,
        });
        flashRedirect(res, "/admin/reaction-roles", {
          type: result.success ? "ok" : "err",
          text: result.message,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Archive reaction role failed", err);
        await recordAudit(session, {
          action: "reactionrole.archive",
          targetId: roleName,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/reaction-roles", {
          type: "err",
          text: `Failed to archive ${roleName}: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/reaction-roles/unarchive",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const roleName = getString(req, "roleName");
      if (!roleName) {
        flashRedirect(res, "/admin/reaction-roles", {
          type: "err",
          text: "Role name is required.",
        });
        return;
      }
      const service = ReactionRoleService.getInstance(client);
      try {
        const result = await service.unarchiveReactionRole(
          session.guildId,
          roleName,
        );
        await recordAudit(session, {
          action: "reactionrole.unarchive",
          targetId: roleName,
          details: { roleName },
          result: result.success ? "success" : "failure",
          errorMessage: result.success ? null : result.message,
        });
        flashRedirect(res, "/admin/reaction-roles", {
          type: result.success ? "ok" : "err",
          text: result.message,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Unarchive reaction role failed", err);
        await recordAudit(session, {
          action: "reactionrole.unarchive",
          targetId: roleName,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/reaction-roles", {
          type: "err",
          text: `Failed to unarchive ${roleName}: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/reaction-roles/delete",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const roleName = getString(req, "roleName");
      if (!roleName) {
        flashRedirect(res, "/admin/reaction-roles", {
          type: "err",
          text: "Role name is required.",
        });
        return;
      }
      const service = ReactionRoleService.getInstance(client);
      try {
        const result = await service.deleteReactionRole(
          session.guildId,
          roleName,
        );
        await recordAudit(session, {
          action: "reactionrole.delete",
          targetId: roleName,
          details: { roleName },
          result: result.success ? "success" : "failure",
          errorMessage: result.success ? null : result.message,
        });
        flashRedirect(res, "/admin/reaction-roles", {
          type: result.success ? "ok" : "err",
          text: result.message,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Delete reaction role failed", err);
        await recordAudit(session, {
          action: "reactionrole.delete",
          targetId: roleName,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/reaction-roles", {
          type: "err",
          text: `Failed to delete ${roleName}: ${text}`,
        });
      }
    }),
  );

  // ============================================================
  // Notices (issue #384)
  // ============================================================

  const NOTICE_CATEGORY_KEYS = new Set(Object.keys(NOTICE_CATEGORIES));

  router.post(
    "/notices/create",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const title = getString(req, "title");
      const content = getString(req, "content");
      const category = getString(req, "category");
      const orderRaw = getString(req, "order");

      if (!title || !content || !category) {
        flashRedirect(res, "/admin/notices", {
          type: "err",
          text: "Title, content, and category are all required.",
        });
        return;
      }
      if (title.length > 256) {
        flashRedirect(res, "/admin/notices", {
          type: "err",
          text: "Title must be 256 characters or fewer.",
        });
        return;
      }
      if (content.length > 4000) {
        flashRedirect(res, "/admin/notices", {
          type: "err",
          text: "Content must be 4000 characters or fewer.",
        });
        return;
      }
      if (!NOTICE_CATEGORY_KEYS.has(category)) {
        flashRedirect(res, "/admin/notices", {
          type: "err",
          text: `Unknown category: ${category}.`,
        });
        return;
      }
      const order = parseIntInRange(orderRaw || "0", -1000, 10000);
      if (order === null) {
        flashRedirect(res, "/admin/notices", {
          type: "err",
          text: "Order must be an integer between -1000 and 10000.",
        });
        return;
      }

      try {
        const enabled = await ConfigService.getInstance().getBoolean(
          "notices.enabled",
          false,
        );
        const notice = await new Notice({
          title,
          content,
          category,
          order,
          createdBy: session.discordUserId,
        }).save();

        let postedMessageId: string | null = null;
        if (enabled) {
          const manager = NoticesChannelManager.getInstance(client);
          postedMessageId = await manager.postNotice(notice);
          if (postedMessageId) {
            notice.messageId = postedMessageId;
            await notice.save();
          }
        }

        await recordAudit(session, {
          action: "notice.create",
          targetId: String(notice._id),
          details: {
            title,
            category,
            order,
            posted: postedMessageId !== null,
            featureEnabled: enabled,
          },
          result: "success",
        });
        let flashType: Flash["type"] = "ok";
        let flashText: string;
        if (!enabled) {
          flashText = `Created notice ${notice._id}. Enable notices.enabled to post it to a channel.`;
        } else if (postedMessageId !== null) {
          flashText = `Created notice ${notice._id} and posted to channel.`;
        } else {
          flashType = "warn";
          flashText = `Created notice ${notice._id} but the channel post failed. Check the bot's logs and use Resync to retry.`;
        }
        flashRedirect(res, "/admin/notices", {
          type: flashType,
          text: flashText,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Create notice failed", err);
        await recordAudit(session, {
          action: "notice.create",
          details: { title, category, order },
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/notices", {
          type: "err",
          text: `Failed to create notice: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/notices/:id/update",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const title = getString(req, "title");
      const content = getString(req, "content");
      const category = getString(req, "category");
      const orderRaw = getString(req, "order");

      if (!title || !content || !category) {
        flashRedirect(res, "/admin/notices", {
          type: "err",
          text: "Title, content, and category are all required.",
        });
        return;
      }
      if (!NOTICE_CATEGORY_KEYS.has(category)) {
        flashRedirect(res, "/admin/notices", {
          type: "err",
          text: `Unknown category: ${category}.`,
        });
        return;
      }
      const order = parseIntInRange(orderRaw, -1000, 10000);
      if (order === null) {
        flashRedirect(res, "/admin/notices", {
          type: "err",
          text: "Order must be an integer between -1000 and 10000.",
        });
        return;
      }

      try {
        const notice = await Notice.findById(id);
        if (!notice) {
          await recordAudit(session, {
            action: "notice.update",
            targetId: id,
            result: "failure",
            errorMessage: "not found",
          });
          flashRedirect(res, "/admin/notices", {
            type: "err",
            text: `Notice ${id} not found.`,
          });
          return;
        }

        notice.title = title;
        notice.content = content;
        notice.category = category;
        notice.order = order;
        await notice.save();

        const enabled = await ConfigService.getInstance().getBoolean(
          "notices.enabled",
          false,
        );
        // `postNotice()` catches its own errors and returns null on failure.
        // Track the actual outcome so the audit/flash don't lie about a repost.
        let repostAttempted = false;
        let repostSucceeded = false;
        if (enabled) {
          repostAttempted = true;
          const manager = NoticesChannelManager.getInstance(client);
          if (notice.messageId) {
            await manager.deleteNoticeMessage(notice.messageId);
          }
          const newMessageId = await manager.postNotice(notice);
          if (newMessageId) {
            notice.messageId = newMessageId;
            repostSucceeded = true;
          } else {
            // We deleted (or tried to delete) the old message but couldn't
            // post a replacement. Clear the now-stale messageId so the next
            // sync doesn't try to delete a message that no longer exists.
            notice.messageId = undefined;
          }
          await notice.save();
        }

        await recordAudit(session, {
          action: "notice.update",
          targetId: id,
          details: {
            title,
            category,
            order,
            repostAttempted,
            repostSucceeded,
          },
          result: "success",
        });
        if (repostAttempted && !repostSucceeded) {
          flashRedirect(res, "/admin/notices", {
            type: "warn",
            text: `Updated notice ${id} but the channel post failed. Use Resync to retry.`,
          });
          return;
        }
        flashRedirect(res, "/admin/notices", {
          type: "ok",
          text: `Updated notice ${id}.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Update notice failed", err);
        await recordAudit(session, {
          action: "notice.update",
          targetId: id,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/notices", {
          type: "err",
          text: `Failed to update notice ${id}: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/notices/:id/order",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const orderRaw = getString(req, "order");
      const order = parseIntInRange(orderRaw, -1000, 10000);
      if (order === null) {
        flashRedirect(res, "/admin/notices", {
          type: "err",
          text: "Order must be an integer between -1000 and 10000.",
        });
        return;
      }
      try {
        const notice = await Notice.findById(id);
        if (!notice) {
          await recordAudit(session, {
            action: "notice.reorder",
            targetId: id,
            result: "failure",
            errorMessage: "not found",
          });
          flashRedirect(res, "/admin/notices", {
            type: "err",
            text: `Notice ${id} not found.`,
          });
          return;
        }
        const previous = notice.order;
        notice.order = order;
        await notice.save();
        await recordAudit(session, {
          action: "notice.reorder",
          targetId: id,
          details: { from: previous, to: order, category: notice.category },
          result: "success",
        });
        flashRedirect(res, "/admin/notices", {
          type: "ok",
          text: `Reordered notice ${id}: ${previous} → ${order}. Resync to refresh channel order.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Reorder notice failed", err);
        await recordAudit(session, {
          action: "notice.reorder",
          targetId: id,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/notices", {
          type: "err",
          text: `Failed to reorder notice ${id}: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/notices/:id/delete",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      try {
        const notice = await Notice.findById(id);
        if (!notice) {
          await recordAudit(session, {
            action: "notice.delete",
            targetId: id,
            result: "failure",
            errorMessage: "not found",
          });
          flashRedirect(res, "/admin/notices", {
            type: "err",
            text: `Notice ${id} not found.`,
          });
          return;
        }
        const manager = NoticesChannelManager.getInstance(client);
        if (notice.messageId) {
          await manager.deleteNoticeMessage(notice.messageId);
        }
        await Notice.findByIdAndDelete(id);
        await recordAudit(session, {
          action: "notice.delete",
          targetId: id,
          details: { title: notice.title, category: notice.category },
          result: "success",
        });
        flashRedirect(res, "/admin/notices", {
          type: "ok",
          text: `Deleted notice ${id}.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Delete notice failed", err);
        await recordAudit(session, {
          action: "notice.delete",
          targetId: id,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/notices", {
          type: "err",
          text: `Failed to delete notice ${id}: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/notices/sync",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      try {
        const manager = NoticesChannelManager.getInstance(client);
        await manager.syncNotices();
        const count = await Notice.countDocuments();
        await recordAudit(session, {
          action: "notice.sync",
          details: { count },
          result: "success",
        });
        flashRedirect(res, "/admin/notices", {
          type: "ok",
          text: `Synced ${count} notices to channel.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Notice sync failed", err);
        await recordAudit(session, {
          action: "notice.sync",
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/notices", {
          type: "err",
          text: `Failed to sync notices: ${text}`,
        });
      }
    }),
  );

  // ============================================================
  // Database — dbtrunk (issue #384)
  // ============================================================

  router.post(
    "/database/run-cleanup",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const service = VoiceChannelTruncationService.getInstance(client);
      try {
        const stats = await service.runCleanup();
        const skipped = stats.skipped === true;
        const hasErrors = stats.errors.length > 0 && !skipped;
        await recordAudit(session, {
          action: "dbtrunk.run",
          details: {
            sessionsRemoved: stats.sessionsRemoved,
            dataAggregated: stats.dataAggregated,
            executionTime: stats.executionTime,
            errors: hasErrors ? stats.errors.length : 0,
            skipped,
          },
          result: hasErrors ? "failure" : "success",
          errorMessage: hasErrors ? stats.errors.slice(0, 3).join("; ") : null,
        });
        if (skipped) {
          flashRedirect(res, "/admin/database", {
            type: "warn",
            text: "Cleanup skipped: 24-hour minimum interval not met since the last run.",
          });
          return;
        }
        if (hasErrors) {
          flashRedirect(res, "/admin/database", {
            type: "err",
            text: `Cleanup finished with errors: ${stats.errors.slice(0, 3).join("; ")}`,
          });
          return;
        }
        flashRedirect(res, "/admin/database", {
          type: "ok",
          text: `Cleanup complete. Removed ${stats.sessionsRemoved} sessions across ${stats.dataAggregated} users in ${stats.executionTime}ms.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("dbtrunk run failed", err);
        await recordAudit(session, {
          action: "dbtrunk.run",
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/database", {
          type: "err",
          text: `Cleanup failed: ${text}`,
        });
      }
    }),
  );

  // ============================================================
  // Voice Channels (issue #384)
  // ============================================================

  router.post(
    "/voice-channels/reload",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const manager = VoiceChannelManager.getInstance(client);
      try {
        await manager.cleanupEmptyChannels();
        await recordAudit(session, {
          action: "voicechannels.reload",
          result: "success",
        });
        flashRedirect(res, "/admin/voice-channels", {
          type: "ok",
          text: "Cleaned up empty voice channels.",
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("VC reload failed", err);
        await recordAudit(session, {
          action: "voicechannels.reload",
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/voice-channels", {
          type: "err",
          text: `Cleanup failed: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/voice-channels/force-reload",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const manager = VoiceChannelManager.getInstance(client);
      try {
        await manager.cleanupEmptyChannels();
        const guild = await client.guilds.fetch(session.guildId);
        await manager.ensureLobbyChannels(guild);
        await recordAudit(session, {
          action: "voicechannels.force-reload",
          result: "success",
        });
        flashRedirect(res, "/admin/voice-channels", {
          type: "ok",
          text: "Force cleanup complete. Unmanaged channels removed and lobby channels ensured.",
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("VC force-reload failed", err);
        await recordAudit(session, {
          action: "voicechannels.force-reload",
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/voice-channels", {
          type: "err",
          text: `Force cleanup failed: ${text}`,
        });
      }
    }),
  );

  return router;
}
