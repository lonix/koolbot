/**
 * What the Dashboard reads (#1322): each source is bounded and isolated, a
 * source that could not be read is "unavailable" and never 0, and the "Needs
 * you" rows are one per problem.
 */
import { describe, it, expect, jest } from "@jest/globals";
import {
  DASHBOARD_SOURCE_TIMEOUT_MS,
  dashboardFeatures,
  loadDashboardData,
  permissionRows,
  scanRows,
  uncheckedFeatures,
  withTimeout,
  type DashboardSources,
} from "../../src/web/dashboard-data.js";
import {
  ROLE_ABOVE_BOT,
  type BotPermissionReport,
} from "../../src/services/bot-permission-check.js";
import { busyScan } from "./server-scan-fixtures.js";

const ref = (feature: string): never =>
  ({ id: feature, area: "a", feature, effect: "e", fix: "f" }) as never;

function report(over: Partial<BotPermissionReport> = {}): BotPermissionReport {
  return {
    available: true,
    reason: null,
    fresh: true,
    problems: [],
    unknown: [],
    quiet: [],
    okFeatures: [],
    notes: [],
    checks: [],
    ...over,
  };
}

const server = { kind: "server", id: null, name: "Guild" } as const;

function sources(over: Partial<DashboardSources> = {}): DashboardSources {
  return {
    guild: async () => ({
      id: "g",
      name: "Guild",
      memberCount: 5,
      voiceUsers: 1,
      botTag: "Bot#1",
      connected: true,
    }),
    mongoState: () => "connected",
    counts: async () => ({
      announcements: 1,
      pollSchedules: 1,
      pollItems: 1,
      reactionRoles: 1,
      notices: 1,
    }),
    permissions: async () => report(),
    recentScan: () => null,
    voiceTrackingEnabled: () => false,
    voiceWeek: async () => {
      throw new Error("not read when voice tracking is off");
    },
    navFeatureStatus: {},
    timeoutMs: 50,
    ...over,
  };
}

const never = (): Promise<never> => new Promise(() => undefined);

describe("withTimeout", () => {
  it("rejects when the work is slower than the limit and passes a fast result through", async () => {
    await expect(withTimeout(never(), 10)).rejects.toThrow("timed out");
    await expect(withTimeout(Promise.resolve(7), 10)).resolves.toBe(7);
  });
});

