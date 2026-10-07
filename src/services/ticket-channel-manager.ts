import { randomBytes } from "node:crypto";
import {
  AttachmentBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
  Guild,
  GuildMember,
  PermissionFlagsBits,
  TextChannel,
  type Message,
  type OverwriteResolvable,
} from "discord.js";
import { CommandManager } from "./command-manager.js";
import { ConfigService } from "./config-service.js";
import { Ticket, type ITicket, type TicketStatus } from "../models/ticket.js";
import logger from "../utils/logger.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";
import { getErrorMessage } from "../utils/error-guards.js";

/**
 * Support tickets (#1004): a private text channel per ticket.
 *
 * `/ticket` and the `/admin/tickets` page both drive the same transitions
 * through this service, so a ticket behaves identically whichever surface
 * touched it. It owns no timers — a ticket is only ever acted on by a person.
 *
 * Closing archives rather than deletes: the channel is renamed `closed-…` and
 * the author is denied `SendMessages`, which keeps the history for staff and
 * makes reopen a permission flip instead of a recreate.
 */

/** Cap on the subject a member types, mirrored by the command's max length. */
export const MAX_SUBJECT_LENGTH = 100;

/** Most messages a transcript will include (Discord pages 100 at a time). */
const TRANSCRIPT_MAX_MESSAGES = 1000;

const MEMBER_ALLOW = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles,
];

const EMBED_COLOR = 0x5865f2;

export type TicketFailure =
  | "disabled"
  | "no-staff-role"
  | "not-found"
  | "already-closed"
  | "not-closed"
  | "already-claimed"
  | "discord-error";

export type TicketResult<T = ITicket> =
  { ok: true; ticket: T } | { ok: false; reason: TicketFailure };

export interface TicketSettings {
  enabled: boolean;
  categoryId: string;
  staffRoleId: string;
  transcriptOnClose: boolean;
}

/** `ticket-<name>-<4 hex>`: lowercase, hyphenated, inside Discord's 100 chars. */
export function ticketChannelName(username: string, suffix: string): string {
  const slug = username
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20);
  return `ticket-${slug ? `${slug}-` : ""}${suffix}`;
}

/** The archived name for a ticket channel, preserving its original suffix. */
export function closedChannelName(name: string): string {
  return name.startsWith("closed-")
    ? name
    : `closed-${name.replace(/^ticket-/, "")}`.slice(0, 100);
}

/** The reverse of {@link closedChannelName}, for reopen. */
export function reopenedChannelName(name: string): string {
  return name.startsWith("closed-")
    ? `ticket-${name.slice("closed-".length)}`.slice(0, 100)
    : name;
}

