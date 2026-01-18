import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { ScheduledAnnouncementService } from "../services/scheduled-announcement-service.js";
import logger from "../utils/logger.js";
import { ConfigService } from "../services/config-service.js";

const configService = ConfigService.getInstance();

export const data = new SlashCommandBuilder()
  .setName("announce")
  .setDescription("Manage scheduled announcements")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("create")
      .setDescription("Create a new scheduled announcement")
      .addStringOption((option) =>
        option
          .setName("cron")
          .setDescription(
            "Cron schedule (e.g., '0 9 * * *' for daily at 9 AM)",
          )
          .setRequired(true),
      )
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("Channel to send announcements to")
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("message")
          .setDescription("Message content (supports placeholders)")
          .setRequired(true),
      )
      .addBooleanOption((option) =>
        option
          .setName("placeholders")
          .setDescription(
            "Enable placeholders like {server_name}, {member_count}, {date}, {time}",
          )
          .setRequired(false),
      )
      .addStringOption((option) =>
        option
          .setName("embed_title")
          .setDescription("Optional embed title")
          .setRequired(false),
      )
      .addStringOption((option) =>
        option
          .setName("embed_description")
          .setDescription("Optional embed description")
          .setRequired(false),
      )
      .addStringOption((option) =>
        option
          .setName("embed_color")
          .setDescription("Optional embed color (hex code, e.g., #FF0000)")
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("list")
      .setDescription("List all scheduled announcements"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("delete")
      .setDescription("Delete a scheduled announcement")
      .addStringOption((option) =>
        option
          .setName("id")
          .setDescription("Announcement ID to delete")
          .setRequired(true),
      ),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "create") {
      await handleCreate(interaction);
    } else if (subcommand === "list") {
      await handleList(interaction);
    } else if (subcommand === "delete") {
      await handleDelete(interaction);
    }
  } catch (error) {
    logger.error("Error executing announce command:", error);
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

  const cron = interaction.options.getString("cron", true);
  const channel = interaction.options.getChannel("channel", true);
  const message = interaction.options.getString("message", true);
  const placeholders = interaction.options.getBoolean("placeholders") ?? false;
  const embedTitle = interaction.options.getString("embed_title");
  const embedDescription = interaction.options.getString("embed_description");
  const embedColorHex = interaction.options.getString("embed_color");

  if (!interaction.guildId) {
    await interaction.editReply({
      content: "❌ This command can only be used in a server.",
    });
    return;
  }

  // Validate cron expression
  try {
    const { CronTime } = await import("cron");
    new CronTime(cron);
  } catch (error) {
    await interaction.editReply({
      content: `❌ Invalid cron expression: ${cron}\n\nExamples:\n- \`0 9 * * *\` - Daily at 9 AM\n- \`0 12 * * 1\` - Every Monday at noon\n- \`0 0 * * 0\` - Every Sunday at midnight`,
    });
    return;
  }

  const service = ScheduledAnnouncementService.getInstance(interaction.client);

  // Build embed data if provided
  let embedData = undefined;
  if (embedTitle || embedDescription || embedColorHex) {
    embedData = {
      title: embedTitle ?? undefined,
      description: embedDescription ?? undefined,
      color: embedColorHex
        ? parseInt(embedColorHex.replace("#", ""), 16)
        : undefined,
    };
  }

  const announcement = await service.createAnnouncement({
    guildId: interaction.guildId,
    channelId: channel.id,
    cronSchedule: cron,
    message,
    embedData,
    placeholders,
    enabled: true,
    createdBy: interaction.user.id,
  } as any);

  const embed = new EmbedBuilder()
    .setColor(0x00ff00)
    .setTitle("✅ Announcement Created")
    .setDescription(`Announcement ID: \`${announcement._id}\``)
    .addFields(
      { name: "Channel", value: `<#${channel.id}>`, inline: true },
      { name: "Schedule", value: `\`${cron}\``, inline: true },
      {
        name: "Placeholders",
        value: placeholders ? "Enabled" : "Disabled",
        inline: true,
      },
      { name: "Message", value: message },
    );

  if (embedData) {
    embed.addFields({
      name: "Embed",
      value: `Title: ${embedTitle || "None"}\nDescription: ${embedDescription || "None"}\nColor: ${embedColorHex || "None"}`,
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

  const service = ScheduledAnnouncementService.getInstance(interaction.client);
  const announcements = await service.listAnnouncements(interaction.guildId);

  if (announcements.length === 0) {
    await interaction.editReply({
      content: "📭 No scheduled announcements found.",
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0x0099ff)
    .setTitle("📢 Scheduled Announcements")
    .setDescription(`Total: ${announcements.length} announcement(s)`);

  // Show up to 10 announcements
  const displayAnnouncements = announcements.slice(0, 10);
  for (const announcement of displayAnnouncements) {
    const status = announcement.enabled ? "✅" : "❌";
    const channelMention = `<#${announcement.channelId}>`;
    const truncatedMessage =
      announcement.message.length > 100
        ? announcement.message.substring(0, 100) + "..."
        : announcement.message;

    embed.addFields({
      name: `${status} ${announcement._id}`,
      value: `**Channel:** ${channelMention}\n**Schedule:** \`${announcement.cronSchedule}\`\n**Message:** ${truncatedMessage}`,
    });
  }

  if (announcements.length > 10) {
    embed.setFooter({
      text: `Showing 10 of ${announcements.length} announcements`,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

async function handleDelete(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const announcementId = interaction.options.getString("id", true);

  const service = ScheduledAnnouncementService.getInstance(interaction.client);
  const deleted = await service.deleteAnnouncement(announcementId);

  if (deleted) {
    await interaction.editReply({
      content: `✅ Announcement \`${announcementId}\` has been deleted.`,
    });
  } else {
    await interaction.editReply({
      content: `❌ Announcement \`${announcementId}\` not found.`,
    });
  }
}
