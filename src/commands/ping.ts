import { SlashCommandBuilder } from "discord.js";
import logger from "../utils/logger.js";

export const data = new SlashCommandBuilder()
  .setName("ping")
  .setDescription("Replies with Pong!");

export async function execute(interaction: any) {
  try {
    const sent = await interaction.reply({
      content: "Pinging...",
      fetchReply: true,
    });
    const latency = sent.createdTimestamp - interaction.createdTimestamp;
    const apiLatency = Math.round(interaction.client.ws.ping);

    await interaction.editReply(
      `Pong! 🏓\nBot Latency: ${latency}ms\nAPI Latency: ${apiLatency}ms`,
    );
  } catch (error) {
    logger.error("Error in ping command:", error);
    await interaction.reply({
      content: "There was an error while executing this command!",
      ephemeral: true,
    });
  }
}
