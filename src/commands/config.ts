import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  GuildMember,
  PermissionFlagsBits,
} from "discord.js";
import logger from "../utils/logger.js";
import { WebSessionService } from "../services/web-session-service.js";
import type { WebSessionRole } from "../models/web-session.js";
import { getMissingWebUIEnvVars, isWebUIEnabled } from "../web/index.js";

export const data = new SlashCommandBuilder()
  .setName("config")
  .setDescription(
    "Open the Koolbot web UI (sends you a single-use sign-in link)",
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const userId = interaction.user.id;
  const guildId = interaction.guildId;
  logger.info(`/config invoked by user=${userId} guild=${guildId ?? "<none>"}`);

  // Defer immediately so the DB revoke/create + DM round-trip can't blow
  // Discord's 3-second interaction-ack deadline.
  await interaction.deferReply({ ephemeral: true });

  if (!isWebUIEnabled()) {
    logger.info(
      `/config rejected for user=${userId}: WebUI disabled (WEBUI_ENABLED!=true)`,
    );
    await interaction.editReply({
      content:
        "The web UI is disabled. Ask an operator to set `WEBUI_ENABLED=true` and restart the bot.",
    });
    return;
  }

  const missing = getMissingWebUIEnvVars();
  if (missing.length > 0) {
    logger.warn(
      `/config rejected for user=${userId}: missing env vars: ${missing.join(", ")}`,
    );
    await interaction.editReply({
      content: `❌ Web UI is enabled but missing env vars: ${missing.join(", ")}`,
    });
    return;
  }

  if (!guildId) {
    logger.info(`/config rejected for user=${userId}: not invoked in a guild`);
    await interaction.editReply({
      content: "This command must be run inside a guild.",
    });
    return;
  }

  // Pick the session role from the invoker's live guild permissions.
  // Administrator gets `admin` (admin panel + own `/me`); everyone else
  // gets `user` (only `/me`). Falling through to "user" on a non-member
  // is conservative — the user surface itself enforces self-scope, so a
  // bad role wouldn't grant access to anyone else's data.
  const role: WebSessionRole = invokerIsAdmin(interaction.member)
    ? "admin"
    : "user";

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
    const dmBody = buildDmBody(session.url, ttlMinutes, role);

    try {
      await interaction.user.send(dmBody);
      logger.info(
        `/config: sign-in link DMed to user=${userId} (expires ${session.expiresAt.toISOString()})`,
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
      await interaction.editReply({
        content: dmBody,
      });
    }
  } catch (error) {
    logger.error(`Error issuing web sign-in link for user=${userId}:`, error);
    await interaction.editReply({
      content: "An error occurred while issuing your sign-in link.",
    });
  }
}

/**
 * Determine whether the invoking guild member has the Administrator
 * permission. Returns false defensively when the member object is null
 * (DM contexts, partials missing the permissions bitfield, etc.) — that
 * case is already filtered out earlier in the handler, but the
 * conservative default makes role escalation impossible from this path
 * even if the upstream check were removed.
 */
function invokerIsAdmin(
  member: ChatInputCommandInteraction["member"],
): boolean {
  if (!member) return false;
  // Cached members are `GuildMember`; non-cached interactions surface an
  // `APIInteractionGuildMember` whose `permissions` field is a string
  // bitfield. We only trust the cached path for the strongly-typed
  // `.has()` check; the bitfield branch is handled below.
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

function buildDmBody(
  url: string,
  ttlMinutes: number,
  role: WebSessionRole,
): string {
  const lifecycle =
    `This link is single-use and expires in about ${ttlMinutes} minute(s). ` +
    `If you did not run \`/config\`, ignore this message.`;
  if (role === "admin") {
    // Admins get one sign-in link plus a note that explains both
    // post-redemption surfaces. The token covers `/admin/*` and
    // `/me/*`; we land them on the admin panel by default but the link
    // to their own preferences is right there in the DM.
    return (
      `🔗 **Koolbot sign-in link**\n` +
      `${url}\n` +
      `\n` +
      `Once you've signed in:\n` +
      `• **Admin panel:** the link above drops you on \`/admin/\`.\n` +
      `• **My preferences:** switch to \`/me/\` for your own settings ` +
      `(also reachable via the header link on every admin page).\n` +
      `\n` +
      `${lifecycle}`
    );
  }
  return (
    `🔗 **Koolbot sign-in link**\n` +
    `${url}\n` +
    `Opens **My preferences** (\`/me/\`) — your personal Koolbot settings ` +
    `for this server.\n` +
    `\n` +
    `${lifecycle}`
  );
}
