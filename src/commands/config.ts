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
  .setDescription("Open the admin web UI")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("web")
      .setDescription(
        "Open the admin web UI (sends you a single-use sign-in link)",
      ),
  );

async function handleWeb(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  // Defer immediately so the DB revoke/create + DM round-trip can't blow
  // Discord's 3-second interaction-ack deadline.
  await interaction.deferReply({ ephemeral: true });

  if (!isWebUIEnabled()) {
    await interaction.editReply({
      content:
        "The web UI is disabled. Ask an operator to set `WEBUI_ENABLED=true` and restart the bot.",
    });
    return;
  }

  const missing = getMissingWebUIEnvVars();
  if (missing.length > 0) {
    await interaction.editReply({
      content: `❌ Web UI is enabled but missing env vars: ${missing.join(", ")}`,
    });
    return;
  }

  if (!interaction.guildId) {
    await interaction.editReply({
      content: "This command must be run inside a guild.",
    });
    return;
  }

  try {
    const session = await WebSessionService.getInstance().create(
      interaction.user.id,
      interaction.guildId,
    );
    const ttlMinutes = Math.max(
      1,
      Math.round((session.expiresAt.getTime() - Date.now()) / 60_000),
    );
    const dmBody =
      `🔗 **Koolbot admin sign-in link**\n` +
      `${session.url}\n` +
      `This link is single-use and expires in about ${ttlMinutes} minute(s). ` +
      `If you did not run \`/config web\`, ignore this message.`;

    try {
      await interaction.user.send(dmBody);
      await interaction.editReply({
        content:
          "✅ I've DMed you a single-use sign-in link. Check your direct messages.",
      });
    } catch (dmError) {
      logger.warn(
        `Could not DM web sign-in link to ${interaction.user.id}; falling back to ephemeral reply`,
        dmError,
      );
      await interaction.editReply({
        content: dmBody,
      });
    }
  } catch (error) {
    logger.error("Error issuing web sign-in link:", error);
    await interaction.editReply({
      content: "An error occurred while issuing your sign-in link.",
    });
  }
}

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "web") {
    await handleWeb(interaction);
    return;
  }

  await interaction.reply({
    content: "Unknown subcommand.",
    ephemeral: true,
  });
}
