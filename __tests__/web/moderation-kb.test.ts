/**
 * @jest-environment <rootDir>/__tests__/jsdom-node-env.cjs
 */
/* global DOMParser, Element */

/**
 * The Moderation page and its case cards are built from the kb- components
 * (#1645): PageHeader, Panel, DataTable, EmptyState, Callout, Button,
 * Disclosure, Field, KeyValue and Badge. No class from the old inline `STYLE`
 * set is left in `renderModerationPage` or its case helpers, and the routes,
 * field names and confirmation dialogs are unchanged. The folded Settings card
 * and the flash are shared helpers that other issues move, so the pages here
 * are drawn with no settings rows and no flash.
 */

import { describe, it, expect } from "@jest/globals";
import { renderModerationPage } from "../../src/web/admin-views.js";
import type {
  CaseGroups,
  CaseView,
} from "../../src/web/moderation-case-groups.js";

const BASE = {
  csrfToken: "csrf",
  remainingMs: 600_000,
  enabled: true,
  actionOptions: ["warn" as const, "kick" as const, "ban" as const],
  userOptions: [{ id: "u1", label: "alice" }],
  settingRows: [],
  filters: { action: "", userId: "" },
  rows: [],
  total: 0,
  page: 1,
  pageSize: 50,
  casesEnabled: false,
};

const row = (over: Record<string, unknown> = {}) => ({
  entryId: "a".repeat(24),
  caseNumber: null,
  caseStatus: null,
  createdAt: "2026-01-09 12:00",
  userId: "u1",
  userLabel: "alice",
  moderatorId: "u2",
  moderatorLabel: "bob",
  action: "kick" as const,
  reason: "spam",
  source: "command" as const,
  ...over,
});

const card = (over: Partial<CaseView> = {}): CaseView => ({
  id: "case-1",
  caseNumber: 14,
  userId: "u1",
  userLabel: "alice",
  action: "ban",
  status: "under_review",
  reviewAt: "2026-03-12T09:00:00.000Z",
  openedAt: "2026-01-12T00:00:00.000Z",
  openedByLabel: "Staff",
  originModeratorLabel: "bob",
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
  scheduled: [],
  indefinite: [],
  recentlyResolved: [],
  ...over,
});

const page = (over: Record<string, unknown> = {}): string =>
  renderModerationPage({ ...BASE, ...over } as never);

const PAGES: ReadonlyArray<{ name: string; html: string }> = [
  { name: "log empty, cases off", html: page({ enabled: false }) },
  {
    name: "log with rows, cases off",
    html: page({
      rows: [row(), row({ action: "unban", moderatorId: null })],
      total: 120,
      page: 2,
      filters: { action: "kick", userId: "u1" },
    }),
  },
  {
    name: "cases on, queue empty",
    html: page({
      casesEnabled: true,
      caseGroups: groups(),
      defaultReviewDays: 90,
    }),
  },
  {
    name: "cases on, queue unreadable",
    html: page({ casesEnabled: true, caseGroups: null }),
  },
  {
    name: "cases on, every group filled",
    html: page({
      casesEnabled: true,
      defaultReviewDays: 90,
      caseGroups: groups({
        overdue: [card()],
        dueSoon: [card({ id: "c2", caseNumber: 15, status: "open" })],
        scheduled: [card({ id: "c3", caseNumber: 16, status: "open" })],
        indefinite: [
          card({ id: "c4", caseNumber: 17, status: "open", reviewAt: null }),
        ],
        recentlyResolved: [
          card({
            id: "c5",
            caseNumber: 18,
            status: "lifted",
            live: false,
            reason: null,
            history: [],
          }),
        ],
      }),
      rows: [
        row(),
        row({
          entryId: "b".repeat(24),
          caseNumber: 14,
          caseStatus: "under_review",
        }),
        row({ entryId: "c".repeat(24), action: "warn" }),
      ],
    }),
  },
  {
    name: "open case refused",
    html: page({
      casesEnabled: true,
      caseGroups: groups(),
      rows: [row()],
      total: 1,
      refusedForm: {
        formId: `moderation-case-open-${"a".repeat(24)}`,
        errors: { review_in_days: "Review days must be a whole number." },
        values: { review_in_days: "0", note: "x" },
      },
    }),
  },
  {
    name: "decision refused",
    html: page({
      casesEnabled: true,
      caseGroups: groups({ overdue: [card()] }),
      refusedForm: {
        formId: "moderation-case-decide-case-1",
        errors: { next_review_in_days: "Review days must be a whole number." },
        values: { next_review_in_days: "0", note: "n" },
      },
    }),
  },
];

