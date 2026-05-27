import { CronJob } from "cron";
import logger from "../utils/logger.js";
import { DiscordCommandAuditLog } from "../models/discord-command-audit-log.js";
import { ConfigService } from "./config-service.js";

/**
 * Periodically prune Discord slash-command audit rows older than
 * `core.command_audit.retention_days` (issue #459). Runs once a day at
 * 03:00 server time — far enough from midnight to avoid contention with
 * the voice-tracking cleanup that defaults to 00:00.
 *
 * No-op when `core.command_audit.enabled` is false, so a disabled audit
 * feature doesn't keep pruning a static table.
 */
export class CommandAuditCleanupService {
  private static instance: CommandAuditCleanupService;
  private configService: ConfigService;
  private job: CronJob | null = null;

  private constructor() {
    this.configService = ConfigService.getInstance();
  }

  public static getInstance(): CommandAuditCleanupService {
    if (!CommandAuditCleanupService.instance) {
      CommandAuditCleanupService.instance = new CommandAuditCleanupService();
    }
    return CommandAuditCleanupService.instance;
  }

  public static reset(): void {
    CommandAuditCleanupService.instance =
      undefined as unknown as CommandAuditCleanupService;
  }

  public start(): void {
    if (this.job) return;
    this.job = new CronJob("0 3 * * *", () => {
      this.runCleanup().catch((err) => {
        logger.error("Command audit cleanup failed:", err);
      });
    });
    this.job.start();
    logger.info("Command audit cleanup scheduled (daily at 03:00)");
  }

  public destroy(): void {
    if (this.job) {
      this.job.stop();
      this.job = null;
    }
  }

  public async runCleanup(): Promise<{ deleted: number } | null> {
    const enabled = await this.configService
      .getBoolean("core.command_audit.enabled", true)
      .catch(() => true);
    if (!enabled) return null;

    const retentionDays = await this.configService
      .getNumber("core.command_audit.retention_days", 90)
      .catch(() => 90);
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return null;

    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    try {
      const result = await DiscordCommandAuditLog.deleteMany({
        createdAt: { $lt: cutoff },
      });
      const deleted = result.deletedCount ?? 0;
      if (deleted > 0) {
        logger.info(
          `Command audit cleanup removed ${deleted} rows older than ${retentionDays}d`,
        );
      }
      return { deleted };
    } catch (err) {
      logger.error("Command audit deleteMany failed:", err);
      return null;
    }
  }
}
