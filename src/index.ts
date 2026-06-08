import express, { Request, Response } from "express";
import {
  Client,
  Events,
  GatewayIntentBits,
  ChannelType,
  Collection,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  REST,
  Routes,
  TextChannel,
  Partials,
  AuditLogEvent,
} from "discord.js";
import { config as dotenvConfig } from "dotenv";
import { env, getMissingRequiredEnv } from "./config/env.js";
import logger, { isDebugMode } from "./utils/logger.js";
import { ConfigService } from "./services/config-service.js";
import { runNameToIdMigrations } from "./services/name-id-migrator.js";
import { CommandManager } from "./services/command-manager.js";
import {
  VoiceChannelManager,
  resolveManagedCategory,
} from "./services/voice-channel-manager.js";
import { VoiceChannelTracker } from "./services/voice-channel-tracker.js";
import { VoiceChannelAnnouncer } from "./services/voice-channel-announcer.js";
import { VoiceChannelTruncationService } from "./services/voice-channel-truncation.js";
import { MessageActivityTracker } from "./services/message-activity-tracker.js";
import { MessageActivityCleanupService } from "./services/message-activity-cleanup.js";
import { CommandAuditCleanupService } from "./services/command-audit-cleanup.js";
import { ScheduledAnnouncementService } from "./services/scheduled-announcement-service.js";
import { ChannelInitializer } from "./services/channel-initializer.js";
import { StartupMigrator } from "./services/startup-migrator.js";
import { DiscordLogger } from "./services/discord-logger.js";
import { BotStatusService } from "./services/bot-status-service.js";
import { QuoteChannelManager } from "./services/quote-channel-manager.js";
import { NoticesChannelManager } from "./services/notices-channel-manager.js";
import { PermissionsService } from "./services/permissions-service.js";
import { ReactionRoleService } from "./services/reaction-role-service.js";
import { PollService } from "./services/poll-service.js";
import { LeaderboardRoleService } from "./services/leaderboard-role-service.js";
import { DigestService } from "./services/digest-service.js";
import { RewindNudgeService } from "./services/rewind-nudge-service.js";
import { WizardService } from "./services/wizard-service.js";
import { MonitoringService } from "./services/monitoring-service.js";
import {
  createUserWebRouter,
  createWebRouter,
  getMissingWebUIEnvVars,
  isWebUIEnabled,
} from "./web/index.js";
import {
  createMetricsRouter,
  recordDiscordEvent,
  setBotUp,
  setVoiceSessionsProvider,
} from "./web/metrics.js";
import mongoose from "mongoose";

dotenvConfig();

// Validate critical environment variables
const missingVars = getMissingRequiredEnv();

if (missingVars.length > 0) {
  logger.error(
    `Missing required environment variables: ${missingVars.join(", ")}`,
  );
  process.exit(1);
}

// Set debug mode
if (isDebugMode()) {
  logger.info("Debug mode enabled");
}

// Register global error handlers EARLY to catch initialization errors
process.on("unhandledRejection", (error) => {
  logger.error("Unhandled promise rejection:", error);
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception:", error);
  process.exit(1);
});

// Extend Client type to include commands collection
declare module "discord.js" {
  export interface Client {
    commands: Collection<
      string,
      {
        execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
        autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
      }
    >;
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Reaction],
});

// Add commands collection to client
client.commands = new Collection();

let isShuttingDown = false;
let discordLogger: DiscordLogger;
const botStatusService: BotStatusService = BotStatusService.getInstance(client);

// Healthcheck endpoint for Docker (start only after bot is ready)

