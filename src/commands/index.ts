import { ChatInputCommandInteraction } from "discord.js";
import logger from "../utils/logger.js";
import { execute as ping } from "./ping.js";
import { execute as voicestats } from "./voicestats.js";
import { execute as seen } from "./seen.js";
import { execute as configCommand } from "./config.js";
import { execute as quoteCommand } from "./quote.js";
import { execute as achievementsCommand } from "./achievements.js";
import { execute as helpCommand } from "./help.js";
import { ConfigService } from "../services/config-service.js";

const configService = ConfigService.getInstance();

const commands: Record<
  string,
  ((interaction: ChatInputCommandInteraction) => Promise<void>) | undefined
> = {
  ping: async (interaction) => {
    if (await configService.getBoolean("ping.enabled", false)) {
      await ping(interaction);
    }
  },
  voicestats: async (interaction) => {
    if (await configService.getBoolean("voicetracking.enabled", false)) {
      await voicestats(interaction);
    }
  },
  seen: async (interaction) => {
    if (await configService.getBoolean("voicetracking.seen.enabled", false)) {
      await seen(interaction);
    }
  },
  config: async (interaction) => {
    await configCommand(interaction);
  },
  quote: async (interaction) => {
    if (await configService.getBoolean("quotes.enabled", false)) {
      await quoteCommand(interaction);
    }
  },
  achievements: async (interaction) => {
    if (await configService.getBoolean("achievements.enabled", false)) {
      await achievementsCommand(interaction);
    }
  },
  help: async (interaction) => {
    await helpCommand(interaction);
  },
};

export async function handleCommands(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.isCommand()) return;

  logger.debug(`Received command: ${interaction.commandName}`);

  const command = commands[interaction.commandName];
  if (command) {
    try {
      await command(interaction);
    } catch (error) {
      logger.error(
        `Error executing command ${interaction.commandName}:`,
        error,
      );
      await interaction.reply({
        content: "There was an error executing this command.",
        ephemeral: true,
      });
    }
  } else {
    logger.error(`Unknown command: ${interaction.commandName}`);
    await interaction.reply({ content: "🔒 Unknown command", ephemeral: true });
  }
}
