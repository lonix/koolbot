import {
  Client,
  GatewayIntentBits,
  Interaction,
  VoiceState,
  ChannelType,
  CategoryChannel,
  GuildBasedChannel,
  VoiceChannel,
} from "discord.js";
import { config } from "dotenv";
import Logger from "./utils/logger.js";
import { handleCommands } from "./commands/index.js";
import mongoose from "mongoose";
import { VoiceChannelManager } from "./services/voice-channel-manager.js";
import { ChannelInitializer } from "./services/channel-initializer.js";
import { CommandManager } from "./services/command-manager.js";
import { VoiceChannelTracker } from "./services/voice-channel-tracker.js";
import { VoiceChannelAnnouncer } from "./services/voice-channel-announcer.js";
import { ConfigService } from "./services/config-service.js";

config();
const logger = Logger.getInstance();

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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

let isShuttingDown = false;

async function initializeDatabase(): Promise<void> {
  try {
    await mongoose.connect(process.env.MONGODB_URI!);
    logger.info("Connected to MongoDB");
  } catch (error) {
    logger.error("Failed to connect to MongoDB:", error);
    throw error;
  }
}

async function cleanupVoiceChannels(
  createOfflineLobby: boolean = false,
): Promise<void> {
  try {
    const configService = ConfigService.getInstance();
    if (await configService.get("ENABLE_VC_MANAGEMENT")) {
      logger.info("Cleaning up voice channels...");
      const guild = await client.guilds.fetch(
        await configService.getString("GUILD_ID", ""),
      );
      if (guild) {
        // Get the VC category
        const categoryName = await configService.getString(
          "VC_CATEGORY_NAME",
          "Dynamic Voice Channels",
        );
        const category = guild.channels.cache.find(
          (channel: GuildBasedChannel) =>
            channel.type === ChannelType.GuildCategory &&
            channel.name === categoryName,
        ) as CategoryChannel;

        if (category) {
          // Clean up any empty channels in the category
          for (const channel of category.children.cache.values()) {
            if (
              channel.type === ChannelType.GuildVoice &&
              channel.members.size === 0 &&
              channel.name !==
                (await configService.getString("LOBBY_CHANNEL_NAME", "Lobby"))
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

async function cleanup(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  try {
    logger.info("Cleaning up...");
    await cleanupVoiceChannels();
    logger.info("Cleanup completed");
  } catch (error) {
    logger.error("Error during cleanup:", error);
  } finally {
    process.exit(0);
  }
}

// Handle process termination
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

client.once("ready", async () => {
  try {
    logger.info("Bot is starting up...");

    // Initialize configuration service first
    const configService = ConfigService.getInstance();
    configService.setClient(client);
    await configService.initialize();

    // Migrate environment variables to config service
    await configService.migrateFromEnv();
    logger.info("Configuration service initialized");

    // Initialize database after config service
    await initializeDatabase();
    logger.info("Database initialized");

    // Set up CommandManager with client
    CommandManager.getInstance().setClient(client);

    // Register reload callbacks
    configService.registerReloadCallback(async () => {
      // Reinitialize voice channel announcer
      VoiceChannelAnnouncer.getInstance(client).start();
      logger.info("Voice channel announcer reloaded");

      // Reinitialize voice channel manager
      if (await configService.get("ENABLE_VC_MANAGEMENT")) {
        const guild = await client.guilds.fetch(
          await configService.getString("GUILD_ID", ""),
        );
        if (guild) {
          await VoiceChannelManager.getInstance(client).initialize(guild.id);
          logger.info("Voice channel manager reloaded");
        }
      }

      // Reinitialize voice channel tracker
      if (await configService.get("ENABLE_VC_TRACKING")) {
        VoiceChannelTracker.getInstance(client);
        logger.info("Voice channel tracker reloaded");
      }

      // Re-register commands based on new configuration
      await CommandManager.getInstance().registerCommands();
      logger.info("Commands re-registered");
    });

    // Initialize voice channel announcer
    VoiceChannelAnnouncer.getInstance(client).start();
    logger.info("Voice channel announcer initialized");

    // Initialize channels
    const guild = await client.guilds.fetch(
      await configService.getString("GUILD_ID", ""),
    );
    if (guild) {
      // Clean up any existing offline lobby channel
      const offlineLobbyName = await configService.getString(
        "LOBBY_CHANNEL_NAME_OFFLINE",
      );
      if (offlineLobbyName) {
        const offlineLobby = guild.channels.cache.find(
          (channel) =>
            channel.type === ChannelType.GuildVoice &&
            channel.name === offlineLobbyName,
        ) as VoiceChannel;

        if (offlineLobby) {
          // If there are users in the offline lobby, create a new channel for them
          if (offlineLobby.members.size > 0) {
            const firstMember = offlineLobby.members.first();
            if (firstMember) {
              const categoryName = await configService.getString(
                "VC_CATEGORY_NAME",
                "Dynamic Voice Channels",
              );
              const category = guild.channels.cache.find(
                (channel: GuildBasedChannel) =>
                  channel.type === ChannelType.GuildCategory &&
                  channel.name === categoryName,
              ) as CategoryChannel;

              if (category) {
                const newChannel = await guild.channels.create({
                  name: `${firstMember.user.username}'s Channel`,
                  type: ChannelType.GuildVoice,
                  parent: category,
                });

                // Move all users to the new channel
                for (const member of offlineLobby.members.values()) {
                  try {
                    await member.voice.setChannel(newChannel);
                  } catch (error) {
                    logger.error(
                      `Error moving member ${member.user.tag}:`,
                      error,
                    );
                  }
                }
              }
            }
          }

          // Delete the offline lobby channel
          try {
            await offlineLobby.delete("Bot startup cleanup");
            logger.info("Deleted offline lobby channel");
          } catch (error) {
            logger.error("Error deleting offline lobby channel:", error);
          }
        }
      }

      await ChannelInitializer.getInstance().initializeChannels(guild);
      logger.info("Channels initialized");

      // Initialize voice channel manager and clean up any empty channels
      if (await configService.get("ENABLE_VC_MANAGEMENT")) {
        await VoiceChannelManager.getInstance(client).initialize(guild.id);
      }
    } else {
      logger.error("Guild not found, skipping channel initialization");
    }

    // Register commands
    await CommandManager.getInstance().registerCommands();
    logger.info("Commands registered");

    logger.info(`Bot is ready! Logged in as ${client.user?.tag}`);
  } catch (error) {
    logger.error("Error during bot startup:", error);
    await cleanup();
  }
});

client.on("interactionCreate", async (interaction: Interaction) => {
  if (interaction.isChatInputCommand()) {
    await handleCommands(interaction);
  }
});

client.on(
  "voiceStateUpdate",
  async (oldState: VoiceState, newState: VoiceState) => {
    try {
      const configService = ConfigService.getInstance();
      // Handle voice channel management
      if (await configService.get("ENABLE_VC_MANAGEMENT")) {
        await VoiceChannelManager.getInstance(client).handleVoiceStateUpdate(
          oldState,
          newState,
        );
      }

      // Handle voice channel tracking
      if (await configService.get("ENABLE_VC_TRACKING")) {
        try {
          await VoiceChannelTracker.getInstance(client).handleVoiceStateUpdate(
            oldState,
            newState,
          );
        } catch (error) {
          logger.error("Error handling voice state update in tracker:", error);
        }
      }
    } catch (error) {
      logger.error("Error handling voice state update:", error);
    }
  },
);

// Start the bot
client.login(process.env.DISCORD_TOKEN).catch((error) => {
  logger.error("Failed to login:", error);
  process.exit(1);
});
