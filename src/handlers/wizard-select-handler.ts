import { StringSelectMenuInteraction, EmbedBuilder } from "discord.js";
import logger from "../utils/logger.js";
import { WizardService } from "../services/wizard-service.js";

const wizardService = WizardService.getInstance();

export async function handleWizardSelectMenu(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const customId = interaction.customId;

  // Parse custom ID: wizard_{action}__{userId}_{guildId}
  // Extract the parts after "wizard_"
  if (!customId.startsWith("wizard_")) {
    await interaction.reply({
      content: "❌ Invalid select menu interaction.",
      ephemeral: true,
    });
    return;
  }

  const afterWizard = customId.substring(7); // Remove "wizard_"
  const doubleSplit = afterWizard.split("__");

  if (doubleSplit.length !== 2) {
    await interaction.reply({
      content: "❌ Invalid select menu interaction format.",
      ephemeral: true,
    });
    return;
  }

  const action = doubleSplit[0];
  const userGuildParts = doubleSplit[1].split("_");

  if (userGuildParts.length < 2) {
    await interaction.reply({
      content: "❌ Invalid select menu interaction format.",
      ephemeral: true,
    });
    return;
  }

  const userId = userGuildParts[0];
  const guildId = userGuildParts[1];
  const selectType = action;

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
    switch (selectType) {
      case "features":
        await handleFeatureSelection(interaction, guild, userId, guildId);
        break;
      case "select_vc_category":
        await handleVcCategorySelection(interaction, guild, userId, guildId);
        break;
      case "select_quotes_channel":
        await handleQuotesChannelSelection(interaction, guild, userId, guildId);
        break;
      case "select_logging_channel":
        await handleLoggingChannelSelection(
          interaction,
          guild,
          userId,
          guildId,
        );
        break;
      default:
        await interaction.reply({
          content: "❌ Unknown select menu type.",
          ephemeral: true,
        });
    }
  } catch (error) {
    logger.error("Error handling wizard select menu:", error);
    await interaction.reply({
      content: `❌ An error occurred: ${error instanceof Error ? error.message : "Unknown error"}`,
      ephemeral: true,
    });
  }
}

async function handleFeatureSelection(
  interaction: StringSelectMenuInteraction,
  guild: any,
  userId: string,
  guildId: string,
): Promise<void> {
  const selectedFeatures = interaction.values;

  // Update wizard state with selected features
  const state = wizardService.getSession(userId, guildId);
  if (!state) return;

  state.selectedFeatures = selectedFeatures;
  wizardService.updateSession(userId, guildId, state);

  await interaction.deferUpdate();

  const embed = new EmbedBuilder()
    .setTitle("✅ Features Selected")
    .setDescription(
      `You've selected ${selectedFeatures.length} feature(s):\n` +
        selectedFeatures.map((f) => `• ${f}`).join("\n") +
        "\n\nClick 'Continue' to start configuration.",
    )
    .setColor(0x00ff00);

  await interaction.followUp({ embeds: [embed], ephemeral: true });
}

async function handleVcCategorySelection(
  interaction: StringSelectMenuInteraction,
  guild: any,
  userId: string,
  guildId: string,
): Promise<void> {
  const selectedCategoryId = interaction.values[0];

  const category = await guild.channels.fetch(selectedCategoryId);
  if (!category) {
    await interaction.reply({
      content: "❌ Could not find the selected category.",
      ephemeral: true,
    });
    return;
  }

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
    category.name,
  );

  // Find lobby channel in category
  const lobbyChannel = category.children.cache.find((ch: any) =>
    ch.name.toLowerCase().includes("lobby"),
  );
  if (lobbyChannel) {
    wizardService.addConfiguration(
      userId,
      guildId,
      "voicechannels.lobby.name",
      lobbyChannel.name,
    );
  }

  await interaction.deferUpdate();

  const embed = new EmbedBuilder()
    .setTitle("✅ Voice Channels Configured")
    .setDescription(
      `Using existing category: **${category.name}**\n` +
        (lobbyChannel ? `Lobby channel: **${lobbyChannel.name}**` : ""),
    )
    .setColor(0x00ff00);

  await interaction.followUp({ embeds: [embed], ephemeral: true });

  // Import helper to move to next feature
  const { moveToNextFeature } =
    await import("./wizard-button-handler-helpers.js");
  await moveToNextFeature(interaction.channel!, guild, userId, guildId);
}

async function handleQuotesChannelSelection(
  interaction: StringSelectMenuInteraction,
  guild: any,
  userId: string,
  guildId: string,
): Promise<void> {
  const selectedChannelId = interaction.values[0];

  const channel = await guild.channels.fetch(selectedChannelId);
  if (!channel) {
    await interaction.reply({
      content: "❌ Could not find the selected channel.",
      ephemeral: true,
    });
    return;
  }

  // Save configuration
  wizardService.addConfiguration(userId, guildId, "quotes.enabled", true);
  wizardService.addConfiguration(
    userId,
    guildId,
    "quotes.channel_id",
    selectedChannelId,
  );

  await interaction.deferUpdate();

  const embed = new EmbedBuilder()
    .setTitle("✅ Quote System Configured")
    .setDescription(`Quotes will be posted in: <#${selectedChannelId}>`)
    .setColor(0x00ff00);

  await interaction.followUp({ embeds: [embed], ephemeral: true });

  // Import helper to move to next feature
  const { moveToNextFeature } =
    await import("./wizard-button-handler-helpers.js");
  await moveToNextFeature(interaction.channel!, guild, userId, guildId);
}

async function handleLoggingChannelSelection(
  interaction: StringSelectMenuInteraction,
  guild: any,
  userId: string,
  guildId: string,
): Promise<void> {
  const selectedChannelIds = interaction.values;

  if (selectedChannelIds.length === 0) {
    await interaction.reply({
      content: "❌ Please select at least one channel.",
      ephemeral: true,
    });
    return;
  }

  // Save configuration - use first channel for all logging
  const primaryChannel = selectedChannelIds[0];

  wizardService.addConfiguration(userId, guildId, "core.startup.enabled", true);
  wizardService.addConfiguration(
    userId,
    guildId,
    "core.startup.channel_id",
    primaryChannel,
  );
  wizardService.addConfiguration(userId, guildId, "core.errors.enabled", true);
  wizardService.addConfiguration(
    userId,
    guildId,
    "core.errors.channel_id",
    primaryChannel,
  );
  wizardService.addConfiguration(userId, guildId, "core.config.enabled", true);
  wizardService.addConfiguration(
    userId,
    guildId,
    "core.config.channel_id",
    primaryChannel,
  );

  await interaction.deferUpdate();

  const embed = new EmbedBuilder()
    .setTitle("✅ Logging Configured")
    .setDescription(
      `Bot logging will be sent to: <#${primaryChannel}>\n\n` +
        "Enabled logging:\n" +
        "• Startup/shutdown events\n" +
        "• Error notifications\n" +
        "• Configuration changes",
    )
    .setColor(0x00ff00);

  await interaction.followUp({ embeds: [embed], ephemeral: true });

  // Import helper to move to next feature
  const { moveToNextFeature } =
    await import("./wizard-button-handler-helpers.js");
  await moveToNextFeature(interaction.channel!, guild, userId, guildId);
}
