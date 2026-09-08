import {
  AuditLogEvent,
  Client,
  Guild,
  type GuildAuditLogsEntry,
} from "discord.js";
import logger from "../utils/logger.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";
import { ConfigService } from "./config-service.js";
import { DiscordLogger } from "./discord-logger.js";
import {
  actionColor,
  actionLabel,
  formatHistorySummary,
  type ModerationHistorySummary,
} from "../utils/moderation-format.js";
import {
  truncateText,
  DISCORD_EMBED_FIELD_VALUE_LIMIT,
} from "../utils/discord-limits.js";
import {
  ModerationLog,
  type IModerationLog,
  type ModerationAction,
} from "../models/moderation-log.js";

export interface WarnInput {
  guildId: string;
  userId: string;
  moderatorId: string;
  reason: string | null;
}

export interface ModerationHistoryQuery {
  limit: number;
  skip: number;
}

export interface RecentQuery extends ModerationHistoryQuery {
  action?: ModerationAction;
  userId?: string;
}

/**
 * The action that was just recorded, as the context notice needs to describe
 * it. `entryId` is the `_id` of the row that was written, so the prior-history
 * roll-up can exclude it and read as history rather than counting the action
 * being announced (#907).
 */
export interface ActionContext {
  guildId: string;
  userId: string;
  moderatorId: string | null;
  action: ModerationAction;
  reason: string | null;
  entryId: unknown;
}

/**
 * The result of interpreting a guild audit-log entry as a moderation action.
 * `null` when the entry is not a moderation action we mirror (e.g. a
 * `MemberUpdate` that only changed a nickname).
 */
export interface MappedAuditEntry {
  action: ModerationAction;
  reason: string | null;
}

/**
 * Interpret a `GuildAuditLogEntryCreate` entry as a moderation action, or
 * return `null` when it isn't one we mirror. Pure and exported so the mapping
 * (especially the timeout add/remove disambiguation) is unit-testable without
 * a live gateway.
 *
 * Timeouts have no dedicated audit-log action: Discord records them as a
 * `MemberUpdate` carrying a `communication_disabled_until` change. A non-empty
 * new value is a timeout being applied; an empty/absent new value is a timeout
 * being lifted. A `MemberUpdate` without that change key (a plain nickname or
 * role edit) is not a moderation action.
 */
export function mapAuditLogEntry(entry: {
  action: number;
  reason: string | null;
  changes: ReadonlyArray<{ key: string; old?: unknown; new?: unknown }>;
}): MappedAuditEntry | null {
  const reason = entry.reason ?? null;
  switch (entry.action) {
    case AuditLogEvent.MemberKick:
      return { action: "kick", reason };
    case AuditLogEvent.MemberBanAdd:
      return { action: "ban", reason };
    case AuditLogEvent.MemberBanRemove:
      return { action: "unban", reason };
    case AuditLogEvent.MemberUpdate: {
      const change = entry.changes.find(
        (c) => c.key === "communication_disabled_until",
      );
      if (!change) return null;
      // A future timestamp string in `new` means a timeout was applied; a
      // cleared value (undefined / null / empty) means it was lifted.
      const applied =
        change.new !== undefined && change.new !== null && change.new !== "";
      return { action: applied ? "timeout" : "untimeout", reason };
    }
    default:
      return null;
  }
}

/**
 * Moderation log (issue #728). Owns two write paths into the shared
 * `ModerationLog` collection and the read paths that `/modlog` and the admin
 * `/admin/moderation` page consume:
 *
 *   - `/warn` calls {@link logWarn} directly — bot-issued warnings are not a
 *     native Discord action, so KoolBot is the only place they exist.
 *   - {@link handleAuditLogEntry} mirrors native kick/ban/unban/timeout
 *     actions from `GuildAuditLogEntryCreate`, following the same "aggregate
 *     what already happens" pattern the activity trackers use.
 *
 * Both write paths also announce the action, with the target's prior history
 * attached, to the `core.moderation` Discord log channel (#907) — see
 * {@link postActionContext}.
 *
 * The whole feature is gated behind `moderation.enabled` (default off). There
 * are no timers to own, so the service needs no start/destroy — it is a thin
 * façade over the model plus the config gate, constructed with the standard
 * `getInstance(client)` singleton pattern.
 */
