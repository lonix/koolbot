/**
 * The per-feature Discord permission notice (#1253): a small callout a feature
 * page shows when the bot lacks a permission that feature needs, naming the
 * permission and where (the channel or category), and linking to the Bot
 * permissions page.
 *
 * It adds no permission list and no Discord call of its own. It reads the
 * `checks` of the report `checkBotPermissions` already builds from the registry
 * (`bot-permission-registry.ts`), which shares one Discord read per
 * `SNAPSHOT_TTL_MS`, so a page view costs no extra REST traffic.
 *
 * Only enabled features are reported (the registry's own `enabled` flag, plus
 * the page's `enabled` for the case where the whole check is unavailable). A
 * feature whose channel is not set is not reported here: the page already says
 * so in its status line. When the check cannot run, the notice says that
 * instead of staying quiet, so a missing notice never means "all is well"
 * while the check was blind.
 */

import type { Client } from "discord.js";
import {
  checkBotPermissions,
  type BotPermissionReport,
  type CheckDeps,
  type EventPlacement,
  type FeatureRef,
  type PermissionTarget,
} from "../services/bot-permission-check.js";
import { RECORDED_WARNINGS } from "../services/bot-permission-registry.js";
import logger from "../utils/logger.js";
import { BOT_PERMISSIONS_HREF } from "./dashboard-data.js";
import { escapeHtml } from "./html.js";
import { icon } from "./icons.js";

/** How long a page waits for the check before it says "not checked yet". */
export const NOTICE_TIMEOUT_MS = 3000;

export interface NoticeMissing {
  feature: FeatureRef;
  permissions: string[];
  target: PermissionTarget;
}

export interface NoticeUnchecked {
  feature: FeatureRef;
  target: PermissionTarget;
  note: string;
}

export interface PermissionNotice {
  /** Why the whole check could not run; the other lists are then empty. */
  unavailable: string | null;
  missing: NoticeMissing[];
  unchecked: NoticeUnchecked[];
  /** The numbers come from the bot's cached view, not a fresh read. */
  stale: boolean;
}

export type FeatureFilter = (feature: FeatureRef) => boolean;

/** Registry entries of one or more areas ("Events", "Voice channels"), so a new entry shows up without an edit here. */
export function inAreas(...areas: string[]): FeatureFilter {
  return (f) => areas.includes(f.area);
}

/** Registry entries by id, for a page that shows only the ones its content needs. */
export function inFeatures(...ids: string[]): FeatureFilter {
  return (f) => ids.includes(f.id);
}

export interface BuildOptions {
  /** The feature page's own on/off. Only matters when the check is unavailable. */
  enabled: boolean;
  filter: FeatureFilter;
  /**
   * The filter as a function of the finished report, for a page whose choice of
   * features depends on what the check found (the host panel: which channels
   * exist). Wins over `filter`.
   */
  filterFromReport?: (report: BotPermissionReport) => FeatureFilter;
  /**
   * Recorded warning texts the page already shows (the host panel's group and
   * tag warnings). A finding they fully cover is left out, so it is read once.
   */
  shownWarnings?: readonly string[];
}

function coveredByShownWarning(
  m: NoticeMissing,
  shown: readonly string[],
): boolean {
  const recorded = RECORDED_WARNINGS[m.feature.id];
  if (!recorded || !recorded.texts.some((t) => shown.includes(t))) return false;
  return m.permissions.every((p) => recorded.covers.includes(p));
}

/**
 * What to tell the admin, from a finished report. Null: nothing to say (all
 * checked features are in place, switched off, or have no channel set).
 */
export function buildPermissionNotice(
  report: BotPermissionReport,
  opts: BuildOptions,
): PermissionNotice | null {
  if (!report.available) {
    if (!opts.enabled) return null;
    return {
      unavailable:
        report.reason ??
        "The bot's permissions could not be checked right now.",
      missing: [],
      unchecked: [],
      stale: false,
    };
  }
  const filter = opts.filterFromReport?.(report) ?? opts.filter;
  const missing: NoticeMissing[] = [];
  const unchecked: NoticeUnchecked[] = [];
  for (const c of report.checks) {
    if (!c.enabled || !c.target || !filter(c.feature)) continue;
    if (c.outcome === "missing") {
      const m = {
        feature: c.feature,
        permissions: c.missing,
        target: c.target,
      };
      if (!coveredByShownWarning(m, opts.shownWarnings ?? [])) missing.push(m);
    } else if (c.outcome === "unknown") {
      const note =
        report.unknown.find(
          (u) => u.feature.id === c.feature.id && u.target.id === c.target?.id,
        )?.note ?? "It could not be checked.";
      unchecked.push({ feature: c.feature, target: c.target, note });
    }
  }
  if (missing.length === 0 && unchecked.length === 0) return null;
  return { unavailable: null, missing, unchecked, stale: !report.fresh };
}

/** "server-wide", or `in the category “X”`, for a plain-text sentence (escaped on output by the caller). */
function where(target: PermissionTarget): string {
  if (target.kind === "server") return "server-wide";
  if (target.kind === "role") return `for the role “${target.name}”`;
  return `in the ${target.kind} “${target.name}”`;
}

