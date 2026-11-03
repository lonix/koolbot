/**
 * @jest-environment <rootDir>/__tests__/jsdom-node-env.cjs
 */
/* global DOMParser, Document, Element */

/**
 * The member mod log pages (`me-moderation-page.ts`) and the standalone sign-in
 * and error pages (`views.ts`) are built from the kb- components (#1710): no
 * class outside the kb- set, no bare list, EmptyStates and Callouts with their
 * icon, the shared list pager, PageHeader + Panel on the standalone pages, and
 * no inline style sheet. Routes, field names, posted values, confirmations and
 * the no-JavaScript Review form are unchanged.
 */

import { describe, it, expect } from "@jest/globals";
import { ChannelType } from "discord.js";
import {
  renderModAuditBody,
  renderModCaseBody,
  renderModCaseMissingBody,
  renderModLogBody,
  type ModAuditBodyProps,
  type ModLogBodyProps,
} from "../../src/web/me-moderation-page.js";
import {
  renderConsent,
  renderErrorPage,
  renderInvalidLink,
  renderSignedOut,
} from "../../src/web/views.js";
import type { CaseView } from "../../src/web/moderation-case-groups.js";

const doc = (html: string): Document =>
  new DOMParser().parseFromString(html, "text/html");

const logProps = (over: Partial<ModLogBodyProps> = {}): ModLogBodyProps => ({
  enabled: true,
  casesEnabled: true,
  tiles: { openCases: 1, overdueCases: 1, actionsLast7Days: 2, timeoutsNow: 0 },
  openCases: [
    {
      id: "c1",
      caseNumber: 4,
      userId: "u1",
      userLabel: "Ben",
      action: "ban",
      status: "under_review",
      reviewAt: "2026-01-10T09:00:00.000Z",
      due: true,
    },
  ],
  kind: "all",
  rows: [
    {
      entryId: "e1",
      caseId: "c1",
      caseNumber: 4,
      caseStatus: "open",
      createdAt: "2026-01-01T10:00:00.000Z",
      userId: "u1",
      userLabel: "Ben",
      moderatorId: "m1",
      moderatorLabel: "Mia",
      action: "ban",
      reason: "spam",
      source: "audit",
    },
  ],
  rowsUnavailable: false,
  caseLookupFailed: false,
  total: 120,
  page: 2,
  pageSize: 50,
  ...over,
});

const theCase = (over: Partial<CaseView> = {}): CaseView => ({
  id: "c1",
  caseNumber: 4,
  userId: "u1",
  userLabel: "Ben",
  action: "ban",
  status: "open",
  reviewAt: "2026-02-01T09:00:00.000Z",
  openedAt: "2026-01-01T10:00:00.000Z",
  openedByLabel: "Mia",
  originModeratorLabel: "Mia",
  reason: "spam",
  events: [
    {
      at: "2026-01-06T09:00:00.000Z",
      byLabel: "Mia",
      to: "open",
      outcome: "upheld",
      note: "still a risk",
    },
  ],
  history: [
    { createdAt: "2025-12-01T10:00:00.000Z", action: "warn", reason: "caps" },
    { createdAt: "2025-11-01T10:00:00.000Z", action: "timeout", reason: null },
  ],
  live: true,
  ...over,
});

const auditProps = (
  over: Partial<ModAuditBodyProps> = {},
): ModAuditBodyProps => ({
  enabled: true,
  commandOptions: ["warn"],
  userOptions: [{ id: "u1", label: "Mia" }],
  filters: { commandName: "", userId: "", result: "", from: "", to: "" },
  rows: [
    {
      createdAt: "2026-01-03T09:30:00.000Z",
      discordUserId: "u1",
      userLabel: "Mia",
      commandName: "warn",
      subcommand: null,
      channelId: "c1",
      channelLabel: "general",
      channelType: ChannelType.GuildText,
      channelStoredName: null,
      result: "success",
      errorMessage: null,
      durationMs: 5,
    },
  ],
  total: 80,
  page: 1,
  pageSize: 50,
  ...over,
});

