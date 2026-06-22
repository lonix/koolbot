/**
 * Route handlers for the user self-service surface (#481).
 *
 * Mounted at `/me`. Every handler runs behind `requireSession`, accepts
 * either an `admin`-role or `user`-role session (admins are guild
 * members too — they have their own preferences/Rewind), and enforces
 * self-scope via `assertSelfScope`: a session may only read/write rows
 * keyed by `(session.userId, session.guildId)`. v1 ships a single stub
 * index page; sub-issues #482/#484 add real content.
 */

import {
  Router,
  type NextFunction,
  type Response,
  type RequestHandler,
} from "express";
import { Client } from "discord.js";
import logger from "../utils/logger.js";
import { WebSessionService } from "../services/web-session-service.js";
import {
  NOTIFICATION_PREF_KEYS,
  UserNotificationPrefsService,
  type NotificationPrefKey,
  type NotificationPrefs,
} from "../services/user-notification-prefs-service.js";
import { ConfigService } from "../services/config-service.js";
import { requireCsrf } from "./csrf.js";
import {
  AuthenticatedRequest,
  clearSessionCookie,
  createSessionPingHandler,
  type WebSessionContext,
} from "./session.js";
import { getDisplayedRemainingMs } from "./admin-layout.js";
import {
  renderUserBirthdayBody,
  renderUserIndexBody,
  renderUserNotificationsBody,
  renderUserPage,
  renderUserRewindBody,
  renderUserTimezoneBody,
  renderUserVoiceBody,
  type UserFlashMessage,
  type VoicePresetView,
} from "./user-layout.js";
import { BirthdayService } from "../services/birthday-service.js";
import {
  UserVoicePrefsService,
  VoicePrefsValidationError,
} from "../services/user-voice-prefs-service.js";
import {
  getServerTimezone,
  listSupportedTimezones,
} from "../utils/timezone.js";
import {
  RewindService,
  formatFunComparison,
  formatHoursMinutes,
} from "../services/rewind-service.js";
import { recordAudit } from "./audit.js";
import { renderSignedOut } from "./views.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";

function asyncHandler(
  fn: (req: AuthenticatedRequest, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next: NextFunction): void => {
    fn(req as AuthenticatedRequest, res).catch(next);
  };
}

function getCsrfToken(req: AuthenticatedRequest): string {
  return (req as AuthenticatedRequest & { csrfToken?: string }).csrfToken ?? "";
}

function readCheckbox(value: unknown): boolean {
  // The page posts "true" when checked; absent → unchecked.
  if (typeof value === "string") return value === "true" || value === "on";
  return value === true;
}

const NOTIFICATION_FLASH_MAX = 300;

function flashUrl(path: string, flash: UserFlashMessage): string {
  const text =
    flash.text.length > NOTIFICATION_FLASH_MAX
      ? `${flash.text.slice(0, NOTIFICATION_FLASH_MAX - 1)}…`
      : flash.text;
  const qs = new globalThis.URLSearchParams({
    flash: flash.type,
    msg: text,
  }).toString();
  return `${path}?${qs}`;
}

function readFlashFromQuery(
  req: AuthenticatedRequest,
): UserFlashMessage | null {
  const type = String(req.query.flash ?? "");
  const text = String(req.query.msg ?? "");
  if (!text) return null;
  if (type !== "ok" && type !== "warn" && type !== "err") return null;
  return {
    type,
    text:
      text.length > NOTIFICATION_FLASH_MAX
        ? `${text.slice(0, NOTIFICATION_FLASH_MAX - 1)}…`
        : text,
  };
}

interface NotificationRowDef {
  key: NotificationPrefKey;
  label: string;
  description: string;
  comingSoon?: string;
}

const NOTIFICATION_ROW_DEFS: readonly NotificationRowDef[] = [
  {
    key: "achievements",
    label: "Achievement DMs",
    description:
      "Direct messages from Koolbot when you earn a new accolade or badge.",
  },
  {
    key: "digest",
    label: "Weekly digest",
    description:
      "Once-a-week DM summarising your activity and the server's highlights.",
  },
  {
    key: "rewind",
    label: "Year-in-review (Rewind)",
    description:
      "End-of-year DM nudge with a link to your personal recap at /me/rewind.",
  },
];

