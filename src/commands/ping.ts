import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import logger from "../utils/logger.js";
import { safeReply } from "../utils/safe-reply.js";

export const data = new SlashCommandBuilder()
  .setName("ping")
  .setDescription("Replies with Pong!");

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    // `withResponse` returns the interaction callback, whose resource carries
    // the message we just sent (the v14.16+ replacement for `fetchReply`).
    // The resource is typed as nullable, so fall back to fetching the reply
    // rather than crashing on a missing message.
    const response = await interaction.reply({
      content: "Pinging...",
      withResponse: true,
    });
    const sent = response.resource?.message ?? (await interaction.fetchReply());
    const latency = sent.createdTimestamp - interaction.createdTimestamp;
    const apiLatency = Math.round(interaction.client.ws.ping);

    await interaction.editReply(
      `Pong! 🏓\nBot Latency: ${latency}ms\nAPI Latency: ${apiLatency}ms`,
    );
  } catch (error) {
    logger.error("Error in ping command:", error);
    await safeReply(interaction, {
      content: "There was an error while executing this command!",
      flags: MessageFlags.Ephemeral,
    });
  }
}
