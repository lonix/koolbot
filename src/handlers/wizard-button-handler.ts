import {
  ButtonInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  Guild,
  TextChannel,
  CategoryChannel,
} from "discord.js";
import logger from "../utils/logger.js";
import { WizardService } from "../services/wizard-service.js";

const wizardService = WizardService.getInstance();

export async function handleWizardButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const customId = interaction.customId;

  // Parse custom ID: wizard_{action}__{userId}_{guildId}
  // Extract the parts after "wizard_"
  if (!customId.startsWith("wizard_")) {
    await interaction.reply({
      content: "❌ Invalid button interaction.",
      ephemeral: true,
    });
    return;
  }

  const afterWizard = customId.substring(7); // Remove "wizard_"
  const doubleSplit = afterWizard.split("__");

  if (doubleSplit.length !== 2) {
    await interaction.reply({
      content: "❌ Invalid button interaction format.",
      ephemeral: true,
    });
    return;
  }

  const action = doubleSplit[0];
  const userGuildParts = doubleSplit[1].split("_");

  if (userGuildParts.length !== 2) {
    await interaction.reply({
      content: "❌ Invalid button interaction format.",
      ephemeral: true,
    });
    return;
  }

  const targetUserId = userGuildParts[0];
  const guildId = userGuildParts[1];
  const userId = interaction.user.id;

  // Verify user owns this wizard session
  if (userId !== targetUserId) {
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
    switch (action) {
      case "continue":
        await handleContinue(interaction, guild, userId, guildId);
        break;
      case "cancel":
        await handleCancel(interaction, userId, guildId);
        break;
      case "vc_existing":
        await handleVcExisting(interaction, guild, userId, guildId);
        break;
      case "vc_new":
        await handleVcNew(interaction, userId, guildId);
        break;
      case "vc_skip":
        await handleFeatureSkip(interaction, guild, userId, guildId);
        break;
      case "vt_enable":
        await handleVtEnable(interaction, userId, guildId);
        break;
      case "vt_skip":
        await handleFeatureSkip(interaction, guild, userId, guildId);
        break;
      case "quotes_configure":
        await handleQuotesConfigure(interaction, guild, userId, guildId);
        break;
      case "quotes_skip":
        await handleFeatureSkip(interaction, guild, userId, guildId);
        break;
      case "gamif_enable":
        wizardService.addConfiguration(
          userId,
          guildId,
          "gamification.enabled",
          true,
        );
        await handleFeatureComplete(
          interaction,
          guild,
          userId,
          guildId,
          "Gamification",
        );
        break;
      case "gamif_skip":
        await handleFeatureSkip(interaction, guild, userId, guildId);
        break;
      case "logging_configure":
        await handleLoggingConfigure(interaction, guild, userId, guildId);
        break;
      case "logging_skip":
        await handleFeatureSkip(interaction, guild, userId, guildId);
        break;
      case "finish_confirm":
        await handleFinish(interaction, guild, userId, guildId);
        break;
      case "back":
        await handleBack(interaction, guild, userId, guildId);
        break;
      case "next":
        await handleNext(interaction, guild, userId, guildId);
        break;
      case "channel_page_next":
        await handleChannelPageNext(interaction, guild, userId, guildId);
        break;
      case "channel_page_prev":
        await handleChannelPagePrev(interaction, guild, userId, guildId);
        break;
      default:
        await interaction.reply({
          content: "❌ Unknown action.",
          ephemeral: true,
        });
    }
  } catch (error) {
    logger.error("Error handling wizard button:", error);
    await interaction.reply({
      content: `❌ An error occurred: ${error instanceof Error ? error.message : "Unknown error"}`,
      ephemeral: true,
    });
  }
}

