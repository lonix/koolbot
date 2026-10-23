/**
 * Re-post a message the bot manages (the quotes header, the notices header,
 * the rules message) so an admin can force a fresh one while the old message
 * still exists (#1428).
 *
 * The order is the whole point. The new message is sent first, its id is
 * stored second, and the old message is taken down last:
 *
 * - If sending fails (no permission, channel gone), nothing has changed and the
 *   old message is still the live one.
 * - If storing the id fails, the new message is taken down again and the old
 *   one stays live. There are never two live copies after a failed save.
 * - Deleting the old message last means the periodic header check (which
 *   recreates a header whose stored id is stale) never sees a window with no
 *   header and posts a second one.
 * - A button on the old rules message stops working the moment the new id is
 *   stored, because the accept handler only honours the stored id.
 *
 * Never throws: every outcome comes back as a {@link RepostResult}.
 */

import type { Message } from "discord.js";
import logger from "../utils/logger.js";
import { describeDiscordError } from "../utils/log-sanitize.js";
import { escapeDisplayText } from "../utils/allowed-mentions.js";

/** What happened to the message that was live before the re-post. */
export type OldMessageOutcome =
  /** No id was stored, so there was nothing to take down. */
  | "none"
  /** Found in the channel and deleted. */
  | "deleted"
  /**
   * Not found in the channel the bot posts to now. It was deleted, or it sits
   * in the channel it was posted in before a channel change. Either way the bot
   * can't see it, so it can't remove it.
   */
  | "not-found"
  /** The stored id points at a message the bot did not write; left alone. */
  | "not-ours"
  /** Found but could not be deleted (missing permission or a Discord error). */
  | "delete-failed"
  /** Could not be looked up (a Discord error other than "not found"). */
  | "lookup-failed";

export type RepostFailure =
  /** The bot may not post in the channel. Nothing was changed. */
  | "no-permission"
  /** The feature or channel isn't set up. Nothing was changed. */
  | "not-ready"
  /** The submitted id isn't the live one any more: someone re-posted first. */
  | "stale"
  /** The message was posted but its id couldn't be saved, so it was removed. */
  | "not-saved"
  /** Any other Discord or database failure. */
  | "failed";

export type RepostResult =
  | {
      ok: true;
      /** The new message. */
      messageId: string;
      /** The id that was stored before, or null when there was none. */
      oldMessageId: string | null;
      old: OldMessageOutcome;
    }
  | { ok: false; reason: RepostFailure; error: string };

export interface RepostChannel {
  id: string;
  name?: string;
  messages: {
    fetch(id: string): Promise<Message>;
  };
}

export interface RepostParams {
  channel: RepostChannel;
  /** The bot's own user id; only the bot's own messages are ever deleted. */
  botUserId: string | undefined;
  /** The stored id of the live message, or "" when there is none. */
  oldId: string;
  /** Sends (and pins, if wanted) the new message. May throw. */
  send: () => Promise<Message>;
  /** Stores the new id. May throw. */
  store: (id: string) => Promise<void>;
  /** For log lines, e.g. "quote channel header". */
  label: string;
}

/** Discord error codes that mean the bot may not act in the channel. */
const MISSING_ACCESS = 50001;
const MISSING_PERMISSIONS = 50013;
const UNKNOWN_MESSAGE = 10008;
const UNKNOWN_CHANNEL = 10003;

function codeOf(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : undefined;
}

/** Whether Discord refused because the bot lacks access or permission. */
export function isPermissionError(error: unknown): boolean {
  const code = codeOf(error);
  return code === MISSING_ACCESS || code === MISSING_PERMISSIONS;
}

/** The message for a failed send, in words an admin can act on. */
export function sendFailureText(error: unknown, channelName?: string): string {
  // A channel name is admin-controlled text that can carry `@everyone`, a
  // `<@id>` mention or Markdown; neutralise it before it goes into a message.
  const where = channelName
    ? `#${escapeDisplayText(channelName)}`
    : "the channel";
  if (isPermissionError(error)) {
    return `KoolBot isn't allowed to post in ${where}. Give it View Channel, Send Messages and Embed Links there, then try again. Nothing was changed.`;
  }
  if (codeOf(error) === UNKNOWN_CHANNEL) {
    return `${where} no longer exists. Pick a channel in the settings first. Nothing was changed.`;
  }
  return "Discord refused the new message, so nothing was changed. Check the bot's channel access and try again.";
}

