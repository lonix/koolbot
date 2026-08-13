import {
  Client,
  TextChannel,
  EmbedBuilder,
  ChannelType,
  CategoryChannel,
  MessageReaction,
  User,
  PartialMessageReaction,
  PartialUser,
  Role,
  Message,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  ComponentEmojiResolvable,
  MessageCreateOptions,
} from "discord.js";
import { ConfigService } from "./config-service.js";
import logger from "../utils/logger.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";
import {
  ReactionRoleConfig,
  IReactionRoleConfig,
  ReactionRoleStyle,
  REACTION_ROLE_STYLES,
} from "../models/reaction-role-config.js";

/**
 * customId prefixes for component-backed self-assign roles. Buttons encode the
 * target roleId (`reactrole:btn:<roleId>`) so a single click maps to exactly
 * one config; select menus carry roleIds as their option values and use a
 * static customId (`reactrole:sel`). Both resolve the concrete config from the
 * interaction's own message id, so no privileged reaction intents or partials
 * are involved.
 */
export const REACTION_ROLE_BUTTON_PREFIX = "reactrole:btn:";
export const REACTION_ROLE_SELECT_ID = "reactrole:sel";

export class ReactionRoleService {
  private static instance: ReactionRoleService;
  private client: Client;
  private configService: ConfigService;
  private isInitialized: boolean = false;

  private constructor(client: Client) {
    this.client = client;
    this.configService = ConfigService.getInstance();
  }

  public static getInstance(client: Client): ReactionRoleService {
    if (!ReactionRoleService.instance) {
      ReactionRoleService.instance = new ReactionRoleService(client);
    }
    return ReactionRoleService.instance;
  }