function callout(
  tone: "warn" | "",
  title: string,
  bodyHtml: string,
  actionsHtml: string,
): string {
  return `<div class="kb-callout${tone ? ` kb-callout--${tone}` : ""}" role="note" data-permission-notice>
  ${icon(tone === "warn" ? "triangle-alert" : "info")}<div class="kb-callout__body"><p class="kb-callout__title">${escapeHtml(title)}</p>${bodyHtml}</div>${actionsHtml ? `<div class="kb-callout__actions">${actionsHtml}</div>` : ""}
</div>`;
}

export interface RenderOptions {
  /** The Bot permissions page is admin-only; a host who is not an admin gets a plain sentence instead of a link. */
  canLinkToPage: boolean;
}

/**
 * The notice as HTML, escaped. Empty string for null. It never says that all
 * is well: it is only shown when there is something to fix or the check was blind.
 */
export function renderPermissionNotice(
  notice: PermissionNotice | null,
  opts: RenderOptions,
): string {
  if (!notice) return "";
  const link = opts.canLinkToPage
    ? `<a class="kb-btn kb-btn--sm" href="${BOT_PERMISSIONS_HREF}">Open Bot permissions</a>`
    : "";
  const askAdmin = opts.canLinkToPage
    ? ""
    : `<p class="kb-callout__text">Ask a server admin to give the bot the permission (Bot permissions page).</p>`;
  if (notice.unavailable !== null) {
    return callout(
      "",
      "Bot permissions could not be checked",
      `<p class="kb-callout__text">${escapeHtml(notice.unavailable)} This page cannot tell you whether the bot has what this feature needs.</p>`,
      link,
    );
  }
  const parts: string[] = [];
  const staleText = notice.stale
    ? `<p class="kb-callout__text">Discord could not be reached, so this is from the bot's cached view and may be out of date.</p>`
    : "";
  // Said once: with the missing-permissions callout when there is one,
  // otherwise with the "could not be checked" one.
  const stale = notice.missing.length > 0 ? staleText : "";
  if (notice.missing.length > 0) {
    const items = notice.missing
      .map(
        (m) =>
          `<li><strong>${escapeHtml(m.feature.feature)}:</strong> missing ${m.permissions.map((p) => `<strong>${escapeHtml(p)}</strong>`).join(", ")} ${escapeHtml(where(m.target))}. ${escapeHtml(m.feature.effect)}</li>`,
      )
      .join("");
    parts.push(
      callout(
        "warn",
        notice.missing.length === 1
          ? "The bot is missing a Discord permission"
          : "The bot is missing Discord permissions",
        `<div class="kb-callout__text"><ul>${items}</ul></div>${askAdmin}${stale}`,
        link,
      ),
    );
  }
  if (notice.unchecked.length > 0) {
    const items = notice.unchecked
      .map(
        (u) =>
          `<li><strong>${escapeHtml(u.feature.feature)}:</strong> ${escapeHtml(u.note)}</li>`,
      )
      .join("");
    parts.push(
      callout(
        "",
        "Some bot permissions could not be checked",
        `<div class="kb-callout__text"><ul>${items}</ul></div>${notice.missing.length > 0 ? "" : staleText}`,
        notice.missing.length === 0 ? link : "",
      ),
    );
  }
  return parts.join("\n");
}

/**
 * A notice cut into the part that belongs next to named fields and the rest
 * (#1478). Each slot takes the findings of the registry entries it names; what
 * no slot names stays in `rest`, which also keeps the "could not be checked"
 * message, so that is said once for the page and never per field. Nothing is
 * dropped and nothing is read again: the slots are slices of the one report.
 */
export interface PartitionedNotice<S extends string> {
  rest: PermissionNotice | null;
  slots: Record<S, PermissionNotice | null>;
}

export function partitionNotice<S extends string>(
  notice: PermissionNotice | null,
  slotFeatures: Record<S, readonly string[]>,
): PartitionedNotice<S> {
  const slots = {} as Record<S, PermissionNotice | null>;
  const claimed = new Set<string>();
  for (const slot of Object.keys(slotFeatures) as S[]) {
    const ids = slotFeatures[slot];
    ids.forEach((id) => claimed.add(id));
    const missing = notice?.missing.filter((m) => ids.includes(m.feature.id));
    const unchecked = notice?.unchecked.filter((u) =>
      ids.includes(u.feature.id),
    );
    slots[slot] =
      notice &&
      notice.unavailable === null &&
      ((missing?.length ?? 0) > 0 || (unchecked?.length ?? 0) > 0)
        ? {
            unavailable: null,
            missing: missing ?? [],
            unchecked: unchecked ?? [],
            stale: notice.stale,
          }
        : null;
  }
  if (!notice) return { rest: null, slots };
  const missing = notice.missing.filter((m) => !claimed.has(m.feature.id));
  const unchecked = notice.unchecked.filter((u) => !claimed.has(u.feature.id));
  const rest =
    notice.unavailable !== null || missing.length > 0 || unchecked.length > 0
      ? { ...notice, missing, unchecked }
      : null;
  return { rest, slots };
}

