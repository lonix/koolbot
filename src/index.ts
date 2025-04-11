import { Client, GatewayIntentBits, Interaction, VoiceState } from 'discord.js';
import { config } from 'dotenv';
import { Logger } from './utils/logger';
import { handleCommands } from './commands';
import mongoose from 'mongoose';
import { VoiceChannelManager } from './services/voice-channel-manager';
import { ChannelInitializer } from './services/channel-initializer';
import { CommandManager } from './services/command-manager';
import { VoiceChannelTracker } from './services/voice-channel-tracker';

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
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://mongodb:27017/koolbot');
    logger.info('Connected to MongoDB');
  } catch (error) {
    logger.error('Failed to connect to MongoDB:', error);
    throw error;
  }
}

async function cleanupDatabase(): Promise<void> {
  try {
    if (mongoose.connection.readyState === 1) {
      logger.info('Starting MongoDB cleanup...');
      await mongoose.disconnect();
      logger.info('MongoDB cleanup completed successfully');
    }
  } catch (error) {
    logger.error('Error during MongoDB cleanup:', error);
  }
}

async function cleanup() {
  try {
    logger.info('Cleaning up resources...');
    
    // Clean up voice channel manager
    VoiceChannelManager.getInstance().destroy();
    
    // Close MongoDB connection
    await mongoose.connection.close();
    logger.info('MongoDB connection closed');
    
    // Destroy Discord client
    client.destroy();
    logger.info('Discord client destroyed');
    
    process.exit(0);
  } catch (error) {
    logger.error('Error during cleanup:', error);
    process.exit(1);
  }
}

// Handle process termination
process.on('SIGTERM', async () => {
  if (!isShuttingDown) {
    isShuttingDown = true;
    logger.info('Received SIGTERM, shutting down...');
    await cleanup();
  }
});

process.on('SIGINT', async () => {
  if (!isShuttingDown) {
    isShuttingDown = true;
    logger.info('Received SIGINT, shutting down...');
    await cleanup();
  }
});

process.on('SIGQUIT', cleanup);
process.on('uncaughtException', (error: Error) => {
  logger.error('Uncaught Exception:', error);
  cleanup();
});
process.on('unhandledRejection', (error: Error) => {
  logger.error('Unhandled Rejection:', error);
  cleanup();
});

client.once('ready', async () => {
  try {
    logger.info('Bot is starting up...');
    
    // Initialize database first
    await initializeDatabase();
    logger.info('Database initialized');
    
    // Initialize channels
    const guild = await client.guilds.fetch(process.env.GUILD_ID || '');
    if (guild) {
      await ChannelInitializer.getInstance().initializeChannels(guild);
      logger.info('Channels initialized');
      
      // Initialize voice channel manager and clean up any empty channels
      if (process.env.ENABLE_VC_MANAGEMENT === 'true') {
        await VoiceChannelManager.getInstance(client).initialize(guild.id);
      }
    } else {
      logger.error('Guild not found, skipping channel initialization');
    }
    
    // Register commands
    await CommandManager.getInstance().registerCommands();
    logger.info('Commands registered');
    
    logger.info(`Bot is ready! Logged in as ${client.user?.tag}`);
  } catch (error) {
    logger.error('Failed to initialize bot:', error);
    await cleanup();
  }
});

client.on('interactionCreate', async (interaction: Interaction) => {
  if (interaction.isCommand()) {
    await handleCommands(interaction);
  }
});

client.on('voiceStateUpdate', async (oldState: VoiceState, newState: VoiceState) => {
  try {
    // Handle voice channel management
    if (process.env.ENABLE_VC_MANAGEMENT === 'true') {
      await VoiceChannelManager.getInstance().handleVoiceStateUpdate(oldState, newState);
    }

    // Handle voice channel tracking
    if (process.env.ENABLE_VC_TRACKING === 'true') {
      await VoiceChannelTracker.getInstance().handleVoiceStateUpdate(oldState, newState);
    }
  } catch (error) {
    logger.error('Error handling voice state update:', error);
  }
});

// Start the bot
client.login(process.env.DISCORD_TOKEN)
  .catch(error => {
    logger.error('Failed to login:', error);
    process.exit(1);
  });
