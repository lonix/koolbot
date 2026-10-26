/**
 * Shared helpers for the admin write routers (`src/web/routes/write/*`).
 *
 * Pure helpers (validation, coercion, flash plumbing) live here so every
 * domain router — and the unit tests — can import them without constructing
 * a router. Nothing in this module registers a route; see
 * `src/web/write-routes.ts` for the mount point that composes the domain
 * routers behind `requireSession`, the admin-role check and `requireCsrf`.
 */

import { RAID_CONFIG_KEYS } from "../../../services/raid-protection-service.js";
import type { Client } from "discord.js";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { forbiddenSelfAssignPermissions } from "../../../utils/role-safety.js";
import {
  isValidCronExpression,
  sanitizeCronExpression,
} from "../../../utils/cron.js";
import logger from "../../../utils/logger.js";
import {
  hasCustomEmojiMarkup,
  validateSettingFormat,
} from "../../../utils/setting-formats.js";
import { ConfigService } from "../../../services/config-service.js";
import { RoleGroupService } from "../../../services/role-group-service.js";
import { grantedRoleIds } from "../../../services/role-grants.js";
import type { WizardApplyResult } from "../../../services/wizard-service.js";
import {
  defaultConfig,
  isManagedSetting,
  settingsMetadata,
} from "../../../services/config-schema.js";
import { signFlash, truncateFlash, wantsJson } from "../../http-flash.js";
import type { FormErrors, FormValues } from "../../form-errors.js";
import { getFormPage } from "../../form-pages.js";
import { escapeHtml } from "../../html.js";
import { loadReactionRoleMessageIds } from "../../reaction-role-messages.js";
import { PROTECTED_KEYS } from "../../bootstrap-vars.js";
import { pickCascadeMasterKey } from "../../cascade-master.js";
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
  /** Staff note recorded on a moderation case decision (#908). */
  caseNote: 500,
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

/** Longest reason sent back for one refused key in the AJAX reply (#1517). */
export const INVALID_REASON_MAX = 300;

/** Query string for a flash redirect, exported so its caps can be tested. */
export function flashRedirectQuery(
  flash: Flash,
  invalidKeys: string[] = [],
  openSettings = false,
): string {
  // Mirror the renderer's 500-char cap on the way out so the redirect
  // URL itself can't balloon to header/URI limits on a noisy failure.
  const params: Record<string, string> = {
    flash: flash.type,
    msg: truncateFlash(flash.text),
  };
  params.sig = signFlash(flash.type, params.msg);
  if (invalidKeys.length > 0) {
    params.invalid = invalidKeys.slice(0, INVALID_KEYS_MAX).join(",");
  }
  // The result of a save or reset in a feature page's folded settings (#1301):
  // the page opens them and shows the flash there. Not part of the signature,
  // it only opens a fold.
  if (openSettings) params.settings = "open";
  return new globalThis.URLSearchParams(params).toString();
}

export function flashRedirect(
  res: Response,
  path: string,
  flash: Flash,
  invalidKeys: string[] = [],
  openSettings = false,
): void {
  res.redirect(
    303,
    `${path}?${flashRedirectQuery(flash, invalidKeys, openSettings)}`,
  );
}

/**
 * Answer a refused create or edit form: render the page again with status 422,
 * the typed values and one message per field (#1517). Typed text is never put
 * into a redirect URL.
 *
 * Returns true when it answered, so a route reads
 * `if (await refuseForm(req, res, {...})) return;`. Returns false when no
 * field was refused. When the page has no registered renderer, or rendering
 * fails, it falls back to the old flash redirect with the first message, so a
 * refusal is never lost.
 */
export async function refuseForm(
  req: Request,
  res: Response,
  opts: {
    /** Path of the page the form is on ("/admin/announcements"). */
    page: string;
    /** Which form on the page; see `RefusedForm.formId`. */
    formId: string;
    errors: FormErrors;
    values: FormValues;
  },
): Promise<boolean> {
  const messages = Object.values(opts.errors);
  if (messages.length === 0) return false;
  const render = getFormPage(opts.page);
  if (render) {
    try {
      const html = await render(req, {
        formId: opts.formId,
        errors: opts.errors,
        values: opts.values,
      });
      // The page must hold the refused form: its first error line carries the
      // form id. A row deleted since the form was drawn has no form, and a 422
      // with no message, no marked field and no values would explain nothing.
      const first = Object.keys(opts.errors)[0];
      const marker = `id="${escapeHtml(`${opts.formId}-${first}-error`)}"`;
      if (html.includes(marker)) {
        res.status(422).type("text/html").send(html);
        return true;
      }
      logger.warn("Refused form is not on the rendered page; redirecting");
    } catch (err) {
      logger.warn("Could not render a refused form; redirecting", err);
    }
  }
  flashRedirect(res, opts.page, {
    type: "err",
    text: `Not saved. ${messages[0]}`,
  });
  return true;
}

