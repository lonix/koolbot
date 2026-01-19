import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";
import logger from "../utils/logger.js";
import { ReactionRoleService } from "../services/reaction-role-service.js";

export const data = new SlashCommandBuilder()
  .setName("reactrole")
  .setDescription("Manage reaction-based roles")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("create")
      .setDescription(
        "Create a reaction role with Discord role, category, and channel",
      )
      .addStringOption((option) =>
        option
          .setName("name")
          .setDescription("Name for the role and category")
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("emoji")
          .setDescription("Emoji to use for reactions")
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("archive")
      .setDescription(
        "Archive a reaction role (disable reactions, keep role/category)",
      )
      .addStringOption((option) =>
        option
          .setName("name")
          .setDescription("Name of the reaction role to archive")
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("unarchive")
      .setDescription("Unarchive a reaction role (re-enable reactions)")
      .addStringOption((option) =>
        option
          .setName("name")
          .setDescription("Name of the reaction role to unarchive")
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("delete")
      .setDescription(
        "Fully delete a reaction role and all associated resources",
      )
      .addStringOption((option) =>
        option
          .setName("name")
          .setDescription("Name of the reaction role to delete")
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("list").setDescription("List all reaction roles"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("status")
      .setDescription("Check status of a specific reaction role")
      .addStringOption((option) =>
        option
          .setName("name")
          .setDescription("Name of the reaction role to check")
          .setRequired(true),
      ),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    if (!interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server!",
        ephemeral: true,
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    const reactionRoleService = ReactionRoleService.getInstance(
      interaction.client,
    );

    switch (subcommand) {
      case "create":
        await handleCreate(interaction, reactionRoleService);
        break;
      case "archive":
        await handleArchive(interaction, reactionRoleService);
        break;
      case "unarchive":
        await handleUnarchive(interaction, reactionRoleService);
        break;
      case "delete":
        await handleDelete(interaction, reactionRoleService);
        break;
      case "list":
        await handleList(interaction, reactionRoleService);
        break;
      case "status":
        await handleStatus(interaction, reactionRoleService);
        break;
      default:
        await interaction.reply({
          content: "Unknown subcommand",
          ephemeral: true,
        });
    }
  } catch (error) {
    logger.error("Error in reactrole command:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({
        content: `❌ An error occurred: ${errorMessage}`,
      });
    } else {
      await interaction.reply({
        content: `❌ An error occurred: ${errorMessage}`,
        ephemeral: true,
      });
    }
  }
}

async function handleCreate(
  interaction: ChatInputCommandInteraction,
  service: ReactionRoleService,
): Promise<void> {
  const name = interaction.options.getString("name", true);
  const emoji = interaction.options.getString("emoji", true);

  await interaction.deferReply({ ephemeral: true });

  const result = await service.createReactionRole(
    interaction.guild!.id,
    name,
    emoji,
  );

  if (result.success) {
    const embed = new EmbedBuilder()
      .setColor(0x00ff00)
      .setTitle("✅ Reaction Role Created")
      .setDescription(result.message)
      .addFields(
        { name: "Role", value: `<@&${result.roleId}>`, inline: true },
        {
          name: "Category",
          value: `<#${result.categoryId}>`,
          inline: true,
        },
        { name: "Channel", value: `<#${result.channelId}>`, inline: true },
      )
      .setFooter({
        text: "Users can now react to get this role!",
      })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } else {
    await interaction.editReply({
      content: `❌ ${result.message}`,
    });
  }
}

async function handleArchive(
  interaction: ChatInputCommandInteraction,
  service: ReactionRoleService,
): Promise<void> {
  const name = interaction.options.getString("name", true);

  await interaction.deferReply({ ephemeral: true });

  const result = await service.archiveReactionRole(interaction.guild!.id, name);

  if (result.success) {
    const embed = new EmbedBuilder()
      .setColor(0xffa500)
      .setTitle("📦 Reaction Role Archived")
      .setDescription(result.message)
      .setFooter({
        text: "The reaction message has been removed",
      })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } else {
    await interaction.editReply({
      content: `❌ ${result.message}`,
    });
  }
}

async function handleUnarchive(
  interaction: ChatInputCommandInteraction,
  service: ReactionRoleService,
): Promise<void> {
  const name = interaction.options.getString("name", true);

  await interaction.deferReply({ ephemeral: true });

  const result = await service.unarchiveReactionRole(
    interaction.guild!.id,
    name,
  );

  if (result.success) {
    const embed = new EmbedBuilder()
      .setColor(0x00ff00)
      .setTitle("📤 Reaction Role Unarchived")
      .setDescription(result.message)
      .setFooter({
        text: "Users can now react to get this role again!",
      })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } else {
    await interaction.editReply({
      content: `❌ ${result.message}`,
    });
  }
}

async function handleDelete(
  interaction: ChatInputCommandInteraction,
  service: ReactionRoleService,
): Promise<void> {
  const name = interaction.options.getString("name", true);

  await interaction.deferReply({ ephemeral: true });

  const result = await service.deleteReactionRole(interaction.guild!.id, name);

  if (result.success) {
    const embed = new EmbedBuilder()
      .setColor(0xff0000)
      .setTitle("🗑️ Reaction Role Deleted")
      .setDescription(result.message)
      .setFooter({
        text: "All resources have been permanently removed",
      })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } else {
    await interaction.editReply({
      content: `❌ ${result.message}`,
    });
  }
}

async function handleList(
  interaction: ChatInputCommandInteraction,
  service: ReactionRoleService,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const roles = await service.listReactionRoles(interaction.guild!.id);

  if (roles.length === 0) {
    await interaction.editReply({
      content: "No reaction roles configured for this server.",
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("📋 Reaction Roles")
    .setDescription(`Found ${roles.length} reaction role(s)`)
    .setTimestamp();

  for (const role of roles) {
    const status = role.isArchived ? "📦 Archived" : "✅ Active";
    embed.addFields({
      name: `${role.emoji} ${role.roleName}`,
      value: `**Status:** ${status}\n**Role:** <@&${role.roleId}>\n**Category:** <#${role.categoryId}>\n**Channel:** <#${role.channelId}>\n**Created:** ${role.createdAt.toLocaleDateString()}`,
      inline: false,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

async function handleStatus(
  interaction: ChatInputCommandInteraction,
  service: ReactionRoleService,
): Promise<void> {
  const name = interaction.options.getString("name", true);

  await interaction.deferReply({ ephemeral: true });

  const config = await service.getReactionRoleStatus(
    interaction.guild!.id,
    name,
  );

  if (!config) {
    await interaction.editReply({
      content: `❌ Reaction role **${name}** not found.`,
    });
    return;
  }

  const status = config.isArchived ? "📦 Archived" : "✅ Active";

  const embed = new EmbedBuilder()
    .setColor(config.isArchived ? 0xffa500 : 0x00ff00)
    .setTitle(`${config.emoji} ${config.roleName}`)
    .setDescription(`**Status:** ${status}`)
    .addFields(
      { name: "Role ID", value: config.roleId, inline: true },
      { name: "Category ID", value: config.categoryId, inline: true },
      { name: "Channel ID", value: config.channelId, inline: true },
      {
        name: "Created",
        value: config.createdAt.toLocaleString(),
        inline: true,
      },
      {
        name: "Last Updated",
        value: config.updatedAt.toLocaleString(),
        inline: true,
      },
    )
    .setFooter({ text: `Message ID: ${config.messageId}` })
    .setTimestamp();

  if (config.isArchived && config.archivedAt) {
    embed.addFields({
      name: "Archived",
      value: config.archivedAt.toLocaleString(),
      inline: true,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}
