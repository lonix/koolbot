import { CronJob } from "cron";
import logger from "../utils/logger.js";
import { ModerationLog } from "../models/moderation-log.js";
import {
  ModerationCase,
  LIVE_CASE_STATUSES,
  TERMINAL_CASE_STATUSES,
} from "../models/moderation-case.js";
import { ConfigService } from "./config-service.js";

/**
 * Periodically prune moderation-log rows older than
 * `moderation.retention_days` (issue #742). Runs once a day at 03:30 server
 * time — offset from the command-audit cleanup at 03:00 and the
 * voice/message cleanups that default to 00:00 / 03:00.
 *
 * No-op when `moderation.enabled` is false (a disabled feature shouldn't
 * keep pruning a static table) and when retention is zero or negative —
 * the documented "keep history forever" setting, since moderation history
 * plausibly wants to outlive routine activity data.
 *
 * Cases (#908) change what may be pruned. A case with a six-month review, or
 * the history behind a readmitted member, must not be deleted before it is
 * needed, so the log prune skips:
 *   - every entry a case references (its origin and resolution rows), and
 *   - every row belonging to a member with a live case, or whose case
 *     resolved within `moderation.cases.history_grace_days` (0 = while the
 *     case exists).
 * Both sets are bounded by the number of cases (a handful a year), not by the
 * size of the log, so `$nin` is safe here. Resolved cases are pruned on their
 * own rule, `moderation.cases.retention_days`, measured from the last
 * decision; live cases are never pruned — they are the queue.
 */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export class ModerationLogCleanupService {
  private static instance: ModerationLogCleanupService;
  private configService: ConfigService;
  private job: CronJob | null = null;

  private constructor() {
    this.configService = ConfigService.getInstance();
  }

  public static getInstance(): ModerationLogCleanupService {
    if (!ModerationLogCleanupService.instance) {
      ModerationLogCleanupService.instance = new ModerationLogCleanupService();
    }
    return ModerationLogCleanupService.instance;
  }

  public static reset(): void {
    ModerationLogCleanupService.instance =
      undefined as unknown as ModerationLogCleanupService;
  }

  public start(): void {
    if (this.job) return;
    this.job = new CronJob("30 3 * * *", () => {
      this.runCleanup().catch((err) => {
        logger.error("Moderation log cleanup failed:", err);
      });
    });
    this.job.start();
    logger.info("Moderation log cleanup scheduled (daily at 03:30)");
  }

  public destroy(): void {
    if (this.job) {
      this.job.stop();
      this.job = null;
    }
  }

  public async runCleanup(): Promise<{
    deleted: number;
    casesDeleted: number;
  } | null> {
    const enabled = await this.configService
      .getBoolean("moderation.enabled", false)
      .catch(() => false);
    if (!enabled) return null;

    const retentionDays = await this.configService
      .getNumber("moderation.retention_days", 365)
      .catch(() => 365);
    const caseRetentionDays = await this.configService
      .getNumber("moderation.cases.retention_days", 0)
      .catch(() => 0);
    const logPrunes = Number.isFinite(retentionDays) && retentionDays > 0;
    const casePrunes =
      Number.isFinite(caseRetentionDays) && caseRetentionDays > 0;
    if (!logPrunes && !casePrunes) return null;

    try {
      // Cases first, so the protection sets below reflect what survives.
      let casesDeleted = 0;
      if (casePrunes) {
        const caseCutoff = new Date(
          Date.now() - caseRetentionDays * MS_PER_DAY,
        );
        const result = await ModerationCase.deleteMany({
          status: { $in: TERMINAL_CASE_STATUSES },
          updatedAt: { $lt: caseCutoff },
        });
        casesDeleted = result.deletedCount ?? 0;
        if (casesDeleted > 0) {
          logger.info(
            `Moderation cleanup removed ${casesDeleted} resolved cases older than ${caseRetentionDays}d`,
          );
        }
      }

      let deleted = 0;
      if (logPrunes) {
        const cutoff = new Date(Date.now() - retentionDays * MS_PER_DAY);
        const filter: Record<string, unknown> = { createdAt: { $lt: cutoff } };
        const protection = await this.collectProtection();
        if (protection.entryIds.length > 0) {
          filter._id = { $nin: protection.entryIds };
        }
        if (protection.userKeys.length > 0) {
          filter.$nor = protection.userKeys;
        }
        const result = await ModerationLog.deleteMany(filter);
        deleted = result.deletedCount ?? 0;
        if (deleted > 0) {
          logger.info(
            `Moderation log cleanup removed ${deleted} rows older than ${retentionDays}d`,
          );
        }
      }
      return { deleted, casesDeleted };
    } catch (err) {
      logger.error("Moderation cleanup failed:", err);
      return null;
    }
  }

  /**
   * What the log prune must leave alone because a case needs it. Entries a
   * case points at are always kept; a member's whole history is kept while
   * their case is live or inside the grace window after it resolved.
   */
  private async collectProtection(): Promise<{
    entryIds: unknown[];
    userKeys: Array<{ guildId: string; userId: string }>;
  }> {
    const graceDays = await this.configService
      .getNumber("moderation.cases.history_grace_days", 365)
      .catch(() => 365);
    const graceCutoff =
      Number.isFinite(graceDays) && graceDays > 0
        ? new Date(Date.now() - graceDays * MS_PER_DAY)
        : null;

    const [origins, resolutions, protectedCases] = await Promise.all([
      ModerationCase.distinct("originEntryId", {}),
      ModerationCase.distinct("resolutionEntryId", {
        resolutionEntryId: { $ne: null },
      }),
      ModerationCase.find(
        graceCutoff
          ? {
              $or: [
                { status: { $in: LIVE_CASE_STATUSES } },
                { updatedAt: { $gte: graceCutoff } },
              ],
            }
          : {},
      )
        .select({ guildId: 1, userId: 1 })
        .lean<Array<{ guildId: string; userId: string }>>()
        .exec(),
    ]);

    const seen = new Set<string>();
    const userKeys: Array<{ guildId: string; userId: string }> = [];
    for (const c of protectedCases) {
      const key = `${c.guildId}:${c.userId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      userKeys.push({ guildId: c.guildId, userId: c.userId });
    }
    return { entryIds: [...origins, ...resolutions], userKeys };
  }
}