/**
 * Whether a refused edit's row is known to be gone (#1520). A write route asks
 * this before it answers a refusal, so a row deleted in another tab gets the
 * not-found flash instead of a 422 for a form that is no longer on the page.
 *
 * The lookup only decides between "not found" and the validation refusal, so a
 * failed read counts as "not known to be gone": the refusal is still answered
 * (and `refuseForm` falls back to a flash if the page cannot show the form)
 * rather than the request failing with a generic server error.
 */
export async function rowIsGone(
  exists: () => Promise<boolean>,
  what: string,
): Promise<boolean> {
  try {
    return !(await exists());
  } catch (err) {
    logger.warn(`${what} lookup before a refused edit failed`, err);
    return false;
  }
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
  // The save changed something the rest of the page renders from (a feature
  // page's enable flag drives its disabled banner, Status card, nav badge and
  // action buttons). The AJAX reply then carries the same flash URL the no-JS
  // path redirects to, and the page script navigates there instead of
  // showing the flash in place over a now-stale page.
  reload = false,
  // The save came from a feature page's folded settings (#1301).
  openSettings = false,
  // Why each refused key was refused (#1517). Only the AJAX reply carries
  // them, so the page can print each reason under its own row. The no-JS
  // redirect cannot: a query string is not signed, and only the flash text is.
  invalidReasons: Readonly<Record<string, string>> = {},
): void {
  if (wantsJson(req)) {
    const shownKeys = invalidKeys.slice(0, INVALID_KEYS_MAX);
    res.status(200).json({
      type: flash.type,
      text: truncateFlash(flash.text),
      invalidKeys: shownKeys,
      invalidReasons: Object.fromEntries(
        shownKeys
          .filter((k) => typeof invalidReasons[k] === "string")
          .map((k) => [k, invalidReasons[k].slice(0, INVALID_REASON_MAX)]),
      ),
      ...(reload
        ? {
            reload: `${redirectTo}?${flashRedirectQuery(flash, invalidKeys, openSettings)}`,
          }
        : {}),
    });
    return;
  }
  flashRedirect(res, redirectTo, flash, invalidKeys, openSettings);
}

export function getString(req: AuthenticatedRequest, name: string): string {
  const raw = (req.body as Record<string, unknown> | undefined)?.[name];
  if (typeof raw !== "string") return "";
  return raw.trim();
}

/**
 * A form field exactly as submitted, without the trimming `getString` does.
 * For values that must match server data character for character, such as a
 * typed confirmation of a role name that has leading or trailing spaces.
 */
