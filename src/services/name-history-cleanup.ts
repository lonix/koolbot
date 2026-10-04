import type { Client } from "discord.js";
import logger from "../utils/logger.js";
import { UserNameHistory } from "../models/user-name-history.js";
import { ScheduledService } from "./scheduled-service.js";

/** Daily at 03:45 — offset from the moderation-log cleanup at 03:30. */
const CLEANUP_CRON = "45 3 * * *";

export interface NameHistoryCleanupSummary {
  deleted: number;
}

/**
 * Daily prune of name-history rows not seen for more than
 * `namehistory.retention_days` (#1038). `0` (or negative) keeps history
 * forever.
 *
 * Built on `ScheduledService`, so it is armed only while
 * `namehistory.enabled` is on and re-arms on `/config reload`; run
 * coalescing and tick-failure handling come from the base class.
 */
export class NameHistoryCleanupService extends ScheduledService<NameHistoryCleanupSummary | null> {
  private static instance: NameHistoryCleanupService;

  private constructor(client: Client) {
    super(client, {
      label: "Name history cleanup",
      disabledMessage: "Name history is disabled; cleanup not scheduled",
      cronContext: "name history cleanup",
      runLabel: "Name history cleanup",
    });
  }

  public static getInstance(client: Client): NameHistoryCleanupService {
    if (!NameHistoryCleanupService.instance) {
      NameHistoryCleanupService.instance = new NameHistoryCleanupService(
        client,
      );
    } else if (NameHistoryCleanupService.instance.client !== client) {
      throw new Error(
        "NameHistoryCleanupService already initialised with a different client",
      );
    }
    return NameHistoryCleanupService.instance;
  }

  public static reset(): void {
    if (NameHistoryCleanupService.instance) {
      NameHistoryCleanupService.instance.destroy();
    }
    NameHistoryCleanupService.instance =
      undefined as unknown as NameHistoryCleanupService;
  }

  protected async isEnabled(): Promise<boolean> {
    return this.configService
      .getBoolean("namehistory.enabled", false)
      .catch(() => false);
  }

  protected async resolveSchedule(): Promise<string> {
    return CLEANUP_CRON;
  }

  /** Run one prune now (same as `runNow`; kept for callers and tests). */
  public runCleanup(): Promise<NameHistoryCleanupSummary | null> {
    return this.runNow();
  }

  protected async runOnce(): Promise<NameHistoryCleanupSummary | null> {
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
