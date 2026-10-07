/**
 * The Cases section of the Moderation page (#908): what each card shows, which
 * actions a card offers, that nothing renders while the lifecycle is off, and
 * that member-controlled text is escaped.
 */

import { describe, it, expect, jest } from "@jest/globals";
import { renderModerationPage } from "../../src/web/admin-views.js";
import {
  buildCaseGroups,
  loadCaseHistory,
  loadModerationCaseData,
  CASE_HISTORY_LIMIT,
  CASE_HISTORY_CONCURRENCY,
  type CaseGroups,
  type CaseView,
} from "../../src/web/moderation-case-groups.js";
import type { CaseQueue } from "../../src/services/moderation-case-service.js";

const COMMON = { csrfToken: "tok-123", remainingMs: 60_000 };

const baseProps = {
  ...COMMON,
  enabled: true,
  actionOptions: ["kick" as const, "ban" as const],
  userOptions: [],
  filters: { action: "", userId: "" },
  total: 0,
  page: 1,
  pageSize: 50,
};

const row = (over: Record<string, unknown> = {}) => ({
  entryId: "entry-1",
  caseNumber: null,
  caseStatus: null,
  createdAt: "2026-01-12T00:00:00.000Z",
  userId: "u1",
  userLabel: "Member One",
  moderatorId: "m1",
  moderatorLabel: "Mod",
  action: "kick" as const,
  reason: "spam",
  source: "audit" as const,
  ...over,
});

const card = (over: Partial<CaseView> = {}): CaseView => ({
  id: "case-1",
  caseNumber: 14,
  userId: "u1",
  userLabel: "Member One",
  action: "ban",
  status: "under_review",
  reviewAt: "2026-03-12T09:00:00.000Z",
  openedAt: "2026-01-12T00:00:00.000Z",
  openedByLabel: "Staff",
  originModeratorLabel: "Mod",
  reason: "Repeated spam",
  events: [
    {
      at: "2026-01-12T00:00:00.000Z",
      byLabel: "Staff",
      to: "open",
      outcome: null,
      note: "first look",
    },
  ],
  history: [
    { createdAt: "2025-11-01T00:00:00.000Z", action: "warn", reason: "caps" },
  ],
  live: true,
  ...over,
});

const groups = (over: Partial<CaseGroups> = {}): CaseGroups => ({
  overdue: [],
  dueSoon: [],
  indefinite: [],
  recentlyResolved: [],
  ...over,
});

const render = (over: Record<string, unknown> = {}): string =>
  renderModerationPage({ ...baseProps, rows: [], ...over } as never);

