/**
 * The Rewind page body (`renderUserRewindBody`) on the kb- components (#1524):
 * a solid lore-deep hero, StatTiles, bar lists for the weekday and the hour,
 * Panels, EmptyStates, and a year picker that marks the shown year in the
 * markup and not by colour alone. The HTML is parsed with jsdom, never
 * regex-stripped.
 */

/* global Document, Element, HTMLElement */
import { describe, it, expect } from "@jest/globals";
import { JSDOM } from "jsdom";
import {
  renderUserPage,
  renderUserRewindBody,
  type RewindBodyOptions,
} from "../../src/web/user-layout.js";

const BASE: RewindBodyOptions = {
  year: 2026,
  availableYears: [2024, 2025, 2026],
  hasData: true,
  totalDuration: "42 hr 10 min",
  funComparison: "That's 14 feature films.",
  sessionCount: 1,
  daysActive: 51,
  topCompanions: [
    { userId: "u2", displayName: "<b>bob</b>", duration: "9 hr" },
  ],
  peakDay: { date: "2026-01-03", duration: "4 hr 20 min" },
  voiceByKind: [{ kind: "dynamic", duration: "30 hr" }],
  longestSession: {
    duration: "3 hr 5 min",
    date: "2026-01-03",
    roomKind: "other",
  },
  longestStreakDays: 6,
  longestStreakRange: { startDate: "2026-01-01", endDate: "2026-01-06" },
  accolades: [
    {
      emoji: "🌙",
      name: "Night owl",
      description: "After midnight.",
      earnedAt: "2026-01-05",
    },
  ],
  achievements: [],
  annualRank: 3,
  annualGuildMembers: 120,
  percentAboveMedian: -4,
  weeklyJourney: {
    first: { isoYear: 2026, isoWeek: 1, rank: 12 },
    last: null,
    best: { isoYear: 2026, isoWeek: 5, rank: 2 },
  },
  messagesSent: 430,
  topTextChannels: [],
  peakMessageDay: { date: "2026-01-04", count: 1 },
  reactionsGiven: 90,
  reactionsReceived: 0,
  hourOfDayDistribution: Array.from({ length: 24 }, (_, h) =>
    h === 22 ? 120 : h,
  ),
  dayOfWeekDistribution: [0, 10, 20, 30, 40, 200, 5],
  pollVotesCast: 12,
};

function dom(overrides: Partial<RewindBodyOptions> = {}): Document {
  return new JSDOM(
    `<body>${renderUserRewindBody({ ...BASE, ...overrides })}</body>`,
  ).window.document;
}