function buildNotificationRows(prefs: NotificationPrefs): Array<{
  key: string;
  label: string;
  description: string;
  enabled: boolean;
  comingSoon?: string;
}> {
  return NOTIFICATION_ROW_DEFS.map((def) => ({
    key: def.key,
    label: def.label,
    description: def.description,
    enabled: prefs[def.key],
    comingSoon: def.comingSoon,
  }));
}

/**
 * Enforce that the session may only act on rows belonging to itself —
 * both the Discord user id and the guild id must match the session's.
 *
 * Crucially this applies to admin-role sessions too. An admin who
 * lands on `/me/notifications` to manage their own prefs sees their
 * own row; if they ever try to pass `?userId=someone-else` on a write,
 * this helper rejects it. Admins who need to act on another user's
 * data use the admin panel's audit/user tooling, not impersonation on
 * `/me/*`. See #481 acceptance.
 *
 * Returns the validated `(userId, guildId)` pair. Throws `SelfScopeError`
 * on mismatch — handlers wrap their bodies in `asyncHandler` so the
 * thrown error reaches the WebUI error pipeline and renders a 403.
 */
export function assertSelfScope(
  session: WebSessionContext,
  target: { userId: string; guildId: string },
): { userId: string; guildId: string } {
  if (
    target.userId !== session.discordUserId ||
    target.guildId !== session.guildId
  ) {
    throw new SelfScopeError(
      `Session ${session.sessionId} (user=${session.discordUserId} guild=${session.guildId} role=${session.role}) ` +
        `attempted to access user=${target.userId} guild=${target.guildId}`,
    );
  }
  return { userId: session.discordUserId, guildId: session.guildId };
}

export class SelfScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelfScopeError";
  }
}

/**
 * Whether the Rewind feature (the `/me/rewind` page + its nav entry) is
 * enabled (#608). Distinct from the end-of-year DM nudge, which has its
 * own `rewind.nudge.enabled` toggle handled by `RewindNudgeService`.
 * Defaults to `false`, following the repo's opt-in feature-gate convention.
 */
async function isRewindFeatureEnabled(): Promise<boolean> {
  return ConfigService.getInstance().getBoolean("rewind.enabled", false);
}

/**
 * Whether the per-user voice-preferences feature (`/me/voice` + its nav
 * entry) is enabled (#656). Shares the `voicechannels.presets.enabled`
 * gate with the Discord modal surface so both turn on together. Defaults
 * to `false`, following the repo's opt-in feature-gate convention.
 */
async function isVoicePresetsEnabled(): Promise<boolean> {
  return ConfigService.getInstance().getBoolean(
    "voicechannels.presets.enabled",
    false,
  );
}

/**
 * Whether birthday celebrations are enabled (#657). Used only to soften
 * the `/me/birthday` page copy — the page stays reachable either way so
 * members can pre-set their date before an admin flips the feature on.
 */
async function isBirthdayFeatureEnabled(): Promise<boolean> {
  return ConfigService.getInstance().getBoolean("birthdays.enabled", false);
}

/**
 * Resolve the session user's display name for the name-pattern preview.
 * Best-effort: falls back to the raw user id when the member can't be
 * fetched (e.g. left the guild), so the page still renders.
 */
async function resolveDisplayName(
  client: Client,
  guildId: string,
  userId: string,
): Promise<string> {
  try {
    const guild =
      client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId));
    const member = await guild.members.fetch(userId);
    return member.displayName;
  } catch {
    return userId;
  }
}

/**
 * Parse an optional integer form field, treating blank as "unset". A
 * non-integer (e.g. "1.9", "abc") yields `NaN` so callers reject it rather
 * than silently truncating — the service's bounds are integer-only.
 */
function parseOptionalInt(raw: unknown): number | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const n = Number(trimmed);
  return Number.isInteger(n) ? n : NaN;
}

/**
 * Parse an optional integer field from a posted form. Returns `null` for
 * blank/absent values and `NaN` for non-numeric junk so the caller can
 * tell "not provided" from "provided but invalid".
 */
function parseIntField(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  return Number.parseInt(trimmed, 10);
}

function toPresetViews(
  presets: {
    name: string;
    channelName?: string;
    userLimit?: number;
    bitrate?: number;
    isDefault?: boolean;
  }[],
): VoicePresetView[] {
  return presets.map((p, index) => ({
    index,
    name: p.name,
    channelName: p.channelName ?? null,
    userLimit: typeof p.userLimit === "number" ? p.userLimit : null,
    bitrate: typeof p.bitrate === "number" ? p.bitrate : null,
    isDefault: !!p.isDefault,
  }));
}

