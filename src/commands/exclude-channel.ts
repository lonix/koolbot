import {
  SlashCommandBuilder,
  CommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { VoiceChannelTracker } from "../services/voice-channel-tracker.js";
import Logger from "../utils/logger.js";

const logger = Logger.getInstance();

export const data = new SlashCommandBuilder()
  .setName("exclude-channel")
  .setDescription("Manage voice channels excluded from tracking")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("add")
      .setDescription("Add a voice channel to the exclusion list")
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("The voice channel to exclude from tracking")
          .setRequired(true)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("remove")
      .setDescription("Remove a voice channel from the exclusion list")
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("The voice channel to remove from exclusion list")
          .setRequired(true)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("list")
      .setDescription("List all excluded voice channels")
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction: CommandInteraction) {
  try {
    const subcommand = interaction.options.getSubcommand();
    const tracker = VoiceChannelTracker.getInstance(interaction.client);

    switch (subcommand) {
      case "add": {
        const channel = interaction.options.getChannel("channel");
        if (!channel || channel.type !== 2) { // 2 is GUILD_VOICE
          await interaction.reply({
            content: "Please select a valid voice channel.",
            ephemeral: true,
          });
          return;
        }

        await tracker.addExcludedChannel(channel.id);
        await interaction.reply({
          content: `Voice channel ${channel.name} has been excluded from tracking.`,
          ephemeral: true,
        });
        break;
      }

      case "remove": {
        const channel = interaction.options.getChannel("channel");
        if (!channel || channel.type !== 2) {
          await interaction.reply({
            content: "Please select a valid voice channel.",
            ephemeral: true,
          });
          return;
        }

        await tracker.removeExcludedChannel(channel.id);
        await interaction.reply({
          content: `Voice channel ${channel.name} has been removed from the exclusion list.`,
          ephemeral: true,
        });
        break;
      }

      case "list": {
        const excludedChannels = await tracker.getExcludedChannels();
        if (excludedChannels.length === 0) {
          await interaction.reply({
            content: "No voice channels are currently excluded from tracking.",
            ephemeral: true,
          });
          return;
        }

        const channelList = await Promise.all(
          excludedChannels.map(async (channelId) => {
            const channel = await interaction.client.channels.fetch(channelId);
            return channel ? `• ${channel.name}` : `• Unknown channel (${channelId})`;
          })
        );

        await interaction.reply({
          content: `**Excluded Voice Channels:**\n${channelList.join("\n")}`,
          ephemeral: true,
        });
        break;
      }
    }
  } catch (error) {
    logger.error("Error in exclude-channel command:", error);
    await interaction.reply({
      content: "An error occurred while managing excluded channels.",
      ephemeral: true,
    });
  }
}
