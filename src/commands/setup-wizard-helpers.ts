import {
  Guild,
  ChatInputCommandInteraction,
  ButtonInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { WizardService } from "../services/wizard-service.js";
import logger from "../utils/logger.js";

const wizardService = WizardService.getInstance();

// Features configuration - exported for use in setup-wizard.ts
export const FEATURES = {
  voicechannels: {
    name: "Voice Channels",
    emoji: "🎤",
    description: "Dynamic voice channel management with lobby",
    configKey: "voicechannels.enabled",
  },
  voicetracking: {
    name: "Voice Tracking",
    emoji: "📊",
    description: "Track voice activity and generate statistics",
    configKey: "voicetracking.enabled",
  },
  quotes: {
    name: "Quote System",
    emoji: "💬",
    description: "Collect and share memorable quotes",
    configKey: "quotes.enabled",
  },
  achievements: {
    name: "Achievements",
    emoji: "🏆",
    description: "Achievement system for voice activity",
    configKey: "achievements.enabled",
  },
  logging: {
    name: "Core Logging",
    emoji: "📝",
    description: "Bot event logging to Discord channels",
    configKey: "core.startup.enabled", // Using startup as main indicator
  },
  amikool: {
    name: "Am I Kool",
    emoji: "😎",
    description: "Fun command to check kool status based on role",
    configKey: "amikool.enabled",
  },
  reactionroles: {
    name: "Reaction Roles",
    emoji: "⭐",
    description: "Let users self-assign roles via reactions",
    configKey: "reactionroles.enabled",
  },
  announcements: {
    name: "Announcements",
    emoji: "📢",
    description: "Schedule automated announcements",
    configKey: "announcements.enabled",
  },
} as const;

type FeatureKey = keyof typeof FEATURES;

// Export for testing
export type { FeatureKey };

/**
 * Start configuration for a specific feature
 */
export async function startFeatureConfiguration(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
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
    case "achievements":
      await configureAchievements(interaction, guild, userId, guildId, embed);
      break;
    case "logging":
      await configureLogging(interaction, guild, userId, guildId, embed);
      break;
    case "amikool":
      await configureAmikool(interaction, guild, userId, guildId, embed);
      break;
    case "reactionroles":
      await configureReactionRoles(interaction, guild, userId, guildId, embed);
      break;
    case "announcements":
      await configureAnnouncements(interaction, guild, userId, guildId, embed);
      break;
    default:
      // This case is unreachable due to TypeScript's type system (FeatureKey guarantees valid keys)
      // However, we keep it for defensive programming in case features are added at runtime
      logger.error(`Unknown feature type: ${feature}`);
      await interaction.followUp({
        content: `❌ Unknown feature type: ${feature}`,
        ephemeral: true,
      });
  }
}

async function configureVoiceChannels(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
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
  interaction: ChatInputCommandInteraction | ButtonInteraction,
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
  interaction: ChatInputCommandInteraction | ButtonInteraction,
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

async function configureAchievements(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  guild: Guild,
  userId: string,
  guildId: string,
  embed: EmbedBuilder,
): Promise<void> {
  embed.setDescription(
    "**Achievements Configuration**\n\n" +
      "Enable achievement system for voice activity?\n\n" +
      "Features:\n" +
      "• Unlock achievements for milestones\n" +
      "• Track accolades and progress\n" +
      "• Leaderboards and stats",
  );

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`wizard_achiv_enable__${userId}_${guildId}`)
      .setLabel("Enable")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`wizard_achiv_skip__${userId}_${guildId}`)
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
  interaction: ChatInputCommandInteraction | ButtonInteraction,
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

async function configureAmikool(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  guild: Guild,
  userId: string,
  guildId: string,
  embed: EmbedBuilder,
): Promise<void> {
  embed.setDescription(
    "**Am I Kool Configuration**\n\n" +
      "Fun command that checks if users have a specific role.\n\n" +
      "Users with the configured role will be told they are 'kool'!",
  );

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`wizard_amikool_configure__${userId}_${guildId}`)
      .setLabel("Configure Role")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`wizard_amikool_skip__${userId}_${guildId}`)
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

async function configureReactionRoles(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  guild: Guild,
  userId: string,
  guildId: string,
  embed: EmbedBuilder,
): Promise<void> {
  const state = wizardService.getSession(userId, guildId);
  if (!state) return;

  const textChannels = state.detectedResources.textChannels || [];

  embed.setDescription(
    "**Reaction Roles Configuration**\n\n" +
      "Allow users to self-assign roles by reacting to messages.\n\n" +
      `I found ${textChannels.length} text channels where you can post reaction role messages.`,
  );

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`wizard_reactrole_configure__${userId}_${guildId}`)
      .setLabel("Configure")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`wizard_reactrole_skip__${userId}_${guildId}`)
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

async function configureAnnouncements(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  guild: Guild,
  userId: string,
  guildId: string,
  embed: EmbedBuilder,
): Promise<void> {
  embed.setDescription(
    "**Announcements Configuration**\n\n" +
      "Schedule automated announcements to channels.\n\n" +
      "You can create recurring announcements with custom schedules.",
  );

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`wizard_announce_configure__${userId}_${guildId}`)
      .setLabel("Configure")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`wizard_announce_skip__${userId}_${guildId}`)
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
