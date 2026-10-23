/**
 * The one "create event from the form" pipeline (#1305), shared by the admin
 * form (`POST /admin/events/create`) and the host's own (`POST /me/events/new`)
 * so the two cannot drift: same validation, same Groups handling, same audit.
 *
 * It trusts nothing in the body about who or where: `createdBy` and `guildId`
 * come from the session passed in, never from a posted field. Who may call it
 * is the caller's job (the admin router's role check, the `/me/events` host
 * scope guard); it only decides what a host may NOT set (`allowRecurrence`).
 */

import type { Client } from "discord.js";
import type { Response } from "express";
import logger from "../utils/logger.js";
import {
  EventService,
  ImpromptuNotReadyError,
  IMPROMPTU_START_BUFFER_MS,
  RecurrenceDisabledError,
} from "../services/event-service.js";
import {
  EVENT_RECURRENCES,
  type EventRecurrence,
  type IEvent,
} from "../models/event.js";
import { ConfigService } from "../services/config-service.js";
import { loadPresetResolver } from "../services/event-group-preset-service.js";
import {
  hasCaptainsLobby,
  parseGroupForm,
  resolveGroupCountLimits,
  validateGroupSetup,
  type EventGroupSetup,
} from "../services/event-groups.js";
import { validateEventForm } from "./event-form.js";
import { parseEventWhen, plannedStartFor } from "./event-when.js";
import { recordAudit, type AuditEntry } from "./audit.js";
import { hostPanelPath } from "./host-panel-shared.js";
import { countOpenHostEvents } from "./event-host.js";
import { createKeyedLock } from "../utils/keyed-lock.js";
import { PermissionsService } from "../services/permissions-service.js";
import { signFlash, truncateFlash } from "./http-flash.js";
import type { WebSessionContext } from "./session.js";

export interface CreateEventPipelineOptions {
  /** True for the admin form; a host's events never repeat. */
  allowRecurrence: boolean;
  /** Which form it came from, recorded in the audit details. */
  via: "admin" | "host";
  /**
   * How the audit row is written. The host route passes a bounded writer, since
   * a host's strings are member-supplied (#1142); the admin form keeps the full
   * details.
   */
  audit?: (session: WebSessionContext, entry: AuditEntry) => Promise<void>;
  /** The clock, for tests. */
  now?: Date;
}

export type CreateEventResult =
  | {
      ok: true;
      event: IEvent;
      title: string;
      /** The "When: Now" path ran; `started` says whether Start now worked. */
      impromptu: boolean;
      started: boolean;
    }
  | { ok: false; error: string };

function field(body: Record<string, unknown>, name: string): string {
  const raw = body[name];
  return typeof raw === "string" ? raw.trim() : "";
}

/** One check-and-create at a time per host (this process is the only writer). */
const hostCreateLock = createKeyedLock();

/**
 * What the per-host cap (#1408) means for this request: `limit` null when it
 * does not apply (no limit, or an administrator), or a refusal.
 */
async function resolveHostCap(
  client: Client,
  session: WebSessionContext,
  rawBody: unknown,
  opts: CreateEventPipelineOptions,
): Promise<{ limit: number | null } | { refusal: string }> {
  // An admin-role session is never limited; nothing to read.
  if (session.role === "admin") return { limit: null };
  const whenRaw =
    rawBody && typeof rawBody === "object"
      ? (rawBody as Record<string, unknown>).when
      : undefined;
  let limit: number;
  try {
    // Strict: an unreadable setting must not quietly become "no limit".
    limit = await ConfigService.getInstance().getNumberStrict(
      "events.max_active_per_host",
      0,
    );
  } catch (err) {
    logger.error("Could not read events.max_active_per_host", err);
    await (opts.audit ?? recordAudit)(session, {
      action: "event.create",
      details: {
        via: opts.via,
        when: typeof whenRaw === "string" ? whenRaw : "",
      },
      result: "failure",
      errorMessage: "could not read the open event limit",
    });
    return {
      refusal:
        "Could not check the limit on open events, so nothing was created. Try again in a moment.",
    };
  }
  if (!Number.isFinite(limit) || limit <= 0) return { limit: null };
  // A /me session is issued to administrators too, so the role says how the
  // person signed in, not what they may do: ask Discord. If that cannot be
  // checked, they are treated as not an administrator and the limit applies.
  try {
    if (
      await PermissionsService.getInstance(client).isAdministrator(
        session.discordUserId,
        session.guildId,
      )
    ) {
      return { limit: null };
    }
  } catch (err) {
    logger.warn(
      "Could not check Administrator for the event limit; applying the limit",
      err,
    );
  }
  return { limit };
}

