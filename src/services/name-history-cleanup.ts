import { CronJob } from "cron";
import logger from "../utils/logger.js";
import { UserNameHistory } from "../models/user-name-history.js";
import { ConfigService } from "./config-service.js";

/**
 * Daily prune of name-history rows not seen for more than
 * `namehistory.retention_days` (#1038). Runs at 03:45, offset from the
 * moderation-log cleanup at 03:30. `0` (or negative) keeps history forever.
 *
 * Gated on `namehistory.enabled`, so a disabled feature does not keep
 * pruning a static table.
 */
export class NameHistoryCleanupService {
  private static instance: NameHistoryCleanupService;
  private configService: ConfigService;
  private job: CronJob | null = null;

  private constructor() {
    this.configService = ConfigService.getInstance();
  }

  public static getInstance(): NameHistoryCleanupService {
    if (!NameHistoryCleanupService.instance) {
      NameHistoryCleanupService.instance = new NameHistoryCleanupService();
    }
    return NameHistoryCleanupService.instance;
  }

  public static reset(): void {
    NameHistoryCleanupService.instance =
      undefined as unknown as NameHistoryCleanupService;
  }

  public start(): void {
    if (this.job) return;
    this.job = new CronJob("45 3 * * *", () => {
      this.runCleanup().catch((err) => {
        logger.error("Name history cleanup failed:", err);
      });
    });
    this.job.start();
    logger.info("Name history cleanup scheduled (daily at 03:45)");
  }

  public destroy(): void {
    if (this.job) {
      this.job.stop();
      this.job = null;
    }
  }

  public async runCleanup(): Promise<{ deleted: number } | null> {
    const enabled = await this.configService
      .getBoolean("namehistory.enabled", false)
      .catch(() => false);
    if (!enabled) return null;

    const retentionDays = await this.configService
      .getNumber("namehistory.retention_days", 365)
      .catch(() => 365);
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return null;

    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    try {
      const result = await UserNameHistory.deleteMany({
        lastSeenAt: { $lt: cutoff },
      });
      const deleted = result.deletedCount ?? 0;
      if (deleted > 0) {
        logger.info(
          `Name history cleanup removed ${deleted} rows older than ${retentionDays}d`,
        );
      }
      return { deleted };
    } catch (err) {
      logger.error("Name history deleteMany failed:", err);
      return null;
    }
  }
}
