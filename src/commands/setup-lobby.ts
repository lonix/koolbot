import {
  SlashCommandBuilder,
  CommandInteraction,
  CategoryChannel,
  VoiceChannel,
  ChannelType,
} from "discord.js";
import Logger from "../utils/logger.js";
import { Command } from "../interfaces/command.js";
import { ConfigService } from "../services/config-service.js";

const logger = Logger.getInstance();
const configService = ConfigService.getInstance();

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName("setup-lobby")
    .setDescription("Set up the voice channel lobby and category"),
  async execute(interaction: CommandInteraction): Promise<void> {
    try {
      // Get the guild
      const guild = interaction.guild;
      if (!guild) {
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

      // Get the category name from config
      const categoryName = await configService.getString(
        "VC_CATEGORY_NAME",
        "Dynamic Voice Channels"
      );

      // Create or get the category
      let category = guild.channels.cache.find(
        (c) => c.name === categoryName && c.type === 4
      );
      if (!category) {
        category = await guild.channels.create({
          name: categoryName,
          type: 4,
        });
        logger.info(`Created category: ${categoryName}`);
      }

      // Get the lobby name from config
      const lobbyName = await configService.getString("LOBBY_CHANNEL_NAME", "Lobby");

      // Create or get the lobby channel
      let lobbyChannel = guild.channels.cache.find(
        (c) => c.name === lobbyName && c.type === 2
      );
      if (!lobbyChannel) {
        lobbyChannel = await guild.channels.create({
          name: lobbyName,
          type: 2,
          parent: category.id,
        });
        logger.info(`Created lobby channel: ${lobbyName}`);
      }

      await interaction.reply({
        content: `Successfully set up the voice channel system!\nCategory: ${categoryName}\nLobby: ${lobbyName}`,
        ephemeral: true,
      });
    } catch (error) {
      logger.error("Error in setup-lobby command:", error);
      await interaction.reply({
        content: "There was an error setting up the voice channel system!",
        ephemeral: true,
      });
    }
  },
};
