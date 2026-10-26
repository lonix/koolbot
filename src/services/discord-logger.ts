import { Client, TextChannel, EmbedBuilder, ColorResolvable } from "discord.js";
import { env } from "../config/env.js";
import logger from "../utils/logger.js";
import { ConfigService } from "./config-service.js";
import { defaultConfig } from "./config-schema.js";
import { embedColor } from "../utils/embed-style.js";

/**
 * Discord log categories, derived from the config schema (#844): every
 * `core.<type>.enabled` key that has a matching `core.<type>.channel_id`.
 * Declaring the pair in `config-schema.ts` is what makes a category
 * configurable — it renders on the Settings page, passes write-time
 * validation, and survives the startup cleanup sweep.
 */
export const DISCORD_LOG_TYPES: readonly string[] = Object.keys(defaultConfig)
  .map((key) => /^core\.([^.]+)\.enabled$/.exec(key)?.[1])
  .filter(
    (type): type is string =>
      type !== undefined && `core.${type}.channel_id` in defaultConfig,
  );

export interface ILogChannel {
  enabled: boolean;
  channelId?: string;
}

/** What an admin should do next when a log post reports a failure. */
const CHECK_LOG_HINT = "Check the bot's log for the full error.";

export interface ILogMessage {
  title: string;
  /** Left out when it would only repeat the title. */
  description?: string;
  color?: ColorResolvable;
  fields?: Array<{
    name: string;
    value: string;
    inline?: boolean;
  }>;
  timestamp?: Date;
  footer?: string;
}

export class DiscordLogger {
  private static instance: DiscordLogger;
  private client: Client;
  private configService: ConfigService;
  private logChannels: Map<string, ILogChannel> = new Map();
  private isInitialized: boolean = false;
  private reloadCallbackRegistered: boolean = false;

  private constructor(client: Client) {
    this.client = client;
    this.configService = ConfigService.getInstance();
  }

  public static getInstance(client: Client): DiscordLogger {
    if (!DiscordLogger.instance) {
      DiscordLogger.instance = new DiscordLogger(client);
    }
    return DiscordLogger.instance;
  }

  /**
   * Check if the logger is fully initialized and ready
   */
  public isReady(): boolean {
    return this.isInitialized && this.logChannels.size > 0;
  }

  /**
   * Initialize the Discord logger by loading channel configurations
   */
  public async initialize(): Promise<void> {
    try {
      logger.info("Initializing Discord logger...");

      // Load all core.* channel configurations
      await this.loadLogChannels();

      // Re-read every category whenever ConfigService.triggerReload() fires
      // (e.g. after a wizard apply). Registered once so repeated
      // initialize() calls (tests, reconnects) don't stack callbacks.
      if (!this.reloadCallbackRegistered) {
        this.configService.registerReloadCallback(async () => {
          await this.refreshChannels();
        });
        this.reloadCallbackRegistered = true;
      }

      this.isInitialized = true;
      logger.info("Discord logger initialized successfully");
    } catch (error) {
      logger.error("Error initializing Discord logger:", error);
    }
  }

  /**
   * Load the enabled flag + channel id for every schema-declared log
   * category. Reads go through ConfigService so cached values and schema
   * defaults apply (previously this scanned raw Mongo rows, which meant a
   * category could only be discovered if someone had hand-written a row —
   * and the startup cleanup deleted those rows as unknown keys; #844).
   */
  private async loadLogChannels(): Promise<void> {
    try {
      for (const logType of DISCORD_LOG_TYPES) {
        const { enabled, channelId } = await this.resolveLogChannel(logType);
        logger.debug(
          `Loaded log channel: ${logType} - Enabled: ${enabled}, Channel: ${channelId || "not set"}`,
        );
      }
    } catch (error) {
      logger.error("Error loading log channels:", error);
    }
  }

  /**
   * Read the current enabled flag + channel id for one category and cache
   * it in `logChannels`. Called on every `logToChannel()` so a Settings-page
   * save (which writes straight through ConfigService's cache) takes effect
   * on the next log message — no restart or reload needed.
   */
  private async resolveLogChannel(logType: string): Promise<ILogChannel> {
    const enabled = await this.configService.getBoolean(
      `core.${logType}.enabled`,
      false,
    );
    const channelId = await this.configService.getString(
      `core.${logType}.channel_id`,
      "",
    );
    const resolved: ILogChannel = {
      enabled,
      channelId: channelId || undefined,
    };
    this.logChannels.set(logType, resolved);
    return resolved;
  }

