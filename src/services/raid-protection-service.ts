import { Client, Guild, GuildMember, type Role } from "discord.js";
import { Types } from "mongoose";
import { createKeyedLock } from "../utils/keyed-lock.js";
import { ConfigService } from "./config-service.js";
import { env } from "../config/env.js";
import logger from "../utils/logger.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";
import { getErrorMessage } from "../utils/error-guards.js";
import { truncateText } from "../utils/discord-limits.js";
import { GUILD_MEMBERS_INTENT_HOWTO } from "../utils/guild-members-intent.js";
import {
  MAX_REASON_LENGTH,
  MAX_TIMEOUT_MINUTES,
} from "../utils/moderation-guards.js";
import { defaultConfig } from "./config-schema.js";
import {
  RAID_ACTIONS,
  RAID_ACTION_PERMISSIONS,
  type RaidAction,
} from "../utils/raid-actions.js";
import {
  ModerationLog,
  type ModerationAction,
} from "../models/moderation-log.js";

/**
 * Anti-raid protection (#1045): join-rate detection with a lockdown mode, and
 * an account-age gate. Detection is event-driven (join events). The only
 * timers are the per-guild auto-expiry timers armed by `scheduleExpiry()` for
 * a lockdown with a time limit, so a quiet lockdown ends on time; the checks
 * on each join, status read and settings reconciliation are the backstop.
 * `destroy()` clears the timers and unregisters the config callbacks.
 *
 * Safety properties, each covered by tests:
 *   - Default off, and a first enablement is a *dry run* (`dry_run` defaults
 *     on): it detects and alerts but never touches a member.
 *   - Only members who join while it is active are ever acted on, never
 *     existing members, and never bots (a bot is added by a human admin).
 *   - Requires `moderation.enabled` so every action lands in the moderation
 *     log, and the GuildMembers intent so join events actually arrive. When
 *     either is missing it stays inactive and says why.
 *   - Acts only when discord.js reports the bot may (`kickable`,
 *     `moderatable`, `manageable`), which covers the server owner, members at
 *     or above the bot's highest role, and missing permissions.
 *   - Every action and every lockdown on/off is a `ModerationLog` row with
 *     `source: "raid"`; nothing leaves the instance.
 */

export { RAID_ACTIONS, type RaidAction };

/**
 * How long a join waits for startup restoration before being evaluated anyway.
 * Fail open on purpose: after this the guild is treated as not in lockdown
 * (with a warning), because blocking joins, or acting on members, while the
 * state is unknown is the worse failure.
 */
export const INIT_WAIT_MS = 10_000;

/** Waits between attempts to write a log row, then it is queued for later. */
export const ROW_RETRY_DELAYS_MS = [100, 300];
export const MAX_PENDING_ROWS = 500;
/**
 * Hard bound on queued lockdown/clear rows. They are never shed, but they are
 * not unbounded: past this, a manual transition is refused with an error (and an
 * automatic one is logged and its row dropped) rather than growing memory
 * while the database is down.
 */
export const MAX_PENDING_TRANSITIONS = 2000;

type LogRow = Record<string, unknown>;

function isTransitionRow(row: LogRow): boolean {
  return row.action === "raid_lockdown" || row.action === "raid_clear";
}
const MAX_TIMER_MS = 2 ** 31 - 1;

export const MIN_JOIN_THRESHOLD = 2;
export const MIN_WINDOW_SECONDS = 5;
export const MAX_WINDOW_SECONDS = 3600;
export const MIN_TIMEOUT_MINUTES = 1;
/** Appended to the log reason of a lockdown that began as a dry run. */
export const DRY_RUN_SUFFIX = " (dry run)";

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_MINUTE = 60 * 1000;

/** Every `moderation.raid.*` key the service reads, so tests and docs share one list. */
export const RAID_CONFIG_KEYS = [
  "moderation.raid.enabled",
  "moderation.raid.dry_run",
  "moderation.raid.join_threshold",
  "moderation.raid.window_seconds",
  "moderation.raid.lockdown_action",
  "moderation.raid.min_account_age_hours",
  "moderation.raid.new_account_action",
  "moderation.raid.timeout_minutes",
  "moderation.raid.quarantine_role_id",
  "moderation.raid.lockdown_max_minutes",
  "moderation.raid.alert_channel_id",
] as const;

/** Resolved, clamped settings for one decision. */
export interface RaidSettings {
  enabled: boolean;
  dryRun: boolean;
  joinThreshold: number;
  windowSeconds: number;
  lockdownAction: RaidAction;
  minAccountAgeHours: number;
  newAccountAction: RaidAction;
  timeoutMinutes: number;
  quarantineRoleId: string;
  lockdownMaxMinutes: number;
  alertChannelId: string;
}

/** True when `a` is a stronger action than `b` (RAID_ACTIONS is ordered by strength). */
export function isStronger(a: RaidAction, b: RaidAction): boolean {
  return RAID_ACTIONS.indexOf(a) > RAID_ACTIONS.indexOf(b);
}

