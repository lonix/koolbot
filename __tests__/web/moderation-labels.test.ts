/**
 * @jest-environment <rootDir>/__tests__/jsdom-node-env.cjs
 */

/**
 * Moderation label drift gate (#1353). `docs/design/labels.md` lists the plain
 * words moderation shows people; `src/utils/moderation-labels.ts` holds them.
 * This renders the REAL pages and messages (every action, every case state,
 * every recorded decision) and fails when a retired word comes back on one of
 * them, or when the Web UI and Discord stop naming the same thing the same way.
 *
 * Pages are parsed with the browser's own parser and read as text, the way
 * `a11y-dom.ts` does, never searched as an HTML string: what a person reads is
 * the text content plus the attributes assistive technology and tooltips read
 * (`data-confirm`, `data-confirm-list`, `aria-label`, `title`, `placeholder`).
 * Links, form actions and option values carry the stored names (`/readmit`,
 * `untimeout`) on purpose and are not read.
 */

import { describe, it, expect } from "@jest/globals";
import { renderModerationPage } from "../../src/web/admin-views.js";
import {
  renderModCaseBody,
  renderModLogBody,
  type ModLogBodyProps,
} from "../../src/web/me-moderation-page.js";
import type {
  CaseGroups,
  CaseView,
} from "../../src/web/moderation-case-groups.js";
import {
  MODERATION_ACTIONS,
  type ModerationAction,
} from "../../src/models/moderation-log.js";
import {
  actionLabel,
  formatCaseLine,
  formatHistorySummary,
  type CaseLineSource,
} from "../../src/utils/moderation-format.js";
import {
  ACTION_WORDS,
  CASE_OUTCOME_WORDS,
  CASE_STATUS_WORDS,
  DECISION_CONFIRM_TEXT,
  DECISION_DONE,
  DECISION_LABELS,
  PERMANENT_CONFIRM_ITEMS,
  REVIEW_JOB_NOTE,
  capitalise,
} from "../../src/utils/moderation-labels.js";
import { settingsMetadata } from "../../src/services/config-schema.js";
import { allPages } from "./a11y-pages.js";

/** Attributes whose value a person reads. Everything else is machinery. */
const READ_ATTRIBUTES = [
  "data-confirm",
  "data-confirm-list",
  "aria-label",
  "title",
  "placeholder",
];

/** The text a person reads on a page, as one string. */
function readableText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const el of Array.from(doc.querySelectorAll("script, style"))) {
    el.remove();
  }
  // `textContent` joins neighbouring elements without a gap ("due" + "2026"
  // reads as one word), so give every element its own line first.
  for (const el of Array.from(doc.body.querySelectorAll("*"))) {
    el.after("\n");
  }
  const parts: string[] = [doc.body.textContent ?? ""];
  const selector = READ_ATTRIBUTES.map((a) => `[${a}]`).join(",");
  for (const el of Array.from(doc.querySelectorAll(selector))) {
    for (const attr of READ_ATTRIBUTES) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      parts.push(
        attr === "data-confirm-list"
          ? (JSON.parse(value) as string[]).join("\n")
          : value,
      );
    }
  }
  return parts.join("\n");
}

/**
 * Words retired in #1353, matched on plain text. `[label, pattern]`. These are
 * checked on every moderation fixture; the short list below it is also checked
 * on every page in the a11y set, where a looser word (permanent, extend) can be
 * said about something that is not a case.
 */
const RETIRED_ON_MODERATION: ReadonlyArray<readonly [string, RegExp]> = [
  ["Uphold / upheld", /\bupheld\b|\buphold(s)?\b/i],
  ["Extend / extended", /\bextend(s|ed|ing)?\b/i],
  ["permanent", /\bpermanent(ly)?\b/i],
  ["Readmit / readmitted", /\breadmit(ted)?\b/i],
  ["unban", /\bunban(s|ned)?\b/i],
  ["untimeout", /\buntimeout\b/i],
  ["under review", /\bunder review\b/i],
  ["due for review", /\bdue for review\b/i],
  ["Overdue", /\boverdue\b/i],
  ["Due soon", /\bdue soon\b/i],
  ["came due", /\bcame due\b/i],
  ["Due (badge)", /\bDue\b/],
  ["Recently resolved", /\brecently resolved\b/i],
  ["review pass", /\breview pass\b/i],
  ["Prior history / entries", /\bprior (history|entries)\b/i],
  ["No other history", /\bno other history\b/i],
  ["Escalation", /\bescalation\b/i],
  ["guild audit log", /\bguild\b/i],
  ["native actions", /\bnative\b/i],
  ["raid cleared", /\braid cleared\b/i],
];

