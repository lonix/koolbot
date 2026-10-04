import {
  ChatInputCommandInteraction,
  GuildMember,
  PermissionFlagsBits,
  MessageFlags,
} from "discord.js";
import logger from "../utils/logger.js";
import { safeReply } from "../utils/safe-reply.js";
import { WebSessionService } from "./web-session-service.js";
import type { WebSessionRole } from "../models/web-session.js";
import { isWebUIEnabled, validateWebUIEnvVars } from "../web/index.js";

/**
 * Shared flow behind `/config` (admin) and `/me` (member): defer, run the
 * Web UI enabled/valid-config checks, issue a single-use sign-in session for
 * a role the caller picked, and DM the link (ephemeral fallback when DMs are
 * closed). Each command only chooses the role and the DM wording.
 */
export interface WebSigninOptions {
  /** Command name for log lines, without the slash. */
  commandName: string;
  /** Role the issued session carries. */
  role: WebSessionRole;
  /** Builds the DM body for the issued link. */
  buildDmBody: (url: string, ttlMinutes: number) => string;
}

/**
 * Whether the invoking guild member has the Administrator permission.
 * Returns false defensively when the member object is null (DM contexts,
 * partials missing the permissions bitfield, etc.).
 */
export function invokerIsAdmin(
  member: ChatInputCommandInteraction["member"],
): boolean {
  if (!member) return false;
  // Cached members are `GuildMember`; non-cached interactions surface an
  // `APIInteractionGuildMember` whose `permissions` is a string bitfield.
  if (member instanceof GuildMember) {
    return member.permissions.has(PermissionFlagsBits.Administrator);
  }
  const raw = (member as { permissions?: unknown }).permissions;
  if (typeof raw !== "string") return false;
  try {
    return (
      (BigInt(raw) & PermissionFlagsBits.Administrator) ===
      PermissionFlagsBits.Administrator
    );
  } catch {
    return false;
  }
}

export async function runWebSignin(
  interaction: ChatInputCommandInteraction,
  options: WebSigninOptions,
  /** Optional guard run after the defer; return a message to reject with. */
  guard?: () => string | null,
): Promise<void> {
  const { commandName, role } = options;
  const userId = interaction.user.id;
  const guildId = interaction.guildId;
  logger.info(
    `/${commandName} invoked by user=${userId} guild=${guildId ?? "<none>"}`,
  );

  // Defer immediately so the DB revoke/create + DM round-trip can't blow
  // Discord's 3-second interaction-ack deadline (#842).
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const rejection = guard?.() ?? null;
  if (rejection) {
    logger.info(`/${commandName} rejected for user=${userId}: not permitted`);
    await interaction.editReply({ content: rejection });
    return;
  }

  if (!isWebUIEnabled()) {
    logger.info(
      `/${commandName} rejected for user=${userId}: WebUI disabled (WEBUI_ENABLED!=true)`,
    );
    await interaction.editReply({
      content:
        "The web UI is disabled. Ask an operator to set `WEBUI_ENABLED=true` and restart the bot.",
    });
    return;
  }

  const configErrors = validateWebUIEnvVars();
  if (configErrors.length > 0) {
    logger.warn(
      `/${commandName} rejected for user=${userId}: invalid WebUI config: ${configErrors.join("; ")}`,
    );
    await interaction.editReply({
      content: `❌ Web UI is enabled but its configuration is invalid: ${configErrors.join("; ")}`,
    });
    return;
  }

  if (!guildId) {
    logger.info(
      `/${commandName} rejected for user=${userId}: not invoked in a guild`,
    );
    await interaction.editReply({
      content: "This command must be run inside a guild.",
    });
    return;
  }

  try {
    const session = await WebSessionService.getInstance().create(
      userId,
      guildId,
      role,
    );
    const ttlMinutes = Math.max(
      1,
      Math.round((session.expiresAt.getTime() - Date.now()) / 60_000),
    );
    const dmBody = options.buildDmBody(session.url, ttlMinutes);

    try {
      await interaction.user.send(dmBody);
      logger.info(
        `/${commandName}: sign-in link DMed to user=${userId} (expires ${session.expiresAt.toISOString()})`,
      );
      await interaction.editReply({
        content:
          "✅ I've DMed you a single-use sign-in link. Check your direct messages.",
      });
    } catch (dmError) {
      logger.warn(
        `Could not DM web sign-in link to ${userId}; falling back to ephemeral reply`,
        dmError,
      );
      await safeReply(interaction, { content: dmBody });
    }
  } catch (error) {
    logger.error(`Error issuing web sign-in link for user=${userId}:`, error);
    await safeReply(interaction, {
      content: "An error occurred while issuing your sign-in link.",
    });
  }
}
