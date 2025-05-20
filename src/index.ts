import {
  Client,
  GatewayIntentBits,
  Interaction,
  VoiceState,
  ChannelType,
  CategoryChannel,
  GuildBasedChannel,
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
    const mongoUri =
      process.env.MONGODB_URI || "mongodb://mongodb:27017/koolbot";
    await mongoose.connect(mongoUri);
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
          // Only create offline lobby if explicitly requested (during shutdown)
          if (createOfflineLobby) {
            const offlineLobbyName = await configService.getString(
              "LOBBY_CHANNEL_NAME_OFFLINE",
            );
            if (!offlineLobbyName) {
              logger.error(
                "LOBBY_CHANNEL_NAME_OFFLINE is not set in configuration",
              );
              return;
            }

            const existingOfflineLobby = category.children.cache.find(
              (channel: GuildBasedChannel) =>
                channel.type === ChannelType.GuildVoice &&
                channel.name === offlineLobbyName,
            );

            if (!existingOfflineLobby) {
              try {
                await guild.channels.create({
                  name: offlineLobbyName,
                  type: ChannelType.GuildVoice,
                  parent: category,
                  position: 0,
                });
                logger.info(
                  `Created offline lobby channel: ${offlineLobbyName}`,
                );
              } catch (error) {
                logger.error("Error creating offline lobby channel:", error);
              }
            }
          }

          // Delete all empty voice channels
          const lobbyChannelName = await configService.getString(
            "LOBBY_CHANNEL_NAME",
            "Lobby",
          );
          const offlineLobbyName = await configService.getString(
            "LOBBY_CHANNEL_NAME_OFFLINE",
          );
          const emptyChannels = category.children.cache.filter(
            (channel: GuildBasedChannel) =>
              channel.type === ChannelType.GuildVoice &&
              channel.members.size === 0 &&
              channel.name !== lobbyChannelName &&
              channel.name !== offlineLobbyName,
          );

          for (const channel of emptyChannels.values()) {
            try {
              await channel.delete("Bot shutdown cleanup");
              logger.info(`Deleted empty voice channel: ${channel.name}`);
            } catch (error) {
              logger.error(`Error deleting channel ${channel.name}:`, error);
            }
          }

          // Delete the lobby channel if empty
          const lobbyChannel = category.children.cache.find(
            (channel: GuildBasedChannel) =>
              channel.type === ChannelType.GuildVoice &&
              channel.name === lobbyChannelName,
          );

          if (lobbyChannel && lobbyChannel.members.size === 0) {
            try {
              await lobbyChannel.delete("Bot shutdown cleanup");
              logger.info("Deleted lobby channel");
            } catch (error) {
              logger.error("Error deleting lobby channel:", error);
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
    await cleanupVoiceChannels(true); // Create offline lobby during actual shutdown
    await mongoose.disconnect();
    logger.info("Cleanup completed");
  } catch (error) {
    logger.error("Error during cleanup:", error);
  }
}

// Handle process termination
process.on("SIGTERM", async () => {
  logger.info("Received SIGTERM signal");
  await cleanup();
  process.exit(0);
});

process.on("SIGINT", async () => {
  logger.info("Received SIGINT signal");
  await cleanup();
  process.exit(0);
});

process.on("unhandledRejection", async (error: Error) => {
  logger.error("Unhandled Rejection:", error);
  await cleanupVoiceChannels(false); // Don't create offline lobby for unhandled rejections
});

process.on("uncaughtException", async (error: Error) => {
  logger.error("Uncaught Exception:", error);
  await cleanup();
});

client.once("ready", async () => {
  try {
    logger.info("Bot is starting up...");

    // Initialize database first
    await initializeDatabase();
    logger.info("Database initialized");

    // Initialize configuration service and migrate from env
    const configService = ConfigService.getInstance();
    configService.setClient(client);
    await configService.initialize();
    await configService.migrateFromEnv();

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
      // Handle offline lobby channel
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
        const offlineLobbyName = await configService.getString(
          "LOBBY_CHANNEL_NAME_OFFLINE",
        );
        if (!offlineLobbyName) {
          logger.error(
            "LOBBY_CHANNEL_NAME_OFFLINE is not set in configuration",
          );
          return;
        }

        const offlineLobby = category.children.cache.find(
          (channel: GuildBasedChannel) =>
            channel.type === ChannelType.GuildVoice &&
            channel.name === offlineLobbyName,
        );

        if (offlineLobby) {
          // If there are users in the offline lobby, create a new channel for them
          if (offlineLobby.members.size > 0) {
            const firstMember = offlineLobby.members.first();
            if (firstMember) {
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
        await VoiceChannelTracker.getInstance(client).handleVoiceStateUpdate(
          oldState,
          newState,
        );
      }
    } catch (error) {
      logger.error("Error handling voice state update:", error);
    }
  },
);

// Start the bot
const configService = ConfigService.getInstance();
client.login(await configService.getString("DISCORD_TOKEN")).catch((error) => {
  logger.error("Failed to login:", error);
  process.exit(1);
});
