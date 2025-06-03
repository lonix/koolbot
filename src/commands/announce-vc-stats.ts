import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { VoiceChannelAnnouncer } from "../services/voice-channel-announcer.js";
import logger from "../utils/logger.js";

export const data = new SlashCommandBuilder()
  .setName("announce-vc-stats")
  .setDescription("Manually trigger the voice channel activity announcement")
  .setDefaultMemberPermissions(0x8); // Requires Administrator permission

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    await interaction.deferReply({ ephemeral: true });

    const announcer = VoiceChannelAnnouncer.getInstance(interaction.client);
    await announcer.makeAnnouncement();

    await interaction.editReply({
      content: "✅ Voice channel activity announcement has been sent!",
    });
  } catch (error) {
    logger.error("Error executing announce-vc-stats command:", error);
    await interaction.editReply({
      content: "❌ Failed to send the announcement. Please check the logs for details.",
    });
  }
}
