import { GuildMember } from "discord.js";
import { ConfigService } from "./config-service.js";
import { env } from "../config/env.js";
import logger from "../utils/logger.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";
import { getErrorMessage } from "../utils/error-guards.js";

/** How long a greeted member is remembered, so a fast leave/rejoin is not greeted twice. */
export const GREETED_TTL_MS = 5 * 60 * 1000;

export interface WelcomePlaceholders {
  userId: string;
  displayName: string;
  guildName: string;
  /** Jump link / channel mention for the self-assign role picker, or "". */
  rolesLink: string;
  /** Channel mention for the rules channel, or "". */
  rulesLink: string;
}

/**
 * Fill the placeholders in a welcome message template. `{user}` is a real
 * mention (`<@id>`); whether it pings is decided by the caller's
 * `allowedMentions`. `{roles}` and `{rules}` resolve to the empty string when
 * nothing is configured, and the leftover whitespace is tidied up (same idea
 * as `{age}` in the birthday renderer). Pure, for direct unit testing.
 *
 * New placeholders (e.g. for the rules-acceptance flow, #1024) are added here
 * and in {@link WelcomePlaceholders}.
 */
export function renderWelcomeMessage(
  template: string,
  args: WelcomePlaceholders,
): string {
  const result = template
    .split("{user}")
    .join(`<@${args.userId}>`)
    .split("{username}")
    .join(args.displayName)
    .split("{server}")
    .join(args.guildName)
    .split("{roles}")
    .join(args.rolesLink)
    .split("{rules}")
    .join(args.rulesLink);
  const blankPlaceholder = !args.rolesLink || !args.rulesLink;
  return blankPlaceholder ? result.replace(/[ \t]{2,}/g, " ").trim() : result;
}

/**
 * Greets new members in a configured channel (#767). Event-driven only — no
 * timers. Needs the privileged GuildMembers intent (`GUILD_MEMBERS_INTENT`),
 * without which Discord never delivers `guildMemberAdd`.
 */
export class WelcomeService {
  private static instance: WelcomeService | undefined;
  private readonly greeted = new Map<string, number>();

  private constructor() {}

  public static getInstance(): WelcomeService {
    if (!WelcomeService.instance) {
      WelcomeService.instance = new WelcomeService();
    }
    return WelcomeService.instance;
  }

  public static reset(): void {
    WelcomeService.instance = undefined;
  }

  /**
   * Log a clear warning when the feature is on but join events cannot arrive
   * because the GuildMembers intent was not requested. Returns whether a
   * warning was logged.
   */
  public async warnIfIntentMissing(): Promise<boolean> {
    const enabled = await ConfigService.getInstance()
      .getBoolean("welcome.enabled", false)
      .catch(() => false);
    if (!enabled || env.guildMembersIntent) return false;
    logger.warn(
      "welcome.enabled is on but GUILD_MEMBERS_INTENT is not set: Discord does not deliver member-join events, so no welcome messages will be posted. Enable the Server Members Intent in the Discord developer portal and set GUILD_MEMBERS_INTENT=true.",
    );
    return true;
  }

  /** Handle a `guildMemberAdd` event. Never throws. */
  public async handleMemberJoin(member: GuildMember): Promise<void> {
    try {
      const config = ConfigService.getInstance();
      if (!(await config.getBoolean("welcome.enabled", false))) return;
      if (member.user.bot) return;
      if (!env.guildId || member.guild.id !== env.guildId) return;

      const now = Date.now();
      for (const [id, at] of this.greeted) {
        if (now - at >= GREETED_TTL_MS) this.greeted.delete(id);
      }
      if (this.greeted.has(member.id)) return;

      const channelId = (
        await config.getString("welcome.channel_id", "")
      ).trim();
      if (!channelId) {
        logger.warn(
          "welcome.enabled is on but welcome.channel_id is not set; skipping welcome message",
        );
        return;
      }
      const channel = await member.guild.channels
        .fetch(channelId)
        .catch(() => null);
      if (!channel || !channel.isTextBased() || !("send" in channel)) {
        logger.warn(
          `welcome.channel_id ${sanitizeForLog(channelId)} is not a text channel the bot can see; skipping welcome message`,
        );
        return;
      }

      const template = await config.getString(
        "welcome.message",
        "👋 Welcome to {server}, {user}!",
      );
      const mention = await config.getBoolean("welcome.mention", true);
      const content = renderWelcomeMessage(template, {
        userId: member.id,
        displayName: member.displayName,
        guildName: member.guild.name,
        rolesLink: await this.resolveRolesLink(member.guild.id),
        rulesLink: await this.resolveRulesLink(),
      });
      if (!content) return;

      this.greeted.set(member.id, now);
      await channel.send({
        content,
        allowedMentions: mention ? { users: [member.id] } : { parse: [] },
      });
    } catch (error) {
      logger.error(
        `Failed to send welcome message: ${sanitizeForLog(getErrorMessage(error))}`,
      );
    }
  }

  /**
   * Jump link to the reaction-role message when both ids are set, the
   * channel mention when only the channel is, otherwise "".
   */
  private async resolveRolesLink(guildId: string): Promise<string> {
    const config = ConfigService.getInstance();
    const channelId = (
      await config.getString("reactionroles.message_channel_id", "")
    ).trim();
    if (!channelId) return "";
    const messageId = (
      await config.getString("welcome.roles_message_id", "")
    ).trim();
    return messageId
      ? `https://discord.com/channels/${guildId}/${channelId}/${messageId}`
      : `<#${channelId}>`;
  }

  private async resolveRulesLink(): Promise<string> {
    const channelId = (
      await ConfigService.getInstance().getString(
        "welcome.rules_channel_id",
        "",
      )
    ).trim();
    return channelId ? `<#${channelId}>` : "";
  }
}
