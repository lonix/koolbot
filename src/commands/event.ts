import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  GuildMember,
} from "discord.js";
import { ConfigService } from "../services/config-service.js";
import {
  EventService,
  parseEventDateTime,
  formatEventWhen,
  countRsvps,
} from "../services/event-service.js";
import { isValidTimezone, resolveTimezone } from "../utils/timezone.js";
import logger from "../utils/logger.js";

export const data = new SlashCommandBuilder()
  .setName("event")
  .setDescription("Schedule and manage server events")
  // Admin-gated by default; /event list is still reachable via the shared
  // command but the mutating subcommands re-check below.
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
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
  if (!member || !("permissions" in member)) return false;
  const perms = (member as GuildMember).permissions;
  return (
    typeof perms === "object" && perms.has(PermissionFlagsBits.Administrator)
  );
}

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const config = ConfigService.getInstance();
  const enabled = await config.getBoolean("events.enabled", false);
  if (!enabled) {
    await interaction.reply({
      content: "The events feature is currently disabled.",
      ephemeral: true,
    });
    return;
  }
  if (!interaction.guildId) {
    await interaction.reply({
      content: "This command must be run inside a guild.",
      ephemeral: true,
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
        ephemeral: true,
      });
      return;
    }

    if (sub === "create") await handleCreate(interaction, config);
    else if (sub === "cancel") await handleCancel(interaction);
    else if (sub === "start") await handleStart(interaction);
  } catch (error) {
    logger.error(`Error in /event ${sub}:`, error);
    const msg = "❌ There was an error running this command.";
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: msg, ephemeral: true });
    } else {
      await interaction.reply({ content: msg, ephemeral: true });
    }
  }
}

async function handleCreate(
  interaction: ChatInputCommandInteraction,
  config: ConfigService,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const title = interaction.options.getString("title", true).trim();
  const date = interaction.options.getString("date", true).trim();
  const time = interaction.options.getString("time", true).trim();
  const description =
    interaction.options.getString("description")?.trim() ?? "";
  const durationOpt = interaction.options.getInteger("duration");
  const tzOpt = interaction.options.getString("timezone")?.trim();

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
  const event = await service.createEvent({
    guildId: interaction.guildId as string,
    title,
    description,
    startTime,
    timezone: resolveTimezone(timezone),
    durationMinutes,
    createdBy: interaction.user.id,
  });

  await interaction.editReply(
    `✅ Created event **${title}** for ${formatEventWhen(event)}.\n` +
      `ID: \`${event._id}\` · duration: ${durationMinutes} min`,
  );
}

async function handleList(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
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
        `${formatEventWhen(e)} · ${e.state}\n` +
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
  await interaction.deferReply({ ephemeral: true });
  const id = interaction.options.getString("id", true).trim();
  const service = EventService.getInstance(interaction.client);
  const event = await service.cancelEvent(id, interaction.guildId as string);
  if (!event) {
    await interaction.editReply(`❌ Event \`${id}\` not found.`);
    return;
  }
  await interaction.editReply(`✅ Cancelled **${event.title}**.`);
}

async function handleStart(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
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