function startHealthServer(): void {
  const healthApp = express();
  healthApp.get("/health", (_req: Request, res: Response) => {
    let discordReady = false;
    let mongoReady = false;
    try {
      discordReady =
        typeof client.isReady === "function" ? client.isReady() : false;
    } catch {
      discordReady = false;
    }
    try {
      mongoReady = mongoose.connection.readyState === 1;
    } catch {
      mongoReady = false;
    }
    if (discordReady && mongoReady) {
      res.status(200).send("OK");
    } else {
      res.status(503).send("Service Unavailable");
    }
  });

  // Mount the WebUI behind the feature flag. When disabled, no /admin/*
  // route is registered, so the server responds 404 for those paths
  // exactly as it did before this scaffold landed.
  if (isWebUIEnabled()) {
    const missing = getMissingWebUIEnvVars();
    if (missing.length > 0) {
      logger.error(
        `WEBUI_ENABLED=true but missing required env vars: ${missing.join(", ")}. WebUI will not be mounted.`,
      );
    } else {
      // Default to NOT trusting any X-Forwarded-* headers so an attacker
      // cannot spoof req.ip and bypass the rate limiter. Operators behind
      // a reverse proxy can opt in by setting WEBUI_TRUST_PROXY to a hop
      // count (e.g. "1") or to one of express' supported strings ("loopback",
      // "linklocal", "uniquelocal", "true").
      const trustProxyRaw = (env.webui.trustProxy || "").trim();
      if (trustProxyRaw) {
        const asNumber = Number(trustProxyRaw);
        if (Number.isFinite(asNumber) && asNumber >= 0) {
          healthApp.set("trust proxy", asNumber);
        } else if (trustProxyRaw.toLowerCase() === "true") {
          healthApp.set("trust proxy", true);
        } else {
          healthApp.set("trust proxy", trustProxyRaw);
        }
        logger.info(`WebUI trust proxy set to: ${trustProxyRaw}`);
      }
      healthApp.use("/admin", createWebRouter(client));
      healthApp.use("/me", createUserWebRouter(client));
      logger.info("WebUI mounted at /admin and user surface at /me");
    }
  } else {
    logger.debug("WEBUI_ENABLED is not true; /admin routes not mounted");
  }

  // Prometheus/OpenMetrics scrape endpoint (#509). Mounted only when
  // METRICS_ENABLED=true; otherwise nothing is registered and /metrics
  // stays 404. Optionally bearer-token protected via METRICS_TOKEN.
  const metricsRouter = createMetricsRouter();
  if (metricsRouter) {
    healthApp.use(metricsRouter);
  }

  healthApp.listen(3000, () => {
    logger.info("Healthcheck server running on port 3000");
  });
}

// Add health server startup to main ready handler
client.once(Events.ClientReady, async (readyClient) => {
  logger.info(`Ready! Logged in as ${readyClient.user.tag}`);

  // koolbot_up = 1: connected to Discord (#509).
  setBotUp(true);

  // Set connecting status (yellow) immediately when Discord is ready
  botStatusService.setConnectingStatus();

  await initializeServices();

  // Start healthcheck server after all other initialization
  startHealthServer();
});

async function cleanupGlobalCommands(): Promise<void> {
  try {
    const token = env.discordToken;
    const clientId = env.clientId;

    if (!token || !clientId) {
      logger.warn(
        "Cannot check global commands: Missing DISCORD_TOKEN or CLIENT_ID",
      );
      return;
    }

    const rest = new REST({ version: "10" }).setToken(token);

    // Check for global commands
    const globalCommands = (await rest.get(
      Routes.applicationCommands(clientId),
    )) as Array<{
      id: string;
      name: string;
      description: string;
    }>;

    if (globalCommands.length > 0) {
      logger.warn(
        `Found ${globalCommands.length} global commands that may conflict with guild commands:`,
      );
      globalCommands.forEach((cmd) => {
        logger.warn(`  - /${cmd.name} (${cmd.description})`);
      });

      // Remove global commands to prevent duplicates
      logger.info(
        "Removing global commands to prevent duplicate command issues...",
      );
      await rest.put(Routes.applicationCommands(clientId), { body: [] });
      logger.info("✅ Global commands removed successfully");
    } else {
      logger.debug("No global commands found - no cleanup needed");
    }
  } catch (error) {
    logger.error("Error checking/cleaning global commands:", error);
    // Don't fail startup for this - just log the error
  }
}

