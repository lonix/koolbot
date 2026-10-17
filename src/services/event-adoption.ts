import {
  DiscordAPIError,
  GuildScheduledEventStatus,
  PermissionFlagsBits,
  type Client,
  type Guild,
} from "discord.js";
import { Event } from "../models/event.js";
import logger from "../utils/logger.js";
import { ConfigService } from "./config-service.js";
import { EventService } from "./event-service.js";
import type {
  AdoptionEventPort,
  AdoptionNativeEvent,
} from "./server-adoption-service.js";
import {
  computePlanId,
  type AdoptionPlan,
  type EventAdoptOp,
  type EventBaseline,
  type PlanIssue,
} from "./server-adoption-planner.js";
import {
  ServerScanService,
  type ScheduledEventInfo,
} from "./server-scan-service.js";

/**
 * Adopt existing Discord native scheduled events as KoolBot events (#1034).
 *
 * The native event stays the single source of truth for members (they mark
 * Interested on it) and is never edited, cancelled or deleted by an adoption or
 * by its rollback. Adopting creates one one-off KoolBot event row linked to it
 * by `nativeEventId`; the Events scan then posts the link announcement, sends
 * the reminder and, for an event with no channel of its own, creates the
 * temporary voice channel, like for any other event.
 *
 * Nothing here writes. `planEventAdoption` builds a plan the Web UI previews;
 * the adoption engine applies it (snapshotted, resumable) and rolls it back.
 */

/** Used when a native event has no end time. */
export const DEFAULT_ADOPTED_DURATION_MINUTES = 120;

const MS_PER_MINUTE = 60 * 1000;
const SCHEDULED = String(GuildScheduledEventStatus.Scheduled);
const DISCORD_UNKNOWN_SCHEDULED_EVENT = 10070;

export interface EventAdoptionContext {
  /** The Events feature is on (`events.enabled`). */
  eventsEnabled: boolean;
  botUserId: string;
  /** The bot may manage events other members created (Manage Events). */
  canManageEvents: boolean;
  /** Native event ids a KoolBot event is already linked to. */
  linkedNativeIds: ReadonlySet<string>;
  /** Open KoolBot events that have no native event yet (the sync will make one). */
  openUnlinked: ReadonlyArray<{ title: string; startTime: Date }>;
  now: Date;
}

export interface EventAdoptionCandidate {
  info: ScheduledEventInfo;
  adoptable: boolean;
  /** Why it can't be adopted; null when it can. */
  reason: string | null;
  /** What adopting it will do differently, shown in the preview. */
  notes: string[];
}

/** Pure: can this native event be adopted, and if not, why. */
export function classifyScheduledEvent(
  info: ScheduledEventInfo,
  ctx: EventAdoptionContext,
): EventAdoptionCandidate {
  const skip = (reason: string): EventAdoptionCandidate => ({
    info,
    adoptable: false,
    reason,
    notes: [],
  });
  if (ctx.linkedNativeIds.has(info.id)) {
    return skip("Already a KoolBot event.");
  }
  if (info.status !== SCHEDULED) {
    return skip(
      "Not waiting to start: it is running, finished or cancelled. Only scheduled events are adopted.",
    );
  }
  const starts = info.startsAt ? Date.parse(info.startsAt) : NaN;
  if (Number.isNaN(starts) || starts <= ctx.now.getTime()) {
    return skip("Its start time has passed.");
  }
  if (info.recurring) {
    return skip(
      "It repeats through a Discord recurrence rule. KoolBot runs repeats itself and does not map those rules, so this one is left to Discord.",
    );
  }
  if (info.creatorId !== null && info.creatorId === ctx.botUserId) {
    return skip(
      "Created by KoolBot itself: it is the Discord copy of a KoolBot event.",
    );
  }
  if (info.creatorIsBot === true) {
    return skip("Created by another bot, which manages it.");
  }
  const sameStart = ctx.openUnlinked.some(
    (e) =>
      e.title === info.name.slice(0, 100) && e.startTime.getTime() === starts,
  );
  if (sameStart) {
    return skip(
      "A KoolBot event with the same name and start time exists already; adopting this one would announce the event twice.",
    );
  }
  if (!ctx.canManageEvents) {
    return skip(
      "KoolBot needs the Manage Events permission to manage an event a member created. Grant it to the bot's role, then scan again.",
    );
  }
  const notes: string[] = [];
  if (info.channelId) {
    notes.push(
      "It happens in a Discord channel of its own, so KoolBot makes no temporary voice channel for it.",
    );
  }
  if (!info.endsAt) {
    notes.push(
      `It has no end time; KoolBot assumes ${DEFAULT_ADOPTED_DURATION_MINUTES / 60} hours.`,
    );
  }
  return { info, adoptable: true, reason: null, notes };
}

