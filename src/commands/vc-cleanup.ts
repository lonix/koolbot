import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import logger from "../utils/logger.js";
import { VoiceChannelTruncationService } from "../services/voice-channel-truncation.js";

export const data = new SlashCommandBuilder()
  .setName("vc-cleanup")
  .setDescription("Voice channel cleanup management")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((subcommand) =>
    subcommand.setName("run").setDescription("Run cleanup immediately"),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("status").setDescription("Show cleanup service status"),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("config").setDescription("View cleanup configuration"),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    const subcommand = interaction.options.getSubcommand();

    await handleCleanupSubcommand(interaction, subcommand);
  } catch (error) {
    logger.error("Error in vc-cleanup command:", error);
    await interaction.reply({
      content: "There was an error while executing this command!",
      ephemeral: true,
    });
  }
}

async function handleCleanupSubcommand(
  interaction: ChatInputCommandInteraction,
  subcommand: string,
): Promise<void> {
  const truncationService = VoiceChannelTruncationService.getInstance(
    interaction.client,
  );

  switch (subcommand) {
    case "run":
      await handleCleanupRun(interaction, truncationService);
      break;
    case "status":
      await handleCleanupStatus(interaction, truncationService);
      break;
    case "config":
      await handleCleanupConfig(interaction, truncationService);
      break;
    default:
      await interaction.reply({
        content: "Invalid cleanup subcommand.",
        ephemeral: true,
      });
  }
}

async function handleCleanupRun(
  interaction: ChatInputCommandInteraction,
  truncationService: VoiceChannelTruncationService,
): Promise<void> {
  try {
    // Check if cleanup is enabled
    const isEnabled = await truncationService.isEnabled();
    if (!isEnabled) {
      await interaction.reply({
        content:
          "❌ Voice tracking cleanup is currently disabled. Enable it in the configuration first.",
        ephemeral: true,
      });
      return;
    }

    // Check if cleanup is already running
    const status = truncationService.getStatus();
    if (status.isRunning) {
      await interaction.reply({
        content:
          "⚠️ Cleanup is already running. Please wait for it to complete.",
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      content:
        "🔄 Starting voice channel cleanup... This may take a few minutes.",
      ephemeral: true,
    });

    // Run cleanup in background
    truncationService
      .runCleanup()
      .then(async (stats) => {
        // Results are automatically logged to Discord via DiscordLogger
        logger.info(
          `Cleanup completed: ${stats.sessionsRemoved} sessions removed, ${stats.dataAggregated} users processed`,
        );

        // Update the original interaction with results
        const resultMessage =
          stats.errors.length > 0
            ? `❌ Cleanup completed with errors:\n${stats.errors.join("\n")}`
            : `✅ Cleanup completed successfully!\n📊 Sessions removed: ${stats.sessionsRemoved}\n⏱️ Execution time: ${stats.executionTime}ms`;

        await interaction.editReply({
          content: resultMessage,
        });
      })
      .catch(async (error) => {
        logger.error("Error during cleanup execution:", error);
        await interaction.editReply({
          content: `❌ Cleanup failed: ${error.message}`,
        });
      });
  } catch (error) {
    logger.error("Error handling cleanup run:", error);
    await interaction.editReply({
      content: `❌ Error starting cleanup: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

async function handleCleanupStatus(
  interaction: ChatInputCommandInteraction,
  truncationService: VoiceChannelTruncationService,
): Promise<void> {
  try {
    const status = truncationService.getStatus();
    const isEnabled = await truncationService.isEnabled();
    const notificationChannel =
      await truncationService.getNotificationChannel();
    const schedule = await truncationService.getSchedule();

    const statusEmbed = {
      color: status.isRunning ? 0xffa500 : isEnabled ? 0x00ff00 : 0xff0000,
      title: "🎙️ Voice Tracking Cleanup Status",
      fields: [
        {
          name: "Status",
          value: status.isRunning
            ? "🔄 Running"
            : isEnabled
              ? "✅ Enabled"
              : "❌ Disabled",
          inline: true,
        },
        {
          name: "Database Connection",
          value: status.isConnected ? "✅ Connected" : "❌ Disconnected",
          inline: true,
        },
        {
          name: "Last Cleanup",
          value: status.lastCleanupDate
            ? status.lastCleanupDate.toLocaleString()
            : "Never",
          inline: true,
        },
        {
          name: "Schedule",
          value: schedule || "Not configured",
          inline: true,
        },
        {
          name: "Notification Channel",
          value: notificationChannel
            ? `<#${notificationChannel}>`
            : "Not configured",
          inline: true,
        },
      ],
      timestamp: new Date().toISOString(),
      footer: {
        text: "Voice Tracking Cleanup Service",
      },
    };

    await interaction.reply({ embeds: [statusEmbed] });
  } catch (error) {
    logger.error("Error handling cleanup status:", error);
    await interaction.reply({
      content: "There was an error while getting the cleanup status!",
      ephemeral: true,
    });
  }
}

async function handleCleanupConfig(
  interaction: ChatInputCommandInteraction,
  truncationService: VoiceChannelTruncationService,
): Promise<void> {
  try {
    const isEnabled = await truncationService.isEnabled();
    const notificationChannel =
      await truncationService.getNotificationChannel();
    const schedule = await truncationService.getSchedule();

    const configEmbed = {
      color: isEnabled ? 0x00ff00 : 0xff0000,
      title: "⚙️ Voice Tracking Cleanup Configuration",
      description: "Current configuration settings for the cleanup service.",
      fields: [
        {
          name: "🔄 Service Status",
          value: isEnabled ? "✅ Enabled" : "❌ Disabled",
          inline: true,
        },
        {
          name: "⏰ Schedule",
          value: schedule || "Not configured",
          inline: true,
        },
        {
          name: "📢 Notification Channel",
          value: notificationChannel
            ? `<#${notificationChannel}>`
            : "Not configured",
          inline: true,
        },
        {
          name: "📋 Configuration Note",
          value:
            "Retention settings are currently using default values and will be configurable in a future update.",
          inline: false,
        },
      ],
      timestamp: new Date().toISOString(),
      footer: {
        text: "Voice Tracking Cleanup Service",
      },
    };

    await interaction.reply({ embeds: [configEmbed] });
  } catch (error) {
    logger.error("Error handling cleanup config:", error);
    await interaction.reply({
      content: "There was an error while getting the cleanup configuration!",
      ephemeral: true,
    });
  }
}
