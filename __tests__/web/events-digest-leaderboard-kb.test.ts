/* global Document, Element */
/**
 * The Events, Digest and Leaderboard roles pages are built from the design
 * system's components and no longer from the old inline classes (#1644):
 * PageHeader, Panel, DataTable, Button, Badge, Callout, EmptyState, DiscordEmbed,
 * Field and Disclosure (docs/design/components.md). Checked on the markup the
 * pages send; the settings card is the shared `renderFeatureSettingsCard`.
 */
import { describe, it, expect } from "@jest/globals";
import { JSDOM } from "jsdom";
import { ChannelType } from "discord.js";
import {
  renderDigestPage,
  renderEventsPage,
  renderLeaderboardRolesPage,
  type DigestProps,
  type EventRow,
  type EventsProps,
  type LeaderboardRolesProps,
} from "../../src/web/admin-views.js";
import type { RefusedForm } from "../../src/web/form-errors.js";

const COMMON = { csrfToken: "csrf", remainingMs: 60_000 };

const dom = (html: string): Document => new JSDOM(html).window.document;
const main = (html: string): Element => {
  const el = dom(html).querySelector("main");
  if (!el) throw new Error("no <main>");
  return el;
};

/** The old classes the issue lists, and the helpers' spellings that went with them. */
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
  "stack",
  "muted",
  "mono",
  "tag",
  "tag-on",
  "tag-off",
  "tag-info",
  "tag-warn",
  "actions",
  "edit-details",
  "field-row",
  "help",
  "data",
  "inline-form",
  "visually-hidden",
  "digest-embed",
  "digest-embed-head",
  "digest-embed-title",
  "digest-embed-desc",
  "digest-embed-footer",
  "digest-fields",
  "digest-field",
  "digest-field-name",
  "digest-field-value",
  "inline",
  "end-now",
  "cover-msg",
  "lb-tier-remove",
];

const usedClasses = (root: Element): Set<string> => {
  const used = new Set<string>();
  for (const el of root.querySelectorAll("[class]")) {
    for (const token of el.getAttribute("class")?.split(/\s+/) ?? []) {
      used.add(token);
    }
  }
  return used;
};

// ---------- Events ----------

const eventsProps = (over: Partial<EventsProps> = {}): EventsProps => ({
  ...COMMON,
  enabled: true,
  categoryConfigured: true,
  announcementConfigured: true,
  timezone: "UTC",
  settingRows: [],
  rows: [],
  ...over,
});

const ev = (id: string, over: Partial<EventRow> = {}): EventRow => ({
  id,
  title: `Event ${id}`,
  when: "2026-02-01 20:00",
  state: "scheduled",
  channelId: null,
  ...over,
});

const EVENT_ROWS: EventRow[] = [
  ev("live", {
    state: "active",
    running: true,
    channelId: "c1",
    channelName: "quiz",
    channelType: ChannelType.GuildVoice,
    groupCount: 2,
    hasGroupChannels: true,
  }),
  ev("series", {
    recurrence: "weekly",
    occurrence: 3,
    expected: {
      kind: "ok",
      count: 4,
      names: ["alice", "bob"],
      truncated: true,
    },
    legacyRsvps: { going: 1, maybe: 2, cant: 3 },
    cover: { kind: "editable", hasCover: true, series: true },
  }),
  ev("plain", {
    expected: { kind: "unavailable", message: "Could not read the list." },
    cover: { kind: "editable", hasCover: false, series: false },
  }),
  ev("adopted", { nativeAdopted: true, cover: { kind: "adopted" } }),
  ev("detached", { cover: { kind: "detached" } }),
  ev("waiting", {
    state: "ended",
    awaitingSuccessor: true,
    recurrence: "daily",
  }),
  ev("old", { state: "cancelled" }),
];

const EVENT_CASES: Array<[string, Partial<EventsProps>]> = [
  ["empty", {}],
  ["feature off", { enabled: false }],
  ["every kind of row", { rows: EVENT_ROWS }],
  [
    "a flash and a missing category",
    {
      rows: EVENT_ROWS,
      categoryConfigured: false,
      flash: { type: "ok", text: "Saved." },
    },
  ],
];