describe("loadDashboardData", () => {
  it("reads every source and has nothing under Needs you when all is well", async () => {
    const d = await loadDashboardData(sources());
    expect(d.guild.state).toBe("ok");
    expect(d.counts.state).toBe("ok");
    expect(d.permissions).toEqual({
      state: "ok",
      value: { problems: 0, unchecked: 0 },
    });
    expect(d.needsYou).toEqual([]);
    expect(d.voice).toBeNull();
  });

  it("marks a source that fails or times out unavailable without failing the others", async () => {
    const d = await loadDashboardData(
      sources({
        guild: never,
        counts: async () => {
          throw new Error("boom");
        },
        permissions: never,
      }),
    );
    expect(d.guild.state).toBe("unavailable");
    expect(d.counts).toMatchObject({ state: "unavailable", reason: "boom" });
    // Not "0 issues": a check that did not answer is not a clean result.
    expect(d.permissions.state).toBe("unavailable");
    expect(d.needsYou).toEqual([]);
  });

  it("does not query the counts while the database is not connected", async () => {
    const counts = jest.fn(async () => {
      throw new Error("a buffered count would wait out the buffer");
    });
    const d = await loadDashboardData(
      sources({ mongoState: () => "disconnected", counts }),
    );
    expect(counts).not.toHaveBeenCalled();
    expect(d.counts).toMatchObject({ state: "unavailable" });
    expect(d.mongoState).toBe("disconnected");
  });

  it("is bounded by the per-source limit, not by the slowest source", async () => {
    const started = Date.now();
    await loadDashboardData(
      sources({
        guild: never,
        counts: never,
        permissions: never,
        timeoutMs: 40,
      }),
    );
    // Sources run in parallel: about one limit, not three.
    expect(Date.now() - started).toBeLessThan(400);
    expect(DASHBOARD_SOURCE_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });

  it("reads the voice week only when voice tracking is on", async () => {
    const voiceWeek = jest.fn(async () => ({
      matrix: [],
      byHour: [],
      byDay: [0, 10, 0, 0, 0, 0, 0],
      totalMinutes: 10,
      peak: { day: 1, hour: 20, minutes: 10 },
      timeZone: "UTC",
    }));
    const off = await loadDashboardData(sources({ voiceWeek }));
    expect(voiceWeek).not.toHaveBeenCalled();
    expect(off.voice).toBeNull();
    const on = await loadDashboardData(
      sources({ voiceWeek, voiceTrackingEnabled: () => true }),
    );
    expect(on.voice).toEqual({
      state: "ok",
      value: {
        byDay: [0, 10, 0, 0, 0, 0, 0],
        totalMinutes: 10,
        timeZone: "UTC",
      },
    });
    const slow = await loadDashboardData(
      sources({ voiceWeek: never, voiceTrackingEnabled: () => true }),
    );
    expect(slow.voice?.state).toBe("unavailable");
  });

  it("lists permission problems first, then scan rows without repeating the same problem", async () => {
    const d = await loadDashboardData(
      sources({
        permissions: async () =>
          report({
            problems: [
              {
                permission: "Manage Roles",
                target: server,
                features: [ref("Reaction roles")],
              },
            ],
            unknown: [
              { feature: ref("Voice rooms"), target: server, note: "n" },
            ],
          }),
        recentScan: () => busyScan(),
      }),
    );
    expect(d.permissions).toEqual({
      state: "ok",
      value: { problems: 1, unchecked: 1 },
    });
    // busyScan: a blocker fixed on Bot permissions (a duplicate of the row above),
    // a warning fixed elsewhere, and a note that is not a problem.
    expect(d.needsYou.map((r) => r.title)).toEqual([
      "Bot lacks Manage Roles server-wide",
      "The bot is not requesting the GuildMembers intent",
    ]);
    expect(d.scanReadAt).toBe("2026-10-07T00:00:00Z");
  });

  it("keeps the scan's permission blockers when the permission check did not answer", async () => {
    const d = await loadDashboardData(
      sources({ permissions: never, recentScan: () => busyScan() }),
    );
    expect(d.needsYou.map((r) => r.title)).toEqual([
      "KoolBot lacks Manage Roles",
      "The bot is not requesting the GuildMembers intent",
    ]);
    expect(d.needsYou[0]).toMatchObject({
      severity: "blocker",
      href: "/admin/bot-permissions",
    });
  });

  it("survives a scan peek that throws", async () => {
    const d = await loadDashboardData(
      sources({
        recentScan: () => {
          throw new Error("cache broke");
        },
      }),
    );
    expect(d.needsYou).toEqual([]);
    expect(d.scanReadAt).toBeNull();
  });
});

describe("permissionRows and scanRows", () => {
  it("writes one plain-text row per missing permission and place", () => {
    const rows = permissionRows(
      report({
        problems: [
          {
            permission: "Manage Nicknames",
            target: { kind: "category", id: "c", name: 'Ev"ents' },
            features: [ref("Tags"), ref("Tags"), ref("Moves")],
          },
          { permission: ROLE_ABOVE_BOT, target: server, features: [] },
        ],
      }),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].title).toBe(
      'Bot lacks Manage Nicknames in the category "Ev"ents"',
    );
    // Duplicated features are named once.
    expect(rows[0].detail).toBe("Affects Tags, Moves.");
    expect(rows[1].title).toBe("Bot role is too low server-wide");
    expect(rows[1].detail).toBe("Affects a feature that is switched on.");
    expect(rows.every((r) => r.href === "/admin/bot-permissions")).toBe(true);
  });

  it("points a scan row at the page that fixes it", () => {
    const rows = scanRows(busyScan(), null);
    expect(rows.map((r) => [r.severity, r.href])).toEqual([
      ["blocker", "/admin/bot-permissions"],
      ["warning", "/admin/adopt"],
    ]);
  });
});