async function cleanupVoiceChannels(): Promise<void> {
  try {
    const configService = ConfigService.getInstance();

    // Check if voice channel management is enabled. Legacy keys
    // (voice_channel.enabled, ENABLE_VC_MANAGEMENT) are migrated to this
    // canonical key by StartupMigrator, so only the canonical key is read here.
    const isEnabled = await configService.getBoolean(
      "voicechannels.enabled",
      false,
    );

    if (isEnabled) {
      logger.info("Cleaning up voice channels...");
      const guild = await client.guilds.fetch(
        await configService.getString("GUILD_ID", ""),
      );
      if (guild) {
        const category = await resolveManagedCategory(guild);

        if (category) {
          // Get lobby channel name. Legacy keys (voice_channel.lobby_channel_name,
          // LOBBY_CHANNEL_NAME) are migrated to this canonical key by
          // StartupMigrator, so only the canonical key is read here.
          const lobbyChannelName = await configService.getString(
            "voicechannels.lobby.name",
            "Lobby",
          );

          // Clean up any empty channels in the category
          for (const channel of category.children.cache.values()) {
            if (
              channel.type === ChannelType.GuildVoice &&
              channel.members.size === 0 &&
              channel.name !== lobbyChannelName
            ) {
              try {
                await channel.delete();
                logger.info(`Cleaned up empty channel ${channel.name}`);
              } catch (error) {
                logger.error(
                  `Error cleaning up channel ${channel.name}:`,
                  error,
                );
              }
            }
          }
        }
      }
    }
  } catch (error) {
    logger.error("Error during voice channel cleanup:", error);
  }
}

// Graceful shutdown handler
async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    logger.info("Shutdown already in progress, forcing exit...");
    process.exit(1);
  }

  isShuttingDown = true;
  const startTime = Date.now();

  // koolbot_up = 0: no longer serving (#509).
  setBotUp(false);

  try {
    logger.info(`🔄 Received ${signal}, starting graceful shutdown...`);

    // Helper function to run operations with timeout
    const runWithTimeout = async <T>(
      operation: () => Promise<T>,
      timeoutMs: number,
      operationName: string,
    ): Promise<T | null> => {
      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error(`Timeout after ${timeoutMs}ms`)),
            timeoutMs,
          );
        });

        const result = await Promise.race([operation(), timeoutPromise]);
        logger.info(`✅ ${operationName} completed`);
        return result;
      } catch (error) {
        logger.error(`❌ Error in ${operationName}:`, error);
        return null;
      }
    };

    // 1. Switch lobby to offline mode (priority 1) - 5 second timeout
    await runWithTimeout(
      async () => {
        const guildId = await configService.getString("GUILD_ID", "");
        if (guildId) {
          const guild = await client.guilds.fetch(guildId);
          const offlineLobbyName = await configService.getString(
            "voicechannels.lobby.offlinename",
            "🔴 Lobby",
          );

          // Find the lobby channel and rename it
          const lobbyChannel = guild.channels.cache.find(
            (channel) =>
              channel.name.includes("🟢") &&
              channel.type === ChannelType.GuildVoice,
          );

          if (lobbyChannel && lobbyChannel.type === ChannelType.GuildVoice) {
            await lobbyChannel.setName(offlineLobbyName);
            logger.info(
              `✅ Lobby renamed to offline mode: ${offlineLobbyName}`,
            );
          }
        }
      },
      5000,
      "Lobby offline mode switch",
    );

    // 2. Set bot status to offline (priority 2) - 3 second timeout
    await runWithTimeout(
      async () => {
        await client.user?.setStatus("invisible");
      },
      3000,
      "Bot status offline",
    );

    // 3. Deregister commands (no wait needed) - 5 second timeout
    await runWithTimeout(
      async () => {
        const guildId = await configService.getString("GUILD_ID", "");
        if (guildId) {
          const rest = new REST({ version: "10" }).setToken(env.discordToken!);
          await rest.put(
            Routes.applicationGuildCommands(env.clientId!, guildId),
            { body: [] },
          );
          logger.info("✅ Commands deregistered from Discord");
        }
      },
      5000,
      "Command deregistration",
    );

    // 4. Clean up voice channels (existing functionality) - 3 second timeout
    await runWithTimeout(
      async () => {
        await cleanupVoiceChannels();
      },
      3000,
      "Voice channel cleanup",
    );

    // 5. Stop quote channel cleanup job - 1 second timeout
    await runWithTimeout(
      async () => {
        await quoteChannelManager.stop();
      },
      1000,
      "Quote channel cleanup job stop",
    );

    // 6. Stop scheduled announcements cron jobs - 1 second timeout
    await runWithTimeout(
      async () => {
        scheduledAnnouncementService.destroy();
      },
      1000,
      "Scheduled announcements cleanup",
    );

    // 7. Stop remaining timer-owning services so their intervals/timeouts
    //    don't fire against a half-closed Discord client or MongoDB
    //    connection during the rest of the shutdown sequence.
    await runWithTimeout(
      async () => {
        voiceChannelManager.destroy();
        voiceChannelAnnouncer.destroy();
        voiceChannelTruncation.destroy();
        messageActivityCleanup.destroy();
        CommandAuditCleanupService.getInstance().destroy();
        await noticesChannelManager.stop();
        pollService.destroy();
        leaderboardRoleService.destroy();
        digestService.destroy();
        rewindNudgeService.destroy();
        WizardService.getInstance().shutdown();
        MonitoringService.getInstance().destroy();
        await botStatusService.shutdown();
      },
      2000,
      "Service timer cleanup",
    );

    // 8. Close database connections - 3 second timeout
    await runWithTimeout(
      async () => {
        const { default: mongoose } = await import("mongoose");
        if (mongoose.connection.readyState !== 0) {
          await mongoose.connection.close();
          logger.info("✅ Database connections closed");
        }
      },
      3000,
      "Database connection closure",
    );

    // 9. Destroy Discord client - 5 second timeout
    await runWithTimeout(
      async () => {
        await client.destroy();
      },
      5000,
      "Discord client destruction",
    );

    const shutdownTime = Date.now() - startTime;
    logger.info(`✅ Graceful shutdown completed in ${shutdownTime}ms`);

    // Exit with success
    process.exit(0);
  } catch (error) {
    logger.error("❌ Error during graceful shutdown:", error);
    process.exit(1);
  }
}

