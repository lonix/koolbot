import {
  BOT_CATEGORY,
  GATED_CATEGORY_EVERYONE,
  GATED_CATEGORY_ROLE,
  toOverwriteOptions,
} from "../utils/channel-permissions.js";
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
  SnowflakeUtil,
} from "discord.js";
import { isValidObjectId } from "mongoose";
import { ConfigService } from "./config-service.js";
import { CommandManager } from "./command-manager.js";
import logger from "../utils/logger.js";
import { RoleGroupService } from "./role-group-service.js";
import { waitForClientReady } from "../utils/discord.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";
import { getErrorMessage } from "../utils/error-guards.js";
import {
  consumeBurst,
  reserveBurst,
  waitText,
} from "../utils/member-cooldown.js";
import {
  forbiddenSelfAssignNames,
  forbiddenSelfAssignPermissions,
} from "../utils/role-safety.js";
import { reactionRoleGuildLock } from "./reaction-role-guild-lock.js";
import {
  ReactionRoleConfig,
  IReactionRoleConfig,
  ReactionRoleStyle,
  REACTION_ROLE_STYLES,
  ReactionRoleMode,
  REACTION_ROLE_MODES,
} from "../models/reaction-role-config.js";

/**
 * A picker posted by a server-adoption step carries the step's key in its embed
 * footer. The message exists before its mapping is saved, so after a crash the
 * key is how a retry or a rollback finds (and proves ownership of) it.
 */
