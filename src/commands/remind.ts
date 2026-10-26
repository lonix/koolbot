import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
} from "discord.js";
import { isValidObjectId } from "mongoose";
import { ConfigService } from "../services/config-service.js";
import {
  ReminderService,
  checkRemindAt,
} from "../services/reminder-service.js";
import { discordTimestamp } from "../utils/discord-time.js";
import { UserNotificationPrefsService } from "../services/user-notification-prefs-service.js";
import { parseDuration } from "../utils/time.js";
import { parseZonedDateTime, resolveTimezone } from "../utils/timezone.js";
import {
  clampToLimit,
  DISCORD_EMBED_DESCRIPTION_LIMIT,
  truncateText,
} from "../utils/discord-limits.js";
import logger from "../utils/logger.js";
import {
  afterWrite,
  replyWithError,
  replyWithUnexpectedError,
} from "../utils/error-reply.js";
import { embedColor } from "../utils/embed-style.js";

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
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const config = ConfigService.getInstance();
    const enabled = await config.getBoolean("reminders.enabled", false);
    if (!enabled) {
      await replyWithError(interaction, {
        title: "Reminders are off",
        next: "Ask an admin to turn them on in the Web UI.",
      });
      return;
    }

    if (!interaction.guildId) {
      await replyWithError(interaction, {
        title: "Can't use this here",
        next: "Run this command in a server.",
      });
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
      await replyWithError(interaction, {
        title: "Couldn't run that",
        next: "I don't know that subcommand. Pick `set`, `list` or `cancel`.",
      });
    }
  } catch (error) {
    logger.error("Error in remind command:", error);
    await replyWithUnexpectedError(interaction);
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
    await replyWithError(interaction, {
      title: "Couldn't set your reminder",
      next: "Add some text for the reminder, then try again.",
    });
    return;
  }

  // `channelId` is nullable on the interaction type. A guild slash command
  // always carries one in practice, but storing an empty fallback target
  // would create a reminder whose channel fallback silently drops it — the
  // one delivery path we promise when DMs are closed. Refuse instead of
  // storing something undeliverable.
  if (!interaction.channelId) {
    await replyWithError(interaction, {
      title: "Couldn't set your reminder",
      next: "I couldn't tell which channel this is, so I'd have nowhere to post if your DMs are closed. Try again from a normal text channel.",
    });
    return;
  }

  const hasRelative = Boolean(inRaw);
  const hasAbsolute = Boolean(dateRaw || timeRaw);

  if (hasRelative && hasAbsolute) {
    await replyWithError(interaction, {
      title: "Couldn't set your reminder",
      next: "Pick one way to say when: either `in:` **or** `date:` + `time:`, not both.",
    });
    return;
  }
  if (!hasRelative && !hasAbsolute) {
    await replyWithError(interaction, {
      title: "Couldn't set your reminder",
      next: "Tell me when: `in:2h` for a relative time, or `date:YYYY-MM-DD time:HH:MM` for a specific one.",
    });
    return;
  }

  const now = new Date();
  let when: ResolvedWhen;

  if (hasRelative) {
    const durationMs = parseDuration(inRaw as string);
    if (durationMs === null) {
      await replyWithError(interaction, {
        title: "Couldn't read that duration",
        next: "Use a number and a unit — `30m`, `2h`, `3d`, `1w`, or a combination like `1h30m`.",
      });
      return;
    }
    when = { remindAt: new Date(now.getTime() + durationMs), timezone: "" };
  } else {
    if (!dateRaw || !timeRaw) {
      await replyWithError(interaction, {
        title: "Couldn't set your reminder",
        next: "`date:` and `time:` go together — give both, or use `in:` instead.",
      });
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
      await replyWithError(interaction, {
        title: "Couldn't read that date and time",
        next: `Use \`date:YYYY-MM-DD\` and \`time:HH:MM\` (24-hour) — a four-digit year, then month and day. Times are read in **${zone}**.`,
      });
      return;
    }
    when = { remindAt: parsed, timezone: zone };
  }

  const issue = checkRemindAt(when.remindAt, now);
  if (issue === "past") {
    await replyWithError(interaction, {
      title: "That time has already passed",
      next: "Pick a time in the future.",
    });
    return;
  }
  if (issue === "too-far") {
    await replyWithError(interaction, {
      title: "That time is too far away",
      next: "That's more than a year away — pick something sooner.",
    });
    return;
  }

  const service = ReminderService.getInstance(interaction.client);
  const result = await service.createReminder({
    userId: interaction.user.id,
    guildId,
    channelId: interaction.channelId,
    message,
    remindAt: when.remindAt,
    timezone: when.timezone,
  });

  if (!result.ok) {
    await replyWithError(interaction, {
      title: "Couldn't set your reminder",
      next: `You already have ${result.limit} pending reminders. Cancel one with \`/remind cancel\` before adding another.`,
    });
    return;
  }

  // The reminder is stored: a failing confirmation must not tell the member
  // to try again, which would set a second one.
  await afterWrite(
    interaction,
    { done: "Your reminder was saved", check: "`/remind list`" },
    async () => {
      const zoneNote = when.timezone ? ` (read in ${when.timezone})` : "";
      await interaction.editReply(
        [
          `⏰ Reminder set for ${discordTimestamp(when.remindAt)} — ${discordTimestamp(when.remindAt, "R")}${zoneNote}.`,
          "I'll DM you. If your DMs are closed I'll try to post here instead.",
          `Cancel it with \`/remind cancel id:${result.reminder._id}\`.`,
        ].join("\n"),
      );
    },
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
    .setColor(embedColor("warn"))
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
    await replyWithError(interaction, {
      title: "That isn't a reminder ID",
      next: "Copy one from `/remind list`, then try again.",
    });
    return;
  }

  const service = ReminderService.getInstance(interaction.client);
  const cancelled = await service.cancelReminder(
    id,
    interaction.user.id,
    interaction.guildId as string,
  );

  if (!cancelled) {
    await replyWithError(interaction, {
      title: "Couldn't find that reminder",
      next: "No pending reminder of yours has that ID. Check `/remind list`.",
    });
    return;
  }
  await afterWrite(
    interaction,
    { done: "Your reminder was cancelled", check: "`/remind list`" },
    async () => {
      await interaction.editReply("🗑️ Reminder cancelled.");
    },
  );
}
