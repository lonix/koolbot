import {
  EmbedBuilder,
  MessageFlags,
  type RepliableInteraction,
} from "discord.js";
import { embedColor } from "./embed-style.js";
import { safeReply } from "./safe-reply.js";
import logger from "./logger.js";
import { describeDiscordError } from "./log-sanitize.js";

/**
 * The one shape of a failed or refused answer in Discord (#1509, epic #1314):
 * an `embed-danger` embed whose title says what failed and whose description
 * says what to do next (`docs/design/discord.md` → Replies). Use it from slash
 * commands, the dispatcher and component handlers instead of writing a
 * `❌ …` line (a guard test fails on one in `src/commands/`).
 */
export interface ErrorMessage {
  /** Sentence case, says what failed ("Couldn't post your LFG"). No emoji. */
  title: string;
  /** One or two short sentences: what the member does next. */
  next: string;
}

export interface ReplyWithErrorOptions {
  /**
   * What to do when the interaction is already deferred.
   *
   * - `"edit"` (default): replace the deferred response. Right after
   *   `deferReply()`, and for a component that deferred with `deferUpdate()` on
   *   an ephemeral panel the error should replace.
   * - `"followUp"`: send the error as a separate ephemeral message and leave
   *   the deferred response alone. Right for a component that deferred with
   *   `deferUpdate()` on a public message (discord.js sets `deferred` for both,
   *   so only the caller knows which it is).
   */
  whenDeferred?: "edit" | "followUp";
}

/** The shared wording for an error nobody planned for; every catch-all uses it. */
export const UNEXPECTED_ERROR: Readonly<ErrorMessage> = {
  title: "Something went wrong",
  next: "Try again in a minute. If it keeps happening, tell an admin; the details are in the bot's log.",
};

/** Discord's embed limits; a longer value makes the whole reply fail. */
const MAX_TITLE = 256;
const MAX_DESCRIPTION = 4096;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The embed itself, for a caller that sends it some other way. */
export function errorEmbed({ title, next }: ErrorMessage): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(embedColor("danger"))
    .setTitle(clip(title, MAX_TITLE))
    .setDescription(clip(next, MAX_DESCRIPTION));
}

/**
 * Answer an interaction with an error embed. Ephemeral when nothing was
 * acknowledged yet; after `deferReply()` the response keeps the visibility it
 * was deferred with (Discord fixes it then), so the embed edits it. Like
 * `safeReply`, this never throws: it returns `false` when delivery failed.
 *
 * It also clears the deferred response's `content` and components, so an error
 * replaces a panel rather than sitting under it.
 */
export async function replyWithError(
  interaction: RepliableInteraction,
  { title, next, whenDeferred = "edit" }: ErrorMessage & ReplyWithErrorOptions,
): Promise<boolean> {
  // Building the embed (design tokens, embed builder) is inside the no-throw
  // boundary too: callers use this from their last catch block.
  let embed: EmbedBuilder;
  try {
    embed = errorEmbed({ title, next });
  } catch (error) {
    logger.error(
      `Failed to build the error embed for interaction ${interaction.id}: ${describeDiscordError(error)}`,
      { stack: error instanceof Error ? error.stack : undefined },
    );
    return false;
  }
  return safeReply(
    interaction,
    {
      content: "",
      embeds: [embed],
      components: [],
      flags: MessageFlags.Ephemeral,
    },
    { followUp: whenDeferred === "followUp" },
  );
}

/** `replyWithError` with the shared "Something went wrong" wording, for catch-alls. */
export function replyWithUnexpectedError(
  interaction: RepliableInteraction,
  options: ReplyWithErrorOptions = {},
): Promise<boolean> {
  return replyWithError(interaction, { ...UNEXPECTED_ERROR, ...options });
}

/** What a command already did, for a failure that happens after its write. */
export interface WriteDone {
  /** Says the write happened, as the title ("Your reminder was saved"). */
  done: string;
  /** Where the member can check, in the description ("`/remind list`"). */
  check: string;
}

/**
 * The error reply for a failure AFTER a command stored something. It says the
 * work was done and where to check, and gives no retry advice: running the
 * command again would create the same thing twice. Never throws; when the
 * confirmation itself failed this reply may fail for the same reason, which is
 * logged by `safeReply` and returned as `false`.
 */
export function replyAfterWriteError(
  interaction: RepliableInteraction,
  { done, check }: WriteDone,
  options: ReplyWithErrorOptions = {},
): Promise<boolean> {
  return replyWithError(interaction, {
    title: done,
    next: `I couldn't finish the confirmation here. Check ${check} before doing this again; the details are in the bot's log.`,
    ...options,
  });
}

/**
 * Run the steps of a command that come after its write (the confirmation, a
 * follow-up read). A failure is logged and answered with
 * {@link replyAfterWriteError}; it never reaches the command's catch-all, whose
 * generic "try again" would repeat the write. Never throws.
 */
export async function afterWrite(
  interaction: RepliableInteraction,
  info: WriteDone,
  step: () => Promise<void>,
): Promise<void> {
  try {
    await step();
  } catch (error) {
    logger.error(
      `A step after "${info.done}" failed for interaction ${interaction.id}: ${describeDiscordError(error)}`,
      { stack: error instanceof Error ? error.stack : undefined },
    );
    await replyAfterWriteError(interaction, info);
  }
}
