import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
} from "discord.js";
import { ConfigService } from "../../services/config-service.js";
import { defaultConfig } from "../../services/config-schema.js";
import logger from "../../utils/logger.js";

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

// Helper function to get display name for category
function getCategoryDisplayName(category: string): string {
  const displayNames: Record<string, string> = {
    voicechannels: "Voice Channels",
    voicetracking: "Voice Tracking",
    ping: "Ping",
    amikool: "Amikool",
    plexprice: "PLEX Price",
    quotes: "Quotes",
  };
  return displayNames[category] || category;
}

// Helper function to get all settings from the new schema
function getAllSettingsFromSchema(): Array<{
  key: string;
  value: string | number | boolean;
  category: string;
  description: string;
}> {
  const settings: Array<{
    key: string;
    value: string | number | boolean;
    category: string;
    description: string;
  }> = [];

  // Add all settings from the default config
  for (const [key, value] of Object.entries(defaultConfig)) {
    const category = key.split(".")[0];
    settings.push({
      key,
      value,
      category,
      description: getSettingDescription(key),
    });
  }

  return settings;
}

// Helper function to get setting descriptions
function getSettingDescription(key: string): string {
  const descriptions: Record<string, string> = {
    // Voice Channels
    "voicechannels.enabled": "Enable/disable dynamic voice channel management",
    "voicechannels.category.name": "Name of the category for voice channels",
    "voicechannels.lobby.name": "Name of the lobby channel",
    "voicechannels.lobby.offlinename": "Name of the offline lobby channel",
    "voicechannels.channel.prefix": "Prefix for dynamically created channels",
    "voicechannels.channel.suffix": "Suffix for dynamically created channels",

    // Voice Tracking
    "voicetracking.enabled": "Enable/disable voice activity tracking",
    "voicetracking.seen.enabled": "Enable/disable last seen tracking",
    "voicetracking.excluded_channels":
      "Comma-separated list of voice channel IDs to exclude from tracking",
    "voicetracking.announcements.enabled":
      "Enable/disable weekly voice channel announcements",
    "voicetracking.announcements.schedule":
      "Cron expression for weekly announcements",
    "voicetracking.announcements.channel":
      "Channel name for voice channel announcements",
    "voicetracking.admin_roles":
      "Comma-separated role names that can manage tracking",

    // Individual Features
    "ping.enabled": "Enable/disable ping command",
    "amikool.enabled": "Enable/disable amikool command",
    "amikool.role.name": "Role name required to use amikool command",
    "plexprice.enabled": "Enable/disable PLEX price checker",

    // Quote System
    "quotes.enabled": "Enable/disable quote system",
    "quotes.add_roles": "Comma-separated role IDs that can add quotes",
    "quotes.delete_roles": "Comma-separated role IDs that can delete quotes",
    "quotes.max_length": "Maximum quote length",
    "quotes.cooldown": "Cooldown in seconds between quote additions",
  };

  return descriptions[key] || "No description available";
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
            { name: "Voice Channels", value: "voicechannels" },
            { name: "Voice Tracking", value: "voicetracking" },
            { name: "Ping", value: "ping" },
            { name: "Amikool", value: "amikool" },
            { name: "PLEX Price", value: "plexprice" },
            { name: "Quotes", value: "quotes" },
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
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("redeploy")
      .setDescription(
        "Redeploy all commands to Discord API (use after changing command settings)",
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

    // Get all settings from the new schema
    let allSettings = getAllSettingsFromSchema();

    // Filter by category if specified
    if (category) {
      allSettings = allSettings.filter(
        (setting) => setting.category === category,
      );
    }

    const embed = new EmbedBuilder()
      .setTitle("Configuration Settings")
      .setColor(0x0099ff)
      .setTimestamp();

    if (allSettings.length === 0) {
      embed.setDescription("No configuration settings found.");
    } else {
      // Group settings by category
      const groupedSettings = allSettings.reduce(
        (acc, setting) => {
          if (!acc[setting.category]) {
            acc[setting.category] = [];
          }
          acc[setting.category].push(setting);
          return acc;
        },
        {} as Record<string, typeof allSettings>,
      );

      for (const [category, settings] of Object.entries(groupedSettings)) {
        const categoryName = getCategoryDisplayName(category);
        const valueList = await Promise.all(
          settings.map(async (setting) => {
            // Try to get the actual value from the database, fallback to default
            let actualValue = setting.value;
            try {
              const dbValue = await configService.get(setting.key);
              if (dbValue !== null && dbValue !== undefined) {
                actualValue = dbValue as string | number | boolean;
              }
            } catch (error) {
              // If there's an error getting from DB, use the default value
              logger.debug(`Using default value for ${setting.key}: ${error}`);
            }

            const value = isRoleOrChannelSetting(setting.key)
              ? await formatAsMentions(String(actualValue), interaction)
              : String(actualValue);
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

    // Check if the key exists in our schema
    const allSettings = getAllSettingsFromSchema();
    const settingInfo = allSettings.find((s) => s.key === key);

    if (!settingInfo) {
      await interaction.reply({
        content: `Configuration key '${key}' not found in the schema.`,
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

    // Use the setting info from the schema instead of looking in the database
    await configService.set(
      key,
      value,
      settingInfo.description,
      settingInfo.category,
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

async function handleRedeploy(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    await interaction.reply({
      content: "Redeploying commands to Discord API... This may take a moment.",
      ephemeral: true,
    });

    // Get the command manager instance and force a redeploy
    const { CommandManager } = await import(
      "../../services/command-manager.js"
    );
    const commandManager = CommandManager.getInstance(interaction.client);

    // Redeploy commands to Discord API
    await commandManager.registerCommands();

    // Update client-side command handling
    await commandManager.populateClientCommands();

    const embed = new EmbedBuilder()
      .setTitle("Commands Redeployed")
      .setColor(0x00ff00)
      .setDescription(
        "All commands have been redeployed to Discord API with current settings.",
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    logger.error("Error redeploying commands:", error);
    await interaction.editReply({
      content: "An error occurred while redeploying commands.",
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
    case "redeploy":
      await handleRedeploy(interaction);
      break;
    default:
      await interaction.reply({
        content: "Unknown subcommand.",
        ephemeral: true,
      });
  }
}