function parseYearParam(raw: unknown, fallback: number): number {
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  const n = Number.parseInt(raw, 10);
  // Clamp to a plausible range so a junk URL can't produce a billion-year
  // query against Mongo. Years before the project existed have no data
  // anyway; far-future years are nonsense.
  if (!Number.isFinite(n) || n < 2000 || n > 9999) return fallback;
  return n;
}

export function createUserRouter(
  client: Client,
  requireSession: RequestHandler,
): Router {
  const router = Router();

  // Surface-local session ping so the `/me` banner script never has to
  // reach across to `/admin/session/ping`. Identical handler (the ping
  // is surface-neutral — same cookie, same DB row), just mounted on
  // both routers so a future split of the admin mount can't silently
  // break the countdown on `/me/*`. Mounted BEFORE `requireSession` for
  // the same reason the admin copy is: the ping itself does its own
  // (non-mutating) cookie + DB validation and must NOT bump `act`.
  router.get("/session/ping", createSessionPingHandler());

  router.use(requireSession);

  // ---------- Index ----------
  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const session = req.webSession;
      if (!session) {
        // `requireSession` guarantees this, but the type narrower
        // doesn't know that without an explicit check.
        res.status(500).type("text/plain").send("session missing");
        return;
      }
      const rewindEnabled = await isRewindFeatureEnabled();
      const presetsEnabled = await isVoicePresetsEnabled();
      res.type("text/html").send(
        renderUserPage({
          title: "Overview",
          active: "/me/",
          body: renderUserIndexBody({
            discordUserId: session.discordUserId,
            guildId: session.guildId,
            isAdmin: session.role === "admin",
            rewindEnabled,
            presetsEnabled,
          }),
          csrfToken: getCsrfToken(req),
          remainingMs: getDisplayedRemainingMs(session),
          isAdmin: session.role === "admin",
          rewindEnabled,
          presetsEnabled,
        }),
      );
    }),
  );

  // ---------- Notifications (#482) ----------
  router.get(
    "/notifications",
    asyncHandler(async (req, res) => {
      const session = req.webSession;
      if (!session) {
        res.status(500).type("text/plain").send("session missing");
        return;
      }
      const { userId, guildId } = assertSelfScope(session, {
        userId: session.discordUserId,
        guildId: session.guildId,
      });
      const prefs = await UserNotificationPrefsService.getInstance().getPrefs(
        userId,
        guildId,
      );
      const flash = readFlashFromQuery(req);
      res.type("text/html").send(
        renderUserPage({
          title: "Notifications",
          active: "/me/notifications",
          body: renderUserNotificationsBody({
            csrfToken: getCsrfToken(req),
            rows: buildNotificationRows(prefs),
          }),
          csrfToken: getCsrfToken(req),
          remainingMs: getDisplayedRemainingMs(session),
          isAdmin: session.role === "admin",
          flash,
          rewindEnabled: await isRewindFeatureEnabled(),
          presetsEnabled: await isVoicePresetsEnabled(),
        }),
      );
    }),
  );

  router.post(
    "/notifications",
    requireCsrf,
    asyncHandler(async (req, res) => {
      const session = req.webSession;
      if (!session) {
        res.status(500).type("text/plain").send("session missing");
        return;
      }
      const { userId, guildId } = assertSelfScope(session, {
        userId: session.discordUserId,
        guildId: session.guildId,
      });

      const body = (req.body as Record<string, unknown> | undefined) ?? {};
      const service = UserNotificationPrefsService.getInstance();
      const before = await service.getPrefs(userId, guildId);

      // Per-row toggle: the page submits a hidden `submitted_<key>` flag
      // alongside each checkbox, so we can distinguish "explicitly off"
      // (flag present, checkbox absent) from "row not on this page"
      // (flag absent — leave the stored value alone). Without the
      // hidden flag a single missing checkbox would silently default to
      // "false" on every save and quietly reset opt-ins on unrelated
      // rows that future sub-issues append.
      const patch: Partial<NotificationPrefs> = {};
      for (const key of NOTIFICATION_PREF_KEYS) {
        const submitted = body[`submitted_${key}`];
        if (typeof submitted !== "string" || submitted.length === 0) continue;
        patch[key] = readCheckbox(body[key]);
      }

      let result: "success" | "failure" = "success";
      let errorMessage: string | null = null;
      let after: NotificationPrefs = before;
      try {
        after = await service.setPrefs(userId, guildId, patch);
      } catch (err) {
        result = "failure";
        errorMessage = err instanceof Error ? err.message : String(err);
        logger.error("Failed to save notification prefs", err);
      }

      // Diff only the keys that actually changed so the audit row stays
      // small and the row count grows linearly with deliberate toggles.
      const changed = NOTIFICATION_PREF_KEYS.reduce<Record<string, unknown>>(
        (acc, key) => {
          if (before[key] !== after[key]) {
            acc[key] = { before: before[key], after: after[key] };
          }
          return acc;
        },
        {},
      );

      await recordAudit(session, {
        action: "user.notifications.set",
        targetId: userId,
        details:
          result === "success"
            ? { changed, submitted: Object.keys(patch) }
            : { submitted: Object.keys(patch) },
        result,
        errorMessage,
      });

      const flash: UserFlashMessage =
        result === "failure"
          ? {
              type: "err",
              text: `Could not save your notification preferences: ${errorMessage ?? "unknown error"}.`,
            }
          : Object.keys(changed).length === 0
            ? { type: "ok", text: "No changes — preferences already match." }
            : {
                type: "ok",
                text: `Saved ${Object.keys(changed).length} preference change${Object.keys(changed).length === 1 ? "" : "s"}.`,
              };
      res.redirect(303, flashUrl("/me/notifications", flash));
    }),
  );

  // ---------- Timezone (#524) ----------
  router.get(
    "/timezone",
    asyncHandler(async (req, res) => {
      const session = req.webSession;
      if (!session) {
        res.status(500).type("text/plain").send("session missing");
        return;
      }
      const { userId, guildId } = assertSelfScope(session, {
        userId: session.discordUserId,
        guildId: session.guildId,
      });
      const selected =
        await UserNotificationPrefsService.getInstance().getTimezone(
          userId,
          guildId,
        );
      const flash = readFlashFromQuery(req);
      res.type("text/html").send(
        renderUserPage({
          title: "Timezone",
          active: "/me/timezone",
          body: renderUserTimezoneBody({
            csrfToken: getCsrfToken(req),
            zones: listSupportedTimezones(),
            selected,
            serverTimezone: getServerTimezone(),
          }),
          csrfToken: getCsrfToken(req),
          remainingMs: getDisplayedRemainingMs(session),
          isAdmin: session.role === "admin",
          flash,
          rewindEnabled: await isRewindFeatureEnabled(),
          presetsEnabled: await isVoicePresetsEnabled(),
        }),
      );
    }),
  );

  router.post(
    "/timezone",
    requireCsrf,
    asyncHandler(async (req, res) => {
      const session = req.webSession;
      if (!session) {
        res.status(500).type("text/plain").send("session missing");
        return;
      }
      const { userId, guildId } = assertSelfScope(session, {
        userId: session.discordUserId,
        guildId: session.guildId,
      });

      const body = (req.body as Record<string, unknown> | undefined) ?? {};
      // Strip line breaks before the value reaches the service: it gets
      // echoed back in `setTimezone`'s validation error (and from there
      // into our logs), and a CR/LF could forge a log line. No valid IANA
      // identifier contains a newline, so this never rejects a real zone.
      const raw =
        typeof body.timezone === "string"
          ? body.timezone.replace(/[\r\n]+/g, "").trim()
          : "";
      const service = UserNotificationPrefsService.getInstance();
      const before = await service.getTimezone(userId, guildId);

      let result: "success" | "failure" = "success";
      let errorMessage: string | null = null;
      let after: string | null = before;
      try {
        after = await service.setTimezone(
          userId,
          guildId,
          raw === "" ? null : raw,
        );
      } catch (err) {
        result = "failure";
        errorMessage = err instanceof Error ? err.message : String(err);
        logger.error(
          `Failed to save user timezone: ${sanitizeForLog(errorMessage)}`,
        );
      }

      await recordAudit(session, {
        action: "user.timezone.set",
        targetId: userId,
        details: result === "success" ? { before, after } : { attempted: raw },
        result,
        errorMessage,
      });

      let flash: UserFlashMessage;
      if (result === "failure") {
        flash = {
          type: "err",
          text: `Could not save your timezone: ${errorMessage ?? "unknown error"}.`,
        };
      } else if (before === after) {
        flash = { type: "ok", text: "No change — timezone already set." };
      } else if (after === null) {
        flash = {
          type: "ok",
          text: "Cleared your timezone — Koolbot will use the server timezone.",
        };
      } else {
        flash = { type: "ok", text: `Saved your timezone as ${after}.` };
      }
      res.redirect(303, flashUrl("/me/timezone", flash));
    }),
  );

  // ---------- Birthday (#657) ----------
  router.get(
    "/birthday",
    asyncHandler(async (req, res) => {
      const session = req.webSession;
      if (!session) {
        res.status(500).type("text/plain").send("session missing");
        return;
      }
      const { userId, guildId } = assertSelfScope(session, {
        userId: session.discordUserId,
        guildId: session.guildId,
      });
      const selected = await BirthdayService.getInstance(client).getBirthday(
        userId,
        guildId,
      );
      const flash = readFlashFromQuery(req);
      res.type("text/html").send(
        renderUserPage({
          title: "Birthday",
          active: "/me/birthday",
          body: renderUserBirthdayBody({
            csrfToken: getCsrfToken(req),
            selected,
            featureEnabled: await isBirthdayFeatureEnabled(),
          }),
          csrfToken: getCsrfToken(req),
          remainingMs: getDisplayedRemainingMs(session),
          isAdmin: session.role === "admin",
          flash,
          rewindEnabled: await isRewindFeatureEnabled(),
        }),
      );
    }),
  );

  router.post(
    "/birthday",
    requireCsrf,
    asyncHandler(async (req, res) => {
      const session = req.webSession;
      if (!session) {
        res.status(500).type("text/plain").send("session missing");
        return;
      }
      const { userId, guildId } = assertSelfScope(session, {
        userId: session.discordUserId,
        guildId: session.guildId,
      });

      const body = (req.body as Record<string, unknown> | undefined) ?? {};
      const service = BirthdayService.getInstance(client);
      const before = await service.getBirthday(userId, guildId);

      // Clearing is only ever the explicit "Remove" button (which posts
      // `clear`). A plain "Save" with no month/day is a validation error,
      // not a silent delete of an existing birthday.
      const month = parseIntField(body.month);
      const day = parseIntField(body.day);
      const year = parseIntField(body.year);
      const clearing = typeof body.clear === "string" && body.clear.length > 0;

      let result: "success" | "failure" = "success";
      let errorMessage: string | null = null;
      let after = before;
      try {
        if (clearing) {
          after = await service.setBirthday(userId, guildId, null);
        } else if (month === null || day === null) {
          throw new Error("Please choose a month and enter a day.");
        } else {
          after = await service.setBirthday(userId, guildId, {
            month,
            day,
            year,
          });
        }
      } catch (err) {
        result = "failure";
        errorMessage = err instanceof Error ? err.message : String(err);
        logger.error(
          `Failed to save birthday: ${sanitizeForLog(errorMessage)}`,
        );
      }

      await recordAudit(session, {
        action: "user.birthday.set",
        targetId: userId,
        details:
          result === "success"
            ? { before, after }
            : { attempted: { month, day, year } },
        result,
        errorMessage,
      });

      let flash: UserFlashMessage;
      if (result === "failure") {
        flash = {
          type: "err",
          text: `Could not save your birthday: ${errorMessage ?? "unknown error"}.`,
        };
      } else if (after === null) {
        flash = { type: "ok", text: "Removed your birthday." };
      } else {
        flash = {
          type: "ok",
          text: `Saved your birthday as ${after.month}/${after.day}${after.year ? `/${after.year}` : ""}.`,
        };
      }
      res.redirect(303, flashUrl("/me/birthday", flash));
    }),
  );

  // ---------- Rewind (#484) ----------
  // `/me/rewind` defaults to the current calendar year (UTC); the
  // `/:year` variant lets users browse past years. Both gate on
  // `assertSelfScope` — admin sessions land on their own Rewind.
  const rewindHandler = asyncHandler(async (req, res) => {
    const session = req.webSession;
    if (!session) {
      res.status(500).type("text/plain").send("session missing");
      return;
    }
    const { userId, guildId } = assertSelfScope(session, {
      userId: session.discordUserId,
      guildId: session.guildId,
    });
    const presetsEnabled = await isVoicePresetsEnabled();

    // Feature gate (#608): when Rewind is disabled the page is not served
    // (and the nav link is already suppressed). Return a friendly disabled
    // state with 404 so the route can't be used to reach the recap while
    // off, mirroring how the nav advertisement is hidden.
    if (!(await isRewindFeatureEnabled())) {
      res
        .status(404)
        .type("text/html")
        .send(
          renderUserPage({
            title: "Rewind",
            active: "/me/rewind",
            body:
              "<h1>Rewind</h1>" +
              '<div class="notice info">The year-in-review (Rewind) feature is currently disabled on this server.</div>',
            csrfToken: getCsrfToken(req),
            remainingMs: getDisplayedRemainingMs(session),
            isAdmin: session.role === "admin",
            rewindEnabled: false,
            presetsEnabled,
          }),
        );
      return;
    }

    const currentYear = new Date().getUTCFullYear();
    // The explicit `/rewind/:year` deep-link must always honour the
    // requested year (even an empty one), so it falls back to the current
    // year only when the param is junk. The bare `/rewind` route instead
    // lands on the most recent year the user actually has data for, so a
    // visit right after the year rolls over shows a finished recap rather
    // than the empty new year (#573).
    const fallbackYear = req.params.year
      ? currentYear
      : await RewindService.getInstance(client).getDefaultRewindYear(
          userId,
          guildId,
        );
    const year = parseYearParam(req.params.year, fallbackYear);

    const timezone =
      await UserNotificationPrefsService.getInstance().getTimezone(
        userId,
        guildId,
      );
    const summary = await RewindService.getInstance(client).getSummary(
      userId,
      guildId,
      year,
      timezone,
    );

    if (!summary) {
      res
        .status(500)
        .type("text/html")
        .send(
          renderUserPage({
            title: "Rewind",
            active: "/me/rewind",
            body:
              `<h1>Rewind ${year}</h1>` +
              '<div class="notice err">Could not load your year-in-review. Please try again later.</div>',
            csrfToken: getCsrfToken(req),
            remainingMs: getDisplayedRemainingMs(session),
            isAdmin: session.role === "admin",
            rewindEnabled: true,
            presetsEnabled,
          }),
        );
      return;
    }

    res.type("text/html").send(
      renderUserPage({
        title: `Rewind ${year}`,
        active: "/me/rewind",
        body: renderUserRewindBody({
          year: summary.year,
          availableYears: summary.availableYears,
          hasData: summary.hasData,
          totalDuration: formatHoursMinutes(summary.totalSeconds),
          funComparison: formatFunComparison(summary.totalSeconds),
          sessionCount: summary.sessionCount,
          daysActive: summary.daysActive,
          topCompanions: (summary.topCompanions ?? []).map((c) => ({
            userId: c.userId,
            displayName: c.displayName,
            duration: formatHoursMinutes(c.totalSeconds),
          })),
          peakDay: summary.peakDay
            ? {
                date: summary.peakDay.date,
                duration: formatHoursMinutes(summary.peakDay.totalSeconds),
              }
            : null,
          longestSession: summary.longestSession
            ? {
                duration: formatHoursMinutes(
                  summary.longestSession.totalSeconds,
                ),
                date: summary.longestSession.date,
                channelName: summary.longestSession.channelName,
              }
            : null,
          longestStreakDays: summary.longestStreakDays,
          longestStreakRange: summary.longestStreakRange,
          accolades: summary.accolades.map((a) => ({
            emoji: a.emoji,
            name: a.name,
            description: a.description,
            earnedAt: a.earnedAt.toISOString().slice(0, 10),
          })),
          achievements: summary.achievements.map((a) => ({
            emoji: a.emoji,
            name: a.name,
            description: a.description,
            earnedAt: a.earnedAt.toISOString().slice(0, 10),
          })),
          annualRank: summary.annualRank,
          annualGuildMembers: summary.annualGuildMembers,
          percentAboveMedian: summary.percentAboveMedian,
          weeklyJourney: summary.weeklyJourney,
          messagesSent: summary.messagesSent,
          topTextChannels: summary.topTextChannels.map((c) => ({
            channelId: c.channelId,
            channelName: c.channelName,
            count: c.count,
          })),
          peakMessageDay: summary.peakMessageDay,
        }),
        csrfToken: getCsrfToken(req),
        remainingMs: getDisplayedRemainingMs(session),
        isAdmin: session.role === "admin",
        rewindEnabled: true,
        presetsEnabled,
      }),
    );
  });
  router.get("/rewind", rewindHandler);
  router.get("/rewind/:year", rewindHandler);

  // ---------- Voice preferences (#656) ----------
  // `/me/voice` manages the per-user name pattern + saved presets. It
  // shares the `voicechannels.presets.enabled` gate with the Discord
  // modal surface and reuses `UserVoicePrefsService` so the validation
  // rules never diverge between the two surfaces. Presets are created in
  // Discord (snapshot of a live channel); the web surface edits, sets the
  // default, and deletes the ones you already have.

  // Helper shared by every voice route: 404 with a friendly disabled
  // state when the feature is off (mirrors the Rewind gate, #608).
  const renderVoiceDisabled = async (
    req: AuthenticatedRequest,
    res: Response,
    session: WebSessionContext,
  ): Promise<void> => {
    res
      .status(404)
      .type("text/html")
      .send(
        renderUserPage({
          title: "Voice preferences",
          active: "/me/voice",
          body:
            "<h1>Voice preferences</h1>" +
            '<div class="notice info">Per-user voice presets are currently disabled on this server.</div>',
          csrfToken: getCsrfToken(req),
          remainingMs: getDisplayedRemainingMs(session),
          isAdmin: session.role === "admin",
          rewindEnabled: await isRewindFeatureEnabled(),
          presetsEnabled: false,
        }),
      );
  };

  router.get(
    "/voice",
    asyncHandler(async (req, res) => {
      const session = req.webSession;
      if (!session) {
        res.status(500).type("text/plain").send("session missing");
        return;
      }
      if (!(await isVoicePresetsEnabled())) {
        await renderVoiceDisabled(req, res, session);
        return;
      }
      const { userId } = assertSelfScope(session, {
        userId: session.discordUserId,
        guildId: session.guildId,
      });

      const service = UserVoicePrefsService.getInstance();
      const prefs = await service.getPrefs(userId);
      const displayName = await resolveDisplayName(
        client,
        session.guildId,
        userId,
      );
      const maxPerUser = await ConfigService.getInstance().getNumber(
        "voicechannels.presets.max_per_user",
        3,
      );
      const flash = readFlashFromQuery(req);

      res.type("text/html").send(
        renderUserPage({
          title: "Voice preferences",
          active: "/me/voice",
          body: renderUserVoiceBody({
            csrfToken: getCsrfToken(req),
            namePattern: prefs.namePattern ?? null,
            displayName,
            presets: toPresetViews(prefs.presets),
            maxPerUser,
          }),
          csrfToken: getCsrfToken(req),
          remainingMs: getDisplayedRemainingMs(session),
          isAdmin: session.role === "admin",
          flash,
          rewindEnabled: await isRewindFeatureEnabled(),
          presetsEnabled: true,
        }),
      );
    }),
  );

  router.post(
    "/voice/name-pattern",
    requireCsrf,
    asyncHandler(async (req, res) => {
      const session = req.webSession;
      if (!session) {
        res.status(500).type("text/plain").send("session missing");
        return;
      }
      if (!(await isVoicePresetsEnabled())) {
        await renderVoiceDisabled(req, res, session);
        return;
      }
      const { userId } = assertSelfScope(session, {
        userId: session.discordUserId,
        guildId: session.guildId,
      });

      const body = (req.body as Record<string, unknown> | undefined) ?? {};
      const raw =
        typeof body.namePattern === "string"
          ? body.namePattern.replace(/[\r\n]+/g, "")
          : "";

      let result: "success" | "failure" = "success";
      let errorMessage: string | null = null;
      let stored: string | null = null;
      try {
        stored = await UserVoicePrefsService.getInstance().setNamePattern(
          userId,
          raw,
        );
      } catch (err) {
        result = "failure";
        errorMessage = err instanceof Error ? err.message : String(err);
      }

      await recordAudit(session, {
        action: "user.voice.namepattern.set",
        targetId: userId,
        details:
          result === "success"
            ? { pattern: stored }
            : { attempted: sanitizeForLog(raw) },
        result,
        errorMessage,
      });

      const flash: UserFlashMessage =
        result === "failure"
          ? {
              type: "err",
              text: `Could not save your name pattern: ${errorMessage ?? "unknown error"}.`,
            }
          : stored === null
            ? { type: "ok", text: "Cleared your name pattern." }
            : { type: "ok", text: `Saved your name pattern as "${stored}".` };
      res.redirect(303, flashUrl("/me/voice", flash));
    }),
  );

  // Shared body for the three preset-mutation routes: validates the
  // `index`/`expectedName` pair, runs `op`, and PRG-redirects with a flash.
  const presetMutation = (
    action: string,
    op: (args: {
      service: UserVoicePrefsService;
      userId: string;
      index: number;
      expectedName: string;
      body: Record<string, unknown>;
    }) => Promise<{
      flash: UserFlashMessage;
      details: Record<string, unknown>;
    }>,
  ): RequestHandler =>
    asyncHandler(async (req, res) => {
      const session = req.webSession;
      if (!session) {
        res.status(500).type("text/plain").send("session missing");
        return;
      }
      if (!(await isVoicePresetsEnabled())) {
        await renderVoiceDisabled(req, res, session);
        return;
      }
      const { userId } = assertSelfScope(session, {
        userId: session.discordUserId,
        guildId: session.guildId,
      });

      const body = (req.body as Record<string, unknown> | undefined) ?? {};
      const index = parseOptionalInt(body.index);
      const expectedName =
        typeof body.expectedName === "string" ? body.expectedName : "";

      let result: "success" | "failure" = "success";
      let errorMessage: string | null = null;
      let flash: UserFlashMessage;
      let details: Record<string, unknown> = {};

      if (index === undefined || index === null || Number.isNaN(index)) {
        result = "failure";
        errorMessage = "Invalid preset reference.";
        flash = {
          type: "err",
          text: "Could not find that preset — reload the page and try again.",
        };
      } else {
        try {
          const out = await op({
            service: UserVoicePrefsService.getInstance(),
            userId,
            index,
            expectedName,
            body,
          });
          flash = out.flash;
          details = out.details;
        } catch (err) {
          result = "failure";
          errorMessage = err instanceof Error ? err.message : String(err);
          flash = {
            type: err instanceof VoicePrefsValidationError ? "warn" : "err",
            text:
              err instanceof VoicePrefsValidationError
                ? errorMessage
                : `Could not update the preset: ${errorMessage}.`,
          };
        }
      }

      await recordAudit(session, {
        action,
        targetId: userId,
        details: { ...details, index, expectedName },
        result,
        errorMessage,
      });

      res.redirect(303, flashUrl("/me/voice", flash));
    });

  router.post(
    "/voice/preset/edit",
    requireCsrf,
    presetMutation(
      "user.voice.preset.edit",
      async ({ service, userId, index, expectedName, body }) => {
        const name = typeof body.name === "string" ? body.name : "";
        const channelName =
          typeof body.channelName === "string" ? body.channelName : undefined;
        const userLimit = parseOptionalInt(body.userLimit);
        const bitrate = parseOptionalInt(body.bitrate);
        // NaN means "present but not a number" — surface a friendly error
        // rather than passing it to the validator as a bound check.
        if (Number.isNaN(userLimit)) {
          throw new VoicePrefsValidationError("User limit must be a number.");
        }
        if (Number.isNaN(bitrate)) {
          throw new VoicePrefsValidationError("Bitrate must be a number.");
        }
        const saved = await service.editPreset(
          userId,
          index,
          { name, channelName, userLimit, bitrate },
          expectedName,
        );
        return {
          flash: { type: "ok", text: `Saved changes to "${saved.name}".` },
          details: { name: saved.name },
        };
      },
    ),
  );

  router.post(
    "/voice/preset/default",
    requireCsrf,
    presetMutation(
      "user.voice.preset.default",
      async ({ service, userId, index, expectedName }) => {
        const { name, isDefault } = await service.setDefault(
          userId,
          index,
          expectedName,
        );
        return {
          flash: {
            type: "ok",
            text: isDefault
              ? `"${name}" will auto-apply on your next channel.`
              : `"${name}" is no longer the default.`,
          },
          details: { name, isDefault },
        };
      },
    ),
  );

  router.post(
    "/voice/preset/delete",
    requireCsrf,
    presetMutation(
      "user.voice.preset.delete",
      async ({ service, userId, index, expectedName }) => {
        const { name } = await service.deletePreset(
          userId,
          index,
          expectedName,
        );
        return {
          flash: { type: "ok", text: `Deleted preset "${name}".` },
          details: { name },
        };
      },
    ),
  );

  // ---------- Finish (sign out) ----------
  // CSRF-checked, same pattern as `/admin/finish`. The session row is
  // revoked server-side so the cookie cannot be re-used elsewhere.
  router.post(
    "/finish",
    requireCsrf,
    asyncHandler(async (req, res) => {
      const ctx = req.webSession;
      if (ctx) {
        await WebSessionService.getInstance().revokeSession(ctx.sessionId);
      }
      clearSessionCookie(res);
      res.status(200).type("text/html").send(renderSignedOut());
    }),
  );

  return router;
}