describe("the Events page renders only kb- components (#1644)", () => {
  it.each(EVENT_CASES)("uses none of the old classes: %s", (_n, over) => {
    const body = main(renderEventsPage(eventsProps(over)));
    expect(OLD_CLASSES.filter((c) => usedClasses(body).has(c))).toEqual([]);
  });

  it.each(EVENT_CASES)("has no bare table or inline style: %s", (_n, over) => {
    const body = main(renderEventsPage(eventsProps(over)));
    for (const t of body.querySelectorAll("table")) {
      expect(t.classList.contains("kb-table")).toBe(true);
    }
    expect(body.querySelectorAll("h1")).toHaveLength(1);
    expect(body.querySelectorAll("[style]")).toHaveLength(0);
  });

  it("has one primary button while on, and the callout's Enable while off", () => {
    const on = main(renderEventsPage(eventsProps({ rows: EVENT_ROWS })));
    expect(on.querySelectorAll(".kb-btn--primary")).toHaveLength(1);
    const off = main(
      renderEventsPage(eventsProps({ rows: EVENT_ROWS, enabled: false })),
    );
    expect(off.querySelector(".kb-btn--primary")?.textContent).toBe(
      "Enable events",
    );
  });

  it("puts the row actions in small Buttons in a kb-actions cell", () => {
    const body = main(renderEventsPage(eventsProps({ rows: EVENT_ROWS })));
    const row = Array.from(body.querySelectorAll("tbody tr")).find((r) =>
      r.textContent?.includes("Event series"),
    );
    const cell = row?.querySelector("td.kb-actions");
    expect(cell).not.toBeNull();
    for (const b of cell?.querySelectorAll("a, button") ?? []) {
      if (b.closest("[data-end-now]")) continue;
      expect(b.classList.contains("kb-btn")).toBe(true);
    }
    const cancels = Array.from(cell?.querySelectorAll("button") ?? []).filter(
      (b) => b.textContent?.startsWith("Cancel"),
    );
    expect(cancels.length).toBeGreaterThan(0);
    for (const b of cancels) {
      expect(b.classList.contains("kb-btn--danger")).toBe(true);
    }
  });

  it("keeps End now behind a disclosure that holds the confirm form", () => {
    const body = main(renderEventsPage(eventsProps({ rows: EVENT_ROWS })));
    const end = body.querySelector("details[data-end-now]");
    expect(end?.classList.contains("kb-disclosure")).toBe(true);
    expect(end?.querySelector("summary")?.textContent).toContain("End now");
    const form = end?.querySelector("form[data-end-event-form]");
    expect(form?.getAttribute("action")).toBe("/admin/events/live/end-now");
    expect(
      form?.querySelector('input[name="confirm"][required]'),
    ).not.toBeNull();
  });

  it("draws the cover cell as a Disclosure with a labelled file Field", () => {
    const body = main(renderEventsPage(eventsProps({ rows: EVENT_ROWS })));
    const forms = body.querySelectorAll("form[data-cover-upload]");
    expect(forms).toHaveLength(2);
    for (const form of forms) {
      const details = form.closest("details");
      expect(details?.classList.contains("kb-disclosure")).toBe(true);
      const file = form.querySelector('input[type="file"]');
      expect(file?.classList.contains("kb-input")).toBe(true);
      const label = form.querySelector(`label[for="${file?.id}"]`);
      expect(file?.id).not.toBe("");
      expect(label?.classList.contains("kb-label")).toBe(true);
      const msg = form.querySelector("[data-cover-msg]");
      expect(msg?.getAttribute("role")).toBe("status");
      expect(msg?.classList.contains("kb-help")).toBe(true);
    }
    const ids = Array.from(forms).map(
      (f) => f.querySelector('input[type="file"]')?.id,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------- Digest ----------

const digestProps = (over: Partial<DigestProps> = {}): DigestProps => ({
  ...COMMON,
  enabled: true,
  settingRows: [],
  preview: null,
  ...over,
});

const PREVIEW: NonNullable<DigestProps["preview"]> = {
  generatedAt: "2026-06-22T09:00:00.000Z",
  weekRange: "Jun 15 – Jun 22",
  qualifying: 3,
  optedIn: 2,
  skippedOptOut: 1,
  alreadySentAt: "2026-06-22 08:00",
  includeAchievements: false,
  limit: 1,
  entries: [
    {
      username: "alice",
      rank: 1,
      title: "Your weekly voice digest",
      description: "Here's a snapshot, alice.",
      fields: [
        { name: "This week", value: "5h\n▲ 1h vs last week", inline: true },
        { name: "Rank", value: "#1", inline: true },
        { name: "Achievements", value: "None yet", inline: false },
      ],
      footer: "Keep it up!\nDon't want these? Run /config.",
    },
  ],
};

const DIGEST_CASES: Array<[string, Partial<DigestProps>]> = [
  ["no preview", {}],
  ["feature off", { enabled: false }],
  ["a preview", { preview: PREVIEW }],
  [
    "a preview with nobody qualifying",
    { preview: { ...PREVIEW, optedIn: 0, entries: [] } },
  ],
];

describe("the Digest page renders only kb- components (#1644)", () => {
  it.each(DIGEST_CASES)("uses none of the old classes: %s", (_n, over) => {
    const body = main(renderDigestPage(digestProps(over)));
    expect(OLD_CLASSES.filter((c) => usedClasses(body).has(c))).toEqual([]);
    expect(body.querySelectorAll("[style]")).toHaveLength(0);
    expect(body.querySelectorAll("style")).toHaveLength(0);
    expect(body.querySelectorAll("h1")).toHaveLength(1);
    expect(body.querySelector("h1")?.className).toBe("kb-pagehead__title");
  });

  it("has one primary button while on, and the callout's Enable while off", () => {
    const on = main(renderDigestPage(digestProps({ preview: PREVIEW })));
    expect(on.querySelectorAll(".kb-btn--primary")).toHaveLength(1);
    expect(on.querySelector(".kb-btn--primary")?.textContent).toBe(
      "Preview digest",
    );
    const off = main(renderDigestPage(digestProps({ enabled: false })));
    expect(off.querySelector(".kb-btn--primary")?.textContent).toBe(
      "Enable weekly digest",
    );
  });

  it("keeps the preview GET form and the confirmed send-now POST", () => {
    const body = main(renderDigestPage(digestProps()));
    const preview = body.querySelector('form[method="GET"]');
    expect(preview?.getAttribute("action")).toBe("/admin/digest");
    const btn = preview?.querySelector("button");
    expect(btn?.getAttribute("name")).toBe("preview");
    expect(btn?.getAttribute("value")).toBe("1");
    const send = body.querySelector('form[action="/admin/digest/send-now"]');
    expect(send?.getAttribute("data-confirm")).toBe(
      "Send the weekly digest to all qualifying members right now?",
    );
    expect(send?.getAttribute("data-confirm-tone")).toBe("neutral");
  });

  it("shows the preview as a Panel with a Callout summary and a DiscordEmbed", () => {
    const body = main(renderDigestPage(digestProps({ preview: PREVIEW })));
    const panel = body.querySelector("section#digest-preview.kb-panel");
    expect(panel?.querySelector(".kb-panel__meta")?.textContent).toContain(
      "Jun 15 – Jun 22",
    );
    const callout = panel?.querySelector(".kb-callout");
    expect(callout?.getAttribute("role")).toBe("status");
    expect(callout?.textContent).toContain("3 members qualify");
    expect(callout?.textContent).toContain("already sent at 2026-06-22 08:00");
    const embed = panel?.querySelector(".kb-embed");
    expect(embed?.querySelector(".kb-embed__title")?.textContent).toBe(
      "Your weekly voice digest",
    );
    expect(panel?.textContent).toContain("alice");
    const fields = embed?.querySelectorAll(".kb-embed__field") ?? [];
    expect(fields).toHaveLength(3);
    expect(fields[2].classList.contains("kb-embed__field--wide")).toBe(true);
    expect(fields[0].querySelector("br")).not.toBeNull();
    expect(embed?.querySelector(".kb-embed__foot br")).not.toBeNull();
    expect(panel?.querySelector(".kb-panel__foot")?.textContent).toContain(
      "No DMs were sent",
    );
    expect(panel?.textContent).toContain("Showing the top 1 of 2");
    expect(panel?.textContent).toContain("Achievements are excluded");
  });

  it("says nobody qualifies with an EmptyState", () => {
    const body = main(
      renderDigestPage(
        digestProps({ preview: { ...PREVIEW, optedIn: 0, entries: [] } }),
      ),
    );
    expect(body.querySelector(".kb-empty__title")?.textContent).toContain(
      "No opted-in members qualify",
    );
  });

  it("escapes what the embed shows", () => {
    const html = renderDigestPage(
      digestProps({
        preview: {
          ...PREVIEW,
          entries: [
            { ...PREVIEW.entries[0], username: "<img src=x>", footer: "<b>" },
          ],
        },
      }),
    );
    expect(html).not.toContain("<img src=x>");
    expect(html).not.toContain("<b>");
  });
});

// ---------- Leaderboard roles ----------

const ROLES = [
  { id: "r1", name: "Admin" },
  { id: "r2", name: "Top 5" },
];

const lbProps = (
  over: Partial<LeaderboardRolesProps> = {},
): LeaderboardRolesProps => ({
  ...COMMON,
  enabled: true,
  voiceTrackingEnabled: true,
  period: "week",
  cron: "0 0 * * 1",
  tiers: [],
  ignoredEntries: [],
  roles: ROLES,
  settingRows: [],
  ...over,
});

const TIERS: LeaderboardRolesProps["tiers"] = [
  {
    topN: 1,
    roleId: "r1",
    roleName: "Admin",
    assignable: false,
    roleIssue: "managed",
    holders: [{ id: "u1", label: "alice" }],
    lastUpdated: "2026-01-05T00:00:00.000Z",
  },
  {
    topN: 3,
    roleId: "r9",
    roleName: null,
    assignable: null,
    holders: [],
    lastUpdated: null,
  },
  {
    topN: 5,
    roleId: "r2",
    roleName: "Top 5",
    assignable: null,
    holders: [
      { id: "u2", label: "bob" },
      { id: "u3", label: "carol" },
    ],
    lastUpdated: "2026-01-05T00:00:00.000Z",
  },
];

const REFUSED: RefusedForm = {
  formId: "leaderboard-tiers",
  errors: { "topN-0": "Pick a number.", "roleId-1": "Pick a role." },
  values: {
    rows: "2",
    "topN-0": "",
    "roleId-0": "r1",
    "topN-1": "4",
    "roleId-1": "",
  },
};

const LB_CASES: Array<[string, Partial<LeaderboardRolesProps>]> = [
  ["no tiers", {}],
  ["feature off", { enabled: false }],
  ["tiers", { tiers: TIERS }],
  [
    "tiers with tracking off and ignored entries",
    {
      tiers: TIERS,
      voiceTrackingEnabled: false,
      ignoredEntries: ["oops", "x"],
    },
  ],
  ["settings unavailable", { tiers: TIERS, settingsUnavailable: true }],
  ["a refused save", { tiers: TIERS, refusedForm: REFUSED }],
];

describe("the Leaderboard roles page renders only kb- components (#1644)", () => {
  it.each(LB_CASES)("uses none of the old classes: %s", (_n, over) => {
    const body = main(renderLeaderboardRolesPage(lbProps(over)));
    expect(OLD_CLASSES.filter((c) => usedClasses(body).has(c))).toEqual([]);
    expect(body.querySelectorAll("[style]")).toHaveLength(0);
    for (const t of body.querySelectorAll("table")) {
      expect(t.classList.contains("kb-table")).toBe(true);
    }
    expect(body.querySelectorAll("h1")).toHaveLength(1);
    expect(body.querySelector("h1")?.className).toBe("kb-pagehead__title");
  });

  it("has one primary button while on, and the callout's Enable while off", () => {
    const on = main(renderLeaderboardRolesPage(lbProps({ tiers: TIERS })));
    expect(on.querySelectorAll(".kb-btn--primary")).toHaveLength(1);
    expect(on.querySelector(".kb-btn--primary")?.textContent).toBe(
      "Save tiers",
    );
    const off = main(
      renderLeaderboardRolesPage(lbProps({ tiers: TIERS, enabled: false })),
    );
    expect(off.querySelector(".kb-btn--primary")?.textContent).toBe(
      "Enable leaderboard roles",
    );
  });

  it("explains an empty holders list with an EmptyState", () => {
    const body = main(renderLeaderboardRolesPage(lbProps()));
    expect(body.querySelector(".kb-empty__title")?.textContent).toContain(
      "No tiers configured yet",
    );
  });

  it("shows holders as chips and problems as warn badges", () => {
    const body = main(renderLeaderboardRolesPage(lbProps({ tiers: TIERS })));
    const holders = body.querySelector("#current-holders");
    expect(holders?.querySelectorAll(".kb-chip")).toHaveLength(3);
    const warn = Array.from(holders?.querySelectorAll(".kb-badge--warn") ?? []);
    expect(warn.map((b) => b.textContent)).toEqual([
      "managed by an integration",
      "role not found",
    ]);
    expect(holders?.textContent).toContain("nobody yet");
    expect(holders?.textContent).toContain("couldn’t check whether");
    expect(holders?.querySelector(".kb-panel__foot")?.textContent).toContain(
      "not a live read of the role",
    );
  });

  it("warns as Callouts, with the status role", () => {
    const body = main(
      renderLeaderboardRolesPage(
        lbProps({
          tiers: TIERS,
          voiceTrackingEnabled: false,
          ignoredEntries: ["oops"],
        }),
      ),
    );
    const warns = Array.from(body.querySelectorAll(".kb-callout--warn"));
    expect(warns).toHaveLength(2);
    for (const w of warns) expect(w.getAttribute("role")).toBe("status");
    expect(warns[0].textContent).toContain("Voice tracking is off");
    expect(warns[1].textContent).toContain("oops");
  });

  it("keeps the tier editor's fields, hooks and hidden buttons", () => {
    const body = main(renderLeaderboardRolesPage(lbProps({ tiers: TIERS })));
    const form = body.querySelector(
      'form[action="/admin/leaderboard-roles/tiers"]',
    );
    expect(
      form?.querySelectorAll('tbody#lb-tier-rows input[name="topN"]'),
    ).toHaveLength(4);
    for (const i of form?.querySelectorAll('input[name="topN"]') ?? []) {
      expect(i.classList.contains("kb-input")).toBe(true);
      expect(i.getAttribute("aria-label")).toBe("Top N");
    }
    for (const s of form?.querySelectorAll('select[name="roleId"]') ?? []) {
      expect(s.classList.contains("kb-select")).toBe(true);
    }
    const removes = form?.querySelectorAll("button[data-tier-remove][hidden]");
    expect(removes).toHaveLength(4);
    for (const b of removes ?? []) {
      expect(b.classList.contains("kb-btn")).toBe(true);
      expect(b.getAttribute("type")).toBe("button");
    }
    const add = form?.querySelector("button#lb-tier-add");
    expect(add?.hasAttribute("hidden")).toBe(true);
    expect(add?.classList.contains("kb-btn")).toBe(true);
    expect(body.querySelector("template#lb-tier-template")).not.toBeNull();
  });

  it("runs the recalculation behind the neutral confirmation", () => {
    const body = main(renderLeaderboardRolesPage(lbProps({ tiers: TIERS })));
    const run = body.querySelector(
      'form[action="/admin/leaderboard-roles/run-now"]',
    );
    expect(run?.getAttribute("data-confirm-tone")).toBe("neutral");
    expect(run?.querySelector("button")?.classList.contains("kb-btn")).toBe(
      true,
    );
  });
});
