import { Client, TextChannel } from "discord.js";
import { CronJob, CronTime } from "cron";
import { ConfigService } from "./config-service.js";
import logger from "../utils/logger.js";
import { PollSchedule, IPollSchedule } from "../models/poll-schedule.js";
import { PollItem, IPollItem } from "../models/poll-item.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";
import yaml from "js-yaml";

interface ScheduledPollJob {
  schedule: IPollSchedule;
  job: CronJob;
}

interface PollData {
  question: string;
  answers: string[];
  multiselect?: boolean;
  tags?: string[];
}

interface PollSource {
  polls: PollData[];
}

// Cap the size of an imported poll library. 2 MB comfortably holds thousands of
// questions while bounding how much the parser pulls into memory for a single
// import before validation runs.
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

// Discord caps each poll answer (option) at 55 characters and a poll question at
// 300. Imported libraries are validated against the same limits so an oversized
// entry fails cleanly at import time rather than when Discord rejects the poll
// payload (#508).
const MAX_POLL_ANSWER_LENGTH = 55;
const MAX_POLL_QUESTION_LENGTH = 300;

export class PollService {
  private static instance: PollService;
  private client: Client;
  private configService: ConfigService;
  private jobs: Map<string, ScheduledPollJob> = new Map();
  private isInitialized: boolean = false;

  private constructor(client: Client) {
    this.client = client;
    this.configService = ConfigService.getInstance();

    // Register configuration reload callback
    this.configService.registerReloadCallback(async () => {
      try {
        logger.info("Poll service configuration changed, reloading...");

        const enabled = await this.configService.getBoolean(
          "polls.enabled",
          false,
        );

        if (!enabled && this.isInitialized) {
          logger.info("Poll service disabled, cleaning up jobs...");
          this.destroy();
        } else if (enabled) {
          await this.reload();
        }
      } catch (error) {
        logger.error(
          "Error reloading poll service after configuration change:",
          error,
        );
      }
    });
  }

  public static getInstance(client: Client): PollService {
    if (!PollService.instance) {
      PollService.instance = new PollService(client);
    } else if (PollService.instance.client !== client) {
      throw new Error(
        "PollService already initialised with a different client",
      );
    }
    return PollService.instance;
  }

  public static reset(): void {
    if (PollService.instance) {
      PollService.instance.destroy();
    }
    PollService.instance = undefined as unknown as PollService;
  }

