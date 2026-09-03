import { Client, DiscordAPIError } from "discord.js";
import { CronJob, CronTime } from "cron";
import { isValidObjectId } from "mongoose";
import { ConfigService } from "./config-service.js";
import { Reminder, type IReminder } from "../models/reminder.js";
import logger from "../utils/logger.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";

/**
 * Personal reminders (#866).
 *
 * Members schedule one-off reminders with `/remind set`; this service
 * delivers them. Like `EventService`, the whole thing is driven by a
 * single once-a-minute scan over stored rows rather than a per-reminder
 * timer, so delivery is idempotent and survives a restart — the row's
 * `delivered` flag is the source of truth.
 *
 * Delivery is a DM, because the member asked for it personally. That does
 * not conflict with the opt-in DM posture established in #686/#699: the
 * "never DM unprompted" rule exists to stop the bot pushing content nobody
 * asked for, and a reminder is the member's own explicit request. It is
 * therefore *not* gated on `UserNotificationPrefs` — routing it through
 * that gate (which defaults every channel to false) would silently drop
 * the reminder for anyone who never opened `/me/notifications`.
 */

/** Scan cadence. One minute is the delivery resolution members are promised. */
const TICK_CRON = "* * * * *";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * How far ahead a reminder may be scheduled. A year is comfortably past any
 * plausible use and keeps a typo (`in:9999w`) from parking a row in the
 * collection effectively forever.
 */
export const MAX_HORIZON_MS = 365 * MS_PER_DAY;

/**
 * Most reminders one scan will deliver. Sends are serial, so an unbounded
 * query after an outage could hold thousands of rows in memory and run for
 * many minutes — and because ticks coalesce, newly due reminders would not
 * even be queried until that backlog drained. A bounded, oldest-first batch
 * keeps each tick short; the remainder is picked up by the next one.
 */
const SCAN_BATCH_SIZE = 100;

/** Fallback for `reminders.max_pending`, mirroring the schema default. */
const DEFAULT_MAX_PENDING = 10;

/** Discord: "Cannot send messages to this user" (DMs closed or blocked). */
const DISCORD_CANNOT_SEND_TO_USER = 50007;

// ---------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------

/**
 * How a DM attempt ended. Only `dms-closed` may escalate to a public
 * channel post — see `sendDm`.
 */
type DmOutcome = "sent" | "dms-closed" | "failed";

/** Why a requested reminder instant is unusable, or `null` when it's fine. */
export type RemindAtIssue = "past" | "too-far";

/**
 * Validate a requested reminder instant against "now".
 *
 * Rejects instants that are not strictly in the future (a reminder due in
 * the past would fire on the very next scan, which is never what the member
 * meant) and instants beyond {@link MAX_HORIZON_MS}.
 */
export function checkRemindAt(
  remindAt: Date,
  now: Date,
  horizonMs: number = MAX_HORIZON_MS,
): RemindAtIssue | null {
  const at = remindAt.getTime();
  if (!Number.isFinite(at)) return "past";
  if (at <= now.getTime()) return "past";
  if (at - now.getTime() > horizonMs) return "too-far";
  return null;
}

/**
 * Render a reminder instant as a Discord timestamp so every reader sees it
 * in their own local time. `F` is the long date+time style; `R` renders the
 * relative "in 2 hours" form.
 */
export function discordTimestamp(date: Date, style: "F" | "R" = "F"): string {
  return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
}

/**
 * Resolve the configured per-member pending cap to a usable positive integer.
 *
 * `ConfigService.getNumber` hands back a stored number verbatim, so a row
 * written straight to Mongo (bypassing the Settings page, which enforces
 * `min: 1`) can carry `0`, a negative, or a non-finite value. Left unchecked
 * those either disable the feature outright (`pending >= 0` is always true)
 * or remove the cap entirely (`pending >= NaN` is always false). Anything
 * not a finite integer of at least 1 falls back to the schema default.
 */
export function resolvePendingLimit(raw: number): number {
  return Number.isFinite(raw) && raw >= 1
    ? Math.floor(raw)
    : DEFAULT_MAX_PENDING;
}

/** Outcome of a create attempt, so the command can render a real reason. */
export type CreateReminderResult =
  | { ok: true; reminder: IReminder }
  | { ok: false; reason: "cap"; limit: number };

export interface CreateReminderInput {
  userId: string;
  guildId: string;
  channelId: string;
  message: string;
  remindAt: Date;
  timezone: string;
}

export class ReminderService {
  private static instance: ReminderService;
  private client: Client;
  private configService: ConfigService;
  private job: CronJob | null = null;
  private isInitialized = false;
  private isRunning = false;
  private inFlight: Promise<void> | null = null;

