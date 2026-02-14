import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
} from "discord.js";
import { PollService } from "../services/poll-service.js";
import { IPollSchedule } from "../models/poll-schedule.js";
import { IPollItem } from "../models/poll-item.js";
import logger from "../utils/logger.js";

export const data = new SlashCommandBuilder()
  .setName("poll")
  .setDescription("Manage periodic polls for icebreaker discussions")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("create")
      .setDescription("Create a new poll schedule")
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("Channel to post polls in")
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildText),
      )
      .addStringOption((option) =>
        option
          .setName("schedule")
          .setDescription("Cron schedule (e.g., '0 12 * * *' for daily at noon)")
          .setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName("duration")
          .setDescription("Poll duration in hours (1-768, default 24)")
          .setMinValue(1)
          .setMaxValue(768)
          .setRequired(false),
      )
      .addRoleOption((option) =>
        option
          .setName("ping_role")
          .setDescription("Role to ping when posting polls (optional)")
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("list")
      .setDescription("List all poll schedules"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("delete")
      .setDescription("Delete a poll schedule")
      .addStringOption((option) =>
        option
          .setName("id")
          .setDescription("Schedule ID to delete")
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("test")
      .setDescription("Post a poll immediately from a schedule")
      .addStringOption((option) =>
        option
          .setName("schedule_id")
          .setDescription("Schedule ID to test")
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("add-item")
      .setDescription("Add a poll question to the database")
      .addStringOption((option) =>
        option
          .setName("question")
          .setDescription("Poll question (max 300 characters)")
          .setRequired(true)
          .setMaxLength(300),
      )
      .addStringOption((option) =>
        option
          .setName("answers")
          .setDescription("Comma-separated answers (2-10 options)")
          .setRequired(true),
      )
      .addBooleanOption((option) =>
        option
          .setName("multiselect")
          .setDescription("Allow multiple answer selections (default: false)")
          .setRequired(false),
      )
      .addStringOption((option) =>
        option
          .setName("tags")
          .setDescription("Comma-separated tags (e.g., icebreaker,funny)")
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("list-items")
      .setDescription("List all poll questions in the database"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("delete-item")
      .setDescription("Delete a poll question")
      .addStringOption((option) =>
        option
          .setName("id")
          .setDescription("Poll item ID to delete")
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("import-url")
      .setDescription("Import poll questions from a URL (YAML or JSON)")
      .addStringOption((option) =>
        option
          .setName("url")
          .setDescription("URL to YAML or JSON file with poll questions")
          .setRequired(true),
      ),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
      case "create":
        await handleCreate(interaction);
        break;
      case "list":
        await handleList(interaction);
        break;
      case "delete":
        await handleDelete(interaction);
        break;
      case "test":
        await handleTest(interaction);
        break;
      case "add-item":
        await handleAddItem(interaction);
        break;
      case "list-items":
        await handleListItems(interaction);
        break;
      case "delete-item":
        await handleDeleteItem(interaction);
        break;
      case "import-url":
        await handleImportUrl(interaction);
        break;
    }
  } catch (error) {
    logger.error("Error executing poll command:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error occurred";
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply({
        content: `❌ Error: ${errorMessage}`,
      });
    } else {
      await interaction.reply({
        content: `❌ Error: ${errorMessage}`,
        ephemeral: true,
      });
    }
  }
}

async function handleCreate(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const channel = interaction.options.getChannel("channel", true);
  const schedule = interaction.options.getString("schedule", true);
  const duration = interaction.options.getInteger("duration") ?? 24;
  const pingRole = interaction.options.getRole("ping_role");

  if (!interaction.guildId) {
    await interaction.editReply({
      content: "❌ This command can only be used in a server.",
    });
    return;
  }

  // Validate cron expression
  try {
    const { CronTime } = await import("cron");
    new CronTime(schedule);
  } catch {
    await interaction.editReply({
      content: `❌ Invalid cron expression: ${schedule}\n\nExamples:\n- \`0 9 * * *\` - Daily at 9 AM\n- \`0 12 * * 1\` - Every Monday at noon\n- \`0 0 * * 0\` - Every Sunday at midnight`,
    });
    return;
  }

  const service = PollService.getInstance(interaction.client);

  const pollSchedule = await service.createSchedule({
    guildId: interaction.guildId,
    channelId: channel.id,
    cronSchedule: schedule,
    pollDuration: duration,
    roleIdToPing: pingRole?.id ?? null,
    enabled: true,
    createdBy: interaction.user.id,
  } as Omit<IPollSchedule, "createdAt" | "updatedAt" | "lastRun">);

  const embed = new EmbedBuilder()
    .setColor(0x00ff00)
    .setTitle("✅ Poll Schedule Created")
    .setDescription(`Schedule ID: \`${pollSchedule._id}\``)
    .addFields(
      { name: "Channel", value: `<#${channel.id}>`, inline: true },
      { name: "Schedule", value: `\`${schedule}\``, inline: true },
      { name: "Duration", value: `${duration} hours`, inline: true },
    );

  if (pingRole) {
    embed.addFields({
      name: "Ping Role",
      value: `<@&${pingRole.id}>`,
      inline: true,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

async function handleList(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  if (!interaction.guildId) {
    await interaction.editReply({
      content: "❌ This command can only be used in a server.",
    });
    return;
  }

  const service = PollService.getInstance(interaction.client);
  const schedules = await service.listSchedules(interaction.guildId);

  if (schedules.length === 0) {
    await interaction.editReply({
      content: "📭 No poll schedules found.",
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0x0099ff)
    .setTitle("📊 Poll Schedules")
    .setDescription(`Total: ${schedules.length} schedule(s)`);

  // Show up to 10 schedules
  const displaySchedules = schedules.slice(0, 10);
  for (const sched of displaySchedules) {
    const status = sched.enabled ? "✅" : "❌";
    const channelMention = `<#${sched.channelId}>`;
    const roleMention = sched.roleIdToPing
      ? `<@&${sched.roleIdToPing}>`
      : "None";
    const lastRun = sched.lastRun
      ? new Date(sched.lastRun).toLocaleString()
      : "Never";

    embed.addFields({
      name: `${status} ${sched._id}`,
      value: `**Channel:** ${channelMention}\n**Schedule:** \`${sched.cronSchedule}\`\n**Duration:** ${sched.pollDuration}h\n**Ping Role:** ${roleMention}\n**Last Run:** ${lastRun}`,
    });
  }

  if (schedules.length > 10) {
    embed.setFooter({
      text: `Showing 10 of ${schedules.length} schedules`,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

async function handleDelete(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const scheduleId = interaction.options.getString("id", true);

  if (!interaction.guildId) {
    await interaction.editReply({
      content: "❌ This command can only be used in a server.",
    });
    return;
  }

  const service = PollService.getInstance(interaction.client);
  const deleted = await service.deleteSchedule(scheduleId, interaction.guildId);

  if (deleted) {
    await interaction.editReply({
      content: `✅ Poll schedule \`${scheduleId}\` has been deleted.`,
    });
  } else {
    await interaction.editReply({
      content: `❌ Poll schedule \`${scheduleId}\` not found or access denied.`,
    });
  }
}

async function handleTest(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const scheduleId = interaction.options.getString("schedule_id", true);

  const service = PollService.getInstance(interaction.client);

  try {
    await service.testSchedule(scheduleId);
    await interaction.editReply({
      content: `✅ Test poll posted successfully from schedule \`${scheduleId}\``,
    });
  } catch (error) {
    await interaction.editReply({
      content: `❌ Error: ${error instanceof Error ? error.message : "Unknown error"}`,
    });
  }
}

async function handleAddItem(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const question = interaction.options.getString("question", true);
  const answersStr = interaction.options.getString("answers", true);
  const multiSelect = interaction.options.getBoolean("multiselect") ?? false;
  const tagsStr = interaction.options.getString("tags");

  if (!interaction.guildId) {
    await interaction.editReply({
      content: "❌ This command can only be used in a server.",
    });
    return;
  }

  // Parse answers
  const answers = answersStr.split(",").map((a) => a.trim()).filter((a) => a);

  if (answers.length < 2 || answers.length > 10) {
    await interaction.editReply({
      content: "❌ Poll must have between 2 and 10 answers.",
    });
    return;
  }

  // Parse tags
  const tags = tagsStr
    ? tagsStr.split(",").map((t) => t.trim()).filter((t) => t)
    : [];

  const service = PollService.getInstance(interaction.client);

  const pollItem = await service.createPollItem({
    guildId: interaction.guildId,
    question,
    answers,
    multiSelect,
    tags,
    enabled: true,
    createdBy: interaction.user.id,
    source: "manual",
  } as Omit<IPollItem, "createdAt" | "updatedAt" | "usageCount" | "lastUsed">);

  const embed = new EmbedBuilder()
    .setColor(0x00ff00)
    .setTitle("✅ Poll Question Added")
    .setDescription(`Poll ID: \`${pollItem._id}\``)
    .addFields(
      { name: "Question", value: question },
      { name: "Answers", value: answers.join(", ") },
      { name: "Multi-Select", value: multiSelect ? "Yes" : "No", inline: true },
    );

  if (tags.length > 0) {
    embed.addFields({ name: "Tags", value: tags.join(", "), inline: true });
  }

  await interaction.editReply({ embeds: [embed] });
}

async function handleListItems(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  if (!interaction.guildId) {
    await interaction.editReply({
      content: "❌ This command can only be used in a server.",
    });
    return;
  }

  const service = PollService.getInstance(interaction.client);
  const items = await service.listPollItems(interaction.guildId);

  if (items.length === 0) {
    await interaction.editReply({
      content: "📭 No poll questions found.",
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0x0099ff)
    .setTitle("📊 Poll Questions")
    .setDescription(`Total: ${items.length} question(s)`);

  // Show up to 10 items
  const displayItems = items.slice(0, 10);
  for (const item of displayItems) {
    const status = item.enabled ? "✅" : "❌";
    const truncatedQuestion =
      item.question.length > 100
        ? item.question.substring(0, 100) + "..."
        : item.question;
    const lastUsed = item.lastUsed
      ? new Date(item.lastUsed).toLocaleString()
      : "Never";

    embed.addFields({
      name: `${status} ${item._id}`,
      value: `**Q:** ${truncatedQuestion}\n**Answers:** ${item.answers.length}\n**Used:** ${item.usageCount} times\n**Last:** ${lastUsed}`,
    });
  }

  if (items.length > 10) {
    embed.setFooter({
      text: `Showing 10 of ${items.length} questions`,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

async function handleDeleteItem(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const itemId = interaction.options.getString("id", true);

  if (!interaction.guildId) {
    await interaction.editReply({
      content: "❌ This command can only be used in a server.",
    });
    return;
  }

  const service = PollService.getInstance(interaction.client);
  const deleted = await service.deletePollItem(itemId, interaction.guildId);

  if (deleted) {
    await interaction.editReply({
      content: `✅ Poll question \`${itemId}\` has been deleted.`,
    });
  } else {
    await interaction.editReply({
      content: `❌ Poll question \`${itemId}\` not found or access denied.`,
    });
  }
}

async function handleImportUrl(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const url = interaction.options.getString("url", true);

  if (!interaction.guildId) {
    await interaction.editReply({
      content: "❌ This command can only be used in a server.",
    });
    return;
  }

  // Validate URL format
  try {
    // eslint-disable-next-line no-undef
    new URL(url);
  } catch {
    await interaction.editReply({
      content: "❌ Invalid URL format.",
    });
    return;
  }

  await interaction.editReply({
    content: "⏳ Importing polls from URL... This may take a moment.",
  });

  const service = PollService.getInstance(interaction.client);
  const results = await service.importFromUrl(
    url,
    interaction.guildId,
    interaction.user.id,
  );

  const embed = new EmbedBuilder()
    .setColor(results.errors.length > 0 ? 0xffa500 : 0x00ff00)
    .setTitle("📥 Import Results")
    .addFields(
      {
        name: "Imported",
        value: results.imported.toString(),
        inline: true,
      },
      { name: "Skipped", value: results.skipped.toString(), inline: true },
      {
        name: "Errors",
        value: results.errors.length.toString(),
        inline: true,
      },
    );

  if (results.errors.length > 0) {
    const errorText = results.errors.slice(0, 5).join("\n");
    embed.addFields({
      name: "Error Details",
      value: errorText.substring(0, 1024),
    });

    if (results.errors.length > 5) {
      embed.setFooter({
        text: `Showing first 5 of ${results.errors.length} errors`,
      });
    }
  }

  await interaction.editReply({ embeds: [embed], content: null });
}
