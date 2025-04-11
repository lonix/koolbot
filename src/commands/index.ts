import { CommandInteraction } from 'discord.js';
import { Logger } from '../utils/logger';
import { execute as ping } from './ping';
import { execute as amikool } from './amikool';

const logger = Logger.getInstance();

const commands = {
  'ping': ping,
  'amikool': amikool,
};

export async function handleCommands(interaction: CommandInteraction): Promise<void> {
  if (!interaction.isCommand()) return;

  logger.debug(`Received command: ${interaction.commandName}`);

  const command = commands[interaction.commandName as keyof typeof commands];
  if (command) {
    await command(interaction);
  } else {
    logger.error(`Unknown command: ${interaction.commandName}`);
    await interaction.reply({ content: 'Unknown command', ephemeral: true });
  }
}
