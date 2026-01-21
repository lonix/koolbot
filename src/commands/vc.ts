import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  ChannelType,
  VoiceChannel,
} from "discord.js";
import { VoiceChannelManager } from "../services/voice-channel-manager.js";
import { ConfigService } from "../services/config-service.js";
import { ChannelInvite } from "../models/channel-invite.js";
import logger from "../utils/logger.js";

export const data = new SlashCommandBuilder()
  .setName("vc")
  .setDescription("Voice channel management")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("reload")
      .setDescription("Clean up empty voice channels")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("force-reload")
      .setDescription("Force cleanup of ALL unmanaged channels in category")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("invite")
      .setDescription("Invite a user to your voice channel")
      .addUserOption((option) =>
        option
          .setName("user")
          .setDescription("User to invite")
          .setRequired(true),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName("customize")
      .setDescription("Customize your current voice channel")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("name")
          .setDescription("Rename your current voice channel")
          .addStringOption((option) =>
            option
              .setName("name")
              .setDescription("New channel name")
              .setRequired(true)
              .setMaxLength(100),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("limit")
          .setDescription("Set user limit for your current voice channel")
          .addIntegerOption((option) =>
            option
              .setName("number")
              .setDescription("Number of users allowed (0 for unlimited)")
              .setRequired(true)
              .setMinValue(0)
              .setMaxValue(99),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("bitrate")
          .setDescription("Set audio quality for your current voice channel")
          .addIntegerOption((option) =>
            option
              .setName("kbps")
              .setDescription(
                "Bitrate in kbps (8-96 recommended, max 384 with boost)",
              )
              .setRequired(true)
              .setMinValue(8)
              .setMaxValue(384),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("privacy")
          .setDescription("Toggle invite-only mode for your current channel"),
      ),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    const subcommandGroup = interaction.options.getSubcommandGroup();
    const subcommand = interaction.options.getSubcommand();

    if (subcommandGroup === "customize") {
      await handleCustomize(interaction, subcommand);
    } else if (subcommand === "invite") {
      await handleInvite(interaction);
    } else {
      await handleSubcommand(interaction, subcommand);
    }
  } catch (error) {
    logger.error("Error executing vc command:", error);
    await interaction.reply({
      content: "❌ An error occurred while executing the command.",
      ephemeral: true,
    });
  }
}

async function handleSubcommand(
  interaction: ChatInputCommandInteraction,
  subcommand: string,
): Promise<void> {
  // Check admin permissions for reload commands
  if (!interaction.member || !("permissions" in interaction.member)) {
    await interaction.reply({
      content: "❌ Could not verify your permissions.",
      ephemeral: true,
    });
    return;
  }

  const hasAdmin = interaction.member.permissions instanceof PermissionFlagsBits ||
    (typeof interaction.member.permissions === 'object' && 'has' in interaction.member.permissions &&
    interaction.member.permissions.has(PermissionFlagsBits.Administrator));

  if (!hasAdmin) {
    await interaction.reply({
      content: "❌ You need Administrator permission to use this command.",
      ephemeral: true,
    });
    return;
  }

  switch (subcommand) {
    case "reload":
      await handleReload(interaction);
      break;
    case "force-reload":
      await handleForceReload(interaction);
      break;
    default:
      await interaction.reply({
        content: "Invalid vc subcommand.",
        ephemeral: true,
      });
  }
}

async function handleReload(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    await interaction.reply({
      content: "🔄 Cleaning up empty voice channels...",
      ephemeral: true,
    });

    const voiceChannelManager = VoiceChannelManager.getInstance(
      interaction.client,
    );
    await voiceChannelManager.cleanupEmptyChannels();

    await interaction.editReply({
      content: "✅ Voice channel cleanup completed!",
    });
  } catch (error) {
    logger.error("Error handling channel cleanup:", error);
    await interaction.editReply({
      content: `❌ Error during channel cleanup: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

async function handleForceReload(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    await interaction.reply({
      content: "⚠️ Force cleaning up ALL unmanaged channels in category...",
      ephemeral: true,
    });

    const voiceChannelManager = VoiceChannelManager.getInstance(
      interaction.client,
    );

    // Get guild ID from config
    const configService = ConfigService.getInstance();
    const guildId = await configService.getString("GUILD_ID", "");

    if (!guildId) {
      await interaction.editReply({
        content: "❌ GUILD_ID not configured",
      });
      return;
    }

    const guild = await interaction.client.guilds.fetch(guildId);
    if (!guild) {
      await interaction.editReply({
        content: "❌ Guild not found",
      });
      return;
    }

    // Force cleanup
    await voiceChannelManager.cleanupEmptyChannels();

    // Force cleanup and ensure lobby channels exist
    await voiceChannelManager.ensureLobbyChannels(guild);

    await interaction.editReply({
      content:
        "✅ Force cleanup completed! All unmanaged channels removed and lobby channels ensured.",
    });
  } catch (error) {
    logger.error("Error handling force cleanup:", error);
    await interaction.editReply({
      content: `❌ Error during force cleanup: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

async function handleCustomize(
  interaction: ChatInputCommandInteraction,
  subcommand: string,
): Promise<void> {
  // Check if user is in a voice channel
  if (!interaction.guild || !interaction.member) {
    await interaction.reply({
      content: "❌ This command can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  const member = interaction.guild.members.cache.get(interaction.user.id);
  if (!member || !member.voice.channel) {
    await interaction.reply({
      content: "❌ You must be in a voice channel to use this command!",
      ephemeral: true,
    });
    return;
  }

  const voiceChannel = member.voice.channel;
  if (voiceChannel.type !== ChannelType.GuildVoice) {
    await interaction.reply({
      content: "❌ This command only works in voice channels.",
      ephemeral: true,
    });
    return;
  }

  // Check if user is the owner of the channel
  const voiceManager = VoiceChannelManager.getInstance(interaction.client);
  const ownedChannel = voiceManager.getUserChannel(member.id);

  if (!ownedChannel || ownedChannel.id !== voiceChannel.id) {
    await interaction.reply({
      content: "❌ You can only customize voice channels that you own!",
      ephemeral: true,
    });
    return;
  }

  try {
    switch (subcommand) {
      case "name":
        await handleCustomizeName(interaction, voiceChannel);
        break;
      case "limit":
        await handleCustomizeLimit(interaction, voiceChannel);
        break;
      case "bitrate":
        await handleCustomizeBitrate(interaction, voiceChannel);
        break;
      case "privacy":
        await handleCustomizePrivacy(interaction, voiceChannel);
        break;
      default:
        await interaction.reply({
          content: "❌ Invalid customize subcommand.",
          ephemeral: true,
        });
    }
  } catch (error) {
    logger.error("Error handling vc customize:", error);
    await interaction.reply({
      content:
        "❌ An error occurred while customizing your voice channel.",
      ephemeral: true,
    });
  }
}

async function handleCustomizeName(
  interaction: ChatInputCommandInteraction,
  channel: VoiceChannel,
): Promise<void> {
  const newName = interaction.options.getString("name", true);

  // Validate name length
  if (newName.length > 100) {
    await interaction.reply({
      content: "❌ Channel name must be 100 characters or less.",
      ephemeral: true,
    });
    return;
  }

  try {
    await channel.setName(newName);

    await interaction.reply({
      content: `✅ Channel renamed to: **${newName}**`,
      ephemeral: true,
    });
  } catch (error) {
    logger.error("Error renaming channel:", error);
    await interaction.reply({
      content: "❌ Failed to rename channel. Please try again.",
      ephemeral: true,
    });
  }
}

async function handleCustomizeLimit(
  interaction: ChatInputCommandInteraction,
  channel: VoiceChannel,
): Promise<void> {
  const limit = interaction.options.getInteger("number", true);

  try {
    await channel.setUserLimit(limit);

    const limitText = limit === 0 ? "unlimited" : `${limit} users`;
    await interaction.reply({
      content: `✅ Channel user limit set to: **${limitText}**`,
      ephemeral: true,
    });
  } catch (error) {
    logger.error("Error setting user limit:", error);
    await interaction.reply({
      content: "❌ Failed to set user limit. Please try again.",
      ephemeral: true,
    });
  }
}

async function handleCustomizeBitrate(
  interaction: ChatInputCommandInteraction,
  channel: VoiceChannel,
): Promise<void> {
  const bitrate = interaction.options.getInteger("kbps", true);

  try {
    // Convert kbps to bps (Discord API expects bitrate in bits per second)
    await channel.setBitrate(bitrate * 1000);

    await interaction.reply({
      content: `✅ Channel bitrate set to: **${bitrate} kbps**\n\nNote: Higher bitrates may require server boosts and will be capped at the server's maximum.`,
      ephemeral: true,
    });
  } catch (error) {
    logger.error("Error setting bitrate:", error);
    await interaction.reply({
      content: "❌ Failed to set bitrate. Please try again.",
      ephemeral: true,
    });
  }
}

async function handleCustomizePrivacy(
  interaction: ChatInputCommandInteraction,
  channel: VoiceChannel,
): Promise<void> {
  try {
    const everyoneRole = interaction.guild?.roles.everyone;
    if (!everyoneRole) {
      await interaction.reply({
        content: "❌ Could not find @everyone role.",
        ephemeral: true,
      });
      return;
    }

    // Check current privacy state
    const permissions = channel.permissionOverwrites.cache.get(everyoneRole.id);
    const isPrivate = permissions?.deny.has(PermissionFlagsBits.Connect);

    if (isPrivate) {
      // Make public
      await channel.permissionOverwrites.delete(everyoneRole.id);

      await interaction.reply({
        content: "✅ Channel is now **public**. Anyone can join!",
        ephemeral: true,
      });
    } else {
      // Make private
      await channel.permissionOverwrites.create(everyoneRole, {
        Connect: false,
        ViewChannel: false,
      });

      // Ensure owner has access
      await channel.permissionOverwrites.create(interaction.user.id, {
        Connect: true,
        ViewChannel: true,
      });

      await interaction.reply({
        content:
          "🔒 Channel is now **invite-only**! Use `/vc invite` to add users.",
        ephemeral: true,
      });
    }
  } catch (error) {
    logger.error("Error toggling privacy:", error);
    await interaction.reply({
      content: "❌ Failed to toggle privacy. Please try again.",
      ephemeral: true,
    });
  }
}

async function handleInvite(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  // Check if user is in a voice channel
  if (!interaction.guild || !interaction.member) {
    await interaction.reply({
      content: "❌ This command can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  const member = interaction.guild.members.cache.get(interaction.user.id);
  if (!member || !member.voice.channel) {
    await interaction.reply({
      content: "❌ You must be in a voice channel to invite users!",
      ephemeral: true,
    });
    return;
  }

  const voiceChannel = member.voice.channel;
  if (voiceChannel.type !== ChannelType.GuildVoice) {
    await interaction.reply({
      content: "❌ This command only works in voice channels.",
      ephemeral: true,
    });
    return;
  }

  // Check if user is the owner
  const voiceManager = VoiceChannelManager.getInstance(interaction.client);
  const ownedChannel = voiceManager.getUserChannel(member.id);

  if (!ownedChannel || ownedChannel.id !== voiceChannel.id) {
    await interaction.reply({
      content: "❌ You can only invite users to voice channels that you own!",
      ephemeral: true,
    });
    return;
  }

  // Check if channel is private
  const everyoneRole = interaction.guild.roles.everyone;
  const permissions = voiceChannel.permissionOverwrites.cache.get(
    everyoneRole.id,
  );
  const isPrivate = permissions?.deny.has(PermissionFlagsBits.Connect);

  if (!isPrivate) {
    await interaction.reply({
      content:
        "❌ Your channel is public. Use `/vc customize privacy` to make it private first!",
      ephemeral: true,
    });
    return;
  }

  // Get the user to invite
  const userToInvite = interaction.options.getUser("user", true);

  if (userToInvite.id === interaction.user.id) {
    await interaction.reply({
      content: "❌ You cannot invite yourself!",
      ephemeral: true,
    });
    return;
  }

  if (userToInvite.bot) {
    await interaction.reply({
      content: "❌ You cannot invite bots!",
      ephemeral: true,
    });
    return;
  }

  try {
    // Grant permission to the invited user
    await voiceChannel.permissionOverwrites.create(userToInvite.id, {
      Connect: true,
      ViewChannel: true,
    });

    // Save invite to database
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
    await ChannelInvite.create({
      channelId: voiceChannel.id,
      userId: userToInvite.id,
      invitedBy: interaction.user.id,
      status: "accepted", // Automatically accepted since we granted permissions
      expiresAt,
    });

    await interaction.reply({
      content: `✅ ${userToInvite.username} can now join your channel!`,
      ephemeral: true,
    });

    // Try to notify the invited user
    try {
      await userToInvite.send(
        `📩 ${interaction.user.username} invited you to their voice channel **${voiceChannel.name}** in ${interaction.guild.name}!`,
      );
    } catch (error) {
      logger.info(`Could not DM user ${userToInvite.username}:`, error);
    }
  } catch (error) {
    logger.error("Error inviting user:", error);
    await interaction.reply({
      content: "❌ Failed to invite user. Please try again.",
      ephemeral: true,
    });
  }
}