export function clampInt(
  value: number,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Parse a stored action, falling back to the reversible default on anything unknown. */
export function parseRaidAction(value: string): RaidAction {
  return (RAID_ACTIONS as readonly string[]).includes(value)
    ? (value as RaidAction)
    : "timeout";
}

/**
 * Count the joins inside the sliding window ending at `now`, discarding older
 * ones in place. Order-independent (a join whose async work finished late can
 * carry an earlier timestamp), so it filters rather than trimming a prefix.
 */
export function countJoinsInWindow(
  joins: number[],
  now: number,
  windowMs: number,
): number {
  let kept = 0;
  for (const at of joins) {
    if (now - at < windowMs) joins[kept++] = at;
  }
  joins.length = kept;
  return kept;
}

/** True when an account is younger than the gate. A gate of 0 is off. */
export function isNewAccount(
  createdTimestamp: number,
  now: number,
  minAgeHours: number,
): boolean {
  if (minAgeHours <= 0) return false;
  return now - createdTimestamp < minAgeHours * MS_PER_HOUR;
}

/** What happened to members, counted per source of the decision. */
export interface ActionCounts {
  actioned: number;
  wouldAction: number;
  skipped: number;
  failed: number;
}

function freshCounts(): ActionCounts {
  return { actioned: 0, wouldAction: 0, skipped: 0, failed: 0 };
}

/**
 * The action-affecting settings an open lockdown runs under, captured when it
 * starts (for a manual start, the same snapshot the moderator was authorised
 * against). A settings change therefore affects only the next lockdown, never
 * one already running, so nobody can widen an authorised lockdown afterwards.
 * A lockdown restored after a restart snapshots the settings at restore time.
 */
export interface LockdownPolicy {
  lockdownAction: RaidAction;
  newAccountAction: RaidAction;
  minAccountAgeHours: number;
}

function policyOf(settings: RaidSettings): LockdownPolicy {
  return {
    lockdownAction: settings.lockdownAction,
    newAccountAction: settings.newAccountAction,
    minAccountAgeHours: settings.minAccountAgeHours,
  };
}

/** Per-guild runtime state. */
export interface RaidState {
  lockdown: boolean;
  /**
   * The lockdown began while `dry_run` was on. Such a lockdown never acts, and
   * is ended when dry run is switched off, so a rehearsal cannot turn into a
   * live lockdown nobody asked for.
   */
  dryRun: boolean;
  /** The policy the open lockdown runs under, or null when none is open. */
  policy: LockdownPolicy | null;
  /** When the current lockdown began (ms), or null. */
  since: number | null;
  /** The moderator who started it, or null when it was automatic. */
  startedBy: string | null;
  joins: number[];
  /**
   * The settings the join window was counted under. When they change (dry run
   * on/off, threshold, window) the window is emptied, so a count gathered
   * under other rules can never start a lockdown under the new ones.
   */
  windowKey: string | null;
  /** Counters for the current/most recent lockdown. */
  lockdownCounts: ActionCounts;
  /** Counters for the independent new-account gate, since the process started. */
  gateCounts: ActionCounts;
  failureAlerted: boolean;
  /**
   * Bumped by every lockdown start and end. A transition's alert is sent only
   * if no other transition happened while it awaited the log write, so a
   * stale "started" can never follow "ended".
   */
  generation: number;
  /** Fires the auto-expiry of the open lockdown, if it has a time limit. */
  expiryTimer: ReturnType<typeof setTimeout> | null;
}

function freshState(): RaidState {
  return {
    lockdown: false,
    dryRun: false,
    policy: null,
    since: null,
    startedBy: null,
    joins: [],
    windowKey: null,
    lockdownCounts: freshCounts(),
    gateCounts: freshCounts(),
    failureAlerted: false,
    generation: 0,
    expiryTimer: null,
  };
}

export interface RaidStatus {
  /** Null when active; otherwise why the feature is doing nothing. */
  inactiveReason: string | null;
  lockdown: boolean;
  since: number | null;
  startedBy: string | null;
  dryRun: boolean;
  joinsInWindow: number;
  joinThreshold: number;
  windowSeconds: number;
  lockdownAction: RaidAction;
  minAccountAgeHours: number;
  newAccountAction: RaidAction;
  /** Counts for the current/most recent lockdown. */
  counts: ActionCounts;
  /** Counts for the independent new-account gate since the bot started. */
  gateCounts: ActionCounts;
  /** Log rows still waiting to be written after a database failure. */
  unrecorded: number;
}

export interface LockdownRequirement {
  action: RaidAction;
  label: string;
  flag: bigint;
}

/**
 * The permission `/raidmode on` needs under a given settings snapshot: that of
 * the strongest action that can run during the lockdown. That is the lockdown
 * action, or the new-account action when the account gate is enabled and is
 * stronger, since a young account joining during the lockdown gets the stronger
 * of the two (timeout < quarantine < kick).
 */
export function requirementFor(settings: RaidSettings): LockdownRequirement {
  let action = settings.lockdownAction;
  if (
    settings.minAccountAgeHours > 0 &&
    isStronger(settings.newAccountAction, action)
  ) {
    action = settings.newAccountAction;
  }
  const { flag, label } = RAID_ACTION_PERMISSIONS[action];
  return { action, label, flag };
}

export interface SetLockdownResult {
  /** False when the request was a no-op or refused; see `message`. */
  changed: boolean;
  message: string;
}

interface Decision {
  action: RaidAction;
  reason: string;
}

const ROW_ACTION: Record<RaidAction, ModerationAction> = {
  timeout: "timeout",
  quarantine: "quarantine",
  kick: "kick",
};

export class RaidProtectionService {
  private static instance: RaidProtectionService | undefined;
  private client: Client;
  private configService: ConfigService;
  private readonly states = new Map<string, RaidState>();
  /** Quarantine-role problems already warned about, so a raid does not spam the log. */
  private readonly warned = new Set<string>();
  private reloadRegistered = false;
  /** Log rows not yet written because the database failed, oldest first. */
  /**
   * Two write queues. Lockdown/clear rows are the persisted lockdown state and
   * are written strictly in order; member-action rows are best-effort history.
   * Keeping them apart means a member row that keeps failing can never hold a
   * `raid_clear` back. A member row that fails its retries is parked (bounded)
   * and retried once the database is seen working again.
   */
  private transitionRows: LogRow[] = [];
  private memberRows: LogRow[] = [];
  private parkedRows: LogRow[] = [];
  private transitionDrain: Promise<void> | null = null;
  private memberDrain: Promise<void> | null = null;
  /** Resolved once `initialize()` has finished (or failed); joins wait on it. */
  private initDone = false;
  private waitedOut = false;
  private generationAtWaitOut = 0;
  private destroyed = false;
  private readonly transitionLock = createKeyedLock();
  private readyGate: Promise<void> | null = null;
  private gateTimer: ReturnType<typeof setTimeout> | null = null;
  private unregisterConfig: (() => void) | null = null;
  private markReady: () => void = () => undefined;
  private readonly ready: Promise<void> = new Promise<void>((resolve) => {
    this.markReady = (): void => {
      this.initDone = true;
      resolve();
    };
  });

  private constructor(client: Client) {
    this.client = client;
    this.configService = ConfigService.getInstance();
  }

  public static getInstance(client: Client): RaidProtectionService {
    if (!RaidProtectionService.instance) {
      RaidProtectionService.instance = new RaidProtectionService(client);
    } else if (RaidProtectionService.instance.client !== client) {
      throw new Error(
        "RaidProtectionService already initialised with a different client",
      );
    }
    return RaidProtectionService.instance;
  }

  public static reset(): void {
    RaidProtectionService.instance?.destroy();
    RaidProtectionService.instance = undefined;
  }

  /**
   * Stop the timers and unregister the config callbacks, so a destroyed
   * instance (shutdown, tests) neither keeps acting nor stays referenced.
   */
  public destroy(): void {
    for (const state of this.states.values()) {
      if (state.expiryTimer) clearTimeout(state.expiryTimer);
      state.expiryTimer = null;
    }
    if (this.gateTimer) clearTimeout(this.gateTimer);
    this.gateTimer = null;
    this.unregisterConfig?.();
    this.unregisterConfig = null;
    this.reloadRegistered = false;
    // Release anyone waiting on startup restoration, and make a restore that
    // finishes later a no-op, so shutdown never strands a join or arms a timer.
    this.destroyed = true;
    this.markReady();
  }

  /** Resolve and clamp every setting, once per decision. */
  public async loadSettings(): Promise<RaidSettings> {
    const c = this.configService;
    const [
      enabled,
      dryRun,
      joinThreshold,
      windowSeconds,
      lockdownAction,
      minAccountAgeHours,
      newAccountAction,
      timeoutMinutes,
      quarantineRoleId,
      lockdownMaxMinutes,
      alertChannelId,
    ] = await Promise.all([
      c.getBoolean(
        "moderation.raid.enabled",
        defaultConfig["moderation.raid.enabled"],
      ),
      c.getBoolean(
        "moderation.raid.dry_run",
        defaultConfig["moderation.raid.dry_run"],
      ),
      c.getNumber(
        "moderation.raid.join_threshold",
        defaultConfig["moderation.raid.join_threshold"],
      ),
      c.getNumber(
        "moderation.raid.window_seconds",
        defaultConfig["moderation.raid.window_seconds"],
      ),
      c.getString(
        "moderation.raid.lockdown_action",
        defaultConfig["moderation.raid.lockdown_action"],
      ),
      c.getNumber(
        "moderation.raid.min_account_age_hours",
        defaultConfig["moderation.raid.min_account_age_hours"],
      ),
      c.getString(
        "moderation.raid.new_account_action",
        defaultConfig["moderation.raid.new_account_action"],
      ),
      c.getNumber(
        "moderation.raid.timeout_minutes",
        defaultConfig["moderation.raid.timeout_minutes"],
      ),
      c.getString(
        "moderation.raid.quarantine_role_id",
        defaultConfig["moderation.raid.quarantine_role_id"],
      ),
      c.getNumber(
        "moderation.raid.lockdown_max_minutes",
        defaultConfig["moderation.raid.lockdown_max_minutes"],
      ),
      c.getString(
        "moderation.raid.alert_channel_id",
        defaultConfig["moderation.raid.alert_channel_id"],
      ),
    ]);
    return {
      enabled,
      dryRun,
      joinThreshold: clampInt(
        joinThreshold,
        MIN_JOIN_THRESHOLD,
        10000,
        defaultConfig["moderation.raid.join_threshold"],
      ),
      windowSeconds: clampInt(
        windowSeconds,
        MIN_WINDOW_SECONDS,
        MAX_WINDOW_SECONDS,
        defaultConfig["moderation.raid.window_seconds"],
      ),
      lockdownAction: parseRaidAction(lockdownAction),
      minAccountAgeHours: Math.max(0, Number(minAccountAgeHours) || 0),
      newAccountAction: parseRaidAction(newAccountAction),
      timeoutMinutes: clampInt(
        timeoutMinutes,
        MIN_TIMEOUT_MINUTES,
        MAX_TIMEOUT_MINUTES,
        defaultConfig["moderation.raid.timeout_minutes"],
      ),
      quarantineRoleId: quarantineRoleId.trim(),
      lockdownMaxMinutes: Math.max(0, Number(lockdownMaxMinutes) || 0),
      alertChannelId: alertChannelId.trim(),
    };
  }

  /**
   * Why the feature is doing nothing, or `null` when it is active. Surfaced by
   * `/raidmode status` and the startup warning so a missing prerequisite is
   * never a silent no-op.
   */
  public async getInactiveReason(
    settings?: RaidSettings,
  ): Promise<string | null> {
    const s = settings ?? (await this.loadSettings());
    if (!s.enabled) return "Anti-raid protection is switched off.";
    if (!(await this.configService.getBoolean("moderation.enabled", false))) {
      return "The moderation log (`moderation.enabled`) is off, and every anti-raid action must be recorded in it.";
    }
    if (!env.guildMembersIntent) {
      return `The bot is not requesting the Server Members Intent, so Discord never sends member-join events. ${GUILD_MEMBERS_INTENT_HOWTO}`;
    }
    return null;
  }

  /** Warn at startup when the feature is on but cannot work. Returns whether it warned. */
  public async warnIfInactive(): Promise<boolean> {
    const settings = await this.loadSettings().catch(() => null);
    if (!settings?.enabled) return false;
    const reason = await this.getInactiveReason(settings);
    if (!reason) return false;
    logger.warn(
      `moderation.raid.enabled is on but anti-raid protection is inactive: ${reason.replace(/`/g, "")}`,
    );
    return true;
  }

  /**
   * Restore a lockdown that was on when the process last stopped, from the
   * newest `raid_lockdown` / `raid_clear` row. Best effort: a failed read
   * leaves the guild out of lockdown, which is the safe direction.
   *
   * Two cases are deliberately not restored, so an old row cannot resurrect a
   * lockdown nobody is expecting: a rehearsal (dry run) lockdown, and any
   * lockdown found while the feature is inactive. The latter is closed with a
   * `raid_clear` row so it cannot come back when the feature is re-enabled.
   */
  public async initialize(): Promise<void> {
    try {
      if (!env.guildId) return;
      this.registerReload();
      await this.restoreLockdown(env.guildId);
    } finally {
      // Always release waiting joins, even when restoration failed.
      this.markReady();
    }
  }

  private async restoreLockdown(guildId: string): Promise<void> {
    try {
      const last = await ModerationLog.findOne({
        guildId,
        action: { $in: ["raid_lockdown", "raid_clear"] },
      })
        // `_id` breaks a millisecond tie: rows are written one at a time in
        // order, and ObjectIds from one process increase in creation order.
        .sort({ createdAt: -1, _id: -1 })
        .lean<{
          action: ModerationAction;
          createdAt: Date;
          moderatorId: string | null;
          reason: string | null;
        } | null>()
        .exec();
      if (this.destroyed || last?.action !== "raid_lockdown") return;

      const settings = await this.loadSettings();
      const inactive = await this.getInactiveReason(settings);
      if (this.destroyed) return;
      // Close, rather than restore, a lockdown that cannot be enforced or was
      // only a rehearsal, so the persisted state agrees with the in-memory one
      // and the retention exemption does not keep a stale open row alive.
      if (inactive || last.reason?.endsWith(DRY_RUN_SUFFIX)) {
        // A lockdown started, or any transition happened, since the wait gave
        // up: this stale row is no longer the newest truth, and a clear
        // written now would become the newest persisted transition and hide
        // the live lockdown from a restart.
        const current = this.getState(guildId);
        if (
          current.lockdown ||
          (this.waitedOut && current.generation !== this.generationAtWaitOut)
        ) {
          logger.info(
            "Anti-raid: skipped closing a stale lockdown row, the lockdown state changed while restoration was pending",
          );
          return;
        }
        await this.writeRow(
          guildId,
          guildId,
          null,
          "raid_clear",
          inactive
            ? "Automatic: anti-raid was inactive while a lockdown was open"
            : "Automatic: a dry-run lockdown is not restored after a restart",
        );
        return;
      }
      // The bounded startup wait already gave up (fail open): joins were
      // evaluated, and `/raidmode` answered, without this state. Applying it
      // now would reverse that decision behind everyone's back, so ignore it;
      // `/raidmode on` re-applies a lockdown deliberately.
      if (this.waitedOut) {
        const current = this.getState(guildId);
        if (
          current.lockdown ||
          current.generation !== this.generationAtWaitOut
        ) {
          // A newer decision exists; this stale row is not the newest truth.
          logger.warn(
            "Anti-raid: ignoring a lockdown restored after the startup wait timed out; the lockdown state changed meanwhile",
          );
          return;
        }
        // Nothing newer: close the stale row too, so a later restart (when the
        // database answers in time) cannot bring this lockdown back without a
        // deliberate `/raidmode on`.
        logger.warn(
          "Anti-raid: ignoring a lockdown restored after the startup wait timed out and closing its row; use /raidmode on to apply one",
        );
        await this.writeRow(
          guildId,
          guildId,
          null,
          "raid_clear",
          "Automatic: a lockdown found after the startup wait timed out was not restored; use /raidmode on to apply one",
        );
        return;
      }
      const state = this.getState(guildId);
      state.lockdown = true;
      // Snapshot the settings in force now; the original start's snapshot was
      // not persisted, and this is acceptable for a restored lockdown.
      state.policy = policyOf(settings);
      state.since = new Date(last.createdAt).getTime();
      state.startedBy =
        last.moderatorId && last.moderatorId !== this.client.user?.id
          ? last.moderatorId
          : null;
      this.scheduleExpiry(guildId, state, settings);
      logger.warn(
        "Anti-raid: restored an active lockdown from before the restart; clear it with /raidmode off",
      );
    } catch (error) {
      logger.error("Anti-raid: could not restore lockdown state:", error);
    }
  }

  /** Wait (bounded) for startup restoration; see {@link INIT_WAIT_MS}. */
  private async awaitReady(): Promise<void> {
    if (this.initDone || this.waitedOut) return;
    // One shared bounded wait for every caller, so a burst of joins during a
    // slow restore makes a single timer and a single warning.
    if (!this.readyGate) {
      this.readyGate = new Promise<void>((resolve) => {
        this.gateTimer = setTimeout(() => {
          this.waitedOut = true;
          // Remember which transitions had happened when we gave up, so a
          // late restore can tell whether anything changed since.
          this.generationAtWaitOut = env.guildId
            ? this.getState(env.guildId).generation
            : 0;
          logger.warn(
            `Anti-raid: startup restoration did not finish within ${INIT_WAIT_MS}ms; evaluating joins without the persisted lockdown state`,
          );
          resolve();
        }, INIT_WAIT_MS);
        this.gateTimer.unref?.();
        void this.ready.then(() => {
          if (this.gateTimer) clearTimeout(this.gateTimer);
          this.gateTimer = null;
          resolve();
        });
      });
    }
    await this.readyGate;
  }

  /**
   * Re-check the open lockdown whenever settings are saved, so switching the
   * feature (or `moderation.enabled`) off ends the lockdown at once instead of
   * leaving it to resume if the feature is switched back on.
   */
  private registerReload(): void {
    if (this.reloadRegistered) return;
    this.reloadRegistered = true;
    const recheck = async (): Promise<void> => {
      try {
        if (this.destroyed) return;
        const guildId = env.guildId;
        const guild = guildId ? this.client.guilds.cache.get(guildId) : null;
        if (!guild) return;
        await this.reconcile(guild, await this.loadSettings(), Date.now());
      } catch (error) {
        logger.error(
          "Anti-raid: error re-checking after a config change:",
          error,
        );
      }
    };
    // `triggerReload()` is only called by the wizard and the server scan; the
    // Settings and Moderation-card saves go through `ConfigService.set()`,
    // which only notifies change listeners. So subscribe to both: reload for
    // those paths, and a change listener (the pattern the update check uses,
    // #1029) for ordinary saves of the keys this feature depends on.
    const onChange = (key: string): void => {
      if (this.destroyed) return;
      if (key === "moderation.enabled" || key.startsWith("moderation.raid.")) {
        void recheck();
      }
    };
    this.configService.registerReloadCallback(recheck);
    this.configService.addChangeListener(onChange);
    this.unregisterConfig = (): void => {
      this.configService.removeReloadCallback(recheck);
      this.configService.removeChangeListener(onChange);
    };
  }

  /**
   * Bring the guild's state in line with the current settings before anything
   * acts on them. Every path that can act on a member or report state goes
   * through here first. Returns why the feature is inactive, or null.
   *
   *   - Inactive (switched off, moderation log off, no intent): an open
   *     lockdown is closed with a `raid_clear` row and the join window is
   *     emptied, so re-enabling later starts clean.
   *   - Dry run, threshold or window changed: the join window is emptied.
   *   - A rehearsal lockdown outliving dry run, or one past its auto-expiry,
   *     is ended.
   */
  private async reconcile(
    guild: Guild,
    settings: RaidSettings,
    now: number,
  ): Promise<string | null> {
    await this.awaitReady();
    // Retry rows a database outage left unwritten (single attempt, in order).
    await this.drainAll(false);
    const state = this.getState(guild.id);
    const inactive = await this.getInactiveReason(settings);
    if (this.destroyed) return "Anti-raid protection has been shut down.";
    if (inactive) {
      state.joins.length = 0;
      state.windowKey = null;
      if (state.lockdown) {
        await this.endLockdown(guild, state, settings, {
          moderatorId: null,
          reason: "Automatic: anti-raid became inactive during the lockdown",
        });
      }
      return inactive;
    }
    const windowKey = `${settings.dryRun}|${settings.joinThreshold}|${settings.windowSeconds}`;
    if (state.windowKey !== windowKey) {
      state.joins.length = 0;
      state.windowKey = windowKey;
    }
    await this.expireLockdownIfDue(guild, state, settings, now);
    await this.endDryRunLockdownIfLive(guild, state, settings);
    // (Re)arm the expiry for the current settings: they may have changed.
    this.scheduleExpiry(guild.id, state, settings);
    return null;
  }

  /**
   * Arm (or cancel) the timer that ends a lockdown at its time limit, so a
   * quiet server's lockdown ends on time without waiting for a join, a status
   * read or a settings save. The check in `expireLockdownIfDue` stays as the
   * backstop. One timer per guild, its handle kept on the state, never
   * keeping the process alive, and any error is logged, never thrown.
   */
  private scheduleExpiry(
    guildId: string,
    state: RaidState,
    settings: RaidSettings,
  ): void {
    if (state.expiryTimer) clearTimeout(state.expiryTimer);
    state.expiryTimer = null;
    if (this.destroyed) return;
    if (!state.lockdown || state.since === null) return;
    if (settings.lockdownMaxMinutes <= 0) return;
    const dueIn = Math.max(
      0,
      state.since + settings.lockdownMaxMinutes * MS_PER_MINUTE - Date.now(),
    );
    state.expiryTimer = setTimeout(
      () => {
        state.expiryTimer = null;
        void this.runExpiry(guildId);
      },
      // setTimeout cannot take more than a signed 32-bit delay.
      Math.min(dueIn, MAX_TIMER_MS),
    );
    state.expiryTimer.unref?.();
  }

  private async runExpiry(guildId: string): Promise<void> {
    try {
      const guild = this.client.guilds.cache.get(guildId);
      if (!guild) return;
      // reconcile ends the lockdown if it is due, or re-arms the timer (a long
      // limit, or a changed setting).
      await this.reconcile(guild, await this.loadSettings(), Date.now());
    } catch (error) {
      logger.error("Anti-raid: error ending an expired lockdown:", error);
    }
  }

  private getState(guildId: string): RaidState {
    let state = this.states.get(guildId);
    if (!state) {
      state = freshState();
      this.states.set(guildId, state);
    }
    return state;
  }

  /**
   * Handle a `guildMemberAdd` event. Never throws. Resolves `true` only when
   * the member was actually acted on, so the caller can skip the welcome
   * message for someone who was just kicked, timed out or quarantined.
   */
  public async handleMemberJoin(member: GuildMember): Promise<boolean> {
    try {
      if (this.destroyed || member.user.bot) return false;
      if (!env.guildId || member.guild.id !== env.guildId) return false;
      // Join evaluation waits for startup restoration first (bounded), then
      // takes its timestamp, so the wait cannot skew the window.
      await this.awaitReady();
      if (this.destroyed) return false;
      const now = Date.now();

      const settings = await this.loadSettings();
      if (this.destroyed) return false;
      const guild = member.guild;
      if (await this.reconcile(guild, settings, now)) return false;
      if (this.destroyed) return false;
      const state = this.getState(guild.id);

      // From the push to the `beginLockdown` call nothing awaits, and
      // `beginLockdown` sets `state.lockdown` before its own first await, so
      // concurrent joins cannot both start a lockdown.
      // Detection only runs while no lockdown is open: once locked the count
      // cannot trigger anything, and recording a flood of joins would make
      // the work grow with the burst.
      if (!state.lockdown) {
        state.joins.push(now);
        const count = countJoinsInWindow(
          state.joins,
          now,
          settings.windowSeconds * 1000,
        );
        if (count > settings.joinThreshold) {
          await this.beginLockdown(guild, state, settings, now, {
            moderatorId: null,
            reason: `Automatic: ${count} members joined within ${settings.windowSeconds}s (threshold ${settings.joinThreshold}).`,
          });
        }
      }

      // The two triggers are independent. One member gets one action, so when
      // both apply (a young account joining during lockdown) the stronger of
      // the two configured actions wins: the account gate is never weaker
      // during a lockdown than outside it.
      // While a lockdown is open its own snapshot decides the actions; outside
      // one, the live settings do (the account gate on its own).
      const policy =
        state.lockdown && state.policy ? state.policy : policyOf(settings);
      let decision: Decision | null = null;
      if (state.lockdown) {
        decision = {
          action: policy.lockdownAction,
          reason: "Anti-raid: joined during lockdown",
        };
      }
      if (
        isNewAccount(
          member.user.createdTimestamp,
          now,
          policy.minAccountAgeHours,
        )
      ) {
        const young: Decision = {
          action: policy.newAccountAction,
          reason: `Anti-raid: account younger than ${policy.minAccountAgeHours}h`,
        };
        decision =
          decision === null || isStronger(young.action, decision.action)
            ? {
                ...young,
                reason: decision
                  ? `${young.reason}, joined during lockdown`
                  : young.reason,
              }
            : decision;
      }
      if (decision) {
        return await this.applyDecision(member, decision, settings, state);
      }
      return false;
    } catch (error) {
      logger.error("Anti-raid: error handling member join:", error);
      return false;
    }
  }

  /** `/raidmode on|off`. Never throws; the message is shown to the moderator. */
  public setLockdown(
    guild: Guild,
    on: boolean,
    moderatorId: string,
    authorize?: (requirement: LockdownRequirement) => string | null,
  ): Promise<SetLockdownResult> {
    // One manual transition per guild at a time, so an `off` racing an `on`
    // is decided in a single order and acknowledged accordingly.
    return this.transitionLock.run(guild.id, () =>
      this.setLockdownNow(guild, on, moderatorId, authorize),
    );
  }

  private async setLockdownNow(
    guild: Guild,
    on: boolean,
    moderatorId: string,
    authorize?: (requirement: LockdownRequirement) => string | null,
  ): Promise<SetLockdownResult> {
    try {
      const settings = await this.loadSettings();
      const now = Date.now();
      const inactive = await this.reconcile(guild, settings, now);
      if (inactive) return { changed: false, message: inactive };
      const state = this.getState(guild.id);
      if (on) {
        if (state.lockdown) {
          return { changed: false, message: "Lockdown is already on." };
        }
        // Authorised against the very settings snapshot the lockdown starts
        // with, so a setting changed in between cannot widen the action.
        const refusal = authorize?.(requirementFor(settings)) ?? null;
        if (refusal) return { changed: false, message: refusal };
        const full = this.refuseIfTransitionQueueFull();
        if (full) return full;
        await this.beginLockdown(guild, state, settings, now, {
          moderatorId,
          reason: "Manual: started with /raidmode on",
        });
        if (!state.lockdown) {
          return {
            changed: true,
            message: "Lockdown was started, then ended by another action.",
          };
        }
        return {
          changed: true,
          message: settings.dryRun
            ? "Lockdown is on (dry run: new joins are counted but not acted on)."
            : `Lockdown is on. New joins get the **${settings.lockdownAction}** action until you run \`/raidmode off\`.`,
        };
      }
      if (!state.lockdown) {
        return { changed: false, message: "Lockdown is not on." };
      }
      const full = this.refuseIfTransitionQueueFull();
      if (full) return full;
      await this.endLockdown(guild, state, settings, {
        moderatorId,
        reason: "Manual: cleared with /raidmode off",
      });
      return { changed: true, message: "Lockdown is off." };
    } catch (error) {
      logger.error("Anti-raid: error toggling lockdown:", error);
      return {
        changed: false,
        message: `Could not change lockdown: ${getErrorMessage(error)}`,
      };
    }
  }

  /** Snapshot for `/raidmode status`. Also applies a due auto-expiry. */
  public async getStatus(guild: Guild): Promise<RaidStatus> {
    const settings = await this.loadSettings();
    const state = this.getState(guild.id);
    const now = Date.now();
    const inactiveReason = await this.reconcile(guild, settings, now);
    return {
      inactiveReason,
      lockdown: state.lockdown,
      since: state.since,
      startedBy: state.startedBy,
      dryRun: settings.dryRun,
      joinsInWindow: countJoinsInWindow(
        state.joins,
        now,
        settings.windowSeconds * 1000,
      ),
      joinThreshold: settings.joinThreshold,
      windowSeconds: settings.windowSeconds,
      // The action the open lockdown is actually running, else the settings
      // the next one would use.
      lockdownAction: (state.policy ?? settings).lockdownAction,
      minAccountAgeHours: (state.policy ?? settings).minAccountAgeHours,
      newAccountAction: (state.policy ?? settings).newAccountAction,
      counts: { ...state.lockdownCounts },
      gateCounts: { ...state.gateCounts },
      unrecorded: this.unrecordedCount(),
    };
  }

  private async expireLockdownIfDue(
    guild: Guild,
    state: RaidState,
    settings: RaidSettings,
    now: number,
  ): Promise<void> {
    if (
      !state.lockdown ||
      state.since === null ||
      settings.lockdownMaxMinutes <= 0 ||
      now - state.since < settings.lockdownMaxMinutes * MS_PER_MINUTE
    ) {
      return;
    }
    await this.endLockdown(guild, state, settings, {
      moderatorId: null,
      reason: `Automatic: lockdown reached its ${settings.lockdownMaxMinutes} minute limit.`,
    });
  }

  /**
   * A lockdown that began as a rehearsal is ended the moment dry run is
   * switched off, with an audit row and an alert saying so. Otherwise the
   * switch would make a lockdown nobody had confirmed start acting on joins.
   */
  private async endDryRunLockdownIfLive(
    guild: Guild,
    state: RaidState,
    settings: RaidSettings,
  ): Promise<void> {
    if (!state.lockdown || !state.dryRun || settings.dryRun) return;
    await this.endLockdown(guild, state, settings, {
      moderatorId: null,
      reason:
        "Automatic: dry run was switched off, so the rehearsal lockdown was ended",
    });
  }

  private async beginLockdown(
    guild: Guild,
    state: RaidState,
    settings: RaidSettings,
    now: number,
    info: { moderatorId: string | null; reason: string },
  ): Promise<void> {
    // State first, so any join that interleaves with the awaits below already
    // sees the lockdown.
    const generation = ++state.generation;
    state.lockdown = true;
    state.policy = policyOf(settings);
    // The joins that triggered it are spent; the window restarts when it ends.
    state.joins.length = 0;
    state.dryRun = settings.dryRun;
    state.since = now;
    state.startedBy = info.moderatorId;
    this.scheduleExpiry(guild.id, state, settings);
    state.lockdownCounts = freshCounts();
    state.failureAlerted = false;

    const suffix = settings.dryRun ? DRY_RUN_SUFFIX : "";
    await this.writeRow(
      guild.id,
      guild.id,
      info.moderatorId,
      "raid_lockdown",
      `${info.reason}${suffix}`,
    );
    logger.warn(
      `Anti-raid: lockdown started in guild ${sanitizeForLog(guild.id)}${suffix}: ${info.reason}`,
    );
    // Another transition ran while the row was being written: the alert for
    // this one would now be stale.
    if (state.generation !== generation) return;
    const how = settings.dryRun
      ? "Dry run is on, so nobody is being acted on."
      : `New joins get the **${settings.lockdownAction}** action.`;
    await this.sendAlert(
      guild,
      settings,
      `🛡️ **Raid lockdown started.** ${info.reason} ${how} A moderator can end it with \`/raidmode off\`.`,
    );
  }

  private async endLockdown(
    guild: Guild,
    state: RaidState,
    settings: RaidSettings,
    info: { moderatorId: string | null; reason: string },
  ): Promise<void> {
    // Both live and dry-run counts, since dry run can be switched on during a
    // live lockdown.
    const c = state.lockdownCounts;
    const summary = `${c.actioned} acted on, ${c.wouldAction} would have been (dry run), ${c.skipped} skipped, ${c.failed} failed`;
    const generation = ++state.generation;
    state.lockdown = false;
    state.policy = null;
    if (state.expiryTimer) clearTimeout(state.expiryTimer);
    state.expiryTimer = null;
    state.dryRun = false;
    state.since = null;
    state.startedBy = null;
    // Ending a lockdown resets detection too: the joins that triggered it must
    // not count again, or the very next join would restart it.
    state.joins.length = 0;

    await this.writeRow(
      guild.id,
      guild.id,
      info.moderatorId,
      "raid_clear",
      `${info.reason} (${summary})`,
    );
    logger.info(
      `Anti-raid: lockdown ended in guild ${sanitizeForLog(guild.id)}: ${info.reason} (${summary})`,
    );
    if (state.generation !== generation) return;
    await this.sendAlert(
      guild,
      settings,
      `✅ **Raid lockdown ended.** ${info.reason} During it: ${summary}. Review them in the moderation log.`,
    );
  }

  private async applyDecision(
    member: GuildMember,
    decision: Decision,
    settings: RaidSettings,
    state: RaidState,
  ): Promise<boolean> {
    const guildId = member.guild.id;
    // A decision made during a lockdown counts against it; the independent
    // new-account gate has its own counters.
    const counts = state.lockdown ? state.lockdownCounts : state.gateCounts;
    // The non-mutating checks (quarantine role, hierarchy and permissions) run
    // in dry run too, so a rehearsal counts a member the bot could not act on
    // as skipped, exactly as live mode would, and validates the role setup.
    let role: Role | null = null;
    if (decision.action === "quarantine") {
      role = await this.resolveQuarantineRole(member.guild, settings);
      if (this.destroyed) return false;
      if (!role) {
        counts.skipped++;
        return false;
      }
    }

    // The bot may only act where discord.js says it can: this excludes the
    // owner, members at or above the bot's highest role, and missing
    // permissions, so a raid never turns into a hierarchy violation.
    const allowed =
      decision.action === "kick"
        ? member.kickable
        : decision.action === "timeout"
          ? member.moderatable
          : member.manageable;
    if (!allowed) {
      counts.skipped++;
      logger.warn(
        `Anti-raid: skipped ${decision.action} on user ${sanitizeForLog(member.id)}: the bot is not allowed to act on this member (role position or permission)`,
      );
      return false;
    }

    if (settings.dryRun) {
      counts.wouldAction++;
      logger.info(
        `Anti-raid (dry run): would ${decision.action} user ${sanitizeForLog(member.id)} in guild ${sanitizeForLog(guildId)}: ${decision.reason}`,
      );
      return false;
    }

    // Nothing is done to a member once the service is shut down.
    if (this.destroyed) return false;
    const auditReason = truncateText(decision.reason, MAX_REASON_LENGTH);
    try {
      if (decision.action === "kick") {
        await member.kick(auditReason);
      } else if (decision.action === "timeout") {
        await member.timeout(
          settings.timeoutMinutes * MS_PER_MINUTE,
          auditReason,
        );
      } else if (role) {
        await member.roles.add(role, auditReason);
      }
    } catch (error) {
      counts.failed++;
      logger.error(
        `Anti-raid: ${decision.action} failed for user ${sanitizeForLog(member.id)}:`,
        error,
      );
      if (!state.failureAlerted) {
        state.failureAlerted = true;
        await this.sendAlert(
          member.guild,
          settings,
          `⚠️ An anti-raid **${decision.action}** failed (${getErrorMessage(error)}). Check the bot's permissions and role position; the log has the rest.`,
        );
      }
      return false;
    }

    counts.actioned++;
    await this.writeRow(
      guildId,
      member.id,
      this.client.user?.id ?? null,
      ROW_ACTION[decision.action],
      decision.reason,
    );
    return true;
  }

  private async resolveQuarantineRole(
    guild: Guild,
    settings: RaidSettings,
  ): Promise<Role | null> {
    const id = settings.quarantineRoleId;
    let problem: string | null = null;
    let role: Role | null = null;
    if (!id) {
      problem = "no quarantine role is configured";
    } else {
      role =
        guild.roles.cache.get(id) ??
        (await guild.roles.fetch(id).catch(() => null));
      if (!role) problem = "the quarantine role no longer exists";
      else if (role.id === guild.id || role.managed)
        problem = "the quarantine role must be an ordinary role";
      else if (!role.editable)
        problem = "the quarantine role is not below the bot's highest role";
    }
    if (problem) {
      if (!this.warned.has(problem)) {
        this.warned.add(problem);
        logger.warn(`Anti-raid: quarantine skipped, ${problem}`);
      }
      return null;
    }
    this.warned.clear();
    return role;
  }

  /**
   * Queue a log row and write it. The audit mirror deliberately ignores
   * actions the bot executed itself, so a lost row would be lost for good;
   * therefore a failed write is retried with a short backoff and, if it still
   * fails, kept in memory and retried on the next write, join, status read or
   * settings reload, in order, so a `raid_clear` can never land before the
   * `raid_lockdown` it closes. Failures are logged at error level and shown as
   * "unrecorded" in `/raidmode status`. The queue is in memory only: rows still
   * pending when the process dies are lost, and a lost `raid_clear` makes the
   * next start restore the lockdown, the safe direction (`/raidmode off`
   * clears it). Bounded so a long outage cannot grow memory: past the cap the
   * oldest member-action row is shed, and lockdown/clear rows are never shed,
   * so the queue can exceed the cap by the number of transitions (one per
   * lockdown start or end, bounded by people and the service, not by join
   * volume).
   *
   * A lockdown/clear write resolves only after its own row was attempted (it
   * waits for any drain in progress, then drains again), so a command or alert
   * never reports a transition as done while its row is only queued. That wait
   * is bounded by the retry backoff of the head row. Member-action rows are
   * fire-and-forget: the join path never waits on the database.
   */
  private async writeRow(
    guildId: string,
    userId: string,
    moderatorId: string | null,
    action: ModerationAction,
    reason: string,
  ): Promise<void> {
    if (this.destroyed) return;
    if (
      (action === "raid_lockdown" || action === "raid_clear") &&
      this.pendingTransitionCount() >= MAX_PENDING_TRANSITIONS
    ) {
      logger.error(
        `Anti-raid: ${MAX_PENDING_TRANSITIONS} lockdown log rows are waiting for the database; dropped the new ${action} row`,
      );
      return;
    }
    const row: LogRow = {
      // Fixed when the row is queued, in queue order: a retry of an attempt
      // whose outcome was unknown (inserted, but the reply was lost) writes
      // the same `_id` and cannot create a second row, and `_id` order stays
      // the write order that restoration and retention rely on.
      _id: new Types.ObjectId(),
      guildId,
      userId,
      moderatorId,
      action,
      reason: truncateText(reason, MAX_REASON_LENGTH),
      source: "raid",
      createdAt: new Date(),
    };
    if (isTransitionRow(row)) {
      this.transitionRows.push(row);
      await this.drain("transition", true);
      return;
    }
    this.memberRows.push(row);
    if (this.memberRows.length > MAX_PENDING_ROWS) {
      // Shed the oldest member action. Lockdown/clear rows live in their own
      // queue and are never shed.
      this.memberRows.shift();
      logger.error(
        "Anti-raid: too many unwritten log rows, dropped the oldest member action row",
      );
    }
    void this.drain("member", true).catch((error) => {
      logger.error("Anti-raid: error writing log rows:", error);
    });
  }

  /** Refuse a manual transition while too many are waiting for the database. */
  private refuseIfTransitionQueueFull(): SetLockdownResult | null {
    if (this.pendingTransitionCount() < MAX_PENDING_TRANSITIONS) return null;
    logger.error(
      `Anti-raid: refused a lockdown change, ${MAX_PENDING_TRANSITIONS} lockdown log rows are waiting for the database`,
    );
    return {
      changed: false,
      message:
        "Cannot change lockdown: the database has been failing and too many lockdown log rows are waiting to be written. Fix the database first.",
    };
  }

  private pendingTransitionCount(): number {
    return this.transitionRows.length;
  }

  private unrecordedCount(): number {
    return (
      this.transitionRows.length +
      this.memberRows.length +
      this.parkedRows.length
    );
  }

  /** Attempt every queued row once, in order (used before reading state). */
  private async drainAll(withRetries: boolean): Promise<void> {
    if (this.unrecordedCount() === 0) return;
    await this.drain("transition", withRetries);
    await this.drain("member", withRetries);
    // With nothing queued, a parked row acts as the probe for a recovered
    // database: one attempt, and the rest follow only if it succeeds.
    await this.retryParked();
  }

  /**
   * Write one queue's rows in order. Callers of one queue share one drain at a
   * time; a caller that arrives during a drain waits for it and then drains
   * again, so rows appended meanwhile are attempted before it returns. A
   * transition drain stops at the first row that still fails after its
   * retries (strict order); a member drain parks that row and carries on. Every
   * wait is therefore finite.
   */
  private async drain(
    kind: "transition" | "member",
    withRetries: boolean,
  ): Promise<void> {
    const slot = kind === "transition" ? "transitionDrain" : "memberDrain";
    while (this[slot]) await this[slot];
    this[slot] = this.runDrain(kind, withRetries).finally(() => {
      this[slot] = null;
    });
    await this[slot];
  }

  private async runDrain(
    kind: "transition" | "member",
    withRetries: boolean,
  ): Promise<void> {
    const queue = kind === "transition" ? this.transitionRows : this.memberRows;
    const attempts = withRetries ? ROW_RETRY_DELAYS_MS.length + 1 : 1;
    let wroteAny = false;
    while (queue.length > 0) {
      const row = queue[0];
      const written = await this.tryWrite(row, attempts);
      if (!written) {
        if (kind === "transition") return;
        // Park it so it cannot hold later member rows back.
        if (queue[0] === row) queue.shift();
        this.parkedRows.push(row);
        if (this.parkedRows.length > MAX_PENDING_ROWS) {
          this.parkedRows.shift();
          logger.error(
            "Anti-raid: too many parked log rows, dropped the oldest member action row",
          );
        }
        continue;
      }
      wroteAny = true;
      // The head may have been dropped by the cap while we were writing.
      if (queue[0] === row) queue.shift();
    }
    // A write just succeeded, so the database is up: give parked rows a go.
    if (kind === "member" && wroteAny) await this.retryParked();
  }

  /**
   * Retry parked member rows oldest first, one attempt each, stopping at the
   * first failure so a database that is still down costs a single attempt.
   */
  private async retryParked(): Promise<void> {
    while (this.parkedRows.length > 0) {
      const row = this.parkedRows[0];
      if (!(await this.tryWrite(row, 1))) return;
      if (this.parkedRows[0] === row) this.parkedRows.shift();
    }
  }

  private async tryWrite(row: LogRow, attempts: number): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
      try {
        await ModerationLog.create(row);
        return true;
      } catch (error) {
        // A duplicate key on our own fixed `_id` means an earlier, ambiguous
        // attempt did commit: the row is written.
        if ((error as { code?: number }).code === 11000) return true;
        logger.error(
          `Anti-raid: failed to write moderation log row (attempt ${i + 1}/${attempts}, ${this.unrecordedCount()} unrecorded):`,
          error,
        );
        if (i < attempts - 1) {
          await new Promise((resolve) =>
            setTimeout(resolve, ROW_RETRY_DELAYS_MS[i]),
          );
        }
      }
    }
    return false;
  }

  private async sendAlert(
    guild: Guild,
    settings: RaidSettings,
    content: string,
  ): Promise<void> {
    if (!settings.alertChannelId) return;
    try {
      const channel = await guild.channels.fetch(settings.alertChannelId);
      if (!channel || !channel.isTextBased() || !("send" in channel)) return;
      await channel.send({ content, allowedMentions: { parse: [] } });
    } catch (error) {
      logger.error("Anti-raid: failed to post alert:", error);
    }
  }
}