export async function repostManagedMessage(
  p: RepostParams,
): Promise<RepostResult> {
  const oldId = p.oldId.trim();

  let sent: Message;
  try {
    sent = await p.send();
  } catch (error) {
    logger.warn(
      `Re-posting the ${p.label} failed: ${describeDiscordError(error)}`,
    );
    return {
      ok: false,
      reason: isPermissionError(error) ? "no-permission" : "failed",
      error: sendFailureText(error, p.channel.name),
    };
  }

  try {
    await p.store(sent.id);
  } catch (error) {
    logger.error(
      `Re-posting the ${p.label}: the new id couldn't be saved: ${describeDiscordError(error)}`,
    );
    // Only say the new message is gone when it is: a failed rollback leaves a
    // visible, untracked copy that a blind retry would add to.
    let removed = true;
    try {
      await sent.delete();
    } catch (deleteError) {
      // Unknown Message: it is already gone, which is what we wanted.
      if (codeOf(deleteError) !== UNKNOWN_MESSAGE) {
        removed = false;
        logger.warn(
          `Couldn't remove the unlinked ${p.label} ${sent.id}: ${describeDiscordError(deleteError)}`,
        );
      }
    }
    return {
      ok: false,
      reason: "not-saved",
      error: removed
        ? "The new message was posted but couldn't be saved, so it was taken down again and the old one is still live. Check the database and try again."
        : `The new message was posted but couldn't be saved, and it couldn't be taken down again. Delete message ${sent.id} in ${p.channel.name ? `#${escapeDisplayText(p.channel.name)}` : "the channel"} by hand (the old one is still the live one), fix the database, and only then try again.`,
    };
  }

  const old = oldId ? await removeOld(p, oldId) : "none";
  return {
    ok: true,
    messageId: sent.id,
    oldMessageId: oldId || null,
    old,
  };
}

async function removeOld(
  p: RepostParams,
  oldId: string,
): Promise<OldMessageOutcome> {
  let message: Message;
  try {
    message = await p.channel.messages.fetch(oldId);
  } catch (error) {
    if (codeOf(error) === UNKNOWN_MESSAGE) return "not-found";
    logger.warn(
      `Re-posting the ${p.label}: couldn't look up the old message ${oldId}: ${describeDiscordError(error)}`,
    );
    return "lookup-failed";
  }
  if (!message || message.author?.id !== p.botUserId) return "not-ours";
  try {
    await message.delete();
    return "deleted";
  } catch (error) {
    if (codeOf(error) === UNKNOWN_MESSAGE) return "not-found";
    logger.warn(
      `Re-posting the ${p.label}: couldn't delete the old message ${oldId}: ${describeDiscordError(error)}`,
    );
    return "delete-failed";
  }
}

/** The feature or channel isn't ready; nothing was changed. */
export function notReady(error: string): RepostResult {
  return { ok: false, reason: "not-ready", error };
}

/** The admin's page was out of date: the message was already re-posted. */
export function staleRepost(): RepostResult {
  return {
    ok: false,
    reason: "stale",
    error:
      "This message was already re-posted, so nothing was done this time. Reload the page to see the current one.",
  };
}

/** A failure nobody planned for; the caller has logged it. */
export function unexpectedRepostFailure(): RepostResult {
  return {
    ok: false,
    reason: "failed",
    error: "Something went wrong, so nothing was re-posted. Try again.",
  };
}

/**
 * What to tell the admin about the old message. `what` names what was
 * re-posted ("The quotes header"). The flash level follows the outcome:
 * anything that may leave a second visible copy is a warning.
 */
export function describeRepost(
  result: Extract<RepostResult, { ok: true }>,
  what: string,
  extra = "",
): { type: "ok" | "warn"; text: string } {
  const base = `${what} was posted again.`;
  switch (result.old) {
    case "none":
      return { type: "ok", text: `${base}${extra}` };
    case "deleted":
      return { type: "ok", text: `${base} The old one was removed.${extra}` };
    case "not-found":
      return {
        type: "warn",
        text: `${base} The old message wasn't in the channel KoolBot posts to now. It was deleted, or it is still in the channel it was posted in before; if you can see it there, delete it.${extra}`,
      };
    case "not-ours":
      return {
        type: "warn",
        text: `${base} The saved id pointed at a message KoolBot did not write, so it was left alone.${extra}`,
      };
    case "delete-failed":
    case "lookup-failed":
      return {
        type: "warn",
        text: `${base} The old message could not be removed, so it may still be visible. Delete it in Discord (message ${result.oldMessageId ?? ""}).${extra}`,
      };
  }
}