/**
 * The slice of a notice that belongs to one field, as a chip and a help line
 * right under it (components.md, "Missing permission next to the setting it
 * breaks"). Empty string for null. It is the same finding as the block form
 * (`renderPermissionNotice`), at the field: the chip says what is missing and
 * where, the line says what stops working. A stale read is labelled on the
 * slice itself, since a slice is read on its own.
 */
export function renderInlinePermissionNotice(
  notice: PermissionNotice | null,
  opts: RenderOptions,
): string {
  if (!notice) return "";
  const chip = (text: string, warn: boolean): string => {
    const cls = warn ? "kb-chip kb-chip--warn" : "kb-chip";
    const body = `${icon(warn ? "triangle-alert" : "info")}${escapeHtml(text)}`;
    return opts.canLinkToPage
      ? `<a class="${cls}" href="${BOT_PERMISSIONS_HREF}">${body}</a>`
      : `<span class="${cls}">${body}</span>`;
  };
  const askAdmin = opts.canLinkToPage ? "" : " Ask a server admin to fix it.";
  const stale = notice.stale
    ? " Discord could not be reached, so this is from the bot's cached view and may be out of date."
    : "";
  const lines: string[] = [];
  for (const m of notice.missing) {
    lines.push(
      `<p class="kb-help" data-permission-inline="${escapeHtml(m.feature.id)}">${chip(`Bot lacks ${m.permissions.join(", ")} ${where(m.target)}`, true)} ${escapeHtml(m.feature.effect)}${escapeHtml(askAdmin)}${escapeHtml(stale)}</p>`,
    );
  }
  for (const u of notice.unchecked) {
    lines.push(
      `<p class="kb-help" data-permission-inline="${escapeHtml(u.feature.id)}">${chip("Could not be checked", false)} ${escapeHtml(u.note)}${escapeHtml(stale)}</p>`,
    );
  }
  return lines.join("\n");
}

/**
 * Which Events form field each Events registry entry belongs to: the group
 * switch (group channels, host access, moves between them), the group leaders
 * and the clan tags. The other Events entries (the Events list card, the
 * announcement channel) have no field and stay in the page's own block.
 */
export const EVENT_FORM_NOTICE_SLOTS = {
  groups: ["event-channels", "event-host-access", "event-moves"],
  leaders: ["event-leads-channel"],
  tags: ["event-tags"],
} as const;

export type EventFormSlot = keyof typeof EVENT_FORM_NOTICE_SLOTS;

/** The inline HTML for each Events form field; "" where there is nothing to say. */
export type EventFormInline = Record<EventFormSlot, string>;

/**
 * An Events notice split for a form that renders the shared Groups section:
 * the block for the page, and the inline HTML for the fields.
 */
export function splitEventFormNotice(
  notice: PermissionNotice | null,
  opts: RenderOptions,
): { block: string; inline: EventFormInline } {
  const { rest, slots } = partitionNotice(notice, EVENT_FORM_NOTICE_SLOTS);
  return {
    block: renderPermissionNotice(rest, opts),
    inline: {
      groups: renderInlinePermissionNotice(slots.groups, opts),
      leaders: renderInlinePermissionNotice(slots.leaders, opts),
      tags: renderInlinePermissionNotice(slots.tags, opts),
    },
  };
}

export interface LoadOptions extends BuildOptions {
  client: Client;
  guildId: string;
  /** Test seam: the checker. */
  check?: (
    client: Client,
    guildId: string,
    deps?: CheckDeps,
  ) => Promise<BotPermissionReport>;
  /** Ask the check about one event's channels (see `CheckDeps.eventPlacement`). */
  eventPlacement?: EventPlacement;
  timeoutMs?: number;
}

/**
 * Run (or reuse) the check and build the notice. Never throws and never holds
 * a page for long: past the timeout the page says the check did not finish (the
 * read keeps going and fills the checker's cache for the next view).
 */
export async function loadPermissionNotice(
  opts: LoadOptions,
): Promise<PermissionNotice | null> {
  if (!opts.enabled) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const run = (opts.check ?? checkBotPermissions)(
      opts.client,
      opts.guildId,
      opts.eventPlacement ? { eventPlacement: opts.eventPlacement } : undefined,
    );
    const limit = new Promise<null>((resolve) => {
      timer = setTimeout(
        () => resolve(null),
        opts.timeoutMs ?? NOTICE_TIMEOUT_MS,
      );
    });
    const report = await Promise.race([run, limit]);
    if (!report) {
      // A late rejection must not become an unhandled one.
      run.catch(() => undefined);
      return {
        unavailable:
          "The check did not finish in time; reload the page in a moment.",
        missing: [],
        unchecked: [],
        stale: false,
      };
    }
    return buildPermissionNotice(report, opts);
  } catch (err) {
    logger.debug("Permission notice: check failed:", err);
    return {
      unavailable: "The bot's permissions could not be checked right now.",
      missing: [],
      unchecked: [],
      stale: false,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
