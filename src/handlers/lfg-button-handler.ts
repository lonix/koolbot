import { ButtonInteraction, MessageFlags } from "discord.js";
import { LfgService, spotsLeft } from "../services/lfg-service.js";
import logger from "../utils/logger.js";

/**
 * Handle the Join / Leave / Close buttons on an LFG post (#957).
 *
 * customId format: `lfg_{action}_{postId}` — the postId is a Mongo ObjectId
 * (24 hex chars, no underscores), so a plain split is safe (same shape as
 * the event RSVP buttons).
 *
 * Every branch either updates the post message or replies ephemerally, so a
 * click always gets an acknowledgement inside Discord's 3-second window.
 */

const ACTIONS = new Set(["join", "leave", "close"]);

async function replyQuietly(
  interaction: ButtonInteraction,
  content: string,
): Promise<void> {
  if (interaction.replied || interaction.deferred) {
    await interaction
      .followUp({ content, flags: MessageFlags.Ephemeral })
      .catch(() => undefined);
    return;
  }
  await interaction
    .reply({ content, flags: MessageFlags.Ephemeral })
    .catch(() => undefined);
}

export async function handleLfgButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const parts = interaction.customId.split("_");
  if (parts.length !== 3 || parts[0] !== "lfg" || !ACTIONS.has(parts[1])) {
    await replyQuietly(interaction, "❌ Invalid LFG button.");
    return;
  }

  const [, action, postId] = parts;
  const service = LfgService.getInstance(interaction.client);

  try {
    if (action === "join") {
      const result = await service.joinPost(postId, interaction.user.id);
      if (result.status === "closed") {
        await replyQuietly(
          interaction,
          "❌ This LFG post is no longer open. Start your own with `/lfg`.",
        );
        return;
      }
      if (result.status === "already_joined") {
        await replyQuietly(interaction, "You're already on this roster.");
        return;
      }
      if (result.status === "full") {
        await replyQuietly(interaction, "❌ This party is already full.");
        return;
      }

      await interaction.update(service.buildPayload(result.post));
      const where = result.post.voiceChannelId
        ? ` Hop into <#${result.post.voiceChannelId}>.`
        : "";
      await interaction.followUp({
        content: result.filled
          ? `You're in — that fills the party!${where}`
          : `You're in — ${spotsLeft(result.post)} spot(s) left.${where}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (action === "leave") {
      const result = await service.leavePost(postId, interaction.user.id);
      if (result.status === "closed") {
        await replyQuietly(interaction, "❌ This LFG post is no longer open.");
        return;
      }
      if (result.status === "host") {
        await replyQuietly(
          interaction,
          "You're the host — use **Close** to end the post instead.",
        );
        return;
      }
      if (result.status === "not_joined") {
        await replyQuietly(interaction, "You weren't on this roster.");
        return;
      }

      await interaction.update(service.buildPayload(result.post));
      await interaction.followUp({
        content: "You've left the party.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const result = await service.closeByHost(postId, interaction.user.id);
    if (result.status === "not_host") {
      await replyQuietly(
        interaction,
        "❌ Only the host can close this LFG post.",
      );
      return;
    }
    if (result.status === "closed_already") {
      await replyQuietly(interaction, "This LFG post is already closed.");
      return;
    }
    await interaction.update(service.buildPayload(result.post));
  } catch (error) {
    logger.error("Error handling LFG button:", error);
    await replyQuietly(
      interaction,
      "❌ There was an error updating this LFG post.",
    );
  }
}
