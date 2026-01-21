import express, { Request, Response } from "express";
import {
  Client,
  Events,
  GatewayIntentBits,
  GuildBasedChannel,
  CategoryChannel,
  ChannelType,
  Collection,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  REST,
  Routes,
  TextChannel,
  Partials,
} from "discord.js";
import { config as dotenvConfig } from "dotenv";
import logger from "./utils/logger.js";
import { ConfigService } from "./services/config-service.js";
import { CommandManager } from "./services/command-manager.js";
import { VoiceChannelManager } from "./services/voice-channel-manager.js";
import { VoiceChannelTracker } from "./services/voice-channel-tracker.js";
import { VoiceChannelAnnouncer } from "./services/voice-channel-announcer.js";
import { VoiceChannelTruncationService } from "./services/voice-channel-truncation.js";
import { ScheduledAnnouncementService } from "./services/scheduled-announcement-service.js";
import { ChannelInitializer } from "./services/channel-initializer.js";
import { StartupMigrator } from "./services/startup-migrator.js";
import { DiscordLogger } from "./services/discord-logger.js";
import { BotStatusService } from "./services/bot-status-service.js";
import { QuoteChannelManager } from "./services/quote-channel-manager.js";
import { PermissionsService } from "./services/permissions-service.js";
import FriendshipListener from "./services/friendship-listener.js";
import { ReactionRoleService } from "./services/reaction-role-service.js";

dotenvConfig();

// Validate critical environment variables
const requiredEnvVars = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  CLIENT_ID: process.env.CLIENT_ID,
  GUILD_ID: process.env.GUILD_ID,
  MONGODB_URI: process.env.MONGODB_URI,
};

const missingVars = Object.entries(requiredEnvVars)
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missingVars.length > 0) {
  logger.error(
    `Missing required environment variables: ${missingVars.join(", ")}`,
  );
  process.exit(1);
}

// Set debug mode
if (process.env.DEBUG === "true") {
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

// ...existing code...
import mongoose from "mongoose";

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
  healthApp.listen(3000, () => {
    logger.info("Healthcheck server running on port 3000");
  });
}

// Add health server startup to main ready handler
client.once(Events.ClientReady, async (readyClient) => {
  logger.info(`Ready! Logged in as ${readyClient.user.tag}`);

  // Set connecting status (yellow) immediately when Discord is ready
  botStatusService.setConnectingStatus();

  await initializeServices();

  // Start healthcheck server after all other initialization
  startHealthServer();
});

