import { Client } from "discord.js";
import { ScheduledService } from "./scheduled-service.js";
import { ModerationCaseService } from "./moderation-case-service.js";
import { DiscordLogger } from "./discord-logger.js";
import {
  ModerationCase,
  SYSTEM_ACTOR,
  type IModerationCase,
} from "../models/moderation-case.js";
import {
  truncateText,
  DISCORD_EMBED_DESCRIPTION_LIMIT,
} from "../utils/discord-limits.js";
import logger from "../utils/logger.js";

/** Fallback for `moderation.cases.review_cron`, mirroring the schema default. */
const DEFAULT_CRON = "0 9 * * *";

/** Most cases one run will flip, oldest first; the next tick takes the rest. */
const RUN_BATCH_SIZE = 100;

export interface ModerationCaseReviewSummary {
  /** Cases found due this run. */
  due: number;
  /** Cases actually flipped to `under_review` (a racing decision can win). */
  flipped: number;
  /** Whether the digest notice was posted. */
  notified: boolean;
}

/**
 * Daily nudge for cases whose review has come due (issue #908).
 *
 * The cron lifecycle comes from {@link ScheduledService}; this supplies the
 * gate, the schedule and one pass of work: flip every due `open` case to
 * `under_review` and post one digest naming them. The notice is idempotent
 * without a `notifiedAt` field because only cases this run actually flipped
 * are reported — a second run finds nothing left `open`.
 *
 * Nothing here ever decides a case or closes one: `expired` has no automatic
 * producer, since silently turning "nobody looked at this" into "resolved" is
 * exactly what the feature exists to prevent.
 */
export class ModerationCaseReviewService extends ScheduledService<ModerationCaseReviewSummary> {
  private static instance: ModerationCaseReviewService;

  private constructor(client: Client) {
    super(client, {
      label: "Moderation case review service",
      disabledMessage: "Moderation case reviews are disabled",
      cronContext: "moderation case reviews",
      runLabel: "Moderation case review",
    });
  }

  public static getInstance(client: Client): ModerationCaseReviewService {
    if (!ModerationCaseReviewService.instance) {
      ModerationCaseReviewService.instance = new ModerationCaseReviewService(
        client,
      );
    } else if (ModerationCaseReviewService.instance.client !== client) {
      throw new Error(
        "ModerationCaseReviewService already initialised with a different client",
      );
    }
    return ModerationCaseReviewService.instance;
  }

  public static reset(): void {
    if (ModerationCaseReviewService.instance) {
      ModerationCaseReviewService.instance.destroy();
    }
    ModerationCaseReviewService.instance =
      undefined as unknown as ModerationCaseReviewService;
  }

  protected async isEnabled(): Promise<boolean> {
    return ModerationCaseService.getInstance(this.client).isEnabled();
  }

  protected async resolveSchedule(): Promise<string> {
    return this.configService.getString(
      "moderation.cases.review_cron",
      DEFAULT_CRON,
    );
  }

  protected async runOnce(): Promise<ModerationCaseReviewSummary> {
    // Scoped to the configured guild like the other scheduled services, so a
    // case left in the database for another guild is never flipped or named
    // in this instance's review digest.
    const guildId = await this.configService.getString("GUILD_ID", "");
    if (!guildId) {
      logger.error("Moderation case review aborted: GUILD_ID not configured");
      return { due: 0, flipped: 0, notified: false };
    }
    const caseService = ModerationCaseService.getInstance(this.client);
    const due = await ModerationCase.find({
      guildId,
      status: "open",
      reviewAt: { $lte: new Date() },
    })
      .sort({ reviewAt: 1 })
      .limit(RUN_BATCH_SIZE)
      .lean<IModerationCase[]>()
      .exec();

    const flipped: IModerationCase[] = [];
    for (const row of due) {
      const updated = await caseService.markUnderReview(row, SYSTEM_ACTOR);
      if (updated) flipped.push(updated);
    }

    const notified = flipped.length > 0 && (await this.postNotice(flipped));
    if (flipped.length > 0) {
      logger.info(
        `Moderation case review: ${flipped.length} case(s) now due for review`,
      );
    }
    return { due: due.length, flipped: flipped.length, notified };
  }

  /** One digest for the whole run. Best-effort: a throw never fails the run. */
  private async postNotice(flipped: IModerationCase[]): Promise<boolean> {
    try {
      const discordLogger = DiscordLogger.getInstance(this.client);
      if (!discordLogger.isReady()) return false;
      if (!(await discordLogger.isCategoryEnabled("moderation_review"))) {
        return false;
      }
      const lines = flipped.map(
        (c) =>
          `**Case #${c.caseNumber}** · <@${c.userId}> · ${c.action} · due <t:${Math.floor(
            (c.reviewAt ?? c.updatedAt).getTime() / 1000,
          )}:D>`,
      );
      return await discordLogger.logToChannel("moderation_review", {
        title: `🛡️ ${flipped.length} moderation case${
          flipped.length === 1 ? "" : "s"
        } due for review`,
        description: truncateText(
          lines.join("\n"),
          DISCORD_EMBED_DESCRIPTION_LIMIT,
        ),
        color: 0x6366f1,
        footer: "Decide them on the Moderation page of the Web UI",
      });
    } catch (error) {
      logger.error("Moderation case review: failed to post notice:", error);
      return false;
    }
  }
}
