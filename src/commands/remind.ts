import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { isValidObjectId } from "mongoose";
import { ConfigService } from "../services/config-service.js";
import {
  ReminderService,
  checkRemindAt,
  discordTimestamp,
} from "../services/reminder-service.js";
import { UserNotificationPrefsService } from "../services/user-notification-prefs-service.js";
import { parseDuration } from "../utils/time.js";
import { parseZonedDateTime, resolveTimezone } from "../utils/timezone.js";
import {
  clampToLimit,
  DISCORD_EMBED_DESCRIPTION_LIMIT,
  truncateText,
} from "../utils/discord-limits.js";
import logger from "../utils/logger.js";
import { safeReply } from "../utils/safe-reply.js";

/**
 * `/remind` — personal, one-off reminders (#866).
 *
 * Member self-service, not admin configuration, so it belongs in Discord
 * rather than the Web UI (see the admin-surface split in CLAUDE.md). Every
 * reply is ephemeral: a reminder is nobody's business but the member's.
 *
 * A member can say *when* in one of two ways, and the two are mutually
 * exclusive. Discord cannot express "exactly one of these options", so the
 * exclusivity is enforced at runtime.
 */

/** Message cap. Comfortably inside Discord's limits once decorated. */
const MAX_MESSAGE_LENGTH = 500;

/** How much of a reminder's text `/remind list` shows per row. */
const MAX_LIST_MESSAGE_LENGTH = 120;

const EMBED_COLOR = 0x5865f2;

