/* global Element, HTMLElement, HTMLFormElement, Document */
import { describe, it, expect } from "@jest/globals";
import { JSDOM } from "jsdom";
import { renderChannelClaimsPage } from "../../src/web/channel-claims-view.js";
import {
  renderAdoptionDiff,
  renderDestructiveConfirm,
} from "../../src/web/adoption-diff.js";

/**
 * The Channel claims page on the kb- components (#1730): every class in the
 * page's own markup is a kb- class and no table is bare, the panels, buttons,
 * callouts and disclosures follow the manual, and the forms, field names,
 * posted values, CSRF token and confirmations are unchanged. The plan table
 * itself (`renderAdoptionDiff`) and the destructive tick box
 * (`renderDestructiveConfirm`) are #1715 and still emit the old classes, so
 * their exact output is subtracted before the class scan.
 */

const flags = {
  afk: false,
  rules: false,
  system: false,
  publicUpdates: false,
  webhookFed: false,
  followed: false,
  announcement: false,
  forum: false,
  stage: false,
  onboardingDefault: false,
};
const ch = (over: Record<string, unknown>) => ({
  id: "1",
  name: "x",
  kind: "text",
  typeName: "GuildText",
  parentId: null,
  parentName: null,
  syncedToParent: null,
  position: 0,
  overwrites: [],
  usedBy: [],
  featureGuess: null,
  gatedByRoleIds: [],
  ownerHint: null,
  flags,
  ...over,
});
const role = (over: Record<string, unknown>) => ({
  managed: false,
  isEveryone: false,
  botId: null,
  usedBy: [],
  ...over,
});
const scan = {
  guildName: "G",
  guildId: "g",
  scanned: {
    botRoleIds: [],
    botHighestRolePosition: 50,
    roles: [
      { id: "r1", permissions: "0", position: 3 },
      { id: "r9", permissions: "8", position: 4 },
    ],
  },
  webhooks: {
    known: true,
    unavailable: null,
    list: [{ id: "w1", name: "bridge", channelId: "11", kind: "incoming" }],
  },
  roles: [
    role({ id: "r1", name: "Mod", position: 3 }),
    role({ id: "r2", name: "Booster", position: 2, managed: true }),
    role({ id: "r3", name: "Dyno", position: 1, managed: true, botId: "b1" }),
    role({ id: "r9", name: "Root", position: 4 }),
    role({ id: "g", name: "@everyone", position: 0, isEveryone: true }),
  ],
  channels: [
    ch({
      id: "10",
      name: "Games",
      kind: "category",
      typeName: "GuildCategory",
      overwrites: [
        { id: "g", type: "role", allow: [], deny: ["ViewChannel"] },
        { id: "r1", type: "role", allow: ["ViewChannel"], deny: [] },
      ],
    }),
    ch({
      id: "20",
      name: "Admins",
      kind: "category",
      typeName: "GuildCategory",
      position: 1,
      overwrites: [
        { id: "g", type: "role", allow: [], deny: ["ViewChannel"] },
        { id: "r9", type: "role", allow: ["ViewChannel"], deny: [] },
      ],
    }),
    ch({
      id: "11",
      name: "news",
      parentId: "10",
      flags: { ...flags, webhookFed: true },
    }),
    ch({
      id: "12",
      name: "forum",
      parentId: "10",
      flags: { ...flags, forum: true },
    }),
    ch({
      id: "13",
      name: "Lobby",
      kind: "voice",
      typeName: "GuildVoice",
      parentId: "10",
    }),
    ch({
      id: "30",
      name: "stage",
      kind: "voice",
      typeName: "GuildStageVoice",
      flags: { ...flags, stage: true },
    }),
    ch({ id: "14", name: "loose", position: 5 }),
  ],
  naming: { suggestedPrefix: "🔊 | " },
} as any;
const plainScan = {
  ...scan,
  webhooks: { known: true, unavailable: null, list: [] },
  roles: scan.roles.filter((r: any) => r.id === "g"),
  channels: [
    ch({ id: "10", name: "Chat", kind: "category", typeName: "GuildCategory" }),
    ch({ id: "11", name: "general", parentId: "10" }),
  ],
} as any;
const groups = [{ id: "grp1", name: "Mods" }] as any;
const base = {
  csrfToken: "tok",
  remainingMs: 1000,
  navFeatureStatus: {} as any,
};
const empty = {
  ...base,
  scan,
  groups,
  claims: [] as any[],
  plan: null,
  problems: [] as string[],
  previewToken: null,
};
const additive = {
  id: "op-1",
  type: "overwrite.set",
  class: "additive",
  summary: "Edit overwrite",
  before: null,
  after: null,
};
const destructive = {
  id: "op-2",
  type: "overwrite.remove",
  class: "destructive",
  summary: "Remove overwrite",
  before: { allow: "1", deny: "0" },
  after: null,
  approval: {
    kind: "overwrite.remove",
    targetId: "11:r1",
    approvedBy: "a",
    approvedAt: "2026-10-17T10:00:00.000Z",
  },
};
const planOf = (operations: unknown[], extra: Record<string, unknown> = {}) =>
  ({
    scan,
    groups,
    errors: [],
    warnings: [],
    plan: {
      id: "abc",
      errors: [],
      warnings: [],
      operations,
      baseline: { roles: [], channels: [], config: {}, absentRoleNames: [] },
    },
    ...extra,
  }) as any;

