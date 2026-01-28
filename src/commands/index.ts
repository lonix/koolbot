import { ChatInputCommandInteraction } from "discord.js";
import logger from "../utils/logger.js";
import { execute as ping } from "./ping.js";
import { execute as amikool } from "./amikool.js";
import { execute as vctop } from "./vctop.js";
import { execute as vcstats } from "./vcstats.js";
import { execute as seen } from "./seen.js";
import { execute as announceVcStats } from "./announce-vc-stats.js";
import { execute as configCommand } from "./config/index.js";
import { execute as quoteCommand } from "./quote.js";
import { execute as setupLobbyCommand } from "./setup-lobby.js";
import { execute as dbtrunkCommand } from "./dbtrunk.js";
import { execute as vcCommand } from "./vc.js";
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
  amikool: async (interaction) => {
    if (await configService.getBoolean("amikool.enabled", false)) {
      await amikool(interaction);
    }
  },
  vctop: async (interaction) => {
    if (await configService.getBoolean("voicetracking.enabled", false)) {
      await vctop(interaction);
    }
  },
  vcstats: async (interaction) => {
    if (await configService.getBoolean("voicetracking.enabled", false)) {
      await vcstats(interaction);
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
  "announce-vc-stats": async (interaction) => {
    if (
      await configService.getBoolean(
        "voicetracking.announcements.enabled",
        false,
      )
    ) {
      await announceVcStats(interaction);
    }
  },
  quote: async (interaction) => {
    if (await configService.getBoolean("quotes.enabled", false)) {
      await quoteCommand(interaction);
    }
  },

  "setup-lobby": async (interaction) => {
    await setupLobbyCommand(interaction);
  },
  dbtrunk: async (interaction) => {
    await dbtrunkCommand(interaction);
  },
  vc: async (interaction) => {
    if (await configService.getBoolean("voicechannels.enabled", false)) {
      await vcCommand(interaction);
    }
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