const BODIES: ReadonlyArray<{ name: string; html: string }> = [
  { name: "log", html: renderModLogBody(logProps()) },
  {
    name: "log, nothing open, empty filter",
    html: renderModLogBody(
      logProps({ openCases: [], kind: "bans", rows: [], total: 0, page: 1 }),
    ),
  },
  {
    name: "log, unreadable",
    html: renderModLogBody(
      logProps({ openCases: null, rowsUnavailable: true, rows: [] }),
    ),
  },
  { name: "log, off", html: renderModLogBody(logProps({ enabled: false })) },
  {
    name: "case",
    html: renderModCaseBody({
      csrfToken: "csrf",
      case: theCase(),
      defaultReviewDays: 90,
    }),
  },
  {
    name: "case, closed, no history",
    html: renderModCaseBody({
      csrfToken: "csrf",
      case: theCase({ live: false, events: [], history: [] }),
      defaultReviewDays: 90,
    }),
  },
  {
    name: "case, history unavailable",
    html: renderModCaseBody({
      csrfToken: "csrf",
      case: theCase({ historyUnavailable: true, history: [] }),
      defaultReviewDays: 90,
    }),
  },
  { name: "case missing", html: renderModCaseMissingBody(true) },
  { name: "audit", html: renderModAuditBody(auditProps()) },
  {
    name: "audit, empty",
    html: renderModAuditBody(auditProps({ rows: [], total: 0 })),
  },
  {
    name: "audit, unavailable",
    html: renderModAuditBody(auditProps({ rows: [], unavailable: true })),
  },
];

const PAGES: ReadonlyArray<{ name: string; html: string }> = [
  {
    name: "consent",
    html: renderConsent({ token: "tok", csrfToken: "csrf-1" }),
  },
  { name: "signed out", html: renderSignedOut() },
  {
    name: "signed out, reset message",
    html: renderSignedOut("Your data was reset."),
  },
  {
    name: "signed out, not revoked",
    html: renderSignedOut(undefined, { revoked: false }),
  },
  { name: "invalid link", html: renderInvalidLink() },
  {
    name: "error page",
    html: renderErrorPage({
      title: "Forbidden",
      heading: "Forbidden",
      bodyHtml: "<p>Run <code>/config</code> in Discord.</p>",
    }),
  },
];

const classTokens = (root: Document): string[] =>
  [...root.querySelectorAll("[class]")].flatMap(
    (el: Element) =>
      el.getAttribute("class")?.split(/\s+/).filter(Boolean) ?? [],
  );

describe("member mod log pages are built from kb- components (#1710)", () => {
  it.each(BODIES)("$name: every class is a kb- class", ({ html }) => {
    expect(classTokens(doc(html)).filter((c) => !c.startsWith("kb-"))).toEqual(
      [],
    );
  });

  it.each(BODIES)("$name: no bare list", ({ html }) => {
    const bare = [...doc(html).querySelectorAll("ul, ol")].filter(
      (el) => !el.classList.contains("kb-list"),
    );
    expect(bare).toEqual([]);
  });

  it.each(BODIES)("$name: every EmptyState has its icon", ({ html }) => {
    for (const el of doc(html).querySelectorAll(".kb-empty")) {
      expect(el.querySelector(".kb-empty__icon svg.kb-icon")).not.toBeNull();
    }
  });

  it.each(BODIES)("$name: every Callout has its icon", ({ html }) => {
    for (const el of doc(html).querySelectorAll(".kb-callout")) {
      expect(el.querySelector(":scope > svg.kb-icon")).not.toBeNull();
    }
  });

  it.each(BODIES)(
    "$name: a panel title that holds a badge is a plain kb-panel__title (it wraps through the stylesheet, #1698)",
    ({ html }) => {
      for (const el of doc(html).querySelectorAll(".kb-panel__title")) {
        if (el.querySelector(".kb-badge")) {
          expect(el.classList.contains("kb-panel__title")).toBe(true);
          expect(el.classList.contains("kb-row")).toBe(false);
        }
      }
    },
  );

  it("the case history and decisions are kb-list lists that keep their words", () => {
    const d = doc(BODIES.find((b) => b.name === "case")?.html ?? "");
    const lists = [...d.querySelectorAll("ul.kb-list")];
    expect(lists).toHaveLength(2);
    const text = d.body.textContent ?? "";
    expect(text).toContain("2026-01-06 09:00 UTC");
    expect(text).toContain("by Mia: still a risk");
    expect(text).toContain("caps");
    expect(text).toContain("no reason");
  });

  it("the Actions pager is the shared list pager, with the same links", () => {
    const d = doc(BODIES[0].html);
    const foot = d.querySelector("#actions .kb-panel__foot");
    expect(foot?.textContent).toContain("Page 2 of 3");
    const hrefs = [...(foot?.querySelectorAll("a.kb-btn--sm") ?? [])].map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).toEqual([
      "/me/moderation#actions",
      "/me/moderation?page=3#actions",
    ]);
  });

  it("the first page has a disabled Prev instead of a missing one", () => {
    const d = doc(renderModLogBody(logProps({ page: 1 })));
    expect(
      d.querySelector("#actions .kb-panel__foot button[disabled]")?.textContent,
    ).toBe("← Prev");
  });

  it("the audit pager keeps the filters in its links", () => {
    const d = doc(
      renderModAuditBody(
        auditProps({
          page: 2,
          total: 120,
          filters: {
            commandName: "warn",
            userId: "",
            result: "error",
            from: "",
            to: "",
          },
        }),
      ),
    );
    const hrefs = [...d.querySelectorAll(".kb-panel__foot a.kb-btn--sm")].map(
      (a) => a.getAttribute("href"),
    );
    expect(hrefs).toEqual([
      "/me/moderation/audit?command=warn&result=error",
      "/me/moderation/audit?command=warn&result=error&page=3",
    ]);
  });

  it("the Review form still posts to the same routes with the same fields and confirmations", () => {
    const d = doc(BODIES.find((b) => b.name === "case")?.html ?? "");
    const form = d.querySelector("form");
    expect(form?.getAttribute("method")).toBe("POST");
    expect(form?.getAttribute("action")).toBe("/me/moderation/cases/c1/uphold");
    expect(d.querySelector('input[name="_csrf"]')?.getAttribute("value")).toBe(
      "csrf",
    );
    expect(d.querySelector('input[name="next_review_in_days"]')).not.toBeNull();
    expect(d.querySelector('input[name="note"]')).not.toBeNull();
    const actions = [...d.querySelectorAll("button[formaction]")].map((b) =>
      b.getAttribute("formaction"),
    );
    expect(actions).toEqual([
      "/me/moderation/cases/c1/uphold",
      "/me/moderation/cases/c1/extend",
      "/me/moderation/cases/c1/permanent",
      "/me/moderation/cases/c1/readmit",
    ]);
    expect(
      d
        .querySelector('button[formaction$="/permanent"]')
        ?.hasAttribute("data-confirm"),
    ).toBe(true);
  });
});

