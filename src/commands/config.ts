import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import logger from "../utils/logger.js";
import { WebSessionService } from "../services/web-session-service.js";
import { getMissingWebUIEnvVars, isWebUIEnabled } from "../web/index.js";

export const data = new SlashCommandBuilder()
  .setName("config")
  .setDescription("Open the admin web UI (sends you a single-use sign-in link)")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

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

  try {
    const session = await WebSessionService.getInstance().create(
      userId,
      guildId,
    );
    const ttlMinutes = Math.max(
      1,
      Math.round((session.expiresAt.getTime() - Date.now()) / 60_000),
    );
    const dmBody =
      `🔗 **Koolbot admin sign-in link**\n` +
      `${session.url}\n` +
      `This link is single-use and expires in about ${ttlMinutes} minute(s). ` +
      `If you did not run \`/config\`, ignore this message.`;

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