  /**
   * Whether one category is currently switched on and pointed at a channel.
   *
   * Callers that have to do work to build a message (a DB roll-up, an extra
   * query) use this to skip that work when nothing would be posted anyway,
   * instead of duplicating the `core.<type>.*` key names. Unknown categories
   * are always false.
   */
  public async isCategoryEnabled(logType: string): Promise<boolean> {
    if (!DISCORD_LOG_TYPES.includes(logType)) return false;
    const { enabled, channelId } = await this.resolveLogChannel(logType);
    return enabled && Boolean(channelId);
  }

  /**
   * Send a log message to a specific core channel. Never throws; resolves
   * `true` only when the message was actually posted, so a caller that must
   * not lose a one-off message (the update note, #1029) can tell a skipped or
   * failed send from a delivered one.
   */
  public async logToChannel(
    logType: string,
    message: ILogMessage,
  ): Promise<boolean> {
    try {
      // Check if logger is ready
      if (!this.isReady()) {
        logger.debug(
          `Discord logger: Logger not ready, skipping message to ${logType}`,
        );
        return false;
      }

      logger.debug(`Discord logger: Attempting to log to channel: ${logType}`);

      const channelConfig = DISCORD_LOG_TYPES.includes(logType)
        ? await this.resolveLogChannel(logType)
        : this.logChannels.get(logType);
      logger.debug(
        `Discord logger: Channel config for ${logType}:`,
        channelConfig,
      );

      if (
        !channelConfig ||
        !channelConfig.enabled ||
        !channelConfig.channelId
      ) {
        logger.debug(
          `Discord logger: Log channel ${logType} not configured or disabled`,
        );
        return false;
      }

      logger.debug(
        `Discord logger: Looking for channel with ID: ${channelConfig.channelId}`,
      );

      const channel = this.client.channels.cache.get(
        channelConfig.channelId,
      ) as TextChannel;

      if (!channel) {
        logger.warn(
          `Discord logger: Log channel ${logType} not found: ${channelConfig.channelId}`,
        );
        logger.debug(
          `Discord logger: Available channels:`,
          Array.from(this.client.channels.cache.keys()),
        );
        return false;
      }

      logger.debug(
        `Discord logger: Found channel: ${channel.name} (${channel.id})`,
      );

      const embed = new EmbedBuilder()
        .setTitle(message.title)
        .setColor(message.color ?? embedColor("neutral"))
        .setTimestamp(message.timestamp || new Date());

      if (message.description) {
        embed.setDescription(message.description);
      }

      if (message.fields && message.fields.length > 0) {
        embed.addFields(message.fields);
      }

      if (message.footer) {
        embed.setFooter({ text: message.footer });
      }

      // Suppress every mention this message could resolve. Log embeds carry
      // untrusted text — a moderation reason, an error message — and a log
      // channel must never be a way to ping @everyone. Mentions still render
      // as names (allowed_mentions governs notification, not rendering), so
      // the moderation notice's `<@id>` references read as usual.
      await channel.send({
        embeds: [embed],
        allowedMentions: { parse: [] },
      });
      logger.info(
        `Discord logger: Log message sent to ${logType}: ${message.title}`,
      );
      return true;
    } catch (error) {
      logger.error(
        `Discord logger: Error sending log message to ${logType}:`,
        error,
      );
      return false;
    }
  }

  /**
   * Log bot startup
   */
  public async logBotStartup(): Promise<void> {
    await this.logToChannel("startup", {
      title: "KoolBot started",
      color: embedColor("ok"),
      fields: [{ name: "Environment", value: env.nodeEnv, inline: true }],
      footer: "KoolBot · Logs · Startup",
    });
  }

  /**
   * Log bot shutdown
   */
  public async logBotShutdown(): Promise<void> {
    await this.logToChannel("startup", {
      title: "KoolBot is shutting down",
      color: embedColor("warn"),
      footer: "KoolBot · Logs · Shutdown",
    });
  }

  /**
   * The configured server as `Name` + `` `id` ``, or just the id when the
   * guild is not cached (docs/design: ids in mono, after the human name).
   */
  private describeServer(): string {
    const id = env.guildId;
    if (!id) return "Unknown";
    const name = this.client.guilds?.cache?.get(id)?.name;
    return name ? `${name} \`${id}\`` : `\`${id}\``;
  }

  /**
   * Log Discord registration success
   */
  public async logDiscordRegistrationSuccess(): Promise<void> {
    await this.logToChannel("startup", {
      title: "Commands registered with Discord",
      color: embedColor("ok"),
      fields: [{ name: "Server", value: this.describeServer(), inline: true }],
      footer: "KoolBot · Logs · Discord",
    });
  }

  /**
   * Log Discord registration failure
   */
  public async logDiscordRegistrationFailure(error: string): Promise<void> {
    await this.logToChannel("startup", {
      title: "Couldn't register commands with Discord",
      description: CHECK_LOG_HINT,
      color: embedColor("danger"),
      fields: [
        { name: "Error", value: error.substring(0, 1000), inline: false },
      ],
      footer: "KoolBot · Logs · Discord",
    });
  }

