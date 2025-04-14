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
    await mongoose.connect(
      process.env.MONGODB_URI || "mongodb://mongodb:27017/koolbot",
    );
    logger.info("Connected to MongoDB");
  } catch (error) {
    logger.error("Failed to connect to MongoDB:", error);
    throw error;
  }
}

async function cleanupVoiceChannels(): Promise<void> {
  try {
    if (process.env.ENABLE_VC_MANAGEMENT === "true") {
      logger.info("Cleaning up voice channels...");
      const guild = await client.guilds.fetch(process.env.GUILD_ID || "");
      if (guild) {
        // Get the VC category
        const category = guild.channels.cache.find(
          (channel: GuildBasedChannel) =>
            channel.type === ChannelType.GuildCategory &&
            channel.name === process.env.VC_CATEGORY_NAME,
        ) as CategoryChannel;

        if (category) {
          // Create offline lobby channel
          const offlineLobbyName = process.env.LOBBY_CHANNEL_NAME_OFFLINE;
          if (!offlineLobbyName) {
            logger.error("LOBBY_CHANNEL_NAME_OFFLINE is not set in environment variables");
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
              logger.info(`Created offline lobby channel: ${offlineLobbyName}`);
            } catch (error) {
              logger.error("Error creating offline lobby channel:", error);
            }
          }

          // Delete all empty voice channels
          const emptyChannels = category.children.cache.filter(
            (channel: GuildBasedChannel) =>
              channel.type === ChannelType.GuildVoice &&
              channel.members.size === 0 &&
              channel.name !== process.env.LOBBY_CHANNEL_NAME &&
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
              channel.name === process.env.LOBBY_CHANNEL_NAME,
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
    logger.info("Starting cleanup process...");

    // Clean up voice channels
    await cleanupVoiceChannels();

    // Clean up voice channel manager
    VoiceChannelManager.getInstance(client).destroy();
    logger.info("Voice channel manager destroyed");

    // Close MongoDB connection
    await mongoose.connection.close();
    logger.info("MongoDB connection closed");

    // Destroy Discord client
    client.destroy();
    logger.info("Discord client destroyed");

    // Wait for Discord to process the disconnection
    logger.info("Waiting for Discord to process disconnection...");
    await new Promise(resolve => setTimeout(resolve, 5000));

    process.exit(0);
  } catch (error) {
    logger.error("Error during cleanup:", error);
    process.exit(1);
  }
}

// Set up periodic cleanup
const cleanupInterval = setInterval(() => {
  cleanupVoiceChannels().catch((error: Error) => {
    logger.error("Error during periodic cleanup:", error);
  });
}, 5 * 60 * 1000); // Run every 5 minutes

// Clean up on process exit
process.on("SIGTERM", () => {
  clearInterval(cleanupInterval);
  cleanup().catch((error: Error) => {
    logger.error("Error during cleanup:", error);
    process.exit(1);
  });
});

process.on("SIGINT", async () => {
  logger.info("Received SIGINT, shutting down...");
  await cleanup();
});

process.on("SIGQUIT", async () => {
  logger.info("Received SIGQUIT, shutting down...");
  await cleanup();
});

process.on("uncaughtException", async (error: Error) => {
  logger.error("Uncaught Exception:", error);
  await cleanup();
});

process.on("unhandledRejection", async (error: Error) => {
  logger.error("Unhandled Rejection:", error);
  await cleanup();
});

client.once("ready", async () => {
  try {
    logger.info("Bot is starting up...");

    // Initialize database first
    await initializeDatabase();
    logger.info("Database initialized");

    // Initialize channels
    const guild = await client.guilds.fetch(process.env.GUILD_ID || "");
    if (guild) {
      // Handle offline lobby channel
      const category = guild.channels.cache.find(
        (channel: GuildBasedChannel) =>
          channel.type === ChannelType.GuildCategory &&
          channel.name === process.env.VC_CATEGORY_NAME,
      ) as CategoryChannel;

      if (category) {
        const offlineLobbyName = process.env.LOBBY_CHANNEL_NAME_OFFLINE;
        if (!offlineLobbyName) {
          logger.error("LOBBY_CHANNEL_NAME_OFFLINE is not set in environment variables");
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
                  logger.error(`Error moving member ${member.user.tag}:`, error);
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
      if (process.env.ENABLE_VC_MANAGEMENT === "true") {
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
    logger.error("Failed to initialize bot:", error);
    await cleanup();
  }
});

client.on("interactionCreate", async (interaction: Interaction) => {
  if (interaction.isCommand()) {
    await handleCommands(interaction);
  }
});

client.on(
  "voiceStateUpdate",
  async (oldState: VoiceState, newState: VoiceState) => {
    try {
      // Handle voice channel management
      if (process.env.ENABLE_VC_MANAGEMENT === "true") {
        await VoiceChannelManager.getInstance(client).handleVoiceStateUpdate(
          oldState,
          newState,
        );
      }

      // Handle voice channel tracking
      if (process.env.ENABLE_VC_TRACKING === "true") {
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
client.login(process.env.DISCORD_TOKEN).catch((error) => {
  logger.error("Failed to login:", error);
  process.exit(1);
});
