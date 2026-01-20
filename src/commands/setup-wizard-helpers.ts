import { Guild, ChatInputCommandInteraction, EmbedBuilder } from "discord.js";
import { WizardService } from "../services/wizard-service.js";
import logger from "../utils/logger.js";

const wizardService = WizardService.getInstance();

// Features configuration
const FEATURES = {
  voicechannels: {
    name: "Voice Channels",
    emoji: "🎤",
  },
  voicetracking: {
    name: "Voice Tracking",
    emoji: "📊",
  },
  quotes: {
    name: "Quote System",
    emoji: "💬",
  },
  gamification: {
    name: "Gamification",
    emoji: "🏆",
  },
  logging: {
    name: "Core Logging",
    emoji: "📝",
  },
} as const;

type FeatureKey = keyof typeof FEATURES;

/**
 * Start configuration for a specific feature
 */
export async function startFeatureConfiguration(
  interaction: ChatInputCommandInteraction | any,
  guild: Guild,
  userId: string,
  feature: FeatureKey,
): Promise<void> {
  const guildId = guild.id;
  const state = wizardService.getSession(userId, guildId);
  if (!state) {
    await interaction.followUp({ 
      content: "❌ Wizard session expired. Please start again.", 
      ephemeral: true 
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
    .setColor(0x5865f2);

  // Import configuration functions from main command
  const setupWizard = await import("../commands/setup-wizard.js");

  // Call appropriate configuration function based on feature
  // Note: These functions are not exported from setup-wizard.ts
  // We need to refactor or handle this differently
  logger.info(`Configuring feature: ${feature}`);
  await interaction.followUp({
    embeds: [embed],
    content: `⚠️ Feature configuration for ${feature} is being set up...`,
    ephemeral: true,
  });
}
