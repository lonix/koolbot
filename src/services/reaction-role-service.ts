import {
  Client,
  TextChannel,
  EmbedBuilder,
  ChannelType,
  CategoryChannel,
  MessageReaction,
  User,
  Role,
  GuildMember,
  Message,
  Guild,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  ComponentEmojiResolvable,
  MessageCreateOptions,
  PartialMessage,
  DMChannel,
  NonThreadGuildBasedChannel,
  GuildTextBasedChannel,
  DiscordAPIError,
  MessageFlags,
} from "discord.js";
import { isValidObjectId } from "mongoose";
import { ConfigService } from "./config-service.js";
import { CommandManager } from "./command-manager.js";
import logger from "../utils/logger.js";
import { waitForClientReady } from "../utils/discord.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";
import {
  ReactionRoleConfig,
  IReactionRoleConfig,
  ReactionRoleStyle,
  REACTION_ROLE_STYLES,
  ReactionRoleMode,
  REACTION_ROLE_MODES,
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

/**
 * Outcome of resolving the shared `reactionroles.message_channel_id` channel
 * during a reconciliation pass. `deleted` is only ever reported for a
 * *confirmed* deletion (a `10003 Unknown Channel` REST error, or an explicit
 * null from the channel manager); anything else — a timeout, a 5xx, a missing
 * permission, a channel that is no longer text-based — is `unavailable` and
 * must leave the guild's mappings alone.
 *
 * `ok` carries a `GuildTextBasedChannel` rather than a `TextChannel`: that is
 * exactly what `isTextBased()` narrows to, and an announcement channel or a
 * thread is a perfectly valid home for a reaction-role message.
 */
type MessageChannelResolution =
  | { status: "ok"; channel: GuildTextBasedChannel }
  | { status: "deleted" }
  | { status: "unavailable" };

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

  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.warn("Reaction role service already initialized, skipping...");
      return;
    }

    logger.info("Initializing reaction role service...");

    this.isInitialized = true;

    try {
      await waitForClientReady(this.client, "ReactionRoleService");

      const enabled = await this.configService.getBoolean(
        "reactionroles.enabled",
        false,
      );
      if (!enabled) {
        logger.info("Reaction roles feature is disabled");
        return;
      }

      // Gateway reaction events are routed from src/index.ts into
      // handleReactionAdd/handleReactionRemove; the service no longer
      // subscribes to the client directly. messageDelete / roleDelete /
      // channelDelete are likewise routed in to the handle*Delete methods.

      // Self-heal after downtime: verify each active config still points at a
      // live message + role, archive the ones that don't, and re-add the bot's
      // own base reaction if it went missing while offline.
      await this.reconcileConfigs();

      logger.info("Reaction role service initialized successfully");
    } catch (error) {
      logger.error("Error initializing reaction role service:", error);
      // Reset initialization flag on error to allow retry
      this.isInitialized = false;
    }
  }

  /**
   * Startup reconciliation (#814). For every active reaction-role config,
   * confirm the shared message channel, the reaction message and the target
   * role still exist; archive the config when any of them is gone, and
   * otherwise re-add the bot's own base reaction if a member (or Discord)
   * cleared it while the bot was offline.
   *
   * Archiving is only ever driven by a *confirmed* deletion (10003 Unknown
   * Channel / 10008 Unknown Message / 10011 Unknown Role, or an explicit null);
   * any other failure skips the config for this pass.
   *
   * Best-effort and defensive: a failure on one config is logged and never
   * aborts the pass or crashes startup. Bulk REST work goes through
   * `CommandManager.makeDiscordApiCall` for shared timeout + backoff.
   */
  public async reconcileConfigs(): Promise<void> {
    let configs: IReactionRoleConfig[];
    try {
      configs = await ReactionRoleConfig.find({ isArchived: false });
    } catch (error) {
      logger.error(
        "Reaction role reconciliation: failed to load configs",
        error,
      );
      return;
    }

    if (configs.length === 0) {
      logger.debug("Reaction role reconciliation: no active configs");
      return;
    }

    const messageChannelId = await this.configService.getString(
      "reactionroles.message_channel_id",
      "",
    );
    const commandManager = CommandManager.getInstance(this.client);

    let archived = 0;
    let repaired = 0;

    // The message-channel id is global, so its fate is decided once per guild
    // rather than re-fetched for every config in that guild.
    const messageChannels = new Map<string, MessageChannelResolution>();

    for (const config of configs) {
      try {
        const guild = await this.client.guilds.fetch(config.guildId);

        // Verify the target role still exists. Only a *confirmed* Unknown Role
        // (10011) — or an explicit null from the manager — means the role was
        // deleted; a transient network/permission error must not archive a
        // healthy mapping, so we log and skip it for this pass instead.
        let role: Role | null;
        try {
          role = await guild.roles.fetch(config.roleId);
        } catch (error) {
          if (this.isUnknownEntityError(error, 10011)) {
            role = null;
          } else {
            logger.warn(
              `Reaction role reconciliation: transient error fetching role ${config.roleId}, skipping`,
              error,
            );
            continue;
          }
        }
        if (!role) {
          await this.archiveConfig(
            config,
            `role ${config.roleId} no longer exists`,
          );
          archived++;
          continue;
        }

        // Verify the reaction message still exists in the configured channel.
        if (!messageChannelId) {
          continue;
        }
        // A deleted message channel takes every mapping's message with it.
        // `handleChannelDelete` covers that live, but the event is delivered to
        // nobody when the channel is deleted while the bot is down, so a
        // *confirmed* deletion archives here too — mirroring the role (10011)
        // and message (10008) paths in this same loop (#870).
        const resolution = await this.resolveMessageChannel(
          guild,
          messageChannelId,
          messageChannels,
        );
        if (resolution.status === "deleted") {
          await this.archiveConfig(
            config,
            `reaction message channel ${messageChannelId} no longer exists`,
          );
          archived++;
          continue;
        }
        if (resolution.status === "unavailable") {
          continue;
        }
        const messageChannel = resolution.channel;

        // Only a confirmed Unknown Message (10008) means the reaction message
        // was deleted; transient fetch failures skip rather than archive.
        let message: Message | null;
        try {
          message = await messageChannel.messages.fetch(config.messageId);
        } catch (error) {
          if (this.isUnknownEntityError(error, 10008)) {
            await this.archiveConfig(
              config,
              `reaction message ${config.messageId} no longer exists`,
            );
            archived++;
            continue;
          }
          logger.warn(
            `Reaction role reconciliation: transient error fetching message ${config.messageId}, skipping`,
            error,
          );
          continue;
        }
        if (!message) {
          await this.archiveConfig(
            config,
            `reaction message ${config.messageId} no longer exists`,
          );
          archived++;
          continue;
        }

        // Re-add the bot's own base reaction if it went missing.
        const hasOwnReaction = message.reactions.cache.some(
          (r) => this.buildEmojiIdentifier(r) === config.emoji && r.me,
        );
        if (!hasOwnReaction) {
          await commandManager.makeDiscordApiCall(
            () => message.react(config.emoji),
            `re-add reaction ${config.emoji} on message ${config.messageId}`,
          );
          repaired++;
          logger.info(
            `Reaction role reconciliation: re-added base reaction for ${sanitizeForLog(config.roleName)}`,
          );
        }
      } catch (error) {
        logger.warn(
          `Reaction role reconciliation: error processing config ${config._id}`,
          error,
        );
      }
    }

    logger.info(
      `Reaction role reconciliation complete: ${configs.length} checked, ${archived} archived, ${repaired} reaction(s) repaired`,
    );
  }

  /**
   * Resolve the shared `reactionroles.message_channel_id` channel for a guild,
   * memoized for the lifetime of one reconciliation pass so a single fetch
   * decides the fate of every mapping in that guild.
   *
   * Only a confirmed `10003 Unknown Channel` (or an explicit null, which means
   * the same thing) reports `deleted`; every other failure reports
   * `unavailable` so a transient blip can never mass-archive a healthy guild.
   */
  private async resolveMessageChannel(
    guild: Guild,
    messageChannelId: string,
    cache: Map<string, MessageChannelResolution>,
  ): Promise<MessageChannelResolution> {
    const cached = cache.get(guild.id);
    if (cached) {
      return cached;
    }

    let resolution: MessageChannelResolution;
    try {
      const channel = await guild.channels.fetch(messageChannelId);
      if (!channel) {
        resolution = { status: "deleted" };
      } else if (!channel.isTextBased()) {
        logger.warn(
          `Reaction role reconciliation: message channel ${messageChannelId} is not text-based, skipping`,
        );
        resolution = { status: "unavailable" };
      } else {
        resolution = { status: "ok", channel };
      }
    } catch (error) {
      if (this.isUnknownEntityError(error, 10003)) {
        resolution = { status: "deleted" };
      } else {
        logger.warn(
          `Reaction role reconciliation: could not fetch message channel ${messageChannelId}, skipping`,
          error,
        );
        resolution = { status: "unavailable" };
      }
    }

    if (resolution.status === "deleted") {
      logger.warn(
        `Reaction role reconciliation: message channel ${messageChannelId} no longer exists in guild ${guild.id}; archiving its mappings`,
      );
    }

    cache.set(guild.id, resolution);
    return resolution;
  }

  /**
   * True only for a Discord REST error whose numeric code confirms the entity
   * is genuinely gone (e.g. 10008 Unknown Message, 10011 Unknown Role, 10003
   * Unknown Channel) — as opposed to a transient network/timeout/permission
   * failure, which must not be treated as a deletion.
   */
  private isUnknownEntityError(error: unknown, code: number): boolean {
    return error instanceof DiscordAPIError && error.code === code;
  }

  /**
   * Archive a config as part of self-healing (stale message/role/channel).
   * Idempotent and swallows write errors so cleanup never crashes a caller.
   */
  private async archiveConfig(
    config: IReactionRoleConfig,
    reason: string,
  ): Promise<void> {
    if (config.isArchived) {
      return;
    }
    try {
      config.isArchived = true;
      config.archivedAt = new Date();
      await config.save();
      logger.info(
        `Archived reaction role ${sanitizeForLog(config.roleName)}: ${reason}`,
      );
    } catch (error) {
      logger.error(
        `Failed to archive reaction role ${sanitizeForLog(config.roleName)}:`,
        error,
      );
    }
  }

  /**
   * Handle a `messageDelete` event routed from `src/index.ts`. If the deleted
   * message backed one or more active reaction-role configs, archive them so
   * the config table stops drifting from reality (#814).
   */
  public async handleMessageDelete(
    message: Message | PartialMessage,
  ): Promise<void> {
    try {
      const configs = await ReactionRoleConfig.find({
        messageId: message.id,
        isArchived: false,
      });
      for (const config of configs) {
        await this.archiveConfig(
          config,
          `reaction message ${message.id} was deleted`,
        );
      }
    } catch (error) {
      logger.error("Error handling reaction-role message delete:", error);
    }
  }

  /**
   * Handle a `roleDelete` event routed from `src/index.ts`. Archive any active
   * config that granted the now-deleted role (#814).
   */
  public async handleRoleDelete(role: Role): Promise<void> {
    try {
      const configs = await ReactionRoleConfig.find({
        guildId: role.guild.id,
        roleId: role.id,
        isArchived: false,
      });
      for (const config of configs) {
        await this.archiveConfig(config, `role ${role.id} was deleted`);
      }
    } catch (error) {
      logger.error("Error handling reaction-role role delete:", error);
    }
  }

  /**
   * Handle a `channelDelete` event routed from `src/index.ts`. Archive any
   * active config whose backing category/channel was deleted (#814) — or, when
   * the deleted channel is the shared `reactionroles.message_channel_id`, every
   * active config in the guild, since that channel holds every reaction-role
   * message regardless of whether a mapping owns a channel of its own (#860).
   */
  public async handleChannelDelete(
    channel: DMChannel | NonThreadGuildBasedChannel,
  ): Promise<void> {
    try {
      // DM channels can never back a reaction role.
      if (!("guild" in channel) || !channel.guild) {
        return;
      }

      const messageChannelId = await this.configService.getString(
        "reactionroles.message_channel_id",
        "",
      );

      // Deleting the shared message channel takes every reaction-role message
      // with it, so *every* active mapping in the guild is invalidated — not
      // just the ones that also own a dedicated channel. Bind-to-existing-role
      // and `createChannel: false` mappings never set `channelId` at all, so a
      // `channelId`-scoped clause would silently skip them (#860).
      const filter =
        messageChannelId === channel.id
          ? { guildId: channel.guild.id, isArchived: false }
          : {
              guildId: channel.guild.id,
              isArchived: false,
              $or: [{ channelId: channel.id }, { categoryId: channel.id }],
            };

      const configs = await ReactionRoleConfig.find(filter);

      const reason =
        messageChannelId === channel.id
          ? `reaction message channel ${channel.id} was deleted`
          : `channel ${channel.id} was deleted`;

      for (const config of configs) {
        await this.archiveConfig(config, reason);
      }
    } catch (error) {
      logger.error("Error handling reaction-role channel delete:", error);
    }
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

  /**
   * Handle a `messageReactionAdd` event routed from `src/index.ts`. The caller
   * resolves partials and skips bot reactors before invoking this method.
   * Writes are gated on `reactionroles.enabled = true`.
   */
  public async handleReactionAdd(
    reaction: MessageReaction,
    user: User,
  ): Promise<void> {
    try {
      const enabled = await this.configService.getBoolean(
        "reactionroles.enabled",
        false,
      );
      if (!enabled) {
        return;
      }

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
        await member.roles.add(role);
        logger.info(`Added role ${role.name} to user ${user.tag}`);
      } else {
        logger.debug(`User ${user.tag} already has role ${role.name}`);
      }

      // `unique` (one-of-set): reacting to one option clears the sibling
      // roles configured on the same message, so a member ends up with at
      // most one role from the group (e.g. exactly one colour role).
      if (config.mode === "unique") {
        await this.applyUniqueMode(reaction, member, config);
      }
    } catch (error) {
      logger.error("Error adding role from reaction:", error);
    }
  }

  /**
   * Enforce `unique` mode: remove every sibling role configured on the same
   * message (any active config with the same `messageId` but a different
   * `roleId`) and, best-effort, clear the member's reaction on those sibling
   * emojis so the visible reactions match the single active choice.
   */
  private async applyUniqueMode(
    reaction: MessageReaction,
    member: GuildMember,
    config: IReactionRoleConfig,
  ): Promise<void> {
    const siblings = await ReactionRoleConfig.find({
      messageId: config.messageId,
      isArchived: false,
      roleId: { $ne: config.roleId },
    });

    for (const sibling of siblings) {
      try {
        if (member.roles.cache.has(sibling.roleId)) {
          await member.roles.remove(sibling.roleId);
          logger.info(
            `Removed sibling role ${sibling.roleName} from user ${member.id} (unique mode)`,
          );
        }

        // Best-effort: drop the member's reaction on the sibling emoji so the
        // message reflects the single active choice. Requires ManageMessages;
        // failures are non-fatal.
        const siblingReaction = reaction.message.reactions?.cache?.find(
          (r) => this.buildEmojiIdentifier(r) === sibling.emoji,
        );
        if (siblingReaction) {
          await siblingReaction.users.remove(member.id);
        }
      } catch (error) {
        logger.warn(
          `Could not clear sibling reaction role ${sibling.roleName} in unique mode:`,
          error,
        );
      }
    }
  }

  /**
   * Handle a `messageReactionRemove` event routed from `src/index.ts`. The
   * caller resolves partials and skips bot reactors before invoking this
   * method. Writes are gated on `reactionroles.enabled = true`.
   */
  public async handleReactionRemove(
    reaction: MessageReaction,
    user: User,
  ): Promise<void> {
    try {
      const enabled = await this.configService.getBoolean(
        "reactionroles.enabled",
        false,
      );
      if (!enabled) {
        return;
      }

      const emojiToMatch = this.buildEmojiIdentifier(reaction);

      const config = await ReactionRoleConfig.findOne({
        messageId: reaction.message.id,
        emoji: emojiToMatch,
        isArchived: false,
      });

      if (!config) {
        return;
      }

      // `sticky` (add-only): reacting grants the role, but removing the
      // reaction never revokes it. Good for opt-in cosmetic roles.
      if (config.mode === "sticky") {
        logger.debug(
          `Ignoring reaction removal for sticky reaction role ${config.roleName}`,
        );
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
    mode?: ReactionRoleMode;
  }): MessageCreateOptions {
    const { emoji, roleName, roleId, style, mode = "toggle" } = config;

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
        // Discord caps button labels at 80 chars; role names may be up to 100.
        .setLabel(roleName.slice(0, 80))
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
        // Discord caps select-option labels at 100 chars.
        label: roleName.slice(0, 100),
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
    // Description/footer track the assignment mode so a sticky mapping never
    // tells members that unreacting removes the role (it doesn't).
    let description = `React with ${emoji} to get access to the **${roleName}** role and channels!`;
    let footer = "Remove your reaction to lose access";
    if (mode === "sticky") {
      footer = "Removing your reaction keeps the role";
    } else if (mode === "unique") {
      description = `React with ${emoji} to get the **${roleName}** role and its channels. This clears the other roles offered on this message.`;
      footer = "Reacting here swaps you to this role";
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`${emoji} ${roleName}`)
      .setDescription(description)
      .setFooter({ text: footer })
      .setTimestamp();
    return { embeds: [embed] };
  }

  /**
   * Add or remove a role on an already-fetched member and return a
   * human-readable, ephemeral confirmation line. The caller resolves the guild,
   * member and role once and reuses them, so a multi-role message only pays for
   * a single guild/member fetch. Shared by the button and select handlers.
   */
  private async applyRoleToggleForMember(
    member: GuildMember,
    role: Role,
    desired: "add" | "remove",
  ): Promise<string> {
    const hasRole = member.roles.cache.has(role.id);

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
          flags: MessageFlags.Ephemeral,
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
          flags: MessageFlags.Ephemeral,
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
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const guild = await this.client.guilds.fetch(interaction.guildId);
      const member = await guild.members.fetch(interaction.user.id);
      const role =
        guild.roles.cache.get(roleId) ?? (await guild.roles.fetch(roleId));
      if (!role) {
        logger.error(
          `Role ${roleId} not found while toggling self-assign role`,
        );
        await interaction.reply({
          content: "⚠️ That role no longer exists.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const desired = member.roles.cache.has(roleId) ? "remove" : "add";
      const message = await this.applyRoleToggleForMember(
        member,
        role,
        desired,
      );

      await interaction.reply({
        content: message,
        flags: MessageFlags.Ephemeral,
      });
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
          flags: MessageFlags.Ephemeral,
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
          flags: MessageFlags.Ephemeral,
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
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const managedRoleIds = new Set(configs.map((c) => c.roleId));
      const selected = new Set(
        interaction.values.filter((v) => managedRoleIds.has(v)),
      );

      // Fetch the guild and member once, then reason about every managed role
      // against the member's cached roles — no per-role REST fetches.
      const guild = await this.client.guilds.fetch(interaction.guildId);
      const member = await guild.members.fetch(interaction.user.id);

      const lines: string[] = [];
      for (const roleId of managedRoleIds) {
        const desired = selected.has(roleId) ? "add" : "remove";
        const hasRole = member.roles.cache.has(roleId);
        // Only act (and report) when the selection actually changes state.
        if (
          (desired === "add" && !hasRole) ||
          (desired === "remove" && hasRole)
        ) {
          const role =
            guild.roles.cache.get(roleId) ?? (await guild.roles.fetch(roleId));
          if (!role) {
            logger.error(
              `Role ${roleId} not found while toggling self-assign role`,
            );
            continue;
          }
          lines.push(
            await this.applyRoleToggleForMember(member, role, desired),
          );
        }
      }

      await interaction.reply({
        content: lines.length > 0 ? lines.join("\n") : "No changes made.",
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      logger.error("Error handling reaction-role select menu:", error);
      await this.safeErrorReply(interaction);
    }
  }

  /** Reply (or follow up) with a generic error without throwing again. */
  private async safeErrorReply(
    interaction: ButtonInteraction | StringSelectMenuInteraction,
  ): Promise<void> {
    const content = "⚠️ Something went wrong updating your roles.";
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      }
    } catch {
      // Nothing more we can do if the interaction can't be answered.
    }
  }

  /**
   * Normalize an emoji into the format stored in the database. Custom emojis
   * are kept as their full `<:name:id>` / `<a:name:id>` markup; standard
   * emojis are stored as their Unicode character unchanged.
   */
  private normalizeEmoji(emoji: string): string {
    const customEmojiMatch = emoji.match(/<a?:(\w+):(\d+)>/);
    return customEmojiMatch ? customEmojiMatch[0] : emoji;
  }

  /**
   * Resolve a role reference to its snowflake. Accepts a raw id, a role mention
   * (`<@&123>`), or an id with surrounding whitespace, so the bind path honours
   * the "accept a role id/mention" contract (#813). Returns the trimmed input
   * unchanged when no snowflake is found, letting `roles.fetch` reject it with a
   * clear "not found" message.
   */
  private normalizeRoleId(roleRef: string): string {
    const match = roleRef.match(/(\d{17,20})/);
    return match ? match[1] : roleRef.trim();
  }

  /**
   * Validate up front that the bot can actually assign `role` before we wire a
   * reaction to it. `member.roles.add()` fails at runtime when the bot lacks
   * Manage Roles, when the target role sits at or above the bot's highest
   * role, or when the role is integration-managed — historically this only
   * surfaced as a `logger.error` deep inside `handleReactionAdd`. Surfacing it
   * at create/bind time turns a silent no-op into an actionable message.
   */
  private async validateRoleAssignable(
    guild: Guild,
    role: Role,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const botMember =
      guild.members.me ?? (await guild.members.fetchMe().catch(() => null));

    if (!botMember) {
      return {
        ok: false,
        message: "I couldn't resolve my own membership in this server.",
      };
    }

    if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return {
        ok: false,
        message:
          "I need the **Manage Roles** permission to assign roles from reactions.",
      };
    }

    if (role.id === guild.roles.everyone.id) {
      return {
        ok: false,
        message: "The @everyone role can't be used as a reaction role.",
      };
    }

    if (role.managed) {
      return {
        ok: false,
        message: `**${role.name}** is managed by an integration or bot and can't be assigned manually.`,
      };
    }

    if (botMember.roles.highest.comparePositionTo(role) <= 0) {
      return {
        ok: false,
        message: `My highest role must be above **${role.name}** in the role list. Move my role higher under Server Settings → Roles, then try again.`,
      };
    }

    return { ok: true };
  }

  /**
   * Create a brand-new role (and, unless opted out, a private category +
   * channel) and post a single-emoji reaction-role message for it. This is the
   * original, heavily-opinionated flow, preserved for backward compatibility.
   *
   * @param options.createChannel When `true` (default) the bot also creates a
   *   private category + text channel locked to the new role. Set `false` to
   *   create a self-assign role with no attached channel (issue #813).
   */
  public async createReactionRole(
    guildId: string,
    roleName: string,
    emoji: string,
    options: { createChannel?: boolean; mode?: ReactionRoleMode } = {},
  ): Promise<{
    success: boolean;
    message: string;
    roleId?: string;
    categoryId?: string;
    channelId?: string;
    messageId?: string;
  }> {
    const createChannel = options.createChannel ?? true;
    let role: Role | null = null;
    let category: CategoryChannel | null = null;
    let channel: TextChannel | null = null;
    let message: Message | null = null;

    // Guard against unexpected mode values reaching the DB enum validator.
    const mode: ReactionRoleMode = options.mode ?? "toggle";
    const normalizedMode: ReactionRoleMode = REACTION_ROLE_MODES.includes(mode)
      ? mode
      : "toggle";

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

      // Verify up front that the bot can manage roles at all — otherwise we'd
      // create a role, category, and channel only for `member.roles.add()` to
      // fail silently at reaction time (#813).
      const botMemberEarly =
        guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
      if (!botMemberEarly?.permissions.has(PermissionFlagsBits.ManageRoles)) {
        return {
          success: false,
          message:
            "I need the **Manage Roles** permission to create reaction roles.",
        };
      }

      const normalizedEmoji = this.normalizeEmoji(emoji);

      // Create the role
      role = await guild.roles.create({
        name: roleName,
        reason: `Reaction role created: ${roleName}`,
      });

      logger.info(`Created role: ${role.name} (${role.id})`);

      if (createChannel) {
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
      }

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
          mode: normalizedMode,
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
            { cause: reactionError },
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
        channelId: channel?.id,
        roleId: role.id,
        categoryId: category?.id,
        emoji: normalizedEmoji,
        roleName,
        style,
        autoCreated: true,
        mode: normalizedMode,
        isArchived: false,
      });

      try {
        await reactionRoleConfig.save();
      } catch (dbError) {
        logger.error("Failed to save reaction role config:", dbError);
        throw new Error("Failed to save configuration to database.", {
          cause: dbError,
        });
      }

      logger.info(`Saved reaction role config for ${sanitizeForLog(roleName)}`);

      return {
        success: true,
        message: `Successfully created reaction role **${roleName}**!`,
        roleId: role.id,
        categoryId: category?.id,
        channelId: channel?.id,
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

  /**
   * Bind an emoji reaction to an **existing** role, without creating a role,
   * category, or channel (issue #813). When `options.messageId` is supplied
   * the mapping is added to that existing message — letting one picker message
   * carry many emoji→role mappings — otherwise a fresh single-mapping message
   * is posted to the configured reaction-role channel.
   *
   * The role hierarchy is validated up front so binding to an unassignable
   * role fails fast with an actionable message rather than silently no-opping
   * at reaction time.
   */
  public async bindReactionRole(
    guildId: string,
    roleId: string,
    emoji: string,
    options: { messageId?: string; messageChannelId?: string } = {},
  ): Promise<{
    success: boolean;
    message: string;
    roleId?: string;
    messageId?: string;
  }> {
    let postedMessage: Message | null = null;

    try {
      const guild = await this.client.guilds.fetch(guildId);

      // Accept a role id or a `<@&id>` mention.
      const resolvedRoleId = this.normalizeRoleId(roleId);
      const role = await guild.roles.fetch(resolvedRoleId).catch(() => null);
      if (!role) {
        return {
          success: false,
          message: `Role \`${roleId}\` was not found in this server.`,
        };
      }

      // Up-front hierarchy / permission validation (#813).
      const assignable = await this.validateRoleAssignable(guild, role);
      if (!assignable.ok) {
        return { success: false, message: assignable.message };
      }

      const normalizedEmoji = this.normalizeEmoji(emoji);

      // Resolve the channel that owns (or will own) the reaction message.
      const messageChannelId =
        options.messageChannelId ||
        (await this.configService.getString(
          "reactionroles.message_channel_id",
          "",
        ));

      if (!messageChannelId) {
        return {
          success: false,
          message:
            "Reaction role message channel not configured. Set reactionroles.message_channel_id",
        };
      }

      const messageChannel = (await guild.channels
        .fetch(messageChannelId)
        .catch(() => null)) as TextChannel | null;

      if (!messageChannel || !messageChannel.isTextBased()) {
        return {
          success: false,
          message: `Message channel ${messageChannelId} not found or is not a text channel.`,
        };
      }

      let targetMessage: Message;

      if (options.messageId) {
        // Add a mapping to an existing picker message.
        const existingMessage = await messageChannel.messages
          .fetch(options.messageId)
          .catch(() => null);
        if (!existingMessage) {
          return {
            success: false,
            message: `Message \`${options.messageId}\` was not found in <#${messageChannelId}>.`,
          };
        }

        // Reject a duplicate emoji on the same message: the reaction handlers
        // resolve one role per (message, emoji), so a collision is ambiguous.
        const duplicate = await ReactionRoleConfig.findOne({
          guildId,
          messageId: options.messageId,
          emoji: normalizedEmoji,
        });
        if (duplicate) {
          return {
            success: false,
            message: `That emoji is already mapped to a role on message \`${options.messageId}\`.`,
          };
        }

        targetMessage = existingMessage;
      } else {
        // Post a fresh single-mapping message for this existing role.
        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle(`${emoji} ${role.name}`)
          .setDescription(
            `React with ${emoji} to get the **${role.name}** role!`,
          )
          .setFooter({ text: "Remove your reaction to lose the role" })
          .setTimestamp();
        postedMessage = await messageChannel.send({ embeds: [embed] });
        targetMessage = postedMessage;
      }

      try {
        await targetMessage.react(emoji);
      } catch (reactionError) {
        logger.error("Failed to add reaction to message:", reactionError);
        // Only clean up a message we ourselves just posted.
        if (postedMessage) {
          await postedMessage.delete().catch((err) => {
            logger.warn("Could not delete message after reaction error:", err);
          });
        }
        return {
          success: false,
          message:
            "Failed to add reaction. The emoji might be invalid or inaccessible.",
        };
      }

      const reactionRoleConfig = new ReactionRoleConfig({
        guildId,
        messageId: targetMessage.id,
        roleId: role.id,
        emoji: normalizedEmoji,
        roleName: role.name,
        autoCreated: false,
        isArchived: false,
      });

      try {
        await reactionRoleConfig.save();
      } catch (dbError) {
        logger.error("Failed to save reaction role binding:", dbError);
        // Roll back the reaction we just added so users can't react to a
        // mapping that was never persisted (e.g. a duplicate lost the unique
        // index race). A freshly posted message is deleted outright, taking its
        // reaction with it; on an existing picker message we only remove the
        // bot's reaction and leave the message intact.
        if (postedMessage) {
          await postedMessage.delete().catch((err) => {
            logger.warn("Could not delete message after DB error:", err);
          });
        } else {
          await this.removeBotReaction(targetMessage, normalizedEmoji);
        }
        return {
          success: false,
          message: "Failed to save configuration to database.",
        };
      }

      logger.info(
        `Bound reaction ${normalizedEmoji} → existing role ${sanitizeForLog(role.name)} on message ${targetMessage.id}`,
      );

      return {
        success: true,
        message: `Bound ${emoji} to existing role **${role.name}**.`,
        roleId: role.id,
        messageId: targetMessage.id,
      };
    } catch (error) {
      logger.error("Error binding reaction role:", error);
      if (postedMessage) {
        await postedMessage.delete().catch((err) => {
          logger.warn("Could not delete message during rollback:", err);
        });
      }
      return {
        success: false,
        message: `Failed to bind reaction role: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }

  /**
   * Remove a single emoji→role mapping identified by its message + emoji.
   * Unlike {@link deleteReactionRole} (which tears down an entire auto-created
   * role + category + channel), this only unbinds one mapping: it removes the
   * bot's reaction and deletes the DB row, and deletes the underlying Discord
   * role/category/channel only when this mapping auto-created them and no other
   * mapping still references them.
   */
  public async removeReactionRoleMapping(
    guildId: string,
    messageId: string,
    emoji: string,
  ): Promise<{ success: boolean; message: string }> {
    try {
      const normalizedEmoji = this.normalizeEmoji(emoji);
      const config = await ReactionRoleConfig.findOne({
        guildId,
        messageId,
        emoji: normalizedEmoji,
      });

      if (!config) {
        return {
          success: false,
          message: `No mapping found for that emoji on message \`${messageId}\`.`,
        };
      }

      const guild = await this.client.guilds.fetch(guildId).catch(() => null);

      // Best-effort: remove the bot's own reaction so the picker stays tidy.
      if (guild) {
        try {
          const messageChannelId = await this.configService.getString(
            "reactionroles.message_channel_id",
            "",
          );
          if (messageChannelId) {
            const channel = (await guild.channels
              .fetch(messageChannelId)
              .catch(() => null)) as TextChannel | null;
            const message = await channel?.messages
              .fetch(messageId)
              .catch(() => null);
            if (message) {
              await this.removeBotReaction(message, normalizedEmoji);
            }
          }
        } catch (err) {
          logger.warn("Could not remove bot reaction while unbinding:", err);
        }
      }

      // Tear down auto-created Discord resources only when no other mapping
      // still references the same role. Checking the reference count *before*
      // touching the category or role means a role shared across several
      // pickers keeps its private channels until the last mapping is removed.
      // Bound (non-auto-created) mappings never delete their role.
      if (guild && config.autoCreated && config.roleId) {
        const stillUsed = await ReactionRoleConfig.countDocuments({
          guildId,
          roleId: config.roleId,
          _id: { $ne: config._id },
        });
        if (stillUsed === 0) {
          if (config.categoryId) {
            await this.deleteCategoryTree(guild, config.categoryId);
          }
          try {
            const role = await guild.roles.fetch(config.roleId);
            if (role) {
              await role.delete();
              logger.info(`Deleted role ${config.roleId}`);
            }
          } catch (err) {
            logger.warn("Could not delete role while unbinding:", err);
          }
        }
      }

      await ReactionRoleConfig.deleteOne({ _id: config._id });

      logger.info(
        `Removed reaction-role mapping ${normalizedEmoji} on message ${messageId} (${sanitizeForLog(config.roleName)})`,
      );

      return {
        success: true,
        message: `Removed the ${emoji} → **${config.roleName}** mapping.`,
      };
    } catch (error) {
      logger.error("Error removing reaction role mapping:", error);
      return {
        success: false,
        message: `Failed to remove mapping: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }

  /**
   * Best-effort removal of the bot's own reaction for a stored emoji from a
   * message. Used both to tidy a picker after unbinding and to roll back a
   * reaction whose mapping failed to persist.
   */
  private async removeBotReaction(
    message: Message,
    normalizedEmoji: string,
  ): Promise<void> {
    try {
      const reaction = message.reactions.cache.find(
        (r) => this.buildEmojiIdentifier(r) === normalizedEmoji,
      );
      await reaction?.users.remove(this.client.user?.id);
    } catch (err) {
      logger.warn("Could not remove bot reaction:", err);
    }
  }

  /**
   * Delete a category and every channel nested under it. Shared by the
   * full-delete and unbind paths.
   */
  private async deleteCategoryTree(
    guild: Guild,
    categoryId: string,
  ): Promise<void> {
    try {
      const category = await guild.channels.fetch(categoryId).catch(() => null);
      if (category) {
        const categoryChannel = category as CategoryChannel;
        for (const [, channel] of categoryChannel.children.cache) {
          try {
            await channel.delete();
          } catch (err) {
            logger.warn(`Could not delete channel ${channel.id}:`, err);
          }
        }
        await category.delete();
        logger.info(`Deleted category ${categoryId}`);
      }
    } catch (error) {
      logger.warn("Could not delete category:", error);
    }
  }

  /**
   * Create a one-of-set role group (#814): one shared reaction message carries
   * several role options, and each option's mapping shares the message id (and
   * a `groupId`) so `unique` mode has real siblings to clear. All options live
   * under a single shared category/channel gated to any of the group's roles.
   *
   * Reaction-surface only — `unique` is a reaction concept, and mixing button/
   * select components with one-of-set semantics is out of scope here.
   *
   * Fully transactional: on any failure every created role/channel/category/
   * message is rolled back so a partial group never lingers.
   */
  public async createReactionRoleGroup(
    guildId: string,
    groupName: string,
    entries: Array<{ roleName: string; emoji: string }>,
    mode: ReactionRoleMode = "unique",
  ): Promise<{
    success: boolean;
    message: string;
    groupId?: string;
    messageId?: string;
    roleIds?: string[];
  }> {
    // Validate the group shape before touching Discord.
    if (entries.length < 2) {
      return {
        success: false,
        message: "A role group needs at least two role options.",
      };
    }
    if (entries.length > 20) {
      return {
        success: false,
        message: "A role group can have at most 20 role options.",
      };
    }
    const names = entries.map((e) => e.roleName.trim());
    if (names.some((n) => n.length === 0)) {
      return { success: false, message: "Every role option needs a name." };
    }
    if (names.some((n) => n.length > 100)) {
      return {
        success: false,
        message: "Role names must be 100 characters or fewer.",
      };
    }
    const lowerNames = names.map((n) => n.toLowerCase());
    if (new Set(lowerNames).size !== lowerNames.length) {
      return {
        success: false,
        message: "Role names within a group must be unique.",
      };
    }
    const emojis = entries.map((e) => this.normalizeEmoji(e.emoji.trim()));
    if (emojis.some((e) => e.length === 0)) {
      return { success: false, message: "Every role option needs an emoji." };
    }
    if (new Set(emojis).size !== emojis.length) {
      return {
        success: false,
        message: "Emojis within a group must be unique.",
      };
    }

    const createdRoles: Role[] = [];
    let category: CategoryChannel | null = null;
    let channel: TextChannel | null = null;
    let message: Message | null = null;

    try {
      // A group is always one-of-set; anything else is meaningless for a shared
      // message, so coerce to `unique` unless a caller explicitly picks another
      // valid mode (e.g. sticky opt-in sets).
      const normalizedMode: ReactionRoleMode = REACTION_ROLE_MODES.includes(
        mode,
      )
        ? mode
        : "unique";

      // Reject if any target role name already exists (roleName is unique).
      const clash = await ReactionRoleConfig.findOne({
        guildId,
        roleName: { $in: names },
      });
      if (clash) {
        return {
          success: false,
          message: `A reaction role named **${clash.roleName}** already exists in this server.`,
        };
      }

      const guild = await this.client.guilds.fetch(guildId);

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

      // Create every role first so we can gate the shared category to all of
      // them at once.
      for (const name of names) {
        const role = await guild.roles.create({
          name,
          reason: `Reaction role group created: ${groupName}`,
        });
        createdRoles.push(role);
        logger.info(`Created role: ${role.name} (${role.id})`);
      }

      // One shared category, visible only to members of any role in the group.
      category = (await guild.channels.create({
        name: groupName,
        type: ChannelType.GuildCategory,
        reason: `Category for reaction role group: ${groupName}`,
      })) as CategoryChannel;
      await category.permissionOverwrites.edit(guild.roles.everyone, {
        ViewChannel: false,
      });
      for (const role of createdRoles) {
        await category.permissionOverwrites.edit(role, { ViewChannel: true });
      }
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

      const sanitizedName =
        groupName
          .toLowerCase()
          .replace(/\s+/g, "-")
          .replace(/[^a-z0-9-_]/g, "")
          .substring(0, 100) || "role-group";
      channel = (await guild.channels.create({
        name: sanitizedName,
        type: ChannelType.GuildText,
        parent: category.id,
        reason: `Channel for reaction role group: ${groupName}`,
      })) as TextChannel;

      // One message listing every option; unreact behaviour follows the mode.
      const optionLines = entries.map(
        (e, i) => `${emojis[i]} — **${names[i]}**`,
      );
      const footer =
        normalizedMode === "unique"
          ? "Pick one — reacting swaps you to that role"
          : normalizedMode === "sticky"
            ? "React to opt in — removing your reaction keeps the role"
            : "React to add a role, remove your reaction to lose it";
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(groupName)
        .setDescription(
          `React to choose your **${groupName}** role:\n\n${optionLines.join("\n")}`,
        )
        .setFooter({ text: footer })
        .setTimestamp();
      message = await messageChannel.send({ embeds: [embed] });

      // React with each option's emoji in order so the picker is ready to use.
      for (const emoji of emojis) {
        await message.react(emoji);
      }

      // groupId anchors the set; equal to the message id at creation.
      const groupId = message.id;

      // Persist one mapping per option, all sharing message/category/channel.
      const docs = entries.map((_, i) => ({
        guildId,
        messageId: message!.id,
        channelId: channel!.id,
        roleId: createdRoles[i].id,
        categoryId: category!.id,
        emoji: emojis[i],
        roleName: names[i],
        style: "reaction" as ReactionRoleStyle,
        // The bot creates every role/category/channel in a group, so it owns
        // their lifecycle (#824's autoCreated model); group delete tears down.
        autoCreated: true,
        mode: normalizedMode,
        groupId,
        isArchived: false,
      }));
      await ReactionRoleConfig.insertMany(docs);

      logger.info(
        `Created reaction role group ${sanitizeForLog(groupName)} (${docs.length} roles, mode ${normalizedMode})`,
      );

      return {
        success: true,
        message: `Successfully created role group **${groupName}** with ${docs.length} roles.`,
        groupId,
        messageId: message.id,
        roleIds: createdRoles.map((r) => r.id),
      };
    } catch (error) {
      logger.error("Error creating reaction role group, rolling back:", error);

      if (message) {
        await message
          .delete()
          .catch((err) =>
            logger.warn("Could not delete group message during rollback:", err),
          );
      }
      if (channel) {
        await channel
          .delete()
          .catch((err) =>
            logger.warn("Could not delete group channel during rollback:", err),
          );
      }
      if (category) {
        await category
          .delete()
          .catch((err) =>
            logger.warn(
              "Could not delete group category during rollback:",
              err,
            ),
          );
      }
      for (const role of createdRoles) {
        await role
          .delete()
          .catch((err) =>
            logger.warn("Could not delete group role during rollback:", err),
          );
      }

      return {
        success: false,
        message: `Failed to create role group: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }

  /**
   * Fully delete a role group (#814): every role in the group, the shared
   * category + channel, the shared message, and all the group's config rows.
   * Best-effort per resource so one failure never leaves the DB inconsistent.
   */
  public async deleteReactionRoleGroup(
    guildId: string,
    groupId: string,
  ): Promise<{ success: boolean; message: string }> {
    try {
      const configs = await ReactionRoleConfig.find({ guildId, groupId });
      if (configs.length === 0) {
        return { success: false, message: `Role group not found.` };
      }

      const guild = await this.client.guilds.fetch(guildId);
      const first = configs[0];

      // Delete the shared message.
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
              first.messageId,
            );
            if (message) {
              await message.delete();
            }
          }
        }
      } catch (error) {
        logger.warn("Could not delete group message:", error);
      }

      // Delete the shared category (and its child channels).
      try {
        const category = first.categoryId
          ? await guild.channels.fetch(first.categoryId)
          : null;
        if (category) {
          const categoryChannel = category as CategoryChannel;
          for (const [, child] of categoryChannel.children.cache) {
            await child
              .delete()
              .catch((err) =>
                logger.warn(`Could not delete channel ${child.id}:`, err),
              );
          }
          await category.delete();
        }
      } catch (error) {
        logger.warn("Could not delete group category:", error);
      }

      // Delete every role in the group.
      for (const config of configs) {
        try {
          const role = await guild.roles.fetch(config.roleId);
          if (role) {
            await role.delete();
          }
        } catch (error) {
          logger.warn(`Could not delete role ${config.roleId}:`, error);
        }
      }

      await ReactionRoleConfig.deleteMany({ guildId, groupId });

      logger.info(
        `Fully deleted reaction role group ${groupId} (${configs.length} roles)`,
      );

      return {
        success: true,
        message: `Successfully deleted role group and its ${configs.length} roles.`,
      };
    } catch (error) {
      logger.error("Error deleting reaction role group:", error);
      return {
        success: false,
        message: `Failed to delete role group: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }

  public async archiveReactionRole(
    guildId: string,
    mappingId: string,
  ): Promise<{ success: boolean; message: string }> {
    try {
      // Identify the mapping by its stable `_id`: role names are no longer
      // unique (#813), so keying on the name could archive the wrong picker.
      if (!isValidObjectId(mappingId)) {
        return { success: false, message: "Reaction role mapping not found." };
      }

      const config = await ReactionRoleConfig.findOne({
        _id: mappingId,
        guildId,
        isArchived: false,
      });

      if (!config) {
        return {
          success: false,
          message: "Reaction role mapping not found or already archived.",
        };
      }

      const roleName = config.roleName;

      // Group members share one message/category/channel; archiving a single
      // member would orphan the rest, so require the group-level operation.
      if (config.groupId) {
        return {
          success: false,
          message: `**${roleName}** belongs to a role group; archive or delete the whole group instead.`,
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
    mappingId: string,
  ): Promise<{ success: boolean; message: string }> {
    try {
      if (!isValidObjectId(mappingId)) {
        return {
          success: false,
          message: "Archived reaction role mapping not found.",
        };
      }

      const config = await ReactionRoleConfig.findOne({
        _id: mappingId,
        guildId,
        isArchived: true,
      });

      if (!config) {
        return {
          success: false,
          message: "Archived reaction role mapping not found.",
        };
      }

      const roleName = config.roleName;

      // Unarchiving one group member would recreate a single-role message
      // detached from its siblings; group lifecycle is managed as a unit.
      if (config.groupId) {
        return {
          success: false,
          message: `**${roleName}** belongs to a role group and cannot be unarchived individually.`,
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
          mode: config.mode ?? "toggle",
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
    mappingId: string,
  ): Promise<{ success: boolean; message: string }> {
    try {
      if (!isValidObjectId(mappingId)) {
        return { success: false, message: "Reaction role mapping not found." };
      }

      const config = await ReactionRoleConfig.findOne({
        _id: mappingId,
        guildId,
      });

      if (!config) {
        return {
          success: false,
          message: "Reaction role mapping not found.",
        };
      }

      const roleName = config.roleName;

      // Group members share resources; deleting one alone would tear down the
      // shared category/channel/message and orphan the siblings. Route the
      // caller to the group-level delete instead.
      if (config.groupId) {
        return {
          success: false,
          message: `**${roleName}** belongs to a role group; delete the whole group instead.`,
        };
      }

      const guild = await this.client.guilds.fetch(guildId);

      // Delete the reaction message only for auto-created mappings, which each
      // own a dedicated single-emoji message. Bound mappings may live on a
      // shared picker message alongside other mappings, so deleting it would
      // wipe those too — leave it in place (#813).
      if (config.autoCreated) {
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
      }

      // Only tear down the underlying Discord resources for mappings the bot
      // auto-created, and only when no other mapping still references the same
      // role. Now that a role can appear on more than one picker (#813),
      // deleting it here while another mapping points at it would leave that
      // mapping dangling and silently break its reactions — so gate the
      // category + role teardown on the reference count. Bound mappings never
      // delete their role.
      if (config.autoCreated) {
        const stillUsed = await ReactionRoleConfig.countDocuments({
          guildId,
          roleId: config.roleId,
          _id: { $ne: config._id },
        });
        if (stillUsed === 0) {
          // Delete category (which will handle all child channels)
          if (config.categoryId) {
            await this.deleteCategoryTree(guild, config.categoryId);
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
        } else {
          logger.info(
            `Kept role ${config.roleId}: still referenced by ${stillUsed} other mapping(s)`,
          );
        }
      }

      // Delete from database
      await ReactionRoleConfig.deleteOne({ _id: config._id });

      logger.info(`Fully deleted reaction role: ${sanitizeForLog(roleName)}`);

      return {
        success: true,
        message: config.autoCreated
          ? `Successfully deleted reaction role **${roleName}** and all associated resources.`
          : `Removed the reaction-role mapping for **${roleName}**. The existing role was left untouched.`,
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
