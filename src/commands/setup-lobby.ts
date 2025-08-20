import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import logger from "../utils/logger.js";
import { ChannelInitializer } from "../services/channel-initializer.js";
import { ConfigService } from "../services/config-service.js";

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

      const configService = ConfigService.getInstance();
      const lobbyChannelName = await configService.getString(
        "voice_channel.lobby_channel_name",
        "Lobby",
      );

      await interaction.reply(
        `Setting up voice channels with lobby name: **${lobbyChannelName}**...`,
      );

      const initializer = ChannelInitializer.getInstance(interaction.client);
      await initializer.forceReinitialize(interaction.guild.id);

      await interaction.editReply(
        `✅ Voice channel setup completed successfully!\n\n**Lobby Channel:** ${lobbyChannelName}\n\n*Note: If you changed the lobby channel name, the old channel may have been deleted and a new one created.*`,
      );
    } catch (error) {
      logger.error("Error in setup-lobby command:", error);
      if (interaction.replied) {
        await interaction.editReply({
          content:
            "❌ There was an error while executing this command! Please check the bot logs for details.",
        });
      } else {
        await interaction.reply({
          content:
            "❌ There was an error while executing this command! Please check the bot logs for details.",
          ephemeral: true,
        });
      }
    }
  },
};
