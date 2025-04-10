import { Client, GatewayIntentBits, Partials } from 'discord.js';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { Logger } from './utils/logger';
import { handleCommands } from './commands';

dotenv.config();

const logger = Logger.getInstance();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Message, Partials.Channel]
});

client.once('ready', async () => {
  logger.info(`Logged in as ${client.user?.tag}`);

  // Connect to MongoDB
  try {
    await mongoose.connect('mongodb://mongodb:27017/koolbot');
    logger.info('Connected to MongoDB');
  } catch (error) {
    logger.error('Failed to connect to MongoDB:', error);
    process.exit(1);
  }

  // Set up log channel if specified
  if (process.env.BOT_LOGS_CHANNEL_ID) {
    await logger.setLogChannel(client, process.env.BOT_LOGS_CHANNEL_ID);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;

  try {
    await handleCommands(interaction);
  } catch (error) {
    logger.error('Error handling command:', error);
    if (!interaction.replied) {
      await interaction.reply({ content: 'There was an error executing this command!', ephemeral: true });
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