  private constructor(client: Client) {
    this.client = client;
    this.configService = ConfigService.getInstance();

    this.configService.registerReloadCallback(async () => {
      try {
        logger.info("Reminders configuration changed, reloading...");
        const enabled = await this.configService.getBoolean(
          "reminders.enabled",
          false,
        );
        if (!enabled && this.isInitialized) {
          logger.info("Reminders disabled, stopping scan job...");
          this.destroy();
        } else if (enabled) {
          await this.reload();
        }
      } catch (error) {
        logger.error(
          "Error reloading reminder service after configuration change:",
          error,
        );
      }
    });
  }

  public static getInstance(client: Client): ReminderService {
    if (!ReminderService.instance) {
      ReminderService.instance = new ReminderService(client);
    } else if (ReminderService.instance.client !== client) {
      throw new Error(
        "ReminderService already initialised with a different client",
      );
    }
    return ReminderService.instance;
  }

  public static reset(): void {
    if (ReminderService.instance) {
      ReminderService.instance.destroy();
    }
    ReminderService.instance = undefined as unknown as ReminderService;
  }

  // ---------------------------------------------------------------
  // Cron lifecycle
  // ---------------------------------------------------------------

  public async start(): Promise<void> {
    if (this.isInitialized) {
      logger.warn("Reminder service is already initialized, skipping...");
      return;
    }
    try {
      const enabled = await this.configService.getBoolean(
        "reminders.enabled",
        false,
      );
      if (!enabled) {
        logger.info("Reminders are disabled");
        this.isInitialized = true;
        return;
      }

      if (!this.validateCronExpression(TICK_CRON)) {
        logger.error("Reminder service not started: invalid tick cron");
        this.isInitialized = true;
        return;
      }

      this.job = new CronJob(TICK_CRON, async () => {
        try {
          await this.runNow();
        } catch (error) {
          logger.error("Error running reminder scan:", error);
        }
      });
      this.job.start();
      logger.info(`Reminder service started (scan cron: "${TICK_CRON}")`);
      this.isInitialized = true;
    } catch (error) {
      logger.error("Error starting reminder service:", error);
      throw error;
    }
  }

  public async reload(): Promise<void> {
    logger.info("Reloading reminder service...");
    if (this.job) {
      this.job.stop();
      this.job = null;
    }
    this.isInitialized = false;
    await this.start();
  }

  public destroy(): void {
    if (this.job) {
      this.job.stop();
      this.job = null;
    }
    this.isInitialized = false;
    logger.info("Reminder service destroyed");
  }

  private validateCronExpression(expression: string): boolean {
    try {
      new CronTime(expression);
      return true;
    } catch (error) {
      logger.error(
        `Invalid cron expression for reminders: ${expression}`,
        error,
      );
      return false;
    }
  }

  // ---------------------------------------------------------------
  // Scan
  // ---------------------------------------------------------------