// Handle process termination
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// Service instances (declared outside try-catch for proper scoping)
let configService: ConfigService;
let commandManager: CommandManager;
let voiceChannelManager: VoiceChannelManager;
let voiceChannelTracker: VoiceChannelTracker;
let voiceChannelAnnouncer: VoiceChannelAnnouncer;
let voiceChannelTruncation: VoiceChannelTruncationService;
let messageActivityTracker: MessageActivityTracker;
let messageActivityCleanup: MessageActivityCleanupService;
let scheduledAnnouncementService: ScheduledAnnouncementService;
let channelInitializer: ChannelInitializer;
let startupMigrator: StartupMigrator;
let quoteChannelManager: QuoteChannelManager;
let noticesChannelManager: NoticesChannelManager;
let reactionRoleService: ReactionRoleService;
let pollService: PollService;
let leaderboardRoleService: LeaderboardRoleService;
let digestService: DigestService;
let rewindNudgeService: RewindNudgeService;

// Wrap service instantiation in try-catch to ensure errors are caught
try {
  configService = ConfigService.getInstance();
  commandManager = CommandManager.getInstance(client);
  voiceChannelManager = VoiceChannelManager.getInstance(client);
  // Feed the koolbot_voice_sessions_active gauge (#509) at scrape time.
  setVoiceSessionsProvider(() => voiceChannelManager.getActiveSessionCount());
  voiceChannelTracker = VoiceChannelTracker.getInstance(client);
  voiceChannelAnnouncer = VoiceChannelAnnouncer.getInstance(client);
  voiceChannelTruncation = VoiceChannelTruncationService.getInstance(client);
  messageActivityTracker = MessageActivityTracker.getInstance(client);
  messageActivityCleanup = MessageActivityCleanupService.getInstance(client);
  scheduledAnnouncementService =
    ScheduledAnnouncementService.getInstance(client);
  channelInitializer = ChannelInitializer.getInstance(client);
  startupMigrator = StartupMigrator.getInstance();
  quoteChannelManager = QuoteChannelManager.getInstance(client);
  noticesChannelManager = NoticesChannelManager.getInstance(client);
  reactionRoleService = ReactionRoleService.getInstance(client);
  pollService = PollService.getInstance(client);
  leaderboardRoleService = LeaderboardRoleService.getInstance(client);
  digestService = DigestService.getInstance(client);
  rewindNudgeService = RewindNudgeService.getInstance(client);
} catch (error) {
  logger.error("❌ Fatal error during service instantiation:", error);
  process.exit(1);
}