const text = (el: Element | null | undefined): string =>
  (el?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("Rewind year picker (#1524)", () => {
  it("marks only the shown year with aria-current=page and keeps the nav label", () => {
    const d = dom({ year: 2025 });
    const nav = d.querySelector("nav.kb-years");
    expect(nav?.getAttribute("aria-label")).toBe("Rewind year");
    const current = [...d.querySelectorAll("nav.kb-years a")].filter(
      (a) => a.getAttribute("aria-current") === "page",
    );
    expect(current.map((a) => text(a))).toEqual(["2025"]);
    expect(d.querySelectorAll("nav.kb-years a")).toHaveLength(3);
    expect(d.querySelector(".current")).toBeNull();
  });

  it("renders no picker for a single year", () => {
    expect(dom({ availableYears: [2026] }).querySelector("nav")).toBeNull();
  });
});

describe("Rewind hero and tiles (#1524)", () => {
  it("shows the total in a lore hero, with the session line escaped once", () => {
    const d = dom();
    const hero = d.querySelector(".kb-hero--lore");
    expect(text(hero?.querySelector(".kb-hero__value"))).toBe("42 hr 10 min");
    expect(text(hero)).toContain("That's 14 feature films.");
    expect(text(hero)).toContain("1 session across 51 days");
  });

  it("puts the voice stats in StatTiles with a label, a value and a detail", () => {
    const d = dom();
    const tiles = [...d.querySelectorAll(".kb-tiles")][0];
    const byLabel = new Map(
      [...tiles.querySelectorAll(".kb-tile")].map((t) => [
        text(t.querySelector(".kb-overline")),
        t,
      ]),
    );
    expect([...byLabel.keys()]).toEqual([
      "Peak day",
      "Longest session",
      "Longest streak",
      "Annual rank",
      "Above median",
    ]);
    expect(
      text(byLabel.get("Annual rank")?.querySelector(".kb-tile__value")),
    ).toBe("#3");
    expect(
      text(byLabel.get("Annual rank")?.querySelector(".kb-tile__detail")),
    ).toBe("of 120 active members");
    expect(
      text(byLabel.get("Above median")?.querySelector(".kb-tile__value")),
    ).toBe("-4%");
    expect(
      text(byLabel.get("Longest streak")?.querySelector(".kb-tile__detail")),
    ).toBe("2026-01-01 → 2026-01-06");
  });

  it("shows a dash tile when a stat has no value", () => {
    const d = dom({
      peakDay: null,
      annualRank: null,
      percentAboveMedian: null,
    });
    const tile = [...d.querySelectorAll(".kb-tile")].find(
      (t) => text(t.querySelector(".kb-overline")) === "Annual rank",
    );
    expect(text(tile?.querySelector(".kb-tile__value"))).toBe("—");
    expect(tile?.querySelector(".kb-tile__detail")).toBeNull();
  });

  it("gives text, reaction, poll and journey stats tiles too", () => {
    const d = dom();
    const labels = [...d.querySelectorAll(".kb-tile .kb-overline")].map((e) =>
      text(e),
    );
    for (const l of [
      "Messages sent",
      "Peak message day",
      "Reactions given",
      "Reactions received",
      "Poll votes cast",
      "First",
      "Best",
      "Last",
    ]) {
      expect(labels).toContain(l);
    }
    expect(text(d.querySelector(".kb-tile__detail"))).not.toBe("");
  });
});

describe("Rewind bar lists and panels (#1524)", () => {
  it("draws the weekday and the hour as kb-bars with the peak marked and named in text", () => {
    const d = dom();
    const lists = d.querySelectorAll(".kb-bars");
    expect(lists).toHaveLength(2);
    const [days, hours] = [...lists];
    expect(days.querySelectorAll(".kb-bars__row")).toHaveLength(7);
    expect(hours.querySelectorAll(".kb-bars__row")).toHaveLength(24);
    expect(text(days.querySelector(".is-peak"))).toContain("Fri");
    expect(days.querySelectorAll(".is-peak")).toHaveLength(1);
    expect(text(hours.querySelector(".is-peak"))).toContain("10 PM");
    expect(hours.querySelectorAll(".is-peak")).toHaveLength(1);
    expect(
      (days.querySelector(".is-peak .kb-bars__fill") as HTMLElement).style
        .width,
    ).toBe("100%");
    // Every figure is text, not a tooltip.
    expect(text(days.querySelector(".is-peak .kb-bars__val"))).toBe(
      "3 hr 20 min",
    );
    expect(text(d.querySelector(".kb-panel__meta"))).toBe(
      "Most active: Friday · 10 PM",
    );
  });

  it("lets a list panel run edge to edge inside its own scroll container", () => {
    const body = dom().querySelector(".kb-panel__body--flush");
    expect(body).not.toBeNull();
  });

  it("puts every section in a kb-panel and uses no old Rewind class", () => {
    const html = renderUserRewindBody(BASE);
    expect(html).not.toMatch(/rw-|class="card"|class="empty"|class="current"/);
    const titles = [...dom().querySelectorAll(".kb-panel__title")].map((e) =>
      text(e),
    );
    expect(titles).toEqual([
      "Where you spent your voice time",
      "Top voice companions",
      "Top text channels",
      "When you're online",
      "Rank journey",
      "Badges earned this year",
    ]);
  });

  it("escapes names once", () => {
    const d = dom();
    const name = d.querySelector(".kb-list__main");
    expect(name?.querySelector("b")).toBeNull();
    const list = [...d.querySelectorAll(".kb-panel")].find((p) =>
      text(p).startsWith("Top voice companions"),
    );
    expect(text(list?.querySelector(".kb-list__main"))).toBe("<b>bob</b>");
  });

  it("lists badges with their description and the day, and shows empty sections as kb-empty", () => {
    const d = dom({
      accolades: [],
      topCompanions: [],
      weeklyJourney: { first: null, last: null, best: null },
      topTextChannels: [],
    });
    const empties = [...d.querySelectorAll(".kb-empty__title")].map((e) =>
      text(e),
    );
    expect(empties).toEqual([
      "No voice companions yet.",
      "No tracked text channels this year.",
      "No weekly ranking yet.",
      "No badges this year.",
    ]);
    for (const t of d.querySelectorAll(".kb-empty__text"))
      expect(text(t)).not.toBe("");

    const full = dom();
    const badge = [...full.querySelectorAll(".kb-list > li")].find((li) =>
      text(li).includes("Night owl"),
    );
    expect(text(badge?.querySelector("strong"))).toBe("Night owl");
    expect(
      [...(badge?.querySelectorAll(".kb-list__desc") ?? [])].map((e) =>
        text(e),
      ),
    ).toEqual(["After midnight.", "Earned 2026-01-05"]);
  });

  it("shows a year with no data as one kb-empty in a panel, with the picker", () => {
    const d = dom({ hasData: false, year: 2024 });
    expect(text(d.querySelector(".kb-panel .kb-empty__title"))).toBe(
      "Nothing to recap yet",
    );
    expect(text(d.querySelector(".kb-empty__text"))).toContain("in 2024");
    expect(
      d.querySelector('nav.kb-years a[aria-current="page"]'),
    ).not.toBeNull();
    expect(d.querySelector(".kb-hero--lore")).toBeNull();
  });
});

describe("Rewind sections are spaced by a kb-stack (#1524)", () => {
  const kids = (d: Document): Element[] => {
    const stack = d.body.firstElementChild;
    expect(stack?.classList.contains("kb-stack")).toBe(true);
    expect(d.body.children).toHaveLength(1);
    return [...(stack?.children ?? [])];
  };

  it("makes the hero, the tiles and every panel direct children of one kb-stack", () => {
    const children = kids(dom());
    expect(children.some((c) => c.classList.contains("kb-hero--lore"))).toBe(
      true,
    );
    expect(
      children.filter((c) => c.classList.contains("kb-tiles")).length,
    ).toBeGreaterThan(0);
    const panels = [...dom().querySelectorAll("section.kb-panel")];
    expect(panels.length).toBeGreaterThan(0);
    expect(
      children.filter((c) => c.classList.contains("kb-panel")),
    ).toHaveLength(panels.length);
  });

  it("does the same for a year with no data, so the picker stays apart from the panel", () => {
    const children = kids(dom({ hasData: false }));
    expect(children.map((c) => c.tagName + "." + c.className)).toContain(
      "NAV.kb-years",
    );
    expect(children.some((c) => c.classList.contains("kb-panel"))).toBe(true);
  });
});

describe("Rewind in the member sheet (#1524)", () => {
  it("ships no .rw- rule and no gradient", () => {
    const html = renderUserPage({
      title: "Rewind 2026",
      active: "/me/rewind",
      body: renderUserRewindBody(BASE),
      csrfToken: "csrf",
      remainingMs: 60_000,
      isAdmin: false,
    });
    const sheet = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
    expect(sheet).not.toContain(".rw-");
    expect(sheet).not.toContain("gradient");
  });
});
