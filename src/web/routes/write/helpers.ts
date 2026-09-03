/**
 * Shared helpers for the admin write routers (`src/web/routes/write/*`).
 *
 * Pure helpers (validation, coercion, flash plumbing) live here so every
 * domain router — and the unit tests — can import them without constructing
 * a router. Nothing in this module registers a route; see
 * `src/web/write-routes.ts` for the mount point that composes the domain
 * routers behind `requireSession`, the admin-role check and `requireCsrf`.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { CronTime } from "cron";
import logger from "../../../utils/logger.js";
import { ConfigService } from "../../../services/config-service.js";
import type { WizardApplyResult } from "../../../services/wizard-service.js";
import {
  defaultConfig,
  settingsMetadata,
} from "../../../services/config-schema.js";
import { truncateFlash, wantsJson } from "../../http-flash.js";
import { PROTECTED_KEYS } from "../../bootstrap-vars.js";
import type { AuthenticatedRequest } from "../../session.js";
import { resolveEmojiShortcodes } from "../../../utils/emoji-shortcodes.js";
import { resolveNavFeatureStatus, NAV_ITEMS } from "../../admin-layout.js";
// Re-exported so existing callers/tests can keep importing these from the
// write-route helpers; the canonical home is `../../http-flash.js` (issue #612).
export { truncateFlash, wantsJson };

export type Flash = { type: "ok" | "warn" | "err"; text: string };

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

/**
 * Build the operator-facing flash message for a failed wizard apply (#780).
 * Pure and exported so each wording branch — full rollback, keys left in
 * effect, reload failure — can be unit-tested without Express or Mongo.
 */
export function wizardApplyFailureMessage(result: WizardApplyResult): string {
  const reason = result.failedKey
    ? `${result.failedKey} failed (${result.errorMessage ?? "unknown error"})`
    : (result.errorMessage ?? "unknown error");
  if (result.revertFailedKeys.length > 0) {
    const kept = `Wizard apply failed: ${reason}. Could not roll back ${result.revertFailedKeys.join(", ")} — these settings are saved`;
    // When the follow-up reload also failed, the persisted keys have NOT
    // taken effect for callback-driven services yet — say so instead of
    // claiming they're live.
    return result.reloadFailed
      ? `${kept}, and the configuration reload failed — run /config reload to apply them.`
      : `${kept} and now in effect.`;
  }
  if (result.rolledBackKeys.length > 0) {
    const n = result.rolledBackKeys.length;
    return `Wizard apply failed: ${reason}. The ${n} setting${n === 1 ? "" : "s"} written before the failure ${n === 1 ? "was" : "were"} rolled back — no changes were applied. You can retry.`;
  }
  if (result.appliedKeys.length === 0) {
    return `Wizard apply failed: ${reason}. No changes were applied. You can retry.`;
  }
  // Every write persisted but the reload failed; the reason already says
  // what to do (/config reload).
  return `Wizard apply failed: ${reason}.`;
}

/**
 * Config keys echoed back on a failed Settings save so the reloaded page can
 * mark exactly which controls were refused (#854). Capped: the page only needs
 * enough to point the operator at the first offenders, and an uncapped list of
 * a 100-key section would push the redirect URL past header/URI limits.
 */
export const INVALID_KEYS_MAX = 25;

/** Query string for a flash redirect, exported so its caps can be tested. */
export function flashRedirectQuery(
  flash: Flash,
  invalidKeys: string[] = [],
): string {
  // Mirror the renderer's 500-char cap on the way out so the redirect
  // URL itself can't balloon to header/URI limits on a noisy failure.
  const params: Record<string, string> = {
    flash: flash.type,
    msg: truncateFlash(flash.text),
  };
  if (invalidKeys.length > 0) {
    params.invalid = invalidKeys.slice(0, INVALID_KEYS_MAX).join(",");
  }
  return new globalThis.URLSearchParams(params).toString();
}

export function flashRedirect(
  res: Response,
  path: string,
  flash: Flash,
  invalidKeys: string[] = [],
): void {
  res.redirect(303, `${path}?${flashRedirectQuery(flash, invalidKeys)}`);
}

/**
 * Reply to a section-save with either an inline JSON flash (AJAX) or the
 * legacy 303 redirect (no-JS). Always returns the same 500-char-capped flash
 * the renderer would show, so both paths surface identical messages.
 */
export function respondSectionFlash(
  req: AuthenticatedRequest,
  res: Response,
  flash: Flash,
  redirectTo = "/admin/settings",
  // Keys whose values the save refused. Both paths carry them so the page can
  // set `aria-invalid` on those controls and move focus to the first one,
  // instead of leaving the operator to find the bad field among ~318 (#854).
  invalidKeys: string[] = [],
): void {
  if (wantsJson(req)) {
    res.status(200).json({
      type: flash.type,
      text: truncateFlash(flash.text),
      invalidKeys: invalidKeys.slice(0, INVALID_KEYS_MAX),
    });
    return;
  }
  flashRedirect(res, redirectTo, flash, invalidKeys);
}

export function getString(req: AuthenticatedRequest, name: string): string {
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

export function getCheckbox(req: AuthenticatedRequest, name: string): boolean {
  const raw = (req.body as Record<string, unknown> | undefined)?.[name];
  return typeof raw === "string" && raw.length > 0;
}

export function parseIntInRange(
  raw: string,
  min: number,
  max: number,
): number | null {
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
export function normalizeCron(expr: string): string {
  return expr.replace(/^["']|["']$/g, "").trim();
}

export function validCron(expr: string): boolean {
  try {
    new CronTime(expr);
    return true;
  } catch {
    return false;
  }
}

export function parseHexColor(input: string): number | null {
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

export function requireSessionContext(
  req: AuthenticatedRequest,
): AuthenticatedRequest["webSession"] & object {
  if (!req.webSession) {
    throw new Error("requireSession middleware must run first");
  }
  return req.webSession;
}

export function asyncHandler(
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
export const WIZARD_FEATURE_SETTINGS: Record<string, string[]> = {
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
  reactionroles: [
    "reactionroles.enabled",
    "reactionroles.message_channel_id",
    "reactionroles.style",
  ],
  announcements: ["announcements.enabled"],
  notices: ["notices.enabled", "notices.channel_id", "notices.header_enabled"],
  polls: [
    "polls.enabled",
    "polls.default_duration_hours",
    "polls.cooldown_days",
  ],
};

export const WIZARD_FEATURE_ORDER = [
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
    // A cleared `<input type="number">` posts "" and a YAML key with no value
    // parses as null — both of which `Number()` silently turns into 0. For a
    // retention key that used to mean "cut off at now" and wiped the whole
    // history (#835), so blank input is refused outright instead of coerced.
    // Only a finite number or a non-blank numeric string is accepted.
    if (raw === null || raw === undefined || typeof raw === "boolean") {
      return { ok: false, reason: "invalid number" };
    }
    if (typeof raw === "string" && raw.trim() === "") {
      return { ok: false, reason: "invalid number" };
    }
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n)) return { ok: false, reason: "invalid number" };
    // Declared lower bound (#835): refuse — never clamp — so the operator sees
    // a field-level error rather than a silently different value.
    const min = settingsMetadata[key as keyof typeof settingsMetadata]?.min;
    if (min !== undefined && n < min) {
      return { ok: false, reason: `must be at least ${min}` };
    }
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

export function getCsrfFromReq(req: AuthenticatedRequest): string {
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
export function navStatusForPage(): ReturnType<typeof resolveNavFeatureStatus> {
  const config = ConfigService.getInstance();
  return resolveNavFeatureStatus((key) => config.getBoolean(key, false));
}
