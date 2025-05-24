import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
} from "discord.js";
import { ConfigService } from "../../services/config-service.js";
import Logger from "../../utils/logger.js";

const logger = Logger.getInstance();
const configService = ConfigService.getInstance();

// Helper function to check if a key is a role or channel setting
function isRoleOrChannelSetting(key: string): boolean {
  return (
    key.includes("role") ||
    key.includes("channel") ||
    key.includes("_roles") ||
    key.includes("_channels")
  );
}

// Helper function to extract IDs from mentions
function extractIds(value: string): string {
  // Match role mentions <@&123456789>
  const roleMatches = value.match(/<@&(\d+)>/g);
  if (roleMatches) {
    return roleMatches
      .map((match) => match.match(/\d+/)?.[0])
      .filter(Boolean)
      .join(",");
  }

  // Match channel mentions <#123456789>
  const channelMatches = value.match(/<#(\d+)>/g);
  if (channelMatches) {
    return channelMatches
      .map((match) => match.match(/\d+/)?.[0])
      .filter(Boolean)
      .join(",");
  }

  // If no mentions, return the original value
  return value;
}

// Helper function to format IDs as mentions
async function formatAsMentions(
  value: string,
  interaction: ChatInputCommandInteraction,
): Promise<string> {
  if (!value) return "None";

  const ids = value.split(",").filter(Boolean);
  if (ids.length === 0) return "None";

  // Ensure client is ready
  if (!interaction.client.isReady()) {
    logger.error("Discord client is not ready");
    return value;
  }

  // Ensure guild is available
  if (!interaction.guild) {
    logger.error("Guild not available");
    return value;
  }

  // Fetch guild data if needed
  await interaction.guild.fetch();

  return ids
    .map((id) => {
      // Try to find a role
      const role = interaction.guild?.roles.cache.get(id);
      if (role) return role.toString();

      // Try to find a channel
      const channel = interaction.guild?.channels.cache.get(id);
      if (channel) return channel.toString();

      // If not found, return the ID
      return id;
    })
    .join(", ");
}

export const data = new SlashCommandBuilder()
  .setName("config")
  .setDescription("Manage bot configuration")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("list")
      .setDescription("List all configuration settings")
      .addStringOption((option) =>
        option
          .setName("category")
          .setDescription("Filter by category")
          .setRequired(false)
          .addChoices(
            { name: "Voice Channel", value: "voice_channel" },
            { name: "Tracking", value: "tracking" },
            { name: "Announcements", value: "announcements" },
            { name: "Roles", value: "roles" },
            { name: "Features", value: "features" },
            { name: "System", value: "system" },
          ),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("get")
      .setDescription("Get a specific configuration value")
      .addStringOption((option) =>
        option
          .setName("key")
          .setDescription("Configuration key")
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("set")
      .setDescription("Set a configuration value")
      .addStringOption((option) =>
        option
          .setName("key")
          .setDescription("Configuration key")
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("value")
          .setDescription("New value (use @mentions for roles/channels)")
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("reset")
      .setDescription("Reset a configuration value to default")
      .addStringOption((option) =>
        option
          .setName("key")
          .setDescription("Configuration key")
          .setRequired(true),
      ),
  );

async function handleList(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    // Ensure client is ready
    if (!interaction.client.isReady()) {
      await interaction.reply({
        content: "Bot is still initializing. Please try again in a moment.",
        ephemeral: true,
      });
      return;
    }

    const category = interaction.options.getString("category");
    const configs = category
      ? await configService.getByCategory(category)
      : await configService.getAll();

    const embed = new EmbedBuilder()
      .setTitle("Configuration Settings")
      .setColor(0x0099ff)
      .setTimestamp();

    if (configs.length === 0) {
      embed.setDescription("No configuration settings found.");
    } else {
      const groupedConfigs = configs.reduce(
        (acc, config) => {
          if (!acc[config.category]) {
            acc[config.category] = [];
          }
          acc[config.category].push(config);
          return acc;
        },
        {} as Record<string, typeof configs>,
      );

      for (const [category, settings] of Object.entries(groupedConfigs)) {
        const categoryName = category
          .split("_")
          .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
          .join(" ");
        const valueList = await Promise.all(
          settings.map(async (setting) => {
            const value = isRoleOrChannelSetting(setting.key)
              ? await formatAsMentions(String(setting.value), interaction)
              : String(setting.value);
            return `**${setting.key}**: ${value}`;
          }),
        );
        embed.addFields({ name: categoryName, value: valueList.join("\n") });
      }
    }

    await interaction.reply({ embeds: [embed], ephemeral: true });
  } catch (error) {
    logger.error("Error listing configuration:", error);
    await interaction.reply({
      content: "An error occurred while listing configuration settings.",
      ephemeral: true,
    });
  }
}

async function handleGet(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    const key = interaction.options.getString("key", true);
    const value = await configService.get(key);

    const formattedValue = isRoleOrChannelSetting(key)
      ? await formatAsMentions(String(value), interaction)
      : String(value);

    const embed = new EmbedBuilder()
      .setTitle(`Configuration: ${key}`)
      .setColor(0x0099ff)
      .addFields({ name: "Value", value: formattedValue })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  } catch (error) {
    logger.error("Error getting configuration:", error);
    await interaction.reply({
      content: "An error occurred while getting the configuration value.",
      ephemeral: true,
    });
  }
}

async function handleSet(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    const key = interaction.options.getString("key", true);
    const rawValue = interaction.options.getString("value", true);

    // Get the current config to get its category and description
    const configs = await configService.getAll();
    const currentConfig = configs.find((c) => c.key === key);

    if (!currentConfig) {
      await interaction.reply({
        content: `Configuration key '${key}' not found.`,
        ephemeral: true,
      });
      return;
    }

    // Extract IDs from mentions if it's a role or channel setting
    const value = isRoleOrChannelSetting(key) ? extractIds(rawValue) : rawValue;

    // Validate roles and channels if applicable
    if (isRoleOrChannelSetting(key)) {
      const ids = value.split(",").filter(Boolean);
      const invalidIds: string[] = [];

      for (const id of ids) {
        const role = interaction.guild?.roles.cache.get(id);
        const channel = interaction.guild?.channels.cache.get(id);

        if (!role && !channel) {
          invalidIds.push(id);
        }
      }

      if (invalidIds.length > 0) {
        await interaction.reply({
          content: `Invalid role or channel IDs found: ${invalidIds.join(", ")}. Please make sure all roles and channels exist in this server.`,
          ephemeral: true,
        });
        return;
      }

      // Additional validation for specific settings
      if (key.includes("channel")) {
        const channel = interaction.guild?.channels.cache.get(ids[0]);
        if (channel) {
          // Validate channel type for specific settings
          if (
            key.includes("voice") &&
            channel.type !== ChannelType.GuildVoice
          ) {
            await interaction.reply({
              content: "This setting requires a voice channel.",
              ephemeral: true,
            });
            return;
          }
          if (key.includes("text") && channel.type !== ChannelType.GuildText) {
            await interaction.reply({
              content: "This setting requires a text channel.",
              ephemeral: true,
            });
            return;
          }
        }
      }
    }

    await configService.set(
      key,
      value,
      currentConfig.description,
      currentConfig.category,
    );

    const formattedValue = isRoleOrChannelSetting(key)
      ? await formatAsMentions(value, interaction)
      : value;

    const embed = new EmbedBuilder()
      .setTitle("Configuration Updated")
      .setColor(0x00ff00)
      .addFields(
        { name: "Key", value: key },
        { name: "New Value", value: formattedValue },
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  } catch (error) {
    logger.error("Error setting configuration:", error);
    await interaction.reply({
      content: "An error occurred while setting the configuration value.",
      ephemeral: true,
    });
  }
}

async function handleReset(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    const key = interaction.options.getString("key", true);
    await configService.delete(key);

    const embed = new EmbedBuilder()
      .setTitle("Configuration Reset")
      .setColor(0x00ff00)
      .addFields({ name: "Key", value: key })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  } catch (error) {
    logger.error("Error resetting configuration:", error);
    await interaction.reply({
      content: "An error occurred while resetting the configuration value.",
      ephemeral: true,
    });
  }
}

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case "list":
      await handleList(interaction);
      break;
    case "get":
      await handleGet(interaction);
      break;
    case "set":
      await handleSet(interaction);
      break;
    case "reset":
      await handleReset(interaction);
      break;
    default:
      await interaction.reply({
        content: "Unknown subcommand.",
        ephemeral: true,
      });
  }
}
