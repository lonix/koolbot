import { Guild, ChannelType, CategoryChannel, TextChannel, VoiceChannel } from "discord.js";
import logger from "./logger.js";

export interface DetectedChannels {
  voiceCategories: CategoryChannel[];
  lobbyChannels: VoiceChannel[];
  textChannels: TextChannel[];
}

/**
 * Utility class for auto-detecting existing Discord channels and categories
 * to help avoid duplicate resource creation during setup wizard
 */
export class ChannelDetector {
  /**
   * Detect all relevant channels in a guild
   */
  static async detectChannels(guild: Guild): Promise<DetectedChannels> {
    try {
      // Ensure guild data is fresh
      await guild.fetch();

      const voiceCategories: CategoryChannel[] = [];
      const lobbyChannels: VoiceChannel[] = [];
      const textChannels: TextChannel[] = [];

      // Fetch all channels
      const channels = await guild.channels.fetch();

      channels.forEach((channel) => {
        if (!channel) return;

        // Detect voice categories
        if (channel.type === ChannelType.GuildCategory) {
          // Look for categories that might be voice-related
          const name = channel.name.toLowerCase();
          if (
            name.includes("voice") ||
            name.includes("vc") ||
            name.includes("talk") ||
            name.includes("chat")
          ) {
            voiceCategories.push(channel as CategoryChannel);
          }
        }

        // Detect lobby-like voice channels
        if (channel.type === ChannelType.GuildVoice) {
          const name = channel.name.toLowerCase();
          if (
            name.includes("lobby") ||
            name.includes("lounge") ||
            name.includes("waiting") ||
            name.includes("join")
          ) {
            lobbyChannels.push(channel as VoiceChannel);
          }
        }

        // Collect all text channels for announcements/logging
        if (channel.type === ChannelType.GuildText) {
          textChannels.push(channel as TextChannel);
        }
      });

      logger.debug(
        `Detected ${voiceCategories.length} voice categories, ${lobbyChannels.length} lobby channels, ${textChannels.length} text channels`,
      );

      return {
        voiceCategories,
        lobbyChannels,
        textChannels,
      };
    } catch (error) {
      logger.error("Error detecting channels:", error);
      throw error;
    }
  }

  /**
   * Find a specific category by name (case-insensitive)
   */
  static async findCategoryByName(
    guild: Guild,
    name: string,
  ): Promise<CategoryChannel | null> {
    try {
      const channels = await guild.channels.fetch();
      const category = channels.find(
        (channel) =>
          channel?.type === ChannelType.GuildCategory &&
          channel.name.toLowerCase() === name.toLowerCase(),
      );
      return category ? (category as CategoryChannel) : null;
    } catch (error) {
      logger.error("Error finding category by name:", error);
      return null;
    }
  }

  /**
   * Find a specific voice channel by name (case-insensitive)
   */
  static async findVoiceChannelByName(
    guild: Guild,
    name: string,
  ): Promise<VoiceChannel | null> {
    try {
      const channels = await guild.channels.fetch();
      const voiceChannel = channels.find(
        (channel) =>
          channel?.type === ChannelType.GuildVoice &&
          channel.name.toLowerCase() === name.toLowerCase(),
      );
      return voiceChannel ? (voiceChannel as VoiceChannel) : null;
    } catch (error) {
      logger.error("Error finding voice channel by name:", error);
      return null;
    }
  }

  /**
   * Find a specific text channel by name (case-insensitive)
   */
  static async findTextChannelByName(
    guild: Guild,
    name: string,
  ): Promise<TextChannel | null> {
    try {
      const channels = await guild.channels.fetch();
      const textChannel = channels.find(
        (channel) =>
          channel?.type === ChannelType.GuildText &&
          channel.name.toLowerCase() === name.toLowerCase(),
      );
      return textChannel ? (textChannel as TextChannel) : null;
    } catch (error) {
      logger.error("Error finding text channel by name:", error);
      return null;
    }
  }

  /**
   * Check if a resource (category or channel) already exists
   */
  static async resourceExists(
    guild: Guild,
    type: "category" | "voice" | "text",
    name: string,
  ): Promise<boolean> {
    try {
      switch (type) {
        case "category":
          return (await this.findCategoryByName(guild, name)) !== null;
        case "voice":
          return (await this.findVoiceChannelByName(guild, name)) !== null;
        case "text":
          return (await this.findTextChannelByName(guild, name)) !== null;
        default:
          return false;
      }
    } catch (error) {
      logger.error("Error checking resource existence:", error);
      return false;
    }
  }
}
