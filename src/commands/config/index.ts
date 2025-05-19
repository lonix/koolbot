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
        option
          .setName("value")
          .setDescription("New value")
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("reset")
      .setDescription("Reset a configuration to its default value")
      .addStringOption((option) =>
        option
          .setName("key")
          .setDescription("Configuration key")
          .setRequired(true),
      ),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  try {
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
    }
  } catch (error) {
    logger.error("Error in config command:", error);
    await interaction.reply({
      content: "An error occurred while processing the command.",
      ephemeral: true,
    });
  }
}

async function handleList(interaction: ChatInputCommandInteraction) {
  const category = interaction.options.getString("category");
  const configs = category
    ? await configService.getByCategory(category)
    : await configService.getAll();

  const embed = new EmbedBuilder()
    .setTitle("Bot Configuration")
    .setColor(0x0099ff)
    .setTimestamp();

  if (category) {
    embed.setDescription(`Configuration for category: ${category}`);
  }

  // Group configs by category
  const groupedConfigs = configs.reduce((acc, config) => {
    if (!acc[config.category]) {
      acc[config.category] = [];
    }
    acc[config.category].push(config);
    return acc;
  }, {} as Record<string, typeof configs>);

  for (const [cat, configs] of Object.entries(groupedConfigs)) {
    const valueList = configs
      .map(
        (config) =>
          `**${config.key}**: \`${config.value}\`\n${config.description}`,
      )
      .join("\n\n");
    embed.addFields({ name: cat, value: valueList || "No settings" });
  }

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleGet(interaction: ChatInputCommandInteraction) {
  const key = interaction.options.getString("key", true);
  try {
    const value = await configService.get(key);
    const config = (await configService.getAll()).find((c) => c.key === key);

    const embed = new EmbedBuilder()
      .setTitle(`Configuration: ${key}`)
      .setColor(0x0099ff)
      .addFields(
        { name: "Value", value: `\`${value}\`` },
        { name: "Category", value: config?.category || "Unknown" },
        { name: "Description", value: config?.description || "No description" },
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  } catch (error) {
    await interaction.reply({
      content: `Configuration key '${key}' not found.`,
      ephemeral: true,
    });
  }
}

async function handleSet(interaction: ChatInputCommandInteraction) {
  const key = interaction.options.getString("key", true);
  const value = interaction.options.getString("value", true);
  const config = (await configService.getAll()).find((c) => c.key === key);

  if (!config) {
    await interaction.reply({
      content: `Configuration key '${key}' not found.`,
      ephemeral: true,
    });
    return;
  }

  try {
    // Convert value to appropriate type
    let typedValue: string | number | boolean = value;
    if (value.toLowerCase() === "true") typedValue = true;
    else if (value.toLowerCase() === "false") typedValue = false;
    else if (!isNaN(Number(value))) typedValue = Number(value);

    await configService.set(key, typedValue, config.description, config.category);

    const embed = new EmbedBuilder()
      .setTitle("Configuration Updated")
      .setColor(0x00ff00)
      .addFields(
        { name: "Key", value: key },
        { name: "New Value", value: `\`${typedValue}\`` },
        { name: "Category", value: config.category },
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  } catch (error) {
    logger.error(`Error setting configuration ${key}:`, error);
    await interaction.reply({
      content: "An error occurred while updating the configuration.",
      ephemeral: true,
    });
  }
}

async function handleReset(interaction: ChatInputCommandInteraction) {
  const key = interaction.options.getString("key", true);
  const config = (await configService.getAll()).find((c) => c.key === key);

  if (!config) {
    await interaction.reply({
      content: `Configuration key '${key}' not found.`,
      ephemeral: true,
    });
    return;
  }

  try {
    // Get default value from environment
    const defaultValue = process.env[key];
    if (defaultValue === undefined) {
      await interaction.reply({
        content: `No default value found for '${key}'.`,
        ephemeral: true,
      });
      return;
    }

    // Convert default value to appropriate type
    let typedValue: string | number | boolean = defaultValue;
    if (defaultValue.toLowerCase() === "true") typedValue = true;
    else if (defaultValue.toLowerCase() === "false") typedValue = false;
    else if (!isNaN(Number(defaultValue))) typedValue = Number(defaultValue);

    await configService.set(key, typedValue, config.description, config.category);

    const embed = new EmbedBuilder()
      .setTitle("Configuration Reset")
      .setColor(0x00ff00)
      .addFields(
        { name: "Key", value: key },
        { name: "Reset Value", value: `\`${typedValue}\`` },
        { name: "Category", value: config.category },
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  } catch (error) {
    logger.error(`Error resetting configuration ${key}:`, error);
    await interaction.reply({
      content: "An error occurred while resetting the configuration.",
      ephemeral: true,
    });
  }
}
