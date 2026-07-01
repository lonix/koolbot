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
import { DigestService } from "../services/digest-service.js";
import { ConfigService } from "../services/config-service.js";
import { PermissionsService } from "../services/permissions-service.js";
import { WizardService } from "../services/wizard-service.js";
import { BotStatusService } from "../services/bot-status-service.js";
import { CommandManager } from "../services/command-manager.js";
import {
  defaultConfig,
  settingsMetadata,
  getDependencies,
  isEnabledValue,
} from "../services/config-schema.js";
import type { IScheduledAnnouncement } from "../models/scheduled-announcement.js";
import type { IPollSchedule } from "../models/poll-schedule.js";
import type { IPollItem } from "../models/poll-item.js";
import Notice from "../models/notice.js";
import { NOTICE_CATEGORIES } from "../content/notice-categories.js";
import type { HydratedDocument } from "mongoose";
import {
  BotStatusMessage,
  type IBotStatusMessage,
} from "../models/bot-status-message.js";
import {
  isBotStatusPool,
  validateStatusEntry,
  STATUS_POOL_DEFAULTS,
  type BotStatusPool,
} from "../content/statuses.js";
import { requireCsrf } from "./csrf.js";
import { FLASH_MAX, truncateFlash, wantsJson } from "./http-flash.js";
// Re-exported so existing callers/tests can keep importing these from the
// write router; the canonical home is `./http-flash.js` (issue #612).
export { truncateFlash, wantsJson };
import { PROTECTED_KEYS } from "./bootstrap-vars.js";
import {
  requireAdminRoleMiddleware,
  type AuthenticatedRequest,
} from "./session.js";
import { recordAudit } from "./audit.js";
import {
  resolveEmojiShortcodes,
  findUnknownShortcodes,
} from "../utils/emoji-shortcodes.js";
import {
  getDisplayedRemainingMs,
  resolveNavFeatureStatus,
  NAV_ITEMS,
} from "./admin-layout.js";
import {
  renderImportDiffPage,
  renderWizardPage,
  renderWizardStepPage,
  renderWizardConfirmPage,
  settingValueFieldName,
  type ImportDiffRow,
} from "./admin-views.js";
import { fetchChannelData, fetchRoleData } from "./read-only-routes.js";

type Flash = { type: "ok" | "warn" | "err"; text: string };

/**
 * Maximum lengths for user-supplied free text (issue #508). Each cap is
 * derived from the real-world constraint the value eventually hits — a
 * Discord embed/message/poll limit, or a sane ceiling for a stored setting.
 * Server-side validation uses these so an oversized payload is rejected with
 * a clean flash *before* it reaches MongoDB or the Discord API, rather than
 * surfacing later as an opaque Mongoose `ValidationError` (formatted as a 500)
 * or a silent Discord rejection at send time. The matching schema `maxlength`
 * constraints are defence-in-depth for non-route writers.
 */
export const TEXT_LIMITS = {
  /** Discord embed title cap — notice titles render as the embed title. */
  noticeTitle: 256,
  /** Discord embed description (body) cap — notices render as embeds. */
  noticeContent: 4000,
  /** Discord message content cap. */
  announcementMessage: 2000,
  /** Discord embed title cap. */
  embedTitle: 256,
  /** Discord embed description cap. */
  embedDescription: 4000,
  /** Discord poll question cap. */
  pollQuestion: 300,
  /** Discord poll answer (option) cap. */
  pollAnswer: 55,
  /** Ceiling for any single free-text setting value. */
  configValue: 2000,
} as const;

/**
 * Validate a labelled set of strings against their maximum lengths. Returns a
 * human-readable error for the first field that exceeds its cap, or null when
 * everything fits. Pure and exported so the route-layer length checks can be
 * unit-tested without Express or Mongo.
 */
export function firstLengthError(
  fields: Array<{ label: string; value: string; max: number }>,
): string | null {
  for (const { label, value, max } of fields) {
    if (value.length > max) {
      return `${label} must be ${max} characters or fewer.`;
    }
  }
  return null;
}

function flashRedirect(res: Response, path: string, flash: Flash): void {
  // Mirror the renderer's 500-char cap on the way out so the redirect
  // URL itself can't balloon to header/URI limits on a noisy failure.
  const qs = new globalThis.URLSearchParams({
    flash: flash.type,
    msg: truncateFlash(flash.text),
  }).toString();
  res.redirect(303, `${path}?${qs}`);
}

/**
 * Reply to a section-save with either an inline JSON flash (AJAX) or the
 * legacy 303 redirect (no-JS). Always returns the same 500-char-capped flash
 * the renderer would show, so both paths surface identical messages.
 */
function respondSectionFlash(
  req: AuthenticatedRequest,
  res: Response,
  flash: Flash,
  redirectTo = "/admin/settings",
): void {
  if (wantsJson(req)) {
    res.status(200).json({ type: flash.type, text: truncateFlash(flash.text) });
    return;
  }
  flashRedirect(res, redirectTo, flash);
}

function getString(req: AuthenticatedRequest, name: string): string {
  const raw = (req.body as Record<string, unknown> | undefined)?.[name];
  if (typeof raw !== "string") return "";
  return raw.trim();
}

/**
 * Allowlisted post-action redirect targets (#610). The feature pages render an
 * inline "Enable <feature>" form that POSTs to /admin/settings/set with a
 * `redirect` field so the operator lands back on the page they enabled rather
 * than on /admin/settings. Restricting the target to known nav hrefs closes
 * the open-redirect door — an unrecognised value falls back to the Settings
 * page that this route has always returned to.
 */
const ADMIN_REDIRECT_ALLOWLIST = new Set<string>(
  NAV_ITEMS.map((item) => item.href),
);

