import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { AchievementsService } from "../services/achievements-service.js";
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
    const achievementsService = AchievementsService.getInstance(
      interaction.client,
    );

    const userAchievements = await achievementsService.getUserAchievements(
      targetUser.id,
    );

    if (
      !userAchievements ||
      (userAchievements.accolades.length === 0 &&
        userAchievements.achievements.length === 0)
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
    if (userAchievements.accolades.length > 0) {
      const accoladesList = userAchievements.accolades
        .sort((a, b) => b.earnedAt.getTime() - a.earnedAt.getTime())
        .map((accolade) => {
          const definition = achievementsService.getAccoladeDefinition(
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

    // Add achievements section (time-based)
    if (userAchievements.achievements.length > 0) {
      const achievementsList = userAchievements.achievements
        .sort((a, b) => b.earnedAt.getTime() - a.earnedAt.getTime())
        .slice(0, 10) // Limit to most recent 10
        .map((achievement) => {
          const definition = achievementsService.getAchievementDefinition(
            achievement.type,
          );
          if (!definition) return null;

          const earnedDate = achievement.earnedAt.toLocaleDateString();
          const period = achievement.period || "N/A";
          const metadataUnit = achievement.metadata?.unit ?? "";
          const metadataText = achievement.metadata?.value
            ? ` - ${achievement.metadata.value}${metadataUnit ? ` ${metadataUnit}` : ""}`
            : "";

          return `${definition.emoji} **${definition.name}**${metadataText}\n*${definition.description}* (${period})\nEarned: ${earnedDate}`;
        })
        .filter((text): text is string => Boolean(text));

      if (achievementsList.length > 0) {
        embed.addFields({
          name: "🏅 Recent Achievements (Time-Based)",
          value: achievementsList.join("\n\n"),
          inline: false,
        });
      }
    }

    // Add summary
    embed.addFields({
      name: "📊 Summary",
      value: `Total Accolades: ${userAchievements.statistics.totalAccolades}\nTotal Achievements: ${userAchievements.statistics.totalAchievements}`,
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