interface State {
  name: string;
  html: string;
  plan: any | null;
}
const state = (name: string, props: Record<string, unknown>): State => ({
  name,
  html: renderChannelClaimsPage({ ...empty, ...props } as any),
  plan: (props["plan"] as any) ?? null,
});
const STATES: State[] = [
  state("no plan, with suggestions", {}),
  state("nothing to suggest", { scan: plainScan }),
  state("webhook data unavailable", {
    scan: {
      ...scan,
      webhooks: { known: false, unavailable: "missing-permission", list: [] },
    },
  }),
  state("prefilled from the Server scan", {
    claims: [
      { channelId: "14", action: "leave", bindKey: "quotes.channel_id" },
    ],
    prefill: { channelId: "14", channelName: "loose", featureLabel: "Quotes" },
  }),
  state("problems reading the form", { problems: ["Ignored channel 9."] }),
  state("running apply", { jobId: "11111111-1111-1111-1111-111111111111" }),
  state("scan failed", { scan: null, error: "boom" }),
  state("applicable plan", {
    claims: [{ channelId: "14", action: "read-only" }],
    plan: planOf([additive]),
    previewToken: "tok-1",
  }),
  state("applicable plan with destructive steps", {
    plan: planOf([additive, destructive]),
    previewToken: "tok-1",
  }),
  state("plan with nothing to change", {
    plan: planOf([]),
    previewToken: "tok-1",
  }),
  state("blocked plan with problems and advice", {
    plan: planOf([additive], {
      errors: [{ code: "voice-cleanup-risk", message: "no <x>" }],
      warnings: [{ code: "rebind", message: "careful <b>" }],
    }),
    previewToken: "tok-1",
  }),
];

/** The page's own markup, without the shared layout around it. */
const mainOf = (html: string): string =>
  html.slice(html.indexOf("<main"), html.indexOf("</main>"));

/** The markup the plan view embeds from `adoption-diff.ts` (#1715, held). */
const heldOutput = (plan: any | null): string[] =>
  plan
    ? [renderAdoptionDiff(plan.plan), renderDestructiveConfirm(plan.plan)]
    : [];

const ownMarkup = (s: State): string => {
  let main = mainOf(s.html);
  for (const held of heldOutput(s.plan)) {
    if (held) main = main.split(held).join("");
  }
  return main;
};

