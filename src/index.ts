import { Client, GatewayIntentBits, Interaction } from 'discord.js';
import { config } from 'dotenv';
import { Logger } from './utils/logger';
import { handleCommands } from './commands';
import { deployCommands } from './deploy-commands';
import mongoose, { Connection } from 'mongoose';

config();
const logger = Logger.getInstance();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
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
    // Check if we have an active connection
    if (mongoose.connection.readyState === 1) { // 1 = connected
      logger.info('Starting MongoDB cleanup...');
      
      // Close all connections in the connection pool
      const connections = mongoose.connections;
      for (const connection of connections) {
        if (connection.readyState === 1) { // 1 = connected
          logger.info(`Closing MongoDB connection: ${connection.name}`);
          await connection.close();
        }
      }

      // Ensure the main connection is closed
      if (mongoose.connection.readyState === 1) { // 1 = connected
        logger.info('Closing main MongoDB connection');
        await mongoose.disconnect();
      }

      logger.info('MongoDB cleanup completed successfully');
    }
  } catch (error) {
    logger.error('Error during MongoDB cleanup:', error);
    // Don't throw here, we want to continue with other cleanup tasks
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
    // Disconnect from Discord
    if (client.isReady()) {
      logger.info('Disconnecting from Discord...');
      await client.destroy();
      logger.info('Successfully disconnected from Discord');
    }

    // Cleanup MongoDB connections
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
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  cleanup();
});
process.on('unhandledRejection', (error) => {
  logger.error('Unhandled Rejection:', error);
  cleanup();
});

// Handle Docker stop
process.on('SIGTERM', () => {
  logger.info('Received SIGTERM signal, initiating cleanup...');
  cleanup();
});

client.on('ready', async () => {
  try {
    // Wait for both database connection and command deployment
    await Promise.all([
      initializeDatabase(),
      deployCommands()
    ]);

    // Only log ready after everything is set up
    logger.info(`Bot is ready! Logged in as ${client.user?.tag}`);
  } catch (error) {
    logger.error('Failed to initialize bot:', error);
    cleanup();
  }
});

client.on('interactionCreate', async (interaction: Interaction) => {
  if (!interaction.isCommand()) return;
  await handleCommands(interaction);
});

client.login(process.env.DISCORD_TOKEN);
