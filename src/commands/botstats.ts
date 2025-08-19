import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { MonitoringService } from "../services/monitoring-service.js";

export const data = new SlashCommandBuilder()
  .setName("botstats")
  .setDescription("Display bot performance and usage statistics");

export async function execute(interaction: ChatInputCommandInteraction) {
  try {
    const monitoringService = MonitoringService.getInstance();
    const performanceMetrics = monitoringService.getPerformanceMetrics();
    const topCommands = monitoringService.getTopCommands(5);
    const commandsWithErrors = monitoringService.getCommandsWithErrors(3);
    const slowestCommands = monitoringService.getSlowestCommands(3);

    const embed = new EmbedBuilder()
      .setTitle("🤖 KoolBot Statistics")
      .setColor(0x0099ff)
      .setTimestamp()
      .addFields(
        {
          name: "📊 General Stats",
          value: [
            `**Uptime:** ${monitoringService.formatUptime()}`,
            `**Total Commands:** ${performanceMetrics.totalCommands.toLocaleString()}`,
            `**Total Errors:** ${performanceMetrics.totalErrors.toLocaleString()}`,
            `**Error Rate:** ${performanceMetrics.totalCommands > 0 ? ((performanceMetrics.totalErrors / performanceMetrics.totalCommands) * 100).toFixed(2) : "0"}%`,
            `**Avg Response Time:** ${performanceMetrics.averageResponseTime.toFixed(0)}ms`,
          ].join("\n"),
          inline: true,
        },
        {
          name: "💾 Memory Usage",
          value: [
            `**Heap Used:** ${Math.round(performanceMetrics.memoryUsage.heapUsed / 1024 / 1024)}MB`,
            `**Heap Total:** ${Math.round(performanceMetrics.memoryUsage.heapTotal / 1024 / 1024)}MB`,
            `**External:** ${Math.round(performanceMetrics.memoryUsage.external / 1024 / 1024)}MB`,
            `**RSS:** ${Math.round(performanceMetrics.memoryUsage.rss / 1024 / 1024)}MB`,
          ].join("\n"),
          inline: true,
        },
      );

    // Add top commands if any exist
    if (topCommands.length > 0) {
      embed.addFields({
        name: "🔥 Most Used Commands",
        value: topCommands
          .map(
            (cmd, index) =>
              `${index + 1}. **${cmd.name}** - ${cmd.usageCount} uses`,
          )
          .join("\n"),
        inline: false,
      });
    }

    // Add slowest commands if any exist
    if (slowestCommands.length > 0) {
      embed.addFields({
        name: "🐌 Slowest Commands",
        value: slowestCommands
          .map(
            (cmd, index) =>
              `${index + 1}. **${cmd.name}** - ${cmd.averageResponseTime.toFixed(0)}ms avg`,
          )
          .join("\n"),
        inline: false,
      });
    }

    // Add commands with errors if any exist
    if (commandsWithErrors.length > 0) {
      embed.addFields({
        name: "⚠️ Commands with Errors",
        value: commandsWithErrors
          .map((cmd, index) => {
            const errorRate = ((cmd.errorCount / cmd.usageCount) * 100).toFixed(
              1,
            );
            return `${index + 1}. **${cmd.name}** - ${cmd.errorCount} errors (${errorRate}%)`;
          })
          .join("\n"),
        inline: false,
      });
    }

    await interaction.reply({ embeds: [embed] });
  } catch (error) {
    console.error("Error in botstats command:", error);
    await interaction.reply({
      content: "❌ There was an error while fetching bot statistics!",
      ephemeral: true,
    });
  }
}
