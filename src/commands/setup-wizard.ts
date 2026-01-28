import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  StringSelectMenuBuilder,
  ButtonStyle,
  PermissionFlagsBits,
} from "discord.js";
import logger from "../utils/logger.js";
import { WizardService } from "../services/wizard-service.js";
import { ChannelDetector } from "../utils/channel-detector.js";

const wizardService = WizardService.getInstance();

// Feature definitions
const FEATURES = {
  voicechannels: {
    name: "Voice Channels",
    emoji: "🎤",
    description: "Dynamic voice channel management with lobby",
  },
  voicetracking: {
    name: "Voice Tracking",
    emoji: "📊",
    description: "Track voice activity and generate statistics",
  },
  quotes: {
    name: "Quote System",
    emoji: "💬",
    description: "Collect and share memorable quotes",
  },
  gamification: {
    name: "Gamification",
    emoji: "🏆",
    description: "Achievement system for voice activity",
  },
  logging: {
    name: "Core Logging",
    emoji: "📝",
    description: "Bot event logging to Discord channels",
  },
} as const;

type FeatureKey = keyof typeof FEATURES;

export const data = new SlashCommandBuilder()
  .setName("setup")
  .setDescription("Interactive server setup wizard")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("wizard")
      .setDescription("Start interactive configuration wizard")
      .addStringOption((option) =>
        option
          .setName("feature")
          .setDescription(
            "Configure a specific feature (leave empty for full setup)",
          )
          .setRequired(false)
          .addChoices(
            { name: "Voice Channels", value: "voicechannels" },
            { name: "Voice Tracking", value: "voicetracking" },
            { name: "Quote System", value: "quotes" },
            { name: "Gamification", value: "gamification" },
            { name: "Core Logging", value: "logging" },
          ),
      ),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    if (!interaction.guild) {
      await interaction.reply({
        content: "❌ This command can only be used in a server!",
        ephemeral: true,
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "wizard") {
      await handleWizard(interaction);
    } else {
      await interaction.reply({
        content: "❌ Unknown subcommand.",
        ephemeral: true,
      });
    }
  } catch (error) {
    logger.error("Error in setup command:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({
        content: `❌ An error occurred: ${errorMessage}`,
      });
    } else {
      await interaction.reply({
        content: `❌ An error occurred: ${errorMessage}`,
        ephemeral: true,
      });
    }
  }
}

async function handleWizard(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const featureParam = interaction.options.getString("feature");
  const userId = interaction.user.id;
  const guildId = interaction.guild!.id;

  try {
    // Detect existing channels
    const detectedChannels = await ChannelDetector.detectChannels(
      interaction.guild!,
    );

    // Create wizard session
    const selectedFeatures = featureParam ? [featureParam] : [];
    const state = wizardService.createSession(
      userId,
      guildId,
      selectedFeatures,
    );
    state.detectedResources = {
      categories: detectedChannels.voiceCategories,
      voiceChannels: detectedChannels.lobbyChannels,
      textChannels: detectedChannels.textChannels,
    };
    wizardService.updateSession(userId, guildId, state);

    // Start wizard with ephemeral interaction
    if (featureParam) {
      // Direct to specific feature configuration
      await startFeatureConfiguration(
        interaction,
        interaction.guild!,
        userId,
        featureParam as FeatureKey,
      );
    } else {
      // Show feature selection
      await showFeatureSelection(
        interaction,
        interaction.guild!.name,
        userId,
        guildId,
      );
    }
  } catch (error: any) {
    logger.error("Error starting wizard:", error);
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply({
        content: `❌ Failed to start wizard: ${error.message}`,
      });
    } else {
      await interaction.reply({
        content: `❌ Failed to start wizard: ${error.message}`,
        ephemeral: true,
      });
    }
    wizardService.endSession(userId, guildId);
  }
}