export class ModerationService {
  private static instance: ModerationService;
  private client: Client;
  private configService: ConfigService;

  private constructor(client: Client) {
    this.client = client;
    this.configService = ConfigService.getInstance();
  }

  public static getInstance(client: Client): ModerationService {
    if (!ModerationService.instance) {
      ModerationService.instance = new ModerationService(client);
    } else if (ModerationService.instance.client !== client) {
      throw new Error(
        "ModerationService already initialised with a different client",
      );
    }
    return ModerationService.instance;
  }

  public static reset(): void {
    ModerationService.instance = undefined as unknown as ModerationService;
  }

  public async isEnabled(): Promise<boolean> {
    return this.configService.getBoolean("moderation.enabled", false);
  }

  public async initialize(): Promise<void> {
    const enabled = await this.isEnabled();
    logger.info(
      `ModerationService initialized (moderation.enabled=${enabled})`,
    );
  }

  /**
   * Record a bot-issued warning. Called by the `/warn` command. Returns the
   * persisted row so the caller can surface a confirmation.
   */
  public async logWarn(input: WarnInput): Promise<IModerationLog> {
    const entry = await ModerationLog.create({
      guildId: input.guildId,
      userId: input.userId,
      moderatorId: input.moderatorId,
      action: "warn",
      reason: input.reason,
      source: "command",
    });
    logger.info(
      `Moderation: warn recorded for user ${sanitizeForLog(
        input.userId,
      )} by ${sanitizeForLog(input.moderatorId)} in guild ${sanitizeForLog(
        input.guildId,
      )}`,
    );
    await this.postActionContext({
      guildId: input.guildId,
      userId: input.userId,
      moderatorId: input.moderatorId,
      action: "warn",
      reason: input.reason,
      entryId: entry._id,
    });
    return entry;
  }

  /**
   * Mirror a native moderation action from a `GuildAuditLogEntryCreate`
   * event. No-op when the feature is disabled, when the entry is not a
   * moderation action, or when the target is unknown. Never throws — a
   * failure here must not crash the gateway event handler.
   */
  public async handleAuditLogEntry(
    entry: GuildAuditLogsEntry,
    guild: Guild,
  ): Promise<void> {
    try {
      if (!(await this.isEnabled())) return;

      const mapped = mapAuditLogEntry({
        action: entry.action,
        reason: entry.reason,
        changes: entry.changes,
      });
      if (!mapped) return;

      const targetId = entry.targetId;
      if (!targetId) {
        logger.debug(
          `Moderation: skipping ${mapped.action} audit entry with no target`,
        );
        return;
      }

      const row = await ModerationLog.create({
        guildId: guild.id,
        userId: targetId,
        moderatorId: entry.executorId ?? null,
        action: mapped.action,
        reason: mapped.reason,
        source: "audit",
      });
      logger.info(
        `Moderation: mirrored ${mapped.action} for user ${sanitizeForLog(
          targetId,
        )} from audit log in guild ${sanitizeForLog(guild.id)}`,
      );
      await this.postActionContext({
        guildId: guild.id,
        userId: targetId,
        moderatorId: entry.executorId ?? null,
        action: mapped.action,
        reason: mapped.reason,
        entryId: row?._id,
      });
    } catch (error) {
      logger.error("Error mirroring moderation audit-log entry:", error);
    }
  }

  /** Per-user history, newest first. Backs `/modlog <user>`. */
  public async getHistory(
    guildId: string,
    userId: string,
    query: ModerationHistoryQuery,
  ): Promise<IModerationLog[]> {
    return ModerationLog.find({ guildId, userId })
      .sort({ createdAt: -1 })
      .skip(query.skip)
      .limit(query.limit)
      .lean<IModerationLog[]>()
      .exec();
  }

  public async countHistory(guildId: string, userId: string): Promise<number> {
    return ModerationLog.countDocuments({ guildId, userId }).exec();
  }