async function handleContinue(
  interaction: ButtonInteraction,
  guild: any,
  userId: string,
  guildId: string,
): Promise<void> {
  const state = wizardService.getSession(userId, guildId);
  if (!state) return;

  // If no features selected yet, prompt to select
  if (state.selectedFeatures.length === 0) {
    await interaction.reply({
      content: "❌ Please select at least one feature to configure.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferUpdate();

  // Move to first feature configuration
  const firstFeature = state.selectedFeatures[0];
  state.currentStep = 1;
  wizardService.updateSession(userId, guildId, state);

  // Import the setup-wizard module to call feature configuration
  const { startFeatureConfiguration } =
    await import("../commands/setup-wizard-helpers.js");
  await startFeatureConfiguration(
    interaction,
    guild,
    userId,
    firstFeature as any,
  );
}

async function handleCancel(
  interaction: ButtonInteraction,
  userId: string,
  guildId: string,
): Promise<void> {
  wizardService.endSession(userId, guildId);

  const embed = new EmbedBuilder()
    .setTitle("❌ Setup Wizard Cancelled")
    .setDescription("No changes were made to your server configuration.")
    .setColor(0xff0000);

  await interaction.update({ embeds: [embed], components: [] });
}

async function handleVcExisting(
  interaction: ButtonInteraction,
  guild: any,
  userId: string,
  guildId: string,
): Promise<void> {
  const state = wizardService.getSession(userId, guildId);
  if (!state) return;

  const categories = state.detectedResources.categories || [];

  if (categories.length === 0) {
    await interaction.reply({
      content: "❌ No existing voice categories found.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferUpdate();

  // Initialize page to 0 if not set
  if (state.channelPage === undefined) {
    state.channelPage = 0;
    wizardService.updateSession(userId, guildId, state);
  }

  await showChannelSelectionPage(
    interaction,
    guild,
    userId,
    guildId,
    categories,
    "vc_category",
  );
}

async function handleVcNew(
  interaction: ButtonInteraction,
  userId: string,
  guildId: string,
): Promise<void> {
  // Show modal for new voice channel configuration
  const modal = new ModalBuilder()
    .setCustomId(`wizard_modal_vc_new__${userId}_${guildId}`)
    .setTitle("Voice Channel Configuration");

  const categoryInput = new TextInputBuilder()
    .setCustomId("category_name")
    .setLabel("Category Name")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("Voice Channels")
    .setRequired(true)
    .setMaxLength(100);

  const lobbyInput = new TextInputBuilder()
    .setCustomId("lobby_name")
    .setLabel("Lobby Channel Name")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("Lobby")
    .setRequired(true)
    .setMaxLength(100);

  const prefixInput = new TextInputBuilder()
    .setCustomId("channel_prefix")
    .setLabel("Channel Prefix (emoji or text)")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("🎮")
    .setRequired(false)
    .setMaxLength(10);

  const row1 = new ActionRowBuilder<TextInputBuilder>().addComponents(
    categoryInput,
  );
  const row2 = new ActionRowBuilder<TextInputBuilder>().addComponents(
    lobbyInput,
  );
  const row3 = new ActionRowBuilder<TextInputBuilder>().addComponents(
    prefixInput,
  );

  modal.addComponents(row1, row2, row3);
  await interaction.showModal(modal);
}

async function handleVtEnable(
  interaction: ButtonInteraction,
  userId: string,
  guildId: string,
): Promise<void> {
  // Show modal for voice tracking configuration
  const modal = new ModalBuilder()
    .setCustomId(`wizard_modal_vt__${userId}_${guildId}`)
    .setTitle("Voice Tracking Configuration");

  const channelInput = new TextInputBuilder()
    .setCustomId("announcements_channel")
    .setLabel("Announcements Channel Name")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("voice-stats")
    .setRequired(true)
    .setMaxLength(100);

  const scheduleInput = new TextInputBuilder()
    .setCustomId("announcements_schedule")
    .setLabel("Cron Schedule (e.g., weekly)")
    .setStyle(TextInputStyle.Short)
    .setValue("0 16 * * 5")
    .setPlaceholder("0 16 * * 5 (Friday 4PM)")
    .setRequired(false)
    .setMaxLength(50);

  const row1 = new ActionRowBuilder<TextInputBuilder>().addComponents(
    channelInput,
  );
  const row2 = new ActionRowBuilder<TextInputBuilder>().addComponents(
    scheduleInput,
  );

  modal.addComponents(row1, row2);
  await interaction.showModal(modal);
}

async function handleQuotesConfigure(
  interaction: ButtonInteraction,
  guild: any,
  userId: string,
  guildId: string,
): Promise<void> {
  const state = wizardService.getSession(userId, guildId);
  if (!state) return;

  const textChannels = state.detectedResources.textChannels || [];

  if (textChannels.length === 0) {
    await interaction.reply({
      content: "❌ No text channels found in your server.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferUpdate();

  // Initialize page to 0 if not set
  if (state.channelPage === undefined) {
    state.channelPage = 0;
    wizardService.updateSession(userId, guildId, state);
  }

  await showChannelSelectionPage(
    interaction,
    guild,
    userId,
    guildId,
    textChannels,
    "quotes",
  );
}

async function handleLoggingConfigure(
  interaction: ButtonInteraction,
  guild: any,
  userId: string,
  guildId: string,
): Promise<void> {
  const state = wizardService.getSession(userId, guildId);
  if (!state) return;

  const textChannels = state.detectedResources.textChannels || [];

  if (textChannels.length === 0) {
    await interaction.reply({
      content: "❌ No text channels found in your server.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferUpdate();

  // Initialize page to 0 if not set
  if (state.channelPage === undefined) {
    state.channelPage = 0;
    wizardService.updateSession(userId, guildId, state);
  }

  await showChannelSelectionPage(
    interaction,
    guild,
    userId,
    guildId,
    textChannels,
    "logging",
  );
}

async function handleFeatureComplete(
  interaction: ButtonInteraction,
  guild: any,
  userId: string,
  guildId: string,
  featureName: string,
): Promise<void> {
  await interaction.deferUpdate();

  const embed = new EmbedBuilder()
    .setTitle(`✅ ${featureName} Configured`)
    .setDescription(`${featureName} has been configured successfully.`)
    .setColor(0x00ff00);

  await interaction.followUp({ embeds: [embed], ephemeral: true });

  // Move to next feature or show summary
  await moveToNextFeature(interaction, guild, userId, guildId);
}

async function handleFeatureSkip(
  interaction: ButtonInteraction,
  guild: any,
  userId: string,
  guildId: string,
): Promise<void> {
  await interaction.deferUpdate();

  const embed = new EmbedBuilder()
    .setTitle("⏭️ Feature Skipped")
    .setDescription("Moving to next feature...")
    .setColor(0xffaa00);

  await interaction.followUp({ embeds: [embed], ephemeral: true });

  // Move to next feature or show summary
  await moveToNextFeature(interaction, guild, userId, guildId);
}

async function moveToNextFeature(
  interaction: ButtonInteraction,
  guild: any,
  userId: string,
  guildId: string,
): Promise<void> {
  const state = wizardService.getSession(userId, guildId);
  if (!state) return;

  const nextFeatureIndex = state.currentStep;

  if (nextFeatureIndex >= state.selectedFeatures.length) {
    // All features configured, show summary
    await showSummary(interaction, guild, userId, guildId);
  } else {
    // Move to next feature
    state.currentStep++;
    wizardService.updateSession(userId, guildId, state);

    const nextFeature = state.selectedFeatures[nextFeatureIndex];
    const { startFeatureConfiguration } =
      await import("../commands/setup-wizard-helpers.js");
    await startFeatureConfiguration(
      interaction,
      guild,
      userId,
      nextFeature as any,
    );
  }
}

async function showSummary(
  interaction: ButtonInteraction,
  guild: any,
  userId: string,
  guildId: string,
): Promise<void> {
  const state = wizardService.getSession(userId, guildId);
  if (!state) return;

  const configEntries = Object.entries(state.configuration);

  const embed = new EmbedBuilder()
    .setTitle("📋 Configuration Summary")
    .setDescription(
      `Review your configuration changes for **${guild.name}**:\n\n` +
        `**${configEntries.length} settings will be updated**`,
    )
    .setColor(0x5865f2);

  if (configEntries.length > 0) {
    // Group by category
    const grouped: Record<string, Array<[string, any]>> = {};
    configEntries.forEach(([key, value]) => {
      const category = key.split(".")[0];
      if (!grouped[category]) {
        grouped[category] = [];
      }
      grouped[category].push([key, value]);
    });

    for (const [category, entries] of Object.entries(grouped)) {
      const fieldValue = entries
        .map(([key, value]) => `• \`${key}\`: ${value}`)
        .join("\n");
      embed.addFields({
        name: category.charAt(0).toUpperCase() + category.slice(1),
        value: fieldValue,
        inline: false,
      });
    }
  }

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`wizard_finish_confirm__${userId}_${guildId}`)
      .setLabel("Apply Configuration")
      .setStyle(ButtonStyle.Success)
      .setEmoji("✅"),
    new ButtonBuilder()
      .setCustomId(`wizard_cancel__${userId}_${guildId}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Danger)
      .setEmoji("❌"),
  );

  await interaction.followUp({
    embeds: [embed],
    components: [buttons],
    ephemeral: true,
  });
}

async function handleFinish(
  interaction: ButtonInteraction,
  guild: any,
  userId: string,
  guildId: string,
): Promise<void> {
  await interaction.deferUpdate();

  const embed = new EmbedBuilder()
    .setTitle("⏳ Applying Configuration...")
    .setDescription("Please wait while I apply your configuration changes...")
    .setColor(0xffaa00);

  await interaction.followUp({ embeds: [embed], ephemeral: true });

  // Apply configuration
  const success = await wizardService.applyConfiguration(userId, guildId);

  if (success) {
    const successEmbed = new EmbedBuilder()
      .setTitle("✅ Configuration Applied")
      .setDescription(
        `Your configuration has been applied successfully to **${guild.name}**!\n\n` +
          "The bot will now reload to apply the changes.",
      )
      .setColor(0x00ff00);

    await interaction.followUp({ embeds: [successEmbed], ephemeral: true });

    // Try to notify in the server too
    try {
      const member = await guild.members.fetch(userId);
      const serverChannel = guild.channels.cache.find(
        (ch: any) =>
          ch.type === 0 &&
          ch.permissionsFor(guild.members.me).has("SendMessages"),
      );
      if (serverChannel) {
        await serverChannel.send({
          content: `${member}, setup wizard completed! Configuration has been applied.`,
        });
      }
    } catch (error) {
      logger.debug("Could not send server notification:", error);
    }
  } else {
    const errorEmbed = new EmbedBuilder()
      .setTitle("❌ Configuration Failed")
      .setDescription(
        "There was an error applying your configuration. Please check the logs or try again.",
      )
      .setColor(0xff0000);

    await interaction.followUp({ embeds: [errorEmbed], ephemeral: true });
  }

  // End wizard session
  wizardService.endSession(userId, guildId);
}

async function handleBack(
  interaction: ButtonInteraction,
  guild: any,
  userId: string,
  guildId: string,
): Promise<void> {
  wizardService.previousStep(userId, guildId);
  await interaction.reply({
    content: "⬅️ Moved to previous step.",
    ephemeral: true,
  });
}

async function handleNext(
  interaction: ButtonInteraction,
  guild: any,
  userId: string,
  guildId: string,
): Promise<void> {
  wizardService.nextStep(userId, guildId);
  await interaction.reply({
    content: "➡️ Moved to next step.",
    ephemeral: true,
  });
}

/**
 * Helper function to show channel selection with pagination
 */
async function showChannelSelectionPage(
  interaction: ButtonInteraction,
  guild: Guild,
  userId: string,
  guildId: string,
  channels: TextChannel[] | CategoryChannel[],
  selectionType: "quotes" | "logging" | "vc_category",
): Promise<void> {
  const state = wizardService.getSession(userId, guildId);
  if (!state) return;

  const CHANNELS_PER_PAGE = 25;
  const totalPages = Math.ceil(channels.length / CHANNELS_PER_PAGE);

  // Validate page bounds
  if ((state.channelPage || 0) >= totalPages && totalPages > 0) {
    state.channelPage = 0;
    wizardService.updateSession(userId, guildId, state);
  }

  // Use the validated page value consistently
  const effectivePage = state.channelPage || 0;
  const startIndex = effectivePage * CHANNELS_PER_PAGE;
  const endIndex = Math.min(startIndex + CHANNELS_PER_PAGE, channels.length);
  const channelsOnPage = channels.slice(startIndex, endIndex);

  // Validate we have channels to display
  if (channelsOnPage.length === 0) {
    await interaction.followUp({
      content: "❌ No channels available on this page.",
      ephemeral: true,
    });
    return;
  }

  // Build select menu based on type
  let selectMenu: StringSelectMenuBuilder;
  let embed: EmbedBuilder;

  if (selectionType === "quotes") {
    selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`wizard_select_quotes_channel__${userId}_${guildId}`)
      .setPlaceholder("Select a channel for quotes")
      .addOptions(
        channelsOnPage.map((ch) => ({
          label: `#${ch.name}`,
          value: ch.id,
        })),
      );

    embed = new EmbedBuilder()
      .setTitle("💬 Select Quotes Channel")
      .setDescription(
        `Choose a channel where quotes will be posted:\n\n` +
          `Showing channels ${startIndex + 1}-${endIndex} of ${channels.length}` +
          (totalPages > 1
            ? `\nPage ${effectivePage + 1} of ${totalPages}`
            : ""),
      )
      .setColor(0x5865f2);
  } else if (selectionType === "logging") {
    selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`wizard_select_logging_channel__${userId}_${guildId}`)
      .setPlaceholder("Select logging channels")
      .setMinValues(1)
      .setMaxValues(Math.min(3, channelsOnPage.length))
      .addOptions(
        channelsOnPage.map((ch) => ({
          label: `#${ch.name}`,
          value: ch.id,
        })),
      );

    embed = new EmbedBuilder()
      .setTitle("📝 Select Logging Channels")
      .setDescription(
        "Choose channels for bot logging:\n" +
          "• Startup/shutdown events\n" +
          "• Error notifications\n" +
          "• Configuration changes\n\n" +
          `Showing channels ${startIndex + 1}-${endIndex} of ${channels.length}` +
          (totalPages > 1
            ? `\nPage ${effectivePage + 1} of ${totalPages}`
            : "") +
          "\n\nYou can select 1-3 channels.",
      )
      .setColor(0x5865f2);
  } else {
    // vc_category
    selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`wizard_select_vc_category__${userId}_${guildId}`)
      .setPlaceholder("Select a voice category")
      .addOptions(
        channelsOnPage.map((cat) => ({
          label: cat.name,
          value: cat.id,
          description: `Category with ${cat.children.cache.size} channels`,
        })),
      );

    embed = new EmbedBuilder()
      .setTitle("🎤 Select Voice Category")
      .setDescription(
        `Choose an existing voice category to use:\n\n` +
          `Showing categories ${startIndex + 1}-${endIndex} of ${channels.length}` +
          (totalPages > 1
            ? `\nPage ${effectivePage + 1} of ${totalPages}`
            : ""),
      )
      .setColor(0x5865f2);
  }

  const components: ActionRowBuilder<any>[] = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu),
  ];

  // Add pagination buttons if needed
  if (totalPages > 1) {
    const paginationButtons =
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`wizard_channel_page_prev__${userId}_${guildId}`)
          .setLabel("Previous")
          .setStyle(ButtonStyle.Secondary)
          .setEmoji("◀️")
          .setDisabled(effectivePage === 0),
        new ButtonBuilder()
          .setCustomId(`wizard_channel_page_next__${userId}_${guildId}`)
          .setLabel("Next")
          .setStyle(ButtonStyle.Secondary)
          .setEmoji("▶️")
          .setDisabled(effectivePage === totalPages - 1),
      );
    components.push(paginationButtons);
  }

  await interaction.followUp({
    embeds: [embed],
    components: components,
    ephemeral: true,
  });
}

/**
 * Refresh the channel selection page based on current wizard state
 */
async function refreshChannelSelectionPage(
  interaction: ButtonInteraction,
  guild: Guild,
  userId: string,
  guildId: string,
): Promise<void> {
  const state = wizardService.getSession(userId, guildId);
  if (!state) return;

  const textChannels = state.detectedResources.textChannels || [];
  const categories = state.detectedResources.categories || [];
  const currentFeature = state.selectedFeatures[state.currentStep - 1];

  if (currentFeature === "quotes") {
    await showChannelSelectionPage(
      interaction,
      guild,
      userId,
      guildId,
      textChannels,
      "quotes",
    );
  } else if (currentFeature === "logging") {
    await showChannelSelectionPage(
      interaction,
      guild,
      userId,
      guildId,
      textChannels,
      "logging",
    );
  } else if (currentFeature === "voicechannels") {
    await showChannelSelectionPage(
      interaction,
      guild,
      userId,
      guildId,
      categories,
      "vc_category",
    );
  } else {
    logger.warn(
      `Unexpected feature type for channel pagination: ${currentFeature}`,
    );
    await interaction.followUp({
      content: "❌ Unable to display channel selection for this feature.",
      ephemeral: true,
    });
  }
}

/**
 * Handle next page button for channel selection
 */
async function handleChannelPageNext(
  interaction: ButtonInteraction,
  guild: Guild,
  userId: string,
  guildId: string,
): Promise<void> {
  const state = wizardService.getSession(userId, guildId);
  if (!state) return;

  const currentPage = state.channelPage || 0;

  // Get total channels to validate bounds
  const textChannels = state.detectedResources.textChannels || [];
  const categories = state.detectedResources.categories || [];
  const currentFeature = state.selectedFeatures[state.currentStep - 1];

  let totalChannels = 0;
  if (currentFeature === "quotes" || currentFeature === "logging") {
    totalChannels = textChannels.length;
  } else if (currentFeature === "voicechannels") {
    totalChannels = categories.length;
  }

  const totalPages = Math.ceil(totalChannels / 25);

  // Validate we're not already on the last page
  if (currentPage >= totalPages - 1) {
    await interaction.reply({
      content: "❌ Already on the last page.",
      ephemeral: true,
    });
    return;
  }

  state.channelPage = currentPage + 1;
  wizardService.updateSession(userId, guildId, state);

  await interaction.deferUpdate();
  await refreshChannelSelectionPage(interaction, guild, userId, guildId);
}

/**
 * Handle previous page button for channel selection
 */
async function handleChannelPagePrev(
  interaction: ButtonInteraction,
  guild: Guild,
  userId: string,
  guildId: string,
): Promise<void> {
  const state = wizardService.getSession(userId, guildId);
  if (!state) return;

  const currentPage = state.channelPage || 0;

  // Validate we're not already on the first page
  if (currentPage <= 0) {
    await interaction.reply({
      content: "❌ Already on the first page.",
      ephemeral: true,
    });
    return;
  }

  state.channelPage = Math.max(0, currentPage - 1);
  wizardService.updateSession(userId, guildId, state);

  await interaction.deferUpdate();
  await refreshChannelSelectionPage(interaction, guild, userId, guildId);
}
