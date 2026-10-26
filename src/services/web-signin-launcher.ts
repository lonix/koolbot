import {
  ChatInputCommandInteraction,
  GuildMember,
  PermissionFlagsBits,
  MessageFlags,
} from "discord.js";
import logger from "../utils/logger.js";
import { describeDiscordError } from "../utils/log-sanitize.js";
import { safeReply } from "../utils/safe-reply.js";
import { replyWithError, UNEXPECTED_ERROR } from "../utils/error-reply.js";
import {
  clearMemberCooldown,
  cooldownRemaining,
  startCooldown,
  waitText,
} from "../utils/member-cooldown.js";
import { ConfigService } from "./config-service.js";
import { WebSessionService } from "./web-session-service.js";
import { RoleGroupService } from "./role-group-service.js";
import type { WebSessionRole } from "../models/web-session.js";
import { env } from "../config/env.js";
import { isForeignGuild } from "../utils/guild-scope.js";
import { isWebUIEnabled, validateWebUIEnvVars } from "../web/index.js";

/**
 * Shared flow behind `/config` (admin) and `/me` (member): defer, run the
 * Web UI enabled/valid-config checks, issue a single-use sign-in session for
 * a role the caller picked, and deliver the link per `core.webui.link_delivery` (DM by default, ephemeral
 * fallback when DMs are closed). Each command only chooses the role and the DM wording.
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

/**
 * Administrator permission *or* membership of the `admin` role group (#1021);
 * the guild owner always counts. Fails closed to `invokerIsAdmin` when the
 * groups can't be read.
 */
export async function invokerIsAdminOrGroup(
  interaction: ChatInputCommandInteraction,
): Promise<boolean> {
  if (invokerIsAdmin(interaction.member)) return true;
  try {
    const member =
      interaction.member instanceof GuildMember
        ? interaction.member
        : await interaction.guild?.members.fetch(interaction.user.id);
    if (!member) return false;
    return await RoleGroupService.getInstance().memberHasCapability(
      member,
      "admin",
    );
  } catch (error) {
    logger.warn("web signin: admin group check failed", error);
    return false;
  }
}

export async function runWebSignin(
  interaction: ChatInputCommandInteraction,
  options: WebSigninOptions,
  /** Optional guard run after the defer; return a message to reject with. */
  guard?: () => string | null | Promise<string | null>,
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

  const rejection = (await guard?.()) ?? null;
  if (rejection) {
    logger.info(`/${commandName} rejected for user=${userId}: not permitted`);
    await replyWithError(interaction, {
      title: "You can't use this command",
      next: rejection,
    });
    return;
  }

  if (!isWebUIEnabled()) {
    logger.info(
      `/${commandName} rejected for user=${userId}: WebUI disabled (WEBUI_ENABLED!=true)`,
    );
    await replyWithError(interaction, {
      title: "The Web UI is off",
      next: "Ask an operator to set `WEBUI_ENABLED=true` and restart the bot.",
    });
    return;
  }

  const configErrors = validateWebUIEnvVars();
  if (configErrors.length > 0) {
    logger.warn(
      `/${commandName} rejected for user=${userId}: invalid WebUI config: ${configErrors.join("; ")}`,
    );
    // The detail stays in the log above. Only `/config` (admin-only, behind
    // the guard) may show it; `/me` is open to every member.
    await replyWithError(interaction, {
      title: "The Web UI isn't set up correctly",
      next:
        role === "admin"
          ? `Its configuration is invalid: ${configErrors.join("; ")}`
          : "Ask an admin to check the Web UI settings.",
    });
    return;
  }

  if (!guildId) {
    logger.info(
      `/${commandName} rejected for user=${userId}: not invoked in a guild`,
    );
    await replyWithError(interaction, {
      title: "Can't use this here",
      next: "Run this command in a server.",
    });
    return;
  }

  // The Web UI belongs to the configured guild only (#1144).
  if (isForeignGuild(guildId, env.guildId)) {
    logger.info(
      `/${commandName} rejected for user=${userId}: guild is not the configured GUILD_ID`,
    );
    await replyWithError(interaction, {
      title: "Can't use this here",
      next: "The Web UI is only available in this bot's own server.",
    });
    return;
  }

  // Every link is a new session row that revokes the previous one, so cap how
  // fast one member can ask (#1147). Started before the awaits below so two
  // simultaneous invocations cannot both pass; cleared again if issuing fails.
  const cooldownScope = `web-signin:${guildId}:${role}`;
  const cooldownSeconds = await ConfigService.getInstance().getNumber(
    "core.webui.signin_cooldown_seconds",
    60,
  );
  const wait = cooldownRemaining(cooldownScope, userId, cooldownSeconds);
  if (wait > 0) {
    logger.info(`/${commandName} rejected for user=${userId}: cooldown`);
    await replyWithError(interaction, {
      title: "You just asked for a sign-in link",
      next: `Please wait ${waitText(wait)}, or use the link I already sent you.`,
    });
    return;
  }
  const cooldownToken = startCooldown(cooldownScope, userId, cooldownSeconds);

  // Once a session row exists the issuance the cooldown bounds has happened,
  // so later (delivery) failures must keep the cooldown.
  let sessionCreated = false;
  try {
    const session = await WebSessionService.getInstance().create(
      userId,
      guildId,
      role,
    );
    sessionCreated = true;
    const ttlMinutes = Math.max(
      1,
      Math.round((session.expiresAt.getTime() - Date.now()) / 60_000),
    );
    const dmBody = options.buildDmBody(session.url, ttlMinutes);

    const delivery = await ConfigService.getInstance().getString(
      "core.webui.link_delivery",
      "dm",
    );
    if (delivery === "ephemeral") {
      logger.info(
        `/${commandName}: sign-in link sent ephemerally to user=${userId} (expires ${session.expiresAt.toISOString()})`,
      );
      await interaction.editReply({ content: dmBody });
      return;
    }

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
      // Never pass the raw error: a DiscordAPIError carries the DM body
      // (the sign-in link) in `requestBody` (#1152).
      logger.warn(
        `/${commandName}: could not DM web sign-in link to user=${userId} (${describeDiscordError(dmError)}); falling back to ephemeral reply`,
      );
      await safeReply(interaction, { content: dmBody });
    }
  } catch (error) {
    // Only our own reservation: a newer one (ours expired while create() was
    // slow) belongs to another request and must survive.
    if (!sessionCreated) {
      clearMemberCooldown(cooldownScope, userId, cooldownToken);
    }
    logger.error(
      `Error issuing web sign-in link for user=${userId}: ${describeDiscordError(error)}`,
    );
    await replyWithError(interaction, {
      title: "Couldn't issue your sign-in link",
      next: UNEXPECTED_ERROR.next,
    });
  }
}
