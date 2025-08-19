import {
  Client,
  Events,
  GatewayIntentBits,
  GuildBasedChannel,
  CategoryChannel,
  ChannelType,
  Collection,
  ChatInputCommandInteraction,
} from "discord.js";
import { config as dotenvConfig } from "dotenv";
import logger from "./utils/logger.js";
import { ConfigService } from "./services/config-service.js";
import { CommandManager } from "./services/command-manager.js";
import { VoiceChannelManager } from "./services/voice-channel-manager.js";
import { VoiceChannelTracker } from "./services/voice-channel-tracker.js";
import { VoiceChannelAnnouncer } from "./services/voice-channel-announcer.js";
import { ChannelInitializer } from "./services/channel-initializer.js";

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

// Extend Client type to include commands collection
declare module "discord.js" {
  export interface Client {
    commands: Collection<
      string,
      {
        execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
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
  ],
});

// Add commands collection to client
client.commands = new Collection();

let isShuttingDown = false;

async function cleanupVoiceChannels(): Promise<void> {
  try {
    const configService = ConfigService.getInstance();

    // Check if voice channel management is enabled using new config keys
    const isEnabled =
      (await configService.getBoolean("voice_channel.enabled")) ||
      (await configService.getBoolean("ENABLE_VC_MANAGEMENT"));

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

const configService = ConfigService.getInstance();
const commandManager = CommandManager.getInstance(client);
const voiceChannelManager = VoiceChannelManager.getInstance(client);
const voiceChannelTracker = VoiceChannelTracker.getInstance(client);
const voiceChannelAnnouncer = VoiceChannelAnnouncer.getInstance(client);
const channelInitializer = ChannelInitializer.getInstance(client);

async function initializeServices(): Promise<void> {
  try {
    // Set client for services that need it
    configService.setClient(client);

    // Initialize services
    await configService.initialize();
    await configService.migrateFromEnv();
    await commandManager.registerCommands();
    await commandManager.populateClientCommands();

    // Get guild ID from config
    const guildId = await configService.getString("GUILD_ID", "");
    if (!guildId) {
      throw new Error("GUILD_ID not configured");
    }

    // Initialize voice channel services
    await voiceChannelManager.initialize(guildId);
    await voiceChannelAnnouncer.start();
    await channelInitializer.initializeChannels(
      await client.guilds.fetch(guildId),
    );

    logger.info("All services initialized successfully");
  } catch (error) {
    logger.error("Error initializing services:", error);
    process.exit(1);
  }
}

client.once(Events.ClientReady, async (readyClient) => {
  logger.info(`Ready! Logged in as ${readyClient.user.tag}`);
  await initializeServices();
});

client.on(Events.InteractionCreate, async (interaction) => {
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
        await refreshed.execute(interaction as ChatInputCommandInteraction);
        return;
      } catch (refreshError) {
        logger.error(
          "Error refreshing commands after missing command:",
          refreshError,
        );
        return;
      }
    }

    await command.execute(interaction as ChatInputCommandInteraction);
  } catch (error) {
    logger.error("Error handling command:", error);
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({
        content: "There was an error while executing this command!",
        ephemeral: true,
      });
    } else {
      await interaction.reply({
        content: "There was an error while executing this command!",
        ephemeral: true,
      });
    }
  }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try {
    await voiceChannelManager.handleVoiceStateUpdate(oldState, newState);
    await voiceChannelTracker.handleVoiceStateUpdate(oldState, newState);
  } catch (error) {
    logger.error("Error handling voice state update:", error);
  }
});

process.on("unhandledRejection", (error) => {
  logger.error("Unhandled promise rejection:", error);
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception:", error);
  process.exit(1);
});

client.login(process.env.DISCORD_TOKEN);
