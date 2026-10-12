import { Client, Guild, GuildMember, type Role } from "discord.js";
import { ConfigService } from "./config-service.js";
import { env } from "../config/env.js";
import logger from "../utils/logger.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";
import { getErrorMessage } from "../utils/error-guards.js";
import { truncateText } from "../utils/discord-limits.js";
import { MAX_REASON_LENGTH } from "../utils/moderation-guards.js";
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

export const RAID_ACTIONS = ["timeout", "quarantine", "kick"] as const;
export type RaidAction = (typeof RAID_ACTIONS)[number];

export const MIN_JOIN_THRESHOLD = 2;
export const MIN_WINDOW_SECONDS = 5;
export const MAX_WINDOW_SECONDS = 3600;
export const MIN_TIMEOUT_MINUTES = 1;
/** Discord's hard cap on a communication timeout (28 days). */
export const MAX_TIMEOUT_MINUTES = 28 * 24 * 60;

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

/** Per-guild runtime state. */
export interface RaidState {
  lockdown: boolean;
  /** When the current lockdown began (ms), or null. */
  since: number | null;
  /** The moderator who started it, or null when it was automatic. */
  startedBy: string | null;
  joins: number[];
  actioned: number;
  wouldAction: number;
  skipped: number;
  failed: number;
  failureAlerted: boolean;
}

function freshState(): RaidState {
  return {
    lockdown: false,
    since: null,
    startedBy: null,
    joins: [],
    actioned: 0,
    wouldAction: 0,
    skipped: 0,
    failed: 0,
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
  actioned: number;
  wouldAction: number;
  skipped: number;
  failed: number;
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
      c.getBoolean("moderation.raid.enabled", false),
      c.getBoolean("moderation.raid.dry_run", true),
      c.getNumber("moderation.raid.join_threshold", 10),
      c.getNumber("moderation.raid.window_seconds", 30),
      c.getString("moderation.raid.lockdown_action", "timeout"),
      c.getNumber("moderation.raid.min_account_age_hours", 0),
      c.getString("moderation.raid.new_account_action", "timeout"),
      c.getNumber("moderation.raid.timeout_minutes", 60),
      c.getString("moderation.raid.quarantine_role_id", ""),
      c.getNumber("moderation.raid.lockdown_max_minutes", 0),
      c.getString("moderation.raid.alert_channel_id", ""),
    ]);
    return {
      enabled,
      dryRun,
      joinThreshold: clampInt(joinThreshold, MIN_JOIN_THRESHOLD, 10000, 10),
      windowSeconds: clampInt(
        windowSeconds,
        MIN_WINDOW_SECONDS,
        MAX_WINDOW_SECONDS,
        30,
      ),
      lockdownAction: parseRaidAction(lockdownAction),
      minAccountAgeHours: Math.max(0, Number(minAccountAgeHours) || 0),
      newAccountAction: parseRaidAction(newAccountAction),
      timeoutMinutes: clampInt(
        timeoutMinutes,
        MIN_TIMEOUT_MINUTES,
        MAX_TIMEOUT_MINUTES,
        60,
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
   */
  public async initialize(): Promise<void> {
    if (!env.guildId) return;
    try {
      const last = await ModerationLog.findOne({
        guildId: env.guildId,
        action: { $in: ["raid_lockdown", "raid_clear"] },
      })
        .sort({ createdAt: -1 })
        .lean<{
          action: ModerationAction;
          createdAt: Date;
          moderatorId: string | null;
        } | null>()
        .exec();
      if (last?.action === "raid_lockdown") {
        const state = this.getState(env.guildId);
        state.lockdown = true;
        state.since = new Date(last.createdAt).getTime();
        state.startedBy =
          last.moderatorId && last.moderatorId !== this.client.user?.id
            ? last.moderatorId
            : null;
        logger.warn(
          "Anti-raid: restored an active lockdown from before the restart; clear it with /raidmode off",
        );
      }
    } catch (error) {
      logger.error("Anti-raid: could not restore lockdown state:", error);
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
      if (member.user.bot) return false;
      if (!env.guildId || member.guild.id !== env.guildId) return false;
      // Captured before any await so a slow config read cannot skew the window.
      const now = Date.now();

      const settings = await this.loadSettings();
      if (await this.getInactiveReason(settings)) return false;

      const guild = member.guild;
      const state = this.getState(guild.id);

      await this.expireLockdownIfDue(guild, state, settings, now);

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
      const inactive = await this.getInactiveReason(settings);
      if (inactive) return { changed: false, message: inactive };
      const state = this.getState(guild.id);
      const now = Date.now();
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
    await this.expireLockdownIfDue(guild, state, settings, now);
    return {
      inactiveReason: await this.getInactiveReason(settings),
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
      actioned: state.actioned,
      wouldAction: state.wouldAction,
      skipped: state.skipped,
      failed: state.failed,
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
    state.since = now;
    state.startedBy = info.moderatorId;
    state.actioned = 0;
    state.wouldAction = 0;
    state.skipped = 0;
    state.failed = 0;
    state.failureAlerted = false;

    const suffix = settings.dryRun ? " (dry run)" : "";
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
    const summary = settings.dryRun
      ? `${state.wouldAction} would have been acted on`
      : `${state.actioned} acted on, ${state.skipped} skipped, ${state.failed} failed`;
    state.lockdown = false;
    state.since = null;
    state.startedBy = null;

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
    if (settings.dryRun) {
      state.wouldAction++;
      logger.info(
        `Anti-raid (dry run): would ${decision.action} user ${sanitizeForLog(member.id)} in guild ${sanitizeForLog(guildId)}: ${decision.reason}`,
      );
      return false;
    }

    let role: Role | null = null;
    if (decision.action === "quarantine") {
      role = await this.resolveQuarantineRole(member.guild, settings);
      if (!role) {
        state.skipped++;
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
      state.skipped++;
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
      state.failed++;
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

    state.actioned++;
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

  private async writeRow(
    guildId: string,
    userId: string,
    moderatorId: string | null,
    action: ModerationAction,
    reason: string,
  ): Promise<void> {
    try {
      await ModerationLog.create({
        guildId,
        userId,
        moderatorId,
        action,
        reason: truncateText(reason, MAX_REASON_LENGTH),
        source: "raid",
      });
    } catch (error) {
      // The action already happened; losing the row is logged, not thrown.
      logger.error("Anti-raid: failed to write moderation log row:", error);
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
