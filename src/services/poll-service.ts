import { Client, TextChannel } from "discord.js";
import { CronJob, CronTime } from "cron";
import { ConfigService } from "./config-service.js";
import logger from "../utils/logger.js";
import { PollSchedule, IPollSchedule } from "../models/poll-schedule.js";
import { PollItem, IPollItem } from "../models/poll-item.js";
import axios from "axios";
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
    }
    return PollService.instance;
  }

  private validateCronExpression(expression: string): boolean {
    try {
      const cleanExpression = expression.replace(/^["']|["']$/g, "");
      new CronTime(cleanExpression);
      return true;
    } catch (error) {
      logger.error(`Invalid cron expression: ${expression}`, error);
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

      const cleanup = () => {
        if (resolved) {
          return;
        }
        resolved = true;
        this.client.off("ready", onReady);
        clearInterval(intervalId);
      };

      const onReady = () => {
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
          `Guild not found with ID: ${schedule.guildId} for schedule ${schedule._id}`,
        );
        return;
      }

      const channel = await guild.channels.fetch(schedule.channelId);
      if (!channel || !(channel instanceof TextChannel)) {
        logger.error(
          `Channel not found or not a text channel: ${schedule.channelId} for schedule ${schedule._id}`,
        );
        return;
      }

      // Select a poll item
      const pollItem = await this.selectPollItem(schedule.guildId);
      if (!pollItem) {
        logger.warn(`No poll items available for guild ${schedule.guildId}`);
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
        `Posted poll "${pollItem.question}" to channel ${schedule.channelId} (schedule ${schedule._id})`,
      );
    } catch (error) {
      logger.error(`Error posting poll for schedule ${schedule._id}:`, error);
    }
  }

  private schedulePoll(schedule: IPollSchedule): CronJob | null {
    if (!this.validateCronExpression(schedule.cronSchedule)) {
      logger.error(
        `Invalid cron schedule for poll ${schedule._id}: ${schedule.cronSchedule}`,
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
        `Scheduled poll ${schedule._id} with cron: ${schedule.cronSchedule}`,
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
   * Import polls from a URL (YAML or JSON format)
   */
  public async importFromUrl(
    url: string,
    guildId: string,
    userId: string,
  ): Promise<{ imported: number; skipped: number; errors: string[] }> {
    const results = {
      imported: 0,
      skipped: 0,
      errors: [] as string[],
    };

    try {
      // Fetch the content with timeout
      const response = await axios.get(url, {
        timeout: 10000,
        maxContentLength: 1024 * 1024, // 1MB max
        headers: {
          "User-Agent": "KoolBot-PollService/1.0",
        },
      });

      let pollData: PollSource;

      // Try to parse as YAML first (also works for JSON)
      try {
        pollData = yaml.load(response.data) as PollSource;
      } catch {
        // If YAML fails, try JSON
        pollData = JSON.parse(response.data);
      }

      if (!pollData.polls || !Array.isArray(pollData.polls)) {
        results.errors.push("Invalid format: expected { polls: [...] }");
        return results;
      }

      // Process each poll
      for (let i = 0; i < pollData.polls.length; i++) {
        const poll = pollData.polls[i];

        // Validate poll data
        if (!poll.question || !poll.answers || !Array.isArray(poll.answers)) {
          results.errors.push(`Poll ${i + 1}: Missing question or answers`);
          results.skipped++;
          continue;
        }

        if (poll.answers.length < 2 || poll.answers.length > 10) {
          results.errors.push(`Poll ${i + 1}: Must have 2-10 answers`);
          results.skipped++;
          continue;
        }

        if (poll.question.length > 300) {
          results.errors.push(
            `Poll ${i + 1}: Question too long (max 300 chars)`,
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
            source: url,
          });
          results.imported++;
        } catch (error) {
          results.errors.push(
            `Poll ${i + 1}: ${error instanceof Error ? error.message : "Unknown error"}`,
          );
          results.skipped++;
        }
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.code === "ECONNABORTED") {
          results.errors.push("Request timeout - URL took too long to respond");
        } else if (error.response) {
          results.errors.push(
            `HTTP ${error.response.status}: ${error.response.statusText}`,
          );
        } else if (error.request) {
          results.errors.push(
            "No response from URL - check if URL is accessible",
          );
        } else {
          results.errors.push(`Request error: ${error.message}`);
        }
      } else {
        results.errors.push(
          `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
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
        `Attempted to delete schedule ${scheduleId} from wrong guild`,
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
    logger.info(`Deleted poll schedule: ${scheduleId}`);
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
      logger.warn(`Attempted to delete poll item ${itemId} from wrong guild`);
      return false;
    }

    await PollItem.findByIdAndDelete(itemId);
    logger.info(`Deleted poll item: ${itemId}`);
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
