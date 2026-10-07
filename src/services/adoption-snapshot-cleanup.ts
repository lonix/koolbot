import type { Client } from "discord.js";
import logger from "../utils/logger.js";
import {
  AdoptionSnapshot,
  ADOPTION_STALE_AFTER_MS,
} from "../models/adoption-snapshot.js";
import { ScheduledService } from "./scheduled-service.js";

/** Daily at 04:00 — after the other retention cleanups (03:00–03:45). */
const CLEANUP_CRON = "0 4 * * *";

export interface AdoptionSnapshotCleanupSummary {
  deleted: number;
}

/**
 * Daily prune of server-adoption snapshots older than
 * `adoption.snapshot.retention_days` (#1018). `0` (or negative) keeps them
 * forever. A snapshot that is being applied or rolled back is never pruned.
 *
 * Snapshots exist whether or not any adoption feature is in use, so the job
 * has no enable gate of its own: retention alone governs it.
 */
export class AdoptionSnapshotCleanupService extends ScheduledService<AdoptionSnapshotCleanupSummary | null> {
  private static instance: AdoptionSnapshotCleanupService;

  private constructor(client: Client) {
    super(client, {
      label: "Adoption snapshot cleanup",
      disabledMessage: "Adoption snapshot cleanup is disabled",
      cronContext: "adoption snapshot cleanup",
      runLabel: "Adoption snapshot cleanup",
    });
  }

  public static getInstance(client: Client): AdoptionSnapshotCleanupService {
    if (!AdoptionSnapshotCleanupService.instance) {
      AdoptionSnapshotCleanupService.instance =
        new AdoptionSnapshotCleanupService(client);
    } else if (AdoptionSnapshotCleanupService.instance.client !== client) {
      throw new Error(
        "AdoptionSnapshotCleanupService already initialised with a different client",
      );
    }
    return AdoptionSnapshotCleanupService.instance;
  }

  public static reset(): void {
    if (AdoptionSnapshotCleanupService.instance) {
      AdoptionSnapshotCleanupService.instance.destroy();
    }
    AdoptionSnapshotCleanupService.instance =
      undefined as unknown as AdoptionSnapshotCleanupService;
  }

  protected async isEnabled(): Promise<boolean> {
    return true;
  }

  protected async resolveSchedule(): Promise<string> {
    return CLEANUP_CRON;
  }

  /**
   * An apply or rollback that died with the process (deploy, crash) leaves its
   * snapshot active forever. One whose heartbeat has stopped is handed back as
   * "partial", which can be resumed or rolled back, and releases the lock.
   */
  public async recoverStale(): Promise<number> {
    try {
      const cutoff = new Date(Date.now() - ADOPTION_STALE_AFTER_MS);
      // Direction matters: a dead apply can be resumed, but a dead rollback
      // must only ever be continued as a rollback.
      const stale = { active: true, heartbeatAt: { $lt: cutoff } };
      const applies = await AdoptionSnapshot.updateMany(
        { ...stale, status: "applying" },
        { $set: { status: "partial", active: false } },
      );
      const rollbacks = await AdoptionSnapshot.updateMany(
        { ...stale, status: "rolling_back" },
        { $set: { status: "rollback_partial", active: false } },
      );
      const recovered =
        (applies.modifiedCount ?? 0) + (rollbacks.modifiedCount ?? 0);
      if (recovered > 0) {
        logger.warn(
          `Recovered ${recovered} stale adoption snapshot(s) to partial`,
        );
      }
      return recovered;
    } catch (err) {
      logger.error("Adoption snapshot recovery failed:", err);
      return 0;
    }
  }

  /** Run one prune now (same as `runNow`; kept for callers and tests). */
  public runCleanup(): Promise<AdoptionSnapshotCleanupSummary | null> {
    return this.runNow();
  }

  protected async runOnce(): Promise<AdoptionSnapshotCleanupSummary | null> {
    await this.recoverStale();
    const retentionDays = await this.configService
      .getNumber("adoption.snapshot.retention_days", 90)
      .catch(() => 90);
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return null;

    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    try {
      const result = await AdoptionSnapshot.deleteMany({
        createdAt: { $lt: cutoff },
        status: { $nin: ["applying", "rolling_back"] },
      });
      const deleted = result.deletedCount ?? 0;
      if (deleted > 0) {
        logger.info(
          `Adoption snapshot cleanup removed ${deleted} snapshots older than ${retentionDays}d`,
        );
      }
      return { deleted };
    } catch (err) {
      logger.error("Adoption snapshot deleteMany failed:", err);
      return null;
    }
  }
}