export async function createEventFromForm(
  client: Client,
  session: WebSessionContext,
  rawBody: unknown,
  opts: CreateEventPipelineOptions,
): Promise<CreateEventResult> {
  const cap = await resolveHostCap(client, session, rawBody, opts);
  if ("refusal" in cap) return { ok: false, error: cap.refusal };
  if (cap.limit === null) {
    return createEventUnlocked(client, session, rawBody, opts, null);
  }
  const limit = cap.limit;
  return hostCreateLock.run(`${session.guildId}:${session.discordUserId}`, () =>
    createEventUnlocked(client, session, rawBody, opts, limit),
  );
}

async function createEventUnlocked(
  client: Client,
  session: WebSessionContext,
  rawBody: unknown,
  opts: CreateEventPipelineOptions,
  capLimit: number | null,
): Promise<CreateEventResult> {
  const body: Record<string, unknown> =
    rawBody && typeof rawBody === "object"
      ? (rawBody as Record<string, unknown>)
      : {};
  const now = opts.now ?? new Date();
  const audit = (entry: AuditEntry): Promise<void> =>
    (opts.audit ?? recordAudit)(session, entry);

  const when = parseEventWhen(field(body, "when"));
  if (!when) return { ok: false, error: "Invalid choice for when." };

  // The per-host cap (#1408). `capLimit` was resolved by the caller, which
  // holds the host's lock from here to the insert, so two overlapping requests
  // cannot both see room. Checked before anything is created.
  {
    const limit = capLimit;
    if (limit !== null) {
      let open: number;
      try {
        open = await countOpenHostEvents(
          session.guildId,
          session.discordUserId,
        );
      } catch (err) {
        logger.error("Could not count a host's open events", err);
        await audit({
          action: "event.create",
          details: { via: opts.via, when, limit },
          result: "failure",
          errorMessage: "could not check the open event limit",
        });
        return {
          ok: false,
          error:
            "Could not check how many events you have open, so nothing was created. Try again in a moment.",
        };
      }
      if (open >= limit) {
        await audit({
          action: "event.host.limit",
          details: { via: opts.via, when, limit, open },
          result: "failure",
          errorMessage: "open event limit reached",
        });
        return {
          ok: false,
          error: `You already have ${open} open ${open === 1 ? "event" : "events"}, and the limit is ${limit}. End or cancel one before creating another.`,
        };
      }
    }
  }

  const recurrenceRaw = opts.allowRecurrence
    ? field(body, "recurrence") || "none"
    : "none";
  if (!(EVENT_RECURRENCES as readonly string[]).includes(recurrenceRaw)) {
    return { ok: false, error: `Invalid recurrence: ${recurrenceRaw}` };
  }
  const recurrence = recurrenceRaw as EventRecurrence;
  const impromptu = when === "now";
  if (impromptu && recurrence !== "none") {
    return {
      ok: false,
      error:
        'An event that starts now cannot repeat. Choose "Pick date & time" for a repeating event.',
    };
  }

  // The date and time fields are read only for "Pick date & time". The other
  // choices decide the start themselves; `Now` gets its start from the service.
  const startOverride = impromptu
    ? new Date(now.getTime() + IMPROMPTU_START_BUFFER_MS)
    : (plannedStartFor(when, now) ?? undefined);
  // Shared with the edit form (#1298): one validator, one set of messages.
  const parsed = await validateEventForm(
    {
      title: field(body, "title"),
      description: field(body, "description"),
      date: field(body, "date"),
      time: field(body, "time"),
      duration: field(body, "duration"),
      timezone: field(body, "timezone"),
    },
    { requireFuture: true, ...(startOverride ? { startOverride } : {}) },
  );
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const { title, description, startTime, timezone, durationMinutes } =
    parsed.value;
  const config = ConfigService.getInstance();

  // Optional Groups section (#1188). Read the cap only when groups are on, so
  // a plain event takes exactly the path it always did.
  const groupInput = parseGroupForm(body);
  let groups: EventGroupSetup | undefined;
  if (groupInput.enabled) {
    const [defaultCount, configuredMax] = await Promise.all([
      config.getNumber("events.groups.default_count", 2),
      config.getNumber("events.groups.max_count", 15),
    ]);
    const { maxCount } = resolveGroupCountLimits(defaultCount, configuredMax);
    // The enabled presets are read once, here, and used for the whole request.
    // Custom needs no read, so it works even when the library is unreadable; a
    // named preset that cannot be confirmed is refused.
    const presetId = groupInput.presetId;
    const resolvePreset =
      presetId && presetId !== "custom"
        ? (
            await loadPresetResolver(session.guildId, {
              ownerId: session.discordUserId,
            })
          ).resolve
        : undefined;
    const result = validateGroupSetup(groupInput, {
      maxCount,
      ...(resolvePreset ? { resolvePreset } : {}),
    });
    if (!result.ok) {
      return { ok: false, error: `Groups: ${result.errors.join(" ")}` };
    }
    groups = result.setup;
  }

  const service = EventService.getInstance(client);
  try {
    let event: IEvent;
    let started = false;
    const base = {
      guildId: session.guildId,
      title,
      description,
      timezone,
      durationMinutes,
      ...(groups ? { groups } : {}),
      createdBy: session.discordUserId,
    };
    if (impromptu) {
      const made = await service.createImpromptuEvent(base, now);
      event = made.event;
      started = made.started;
    } else {
      event = await service.createEvent({ ...base, startTime, recurrence });
    }
    await audit({
      action: "event.create",
      targetId: String(event._id),
      details: {
        title,
        startTime: (event.startTime ?? startTime).toISOString(),
        durationMinutes,
        recurrence,
        via: opts.via,
        when,
        ...(impromptu ? { startedNow: started } : {}),
        ...(groups
          ? {
              groups: groups.groups.length,
              groupPreset: groups.presetId,
              channelLeadMinutes: groups.channelLeadMinutes,
              captainsEnabled: groups.captainsEnabled,
              captainsLobby: hasCaptainsLobby(groups.groups),
              captainCustomisationEnabled: groups.captainCustomisationEnabled,
              tagsEnabled: groups.tagsEnabled,
              tagsSuffix: groups.tagsSuffix,
            }
          : {}),
      },
      result: "success",
    });
    return { ok: true, event, title, impromptu, started };
  } catch (err) {
    const text = err instanceof Error ? err.message : "Unknown error";
    if (
      !(err instanceof RecurrenceDisabledError) &&
      !(err instanceof ImpromptuNotReadyError)
    ) {
      logger.error("Create event failed", err);
    }
    await audit({
      action: "event.create",
      details: { title, via: opts.via, when },
      result: "failure",
      errorMessage: text,
    });
    return { ok: false, error: `Failed to create event: ${text}` };
  }
}