// Bot status service is already initialized above

async function initializeServices(): Promise<void> {
  try {
    // Set client for services that need it
    configService.setClient(client);

    // Check and clean up any global commands that might cause duplicates
    await cleanupGlobalCommands();

    // Initialize services
    await configService.initialize();
    // await configService.migrateFromEnv(); // Disabled - let startup migrator handle all migration
    await startupMigrator.checkForOutdatedSettings();

    // Initialize Discord logger AFTER database connection is established
    discordLogger = DiscordLogger.getInstance(client);
    await discordLogger.initialize();

    // Log database connection status
    await discordLogger.logDatabaseStatus(
      true,
      "Successfully connected to MongoDB database",
    );

    // Try to register commands, but don't fail if Discord API is unavailable
    try {
      await commandManager.registerCommands();
      await commandManager.populateClientCommands();
      logger.info("✅ Discord commands registered successfully");

      // Log successful Discord registration
      await discordLogger.logDiscordRegistrationSuccess();
    } catch (error) {
      logger.warn(
        "⚠️ Failed to register Discord commands - bot will continue without slash commands",
      );
      logger.warn(
        "💡 Voice channel management and user tracking will still work",
      );
      logger.warn(
        "💡 Restart the bot when Discord API is available to register commands",
      );
      logger.debug("Command registration error details:", error);
    }

    // Get guild ID from config
    const guildId = await configService.getString("GUILD_ID", "");
    if (!guildId) {
      throw new Error("GUILD_ID not configured");
    }

    // Translate any legacy name-stored Discord references (e.g. role names
    // or channel names) into IDs before services that consume them start
    // up. One-shot, idempotent, no-op on already-migrated deployments.
    await runNameToIdMigrations(client, guildId, configService);

    // Initialize voice channel services
    await voiceChannelManager.initialize(guildId);
    await voiceChannelTracker.initialize();
    await voiceChannelTruncation.initialize();
    await messageActivityTracker.initialize();
    await messageActivityCleanup.initialize();
    await voiceChannelAnnouncer.start();
    await scheduledAnnouncementService.start();
    await channelInitializer.initializeChannels(
      await client.guilds.fetch(guildId),
    );

    // Initialize quote channel manager
    await quoteChannelManager.initialize();

    // Initialize notices channel manager
    await noticesChannelManager.initialize();

    // Initialize reaction role service
    await reactionRoleService.initialize();

    // Initialize poll service
    await pollService.start();

    // Initialize leaderboard role rewards service
    await leaderboardRoleService.start();

    // Initialize weekly voice-activity digest service (#483)
    await digestService.start();

    // Initialize annual rewind nudge service (#484). The /me/rewind
    // page itself is served by the user WebUI router regardless of
    // this service — this only schedules the end-of-year DM nudge.
    await rewindNudgeService.start();

    // Start the slash-command audit log cleanup cron (#459)
    CommandAuditCleanupService.getInstance().start();

    // Initialize permissions service and set up default permissions
    const permissionsService = PermissionsService.getInstance(client);
    await permissionsService.initializeDefaultPermissions(guildId);

    // Switch lobby to online mode on startup and handle any users in offline lobby
    try {
      const guild = await client.guilds.fetch(guildId);
      await voiceChannelManager.renameLobbyToOnline(guild);
    } catch (error) {
      logger.error("❌ Error switching lobby to online mode:", error);
    }

    // Set bot to fully operational status (green) and start VC monitoring
    botStatusService.setOperationalStatus();
    botStatusService.startVcMonitoring();

    logger.info("All services initialized successfully");
  } catch (error) {
    logger.error("Error initializing services:", error);

    // Log startup failure
    if (discordLogger) {
      await discordLogger.logError(
        error instanceof Error ? error : new Error(String(error)),
        "Service Initialization",
      );
    }

    process.exit(1);
  }
}