async function showFeatureSelection(
  interaction: ChatInputCommandInteraction,
  guildName: string,
  userId: string,
  guildId: string,
): Promise<void> {
  const embed = new EmbedBuilder()
    .setTitle(`🧙‍♂️ Setup Wizard for ${guildName}`)
    .setDescription(
      "Welcome to the interactive setup wizard! Select the features you want to configure:\n\n" +
        "You can select multiple features or configure them one at a time.",
    )
    .setColor(0x5865f2)
    .addFields(
      Object.entries(FEATURES).map(([, feature]) => ({
        name: `${feature.emoji} ${feature.name}`,
        value: feature.description,
        inline: false,
      })),
    )
    .setFooter({
      text: "Click buttons below to select features • Session expires in 15 minutes",
    });

  // Create select menu for features
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`wizard_features__${userId}_${guildId}`)
    .setPlaceholder("Select features to configure")
    .setMinValues(1)
    .setMaxValues(Object.keys(FEATURES).length)
    .addOptions(
      Object.entries(FEATURES).map(([key, feature]) => ({
        label: feature.name,
        value: key,
        description: feature.description,
        emoji: feature.emoji,
      })),
    );

  const row1 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    selectMenu,
  );

  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`wizard_continue__${userId}_${guildId}`)
      .setLabel("Continue")
      .setStyle(ButtonStyle.Primary)
      .setEmoji("▶️"),
    new ButtonBuilder()
      .setCustomId(`wizard_cancel__${userId}_${guildId}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Danger)
      .setEmoji("❌"),
  );

  await interaction.reply({
    embeds: [embed],
    components: [row1, row2],
    ephemeral: true,
  });
}

async function startFeatureConfiguration(
  interaction: ChatInputCommandInteraction,
  guild: any,
  userId: string,
  feature: FeatureKey,
): Promise<void> {
  const guildId = guild.id;
  const state = wizardService.getSession(userId, guildId);
  if (!state) {
    await interaction.reply({
      content: "❌ Wizard session expired. Please start again.",
      ephemeral: true,
    });
    return;
  }

  // Set current feature
  if (!state.selectedFeatures.includes(feature)) {
    state.selectedFeatures.push(feature);
    wizardService.updateSession(userId, guildId, state);
  }

  const featureInfo = FEATURES[feature];
  const embed = new EmbedBuilder()
    .setTitle(`${featureInfo.emoji} ${featureInfo.name} Configuration`)
    .setDescription(featureInfo.description)
    .setColor(0x5865f2);

  // Configure based on feature type
  switch (feature) {
    case "voicechannels":
      await configureVoiceChannels(interaction, guild, userId, guildId, embed);
      break;
    case "voicetracking":
      await configureVoiceTracking(interaction, guild, userId, guildId, embed);
      break;
    case "quotes":
      await configureQuotes(interaction, guild, userId, guildId, embed);
      break;
    case "gamification":
      await configureGamification(interaction, guild, userId, guildId, embed);
      break;
    case "logging":
      await configureLogging(interaction, guild, userId, guildId, embed);
      break;
  }
}

async function configureVoiceChannels(
  interaction: ChatInputCommandInteraction,
  guild: any,
  userId: string,
  guildId: string,
  embed: EmbedBuilder,
): Promise<void> {
  const state = wizardService.getSession(userId, guildId);
  if (!state) return;

  // Check for existing categories
  const existingCategories = state.detectedResources.categories || [];
  const existingLobbies = state.detectedResources.voiceChannels || [];

  let description = "**Voice Channel Configuration**\n\n";

  if (existingCategories.length > 0) {
    description += `I found ${existingCategories.length} existing voice categories:\n`;
    description += existingCategories.map((cat) => `• ${cat.name}`).join("\n");
    description += "\n\n";
  }

  if (existingLobbies.length > 0) {
    description += `I found ${existingLobbies.length} potential lobby channels:\n`;
    description += existingLobbies.map((ch) => `• ${ch.name}`).join("\n");
    description += "\n\n";
  }

  description += "Choose how to set up voice channels:";

  embed.setDescription(description);

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`wizard_vc_existing__${userId}_${guildId}`)
      .setLabel("Use Existing")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(existingCategories.length === 0),
    new ButtonBuilder()
      .setCustomId(`wizard_vc_new__${userId}_${guildId}`)
      .setLabel("Create New")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`wizard_vc_skip__${userId}_${guildId}`)
      .setLabel("Skip")
      .setStyle(ButtonStyle.Secondary),
  );

  if (interaction.replied || interaction.deferred) {
    await interaction.followUp({
      embeds: [embed],
      components: [buttons],
      ephemeral: true,
    });
  } else {
    await interaction.reply({
      embeds: [embed],
      components: [buttons],
      ephemeral: true,
    });
  }
}

async function configureVoiceTracking(
  interaction: ChatInputCommandInteraction,
  guild: any,
  userId: string,
  guildId: string,
  embed: EmbedBuilder,
): Promise<void> {
  embed.setDescription(
    "**Voice Tracking Configuration**\n\n" +
      "Enable tracking of voice activity and generate weekly statistics?\n\n" +
      "This will track:\n" +
      "• Time spent in voice channels\n" +
      "• Most active users\n" +
      "• Channel usage statistics",
  );

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`wizard_vt_enable__${userId}_${guildId}`)
      .setLabel("Enable & Configure")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`wizard_vt_skip__${userId}_${guildId}`)
      .setLabel("Skip")
      .setStyle(ButtonStyle.Secondary),
  );

  if (interaction.replied || interaction.deferred) {
    await interaction.followUp({
      embeds: [embed],
      components: [buttons],
      ephemeral: true,
    });
  } else {
    await interaction.reply({
      embeds: [embed],
      components: [buttons],
      ephemeral: true,
    });
  }
}

async function configureQuotes(
  interaction: ChatInputCommandInteraction,
  guild: any,
  userId: string,
  guildId: string,
  embed: EmbedBuilder,
): Promise<void> {
  const state = wizardService.getSession(userId, guildId);
  if (!state) return;

  const textChannels = state.detectedResources.textChannels || [];

  embed.setDescription(
    "**Quote System Configuration**\n\n" +
      "Set up a channel where users can save and share memorable quotes.\n\n" +
      `I found ${textChannels.length} text channels in your server.`,
  );

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`wizard_quotes_configure__${userId}_${guildId}`)
      .setLabel("Configure")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`wizard_quotes_skip__${userId}_${guildId}`)
      .setLabel("Skip")
      .setStyle(ButtonStyle.Secondary),
  );

  if (interaction.replied || interaction.deferred) {
    await interaction.followUp({
      embeds: [embed],
      components: [buttons],
      ephemeral: true,
    });
  } else {
    await interaction.reply({
      embeds: [embed],
      components: [buttons],
      ephemeral: true,
    });
  }
}

async function configureGamification(
  interaction: ChatInputCommandInteraction,
  guild: any,
  userId: string,
  guildId: string,
  embed: EmbedBuilder,
): Promise<void> {
  embed.setDescription(
    "**Gamification Configuration**\n\n" +
      "Enable achievement system for voice activity?\n\n" +
      "Features:\n" +
      "• Unlock achievements for milestones\n" +
      "• Track accolades and progress\n" +
      "• Leaderboards and stats",
  );

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`wizard_gamif_enable__${userId}_${guildId}`)
      .setLabel("Enable")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`wizard_gamif_skip__${userId}_${guildId}`)
      .setLabel("Skip")
      .setStyle(ButtonStyle.Secondary),
  );

  if (interaction.replied || interaction.deferred) {
    await interaction.followUp({
      embeds: [embed],
      components: [buttons],
      ephemeral: true,
    });
  } else {
    await interaction.reply({
      embeds: [embed],
      components: [buttons],
      ephemeral: true,
    });
  }
}

async function configureLogging(
  interaction: ChatInputCommandInteraction,
  guild: any,
  userId: string,
  guildId: string,
  embed: EmbedBuilder,
): Promise<void> {
  const state = wizardService.getSession(userId, guildId);
  if (!state) return;

  const textChannels = state.detectedResources.textChannels || [];

  embed.setDescription(
    "**Core Logging Configuration**\n\n" +
      "Configure channels for bot event logging:\n" +
      "• Startup/shutdown events\n" +
      "• Error notifications\n" +
      "• Configuration changes\n\n" +
      `I found ${textChannels.length} text channels in your server.`,
  );

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`wizard_logging_configure__${userId}_${guildId}`)
      .setLabel("Configure")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`wizard_logging_skip__${userId}_${guildId}`)
      .setLabel("Skip")
      .setStyle(ButtonStyle.Secondary),
  );

  if (interaction.replied || interaction.deferred) {
    await interaction.followUp({
      embeds: [embed],
      components: [buttons],
      ephemeral: true,
    });
  } else {
    await interaction.reply({
      embeds: [embed],
      components: [buttons],
      ephemeral: true,
    });
  }
}