/** Plain-text log of a ticket's messages, oldest first. */
export function renderTranscript(
  messages: Array<{
    createdAt: Date;
    authorTag: string;
    content: string;
    attachmentUrls: string[];
  }>,
): string {
  return messages
    .map((m) => {
      const lines = [`[${m.createdAt.toISOString()}] ${m.authorTag}:`];
      if (m.content) lines.push(m.content);
      for (const url of m.attachmentUrls) lines.push(`(attachment) ${url}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

export class TicketChannelManager {
  private static instance: TicketChannelManager;
  private client: Client;
  private configService: ConfigService;

  private constructor(client: Client) {
    this.client = client;
    this.configService = ConfigService.getInstance();
  }

  public static getInstance(client: Client): TicketChannelManager {
    if (!TicketChannelManager.instance) {
      TicketChannelManager.instance = new TicketChannelManager(client);
    } else if (TicketChannelManager.instance.client !== client) {
      throw new Error(
        "TicketChannelManager already initialised with a different client",
      );
    }
    return TicketChannelManager.instance;
  }

  public static reset(): void {
    TicketChannelManager.instance =
      undefined as unknown as TicketChannelManager;
  }

  public async getSettings(): Promise<TicketSettings> {
    const [enabled, categoryId, staffRoleId, transcriptOnClose] =
      await Promise.all([
        this.configService.getBoolean("tickets.enabled", false),
        this.configService.getString("tickets.category_id", ""),
        this.configService.getString("tickets.staff_role_id", ""),
        this.configService.getBoolean("tickets.transcript_on_close", true),
      ]);
    return {
      enabled,
      categoryId: categoryId.trim(),
      staffRoleId: staffRoleId.trim(),
      transcriptOnClose,
    };
  }

  public async isEnabled(): Promise<boolean> {
    return this.configService.getBoolean("tickets.enabled", false);
  }

  /** Staff = holds the configured staff role, or is a server administrator. */
  public isStaff(member: GuildMember, staffRoleId: string): boolean {
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    return staffRoleId !== "" && member.roles.cache.has(staffRoleId);
  }

  // ---------------------------------------------------------------
  // Lookups
  // ---------------------------------------------------------------

  public findByChannel(
    guildId: string,
    channelId: string,
  ): Promise<ITicket | null> {
    return Ticket.findOne({ guildId, channelId }).exec();
  }

  public async findById(guildId: string, id: string): Promise<ITicket | null> {
    if (!/^[a-f0-9]{24}$/i.test(id)) return null;
    return Ticket.findOne({ guildId, _id: id }).exec();
  }

  public list(
    guildId: string,
    opts: { status?: TicketStatus; limit: number; skip: number },
  ): Promise<ITicket[]> {
    const filter: Record<string, unknown> = { guildId };
    if (opts.status) filter.status = opts.status;
    return Ticket.find(filter)
      .sort({ createdAt: -1 })
      .skip(opts.skip)
      .limit(opts.limit)
      .exec();
  }

  public count(guildId: string, status?: TicketStatus): Promise<number> {
    const filter: Record<string, unknown> = { guildId };
    if (status) filter.status = status;
    return Ticket.countDocuments(filter).exec();
  }

  // ---------------------------------------------------------------
  // Transitions
  // ---------------------------------------------------------------

  /** Create the private channel and the ticket row. */
  public async openTicket(input: {
    guild: Guild;
    authorId: string;
    authorName: string;
    subject: string;
  }): Promise<TicketResult<{ ticket: ITicket; channelId: string }>> {
    const settings = await this.getSettings();
    if (!settings.enabled) return { ok: false, reason: "disabled" };
    if (!settings.staffRoleId) return { ok: false, reason: "no-staff-role" };

    const subject = input.subject.trim().slice(0, MAX_SUBJECT_LENGTH);
    const manager = CommandManager.getInstance(this.client);
    const botId = this.client.user?.id;

    const overwrites: OverwriteResolvable[] = [
      {
        id: input.guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      { id: input.authorId, allow: MEMBER_ALLOW },
      {
        id: settings.staffRoleId,
        allow: [...MEMBER_ALLOW, PermissionFlagsBits.ManageMessages],
      },
    ];
    if (botId) {
      overwrites.push({
        id: botId,
        allow: [...MEMBER_ALLOW, PermissionFlagsBits.ManageChannels],
      });
    }

    let channelId: string;
    try {
      const channel = await manager.makeDiscordApiCall(
        () =>
          input.guild.channels.create({
            name: ticketChannelName(
              input.authorName,
              randomBytes(2).toString("hex"),
            ),
            type: ChannelType.GuildText,
            parent: settings.categoryId || undefined,
            topic: `Support ticket for <@${input.authorId}>: ${subject}`.slice(
              0,
              1024,
            ),
            permissionOverwrites: overwrites,
            reason: `Support ticket opened by ${input.authorId}`,
          }),
        "create ticket channel",
      );
      channelId = channel.id;

      try {
        const ticket = await Ticket.create({
          guildId: input.guild.id,
          authorId: input.authorId,
          channelId,
          subject,
          status: "open",
        });
        // Best-effort: the ticket exists and is usable without the greeting.
        await this.sendWelcome(channel, ticket, settings.staffRoleId).catch(
          (error) =>
            logger.warn(
              `Ticket ${String(ticket._id)} welcome failed: ${sanitizeForLog(getErrorMessage(error))}`,
            ),
        );
        return { ok: true, ticket: { ticket, channelId } };
      } catch (error) {
        // The row is the source of truth; a channel with no row is an orphan
        // nobody can find, so take it back down.
        await channel
          .delete("Ticket record could not be saved")
          .catch(() => {});
        throw error;
      }
    } catch (error) {
      logger.error(
        `Failed to open ticket: ${sanitizeForLog(getErrorMessage(error))}`,
      );
      return { ok: false, reason: "discord-error" };
    }
  }

  public async claimTicket(
    ticket: ITicket,
    staffId: string,
  ): Promise<TicketResult> {
    if (ticket.status === "closed")
      return { ok: false, reason: "already-closed" };
    if (ticket.status === "claimed") {
      return { ok: false, reason: "already-claimed" };
    }
    // Conditional on the row still being open, so two simultaneous claims
    // cannot both succeed and the later one silently take over.
    const claimed = await Ticket.findOneAndUpdate(
      { _id: ticket._id, status: "open" },
      { $set: { status: "claimed", claimedBy: staffId } },
      { new: true },
    ).exec();
    if (!claimed) return { ok: false, reason: "already-claimed" };
    ticket.status = claimed.status;
    ticket.claimedBy = claimed.claimedBy;
    await this.say(ticket, `🙋 <@${staffId}> claimed this ticket.`, [staffId]);
    return { ok: true, ticket };
  }

  public async closeTicket(
    ticket: ITicket,
    closerId: string,
  ): Promise<TicketResult> {
    if (ticket.status === "closed")
      return { ok: false, reason: "already-closed" };
    const settings = await this.getSettings();
    const channel = await this.fetchChannel(ticket);

    if (channel) {
      try {
        if (settings.transcriptOnClose) {
          // Best-effort: a failed transcript must not leave a "closed" ticket
          // unlocked, so it is isolated from the lock and rename below.
          try {
            const sent = await this.postTranscript(channel, ticket);
            if (sent) ticket.transcriptMessageId = sent.id;
          } catch (error) {
            logger.warn(
              `Ticket ${String(ticket._id)} transcript failed: ${sanitizeForLog(getErrorMessage(error))}`,
            );
          }
        }
        const manager = CommandManager.getInstance(this.client);
        await manager.makeDiscordApiCall(
          () =>
            channel.permissionOverwrites.edit(
              ticket.authorId,
              { SendMessages: false, SendMessagesInThreads: false },
              { reason: `Ticket closed by ${closerId}` },
            ),
          "lock closed ticket channel",
        );
        await manager.makeDiscordApiCall(
          () => channel.setName(closedChannelName(channel.name)),
          "rename closed ticket channel",
        );
        await channel.send({
          content: `🔒 Ticket closed by <@${closerId}>.`,
          allowedMentions: { parse: [] },
        });
      } catch (error) {
        // The record must still close: a ticket stuck "open" because Discord
        // hiccuped on the archive would be un-closable from the Web UI.
        logger.warn(
          `Ticket ${String(ticket._id)} archive step failed: ${sanitizeForLog(getErrorMessage(error))}`,
        );
      }
    }

    ticket.status = "closed";
    ticket.closedBy = closerId;
    ticket.closedAt = new Date();
    await ticket.save();
    return { ok: true, ticket };
  }

  public async reopenTicket(
    ticket: ITicket,
    staffId: string,
  ): Promise<TicketResult> {
    if (ticket.status !== "closed") return { ok: false, reason: "not-closed" };
    const channel = await this.fetchChannel(ticket);
    if (!channel) return { ok: false, reason: "not-found" };

    try {
      const manager = CommandManager.getInstance(this.client);
      await manager.makeDiscordApiCall(
        () =>
          channel.permissionOverwrites.edit(
            ticket.authorId,
            { SendMessages: true, SendMessagesInThreads: true },
            { reason: `Ticket reopened by ${staffId}` },
          ),
        "unlock reopened ticket channel",
      );
      await manager.makeDiscordApiCall(
        () => channel.setName(reopenedChannelName(channel.name)),
        "rename reopened ticket channel",
      );
    } catch (error) {
      logger.error(
        `Failed to reopen ticket ${String(ticket._id)}: ${sanitizeForLog(getErrorMessage(error))}`,
      );
      return { ok: false, reason: "discord-error" };
    }

    ticket.status = ticket.claimedBy ? "claimed" : "open";
    ticket.closedBy = null;
    ticket.closedAt = null;
    await ticket.save();
    await this.say(ticket, `🔓 Ticket reopened by <@${staffId}>.`, []);
    return { ok: true, ticket };
  }

  // ---------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------

  private async fetchChannel(ticket: ITicket): Promise<TextChannel | null> {
    try {
      const channel = await this.client.channels.fetch(ticket.channelId);
      if (channel && channel.type === ChannelType.GuildText) return channel;
    } catch {
      // Deleted by hand — handled by the callers.
    }
    return null;
  }

  private async say(
    ticket: ITicket,
    content: string,
    mentionUsers: string[],
  ): Promise<void> {
    const channel = await this.fetchChannel(ticket);
    if (!channel) return;
    await channel
      .send({ content, allowedMentions: { users: mentionUsers } })
      .catch((error) =>
        logger.warn(
          `Ticket ${String(ticket._id)} notice failed: ${sanitizeForLog(getErrorMessage(error))}`,
        ),
      );
  }

  private async sendWelcome(
    channel: TextChannel,
    ticket: ITicket,
    staffRoleId: string,
  ): Promise<void> {
    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle("🎫 Support ticket")
      .setDescription(ticket.subject)
      .setFooter({
        text: "Staff will be with you shortly. Use /ticket close when you're done.",
      })
      .setTimestamp();
    await channel.send({
      content: `<@${ticket.authorId}> <@&${staffRoleId}>`,
      embeds: [embed],
      allowedMentions: { users: [ticket.authorId], roles: [staffRoleId] },
    });
  }

  /** Fetch up to {@link TRANSCRIPT_MAX_MESSAGES} messages and post them as a file. */
  private async postTranscript(
    channel: TextChannel,
    ticket: ITicket,
  ): Promise<Message | null> {
    const collected: Message[] = [];
    let before: string | undefined;
    while (collected.length < TRANSCRIPT_MAX_MESSAGES) {
      const page = await channel.messages.fetch({ limit: 100, before });
      if (page.size === 0) break;
      collected.push(...page.values());
      before = page.last()?.id;
      if (page.size < 100) break;
    }
    collected.reverse();
    // Discord returns newest-first per page; sort to be safe across pages.
    collected.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    const text = renderTranscript(
      collected.map((m) => ({
        createdAt: m.createdAt,
        authorTag: m.author.tag,
        content: m.content,
        attachmentUrls: [...m.attachments.values()].map((a) => a.url),
      })),
    );
    return channel.send({
      content: `📄 Transcript (${collected.length} message${collected.length === 1 ? "" : "s"})`,
      files: [
        new AttachmentBuilder(Buffer.from(text || "(no messages)", "utf8"), {
          name: `ticket-${String(ticket._id)}.txt`,
        }),
      ],
      allowedMentions: { parse: [] },
    });
  }
}