  /** Run the delivery scan immediately. Concurrent calls coalesce. */
  public async runNow(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runOnce();
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async runOnce(): Promise<void> {
    if (this.isRunning) {
      logger.warn("Reminder scan already in progress, skipping");
      return;
    }
    this.isRunning = true;
    try {
      const enabled = await this.configService.getBoolean(
        "reminders.enabled",
        false,
      );
      if (!enabled) return;

      const due = await Reminder.find({
        delivered: false,
        remindAt: { $lte: new Date() },
      })
        .sort({ remindAt: 1 })
        .limit(SCAN_BATCH_SIZE);

      for (const reminder of due) {
        try {
          await this.deliver(reminder);
        } catch (error) {
          logger.error(
            `Error delivering reminder ${sanitizeForLog(String(reminder._id))}:`,
            error,
          );
        }
      }
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Deliver one due reminder.
   *
   * The row is *claimed* before any Discord call: a conditional update flips
   * `delivered` only if it is still false, so two overlapping scans (or a
   * scan racing a manual `runNow`) can never both send. The cost of that
   * ordering is that a hard send failure loses the reminder rather than
   * retrying it — chosen deliberately, because the alternative is a row that
   * re-sends on every tick for as long as the failure persists.
   */
  private async deliver(reminder: IReminder): Promise<void> {
    const claimed = await Reminder.findOneAndUpdate(
      { _id: reminder._id, delivered: false },
      { $set: { delivered: true, deliveredAt: new Date() } },
      { new: true },
    );
    // Another scan got there first.
    if (!claimed) return;

    // Only a *closed DM* earns the public fallback. A transient fetch or
    // send failure must not push a member's private reminder into a channel.
    const outcome = await this.sendDm(claimed);
    if (outcome === "dms-closed") {
      await this.sendToChannel(claimed);
    }
  }

  /**
   * DM the reminder.
   *
   * The three outcomes are kept distinct because only one of them may
   * escalate to a public channel post. `dms-closed` (Discord 50007) means
   * the member has chosen not to receive DMs, which is exactly the case the
   * channel fallback exists for. Any other failure — a network blip, a
   * rate limit, an outage — says nothing about the member's preferences, so
   * it is logged and the reminder is dropped rather than published where
   * anyone can read it.
   */
  private async sendDm(reminder: IReminder): Promise<DmOutcome> {
    try {
      const user = await this.client.users.fetch(reminder.userId);
      await user.send({
        content: this.formatBody(reminder),
        // The body is member-authored text: never let it ping anyone.
        allowedMentions: { parse: [] },
      });
      return "sent";
    } catch (error) {
      const code = (error as DiscordAPIError).code;
      if (code === DISCORD_CANNOT_SEND_TO_USER) {
        logger.debug(
          `Reminder: DMs closed for ${sanitizeForLog(reminder.userId)}, falling back to channel`,
        );
        return "dms-closed";
      }
      logger.error(
        `Reminder: DM failed for ${sanitizeForLog(reminder.userId)}:`,
        error,
      );
      return "failed";
    }
  }

  /**
   * Fallback delivery in the channel the reminder was set in. The member is
   * mentioned so the ping still reaches them, and `allowedMentions` is
   * pinned to that one id so nothing inside their own reminder text can
   * ping anybody else.
   */
  private async sendToChannel(reminder: IReminder): Promise<void> {
    if (!reminder.channelId) return;
    try {
      const channel = await this.client.channels.fetch(reminder.channelId);
      if (!channel || !channel.isTextBased() || !channel.isSendable()) {
        logger.warn(
          `Reminder: channel ${sanitizeForLog(reminder.channelId)} is not sendable, dropping`,
        );
        return;
      }
      await channel.send({
        content: `<@${reminder.userId}> ${this.formatBody(reminder)}`,
        allowedMentions: { users: [reminder.userId] },
      });
    } catch (error) {
      logger.error(
        `Reminder: channel fallback failed for ${sanitizeForLog(reminder.channelId)}:`,
        error,
      );
    }
  }

  private formatBody(reminder: IReminder): string {
    return `⏰ **Reminder:** ${reminder.message}`;
  }

  // ---------------------------------------------------------------
  // Public API (command)
  // ---------------------------------------------------------------

  /** Pending (undelivered) reminders for a member, soonest first. */
  public async listPending(
    userId: string,
    guildId: string,
  ): Promise<IReminder[]> {
    return Reminder.find({ userId, guildId, delivered: false }).sort({
      remindAt: 1,
    });
  }

  /** How many pending reminders a member currently holds. */
  public async countPending(userId: string, guildId: string): Promise<number> {
    return Reminder.countDocuments({ userId, guildId, delivered: false });
  }

  /**
   * Store a new reminder, refusing once the member is at their pending cap.
   * The caller is expected to have validated `remindAt` with
   * {@link checkRemindAt} already.
   */
  public async createReminder(
    input: CreateReminderInput,
  ): Promise<CreateReminderResult> {
    const limit = resolvePendingLimit(
      await this.configService.getNumber(
        "reminders.max_pending",
        DEFAULT_MAX_PENDING,
      ),
    );
    const pending = await this.countPending(input.userId, input.guildId);
    if (pending >= limit) {
      return { ok: false, reason: "cap", limit };
    }

    const reminder = await Reminder.create({
      userId: input.userId,
      guildId: input.guildId,
      channelId: input.channelId,
      message: input.message,
      remindAt: input.remindAt,
      timezone: input.timezone,
      delivered: false,
    });
    return { ok: true, reminder };
  }

  /**
   * Cancel one of the member's own pending reminders. Scoped by `userId` in
   * the query itself, so a member can never cancel someone else's by
   * guessing an id. Returns false when no such pending reminder exists.
   *
   * A malformed id is one such case, and is rejected here rather than left
   * to Mongoose (which raises a `CastError`): the command guards its own
   * input, but this method is public and has to hold its contract for every
   * caller.
   */
  public async cancelReminder(
    id: string,
    userId: string,
    guildId: string,
  ): Promise<boolean> {
    if (!isValidObjectId(id)) return false;

    const result = await Reminder.deleteOne({
      _id: id,
      userId,
      guildId,
      delivered: false,
    });
    return result.deletedCount > 0;
  }
}
