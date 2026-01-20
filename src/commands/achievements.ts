import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { GamificationService } from "../services/gamification-service.js";
import logger from "../utils/logger.js";

export const data = new SlashCommandBuilder()
  .setName("achievements")
  .setDescription("View earned badges and achievements")
  .addUserOption((option) =>
    option
      .setName("user")
      .setDescription("The user to view achievements for (defaults to you)")
      .setRequired(false),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    const targetUser = interaction.options.getUser("user") || interaction.user;
    const gamificationService = GamificationService.getInstance(
      interaction.client,
    );

    const userGamification = await gamificationService.getUserGamification(
      targetUser.id,
    );

    if (
      !userGamification ||
      (userGamification.accolades.length === 0 &&
        userGamification.achievements.length === 0)
    ) {
      await interaction.reply({
        content: `${targetUser.username} hasn't earned any badges yet. Keep participating in voice channels!`,
        ephemeral: true,
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(0x00ae86)
      .setTitle(`🏆 ${targetUser.username}'s Achievements`)
      .setThumbnail(targetUser.displayAvatarURL())
      .setTimestamp();

    // Add accolades section
    if (userGamification.accolades.length > 0) {
      const accoladesList = userGamification.accolades
        .sort((a, b) => b.earnedAt.getTime() - a.earnedAt.getTime())
        .map((accolade) => {
          const definition = gamificationService.getAccoladeDefinition(
            accolade.type,
          );
          if (!definition) return null;

          const earnedDate = accolade.earnedAt.toLocaleDateString();
          const metadataUnit = accolade.metadata?.unit ?? "";
          const metadataText = accolade.metadata?.value
            ? ` - ${accolade.metadata.value}${metadataUnit ? ` ${metadataUnit}` : ""}`
            : "";

          const accoladeText = `${definition.emoji} **${definition.name}**${metadataText}\n*${definition.description}*\nEarned: ${earnedDate}`;

          // Ensure no single accolade string can exceed Discord's 1024 character field limit
          if (accoladeText.length > 1024) {
            return `${accoladeText.slice(0, 1021)}...`;
          }

          return accoladeText;
        })
        .filter((text): text is string => Boolean(text));

      if (accoladesList.length > 0) {
        // Build chunks that respect Discord's 1024 character limit for field values
        const MAX_FIELD_LENGTH = 1024;
        const accoladesChunks: string[] = [];
        let currentChunk = "";

        for (const accoladeText of accoladesList) {
          const separator = currentChunk.length > 0 ? "\n\n" : "";
          const potentialLength =
            currentChunk.length + separator.length + accoladeText.length;

          if (potentialLength > MAX_FIELD_LENGTH) {
            if (currentChunk.length > 0) {
              accoladesChunks.push(currentChunk);
            }
            // Start a new chunk with the current accolade text
            currentChunk =
              accoladeText.length > MAX_FIELD_LENGTH
                ? `${accoladeText.slice(0, MAX_FIELD_LENGTH - 3)}...`
                : accoladeText;
          } else {
            currentChunk += `${separator}${accoladeText}`;
          }
        }

        if (currentChunk.length > 0) {
          accoladesChunks.push(currentChunk);
        }

        accoladesChunks.forEach((chunk, index) => {
          const fieldName = index === 0 ? "🎖️ Accolades (Permanent)" : "\u200B";
          embed.addFields({
            name: fieldName,
            value: chunk,
            inline: false,
          });
        });
      }
    }

    // Add summary
    embed.addFields({
      name: "📊 Summary",
      value: `Total Accolades: ${userGamification.statistics.totalAccolades}\nTotal Achievements: ${userGamification.statistics.totalAchievements}`,
      inline: false,
    });

    await interaction.reply({ embeds: [embed] });
  } catch (error) {
    logger.error("Error in achievements command:", error);
    await interaction.reply({
      content: "There was an error while fetching achievements!",
      ephemeral: true,
    });
  }
}
