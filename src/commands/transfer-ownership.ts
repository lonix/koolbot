import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  SlashCommandUserOption,
} from "discord.js";
import logger from "../utils/logger.js";
import { VoiceChannelManager } from "../services/voice-channel-manager.js";

export const data = new SlashCommandBuilder()
  .setName("transfer-ownership")
  .setDescription("Transfer ownership of your voice channel to another user")
  .addUserOption((option: SlashCommandUserOption) =>
    option
      .setName("user")
      .setDescription("The user to transfer ownership to")
      .setRequired(true),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server!",
        ephemeral: true,
      });
      return;
    }

    const member = interaction.guild.members.cache.get(interaction.user.id);
    if (!member) {
      await interaction.reply({
        content: "Could not find your member information.",
        ephemeral: true,
      });
      return;
    }

    const voiceChannel = member.voice.channel;
    if (!voiceChannel) {
      await interaction.reply({
        content: "You must be in a voice channel to transfer ownership!",
        ephemeral: true,
      });
      return;
    }

    // Get the target user
    const targetUser = interaction.options.getUser("user");
    if (!targetUser) {
      await interaction.reply({
        content: "Please specify a user to transfer ownership to.",
        ephemeral: true,
      });
      return;
    }

    // Get the target member
    const targetMember = interaction.guild.members.cache.get(targetUser.id);
    if (!targetMember) {
      await interaction.reply({
        content: "Could not find the target user's member information.",
        ephemeral: true,
      });
      return;
    }

    // Check if target user is in the same voice channel
    if (targetMember.voice.channelId !== voiceChannel.id) {
      await interaction.reply({
        content: "The target user must be in the same voice channel!",
        ephemeral: true,
      });
      return;
    }

    // Get the voice channel manager instance
    const manager = VoiceChannelManager.getInstance(interaction.client);

    // Transfer ownership
    await manager.transferOwnership(
      voiceChannel.id,
      member.id,
      targetMember.id,
    );

    await interaction.reply({
      content: `Voice channel ownership transferred to ${targetUser.username}!`,
      ephemeral: true,
    });
  } catch (error) {
    logger.error("Error in transfer-ownership command:", error);
    await interaction.reply({
      content: "An error occurred while transferring ownership.",
      ephemeral: true,
    });
  }
}