export const data = new SlashCommandBuilder()
  .setName("remind")
  .setDescription("Set a personal reminder that KoolBot DMs back to you")
  .addSubcommand((sub) =>
    sub
      .setName("set")
      .setDescription("Schedule a reminder for yourself")
      .addStringOption((o) =>
        o
          .setName("message")
          .setDescription("What should I remind you about?")
          .setRequired(true)
          .setMaxLength(MAX_MESSAGE_LENGTH),
      )
      .addStringOption((o) =>
        o
          .setName("in")
          .setDescription("Time from now, e.g. 30m, 2h, 3d, 1w, 1h30m"),
      )
      .addStringOption((o) =>
        o
          .setName("date")
          .setDescription("Calendar date (YYYY-MM-DD) — use with time:"),
      )
      .addStringOption((o) =>
        o
          .setName("time")
          .setDescription("24h time (HH:MM) in your timezone — use with date:"),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName("list").setDescription("Show your pending reminders"),
  )
  .addSubcommand((sub) =>
    sub
      .setName("cancel")
      .setDescription("Cancel one of your pending reminders")
      .addStringOption((o) =>
        o
          .setName("id")
          .setDescription("Reminder ID (from /remind list)")
          .setRequired(true),
      ),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  // Acknowledge before any config or DB read so a slow lookup cannot miss
  // Discord's 3-second ACK window (`10062 Unknown interaction`, #842).
  await interaction.deferReply({ ephemeral: true });

  try {
    const config = ConfigService.getInstance();
    const enabled = await config.getBoolean("reminders.enabled", false);
    if (!enabled) {
      await interaction.editReply(
        "The reminders feature is currently disabled.",
      );
      return;
    }

    if (!interaction.guildId) {
      await interaction.editReply("This command must be run inside a guild.");
      return;
    }

    const sub = interaction.options.getSubcommand();
    if (sub === "set") {
      await handleSet(interaction);
    } else if (sub === "list") {
      await handleList(interaction);
    } else if (sub === "cancel") {
      await handleCancel(interaction);
    } else {
      await interaction.editReply("Unknown subcommand.");
    }
  } catch (error) {
    logger.error("Error in remind command:", error);
    await safeReply(interaction, {
      content: "There was an error while executing this command!",
    });
  }
}

/**
 * Resolve the instant a `/remind set` invocation refers to, or the reason it
 * can't be resolved. Exported-shaped as a plain result so the handler stays
 * a straight line of guards.
 */
interface ResolvedWhen {
  remindAt: Date;
  /** Zone the wall-clock input was read in; empty for a relative `in:`. */
  timezone: string;
}

async function handleSet(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guildId = interaction.guildId as string;
  const message = interaction.options.getString("message", true).trim();
  const inRaw = interaction.options.getString("in");
  const dateRaw = interaction.options.getString("date");
  const timeRaw = interaction.options.getString("time");

  if (message.length === 0) {
    await interaction.editReply("Your reminder needs some text.");
    return;
  }

  const hasRelative = Boolean(inRaw);
  const hasAbsolute = Boolean(dateRaw || timeRaw);

  if (hasRelative && hasAbsolute) {
    await interaction.editReply(
      "Pick one way to say when: either `in:` **or** `date:` + `time:`, not both.",
    );
    return;
  }
  if (!hasRelative && !hasAbsolute) {
    await interaction.editReply(
      "Tell me when: `in:2h` for a relative time, or `date:2026-09-01 time:18:00` for a specific one.",
    );
    return;
  }

  const now = new Date();
  let when: ResolvedWhen;

  if (hasRelative) {
    const durationMs = parseDuration(inRaw as string);
    if (durationMs === null) {
      await interaction.editReply(
        "I couldn't read that duration. Use a number and a unit — `30m`, `2h`, `3d`, `1w`, or a combination like `1h30m`.",
      );
      return;
    }
    when = { remindAt: new Date(now.getTime() + durationMs), timezone: "" };
  } else {
    if (!dateRaw || !timeRaw) {
      await interaction.editReply(
        "`date:` and `time:` go together — give both, or use `in:` instead.",
      );
      return;
    }
    // The member's own zone from /me/timezone; the server zone when unset.
    // No per-command timezone option on purpose: the confirmation renders a
    // Discord timestamp in the reader's real local time, so a wrong zone is
    // visible immediately and fixed once, on /me/timezone, rather than
    // re-typed on every reminder.
    const prefs = UserNotificationPrefsService.getInstance();
    const stored = await prefs.getTimezone(interaction.user.id, guildId);
    const zone = resolveTimezone(stored);
    const parsed = parseZonedDateTime(dateRaw, timeRaw, zone);
    if (!parsed) {
      await interaction.editReply(
        `That date and time didn't parse. Use \`date:YYYY-MM-DD\` and \`time:HH:MM\` (24-hour), e.g. \`date:2026-09-01 time:18:00\`. Times are read in **${zone}**.`,
      );
      return;
    }
    when = { remindAt: parsed, timezone: zone };
  }

  const issue = checkRemindAt(when.remindAt, now);
  if (issue === "past") {
    await interaction.editReply(
      "That time has already passed. Pick a time in the future.",
    );
    return;
  }
  if (issue === "too-far") {
    await interaction.editReply(
      "That's more than a year away — pick something sooner.",
    );
    return;
  }

  const service = ReminderService.getInstance(interaction.client);
  const result = await service.createReminder({
    userId: interaction.user.id,
    guildId,
    channelId: interaction.channelId ?? "",
    message,
    remindAt: when.remindAt,
    timezone: when.timezone,
  });

  if (!result.ok) {
    await interaction.editReply(
      `You already have ${result.limit} pending reminders. Cancel one with \`/remind cancel\` before adding another.`,
    );
    return;
  }

  const zoneNote = when.timezone ? ` (read in ${when.timezone})` : "";
  await interaction.editReply(
    [
      `⏰ Reminder set for ${discordTimestamp(when.remindAt)} — ${discordTimestamp(when.remindAt, "R")}${zoneNote}.`,
      "I'll DM you, and post here instead if your DMs are closed.",
      `Cancel it with \`/remind cancel id:${result.reminder._id}\`.`,
    ].join("\n"),
  );
}

async function handleList(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const service = ReminderService.getInstance(interaction.client);
  const pending = await service.listPending(
    interaction.user.id,
    interaction.guildId as string,
  );

  if (pending.length === 0) {
    await interaction.editReply(
      "You have no pending reminders. Set one with `/remind set`.",
    );
    return;
  }

  const rows = pending.map((reminder) => {
    const text = truncateText(reminder.message, MAX_LIST_MESSAGE_LENGTH);
    return [
      `${discordTimestamp(reminder.remindAt)} — ${discordTimestamp(reminder.remindAt, "R")}`,
      `> ${text}`,
      `\`${reminder._id}\``,
    ].join("\n");
  });

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle("⏰ Your pending reminders")
    .setDescription(
      clampToLimit(rows, DISCORD_EMBED_DESCRIPTION_LIMIT, {
        separator: "\n\n",
        overflowLabel: (dropped) => `…and ${dropped} more`,
      }),
    )
    .setFooter({ text: "Cancel one with /remind cancel id:<id>" });

  await interaction.editReply({ embeds: [embed] });
}

async function handleCancel(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const id = interaction.options.getString("id", true).trim();

  // Guard before the query: Mongoose throws a CastError on a malformed id,
  // which would surface as the generic error reply instead of a useful one.
  if (!isValidObjectId(id)) {
    await interaction.editReply(
      "That doesn't look like a reminder ID. Copy one from `/remind list`.",
    );
    return;
  }

  const service = ReminderService.getInstance(interaction.client);
  const cancelled = await service.cancelReminder(
    id,
    interaction.user.id,
    interaction.guildId as string,
  );

  await interaction.editReply(
    cancelled
      ? "🗑️ Reminder cancelled."
      : "No pending reminder of yours has that ID. Check `/remind list`.",
  );
}
