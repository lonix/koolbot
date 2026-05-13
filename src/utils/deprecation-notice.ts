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

  const embed = buildEmbed();

  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({
        embeds: [embed],
        flags: MessageFlags.Ephemeral,
      });
    } else {
      await interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (error) {
    logger.warn(
      `Failed to send deprecation notice for /${interaction.commandName}:`,
      error,
    );
  }
}
