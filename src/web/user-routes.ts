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
  type Request,
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
import {
  readMeNotificationAvailability,
  readMeSurfaceFlagsStrict,
  type MeNotificationAvailability,
  type MeSurfaceFlags,
} from "./me-surfaces.js";
import { requireCsrf } from "./csrf.js";
import {
  AuthenticatedRequest,
  clearSessionCookie,
  createSessionPingHandler,
  hasScope,
  requireScopeMiddleware,
  type WebSessionContext,
} from "./session.js";
import { getDisplayedRemainingMs } from "./admin-layout.js";
import {
  renderUserBirthdayBody,
  renderUserIndexBody,
  renderUserNotificationsBody,
  renderUserPage,
  renderUserPrivacyBody,
  renderUserRewindBody,
  renderUserTimezoneBody,
  renderUserVoiceBody,
  BIRTHDAY_FORM_ID,
  PRIVACY_RESET_CONFIRM_WORD,
  VOICE_NAME_PATTERN_FORM_ID,
  voicePresetFormId,
  type UserFeatureFlags,
  type UserFlashMessage,
  type VoicePresetView,
} from "./user-layout.js";
import {
  BirthdayFieldError,
  BirthdayService,
  type BirthdayPurgeResult,
} from "../services/birthday-service.js";
import {
  UserVoicePrefsService,
  VoicePrefsValidationError,
} from "../services/user-voice-prefs-service.js";
import {
  addFieldError,
  type FormErrors,
  type FormValues,
  type RefusedForm,
} from "./form-errors.js";
import {
  formatDateTimeInZone,
  formatInZone,
  getServerTimezone,
  resolveTimezone,
} from "../utils/timezone.js";
import {
  RewindService,
  formatFunComparison,
  formatHoursMinutes,
} from "../services/rewind-service.js";
import { PollParticipationTracker } from "../services/poll-participation-tracker.js";
import {
  createExportProgress,
  UserDataExportService,
} from "../services/user-data-export-service.js";
import {
  EXCLUDED_USER_DATA,
  EXPORTABLE_USER_DATA,
  summariseByCollection,
} from "../services/user-data-registry.js";
import { createRateLimiter } from "./rate-limit.js";
import {
  boundAuditEntry,
  recordAudit as recordAuditUnbounded,
  recordAuditOrThrow as recordAuditOrThrowUnbounded,
  type AuditEntry,
} from "./audit.js";
import { WebAuditLog } from "../models/web-audit-log.js";
import {
  UserDataDeletionService,
  type PurgeReport,
} from "../services/user-data-deletion-service.js";
import { renderSignedOut } from "./views.js";
import { TrackingOptOutService } from "../services/tracking-opt-out-service.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";
import { createHostEventsRouter } from "./routes/host-events.js";
import { createMeNewEventRouter } from "./routes/me-new-event.js";
import { createMeEventsRouter } from "./routes/me-events.js";
import { createMeModerationRouter } from "./routes/me-moderation.js";
import { createMeEventPresetsRouter } from "./routes/me-event-presets.js";
import { listHostedEvents } from "./event-host.js";
import { readMemberZone } from "./member-timezone.js";
import {
  birthdayValue,
  notificationsValue,
  privacyValue,
  timezoneValue,
  voiceValue,
} from "./me-preference-values.js";

// Everything on the `/me` surface may carry member-supplied strings, so every
// audit row written from here is bounded first (#1142).
const recordAudit = (
  session: Parameters<typeof recordAuditUnbounded>[0],
  entry: AuditEntry,
): Promise<void> => recordAuditUnbounded(session, boundAuditEntry(entry));
const recordAuditOrThrow = (
  session: Parameters<typeof recordAuditOrThrowUnbounded>[0],
  entry: AuditEntry,
): Promise<void> =>
  recordAuditOrThrowUnbounded(session, boundAuditEntry(entry));

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

type PreferenceValueKey =
  "notifications" | "timezone" | "voice" | "birthday" | "privacy";

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
      "Direct messages from KoolBot when you earn a new accolade or badge.",
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

/**
 * The rows to offer: only DMs the server can send (#1292). A hidden row keeps
 * its stored value untouched and shows it again once the feature is back on.
 */
