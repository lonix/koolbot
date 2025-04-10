import { Client, GatewayIntentBits, Interaction } from 'discord.js';
import { config } from 'dotenv';
import { Logger } from './utils/logger';
import { handleCommands } from './commands';
import { deployCommands } from './deploy-commands';
import mongoose from 'mongoose';

config();
const logger = Logger.getInstance();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

async function initializeDatabase(): Promise<void> {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://mongodb:27017/koolbot');
    logger.info('Connected to MongoDB');
  } catch (error) {
    logger.error('Failed to connect to MongoDB:', error);
    throw error;
  }
}

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
    process.exit(1);
  }
});

client.on('interactionCreate', async (interaction: Interaction) => {
  if (!interaction.isCommand()) return;
  await handleCommands(interaction);
});

client.login(process.env.DISCORD_TOKEN);
