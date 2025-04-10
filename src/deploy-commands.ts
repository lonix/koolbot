import { REST, Routes } from 'discord.js';
import { config } from 'dotenv';
import { Logger } from './utils/logger';

config();
const logger = Logger.getInstance();

const commands = [
  {
    name: 'ping',
    description: 'Replies with Pong!',
  },
  {
    name: 'amikool',
    description: 'Check if you are kool',
  },
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN!);

export async function deployCommands(): Promise<void> {
  try {
    // First, remove all existing commands
    logger.info('Removing all existing commands...');
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID!),
      { body: [] },
    );
    logger.info('Successfully removed all existing commands.');

    // Then register our commands
    logger.info('Registering new commands...');
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID!),
      { body: commands },
    );
    logger.info('Successfully registered new commands.');
  } catch (error) {
    logger.error('Error during command deployment:', error);
    throw error;
  }
}