// Track Discord connectivity for koolbot_up (#509). ClientReady flips it
// to 1; a shard dropping flips it to 0, and a resume brings it back.
client.on(Events.ShardDisconnect, () => {
  recordDiscordEvent("shardDisconnect");
  setBotUp(false);
});
client.on(Events.ShardResume, () => {
  recordDiscordEvent("shardResume");
  setBotUp(true);
});

client.on(Events.InteractionCreate, async (interaction) => {
  recordDiscordEvent("interactionCreate");
  // Handle autocomplete interactions
  if (interaction.isAutocomplete()) {
    try {
      const command = client.commands.get(interaction.commandName);
      if (!command || !command.autocomplete) {
        return;
      }
      await command.autocomplete(interaction);
    } catch (error) {
      logger.error(
        `Error handling autocomplete for ${interaction.commandName}:`,
        error,
      );
    }
    return;
  }

  // Handle button interactions
  if (interaction.isButton()) {
    try {
      if (interaction.customId.startsWith("vc_control_")) {
        const { handleVCControlButton } =
          await import("./handlers/vc-control-button-handler.js");
        await handleVCControlButton(interaction);
      } else if (interaction.customId.startsWith("vc_preset_")) {
        const { handleVCPresetButton } =
          await import("./handlers/vc-preset-handler.js");
        await handleVCPresetButton(interaction);
      } else {
        logger.debug(
          `Ignoring button interaction with unrecognized customId: ${interaction.customId}`,
        );
        await interaction.reply({
          content:
            "This button is no longer supported. The control it belongs to has been removed in v1.0 — please dismiss this message.",
          ephemeral: true,
        });
      }
    } catch (error) {
      logger.error("Error handling button interaction:", error);
    }
    return;
  }

  // Handle select menu interactions
  if (interaction.isStringSelectMenu()) {
    try {
      if (interaction.customId.startsWith("vc_transfer_select_")) {
        const { handleVCTransferSelect } =
          await import("./handlers/vc-transfer-select-handler.js");
        await handleVCTransferSelect(interaction);
      } else if (interaction.customId.startsWith("vc_preset_")) {
        const { handleVCPresetSelect } =
          await import("./handlers/vc-preset-handler.js");
        await handleVCPresetSelect(interaction);
      } else {
        logger.debug(
          `Ignoring select menu interaction with unrecognized customId: ${interaction.customId}`,
        );
        await interaction.reply({
          content:
            "This menu is no longer supported. The control it belongs to has been removed in v1.0 — please dismiss this message.",
          ephemeral: true,
        });
      }
    } catch (error) {
      logger.error("Error handling select menu interaction:", error);
    }
    return;
  }

  // Handle modal submit interactions
  if (interaction.isModalSubmit()) {
    try {
      if (interaction.customId.startsWith("vc_modal_")) {
        const { handleVCModal } =
          await import("./handlers/vc-modal-handler.js");
        await handleVCModal(interaction);
      } else {
        logger.debug(
          `Ignoring modal interaction with unrecognized customId: ${interaction.customId}`,
        );
        await interaction.reply({
          content:
            "This form is no longer supported. The control it belongs to has been removed in v1.0 — please dismiss this message.",
          ephemeral: true,
        });
      }
    } catch (error) {
      logger.error("Error handling modal interaction:", error);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  try {
    const command = client.commands.get(interaction.commandName);
    if (!command) {
      logger.error(`No command matching ${interaction.commandName} was found.`);
      // Attempt a one-time refresh in case commands were not yet populated
      try {
        await commandManager.populateClientCommands();
        const refreshed = client.commands.get(interaction.commandName);
        if (!refreshed) {
          return;
        }
        await commandManager.executeCommand(
          interaction.commandName,
          interaction as ChatInputCommandInteraction,
          () => refreshed.execute(interaction as ChatInputCommandInteraction),
        );
        return;
      } catch (refreshError) {
        logger.error(
          "Error refreshing commands after missing command:",
          refreshError,
        );
        return;
      }
    }

    await commandManager.executeCommand(
      interaction.commandName,
      interaction as ChatInputCommandInteraction,
      () => command.execute(interaction as ChatInputCommandInteraction),
    );
  } catch (error) {
    logger.error(`Error executing command ${interaction.commandName}:`, error);
    const errorMessage = "There was an error while executing this command!";

    if (interaction.replied || interaction.deferred) {
      await interaction.editReply({ content: errorMessage });
    } else {
      await interaction.reply({ content: errorMessage, ephemeral: true });
    }
  }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  recordDiscordEvent("voiceStateUpdate");
  try {
    const member = newState.member || oldState.member;
    if (member) {
      logger.debug(
        `Voice state update: ${member.displayName} (${member.id}) - Old: ${oldState.channel?.name || "none"} -> New: ${newState.channel?.name || "none"}`,
      );
    }

    await voiceChannelManager.handleVoiceStateUpdate(oldState, newState);
    await voiceChannelTracker.handleVoiceStateUpdate(oldState, newState);

    // Update bot status with current VC user count (username logic removed)
    if (botStatusService) {
      const vcUserCount = await voiceChannelManager.getTotalVcUserCount();
      botStatusService.updateVcUserCount(vcUserCount);
    }
  } catch (error) {
    logger.error("Error handling voice state update:", error);
  }
});

// Handle text messages for per-user/per-channel activity tracking (#495).
// Gating (enabled, bot/DM, excluded channels) lives in the tracker.
client.on(Events.MessageCreate, async (message) => {
  recordDiscordEvent("messageCreate");
  try {
    await messageActivityTracker.handleMessageCreate(message);
  } catch (error) {
    logger.error("Error handling messageCreate:", error);
  }
});

// Handle channel updates to detect renames
client.on(Events.ChannelUpdate, async (oldChannel, newChannel) => {
  try {
    // Only track voice channel updates
    if (newChannel.type !== ChannelType.GuildVoice) {
      return;
    }

    // Type guard - ensure we're working with guild-based channels
    if (!("name" in oldChannel) || !("name" in newChannel)) {
      return;
    }

    // Check if the channel name changed
    if (oldChannel.name !== newChannel.name) {
      logger.info(
        `Channel renamed: "${oldChannel.name}" → "${newChannel.name}" (${newChannel.id})`,
      );

      // Try to identify who renamed the channel by checking audit logs
      try {
        const auditLogs = await newChannel.guild.fetchAuditLogs({
          type: AuditLogEvent.ChannelUpdate,
          limit: 1,
        });

        const entry = auditLogs.entries.first();
        if (
          entry &&
          entry.targetId === newChannel.id &&
          Date.now() - entry.createdTimestamp < 5000
        ) {
          const executor = entry.executor;
          logger.info(
            `Channel renamed by: ${executor?.displayName || executor?.username || "Unknown"} (${executor?.id || "Unknown"})`,
          );
        }
      } catch (auditError) {
        logger.debug(
          "Could not fetch audit logs for channel rename:",
          auditError,
        );
      }
    }
  } catch (error) {
    logger.error("Error handling channel update:", error);
  }
});

// Easter egg: Creator detection when joining the server
client.on(Events.GuildMemberAdd, async (member) => {
  if (member.id === "174051908586176512") {
    try {
      const guild = member.guild;
      const generalChannel = guild.channels.cache.find(
        (channel) =>
          channel.name === "general" && channel.type === ChannelType.GuildText,
      ) as TextChannel;

      if (generalChannel) {
        await generalChannel.send("👑 All hail my creator!");
        logger.debug("Easter egg triggered for creator joining server");
      }
    } catch (error) {
      logger.debug("Easter egg failed (non-critical):", error);
    }
  }
});

// Login to Discord (errors will be caught by global error handlers)
client.login(env.discordToken).catch((error) => {
  logger.error("❌ Failed to login to Discord:", error);
  process.exit(1);
});
