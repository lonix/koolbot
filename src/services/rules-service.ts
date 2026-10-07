import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  Client,
  Guild,
  MessageFlags,
  PermissionFlagsBits,
  type Role,
} from "discord.js";
import { ConfigService } from "./config-service.js";
import { RulesAcceptance } from "../models/rules-acceptance.js";
import { env } from "../config/env.js";
import { createKeyedLock } from "../utils/keyed-lock.js";
import logger from "../utils/logger.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";
import { getErrorMessage } from "../utils/error-guards.js";
import {
  DISCORD_MESSAGE_CONTENT_LIMIT,
  truncateText,
} from "../utils/discord-limits.js";

/** customId of the Accept button on the rules message. */
export const RULES_ACCEPT_CUSTOM_ID = "rules:accept";

/** Discord's limit for a button label. */
const BUTTON_LABEL_LIMIT = 80;

export type RulesProblem =
  | "role-missing"
  | "role-managed"
  | "role-everyone"
  | "role-too-high"
  | "role-privileged"
  | "no-manage-roles";

/**
 * Permissions nobody may self-grant by pressing a public button. The Accept
 * button is open to every member, so an acceptance role carrying any of these
 * would hand out server control (Administrator), configuration (Manage
 * Server/Roles/Channels/Webhooks/Events/Expressions), moderation (Manage
 * Messages/Threads/Nicknames, Kick, Ban, Timeout, voice Move/Mute/Deafen),
 * audit-log visibility, or mass pings (Mention @everyone).
 */
export const UNSAFE_ACCEPTANCE_PERMISSIONS: bigint[] = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.ManageNicknames,
  PermissionFlagsBits.ManageEvents,
  PermissionFlagsBits.ManageGuildExpressions,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.MoveMembers,
  PermissionFlagsBits.MuteMembers,
  PermissionFlagsBits.DeafenMembers,
  PermissionFlagsBits.ViewAuditLog,
  PermissionFlagsBits.MentionEveryone,
];

const UNSAFE_MASK = UNSAFE_ACCEPTANCE_PERMISSIONS.reduce((a, b) => a | b, 0n);

/** A discord.js Permissions, a bitfield, or a decimal string. */
type PermissionsLike = bigint | string | { bitfield: bigint };

const toBits = (p: PermissionsLike): bigint => {
  try {
    if (typeof p === "bigint") return p;
    if (typeof p === "string") return BigInt(p);
    return p.bitfield;
  } catch {
    return 0n;
  }
};

/**
 * Why the bot cannot hand out `role`, or null when it can. Mirrors the
 * adoption safety rules: never touch managed roles or roles at or above the
 * bot's own highest role.
 */
export function roleProblem(
  role:
    | (Pick<Role, "id" | "managed" | "position"> & {
        permissions?: PermissionsLike;
      })
    | undefined
    | null,
  guildId: string,
  botHighestPosition: number,
  botCanManageRoles: boolean,
): RulesProblem | null {
  if (!role) return "role-missing";
  if (role.id === guildId) return "role-everyone";
  if (role.managed) return "role-managed";
  if (role.position >= botHighestPosition) return "role-too-high";
  if (
    role.permissions !== undefined &&
    (toBits(role.permissions) & UNSAFE_MASK) !== 0n
  )
    return "role-privileged";
  if (!botCanManageRoles) return "no-manage-roles";
  return null;
}

export const ROLE_PROBLEM_TEXT: Record<RulesProblem, string> = {
  "role-missing": "The acceptance role no longer exists.",
  "role-managed": "The acceptance role is managed by an integration.",
  "role-everyone": "@everyone can't be the acceptance role.",
  "role-too-high":
    "The acceptance role is at or above the bot's highest role, so the bot can't grant it.",
  "role-privileged":
    "The acceptance role carries administrative or moderation permissions (such as Administrator, Manage Server or Ban Members). Everyone can press Accept, so use a role without them.",
  "no-manage-roles": "The bot lacks the Manage Roles permission.",
};

export interface RulesPostResult {
  ok: boolean;
  /** "posted" for a new message, "updated" for an edit of the existing one. */
  action?: "posted" | "updated";
  messageId?: string;
  error?: string;
}

/**
 * Optional rules / terms-of-service acceptance gate (#1024). Posts a rules
 * message with an Accept button and, on click, grants the acceptance role and
 * records when. Event-driven; no timers. Gated on `rules.enabled`.
 */
export class RulesService {
  private static instance: RulesService | undefined;

  private readonly acceptLock = createKeyedLock();

  private constructor(private readonly client: Client) {}

