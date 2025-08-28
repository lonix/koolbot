import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { VoiceChannelManager } from "../services/voice-channel-manager.js";
import { ConfigService } from "../services/config-service.js";
import logger from "../utils/logger.js";

export const data = new SlashCommandBuilder()
  .setName("vc")
  .setDescription("Voice channel management")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((subcommand) =>
    subcommand.setName("reload").setDescription("Clean up empty voice channels"),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("force-reload").setDescription("Force cleanup of ALL unmanaged channels in category"),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    const subcommand = interaction.options.getSubcommand();
    await handleSubcommand(interaction, subcommand);
  } catch (error) {
    logger.error("Error executing vc command:", error);
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
  switch (subcommand) {
    case "reload":
      await handleReload(interaction);
      break;
    case "force-reload":
      await handleForceReload(interaction);
      break;
    default:
      await interaction.reply({
        content: "Invalid vc subcommand.",
        ephemeral: true,
      });
  }
}

async function handleReload(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    await interaction.reply({
      content: "🔄 Cleaning up empty voice channels...",
      ephemeral: true,
    });

    const voiceChannelManager = VoiceChannelManager.getInstance(interaction.client);
    await voiceChannelManager.cleanupEmptyChannels();

    await interaction.editReply({
      content: "✅ Voice channel cleanup completed!",
    });
  } catch (error) {
    logger.error("Error handling channel cleanup:", error);
    await interaction.editReply({
      content: `❌ Error during channel cleanup: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

async function handleForceReload(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    await interaction.reply({
      content: "⚠️ Force cleaning up ALL unmanaged channels in category...",
      ephemeral: true,
    });

    const voiceChannelManager = VoiceChannelManager.getInstance(interaction.client);

    // Get guild ID from config
    const configService = ConfigService.getInstance();
    const guildId = await configService.getString("GUILD_ID", "");

    if (!guildId) {
      await interaction.editReply({
        content: "❌ GUILD_ID not configured",
      });
      return;
    }

    const guild = await interaction.client.guilds.fetch(guildId);
    if (!guild) {
      await interaction.editReply({
        content: "❌ Guild not found",
      });
      return;
    }

    // Force cleanup
    await voiceChannelManager.cleanupEmptyChannels();

    // Ensure lobby channels exist
    await voiceChannelManager.ensureLobbyChannels(guild);

    await interaction.editReply({
      content: "✅ Force cleanup completed! All unmanaged channels removed and lobby channels ensured.",
    });
  } catch (error) {
    logger.error("Error handling force cleanup:", error);
    await interaction.editReply({
      content: `❌ Error during force cleanup: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}
