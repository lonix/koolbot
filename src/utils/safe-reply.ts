import type {
  InteractionEditReplyOptions,
  InteractionReplyOptions,
  RepliableInteraction,
} from "discord.js";
import logger from "./logger.js";
import { getErrorMessage } from "./error-guards.js";

/**
 * Reply-only fields that `editReply` does not accept. Ephemerality (and the
 * other delivery flags) are fixed when the interaction is first acknowledged,
 * so they are meaningless once we are editing an existing response.
 */
function toEditPayload(
  payload: InteractionReplyOptions,
): InteractionEditReplyOptions {
  const rest: InteractionReplyOptions = { ...payload };
  delete rest.ephemeral;
  delete rest.flags;
  delete rest.tts;
  delete rest.withResponse;
  delete rest.fetchReply;
  return rest as InteractionEditReplyOptions;
}

/**
 * Deliver a response to an interaction without ever throwing.
 *
 * discord.js does not await event-listener promises, so a rejected
 * `reply`/`editReply` inside a `catch` block escapes as an unhandled
 * rejection. That is exactly the path a dead interaction takes: the command
 * misses the 3-second ACK window, its own reply fails with `10062 Unknown
 * interaction`, and the error handler then replies to the same dead
 * interaction and fails again with nothing left to catch it (see issue #837).
 *
 * This helper picks the correct method for the interaction's current state and
 * swallows (logging) any failure, so error handling can never become the
 * error.
 *
 * @returns `true` if the response was delivered, `false` if it could not be.
 */
export async function safeReply(
  interaction: RepliableInteraction,
  payload: InteractionReplyOptions,
): Promise<boolean> {
  try {
    if (interaction.replied) {
      // Already acknowledged with a visible response (including `update()` on
      // a component interaction) — a second `reply` would throw, so append.
      await interaction.followUp(payload);
    } else if (interaction.deferred) {
      await interaction.editReply(toEditPayload(payload));
    } else {
      await interaction.reply(payload);
    }
    return true;
  } catch (error) {
    logger.error(
      `Failed to deliver response for interaction ${interaction.id}: ${getErrorMessage(error)}`,
    );
    return false;
  }
}
