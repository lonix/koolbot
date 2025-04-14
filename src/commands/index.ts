import { CommandInteraction } from "discord.js";
import Logger from "../utils/logger.js";
import { execute as ping } from "./ping.js";
import { execute as amikool } from "./amikool.js";
import { execute as plexprice } from "./plexprice.js";
import { execute as vctop } from "./vctop.js";
import { execute as vcstats } from "./vcstats.js";
import { execute as seen } from "./seen.js";

const logger = Logger.getInstance();

const commands = {
  ping: process.env.ENABLE_PING === "true" ? ping : undefined,
  amikool: process.env.ENABLE_AMIKOOL === "true" ? amikool : undefined,
  plexprice: process.env.ENABLE_PLEXPRICE === "true" ? plexprice : undefined,
  vctop: process.env.ENABLE_VC_TRACKING === "true" ? vctop : undefined,
  vcstats: process.env.ENABLE_VC_TRACKING === "true" ? vcstats : undefined,
  seen: process.env.ENABLE_SEEN === "true" ? seen : undefined,
};

export async function handleCommands(
  interaction: CommandInteraction,
): Promise<void> {
  if (!interaction.isCommand()) return;

  logger.debug(`Received command: ${interaction.commandName}`);

  const command = commands[interaction.commandName as keyof typeof commands];
  if (command) {
    await command(interaction);
  } else {
    logger.error(`Unknown command: ${interaction.commandName}`);
    await interaction.reply({ content: "Unknown command", ephemeral: true });
  }
}