/** The classes of the old inline `STYLE` set that this page used. */
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
];

function mainOf(html: string): Element {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const main = doc.querySelector("main");
  if (!main) throw new Error("no main element");
  return main;
}

describe("Moderation page and case cards on the kb- components (#1645)", () => {
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
        main.querySelector("header.kb-pagehead h1.kb-pagehead__title")
          ?.textContent,
      ).toBe("Moderation log");
      expect(
        main.querySelector("header.kb-pagehead .kb-statusline"),
      ).not.toBeNull();
    },
  );

  it.each(PAGES)("$name has no primary button of its own", ({ html }) => {
    const own = Array.from(
      mainOf(html).querySelectorAll(".kb-btn--primary"),
    ).filter((b) => !b.closest("dialog, .kb-savebar, .kb-callout"));
    expect(own.map((b) => b.textContent?.trim())).toEqual([]);
  });

  it.each(PAGES)("$name gives every form control a label", ({ html }) => {
    const main = mainOf(html);
    main
      .querySelectorAll("input:not([type=hidden]), select, textarea")
      .forEach((el) => {
        if (el.closest(".kb-settings, [data-settings-fold]")) return;
        const id = el.getAttribute("id");
        const labelled =
          (id && main.querySelector(`label[for="${id}"]`) !== null) ||
          el.getAttribute("aria-label") !== null;
        expect(labelled).toBe(true);
      });
  });

  it("puts the log in a Panel with a DataTable, filters and a footer pager", () => {
    const main = mainOf(PAGES[1].html);
    const panel = main.querySelector("section.kb-panel#moderation-actions");
    expect(panel).not.toBeNull();
    expect(
      panel?.querySelector(".kb-panel__body--flush table.kb-table"),
    ).not.toBeNull();
    expect(
      panel?.querySelector("form[role=search] select#moderation-filter-action"),
    ).not.toBeNull();
    expect(
      Array.from(panel?.querySelectorAll("thead th") ?? []).map(
        (th) => th.textContent,
      ),
    ).toEqual(["When", "User", "Action", "Moderator", "Reason", "Source"]);
    expect(
      panel?.querySelector("footer.kb-panel__foot")?.textContent,
    ).toContain("Page 2 of 3");
    const links = Array.from(
      panel?.querySelectorAll("footer a.kb-btn") ?? [],
    ).map((a) => a.getAttribute("href"));
    expect(links).toEqual([
      "/admin/moderation?action=kick&user=u1",
      "/admin/moderation?action=kick&user=u1&page=3",
    ]);
    expect(panel?.querySelector(".kb-badge--off")?.textContent).toBe("kick");
    expect(panel?.querySelector(".kb-badge--on")?.textContent).toBe("ban lifted");
  });

  it("shows an EmptyState when no action matches", () => {
    const main = mainOf(PAGES[0].html);
    expect(
      main.querySelector("#moderation-actions .kb-empty__title")?.textContent,
    ).toBe("No moderation actions match the current filters.");
    expect(
      main.querySelector("#moderation-actions .kb-empty__text")?.textContent,
    ).toContain("/warn");
  });

  it("makes each queue group its own Panel, with an EmptyState when it has no case", () => {
    const empty = mainOf(PAGES[2].html);
    const ids = Array.from(
      empty.querySelectorAll("section.kb-panel[id^=cases-]"),
    ).map((p) => p.id);
    expect(ids).toEqual([
      "cases-overdue",
      "cases-soon",
      "cases-later",
      "cases-undated",
      "cases-closed",
    ]);
    expect(
      empty.querySelectorAll("section[id^=cases-] .kb-empty"),
    ).toHaveLength(5);
    expect(empty.querySelector("#cases-h")?.textContent).toBe("Cases");
    const run = empty.querySelector(
      '#cases .kb-panel__actions form[action="/admin/moderation/cases/run-review"]',
    );
    expect(run?.getAttribute("data-confirm")).toContain("Mark every case");
    expect(run?.querySelector("button.kb-btn")?.textContent).toBe(
      "Check review dates now",
    );
  });

  it("says in a Callout that the queue could not be read", () => {
    const main = mainOf(PAGES[3].html);
    const callout = main.querySelector(
      "#cases .kb-callout.kb-callout--err[role=alert]",
    );
    expect(callout?.querySelector(".kb-callout__title")?.textContent).toBe(
      "The case queue could not be read.",
    );
    expect(main.querySelector("section[id^=cases-]")).toBeNull();
  });

  it("draws a case as a nested Panel with KeyValue facts and folded history", () => {
    const main = mainOf(PAGES[4].html);
    const panel = main.querySelector("#cases-overdue section.kb-panel");
    expect(panel?.querySelector("h3.kb-panel__title")?.textContent).toContain(
      "Case #14",
    );
    const terms = Array.from(panel?.querySelectorAll("dl.kb-kv dt") ?? []).map(
      (dt) => dt.textContent,
    );
    expect(terms).toEqual(["Review", "Opened", "Action by", "Reason"]);
    const folds = Array.from(
      panel?.querySelectorAll("details.kb-disclosure > summary") ?? [],
    ).map((s) => s.textContent);
    expect(folds).toEqual(["Earlier actions", "Decisions"]);
    expect(
      panel?.querySelector("details.kb-disclosure")?.hasAttribute("open"),
    ).toBe(true);
    expect(panel?.querySelectorAll("ul.kb-list li")).toHaveLength(2);
    // The review date shows as a state, and a case with no date says so.
    expect(main.querySelector("#cases-undated dl.kb-kv dd")?.textContent).toBe(
      "no review date",
    );
    // A closed case shows when it closed, offers no decisions and says when there is no reason.
    const closed = main.querySelector("#cases-closed section.kb-panel");
    expect(closed?.querySelector("dl.kb-kv dt")?.textContent).toBe("Closed");
    expect(closed?.querySelector("form")).toBeNull();
    expect(closed?.textContent).toContain("No reason recorded.");
  });

  it("keeps the four decisions with their routes, and Permanent as the one danger button", () => {
    const form = mainOf(PAGES[4].html).querySelector(
      'form[action="/admin/moderation/cases/case-1/uphold"]',
    );
    expect(form).not.toBeNull();
    const buttons = Array.from(form?.querySelectorAll("button") ?? []);
    expect(buttons.map((b) => b.getAttribute("formaction"))).toEqual([
      null,
      "/admin/moderation/cases/case-1/extend",
      "/admin/moderation/cases/case-1/permanent",
      "/admin/moderation/cases/case-1/readmit",
    ]);
    expect(buttons.map((b) => b.classList.contains("kb-btn--danger"))).toEqual([
      false,
      false,
      true,
      false,
    ]);
    expect(buttons[2].getAttribute("data-confirm")).toContain(
      "Keep this member out for good?",
    );
    expect(buttons[3].getAttribute("data-confirm-tone")).toBe("neutral");
    expect(
      form?.querySelector('input[name="_csrf"]')?.getAttribute("value"),
    ).toBe("csrf");
  });

  it("offers Open case as a Disclosure only on a kick or ban without a case", () => {
    const main = mainOf(PAGES[4].html);
    const cells = Array.from(
      main.querySelectorAll("#moderation-actions tbody tr"),
    ).map((tr) => tr.lastElementChild);
    expect(cells[0]?.classList.contains("kb-actions")).toBe(true);
    expect(
      cells[0]?.querySelector("details.kb-disclosure summary")?.textContent,
    ).toBe("Open case for alice");
    expect(cells[0]?.querySelector("button.kb-btn--sm")?.textContent).toBe(
      "Open case",
    );
    expect(cells[1]?.textContent).toContain("#14");
    expect(cells[1]?.querySelector(".kb-badge--warn")?.textContent).toBe(
      "needs a decision",
    );
    expect(cells[2]?.textContent).toBe("—");
  });

  it("marks a refused field and links its error, and opens the refused form", () => {
    const open = mainOf(PAGES[5].html);
    const days = open.querySelector("input[name=review_in_days]");
    expect(days?.getAttribute("aria-invalid")).toBe("true");
    const describedBy = (days?.getAttribute("aria-describedby") ?? "").split(
      " ",
    );
    expect(describedBy).toHaveLength(2);
    describedBy.forEach((id) =>
      expect(open.querySelector(`[id="${id}"]`)).not.toBeNull(),
    );
    expect(
      open.querySelector(
        "details.kb-disclosure[open] input[name=review_in_days]",
      ),
    ).not.toBeNull();
    const decide = mainOf(PAGES[6].html).querySelector(
      "input[name=next_review_in_days]",
    );
    expect(decide?.getAttribute("aria-invalid")).toBe("true");
    expect(
      mainOf(PAGES[6].html).querySelector(
        `[id="${decide?.getAttribute("aria-describedby")}"]`,
      )?.textContent,
    ).toBe("Review days must be a whole number.");
  });
});
