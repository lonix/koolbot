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
          const metadataText = accolade.metadata?.value
            ? ` - ${accolade.metadata.value} ${accolade.metadata.description?.includes("hour") ? "hrs" : ""}`
            : "";

          return `${definition.emoji} **${definition.name}**${metadataText}\n*${definition.description}*\nEarned: ${earnedDate}`;
        })
        .filter(Boolean);

      if (accoladesList.length > 0) {
        // Split into chunks if too long
        const chunkSize = 5;
        for (let i = 0; i < accoladesList.length; i += chunkSize) {
          const chunk = accoladesList.slice(i, i + chunkSize);
          const fieldName = i === 0 ? "🎖️ Accolades (Permanent)" : "\u200B";
          embed.addFields({
            name: fieldName,
            value: chunk.join("\n\n"),
            inline: false,
          });
        }
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
