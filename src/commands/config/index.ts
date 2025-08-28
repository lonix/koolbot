import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  AttachmentBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { Buffer } from "buffer";
import { ConfigService } from "../../services/config-service.js";
import { defaultConfig } from "../../services/config-schema.js";
import * as yaml from "js-yaml";
import logger from "../../utils/logger.js";

// Import fetch for Node.js compatibility
import fetch from "node-fetch";

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
    core: "Core",
    individual: "Individual Features",
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

    // Voice Channel Cleanup
    "voicetracking.cleanup.enabled":
      "Enable/disable automated voice channel data cleanup",
    "voicetracking.cleanup.schedule":
      "Cron schedule for automated cleanup (e.g., '0 0 * * *' for daily at midnight)",
    "voicetracking.cleanup.retention.detailed_sessions_days":
      "Number of days to keep detailed session data",
    "voicetracking.cleanup.retention.monthly_summaries_months":
      "Number of months to keep monthly summary data",
    "voicetracking.cleanup.retention.yearly_summaries_years":
      "Number of years to keep yearly summary data",

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

    // Core Bot Logging (Discord)
    "core.startup.enabled":
      "Enable/disable Discord logging for bot startup/shutdown events",
    "core.startup.channel_id":
      "Discord channel ID for startup/shutdown logging",
    "core.errors.enabled": "Enable/disable Discord logging for critical errors",
    "core.errors.channel_id": "Discord channel ID for error logging",
    "core.cleanup.enabled":
      "Enable/disable Discord logging for database cleanup results",
    "core.cleanup.channel_id": "Discord channel ID for cleanup logging",
    "core.config.enabled":
      "Enable/disable Discord logging for configuration changes",
    "core.config.channel_id": "Discord channel ID for config change logging",
    "core.cron.enabled":
      "Enable/disable Discord logging for scheduled task results",
    "core.cron.channel_id": "Discord channel ID for cron job logging",
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
          .setDescription("Show settings for specific category only")
          .setRequired(false)
          .addChoices(
            { name: "Voice Channels", value: "voicechannels" },
            { name: "Voice Tracking", value: "voicetracking" },
            { name: "Core", value: "core" },
            { name: "Individual Features", value: "individual" },
            { name: "Quote System", value: "quotes" },
          ),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("set")
      .setDescription("Set a configuration value")
      .addStringOption((option) =>
        option
          .setName("key")
          .setDescription("Configuration key (e.g., voicechannels.enabled)")
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("value")
          .setDescription("Configuration value")
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("import")
      .setDescription("Import configuration from YAML file")
      .addAttachmentOption((option) =>
        option
          .setName("file")
          .setDescription("YAML configuration file")
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("export")
      .setDescription("Export current configuration to YAML file")
      .addStringOption((option) =>
        option
          .setName("category")
          .setDescription("Export specific category only")
          .setRequired(false)
          .addChoices(
            { name: "All Categories", value: "all" },
            { name: "Voice Channels", value: "voicechannels" },
            { name: "Voice Tracking", value: "voicetracking" },
            { name: "Core", value: "core" },
            { name: "Individual Features", value: "individual" },
            { name: "Quote System", value: "quotes" },
          ),
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
      .setName("reload")
      .setDescription(
        "Reload all commands to Discord API (use after changing command settings)",
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

    // Defer the reply immediately to prevent timeout
    await interaction.deferReply({ ephemeral: true });

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
      // Batch fetch all settings from database at once
      const allDbValues = await configService.getAll();
      const dbValuesMap = new Map(
        allDbValues.map((config) => [config.key, config.value]),
      );

      // Pre-fetch guild data once to avoid repeated API calls
      if (interaction.guild) {
        await interaction.guild.fetch();
      }

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
            // Get value from database map, fallback to default
            let actualValue = setting.value;
            const dbValue = dbValuesMap.get(setting.key);
            if (dbValue !== null && dbValue !== undefined) {
              actualValue = dbValue as string | number | boolean;
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

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    logger.error("Error listing configuration:", error);
    await interaction.editReply({
      content: "An error occurred while listing configuration settings.",
    });
  }
}

async function handleSet(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    const key = interaction.options.getString("key", true);
    const value = interaction.options.getString("value", true);

    // Validate the key exists in our schema
    if (!(key in defaultConfig)) {
      await interaction.reply({
        content: `❌ Unknown configuration key: \`${key}\``,
        ephemeral: true,
      });
      return;
    }

    // Special handling for channel ID settings
    if (key.includes("channel_id")) {
      let channelId = value;

      // If it's a channel mention, extract the ID
      const channelMatch = value.match(/<#(\d+)>/);
      if (channelMatch) {
        channelId = channelMatch[1];
      } else if (value.startsWith("#")) {
        // If it's a channel name with #, try to find the channel
        const channelName = value.substring(1);
        const channel = interaction.guild?.channels.cache.find(
          (ch) => ch.name === channelName && ch.type === 0, // TextChannel type
        );
        if (channel) {
          channelId = channel.id;
        } else {
          await interaction.reply({
            content: `❌ Channel \`${channelName}\` not found. Please use a channel mention (#channel-name) or the actual channel ID.`,
            ephemeral: true,
          });
          return;
        }
      } else if (!/^\d+$/.test(value)) {
        // If it's not a numeric ID, provide guidance
        await interaction.reply({
          content: `❌ Invalid channel ID format. Please use:\n• Channel mention: #channel-name\n• Channel ID: 123456789012345678\n• Or right-click the channel and "Copy ID"`,
          ephemeral: true,
        });
        return;
      }

      // Validate the channel exists
      const channel = interaction.guild?.channels.cache.get(channelId);
      if (!channel || channel.type !== 0) {
        await interaction.reply({
          content: `❌ Channel with ID \`${channelId}\` not found or is not a text channel.`,
          ephemeral: true,
        });
        return;
      }

      // Store the numeric channel ID
      await configService.set(
        key,
        channelId,
        getSettingDescription(key),
        key.split(".")[0],
      );

      const embed = new EmbedBuilder()
        .setTitle("Configuration Updated")
        .setColor(0x00ff00)
        .addFields(
          { name: "Key", value: key, inline: true },
          {
            name: "Value",
            value: `${channel.toString()} (ID: ${channelId})`,
            inline: true,
          },
        )
        .setTimestamp();

      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }

    // For non-channel settings, use the original logic
    const extractedValue = extractIds(value);
    await configService.set(
      key,
      extractedValue,
      getSettingDescription(key),
      key.split(".")[0],
    );

    const embed = new EmbedBuilder()
      .setTitle("Configuration Updated")
      .setColor(0x00ff00)
      .addFields(
        { name: "Key", value: key, inline: true },
        {
          name: "Value",
          value: await formatAsMentions(extractedValue, interaction),
          inline: true,
        },
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

async function handleImport(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    const file = interaction.options.getAttachment("file", true);

    // Check if it's a YAML file
    if (!file.name?.endsWith('.yml') && !file.name?.endsWith('.yaml')) {
      await interaction.reply({
        content: "❌ Please upload a YAML file (.yml or .yaml extension).",
        ephemeral: true,
      });
      return;
    }

    // Fetch the file content from Discord's CDN
    const response = await fetch(file.url);
    if (!response.ok) {
      await interaction.reply({
        content: "❌ Failed to download the uploaded file.",
        ephemeral: true,
      });
      return;
    }

    const fileContent = await response.text();
    let importedConfig: Record<string, any>;

    try {
      importedConfig = yaml.load(fileContent) as Record<string, any>;
    } catch (error) {
      logger.error("Error parsing YAML file:", error);
      await interaction.reply({
        content: "❌ Failed to parse YAML file. Please ensure it's a valid YAML file.",
        ephemeral: true,
      });
      return;
    }

    if (!importedConfig || typeof importedConfig !== "object") {
      await interaction.reply({
        content: "❌ Invalid configuration format. Expected a YAML object.",
        ephemeral: true,
      });
      return;
    }

    // Validate and apply each setting
    const results: { key: string; success: boolean; message: string }[] = [];

    for (const [key, value] of Object.entries(importedConfig)) {
      try {
        // Check if the key exists in our schema
        if (key in defaultConfig) {
          // Validate the value type matches the schema
          const expectedType = typeof defaultConfig[key as keyof typeof defaultConfig];
          if (typeof value === expectedType) {
            // Get description and category from schema
            const description = getSettingDescription(key);
            const category = key.split(".")[0];
            await configService.set(key, value, description, category);
            results.push({ key, success: true, message: "✅ Updated" });
          } else {
            results.push({
              key,
              success: false,
              message: `❌ Type mismatch: expected ${expectedType}, got ${typeof value}`,
            });
          }
        } else {
          results.push({ key, success: false, message: "❌ Unknown setting" });
        }
      } catch (error) {
        results.push({
          key,
          success: false,
          message: `❌ Error: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    // Create results embed
    const embed = new EmbedBuilder()
      .setTitle("Configuration Import Results")
      .setColor(0x0099ff)
      .setDescription(`Processed ${results.length} configuration settings`)
      .setTimestamp();

    // Group results by success/failure
    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    if (successful.length > 0) {
      embed.addFields({
        name: `✅ Successfully Updated (${successful.length})`,
        value: successful.map((r) => `\`${r.key}\``).join("\n") || "None",
        inline: true,
      });
    }

    if (failed.length > 0) {
      embed.addFields({
        name: `❌ Failed to Update (${failed.length})`,
        value: failed.map((r) => `\`${r.key}\`: ${r.message}`).join("\n") || "None",
        inline: true,
      });
    }

    await interaction.reply({ embeds: [embed], ephemeral: true });
  } catch (error) {
    logger.error("Error importing configuration:", error);
    await interaction.reply({
      content: "An error occurred while importing the configuration.",
      ephemeral: true,
    });
  }
}

async function handleExport(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    const category = interaction.options.getString("category") || "all";

    // Get current configuration
    const currentConfig = await configService.getAll();
    logger.debug(`Retrieved ${currentConfig.length} configuration items`);
    const configMap = new Map(currentConfig.map((c) => [c.key, c.value]));

    // Get all settings from schema
    let allSettings = getAllSettingsFromSchema();

    // Filter by category if specified
    if (category !== "all") {
      allSettings = allSettings.filter(
        (setting) => setting.category === category,
      );
    }

    // Build export object with current values or defaults
    const exportConfig: Record<string, any> = {};

    for (const setting of allSettings) {
      if (configMap.has(setting.key)) {
        // Use current value
        exportConfig[setting.key] = configMap.get(setting.key);
      } else {
        // Use default value
        exportConfig[setting.key] = setting.value;
      }
    }

    // Convert to YAML
    const yamlContent = yaml.dump(exportConfig);
    logger.debug(`YAML export successful, length: ${yamlContent.length}`);

    // Create an AttachmentBuilder for the YAML content
    const attachment = new AttachmentBuilder(Buffer.from(yamlContent), {
      name: `config_${category === "all" ? "all" : getCategoryDisplayName(category).toLowerCase().replace(/\s+/g, '_')}.yaml`,
    });

    // Send the attachment
    await interaction.reply({
      files: [attachment],
      ephemeral: true,
    });

    logger.debug("Export response sent successfully");
  } catch (error) {
    logger.error("Error exporting configuration:", error);

    // Provide more specific error information
    const errorMessage = error instanceof Error ? error.message : String(error);
    await interaction.reply({
      content: `❌ Error exporting configuration: ${errorMessage}`,
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

async function handleReload(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    await interaction.reply({
      content: "Reloading commands to Discord API... This may take a moment.",
      ephemeral: true,
    });

    // Get the command manager instance and force a reload
    const { CommandManager } = await import(
      "../../services/command-manager.js"
    );
    const commandManager = CommandManager.getInstance(interaction.client);

    // Reload commands to Discord API
    await commandManager.registerCommands();

    // Update client-side command handling
    await commandManager.populateClientCommands();

    const embed = new EmbedBuilder()
      .setTitle("Commands Reloaded")
      .setColor(0x00ff00)
      .setDescription(
        "All commands have been reloaded to Discord API with current settings.",
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    logger.error("Error reloading commands:", error);
    await interaction.editReply({
      content: "An error occurred while reloading commands.",
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
    case "set":
      await handleSet(interaction);
      break;
    case "import":
      await handleImport(interaction);
      break;
    case "export":
      await handleExport(interaction);
      break;
    case "reset":
      await handleReset(interaction);
      break;
    case "reload":
      await handleReload(interaction);
      break;
    default:
      await interaction.reply({
        content: "Unknown subcommand.",
        ephemeral: true,
      });
  }
}
