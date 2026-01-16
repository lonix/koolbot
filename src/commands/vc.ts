import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { VoiceChannelManager } from "../services/voice-channel-manager.js";
import { ConfigService } from "../services/config-service.js";
import { UserVoicePreferences } from "../models/user-voice-preferences.js";
import logger from "../utils/logger.js";

export const data = new SlashCommandBuilder()
  .setName("vc")
  .setDescription("Voice channel management")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("reload")
      .setDescription("Clean up empty voice channels"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("force-reload")
      .setDescription("Force cleanup of ALL unmanaged channels in category"),
  )
  .addSubcommandGroup((group) =>
    group
      .setName("customize")
      .setDescription("Customize your voice channel settings")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("name")
          .setDescription("Set custom channel naming pattern")
          .addStringOption((option) =>
            option
              .setName("pattern")
              .setDescription(
                'Pattern for channel name (use {username} as placeholder, e.g., "🎮 {username}\'s Room")',
              )
              .setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("limit")
          .setDescription("Set user limit for your voice channel")
          .addIntegerOption((option) =>
            option
              .setName("number")
              .setDescription("Number of users allowed (0 for unlimited)")
              .setRequired(true)
              .setMinValue(0)
              .setMaxValue(99),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("bitrate")
          .setDescription("Set audio quality for your voice channel")
          .addIntegerOption((option) =>
            option
              .setName("kbps")
              .setDescription("Bitrate in kbps (8-96 recommended, max 384 with boost)")
              .setRequired(true)
              .setMinValue(8)
              .setMaxValue(384),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("reset")
          .setDescription("Reset all your voice channel customizations"),
      ),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    const subcommandGroup = interaction.options.getSubcommandGroup();
    const subcommand = interaction.options.getSubcommand();

    if (subcommandGroup === "customize") {
      await handleCustomize(interaction, subcommand);
    } else {
      await handleSubcommand(interaction, subcommand);
    }
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

    const voiceChannelManager = VoiceChannelManager.getInstance(
      interaction.client,
    );
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

    const voiceChannelManager = VoiceChannelManager.getInstance(
      interaction.client,
    );

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

    // Force cleanup and ensure lobby channels exist
    await voiceChannelManager.ensureLobbyChannels(guild);

    await interaction.editReply({
      content:
        "✅ Force cleanup completed! All unmanaged channels removed and lobby channels ensured.",
    });
  } catch (error) {
    logger.error("Error handling force cleanup:", error);
    await interaction.editReply({
      content: `❌ Error during force cleanup: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

async function handleCustomize(
  interaction: ChatInputCommandInteraction,
  subcommand: string,
): Promise<void> {
  const userId = interaction.user.id;

  try {
    switch (subcommand) {
      case "name":
        await handleCustomizeName(interaction, userId);
        break;
      case "limit":
        await handleCustomizeLimit(interaction, userId);
        break;
      case "bitrate":
        await handleCustomizeBitrate(interaction, userId);
        break;
      case "reset":
        await handleCustomizeReset(interaction, userId);
        break;
      default:
        await interaction.reply({
          content: "❌ Invalid customize subcommand.",
          ephemeral: true,
        });
    }
  } catch (error) {
    logger.error("Error handling vc customize:", error);
    await interaction.reply({
      content: "❌ An error occurred while customizing your voice channel settings.",
      ephemeral: true,
    });
  }
}

async function handleCustomizeName(
  interaction: ChatInputCommandInteraction,
  userId: string,
): Promise<void> {
  const pattern = interaction.options.getString("pattern", true);

  // Validate pattern contains {username} placeholder
  if (!pattern.includes("{username}")) {
    await interaction.reply({
      content:
        '❌ Name pattern must include {username} placeholder. Example: "🎮 {username}\'s Room"',
      ephemeral: true,
    });
    return;
  }

  // Validate pattern length (Discord channel name limit is 100 characters)
  const testName = pattern.replace("{username}", "A".repeat(32)); // Max Discord username length
  if (testName.length > 100) {
    await interaction.reply({
      content:
        "❌ Name pattern is too long. It must be less than 100 characters when username is applied.",
      ephemeral: true,
    });
    return;
  }

  try {
    await UserVoicePreferences.findOneAndUpdate(
      { userId },
      { namePattern: pattern },
      { upsert: true, new: true },
    );

    await interaction.reply({
      content: `✅ Your channel name pattern has been set to: **${pattern}**\n\nExample: ${pattern.replace("{username}", interaction.user.username)}`,
      ephemeral: true,
    });
  } catch (error) {
    logger.error("Error saving name pattern:", error);
    await interaction.reply({
      content: "❌ Failed to save name pattern. Please try again.",
      ephemeral: true,
    });
  }
}

async function handleCustomizeLimit(
  interaction: ChatInputCommandInteraction,
  userId: string,
): Promise<void> {
  const limit = interaction.options.getInteger("number", true);

  try {
    await UserVoicePreferences.findOneAndUpdate(
      { userId },
      { userLimit: limit },
      { upsert: true, new: true },
    );

    const limitText = limit === 0 ? "unlimited" : `${limit} users`;
    await interaction.reply({
      content: `✅ Your channel user limit has been set to: **${limitText}**`,
      ephemeral: true,
    });
  } catch (error) {
    logger.error("Error saving user limit:", error);
    await interaction.reply({
      content: "❌ Failed to save user limit. Please try again.",
      ephemeral: true,
    });
  }
}

async function handleCustomizeBitrate(
  interaction: ChatInputCommandInteraction,
  userId: string,
): Promise<void> {
  const bitrate = interaction.options.getInteger("kbps", true);

  try {
    await UserVoicePreferences.findOneAndUpdate(
      { userId },
      { bitrate },
      { upsert: true, new: true },
    );

    await interaction.reply({
      content: `✅ Your channel bitrate has been set to: **${bitrate} kbps**\n\nNote: Higher bitrates may require server boosts and will be capped at the server's maximum.`,
      ephemeral: true,
    });
  } catch (error) {
    logger.error("Error saving bitrate:", error);
    await interaction.reply({
      content: "❌ Failed to save bitrate. Please try again.",
      ephemeral: true,
    });
  }
}

async function handleCustomizeReset(
  interaction: ChatInputCommandInteraction,
  userId: string,
): Promise<void> {
  try {
    const result = await UserVoicePreferences.findOneAndDelete({ userId });

    if (result) {
      await interaction.reply({
        content:
          "✅ All your voice channel customizations have been reset to defaults.",
        ephemeral: true,
      });
    } else {
      await interaction.reply({
        content: "ℹ️ You don't have any customizations set.",
        ephemeral: true,
      });
    }
  } catch (error) {
    logger.error("Error resetting preferences:", error);
    await interaction.reply({
      content: "❌ Failed to reset preferences. Please try again.",
      ephemeral: true,
    });
  }
}