function buildNotificationRows(
  prefs: NotificationPrefs,
  available: MeNotificationAvailability,
): Array<{
  key: string;
  label: string;
  description: string;
  enabled: boolean;
  comingSoon?: string;
}> {
  return NOTIFICATION_ROW_DEFS.filter((def) => available[def.key]).map(
    (def) => ({
      key: def.key,
      label: def.label,
      description: def.description,
      enabled: prefs[def.key],
      comingSoon: def.comingSoon,
    }),
  );
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
 * Whether per-user poll-participation capture is enabled (#655). Gates the
 * read-only "Poll participation" card on the `/me/` overview: when off we
 * skip the lookup entirely and the card is omitted (no rows exist anyway).
 */
async function isPollParticipationEnabled(): Promise<boolean> {
  return ConfigService.getInstance().getBoolean(
    "polls.participation.enabled",
    false,
  );
}

/**
 * Whether the self-service data export (`/me/privacy` + its download) is
 * enabled (#719). Defaults to `false`, following the repo's opt-in
 * feature-gate convention: until an operator opts in, the page shows the
 * shared "off" banner and the export route refuses.
 */
async function isPrivacyExportEnabled(): Promise<boolean> {
  return (await readMeSurfaceFlagsStrict()).privacyEnabled;
}

/**
 * Whether the self-service data reset (#917) is enabled. Its own opt-in
 * gate, off by default: turning the export on is not consent to the
 * destructive half. It also needs the export itself on — the reset lives
 * on the `/me/privacy` page, which is hidden behind `privacy.enabled`.
 *
 * Returns the keys that are off (empty when the reset is enabled), so a
 * refusal can name the setting an operator actually has to change.
 */
async function getPrivacyResetDisabledKeys(): Promise<string[]> {
  const config = ConfigService.getInstance();
  const [exportOn, resetOn] = await Promise.all([
    config.getBoolean("privacy.enabled", false),
    config.getBoolean("privacy.delete.enabled", false),
  ]);
  const off: string[] = [];
  if (!exportOn) off.push("privacy.enabled");
  if (!resetOn) off.push("privacy.delete.enabled");
  return off;
}

async function isPrivacyResetEnabled(): Promise<boolean> {
  return (await getPrivacyResetDisabledKeys()).length === 0;
}

/** `privacy.delete.cooldown_hours`, clamped to a non-negative number. */
async function getPrivacyResetCooldownHours(): Promise<number> {
  const hours = await ConfigService.getInstance().getNumber(
    "privacy.delete.cooldown_hours",
    168,
  );
  return Number.isFinite(hours) && hours > 0 ? hours : 0;
}

/**
 * Keys that stop a member *starting* a tracking opt-out (#918); empty when
 * it is offered. Only the offer is gated: an opt-out on file is always
 * honoured by the trackers, and opting back in is never refused.
 */
async function getTrackingOptOutDisabledKeys(): Promise<string[]> {
  const config = ConfigService.getInstance();
  const [exportOn, optOutOn] = await Promise.all([
    config.getBoolean("privacy.enabled", false),
    config.getBoolean("privacy.tracking_opt_out.enabled", false),
  ]);
  const off: string[] = [];
  if (!exportOn) off.push("privacy.enabled");
  if (!optOutOn) off.push("privacy.tracking_opt_out.enabled");
  return off;
}

/** Audit action for every tracking opt-out / opt-in row (#918). */
const TRACKING_OPT_OUT_ACTION = "user.privacy.tracking";

/** Audit action for every row the data reset writes (#917). */
const PRIVACY_RESET_ACTION = "user.privacy.delete";

/**
 * Members with a reset currently running in this process, keyed
 * `guildId:userId`. Closes the gap between the cooldown check and the intent
 * row being written: without it, two requests fired together could both see
 * no prior reset and both pass. The bot runs as a single process (one
 * gateway connection), so an in-memory set is the whole of the race.
 */
const resetsInFlight = new Set<string>();

/**
 * When this member's last reset started, if it still counts against the
 * cooldown — read back from the Web UI audit log rather than an in-memory
 * map, so a restart or a second IP does not reset the clock.
 *
 * Keyed on the **intent** row, which is written (fail-closed) before any
 * data is touched, not on the completed row, which is written after. So a
 * completed row that fails to write, or a process that dies mid-purge,
 * still leaves the cooldown in force. The one thing that lifts it is a
 * *recorded* failure after that intent — a purge that reported incomplete
 * steps or threw — since that is exactly the case where the member should
 * be able to retry, and every purge step is idempotent. The audit log is
 * `retain` in the registry, so the purge never erases the rows this reads.
 */
async function findActiveResetCooldown(
  userId: string,
  guildId: string,
  cooldownHours: number,
): Promise<Date | null> {
  if (cooldownHours <= 0) return null;
  const since = new Date(Date.now() - cooldownHours * 60 * 60 * 1000);
  const base = { guildId, discordUserId: userId, action: PRIVACY_RESET_ACTION };
  const intent = await WebAuditLog.findOne({
    ...base,
    "details.phase": "intent",
    createdAt: { $gte: since },
  })
    .sort({ createdAt: -1 })
    .lean();
  if (!intent) return null;
  const startedAt = new Date(intent.createdAt);
  const failedAfter = await WebAuditLog.findOne({
    ...base,
    "details.phase": "completed",
    result: "failure",
    createdAt: { $gte: startedAt },
  }).lean();
  return failedAfter ? null : startedAt;
}

/**
 * Resolve the enabled-state of every feature-gated `/me/*` surface in one
 * shot. Threaded into `renderUserPage` (and the overview body) on every page
 * so the tabs and cards leave out whatever is switched off (#1292), and read
 * by `requireSurfaceOn` for the 404s: one read, one answer, on every page.
 * Strict: a failed read goes to the error handler instead of reading as off,
 * so a database hiccup cannot 404 a page that is on.
 */
async function readUserFeatureFlags(): Promise<Required<UserFeatureFlags>> {
  return readMeSurfaceFlagsStrict();
}

/**
 * How each preference is set now, for the cards on `/me/`. Each value is read
 * on its own and only for a feature the server has on; a read that fails
 * leaves that card without a value line instead of failing the page.
 */
async function readPreferenceValues(
  client: Client,
  session: WebSessionContext,
  flags: Required<UserFeatureFlags>,
  /** The member's preference row, read once by the caller; `null`: it failed. */
  prefsRead: { prefs: NotificationPrefs; timezone: string | null } | null,
): Promise<Partial<Record<PreferenceValueKey, string>>> {
  const { discordUserId: userId, guildId } = session;
  const out: Partial<Record<PreferenceValueKey, string>> = {};
  const attempt = async (
    key: PreferenceValueKey,
    read: () => Promise<string | undefined>,
  ): Promise<void> => {
    try {
      const value = await read();
      if (value) out[key] = value;
    } catch (err) {
      logger.warn(
        `Could not read the ${key} value for the /me overview: ${sanitizeForLog(String(err))}`,
      );
    }
  };
  await Promise.all([
    attempt("notifications", async () => {
      // A failed read (logged by the caller) leaves both lines out.
      if (!prefsRead) return undefined;
      const { prefs, timezone } = prefsRead;
      // The same row read gives the timezone card its value too, so it does
      // not depend on the availability read below.
      out.timezone = timezoneValue(timezone, getServerTimezone(), new Date());
      const available = await readMeNotificationAvailability(flags);
      const rows = buildNotificationRows(prefs, available);
      return notificationsValue(
        rows.filter((r) => r.enabled).length,
        rows.length,
      );
    }),
    flags.presetsEnabled
      ? attempt("voice", async () => {
          const v =
            await UserVoicePrefsService.getInstance().getSummary(userId);
          return voiceValue(v.namePattern, v.presetCount);
        })
      : Promise.resolve(),
    flags.birthdayEnabled
      ? attempt("birthday", async () =>
          birthdayValue(
            await BirthdayService.getInstance(client).getBirthdayStrict(
              userId,
              guildId,
            ),
          ),
        )
      : Promise.resolve(),
    flags.privacyEnabled
      ? attempt("privacy", async () =>
          privacyValue(
            (await TrackingOptOutService.getInstance().getOptedOutAt(
              userId,
              guildId,
            )) !== null,
          ),
        )
      : Promise.resolve(),
  ]);
  return out;
}

/**
 * 404 for a whole `/me/<feature>` area (every GET and POST under it) while
 * its feature is off (#1292, as `/me/privacy` since #1066), so a bookmark
 * lands on "not found" rather than a dead settings page and nothing can be
 * saved for a feature the member cannot see. Stored choices are left alone.
 * Mounted ahead of the page's own rate limiter, so refused requests spend no
 * allowance.
 */
function requireSurfaceOn(surface: keyof MeSurfaceFlags): RequestHandler {
  return (_req, res, next): void => {
    readUserFeatureFlags()
      .then((flags) => {
        if (!flags[surface]) {
          res.status(404).type("text/plain").send("Not found");
          return;
        }
        next();
      })
      .catch(next);
  };
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

/**
 * `text` with a full stop at the end, unless it already ends a sentence. A
 * flash is built as "Could not save X: <reason>", and a reason can come with
 * its own full stop (#1535).
 */
function withFinalStop(text: string): string {
  const t = text.trimEnd();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/**
 * What a form posted, as typed, for the fixed `names` of the form: a refused
 * save puts them back in the fields. Never indexed by a posted name, and each
 * value is bounded.
 */
function postedValues(
  body: Record<string, unknown>,
  names: readonly string[],
): FormValues {
  const values: FormValues = {};
  for (const name of names) {
    const v = Object.entries(body).find(([k]) => k === name)?.[1];
    values[name] = typeof v === "string" ? v.slice(0, 200) : "";
  }
  return values;
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

/**
 * The Discord type of a channel shown on Rewind, for labelling it by kind
 * (#1303). A stored value (including an explicit null, a failed resolution)
 * is kept; a snapshot frozen before the field existed has none, so it is
 * read from the client cache. A channel that is no longer cached is null and
 * reads as unavailable.
 */
function rewindChannelType(
  client: Client,
  channelId: string,
  stored?: number | null,
): number | null {
  if (stored !== undefined) return stored;
  const channel = client.channels.cache.get(channelId);
  return channel && typeof channel.type === "number" ? channel.type : null;
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

/**
 * Write one chunk, waiting for the socket to drain when the kernel buffer is
 * full. Without this the "stream" would just accumulate in Node's memory,
 * which is the thing the export is streamed to avoid (#719).
 *
 * Returns false once the response can take no more — the client hung up, or
 * the socket errored. `drain` never fires on a dead socket, so waiting on it
 * alone would park the handler forever: the audit row would never be written
 * and the export's Mongo reads would keep running for a reader that is gone.
 * `close` and `error` therefore release the wait too, and the caller stops
 * pulling data.
 */
async function writeChunk(res: Response, chunk: string): Promise<boolean> {
  if (res.writableEnded || res.destroyed) return false;

  const flushed = res.write(chunk);
  if (flushed !== false || typeof res.once !== "function") return true;

  await new Promise<void>((resolve) => {
    const release = (): void => {
      res.off?.("drain", release);
      res.off?.("close", release);
      res.off?.("error", release);
      resolve();
    };
    res.once("drain", release);
    res.once("close", release);
    res.once("error", release);
  });

  return !res.writableEnded && !res.destroyed;
}

/**
 * Filename for the downloaded export. The user id comes from the validated
 * session (a Discord snowflake), but it is still scrubbed of anything that
 * could break out of the quoted `filename=` parameter.
 */
function exportFilename(userId: string): string {
  const safeId = userId.replace(/[^A-Za-z0-9_-]/g, "");
  return `koolbot-export-${safeId}-${new Date().toISOString().slice(0, 10)}.json`;
}

export function createUserRouter(
  client: Client,
  requireSession: RequestHandler,
): Router {
  const router = Router();

  // General limit for the whole surface (#1142), registered first so even the
  // session ping (which still does cookie + Mongo validation) is covered. Same in-memory, per-IP
  // limiter as the export/reset buckets. The general bucket sits before the
  // session check so a flood of unauthenticated or revalidating requests is
  // throttled before it reaches Mongo or Discord; writes and the rewind
  // aggregations get tighter buckets of their own.
  const generalLimiter = createRateLimiter({
    windowMs: 10 * 60_000,
    max: 600,
    keyName: "me-general",
  });
  router.use(generalLimiter);

  // Surface-local session ping so the `/me` banner script never has to
  // reach across to `/admin/session/ping`. Identical handler (the ping
  // is surface-neutral — same cookie, same DB row), just mounted on
  // both routers so a future split of the admin mount can't silently
  // break the countdown on `/me/*`. Mounted BEFORE `requireSession` for
  // the same reason the admin copy is: the ping itself does its own
  // (non-mutating) cookie + DB validation and must NOT bump `act`.
  router.get("/session/ping", createSessionPingHandler());

  // The data export is the most expensive read a member can trigger — it
  // touches every per-user collection — so it gets its own bucket rather
  // than sharing the surface's general allowance (#719).
  const exportLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 3,
    keyName: "me-export",
  });

  // The data reset (#917) gets a bucket of its own too. This is only the
  // outer layer: it keys on client IP and lives in memory, so it resets on
  // restart and is shared across a NAT. The real once-per-member limit is
  // the persisted `privacy.delete.cooldown_hours` check in the handler.
  const resetLimiter = createRateLimiter({
    windowMs: 15 * 60_000,
    max: 5,
    keyName: "me-privacy-reset",
  });

  // Tighter buckets for writes and the Rewind aggregations (#1142).
  const writeLimiter = createRateLimiter({
    windowMs: 10 * 60_000,
    max: 60,
    keyName: "me-write",
  });
  const rewindLimiter = createRateLimiter({
    windowMs: 10 * 60_000,
    max: 30,
    keyName: "me-rewind",
  });

  router.use(requireSession);
  router.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD") {
      next();
      return;
    }
    writeLimiter(req, res, next);
  });

  // ---------- Event host panel (#1189) ----------
  // Behind the session check and the write limiter above. The sub-router's
  // own gate (CSRF, then the event-host check) covers every path under it.
  // Hosting needs the `host` scope (#1316), resolved from role groups on every
  // request. The guard sits on the `/events` prefix, ahead of both routers
  // below, so it covers the panel and the presets. A host still only reaches
  // events they created (`isEventHost`), an admin session every event.
  router.use("/events", requireScopeMiddleware("host"));
  // A host creates events of their own (#1305): `/me/events/new`. Sits behind
  // the guard above, so a member without the scope never reaches it.
  router.use("/events/new", createMeNewEventRouter(client));
  router.use("/events/:id/host", createHostEventsRouter(client));
  // A host's own group presets (#1216): `/me/events/presets`.
  router.use("/events/presets", createMeEventPresetsRouter(client));
  // "Your events" (#1319): `GET /me/events`. Last of the group, so the more
  // specific paths above answer first; it only has the list route.
  router.use("/events", createMeEventsRouter());

  // Moderation pages (#1320) need the `moderator` scope. The guard sits ahead
  // of the router, so every route added under `/me/moderation` is gated from
  // its first commit: add routes to that router, never beside it.
  router.use("/moderation", requireScopeMiddleware("moderator"));
  router.use("/moderation", createMeModerationRouter(client));

  // Feature-gated pages answer 404 while their feature is off (#1292, #1066),
  // GETs and POSTs alike. Mounted ahead of every route below, so a route added
  // under these prefixes is gated from its first commit. Privacy gates itself
  // (its export is also gated ahead of its own limiter).
  router.use("/voice", requireSurfaceOn("presetsEnabled"));
  router.use("/birthday", requireSurfaceOn("birthdayEnabled"));
  router.use("/rewind", requireSurfaceOn("rewindEnabled"));

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
      const flags = await readUserFeatureFlags();
      // One read of the member's preference row serves the cards' values and
      // the zone the times below are shown in (#1538). A failed read leaves
      // the value lines out and shows the times in the server's zone.
      let prefsRead: Awaited<
        ReturnType<UserNotificationPrefsService["getPrefsWithTimezoneStrict"]>
      > | null = null;
      try {
        prefsRead =
          await UserNotificationPrefsService.getInstance().getPrefsWithTimezoneStrict(
            session.discordUserId,
            session.guildId,
          );
      } catch (err) {
        logger.warn(
          `Could not read the notification preferences for the /me overview: ${sanitizeForLog(String(err))}`,
        );
      }
      const zone = resolveTimezone(prefsRead?.timezone);
      // Only hosts see the card: its links lead to `/me/events*` (#1316).
      const hostedEvents = (
        hasScope(session, "host")
          ? await listHostedEvents(session.guildId, session.discordUserId)
          : []
      ).map((e) => ({
        id: e.id,
        title: e.title,
        when: formatDateTimeInZone(e.startTime, zone),
        state: e.state,
        running: e.running,
      }));

      // Read-only poll-participation summary for the overview card (#655).
      // Only fetched when capture is on; a member who has never voted has no
      // row, so `getParticipationSummary` returns null and the card is hidden.
      const pollParticipation = (await isPollParticipationEnabled())
        ? await PollParticipationTracker.getInstance(
            client,
          ).getParticipationSummary(session.discordUserId, session.guildId)
        : null;

      const preferenceValues = await readPreferenceValues(
        client,
        session,
        flags,
        prefsRead,
      );

      res.type("text/html").send(
        renderUserPage({
          title: "Overview",
          active: "/me/",
          body: renderUserIndexBody({
            discordUserId: session.discordUserId,
            guildId: session.guildId,
            isAdmin: session.role === "admin",
            ...flags,
            hostedEvents,
            preferenceValues,
            pollParticipation: pollParticipation
              ? {
                  totalVotes: pollParticipation.totalVotes,
                  thisYearVotes: pollParticipation.thisYearVotes,
                  thisWeekVotes: pollParticipation.thisWeekVotes,
                  lastVoted: pollParticipation.lastVoteAt
                    ? formatInZone(
                        pollParticipation.lastVoteAt,
                        zone,
                        "yyyy-MM-dd",
                      )
                    : null,
                }
              : null,
          }),
          csrfToken: getCsrfToken(req),
          remainingMs: getDisplayedRemainingMs(session),
          isAdmin: session.role === "admin",
          ...flags,
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
      const flags = await readUserFeatureFlags();
      const available = await readMeNotificationAvailability(flags);
      res.type("text/html").send(
        renderUserPage({
          title: "Notifications",
          active: "/me/notifications",
          body: renderUserNotificationsBody({
            csrfToken: getCsrfToken(req),
            rows: buildNotificationRows(prefs, available),
          }),
          csrfToken: getCsrfToken(req),
          remainingMs: getDisplayedRemainingMs(session),
          isAdmin: session.role === "admin",
          flash,
          ...flags,
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
      //
      // A row the page does not offer (its feature is off, #1292) is skipped
      // even when a stale form still carries it: nothing is saved for a DM
      // the member cannot see, and the stored value stays as it was.
      const available = await readMeNotificationAvailability(
        await readUserFeatureFlags(),
      );
      const patch: Partial<NotificationPrefs> = {};
      for (const key of NOTIFICATION_PREF_KEYS) {
        if (!available[key]) continue;
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
            selected,
            serverTimezone: getServerTimezone(),
          }),
          csrfToken: getCsrfToken(req),
          remainingMs: getDisplayedRemainingMs(session),
          isAdmin: session.role === "admin",
          flash,
          ...(await readUserFeatureFlags()),
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
        // Never store the rejected value itself: it is member-supplied and
        // unbounded. Its length is enough to tell a typo from abuse (#1142).
        details:
          result === "success"
            ? { before, after }
            : { reason: "invalid-timezone", attemptedLength: raw.length },
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
          text: "Cleared your timezone — KoolBot will use the server timezone.",
        };
      } else {
        flash = { type: "ok", text: `Saved your timezone as ${after}.` };
      }
      res.redirect(303, flashUrl("/me/timezone", flash));
    }),
  );

  // ---------- Birthday (#657) ----------
  // The page, for a fresh GET and for a refused save (#1535), which is answered
  // in the same response (422) so what was typed is not lost.
  async function sendBirthdayPage(
    req: Request,
    res: Response,
    session: WebSessionContext,
    refusal?: { refused: RefusedForm; flash?: UserFlashMessage },
  ): Promise<void> {
    const { userId, guildId } = assertSelfScope(session, {
      userId: session.discordUserId,
      guildId: session.guildId,
    });
    const selected = await BirthdayService.getInstance(client).getBirthday(
      userId,
      guildId,
    );
    const flash = refusal ? (refusal.flash ?? null) : readFlashFromQuery(req);
    const flags = await readUserFeatureFlags();
    const changeCooldownSeconds = await ConfigService.getInstance().getNumber(
      "birthdays.change_cooldown_seconds",
      300,
    );
    res
      .status(refusal ? 422 : 200)
      .type("text/html")
      .send(
        renderUserPage({
          title: "Birthday",
          active: "/me/birthday",
          body: renderUserBirthdayBody({
            csrfToken: getCsrfToken(req),
            selected,
            changeCooldownSeconds,
            refusedForm: refusal?.refused ?? null,
          }),
          csrfToken: getCsrfToken(req),
          remainingMs: getDisplayedRemainingMs(session),
          isAdmin: session.role === "admin",
          flash,
          ...flags,
        }),
      );
  }

  router.get(
    "/birthday",
    asyncHandler(async (req, res) => {
      const session = req.webSession;
      if (!session) {
        res.status(500).type("text/plain").send("session missing");
        return;
      }
      await sendBirthdayPage(req, res, session);
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
      let fieldError: BirthdayFieldError | null = null;
      let dateMissing = false;
      let after = before;
      let purge: BirthdayPurgeResult | null = null;
      try {
        if (clearing) {
          // Never a raw delete: the row is the only record of a live
          // birthday role and of the bot's posts about the member, so the
          // purge takes those back first and keeps the row if it cannot
          // (#916, #1033).
          purge = await service.removeOwnBirthday(guildId, userId);
          if (purge.error || (purge.matched > 0 && purge.removed === 0)) {
            throw new Error(
              purge.error ?? "the birthday could not be fully removed",
            );
          }
          after = null;
        } else if (month === null || day === null) {
          dateMissing = true;
          throw new BirthdayFieldError(
            "Please choose a month and a day.",
            "date",
          );
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
        if (err instanceof BirthdayFieldError) fieldError = err;
        logger.error(
          `Failed to ${clearing ? "remove" : "save"} birthday: ${sanitizeForLog(errorMessage)}`,
        );
      }

      await recordAudit(session, {
        action: "user.birthday.set",
        targetId: userId,
        details:
          result === "success"
            ? { before, after, ...(purge ? { purge } : {}) }
            : clearing
              ? { attempted: { clear: true }, before, purge }
              : { attempted: { month, day, year } },
        result,
        errorMessage,
      });

      // A refused save comes back as the page itself, with what was posted. A
      // refusal about the date or the year marks that field; any other (the
      // change cooldown, a failed read) is a callout, as it is not about one
      // field. The refused removal stays a redirect: nothing was typed.
      if (result === "failure" && !clearing) {
        const errors: FormErrors = {};
        if (fieldError) {
          addFieldError(
            errors,
            fieldError.field,
            fieldError.field === "year"
              ? "Enter a four-digit year from 1900 up to this year, or leave it blank."
              : dateMissing
                ? "Choose a month and a day."
                : "That date does not exist. Choose a day that fits the month.",
          );
        }
        await sendBirthdayPage(req, res, session, {
          refused: {
            formId: BIRTHDAY_FORM_ID,
            errors,
            values: postedValues(body, ["month", "day", "year"]),
          },
          flash: fieldError
            ? undefined
            : {
                type: "err",
                text: withFinalStop(
                  `Could not save your birthday: ${errorMessage ?? "unknown error"}`,
                ),
              },
        });
        return;
      }

      let flash: UserFlashMessage;
      if (result === "failure") {
        flash = {
          type: "err",
          text: withFinalStop(
            `Could not remove your birthday: ${errorMessage ?? "unknown error"}`,
          ),
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
    const flags = await readUserFeatureFlags();

    // While Rewind is off the whole area answers 404 (`requireSurfaceOn`,
    // #1292), ahead of the limiter, so everything below runs with it on.

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
            ...flags,
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
          voiceByKind: (summary.voiceByKind ?? []).map((k) => ({
            kind: k.kind,
            duration: formatHoursMinutes(k.totalSeconds),
          })),
          longestSession: summary.longestSession
            ? {
                duration: formatHoursMinutes(
                  summary.longestSession.totalSeconds,
                ),
                date: summary.longestSession.date,
                roomKind: summary.longestSession.roomKind ?? "other",
              }
            : null,
          longestStreakDays: summary.longestStreakDays,
          longestStreakRange: summary.longestStreakRange,
          accolades: summary.accolades.map((a) => ({
            emoji: a.emoji,
            name: a.name,
            description: a.description,
            earnedAt: formatInZone(a.earnedAt, timezone, "yyyy-MM-dd"),
          })),
          achievements: summary.achievements.map((a) => ({
            emoji: a.emoji,
            name: a.name,
            description: a.description,
            earnedAt: formatInZone(a.earnedAt, timezone, "yyyy-MM-dd"),
          })),
          annualRank: summary.annualRank,
          annualGuildMembers: summary.annualGuildMembers,
          percentAboveMedian: summary.percentAboveMedian,
          weeklyJourney: summary.weeklyJourney,
          messagesSent: summary.messagesSent,
          topTextChannels: summary.topTextChannels.map((c) => ({
            channelId: c.channelId,
            channelName: c.channelName,
            channelType: rewindChannelType(client, c.channelId, c.channelType),
            count: c.count,
          })),
          peakMessageDay: summary.peakMessageDay,
          reactionsGiven: summary.reactionsGiven,
          reactionsReceived: summary.reactionsReceived,
          hourOfDayDistribution: summary.hourOfDayDistribution ?? [],
          dayOfWeekDistribution: summary.dayOfWeekDistribution ?? [],
          pollVotesCast: summary.pollVotesCast,
        }),
        csrfToken: getCsrfToken(req),
        remainingMs: getDisplayedRemainingMs(session),
        isAdmin: session.role === "admin",
        ...flags,
      }),
    );
  });
  router.get("/rewind", rewindLimiter, rewindHandler);
  router.get("/rewind/:year", rewindLimiter, rewindHandler);

  // ---------- Voice preferences (#656) ----------
  // `/me/voice` manages the per-user name pattern + saved presets. It
  // shares the `voicechannels.presets.enabled` gate with the Discord
  // modal surface and reuses `UserVoicePrefsService` so the validation
  // rules never diverge between the two surfaces. Presets are created in
  // Discord (snapshot of a live channel); the web surface edits, sets the
  // default, and deletes the ones you already have.

  // While `voicechannels.presets.enabled` is off the page and its POSTs answer
  // 404 (`requireSurfaceOn`, #1292); a member's saved name pattern and presets
  // stay stored and are back when the feature is turned on.

  // The page, for a fresh GET and for a refused save (#1535): answered in the
  // same response (422) so what was typed in that one form is not lost.
  async function sendVoicePage(
    req: Request,
    res: Response,
    session: WebSessionContext,
    refusal?: { refused: RefusedForm; flash?: UserFlashMessage },
  ): Promise<void> {
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
    const flash = refusal ? (refusal.flash ?? null) : readFlashFromQuery(req);
    const flags = await readUserFeatureFlags();

    res
      .status(refusal ? 422 : 200)
      .type("text/html")
      .send(
        renderUserPage({
          title: "Voice preferences",
          active: "/me/voice",
          body: renderUserVoiceBody({
            csrfToken: getCsrfToken(req),
            namePattern: prefs.namePattern ?? null,
            displayName,
            presets: toPresetViews(prefs.presets),
            maxPerUser,
            refusedForm: refusal?.refused ?? null,
          }),
          csrfToken: getCsrfToken(req),
          remainingMs: getDisplayedRemainingMs(session),
          isAdmin: session.role === "admin",
          flash,
          ...flags,
        }),
      );
  }

  router.get(
    "/voice",
    asyncHandler(async (req, res) => {
      const session = req.webSession;
      if (!session) {
        res.status(500).type("text/plain").send("session missing");
        return;
      }
      await sendVoicePage(req, res, session);
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
      let refusal: VoicePrefsValidationError | null = null;
      try {
        stored = await UserVoicePrefsService.getInstance().setNamePattern(
          userId,
          raw,
        );
      } catch (err) {
        result = "failure";
        errorMessage = err instanceof Error ? err.message : String(err);
        if (err instanceof VoicePrefsValidationError) refusal = err;
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

      // A refused pattern comes back as the page itself with what was typed and
      // the field marked (#1535); a failure that is not a refusal stays a flash.
      if (refusal) {
        const errors: FormErrors = {};
        if (refusal.field)
          addFieldError(errors, refusal.field, refusal.message);
        await sendVoicePage(req, res, session, {
          refused: {
            formId: VOICE_NAME_PATTERN_FORM_ID,
            errors,
            values: { namePattern: raw },
          },
          flash: refusal.field
            ? undefined
            : { type: "err", text: withFinalStop(refusal.message) },
        });
        return;
      }

      const flash: UserFlashMessage =
        result === "failure"
          ? {
              type: "err",
              text: withFinalStop(
                `Could not save your name pattern: ${errorMessage ?? "unknown error"}`,
              ),
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
    // A refusal that names a field of the form: answers with the page and
    // returns true, or returns false to leave it as a flash (#1535).
    answerRefusal?: (ctx: {
      req: Request;
      res: Response;
      session: WebSessionContext;
      userId: string;
      index: number;
      expectedName: string;
      body: Record<string, unknown>;
      err: VoicePrefsValidationError;
    }) => Promise<boolean>,
  ): RequestHandler =>
    asyncHandler(async (req, res) => {
      const session = req.webSession;
      if (!session) {
        res.status(500).type("text/plain").send("session missing");
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
      let fieldRefusal: VoicePrefsValidationError | null = null;

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
          if (err instanceof VoicePrefsValidationError && err.field) {
            fieldRefusal = err;
          }
          flash = {
            type: err instanceof VoicePrefsValidationError ? "warn" : "err",
            text:
              err instanceof VoicePrefsValidationError
                ? errorMessage
                : withFinalStop(`Could not update the preset: ${errorMessage}`),
          };
        }
      }

      await recordAudit(session, {
        action,
        targetId: userId,
        // On success `expectedName` matched the stored preset name, so a
        // bounded copy is harmless; on failure it is unverified input, so
        // only its length is kept (#1142).
        details:
          result === "success"
            ? {
                ...details,
                index,
                expectedName: sanitizeForLog(expectedName, 64),
              }
            : { ...details, index, expectedNameLength: expectedName.length },
        result,
        errorMessage,
      });

      if (
        fieldRefusal &&
        answerRefusal &&
        index !== undefined &&
        (await answerRefusal({
          req,
          res,
          session,
          userId,
          index,
          expectedName,
          body,
          err: fieldRefusal,
        }))
      ) {
        return;
      }

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
          throw new VoicePrefsValidationError(
            "User limit must be a number.",
            "userLimit",
          );
        }
        if (Number.isNaN(bitrate)) {
          throw new VoicePrefsValidationError(
            "Bitrate must be a number.",
            "bitrate",
          );
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
      async ({ req, res, session, userId, index, expectedName, body, err }) => {
        // The refusal is about this row's form only if the row is still the one
        // the form was drawn for; a preset another tab removed or shifted has
        // no form to mark, so that stays the flash (#1535).
        try {
          const prefs =
            await UserVoicePrefsService.getInstance().getPrefs(userId);
          if (prefs.presets[index]?.name !== expectedName) return false;
        } catch (lookupErr) {
          logger.warn("Preset lookup before a refused edit failed", lookupErr);
          return false;
        }
        const errors: FormErrors = {};
        if (err.field) addFieldError(errors, err.field, err.message);
        await sendVoicePage(req, res, session, {
          refused: {
            formId: voicePresetFormId(index),
            errors,
            values: postedValues(body, [
              "name",
              "channelName",
              "userLimit",
              "bitrate",
            ]),
          },
        });
        return true;
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

  // ---------- Privacy / data export (#719) ----------
  // `GET /me/privacy` describes what is stored; `GET /me/privacy/export`
  // serves the JSON file. Both are self-scoped like every other `/me/*`
  // handler, and the download is the most expensive read a member can
  // trigger, so it carries its own rate limiter on top.

  router.get(
    "/privacy/export",
    // Gate before the limiter (#1066): while the section is off these
    // requests must stay a plain 404 and must not spend the export allowance,
    // or the first download after re-enabling could be rate-limited.
    (_req: Request, res: Response, next: NextFunction): void => {
      isPrivacyExportEnabled()
        .then((on) => {
          if (!on) {
            res.status(404).type("text/plain").send("Not found");
            return;
          }
          next();
        })
        .catch(next);
    },
    exportLimiter,
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

      const progress = createExportProgress();
      // Serve as a downloaded file, never as a rendered page: `nosniff` so a
      // browser can't be talked into treating the JSON as HTML, and
      // `no-store` so a shared machine's cache doesn't keep a copy.
      res.status(200);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${exportFilename(userId)}"`,
      );
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "no-store");

      let errorMessage: string | null = null;
      let aborted = false;
      try {
        for await (const chunk of UserDataExportService.getInstance().streamJson(
          userId,
          guildId,
          progress,
        )) {
          if (!(await writeChunk(res, chunk))) {
            // The reader is gone. Stop pulling collections rather than
            // finishing an export nobody will receive.
            aborted = true;
            break;
          }
        }
      } catch (err) {
        errorMessage = err instanceof Error ? err.message : String(err);
        logger.error(
          `Failed to stream user data export: ${sanitizeForLog(errorMessage)}`,
        );
      }
      if (aborted && errorMessage === null) {
        errorMessage = "client disconnected before the export completed";
      }
      // The response is already committed by the time a reader can fail, so
      // a mid-stream error can only truncate the file — the audit row is what
      // records that it happened. A disconnect leaves nothing to close.
      if (!res.writableEnded && !res.destroyed) res.end();

      await recordAudit(session, {
        action: "user.privacy.export",
        targetId: userId,
        details: {
          collections: progress.collections,
          truncated: progress.truncated,
          ...(aborted ? { aborted: true } : {}),
        },
        result: errorMessage === null ? "success" : "failure",
        errorMessage,
      });
    }),
  );

  router.get(
    "/privacy",
    asyncHandler(async (req, res) => {
      const session = req.webSession;
      if (!session) {
        res.status(500).type("text/plain").send("session missing");
        return;
      }
      assertSelfScope(session, {
        userId: session.discordUserId,
        guildId: session.guildId,
      });
      const flags = await readUserFeatureFlags();
      // Hidden while off (#1066): 404, not a disabled banner.
      if (!flags.privacyEnabled) {
        res.status(404).type("text/plain").send("Not found");
        return;
      }
      const maxItems = await UserDataExportService.getInstance().getMaxItems();
      const [resetEnabled, cooldownHours, optOutDisabledKeys] =
        await Promise.all([
          isPrivacyResetEnabled(),
          getPrivacyResetCooldownHours(),
          getTrackingOptOutDisabledKeys(),
        ]);
      // Read from Mongo, not the trackers' cache, so the page shows the real
      // state. A failed read shows the member as tracked: the conservative
      // answer, since it keeps the reset described as "not a deletion".
      let optedOutAt: Date | null = null;
      try {
        optedOutAt = await TrackingOptOutService.getInstance().getOptedOutAt(
          session.discordUserId,
          session.guildId,
        );
      } catch (error) {
        logger.warn("Could not read tracking opt-out for /me/privacy", error);
      }

      res.type("text/html").send(
        renderUserPage({
          title: "Privacy",
          active: "/me/privacy",
          body: renderUserPrivacyBody({
            featureEnabled: flags.privacyEnabled,
            rewindEnabled: flags.rewindEnabled,
            included: summariseByCollection(EXPORTABLE_USER_DATA),
            excluded: summariseByCollection(EXCLUDED_USER_DATA),
            maxItems,
            reset: {
              enabled: resetEnabled,
              cooldownHours,
              csrfToken: getCsrfToken(req),
            },
            trackingOptOut: {
              offered: optOutDisabledKeys.length === 0,
              optedOutAt,
              csrfToken: getCsrfToken(req),
            },
          }),
          flash: readFlashFromQuery(req),
          csrfToken: getCsrfToken(req),
          remainingMs: getDisplayedRemainingMs(session),
          isAdmin: session.role === "admin",
          ...flags,
        }),
      );
    }),
  );

  // ---------- Privacy / tracking opt-out (#918) ----------
  // `action=opt-out` is refused while the offer is switched off;
  // `action=opt-in` never is — a member can always remove their own flag.
  router.post(
    "/privacy/tracking",
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
      const action = body.action;
      if (action !== "opt-out" && action !== "opt-in") {
        res.redirect(
          303,
          flashUrl("/me/privacy", {
            type: "err",
            text: "Unknown tracking action.",
          }),
        );
        return;
      }

      if (action === "opt-out") {
        const disabledKeys = await getTrackingOptOutDisabledKeys();
        if (disabledKeys.length > 0) {
          await recordAudit(session, {
            action: TRACKING_OPT_OUT_ACTION,
            targetId: userId,
            details: { action, reason: "feature-disabled", disabledKeys },
            result: "failure",
            errorMessage: `${disabledKeys.join(" and ")} ${disabledKeys.length === 1 ? "is" : "are"} off`,
          });
          res
            .status(403)
            .type("text/plain")
            .send("The tracking opt-out is not enabled on this server.");
          return;
        }
      }

      // Opting back in stays possible with the export off, but /me/privacy
      // then 404s (#1066), so land the member on the overview instead.
      const landing = (await isPrivacyExportEnabled()) ? "/me/privacy" : "/me/";
      const service = TrackingOptOutService.getInstance();
      // False when work from an opt-out could not be confirmed finished:
      // for an opt-out it is stored anyway, for an opt-in nothing changed.
      // Said out loud either way, never flashed as clean.
      let settled: boolean;
      try {
        ({ settled } =
          action === "opt-out"
            ? await service.optOut(userId, guildId)
            : await service.optIn(userId, guildId));
      } catch (error) {
        logger.error(
          `Tracking ${action} failed for ${sanitizeForLog(userId)}`,
          error,
        );
        await recordAudit(session, {
          action: TRACKING_OPT_OUT_ACTION,
          targetId: userId,
          details: { action },
          result: "failure",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        res.redirect(
          303,
          flashUrl(landing, {
            type: "err",
            text: "Could not save your tracking choice — nothing changed. Please try again.",
          }),
        );
        return;
      }

      await recordAudit(session, {
        action: TRACKING_OPT_OUT_ACTION,
        targetId: userId,
        details: settled ? { action } : { action, settled: false },
        // An unsettled opt-in changed nothing; an unsettled opt-out is still
        // stored, so only the former is a failure.
        ...(action === "opt-in" && !settled
          ? {
              result: "failure" as const,
              errorMessage: "opt-out work had not settled; still opted out",
            }
          : { result: "success" as const }),
      });
      res.redirect(
        303,
        flashUrl(
          landing,
          action === "opt-in"
            ? settled
              ? {
                  type: "ok",
                  text: "You are opted back in. Tracking starts again from now; time in voice counts from the next channel you join.",
                }
              : {
                  type: "err",
                  text: "You are still opted out: a recording from before could not be confirmed finished. Try opting back in again in a minute.",
                }
            : settled
              ? {
                  type: "ok",
                  text: "You are opted out of tracking. Nothing new is recorded about you from now on.",
                }
              : {
                  type: "err",
                  text: "You are opted out of tracking, but a recording that was already under way could not be confirmed finished. Wait a minute before resetting your data.",
                },
        ),
      );
    }),
  );

  // ---------- Privacy / self-service data reset (#917) ----------
  // Destructive, so every refusal is audited and the order is fixed:
  // gate → typed confirmation → persisted cooldown → intent row (refuse if
  // it cannot be written) → purge → completed row → sign out. The purge
  // revokes the member's web sessions as its own last step; the handler
  // then clears the cookie and renders the terminal signed-out page, the
  // same treatment as `POST /me/finish`.
  router.post(
    "/privacy/delete",
    resetLimiter,
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

      const disabledKeys = await getPrivacyResetDisabledKeys();
      if (disabledKeys.length > 0) {
        await recordAudit(session, {
          action: PRIVACY_RESET_ACTION,
          targetId: userId,
          details: { reason: "feature-disabled", disabledKeys },
          result: "failure",
          errorMessage: `${disabledKeys.join(" and ")} ${disabledKeys.length === 1 ? "is" : "are"} off`,
        });
        res
          .status(403)
          .type("text/plain")
          .send("The self-service data reset is not enabled on this server.");
        return;
      }

      const body = (req.body as Record<string, unknown> | undefined) ?? {};
      const confirmText =
        typeof body.confirm === "string" ? body.confirm.trim() : "";
      if (confirmText !== PRIVACY_RESET_CONFIRM_WORD) {
        await recordAudit(session, {
          action: PRIVACY_RESET_ACTION,
          targetId: userId,
          details: { reason: "confirmation-mismatch" },
          result: "failure",
          errorMessage: "confirmation text did not match",
        });
        res.redirect(
          303,
          flashUrl("/me/privacy", {
            type: "err",
            text: `Reset cancelled — type ${PRIVACY_RESET_CONFIRM_WORD} exactly to confirm.`,
          }),
        );
        return;
      }

      // Held from the cooldown check until the purge has finished, so a
      // second request cannot slip in before this one's intent row exists.
      const lockKey = `${guildId}:${userId}`;
      if (resetsInFlight.has(lockKey)) {
        await recordAudit(session, {
          action: PRIVACY_RESET_ACTION,
          targetId: userId,
          details: { reason: "in-progress" },
          result: "failure",
          errorMessage: "a reset for this member is already running",
        });
        res.redirect(
          303,
          flashUrl("/me/privacy", {
            type: "err",
            text: "A reset of your data is already in progress.",
          }),
        );
        return;
      }
      resetsInFlight.add(lockKey);
      try {
        await runPrivacyReset(session, res, userId, guildId);
      } finally {
        resetsInFlight.delete(lockKey);
      }
    }),
  );

  /**
   * The part of the reset that runs under the per-member lock: cooldown,
   * intent row, purge, completed row, sign-out.
   */
  async function runPrivacyReset(
    session: WebSessionContext,
    res: Response,
    userId: string,
    guildId: string,
  ): Promise<void> {
    const cooldownHours = await getPrivacyResetCooldownHours();
    let lastReset: Date | null;
    try {
      lastReset = await findActiveResetCooldown(userId, guildId, cooldownHours);
    } catch (err) {
      // Fail closed: a cooldown that cannot be checked is not a cooldown
      // that has passed.
      logger.error(
        `Privacy reset cooldown lookup failed for ${sanitizeForLog(userId)}`,
        err,
      );
      // Audited like every other refusal (#919). No `phase`, so this row can
      // neither start nor lift a cooldown.
      await recordAudit(session, {
        action: PRIVACY_RESET_ACTION,
        targetId: userId,
        details: { reason: "cooldown-check-failed" },
        result: "failure",
        errorMessage: "could not check the reset cooldown",
      });
      res.redirect(
        303,
        flashUrl("/me/privacy", {
          type: "err",
          text: "Reset refused — could not check when you last reset. Nothing was changed; try again later.",
        }),
      );
      return;
    }
    if (lastReset) {
      const availableAt = new Date(
        lastReset.getTime() + cooldownHours * 60 * 60 * 1000,
      );
      await recordAudit(session, {
        action: PRIVACY_RESET_ACTION,
        targetId: userId,
        details: {
          reason: "cooldown",
          lastResetAt: lastReset.toISOString(),
          availableAt: availableAt.toISOString(),
        },
        result: "failure",
        errorMessage: "reset cooldown still active",
      });
      const zone = await readMemberZone(userId, guildId);
      res.redirect(
        303,
        flashUrl("/me/privacy", {
          type: "err",
          text: `You already reset your data recently. You can reset again after ${formatDateTimeInZone(availableAt, zone)}.`,
        }),
      );
      return;
    }

    // `recordAudit` swallows its own failures, which is right for most
    // writes and wrong here: a purge nobody can see happened is the one
    // thing an operator must never be left with — and this row is also
    // what starts the cooldown. No intent row, no purge.
    try {
      await recordAuditOrThrow(session, {
        action: PRIVACY_RESET_ACTION,
        targetId: userId,
        details: { phase: "intent" },
        result: "success",
      });
    } catch (err) {
      logger.error(
        `Privacy reset refused for ${sanitizeForLog(userId)}: intent audit row could not be written`,
        err,
      );
      res.redirect(
        303,
        flashUrl("/me/privacy", {
          type: "err",
          text: "Reset refused — it could not be recorded in the audit log. Nothing was changed; try again later.",
        }),
      );
      return;
    }

    let report: PurgeReport;
    try {
      report = await UserDataDeletionService.getInstance(client).purge(
        userId,
        guildId,
      );
    } catch (err) {
      // The coordinator records per-step failures itself and only throws
      // on a programming error — but if it does, part of the member's data
      // may already be gone, so close the intent with a failure row and
      // still end the session like any other attempted purge.
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(
        `Privacy reset for ${sanitizeForLog(userId)} failed: ${sanitizeForLog(errorMessage)}`,
      );
      await recordCompletion(session, userId, {
        details: { phase: "completed" },
        result: "failure",
        errorMessage,
      });
      await finishSignedOut(
        res,
        userId,
        "Your KoolBot data reset could not finish, and some of your data may already be gone. Sign in again and retry — it is safe to run more than once.",
      );
      return;
    }

    await recordCompletion(session, userId, {
      details: { phase: "completed", report },
      result: report.ok ? "success" : "failure",
      errorMessage: report.ok
        ? null
        : `${report.steps.filter((step) => step.error || step.removed < step.matched).length} purge step(s) incomplete`,
    });

    await finishSignedOut(
      res,
      userId,
      report.ok
        ? "Your KoolBot data on this server has been reset."
        : "Your KoolBot data reset did not fully complete. Sign in again and retry — it is safe to run more than once.",
    );
  }

  /**
   * Write the completed row. It does not gate anything — the cooldown is
   * keyed on the intent row — but it carries the purge report, so a failure
   * to store it is logged loudly rather than swallowed like `recordAudit`.
   */
  async function recordCompletion(
    session: WebSessionContext,
    userId: string,
    entry: Pick<AuditEntry, "details" | "result" | "errorMessage">,
  ): Promise<void> {
    try {
      await recordAuditOrThrow(session, {
        action: PRIVACY_RESET_ACTION,
        targetId: userId,
        ...entry,
      });
    } catch (err) {
      logger.error(
        `Privacy reset for ${sanitizeForLog(userId)}: completed audit row could not be written ` +
          `(result=${entry.result}); the intent row still holds the cooldown`,
        err,
      );
    }
  }

  /**
   * Terminal treatment, same as `POST /me/finish`: revoke, clear the cookie,
   * render the signed-out page. The purge's own last step already revoked
   * every session this member holds; this repeats it with the throwing
   * `revokeForUser` (not `revokeSession`, which returns `false` on a DB
   * error just as it does for an already-revoked row), so the page only
   * says the session was revoked when that is known to be true.
   */
  async function finishSignedOut(
    res: Response,
    userId: string,
    message: string,
  ): Promise<void> {
    let revoked = true;
    try {
      await WebSessionService.getInstance().revokeForUser(userId);
    } catch (err) {
      revoked = false;
      logger.error(
        `Failed to revoke sessions after privacy reset for ${sanitizeForLog(userId)}`,
        err,
      );
    }
    clearSessionCookie(res);
    res
      .status(200)
      .type("text/html")
      .send(renderSignedOut(message, { revoked }));
  }

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
