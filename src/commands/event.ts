import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  GuildMember,
  MessageFlags,
} from "discord.js";
import type { EventRecurrence } from "../models/event.js";
import { ConfigService } from "../services/config-service.js";
import {
  EventService,
  parseEventDateTime,
  formatEventWhen,
  countRsvps,
  isRecurring,
  recurrenceLabel,
  RecurrenceDisabledError,
} from "../services/event-service.js";
import { isValidTimezone, resolveTimezone } from "../utils/timezone.js";
import logger from "../utils/logger.js";
import { safeReply } from "../utils/safe-reply.js";

export const data = new SlashCommandBuilder()
  .setName("event")
  .setDescription("Schedule and manage server events")
  // No command-wide permission default: `/event list` is open to everyone,
  // while create/cancel/start enforce an Administrator check at runtime
  // (setDefaultMemberPermissions would hide the whole command, list included).
  .addSubcommand((sub) =>
    sub
      .setName("create")
      .setDescription("Schedule a new event with a temporary voice channel")
      .addStringOption((o) =>
        o
          .setName("title")
          .setDescription("Event title")
          .setRequired(true)
          .setMaxLength(100),
      )
      .addStringOption((o) =>
        o
          .setName("date")
          .setDescription("Start date (YYYY-MM-DD)")
          .setRequired(true),
      )
      .addStringOption((o) =>
        o
          .setName("time")
          .setDescription("Start time (24h HH:MM)")
          .setRequired(true),
      )
      .addStringOption((o) =>
        o
          .setName("description")
          .setDescription("What's the event about?")
          .setMaxLength(1000),
      )
      .addIntegerOption((o) =>
        o
          .setName("duration")
          .setDescription("Duration in minutes")
          .setMinValue(1)
          .setMaxValue(1440),
      )
      .addStringOption((o) =>
        o
          .setName("timezone")
          .setDescription("IANA timezone (e.g. Europe/London)"),
      )
      .addStringOption((o) =>
        o
          .setName("repeat")
          .setDescription("Repeat at the same time (default: one-off)")
          .addChoices(
            { name: "Weekly", value: "weekly" },
            { name: "Every 2 weeks", value: "biweekly" },
            { name: "Monthly", value: "monthly" },
          ),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName("list").setDescription("List upcoming and recent events"),
  )
  .addSubcommand((sub) =>
    sub
      .setName("cancel")
      .setDescription("Cancel an event and remove its channel")
      .addStringOption((o) =>
        o
          .setName("id")
          .setDescription("Event ID (from /event list)")
          .setRequired(true),
      )
      .addStringOption((o) =>
        o
          .setName("scope")
          .setDescription("Recurring events: just this date, or the series")
          .addChoices(
            { name: "This occurrence only", value: "occurrence" },
            { name: "The whole series", value: "series" },
          ),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("start")
      .setDescription("Spin up an event's voice channel now")
      .addStringOption((o) =>
        o
          .setName("id")
          .setDescription("Event ID (from /event list)")
          .setRequired(true),
      ),
  );

function isAdmin(interaction: ChatInputCommandInteraction): boolean {
  const member = interaction.member;
  if (!member) return false;
  // Cached members are `GuildMember`; non-cached interactions surface an
  // `APIInteractionGuildMember` whose `permissions` field is a string
  // bitfield. Mirror the gating used by /config and /quote so real admins
  // aren't blocked on the uncached path.
  if (member instanceof GuildMember) {
    return member.permissions.has(PermissionFlagsBits.Administrator);
  }
  const raw = (member as { permissions?: unknown }).permissions;
  if (typeof raw !== "string") return false;
  try {
    return (
      (BigInt(raw) & PermissionFlagsBits.Administrator) ===
      PermissionFlagsBits.Administrator
    );
  } catch {
    return false;
  }
}

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const config = ConfigService.getInstance();
  const enabled = await config.getBoolean("events.enabled", false);
  if (!enabled) {
    await interaction.reply({
      content: "The events feature is currently disabled.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!interaction.guildId) {
    await interaction.reply({
      content: "This command must be run inside a guild.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const sub = interaction.options.getSubcommand();
  try {
    if (sub === "list") {
      await handleList(interaction);
      return;
    }

    // create / cancel / start are admin-only.
    if (!isAdmin(interaction)) {
      await interaction.reply({
        content: "❌ Only administrators can manage events.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "create") await handleCreate(interaction, config);
    else if (sub === "cancel") await handleCancel(interaction);
    else if (sub === "start") await handleStart(interaction);
  } catch (error) {
    logger.error(`Error in /event ${sub}:`, error);
    await safeReply(interaction, {
      content: "❌ There was an error running this command.",
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function handleCreate(
  interaction: ChatInputCommandInteraction,
  config: ConfigService,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const title = interaction.options.getString("title", true).trim();
  const date = interaction.options.getString("date", true).trim();
  const time = interaction.options.getString("time", true).trim();
  const description =
    interaction.options.getString("description")?.trim() ?? "";
  const durationOpt = interaction.options.getInteger("duration");
  const tzOpt = interaction.options.getString("timezone")?.trim();
  const repeat = (interaction.options.getString("repeat") ??
    "none") as EventRecurrence;

  const configuredTz = await config.getString("events.timezone", "");
  const timezone = tzOpt || configuredTz;
  if (tzOpt && !isValidTimezone(tzOpt)) {
    await interaction.editReply(
      `❌ "${tzOpt}" is not a recognised IANA timezone.`,
    );
    return;
  }

  const startTime = parseEventDateTime(date, time, timezone);
  if (!startTime) {
    await interaction.editReply(
      "❌ Invalid date/time. Use date `YYYY-MM-DD` and time `HH:MM` (24-hour).",
    );
    return;
  }
  if (startTime.getTime() <= Date.now()) {
    await interaction.editReply(
      "❌ The event start time must be in the future.",
    );
    return;
  }

  const defaultDuration = await config.getNumber(
    "events.default_duration_minutes",
    120,
  );
  const durationMinutes = durationOpt ?? defaultDuration;

  const service = EventService.getInstance(interaction.client);
  let event;
  try {
    event = await service.createEvent({
      guildId: interaction.guildId as string,
      title,
      description,
      startTime,
      timezone: resolveTimezone(timezone),
      durationMinutes,
      recurrence: repeat,
      createdBy: interaction.user.id,
    });
  } catch (error) {
    if (error instanceof RecurrenceDisabledError) {
      await interaction.editReply(
        "❌ Recurring events are turned off (`events.recurrence_enabled`).",
      );
      return;
    }
    throw error;
  }

  const repeats =
    repeat !== "none" ? ` · repeats ${recurrenceLabel(repeat)}` : "";
  await interaction.editReply(
    `✅ Created event **${title}** for ${formatEventWhen(event)}.\n` +
      `ID: \`${event._id}\` · duration: ${durationMinutes} min${repeats}`,
  );
}

async function handleList(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const service = EventService.getInstance(interaction.client);
  const events = await service.listEvents(interaction.guildId as string);

  const upcoming = events.filter(
    (e) => e.state === "scheduled" || e.state === "active",
  );
  if (upcoming.length === 0) {
    await interaction.editReply(
      "No upcoming events. Create one with `/event create`.",
    );
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle("📅 Upcoming events")
    .setColor(0x5865f2);

  for (const e of upcoming.slice(0, 15)) {
    const counts = countRsvps(e.rsvps);
    embed.addFields({
      name: e.title,
      value:
        `${formatEventWhen(e)} · ${e.state}` +
        (isRecurring(e) ? ` · 🔁 ${recurrenceLabel(e.recurrence)}` : "") +
        "\n" +
        `✅ ${counts.going} · 🤔 ${counts.maybe} · 🚫 ${counts.cant}\n` +
        `ID: \`${e._id}\``,
      inline: false,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

async function handleCancel(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const id = interaction.options.getString("id", true).trim();
  const scope = interaction.options.getString("scope") ?? "occurrence";
  const service = EventService.getInstance(interaction.client);

  if (scope === "series") {
    const result = await service.cancelSeries(
      id,
      interaction.guildId as string,
    );
    if (!result) {
      await interaction.editReply(`❌ Event \`${id}\` not found.`);
      return;
    }
    await interaction.editReply(
      isRecurring(result.event)
        ? `✅ Cancelled the **${result.event.title}** series (${result.cancelled} upcoming occurrence(s)).`
        : `✅ Cancelled **${result.event.title}**.`,
    );
    return;
  }

  const event = await service.cancelEvent(id, interaction.guildId as string);
  if (!event) {
    await interaction.editReply(`❌ Event \`${id}\` not found.`);
    return;
  }
  await interaction.editReply(
    isRecurring(event)
      ? `✅ Cancelled this occurrence of **${event.title}**; the series continues. Use \`scope:series\` to stop it.`
      : `✅ Cancelled **${event.title}**.`,
  );
}

async function handleStart(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const id = interaction.options.getString("id", true).trim();
  const service = EventService.getInstance(interaction.client);
  const event = await service.startEventNow(id, interaction.guildId as string);
  if (!event) {
    await interaction.editReply(
      `❌ Could not start event \`${id}\` (not found, or already ended/cancelled).`,
    );
    return;
  }
  const where = event.channelId ? ` Channel: <#${event.channelId}>` : "";
  await interaction.editReply(`✅ Started **${event.title}**.${where}`);
}