describe("standalone sign-in and error pages are built from kb- components (#1710)", () => {
  it.each(PAGES)("$name: every class is a kb- class", ({ html }) => {
    expect(classTokens(doc(html)).filter((c) => !c.startsWith("kb-"))).toEqual(
      [],
    );
  });

  it.each(PAGES)(
    "$name: kb.css is linked and there is no inline style sheet or style attribute",
    ({ html }) => {
      const d = doc(html);
      expect(
        [...d.querySelectorAll('link[rel="stylesheet"]')].map((l) =>
          l.getAttribute("href")?.replace(/\?.*$/, ""),
        ),
      ).toEqual(["/admin/_assets/tokens.css", "/admin/_assets/kb.css"]);
      expect(d.querySelector("style")).toBeNull();
      expect(d.querySelector("[style]")).toBeNull();
    },
  );

  it.each(PAGES)(
    "$name: one main landmark with a PageHeader and a single h1",
    ({ html }) => {
      const d = doc(html);
      expect(d.querySelectorAll("main")).toHaveLength(1);
      expect(d.querySelector("main")?.classList.contains("kb-member")).toBe(
        true,
      );
      expect(
        d.querySelectorAll("main header.kb-pagehead h1.kb-pagehead__title"),
      ).toHaveLength(1);
      expect(d.querySelectorAll("h1")).toHaveLength(1);
    },
  );

  it("the consent page keeps its form, CSRF field and one primary button", () => {
    const d = doc(PAGES[0].html);
    const form = d.querySelector("form");
    expect(form?.getAttribute("method")).toBe("POST");
    expect(form?.getAttribute("action")).toBe("/admin/s/tok");
    expect(d.querySelector('input[name="_csrf"]')?.getAttribute("value")).toBe(
      "csrf-1",
    );
    const buttons = d.querySelectorAll("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0].className).toBe("kb-btn kb-btn--primary");
    expect(buttons[0].getAttribute("type")).toBe("submit");
    expect(buttons[0].textContent).toBe("Continue");
    expect(d.querySelector("h1")?.textContent).toBe("Sign in to KoolBot Admin");
  });

  it("the signed-out page keeps its message and both revocation wordings", () => {
    const withMessage = doc(PAGES[2].html).body.textContent ?? "";
    expect(withMessage).toContain("Your data was reset.");
    expect(withMessage).toContain("Your session has been revoked.");
    expect(doc(PAGES[3].html).body.textContent).toContain(
      "could not confirm your session was revoked",
    );
    expect(doc(PAGES[1].html).body.textContent).toContain("/config");
  });

  it("the error page puts the caller's markup inside the Panel body", () => {
    const d = doc(PAGES[5].html);
    expect(
      d.querySelector(".kb-panel > .kb-panel__body code")?.textContent,
    ).toBe("/config");
  });
});