const RETIRED_EVERYWHERE = RETIRED_ON_MODERATION.filter(([label]) =>
  [
    "Uphold / upheld",
    "Readmit / readmitted",
    "unban",
    "untimeout",
    "under review",
    "due for review",
    "Prior history / entries",
    "raid cleared",
  ].includes(label),
);

function retiredIn(
  text: string,
  list: ReadonlyArray<readonly [string, RegExp]>,
): string[] {
  return list.filter(([, re]) => re.test(text)).map(([label]) => label);
}

// ---------- Fixtures: every action, every state, every decision ----------

const STATUSES = Object.keys(CASE_STATUS_WORDS) as Array<
  keyof typeof CASE_STATUS_WORDS
>;
const OUTCOMES = Object.keys(CASE_OUTCOME_WORDS) as Array<
  keyof typeof CASE_OUTCOME_WORDS
>;

const TS = "2026-01-12T09:00:00.000Z";

/** One case per state, each carrying every recorded decision in its trail. */
const caseFor = (
  status: (typeof STATUSES)[number],
  n: number,
  over: Partial<CaseView> = {},
): CaseView => ({
  id: `case-${n}`,
  caseNumber: n,
  userId: `u${n}`,
  userLabel: `Member ${n}`,
  action: n % 2 === 0 ? "ban" : "kick",
  status,
  reviewAt: TS,
  openedAt: TS,
  openedByLabel: "Staff",
  originModeratorLabel: "Mod",
  reason: "Repeated spam",
  events: [
    {
      at: TS,
      byLabel: "KoolBot",
      to: "under_review",
      outcome: null,
      note: REVIEW_JOB_NOTE,
    },
    ...OUTCOMES.map((outcome) => ({
      at: TS,
      byLabel: "Staff",
      to: "open",
      outcome,
      note: null,
    })),
  ],
  history: MODERATION_ACTIONS.map((action) => ({
    createdAt: TS,
    action,
    reason: "earlier",
  })),
  live: status === "open" || status === "under_review",
  ...over,
});

const CASES = STATUSES.map((s, i) => caseFor(s, i + 1));

const GROUPS: CaseGroups = {
  overdue: CASES.filter((c) => c.status === "under_review"),
  dueSoon: CASES.filter((c) => c.status === "open"),
  scheduled: [caseFor("open", 20)],
  indefinite: [caseFor("open", 21, { reviewAt: null })],
  recentlyResolved: CASES.filter((c) => !c.live),
};

const LOG_ROWS = MODERATION_ACTIONS.map((action, i) => ({
  entryId: `e${i}`,
  caseId: i < STATUSES.length ? `case-${i + 1}` : null,
  caseNumber: i < STATUSES.length ? i + 1 : null,
  caseStatus: i < STATUSES.length ? STATUSES[i] : null,
  createdAt: TS,
  userId: `u${i}`,
  userLabel: `Member ${i}`,
  moderatorId: "m1",
  moderatorLabel: "Mod",
  action,
  reason: "spam",
  source: "command" as const,
}));

function adminPage(): string {
  return renderModerationPage({
    csrfToken: "tok",
    remainingMs: 60_000,
    enabled: true,
    actionOptions: [...MODERATION_ACTIONS],
    userOptions: [],
    filters: { action: "", userId: "" },
    rows: LOG_ROWS,
    total: LOG_ROWS.length,
    page: 1,
    pageSize: 50,
    casesEnabled: true,
    defaultReviewDays: 90,
    caseGroups: GROUPS,
  } as never);
}

const REASON = { kind: "groups", names: ["Moderator"] } as const;

function modLog(overdue: number | null): string {
  const props: ModLogBodyProps = {
    reason: REASON,
    enabled: true,
    casesEnabled: true,
    tiles: {
      openCases: 4,
      overdueCases: overdue,
      actionsLast7Days: 9,
      timeoutsNow: 1,
    },
    openCases: CASES.filter((c) => c.live).map((c) => ({
      id: c.id,
      caseNumber: c.caseNumber,
      userId: c.userId,
      userLabel: c.userLabel,
      action: c.action,
      status: c.status,
      reviewAt: c.reviewAt,
      due: c.status === "under_review",
    })),
    kind: "all",
    rows: LOG_ROWS,
    rowsUnavailable: false,
    caseLookupFailed: false,
    total: LOG_ROWS.length,
    page: 1,
    pageSize: 50,
  };
  return renderModLogBody(props);
}

const caseBody = (c: CaseView): string =>
  renderModCaseBody({
    reason: REASON,
    csrfToken: "tok",
    case: c,
    defaultReviewDays: 90,
  });

/** The `/modlog` line for each state, with and without a review date. */
function discordCaseLines(): string[] {
  const lines: string[] = [];
  for (const status of STATUSES) {
    for (const reviewAt of [new Date(TS), null]) {
      const src: CaseLineSource = {
        caseNumber: 14,
        status,
        reviewAt,
        events: [{ at: new Date(TS), byUserId: "staff-9" }],
      };
      lines.push(formatCaseLine(src));
    }
  }
  return lines;
}

