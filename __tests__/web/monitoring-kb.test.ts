/**
 * @jest-environment <rootDir>/__tests__/jsdom-node-env.cjs
 */
/* global DOMParser, Element */

/**
 * The monitoring pages are built from the kb- components (#1646).
 *
 * `renderCommandAuditPage`, `renderCommandMetricsPage`, `renderAnalyticsPage`,
 * `renderDatabasePage` and `renderBotStatusPage` render no class from the old
 * inline `STYLE` set (docs/design/patterns.md, From the old classes) and keep
 * their routes, field names and confirmation dialogs. The folded Settings card,
 * the flash and the string-list editor are shared helpers that other migrations
 * move (#1647, #1684, #1642), so the pages here are drawn with no settings
 * rows, no flash and no presence pools.
 */

import { describe, it, expect, afterEach } from "@jest/globals";
import { ChannelType } from "discord.js";
import {
  renderAnalyticsPage,
  renderBotStatusPage,
  renderCommandAuditPage,
  renderCommandMetricsPage,
  renderDatabasePage,
  type AnalyticsProps,
  type BotStatusProps,
  type CommandAuditProps,
  type CommandMetricsProps,
  type DatabaseProps,
} from "../../src/web/admin-views.js";
import {
  renderAdminPage,
  setAdminUpdateBadgeProvider,
} from "../../src/web/admin-layout.js";

const COMMON = { csrfToken: "csrf", remainingMs: 600_000 };
const NO_FILTERS = {
  commandName: "",
  userId: "",
  result: "",
  from: "",
  to: "",
};

const AUDIT: CommandAuditProps = {
  ...COMMON,
  enabled: true,
  retentionDays: 90,
  settingRows: [],
  commandOptions: ["quote", "component:vc_control"],
  userOptions: [{ id: "u1", label: "Alice" }],
  filters: NO_FILTERS,
  rows: [],
  total: 0,
  page: 1,
  pageSize: 50,
};

const audit = (
  result: "success" | "error" | "denied",
  durationMs: number,
  errorMessage: string | null = null,
) => ({
  createdAt: "2026-05-08T12:34:56.000Z",
  discordUserId: "u1",
  userLabel: "Alice",
  commandName: "quote",
  subcommand: "add",
  channelId: "c1",
  channelLabel: "general",
  channelType: ChannelType.GuildText,
  channelStoredName: null,
  result,
  errorMessage,
  durationMs,
});

const METRICS: CommandMetricsProps = {
  ...COMMON,
  enabled: true,
  retentionDays: 30,
  settingRows: [],
  windowDays: 30,
  totalUsage: 0,
  totalErrors: 0,
  rows: [],
  dailyTotals: [],
};

const METRIC_ROWS = [
  {
    command: "quote",
    usageCount: 100,
    errorCount: 30,
    errorRate: 0.3,
    avgResponseMs: 250,
    lastUsedAt: "2026-05-08 12:00",
  },
  {
    command: "ping",
    usageCount: 50,
    errorCount: 1,
    errorRate: 0.02,
    avgResponseMs: 20,
    lastUsedAt: null,
  },
  {
    command: "seen",
    usageCount: 10,
    errorCount: 0,
    errorRate: 0,
    avgResponseMs: 90,
    lastUsedAt: "2026-05-07 09:00",
  },
];

const EMPTY_HEATMAP = {
  matrix: Array.from({ length: 7 }, () => new Array(24).fill(0)),
  byHour: new Array(24).fill(0),
  byDay: new Array(7).fill(0),
  totalMinutes: 0,
  peak: null,
  timeZone: "UTC",
};

function busyHeatmap(): AnalyticsProps["heatmap"] {
  const matrix = Array.from({ length: 7 }, () => new Array(24).fill(0));
  matrix[5][22] = 200;
  matrix[1][9] = 50;
  const byDay = new Array(7).fill(0);
  byDay[5] = 200;
  byDay[1] = 50;
  const byHour = new Array(24).fill(0);
  byHour[22] = 200;
  byHour[9] = 50;
  return {
    matrix,
    byDay,
    byHour,
    totalMinutes: 250,
    peak: { day: 5, hour: 22, minutes: 200 },
    timeZone: "UTC",
  };
}

