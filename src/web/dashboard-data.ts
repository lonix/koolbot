/**
 * What the Dashboard reads (#1322), and how it reads it.
 *
 * The page is made of independent sources: Discord, MongoDB, the bot-permission
 * check, the last Server scan, the voice aggregate. Each is read on its own,
 * under its own time limit, and a source that fails or is slow becomes
 * `unavailable` in its own card. It never fails the page, and it is never shown
 * as a zero: "0 issues" and "could not be checked" are different statements.
 *
 * The sources are passed in (`DashboardSources`), so the rules here run in tests
 * without Discord, MongoDB or a clock. `read-only-routes.ts` builds the real ones.
 */

import {
  ROLE_ABOVE_BOT,
  type BotPermissionReport,
  type MissingPermission,
} from "../services/bot-permission-check.js";
import type { ServerScan } from "../services/server-scan-service.js";
import type { GuildVoiceHeatmap } from "../services/voice-activity-analytics.js";
import { NAV_ITEMS, type NavFeatureStatus } from "./admin-layout.js";
import { fixedOnBotPermissions } from "./adopt-view.js";

/** How long one source may take before the page goes ahead without it. */
export const DASHBOARD_SOURCE_TIMEOUT_MS = 2_500;

export const BOT_PERMISSIONS_HREF = "/admin/bot-permissions";
export const SERVER_SCAN_HREF = "/admin/adopt";

/** The most "Needs you" rows shown; the rest are one line that links to where they all are. */
export const NEEDS_YOU_LIMIT = 6;

/** A value that was read, or that could not be. */
export type Read<T> =
  { state: "ok"; value: T } | { state: "unavailable"; reason?: string };

export interface GuildFacts {
  name: string | null;
  id: string;
  memberCount: number | null;
  voiceUsers: number | null;
  botTag: string | null;
  /** The gateway is ready and the server could be read. */
  connected: boolean;
}

export interface DatabaseCounts {
  announcements: number | null;
  pollSchedules: number | null;
  pollItems: number | null;
  reactionRoles: number | null;
  notices: number | null;
}

export interface NeedsYouRow {
  severity: "blocker" | "warning" | "missing";
  title: string;
  /** One sentence on what it breaks; plain text, escaped by the renderer. */
  detail: string;
  href: string;
  action: string;
}

export interface FeatureEntry {
  key: string;
  label: string;
  href: string;
  on: boolean;
}

export interface PermissionsSummary {
  /** Problems in switched-on features (what the navigation badge counts). */
  problems: number;
  /** Switched-on features the check could not look at. */
  unchecked: number;
}

export interface VoiceWeek {
  byDay: number[];
  totalMinutes: number;
  timeZone: string;
}

export interface DashboardData {
  guild: Read<GuildFacts>;
  /** Mongoose's connection state word ("connected", "disconnected", ...). */
  mongoState: string;
  /** Unavailable when the database is not connected or the counts timed out. */
  counts: Read<DatabaseCounts>;
  permissions: Read<PermissionsSummary>;
  needsYou: NeedsYouRow[];
  /** When the scan whose rows are listed was read, or null: no recent scan to read from. */
  scanReadAt: string | null;
  /** Null when voice tracking is off. */
  voice: Read<VoiceWeek> | null;
  features: FeatureEntry[];
}

export interface DashboardSources {
  guild: () => Promise<GuildFacts>;
  mongoState: () => string;
  counts: () => Promise<DatabaseCounts>;
  permissions: () => Promise<BotPermissionReport>;
  /**
   * The last finished scan still within the Dashboard's retention, with when it
   * finished (ms), or null. Never starts one.
   */
  recentScan: () => { scan: ServerScan; readAt: number } | null;
  /** The clock, for the age shown beside the scan's rows. */
  now?: () => number;
  voiceTrackingEnabled: () => boolean;
  voiceWeek: () => Promise<GuildVoiceHeatmap>;
  navFeatureStatus: NavFeatureStatus;
  timeoutMs?: number;
}

/** Rejects when `work` takes longer than `ms`. The work itself is not cancelled. */
export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    // A pending limit must not keep the process alive.
    timer.unref?.();
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