  public static getInstance(client: Client): RulesService {
    if (!RulesService.instance) {
      RulesService.instance = new RulesService(client);
    }
    return RulesService.instance;
  }

  public static reset(): void {
    RulesService.instance = undefined;
  }

  /** The message body and button, from config. */
  public async buildMessage(): Promise<{
    content: string;
    components: ActionRowBuilder<ButtonBuilder>[];
  }> {
    const config = ConfigService.getInstance();
    const text = (await config.getString("rules.message", "")).trim();
    const label =
      (await config.getString("rules.button_label", "")).trim() ||
      "I accept the rules";
    const button = new ButtonBuilder()
      .setCustomId(RULES_ACCEPT_CUSTOM_ID)
      .setLabel(truncateText(label, BUTTON_LABEL_LIMIT))
      .setStyle(ButtonStyle.Success);
    return {
      content: truncateText(
        text || "Press the button to accept the server rules.",
        DISCORD_MESSAGE_CONTENT_LIMIT,
      ),
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)],
    };
  }

  /**
   * Post the rules message in `rules.channel_id`, or edit the one already
   * posted (`rules.message_id`). Never throws.
   */
  public async postOrUpdateMessage(guild: Guild): Promise<RulesPostResult> {
    try {
      const config = ConfigService.getInstance();
      const channelId = (await config.getString("rules.channel_id", "")).trim();
      if (!channelId) {
        return { ok: false, error: "Set the rules channel first." };
      }
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased() || !("send" in channel)) {
        return {
          ok: false,
          error: "The rules channel isn't a text channel the bot can see.",
        };
      }
      const payload = await this.buildMessage();
      const existingId = (
        await config.getString("rules.message_id", "")
      ).trim();
      if (existingId) {
        const existing = await channel.messages
          .fetch(existingId)
          .catch(() => null);
        if (existing && existing.author.id === this.client.user?.id) {
          await existing.edit({ ...payload, allowedMentions: { parse: [] } });
          return { ok: true, action: "updated", messageId: existing.id };
        }
      }
      const sent = await channel.send({
        ...payload,
        allowedMentions: { parse: [] },
      });
      try {
        await config.set(
          "rules.message_id",
          sent.id,
          "Managed by KoolBot: the ID of the posted rules message.",
          "rules",
        );
      } catch (error) {
        // Without the stored ID the button is always "out of date" and a retry
        // would post a duplicate, so take the message back down.
        await sent.delete().catch((deleteError: unknown) => {
          logger.warn(
            `Couldn't remove the unlinked rules message ${sent.id}: ${sanitizeForLog(getErrorMessage(deleteError))}`,
          );
        });
        throw error;
      }
      return { ok: true, action: "posted", messageId: sent.id };
    } catch (error) {
      logger.error(
        `Failed to post the rules message: ${sanitizeForLog(getErrorMessage(error))}`,
      );
      return {
        ok: false,
        error: "Discord refused the message. Check the bot's channel access.",
      };
    }
  }

  /**
   * Handle the Accept button. Acknowledges first (Discord drops an interaction
   * not answered within 3 seconds), then grants the role and records it.
   */
  public async handleAcceptButton(
    interaction: ButtonInteraction,
  ): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const reply = (content: string): Promise<unknown> =>
      interaction.editReply({ content });
    try {
      const config = ConfigService.getInstance();
      if (!(await config.getBoolean("rules.enabled", false))) {
        await reply("Rules acceptance is not active on this server.");
        return;
      }
      // Only the message the bot currently manages counts: an older copy left
      // behind after the rules moved must not still grant the role.
      const [activeMessageId, activeChannelId] = await Promise.all([
        config.getString("rules.message_id", ""),
        config.getString("rules.channel_id", ""),
      ]);
      if (
        !activeMessageId.trim() ||
        interaction.message.id !== activeMessageId.trim() ||
        interaction.channelId !== activeChannelId.trim()
      ) {
        await reply(
          "This rules message is out of date. Please use the current rules message.",
        );
        return;
      }
      const guild = interaction.guild;
      if (!guild || (env.guildId && guild.id !== env.guildId)) {
        await reply("This button only works in the server.");
        return;
      }
      const roleId = (await config.getString("rules.role_id", "")).trim();
      if (!roleId) {
        await reply(
          "No acceptance role is configured yet. Please tell a server admin.",
        );
        return;
      }
      const roles = await guild.roles.fetch();
      const role = roles.get(roleId);
      const me = guild.members.me ?? (await guild.members.fetchMe());
      const problem = roleProblem(
        role,
        guild.id,
        me.roles.highest.position,
        me.permissions.has(PermissionFlagsBits.ManageRoles),
      );
      if (problem || !role) {
        logger.warn(
          `Rules acceptance can't grant role ${roleId}: ${problem ?? "unknown"}`,
        );
        await reply(
          "I can't grant the acceptance role right now. Please tell a server admin.",
        );
        return;
      }
      // One click at a time per member: otherwise two overlapping clicks can
      // both see "no role yet", and a failed write in one would take back the
      // role the other one's successful acceptance depends on.
      await this.acceptLock.run(
        `${guild.id}:${interaction.user.id}`,
        async () => {
          const member = await guild.members.fetch(interaction.user.id);
          const already = member.roles.cache.has(role.id);
          if (!already) {
            await member.roles.add(role, "Accepted the server rules");
          }
          // An existing holder who never clicked still gets a record, so the
          // accepted-at data is complete; "adopted" keeps it honest.
          try {
            await RulesAcceptance.updateOne(
              { userId: member.id, guildId: guild.id },
              {
                $setOnInsert: {
                  acceptedAt: new Date(),
                  source: already ? "adopted" : "button",
                },
              },
              { upsert: true },
            );
          } catch (error) {
            logger.error(
              `Couldn't record the rules acceptance: ${sanitizeForLog(getErrorMessage(error))}`,
            );
            // Only undo a role this attempt added, so the member isn't left with
            // access and no accepted-at record. A pre-existing holder keeps theirs.
            if (!already) {
              await member.roles
                .remove(role, "Rules acceptance could not be recorded")
                .catch((removeError: unknown) => {
                  logger.error(
                    `Couldn't take back role ${role.id} from ${member.id}: ${sanitizeForLog(getErrorMessage(removeError))}`,
                  );
                });
            }
            await reply("Something went wrong. Please try again in a moment.");
            return;
          }
          await reply(
            already
              ? "You have already accepted the rules. Thank you!"
              : "Thanks for accepting the rules. Welcome in!",
          );
        },
      );
    } catch (error) {
      logger.error(
        `Rules acceptance failed: ${sanitizeForLog(getErrorMessage(error))}`,
      );
      await reply("Something went wrong. Please try again in a moment.").catch(
        () => undefined,
      );
    }
  }

  /**
   * Record current holders of the acceptance role as accepted ("adopted"),
   * skipping members who already have a record. Needs the member list, so it
   * requires the GuildMembers intent. The role is validated first, with the
   * same rules as the Accept handler, so a role that can never be granted
   * (e.g. @everyone set outside the picker) isn't recorded as adopted.
   * Returns how many were recorded, or the role problem.
   */
  public async recordExistingHolders(
    guild: Guild,
  ): Promise<{ recorded: number } | { problem: RulesProblem }> {
    const roleId = (
      await ConfigService.getInstance().getString("rules.role_id", "")
    ).trim();
    if (!roleId) return { recorded: 0 };
    const roles = await guild.roles.fetch();
    const me = guild.members.me ?? (await guild.members.fetchMe());
    const problem = roleProblem(
      roles.get(roleId),
      guild.id,
      me.roles.highest.position,
      me.permissions.has(PermissionFlagsBits.ManageRoles),
    );
    if (problem) return { problem };
    const members = await guild.members.fetch();
    const holders = members.filter(
      (m) => !m.user.bot && m.roles.cache.has(roleId),
    );
    if (holders.size === 0) return { recorded: 0 };
    const known = new Set(
      (
        await RulesAcceptance.find({ guildId: guild.id })
          .select("userId")
          .lean()
      ).map((r) => r.userId),
    );
    const fresh = [...holders.keys()].filter((id) => !known.has(id));
    if (fresh.length === 0) return { recorded: 0 };
    const now = new Date();
    await RulesAcceptance.bulkWrite(
      fresh.map((userId) => ({
        updateOne: {
          filter: { userId, guildId: guild.id },
          update: {
            $setOnInsert: { acceptedAt: now, source: "adopted" as const },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
    return { recorded: fresh.length };
  }

  /**
   * Whether Discord's own rules gate looks active, so the admin isn't asked to
   * accept the rules twice. `COMMUNITY` servers have a native rules channel;
   * `MEMBER_VERIFICATION_GATE_ENABLED` is Membership Screening.
   */
  public static nativeGate(guild: Guild): {
    screening: boolean;
    community: boolean;
  } {
    const features = guild.features as readonly string[];
    return {
      screening: features.includes("MEMBER_VERIFICATION_GATE_ENABLED"),
      community: features.includes("COMMUNITY"),
    };
  }
}