/** Pure: the plan for the chosen events. */
export function buildEventAdoptionPlan(input: {
  guildId: string;
  adminUserId: string;
  candidates: readonly EventAdoptionCandidate[];
  selectedIds: readonly string[];
  eventsEnabled: boolean;
  announcementConfigured: boolean;
}): AdoptionPlan {
  const errors: PlanIssue[] = [];
  const warnings: PlanIssue[] = [];
  const byId = new Map(input.candidates.map((c) => [c.info.id, c]));
  const ops: EventAdoptOp[] = [];
  const events: EventBaseline[] = [];

  const chosen = [...new Set(input.selectedIds)];
  for (const id of chosen) {
    const candidate = byId.get(id);
    if (!candidate) {
      warnings.push({
        code: "event-missing",
        message: `Event ${id} was not found on the server any more, so it was left out.`,
        targetId: id,
      });
      continue;
    }
    if (!candidate.adoptable) {
      warnings.push({
        code: "event-skipped",
        message:
          `"${candidate.info.name}" was left out. ${candidate.reason ?? ""}`.trim(),
        targetId: id,
      });
    }
  }
  const picked = chosen
    .map((id) => byId.get(id))
    .filter((c): c is EventAdoptionCandidate => !!c && c.adoptable)
    .sort(
      (a, b) =>
        Date.parse(a.info.startsAt ?? "") - Date.parse(b.info.startsAt ?? "") ||
        a.info.id.localeCompare(b.info.id),
    );

  for (const [index, c] of picked.entries()) {
    const info = c.info;
    const startsAt = info.startsAt as string;
    const minutes = info.endsAt
      ? Math.max(
          1,
          Math.ceil(
            (Date.parse(info.endsAt) - Date.parse(startsAt)) / MS_PER_MINUTE,
          ),
        )
      : DEFAULT_ADOPTED_DURATION_MINUTES;
    ops.push({
      id: `op-${index + 1}`,
      type: "event.adopt",
      class: "additive",
      summary: `Adopt the Discord event "${info.name}" as a KoolBot event`,
      targetId: info.id,
      before: null,
      after: {
        "KoolBot event": info.name.slice(0, 100),
        starts: startsAt,
        ends: info.endsAt ?? "not set",
        "Discord event": "kept as it is; members keep using Interested",
        announcement: "link post in the announcement channel",
        "temporary voice channel": info.channelId
          ? "none (the event has its own channel)"
          : "created shortly before the start",
      },
      nativeEventId: info.id,
      name: info.name,
      description: info.description,
      startsAt,
      endsAt: info.endsAt,
      durationMinutes: minutes,
      hasChannel: !!info.channelId,
    });
    events.push({
      id: info.id,
      name: info.name,
      description: info.description,
      startsAt: info.startsAt,
      endsAt: info.endsAt,
      status: info.status,
    });
  }

  if (ops.length > 0) {
    if (!input.eventsEnabled) {
      errors.push({
        code: "events-disabled",
        message:
          "The Events feature is off. Turn on events.enabled in Settings first: adopted events are run by it.",
      });
    }
    if (!input.announcementConfigured) {
      warnings.push({
        code: "no-announcement-channel",
        message:
          "No announcement channel is set (events.announcement_channel_id), so adopted events get no announcement post or reminder.",
      });
    }
  }

  const operations = ops;
  const baseline: AdoptionPlan["baseline"] = {
    absentRoleNames: [],
    roles: [],
    channels: [],
    config: {},
    // Left out when empty so a plan without events keeps its usual id.
    ...(events.length > 0 ? { events } : {}),
  };
  const core = {
    guildId: input.guildId,
    plannedBy: input.adminUserId,
    operations,
    baseline,
    errors,
  };
  return { id: computePlanId(core), ...core, warnings };
}

export function eventPlanIsApplicable(p: EventAdoptionPlan): boolean {
  return p.plan.errors.length === 0 && p.plan.operations.length > 0;
}

export interface EventAdoptionPlan {
  plan: AdoptionPlan;
  candidates: EventAdoptionCandidate[];
  selectedIds: string[];
  eventsEnabled: boolean;
  announcementConfigured: boolean;
  canManageEvents: boolean;
}

