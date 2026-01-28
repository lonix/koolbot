import {
  Guild,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { WizardService } from "../services/wizard-service.js";
import logger from "../utils/logger.js";

const wizardService = WizardService.getInstance();

// Features configuration
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

/**
 * Start configuration for a specific feature
 */
export async function startFeatureConfiguration(
  interaction: ChatInputCommandInteraction,
  guild: Guild,
  userId: string,
  feature: FeatureKey,
): Promise<void> {
  const guildId = guild.id;
  const state = wizardService.getSession(userId, guildId);
  if (!state) {
    await interaction.followUp({
      content: "❌ Wizard session expired. Please start again.",
      ephemeral: true,
    });
    return;
  }

  // Ensure feature is in selected features
  if (!state.selectedFeatures.includes(feature)) {
    state.selectedFeatures.push(feature);
    wizardService.updateSession(userId, guildId, state);
  }

  const featureInfo = FEATURES[feature];
  const embed = new EmbedBuilder()
    .setTitle(`${featureInfo.emoji} ${featureInfo.name} Configuration`)
    .setDescription(featureInfo.description)
    .setColor(0x5865f2);

  // Call appropriate configuration function based on feature
  logger.info(`Configuring feature: ${feature}`);

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
    default:
      logger.error(`Unknown feature type: ${feature}`);
      await interaction.followUp({
        content: `❌ Unknown feature type: ${feature}`,
        ephemeral: true,
      });
  }
}

async function configureVoiceChannels(
  interaction: ChatInputCommandInteraction,
  guild: Guild,
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
  guild: Guild,
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
  guild: Guild,
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
  guild: Guild,
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
  guild: Guild,
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
