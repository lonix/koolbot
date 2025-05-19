import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  ChannelType,
} from "discord.js";
import { ConfigService } from "../services/config-service.js";
import Logger from "../utils/logger.js";

const logger = Logger.getInstance();
const configService = ConfigService.getInstance();

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
          .addChannelTypes(ChannelType.GuildVoice),
      ),
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
          .addChannelTypes(ChannelType.GuildVoice),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("list")
      .setDescription("List all excluded voice channels"),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction: ChatInputCommandInteraction) {
  try {
    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
      case "add": {
        const channel = interaction.options.getChannel("channel", true);
        if (channel.type !== ChannelType.GuildVoice) {
          await interaction.reply({
            content: "Please select a valid voice channel.",
            ephemeral: true,
          });
          return;
        }

        const currentExcluded =
          (await configService.get("EXCLUDED_VC_CHANNELS")) || "";
        const excludedList = currentExcluded
          ? String(currentExcluded)
              .split(",")
              .map((id) => id.trim())
          : [];

        if (excludedList.includes(channel.id)) {
          await interaction.reply({
            content: `Voice channel ${channel.name} is already excluded from tracking.`,
            ephemeral: true,
          });
          return;
        }

        excludedList.push(channel.id);
        await configService.set(
          "EXCLUDED_VC_CHANNELS",
          excludedList.join(","),
          "Comma-separated list of voice channel IDs to exclude from tracking",
          "tracking",
        );

        await interaction.reply({
          content: `Voice channel ${channel.name} has been excluded from tracking.`,
          ephemeral: true,
        });
        break;
      }

      case "remove": {
        const channel = interaction.options.getChannel("channel", true);
        if (channel.type !== ChannelType.GuildVoice) {
          await interaction.reply({
            content: "Please select a valid voice channel.",
            ephemeral: true,
          });
          return;
        }

        const currentExcluded =
          (await configService.get("EXCLUDED_VC_CHANNELS")) || "";
        const excludedList = currentExcluded
          ? String(currentExcluded)
              .split(",")
              .map((id) => id.trim())
          : [];

        if (!excludedList.includes(channel.id)) {
          await interaction.reply({
            content: `Voice channel ${channel.name} is not currently excluded from tracking.`,
            ephemeral: true,
          });
          return;
        }

        const newExcludedList = excludedList.filter((id) => id !== channel.id);
        await configService.set(
          "EXCLUDED_VC_CHANNELS",
          newExcludedList.join(","),
          "Comma-separated list of voice channel IDs to exclude from tracking",
          "tracking",
        );

        await interaction.reply({
          content: `Voice channel ${channel.name} has been removed from the exclusion list.`,
          ephemeral: true,
        });
        break;
      }

      case "list": {
        const excludedChannels =
          (await configService.get("EXCLUDED_VC_CHANNELS")) || "";
        const excludedList = excludedChannels
          ? String(excludedChannels)
              .split(",")
              .map((id) => id.trim())
          : [];

        if (excludedList.length === 0) {
          await interaction.reply({
            content: "No voice channels are currently excluded from tracking.",
            ephemeral: true,
          });
          return;
        }

        const channelList = await Promise.all(
          excludedList.map(async (channelId) => {
            const channel = await interaction.client.channels.fetch(channelId);
            return channel && channel.type === ChannelType.GuildVoice
              ? `• ${channel.name}`
              : `• Unknown channel (${channelId})`;
          }),
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
