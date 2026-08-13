import { CronJob } from "cron";
import logger from "../utils/logger.js";
import { WebAuditLog } from "../models/web-audit-log.js";
import { ConfigService } from "./config-service.js";

/**
 * Periodically prune WebUI audit rows older than
 * `core.web_audit.retention_days` (issue #756). Runs once a day at 03:15
 * server time — offset from the command-audit cleanup at 03:00 and the
 * moderation-log cleanup at 03:30 to avoid contention.
 *
 * `WebAuditLog` rows are written unconditionally on every state-changing
 * WebUI request (there's no `web_audit.enabled` toggle), so unlike its
 * sibling `CommandAuditCleanupService` this job gates only on retention:
 * a zero or negative value is the documented "keep history forever"
 * setting and makes the job a no-op.
 */
export class WebAuditLogCleanupService {
  private static instance: WebAuditLogCleanupService;
  private configService: ConfigService;
  private job: CronJob | null = null;

  private constructor() {
    this.configService = ConfigService.getInstance();
  }

  public static getInstance(): WebAuditLogCleanupService {
    if (!WebAuditLogCleanupService.instance) {
      WebAuditLogCleanupService.instance = new WebAuditLogCleanupService();
    }
    return WebAuditLogCleanupService.instance;
  }

  public static reset(): void {
    WebAuditLogCleanupService.instance =
      undefined as unknown as WebAuditLogCleanupService;
  }

  public start(): void {
    if (this.job) return;
    this.job = new CronJob("15 3 * * *", () => {
      this.runCleanup().catch((err) => {
        logger.error("Web audit cleanup failed:", err);
      });
    });
    this.job.start();
    logger.info("Web audit cleanup scheduled (daily at 03:15)");
  }

  public destroy(): void {
    if (this.job) {
      this.job.stop();
      this.job = null;
    }
  }

  public async runCleanup(): Promise<{ deleted: number } | null> {
    const retentionDays = await this.configService
      .getNumber("core.web_audit.retention_days", 90)
      .catch(() => 90);
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return null;

    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    try {
      const result = await WebAuditLog.deleteMany({
        createdAt: { $lt: cutoff },
      });
      const deleted = result.deletedCount ?? 0;
      if (deleted > 0) {
        logger.info(
          `Web audit cleanup removed ${deleted} rows older than ${retentionDays}d`,
        );
      }
      return { deleted };
    } catch (err) {
      logger.error("Web audit deleteMany failed:", err);
      return null;
    }
  }
}
