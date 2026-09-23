import { ButtonInteraction, MessageFlags } from "discord.js";
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

/**
 * One in-flight chain per post, so clicks on the same post are handled one
 * after another.
 *
 * Each click renders the snapshot its own database write returned. Left
 * unordered, two clicks in the same instant can have their Discord edits land
 * in the opposite order from their Mongo writes, and the older roster wins the
 * message — permanently, because nothing re-renders a post that is still open.
 * Serialising the whole mutate-then-render step keeps the last edit the last
 * write. The interaction is already deferred by then, so waiting a turn costs
 * the clicker nothing.
 *
 * In-process is the right scope: the bot runs as a single process (the voice
 * manager's in-memory ownership maps assume the same), and the writes
 * themselves stay atomic regardless.
 */
const postChains = new Map<string, Promise<void>>();

function withPostLock(
  postId: string,
  work: () => Promise<void>,
): Promise<void> {
  const previous = postChains.get(postId) ?? Promise.resolve();
  // `catch` first: one click's failure must not poison the next click's turn.
  const next = previous.catch(() => undefined).then(work);
  postChains.set(postId, next);
  void next
    .catch(() => undefined)
    .finally(() => {
      // Only the tail clears the entry, so the map cannot grow with every click
      // and a chain still running is never dropped.
      if (postChains.get(postId) === next) postChains.delete(postId);
    });
  return next;
}

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
  const service = LfgService.getInstance(interaction.client);

  // Acknowledge before the first database round-trip, and without changing
  // the message: the branches below decide whether it changes at all. This
  // happens outside the per-post lock so a queued click still beats Discord's
  // three-second window.
  await interaction.deferUpdate();

  await withPostLock(postId, () =>
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
   * Re-render the post. A post that has just closed also gets marked as
   * rendered, so the sweep neither retries this edit nor purges the row
   * while its message still reads as open.
   */
  const refresh = async (post: ILfgPost): Promise<void> => {
    await interaction.editReply(service.buildPayload(post));
    if (post.state === "closed") {
      await service.markCloseRendered(String(post._id));
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