  /**
   * Log configuration reload
   */
  public async logConfigReload(result: {
    success: boolean;
    message: string;
    commandsUpdated?: number;
  }): Promise<void> {
    await this.logToChannel("config", {
      title: result.success ? "Settings reloaded" : "Couldn't reload settings",
      description: result.success
        ? result.message
        : `${result.message} ${CHECK_LOG_HINT}`,
      color: result.success ? embedColor("ok") : embedColor("danger"),
      fields:
        result.commandsUpdated !== undefined
          ? [
              {
                name: "Commands updated",
                value: result.commandsUpdated.toString(),
                inline: true,
              },
            ]
          : [],
      footer: "KoolBot · Logs · Configuration",
    });
  }

  /**
   * Log service initialisation
   */
  public async logServiceInit(
    serviceName: string,
    success: boolean,
    details?: string,
  ): Promise<void> {
    await this.logToChannel("startup", {
      title: success
        ? `${serviceName} started`
        : `${serviceName} failed to start`,
      description: details || (success ? undefined : CHECK_LOG_HINT),
      color: success ? embedColor("ok") : embedColor("danger"),
      footer: "KoolBot · Logs · Services",
    });
  }

  /**
   * Log voice channel cleanup results
   */
  public async logCleanupResults(stats: {
    sessionsRemoved: number;
    dataAggregated: number;
    executionTime: number;
    errors: string[];
  }): Promise<void> {
    await this.logToChannel("cleanup", {
      title: "Voice channel clean-up finished",
      description:
        stats.errors.length > 0
          ? `Some steps failed, listed below. ${CHECK_LOG_HINT}`
          : undefined,
      color: stats.errors.length > 0 ? embedColor("warn") : embedColor("ok"),
      fields: [
        {
          name: "Sessions removed",
          value: stats.sessionsRemoved.toString(),
          inline: true,
        },
        {
          name: "Data aggregated",
          value: stats.dataAggregated.toString(),
          inline: true,
        },
        {
          name: "Run time",
          value: `${stats.executionTime} ms`,
          inline: true,
        },
        ...(stats.errors.length > 0
          ? [
              {
                name: "Errors",
                value: stats.errors.slice(0, 5).join("\n"),
                inline: false,
              },
            ]
          : []),
      ],
      footer: "KoolBot · Logs · Cleanup",
    });
  }

  /**
   * Log database connection status
   */
  public async logDatabaseStatus(
    connected: boolean,
    details?: string,
  ): Promise<void> {
    await this.logToChannel("startup", {
      title: connected
        ? "Connected to the database"
        : "Couldn't connect to the database",
      description: details || (connected ? undefined : CHECK_LOG_HINT),
      color: connected ? embedColor("ok") : embedColor("danger"),
      fields: [{ name: "Database", value: "MongoDB", inline: true }],
      footer: "KoolBot · Logs · Database",
    });
  }

  /**
   * Log error events
   */
  public async logError(error: Error, context: string): Promise<void> {
    await this.logToChannel("errors", {
      title: `Error in ${context}`,
      description: CHECK_LOG_HINT,
      color: embedColor("danger"),
      fields: [
        { name: "Context", value: context, inline: true },
        { name: "Error type", value: error.constructor.name, inline: true },
        {
          name: "Error message",
          value: error.message.substring(0, 1000),
          inline: false,
        },
      ],
      footer: "KoolBot · Logs · Errors",
    });
  }

  /**
   * Log cron job success
   */
  public async logCronSuccess(
    jobName: string,
    details?: string,
  ): Promise<void> {
    await this.logToChannel("cron", {
      title: `${jobName} ran`,
      description: details,
      color: embedColor("ok"),
      fields: [{ name: "Job", value: jobName, inline: true }],
      footer: "KoolBot · Logs · Cron",
    });
  }

  /**
   * Log cron job failure
   */
  public async logCronFailure(jobName: string, error: string): Promise<void> {
    await this.logToChannel("cron", {
      title: `${jobName} failed`,
      description: CHECK_LOG_HINT,
      color: embedColor("danger"),
      fields: [
        { name: "Job", value: jobName, inline: true },
        { name: "Error", value: error.substring(0, 1000), inline: false },
      ],
      footer: "KoolBot · Logs · Cron",
    });
  }

  /**
   * Refresh log channel configurations (useful after config changes)
   */
  public async refreshChannels(): Promise<void> {
    logger.info("Refreshing Discord logger channel configurations...");
    this.logChannels.clear();
    await this.loadLogChannels();
    logger.info("Discord logger channel configurations refreshed");
  }
}