/** The flash for a finished create: what happened, in the host's terms. */
export function createdFlash(
  result: Extract<CreateEventResult, { ok: true }>,
): {
  type: "ok" | "err";
  text: string;
} {
  if (!result.impromptu) {
    return { type: "ok", text: `Scheduled event "${result.title}".` };
  }
  return result.started
    ? {
        type: "ok",
        text: `"${result.title}" is live. Its voice channel is ready and the announcement says it is happening now.`,
      }
    : {
        type: "err",
        text: `Created "${result.title}", but its channels could not be made yet. Check the channel category and the bot's permissions; the bot keeps trying every minute.`,
      };
}

/**
 * Redirect to the new event's host panel with a signed flash (a bare
 * query-string flash is ignored, #1149): every new event opens where it is run.
 * Kept here, not imported from the panel's router, so the admin write router
 * does not pull the whole host panel in.
 */
export function redirectToHostPanel(
  res: Response,
  eventId: string,
  flash: { type: "ok" | "err"; text: string },
): void {
  const text = truncateFlash(flash.text);
  const qs = new globalThis.URLSearchParams({
    flash: flash.type,
    msg: text,
    sig: signFlash(flash.type, text),
  }).toString();
  res.redirect(303, `${hostPanelPath(eventId)}?${qs}`);
}
