import { ButtonInteraction, MessageFlags } from "discord.js";
import { ConfigService } from "../services/config-service.js";
import { LfgService, spotsLeft } from "../services/lfg-service.js";
import type { ILfgPost } from "../models/lfg-post.js";
import logger from "../utils/logger.js";
import {
  replyWithError,
  replyWithUnexpectedError,
} from "../utils/error-reply.js";
import { safeReply } from "../utils/safe-reply.js";

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

/**
 * Tell just the clicker something, whatever the interaction's state. After
 * `deferUpdate()` on the public post the deferred response IS the post, so this
 * always sends an ephemeral `followUp`, never an edit (#1510).
 */
async function replyQuietly(
  interaction: ButtonInteraction,
  content: string,
): Promise<void> {
  await safeReply(
    interaction,
    { content, flags: MessageFlags.Ephemeral },
    { followUp: true },
  );
}

/**
 * Answer a failure as an ephemeral error embed that leaves the public post
 * alone (`whenDeferred: "followUp"`). Editing would overwrite the LFG post for
 * everyone.
 */
function refuse(
  interaction: ButtonInteraction,
  title: string,
  next: string,
): Promise<boolean> {
  return replyWithError(interaction, { title, next, whenDeferred: "followUp" });
}

export async function handleLfgButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const parts = interaction.customId.split("_");
  if (parts.length !== 3 || parts[0] !== "lfg" || !ACTIONS.has(parts[1])) {
    await refuse(
      interaction,
      "This LFG button is out of date",
      "Use the newest LFG post, or start your own with `/lfg`.",
    );
    return;
  }

  const [, action, postId] = parts;
  const service = LfgService.getInstance(interaction.client);

  // Acknowledge before *any* awaited work, and without changing the message:
  // the branches below decide whether it changes at all. Even the feature
  // check below is a config read that can reach Mongo on a cache miss, and
  // Discord invalidates an interaction left unacknowledged for three seconds
  // (#842). This also happens outside the per-post lock, so a queued click
  // still beats that window.
  await interaction.deferUpdate();

  // A post outlives the feature switch: the row is closed and re-rendered
  // when LFG is turned off, but an edit that could not go through leaves a
  // message still carrying live-looking buttons. They must not still work.
  if (!(await ConfigService.getInstance().getBoolean("lfg.enabled", false))) {
    await refuse(
      interaction,
      "LFG is switched off on this server",
      "This post is no longer active. Ask an admin to switch LFG on.",
    );
    return;
  }

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
   * visible roster disagrees with the row until someone else clicks.
   *
   * Every mutation marks the row `renderPending` in its own write (that is
   * what makes a crash mid-click recoverable), so a successful click settles
   * it here and costs a second write. That is the price of the row and the
   * message never silently disagreeing.
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
        await refuse(
          interaction,
          "This LFG post is closed",
          "Start your own with `/lfg`.",
        );
        return;
      }
      if (result.status === "already_joined") {
        await replyQuietly(interaction, "You're already on this roster.");
        return;
      }
      if (result.status === "full") {
        await refuse(
          interaction,
          "This party is full",
          "Check the post again later, or start your own with `/lfg`.",
        );
        return;
      }

      await refresh(result.post);
      const left = spotsLeft(result.post);
      const where = result.post.voiceChannelId
        ? ` Hop into <#${result.post.voiceChannelId}>.`
        : "";
      await replyQuietly(
        interaction,
        result.filled
          ? `You're in — that fills the party!${where}`
          : `You're in — ${left} ${left === 1 ? "spot" : "spots"} left.${where}`,
      );
      return;
    }

    if (action === "leave") {
      const result = await service.leavePost(postId, interaction.user.id);
      if (result.status === "closed") {
        await refuse(
          interaction,
          "This LFG post is closed",
          "There is nothing left to leave. Start your own with `/lfg`.",
        );
        return;
      }
      if (result.status === "host") {
        await refuse(
          interaction,
          "The host can't leave the party",
          "Use **Close** to end the post instead.",
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
      await refuse(
        interaction,
        "Only the host can close this LFG post",
        "Ask the host to press Close.",
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
    // A join, leave or close that already stored is repeated harmlessly
    // (second join: already on the roster; second close: already closed), and
    // the sweep re-renders a post whose edit failed, so "try again" is safe.
    await replyWithUnexpectedError(interaction, { whenDeferred: "followUp" });
  }
}