/** Every Discord string from this module family, as one text. */
function discordText(): string {
  const counts = Object.fromEntries(MODERATION_ACTIONS.map((a) => [a, 2]));
  return [
    ...MODERATION_ACTIONS.map(actionLabel),
    ...discordCaseLines(),
    formatHistorySummary({
      total: MODERATION_ACTIONS.length * 2,
      counts,
      mostRecent: new Date(TS),
    }),
    formatHistorySummary({ total: 0, counts: {}, mostRecent: null }),
  ].join("\n");
}

/** Texts a decision can put in a flash or a dialog. */
function decisionText(): string {
  return [
    ...Object.values(DECISION_LABELS),
    ...Object.values(DECISION_DONE).map((d) => `Case #14 ${d}`),
    ...Object.values(DECISION_CONFIRM_TEXT),
    ...PERMANENT_CONFIRM_ITEMS,
  ].join("\n");
}

/** What the Settings page shows for the moderation keys. */
function moderationSettingsText(): string {
  return Object.entries(settingsMetadata)
    .filter(([key]) => /^(core\.)?moderation/.test(key))
    .map(([, m]) => `${m.label}\n${m.description}`)
    .join("\n");
}

describe("moderation labels (#1353)", () => {
  const surfaces: Array<[string, () => string]> = [
    ["admin Moderation page", () => readableText(adminPage())],
    [
      "/me/moderation mod log (some need a decision)",
      () => readableText(modLog(3)),
    ],
    [
      "/me/moderation mod log (one needs a decision)",
      () => readableText(modLog(1)),
    ],
    ["/me/moderation mod log (none)", () => readableText(modLog(0))],
    [
      "/me/moderation mod log (unreadable count)",
      () => readableText(modLog(null)),
    ],
    ...CASES.map((c): [string, () => string] => [
      `/me/moderation case page, ${c.status}`,
      () => readableText(caseBody(c)),
    ]),
    ["Discord messages", discordText],
    ["decision buttons, flashes and dialogs", decisionText],
    ["moderation settings text", moderationSettingsText],
  ];

  it.each(surfaces)("%s uses none of the retired words", (_name, text) => {
    expect(retiredIn(text(), RETIRED_ON_MODERATION)).toEqual([]);
  });

  it("no page in the accessibility set uses the unambiguous retired words", () => {
    const hits = allPages().flatMap((p) =>
      retiredIn(readableText(p.html), RETIRED_EVERYWHERE).map(
        (label) => `${p.name}: ${label}`,
      ),
    );
    expect(hits).toEqual([]);
  });

  it("the fixtures reach every word, so a pass is not an empty scan", () => {
    const admin = readableText(adminPage());
    const me = [modLog(3), ...CASES.map(caseBody)].map(readableText).join("\n");
    for (const text of [admin, me]) {
      for (const word of Object.values(ACTION_WORDS)) {
        expect(text).toContain(word);
      }
      for (const word of Object.values(CASE_STATUS_WORDS)) {
        expect(text).toContain(word);
      }
      for (const word of Object.values(CASE_OUTCOME_WORDS)) {
        expect(text).toContain(word);
      }
    }
    for (const label of Object.values(DECISION_LABELS)) {
      expect(admin).toContain(label);
    }
    for (const heading of [
      "Needs a decision",
      "Review in the next 7 days",
      "Review later",
      "Closed in the last 30 days",
      "Earlier actions",
    ]) {
      expect(admin).toContain(heading);
    }
    expect(readableText(modLog(3))).toContain("3 need a decision");
    expect(readableText(modLog(1))).toContain("1 needs a decision");
    expect(readableText(modLog(0))).toContain("None need a decision");
  });

  it("the case page carries the dialog texts from the shared list", () => {
    const live = readableText(caseBody(CASES[0]));
    expect(live).toContain(DECISION_CONFIRM_TEXT.permanent);
    expect(live).toContain(DECISION_CONFIRM_TEXT.readmit);
    for (const item of PERMANENT_CONFIRM_ITEMS) expect(live).toContain(item);
  });

  describe("Discord and the Web UI name the same thing the same way", () => {
    it.each(MODERATION_ACTIONS as readonly ModerationAction[])(
      "action %s",
      (action) => {
        // The Discord label is the emoji, then the Web UI word with a capital.
        expect(
          actionLabel(action).endsWith(capitalise(ACTION_WORDS[action])),
        ).toBe(true);
      },
    );

    it.each(STATUSES)("case state %s", (status) => {
      const line = formatCaseLine({
        caseNumber: 14,
        status,
        reviewAt: null,
        events: [],
      });
      expect(line).toContain(CASE_STATUS_WORDS[status]);
    });
  });
});
