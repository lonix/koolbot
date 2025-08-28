import { ChatInputCommandInteraction } from "discord.js";
import logger from "../utils/logger.js";
import { execute as ping } from "./ping.js";
import { execute as amikool } from "./amikool.js";
import { execute as plexprice } from "./plexprice.js";
import { execute as vctop } from "./vctop.js";
import { execute as vcstats } from "./vcstats.js";
import { execute as seen } from "./seen.js";
import { execute as transferOwnership } from "./transfer-ownership.js";
import { execute as announceVcStats } from "./announce-vc-stats.js";
import { execute as configCommand } from "./config/index.js";
import { execute as quoteCommand } from "./quote.js";
import { execute as excludeChannel } from "./exclude-channel.js";
import { command as setupLobbyCommand } from "./setup-lobby.js";
import { execute as vcCleanupCommand } from "./voice-tracking.js";
import { ConfigService } from "../services/config-service.js";

const configService = ConfigService.getInstance();

const commands: Record<
  string,
  ((interaction: ChatInputCommandInteraction) => Promise<void>) | undefined
> = {
  ping: async (interaction) => {
    if (await configService.get("ping.enabled")) {
      await ping(interaction);
    }
  },
  amikool: async (interaction) => {
    if (await configService.get("amikool.enabled")) {
      await amikool(interaction);
    }
  },
  plexprice: async (interaction) => {
    if (await configService.get("plexprice.enabled")) {
      await plexprice(interaction);
    }
  },
  vctop: async (interaction) => {
    if (await configService.get("voicetracking.enabled")) {
      await vctop(interaction);
    }
  },
  vcstats: async (interaction) => {
    if (await configService.get("voicetracking.enabled")) {
      await vcstats(interaction);
    }
  },
  seen: async (interaction) => {
    if (await configService.get("voicetracking.seen.enabled")) {
      await seen(interaction);
    }
  },
  config: async (interaction) => {
    await configCommand(interaction);
  },
  "transfer-ownership": async (interaction) => {
    if (await configService.get("voicechannels.enabled")) {
      await transferOwnership(interaction);
    }
  },
  "announce-vc-stats": async (interaction) => {
    if (await configService.get("voicetracking.announcements.enabled")) {
      await announceVcStats(interaction);
    }
  },
  quote: async (interaction) => {
    if (await configService.get("quotes.enabled")) {
      await quoteCommand(interaction);
    }
  },
  "exclude-channel": async (interaction) => {
    await excludeChannel(interaction);
  },
  "setup-lobby": async (interaction) => {
    await setupLobbyCommand.execute(interaction);
  },
  "vc-cleanup": async (interaction) => {
    if (await configService.get("voicetracking.enabled")) {
      await vcCleanupCommand(interaction);
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
