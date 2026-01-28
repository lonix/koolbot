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
import { startFeatureConfiguration } from "./setup-wizard-helpers.js";

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
