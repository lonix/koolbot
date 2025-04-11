import {
  SlashCommandBuilder,
  CommandInteraction,
  CategoryChannel,
  VoiceChannel,
  ChannelType,
} from "discord.js";
import { Logger } from "../utils/logger";

const logger = Logger.getInstance();

export const data = new SlashCommandBuilder()
  .setName("setup-lobby")
  .setDescription("Sets up the lobby channel for dynamic voice channels");

export async function execute(interaction: CommandInteraction): Promise<void> {
  try {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server!",
        ephemeral: true,
      });
      return;
    }

    // Check if user has permission to manage channels
    if (!interaction.memberPermissions?.has("ManageChannels")) {
      await interaction.reply({
        content:
          'You need the "Manage Channels" permission to use this command!',
        ephemeral: true,
      });
      return;
    }

    // Get or create the category
    const categoryName =
      process.env.VC_CATEGORY_NAME || "Dynamic Voice Channels";
    let category = interaction.guild.channels.cache.find(
      (channel): channel is CategoryChannel =>
        channel.type === ChannelType.GuildCategory &&
        channel.name === categoryName,
    );

    if (!category) {
      category = await interaction.guild.channels.create({
        name: categoryName,
        type: ChannelType.GuildCategory,
      });
      logger.info(`Created category: ${categoryName}`);
    }

    // Get or create the lobby channel
    const lobbyName = process.env.LOBBY_CHANNEL_NAME || "Lobby";
    let lobbyChannel = interaction.guild.channels.cache.find(
      (channel): channel is VoiceChannel =>
        channel.type === ChannelType.GuildVoice && channel.name === lobbyName,
    );

    if (!lobbyChannel) {
      lobbyChannel = await interaction.guild.channels.create({
        name: lobbyName,
        type: ChannelType.GuildVoice,
        parent: category,
      });
      logger.info(`Created lobby channel: ${lobbyName}`);
    }

    await interaction.reply({
      content: `✅ Lobby channel setup complete!\nCategory: ${categoryName}\nLobby: ${lobbyName}`,
      ephemeral: true,
    });
  } catch (error) {
    logger.error("Error setting up lobby:", error);
    await interaction.reply({
      content: "An error occurred while setting up the lobby channel.",
      ephemeral: true,
    });
  }
}
