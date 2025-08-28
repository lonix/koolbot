import { Client, TextChannel, EmbedBuilder, ColorResolvable } from "discord.js";
import logger from "../utils/logger.js";
import { ConfigService } from "./config-service.js";

export interface ILogChannel {
  enabled: boolean;
  channelId?: string;
}

export interface ILogMessage {
  title: string;
  description: string;
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

      this.isInitialized = true;
      logger.info("Discord logger initialized successfully");
    } catch (error) {
      logger.error("Error initializing Discord logger:", error);
    }
  }

  /**
   * Load all configured log channels from the database
   */
  private async loadLogChannels(): Promise<void> {
    try {
      // Get all configuration keys that start with "core."
      const allConfigs = await this.configService.getAll();

      for (const config of allConfigs) {
        if (config.key.startsWith("core.") && config.key.endsWith(".enabled")) {
          const logType = config.key
            .replace("core.", "")
            .replace(".enabled", "");

          // Get the channel ID for this log type
          const channelId = await this.configService.get(
            `core.${logType}.channel_id`,
          );

          this.logChannels.set(logType, {
            enabled: config.value as boolean,
            channelId: channelId as string,
          });

          logger.debug(
            `Loaded log channel: ${logType} - Enabled: ${config.value}, Channel: ${channelId || "not set"}`,
          );
        }
      }
    } catch (error) {
      logger.error("Error loading log channels:", error);
    }
  }

  /**
   * Send a log message to a specific core channel
   */
  public async logToChannel(
    logType: string,
    message: ILogMessage,
  ): Promise<void> {
    try {
      // Check if logger is ready
      if (!this.isReady()) {
        logger.debug(
          `Discord logger: Logger not ready, skipping message to ${logType}`,
        );
        return;
      }

      logger.debug(`Discord logger: Attempting to log to channel: ${logType}`);

      const channelConfig = this.logChannels.get(logType);
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
        return;
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
        return;
      }

      logger.debug(
        `Discord logger: Found channel: ${channel.name} (${channel.id})`,
      );

      const embed = new EmbedBuilder()
        .setTitle(message.title)
        .setDescription(message.description)
        .setColor(message.color || "#0099ff")
        .setTimestamp(message.timestamp || new Date());

      if (message.fields) {
        embed.addFields(message.fields);
      }

      if (message.footer) {
        embed.setFooter({ text: message.footer });
      }

      await channel.send({ embeds: [embed] });
      logger.info(
        `Discord logger: Log message sent to ${logType}: ${message.title}`,
      );
    } catch (error) {
      logger.error(
        `Discord logger: Error sending log message to ${logType}:`,
        error,
      );
    }
  }

  /**
   * Log bot startup
   */
  public async logBotStartup(): Promise<void> {
    await this.logToChannel("startup", {
      title: "🚀 Bot Started Successfully",
      description: "KoolBot has successfully started and is now online.",
      color: "#00ff00",
      fields: [
        { name: "Status", value: "✅ Online", inline: true },
        { name: "Timestamp", value: new Date().toLocaleString(), inline: true },
        {
          name: "Environment",
          value: process.env.NODE_ENV || "development",
          inline: true,
        },
      ],
      footer: "KoolBot Startup Logger",
    });
  }

  /**
   * Log bot shutdown
   */
  public async logBotShutdown(): Promise<void> {
    await this.logToChannel("startup", {
      title: "🛑 Bot Shutting Down",
      description: "KoolBot is shutting down gracefully.",
      color: "#ff9900",
      fields: [
        { name: "Status", value: "⚠️ Shutting Down", inline: true },
        { name: "Timestamp", value: new Date().toLocaleString(), inline: true },
        { name: "Reason", value: "Graceful shutdown initiated", inline: true },
      ],
      footer: "KoolBot Shutdown Logger",
    });
  }

  /**
   * Log Discord registration success
   */
  public async logDiscordRegistrationSuccess(): Promise<void> {
    await this.logToChannel("startup", {
      title: "✅ Discord Registration Successful",
      description:
        "Bot has successfully registered with Discord and is ready to receive commands.",
      color: "#00ff00",
      fields: [
        { name: "Status", value: "✅ Registered", inline: true },
        { name: "Timestamp", value: new Date().toLocaleString(), inline: true },
        {
          name: "Guild",
          value: process.env.GUILD_ID || "Unknown",
          inline: true,
        },
      ],
      footer: "KoolBot Discord Logger",
    });
  }

  /**
   * Log Discord registration failure
   */
  public async logDiscordRegistrationFailure(error: string): Promise<void> {
    await this.logToChannel("startup", {
      title: "❌ Discord Registration Failed",
      description:
        "Bot failed to register with Discord. Check logs for details.",
      color: "#ff0000",
      fields: [
        { name: "Status", value: "❌ Failed", inline: true },
        { name: "Timestamp", value: new Date().toLocaleString(), inline: true },
        { name: "Error", value: error.substring(0, 1000), inline: false },
      ],
      footer: "KoolBot Discord Logger",
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
      title: result.success
        ? "⚙️ Configuration Reloaded"
        : "❌ Configuration Reload Failed",
      description: result.message,
      color: result.success ? "#00ff00" : "#ff0000",
      fields: [
        {
          name: "Status",
          value: result.success ? "✅ Success" : "❌ Failed",
          inline: true,
        },
        { name: "Timestamp", value: new Date().toLocaleString(), inline: true },
        ...(result.commandsUpdated !== undefined
          ? [
              {
                name: "Commands Updated",
                value: result.commandsUpdated.toString(),
                inline: true,
              },
            ]
          : []),
      ],
      footer: "KoolBot Configuration Logger",
    });
  }

  /**
   * Log service initialization
   */
  public async logServiceInit(
    serviceName: string,
    success: boolean,
    details?: string,
  ): Promise<void> {
    await this.logToChannel("startup", {
      title: success
        ? `✅ ${serviceName} Initialized`
        : `❌ ${serviceName} Failed`,
      description:
        details ||
        (success
          ? `${serviceName} service initialized successfully.`
          : `${serviceName} service failed to initialize.`),
      color: success ? "#00ff00" : "#ff0000",
      fields: [
        { name: "Service", value: serviceName, inline: true },
        {
          name: "Status",
          value: success ? "✅ Success" : "❌ Failed",
          inline: true,
        },
        { name: "Timestamp", value: new Date().toLocaleString(), inline: true },
      ],
      footer: "KoolBot Service Logger",
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
      title: "🧹 Voice Channel Cleanup Completed",
      description:
        stats.errors.length > 0
          ? "Cleanup completed with some errors. Check details below."
          : "Voice channel cleanup completed successfully.",
      color: stats.errors.length > 0 ? "#ff9900" : "#00ff00",
      fields: [
        {
          name: "Sessions Removed",
          value: stats.sessionsRemoved.toString(),
          inline: true,
        },
        {
          name: "Data Aggregated",
          value: stats.dataAggregated.toString(),
          inline: true,
        },
        {
          name: "Execution Time",
          value: `${stats.executionTime}ms`,
          inline: true,
        },
        {
          name: "Status",
          value:
            stats.errors.length > 0 ? "⚠️ Completed with errors" : "✅ Success",
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
      footer: "KoolBot Cleanup Logger",
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
        ? "🗄️ Database Connected"
        : "❌ Database Connection Failed",
      description:
        details ||
        (connected
          ? "Successfully connected to MongoDB database."
          : "Failed to connect to MongoDB database."),
      color: connected ? "#00ff00" : "#ff0000",
      fields: [
        {
          name: "Status",
          value: connected ? "✅ Connected" : "❌ Disconnected",
          inline: true,
        },
        { name: "Timestamp", value: new Date().toLocaleString(), inline: true },
        { name: "Database", value: "MongoDB", inline: true },
      ],
      footer: "KoolBot Database Logger",
    });
  }

  /**
   * Log error events
   */
  public async logError(error: Error, context: string): Promise<void> {
    await this.logToChannel("errors", {
      title: "🚨 Error Occurred",
      description: `An error occurred in ${context}. Check logs for full details.`,
      color: "#ff0000",
      fields: [
        { name: "Context", value: context, inline: true },
        { name: "Error Type", value: error.constructor.name, inline: true },
        { name: "Timestamp", value: new Date().toLocaleString(), inline: true },
        {
          name: "Error Message",
          value: error.message.substring(0, 1000),
          inline: false,
        },
      ],
      footer: "KoolBot Error Logger",
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
      title: `✅ Cron Job Completed: ${jobName}`,
      description: details || `${jobName} cron job executed successfully.`,
      color: "#00ff00",
      fields: [
        { name: "Job Name", value: jobName, inline: true },
        { name: "Status", value: "✅ Success", inline: true },
        { name: "Timestamp", value: new Date().toLocaleString(), inline: true },
      ],
      footer: "KoolBot Cron Logger",
    });
  }

  /**
   * Log cron job failure
   */
  public async logCronFailure(jobName: string, error: string): Promise<void> {
    await this.logToChannel("cron", {
      title: `❌ Cron Job Failed: ${jobName}`,
      description: `${jobName} cron job failed to execute.`,
      color: "#ff0000",
      fields: [
        { name: "Job Name", value: jobName, inline: true },
        { name: "Status", value: "❌ Failed", inline: true },
        { name: "Timestamp", value: new Date().toLocaleString(), inline: true },
        { name: "Error", value: error.substring(0, 1000), inline: false },
      ],
      footer: "KoolBot Cron Logger",
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