export function getRawString(req: AuthenticatedRequest, name: string): string {
  const raw = (req.body as Record<string, unknown> | undefined)?.[name];
  return typeof raw === "string" ? raw : "";
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
 *
 * Delegates to the shared helper so the WebUI stores exactly the form the
 * services parse.
 */
export const normalizeCron = sanitizeCronExpression;

/**
 * A rejected expression here is an admin typo answered with a field error, not
 * a fault, so this uses the non-logging variant.
 */
export const validCron = isValidCronExpression;

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
    "voicechannels.lobby.max_rooms",
    "voicechannels.lobby.room_window_seconds",
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
    "reactionroles.group_role_colour",
    "reactionroles.max_toggles",
    "reactionroles.toggle_window_seconds",
  ],
  announcements: ["announcements.enabled"],
  notices: ["notices.enabled", "notices.channel_id", "notices.header_enabled"],
  polls: [
    "polls.enabled",
    "polls.default_duration_hours",
    "polls.cooldown_days",
  ],
  lfg: [
    // `lfg.enabled` stays first: the apply step derives a feature's master
    // gate as the first `.enabled` key in its list, and `lfg.voice_channel
    // .enabled` would otherwise be mistaken for it.
    "lfg.enabled",
    "lfg.channel_id",
    "lfg.expiry_minutes",
    "lfg.default_size",
    "lfg.max_active_per_user",
    "lfg.voice_channel.enabled",
  ],
  namehistory: [
    // `namehistory.enabled` stays first: it is the master gate the apply step
    // derives (the first `.enabled` key), and it controls recording; the
    // command itself is gated separately by `aka.enabled`.
    "namehistory.enabled",
    "aka.enabled",
    "namehistory.retention_days",
  ],
  moderation: [
    // `moderation.enabled` stays first: it is the master gate the apply step
    // derives; `moderation.cases.enabled` is an extra gate (below).
    "moderation.enabled",
    "moderation.retention_days",
    "moderation.cases.enabled",
    "moderation.cases.default_review_days",
    "moderation.cases.review_cron",
    // Every anti-raid key (#1045), derived so the wizard cannot fall behind.
    ...RAID_CONFIG_KEYS,
  ],
  events: [
    "events.enabled",
    "events.category_id",
    "events.announcement_channel_id",
    "events.timezone",
    "events.channel_prefix",
    "events.reminder_minutes",
    "events.create_lead_minutes",
    "events.default_duration_minutes",
    "events.channel_grace_minutes",
    "events.recurrence_enabled",
    "events.native.location",
    "events.native.link_room",
    "events.groups.default_count",
    "events.groups.max_count",
    "events.max_active_per_host",
  ],
  digest: [
    "digest.enabled",
    "digest.cron",
    "digest.min_active_minutes",
    "digest.streak_min_minutes",
    "digest.include_achievements",
  ],
  birthdays: [
    "birthdays.enabled",
    "birthdays.cron",
    "birthdays.channel_id",
    "birthdays.message",
    "birthdays.mention",
    "birthdays.role_id",
    "birthdays.role_duration_hours",
    "birthdays.change_cooldown_seconds",
  ],
  welcome: [
    "welcome.enabled",
    "welcome.channel_id",
    "welcome.message",
    "welcome.mention",
    "welcome.roles_message_id",
    "welcome.rules_channel_id",
  ],
  rules: [
    "rules.enabled",
    "rules.channel_id",
    "rules.role_id",
    "rules.message",
    "rules.button_label",
  ],
  reminders: ["reminders.enabled", "reminders.max_pending"],
  tickets: [
    "tickets.enabled",
    "tickets.staff_role_id",
    "tickets.category_id",
    "tickets.transcript_on_close",
    "tickets.max_open_per_member",
    "tickets.open_cooldown_seconds",
  ],
  leaderboard_roles: [
    "leaderboard_roles.enabled",
    "leaderboard_roles.period",
    "leaderboard_roles.update_cron",
    "leaderboard_roles.announcement_channel_id",
  ],
};

/**
 * Independent `.enabled` gates a feature has beyond its master gate (the
 * first `.enabled` key in its list). Unticking the feature in the wizard
 * switches these off too, so a deselected feature cannot keep serving data
 * through a gate the apply step did not know about.
 */