const ANALYTICS: AnalyticsProps = {
  ...COMMON,
  enabled: true,
  windowDays: 30,
  heatmap: busyHeatmap(),
};

const DATABASE: DatabaseProps = {
  ...COMMON,
  connection: { state: "connected", name: "koolbot", host: "mongodb" },
  trunk: {
    enabled: true,
    schedule: "0 0 * * *",
    isScheduled: true,
    isRunning: false,
    lastRun: "2026-05-08T00:00:00.000Z",
    detailedDays: 30,
    monthlyMonths: 6,
    yearlyYears: 0,
  },
  trunkHistory: [
    {
      ranAt: "2026-05-08T00:00:00.000Z",
      sessionsRemoved: 17,
      dataAggregated: 4,
      executionMs: 1234,
      errors: 0,
      result: "success",
      errorMessage: null,
    },
    {
      ranAt: "2026-05-07T00:00:00.000Z",
      sessionsRemoved: 0,
      dataAggregated: 0,
      executionMs: 5,
      errors: 2,
      result: "failure",
      errorMessage: "boom",
    },
  ],
  collections: [
    { name: "configs", count: 42 },
    { name: "quotes", count: 8 },
  ],
};

const BOT_STATUS: BotStatusProps = { ...COMMON, maxLength: 128, pools: [] };

const PAGES: ReadonlyArray<{ name: string; html: string }> = [
  { name: "Command audit, empty", html: renderCommandAuditPage(AUDIT) },
  {
    name: "Command audit, logging off",
    html: renderCommandAuditPage({ ...AUDIT, enabled: false }),
  },
  {
    name: "Command audit, a page of rows",
    html: renderCommandAuditPage({
      ...AUDIT,
      rows: [
        audit("success", 12),
        audit("denied", 3),
        audit("error", 400, "boom"),
      ],
      total: 120,
      page: 2,
      filters: { ...NO_FILTERS, commandName: "quote", result: "error" },
    }),
  },
  { name: "Command metrics, empty", html: renderCommandMetricsPage(METRICS) },
  {
    name: "Command metrics, recording off",
    html: renderCommandMetricsPage({ ...METRICS, enabled: false }),
  },
  {
    name: "Command metrics, with data",
    html: renderCommandMetricsPage({
      ...METRICS,
      totalUsage: 160,
      totalErrors: 31,
      rows: METRIC_ROWS,
      dailyTotals: [
        { date: "2026-05-07", usageCount: 5, errorCount: 0 },
        { date: "2026-05-08", usageCount: 20, errorCount: 1 },
      ],
    }),
  },
  {
    name: "Command metrics, no command above the error threshold",
    html: renderCommandMetricsPage({
      ...METRICS,
      totalUsage: 60,
      totalErrors: 1,
      rows: METRIC_ROWS.slice(1),
    }),
  },
  {
    name: "Voice analytics, empty and off",
    html: renderAnalyticsPage({
      ...ANALYTICS,
      enabled: false,
      heatmap: EMPTY_HEATMAP,
    }),
  },
  { name: "Voice analytics, with data", html: renderAnalyticsPage(ANALYTICS) },
  { name: "Database, connected", html: renderDatabasePage(DATABASE) },
  {
    name: "Database, not connected, nothing recorded",
    html: renderDatabasePage({
      ...DATABASE,
      connection: {
        state: "disconnected",
        name: "(unknown)",
        host: "(unknown)",
      },
      trunk: { ...DATABASE.trunk, enabled: false, lastRun: "—" },
      trunkHistory: [],
      collections: [],
    }),
  },
  { name: "Presence", html: renderBotStatusPage(BOT_STATUS) },
];

