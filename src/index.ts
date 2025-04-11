import { Client, GatewayIntentBits, Interaction, VoiceState } from 'discord.js';
import { config } from 'dotenv';
import { Logger } from './utils/logger';
import { handleCommands } from './commands';
import mongoose from 'mongoose';
import { VoiceChannelManager } from './services/voice-channel-manager';
import { ChannelInitializer } from './services/channel-initializer';
import { CommandManager } from './services/command-manager';

config();
const logger = Logger.getInstance();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
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

async function cleanup(): Promise<void> {
  if (isShuttingDown) {
    logger.info('Cleanup already in progress, skipping...');
    return;
  }
  
  isShuttingDown = true;
  logger.info('Starting cleanup...');
  
  try {
    if (client.isReady()) {
      logger.info('Disconnecting from Discord...');
      await client.destroy();
      logger.info('Successfully disconnected from Discord');
    }

    await cleanupDatabase();
    logger.info('Cleanup completed successfully');
  } catch (error) {
    logger.error('Error during cleanup:', error);
  } finally {
    process.exit(0);
  }
}

// Handle process termination
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
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
    const guild = client.guilds.cache.get(process.env.GUILD_ID || '');
    if (guild) {
      await ChannelInitializer.getInstance().initializeChannels(guild);
      logger.info('Channels initialized');
    } else {
      logger.error('Guild not found, skipping channel initialization');
    }
    
    // Clean up and register commands
    const commandManager = CommandManager.getInstance();
    await commandManager.unregisterAllCommands();
    await commandManager.registerCommands();
    logger.info('Commands initialized');
    
    logger.info(`Bot is ready! Logged in as ${client.user?.tag}`);
  } catch (error) {
    logger.error('Failed to initialize bot:', error);
    await cleanup();
  }
});

client.on('interactionCreate', async (interaction: Interaction) => {
  try {
    if (!interaction.isCommand()) return;
    await handleCommands(interaction);
  } catch (error) {
    logger.error('Error handling interaction:', error);
    if (interaction.isCommand() && !interaction.replied) {
      await interaction.reply({ 
        content: 'An error occurred while executing this command.', 
        ephemeral: true 
      });
    }
  }
});

client.on('voiceStateUpdate', async (oldState: VoiceState, newState: VoiceState) => {
  if (process.env.ENABLE_VC_MANAGEMENT === 'true') {
    await VoiceChannelManager.getInstance().handleVoiceStateUpdate(oldState, newState);
  }
});

// Start the bot
client.login(process.env.DISCORD_TOKEN)
  .catch(error => {
    logger.error('Failed to login:', error);
    process.exit(1);
  });