export const WIZARD_FEATURE_EXTRA_GATES: Record<string, string[]> = {
  namehistory: ["aka.enabled"],
  moderation: ["moderation.cases.enabled", "moderation.raid.enabled"],
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
  "lfg",
  "namehistory",
  "moderation",
  "events",
  "digest",
  "birthdays",
  "welcome",
  "rules",
  "reminders",
  "tickets",
  "leaderboard_roles",
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
 * What `coerceConfigValue` may need besides the value and the stored value.
 */
export interface CoerceContext {
  /**
   * The ids of the guild's reaction-role messages, for a
   * `reaction_role_message` key (#1433). Without it a non-empty id is refused
   * (fail closed) unless it is the stored value.
   */
  reactionRoleMessageIds?: ReadonlySet<string>;
}

/** Why a message id outside the bot's reaction-role messages is refused (#1433). */
export const NOT_A_REACTION_ROLE_MESSAGE_REASON =
  "not one of this server's reaction-role messages (pick one from the list, or leave empty to link the channel)";

/** Why a reaction-role message choice is refused when the stored one cannot be read (#1433). */
export const ROLES_MESSAGE_STORED_READ_FAILED_REASON =
  "the stored choice could not be read, so it was left unchanged; try again";

/** Why it is refused when the list of reaction-role messages cannot be read (#1433). */
export const ROLES_MESSAGE_LIST_READ_FAILED_REASON =
  "the reaction-role messages could not be read, so it was left unchanged; try again";

/** True for a setting that holds the id of one of the bot's reaction-role messages. */
export function isReactionRoleMessageKey(key: string): boolean {
  return (
    settingsMetadata[key as keyof typeof settingsMetadata]?.format ===
    "reaction_role_message"
  );
}

/**
 * The stored value of a reaction-role message key, from a read that must
 * succeed. The exemption for an unchanged value hangs on this value, so a
 * failed read refuses the save: falling back to the default (or to "no
 * stored value") would either let a crafted id through or rewrite a choice
 * the operator never touched (#1433). Callers use this one value both as the
 * baseline and for the raw value, so the two cannot come from different reads.
 */
export async function readReactionRoleMessageBaseline(
  key: string,
): Promise<{ ok: true; value: string } | { ok: false; reason: string }> {
  try {
    return {
      ok: true,
      value: await ConfigService.getInstance().getStringStrict(key),
    };
  } catch {
    return { ok: false, reason: ROLES_MESSAGE_STORED_READ_FAILED_REASON };
  }
}

/**
 * `coerceConfigValue` for a save in a guild. Everything except a
 * reaction-role message key is passed straight through. For one, the guild's
 * message ids are loaded only when the value is a non-empty id that is not the
 * stored one (an empty choice or an unchanged value never needs them), and a
 * failed load refuses the save.
 */
export async function coerceConfigValueForGuild(
  key: string,
  raw: unknown,
  current: unknown,
  guildId: string,
): Promise<
  { ok: true; value: string | number | boolean } | { ok: false; reason: string }
> {
  const first = coerceConfigValue(key, raw, current);
  if (
    first.ok ||
    !isReactionRoleMessageKey(key) ||
    first.reason !== NOT_A_REACTION_ROLE_MESSAGE_REASON
  ) {
    return first;
  }
  let ids: Set<string>;
  try {
    ids = await loadReactionRoleMessageIds(guildId);
  } catch {
    return { ok: false, reason: ROLES_MESSAGE_LIST_READ_FAILED_REASON };
  }
  return coerceConfigValue(key, raw, current, { reactionRoleMessageIds: ids });
}

/**
 * Coerce a raw form value to match the expected type of `key` in
 * `defaultConfig`. Returns the coerced value on success, or a typed
 * failure describing why coercion was refused.
 *
 * `current` is the stored value, when the caller has it (the Settings page,
 * the wizard, the YAML import and the adoption planner all pass it; see
 * `readStoredBaseline`). A number outside its bounds is also accepted when it
 * equals the stored one (#1437). A
 * picker-format key (#1426) accepts its stored value unchanged even when the
 * picker could not produce it, so an old custom timezone or a prefix that is
 * not an emoji never blocks saving the rest of its section.
 */
export function coerceConfigValue(
  key: string,
  raw: unknown,
  current?: unknown,
  context: CoerceContext = {},
):
  | { ok: true; value: string | number | boolean }
  | { ok: false; reason: string } {
  if (!(key in defaultConfig)) {
    return { ok: false, reason: "unknown key" };
  }

  // Bot-managed state (the id of a message the bot posted) is never written
  // from a form, an import or an adoption plan (#1304).
  if (isManagedSetting(key)) {
    return { ok: false, reason: "managed by KoolBot and cannot be set here" };
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
    // Digits only: `Number("1e3")` is 1000 and `Number("0x10")` is 16, which
    // the numeric input would never produce, and every number setting is a
    // whole number (#1304).
    if (typeof raw === "string" && !/^-?\d+$/.test(raw.trim())) {
      return {
        ok: false,
        reason: Number.isFinite(Number(raw))
          ? "must be a whole number"
          : "invalid number",
      };
    }
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n)) return { ok: false, reason: "invalid number" };
    if (!Number.isInteger(n)) {
      return { ok: false, reason: "must be a whole number" };
    }
    // Declared bounds (#835, #1304): refuse, never clamp, so the operator sees
    // a field-level error rather than a silently different value.
    const numberMeta = settingsMetadata[key as keyof typeof settingsMetadata];
    const min = numberMeta?.min;
    const max = numberMeta?.max;
    // A stored number outside its bounds (a limit saved before the bound
    // existed, #1429) is kept as stored when it is posted unchanged; only a
    // changed value is checked (#1437).
    const unchangedStored =
      current !== undefined &&
      current !== null &&
      typeof current !== "boolean" &&
      String(current).trim() !== "" &&
      Number(current) === n;
    if (unchangedStored) return { ok: true, value: n };
    if (min !== undefined && n < min) {
      return { ok: false, reason: `must be at least ${min}` };
    }
    if (max !== undefined && n > max) {
      return { ok: false, reason: `must be at most ${max}` };
    }
    return { ok: true, value: n };
  }
  const submitted = String(raw ?? "");
  let value = submitted;
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
  // Picker formats (#1426): the timezone select, colour input and emoji picker
  // are conveniences, so the value is checked again here. The stored value is
  // exempt, whatever it is: refusing it would block the whole section save.
  const format = settingsMetadata[key as keyof typeof settingsMetadata]?.format;
  if (format === "reaction_role_message") {
    // #1433: an empty choice clears, the stored value is kept as stored (a
    // message archived or deleted later must not block saving the rest of the
    // section), anything else must be one of the guild's reaction-role messages.
    const stored =
      current !== undefined && current !== null ? String(current) : null;
    if (stored !== null && submitted === stored) {
      value = submitted;
    } else {
      const checked = validateSettingFormat(format, submitted);
      if (!checked.ok) return { ok: false, reason: checked.reason };
      if (
        checked.value !== "" &&
        !context.reactionRoleMessageIds?.has(checked.value)
      ) {
        return { ok: false, reason: NOT_A_REACTION_ROLE_MESSAGE_REASON };
      }
      value = checked.value;
    }
  } else if (
    format === "affix" &&
    current !== undefined &&
    current !== null &&
    submitted === String(current)
  ) {
    // An affix posted exactly as stored is kept as stored: resolving a
    // shortcode in it (`[VC] :sparkles:` to `[VC] ✨`) would silently rewrite
    // the stored text, and with it every future channel name, whenever a
    // sibling setting in the section or a wizard step is saved.
    value = submitted;
  } else if (format) {
    // Shortcode resolution above would turn the `:name:` of `<:name:id>` into a
    // Unicode emoji and hide the markup, so an affix is also checked as submitted.
    const checked =
      format === "affix" && hasCustomEmojiMarkup(submitted)
        ? validateSettingFormat(format, submitted)
        : validateSettingFormat(format, value);
    if (checked.ok) {
      value = checked.value;
    } else if (
      current !== undefined &&
      current !== null &&
      // The stored value is exempt as it was submitted: a shortcode in it
      // resolves to a longer text above, which must not make the unchanged
      // field fail.
      (submitted === String(current) || value === String(current))
    ) {
      value = String(current);
    } else {
      return { ok: false, reason: checked.reason };
    }
  }
  // Cron keys are re-armed on save (#976), so a value the scheduler can't
  // parse would stop a running job. Refuse it at the write boundary instead,
  // and store the sanitized form (wrapping quotes trimmed) the job will arm.
  if (settingsMetadata[key as keyof typeof settingsMetadata]?.type === "cron") {
    value = sanitizeCronExpression(value);
    if (!isValidCronExpression(value)) {
      return { ok: false, reason: "invalid cron expression" };
    }
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

/** Why an import refuses a key whose stored value cannot be read. */
export const IMPORT_BASELINE_FAILED_REASON =
  "the stored value could not be read, so this key was not imported; try again";

/**
 * Whether `coerceConfigValue` has a stored-value exemption for `key`: a
 * picker-format string or a bounded number. Only those need a baseline.
 */
export function needsStoredBaseline(key: string): boolean {
  if (!(key in defaultConfig)) return false;
  const meta = settingsMetadata[key as keyof typeof settingsMetadata];
  const expected = typeof defaultConfig[key as keyof typeof defaultConfig];
  if (expected === "string") return Boolean(meta?.format);
  if (expected === "number") {
    return meta?.min !== undefined || meta?.max !== undefined;
  }
  return false;
}

/**
 * The stored value of `key` for `coerceConfigValue`'s `current`, read strictly
 * so a failed database read is reported instead of falling back to a default
 * (which would make an unchanged legacy value look changed, or the reverse).
 * Keys without a stored-value exemption yield `current: undefined`, no read.
 */
export async function readStoredBaseline(
  key: string,
): Promise<{ ok: true; current: unknown } | { ok: false }> {
  if (!needsStoredBaseline(key)) return { ok: true, current: undefined };
  const fallback = defaultConfig[key as keyof typeof defaultConfig];
  try {
    const config = ConfigService.getInstance();
    return {
      ok: true,
      current:
        typeof fallback === "number"
          ? await config.getNumberStrict(key, fallback)
          : await config.getStringStrict(key, String(fallback)),
    };
  } catch {
    return { ok: false };
  }
}

/**
 * Pick the cascade "master" toggle for a Settings section among the submitted
 * keys: the boolean two-segment `<category>.enabled` key. Uses the same
 * `pickCascadeMasterKey` as `findCascadeMasterKey` in admin-views so the
 * server skips exactly the dependents the client greyed out (#485, #1068).
 * Returns null when the section has no such key.
 */
export function findSectionMasterKey(
  keys: string[],
  sectionCategory?: string,
): string | null {
  return pickCascadeMasterKey(
    keys.map((key) => ({
      key,
      isBoolean:
        typeof defaultConfig[key as keyof typeof defaultConfig] === "boolean",
      // The posted section is the one the client grouped by (the stored row's
      // category), so prefer it over schema metadata to pick the same master.
      category:
        sectionCategory ||
        settingsMetadata[key as keyof typeof settingsMetadata]?.category ||
        key.split(".")[0],
    })),
  );
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

/**
 * A role that already backs a role group can't be chosen for another feature
 * (#1023): a leaderboard tier would take it back from members on the next
 * run, and a birthday role would hand it out. Returns an operator-facing
 * message naming the group, or null when every role in `roleIds` is fine.
 *
 * Roles in `keep` are the feature's current choices; they are never reported,
 * so an existing collision is not blocked on every unrelated save (it keeps
 * working, and the group page lists it as feature-used). Stored config is
 * never cleared. If the groups can't be read this logs and allows the write:
 * the guard protects a choice, it is not an access check.
 */
export async function findGroupRoleReuse(
  guildId: string,
  roleIds: readonly string[],
  keep: readonly string[] = [],
): Promise<string | null> {
  const fresh = roleIds.filter((id) => id !== "" && !keep.includes(id));
  if (fresh.length === 0) return null;
  try {
    const hits = await RoleGroupService.getInstance().groupBackedRoles(
      guildId,
      fresh,
    );
    if (hits.length === 0) return null;
    const names = [...new Set(hits.map((h) => `"${h.groupName}"`))].join(", ");
    return `That role backs the role group ${names}, so another feature can't use it. Pick a different role, or manage the role through the group.`;
  } catch (err) {
    logger.warn("group role reuse check: role groups unreadable", err);
    return null;
  }
}

/**
 * Role ids a role-granting setting's value names (empty for any other key).
 * Driven by the shared list in `role-grants.ts`, so every setting a feature
 * hands a role out through gets the same guards.
 */
export function guardedRoleIds(key: string, value: unknown): string[] {
  return grantedRoleIds(key, value);
}

/**
 * {@link findGroupRoleReuse} for a settings write: for the birthday role and
 * the leaderboard tiers, refuse a role that backs a group unless the setting
 * already held it. `before` is the stored value (or default).
 */
export async function findGroupRoleReuseForSetting(
  guildId: string,
  key: string,
  value: unknown,
  before: unknown,
): Promise<string | null> {
  const roleIds = guardedRoleIds(key, value);
  if (roleIds.length === 0) return null;
  return findGroupRoleReuse(guildId, roleIds, guardedRoleIds(key, before));
}

/**
 * Validator for the settings that hand a role out automatically (the birthday
 * role and the leaderboard tiers): refuse a newly chosen role that carries
 * Administrator or another permission from `SELF_ASSIGN_FORBIDDEN_PERMISSIONS`
 * (#1145), naming the permissions. Returns an operator-facing message, or null
 * when every newly chosen role is fine.
 *
 * Roles `before` already held are never reported, so an existing choice does
 * not block unrelated saves; the services stop granting it instead, and stored
 * config is never changed. A role that no longer exists is left to the
 * existing checks. Fails closed when the guild's roles can't be read, since
 * this guards a security decision.
 */
export async function findPowerfulRoleForSetting(
  client: Client,
  guildId: string,
  key: string,
  value: unknown,
  before: unknown,
): Promise<string | null> {
  const keep = guardedRoleIds(key, before);
  const fresh = guardedRoleIds(key, value).filter((id) => !keep.includes(id));
  if (fresh.length === 0) return null;
  try {
    const guild = await client.guilds.fetch(guildId);
    await guild.roles.fetch();
    for (const id of fresh) {
      const role = guild.roles.cache.get(id);
      if (!role) continue;
      const powerful = forbiddenSelfAssignPermissions(role);
      if (powerful.length > 0) {
        return `@${role.name} has powerful permissions (${powerful.join(", ")}), so it can't be handed out automatically: every member who qualifies would receive them. Remove those permissions from the role or pick a different one.`;
      }
    }
    return null;
  } catch (err) {
    logger.warn("powerful role check: guild roles unreadable", err);
    return "Could not read the server's roles from Discord to check that role. Try again.";
  }
}