const nonKbClasses = (html: string): string[] => [
  ...[...html.matchAll(/class="([^"]*)"/g)]
    .flatMap((m) => m[1].split(/\s+/))
    .filter((t) => t && !t.startsWith("kb-")),
  ...[...html.matchAll(/<table(?![^>]*class="kb-table")/g)].map((m) => m[0]),
];

const docOf = (s: State): Document =>
  new JSDOM(`<body>${ownMarkup(s)}</body>`).window.document;

describe("Channel claims markup (#1730)", () => {
  it.each(STATES)("$name: only kb- classes and no bare table", (s) => {
    expect(nonKbClasses(ownMarkup(s))).toEqual([]);
  });

  it("really subtracts the held plan output, so the scan covers the page's own markup", () => {
    const s = STATES.find(
      (x) => x.name === "applicable plan with destructive steps",
    )!;
    expect(mainOf(s.html)).toContain('class="adoption-diff"');
    expect(mainOf(s.html)).toContain('<label class="check">');
    expect(ownMarkup(s)).not.toContain("adoption-diff");
  });

  it.each(STATES)(
    "$name: one h1 in the page header, no kb-row on a panel title",
    (s) => {
      const doc = docOf(s);
      expect(doc.querySelectorAll("h1")).toHaveLength(1);
      expect(
        doc.querySelector("header.kb-pagehead h1.kb-pagehead__title"),
      ).not.toBeNull();
      expect(
        doc.querySelector(".kb-pagehead__sub a[href='/admin/adopt']"),
      ).not.toBeNull();
      for (const t of doc.querySelectorAll(".kb-panel__title")) {
        expect(t.classList.contains("kb-row")).toBe(false);
      }
    },
  );

  it.each(STATES)(
    "$name: panels sit in a kb-stack and tables scroll inside their panel",
    (s) => {
      const doc = docOf(s);
      for (const p of doc.querySelectorAll(".kb-panel")) {
        expect(p.parentElement?.closest(".kb-stack")).not.toBeNull();
        expect(p.tagName).toBe("SECTION");
        const labelled = p.getAttribute("aria-labelledby");
        expect(labelled).toBeTruthy();
        expect(doc.getElementById(labelled as string)).not.toBeNull();
      }
      for (const t of doc.querySelectorAll("table")) {
        expect(t.classList.contains("kb-table")).toBe(true);
        expect(t.closest(".kb-panel__body--flush")).not.toBeNull();
      }
    },
  );

  it("wraps the held plan diff in a scroll container inside its panel", () => {
    const s = STATES.find((x) => x.name === "applicable plan")!;
    const diff = renderAdoptionDiff(s.plan.plan);
    const doc = new JSDOM(`<body>${mainOf(s.html)}</body>`).window.document;
    const wrap = doc.querySelector(".kb-panel__body--flush .adoption-plan");
    expect(wrap).not.toBeNull();
    expect(mainOf(s.html)).toContain(diff);
  });

  it.each(STATES)("$name: at most one primary button", (s) => {
    expect(
      docOf(s).querySelectorAll(".kb-btn--primary").length,
    ).toBeLessThanOrEqual(1);
  });

  it("makes Preview the primary button until a plan can be applied, then Apply", () => {
    const primaries = (name: string): string[] =>
      [
        ...docOf(STATES.find((x) => x.name === name)!).querySelectorAll(
          ".kb-btn--primary",
        ),
      ].map((b) => (b.textContent ?? "").trim());
    expect(primaries("no plan, with suggestions")).toEqual(["Preview changes"]);
    expect(primaries("applicable plan")).toEqual(["Apply plan"]);
    expect(primaries("applicable plan with destructive steps")).toEqual([
      "Apply plan",
    ]);
    expect(primaries("blocked plan with problems and advice")).toEqual([
      "Preview changes",
    ]);
    expect(primaries("plan with nothing to change")).toEqual([
      "Preview changes",
    ]);
    expect(primaries("scan failed")).toEqual([]);
  });

  it("uses a kb- control class on every select, input and button", () => {
    for (const s of STATES) {
      const doc = docOf(s);
      for (const el of doc.querySelectorAll("select")) {
        expect(el.classList.contains("kb-select")).toBe(true);
      }
      for (const el of doc.querySelectorAll("button")) {
        if (el.hasAttribute("data-marker-btn")) continue;
        expect(el.classList.contains("kb-btn")).toBe(true);
      }
    }
  });

  it("opens the claim row's Options as a Disclosure, keeping the row anchor", () => {
    const doc = docOf(STATES[0]);
    const row = doc.getElementById("claim-14") as HTMLElement;
    expect(row.tagName).toBe("TR");
    expect(row.getAttribute("class")).toBeNull();
    const details = row.querySelector("details.kb-disclosure") as Element;
    expect(details.querySelector("summary .kb-chev")).not.toBeNull();
    expect(details.querySelector("summary")?.textContent).toContain("Options");
    expect(details.querySelector(".kb-disclosure__body")).not.toBeNull();
    expect(STATES[0].html).toContain('<tr id="claim-14">');
  });

  it("labels the type word and the notes under a channel in muted text", () => {
    const html = STATES[0].html;
    expect(html).toContain('<div class="kb-muted">GuildText</div>');
    expect(html).toContain(
      '<div class="kb-muted">news feed: read-only is suggested',
    );
  });
});

