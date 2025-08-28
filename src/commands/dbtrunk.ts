import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { VoiceChannelTruncationService } from "../services/voice-channel-truncation.js";
import logger from "../utils/logger.js";

export const data = new SlashCommandBuilder()
  .setName("dbtrunk")
  .setDescription("Voice channel database cleanup management")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((subcommand) =>
    subcommand.setName("run").setDescription("Run cleanup immediately"),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("status").setDescription("Show cleanup service status"),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    const subcommand = interaction.options.getSubcommand();
    await handleSubcommand(interaction, subcommand);
  } catch (error) {
    logger.error("Error executing dbtrunk command:", error);
    await interaction.reply({
      content: "❌ An error occurred while executing the command.",
      ephemeral: true,
    });
  }
}

async function handleSubcommand(
  interaction: ChatInputCommandInteraction,
  subcommand: string,
): Promise<void> {
  const truncationService = VoiceChannelTruncationService.getInstance(
    interaction.client,
  );

  switch (subcommand) {
    case "run":
      await handleRun(interaction, truncationService);
      break;
    case "status":
      await handleStatus(interaction, truncationService);
      break;
    default:
      await interaction.reply({
        content: "Invalid dbtrunk subcommand.",
        ephemeral: true,
      });
  }
}

async function handleRun(
  interaction: ChatInputCommandInteraction,
  truncationService: VoiceChannelTruncationService,
): Promise<void> {
  try {
    await interaction.reply({
      content: "🔄 Running voice channel data cleanup...",
      ephemeral: true,
    });

    const stats = await truncationService.runCleanup();

    await interaction.editReply({
      content: `✅ Cleanup completed!\n\n**Results:**\n• Sessions removed: ${stats.sessionsRemoved}\n• Data aggregated: ${stats.dataAggregated}\n• Execution time: ${stats.executionTime}ms\n• Errors: ${stats.errors.length > 0 ? stats.errors.join(", ") : "None"}`,
    });
  } catch (error) {
    logger.error("Error during cleanup execution:", error);
    await interaction.editReply({
      content: `❌ Error during cleanup execution: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

async function handleStatus(
  interaction: ChatInputCommandInteraction,
  truncationService: VoiceChannelTruncationService,
): Promise<void> {
  try {
    const status = await truncationService.getStatus();

    const statusMessage = `**Voice Channel Cleanup Service Status**\n\n` +
      `🔄 **Service Status:** ${status.isRunning ? "Running" : "Stopped"}\n` +
      `🔌 **Database Connection:** ${status.isConnected ? "✅ Connected" : "❌ Disconnected"}\n` +
      `📅 **Last Cleanup:** ${status.lastCleanupDate ? status.lastCleanupDate.toLocaleString() : "Never"}`;

    await interaction.reply({
      content: statusMessage,
      ephemeral: true,
    });
  } catch (error) {
    logger.error("Error getting cleanup status:", error);
    await interaction.reply({
      content: `❌ Error getting cleanup status: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}
