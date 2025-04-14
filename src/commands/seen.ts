import {
  CommandInteraction,
  SlashCommandBuilder,
  SlashCommandUserOption,
} from "discord.js";
import Logger from "../utils/logger.js";
import { VoiceChannelTracker } from "../services/voice-channel-tracker.js";

const logger = Logger.getInstance();

export const data = new SlashCommandBuilder()
  .setName("seen")
  .setDescription("Shows when a user was last seen in a voice channel")
  .addUserOption((option: SlashCommandUserOption) =>
    option
      .setName("user")
      .setDescription("The user to check")
      .setRequired(true),
  );

export async function execute(interaction: CommandInteraction): Promise<void> {
  try {
    logger.info(`Executing seen command for user ${interaction.user.tag}`);

    const targetUser = interaction.options.get("user")?.user;
    if (!targetUser) {
      await interaction.reply("Please specify a user to check.");
      return;
    }

    const tracker = VoiceChannelTracker.getInstance();
    
    // Check if user is currently in a voice channel
    const activeSession = tracker.getActiveSession(targetUser.id);
    if (activeSession) {
      await interaction.reply(
        `${targetUser.username} is currently in the voice channel "${activeSession.channelName}".`,
      );
      return;
    }

    const lastSeen = await tracker.getUserLastSeen(targetUser.id);

    if (!lastSeen) {
      await interaction.reply(
        `${targetUser.username} has never been seen in a voice channel.`,
      );
      return;
    }

    const timeDiff = Date.now() - lastSeen.getTime();
    const minutes = Math.floor(timeDiff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    let timeAgo;
    if (days > 0) {
      timeAgo = `${days} day${days === 1 ? "" : "s"} ago`;
    } else if (hours > 0) {
      timeAgo = `${hours} hour${hours === 1 ? "" : "s"} and ${minutes % 60} minute${minutes % 60 === 1 ? "" : "s"} ago`;
    } else {
      timeAgo = `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
    }

    await interaction.reply(
      `${targetUser.username} was last seen in a voice channel ${timeAgo}.`,
    );
    logger.info(`Seen command completed for user ${interaction.user.tag}`);
  } catch (error) {
    logger.error("Error executing seen command:", error);
    await interaction.reply({
      content: "An error occurred while fetching user information.",
      ephemeral: true,
    });
  }
}
