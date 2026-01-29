import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  EmbedBuilder,
  Role,
  User,
  AutocompleteInteraction,
} from "discord.js";
import { PermissionsService } from "../services/permissions-service.js";
import logger from "../utils/logger.js";

export const data = new SlashCommandBuilder()
  .setName("permissions")
  .setDescription("Manage command permissions")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("set")
      .setDescription("Set command permissions (replaces existing)")
      .addStringOption((option) =>
        option
          .setName("command")
          .setDescription("Command name (e.g., quote, vcstats)")
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addRoleOption((option) =>
        option
          .setName("role1")
          .setDescription("Role that can use this command")
          .setRequired(true),
      )
      .addRoleOption((option) =>
        option
          .setName("role2")
          .setDescription("Additional role (optional)")
          .setRequired(false),
      )
      .addRoleOption((option) =>
        option
          .setName("role3")
          .setDescription("Additional role (optional)")
          .setRequired(false),
      )
      .addRoleOption((option) =>
        option
          .setName("role4")
          .setDescription("Additional role (optional)")
          .setRequired(false),
      )
      .addRoleOption((option) =>
        option
          .setName("role5")
          .setDescription("Additional role (optional)")
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("add")
      .setDescription("Add roles to existing command permissions")
      .addStringOption((option) =>
        option
          .setName("command")
          .setDescription("Command name")
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addRoleOption((option) =>
        option.setName("role1").setDescription("Role to add").setRequired(true),
      )
      .addRoleOption((option) =>
        option
          .setName("role2")
          .setDescription("Additional role (optional)")
          .setRequired(false),
      )
      .addRoleOption((option) =>
        option
          .setName("role3")
          .setDescription("Additional role (optional)")
          .setRequired(false),
      )
      .addRoleOption((option) =>
        option
          .setName("role4")
          .setDescription("Additional role (optional)")
          .setRequired(false),
      )
      .addRoleOption((option) =>
        option
          .setName("role5")
          .setDescription("Additional role (optional)")
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("remove")
      .setDescription("Remove roles from command permissions")
      .addStringOption((option) =>
        option
          .setName("command")
          .setDescription("Command name")
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addRoleOption((option) =>
        option
          .setName("role1")
          .setDescription("Role to remove")
          .setRequired(true),
      )
      .addRoleOption((option) =>
        option
          .setName("role2")
          .setDescription("Additional role (optional)")
          .setRequired(false),
      )
      .addRoleOption((option) =>
        option
          .setName("role3")
          .setDescription("Additional role (optional)")
          .setRequired(false),
      )
      .addRoleOption((option) =>
        option
          .setName("role4")
          .setDescription("Additional role (optional)")
          .setRequired(false),
      )
      .addRoleOption((option) =>
        option
          .setName("role5")
          .setDescription("Additional role (optional)")
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("clear")
      .setDescription(
        "Clear permissions for a command, or all commands for a role/user",
      )
      .addStringOption((option) =>
        option
          .setName("command")
          .setDescription("Command name (leave empty to clear by role/user)")
          .setRequired(false)
          .setAutocomplete(true),
      )
      .addRoleOption((option) =>
        option
          .setName("role")
          .setDescription("Clear all commands for this role")
          .setRequired(false),
      )
      .addUserOption((option) =>
        option
          .setName("user")
          .setDescription("Clear all commands accessible via user's roles")
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("list")
      .setDescription("List command permissions")
      .addStringOption((option) =>
        option
          .setName("command")
          .setDescription("Filter by specific command (optional)")
          .setRequired(false)
          .setAutocomplete(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("view")
      .setDescription("View permissions for a user or role")
      .addUserOption((option) =>
        option
          .setName("user")
          .setDescription("User to check permissions for")
          .setRequired(false),
      )
      .addRoleOption((option) =>
        option
          .setName("role")
          .setDescription("Role to check permissions for")
          .setRequired(false),
      ),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
      case "set":
        await handleSet(interaction);
        break;
      case "add":
        await handleAdd(interaction);
        break;
      case "remove":
        await handleRemove(interaction);
        break;
      case "clear":
        await handleClear(interaction);
        break;
      case "list":
        await handleList(interaction);
        break;
      case "view":
        await handleView(interaction);
        break;
      default:
        await interaction.reply({
          content: "Unknown subcommand.",
          ephemeral: true,
        });
    }
  } catch (error) {
    logger.error("Error executing permissions command:", error);
    const errorMessage = "❌ An error occurred while executing the command.";

    if (interaction.replied || interaction.deferred) {
      await interaction.editReply({ content: errorMessage });
    } else {
      await interaction.reply({ content: errorMessage, ephemeral: true });
    }
  }
}

// Autocomplete handler for command names
export async function autocomplete(
  interaction: AutocompleteInteraction,
): Promise<void> {
  try {
    const focusedOption = interaction.options.getFocused(true);

    if (focusedOption.name === "command") {
      const commandNames = Array.from(interaction.client.commands.keys());
      const filtered = commandNames
        .filter((name) =>
          name.toLowerCase().includes(focusedOption.value.toLowerCase()),
        )
        .slice(0, 25);

      await interaction.respond(
        filtered.map((name) => ({ name: name, value: name })),
      );
    }
  } catch (error) {
    logger.error("Error in permissions autocomplete:", error);
  }
}

async function handleSet(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const commandName = interaction.options.getString("command", true);
  const roles: Role[] = [];

  // Collect all provided roles
  for (let i = 1; i <= 5; i++) {
    const role = interaction.options.getRole(`role${i}`) as Role | null;
    if (role) {
      roles.push(role);
    }
  }

  if (roles.length === 0) {
    await interaction.reply({
      content: "❌ You must specify at least one role.",
      ephemeral: true,
    });
    return;
  }

  // Validate command exists
  if (!interaction.client.commands.has(commandName)) {
    await interaction.reply({
      content: `❌ Command \`${commandName}\` does not exist.`,
      ephemeral: true,
    });
    return;
  }

  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      content: "❌ This command can only be used in a guild.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const service = PermissionsService.getInstance(interaction.client);
  const roleIds = roles.map((r) => r.id);

  await service.setCommandPermissions(guildId, commandName, roleIds);

  const roleList = roles.map((r) => r.toString()).join(", ");
  await interaction.editReply({
    content: `✅ Set permissions for \`/${commandName}\` to: ${roleList}`,
  });
}

async function handleAdd(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const commandName = interaction.options.getString("command", true);
  const roles: Role[] = [];

  // Collect all provided roles
  for (let i = 1; i <= 5; i++) {
    const role = interaction.options.getRole(`role${i}`) as Role | null;
    if (role) {
      roles.push(role);
    }
  }

  if (roles.length === 0) {
    await interaction.reply({
      content: "❌ You must specify at least one role.",
      ephemeral: true,
    });
    return;
  }

  // Validate command exists
  if (!interaction.client.commands.has(commandName)) {
    await interaction.reply({
      content: `❌ Command \`${commandName}\` does not exist.`,
      ephemeral: true,
    });
    return;
  }

  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      content: "❌ This command can only be used in a guild.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const service = PermissionsService.getInstance(interaction.client);
  const roleIds = roles.map((r) => r.id);

  await service.addCommandPermissions(guildId, commandName, roleIds);

  const roleList = roles.map((r) => r.toString()).join(", ");
  await interaction.editReply({
    content: `✅ Added roles to \`/${commandName}\`: ${roleList}`,
  });
}

async function handleRemove(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const commandName = interaction.options.getString("command", true);
  const roles: Role[] = [];

  // Collect all provided roles
  for (let i = 1; i <= 5; i++) {
    const role = interaction.options.getRole(`role${i}`) as Role | null;
    if (role) {
      roles.push(role);
    }
  }

  if (roles.length === 0) {
    await interaction.reply({
      content: "❌ You must specify at least one role.",
      ephemeral: true,
    });
    return;
  }

  // Validate command exists
  if (!interaction.client.commands.has(commandName)) {
    await interaction.reply({
      content: `❌ Command \`${commandName}\` does not exist.`,
      ephemeral: true,
    });
    return;
  }

  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      content: "❌ This command can only be used in a guild.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const service = PermissionsService.getInstance(interaction.client);
  const roleIds = roles.map((r) => r.id);

  await service.removeCommandPermissions(guildId, commandName, roleIds);

  const roleList = roles.map((r) => r.toString()).join(", ");
  await interaction.editReply({
    content: `✅ Removed roles from \`/${commandName}\`: ${roleList}`,
  });
}

async function handleClear(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const commandName = interaction.options.getString("command");
  const role = interaction.options.getRole("role") as Role | null;
  const user = interaction.options.getUser("user");

  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      content: "❌ This command can only be used in a guild.",
      ephemeral: true,
    });
    return;
  }

  // Validate that at least one parameter is provided
  if (!commandName && !role && !user) {
    await interaction.reply({
      content:
        "❌ You must specify either a command, role, or user to clear permissions.",
      ephemeral: true,
    });
    return;
  }

  // If command is specified, use the original behavior
  if (commandName) {
    // Validate command exists
    if (!interaction.client.commands.has(commandName)) {
      await interaction.reply({
        content: `❌ Command \`${commandName}\` does not exist.`,
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const service = PermissionsService.getInstance(interaction.client);
    await service.clearCommandPermissions(guildId, commandName);

    await interaction.editReply({
      content: `✅ Cleared all permissions for \`/${commandName}\`. It is now accessible to everyone.`,
    });
    return;
  }

  // If role is specified, clear all commands that have this role
  if (role) {
    await interaction.deferReply({ ephemeral: true });

    const service = PermissionsService.getInstance(interaction.client);
    const clearedCount = await service.clearRoleFromAllCommands(
      guildId,
      role.id,
    );

    await interaction.editReply({
      content: `✅ Removed ${role.toString()} from ${clearedCount} command(s).`,
    });
    return;
  }

  // If user is specified, clear all commands accessible via the user's roles
  if (user) {
    await interaction.deferReply({ ephemeral: true });

    const guild = interaction.guild;
    if (!guild) {
      await interaction.editReply({
        content: "❌ Could not fetch guild information.",
      });
      return;
    }

    try {
      const member = await guild.members.fetch(user.id);
      const userRoleIds = member.roles.cache.map((r) => r.id);

      const service = PermissionsService.getInstance(interaction.client);
      const clearedCount = await service.clearRolesFromAllCommands(
        guildId,
        userRoleIds,
      );

      await interaction.editReply({
        content: `✅ Removed ${user.toString()}'s roles from ${clearedCount} command(s).`,
      });
    } catch (error) {
      logger.error("Error fetching member for clear command:", error);
      await interaction.editReply({
        content: `❌ Could not fetch member information for ${user.toString()}.`,
      });
    }
  }
}

async function handleList(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const commandName = interaction.options.getString("command");
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      content: "❌ This command can only be used in a guild.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const service = PermissionsService.getInstance(interaction.client);

  // If a specific command is requested, show only that command's permissions
  if (commandName) {
    // Validate command exists
    if (!interaction.client.commands.has(commandName)) {
      await interaction.editReply({
        content: `❌ Command \`${commandName}\` does not exist.`,
      });
      return;
    }

    const roleIds = await service.getCommandPermissions(guildId, commandName);

    if (!roleIds || roleIds.length === 0) {
      await interaction.editReply({
        content: `ℹ️ No permissions configured for \`/${commandName}\`. It is accessible to everyone.`,
      });
      return;
    }

    const guild = interaction.guild;
    if (!guild) {
      await interaction.editReply({
        content: "❌ Could not fetch guild information.",
      });
      return;
    }

    const roles = await Promise.all(
      roleIds.map(async (roleId) => {
        try {
          const role = await guild.roles.fetch(roleId);
          return role ? role.toString() : `<@&${roleId}>`;
        } catch {
          return `<@&${roleId}>`;
        }
      }),
    );

    const embed = new EmbedBuilder()
      .setTitle(`Permissions for /${commandName}`)
      .setDescription("Roles that can use this command:")
      .setColor(0x00ae86)
      .setTimestamp();

    embed.addFields({
      name: "Allowed Roles",
      value: roles.join(", ") || "No roles",
      inline: false,
    });

    embed.setFooter({
      text: "Admins bypass all restrictions.",
    });

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // Original behavior: list all permissions
  const permissions = await service.listAllPermissions(guildId);

  if (permissions.length === 0) {
    await interaction.editReply({
      content:
        "ℹ️ No permissions configured. All commands are accessible to everyone (admins have access to all commands).",
    });
    return;
  }

  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply({
      content: "❌ Could not fetch guild information.",
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle("Command Permissions")
    .setDescription("Commands with role restrictions:")
    .setColor(0x00ae86)
    .setTimestamp();

  for (const perm of permissions) {
    const roles = await Promise.all(
      perm.roleIds.map(async (roleId) => {
        try {
          const role = await guild.roles.fetch(roleId);
          return role ? role.toString() : `<@&${roleId}>`;
        } catch {
          return `<@&${roleId}>`;
        }
      }),
    );

    embed.addFields({
      name: `/${perm.commandName}`,
      value: roles.join(", ") || "No roles",
      inline: false,
    });
  }

  embed.setFooter({
    text: "Commands not listed are accessible to everyone. Admins bypass all restrictions.",
  });

  await interaction.editReply({ embeds: [embed] });
}

async function handleView(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const user = interaction.options.getUser("user");
  const role = interaction.options.getRole("role") as Role | null;

  if (!user && !role) {
    await interaction.reply({
      content: "❌ You must specify either a user or a role.",
      ephemeral: true,
    });
    return;
  }

  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      content: "❌ This command can only be used in a guild.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const service = PermissionsService.getInstance(interaction.client);

  if (user) {
    await handleViewUser(interaction, service, user, guildId);
  } else if (role) {
    await handleViewRole(interaction, service, role, guildId);
  }
}

async function handleViewUser(
  interaction: ChatInputCommandInteraction,
  service: PermissionsService,
  user: User,
  guildId: string,
): Promise<void> {
  const commands = await service.getUserPermissions(user.id, guildId);

  const embed = new EmbedBuilder()
    .setTitle(`Permissions for ${user.tag}`)
    .setDescription(
      commands.length > 0
        ? `Can access **${commands.length}** command(s):`
        : "No accessible commands.",
    )
    .setColor(0x00ae86)
    .setTimestamp();

  if (commands.length > 0) {
    // Split into chunks if too many
    const commandList = commands.map((cmd) => `\`/${cmd}\``).join(", ");
    embed.addFields({
      name: "Accessible Commands",
      value:
        commandList.length > 1024
          ? commandList.substring(0, 1021) + "..."
          : commandList,
      inline: false,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

async function handleViewRole(
  interaction: ChatInputCommandInteraction,
  service: PermissionsService,
  role: Role,
  guildId: string,
): Promise<void> {
  const commands = await service.getRolePermissions(role.id, guildId);

  const embed = new EmbedBuilder()
    .setTitle(`Permissions for ${role.name}`)
    .setDescription(
      commands.length > 0
        ? `Can access **${commands.length}** command(s):`
        : "No accessible commands.",
    )
    .setColor(0x00ae86)
    .setTimestamp();

  if (commands.length > 0) {
    // Split into chunks if too many
    const commandList = commands.map((cmd) => `\`/${cmd}\``).join(", ");
    embed.addFields({
      name: "Accessible Commands",
      value:
        commandList.length > 1024
          ? commandList.substring(0, 1021) + "..."
          : commandList,
      inline: false,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}
