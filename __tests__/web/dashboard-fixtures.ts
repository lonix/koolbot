import {
  dashboardFeatures,
  type DashboardData,
} from "../../src/web/dashboard-data.js";
import type { VersionCheckSnapshot } from "../../src/services/version-check-service.js";

/** A server where everything was read and nothing needs the admin (#1322). */
export function calmDashboard(): DashboardData {
  return {
    guild: {
      state: "ok",
      value: {
        id: "g1",
        name: "Test Guild",
        memberCount: 42,
        voiceUsers: 3,
        botTag: "Koolbot#0001",
        connected: true,
      },
    },
    mongoState: "connected",
    counts: {
      state: "ok",
      value: {
        announcements: 1,
        pollSchedules: 2,
        pollItems: 3,
        reactionRoles: 4,
        notices: 5,
      },
    },
    permissions: { state: "ok", value: { problems: 0, unchecked: 0 } },
    needsYou: [],
    scanReadAt: null,
    voice: {
      state: "ok",
      value: {
        byDay: [30, 95, 120, 60, 45, 210, 180],
        totalMinutes: 740,
        timeZone: "Europe/Oslo",
      },
    },
    features: dashboardFeatures({
      "voicechannels.enabled": true,
      "voicetracking.enabled": true,
      "quotes.enabled": true,
      "polls.enabled": false,
    }),
  };
}

/**
 * The fullest page: problems from the permission check and a recent scan, and
 * sources that could not be read.
 */
export function busyDashboard(): DashboardData {
  return {
    ...calmDashboard(),
    guild: { state: "unavailable", reason: "timed out after 2500 ms" },
    mongoState: "disconnected",
    counts: { state: "unavailable", reason: "the database is disconnected" },
    permissions: { state: "ok", value: { problems: 2, unchecked: 1 } },
    needsYou: [
      {
        severity: "missing",
        title: 'Bot lacks Manage Nicknames in the category "Events"',
        detail: "Affects Event clan tags.",
        href: "/admin/bot-permissions",
        action: "Open Bot permissions",
      },
      {
        severity: "blocker",
        title: "KoolBot lacks Manage Roles",
        detail: "Found by a Server scan 12 minutes ago.",
        href: "/admin/adopt",
        action: "Open Server scan",
      },
      {
        severity: "warning",
        title: "The bot is not requesting the GuildMembers intent",
        detail: "Found by a Server scan 12 minutes ago.",
        href: "/admin/adopt",
        action: "Open Server scan",
      },
    ],
    scanReadAt: "2026-10-22T08:00:00.000Z",
    voice: { state: "unavailable", reason: "timed out after 2500 ms" },
  };
}

/** A major update is available: the fullest Version panel. */
export const UPDATE_AVAILABLE: VersionCheckSnapshot = {
  enabled: true,
  running: "1.2.2",
  latest: {
    version: "v2.0.0",
    url: "https://github.com/lonix/koolbot/releases/tag/v2.0.0",
    publishedAt: new Date("2026-09-01T12:00:00Z"),
    fetchedAt: new Date("2026-09-24T08:00:00Z"),
  },
  status: "update-available",
  updateKind: "major",
  lastAttemptAt: new Date("2026-09-24T08:00:00Z"),
  lastError: null,
};