describe("dashboardFeatures", () => {
  it("takes the features from the sidebar's own list, switched-on first and A to Z", () => {
    const f = dashboardFeatures({
      "quotes.enabled": true,
      "events.enabled": true,
    });
    expect(f.map((x) => x.label).slice(0, 2)).toEqual(["Events", "Quotes"]);
    expect(f.slice(0, 2).every((x) => x.on)).toBe(true);
    expect(f.slice(2).every((x) => !x.on)).toBe(true);
    expect(f.find((x) => x.key === "voicetracking.enabled")).toMatchObject({
      label: "Voice analytics",
      href: "/admin/analytics",
      on: false,
    });
    // A feature the nav status does not name reads as off, never as on.
    expect(dashboardFeatures({}).every((x) => !x.on)).toBe(true);
  });
});

describe("scan findings the permission report has no row for stay (#1322 review)", () => {
  const scanWith = (
    issues: Array<{ code: string; severity: "error" | "warning" }>,
  ): ReturnType<typeof busyScan> => {
    const scan = busyScan();
    scan.readiness.issues = issues.map((i) => ({
      ...i,
      message: i.code,
      help: "h",
    }));
    return scan;
  };

  it("keeps a missing permission the registry does not list, and the general role-order warning", () => {
    const rows = scanRows(
      scanWith([
        { code: "missing-SendMessages", severity: "error" },
        { code: "role-hierarchy-low", severity: "warning" },
        { code: "missing-ManageRoles", severity: "error" },
      ]),
      report({
        problems: [
          { permission: "Manage Roles", target: server, features: [] },
        ],
      }),
    );
    // Only Manage Roles has a row on the permission report.
    expect(rows.map((r) => r.title)).toEqual([
      "missing-SendMessages",
      "role-hierarchy-low",
    ]);
  });

  it("drops a bound-role finding only for the role the report names", () => {
    const rows = scanRows(
      scanWith([
        { code: "bound-role-unmanageable-7", severity: "error" },
        { code: "bound-role-unmanageable-8", severity: "error" },
      ]),
      report({
        problems: [
          {
            permission: ROLE_ABOVE_BOT,
            target: { kind: "role", id: "7", name: "Staff" },
            features: [],
          },
        ],
      }),
    );
    expect(rows.map((r) => r.title)).toEqual(["bound-role-unmanageable-8"]);
  });

  it("matches an either-or permission row by each of its names", () => {
    const rows = scanRows(
      scanWith([{ code: "missing-ManageEvents", severity: "error" }]),
      report({
        problems: [
          {
            permission: "Create Events or Manage Events",
            target: server,
            features: [],
          },
        ],
      }),
    );
    expect(rows).toEqual([]);
  });

  it("keeps every finding when the report is unavailable", () => {
    const rows = scanRows(
      scanWith([{ code: "missing-ManageRoles", severity: "error" }]),
      report({ available: false }),
    );
    expect(rows).toHaveLength(1);
  });
});

describe("uncheckedFeatures", () => {
  it("counts unknown results and enabled features nothing was checked for, once each", () => {
    const check = (
      id: string,
      enabled: boolean,
      outcome: "ok" | "unchecked" | "unknown",
    ): never =>
      ({
        feature: ref(id),
        kind: "permission",
        enabled,
        outcome,
        target: null,
        missing: [],
      }) as never;
    expect(
      uncheckedFeatures(
        report({
          unknown: [{ feature: ref("a"), target: server, note: "n" }],
          checks: [
            check("a", true, "unknown"),
            check("b", true, "unchecked"),
            check("c", false, "unchecked"),
            check("d", true, "ok"),
          ],
        }),
      ),
    ).toBe(2);
  });
});
