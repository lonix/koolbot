import { CronJob } from "cron";
import logger from "../utils/logger.js";
import { ModerationLog } from "../models/moderation-log.js";
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
 */
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

  public async runCleanup(): Promise<{ deleted: number } | null> {
    const enabled = await this.configService
      .getBoolean("moderation.enabled", false)
      .catch(() => false);
    if (!enabled) return null;

    const retentionDays = await this.configService
      .getNumber("moderation.retention_days", 365)
      .catch(() => 365);
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return null;

    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    try {
      const result = await ModerationLog.deleteMany({
        createdAt: { $lt: cutoff },
      });
      const deleted = result.deletedCount ?? 0;
      if (deleted > 0) {
        logger.info(
          `Moderation log cleanup removed ${deleted} rows older than ${retentionDays}d`,
        );
      }
      return { deleted };
    } catch (err) {
      logger.error("Moderation log deleteMany failed:", err);
      return null;
    }
  }
}