const PICKER_SEARCH_MAX_PAGES = 50;
const PICKER_REF_SEPARATOR = " · ";
const PICKER_REF_PREFIX = "ref ";
const isMarkedPicker = (
  message: {
    author?: { id: string };
    embeds?: Array<{ footer?: { text?: string } | null }>;
  },
  botId: string | undefined,
  ownerKey: string,
): boolean =>
  !!botId &&
  message.author?.id === botId &&
  (message.embeds ?? []).some((e) =>
    (e.footer?.text ?? "").endsWith(
      `${PICKER_REF_SEPARATOR}${PICKER_REF_PREFIX}${ownerKey}`,
    ),
  );

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
    let skipped = 0;
    let repaired = 0;

    // Each picker channel is fetched once per pass (keyed by guild + channel),
    // however many mappings live in it.
    const messageChannels = new Map<string, MessageChannelResolution>();

    // Mappings that remember their picker's channel (#1207) are looked up in
    // that channel, so a 10008 there is a confirmed deletion and archives at
    // once. Legacy rows (no stored channel) fall back to the configured channel,
    // where a 10008 may mean "deleted" or "the setting was changed after the
    // picker was posted" (#1113). Only those legacy rows are held back and
    // decided per guild after the loop, once we know whether *any* legacy picker
    // in that guild still resolves in the configured channel.
    const missingMessages = new Map<string, IReactionRoleConfig[]>();
    const liveMessages = new Map<string, number>();
    // Rows that share a picker message share its channel.
    const storedChannelByMessage = new Map<string, string>();
    for (const config of configs) {
      if (config.messageChannelId) {
        storedChannelByMessage.set(
          `${config.guildId}:${config.messageId}`,
          config.messageChannelId,
        );
      }
    }

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

        // Verify the reaction message still exists in its own channel, or in the
        // configured one for a legacy row.
        const storedChannelId =
          config.messageChannelId ||
          storedChannelByMessage.get(`${config.guildId}:${config.messageId}`) ||
          "";
        const pickerChannelId = storedChannelId || messageChannelId;
        if (!pickerChannelId) {
          continue;
        }
        // A deleted message channel takes every mapping's message with it.
        // `handleChannelDelete` covers that live, but the event is delivered to
        // nobody when the channel is deleted while the bot is down, so a
        // *confirmed* deletion archives here too — mirroring the role (10011)
        // and message (10008) paths in this same loop (#870).
        const resolution = await this.resolveMessageChannel(
          guild,
          pickerChannelId,
          messageChannels,
        );
        if (resolution.status === "deleted") {
          await this.archiveConfig(
            config,
            `reaction message channel ${pickerChannelId} no longer exists`,
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
            message = null;
          } else {
            logger.warn(
              `Reaction role reconciliation: transient error fetching message ${config.messageId}, skipping`,
              error,
            );
            continue;
          }
        }
        if (!message) {
          if (storedChannelId) {
            // The channel is the one the picker was posted in, so this is a
            // real deletion, not a changed setting.
            await this.archiveConfig(
              config,
              `reaction message ${config.messageId} no longer exists in channel ${pickerChannelId}`,
            );
            archived++;
          } else {
            this.noteMissingMessage(missingMessages, config);
          }
          continue;
        }
        if (!storedChannelId) {
          liveMessages.set(
            config.guildId,
            (liveMessages.get(config.guildId) ?? 0) + 1,
          );
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

    // A guild where no legacy picker resolved in the configured channel looks
    // exactly like one whose picker channel setting was changed after the
    // pickers were posted. Archiving would orphan every still-valid picker, so
    // leave the mappings active and flag it instead. The cost of being wrong the
    // other way is a stale row that never fires, which is harmless and logged
    // here. Pickers that remember their channel never reach this guard, and do
    // not count towards it: one resolving in its own channel says nothing about
    // whether a legacy picker's channel was changed.
    for (const [guildId, missing] of missingMessages) {
      if ((liveMessages.get(guildId) ?? 0) === 0) {
        logger.warn(
          `Reaction role reconciliation: none of the ${missing.length} reaction message(s) in guild ${sanitizeForLog(guildId)} were found in channel ${sanitizeForLog(messageChannelId)}. ` +
            "Not archiving: these older pickers do not remember their channel, so if reactionroles.message_channel_id was changed after they were posted, change it back or delete and regenerate the pickers (#1113, #1207).",
        );
        skipped += missing.length;
        continue;
      }
      for (const config of missing) {
        await this.archiveConfig(
          config,
          `reaction message ${config.messageId} no longer exists`,
        );
        archived++;
      }
    }

    logger.info(
      `Reaction role reconciliation complete: ${configs.length} checked, ${archived} archived, ${skipped} kept (older picker not found in configured channel), ${repaired} reaction(s) repaired`,
    );
  }

  private noteMissingMessage(
    missing: Map<string, IReactionRoleConfig[]>,
    config: IReactionRoleConfig,
  ): void {
    const list = missing.get(config.guildId) ?? [];
    list.push(config);
    missing.set(config.guildId, list);
  }

  /**
   * Resolve a picker channel for a guild (a mapping's stored channel, or the
   * shared `reactionroles.message_channel_id` for a legacy row), memoized per
   * guild + channel for the lifetime of one reconciliation pass so a single
   * fetch decides the fate of every mapping in that channel. The fetch is
   * forced: a cached channel would hide a deletion and a wrong answer here
   * archives mappings.
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
    const cacheKey = `${guild.id}:${messageChannelId}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    let resolution: MessageChannelResolution;
    try {
      // One forced REST call per picker channel per pass, through the shared
      // timeout + rate-limit wrapper. It rethrows a DiscordAPIError unchanged,
      // so a confirmed 10003 below is still recognised; a timeout or a 429
      // that outlasts the retries surfaces as `unavailable` (nothing archived).
      const channel = await CommandManager.getInstance(
        this.client,
      ).makeDiscordApiCall(
        () => guild.channels.fetch(messageChannelId, { force: true }),
        `fetch picker channel ${messageChannelId}`,
      );
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

    cache.set(cacheKey, resolution);
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
   * The channel a picker message lives in (#1207): the channel stored on any of
   * the given rows (rows on one message share it), otherwise the configured
   * `reactionroles.message_channel_id`, which is where every legacy row (one
   * created before the channel was stored) has always been looked up. Returns
   * "" when neither is known.
   */
  private pickerChannelOf(
    rows: Array<{ messageChannelId?: string | null }>,
    configured: string,
  ): string {
    return rows.find((r) => r.messageChannelId)?.messageChannelId || configured;
  }

  /** {@link pickerChannelOf} for one mapping, reading the configured channel. */
  private async pickerChannelFor(
    config: Pick<IReactionRoleConfig, "guildId" | "messageId"> & {
      messageChannelId?: string | null;
    },
  ): Promise<string> {
    if (config.messageChannelId) {
      return config.messageChannelId;
    }
    // A sibling on the same message may carry the channel the picker is in.
    const sibling = await ReactionRoleConfig.findOne({
      guildId: config.guildId,
      messageId: config.messageId,
      messageChannelId: { $exists: true, $ne: "" },
    });
    return this.pickerChannelOf(
      sibling ? [sibling] : [],
      await this.configService.getString(
        "reactionroles.message_channel_id",
        "",
      ),
    );
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

      // Deleting a picker channel takes every reaction-role message in it with
      // it, so every active mapping whose picker lived there is invalidated —
      // not just the ones that also own a dedicated channel. Bind-to-existing-
      // role and `createChannel: false` mappings never set `channelId` at all,
      // so a `channelId`-scoped clause would silently skip them (#860).
      // A mapping lives in its stored `messageChannelId` (#1207); a legacy row
      // without one lives in the configured channel. Pickers in other channels
      // are untouched. `$in: [null, ""]` matches a row where the field is absent.
      const filter = {
        guildId: channel.guild.id,
        isArchived: false,
        $or: [
          { messageChannelId: channel.id },
          ...(messageChannelId === channel.id
            ? [{ messageChannelId: { $in: [null, ""] } }]
            : []),
          { channelId: channel.id },
          { categoryId: channel.id },
        ],
      };

      const matched = await ReactionRoleConfig.find(filter);

      // Rows on one message share its picker. A legacy picker that was topped up
      // or bound to after #1207 carries a mix of stamped and unstamped rows, and
      // only the stamped ones match above. The picker is gone for all of them, so
      // archive their unstamped siblings too (otherwise half a group stays active
      // on a dead message).
      const deadMessageIds = [
        ...new Set(
          matched
            .filter((c) => c.messageChannelId === channel.id)
            .map((c) => c.messageId),
        ),
      ];
      let configs = matched;
      if (deadMessageIds.length > 0) {
        const seen = new Set(matched.map((c) => String(c._id)));
        const siblings = await ReactionRoleConfig.find({
          guildId: channel.guild.id,
          isArchived: false,
          messageId: { $in: deadMessageIds },
        });
        configs = [
          ...matched,
          ...siblings.filter((c) => !seen.has(String(c._id))),
        ];
      }

      for (const config of configs) {
        const pickerWasDeleted =
          config.messageChannelId === channel.id ||
          (!config.messageChannelId && messageChannelId === channel.id) ||
          deadMessageIds.includes(config.messageId);
        await this.archiveConfig(
          config,
          pickerWasDeleted
            ? `reaction message channel ${channel.id} was deleted`
            : `channel ${channel.id} was deleted`,
        );
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
        // Cheap in-memory brake first, so refused or over-limit attempts never
        // cost a REST read (the live role fetch below).
        if (this.attemptWaitSeconds(guild.id, user.id) > 0) {
          logger.debug(
            `Reaction role attempt limit hit for user ${user.id}; ignoring add`,
          );
          return;
        }
        // The live role is authoritative: a binding made before the guard
        // existed, or a role edited since, must not hand out powerful
        // permissions (#1145).
        if ((await this.forbiddenPermissionsLive(guild, role)).length > 0) {
          await this.takeBackReaction(reaction, user.id, guild.id);
          return;
        }
        // Over the per-member flip limit (#1147): a reaction cannot be
        // answered, so drop it, and take the reaction back so the message does
        // not show a pick that never got its role.
        const flip = await this.reserveFlip(guild.id, user.id);
        if (flip.wait > 0) {
          logger.debug(
            `Reaction role flip limit hit for user ${user.id}; ignoring add`,
          );
          await this.takeBackReaction(reaction, user.id, guild.id);
          return;
        }
        try {
          await member.roles.add(role);
        } catch (error) {
          flip.release(); // the role did not change, so the flip is not spent
          throw error;
        }
        logger.info(`Added role ${role.name} to user ${user.tag}`);
      } else {
        logger.debug(`User ${user.tag} already has role ${role.name}`);
        // The sibling cleanup below does REST work, so a re-add of a role the
        // member already holds is limited too; otherwise remove/re-add of the
        // reaction would run it unbounded once removals are being ignored.
        if (config.mode === "unique") {
          // The fixed attempt cap applies here too (charged once), so the
          // cleanup stays bounded even when `max_toggles` is 0 or above it.
          if (this.attemptWaitSeconds(guild.id, user.id) > 0) {
            logger.debug(
              `Reaction role attempt limit hit for user ${user.id}; skipping unique-mode cleanup`,
            );
            return;
          }
          const flip = await this.reserveFlip(guild.id, user.id);
          if (flip.wait > 0) {
            logger.debug(
              `Reaction role flip limit hit for user ${user.id}; skipping unique-mode cleanup`,
            );
            return;
          }
          try {
            await this.applyUniqueMode(reaction, member, config);
          } catch (error) {
            flip.release(); // the cleanup did not complete, so not spent
            throw error;
          }
          return;
        }
      }

      // `unique` (one-of-set): reacting to one option clears the sibling
      // roles configured on the same message, so a member ends up with at
      // most one role from the group (e.g. exactly one colour role). Reached
      // here after a fresh grant, which was already charged above.
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

      const flip = await this.reserveFlip(guild.id, user.id);
      if (flip.wait > 0) {
        logger.debug(
          `Reaction role flip limit hit for user ${user.id}; ignoring remove`,
        );
        return;
      }
      try {
        await member.roles.remove(role);
      } catch (error) {
        flip.release();
        throw error;
      }
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
   * Generous per-member cap on grant *attempts* (30 a minute), counted before
   * any REST work. It bounds the live role fetch and the take-back for refused
   * roles, which never reach the flip budget. Fixed, not a setting: normal use
   * is far below it.
   */
  private attemptWaitSeconds(guildId: string, userId: string): number {
    return consumeBurst(`reactrole-attempt:${guildId}`, userId, 30, 60);
  }

  /**
   * Resolve the role a button or menu acts on. A cache hit costs nothing; a
   * miss needs a REST fetch (e.g. a binding whose role was deleted), which is
   * counted against the same per-member attempt budget so repeated clicks on a
   * stale binding cannot drive unbounded REST reads. Removals are never
   * limited.
   */
  private async resolveRoleForToggle(
    guild: Guild,
    roleId: string,
    member: GuildMember,
    desired: "add" | "remove",
  ): Promise<"limited" | { role: Role | null; attemptCharged: boolean }> {
    const cached = guild.roles.cache.get(roleId);
    if (cached) return { role: cached, attemptCharged: false };
    if (desired === "add") {
      if (this.attemptWaitSeconds(guild.id, member.id) > 0) return "limited";
      // The grant that follows must not charge this same attempt again.
      return { role: await guild.roles.fetch(roleId), attemptCharged: true };
    }
    return { role: await guild.roles.fetch(roleId), attemptCharged: false };
  }

  /** Roles already warned about, so a bad binding logs once per process. */
  private warnedForbiddenRoles = new Set<string>();
  /** Roles whose live check failed, logged once per process each. */
  private warnedUnverifiedRoles = new Set<string>();

  /**
   * Powerful permissions on the *live* role (fetched fresh), logging one
   * warning per role so the operator can fix the binding (#1145). Fails
   * closed: when the live role cannot be fetched (REST error or nothing
   * returned) it cannot be verified, so a non-empty result is returned and the
   * grant is refused; a role that just gained Administrator must not slip
   * through while Discord is flaky.
   */
  private async forbiddenPermissionsLive(
    guild: Guild,
    role: Role,
  ): Promise<string[]> {
    let live: Role | null = null;
    let failure: unknown = null;
    try {
      live = await guild.roles.fetch(role.id, { force: true });
    } catch (error) {
      failure = error;
    }
    if (!live) {
      if (!this.warnedUnverifiedRoles.has(role.id)) {
        this.warnedUnverifiedRoles.add(role.id);
        logger.warn(
          `Could not verify the live permissions of reaction role "${sanitizeForLog(role.name)}" (${role.id}); refusing to grant it until Discord answers${failure ? `: ${sanitizeForLog(getErrorMessage(failure))}` : ""}`,
        );
      }
      return ["unverified"];
    }
    const forbidden = forbiddenSelfAssignPermissions(live);
    if (forbidden.length > 0 && !this.warnedForbiddenRoles.has(live.id)) {
      this.warnedForbiddenRoles.add(live.id);
      logger.warn(
        `Reaction role "${sanitizeForLog(live.name)}" (${live.id}) carries ${forbidden.join(", ")} and is no longer granted to members. Remove those permissions or unbind the role on the Reaction Roles page.`,
      );
    }
    return forbidden;
  }

  /**
   * Take a refused reaction back so the message does not show a pick that got
   * no role. Bounded per member, so re-adding cannot drive one REST write per
   * attempt: past the bound the reaction is simply left in place.
   */
  private async takeBackReaction(
    reaction: MessageReaction,
    userId: string,
    guildId: string,
  ): Promise<void> {
    if (consumeBurst(`reactrole-undo:${guildId}`, userId, 5, 60) > 0) return;
    await reaction.users.remove(userId).catch(() => undefined);
  }

  /**
   * Per-member limit on role flips across reactions, buttons and menus
   * (#1147). Reserves a slot up front (so concurrent attempts see it): `wait`
   * is 0 when the flip may go ahead, otherwise the seconds to wait. Call
   * `release()` if the role change then fails, so only real changes count.
   * `reactionroles.max_toggles = 0` turns it off.
   */
  private async reserveFlip(
    guildId: string,
    userId: string,
  ): Promise<{ wait: number; release: () => void }> {
    const [max, windowSeconds] = await Promise.all([
      this.configService.getNumber("reactionroles.max_toggles", 10),
      this.configService.getNumber("reactionroles.toggle_window_seconds", 30),
    ]);
    return reserveBurst(`reactrole:${guildId}`, userId, max, windowSeconds);
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
    attemptCharged = false,
  ): Promise<string> {
    const hasRole = member.roles.cache.has(role.id);

    if (desired === "add" && hasRole) {
      return `You already have **${role.name}**.`;
    }
    if (desired === "remove" && !hasRole) {
      return `You don't have **${role.name}**.`;
    }

    if (desired === "add") {
      // Charge the grant attempt once: a cache-miss lookup already did.
      const attemptWait = attemptCharged
        ? 0
        : this.attemptWaitSeconds(member.guild.id, member.id);
      if (attemptWait > 0) {
        return `⏳ You're changing roles too quickly. Please wait ${waitText(attemptWait)} and try again.`;
      }
      // Never grant a role that carries powerful permissions, judged on the
      // live role rather than at bind time (#1145).
      if (
        (await this.forbiddenPermissionsLive(member.guild, role)).length > 0
      ) {
        return `⚠️ **${role.name}** can't be self-assigned right now. Please ask an admin.`;
      }
    }

    // Only real changes count against the flip limit (#1147).
    const flip = await this.reserveFlip(member.guild.id, member.id);
    if (flip.wait > 0) {
      return `⏳ You're changing roles too quickly. Please wait ${waitText(flip.wait)} and try again.`;
    }

    try {
      if (desired === "add") {
        await member.roles.add(role);
        logger.info(`Added role ${role.name} to user ${member.user.tag}`);
        return `✅ You now have **${role.name}**.`;
      }

      await member.roles.remove(role);
      logger.info(`Removed role ${role.name} from user ${member.user.tag}`);
      return `➖ Removed **${role.name}**.`;
    } catch (error) {
      flip.release(); // the role did not change, so the flip is not spent
      throw error;
    }
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
      const resolved = await this.resolveRoleForToggle(
        guild,
        roleId,
        member,
        member.roles.cache.has(roleId) ? "remove" : "add",
      );
      if (resolved === "limited") {
        await interaction.reply({
          content:
            "⏳ You're changing roles too quickly. Please wait a moment and try again.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const role = resolved.role;
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
        resolved.attemptCharged,
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
          const resolved = await this.resolveRoleForToggle(
            guild,
            roleId,
            member,
            desired,
          );
          if (resolved === "limited") {
            lines.push(
              "⏳ You're changing roles too quickly. Please wait a moment and try again.",
            );
            break;
          }
          const role = resolved.role;
          if (!role) {
            logger.error(
              `Role ${roleId} not found while toggling self-assign role`,
            );
            continue;
          }
          lines.push(
            await this.applyRoleToggleForMember(
              member,
              role,
              desired,
              resolved.attemptCharged,
            ),
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
  public normalizeEmoji(emoji: string): string {
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
  public async validateRoleAssignable(
    guild: Guild,
    role: Role,
    resolvedBotMember?: GuildMember | null,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    // Callers that must route REST through a timeout/retry wrapper can pass
    // the bot member they already fetched; otherwise fall back to cache/fetch.
    // `undefined` (omitted) keeps the cache/fetch fallback; an explicit `null`
    // means the caller's own wrapped fetch failed, so do not retry outside it.
    const botMember =
      resolvedBotMember !== undefined
        ? resolvedBotMember
        : (guild.members.me ??
          (await guild.members.fetchMe().catch(() => null)));

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

    // Any member can pick a reaction role up, so a role that carries server
    // control, moderation or mass-ping permissions would hand them to everyone
    // (#1145). Name the permissions so the admin knows what to change.
    const dangerous = forbiddenSelfAssignPermissions(role);
    if (dangerous.length > 0) {
      return {
        ok: false,
        message: `**${role.name}** has powerful permissions (${dangerous.join(", ")}), so it can't be a self-assign role: any member could pick it up. Remove those permissions from the role, or choose a different role.`,
      };
    }

    // A role that backs a role group belongs to that group (#1023): a reaction
    // role would hand it out to anyone. If the groups can't be read this
    // allows the role (the guard protects a choice, it is not an access check).
    const backing = await RoleGroupService.getInstance()
      .groupBackedRoles(guild.id, [role.id])
      .catch((error: unknown) => {
        logger.warn("reaction roles: role group check failed", error);
        return [];
      });
    if (backing.length > 0) {
      return {
        ok: false,
        message: `**${role.name}** backs the role group **${backing[0].groupName}**, so it can't be used as a reaction role. Pick another role, or manage this one through the group.`,
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
        await category.permissionOverwrites.edit(
          guild.roles.everyone,
          toOverwriteOptions(GATED_CATEGORY_EVERYONE),
        );

        await category.permissionOverwrites.edit(
          role,
          toOverwriteOptions(GATED_CATEGORY_ROLE),
        );

        // Ensure the bot can always manage this category and its channels
        const botMember = guild.members.me;
        if (botMember) {
          await category.permissionOverwrites.edit(
            botMember,
            toOverwriteOptions(BOT_CATEGORY),
          );
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
        messageChannelId,
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
    options: {
      messageId?: string;
      messageChannelId?: string;
      /** Stored with the mapping from the first save (server adoption, #1022). */
      categoryId?: string;
      /** Which adoption step made the mapping (snapshot id + step id). */
      adoptionOpKey?: string;
    } = {},
  ): Promise<{
    success: boolean;
    message: string;
    roleId?: string;
    messageId?: string;
  }> {
    // Adding a mapping to an existing picker takes the same per-guild lock the
    // adoption rollback holds while it decides whether the picker is shared, so
    // a mapping added concurrently can't slip past that check. Posting a fresh
    // picker (the adoption path, which already holds the lock) does not lock.
    if (options.messageId) {
      return reactionRoleGuildLock.run(guildId, () =>
        this.bindReactionRoleUnlocked(guildId, roleId, emoji, options),
      );
    }
    return this.bindReactionRoleUnlocked(guildId, roleId, emoji, options);
  }

  private async bindReactionRoleUnlocked(
    guildId: string,
    roleId: string,
    emoji: string,
    options: {
      messageId?: string;
      messageChannelId?: string;
      /** Stored with the mapping from the first save (server adoption, #1022). */
      categoryId?: string;
      /** Which adoption step made the mapping (snapshot id + step id). */
      adoptionOpKey?: string;
    } = {},
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

      // Resolve the channel that owns (or will own) the reaction message. An
      // existing picker is looked up in the channel its other mappings remember
      // (#1207), not wherever the setting points now.
      let messageChannelId = options.messageChannelId || "";
      if (!messageChannelId && options.messageId) {
        const onPicker = await ReactionRoleConfig.findOne({
          guildId,
          messageId: options.messageId,
          messageChannelId: { $exists: true, $ne: "" },
        });
        messageChannelId = onPicker?.messageChannelId ?? "";
      }
      if (!messageChannelId) {
        messageChannelId = await this.configService.getString(
          "reactionroles.message_channel_id",
          "",
        );
      }

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
          .setFooter({
            text: options.adoptionOpKey
              ? `Remove your reaction to lose the role${PICKER_REF_SEPARATOR}${PICKER_REF_PREFIX}${options.adoptionOpKey}`
              : "Remove your reaction to lose the role",
          })
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
        // The channel the message was actually found in or posted to.
        messageChannelId,
        roleId: role.id,
        emoji: normalizedEmoji,
        roleName: role.name,
        autoCreated: false,
        isArchived: false,
        ...(options.categoryId ? { categoryId: options.categoryId } : {}),
        ...(options.adoptionOpKey
          ? { adoptionOpKey: options.adoptionOpKey }
          : {}),
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
   * Register an **existing** role as a self-assign role paired with an
   * **existing** role-gated category (server adoption, #1022).
   *
   * Nothing is created or edited besides one KoolBot picker message and its
   * mapping: the role keeps its permissions and the category keeps its
   * overwrites, so the category stays gated by the role. The mapping is stored
   * with `autoCreated: false`, the category id and the caller's `ownerKey`, so
   * removing it can never delete the role or the category (see
   * `deleteReactionRole` and `deleteReactionRoleGroupLocked`).
   *
   * The role must pass {@link validateRoleAssignable}: a role with
   * Administrator or another dangerous permission is refused (#1159). Throws
   * with the reason on any refusal.
   *
   * Ownership and retries: the mapping stores `ownerKey` (snapshot id + step
   * id). A retry that finds a mapping with the same key made it itself (a first
   * attempt that timed out and finished late), so it is reported as posted and
   * a rollback removes it. A mapping with another key, or none, belongs to
   * someone else (another plan, the Reaction Roles page) and is reported as
   * reused: it is never removed by a rollback.
   *
   * The whole check-then-post runs under the per-guild reaction-role lock. The
   * engine's timeout does not cancel a registration, so a resumed attempt
   * waits for the first one to finish and then finds its mapping, instead of
   * posting a second picker.
   *
   * The picker goes to `input.channelId`, the channel the plan showed, and the
   * mapping remembers it (#1207). If `reactionroles.message_channel_id` has
   * changed since the preview, it still throws: the plan the admin approved
   * named that channel.
   */
  public async registerGatedPairing(
    guildId: string,
    input: {
      roleId: string;
      categoryId: string;
      emoji: string;
      channelId: string;
      ownerKey: string;
      /** The engine began this step before: look for a picker it posted. */
      retry?: boolean;
    },
  ): Promise<{ messageId: string; channelId: string; reused: boolean }> {
    return reactionRoleGuildLock.run(guildId, () =>
      this.registerGatedPairingLocked(guildId, input),
    );
  }

  private async registerGatedPairingLocked(
    guildId: string,
    input: {
      roleId: string;
      categoryId: string;
      emoji: string;
      channelId: string;
      ownerKey: string;
      retry?: boolean;
    },
  ): Promise<{ messageId: string; channelId: string; reused: boolean }> {
    const api = CommandManager.getInstance(this.client);
    const configured = await this.configService.getString(
      "reactionroles.message_channel_id",
      "",
    );
    if (configured !== input.channelId) {
      throw new Error(
        "The reaction-role message channel changed since the plan was previewed. Preview again.",
      );
    }
    const guild = await api.makeDiscordApiCall(
      () => this.client.guilds.fetch(guildId),
      "fetch guild for pairing",
    );
    const role = await api
      .makeDiscordApiCall(
        () => guild.roles.fetch(input.roleId),
        `fetch role ${input.roleId}`,
      )
      .catch(() => null);
    if (!role) {
      throw new Error(`Role ${input.roleId} was not found in this server.`);
    }
    const category = await api
      .makeDiscordApiCall(
        () => guild.channels.fetch(input.categoryId),
        `fetch category ${input.categoryId}`,
      )
      .catch(() => null);
    if (!category || category.type !== ChannelType.GuildCategory) {
      throw new Error(`Category ${input.categoryId} was not found.`);
    }
    const botMember = await api
      .makeDiscordApiCall(
        async () => guild.members.me ?? (await guild.members.fetchMe()),
        "fetch bot member",
      )
      .catch(() => null);
    const assignable = await this.validateRoleAssignable(
      guild,
      role,
      botMember,
    );
    if (!assignable.ok) {
      throw new Error(assignable.message.replace(/\*\*/g, ""));
    }
    // The live category overwrite counts as well: Manage Channels or Manage
    // Webhooks granted to the role there would be handed to everyone who picks
    // it up. Read at apply time, so a change since the preview is caught.
    // Checked on every channel in the guild's cache (the cached overwrites are
    // already in memory, no REST), not just the category: an unsynced child
    // channel's own overwrite for the role is just as exploitable.
    const everyChannel = [
      category,
      ...(guild.channels.cache?.values?.() ?? []),
    ];
    for (const channel of everyChannel) {
      const bits = (
        channel as {
          permissionOverwrites?: {
            cache?: {
              get(id: string): { allow?: { bitfield?: bigint } } | undefined;
            };
          };
        }
      ).permissionOverwrites?.cache?.get(role.id)?.allow?.bitfield;
      const dangerous =
        typeof bits === "bigint" ? forbiddenSelfAssignNames(bits) : [];
      if (dangerous.length > 0) {
        throw new Error(
          `${(channel as { name?: string }).name ?? channel.id} gives ${role.name} powerful permissions in its own overwrite (${dangerous.join(", ")}), so anyone who picks the role would get them there. Remove them from that channel first.`,
        );
      }
    }

    const existing = await ReactionRoleConfig.findOne({
      guildId,
      roleId: role.id,
      categoryId: category.id,
      isArchived: false,
      autoCreated: false,
    });
    if (existing) {
      const ours = existing.adoptionOpKey === input.ownerKey;
      if (!ours && input.retry) {
        // Another owner's mapping is reused, but this step may have posted its
        // own picker before dying. It is not recorded anywhere a rollback would
        // look once the result is "reused", so remove it now: only if it is
        // marked as this step's and no mapping uses it. The other owner's
        // mapping and picker are never touched.
        const orphan = await this.findMarkedPicker(
          guild,
          input.channelId,
          input.ownerKey,
        );
        if (orphan && orphan.id !== existing.messageId) {
          const used = await ReactionRoleConfig.countDocuments({
            guildId,
            messageId: orphan.id,
            isArchived: false,
          });
          if (used === 0) await this.deleteMessageUnderLock(orphan);
        }
      }
      return {
        messageId: existing.messageId,
        channelId: input.channelId,
        reused: !ours,
      };
    }
    const elsewhere = await ReactionRoleConfig.findOne({
      guildId,
      roleId: role.id,
      isArchived: false,
    });
    if (elsewhere) {
      throw new Error(
        `${role.name} is already a reaction role on another picker; it is not registered a second time.`,
      );
    }

    // A retry first looks for a picker this step posted before the process
    // died (posted, but its mapping never saved). It is completed (reaction and
    // mapping) instead of posting a second one. Only on a retry: the first
    // attempt needs no history read.
    const orphan = input.retry
      ? await this.findMarkedPicker(guild, input.channelId, input.ownerKey)
      : null;
    // The lock is already held, so the unlocked bind is called directly.
    const bound = await this.bindReactionRoleUnlocked(
      guildId,
      role.id,
      input.emoji,
      {
        messageChannelId: input.channelId,
        categoryId: category.id,
        adoptionOpKey: input.ownerKey,
        ...(orphan ? { messageId: orphan.id } : {}),
      },
    );
    if (!bound.success || !bound.messageId) {
      throw new Error(bound.message.replace(/\*\*/g, ""));
    }
    return {
      messageId: bound.messageId,
      channelId: input.channelId,
      reused: false,
    };
  }

  /** The most recent message in `channelId` carrying `ownerKey`'s marker. */
  private async findMarkedPicker(
    guild: Guild,
    channelId: string,
    ownerKey: string,
  ): Promise<Message | null> {
    const api = CommandManager.getInstance(this.client);
    const channel = (await api.makeDiscordApiCall(
      () =>
        guild.channels.fetch(channelId).catch((err: unknown) => {
          if (this.isUnknownEntityError(err, 10003)) return null;
          throw err;
        }),
      `fetch picker channel ${channelId}`,
    )) as TextChannel | null;
    if (!channel?.messages) return null;
    const botId = this.client.user?.id;
    // Search back to when the step began. The snapshot id is a Mongo ObjectId,
    // whose first four bytes are its creation time, and a picker can't be older
    // than the snapshot, so that is a durable boundary that needs no extra
    // record. An unreadable key has no boundary, so the page limit applies.
    const created = /^([0-9a-f]{24}):/i.exec(ownerKey);
    const boundary = created
      ? parseInt(created[1].slice(0, 8), 16) * 1000 - 1000
      : null;
    let before: string | undefined;
    for (let page = 0; page < PICKER_SEARCH_MAX_PAGES; page++) {
      const batch = await api.makeDiscordApiCall(
        () =>
          channel.messages.fetch({
            limit: 100,
            ...(before ? { before } : {}),
          }),
        `read messages in ${channelId}`,
      );
      const list = [...batch.values()];
      const hit = list.find((m) => isMarkedPicker(m, botId, ownerKey));
      if (hit) return hit;
      // Fewer than a full page: the history is exhausted.
      if (list.length < 100) return null;
      const oldest = list.reduce((a, b) =>
        BigInt(a.id) < BigInt(b.id) ? a : b,
      );
      if (
        boundary !== null &&
        SnowflakeUtil.timestampFrom(oldest.id) < boundary
      ) {
        return null;
      }
      before = oldest.id;
    }
    // Not found, but not proven absent either: never report "none".
    throw new Error(
      `The history of the reaction-role channel is too long to search for an unsaved picker (${PICKER_SEARCH_MAX_PAGES} pages). Nothing was changed; delete any picker marked "${ownerKey}" by hand and try again.`,
    );
  }

  /**
   * Delete a message. This is a mutation, so it is NOT run through the timed
   * `makeDiscordApiCall` race: a timeout there returns while the request is
   * still in flight, which would let it land after the guild lock is released.
   * Called directly, the lock is held until the request settles (the REST
   * client has its own timeout). Unknown Message counts as already gone.
   */
  private async deleteMessageUnderLock(message: Message): Promise<void> {
    try {
      await message.delete();
    } catch (err) {
      if (!this.isUnknownEntityError(err, 10008)) throw err;
    }
  }

  /**
   * The picker message of the mapping a step with `ownerKey` saved for `roleId`,
   * or null. Reads only (under the guild lock, so a registration still running
   * has finished first); it never posts. Lets a rollback recover a registration
   * the engine never got to record.
   */
  public async findOwnedPairing(
    guildId: string,
    input: { roleId: string; ownerKey: string; channelId: string },
  ): Promise<string | null> {
    return reactionRoleGuildLock.run(guildId, async () => {
      const row = await ReactionRoleConfig.findOne({
        guildId,
        roleId: input.roleId,
        adoptionOpKey: input.ownerKey,
        autoCreated: false,
        isArchived: false,
      });
      if (row) return row.messageId;
      // No mapping: the picker may still have been posted before the process
      // died. Its footer marker proves it was this step's.
      const api = CommandManager.getInstance(this.client);
      const guild = await api.makeDiscordApiCall(
        () => this.client.guilds.fetch(guildId),
        "fetch guild to look for a picker",
      );
      const orphan = await this.findMarkedPicker(
        guild,
        input.channelId,
        input.ownerKey,
      );
      return orphan ? orphan.id : null;
    });
  }

  /**
   * Undo {@link registerGatedPairing}: delete the picker message KoolBot posted
   * (in the channel it was posted to, recorded by the caller, not the current
   * setting) and then the mapping. Only a mapping carrying `ownerKey` and not
   * owning its role (`autoCreated: false`) is removed; the role and the
   * category are never touched.
   *
   * Only a confirmed Unknown Channel (10003) or Unknown Message (10008) counts
   * as "already gone". Any other failure throws and the mapping is kept, so the
   * caller can retry and the picker is never orphaned.
   */
  public async unregisterGatedPairing(
    guildId: string,
    input: {
      roleId: string;
      messageId: string;
      channelId: string;
      ownerKey: string;
    },
  ): Promise<void> {
    await reactionRoleGuildLock.run(guildId, async () => {
      const config = await ReactionRoleConfig.findOne({
        guildId,
        messageId: input.messageId,
        roleId: input.roleId,
        autoCreated: false,
        adoptionOpKey: input.ownerKey,
      });
      const api = CommandManager.getInstance(this.client);
      if (!config) {
        // No mapping (the step died before saving it): the picker is only ours
        // to delete if its footer carries this step's marker.
        const guildForOrphan = await api.makeDiscordApiCall(
          () => this.client.guilds.fetch(guildId),
          "fetch guild to remove picker",
        );
        const orphanChannel = (await api.makeDiscordApiCall(
          () =>
            guildForOrphan.channels
              .fetch(input.channelId)
              .catch((err: unknown) => {
                if (this.isUnknownEntityError(err, 10003)) return null;
                throw err;
              }),
          `fetch picker channel ${input.channelId}`,
        )) as TextChannel | null;
        if (!orphanChannel?.messages) return;
        // The marker survives a mapping being unbound or another being added:
        // the guard that protects a shared picker applies here as well. The
        // lock is held, so no mapping can be added while this is decided.
        const sharedBy = await ReactionRoleConfig.countDocuments({
          guildId,
          messageId: input.messageId,
          isArchived: false,
        });
        if (sharedBy > 0) return;
        const botId = this.client.user?.id;
        // Timed read, then the delete under the lock (see deleteMessageUnderLock).
        const orphan = await api.makeDiscordApiCall(
          () =>
            orphanChannel.messages
              .fetch(input.messageId)
              .catch((err: unknown) => {
                if (this.isUnknownEntityError(err, 10008)) return null;
                throw err;
              }),
          `read orphan picker ${input.messageId}`,
        );
        if (orphan && isMarkedPicker(orphan, botId, input.ownerKey)) {
          await this.deleteMessageUnderLock(orphan);
        }
        return;
      }
      const guild = await api.makeDiscordApiCall(
        () => this.client.guilds.fetch(guildId),
        "fetch guild to remove picker",
      );
      const channel = (await api.makeDiscordApiCall(
        () =>
          guild.channels.fetch(input.channelId).catch((err: unknown) => {
            if (this.isUnknownEntityError(err, 10003)) return null;
            throw err;
          }),
        `fetch picker channel ${input.channelId}`,
      )) as TextChannel | null;
      // The picker may have been shared since: the Reaction Roles page can add
      // another emoji-to-role mapping to it. Deleting the message would leave
      // that mapping without a working picker, so then only this mapping's own
      // reaction goes and the message stays.
      const siblings = await ReactionRoleConfig.countDocuments({
        guildId,
        messageId: input.messageId,
        isArchived: false,
        _id: { $ne: config._id },
      });
      if (channel) {
        // Timed read, then the mutation under the lock: a timed-out callback
        // keeps running after the race returns, and must not delete after the
        // lock is released and another mapping has been added.
        const message = await api.makeDiscordApiCall(
          () =>
            channel.messages.fetch(input.messageId).catch((err: unknown) => {
              if (this.isUnknownEntityError(err, 10008)) return null;
              throw err;
            }),
          `read picker ${input.messageId}`,
        );
        if (message) {
          if (siblings === 0) {
            await this.deleteMessageUnderLock(message);
          } else {
            const reaction = message.reactions.cache.find(
              (r) => this.buildEmojiIdentifier(r) === config.emoji,
            );
            const botId = this.client.user?.id;
            if (reaction && botId) {
              try {
                await reaction.users.remove(botId);
              } catch (err) {
                if (!this.isUnknownEntityError(err, 10008)) throw err;
              }
            }
          }
        }
      }
      await ReactionRoleConfig.deleteOne({ _id: config._id });
    });
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
          const messageChannelId = await this.pickerChannelFor(config);
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
      await category.permissionOverwrites.edit(
        guild.roles.everyone,
        toOverwriteOptions(GATED_CATEGORY_EVERYONE),
      );
      for (const role of createdRoles) {
        await category.permissionOverwrites.edit(
          role,
          toOverwriteOptions(GATED_CATEGORY_ROLE),
        );
      }
      const botMember = guild.members.me;
      if (botMember) {
        await category.permissionOverwrites.edit(
          botMember,
          toOverwriteOptions(BOT_CATEGORY),
        );
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
        messageChannelId,
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
  ): Promise<{
    success: boolean;
    message: string;
    rolesDeleted?: number;
    rolesKept?: number;
  }> {
    // Shared with ReactionRoleGroupService.provisionGroup so a delete and a
    // top-up of the same guild never interleave (no re-entrant calls).
    return reactionRoleGuildLock.run(guildId, () =>
      this.deleteReactionRoleGroupLocked(guildId, groupId),
    );
  }

  private async deleteReactionRoleGroupLocked(
    guildId: string,
    groupId: string,
  ): Promise<{
    success: boolean;
    message: string;
    rolesDeleted?: number;
    rolesKept?: number;
  }> {
    try {
      const configs = await ReactionRoleConfig.find({ guildId, groupId });
      if (configs.length === 0) {
        return { success: false, message: `Role group not found.` };
      }

      const guild = await this.client.guilds.fetch(guildId);
      const first = configs[0];

      // Delete the shared message.
      try {
        // The picker is in the channel the group's rows remember (#1207); only
        // a legacy group falls back to the configured channel.
        const messageChannelId = this.pickerChannelOf(
          configs,
          await this.configService.getString(
            "reactionroles.message_channel_id",
            "",
          ),
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
        // Only a category the bot created is its to delete. A mapping bound to
        // an existing, role-gated category (server adoption, #1022) keeps it.
        const ownsCategory = configs.every((c) => c.autoCreated !== false);
        const category =
          first.categoryId && ownsCategory
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

      // Delete every role in the group, except roles the bot did not create
      // (the grouped-role generator reuses existing roles, #1064).
      let rolesDeleted = 0;
      let rolesKept = 0;
      for (const config of configs) {
        if (config.autoCreated === false) {
          rolesKept++;
          continue;
        }
        try {
          // Same guard as deleteReactionRole: a role reused by a mapping
          // outside this group must survive, or that picker would dangle.
          const stillUsed = await ReactionRoleConfig.countDocuments({
            guildId,
            roleId: config.roleId,
            groupId: { $ne: groupId },
          });
          if (stillUsed > 0) {
            rolesKept++;
            continue;
          }
          const role = await guild.roles.fetch(config.roleId);
          if (role) {
            await role.delete();
            rolesDeleted++;
          }
        } catch (error) {
          logger.warn(`Could not delete role ${config.roleId}:`, error);
        }
      }

      await ReactionRoleConfig.deleteMany({ guildId, groupId });

      logger.info(
        `Fully deleted reaction role group ${groupId} (${rolesDeleted} roles removed, ${rolesKept} kept)`,
      );

      return {
        success: true,
        message:
          rolesKept > 0
            ? `Deleted the role group: removed ${rolesDeleted} role${rolesDeleted === 1 ? "" : "s"}, kept ${rolesKept} that ${rolesKept === 1 ? "was" : "were"} reused or still used elsewhere.`
            : `Successfully deleted role group and its ${rolesDeleted} role${rolesDeleted === 1 ? "" : "s"}.`,
        rolesDeleted,
        rolesKept,
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
        const messageChannelId = await this.pickerChannelFor(config);
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
        // The picker was just reposted in the configured channel, so that is
        // where this mapping lives now, whatever channel it was archived from.
        config.messageChannelId = messageChannelId;
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
          const messageChannelId = await this.pickerChannelFor(config);
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
