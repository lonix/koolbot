import {
  CommandInteraction,
  InteractionReplyOptions,
  MessagePayload,
} from "discord.js";
import Logger from "../utils/logger.js";
import { execute as ping } from "./ping.js";
import { execute as amikool } from "./amikool.js";
import { execute as plexprice } from "./plexprice.js";
import { execute as vctop } from "./vctop.js";
import { execute as vcstats } from "./vcstats.js";
import { execute as seen } from "./seen.js";
import { execute as transferOwnership } from "./transfer-ownership.js";

const logger = Logger.getInstance();

const commands = {
  ping: process.env.ENABLE_PING === "true" ? ping : undefined,
  amikool: process.env.ENABLE_AMIKOOL === "true" ? amikool : undefined,
  plexprice: process.env.ENABLE_PLEXPRICE === "true" ? plexprice : undefined,
  vctop: process.env.ENABLE_VC_TRACKING === "true" ? vctop : undefined,
  vcstats: process.env.ENABLE_VC_TRACKING === "true" ? vcstats : undefined,
  seen: process.env.ENABLE_SEEN === "true" ? seen : undefined,
  "transfer-ownership":
    process.env.ENABLE_VC_MANAGEMENT === "true" ? transferOwnership : undefined,
};

// Create a wrapper for the interaction that makes replies ephemeral by default
function createEphemeralInteraction(
  interaction: CommandInteraction,
): CommandInteraction {
  return {
    ...interaction,
    reply: async function (
      options: string | MessagePayload | InteractionReplyOptions,
    ) {
      if (typeof options === "string") {
        options = { content: options };
      }
      if (
        typeof options === "object" &&
        "ephemeral" in options &&
        options.ephemeral === undefined
      ) {
        options.ephemeral = true;
        // Add a small indicator that the message is ephemeral
        if (typeof options.content === "string") {
          options.content = `🔒 ${options.content}`;
        }
      }
      return interaction.reply(options);
    },
  } as CommandInteraction;
}

export async function handleCommands(
  interaction: CommandInteraction,
): Promise<void> {
  if (!interaction.isCommand()) return;

  logger.debug(`Received command: ${interaction.commandName}`);

  const command = commands[interaction.commandName as keyof typeof commands];
  if (command) {
    // Create an ephemeral version of the interaction
    const ephemeralInteraction = createEphemeralInteraction(interaction);
    await command(ephemeralInteraction);
  } else {
    logger.error(`Unknown command: ${interaction.commandName}`);
    await interaction.reply({ content: "🔒 Unknown command", ephemeral: true });
  }
}
