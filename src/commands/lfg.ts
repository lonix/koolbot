import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import { ConfigService } from "../services/config-service.js";
import {
  LfgService,
  resolvePartySize,
  MAX_PARTY_SIZE,
  MIN_PARTY_SIZE,
} from "../services/lfg-service.js";
import logger from "../utils/logger.js";
import { safeReply } from "../utils/safe-reply.js";

/**
 * `/lfg` — ad-hoc "looking for group" posts (#957).
 *
 * Member self-service, not admin configuration, so it belongs in Discord
 * rather than the Web UI (see the admin-surface split in CLAUDE.md). The
 * command itself is fire-and-forget: everything afterwards — joining,
 * leaving, closing — happens on the post's buttons, so there are no
 * subcommands to manage a post with.
 *
 * The reply is ephemeral; the post is the public artefact.
 */

const MAX_GAME_LENGTH = 100;
const MAX_NOTE_LENGTH = 500;

export const data = new SlashCommandBuilder()
  .setName("lfg")
  .setDescription("Look for people to play with right now")
  .addStringOption((o) =>
    o
      .setName("game")
      .setDescription("What are you playing?")
      .setRequired(true)
      .setMaxLength(MAX_GAME_LENGTH),
  )
  .addIntegerOption((o) =>
    o
      .setName("size")
      .setDescription("How many people do you want in total (you included)?")
      .setMinValue(MIN_PARTY_SIZE)
      .setMaxValue(MAX_PARTY_SIZE),
  )
  .addStringOption((o) =>
    o
      .setName("note")
      .setDescription("Anything else? e.g. 'mic required', 'ranked only'")
      .setMaxLength(MAX_NOTE_LENGTH),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  // Acknowledge before any config or DB read so a slow lookup cannot miss
  // Discord's 3-second ACK window (`10062 Unknown interaction`, #842).
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const config = ConfigService.getInstance();
    if (!(await config.getBoolean("lfg.enabled", false))) {
      await interaction.editReply("The LFG feature is currently disabled.");
      return;
    }
    if (!interaction.guildId || !interaction.channelId) {
      await interaction.editReply("This command must be run inside a guild.");
      return;
    }

    const game = interaction.options.getString("game", true).trim();
    if (!game) {
      await interaction.editReply("❌ Tell me what you want to play.");
      return;
    }
    const note = interaction.options.getString("note")?.trim() ?? "";
    const defaultSize = await config.getNumber("lfg.default_size", 4);
    const partySize = resolvePartySize(
      interaction.options.getInteger("size"),
      defaultSize,
    );

    const service = LfgService.getInstance(interaction.client);
    const result = await service.createPost({
      guildId: interaction.guildId,
      hostId: interaction.user.id,
      game,
      note,
      partySize,
      fallbackChannelId: interaction.channelId,
    });

    if (result.status === "at_limit") {
      await interaction.editReply(
        result.limit === 1
          ? "❌ You already have an open LFG post. Close it from its **Close** button before opening another."
          : `❌ You already have ${result.limit} open LFG posts. Close one before opening another.`,
      );
      return;
    }
    if (result.status === "no_channel") {
      await interaction.editReply(
        "❌ I couldn't find a channel to post in. Ask an admin to set the LFG channel in the Web UI.",
      );
      return;
    }
    if (result.status === "post_failed") {
      await interaction.editReply(
        "❌ I couldn't post that — check that I can send messages in the LFG channel.",
      );
      return;
    }

    const { post } = result;
    const link = post.messageId
      ? `https://discord.com/channels/${post.guildId}/${post.channelId}/${post.messageId}`
      : null;
    await interaction.editReply(
      `✅ Posted your LFG for **${game}** (${post.memberIds.length}/${post.partySize}).` +
        (link ? `\n${link}` : ""),
    );
  } catch (error) {
    logger.error("Error in /lfg:", error);
    await safeReply(interaction, {
      content: "❌ There was an error posting your LFG.",
      flags: MessageFlags.Ephemeral,
    });
  }
}