describe("Cases section", () => {
  it("renders nothing while the lifecycle is off", () => {
    const html = render({
      casesEnabled: false,
      caseGroups: groups({ overdue: [card()] }),
      rows: [row()],
    });
    expect(html).not.toContain("Case #14");
    expect(html).not.toContain("/admin/moderation/cases/");
    expect(html).not.toContain('<th scope="col">Case</th>');
  });

  it("groups cases and counts each group", () => {
    const html = render({
      casesEnabled: true,
      caseGroups: groups({
        overdue: [card()],
        dueSoon: [card({ id: "c2", caseNumber: 15, status: "open" })],
        recentlyResolved: [
          card({ id: "c3", caseNumber: 16, status: "lifted", live: false }),
        ],
      }),
    });
    expect(html).toContain("<h3>Overdue (1)</h3>");
    expect(html).toContain("<h3>Due soon (1)</h3>");
    expect(html).toContain("<h3>No review date (0)</h3>");
    expect(html).toContain("<h3>Recently resolved (1)</h3>");
    expect(html).toContain("No open case is without a review date.");
  });

  it("shows the member, the original reason, and their prior history", () => {
    const html = render({
      casesEnabled: true,
      caseGroups: groups({ overdue: [card()] }),
    });
    expect(html).toContain("Case #14");
    expect(html).toContain("Member One");
    expect(html).toContain("Repeated spam");
    expect(html).toContain("Prior history");
    expect(html).toContain("2025-11-01");
    expect(html).toContain("caps");
  });

  it("offers the four decisions on a live case, each CSRF-protected", () => {
    const html = render({
      casesEnabled: true,
      caseGroups: groups({ overdue: [card()] }),
    });
    expect(html).toContain('action="/admin/moderation/cases/case-1/uphold"');
    for (const decision of ["extend", "permanent", "readmit"]) {
      expect(html).toContain(
        `formaction="/admin/moderation/cases/case-1/${decision}"`,
      );
    }
    expect(html).toContain('name="_csrf" value="tok-123"');
    // The destructive ones ask first, and readmit says it does not unban.
    expect(html).toContain("Make this removal permanent?");
    expect(html).toContain("KoolBot does not unban in Discord");
  });

  it("offers no actions on a resolved case", () => {
    const html = render({
      casesEnabled: true,
      caseGroups: groups({
        recentlyResolved: [card({ status: "lifted", live: false })],
      }),
    });
    expect(html).toContain("Case #14");
    expect(html).not.toContain("/admin/moderation/cases/case-1/");
  });

  it("says when the queue could not be read, and still offers the review button", () => {
    const html = render({ casesEnabled: true, caseGroups: null });
    expect(html).toContain("The case queue could not be read");
    expect(html).toContain("/admin/moderation/cases/run-review");
  });

  it("escapes member-controlled text", () => {
    const evil = '<img src=x onerror="alert(1)">';
    const html = render({
      casesEnabled: true,
      caseGroups: groups({
        overdue: [
          card({
            userLabel: evil,
            reason: evil,
            events: [
              {
                at: "2026-01-12T00:00:00.000Z",
                byLabel: evil,
                to: "open",
                outcome: null,
                note: evil,
              },
            ],
            history: [
              {
                createdAt: "2025-11-01T00:00:00.000Z",
                action: "warn",
                reason: evil,
              },
            ],
          }),
        ],
      }),
    });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("Case column", () => {
  const withRows = (rows: unknown[], extra: Record<string, unknown> = {}) =>
    render({
      casesEnabled: true,
      caseGroups: groups(),
      rows,
      defaultReviewDays: 45,
      ...extra,
    });

  it("offers an Open case form on a kick or ban, pre-filled from the default window", () => {
    const html = withRows([row(), row({ entryId: "entry-2", action: "ban" })]);
    expect(
      html.match(/action="\/admin\/moderation\/cases\/open"/g),
    ).toHaveLength(2);
    expect(html).toContain('name="entry_id" value="entry-1"');
    expect(html).toContain('name="entry_id" value="entry-2"');
    expect(html).toContain(
      'name="review_in_days" min="1" max="3650" value="45"',
    );
  });

  it("offers nothing on a warn, a timeout or an unban", () => {
    for (const action of ["warn", "timeout", "untimeout", "unban"]) {
      expect(withRows([row({ action })])).not.toContain("cases/open");
    }
  });

  it("shows the case number and status instead of the form once a case exists", () => {
    const html = withRows([
      row({ caseNumber: 14, caseStatus: "under_review" }),
    ]);
    expect(html).toContain("#14");
    expect(html).toContain("under review");
    expect(html).not.toContain("cases/open");
  });

  it("omits the column while the lifecycle is off", () => {
    expect(render({ casesEnabled: false, rows: [row()] })).not.toContain(
      '<th scope="col">Case</th>',
    );
  });
});

describe("buildCaseGroups", () => {
  const at = new Date("2026-03-12T09:00:00Z");
  const doc = (over: Record<string, unknown> = {}) =>
    ({
      _id: "case-1",
      caseNumber: 14,
      userId: "u1",
      originEntryId: "entry-1",
      action: "ban",
      status: "under_review",
      reviewAt: at,
      openedAt: new Date("2026-01-12T00:00:00Z"),
      originModeratorId: "m1",
      openedByUserId: "staff-1",
      events: [
        {
          at: new Date("2026-01-12T00:00:00Z"),
          byUserId: "staff-1",
          from: "open",
          to: "open",
          outcome: null,
          note: null,
        },
        {
          at,
          byUserId: "system",
          from: "open",
          to: "under_review",
          outcome: null,
          note: "Review came due",
        },
      ],
      ...over,
    }) as never;

  const labelOf = (id: string | null): string =>
    id ? `label:${id}` : "Unknown";
  const queue = (over: Partial<CaseQueue> = {}): CaseQueue => ({
    overdue: [],
    dueSoon: [],
    indefinite: [],
    recentlyResolved: [],
    ...over,
  });

  it("joins the origin reason and the member's history, and labels the actors", () => {
    const built = buildCaseGroups(
      queue({ overdue: [doc()] }),
      new Map([["entry-1", { reason: "Repeated spam" } as never]]),
      new Map([
        [
          "case-1",
          [
            {
              createdAt: new Date("2025-11-01T00:00:00Z"),
              action: "warn",
              reason: "caps",
            } as never,
          ],
        ],
      ]),
      labelOf,
    );
    const view = built.overdue[0];
    expect(view).toMatchObject({
      caseNumber: 14,
      userLabel: "label:u1",
      reason: "Repeated spam",
      openedByLabel: "label:staff-1",
      originModeratorLabel: "label:m1",
      reviewAt: at.toISOString(),
      live: true,
    });
    expect(view.history).toEqual([
      { createdAt: "2025-11-01T00:00:00.000Z", action: "warn", reason: "caps" },
    ]);
    // The review job is not a member, so it is shown as KoolBot.
    expect(view.events.map((e) => e.byLabel)).toEqual([
      "label:staff-1",
      "KoolBot",
    ]);
  });

  it("marks terminal cases as not live and copes with a missing origin entry", () => {
    const built = buildCaseGroups(
      queue({ recentlyResolved: [doc({ status: "lifted", reviewAt: null })] }),
      new Map(),
      new Map(),
      labelOf,
    );
    expect(built.recentlyResolved[0]).toMatchObject({
      live: false,
      reviewAt: null,
      reason: null,
      history: [],
    });
  });

  it("bounds how many history reads are in flight at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const getHistory = jest.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return [];
    });
    const many = Array.from(
      { length: CASE_HISTORY_CONCURRENCY * 3 + 4 },
      (_, i) => doc({ _id: `c${i}`, originEntryId: `e${i}` }),
    );

    const result = await loadCaseHistory(
      { getHistory } as never,
      "g1",
      many,
      new Map(),
    );

    expect(getHistory).toHaveBeenCalledTimes(many.length);
    expect(peak).toBeLessThanOrEqual(CASE_HISTORY_CONCURRENCY);
    expect(result.size).toBe(many.length);
  });

  it("reads history per case, cut off at that case's origin entry, and survives a failed read", async () => {
    const getHistory = jest.fn(async (_g: string, userId: string) => {
      if (userId === "bad") throw new Error("mongo down");
      return [{ action: "warn" }];
    });
    const older = new Date("2026-01-12T00:00:00Z");
    const newer = new Date("2026-06-01T00:00:00Z");
    const origins = new Map([
      ["entry-a", { createdAt: older } as never],
      ["entry-b", { createdAt: newer } as never],
    ]);
    const result = await loadCaseHistory(
      { getHistory } as never,
      "g1",
      [
        doc({ _id: "c1", userId: "u1", originEntryId: "entry-a" }),
        // A second case for the same member gets its own cutoff.
        doc({ _id: "c2", userId: "u1", originEntryId: "entry-b" }),
        doc({ _id: "c3", userId: "bad", originEntryId: "entry-gone" }),
      ],
      origins,
    );

    expect(getHistory).toHaveBeenCalledTimes(3);
    expect(getHistory).toHaveBeenCalledWith("g1", "u1", {
      limit: CASE_HISTORY_LIMIT,
      skip: 0,
      before: older,
    });
    expect(getHistory).toHaveBeenCalledWith("g1", "u1", {
      limit: CASE_HISTORY_LIMIT,
      skip: 0,
      before: newer,
    });
    // No origin row, so no cutoff to apply.
    expect(getHistory).toHaveBeenCalledWith("g1", "bad", {
      limit: CASE_HISTORY_LIMIT,
      skip: 0,
      before: undefined,
    });
    expect(result.get("c1")).toHaveLength(1);
    expect(result.get("c3")).toEqual([]);
  });
});

describe("loadModerationCaseData", () => {
  const queued = { _id: "c1", userId: "u1", originEntryId: "e1", events: [] };
  const queue: CaseQueue = {
    overdue: [queued as never],
    dueSoon: [],
    indefinite: [],
    recentlyResolved: [],
  };
  const fakeServices = (over: Record<string, unknown> = {}) => {
    const caseService = {
      isEnabled: jest.fn(async () => true),
      getQueue: jest.fn(async () => queue),
      getCasesForEntries: jest.fn(
        async () => new Map([["e9", { caseNumber: 3 }]]),
      ),
      getDefaultReviewDays: jest.fn(async () => 45),
      getOriginEntries: jest.fn(
        async () => new Map([["e1", { reason: "spam" }]]),
      ),
      ...over,
    };
    const moderationService = {
      getHistory: jest.fn(async () => [{ action: "warn" }]),
    };
    return { caseService, moderationService };
  };
  const load = (services: ReturnType<typeof fakeServices>, enabled = true) =>
    loadModerationCaseData({
      caseService: services.caseService as never,
      moderationService: services.moderationService as never,
      guildId: "g1",
      enabled,
      entryIds: ["e9" as never],
    });

  it("loads the queue, the page's cases, origins and history when both gates are on", async () => {
    const services = fakeServices();
    const data = await load(services);
    expect(data).toMatchObject({
      casesEnabled: true,
      defaultReviewDays: 45,
      queue,
    });
    expect(data.casesByEntry.get("e9")).toMatchObject({ caseNumber: 3 });
    expect(data.originEntries.get("e1")).toMatchObject({ reason: "spam" });
    expect(data.queueHistory.get("c1")).toHaveLength(1);
    expect(services.caseService.getCasesForEntries).toHaveBeenCalledWith("g1", [
      "e9",
    ]);
  });

  it.each([
    ["the master gate is off", false, true],
    ["the case gate is off", true, false],
  ])("queries nothing when %s", async (_label, master, cases) => {
    const services = fakeServices({ isEnabled: jest.fn(async () => cases) });
    const data = await load(services, master);
    expect(data.casesEnabled).toBe(false);
    expect(data.queue).toBeNull();
    expect(services.caseService.getQueue).not.toHaveBeenCalled();
    expect(services.caseService.getCasesForEntries).not.toHaveBeenCalled();
    expect(services.moderationService.getHistory).not.toHaveBeenCalled();
  });

  it("keeps the log table usable when the queue cannot be read", async () => {
    const services = fakeServices({
      getQueue: jest.fn(async () => {
        throw new Error("mongo down");
      }),
    });
    const data = await load(services);
    expect(data.casesEnabled).toBe(true);
    expect(data.queue).toBeNull();
    expect(data.casesByEntry.get("e9")).toMatchObject({ caseNumber: 3 });
  });
});