  private validateCronExpression(expression: string): boolean {
    try {
      const cleanExpression = expression.replace(/^["']|["']$/g, "");
      new CronTime(cleanExpression);
      return true;
    } catch (error) {
      logger.error(
        `Invalid cron expression: ${sanitizeForLog(expression)}`,
        error,
      );
      return false;
    }
  }

  private async waitForClientReady(): Promise<void> {
    if (this.client.isReady()) {
      return;
    }

    return new Promise((resolve) => {
      const maxWaitMs = 30000;
      const pollIntervalMs = 500;
      let resolved = false;
      let elapsed = 0;

      const cleanup = (): void => {
        if (resolved) {
          return;
        }
        resolved = true;
        this.client.off("ready", onReady);
        clearInterval(intervalId);
      };

      const onReady = (): void => {
        cleanup();
        resolve();
      };

      const intervalId = setInterval(() => {
        if (this.client.isReady()) {
          cleanup();
          resolve();
          return;
        }

        elapsed += pollIntervalMs;
        if (elapsed >= maxWaitMs) {
          logger.warn(
            "PollService: client did not become ready within expected time; continuing anyway.",
          );
          cleanup();
          resolve();
        }
      }, pollIntervalMs);

      this.client.once("ready", onReady);
    });
  }

  /**
   * Select a poll item from the database that hasn't been used recently
   */
  private async selectPollItem(guildId: string): Promise<IPollItem | null> {
    const cooldownDays = await this.configService.getNumber(
      "polls.cooldown_days",
      7,
    );
    const cooldownDate = new Date();
    cooldownDate.setDate(cooldownDate.getDate() - cooldownDays);

    // First, try to find polls that haven't been used within the cooldown period
    let eligiblePolls = await PollItem.find({
      guildId,
      enabled: true,
      $or: [{ lastUsed: null }, { lastUsed: { $lt: cooldownDate } }],
    }).sort({ usageCount: 1, lastUsed: 1 });

    // If no eligible polls, use the oldest used poll
    if (eligiblePolls.length === 0) {
      eligiblePolls = await PollItem.find({
        guildId,
        enabled: true,
      }).sort({ lastUsed: 1, usageCount: 1 });
    }

    if (eligiblePolls.length === 0) {
      return null;
    }

    // Randomize selection among the least-used polls (top 20% or minimum 3)
    const selectionPoolSize = Math.max(
      3,
      Math.ceil(eligiblePolls.length * 0.2),
    );
    const selectionPool = eligiblePolls.slice(0, selectionPoolSize);
    const randomIndex = Math.floor(Math.random() * selectionPool.length);

    return selectionPool[randomIndex];
  }

  /**
   * Post a poll to a Discord channel
   */
  private async postPoll(schedule: IPollSchedule): Promise<void> {
    try {
      await this.waitForClientReady();

      const guild = await this.client.guilds.fetch(schedule.guildId);
      if (!guild) {
        logger.error(
          `Guild not found with ID: ${sanitizeForLog(schedule.guildId)} for schedule ${sanitizeForLog(schedule._id)}`,
        );
        return;
      }

      const channel = await guild.channels.fetch(schedule.channelId);
      if (!channel || !(channel instanceof TextChannel)) {
        logger.error(
          `Channel not found or not a text channel: ${sanitizeForLog(schedule.channelId)} for schedule ${sanitizeForLog(schedule._id)}`,
        );
        return;
      }

      // Select a poll item
      const pollItem = await this.selectPollItem(schedule.guildId);
      if (!pollItem) {
        logger.warn(
          `No poll items available for guild ${sanitizeForLog(schedule.guildId)}`,
        );
        return;
      }

      // Create the poll manually using Discord.js PollData structure
      const pollData = {
        question: { text: pollItem.question },
        answers: pollItem.answers.map((answer) => ({
          text: answer,
        })),
        duration: schedule.pollDuration,
        allowMultiselect: pollItem.multiSelect,
        layoutType: 1, // DEFAULT layout
      };

      // Build message content with optional role ping
      let content = "";
      if (schedule.roleIdToPing) {
        content = `<@&${schedule.roleIdToPing}>`;
      }

      // Send the poll
      await channel.send({
        content: content || undefined,
        poll: pollData,
      });

      // Update poll item usage statistics
      pollItem.usageCount += 1;
      pollItem.lastUsed = new Date();
      await pollItem.save();

      // Update schedule last run
      schedule.lastRun = new Date();
      await schedule.save();

      logger.info(
        `Posted poll "${sanitizeForLog(pollItem.question)}" to channel ${sanitizeForLog(schedule.channelId)} (schedule ${sanitizeForLog(schedule._id)})`,
      );
    } catch (error) {
      logger.error(
        `Error posting poll for schedule ${sanitizeForLog(schedule._id)}:`,
        error,
      );
    }
  }

  private schedulePoll(schedule: IPollSchedule): CronJob | null {
    if (!this.validateCronExpression(schedule.cronSchedule)) {
      logger.error(
        `Invalid cron schedule for poll ${sanitizeForLog(schedule._id)}: ${sanitizeForLog(schedule.cronSchedule)}`,
      );
      return null;
    }

    try {
      const job = new CronJob(schedule.cronSchedule, async () => {
        try {
          // Fetch fresh schedule data from database to handle updates
          const latestSchedule =
            (await PollSchedule.findById(schedule._id)) ?? schedule;
          await this.postPoll(latestSchedule);
        } catch (error) {
          logger.error(`Error in scheduled poll ${schedule._id}:`, error);
        }
      });

      job.start();
      logger.info(
        `Scheduled poll ${sanitizeForLog(schedule._id)} with cron: ${sanitizeForLog(schedule.cronSchedule)}`,
      );

      const nextRun = job.nextDate();
      logger.info(
        `Next poll ${schedule._id} scheduled for: ${nextRun.toLocaleString()}`,
      );

      return job;
    } catch (error) {
      logger.error(`Error scheduling poll ${schedule._id}:`, error);
      return null;
    }
  }

  public async start(): Promise<void> {
    if (this.isInitialized) {
      logger.warn("Poll service is already initialized, skipping...");
      return;
    }

    logger.info("Starting poll service...");

    try {
      await this.waitForClientReady();

      const enabled = await this.configService.getBoolean(
        "polls.enabled",
        false,
      );

      if (!enabled) {
        logger.info("Poll service is disabled");
        return;
      }

      const guildId = await this.configService.getString("GUILD_ID", "");
      if (!guildId) {
        logger.error("GUILD_ID not configured");
        return;
      }

      // Load all enabled poll schedules for this guild
      let schedules;
      try {
        schedules = await PollSchedule.find({
          guildId,
          enabled: true,
        });
      } catch (error) {
        logger.error("Error loading poll schedules from database:", error);
        throw error;
      }

      logger.info(`Found ${schedules.length} enabled poll schedules`);

      for (const schedule of schedules) {
        const job = this.schedulePoll(schedule);
        if (job) {
          this.jobs.set(schedule._id.toString(), { schedule, job });
        }
      }

      this.isInitialized = true;
      logger.info(`Poll service started with ${this.jobs.size} active jobs`);
    } catch (error) {
      logger.error("Error starting poll service:", error);
      throw error;
    }
  }

  /**
   * Parse, validate, dedup and persist a poll library from a raw YAML/JSON
   * string. This is the sole import path: the bytes come straight from the
   * authenticated admin's browser (pasted into the textarea or read from an
   * uploaded file), so there is no outbound request to forge and no host
   * allowlist to maintain. Callers pass a short provenance label as `source`
   * (e.g. "paste" or "upload").
   */
  public async importFromString(
    raw: string,
    guildId: string,
    userId: string,
    source = "paste",
  ): Promise<{ imported: number; skipped: number; errors: string[] }> {
    const results = {
      imported: 0,
      skipped: 0,
      errors: [] as string[],
    };

    // Apply the same size cap the URL path enforces while streaming. The paste
    // route is already bounded by the WebUI's body-parser limit, but guarding
    // here keeps importFromString safe for any caller (and future limit
    // changes) rather than parsing an unbounded string into memory.
    if (raw.length > MAX_IMPORT_BYTES) {
      results.errors.push(
        `Content too large (max ${MAX_IMPORT_BYTES / (1024 * 1024)} MB)`,
      );
      return results;
    }

    let pollData: PollSource;

    // Try to parse as YAML first (also accepts JSON). yaml.load is permissive,
    // so a JSON.parse fallback only matters for the rare body it rejects; both
    // failing surfaces a clean error rather than throwing to the caller.
    try {
      pollData = yaml.load(raw) as PollSource;
    } catch {
      try {
        pollData = JSON.parse(raw);
      } catch {
        results.errors.push(
          "Invalid format: could not parse content as YAML or JSON",
        );
        return results;
      }
    }

    // yaml.load / JSON.parse can yield null, undefined, or a scalar for an
    // empty or non-object body, so guard before dereferencing.
    if (!pollData?.polls || !Array.isArray(pollData.polls)) {
      results.errors.push("Invalid format: expected { polls: [...] }");
      return results;
    }

    // Process each poll
    for (let i = 0; i < pollData.polls.length; i++) {
      const poll = pollData.polls[i];

      // Validate poll data. The question and every answer must be plain
      // strings: the parsed body is untrusted, and a non-string question (e.g.
      // a YAML/JSON object like `{ $ne: null }`) would otherwise flow into the
      // `PollItem.findOne` duplicate check as a query operator — a NoSQL
      // injection sink (CodeQL js/sql-injection). The typeof guards confine it
      // to primitive strings before it ever reaches the query.
      if (
        typeof poll.question !== "string" ||
        !poll.question ||
        !Array.isArray(poll.answers) ||
        !poll.answers.every((a) => typeof a === "string")
      ) {
        results.errors.push(`Poll ${i + 1}: Missing question or answers`);
        results.skipped++;
        continue;
      }

      if (poll.answers.length < 2 || poll.answers.length > 10) {
        results.errors.push(`Poll ${i + 1}: Must have 2-10 answers`);
        results.skipped++;
        continue;
      }

      if (poll.question.length > MAX_POLL_QUESTION_LENGTH) {
        results.errors.push(
          `Poll ${i + 1}: Question too long (max ${MAX_POLL_QUESTION_LENGTH} chars)`,
        );
        results.skipped++;
        continue;
      }

      if (poll.answers.some((a) => a.length > MAX_POLL_ANSWER_LENGTH)) {
        results.errors.push(
          `Poll ${i + 1}: Answer too long (max ${MAX_POLL_ANSWER_LENGTH} chars)`,
        );
        results.skipped++;
        continue;
      }

      // Check if this poll already exists (by question)
      const existing = await PollItem.findOne({
        guildId,
        question: poll.question,
      });

      if (existing) {
        results.skipped++;
        continue;
      }

      // Create new poll item
      try {
        await PollItem.create({
          guildId,
          question: poll.question,
          answers: poll.answers,
          multiSelect: poll.multiselect ?? false,
          tags: poll.tags ?? [],
          usageCount: 0,
          lastUsed: null,
          enabled: true,
          createdBy: userId,
          source,
        });
        results.imported++;
      } catch (error) {
        results.errors.push(
          `Poll ${i + 1}: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
        results.skipped++;
      }
    }

    return results;
  }

  /**
   * Create a new poll schedule
   */
  public async createSchedule(
    data: Omit<IPollSchedule, "createdAt" | "updatedAt" | "lastRun">,
  ): Promise<IPollSchedule> {
    if (!this.validateCronExpression(data.cronSchedule)) {
      throw new Error(`Invalid cron expression: ${data.cronSchedule}`);
    }

    const schedule = new PollSchedule(data);
    await schedule.save();

    // If the service is running and the schedule is enabled, start the job
    if (this.isInitialized && schedule.enabled) {
      const job = this.schedulePoll(schedule);
      if (job) {
        this.jobs.set(schedule._id.toString(), { schedule, job });
      }
    }

    logger.info(`Created new poll schedule: ${schedule._id}`);
    return schedule;
  }

  /**
   * Edit an existing poll schedule's channel, cron, duration, and ping role.
   * Re-validates the cron expression and re-arms the running `CronJob` in
   * place — stopping the old job and starting a fresh one from the saved row —
   * so the live schedule reflects the edit immediately, exactly as
   * `setScheduleEnabled` does for the toggle path (#556). Other fields
   * (`enabled`, `createdBy`, `lastRun`) are preserved.
   */
  public async updateSchedule(
    scheduleId: string,
    data: {
      channelId: string;
      cronSchedule: string;
      pollDuration: number;
      roleIdToPing: string | null;
    },
    guildId?: string,
  ): Promise<IPollSchedule | null> {
    if (!this.validateCronExpression(data.cronSchedule)) {
      throw new Error(`Invalid cron expression: ${data.cronSchedule}`);
    }

    const schedule = await PollSchedule.findById(scheduleId);
    if (!schedule) {
      return null;
    }
    if (guildId && schedule.guildId !== guildId) {
      logger.warn(
        `Attempted to edit schedule ${sanitizeForLog(schedule._id.toString())} from wrong guild (got ${sanitizeForLog(guildId)})`,
      );
      return null;
    }

    schedule.channelId = data.channelId;
    schedule.cronSchedule = data.cronSchedule;
    schedule.pollDuration = data.pollDuration;
    schedule.roleIdToPing = data.roleIdToPing;
    await schedule.save();

    // Re-arm the cron job in place: stop the old job and start a fresh one from
    // the saved row so a changed cron/channel takes effect now, not on the next
    // service restart. Mirrors the stop/restart lockstep in setScheduleEnabled.
    // Key off the canonical `_id` (not the raw `scheduleId` argument) for both
    // the lookup and the re-insert so a non-canonical id can't leave the old
    // job running while a second one is scheduled for the same row.
    const canonicalId = schedule._id.toString();
    const existing = this.jobs.get(canonicalId);
    if (existing) {
      existing.job.stop();
      this.jobs.delete(canonicalId);
    }

    if (this.isInitialized && schedule.enabled) {
      const job = this.schedulePoll(schedule);
      if (job) {
        this.jobs.set(canonicalId, { schedule, job });
      }
    }

    logger.info(`Updated poll schedule: ${sanitizeForLog(canonicalId)}`);
    return schedule;
  }

  /**
   * Flip a poll schedule's `enabled` flag. Restarts or stops the cron
   * job in lockstep so the toggle reflects in scheduling, not just the
   * database row. Used by the WebUI write surface (#383).
   */
  public async setScheduleEnabled(
    scheduleId: string,
    enabled: boolean,
    guildId?: string,
  ): Promise<IPollSchedule | null> {
    const schedule = await PollSchedule.findById(scheduleId);
    if (!schedule) {
      return null;
    }
    if (guildId && schedule.guildId !== guildId) {
      logger.warn(
        `Attempted to toggle schedule ${sanitizeForLog(schedule._id.toString())} from wrong guild (got ${sanitizeForLog(guildId)})`,
      );
      return null;
    }

    if (schedule.enabled === enabled) {
      return schedule;
    }

    schedule.enabled = enabled;
    await schedule.save();

    const existing = this.jobs.get(scheduleId);
    if (existing) {
      existing.job.stop();
      this.jobs.delete(scheduleId);
    }

    if (this.isInitialized && enabled) {
      const job = this.schedulePoll(schedule);
      if (job) {
        this.jobs.set(schedule._id.toString(), { schedule, job });
      }
    }

    logger.info(
      `${enabled ? "Enabled" : "Disabled"} poll schedule: ${sanitizeForLog(schedule._id.toString())}`,
    );
    return schedule;
  }

  /**
   * Flip a poll item's `enabled` flag. Disabled items are skipped during
   * scheduled selection. Used by the WebUI write surface (#383).
   */
  public async setPollItemEnabled(
    itemId: string,
    enabled: boolean,
    guildId?: string,
  ): Promise<IPollItem | null> {
    const item = await PollItem.findById(itemId);
    if (!item) {
      return null;
    }
    if (guildId && item.guildId !== guildId) {
      logger.warn(
        `Attempted to toggle poll item ${sanitizeForLog(item._id.toString())} from wrong guild (got ${sanitizeForLog(guildId)})`,
      );
      return null;
    }

    if (item.enabled === enabled) {
      return item;
    }

    item.enabled = enabled;
    await item.save();
    logger.info(
      `${enabled ? "Enabled" : "Disabled"} poll item: ${sanitizeForLog(item._id.toString())}`,
    );
    return item;
  }

  /**
   * Delete a poll schedule
   */
  public async deleteSchedule(
    scheduleId: string,
    guildId?: string,
  ): Promise<boolean> {
    const schedule = await PollSchedule.findById(scheduleId);
    if (!schedule) {
      return false;
    }

    if (guildId && schedule.guildId !== guildId) {
      logger.warn(
        `Attempted to delete schedule ${sanitizeForLog(scheduleId)} from wrong guild`,
      );
      return false;
    }

    // Stop the job if it's running
    const scheduledJob = this.jobs.get(scheduleId);
    if (scheduledJob) {
      scheduledJob.job.stop();
      this.jobs.delete(scheduleId);
    }

    await PollSchedule.findByIdAndDelete(scheduleId);
    logger.info(`Deleted poll schedule: ${sanitizeForLog(scheduleId)}`);
    return true;
  }

  /**
   * List all poll schedules for a guild
   */
  public async listSchedules(guildId: string): Promise<IPollSchedule[]> {
    return await PollSchedule.find({ guildId }).sort({ createdAt: -1 });
  }

  /**
   * Get a specific poll schedule
   */
  public async getSchedule(scheduleId: string): Promise<IPollSchedule | null> {
    return await PollSchedule.findById(scheduleId);
  }

  /**
   * Create a poll item manually
   */
  public async createPollItem(
    data: Omit<
      IPollItem,
      "createdAt" | "updatedAt" | "usageCount" | "lastUsed"
    >,
  ): Promise<IPollItem> {
    const pollItem = new PollItem(data);
    await pollItem.save();
    logger.info(`Created new poll item: ${pollItem._id}`);
    return pollItem;
  }

  /**
   * Edit an existing poll item's question, answers, tags, and multiSelect.
   * Usage statistics and provenance (`usageCount`, `lastUsed`, `createdBy`,
   * `source`) are deliberately left untouched so editing a question does not
   * reset its rotation history (#556). Schema validation on `save()` enforces
   * the 2–10 answers / 55-char caps as defence-in-depth behind the route-layer
   * checks.
   */
  public async updatePollItem(
    itemId: string,
    data: {
      question: string;
      answers: string[];
      multiSelect: boolean;
      tags: string[];
    },
    guildId?: string,
  ): Promise<IPollItem | null> {
    const item = await PollItem.findById(itemId);
    if (!item) {
      return null;
    }
    if (guildId && item.guildId !== guildId) {
      logger.warn(
        `Attempted to edit poll item ${sanitizeForLog(item._id.toString())} from wrong guild (got ${sanitizeForLog(guildId)})`,
      );
      return null;
    }

    item.question = data.question;
    item.answers = data.answers;
    item.multiSelect = data.multiSelect;
    item.tags = data.tags;
    await item.save();

    logger.info(`Updated poll item: ${sanitizeForLog(item._id.toString())}`);
    return item;
  }

  /**
   * List poll items for a guild
   */
  public async listPollItems(guildId: string): Promise<IPollItem[]> {
    return await PollItem.find({ guildId }).sort({ createdAt: -1 });
  }

  /**
   * Delete a poll item
   */
  public async deletePollItem(
    itemId: string,
    guildId?: string,
  ): Promise<boolean> {
    const item = await PollItem.findById(itemId);
    if (!item) {
      return false;
    }

    if (guildId && item.guildId !== guildId) {
      logger.warn(
        `Attempted to delete poll item ${sanitizeForLog(itemId)} from wrong guild`,
      );
      return false;
    }

    await PollItem.findByIdAndDelete(itemId);
    logger.info(`Deleted poll item: ${sanitizeForLog(itemId)}`);
    return true;
  }

  /**
   * Test a schedule by posting a poll immediately
   */
  public async testSchedule(scheduleId: string): Promise<void> {
    const schedule = await PollSchedule.findById(scheduleId);
    if (!schedule) {
      throw new Error("Schedule not found");
    }

    await this.postPoll(schedule);
  }

  public async reload(): Promise<void> {
    logger.info("Reloading poll service...");

    // Stop all existing jobs
    for (const [id, scheduledJob] of this.jobs.entries()) {
      scheduledJob.job.stop();
      this.jobs.delete(id);
    }

    this.isInitialized = false;

    // Restart the service
    await this.start();
  }

  public destroy(): void {
    for (const scheduledJob of this.jobs.values()) {
      scheduledJob.job.stop();
    }
    this.jobs.clear();
    this.isInitialized = false;
    logger.info("Poll service destroyed");
  }
}
