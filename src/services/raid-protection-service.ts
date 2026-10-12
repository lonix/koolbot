import { Client, Guild, GuildMember, type Role } from "discord.js";
import { ConfigService } from "./config-service.js";
import { env } from "../config/env.js";
import logger from "../utils/logger.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";
import { getErrorMessage } from "../utils/error-guards.js";
import { truncateText } from "../utils/discord-limits.js";
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
 * an account-age gate. Event-driven only (no timers): a lockdown that has an
 * auto-expiry is ended lazily on the next join or status read.
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
const MAX_PENDING_ROWS = 500;

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

/** Per-guild runtime state. */
export interface RaidState {
  lockdown: boolean;
  /**
   * The lockdown began while `dry_run` was on. Such a lockdown never acts, and
   * is ended when dry run is switched off, so a rehearsal cannot turn into a
   * live lockdown nobody asked for.
   */
  dryRun: boolean;
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
}

function freshState(): RaidState {
  return {
    lockdown: false,
    dryRun: false,
    since: null,
    startedBy: null,
    joins: [],
    windowKey: null,
    lockdownCounts: freshCounts(),
    gateCounts: freshCounts(),
    failureAlerted: false,
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
  private pendingRows: Array<Record<string, unknown>> = [];
  private draining = false;
  /** Resolved once `initialize()` has finished (or failed); joins wait on it. */
  private initDone = false;
  private waitedOut = false;
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
    RaidProtectionService.instance = undefined;
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
      return "The Server Members Intent is off (`GUILD_MEMBERS_INTENT`), so Discord never sends member-join events.";
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
      if (last?.action !== "raid_lockdown") return;

      const settings = await this.loadSettings();
      const inactive = await this.getInactiveReason(settings);
      // Close, rather than restore, a lockdown that cannot be enforced or was
      // only a rehearsal, so the persisted state agrees with the in-memory one
      // and the retention exemption does not keep a stale open row alive.
      if (inactive || last.reason?.endsWith(DRY_RUN_SUFFIX)) {
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
      const state = this.getState(guildId);
      state.lockdown = true;
      state.since = new Date(last.createdAt).getTime();
      state.startedBy =
        last.moderatorId && last.moderatorId !== this.client.user?.id
          ? last.moderatorId
          : null;
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.waitedOut = true;
        logger.warn(
          `Anti-raid: startup restoration did not finish within ${INIT_WAIT_MS}ms; evaluating joins without the persisted lockdown state`,
        );
        resolve();
      }, INIT_WAIT_MS);
    });
    try {
      await Promise.race([this.ready, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The permission a moderator needs for `/raidmode on` under the current
   * settings: the one matching the configured lockdown action.
   */
  public async getLockdownRequirement(): Promise<{
    action: RaidAction;
    label: string;
    flag: bigint;
  }> {
    const { lockdownAction } = await this.loadSettings();
    const { flag, label } = RAID_ACTION_PERMISSIONS[lockdownAction];
    return { action: lockdownAction, label, flag };
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
    this.configService.registerReloadCallback(recheck);
    this.configService.addChangeListener((key) => {
      if (key === "moderation.enabled" || key.startsWith("moderation.raid.")) {
        void recheck();
      }
    });
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
    if (this.pendingRows.length > 0) await this.drainPendingRows(false);
    const state = this.getState(guild.id);
    const inactive = await this.getInactiveReason(settings);
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
    return null;
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
      if (member.user.bot) return false;
      if (!env.guildId || member.guild.id !== env.guildId) return false;
      // Join evaluation waits for startup restoration first (bounded), then
      // takes its timestamp, so the wait cannot skew the window.
      await this.awaitReady();
      const now = Date.now();

      const settings = await this.loadSettings();
      const guild = member.guild;
      if (await this.reconcile(guild, settings, now)) return false;
      const state = this.getState(guild.id);

      // From the push to the `beginLockdown` call nothing awaits, and
      // `beginLockdown` sets `state.lockdown` before its own first await, so
      // concurrent joins cannot both start a lockdown.
      state.joins.push(now);
      const count = countJoinsInWindow(
        state.joins,
        now,
        settings.windowSeconds * 1000,
      );

      if (!state.lockdown && count > settings.joinThreshold) {
        await this.beginLockdown(guild, state, settings, now, {
          moderatorId: null,
          reason: `Automatic: ${count} members joined within ${settings.windowSeconds}s (threshold ${settings.joinThreshold}).`,
        });
      }

      let decision: Decision | null = null;
      if (state.lockdown) {
        decision = {
          action: settings.lockdownAction,
          reason: "Anti-raid: joined during lockdown",
        };
      } else if (
        isNewAccount(
          member.user.createdTimestamp,
          now,
          settings.minAccountAgeHours,
        )
      ) {
        decision = {
          action: settings.newAccountAction,
          reason: `Anti-raid: account younger than ${settings.minAccountAgeHours}h`,
        };
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
  public async setLockdown(
    guild: Guild,
    on: boolean,
    moderatorId: string,
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
        await this.beginLockdown(guild, state, settings, now, {
          moderatorId,
          reason: "Manual: started with /raidmode on",
        });
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
      lockdownAction: settings.lockdownAction,
      minAccountAgeHours: settings.minAccountAgeHours,
      newAccountAction: settings.newAccountAction,
      counts: { ...state.lockdownCounts },
      gateCounts: { ...state.gateCounts },
      unrecorded: this.pendingRows.length,
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
    state.lockdown = true;
    state.dryRun = settings.dryRun;
    state.since = now;
    state.startedBy = info.moderatorId;
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
    const summary = state.dryRun
      ? `${state.lockdownCounts.wouldAction} would have been acted on`
      : `${state.lockdownCounts.actioned} acted on, ${state.lockdownCounts.skipped} skipped, ${state.lockdownCounts.failed} failed`;
    state.lockdown = false;
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
    if (settings.dryRun) {
      counts.wouldAction++;
      logger.info(
        `Anti-raid (dry run): would ${decision.action} user ${sanitizeForLog(member.id)} in guild ${sanitizeForLog(guildId)}: ${decision.reason}`,
      );
      return false;
    }

    let role: Role | null = null;
    if (decision.action === "quarantine") {
      role = await this.resolveQuarantineRole(member.guild, settings);
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
   * clears it). Bounded so a long outage cannot grow memory.
   */
  private async writeRow(
    guildId: string,
    userId: string,
    moderatorId: string | null,
    action: ModerationAction,
    reason: string,
  ): Promise<void> {
    this.pendingRows.push({
      guildId,
      userId,
      moderatorId,
      action,
      reason: truncateText(reason, MAX_REASON_LENGTH),
      source: "raid",
      createdAt: new Date(),
    });
    if (this.pendingRows.length > MAX_PENDING_ROWS) {
      this.pendingRows.shift();
      logger.error(
        "Anti-raid: too many unwritten log rows, dropped the oldest one",
      );
    }
    await this.drainPendingRows(true);
  }

  private async drainPendingRows(withRetries: boolean): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pendingRows.length > 0) {
        const row = this.pendingRows[0];
        let written = false;
        const attempts = withRetries ? ROW_RETRY_DELAYS_MS.length + 1 : 1;
        for (let i = 0; i < attempts && !written; i++) {
          try {
            await ModerationLog.create(row);
            written = true;
          } catch (error) {
            logger.error(
              `Anti-raid: failed to write moderation log row (attempt ${i + 1}/${attempts}, ${this.pendingRows.length} pending):`,
              error,
            );
            if (i < attempts - 1) {
              await new Promise((resolve) =>
                setTimeout(resolve, ROW_RETRY_DELAYS_MS[i]),
              );
            }
          }
        }
        if (!written) return;
        // The head may have been dropped by the cap while we were writing.
        if (this.pendingRows[0] === row) this.pendingRows.shift();
      }
    } finally {
      this.draining = false;
    }
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