/** The classes of the old inline `STYLE` set that these pages used. */
const OLD_CLASSES = [
  "card",
  "notice",
  "btn",
  "btn-primary",
  "btn-secondary",
  "btn-danger",
  "btn-sm",
  "subtitle",
  "empty",
  "helper",
  "kv",
  "muted",
  "mono",
  "inline-form",
  "stack",
  "actions",
  "edit-details",
  "tag",
  "tag-on",
  "tag-off",
  "tag-info",
  "tag-warn",
  "heatgrid",
  "heat-bars",
  "hbar",
  "hg-corner",
  "hg-col",
  "hg-rowlabel",
  "hg-cell",
  "peak",
];

function mainOf(html: string): Element {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const main = doc.querySelector("main");
  if (!main) throw new Error("no main element");
  return main;
}

const page = (name: string): Element => {
  const found = PAGES.find((p) => p.name === name);
  if (!found) throw new Error(`no page ${name}`);
  return mainOf(found.html);
};

const texts = (els: ArrayLike<Element> | undefined): (string | undefined)[] =>
  Array.from(els ?? []).map((e) => e.textContent?.trim());

describe("Monitoring pages on the kb- components (#1646)", () => {
  it.each(PAGES)("$name renders no old class and no bare table", ({ html }) => {
    const main = mainOf(html);
    const found = new Set<string>();
    main.querySelectorAll("[class]").forEach((el) => {
      el.classList.forEach((c) => {
        if (OLD_CLASSES.includes(c)) found.add(c);
      });
    });
    expect([...found]).toEqual([]);
    main.querySelectorAll("table").forEach((t) => {
      expect(t.classList.contains("kb-table")).toBe(true);
    });
    expect(main.querySelector("h1:not(.kb-pagehead__title)")).toBeNull();
  });

  it.each(PAGES)(
    "$name opens with a PageHeader holding the one h1",
    ({ html }) => {
      const main = mainOf(html);
      expect(main.querySelectorAll("h1")).toHaveLength(1);
      expect(
        main.querySelector("header.kb-pagehead h1.kb-pagehead__title"),
      ).not.toBeNull();
      expect(
        main.querySelector("header.kb-pagehead .kb-pagehead__sub"),
      ).not.toBeNull();
    },
  );

  it.each(PAGES)("$name has at most one primary button", ({ html }) => {
    const main = mainOf(html);
    const own = Array.from(main.querySelectorAll(".kb-btn--primary")).filter(
      (b) => !b.closest("dialog, .kb-savebar, .kb-callout"),
    );
    expect(own.length).toBeLessThanOrEqual(1);
  });

  it.each(PAGES)(
    "$name keeps every table cell in a labelled table",
    ({ html }) => {
      mainOf(html)
        .querySelectorAll("table.kb-table")
        .forEach((t) => {
          expect(t.querySelector("caption.kb-visually-hidden")).not.toBeNull();
          expect(
            t.querySelectorAll("thead th[scope=col]").length,
          ).toBeGreaterThan(0);
        });
    },
  );

  describe("Command audit", () => {
    it("shows the state in the header and no callout while logging is on", () => {
      const main = page("Command audit, empty");
      expect(
        main.querySelector("header.kb-pagehead .kb-statusline .kb-badge--on")
          ?.textContent,
      ).toBe("Logging on");
      expect(main.querySelector(".kb-callout")).toBeNull();
    });

    it("says logging is off in a Callout that names the setting", () => {
      const main = page("Command audit, logging off");
      const callout = main.querySelector(".kb-callout");
      expect(callout?.querySelector(".kb-callout__title")).not.toBeNull();
      expect(callout?.textContent).toContain("core.command_audit.enabled");
      expect(callout?.textContent).toContain("in the settings below");
    });

    it("puts the invocations in a Panel with a DataTable and a footer pager", () => {
      const main = page("Command audit, a page of rows");
      const panel = main.querySelector("section.kb-panel#audit-invocations");
      expect(panel).not.toBeNull();
      expect(
        panel?.querySelector(".kb-panel__body--flush table.kb-table"),
      ).not.toBeNull();
      expect(texts(panel?.querySelectorAll("thead th") ?? undefined)).toEqual([
        "When",
        "User",
        "Command",
        "Channel",
        "Result",
        "Duration",
        "Error",
      ]);
      expect(
        texts(panel?.querySelectorAll("tbody .kb-badge") ?? undefined),
      ).toEqual(["success", "denied", "error"]);
      expect(panel?.querySelector("tbody .kb-badge--on")?.textContent).toBe(
        "success",
      );
      expect(panel?.querySelector("tbody .kb-badge--warn")?.textContent).toBe(
        "denied",
      );
      expect(panel?.querySelector("tbody .kb-badge--off")?.textContent).toBe(
        "error",
      );
      expect(panel?.querySelector("td.kb-num")?.textContent).toBe("12ms");
      expect(
        panel?.querySelector("footer.kb-panel__foot")?.textContent,
      ).toContain("Page 2 of 3");
      const next = Array.from(
        panel?.querySelectorAll("footer a.kb-btn") ?? [],
      ).find((a) => a.textContent?.includes("Next"));
      expect(next?.getAttribute("href")).toBe(
        "/admin/audit/commands?command=quote&result=error&page=3",
      );
    });

    it("labels every filter as a Field and keeps the form a GET with its names", () => {
      const main = page("Command audit, a page of rows");
      const form = main.querySelector('form[method="GET"]');
      expect(form?.getAttribute("action")).toBe("/admin/audit/commands");
      for (const name of ["command", "user", "result", "from", "to"]) {
        const control = form?.querySelector(`[name=${name}]`);
        expect(control).not.toBeNull();
        const id = control?.getAttribute("id") ?? "";
        expect(id).not.toBe("");
        expect(form?.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
        expect(
          form?.querySelector(`label.kb-label[for="${id}"]`),
        ).not.toBeNull();
      }
      expect(
        form?.querySelector("select.kb-select[name=command]"),
      ).not.toBeNull();
      expect(form?.querySelector("input.kb-input[name=from]")).not.toBeNull();
      expect(
        form?.querySelector('a.kb-btn[href="/admin/audit/commands"]')
          ?.textContent,
      ).toBe("Reset");
    });

    it("shows an EmptyState that says how rows arrive", () => {
      const main = page("Command audit, empty");
      expect(
        main.querySelector(".kb-empty .kb-empty__title")?.textContent,
      ).toBe("No command invocations match the current filters.");
      expect(
        main.querySelector(".kb-empty .kb-empty__text")?.textContent,
      ).toContain("run");
      expect(main.querySelector("table")).toBeNull();
    });
  });

  describe("Command metrics", () => {
    it("leads with the window tabs and three StatTiles that link to their panels", () => {
      const main = page("Command metrics, with data");
      expect(
        main.querySelector('nav.kb-tabs[aria-label="Time window"]'),
      ).not.toBeNull();
      const tiles = main.querySelectorAll(".kb-tiles a.kb-tile");
      expect(tiles).toHaveLength(3);
      expect(texts(main.querySelectorAll(".kb-tile .kb-overline"))).toEqual([
        "Invocations",
        "Errors",
        "Error rate",
      ]);
      expect(texts(main.querySelectorAll(".kb-tile__value"))).toEqual([
        "160",
        "31",
        "19.4%",
      ]);
      tiles.forEach((t) => {
        const id = t.getAttribute("href")?.slice(1) ?? "";
        expect(
          main.querySelector(`section.kb-panel[id="${id}"]`),
        ).not.toBeNull();
      });
      expect(main.querySelector(".kb-tile--warn")).not.toBeNull();
    });

    it("shows no warn tile and a dash for the rate when nothing was recorded", () => {
      const main = page("Command metrics, empty");
      expect(main.querySelector(".kb-tile--warn")).toBeNull();
      expect(texts(main.querySelectorAll(".kb-tile__value"))).toEqual([
        "0",
        "0",
        "—",
      ]);
    });

    it("puts the error spotlight first when a command is over the threshold", () => {
      const withErrors = page("Command metrics, with data");
      expect(texts(withErrors.querySelectorAll("h2.kb-panel__title"))).toEqual([
        "Error spotlight",
        "Commands by usage",
        "Slowest commands",
        "Usage trend",
      ]);
      const quiet = page(
        "Command metrics, no command above the error threshold",
      );
      expect(texts(quiet.querySelectorAll("h2.kb-panel__title"))).toEqual([
        "Commands by usage",
        "Error spotlight",
        "Slowest commands",
        "Usage trend",
      ]);
    });

    it("draws the tables as DataTables with Badges and right-aligned numbers", () => {
      const main = page("Command metrics, with data");
      const usage = main.querySelector("section#metrics-usage");
      expect(texts(usage?.querySelectorAll("thead th") ?? undefined)).toEqual([
        "Command",
        "Invocations",
        "Error rate",
        "Avg response",
        "Last used",
      ]);
      expect(usage?.querySelector("tbody th.kb-mono")?.textContent).toBe(
        "/quote",
      );
      expect(usage?.querySelector("tbody .kb-badge--off")?.textContent).toBe(
        "30.0%",
      );
      expect(usage?.querySelector("tbody .kb-badge--warn")?.textContent).toBe(
        "2.0%",
      );
      expect(usage?.querySelector("tbody .kb-badge--on")?.textContent).toBe(
        "0%",
      );
      expect(usage?.querySelector("tbody td.kb-num")?.textContent).toBe("100");
    });

    it("says in words, with no emoji, that no command is over the threshold", () => {
      const main = page(
        "Command metrics, no command above the error threshold",
      );
      const panel = main.querySelector("section#metrics-errors");
      expect(panel?.querySelector(".kb-empty__title")?.textContent).toBe(
        "No command exceeded a 10.0% error rate.",
      );
      expect(panel?.textContent).not.toContain("🎉");
      expect(main.querySelector(".kb-tile--warn")).toBeNull();
    });

    it("names the busiest day in the trend panel's footer", () => {
      const main = page("Command metrics, with data");
      const trend = main.querySelector("section#metrics-trend");
      expect(trend?.querySelector(".kb-bars__row.is-peak")).not.toBeNull();
      expect(trend?.querySelector("footer.kb-panel__foot")?.textContent).toBe(
        "Busiest day: 2026-05-08, 20 invocations.",
      );
    });

    it("says recording is off in a Callout", () => {
      const main = page("Command metrics, recording off");
      const callout = main.querySelector(".kb-callout");
      expect(callout?.textContent).toContain(
        "monitoring.metrics_persistence.enabled",
      );
      expect(
        main.querySelector("header.kb-pagehead .kb-badge--off")?.textContent,
      ).toBe("Recording off");
    });
  });

  describe("Voice analytics", () => {
    it("leads with the window tabs and StatTiles for the total, the busiest slot and the zone", () => {
      const main = page("Voice analytics, with data");
      expect(
        main.querySelector('nav.kb-tabs[aria-label="Time window"]'),
      ).not.toBeNull();
      expect(texts(main.querySelectorAll(".kb-tile .kb-overline"))).toEqual([
        "Total voice time",
        "Busiest slot",
        "Timezone",
      ]);
      expect(texts(main.querySelectorAll(".kb-tile__value"))).toEqual([
        "4 hr 10 min",
        "Friday 10 PM",
        "UTC",
      ]);
    });

    it("draws the hour by weekday grid as a Heatmap that names its peak", () => {
      const main = page("Voice analytics, with data");
      const grid = main.querySelector("div.kb-heatmap[role=img]");
      expect(grid?.getAttribute("aria-label")).toBe(
        "Voice activity heatmap by weekday and hour of day. Busiest slot: Friday at 10 PM. Per-weekday and per-hour totals are listed below.",
      );
      expect(grid?.querySelectorAll(".kb-heatmap__col")).toHaveLength(24);
      expect(grid?.querySelectorAll(".kb-heatmap__row")).toHaveLength(7);
      expect(grid?.querySelectorAll(".kb-heatmap__cell")).toHaveLength(168);
      const peak = grid?.querySelectorAll(".kb-heatmap__cell.is-peak");
      expect(peak).toHaveLength(1);
      expect(peak?.[0].getAttribute("data-l")).toBe("4");
      expect(peak?.[0].getAttribute("title")).toBe(
        "Friday 10 PM — 3 hr 20 min",
      );
      // Monday 9 AM is a quarter of the peak: level 1; an empty cell is level 0.
      const cells = grid?.querySelectorAll(".kb-heatmap__cell");
      expect(cells?.[1 * 24 + 9].getAttribute("data-l")).toBe("1");
      expect(cells?.[0].getAttribute("data-l")).toBe("0");
      expect(grid?.querySelector("[style]")).toBeNull();
    });

    it("pairs the grid with a bar list per weekday and per hour, each marking its top row", () => {
      const main = page("Voice analytics, with data");
      const day = main.querySelector("section#voice-weekday .kb-bars");
      const hour = main.querySelector("section#voice-hour .kb-bars");
      expect(day?.querySelectorAll(".kb-bars__row")).toHaveLength(7);
      expect(hour?.querySelectorAll(".kb-bars__row")).toHaveLength(24);
      expect(day?.querySelector(".is-peak .kb-bars__val")?.textContent).toBe(
        "3 hr 20 min",
      );
      expect(hour?.querySelector(".is-peak span")?.textContent).toBe("10 PM");
    });

    it("says in a Callout that tracking is off, and shows an EmptyState instead of a grid", () => {
      const main = page("Voice analytics, empty and off");
      expect(main.querySelector(".kb-callout")?.textContent).toContain(
        "voicetracking.enabled",
      );
      expect(
        main.querySelector("section#voice-heatmap .kb-empty__title")
          ?.textContent,
      ).toBe("No voice activity recorded in the last 30 days.");
      expect(main.querySelector(".kb-heatmap")).toBeNull();
    });

    it("shows no Callout while tracking is on", () => {
      expect(
        page("Voice analytics, with data").querySelector(".kb-callout"),
      ).toBeNull();
    });
  });

  describe("Database", () => {
    it("leads with StatTiles for the connection, the cleanup and the documents", () => {
      const main = page("Database, connected");
      expect(texts(main.querySelectorAll(".kb-tile .kb-overline"))).toEqual([
        "Connection",
        "Voice-tracking cleanup",
        "Documents (est.)",
      ]);
      expect(texts(main.querySelectorAll(".kb-tile__value"))).toEqual([
        "connected",
        "On",
        "50",
      ]);
      expect(main.querySelector(".kb-tile--warn")).toBeNull();
    });

    it("turns the connection tile into a problem when the database is not connected", () => {
      const main = page("Database, not connected, nothing recorded");
      const warn = main.querySelector(".kb-tile--warn");
      expect(warn?.querySelector(".kb-overline")?.textContent).toBe(
        "Connection",
      );
      expect(warn?.querySelector(".kb-tile__value")?.textContent).toBe(
        "disconnected",
      );
    });

    it("shows the cleanup as a KeyValue with Badges and keeps Run cleanup now behind its confirmation", () => {
      const main = page("Database, connected");
      const panel = main.querySelector("section#db-cleanup");
      const kv = panel?.querySelector("dl.kb-kv");
      expect(texts(kv?.querySelectorAll("dt") ?? undefined)).toEqual([
        "Feature",
        "Schedule",
        "Scheduled",
        "Currently running",
        "Last run",
        "Detailed sessions retention",
        "Monthly summaries retention",
        "Yearly summaries retention",
      ]);
      expect(kv?.querySelector("dd .kb-badge--on")?.textContent).toBe(
        "enabled",
      );
      expect(kv?.querySelector("dd.kb-mono")?.textContent).toBe("0 0 * * *");
      expect(kv?.textContent).toContain("keep forever");
      const form = panel?.querySelector(
        'form[method="POST"][action="/admin/database/run-cleanup"]',
      );
      expect(form?.getAttribute("data-confirm")).toBe(
        "Run voice-channel data cleanup now?",
      );
      expect(form?.querySelector('input[name="_csrf"]')).not.toBeNull();
      const run = form?.querySelector("button.kb-btn.kb-btn--primary");
      expect(run?.textContent).toBe("Run cleanup now");
      expect(run?.hasAttribute("disabled")).toBe(false);
    });

    it("disables Run cleanup now and says why while the feature is off", () => {
      const main = page("Database, not connected, nothing recorded");
      const form = main.querySelector(
        'form[action="/admin/database/run-cleanup"]',
      );
      expect(form?.querySelector("button")?.hasAttribute("disabled")).toBe(
        true,
      );
      expect(form?.querySelector(".kb-help")?.textContent).toContain(
        "voicetracking.cleanup.enabled",
      );
    });

    it("folds the cleanup history, counts it and marks a failed run", () => {
      const main = page("Database, connected");
      const panel = main.querySelector("section#db-history");
      const fold = panel?.querySelector("details.kb-disclosure");
      expect(fold).not.toBeNull();
      expect(fold?.hasAttribute("open")).toBe(false);
      expect(fold?.querySelector("summary .kb-badge--count")?.textContent).toBe(
        "2",
      );
      expect(
        texts(fold?.querySelectorAll("tbody .kb-badge") ?? undefined),
      ).toEqual(["ok", "failed"]);
      expect(fold?.querySelector("tbody .kb-badge--off")?.textContent).toBe(
        "failed",
      );
      expect(fold?.textContent).toContain("2: boom");
    });

    it("lists the collections as a DataTable with right-aligned counts", () => {
      const main = page("Database, connected");
      const panel = main.querySelector("section#db-collections");
      expect(texts(panel?.querySelectorAll("thead th") ?? undefined)).toEqual([
        "Collection",
        "Documents (est.)",
      ]);
      expect(panel?.querySelector("tbody th.kb-mono")?.textContent).toBe(
        "configs",
      );
      expect(panel?.querySelector("tbody td.kb-num")?.textContent).toBe("42");
    });

    it("shows EmptyStates for no history and no collections", () => {
      const main = page("Database, not connected, nothing recorded");
      expect(
        texts(main.querySelectorAll(".kb-empty .kb-empty__title")),
      ).toEqual([
        "No prior cleanup runs recorded.",
        "No collection statistics available.",
      ]);
      expect(main.querySelector("table")).toBeNull();
    });
  });

  describe("Presence", () => {
    it("writes the explanation as help text under the header", () => {
      const main = page("Presence");
      expect(main.querySelector("p.kb-help")?.textContent).toContain("Move up");
      expect(main.querySelector("#reorder-status")).not.toBeNull();
    });

    it("keeps the string-list editor (#1642) below the header", () => {
      const html = renderBotStatusPage({
        ...BOT_STATUS,
        pools: [
          {
            pool: "playing",
            label: "Playing",
            description: "d",
            requiresCount: false,
            items: [{ id: "a", order: 0, text: "Hello" }],
            usingDefaults: false,
            exportText: "Hello",
          } as BotStatusProps["pools"][number],
        ],
      });
      const main = mainOf(html);
      expect(main.querySelector("header.kb-pagehead h1")?.textContent).toBe(
        "Presence",
      );
      expect(main.querySelector('form[action$="/add"]')).not.toBeNull();
    });
  });

  describe("Top bar version pills", () => {
    afterEach(() => setAdminUpdateBadgeProvider(null));

    it("draws the running version and the update link with kb- classes only", () => {
      setAdminUpdateBadgeProvider(() => ({ latest: "9.9.9", kind: "major" }));
      const html = renderAdminPage({
        title: "Database",
        active: "/admin/database",
        body: "<p>x</p>",
        ...COMMON,
      });
      const doc = new DOMParser().parseFromString(html, "text/html");
      const bar = doc.querySelector("header.kb-topbar");
      const pills = Array.from(bar?.querySelectorAll(".kb-pill") ?? []);
      expect(pills.length).toBe(2);
      expect(pills[1].classList.contains("kb-pill--info")).toBe(true);
      const old = new Set<string>();
      pills.forEach((p) =>
        p.classList.forEach((c) => {
          if (!c.startsWith("kb-")) old.add(c);
        }),
      );
      expect([...old]).toEqual([]);
    });
  });
});
