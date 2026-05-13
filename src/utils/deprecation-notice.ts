import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
} from "discord.js";
import logger from "./logger.js";

const DEPRECATED_TOP_LEVEL_COMMANDS = new Set([
  "permissions",
  "setup",
  "announce",
  "announce-vc-stats",
  "poll",
  "reactrole",
  "notice",
  "dbtrunk",
  "vc",
  "botstats",
]);

const CONFIG_LAUNCHER_SUBCOMMAND = "web";

const DEPRECATION_TITLE = "Slash command deprecated";
const DEPRECATION_DESCRIPTION =
  "This command is deprecated and will be removed in 1.0. Run `/config` for the WebUI.";

export function isDeprecatedSlashCommand(
  commandName: string,
  subcommand: string | null,
): boolean {
  if (DEPRECATED_TOP_LEVEL_COMMANDS.has(commandName)) {
    return true;
  }
  if (commandName === "config") {
    return subcommand !== null && subcommand !== CONFIG_LAUNCHER_SUBCOMMAND;
  }
  return false;
}

function getInvocationSubcommand(
  interaction: ChatInputCommandInteraction,
): string | null {
  try {
    return interaction.options.getSubcommand(false);
  } catch {
    return null;
  }
}

export function shouldEmitDeprecationNotice(
  interaction: ChatInputCommandInteraction,
): boolean {
  return isDeprecatedSlashCommand(
    interaction.commandName,
    getInvocationSubcommand(interaction),
  );
}

function buildEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(DEPRECATION_TITLE)
    .setDescription(DEPRECATION_DESCRIPTION)
    .setColor(0xf1c40f);
}

export async function sendDeprecationNotice(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!shouldEmitDeprecationNotice(interaction)) {
    return;
  }

  // Only emit as a follow-up so we never consume the initial reply slot.
  // If the command threw before replying/deferring, the global error
  // handler in src/index.ts will produce the user-facing reply; sending a
  // deprecation embed there would just be overwritten by editReply.
  if (!interaction.replied && !interaction.deferred) {
    return;
  }

  try {
    await interaction.followUp({
      embeds: [buildEmbed()],
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    logger.warn(
      `Failed to send deprecation notice for /${interaction.commandName}:`,
      error,
    );
  }
}
