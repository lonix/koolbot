import {
  CommandInteraction,
  SlashCommandBuilder,
  GuildMember,
  SlashCommandUserOption,
} from "discord.js";
import Logger from "../utils/logger.js";
import { VoiceChannelManager } from "../services/voice-channel-manager.js";

const logger = Logger.getInstance();

export const data = new SlashCommandBuilder()
  .setName("transfer-ownership")
  .setDescription("Transfer ownership of your voice channel to another user")
  .addUserOption((option: SlashCommandUserOption) =>
    option
      .setName("user")
      .setDescription("The user to transfer ownership to")
      .setRequired(true)
  );

export async function execute(interaction: CommandInteraction): Promise<void> {
  try {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server!",
        ephemeral: true,
      });
      return;
    }

    const member = interaction.member as GuildMember;
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
    const targetUser = interaction.options.get("user")?.user;
    if (!targetUser) {
      await interaction.reply({
        content: "Please specify a user to transfer ownership to.",
        ephemeral: true,
      });
      return;
    }

    // Get the target member
    const targetMember = await interaction.guild.members.fetch(targetUser.id);
    if (!targetMember) {
      await interaction.reply({
        content: "Could not find the target user in this server.",
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
    const voiceChannelManager = VoiceChannelManager.getInstance(interaction.client);

    // Transfer ownership
    await voiceChannelManager.transferOwnership(
      voiceChannel.id,
      member.id,
      targetMember.id
    );

    await interaction.reply({
      content: `Ownership transferred to ${targetMember.displayName}!`,
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