  /**
   * Collapse a member's history to per-action counts plus the newest
   * timestamp, in a single aggregation over the `(guildId, userId, createdAt)`
   * index. `excludeId` drops one row from the roll-up so the context notice
   * can report *prior* history rather than counting the action it announces
   * (#907).
   */
  public async summarizeHistory(
    guildId: string,
    userId: string,
    options: { excludeId?: unknown } = {},
  ): Promise<ModerationHistorySummary> {
    const match: Record<string, unknown> = { guildId, userId };
    if (options.excludeId !== undefined && options.excludeId !== null) {
      match._id = { $ne: options.excludeId };
    }

    const rows = await ModerationLog.aggregate<{
      _id: ModerationAction;
      count: number;
      mostRecent: Date;
    }>([
      { $match: match },
      {
        $group: {
          _id: "$action",
          count: { $sum: 1 },
          mostRecent: { $max: "$createdAt" },
        },
      },
    ]).exec();

    const counts: Partial<Record<ModerationAction, number>> = {};
    let total = 0;
    let mostRecent: Date | null = null;

    for (const row of rows) {
      counts[row._id] = row.count;
      total += row.count;
      const when = row.mostRecent ? new Date(row.mostRecent) : null;
      if (when && (!mostRecent || when > mostRecent)) {
        mostRecent = when;
      }
    }

    return { total, counts, mostRecent };
  }

  /**
   * Announce a just-recorded action to the `core.moderation` log channel with
   * the member's prior history attached (#907).
   *
   * Discord cannot answer "what has this member done before?" natively — its
   * audit log keeps 45 days and filters by executor, not target — so this is
   * the point where KoolBot's own history becomes visible to the moderator
   * who is making a decision, without them having to think to run `/modlog`.
   *
   * Cheap and best-effort by design: the channel gate is checked before the
   * roll-up runs (so a disabled notice costs no query), only one aggregation
   * is issued, and every failure is swallowed — neither the gateway handler
   * nor `/warn` may fail because a log embed could not be posted.
   */
  private async postActionContext(context: ActionContext): Promise<void> {
    try {
      const discordLogger = DiscordLogger.getInstance(this.client);
      if (!discordLogger.isReady()) return;
      if (!(await discordLogger.isCategoryEnabled("moderation"))) return;

      const summary = await this.summarizeHistory(
        context.guildId,
        context.userId,
        { excludeId: context.entryId },
      );

      const moderator = context.moderatorId
        ? `<@${context.moderatorId}>`
        : "Unknown";

      await discordLogger.logToChannel("moderation", {
        title: actionLabel(context.action),
        description: `<@${context.userId}> · by ${moderator}`,
        color: actionColor(context.action),
        fields: [
          {
            name: "Reason",
            value: context.reason
              ? truncateText(context.reason, DISCORD_EMBED_FIELD_VALUE_LIMIT)
              : "No reason given",
          },
          {
            name: "Prior history",
            value: truncateText(
              formatHistorySummary(summary),
              DISCORD_EMBED_FIELD_VALUE_LIMIT,
            ),
          },
        ],
        footer: "Use /modlog for the full history",
      });
    } catch (error) {
      logger.error("Moderation: failed to post action context notice:", error);
    }
  }

  /** Server-wide recent actions, newest first. Backs the admin page. */
  public async getRecent(
    guildId: string,
    query: RecentQuery,
  ): Promise<IModerationLog[]> {
    const filter: Record<string, unknown> = { guildId };
    if (query.action) filter.action = query.action;
    if (query.userId) filter.userId = query.userId;
    return ModerationLog.find(filter)
      .sort({ createdAt: -1 })
      .skip(query.skip)
      .limit(query.limit)
      .lean<IModerationLog[]>()
      .exec();
  }

  public async countRecent(
    guildId: string,
    query: Pick<RecentQuery, "action" | "userId">,
  ): Promise<number> {
    const filter: Record<string, unknown> = { guildId };
    if (query.action) filter.action = query.action;
    if (query.userId) filter.userId = query.userId;
    return ModerationLog.countDocuments(filter).exec();
  }
}