describe("Channel claims callouts (#1730)", () => {
  const callouts = (name: string): Element[] => [
    ...docOf(STATES.find((x) => x.name === name)!).querySelectorAll(
      ".kb-callout",
    ),
  ];
  it("says a state in a status callout and a failure in an alert", () => {
    const failed = callouts("scan failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].getAttribute("role")).toBe("alert");
    expect(failed[0].classList.contains("kb-callout--err")).toBe(true);
    expect(failed[0].textContent).toContain("The scan failed: boom.");
    for (const name of [
      "prefilled from the Server scan",
      "problems reading the form",
      "webhook data unavailable",
      "running apply",
    ]) {
      for (const c of callouts(name))
        expect(c.getAttribute("role")).toBe("status");
    }
    expect(callouts("webhook data unavailable")[0].textContent).toContain(
      "Webhook data is unavailable because KoolBot lacks the Manage Webhooks permission.",
    );
  });

  it("keeps cc-job on the callout title, where the poll script writes its text", () => {
    const doc = docOf(STATES.find((x) => x.name === "running apply")!);
    const job = doc.getElementById("cc-job") as Element;
    expect(job.tagName).toBe("P");
    expect(job.classList.contains("kb-callout__title")).toBe(true);
    expect(job.textContent).toBe("Applying…");
    expect(STATES.find((x) => x.name === "running apply")!.html).toContain(
      "/admin/role-groups/job/",
    );
  });

  it("lists the plan's problems and advice in callouts that keep their text", () => {
    const s = STATES.find(
      (x) => x.name === "blocked plan with problems and advice",
    )!;
    const doc = docOf(s);
    const text = [...doc.querySelectorAll(".kb-callout")].map(
      (c) => c.textContent ?? "",
    );
    expect(
      text.some(
        (t) =>
          t.includes("Needs attention (1)") &&
          t.includes("voice-cleanup-risk") &&
          t.includes("no <x>"),
      ),
    ).toBe(true);
    expect(
      text.some(
        (t) =>
          t.includes("Worth knowing (1)") &&
          t.includes("rebind") &&
          t.includes("careful <b>"),
      ),
    ).toBe(true);
    expect(
      doc.querySelectorAll(".kb-badge--off, .kb-badge--warn").length,
    ).toBeGreaterThanOrEqual(2);
    expect(s.html).not.toContain("Apply plan");
  });

  it("says where a prefill came from in one status callout", () => {
    const s = STATES.find((x) => x.name === "prefilled from the Server scan")!;
    expect(s.html).toContain(
      "Prefilled from the Server scan: <strong>loose</strong> is set to be bound to <strong>Quotes</strong>.",
    );
    expect(s.html).toContain(
      "Nothing changes until you preview the plan and apply it.",
    );
  });
});

describe("Channel claims behaviour is unchanged (#1730)", () => {
  it("posts the preview form with its CSRF token and every field name", () => {
    const doc = new JSDOM(mainOf(STATES[0].html)).window.document;
    const form = doc.querySelector(
      'form[action="/admin/adopt/claims/preview"]',
    ) as HTMLFormElement;
    expect(form.method).toBe("post");
    expect(
      form.querySelector('input[name="_csrf"]')?.getAttribute("value"),
    ).toBe("tok");
    const names = new Set(
      [...form.querySelectorAll("[name]")].map((e) => e.getAttribute("name")),
    );
    for (const n of [
      "action_10",
      "bulk_10",
      "action_11",
      "bind_10",
      "bind_14",
      "roles_10",
      "min_10",
      "react_10",
      "replace_10",
      "vmo_10",
      "prefix_10",
      "lock_12",
      "speakers_30",
      "pair_10",
      "pairemoji_10",
      "pairs_all",
      "feed_11",
    ]) {
      expect(names).toContain(n);
    }
    expect(names).not.toContain("pair_20");
    expect(form.querySelector('button[type="submit"]')?.textContent).toBe(
      "Preview changes",
    );
    expect(form.textContent).toContain("Nothing is written to Discord yet.");
    expect(form.querySelectorAll("table")).toHaveLength(2);
  });

  it("keeps the checkboxes' posted values", () => {
    const html = STATES[0].html;
    expect(html).toMatch(/<input type="checkbox" name="pair_10" value="1"/);
    expect(html).toMatch(/<input type="checkbox" name="feed_11" value="1"/);
    expect(html).toMatch(/<input type="checkbox" name="pairs_all" value="1"/);
    expect(html).toMatch(/<input type="checkbox" name="react_10" value="1"/);
  });

  it("keeps the apply form, its confirmation and its hidden fields", () => {
    const s = STATES.find(
      (x) => x.name === "applicable plan with destructive steps",
    )!;
    const doc = new JSDOM(mainOf(s.html)).window.document;
    const form = doc.querySelector(
      'form[action="/admin/adopt/claims/apply"]',
    ) as HTMLFormElement;
    expect(form.getAttribute("data-confirm")).toBe(
      "Apply this plan to Discord? A snapshot is saved first so it can be rolled back.",
    );
    expect(form.getAttribute("data-confirm-tone")).toBe("neutral");
    expect(
      form.querySelector('input[name="_csrf"]')?.getAttribute("value"),
    ).toBe("tok");
    expect(
      form.querySelector('input[name="planId"]')?.getAttribute("value"),
    ).toBe("abc");
    expect(
      form.querySelector('input[name="token"]')?.getAttribute("value"),
    ).toBe("tok-1");
    expect(
      form.querySelector('input[name="confirmDestructive"][required]'),
    ).not.toBeNull();
    expect(form.querySelector("button")?.textContent).toBe("Apply plan");
    expect(form.textContent).toContain(
      "A snapshot of everything touched is saved first.",
    );
  });

  it("offers no apply form for a blocked plan or one with nothing to change", () => {
    for (const name of [
      "blocked plan with problems and advice",
      "plan with nothing to change",
    ]) {
      expect(STATES.find((x) => x.name === name)!.html).not.toContain(
        "/admin/adopt/claims/apply",
      );
    }
  });

  it("keeps the suggestions section label for assistive technology", () => {
    const html = STATES[0].html;
    expect(html).toContain('aria-labelledby="cc-suggestions"');
    expect(html).toContain('id="cc-suggestions"');
    expect(html).toContain("Game-role categories");
    expect(html).toContain("Feeds");
  });
});