async function cleanupGlobalCommands(): Promise<void> {
  try {
    const token = process.env.DISCORD_TOKEN;
    const clientId = process.env.CLIENT_ID;

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

    // Check if voice channel management is enabled using new config keys
    const isEnabled =
      (await configService.getBoolean("voicechannels.enabled", false)) ||
      (await configService.getBoolean("voice_channel.enabled", false)) ||
      (await configService.getBoolean("ENABLE_VC_MANAGEMENT", false));

    if (isEnabled) {
      logger.info("Cleaning up voice channels...");
      const guild = await client.guilds.fetch(
        await configService.getString("GUILD_ID", ""),
      );
      if (guild) {
        // Get the VC category - try new config keys first, then fall back to old ones
        const categoryName =
          (await configService.getString("voice_channel.category_name")) ||
          (await configService.getString(
            "VC_CATEGORY_NAME",
            "Dynamic Voice Channels",
          ));
        const category = guild.channels.cache.find(
          (channel: GuildBasedChannel) =>
            channel.type === ChannelType.GuildCategory &&
            channel.name === categoryName,
        ) as CategoryChannel;

        if (category) {
          // Get lobby channel name - try new config keys first, then fall back to old ones
          const lobbyChannelName =
            (await configService.getString(
              "voice_channel.lobby_channel_name",
            )) ||
            (await configService.getString("LOBBY_CHANNEL_NAME", "Lobby"));

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
          const rest = new REST({ version: "10" }).setToken(
            process.env.DISCORD_TOKEN!,
          );
          await rest.put(
            Routes.applicationGuildCommands(process.env.CLIENT_ID!, guildId),
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

    // 7. Close database connections - 3 second timeout
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

    // 7. Destroy Discord client - 5 second timeout
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
let scheduledAnnouncementService: ScheduledAnnouncementService;
let channelInitializer: ChannelInitializer;
let startupMigrator: StartupMigrator;
let quoteChannelManager: QuoteChannelManager;
let reactionRoleService: ReactionRoleService;

// Wrap service instantiation in try-catch to ensure errors are caught
try {
  configService = ConfigService.getInstance();
  commandManager = CommandManager.getInstance(client);
  voiceChannelManager = VoiceChannelManager.getInstance(client);
  voiceChannelTracker = VoiceChannelTracker.getInstance(client);
  voiceChannelAnnouncer = VoiceChannelAnnouncer.getInstance(client);
  voiceChannelTruncation = VoiceChannelTruncationService.getInstance(client);
  scheduledAnnouncementService =
    ScheduledAnnouncementService.getInstance(client);
  channelInitializer = ChannelInitializer.getInstance(client);
  startupMigrator = StartupMigrator.getInstance();
  quoteChannelManager = QuoteChannelManager.getInstance(client);
  reactionRoleService = ReactionRoleService.getInstance(client);
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

    // Initialize voice channel services
    await voiceChannelManager.initialize(guildId);
    await voiceChannelTracker.initialize();
    await voiceChannelTruncation.initialize();
    await voiceChannelAnnouncer.start();
    await scheduledAnnouncementService.start();
    await channelInitializer.initializeChannels(
      await client.guilds.fetch(guildId),
    );

    // Initialize quote channel manager
    await quoteChannelManager.initialize();

    // Initialize reaction role service
    await reactionRoleService.initialize();

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

    // Initialize passive friendship listener if enabled
    try {
      const friendshipEnabled = await configService.getBoolean(
        "fun.friendship",
        false,
      );
      if (friendshipEnabled) {
        FriendshipListener.getInstance(client).initialize();
      } else {
        logger.debug(
          "Friendship listener disabled via config (fun.friendship=false)",
        );
      }
    } catch (flError) {
      logger.warn(
        "Friendship listener failed to initialize (non-critical)",
        flError,
      );
    }

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

client.on(Events.InteractionCreate, async (interaction) => {
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
      // Check if it's a VC control button
      if (interaction.customId.startsWith("vc_control_")) {
        const { handleVCControlButton } =
          await import("./handlers/vc-control-button-handler.js");
        await handleVCControlButton(interaction);
      } else {
        // Handle wizard buttons
        const { handleWizardButton } =
          await import("./handlers/wizard-button-handler.js");
        await handleWizardButton(interaction);
      }
    } catch (error) {
      logger.error("Error handling button interaction:", error);
    }
    return;
  }

  // Handle select menu interactions
  if (interaction.isStringSelectMenu()) {
    try {
      const { handleWizardSelectMenu } =
        await import("./handlers/wizard-select-handler.js");
      await handleWizardSelectMenu(interaction);
    } catch (error) {
      logger.error("Error handling select menu interaction:", error);
    }
    return;
  }

  // Handle modal submit interactions
  if (interaction.isModalSubmit()) {
    try {
      // Check if it's a VC modal
      if (interaction.customId.startsWith("vc_modal_")) {
        const { handleVCModal } =
          await import("./handlers/vc-modal-handler.js");
        await handleVCModal(interaction);
      } else {
        // Handle wizard modals
        const { handleWizardModal } =
          await import("./handlers/wizard-modal-handler.js");
        await handleWizardModal(interaction);
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
client.login(process.env.DISCORD_TOKEN).catch((error) => {
  logger.error("❌ Failed to login to Discord:", error);
  process.exit(1);
});
