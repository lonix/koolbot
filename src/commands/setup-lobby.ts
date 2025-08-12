import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from "discord.js";
import logger from "../utils/logger.js";
import { ChannelInitializer } from "../services/channel-initializer.js";

export const command = {
  data: new SlashCommandBuilder()
    .setName("setup-lobby")
    .setDescription("Set up the voice channel lobby and category"),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    try {
      if (!interaction.guild) {
        await interaction.reply("This command can only be used in a server.");
        return;
      }

      const initializer = ChannelInitializer.getInstance(interaction.client);
      await initializer.initialize(interaction.guild.id);

      await interaction.reply("Voice channel setup completed successfully!");
    } catch (error) {
      logger.error("Error in setup-lobby command:", error);
      await interaction.reply({
        content: "There was an error while executing this command!",
        ephemeral: true,
      });
    }
  },
};
