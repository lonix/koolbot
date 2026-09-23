import { ButtonInteraction, MessageFlags } from "discord.js";
import { ConfigService } from "../services/config-service.js";
import { LfgService, spotsLeft } from "../services/lfg-service.js";
import type { ILfgPost } from "../models/lfg-post.js";
import logger from "../utils/logger.js";

/**
 * Handle the Join / Leave / Close buttons on an LFG post (#957).
 *
 * customId format: `lfg_{action}_{postId}` — the postId is a Mongo ObjectId
 * (24 hex chars, no underscores), so a plain split is safe (same shape as
 * the event RSVP buttons).
 *
 * The click is acknowledged with `deferUpdate()` before the first database
 * read, for the same reason commands defer before theirs: Discord invalidates
 * an interaction that goes unacknowledged for three seconds, and the
 * resulting `10062 Unknown interaction` cannot be recovered — which would
 * leave a member's join recorded but unacknowledged (#842). Everything after
 * the defer therefore edits the post with `editReply` and answers the member
 * with an ephemeral `followUp`.
 */

const ACTIONS = new Set(["join", "leave", "close"]);

/** Tell just the clicker something, whatever the interaction's state. */
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

  // A post outlives the feature switch: the row is closed and re-rendered
  // when LFG is turned off, but an edit that could not go through leaves a
  // message still carrying live-looking buttons. They must not still work.
  if (!(await ConfigService.getInstance().getBoolean("lfg.enabled", false))) {
    await replyQuietly(
      interaction,
      "❌ LFG is switched off on this server, so this post is no longer active.",
    );
    return;
  }

  const service = LfgService.getInstance(interaction.client);

  // Acknowledge before the first database round-trip, and without changing
  // the message: the branches below decide whether it changes at all. This
  // happens outside the per-post lock so a queued click still beats Discord's
  // three-second window.
  await interaction.deferUpdate();

  // Take the post's turn: clicks on one post are handled one after another,
  // and the sweep's retries take the same turn, so no edit can land out of
  // order with a newer one and leave a stale roster on the message.
  await service.runOnPost(postId, () =>
    handleAction(interaction, service, action, postId),
  );
}

async function handleAction(
  interaction: ButtonInteraction,
  service: ReturnType<typeof LfgService.getInstance>,
  action: string,
  postId: string,
): Promise<void> {
  /**
   * Re-render the post, and tell the service how the edit went.
   *
   * The write is already committed by the time we get here, so a failed edit
   * must leave the row flagged for the sweep to re-render — otherwise the
   * visible roster disagrees with the row until someone else clicks. The
   * success path only writes when there is something to clear (a post this
   * click closed, or one carrying an earlier failure), so an ordinary click
   * still costs one write.
   */
  const refresh = async (post: ILfgPost): Promise<void> => {
    const postId = String(post._id);
    try {
      await interaction.editReply(service.buildPayload(post));
    } catch (error) {
      await service.markRenderPending(postId);
      throw error;
    }
    if (post.renderPending) {
      await service.recordRenderAttempt(postId, true);
    }
  };

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

      await refresh(result.post);
      const where = result.post.voiceChannelId
        ? ` Hop into <#${result.post.voiceChannelId}>.`
        : "";
      await replyQuietly(
        interaction,
        result.filled
          ? `You're in — that fills the party!${where}`
          : `You're in — ${spotsLeft(result.post)} spot(s) left.${where}`,
      );
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

      await refresh(result.post);
      await replyQuietly(interaction, "You've left the party.");
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
    await refresh(result.post);
  } catch (error) {
    logger.error("Error handling LFG button:", error);
    await replyQuietly(
      interaction,
      "❌ There was an error updating this LFG post.",
    );
  }
}
