import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { AchievementsService } from "../services/achievements-service.js";
import type { IAccolade } from "../models/user-achievements.js";
import logger from "../utils/logger.js";

/**
 * Format the optional metadata of an accolade/achievement into the
 * trailing " - <value> <unit>" suffix shown next to its name. Returns an
 * empty string when there is no value to display.
 */
export function formatMetadata(metadata?: IAccolade["metadata"]): string {
  if (!metadata?.value) {
    return "";
  }
  const unit = metadata.unit ?? "";
  return ` - ${metadata.value}${unit ? ` ${unit}` : ""}`;
}

/**
 * Render a fixed-width unicode progress bar for a 0-100 percentage, e.g.
 * `▰▰▰▰▰▰▰▰▱▱` for 80%. Used by the unearned-accolade progress display (#654).
 */
export function formatProgressBar(percent: number, segments = 10): string {
  const clamped = Math.max(
    0,
    Math.min(100, Number.isFinite(percent) ? percent : 0),
  );
  const filled = Math.round((clamped / 100) * segments);
  return "▰".repeat(filled) + "▱".repeat(segments - filled);
}

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

    const [userAchievements, progress] = await Promise.all([
      achievementsService.getUserAchievements(targetUser.id),
      achievementsService.getUnearnedAccoladeProgress(targetUser.id, 5),
    ]);

    const hasBadges =
      !!userAchievements &&
      (userAchievements.accolades.length > 0 ||
        userAchievements.achievements.length > 0);

    if (!hasBadges && progress.length === 0) {
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
    if (userAchievements && userAchievements.accolades.length > 0) {
      const accoladesList = userAchievements.accolades
        .sort((a, b) => b.earnedAt.getTime() - a.earnedAt.getTime())
        .map((accolade) => {
          const definition = achievementsService.getAccoladeDefinition(
            accolade.type,
          );
          if (!definition) return null;

          const earnedDate = accolade.earnedAt.toLocaleDateString();
          const metadataText = formatMetadata(accolade.metadata);

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
    if (userAchievements && userAchievements.achievements.length > 0) {
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
          const metadataText = formatMetadata(achievement.metadata);

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

    // Add progress toward the nearest unearned accolades (#654)
    if (progress.length > 0) {
      const progressLines = progress.map((p) => {
        const bar = formatProgressBar(p.percent);
        const unit = p.unit ? ` ${p.unit}` : "";
        return `${p.emoji} ${bar} **${p.name}** — ${p.current} / ${p.target}${unit}`;
      });

      // Each line is short; clamp the joined value to Discord's field limit.
      let value = progressLines.join("\n");
      if (value.length > 1024) {
        value = `${value.slice(0, 1021)}...`;
      }

      embed.addFields({
        name: "🎯 Almost There (Progress)",
        value,
        inline: false,
      });
    }

    // Add summary
    const totalAccolades = userAchievements?.statistics.totalAccolades ?? 0;
    const totalAchievements =
      userAchievements?.statistics.totalAchievements ?? 0;
    embed.addFields({
      name: "📊 Summary",
      value: `Total Accolades: ${totalAccolades}\nTotal Achievements: ${totalAchievements}`,
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
