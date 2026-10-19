/**
 * The leader customiser's button and modal (#1196), in each team channel's chat.
 *
 * - The button (`evcust:btn:<eventId>:<groupKey>`) opens a modal with the team's
 *   name (and its tag, while the event uses clan tags).
 * - The modal (`evcust:modal:<eventId>:<groupKey>`) stores the change through
 *   `customiseGroup`, which decides again from a fresh read.
 *
 * ## Rules
 *
 * - **Only the id's two fields are read from the custom id**, by one anchored
 *   pattern. The event, the group, the guild, the channel and the person are
 *   all checked against a fresh read and the interaction.
 * - **The button's check is a courtesy, the submit's is the rule.** Whoever the
 *   button lets through is checked again at submit, after a deferral, inside the
 *   writer: a leader removed, a switch turned off or the event ended while the
 *   modal was open is refused there.
 * - **The one exception to "defer before the first database read" (#842).** A
 *   modal can only be shown as the FIRST response, never after a deferral, so
 *   the button reads the event before it answers. That read is raced against
 *   `BUTTON_READ_DEADLINE_MS` (well under Discord's 3 seconds); a slow or failed
 *   read answers "try again" instead of letting the interaction die. The modal
 *   submit defers first, as every other handler does.
 * - **Plain text out.** Every reply is ephemeral, carries no mentions
 *   (`allowedMentions` none), and shows member-supplied names escaped.
 */

import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import logger from "../utils/logger.js";
import { safeReply } from "../utils/safe-reply.js";
import { NO_MENTIONS } from "../utils/allowed-mentions.js";
import {
  customiseCustomId,
  customiseRefusal,
  parseCustomiseCustomId,
  refusalMessage,
} from "../services/event-customise-rules.js";
import {
  auditLeaderEdit,
  createCustomiseDeps,
  customiseGroup,
  readCustomiseRow,
  readEventsEnabled,
  type CustomiseDeps,
} from "../services/event-leader-customise.js";
import { GROUP_NAME_MAX, GROUP_TAG_MAX } from "../services/event-groups.js";

/** How long the button waits for its read before answering "try again". */
export const BUTTON_READ_DEADLINE_MS = 2000;

const NAME_FIELD = "name";
const TAG_FIELD = "tag";

const INVALID = "This button is not valid any more.";
const TRY_AGAIN =
  "I could not check that right now, so nothing was opened. Press the button again in a moment.";

/** Resolves to the value, or rejects when it does not arrive in time. */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("deadline")), ms);
    timer.unref?.();
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function say(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  content: string,
): Promise<void> {
  await safeReply(interaction, {
    content,
    flags: MessageFlags.Ephemeral,
    allowedMentions: NO_MENTIONS,
  });
}

export async function handleCustomiseButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const parsed = parseCustomiseCustomId(interaction.customId);
  if (!parsed || parsed.kind !== "btn" || !interaction.guildId) {
    await say(interaction, INVALID);
    return;
  }
  const { eventId, groupKey } = parsed;
  const guildId = interaction.guildId;
  const actorId = interaction.user.id;

  let eventsEnabled: boolean | null;
  let row: Awaited<ReturnType<typeof readCustomiseRow>>;
  try {
    [eventsEnabled, row] = await withDeadline(
      Promise.all([readEventsEnabled(), readCustomiseRow(guildId, eventId)]),
      BUTTON_READ_DEADLINE_MS,
    );
  } catch (err) {
    logger.warn("Customise button could not read the event in time:", err);
    await say(interaction, TRY_AGAIN);
    return;
  }

  const refusal = customiseRefusal({
    event: row,
    eventsEnabled,
    groupKey,
    actorId,
    channelId: interaction.channelId,
  });
  if (refusal || !row) {
    await say(
      interaction,
      refusalMessage(refusal ?? "not-found", row?.leaderLabel),
    );
    return;
  }
  const group = (row.groups ?? []).find((g) => g.key === groupKey);
  if (!group) {
    await say(interaction, refusalMessage("no-group", row.leaderLabel));
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(customiseCustomId("modal", eventId, groupKey))
    .setTitle("Customise your team");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId(NAME_FIELD)
        .setLabel("Team name")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(GROUP_NAME_MAX)
        .setValue(group.name),
    ),
  );
  // The tag only means something while the event puts tags on nicknames.
  if (row.tagsEnabled === true) {
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(TAG_FIELD)
          .setLabel("Clan tag (empty for none)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(GROUP_TAG_MAX)
          .setValue(group.tag ?? ""),
      ),
    );
  }
  try {
    await interaction.showModal(modal);
  } catch (err) {
    // The 3 seconds ran out (10062) or the interaction is gone: nothing to do.
    logger.warn("Customise modal could not be shown:", err);
  }
}

function fieldValue(
  interaction: ModalSubmitInteraction,
  id: string,
): string | null {
  try {
    return interaction.fields.getTextInputValue(id);
  } catch {
    return null;
  }
}

export async function handleCustomiseModal(
  interaction: ModalSubmitInteraction,
  deps?: CustomiseDeps,
): Promise<void> {
  const parsed = parseCustomiseCustomId(interaction.customId);
  // Acknowledge before any slow work (#842): everything below reads the database.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!parsed || parsed.kind !== "modal" || !interaction.guildId) {
    await say(interaction, INVALID);
    return;
  }
  const { eventId, groupKey } = parsed;
  const guildId = interaction.guildId;
  const actorId = interaction.user.id;
  try {
    const result = await customiseGroup(
      {
        guildId,
        eventId,
        groupKey,
        actorId,
        channelId: interaction.channelId,
        rawName: fieldValue(interaction, NAME_FIELD),
        rawTag: fieldValue(interaction, TAG_FIELD),
      },
      deps ?? createCustomiseDeps(interaction.client),
    );
    if (result.ok && result.changed) {
      await auditLeaderEdit({
        guildId,
        eventId,
        actorId,
        groupKey,
        result,
      });
    }
    await say(
      interaction,
      result.ok ? result.lines.join("\n") : result.message,
    );
  } catch (err) {
    logger.error("Error handling the customise modal:", err);
    await say(
      interaction,
      "Something went wrong, so I cannot say whether it was saved. Look at the team's name and try again.",
    );
  }
}