async function loadContext(
  guild: Guild,
  botUserId: string,
): Promise<EventAdoptionContext & { announcementConfigured: boolean }> {
  const config = ConfigService.getInstance();
  const [eventsEnabled, channelId] = await Promise.all([
    config.getBoolean("events.enabled", false),
    config.getString("events.announcement_channel_id", ""),
  ]);
  const me =
    guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  const linked = (await Event.distinct("nativeEventId", {
    guildId: guild.id,
    nativeEventId: { $type: "string" },
  })) as string[];
  const open = await Event.find({
    guildId: guild.id,
    state: { $in: ["scheduled", "active"] },
    nativeEventId: null,
    nativeDetached: { $ne: true },
  })
    .select("title startTime")
    .lean();
  return {
    eventsEnabled,
    botUserId,
    canManageEvents: !!me?.permissions.has(PermissionFlagsBits.ManageEvents),
    linkedNativeIds: new Set(linked),
    openUnlinked: open.map((e) => ({
      title: e.title,
      startTime: e.startTime,
    })),
    now: new Date(),
    announcementConfigured: !!channelId.trim(),
  };
}

/** Scan the server's native events and plan adopting the chosen ones. Read-only. */
export async function planEventAdoption(
  guild: Guild,
  adminUserId: string,
  selectedIds: readonly string[],
): Promise<EventAdoptionPlan> {
  const scan = await ServerScanService.getInstance(guild.client).scanGuild(
    guild,
    { adminUserId },
  );
  const ctx = await loadContext(guild, scan.scanned.botUserId);
  const candidates = scan.scheduledEvents
    .map((e) => classifyScheduledEvent(e, ctx))
    .sort(
      (a, b) =>
        Date.parse(a.info.startsAt ?? "") - Date.parse(b.info.startsAt ?? "") ||
        a.info.id.localeCompare(b.info.id),
    );
  const plan = buildEventAdoptionPlan({
    guildId: guild.id,
    adminUserId,
    candidates,
    selectedIds,
    eventsEnabled: ctx.eventsEnabled,
    announcementConfigured: ctx.announcementConfigured,
  });
  return {
    plan,
    candidates,
    selectedIds: [...new Set(selectedIds)],
    eventsEnabled: ctx.eventsEnabled,
    announcementConfigured: ctx.announcementConfigured,
    canManageEvents: ctx.canManageEvents,
  };
}

/** The engine's window onto KoolBot events and the guild's native events. */
export class DiscordEventAdoptionPort implements AdoptionEventPort {
  public constructor(
    private readonly client: Client,
    private readonly guild: Guild,
  ) {}

  public async adopt(input: {
    ref: string;
    guildId: string;
    adminId: string;
    nativeEventId: string;
    name: string;
    description: string;
    startsAt: string;
    durationMinutes: number;
  }): Promise<string> {
    // A retried step (crash after the insert) finds its own row again.
    const mine = await Event.findOne({ adoptionRef: input.ref })
      .select("_id")
      .lean();
    if (mine) return String(mine._id);
    // Same guard as the sync's claim: a native event belongs to one row.
    if (await Event.exists({ nativeEventId: input.nativeEventId })) {
      throw new Error("That event is already a KoolBot event.");
    }
    try {
      const row = await Event.create({
        guildId: input.guildId,
        title: input.name.slice(0, 100),
        description: input.description.slice(0, 1000),
        startTime: new Date(input.startsAt),
        timezone: "",
        durationMinutes: input.durationMinutes,
        state: "scheduled",
        recurrence: "none",
        nativeEventId: input.nativeEventId,
        nativeAdopted: true,
        adoptionRef: input.ref,
        createdBy: input.adminId,
      });
      return String(row._id);
    } catch (error) {
      // The unique index on `nativeEventId`: another writer linked it first.
      if ((error as { code?: number }).code === 11000) {
        throw new Error("That event is already a KoolBot event.", {
          cause: error,
        });
      }
      throw error;
    }
  }

  public async findByRef(ref: string): Promise<string | null> {
    const row = await Event.findOne({ adoptionRef: ref }).select("_id").lean();
    return row ? String(row._id) : null;
  }

  public async remove(ref: string): Promise<void> {
    await EventService.getInstance(this.client).removeAdoptedEvent(ref);
  }

  public async readNative(
    nativeEventId: string,
  ): Promise<AdoptionNativeEvent | null> {
    try {
      const e = await this.guild.scheduledEvents.fetch(nativeEventId);
      return {
        id: e.id,
        name: e.name,
        description: e.description ?? "",
        startsAt: e.scheduledStartAt?.toISOString() ?? null,
        endsAt: e.scheduledEndAt?.toISOString() ?? null,
        status: String(e.status),
      };
    } catch (error) {
      if (
        error instanceof DiscordAPIError &&
        error.code === DISCORD_UNKNOWN_SCHEDULED_EVENT
      ) {
        return null;
      }
      logger.warn("event adoption: could not read a native event", error);
      throw error;
    }
  }
}
