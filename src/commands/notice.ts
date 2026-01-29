import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";
import logger from "../utils/logger.js";
import Notice from "../models/notice.js";
import { NoticesChannelManager } from "../services/notices-channel-manager.js";
import { ConfigService } from "../services/config-service.js";

const noticesChannelManager = NoticesChannelManager.getInstance;
const configService = ConfigService.getInstance();

export const data = new SlashCommandBuilder()
  .setName("notice")
  .setDescription("Manage server notices")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("add")
      .setDescription("Add a new notice")
      .addStringOption((option) =>
        option
          .setName("title")
          .setDescription("Notice title")
          .setRequired(true)
          .setMaxLength(256),
      )
      .addStringOption((option) =>
        option
          .setName("content")
          .setDescription("Notice content")
          .setRequired(true)
          .setMaxLength(4000),
      )
      .addStringOption((option) =>
        option
          .setName("category")
          .setDescription("Notice category")
          .setRequired(true)
          .addChoices(
            { name: "📋 General", value: "general" },
            { name: "📜 Rules", value: "rules" },
            { name: "ℹ️ Information", value: "info" },
            { name: "❓ Help", value: "help" },
            { name: "🎮 Game Servers", value: "game-servers" },
          ),
      )
      .addIntegerOption((option) =>
        option
          .setName("order")
          .setDescription("Display order (lower numbers appear first)")
          .setRequired(false)
          .setMinValue(0),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("edit")
      .setDescription("Edit an existing notice")
      .addStringOption((option) =>
        option
          .setName("id")
          .setDescription("Notice ID (view in notices channel footer)")
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("title")
          .setDescription("New title (leave empty to keep current)")
          .setRequired(false)
          .setMaxLength(256),
      )
      .addStringOption((option) =>
        option
          .setName("content")
          .setDescription("New content (leave empty to keep current)")
          .setRequired(false)
          .setMaxLength(4000),
      )
      .addStringOption((option) =>
        option
          .setName("category")
          .setDescription("New category (leave empty to keep current)")
          .setRequired(false)
          .addChoices(
            { name: "📋 General", value: "general" },
            { name: "📜 Rules", value: "rules" },
            { name: "ℹ️ Information", value: "info" },
            { name: "❓ Help", value: "help" },
            { name: "🎮 Game Servers", value: "game-servers" },
          ),
      )
      .addIntegerOption((option) =>
        option
          .setName("order")
          .setDescription("New order (leave empty to keep current)")
          .setRequired(false)
          .setMinValue(0),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("delete")
      .setDescription("Delete a notice")
      .addStringOption((option) =>
        option
          .setName("id")
          .setDescription("Notice ID (view in notices channel footer)")
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("sync")
      .setDescription("Sync all notices to the channel (recreate all posts)"),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();

  try {
    // Check if notices system is enabled
    const enabled = await configService.getBoolean("notices.enabled", false);
    if (!enabled) {
      await interaction.reply({
        content:
          "❌ Notices system is not enabled. Use `/config set key:notices.enabled value:true` to enable it.",
        ephemeral: true,
      });
      return;
    }

    switch (subcommand) {
      case "add":
        await handleAdd(interaction);
        break;
      case "edit":
        await handleEdit(interaction);
        break;
      case "delete":
        await handleDelete(interaction);
        break;
      case "sync":
        await handleSync(interaction);
        break;
      default:
        await interaction.reply({
          content: "❌ Unknown subcommand",
          ephemeral: true,
        });
    }
  } catch (error) {
    logger.error("Error executing notice command:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    if (interaction.deferred || interaction.replied) {
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

async function handleAdd(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const title = interaction.options.getString("title", true);
  const content = interaction.options.getString("content", true);
  const category = interaction.options.getString("category", true);
  const order = interaction.options.getInteger("order") ?? 0;

  try {
    // Create notice in database
    const notice = new Notice({
      title,
      content,
      category,
      order,
      createdBy: interaction.user.id,
    });

    await notice.save();
    logger.info(`Notice created: ${notice._id} by ${interaction.user.tag}`);

    // Post to channel
    const manager = noticesChannelManager(interaction.client);
    const messageId = await manager.postNotice(notice);

    if (messageId) {
      notice.messageId = messageId;
      await notice.save();
    }

    const embed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle("✅ Notice Added")
      .addFields(
        { name: "Title", value: title, inline: false },
        { name: "Category", value: category, inline: true },
        { name: "Order", value: order.toString(), inline: true },
        { name: "ID", value: notice._id.toString(), inline: true },
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    logger.error("Error adding notice:", error);
    throw error;
  }
}

async function handleEdit(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const id = interaction.options.getString("id", true);
  const title = interaction.options.getString("title");
  const content = interaction.options.getString("content");
  const category = interaction.options.getString("category");
  const order = interaction.options.getInteger("order");

  try {
    const notice = await Notice.findById(id);
    if (!notice) {
      await interaction.editReply({
        content: `❌ Notice with ID ${id} not found. Check the notice channel for valid IDs.`,
      });
      return;
    }

    // Update fields if provided
    if (title) notice.title = title;
    if (content) notice.content = content;
    if (category) notice.category = category;
    if (order !== null) notice.order = order;

    await notice.save();
    logger.info(`Notice updated: ${notice._id} by ${interaction.user.tag}`);

    // Delete old message and post new one
    const manager = noticesChannelManager(interaction.client);
    if (notice.messageId) {
      await manager.deleteNoticeMessage(notice.messageId);
    }

    const messageId = await manager.postNotice(notice);
    if (messageId) {
      notice.messageId = messageId;
      await notice.save();
    }

    const embed = new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle("✅ Notice Updated")
      .addFields(
        { name: "Title", value: notice.title, inline: false },
        { name: "Category", value: notice.category, inline: true },
        { name: "Order", value: notice.order.toString(), inline: true },
        { name: "ID", value: notice._id.toString(), inline: true },
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    logger.error("Error editing notice:", error);
    throw error;
  }
}

async function handleDelete(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const id = interaction.options.getString("id", true);

  try {
    const notice = await Notice.findById(id);
    if (!notice) {
      await interaction.editReply({
        content: `❌ Notice with ID ${id} not found. Check the notice channel for valid IDs.`,
      });
      return;
    }

    // Delete from channel
    const manager = noticesChannelManager(interaction.client);
    if (notice.messageId) {
      await manager.deleteNoticeMessage(notice.messageId);
    }

    // Delete from database
    await Notice.findByIdAndDelete(id);
    logger.info(`Notice deleted: ${id} by ${interaction.user.tag}`);

    const embed = new EmbedBuilder()
      .setColor(0xe74c3c)
      .setTitle("✅ Notice Deleted")
      .addFields(
        { name: "Title", value: notice.title, inline: false },
        { name: "ID", value: id, inline: true },
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    logger.error("Error deleting notice:", error);
    throw error;
  }
}

async function handleSync(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  try {
    const manager = noticesChannelManager(interaction.client);
    await manager.syncNotices();

    const count = await Notice.countDocuments();

    const embed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle("✅ Notices Synced")
      .setDescription(
        `Successfully synced ${count} notices to the channel. All notices have been reposted in the correct order.`,
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    logger.error("Error syncing notices:", error);
    throw error;
  }
}
