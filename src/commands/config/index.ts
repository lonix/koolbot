import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { ConfigService } from "../../services/config-service.js";
import Logger from "../../utils/logger.js";

const logger = Logger.getInstance();
const configService = ConfigService.getInstance();

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
        option.setName("value").setDescription("New value").setRequired(true),
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
        const valueList = settings
          .map((setting) => `**${setting.key}**: ${setting.value}`)
          .join("\n");
        embed.addFields({ name: categoryName, value: valueList });
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

    const embed = new EmbedBuilder()
      .setTitle(`Configuration: ${key}`)
      .setColor(0x0099ff)
      .addFields({ name: "Value", value: String(value) })
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
    const value = interaction.options.getString("value", true);

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

    await configService.set(
      key,
      value,
      currentConfig.description,
      currentConfig.category,
    );

    const embed = new EmbedBuilder()
      .setTitle("Configuration Updated")
      .setColor(0x00ff00)
      .addFields(
        { name: "Key", value: key },
        { name: "New Value", value: value },
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