export function safeAdminRedirect(raw: string): string {
  return ADMIN_REDIRECT_ALLOWLIST.has(raw) ? raw : "/admin/settings";
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

/**
 * Parse a pasted string-array import (issue #557). Accepts either a JSON
 * array of strings or a plain newline-separated list. Entries are trimmed
 * and blank lines dropped. Exported so the parsing is unit-testable apart
 * from Express.
 */
export function parseStringListImport(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((v): v is string => typeof v === "string")
          .map((v) => v.trim())
          .filter((v) => v.length > 0);
      }
    } catch {
      // Fall through to newline parsing on malformed JSON.
    }
  }
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function requireSessionContext(
  req: AuthenticatedRequest,
): AuthenticatedRequest["webSession"] & object {
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
 * Settings shown per wizard feature. Key order determines form order.
 * Each list must reference real keys in `defaultConfig` — unknown keys
 * are silently dropped at apply.
 */
const WIZARD_FEATURE_SETTINGS: Record<string, string[]> = {
  voicechannels: [
    "voicechannels.enabled",
    "voicechannels.category_id",
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
 * Config keys whose string value is set directly as a Discord channel name
 * (or part of one). For these, `:shortcode:` emoji are resolved to Unicode at
 * the write boundary (issue #558) so admins can type `:green_circle:` and get
 * 🟢 in the channel name. Other free-text keys (headers, message templates,
 * etc.) are left verbatim — a stray `:colon:` there is not necessarily an
 * emoji, and Discord renders shortcodes itself inside message content.
 */
export const EMOJI_NAME_KEYS: ReadonlySet<string> = new Set([
  "voicechannels.lobby.name",
  "voicechannels.lobby.offlinename",
  "voicechannels.channel.prefix",
  "voicechannels.channel.suffix",
]);

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

  // Array payloads only make sense for the multi-select Discord-entity
  // types (channel_list / role_list). For every other key shape, an
  // array means something is wrong upstream — a misconfigured YAML
  // import, a crafted form post, or JS coercion silently flattening a
  // one-element array into a scalar (e.g. `Number([42]) === 42`).
  // Reject loudly here so the failure surfaces in the import preview /
  // audit log instead of being silently swallowed.
  if (Array.isArray(raw)) {
    const metaType =
      settingsMetadata[key as keyof typeof settingsMetadata]?.type;
    if (metaType !== "channel_list" && metaType !== "role_list") {
      return {
        ok: false,
        reason: "invalid shape (array provided for non-list key)",
      };
    }
    const csv = raw
      .filter((v): v is string => typeof v === "string" && v !== "")
      .join(",");
    return { ok: true, value: csv };
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
  let value = String(raw ?? "");
  // Emoji shortcode resolution (#558). For the name-style keys that feed
  // Discord channel names, convert any recognised `:shortcode:` (e.g.
  // `:green_circle:`) to its Unicode codepoint at the write boundary, so the
  // DB stores 🟢 and every downstream name-construction site "just works"
  // without a per-call-site transform. Unknown shortcodes pass through
  // untouched. Done before the length cap so the resolved (shorter) form is
  // what gets measured and stored.
  if (EMOJI_NAME_KEYS.has(key)) {
    value = resolveEmojiShortcodes(value);
  }
  // Cap free-text setting values so an oversized string can't be stored and
  // then overflow the Settings display or a downstream Discord payload (#508).
  // List keys are handled in the array branch above and are bounded by their
  // entity IDs, so the cap only applies to scalar string values here.
  if (value.length > TEXT_LIMITS.configValue) {
    return {
      ok: false,
      reason: `too long (max ${TEXT_LIMITS.configValue} characters)`,
    };
  }
  // Fixed-options keys carry an `options` whitelist in their metadata. Any
  // value outside it (mistyped form field, crafted POST, stale YAML import)
  // is refused with a clear, enumerated error rather than silently stored.
  const options =
    settingsMetadata[key as keyof typeof settingsMetadata]?.options;
  if (options && !options.some((o) => o.value === value)) {
    return {
      ok: false,
      reason: `invalid option (must be one of: ${options
        .map((o) => o.value)
        .join(", ")})`,
    };
  }
  return { ok: true, value };
}

/**
 * Pick the cascade "master" toggle for a Settings section: the boolean
 * `.enabled` key with the fewest dotted segments among the submitted keys
 * (the top-level feature switch). Mirrors `findCascadeMasterKey` in
 * admin-views so the server skips the same dependents the client greyed out
 * (issue #485). Returns null when the section has no boolean `.enabled` key.
 */
export function findSectionMasterKey(keys: string[]): string | null {
  let master: string | null = null;
  for (const key of keys) {
    if (!key.endsWith(".enabled")) continue;
    if (typeof defaultConfig[key as keyof typeof defaultConfig] !== "boolean") {
      continue;
    }
    if (master === null || key.split(".").length < master.split(".").length) {
      master = key;
    }
  }
  return master;
}

function getCsrfFromReq(req: AuthenticatedRequest): string {
  return (req as Request & { csrfToken?: string }).csrfToken ?? "";
}

/**
 * Minimal config-store surface the bulk reset needs. `ConfigService`
 * satisfies it structurally; the narrow shape keeps the reset logic
 * unit-testable against a fake store without Express or Mongo.
 */
export interface ResetConfigStore {
  getAll(): Promise<Array<{ key: string }>>;
  set(
    key: string,
    value: unknown,
    description: string,
    category: string,
    options?: { skipDependencyCheck?: boolean },
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Reset the live config back to `defaultConfig`:
 *   - every key in the schema is rewritten to its default value;
 *   - orphan DB rows (keys no longer in the schema) are deleted.
 *
 * Protected bootstrap keys never live in the `configs` collection, but are
 * skipped on the delete pass defensively so a stray row can't be dropped
 * here. Mirrors the partial-application semantics of the YAML import: a
 * write/delete that throws is collected in `failed` and the rest continue.
 */
export async function resetConfigToDefaults(config: ResetConfigStore): Promise<{
  updated: number;
  deleted: number;
  failed: Array<{ key: string; reason: string }>;
}> {
  const all = await config.getAll();
  const failed: Array<{ key: string; reason: string }> = [];

  let updated = 0;
  for (const [key, value] of Object.entries(defaultConfig)) {
    const meta = settingsMetadata[key as keyof typeof settingsMetadata];
    try {
      // Reset rewrites the whole schema to its defaults; per-key dependency
      // validation would spuriously reject intermediate states (e.g. clearing
      // voicetracking.enabled before a dependent's default lands). The default
      // set is internally consistent, so skip the check.
      await config.set(
        key,
        value,
        meta?.description ?? "",
        meta?.category ?? key.split(".")[0],
        { skipDependencyCheck: true },
      );
      updated++;
    } catch (err) {
      const reason = err instanceof Error ? err.message : "set failed";
      logger.error("reset-defaults: failed to write setting", err);
      failed.push({ key, reason });
    }
  }

  let deleted = 0;
  for (const entry of all) {
    if (entry.key in defaultConfig) continue;
    if (PROTECTED_KEYS.has(entry.key)) continue;
    try {
      await config.delete(entry.key);
      deleted++;
    } catch (err) {
      const reason = err instanceof Error ? err.message : "delete failed";
      logger.error("reset-defaults: failed to delete orphan key", err);
      failed.push({ key: entry.key, reason });
    }
  }

  return { updated, deleted, failed };
}

/**
 * Enabled-state of feature-gated nav items for the pages rendered by the
 * write router (wizard steps, import preview). Keeps their sidebar
 * consistent with the read-only pages.
 */
function navStatusForPage(): ReturnType<typeof resolveNavFeatureStatus> {
  const config = ConfigService.getInstance();
  return resolveNavFeatureStatus((key) => config.getBoolean(key, false));
}

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

  // ============================================================
  // Settings — single-key set/reset + reload (issue #383)
  // ============================================================

  router.post(
    "/settings/set",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const key = getString(req, "key");
      const raw = (req.body as Record<string, unknown> | undefined)?.value;
      // Where to land after the write. Defaults to /admin/settings (this
      // route's historical target); the feature pages' inline "Enable"
      // action passes their own page so the operator returns there (#610).
      const redirectTo = safeAdminRedirect(getString(req, "redirect"));

      const coerced = coerceConfigValue(key, raw);
      if (!coerced.ok) {
        await recordAudit(session, {
          action: "setting.set",
          targetId: key || null,
          details: { reason: coerced.reason },
          result: "failure",
          errorMessage: coerced.reason,
        });
        flashRedirect(res, redirectTo, {
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
        // For the channel-name keys, surface any `:shortcode:` that wasn't
        // recognised so the admin learns it stayed as literal text rather
        // than silently wondering why their emoji didn't appear (#558). The
        // resolved value is already echoed back in the message above.
        const unknown = EMOJI_NAME_KEYS.has(key)
          ? findUnknownShortcodes(coerced.value)
          : [];
        const hint =
          unknown.length > 0
            ? ` Note: ${unknown.join(", ")} ${unknown.length === 1 ? "is not a" : "are not"} recognised emoji shortcode${unknown.length === 1 ? "" : "s"} (kept as typed; custom server emoji can't appear in channel names).`
            : "";
        flashRedirect(res, redirectTo, {
          type: unknown.length > 0 ? "warn" : "ok",
          text: `Set ${key} = ${String(coerced.value)}.${hint}`,
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
        flashRedirect(res, redirectTo, {
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
      // Feature pages that reuse the settings controls (e.g. Voice Channels,
      // #705) pass their own page so a per-key Reset lands back where it was
      // clicked; allowlisted the same way as /settings/set and save-section.
      const redirectTo = safeAdminRedirect(getString(req, "redirect"));
      if (!(key in defaultConfig)) {
        await recordAudit(session, {
          action: "setting.reset",
          targetId: key || null,
          result: "failure",
          errorMessage: "unknown key",
        });
        flashRedirect(res, redirectTo, {
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
        flashRedirect(res, redirectTo, {
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
        flashRedirect(res, redirectTo, {
          type: "err",
          text: `Failed to reset ${key}: ${text}`,
        });
      }
    }),
  );

  // Reset every setting to its schema default (issue #487). Two-step
  // confirm: the page guards the click with a JS confirm() and requires the
  // operator to type the guild name (the form field re-validated below).
  router.post(
    "/settings/reset-defaults",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const body = (req.body as Record<string, unknown> | undefined) ?? {};

      // Defence-in-depth: this endpoint takes no per-key payload, but a
      // crafted request that smuggles a protected bootstrap key (Discord
      // token, Mongo URI, WebUI session config) is refused outright — those
      // keys must never be touched by a settings reset.
      const protectedHit = Object.keys(body).find((k) => PROTECTED_KEYS.has(k));
      if (protectedHit) {
        await recordAudit(session, {
          action: "settings.reset-defaults",
          result: "failure",
          errorMessage: "protected key in payload",
          details: { protectedKey: protectedHit },
        });
        flashRedirect(res, "/admin/settings", {
          type: "err",
          text: "Reset refused: request contained a protected bootstrap key.",
        });
        return;
      }

      // The operator must type the guild name (falling back to the guild id
      // when Discord can't be reached) to commit. Accept either so a fetch
      // failure between render and submit can't lock the operator out.
      let guildName: string | null = null;
      try {
        const guild = await client.guilds.fetch(session.guildId);
        guildName = guild.name;
      } catch (err) {
        logger.debug("reset-defaults guild fetch failed", err);
      }
      const expected = guildName ?? session.guildId;
      const confirmText = getString(req, "confirm");
      const confirmed =
        confirmText.length > 0 &&
        (confirmText === expected || confirmText === session.guildId);
      if (!confirmed) {
        await recordAudit(session, {
          action: "settings.reset-defaults",
          result: "failure",
          errorMessage: "confirmation text did not match",
        });
        flashRedirect(res, "/admin/settings", {
          type: "err",
          text: `Reset cancelled — type "${expected}" exactly to confirm.`,
        });
        return;
      }

      const config = ConfigService.getInstance();
      try {
        const { updated, deleted, failed } =
          await resetConfigToDefaults(config);
        const landed = updated + deleted;
        // Mirror the YAML-import audit: `result: "failure"` only when nothing
        // landed, otherwise `success` with a `partial` flag for reporting.
        const outcome: "ok" | "partial" | "failed" =
          failed.length === 0 ? "ok" : landed > 0 ? "partial" : "failed";
        await recordAudit(session, {
          action: "settings.reset-defaults",
          details: {
            updated,
            deleted,
            failed,
            failedCount: failed.length,
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

        const orphanNote =
          deleted > 0
            ? `, ${deleted} orphan key${deleted === 1 ? "" : "s"} removed`
            : "";
        const reloadNote = " You may need to Reload commands.";
        if (failed.length === 0) {
          flashRedirect(res, "/admin/settings", {
            type: "ok",
            text: `Settings reset to defaults — ${updated} key${updated === 1 ? "" : "s"} updated${orphanNote}.${reloadNote}`,
          });
          return;
        }
        flashRedirect(res, "/admin/settings", {
          type: landed > 0 ? "warn" : "err",
          text: `Reset ${landed > 0 ? "partially " : ""}failed — ${updated} key${updated === 1 ? "" : "s"} updated${orphanNote}, ${failed.length} failed (first: ${failed[0].key} — ${failed[0].reason}).${landed > 0 ? reloadNote : ""}`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Reset to defaults failed", err);
        await recordAudit(session, {
          action: "settings.reset-defaults",
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/settings", {
          type: "err",
          text: `Reset failed: ${text}`,
        });
      }
    }),
  );

  // Bulk save for a single Settings section (issue #433). Replaces the
  // per-row "Set" button with one "Save" per category, posting every key
  // in the section in a single request. Atomic: if any value fails to
  // coerce, no DB writes happen and the operator gets a flash listing the
  // offending keys. Once coercion passes, the writes are applied
  // sequentially; a write that throws is reported in the flash but
  // earlier writes are not rolled back (ConfigService has no transaction
  // primitive, and partial application matches the YAML-import semantics).
  router.post(
    "/settings/save-section",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const body = (req.body as Record<string, unknown> | undefined) ?? {};
      const category = getString(req, "category");
      // Where to land after the save. Defaults to /admin/settings (this route's
      // historical target); a feature page that reuses this route to edit its
      // own `*.` keys in place passes its own page so the operator returns
      // there (#705), allowlisted the same way as /settings/set.
      const redirectTo = safeAdminRedirect(getString(req, "redirect"));
      // Section forms carry an implicit master toggle (the section's shortest
      // `.enabled` key) whose cascade skips dependents when off. A feature page
      // reusing this route has no such master — its master lives elsewhere
      // (e.g. `voicechannels.enabled`, owned by the enable notice) and is not
      // among the submitted keys — so it opts out with `no_cascade`, meaning
      // every submitted key is written rather than skipped.
      const noCascade = getCheckbox(req, "no_cascade");

      const rawKeys = body.keys;
      const keys: string[] = Array.isArray(rawKeys)
        ? rawKeys.map(String).filter((k) => k.length > 0)
        : typeof rawKeys === "string" && rawKeys.length > 0
          ? [rawKeys]
          : [];

      if (keys.length === 0) {
        await recordAudit(session, {
          action: "settings.save-section",
          targetId: category || null,
          result: "failure",
          errorMessage: "no keys submitted",
        });
        respondSectionFlash(
          req,
          res,
          {
            type: "err",
            text: `No settings submitted for section ${category || "(unknown)"}.`,
          },
          redirectTo,
        );
        return;
      }

      // Cascading disable (#485): when the section's master `.enabled` toggle
      // (the shortest boolean `.enabled` key in the section) is unchecked, the
      // dependent controls were greyed out client-side and aren't submitted.
      // Honour that here — write only the master flag and leave the rest
      // untouched, so disabling a feature can't silently clobber its
      // sub-settings (an absent number field would otherwise be rejected, an
      // absent string blanked).
      const masterKey = noCascade ? null : findSectionMasterKey(keys);
      const masterOff =
        masterKey !== null &&
        body[settingValueFieldName(masterKey)] !== "true" &&
        body[settingValueFieldName(masterKey)] !== true;

      // Phase 1: coerce every value before touching the DB. An array of
      // unique keys is required so a duplicate hidden input can't trick
      // the handler into double-writing or mis-counting rejections.
      const seen = new Set<string>();
      let coerced: Array<{
        key: string;
        value: string | number | boolean;
      }> = [];
      const rejected: Array<{ key: string; reason: string }> = [];
      for (const key of keys) {
        if (seen.has(key)) continue;
        seen.add(key);
        if (masterOff && key !== masterKey) continue;
        const raw = body[settingValueFieldName(key)];
        const r = coerceConfigValue(key, raw);
        if (r.ok) {
          coerced.push({ key, value: r.value });
        } else {
          rejected.push({ key, reason: r.reason });
        }
      }

      // Cross-feature dependency validation (#663). Validate the whole coerced
      // batch together (against the live config for keys outside it) so a
      // section that enables a feature and its dependency at once passes, while
      // a write that would break the dependency graph is rejected with an
      // operator-friendly message. Flagged keys join `rejected`, so the
      // existing all-or-nothing guard below blocks the save.
      if (coerced.length > 0) {
        const pending = Object.fromEntries(
          coerced.map((c) => [c.key, c.value]),
        );
        const issues =
          await ConfigService.getInstance().findDependencyIssues(pending);
        if (issues.length > 0) {
          const flagged = new Set(issues.map((i) => i.key as string));
          for (const issue of issues) {
            rejected.push({ key: issue.key, reason: issue.message });
          }
          coerced = coerced.filter((c) => !flagged.has(c.key));
        }
      }

      if (rejected.length > 0) {
        await recordAudit(session, {
          action: "settings.save-section",
          targetId: category || null,
          details: {
            rejected,
            attemptedCount: coerced.length + rejected.length,
          },
          result: "failure",
          errorMessage: rejected.map((r) => `${r.key}: ${r.reason}`).join("; "),
        });
        const detail = rejected.map((r) => `${r.key} (${r.reason})`).join(", ");
        respondSectionFlash(
          req,
          res,
          {
            type: "err",
            text: `No changes saved — ${rejected.length} invalid value${rejected.length === 1 ? "" : "s"} in ${category || "section"}: ${detail}.`,
          },
          redirectTo,
        );
        return;
      }

      // Phase 2: apply. Snapshot `before` per key for the audit row.
      // `config.get()` returns null (not throw) on errors and for keys
      // that aren't stored, so fall back via `??` so unset keys record
      // their schema default in the audit instead of a misleading null.
      const config = ConfigService.getInstance();
      const applied: Array<{ key: string; before: unknown; after: unknown }> =
        [];
      const failed: Array<{ key: string; reason: string }> = [];
      for (const { key, value } of coerced) {
        const stored = await config.get(key);
        const before =
          stored ?? defaultConfig[key as keyof typeof defaultConfig];
        const meta = settingsMetadata[key as keyof typeof settingsMetadata];
        try {
          // Dependencies were validated for the whole batch above; skip the
          // per-key check so intra-batch ordering can't trigger a false reject.
          await config.set(
            key,
            value,
            meta?.description ?? "",
            meta?.category ?? key.split(".")[0],
            { skipDependencyCheck: true },
          );
          applied.push({ key, before, after: value });
        } catch (err) {
          const text = err instanceof Error ? err.message : "set failed";
          // The audit row records which key failed (see `failed` below) so
          // the log message keeps the user-supplied key out of the format
          // string — CodeQL flags template interpolation of body fields as
          // log injection even when validation guarantees the value.
          logger.error("save-section: failed to write setting", err);
          failed.push({ key, reason: text });
        }
      }

      // Tri-state outcome that mirrors the YAML-import audit (see
      // `/settings/import/apply`): `result: "failure"` only when nothing
      // landed, otherwise `success` with a `partial` flag in details so
      // an audit query for `result: "success"` doesn't exclude partial
      // saves. The user-facing flash already uses `warn` for partial.
      const outcome: "ok" | "partial" | "failed" =
        failed.length === 0 ? "ok" : applied.length > 0 ? "partial" : "failed";
      await recordAudit(session, {
        action: "settings.save-section",
        targetId: category || null,
        details: {
          applied,
          failed,
          appliedCount: applied.length,
          failedCount: failed.length,
          outcome,
        },
        result: outcome === "failed" ? "failure" : "success",
        errorMessage:
          failed.length > 0
            ? failed.map((f) => `${f.key}: ${f.reason}`).join("; ")
            : null,
      });

      const label = category || "section";
      if (failed.length === 0) {
        respondSectionFlash(
          req,
          res,
          {
            type: "ok",
            text: `Saved ${applied.length} setting${applied.length === 1 ? "" : "s"} in ${label}.`,
          },
          redirectTo,
        );
        return;
      }
      const firstError = failed[0];
      respondSectionFlash(
        req,
        res,
        {
          type: applied.length > 0 ? "warn" : "err",
          text: `Saved ${applied.length}/${applied.length + failed.length} in ${label}. Failed: ${firstError.key} (${firstError.reason})${failed.length > 1 ? ` and ${failed.length - 1} more` : ""}.`,
        },
        redirectTo,
      );
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
          navFeatureStatus: await navStatusForPage(),
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

      // Phase 1: coerce every importable key. An import is a (possibly
      // partial) config snapshot, so collect the whole valid set before
      // writing — the dependency check below judges them together.
      const pending: Array<{ key: string; value: string | number | boolean }> =
        [];
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
        pending.push({ key, value: coerced.value });
      }

      // Cross-feature dependency validation (#663). Validate the imported set
      // as a batch so a snapshot that enables a feature and its dependency
      // together imports cleanly, while one that breaks the dependency graph
      // has the offending keys rejected (the rest still apply).
      let toWrite = pending;
      if (pending.length > 0) {
        const issues = await config.findDependencyIssues(
          Object.fromEntries(pending.map((p) => [p.key, p.value])),
        );
        if (issues.length > 0) {
          const flagged = new Set(issues.map((i) => i.key as string));
          for (const issue of issues) {
            failed.push({ key: issue.key, reason: issue.message });
          }
          toWrite = pending.filter((p) => !flagged.has(p.key));
        }
      }

      // Phase 2: apply the validated set. Skip the per-key check — the batch
      // was already validated, and per-key ordering would falsely reject an
      // intra-snapshot dependency pair.
      for (const { key, value } of toWrite) {
        const meta = settingsMetadata[key as keyof typeof settingsMetadata];
        try {
          await config.set(
            key,
            value,
            meta?.description ?? "",
            meta?.category ?? key.split(".")[0],
            { skipDependencyCheck: true },
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
      const navFeatureStatus = await navStatusForPage();
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
              navFeatureStatus,
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

          // Resolve a key's effective current value: prefer what the admin
          // already entered earlier in this wizard run, then the persisted
          // config, then the schema default. Used for both the visible fields
          // and the cross-feature dependency targets below.
          const resolveCurrent = async (k: string): Promise<unknown> => {
            const fromWizard = wizard.getConfiguration(
              session.discordUserId,
              session.guildId,
              k,
            );
            if (fromWizard !== undefined) return fromWizard;
            try {
              return await config.get(k);
            } catch {
              return defaultConfig[k as keyof typeof defaultConfig];
            }
          };

          const currentValues: Record<string, unknown> = {};
          for (const k of settingKeys) {
            currentValues[k] = await resolveCurrent(k);
          }

          // Enabled-state of this step's keys plus any dependency targets they
          // reference on other steps (e.g. `achievements.enabled` depends on
          // `voicetracking.enabled`), so the shared dependency-lock logic knows
          // whether a cross-feature requirement is actually satisfied (#666).
          const enabledByKey: Record<string, boolean> = {};
          for (const k of settingKeys) {
            enabledByKey[k] = isEnabledValue(currentValues[k]);
          }
          for (const k of settingKeys) {
            for (const dep of getDependencies(
              k as keyof typeof defaultConfig,
            )) {
              if (dep in enabledByKey) continue;
              enabledByKey[dep] = isEnabledValue(await resolveCurrent(dep));
            }
          }
          // Guild picker lists so channel/category/role keys render as real
          // selectors, exactly like the Settings page (issues #702 / #703).
          // Two guild fetches run in parallel — one for channels/categories,
          // one for roles; both helpers swallow their own errors and return
          // empty lists, so a picker just falls back to an empty dropdown
          // rather than failing the step.
          const [chData, roleData] = await Promise.all([
            fetchChannelData(client, session.guildId),
            fetchRoleData(client, session.guildId),
          ]);
          res.type("text/html").send(
            renderWizardStepPage({
              csrfToken,
              remainingMs,
              navFeatureStatus,
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
              textChannels: chData.textChannels,
              voiceChannels: chData.voiceChannels,
              categoryChannels: chData.categoryChannels,
              roles: roleData.roles,
              enabledByKey,
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
          navFeatureStatus,
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

      // Cascading disable (#485): when the feature's master `.enabled` toggle
      // is off, the dependent controls were greyed out client-side and aren't
      // submitted. Mirror that on the server — record only `<feature>.enabled
      // = false` and skip the rest, so absent dependents don't surface as
      // bogus "invalid input" drops (a missing number field would otherwise
      // fail coercion).
      // The wizard now renders each control through the shared
      // `renderControlInput`, which names every value field `value_<key>`
      // (`settingValueFieldName`) exactly like the Settings page — read the
      // same field names back here (issues #702 / #703).
      const body = req.body as Record<string, unknown> | undefined;
      const masterKey = `${featureKey}.enabled`;
      const masterOff =
        settingKeys.includes(masterKey) &&
        body?.[settingValueFieldName(masterKey)] !== "true";

      const saved: Record<string, unknown> = {};
      const dropped: Array<{ key: string; reason: string }> = [];
      for (const k of settingKeys) {
        if (masterOff && k !== masterKey) continue;
        const raw = body?.[settingValueFieldName(k)];
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
      // Reject oversized text up front so the operator gets a readable flash
      // rather than a Discord rejection at send time or a Mongoose error (#508).
      const lengthError = firstLengthError([
        {
          label: "Message",
          value: message,
          max: TEXT_LIMITS.announcementMessage,
        },
        {
          label: "Embed title",
          value: embedTitle,
          max: TEXT_LIMITS.embedTitle,
        },
        {
          label: "Embed description",
          value: embedDescription,
          max: TEXT_LIMITS.embedDescription,
        },
      ]);
      if (lengthError) {
        flashRedirect(res, "/admin/announcements", {
          type: "err",
          text: lengthError,
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
    "/announcements/:id/post-now",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const service = ScheduledAnnouncementService.getInstance(client);
      try {
        const ok = await service.postAnnouncementNow(id, session.guildId);
        await recordAudit(session, {
          action: "announcement.post-now",
          targetId: id,
          result: ok ? "success" : "failure",
          errorMessage: ok ? null : "not found or wrong guild",
        });
        flashRedirect(res, "/admin/announcements", {
          type: ok ? "ok" : "err",
          text: ok
            ? `Posted announcement ${id}. Check the configured channel.`
            : `Announcement ${id} not found.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Manual announcement post failed", err);
        await recordAudit(session, {
          action: "announcement.post-now",
          targetId: id,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/announcements", {
          type: "err",
          text: `Failed to post announcement ${id}: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/announcements/post-once",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const channelId = getString(req, "channelId");
      const message = getString(req, "message");
      const placeholders = getCheckbox(req, "placeholders");
      const embedTitle = getString(req, "embedTitle");
      const embedDescription = getString(req, "embedDescription");
      const embedColorHex = getString(req, "embedColor");

      if (!channelId || !message) {
        flashRedirect(res, "/admin/announcements", {
          type: "err",
          text: "Channel and message are both required.",
        });
        return;
      }
      // Reject oversized text up front, mirroring the create route (#508).
      const lengthError = firstLengthError([
        {
          label: "Message",
          value: message,
          max: TEXT_LIMITS.announcementMessage,
        },
        {
          label: "Embed title",
          value: embedTitle,
          max: TEXT_LIMITS.embedTitle,
        },
        {
          label: "Embed description",
          value: embedDescription,
          max: TEXT_LIMITS.embedDescription,
        },
      ]);
      if (lengthError) {
        flashRedirect(res, "/admin/announcements", {
          type: "err",
          text: lengthError,
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
        await service.postOnce({
          guildId: session.guildId,
          channelId,
          message,
          embedData,
          placeholders,
        });
        await recordAudit(session, {
          action: "announcement.post-once",
          details: { channelId, placeholders, hasEmbed: !!embedData },
          result: "success",
        });
        flashRedirect(res, "/admin/announcements", {
          type: "ok",
          text: "One-off announcement posted. Check the configured channel.",
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("One-off announcement post failed", err);
        await recordAudit(session, {
          action: "announcement.post-once",
          details: { channelId, placeholders },
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/announcements", {
          type: "err",
          text: `Failed to post announcement: ${text}`,
        });
      }
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
    "/polls/schedules/:id/edit",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
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
        const schedule = await service.updateSchedule(
          id,
          {
            channelId,
            cronSchedule: cron,
            pollDuration: duration,
            roleIdToPing: pingRoleId || null,
          },
          session.guildId,
        );
        if (!schedule) {
          await recordAudit(session, {
            action: "poll-schedule.edit",
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
        await recordAudit(session, {
          action: "poll-schedule.edit",
          targetId: id,
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
          text: `Updated poll schedule ${id}.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        await recordAudit(session, {
          action: "poll-schedule.edit",
          targetId: id,
          details: { channelId, cron },
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: `Failed to update schedule ${id}: ${text}`,
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
      if (question.length > TEXT_LIMITS.pollQuestion) {
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: `Question must be ${TEXT_LIMITS.pollQuestion} characters or fewer.`,
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
      // Discord caps each poll answer (option) at 55 characters; reject an
      // oversized one here so it fails with a clean flash rather than being
      // stored and only rejected when Discord receives the payload (#508).
      if (answers.some((a) => a.length > TEXT_LIMITS.pollAnswer)) {
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: `Each answer must be ${TEXT_LIMITS.pollAnswer} characters or fewer.`,
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
    "/polls/items/:id/edit",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
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
      if (question.length > TEXT_LIMITS.pollQuestion) {
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: `Question must be ${TEXT_LIMITS.pollQuestion} characters or fewer.`,
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
      // Same 55-char poll-option cap the create route enforces (#508).
      if (answers.some((a) => a.length > TEXT_LIMITS.pollAnswer)) {
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: `Each answer must be ${TEXT_LIMITS.pollAnswer} characters or fewer.`,
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
        const item = await service.updatePollItem(
          id,
          { question, answers, multiSelect, tags },
          session.guildId,
        );
        if (!item) {
          await recordAudit(session, {
            action: "poll-item.edit",
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
        await recordAudit(session, {
          action: "poll-item.edit",
          targetId: id,
          details: {
            answerCount: answers.length,
            multiSelect,
            tagCount: tags.length,
          },
          result: "success",
        });
        flashRedirect(res, "/admin/polls", {
          type: "ok",
          text: `Updated poll question ${id}.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        await recordAudit(session, {
          action: "poll-item.edit",
          targetId: id,
          details: { answerCount: answers.length },
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: `Failed to update question ${id}: ${text}`,
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

  // Import a poll library from content the admin pastes into the textarea or
  // loads from a local file in the browser (#646). There is no URL/fetch path:
  // the YAML/JSON arrives straight from the authenticated admin's browser, so
  // there is no outbound request to forge and no host allowlist to maintain.
  // The parse/validate/dedup loop lives in PollService.importFromString.
  router.post(
    "/polls/items/import-text",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const content = getString(req, "content");
      if (!content) {
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: "Paste some YAML or JSON poll content to import.",
        });
        return;
      }
      const service = PollService.getInstance(client);
      try {
        const results = await service.importFromString(
          content,
          session.guildId,
          session.discordUserId,
          "paste",
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
            source: "paste",
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
        logger.error("Poll paste import failed", err);
        await recordAudit(session, {
          action: "poll-item.import",
          details: { source: "paste" },
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
      const lengthError = firstLengthError([
        { label: "Title", value: title, max: TEXT_LIMITS.noticeTitle },
        { label: "Content", value: content, max: TEXT_LIMITS.noticeContent },
      ]);
      if (lengthError) {
        flashRedirect(res, "/admin/notices", {
          type: "err",
          text: lengthError,
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
      // Mirror the create-route length checks: `notice.save()` would otherwise
      // reject the oversized field as a Mongoose ValidationError surfaced as a
      // 500-style flash instead of this readable message (#508).
      const lengthError = firstLengthError([
        { label: "Title", value: title, max: TEXT_LIMITS.noticeTitle },
        { label: "Content", value: content, max: TEXT_LIMITS.noticeContent },
      ]);
      if (lengthError) {
        flashRedirect(res, "/admin/notices", {
          type: "err",
          text: lengthError,
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

  // ============================================================
  // Weekly Digest — send now (issue #539)
  // ============================================================

  router.post(
    "/digest/send-now",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const service = DigestService.getInstance(client);
      try {
        const summary = await service.runNow();
        if (!summary) {
          // runNow returns null only when the feature is disabled or
          // GUILD_ID is unset. Concurrent invocations don't return null —
          // they coalesce onto the in-flight run via `inFlight`.
          await recordAudit(session, {
            action: "digest.send-now",
            result: "failure",
            errorMessage: "digest disabled or GUILD_ID unset",
          });
          flashRedirect(res, "/admin/digest", {
            type: "warn",
            text: "Digest did not run — it is disabled or GUILD_ID is not configured.",
          });
          return;
        }
        await recordAudit(session, {
          action: "digest.send-now",
          details: {
            qualifying: summary.qualifying,
            sent: summary.sent,
            skippedOptOut: summary.skippedOptOut,
            skippedDmsClosed: summary.skippedDmsClosed,
            failed: summary.failed,
          },
          result: summary.failed > 0 ? "failure" : "success",
          errorMessage:
            summary.failed > 0 ? `${summary.failed} delivery error(s)` : null,
        });
        flashRedirect(res, "/admin/digest", {
          type: summary.failed > 0 ? "warn" : "ok",
          text: `Digest sent. ${summary.sent} delivered · ${summary.skippedOptOut} opted out · ${summary.skippedDmsClosed} DMs closed · ${summary.failed} failed.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("digest send-now failed", err);
        await recordAudit(session, {
          action: "digest.send-now",
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/digest", {
          type: "err",
          text: `Digest send failed: ${text}`,
        });
      }
    }),
  );

  // ============================================================
  // Bot Status message pools (issue #557)
  // ============================================================

  const reloadBotStatusPools = async (): Promise<void> => {
    await BotStatusService.getInstance(client).refreshStatusPools();
  };

  // Resolve and guild-check a stored entry; flashes + returns null on miss.
  // A malformed (non-ObjectId) `:id` makes Mongoose throw a CastError — catch
  // it and treat it as a clean "not found" rather than a 500.
  const findOwnedEntry = async (
    res: Response,
    guildId: string,
    id: string,
  ): Promise<HydratedDocument<IBotStatusMessage> | null> => {
    let entry: HydratedDocument<IBotStatusMessage> | null = null;
    try {
      entry = await BotStatusMessage.findById(id);
    } catch {
      entry = null;
    }
    if (!entry || entry.guildId !== guildId) {
      flashRedirect(res, "/admin/bot-status", {
        type: "err",
        text: `Status entry ${id} not found.`,
      });
      return null;
    }
    return entry;
  };

  router.post(
    "/bot-status/pool/:pool/add",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const pool = String(req.params.pool);
      if (!isBotStatusPool(pool)) {
        flashRedirect(res, "/admin/bot-status", {
          type: "err",
          text: `Unknown pool: ${pool}.`,
        });
        return;
      }
      const text = getString(req, "text");
      const orderRaw = getString(req, "order");
      const invalid = validateStatusEntry(pool, text);
      if (invalid) {
        flashRedirect(res, "/admin/bot-status", { type: "err", text: invalid });
        return;
      }
      const order = parseIntInRange(orderRaw || "0", -1000, 10000);
      if (order === null) {
        flashRedirect(res, "/admin/bot-status", {
          type: "err",
          text: "Order must be an integer between -1000 and 10000.",
        });
        return;
      }
      try {
        const entry = await new BotStatusMessage({
          guildId: session.guildId,
          pool,
          text: text.trim(),
          order,
          createdBy: session.discordUserId,
        }).save();
        await reloadBotStatusPools();
        await recordAudit(session, {
          action: "bot-status.add",
          targetId: String(entry._id),
          details: { pool, order },
          result: "success",
        });
        flashRedirect(res, "/admin/bot-status", {
          type: "ok",
          text: `Added status to the ${pool} pool.`,
        });
      } catch (err) {
        const text2 = err instanceof Error ? err.message : "Unknown error";
        logger.error("Add bot status failed", err);
        await recordAudit(session, {
          action: "bot-status.add",
          details: { pool },
          result: "failure",
          errorMessage: text2,
        });
        flashRedirect(res, "/admin/bot-status", {
          type: "err",
          text: `Failed to add status: ${text2}`,
        });
      }
    }),
  );

  router.post(
    "/bot-status/entry/:id/update",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const text = getString(req, "text");
      const entry = await findOwnedEntry(res, session.guildId, id);
      if (!entry) return;
      const pool: BotStatusPool = entry.pool;
      const invalid = validateStatusEntry(pool, text);
      if (invalid) {
        flashRedirect(res, "/admin/bot-status", { type: "err", text: invalid });
        return;
      }
      try {
        entry.text = text.trim();
        await entry.save();
        await reloadBotStatusPools();
        await recordAudit(session, {
          action: "bot-status.update",
          targetId: id,
          details: { pool },
          result: "success",
        });
        flashRedirect(res, "/admin/bot-status", {
          type: "ok",
          text: `Updated status entry ${id}.`,
        });
      } catch (err) {
        const text2 = err instanceof Error ? err.message : "Unknown error";
        logger.error("Update bot status failed", err);
        await recordAudit(session, {
          action: "bot-status.update",
          targetId: id,
          result: "failure",
          errorMessage: text2,
        });
        flashRedirect(res, "/admin/bot-status", {
          type: "err",
          text: `Failed to update status: ${text2}`,
        });
      }
    }),
  );

  router.post(
    "/bot-status/entry/:id/order",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const order = parseIntInRange(
        getString(req, "order") || "0",
        -1000,
        10000,
      );
      if (order === null) {
        flashRedirect(res, "/admin/bot-status", {
          type: "err",
          text: "Order must be an integer between -1000 and 10000.",
        });
        return;
      }
      const entry = await findOwnedEntry(res, session.guildId, id);
      if (!entry) return;
      try {
        const previous = entry.order;
        entry.order = order;
        await entry.save();
        await reloadBotStatusPools();
        await recordAudit(session, {
          action: "bot-status.reorder",
          targetId: id,
          details: { pool: entry.pool, from: previous, to: order },
          result: "success",
        });
        flashRedirect(res, "/admin/bot-status", {
          type: "ok",
          text: `Reordered status entry ${id}: ${previous} → ${order}.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Reorder bot status failed", err);
        await recordAudit(session, {
          action: "bot-status.reorder",
          targetId: id,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/bot-status", {
          type: "err",
          text: `Failed to reorder status: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/bot-status/entry/:id/delete",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const entry = await findOwnedEntry(res, session.guildId, id);
      if (!entry) return;
      const pool = entry.pool;
      try {
        await BotStatusMessage.findByIdAndDelete(id);
        await reloadBotStatusPools();
        await recordAudit(session, {
          action: "bot-status.delete",
          targetId: id,
          details: { pool, text: entry.text },
          result: "success",
        });
        flashRedirect(res, "/admin/bot-status", {
          type: "ok",
          text: `Deleted status entry ${id} from the ${pool} pool.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Delete bot status failed", err);
        await recordAudit(session, {
          action: "bot-status.delete",
          targetId: id,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/bot-status", {
          type: "err",
          text: `Failed to delete status: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/bot-status/pool/:pool/import",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const pool = String(req.params.pool);
      if (!isBotStatusPool(pool)) {
        flashRedirect(res, "/admin/bot-status", {
          type: "err",
          text: `Unknown pool: ${pool}.`,
        });
        return;
      }
      const mode = getString(req, "mode") === "append" ? "append" : "replace";
      const entries = parseStringListImport(getString(req, "items"));
      if (entries.length === 0) {
        flashRedirect(res, "/admin/bot-status", {
          type: "err",
          text: "Nothing to import — paste one entry per line or a JSON array.",
        });
        return;
      }
      // Validate every entry up front so the pool is never left half-written.
      for (let i = 0; i < entries.length; i++) {
        const invalid = validateStatusEntry(pool, entries[i]);
        if (invalid) {
          flashRedirect(res, "/admin/bot-status", {
            type: "err",
            text: `Import rejected at entry ${i + 1} ("${entries[i].slice(0, 40)}"): ${invalid}`,
          });
          return;
        }
      }
      try {
        let baseOrder = 0;
        if (mode === "replace") {
          await BotStatusMessage.deleteMany({
            guildId: session.guildId,
            pool,
          });
        } else {
          const last = await BotStatusMessage.findOne({
            guildId: session.guildId,
            pool,
          })
            .sort({ order: -1 })
            .lean();
          baseOrder = last ? last.order + 1 : 0;
        }
        await BotStatusMessage.insertMany(
          entries.map((text, i) => ({
            guildId: session.guildId,
            pool,
            text: text.trim(),
            order: baseOrder + i,
            createdBy: session.discordUserId,
          })),
        );
        await reloadBotStatusPools();
        await recordAudit(session, {
          action: "bot-status.import",
          details: { pool, mode, count: entries.length },
          result: "success",
        });
        flashRedirect(res, "/admin/bot-status", {
          type: "ok",
          text: `Imported ${entries.length} ${entries.length === 1 ? "entry" : "entries"} into the ${pool} pool (${mode}).`,
        });
      } catch (err) {
        const text2 = err instanceof Error ? err.message : "Unknown error";
        logger.error("Import bot status failed", err);
        await recordAudit(session, {
          action: "bot-status.import",
          details: { pool, mode },
          result: "failure",
          errorMessage: text2,
        });
        flashRedirect(res, "/admin/bot-status", {
          type: "err",
          text: `Failed to import: ${text2}`,
        });
      }
    }),
  );

  router.post(
    "/bot-status/pool/:pool/seed",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const pool = String(req.params.pool);
      if (!isBotStatusPool(pool)) {
        flashRedirect(res, "/admin/bot-status", {
          type: "err",
          text: `Unknown pool: ${pool}.`,
        });
        return;
      }
      try {
        const existing = await BotStatusMessage.countDocuments({
          guildId: session.guildId,
          pool,
        });
        if (existing > 0) {
          flashRedirect(res, "/admin/bot-status", {
            type: "warn",
            text: `The ${pool} pool already has entries — nothing seeded.`,
          });
          return;
        }
        const defaults = STATUS_POOL_DEFAULTS[pool];
        await BotStatusMessage.insertMany(
          defaults.map((text, i) => ({
            guildId: session.guildId,
            pool,
            text,
            order: i,
            createdBy: session.discordUserId,
          })),
        );
        await reloadBotStatusPools();
        await recordAudit(session, {
          action: "bot-status.seed",
          details: { pool, count: defaults.length },
          result: "success",
        });
        flashRedirect(res, "/admin/bot-status", {
          type: "ok",
          text: `Seeded ${defaults.length} default ${pool} entries into the store.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Seed bot status failed", err);
        await recordAudit(session, {
          action: "bot-status.seed",
          details: { pool },
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/bot-status", {
          type: "err",
          text: `Failed to seed defaults: ${text}`,
        });
      }
    }),
  );

  return router;
}
