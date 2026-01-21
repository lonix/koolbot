import { ModalSubmitInteraction, EmbedBuilder } from "discord.js";
import logger from "../utils/logger.js";
import { WizardService } from "../services/wizard-service.js";

const wizardService = WizardService.getInstance();

export async function handleWizardModal(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  const customId = interaction.customId;

  // Parse custom ID: wizard_modal_{type}_{userId}_{guildId}
  const parts = customId.split("_");
  if (parts.length < 5 || parts[0] !== "wizard" || parts[1] !== "modal") {
    await interaction.reply({
      content: "❌ Invalid modal interaction.",
      ephemeral: true,
    });
    return;
  }

  const modalType = parts[2];
  const userId = parts[3];
  const guildId = parts[4];

  // Verify user owns this wizard session
  if (userId !== interaction.user.id) {
    await interaction.reply({
      content: "❌ This wizard session belongs to another user.",
      ephemeral: true,
    });
    return;
  }

  // Get wizard state
  const state = wizardService.getSession(userId, guildId);
  if (!state) {
    await interaction.reply({
      content:
        "❌ Wizard session expired. Please run `/setup wizard` again in the server.",
      ephemeral: true,
    });
    return;
  }

  // Get guild
  const guild = await interaction.client.guilds.fetch(guildId);
  if (!guild) {
    await interaction.reply({
      content: "❌ Could not find the server.",
      ephemeral: true,
    });
    return;
  }

  try {
    switch (modalType) {
      case "vc":
        await handleVcModal(interaction, guild, userId, guildId);
        break;
      case "vt":
        await handleVtModal(interaction, guild, userId, guildId);
        break;
      default:
        await interaction.reply({
          content: "❌ Unknown modal type.",
          ephemeral: true,
        });
    }
  } catch (error) {
    logger.error("Error handling wizard modal:", error);
    await interaction.reply({
      content: `❌ An error occurred: ${error instanceof Error ? error.message : "Unknown error"}`,
      ephemeral: true,
    });
  }
}

async function handleVcModal(
  interaction: ModalSubmitInteraction,
  guild: any,
  userId: string,
  guildId: string,
): Promise<void> {
  const categoryName = interaction.fields.getTextInputValue("category_name");
  const lobbyName = interaction.fields.getTextInputValue("lobby_name");
  const prefix = interaction.fields.getTextInputValue("channel_prefix") || "🎮";

  // Save configuration
  wizardService.addConfiguration(
    userId,
    guildId,
    "voicechannels.enabled",
    true,
  );
  wizardService.addConfiguration(
    userId,
    guildId,
    "voicechannels.category.name",
    categoryName,
  );
  wizardService.addConfiguration(
    userId,
    guildId,
    "voicechannels.lobby.name",
    lobbyName,
  );
  wizardService.addConfiguration(
    userId,
    guildId,
    "voicechannels.channel.prefix",
    prefix,
  );

  await interaction.deferUpdate();

  const embed = new EmbedBuilder()
    .setTitle("✅ Voice Channels Configured")
    .setDescription(
      `Voice channel system will be set up with:\n\n` +
        `**Category:** ${categoryName}\n` +
        `**Lobby:** ${lobbyName}\n` +
        `**Prefix:** ${prefix}`,
    )
    .setColor(0x00ff00);

  await interaction.followUp({ embeds: [embed], ephemeral: true });

  // Import helper to move to next feature
  const { moveToNextFeature } =
    await import("./wizard-button-handler-helpers.js");
  await moveToNextFeature(interaction.channel!, guild, userId, guildId);
}

async function handleVtModal(
  interaction: ModalSubmitInteraction,
  guild: any,
  userId: string,
  guildId: string,
): Promise<void> {
  const channelName = interaction.fields.getTextInputValue(
    "announcements_channel",
  );
  const schedule =
    interaction.fields.getTextInputValue("announcements_schedule") ||
    "0 16 * * 5";

  // Save configuration
  wizardService.addConfiguration(
    userId,
    guildId,
    "voicetracking.enabled",
    true,
  );
  wizardService.addConfiguration(
    userId,
    guildId,
    "voicetracking.seen.enabled",
    true,
  );
  wizardService.addConfiguration(
    userId,
    guildId,
    "voicetracking.announcements.enabled",
    true,
  );
  wizardService.addConfiguration(
    userId,
    guildId,
    "voicetracking.announcements.channel",
    channelName,
  );
  wizardService.addConfiguration(
    userId,
    guildId,
    "voicetracking.announcements.schedule",
    schedule,
  );

  await interaction.deferUpdate();

  const embed = new EmbedBuilder()
    .setTitle("✅ Voice Tracking Configured")
    .setDescription(
      `Voice tracking will be enabled with:\n\n` +
        `**Announcements Channel:** ${channelName}\n` +
        `**Schedule:** ${schedule}\n` +
        `**Last Seen Tracking:** Enabled`,
    )
    .setColor(0x00ff00);

  await interaction.followUp({ embeds: [embed], ephemeral: true });

  // Import helper to move to next feature
  const { moveToNextFeature } =
    await import("./wizard-button-handler-helpers.js");
  await moveToNextFeature(interaction.channel!, guild, userId, guildId);
}