async function read<T>(work: () => Promise<T>, ms: number): Promise<Read<T>> {
  try {
    return { state: "ok", value: await withTimeout(work(), ms) };
  } catch (err) {
    return {
      state: "unavailable",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/** The features that have a page, from the sidebar's own list, switched-on ones first. */
export function dashboardFeatures(status: NavFeatureStatus): FeatureEntry[] {
  const entries = NAV_ITEMS.flatMap((item) =>
    item.group === "Features" && item.featureKey && !item.subpage
      ? [
          {
            key: item.featureKey as string,
            label: item.label,
            href: item.href,
            on: status[item.featureKey] === true,
          },
        ]
      : [],
  );
  const byLabel = (a: FeatureEntry, b: FeatureEntry): number =>
    a.label.localeCompare(b.label);
  return [
    ...entries.filter((e) => e.on).sort(byLabel),
    ...entries.filter((e) => !e.on).sort(byLabel),
  ];
}

function whereText(p: MissingPermission): string {
  const t = p.target;
  if (t.kind === "server") return "server-wide";
  if (t.kind === "role") return `for the role "${t.name}"`;
  return `in the ${t.kind} "${t.name}"`;
}

/** One row per missing permission and place, as the Bot permissions page counts them. */
export function permissionRows(report: BotPermissionReport): NeedsYouRow[] {
  return report.problems.map((p) => {
    const features = [...new Set(p.features.map((f) => f.feature))];
    return {
      severity: "missing",
      title:
        p.permission === ROLE_ABOVE_BOT
          ? `Bot role is too low ${whereText(p)}`
          : `Bot lacks ${p.permission} ${whereText(p)}`,
      detail: features.length
        ? `Affects ${features.join(", ")}.`
        : "Affects a feature that is switched on.",
      href: BOT_PERMISSIONS_HREF,
      action: "Open Bot permissions",
    };
  });
}

const flat = (name: string): string =>
  name.replace(/[^a-z0-9]/gi, "").toLowerCase();

/**
 * Whether the permission report already has a row for this scan finding. The
 * report covers the permissions its registry lists and the roles a feature is
 * bound to; the scan also reports permissions the registry leaves out (posting
 * in channels) and the general "roles above the bot" warning. Those have no row
 * there, so they stay.
 */
function coveredByReport(code: string, report: BotPermissionReport): boolean {
  if (code.startsWith("missing-")) {
    const wanted = flat(code.slice("missing-".length));
    return report.problems.some((p) =>
      p.permission.split(" or ").some((n) => flat(n) === wanted),
    );
  }
  if (code.startsWith("bound-role-unmanageable-")) {
    const id = code.slice("bound-role-unmanageable-".length);
    return report.problems.some(
      (p) => p.permission === ROLE_ABOVE_BOT && p.target.id === id,
    );
  }
  return false;
}

/** "12 minutes ago": how long ago a scan was read, for the rows it produced. */
export function scanAge(readAt: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - readAt) / 60_000));
  if (minutes < 1) return "less than a minute ago";
  if (minutes === 1) return "1 minute ago";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
}

/**
 * Blockers and warnings from the last Server scan. A finding the permission
 * report already has a row for is left out; every other one stays, so a
 * blocker the report cannot see is never hidden.
 */
export function scanRows(
  scan: ServerScan,
  report: BotPermissionReport | null,
  age = "",
): NeedsYouRow[] {
  return scan.readiness.issues
    .filter((i) => i.severity === "error" || i.severity === "warning")
    .filter((i) => !(report?.available && coveredByReport(i.code, report)))
    .map((i) => ({
      severity: i.severity === "error" ? "blocker" : "warning",
      title: i.message,
      detail: age
        ? `Found by a Server scan ${age}.`
        : "Found by the last Server scan.",
      href: fixedOnBotPermissions(i.code)
        ? BOT_PERMISSIONS_HREF
        : SERVER_SCAN_HREF,
      action: fixedOnBotPermissions(i.code)
        ? "Open Bot permissions"
        : "Open Server scan",
    }));
}

/** Switched-on features the check could not look at, each counted once. */
export function uncheckedFeatures(report: BotPermissionReport): number {
  const ids = new Set<string>(report.unknown.map((u) => u.feature.id));
  for (const c of report.checks) {
    if (c.enabled && (c.outcome === "unchecked" || c.outcome === "unknown")) {
      ids.add(c.feature.id);
    }
  }
  return ids.size;
}

function summarise(report: BotPermissionReport): Read<PermissionsSummary> {
  if (!report.available) {
    return { state: "unavailable", reason: report.reason ?? undefined };
  }
  return {
    state: "ok",
    value: {
      problems: report.problems.length,
      unchecked: uncheckedFeatures(report),
    },
  };
}

export async function loadDashboardData(
  src: DashboardSources,
): Promise<DashboardData> {
  const ms = src.timeoutMs ?? DASHBOARD_SOURCE_TIMEOUT_MS;
  const mongoState = src.mongoState();
  // Mongoose buffers a command while it is disconnected, so a count would wait
  // out the buffer and then fail. Say "unavailable" at once instead.
  const dbConnected = mongoState === "connected";
  const voiceOn = src.voiceTrackingEnabled();

  const [guild, counts, report, voice] = await Promise.all([
    read(src.guild, ms),
    dbConnected
      ? read(src.counts, ms)
      : Promise.resolve<Read<DatabaseCounts>>({
          state: "unavailable",
          reason: `the database is ${mongoState}`,
        }),
    read(src.permissions, ms),
    voiceOn ? read(src.voiceWeek, ms) : Promise.resolve(null),
  ]);

  const permissionsRead = report.state === "ok" ? report.value : null;
  const permissions: Read<PermissionsSummary> = permissionsRead
    ? summarise(permissionsRead)
    : {
        state: "unavailable",
        reason: report.state === "unavailable" ? report.reason : undefined,
      };

  const scan = ((): { scan: ServerScan; readAt: number } | null => {
    try {
      return src.recentScan();
    } catch {
      return null;
    }
  })();

  const needsYou = [
    ...(permissionsRead ? permissionRows(permissionsRead) : []),
    ...(scan
      ? scanRows(
          scan.scan,
          permissionsRead,
          scanAge(scan.readAt, (src.now ?? Date.now)()),
        )
      : []),
  ];

  return {
    guild,
    mongoState,
    counts,
    permissions,
    needsYou,
    scanReadAt: scan ? new Date(scan.readAt).toISOString() : null,
    voice:
      voice === null
        ? null
        : voice.state === "ok"
          ? {
              state: "ok",
              value: {
                byDay: voice.value.byDay,
                totalMinutes: voice.value.totalMinutes,
                timeZone: voice.value.timeZone,
              },
            }
          : voice,
    features: dashboardFeatures(src.navFeatureStatus),
  };
}
