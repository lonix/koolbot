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

const logger = Logger.getInstance();

const commands: Record<
  string,
  ((interaction: ChatInputCommandInteraction) => Promise<void>) | undefined
> = {
  ping: process.env.ENABLE_PING === "true" ? ping : undefined,
  amikool: process.env.ENABLE_AMIKOOL === "true" ? amikool : undefined,
  plexprice: process.env.ENABLE_PLEXPRICE === "true" ? plexprice : undefined,
  vctop: process.env.ENABLE_VC_TRACKING === "true" ? vctop : undefined,
  vcstats: process.env.ENABLE_VC_TRACKING === "true" ? vcstats : undefined,
  seen,
  "transfer-ownership":
    process.env.ENABLE_VC_MANAGEMENT === "true" ? transferOwnership : undefined,
  "announce-vc-stats":
    process.env.ENABLE_VC_WEEKLY_ANNOUNCEMENT === "true"
      ? announceVcStats
      : undefined,
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
