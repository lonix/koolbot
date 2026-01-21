import { WizardService } from "../services/wizard-service.js";
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";

const wizardService = WizardService.getInstance();

/**
 * Move to the next feature in the wizard or show summary
 */
export async function moveToNextFeature(
  interaction: any,
  guild: any,
  userId: string,
  guildId: string,
): Promise<void> {
  const state = wizardService.getSession(userId, guildId);
  if (!state) return;

  // Find current feature index based on currentStep
  const nextFeatureIndex = state.currentStep;

  if (nextFeatureIndex >= state.selectedFeatures.length) {
    // All features configured, show summary
    await showSummary(interaction, guild, userId, guildId);
  } else {
    // Move to next feature
    state.currentStep++;
    wizardService.updateSession(userId, guildId, state);

    const nextFeature = state.selectedFeatures[nextFeatureIndex];

    // Import and call feature configuration
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

/**
 * Show configuration summary and confirmation
 */
async function showSummary(
  interaction: any,
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
        .join("\n")
        .substring(0, 1024); // Discord field value limit
      embed.addFields({
        name: category.charAt(0).toUpperCase() + category.slice(1),
        value: fieldValue,
        inline: false,
      });
    }
  }

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`wizard_finish_confirm_${userId}_${guildId}`)
      .setLabel("Apply Configuration")
      .setStyle(ButtonStyle.Success)
      .setEmoji("✅"),
    new ButtonBuilder()
      .setCustomId(`wizard_cancel_${userId}_${guildId}`)
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