  private async waitForClientReady(): Promise<void> {
    if (this.client.isReady()) {
      return;
    }

    return new Promise((resolve) => {
      const checkReady = (): void => {
        if (this.client.isReady()) {
          resolve();
        } else {
          setTimeout(checkReady, 100).unref?.();
        }
      };
      checkReady();
    });
  }

  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.warn("Reaction role service already initialized, skipping...");
      return;
    }

    logger.info("Initializing reaction role service...");

    this.isInitialized = true;

    try {
      await this.waitForClientReady();

      const enabled = await this.configService.getBoolean(
        "reactionroles.enabled",
        false,
      );
      if (!enabled) {
        logger.info("Reaction roles feature is disabled");
        return;
      }

      // Setup reaction handlers
      this.setupReactionHandlers();

      logger.info("Reaction role service initialized successfully");
    } catch (error) {
      logger.error("Error initializing reaction role service:", error);
      // Reset initialization flag on error to allow retry
      this.isInitialized = false;
    }
  }

  private setupReactionHandlers(): void {
    // Listen for reactions added
    this.client.on(
      "messageReactionAdd",
      async (
        reaction: MessageReaction | PartialMessageReaction,
        user: User | PartialUser,
      ) => {
        if (user.bot) return;

        try {
          // Fetch partial data if needed
          if (reaction.partial) {
            await reaction.fetch();
          }
          if (user.partial) {
            await user.fetch();
          }

          await this.handleReactionAdd(
            reaction as MessageReaction,
            user as User,
          );
        } catch (error) {
          logger.error("Error handling reaction add:", error);
        }
      },
    );

    // Listen for reactions removed
    this.client.on(
      "messageReactionRemove",
      async (
        reaction: MessageReaction | PartialMessageReaction,
        user: User | PartialUser,
      ) => {
        if (user.bot) return;

        try {
          // Fetch partial data if needed
          if (reaction.partial) {
            await reaction.fetch();
          }
          if (user.partial) {
            await user.fetch();
          }

          await this.handleReactionRemove(
            reaction as MessageReaction,
            user as User,
          );
        } catch (error) {
          logger.error("Error handling reaction remove:", error);
        }
      },
    );
  }

  /**
   * Build the emoji identifier to match against stored format
   * @param reaction The message reaction
   * @returns The emoji string in the format stored in the database
   */
  private buildEmojiIdentifier(reaction: MessageReaction): string {
    // For custom emojis: stored as <:name:id> or <a:name:id>
    // For standard emojis: stored as Unicode character
    if (reaction.emoji.id) {
      // Custom emoji - reconstruct full format
      const animated = reaction.emoji.animated ? "a" : "";
      return `<${animated}:${reaction.emoji.name}:${reaction.emoji.id}>`;
    }

    // Standard emoji - use Unicode character
    return reaction.emoji.name || "";
  }

  private async handleReactionAdd(
    reaction: MessageReaction,
    user: User,
  ): Promise<void> {
    try {
      const emojiToMatch = this.buildEmojiIdentifier(reaction);

      const config = await ReactionRoleConfig.findOne({
        messageId: reaction.message.id,
        emoji: emojiToMatch,
        isArchived: false,
      });

      if (!config) {
        return;
      }

      const guild = reaction.message.guild;
      if (!guild) {
        return;
      }

      const member = await guild.members.fetch(user.id);
      if (!member) {
        return;
      }

      const role = guild.roles.cache.get(config.roleId);
      if (!role) {
        logger.error(
          `Role ${config.roleId} not found for reaction role ${config.roleName}`,
        );
        return;
      }

      if (member.roles.cache.has(config.roleId)) {
        logger.debug(`User ${user.tag} already has role ${role.name}`);
        return;
      }

      await member.roles.add(role);
      logger.info(`Added role ${role.name} to user ${user.tag}`);
    } catch (error) {
      logger.error("Error adding role from reaction:", error);
    }
  }

  private async handleReactionRemove(
    reaction: MessageReaction,
    user: User,
  ): Promise<void> {
    try {
      const emojiToMatch = this.buildEmojiIdentifier(reaction);

      const config = await ReactionRoleConfig.findOne({
        messageId: reaction.message.id,
        emoji: emojiToMatch,
        isArchived: false,
      });

      if (!config) {
        return;
      }

      const guild = reaction.message.guild;
      if (!guild) {
        return;
      }

      const member = await guild.members.fetch(user.id);
      if (!member) {
        return;
      }

      const role = guild.roles.cache.get(config.roleId);
      if (!role) {
        logger.error(
          `Role ${config.roleId} not found for reaction role ${config.roleName}`,
        );
        return;
      }

      if (!member.roles.cache.has(config.roleId)) {
        logger.debug(`User ${user.tag} does not have role ${role.name}`);
        return;
      }

      await member.roles.remove(role);
      logger.info(`Removed role ${role.name} from user ${user.tag}`);
    } catch (error) {
      logger.error("Error removing role from reaction:", error);
    }
  }

  /**
   * Resolve the configured default surface style for newly created role
   * messages. Falls back to the legacy `reaction` surface for any unknown value
   * so a mistyped config can never break message creation.
   */
  private async resolveDefaultStyle(): Promise<ReactionRoleStyle> {
    const raw = await this.configService.getString(
      "reactionroles.style",
      "reaction",
    );
    return REACTION_ROLE_STYLES.includes(raw as ReactionRoleStyle)
      ? (raw as ReactionRoleStyle)
      : "reaction";
  }

  /**
   * Convert a stored emoji string into a component-emoji resolvable.
   * Custom emojis are stored as `<a?:name:id>`; components need the id (and the
   * animated flag). Standard emojis are passed through as the Unicode string.
   * Returns undefined when there is nothing usable, so the button/option simply
   * renders without an emoji instead of throwing.
   */
  private resolveComponentEmoji(
    emoji: string,
  ): ComponentEmojiResolvable | undefined {
    if (!emoji) {
      return undefined;
    }
    const customMatch = emoji.match(/<(a?):(\w+):(\d+)>/);
    if (customMatch) {
      return {
        animated: customMatch[1] === "a",
        name: customMatch[2],
        id: customMatch[3],
      };
    }
    return emoji;
  }

  /**
   * Build the message payload (embed + optional components) for a self-assign
   * role message given its style. Used by both create and unarchive so the two
   * paths never drift.
   */
  private buildRoleMessagePayload(config: {
    emoji: string;
    roleName: string;
    roleId: string;
    style: ReactionRoleStyle;
  }): MessageCreateOptions {
    const { emoji, roleName, roleId, style } = config;

    if (style === "button") {
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`${emoji} ${roleName}`)
        .setDescription(
          `Click the button below to toggle the **${roleName}** role and its channels.`,
        )
        .setFooter({ text: "Click again to remove the role" })
        .setTimestamp();

      const button = new ButtonBuilder()
        .setCustomId(`${REACTION_ROLE_BUTTON_PREFIX}${roleId}`)
        .setLabel(roleName)
        .setStyle(ButtonStyle.Primary);
      const componentEmoji = this.resolveComponentEmoji(emoji);
      if (componentEmoji) {
        button.setEmoji(componentEmoji);
      }

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);
      return { embeds: [embed], components: [row] };
    }

    if (style === "select") {
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`${emoji} ${roleName}`)
        .setDescription(
          `Use the menu below to give yourself the **${roleName}** role and its channels.`,
        )
        .setFooter({ text: "Deselect to remove the role" })
        .setTimestamp();

      const option = {
        label: roleName,
        value: roleId,
        description: `Toggle the ${roleName} role`.slice(0, 100),
      } as {
        label: string;
        value: string;
        description: string;
        emoji?: ComponentEmojiResolvable;
      };
      const componentEmoji = this.resolveComponentEmoji(emoji);
      if (componentEmoji) {
        option.emoji = componentEmoji;
      }

      const menu = new StringSelectMenuBuilder()
        .setCustomId(REACTION_ROLE_SELECT_ID)
        .setPlaceholder(`Pick to toggle ${roleName}`.slice(0, 150))
        .setMinValues(0)
        .setMaxValues(1)
        .addOptions(option);

      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        menu,
      );
      return { embeds: [embed], components: [row] };
    }

    // Default: legacy reaction surface. The caller adds the reaction after send.
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`${emoji} ${roleName}`)
      .setDescription(
        `React with ${emoji} to get access to the **${roleName}** role and channels!`,
      )
      .setFooter({ text: "Remove your reaction to lose access" })
      .setTimestamp();
    return { embeds: [embed] };
  }

  /**
   * Add or remove a role on a member and return a human-readable, ephemeral
   * confirmation line. Shared by the button and select component handlers.
   */
  private async applyRoleToggle(
    guildId: string,
    userId: string,
    roleId: string,
    desired: "add" | "remove",
  ): Promise<string> {
    const guild = await this.client.guilds.fetch(guildId);
    const member = await guild.members.fetch(userId);
    const role =
      guild.roles.cache.get(roleId) ?? (await guild.roles.fetch(roleId));

    if (!role) {
      logger.error(`Role ${roleId} not found while applying self-assign role`);
      return `⚠️ That role no longer exists.`;
    }

    const hasRole = member.roles.cache.has(roleId);

    if (desired === "add") {
      if (hasRole) {
        return `You already have **${role.name}**.`;
      }
      await member.roles.add(role);
      logger.info(`Added role ${role.name} to user ${member.user.tag}`);
      return `✅ You now have **${role.name}**.`;
    }

    if (!hasRole) {
      return `You don't have **${role.name}**.`;
    }
    await member.roles.remove(role);
    logger.info(`Removed role ${role.name} from user ${member.user.tag}`);
    return `➖ Removed **${role.name}**.`;
  }

  /**
   * Handle a button click on a component-backed self-assign role message.
   * customId format: `reactrole:btn:<roleId>`. Toggles the role for the acting
   * member and replies ephemerally. Routed from the central interaction handler
   * in `index.ts`, not a service-owned `client.on`.
   */
  public async handleButtonInteraction(
    interaction: ButtonInteraction,
  ): Promise<void> {
    try {
      const roleId = interaction.customId.slice(
        REACTION_ROLE_BUTTON_PREFIX.length,
      );
      if (!roleId || !interaction.guildId) {
        await interaction.reply({
          content: "⚠️ This role button is invalid.",
          ephemeral: true,
        });
        return;
      }

      const enabled = await this.configService.getBoolean(
        "reactionroles.enabled",
        false,
      );
      if (!enabled) {
        await interaction.reply({
          content: "⚠️ Self-assign roles are currently disabled.",
          ephemeral: true,
        });
        return;
      }

      const config = await ReactionRoleConfig.findOne({
        messageId: interaction.message.id,
        roleId,
        isArchived: false,
      });
      if (!config) {
        await interaction.reply({
          content: "⚠️ This role is no longer available.",
          ephemeral: true,
        });
        return;
      }

      const hasRole = await this.memberHasRole(
        interaction.guildId,
        interaction.user.id,
        roleId,
      );
      const message = await this.applyRoleToggle(
        interaction.guildId,
        interaction.user.id,
        roleId,
        hasRole ? "remove" : "add",
      );

      await interaction.reply({ content: message, ephemeral: true });
    } catch (error) {
      logger.error("Error handling reaction-role button:", error);
      await this.safeErrorReply(interaction);
    }
  }

  /**
   * Handle a selection on a component-backed self-assign role message.
   * customId is the static `reactrole:sel`; the selected option values are
   * roleIds. The set of roles this message manages is every non-archived
   * select-style config bound to the message, so a deselect removes a role and
   * a select adds one. Forward-compatible with multiple roles per message.
   */
  public async handleSelectInteraction(
    interaction: StringSelectMenuInteraction,
  ): Promise<void> {
    try {
      if (!interaction.guildId) {
        await interaction.reply({
          content: "⚠️ This menu is invalid.",
          ephemeral: true,
        });
        return;
      }

      const enabled = await this.configService.getBoolean(
        "reactionroles.enabled",
        false,
      );
      if (!enabled) {
        await interaction.reply({
          content: "⚠️ Self-assign roles are currently disabled.",
          ephemeral: true,
        });
        return;
      }

      const configs = await ReactionRoleConfig.find({
        messageId: interaction.message.id,
        style: "select",
        isArchived: false,
      });
      if (configs.length === 0) {
        await interaction.reply({
          content: "⚠️ These roles are no longer available.",
          ephemeral: true,
        });
        return;
      }

      const managedRoleIds = new Set(configs.map((c) => c.roleId));
      const selected = new Set(
        interaction.values.filter((v) => managedRoleIds.has(v)),
      );

      const lines: string[] = [];
      for (const roleId of managedRoleIds) {
        const desired = selected.has(roleId) ? "add" : "remove";
        const hasRole = await this.memberHasRole(
          interaction.guildId,
          interaction.user.id,
          roleId,
        );
        // Only act (and report) when the selection actually changes state.
        if (
          (desired === "add" && !hasRole) ||
          (desired === "remove" && hasRole)
        ) {
          lines.push(
            await this.applyRoleToggle(
              interaction.guildId,
              interaction.user.id,
              roleId,
              desired,
            ),
          );
        }
      }

      await interaction.reply({
        content: lines.length > 0 ? lines.join("\n") : "No changes made.",
        ephemeral: true,
      });
    } catch (error) {
      logger.error("Error handling reaction-role select menu:", error);
      await this.safeErrorReply(interaction);
    }
  }

  /** Whether a guild member currently holds a role (cache-first, then fetch). */
  private async memberHasRole(
    guildId: string,
    userId: string,
    roleId: string,
  ): Promise<boolean> {
    const guild = await this.client.guilds.fetch(guildId);
    const member = await guild.members.fetch(userId);
    return member.roles.cache.has(roleId);
  }

  /** Reply (or follow up) with a generic error without throwing again. */
  private async safeErrorReply(
    interaction: ButtonInteraction | StringSelectMenuInteraction,
  ): Promise<void> {
    const content = "⚠️ Something went wrong updating your roles.";
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content, ephemeral: true });
      } else {
        await interaction.reply({ content, ephemeral: true });
      }
    } catch {
      // Nothing more we can do if the interaction can't be answered.
    }
  }

  public async createReactionRole(
    guildId: string,
    roleName: string,
    emoji: string,
  ): Promise<{
    success: boolean;
    message: string;
    roleId?: string;
    categoryId?: string;
    channelId?: string;
    messageId?: string;
  }> {
    let role: Role | null = null;
    let category: CategoryChannel | null = null;
    let channel: TextChannel | null = null;
    let message: Message | null = null;

    try {
      // Check if a reaction role with this name already exists
      const existingConfig = await ReactionRoleConfig.findOne({
        guildId,
        roleName,
      });

      if (existingConfig) {
        return {
          success: false,
          message: `A reaction role named **${roleName}** already exists in this server.`,
        };
      }

      const guild = await this.client.guilds.fetch(guildId);

      // Parse emoji to determine if it's custom or standard
      // Custom emoji format: <:name:id> or <a:name:id>
      // Store the emoji as-is for both standard (Unicode) and custom (full format)
      let normalizedEmoji: string = emoji;
      const customEmojiMatch = emoji.match(/<a?:(\w+):(\d+)>/);
      if (customEmojiMatch) {
        // For custom emojis, store the full markup to preserve name and animated flag
        normalizedEmoji = customEmojiMatch[0];
      }
      // For standard emojis, normalizedEmoji is already set to the Unicode character

      // Create the role
      role = await guild.roles.create({
        name: roleName,
        reason: `Reaction role created: ${roleName}`,
      });

      logger.info(`Created role: ${role.name} (${role.id})`);

      // Create category
      category = (await guild.channels.create({
        name: roleName,
        type: ChannelType.GuildCategory,
        reason: `Category for reaction role: ${roleName}`,
      })) as CategoryChannel;

      logger.info(`Created category: ${category.name} (${category.id})`);

      // Set category permissions - only role members can view
      await category.permissionOverwrites.edit(guild.roles.everyone, {
        ViewChannel: false,
      });

      await category.permissionOverwrites.edit(role, {
        ViewChannel: true,
      });

      // Ensure the bot can always manage this category and its channels
      const botMember = guild.members.me;
      if (botMember) {
        await category.permissionOverwrites.edit(botMember, {
          ViewChannel: true,
          ManageChannels: true,
          ManageRoles: true,
        });
      } else {
        logger.warn(
          `Unable to set category permissions for bot user in guild ${guild.id} - guild.members.me is null`,
        );
      }

      // Create text channel in the category with sanitized name
      // Discord channel names: lowercase, no spaces, 1-100 chars, alphanumeric + hyphens/underscores
      const sanitizedName = roleName
        .toLowerCase()
        .replace(/\s+/g, "-") // Replace spaces with hyphens
        .replace(/[^a-z0-9-_]/g, "") // Remove special characters
        .substring(0, 100); // Limit to 100 characters

      if (!sanitizedName) {
        throw new Error(
          "Role name must contain at least one alphanumeric character for channel creation",
        );
      }

      channel = (await guild.channels.create({
        name: sanitizedName,
        type: ChannelType.GuildText,
        parent: category.id,
        reason: `Channel for reaction role: ${roleName}`,
      })) as TextChannel;

      logger.info(`Created channel: ${channel.name} (${channel.id})`);

      // Get the configured message channel
      const messageChannelId = await this.configService.getString(
        "reactionroles.message_channel_id",
        "",
      );

      if (!messageChannelId) {
        throw new Error(
          "Reaction role message channel not configured. Set reactionroles.message_channel_id",
        );
      }

      const messageChannel = (await guild.channels.fetch(
        messageChannelId,
      )) as TextChannel;

      if (!messageChannel || !messageChannel.isTextBased()) {
        throw new Error(
          `Message channel ${messageChannelId} not found or is not a text channel`,
        );
      }

      // Determine the surface style for this message from config.
      const style = await this.resolveDefaultStyle();

      // Create the self-assign role message with the appropriate surface.
      message = await messageChannel.send(
        this.buildRoleMessagePayload({
          emoji,
          roleName,
          roleId: role.id,
          style,
        }),
      );

      // Only the legacy reaction surface needs an actual reaction added.
      if (style === "reaction") {
        try {
          await message.react(emoji);
        } catch (reactionError) {
          logger.error("Failed to add reaction to message:", reactionError);
          throw new Error(
            "Failed to add reaction. The emoji might be invalid or inaccessible.",
          );
        }
      }

      logger.info(
        `Created ${style} self-assign role message ${message.id} in channel ${messageChannel.name}`,
      );

      // Save to database
      const reactionRoleConfig = new ReactionRoleConfig({
        guildId,
        messageId: message.id,
        channelId: channel.id,
        roleId: role.id,
        categoryId: category.id,
        emoji: normalizedEmoji,
        roleName,
        style,
        isArchived: false,
      });

      try {
        await reactionRoleConfig.save();
      } catch (dbError) {
        logger.error("Failed to save reaction role config:", dbError);
        throw new Error("Failed to save configuration to database.");
      }

      logger.info(`Saved reaction role config for ${sanitizeForLog(roleName)}`);

      return {
        success: true,
        message: `Successfully created reaction role **${roleName}**!`,
        roleId: role.id,
        categoryId: category.id,
        channelId: channel.id,
        messageId: message.id,
      };
    } catch (error) {
      logger.error("Error creating reaction role, rolling back:", error);

      // Rollback: Delete created resources in reverse order
      if (message) {
        try {
          await message.delete();
          logger.info("Rolled back: deleted message");
        } catch (err) {
          logger.warn("Could not delete message during rollback:", err);
        }
      }

      if (channel) {
        try {
          await channel.delete();
          logger.info("Rolled back: deleted channel");
        } catch (err) {
          logger.warn("Could not delete channel during rollback:", err);
        }
      }

      if (category) {
        try {
          await category.delete();
          logger.info("Rolled back: deleted category");
        } catch (err) {
          logger.warn("Could not delete category during rollback:", err);
        }
      }

      if (role) {
        try {
          await role.delete();
          logger.info("Rolled back: deleted role");
        } catch (err) {
          logger.warn("Could not delete role during rollback:", err);
        }
      }

      return {
        success: false,
        message: `Failed to create reaction role: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }

  public async archiveReactionRole(
    guildId: string,
    roleName: string,
  ): Promise<{ success: boolean; message: string }> {
    try {
      const config = await ReactionRoleConfig.findOne({
        guildId,
        roleName,
        isArchived: false,
      });

      if (!config) {
        return {
          success: false,
          message: `Reaction role **${roleName}** not found or already archived`,
        };
      }

      // Mark as archived
      config.isArchived = true;
      config.archivedAt = new Date();
      await config.save();

      // Delete the reaction message
      try {
        const guild = await this.client.guilds.fetch(guildId);
        const messageChannelId = await this.configService.getString(
          "reactionroles.message_channel_id",
          "",
        );
        const messageChannel = (await guild.channels.fetch(
          messageChannelId,
        )) as TextChannel;

        if (messageChannel) {
          const message = await messageChannel.messages.fetch(config.messageId);
          if (message) {
            await message.delete();
            logger.info(
              `Deleted reaction message ${config.messageId} for archived role ${sanitizeForLog(roleName)}`,
            );
          }
        }
      } catch (error) {
        logger.error("Error deleting reaction message:", error);
      }

      logger.info(`Archived reaction role: ${sanitizeForLog(roleName)}`);

      return {
        success: true,
        message: `Successfully archived reaction role **${roleName}**. Role and channels are preserved but reactions are disabled.`,
      };
    } catch (error) {
      logger.error("Error archiving reaction role:", error);
      return {
        success: false,
        message: `Failed to archive reaction role: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }

  public async unarchiveReactionRole(
    guildId: string,
    roleName: string,
  ): Promise<{ success: boolean; message: string }> {
    try {
      const config = await ReactionRoleConfig.findOne({
        guildId,
        roleName,
        isArchived: true,
      });

      if (!config) {
        return {
          success: false,
          message: `Archived reaction role **${roleName}** not found`,
        };
      }

      const guild = await this.client.guilds.fetch(guildId);

      // Verify the role still exists
      const role = await guild.roles.fetch(config.roleId);
      if (!role) {
        return {
          success: false,
          message: `Role ${config.roleId} no longer exists. Cannot unarchive.`,
        };
      }

      // Get the configured message channel
      const messageChannelId = await this.configService.getString(
        "reactionroles.message_channel_id",
        "",
      );

      if (!messageChannelId) {
        return {
          success: false,
          message:
            "Reaction role message channel not configured. Set reactionroles.message_channel_id",
        };
      }

      const messageChannel = (await guild.channels.fetch(
        messageChannelId,
      )) as TextChannel;

      if (!messageChannel || !messageChannel.isTextBased()) {
        return {
          success: false,
          message: `Message channel ${messageChannelId} not found or is not a text channel`,
        };
      }

      // Recreate the message using the style the config was created with, so
      // component-backed configs stay component-backed after unarchiving.
      const style: ReactionRoleStyle = config.style ?? "reaction";
      const message = await messageChannel.send(
        this.buildRoleMessagePayload({
          emoji: config.emoji,
          roleName: config.roleName,
          roleId: config.roleId,
          style,
        }),
      );

      // Only the legacy reaction surface needs an actual reaction added; if it
      // fails, delete the message and abort.
      if (style === "reaction") {
        try {
          await message.react(config.emoji);
        } catch (reactionError) {
          logger.error("Failed to add reaction to message:", reactionError);
          try {
            await message.delete();
          } catch (deleteError) {
            logger.error(
              "Failed to delete message after reaction error:",
              deleteError,
            );
          }
          return {
            success: false,
            message: `Failed to add reaction to message. The emoji might be invalid.`,
          };
        }
      }

      logger.info(
        `Recreated ${style} self-assign role message ${message.id} for unarchived role ${sanitizeForLog(roleName)}`,
      );

      // Update database with error handling
      try {
        config.isArchived = false;
        config.archivedAt = undefined;
        config.messageId = message.id;
        await config.save();
      } catch (dbError) {
        logger.error(
          "Failed to update database after creating message:",
          dbError,
        );
        // Try to delete the message since DB update failed
        try {
          await message.delete();
        } catch (deleteError) {
          logger.error("Failed to delete message after DB error:", deleteError);
        }
        return {
          success: false,
          message: `Failed to update database. Please try again.`,
        };
      }

      logger.info(`Unarchived reaction role: ${sanitizeForLog(roleName)}`);

      return {
        success: true,
        message: `Successfully unarchived reaction role **${roleName}**. Users can now react to get this role again!`,
      };
    } catch (error) {
      logger.error("Error unarchiving reaction role:", error);
      return {
        success: false,
        message: `Failed to unarchive reaction role: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }

  public async deleteReactionRole(
    guildId: string,
    roleName: string,
  ): Promise<{ success: boolean; message: string }> {
    try {
      const config = await ReactionRoleConfig.findOne({
        guildId,
        roleName,
      });

      if (!config) {
        return {
          success: false,
          message: `Reaction role **${roleName}** not found`,
        };
      }

      const guild = await this.client.guilds.fetch(guildId);

      // Delete message
      try {
        const messageChannelId = await this.configService.getString(
          "reactionroles.message_channel_id",
          "",
        );
        if (messageChannelId) {
          const messageChannel = (await guild.channels.fetch(
            messageChannelId,
          )) as TextChannel;
          if (messageChannel) {
            const message = await messageChannel.messages.fetch(
              config.messageId,
            );
            if (message) {
              await message.delete();
            }
          }
        }
      } catch (error) {
        logger.warn("Could not delete reaction message:", error);
      }

      // Delete category (which will handle all child channels)
      try {
        const category = await guild.channels.fetch(config.categoryId);
        if (category) {
          // Delete all channels in category first
          const categoryChannel = category as CategoryChannel;
          for (const [, channel] of categoryChannel.children.cache) {
            try {
              await channel.delete();
            } catch (err) {
              logger.warn(`Could not delete channel ${channel.id}:`, err);
            }
          }
          await category.delete();
          logger.info(`Deleted category ${config.categoryId}`);
        }
      } catch (error) {
        logger.warn("Could not delete category:", error);
      }

      // Delete role
      try {
        const role = await guild.roles.fetch(config.roleId);
        if (role) {
          await role.delete();
          logger.info(`Deleted role ${config.roleId}`);
        }
      } catch (error) {
        logger.warn("Could not delete role:", error);
      }

      // Delete from database
      await ReactionRoleConfig.deleteOne({ _id: config._id });

      logger.info(`Fully deleted reaction role: ${sanitizeForLog(roleName)}`);

      return {
        success: true,
        message: `Successfully deleted reaction role **${roleName}** and all associated resources.`,
      };
    } catch (error) {
      logger.error("Error deleting reaction role:", error);
      return {
        success: false,
        message: `Failed to delete reaction role: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }

  public async listReactionRoles(
    guildId: string,
  ): Promise<IReactionRoleConfig[]> {
    try {
      const configs = await ReactionRoleConfig.find({ guildId }).sort({
        createdAt: -1,
      });
      return configs;
    } catch (error) {
      logger.error("Error listing reaction roles:", error);
      return [];
    }
  }

  public async getReactionRoleStatus(
    guildId: string,
    roleName: string,
  ): Promise<IReactionRoleConfig | null> {
    try {
      const config = await ReactionRoleConfig.findOne({
        guildId,
        roleName,
      });
      return config;
    } catch (error) {
      logger.error("Error getting reaction role status:", error);
      return null;
    }
  }
}
