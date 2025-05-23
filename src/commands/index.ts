import { ChatInputCommandInteraction } from "discord.js";
import Logger from "../utils/logger.js";
import { execute as ping } from "./ping.js";
import { execute as amikool } from "./amikool.js";
import { execute as plexprice } from "./plexprice.js";
import { execute as vctop } from "./vctop.js";
import { execute as vcstats } from "./vcstats.js";
import { execute as seen } from "./seen.js";
import { execute as transferOwnership } from "./transfer-ownership.js";
import { execute as announceVcStats } from "./announce-vc-stats.js";
import { execute as config } from "./config/index.js";
import { execute as quote } from "./quote.js";
import { ConfigService } from "../services/config-service.js";

const logger = Logger.getInstance();
const configService = ConfigService.getInstance();

const commands: Record<
  string,
  ((interaction: ChatInputCommandInteraction) => Promise<void>) | undefined
> = {
  ping: async (interaction) => {
    if (await configService.get("ENABLE_PING")) {
      await ping(interaction);
    }
  },
  amikool: async (interaction) => {
    if (await configService.get("ENABLE_AMIKOOL")) {
      await amikool(interaction);
    }
  },
  plexprice: async (interaction) => {
    if (await configService.get("ENABLE_PLEX_PRICE")) {
      await plexprice(interaction);
    }
  },
  vctop: async (interaction) => {
    if (await configService.get("ENABLE_VC_TRACKING")) {
      await vctop(interaction);
    }
  },
  vcstats: async (interaction) => {
    if (await configService.get("ENABLE_VC_TRACKING")) {
      await vcstats(interaction);
    }
  },
  seen: async (interaction) => {
    if (await configService.get("ENABLE_SEEN")) {
      await seen(interaction);
    }
  },
  config,
  "transfer-ownership": async (interaction) => {
    if (await configService.get("ENABLE_VC_MANAGEMENT")) {
      await transferOwnership(interaction);
    }
  },
  "announce-vc-stats": async (interaction) => {
    if (await configService.get("ENABLE_VC_WEEKLY_ANNOUNCEMENT")) {
      await announceVcStats(interaction);
    }
  },
  quote: async (interaction) => {
    if (await configService.get("quotes.enabled")) {
      await quote(interaction);
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
