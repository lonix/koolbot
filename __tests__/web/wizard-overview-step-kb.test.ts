/* global Document, Element, HTMLInputElement */
/**
 * The Setup wizard's overview (*Choose features*) and its step pages are built
 * from the design system's components and no longer from the old classes
 * (#1751, epic #1639): PageHeader, Panel, Callout, Button, SettingRow and Switch
 * (docs/design/components.md). Checked on the markup the pages send, for every
 * state each page has. The routes, field names, posted values and the Picker
 * create rows are checked next to it, because a restyle must not move them.
 */
import { describe, it, expect } from "@jest/globals";
import { JSDOM } from "jsdom";
import {
  renderWizardPage,
  renderWizardStepPage,
  type WizardPageProps,
  type WizardStepPageProps,
} from "../../src/web/admin-views.js";
import {
  defaultConfig,
  settingsMetadata,
} from "../../src/services/config-schema.js";
import { WIZARD_FEATURE_SETTINGS } from "../../src/web/routes/write/helpers.js";

const COMMON = { csrfToken: "csrf", remainingMs: 60_000 };

const dom = (html: string): Document => new JSDOM(html).window.document;
const main = (html: string): Element => {
  const el = dom(html).querySelector("main");
  if (!el) throw new Error("no <main>");
  return el;
};

/** The old classes the issue lists, and the page-local ones that went with them. */
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
  "field-row",
  "field-label",
  "help",
  "dep-off",
  "feature-card",
  "fc-info",
  "fc-name",
  "fc-desc",
  "fc-current",
  "wizard-features",
  "settings-warn",
  "settings-dep-hint",
];

/** The cron picker's classes: hooks of its script (`CRON_PICKER_SCRIPT`), drawn by the shared control renderer. */
const CRON_HOOK = /^cron-[a-z-]+$/;

const classTokens = (root: Element): Set<string> => {
  const used = new Set<string>();
  for (const el of root.querySelectorAll("[class]")) {
    for (const token of el.getAttribute("class")?.split(/\s+/) ?? []) {
      if (token) used.add(token);
    }
  }
  return used;
};

// ---------- fixtures ----------

const CHANNELS = [
  { id: "t1", name: "general" },
  { id: "t2", name: "quotes" },
];
const PICKERS = {
  textChannels: CHANNELS,
  voiceChannels: [{ id: "v1", name: "Lobby" }],
  categoryChannels: [{ id: "c1", name: "Voice" }],
  roles: [
    { id: "r1", name: "Admin" },
    { id: "r2", name: "Member" },
  ],
};

const ADMIN = {
  has: { check: { state: "has" as const }, inviteUrl: null },
  missing: {
    check: { state: "missing" as const },
    inviteUrl:
      "https://discord.com/oauth2/authorize?client_id=123456789012345678&permissions=8&scope=bot",
  },
  unknown: {
    check: {
      state: "unknown" as const,
      reason: "Discord could not be reached.",
    },
    inviteUrl: null,
  },
};

const FEATURES = ["voicechannels", "polls", "quotes"];
const overview = (over: Partial<WizardPageProps> = {}): string =>
  renderWizardPage({
    ...COMMON,
    featureOrder: FEATURES,
    featureStatus: { voicechannels: true, polls: false, quotes: true },
    ...over,
  });

const OVERVIEW_STATES: Array<[string, string]> = [
  ["overview", overview()],
  ["overview, bot has Administrator", overview({ admin: ADMIN.has })],
  [
    "overview, bot lacks Administrator, one feature ticked",
    overview({ admin: ADMIN.missing, ticked: ["polls"] }),
  ],
  [
    "overview, bot lacks Administrator, no invite link",
    overview({ admin: { ...ADMIN.missing, inviteUrl: null } }),
  ],
  [
    "overview, Administrator could not be checked",
    overview({ admin: ADMIN.unknown }),
  ],
  [
    "overview, every feature, none on",
    overview({
      featureOrder: Object.keys(WIZARD_FEATURE_SETTINGS),
      featureStatus: {},
    }),
  ],
];

const step = (over: Partial<WizardStepPageProps> = {}): string =>
  renderWizardStepPage({
    ...COMMON,
    ...PICKERS,
    stepIndex: 0,
    featureKeys: ["voicechannels", "quotes", "polls"],
    featureKey: "voicechannels",
    settingKeys: ["voicechannels.enabled", "voicechannels.category_id"],
    currentValues: {
      "voicechannels.enabled": true,
      "voicechannels.category_id": "c1",
    },
    metadata: settingsMetadata,
    defaultValues: {
      "voicechannels.enabled": false,
      "voicechannels.category_id": "",
    },
    enabledByKey: { "voicechannels.enabled": true },
    ...over,
  });

/** Every setting of every feature, so each control shape the wizard can draw is in the scan. */
const allSettings = (feature: string): string => {
  const keys = WIZARD_FEATURE_SETTINGS[feature] ?? [];
  const cfg = defaultConfig as unknown as Record<string, unknown>;
  const enabledByKey: Record<string, boolean> = {};
  for (const k of keys) enabledByKey[k] = k.endsWith(".enabled");
  return step({
    featureKeys: [feature],
    featureKey: feature,
    settingKeys: keys,
    currentValues: Object.fromEntries(keys.map((k) => [k, cfg[k]])),
    defaultValues: Object.fromEntries(keys.map((k) => [k, cfg[k]])),
    enabledByKey,
    pickerCreate: { kind: "channel", channelKind: "text", ok: true },
    pickerCreateCategory: { kind: "category", ok: true },
  });
};

const STEP_STATES: Array<[string, string]> = [
  ["step, first of three", step()],
  [
    "step, middle of three",
    step({
      stepIndex: 1,
      featureKey: "quotes",
      settingKeys: ["quotes.enabled", "quotes.cooldown"],
      currentValues: { "quotes.enabled": true },
      defaultValues: { "quotes.enabled": false },
      enabledByKey: { "quotes.enabled": true },
    }),
  ],
  [
    "step, last of three (Review)",
    step({
      stepIndex: 2,
      featureKey: "polls",
      settingKeys: ["polls.enabled", "polls.cooldown_days"],
      currentValues: { "polls.enabled": true },
      defaultValues: { "polls.enabled": false },
      enabledByKey: { "polls.enabled": true },
    }),
  ],
  ["step, the only feature", step({ featureKeys: ["voicechannels"] })],
  [
    "step, flash",
    step({ flash: { type: "err", text: "One value was rejected." } }),
  ],
  [
    "step, feature switched off, rows dimmed by the cascade",
    step({ currentValues: { "voicechannels.enabled": false } }),
  ],
  [
    "step, a row locked by a dependency",
    step({
      featureKeys: ["achievements"],
      featureKey: "achievements",
      settingKeys: ["achievements.enabled"],
      currentValues: { "achievements.enabled": true },
      defaultValues: { "achievements.enabled": false },
      enabledByKey: {
        "achievements.enabled": true,
        "voicetracking.enabled": false,
      },
    }),
  ],
  [
    "step, a value below its warning threshold",
    step({
      featureKeys: ["voicetracking"],
      featureKey: "voicetracking",
      settingKeys: ["voicetracking.seen_retention_days"],
      currentValues: { "voicetracking.seen_retention_days": 2 },
      defaultValues: { "voicetracking.seen_retention_days": 30 },
      metadata: {
        "voicetracking.seen_retention_days": {
          label: "Retention days",
          description: "How long to keep sessions.",
          category: "voicetracking",
          type: "number",
          warnBelow: { value: 7, message: "Below 7 days loses history." },
        },
      } as unknown as WizardStepPageProps["metadata"],
      enabledByKey: {},
    }),
  ],
  [
    "step, a key the schema does not describe",
    step({
      settingKeys: ["voicechannels.unknown_key"],
      currentValues: {},
      metadata: {},
      defaultValues: { "voicechannels.unknown_key": 3 },
      enabledByKey: {},
    }),
  ],
  [
    "step, leaderboard roles (tier editor note)",
    step({
      featureKeys: ["leaderboard_roles"],
      featureKey: "leaderboard_roles",
      settingKeys: ["leaderboard_roles.enabled"],
      currentValues: { "leaderboard_roles.enabled": true },
      defaultValues: { "leaderboard_roles.enabled": false },
      enabledByKey: { "leaderboard_roles.enabled": true },
    }),
  ],
  [
    "step, a channel to be created",
    step({
      featureKeys: ["quotes"],
      featureKey: "quotes",
      settingKeys: ["quotes.enabled", "quotes.channel_id"],
      currentValues: {
        "quotes.enabled": true,
        "quotes.channel_id": "create:Quote Wall",
      },
      defaultValues: { "quotes.enabled": false, "quotes.channel_id": "" },
      pickerCreate: { kind: "channel", channelKind: "text", ok: true },
      enabledByKey: { "quotes.enabled": true },
    }),
  ],
  [
    "step, creating a channel is not possible",
    step({
      featureKeys: ["quotes"],
      featureKey: "quotes",
      settingKeys: ["quotes.enabled", "quotes.channel_id"],
      currentValues: { "quotes.enabled": true, "quotes.channel_id": "" },
      defaultValues: { "quotes.enabled": false, "quotes.channel_id": "" },
      pickerCreate: {
        kind: "channel",
        channelKind: "text",
        ok: false,
        reason: "The bot needs Manage Channels to create a channel.",
      },
      enabledByKey: { "quotes.enabled": true },
    }),
  ],
  [
    "step, a category offered",
    step({
      featureKeys: ["tickets"],
      featureKey: "tickets",
      settingKeys: ["tickets.enabled", "tickets.category_id"],
      currentValues: { "tickets.enabled": true, "tickets.category_id": "" },
      defaultValues: { "tickets.enabled": false, "tickets.category_id": "" },
      pickerCreateCategory: { kind: "category", ok: true },
      enabledByKey: { "tickets.enabled": true },
    }),
  ],
  ["step, settings unavailable, first", step({ settingsUnavailable: true })],
  [
    "step, settings unavailable, later step with a flash",
    step({
      settingsUnavailable: true,
      stepIndex: 2,
      featureKey: "polls",
      flash: { type: "warn", text: "Reload." },
    }),
  ],
  ...Object.keys(WIZARD_FEATURE_SETTINGS).map((f): [string, string] => [
    `step, all settings of ${f}`,
    allSettings(f),
  ]),
];

// ---------- the pages are kb- only ----------

describe.each([...OVERVIEW_STATES, ...STEP_STATES])(
  "Setup wizard pages: %s",
  (_name, html) => {
    const body = main(html);

    it("renders content", () => {
      expect(body.textContent?.length ?? 0).toBeGreaterThan(50);
    });

    it("uses no old class", () => {
      const used = classTokens(body);
      expect(OLD_CLASSES.filter((c) => used.has(c))).toEqual([]);
    });

    it("uses only kb- classes, or the state classes the components script reads", () => {
      const allowed = new Set(["is-done", "is-off", "is-inactive"]);
      const stray = [...classTokens(body)].filter(
        (c) => !c.startsWith("kb-") && !allowed.has(c) && !CRON_HOOK.test(c),
      );
      expect(stray).toEqual([]);
    });

    it("keeps the cron picker's script hooks only inside a control", () => {
      for (const el of body.querySelectorAll("[class]")) {
        const hooks = [...el.classList].filter((c) => CRON_HOOK.test(c));
        if (hooks.length > 0) {
          expect(el.closest(".kb-setting__control")).not.toBeNull();
        }
      }
    });

    it("has one h1 and no bare table, inline style or style block", () => {
      expect(body.querySelectorAll("h1")).toHaveLength(1);
      expect(body.querySelectorAll("table")).toHaveLength(0);
      expect(body.querySelectorAll("style")).toHaveLength(0);
      // The width of a number, duration or cron field comes from the shared
      // control renderer (left in place, see the PR); nothing else is styled.
      for (const el of body.querySelectorAll("[style]")) {
        expect(el.closest(".kb-setting__control")).not.toBeNull();
        expect(el.getAttribute("style")).toMatch(/^width:[\d.]+rem$/);
      }
    });

    it("has at most one primary button", () => {
      expect(body.querySelectorAll(".kb-btn--primary").length).toBeLessThan(2);
    });

    it("opens with the page header, in the page's own stack", () => {
      expect(
        body.querySelector("header.kb-pagehead h1.kb-pagehead__title"),
      ).not.toBeNull();
    });
  },
);

// ---------- Choose features ----------

describe("Setup wizard overview", () => {
  const html = overview();
  const doc = dom(html);
  const form = doc.querySelector("form[action='/admin/wizard/start']");

  it("posts the chosen features to the same route with the CSRF token", () => {
    expect(form?.getAttribute("method")?.toUpperCase()).toBe("POST");
    expect(
      form
        ?.querySelector("input[type=hidden][name=_csrf]")
        ?.getAttribute("value"),
    ).toBe("csrf");
  });

  it("offers one checkbox per feature, named features, unchecked, with its own id", () => {
    for (const fk of FEATURES) {
      const box = doc.getElementById(`feat-${fk}`) as HTMLInputElement | null;
      expect(box?.getAttribute("type")).toBe("checkbox");
      expect(box?.getAttribute("name")).toBe("features");
      expect(box?.getAttribute("value")).toBe(fk);
      expect(box?.hasAttribute("checked")).toBe(false);
      expect(form?.contains(box)).toBe(true);
    }
  });

  it("names each checkbox by its feature, and shows today's state as a Badge", () => {
    for (const [fk, name, on] of [
      ["voicechannels", "Voice Channels", true],
      ["polls", "Polls", false],
    ] as const) {
      const box = doc.getElementById(`feat-${fk}`);
      const labelledBy = box?.getAttribute("aria-labelledby");
      const label =
        (labelledBy && doc.getElementById(labelledBy)) ||
        doc.querySelector(`label[for="feat-${fk}"]`);
      expect(label?.textContent).toContain(name);
      const row = box?.closest(".kb-setting");
      const badge = row?.querySelector(".kb-badge");
      expect(badge?.textContent).toBe(on ? "Currently on" : "Currently off");
      expect(
        badge?.classList.contains(on ? "kb-badge--on" : "kb-badge--off"),
      ).toBe(true);
    }
  });

  it("keeps the ticked features ticked after Check again", () => {
    const d = dom(overview({ admin: ADMIN.missing, ticked: ["polls"] }));
    expect(d.getElementById("feat-polls")?.hasAttribute("checked")).toBe(true);
    expect(
      d.getElementById("feat-voicechannels")?.hasAttribute("checked"),
    ).toBe(false);
  });

  it("has Next as the one primary button, then Cancel to the dashboard", () => {
    const primary = form?.querySelectorAll(".kb-btn--primary");
    expect(primary).toHaveLength(1);
    expect(primary?.[0].textContent?.trim()).toBe("Next →");
    expect(primary?.[0].getAttribute("type")).toBe("submit");
    const cancel = [...(form?.querySelectorAll("a.kb-btn") ?? [])].find(
      (a) => a.textContent?.trim() === "Cancel",
    );
    expect(cancel?.getAttribute("href")).toBe("/admin/");
    expect(cancel?.classList.contains("kb-btn--primary")).toBe(false);
  });

  it("keeps the adoption links and says nothing changes until a plan is applied", () => {
    const panel = doc.getElementById("wizard-adoption");
    expect(panel?.classList.contains("kb-panel")).toBe(true);
    const hrefs = [...(panel?.querySelectorAll("a") ?? [])].map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).toEqual([
      "/admin/adopt",
      "/admin/role-groups",
      "/admin/rules",
      "/admin/adopt/claims",
      "/admin/adopt/history",
    ]);
    expect(panel?.textContent).toContain(
      "Nothing is changed until you preview",
    );
  });

  it("says changes are only applied at the final step, in a Callout", () => {
    const callout = [...doc.querySelectorAll(".kb-callout")].find((c) =>
      c.textContent?.includes(
        "Changes are only applied at the final confirmation",
      ),
    );
    expect(callout).toBeDefined();
    expect(callout?.getAttribute("role")).toBe("status");
  });

  it("puts the Administrator state before the features, inside the form", () => {
    const d = dom(overview({ admin: ADMIN.missing }));
    const f = d.querySelector("form[action='/admin/wizard/start']");
    const admin = f?.querySelector("[data-wizard-admin='missing']");
    const first = f?.querySelector("[name=features]");
    expect(admin).not.toBeNull();
    expect(
      admin!.compareDocumentPosition(first!) &
        0x04 /* DOCUMENT_POSITION_FOLLOWING */,
    ).toBeTruthy();
  });

  it("makes Enter mean Next when Check again sits ahead of it", () => {
    for (const admin of [ADMIN.missing, ADMIN.unknown]) {
      const f = dom(overview({ admin })).querySelector(
        "form[action='/admin/wizard/start']",
      );
      const firstSubmit = f?.querySelector("button[type=submit]");
      expect(firstSubmit?.hasAttribute("hidden")).toBe(true);
      expect(firstSubmit?.textContent).toBe("Next");
      const again = f?.querySelector(
        "button[formaction='/admin/wizard/check']",
      );
      expect(again?.textContent).toBe("Check again");
    }
    const has = dom(overview({ admin: ADMIN.has })).querySelector(
      "form[action='/admin/wizard/start']",
    );
    expect(has?.querySelector("button[hidden]")).toBeNull();
    expect(
      has?.querySelector("button[formaction='/admin/wizard/check']"),
    ).toBeNull();
  });

  it("sorts features that are on above the ones that are off", () => {
    const ids = [...doc.querySelectorAll("input[name=features]")].map(
      (i) => i.id,
    );
    expect(ids).toEqual(["feat-voicechannels", "feat-quotes", "feat-polls"]);
  });
});

// ---------- Step ----------

describe("Setup wizard step page", () => {
  it("titles the page with the feature, once, and says what it is for", () => {
    const d = dom(step());
    expect(d.querySelector("h1")?.textContent).toBe("Voice Channels");
    expect(d.querySelector(".kb-pagehead__sub")?.textContent).toBe(
      "Dynamic voice channel management with lobby.",
    );
  });

  it("posts to the step route, with the CSRF token and the cascade scope", () => {
    const f = dom(
      step({
        stepIndex: 2,
        featureKey: "polls",
        settingKeys: [],
        currentValues: {},
        defaultValues: {},
      }),
    ).querySelector("form[action='/admin/wizard/step/2']");
    expect(f?.getAttribute("method")?.toUpperCase()).toBe("POST");
    expect(f?.hasAttribute("data-cascade-scope")).toBe(true);
    expect(
      f?.querySelector("input[type=hidden][name=_csrf]")?.getAttribute("value"),
    ).toBe("csrf");
  });

  it("renders each setting as a SettingRow with its label tied to the control", () => {
    const d = dom(step());
    const rows = d.querySelectorAll("form .kb-settings > .kb-setting");
    expect(rows).toHaveLength(2);
    for (const key of ["voicechannels.enabled", "voicechannels.category_id"]) {
      const control = d.getElementById(`wiz-${key}`);
      expect(control).not.toBeNull();
      const row = control!.closest(".kb-setting");
      expect(row).not.toBeNull();
      // The key sits under the row, and the control is described by it.
      expect(
        row?.querySelector(".kb-setting__extra .kb-mono")?.textContent,
      ).toBe(key);
      expect(control!.getAttribute("aria-describedby")).toContain(
        `wiz-${key}-key`,
      );
      const label = d.getElementById(`wiz-${key}-label`);
      expect(label?.getAttribute("for")).toBe(`wiz-${key}`);
    }
  });

  it("adds no field the old page did not post", () => {
    const f = dom(step()).querySelector("form[action='/admin/wizard/step/0']");
    expect(f?.querySelector("input[name=keys]")).toBeNull();
    const names = [...(f?.querySelectorAll("[name]") ?? [])].map((e) =>
      e.getAttribute("name"),
    );
    expect(names).toContain("value_voicechannels.enabled");
    expect(names).toContain("value_voicechannels.category_id");
  });

  it("keeps a master toggle the cascade script can find, and every row inside a .kb-setting", () => {
    const d = dom(step());
    const master = d.querySelector("[data-cascade-master]");
    expect(master?.getAttribute("name")).toBe("value_voicechannels.enabled");
    const scope = master?.closest("[data-cascade-scope]");
    for (const el of scope!.querySelectorAll(
      "input:not([type=hidden]),select,textarea",
    )) {
      if (el === master) continue;
      expect(el.closest(".kb-setting")).not.toBeNull();
    }
  });

  it("links the help text, warning and dependency hint to the control", () => {
    const html = STEP_STATES.find(([n]) => n.includes("below its warning"))![1];
    const d = dom(html);
    const control = d.getElementById("wiz-voicetracking.seen_retention_days");
    expect(control?.getAttribute("aria-describedby")).toBe(
      "wiz-voicetracking.seen_retention_days-warn wiz-voicetracking.seen_retention_days-help wiz-voicetracking.seen_retention_days-key",
    );
    expect(
      d.getElementById("wiz-voicetracking.seen_retention_days-warn")
        ?.textContent,
    ).toBe("Below 7 days loses history.");
    expect(
      d.getElementById("wiz-voicetracking.seen_retention_days-help")
        ?.textContent,
    ).toBe("How long to keep sessions.");
  });

  it("locks a row whose dependency is off, and says why", () => {
    const d = dom(
      STEP_STATES.find(([n]) => n.includes("locked by a dependency"))![1],
    );
    const control = d.getElementById("wiz-achievements.enabled");
    expect(control?.hasAttribute("disabled")).toBe(true);
    expect(control?.hasAttribute("data-dep-locked")).toBe(true);
    expect(control?.closest(".kb-setting")?.classList).toContain(
      "kb-setting--locked",
    );
    const hint = d.getElementById("wiz-achievements.enabled-dep");
    expect(hint?.textContent).toMatch(/^Requires .+ enabled$/);
    expect(control?.getAttribute("aria-describedby")).toContain(
      "wiz-achievements.enabled-dep",
    );
  });

  it("labels the last step Review and the others Next, Next being the one primary button", () => {
    for (const [index, label] of [
      [0, "Next →"],
      [1, "Next →"],
      [2, "Review →"],
    ] as const) {
      const f = dom(
        step({
          stepIndex: index,
          featureKey: "polls",
          settingKeys: [],
          currentValues: {},
          defaultValues: {},
        }),
      ).querySelector(`form[action='/admin/wizard/step/${index}']`);
      const primary = f?.querySelectorAll(".kb-btn--primary");
      expect(primary).toHaveLength(1);
      expect(primary?.[0].tagName).toBe("BUTTON");
      expect(primary?.[0].getAttribute("type")).toBe("submit");
      expect(primary?.[0].textContent?.trim()).toBe(label);
    }
  });

  it("links Previous to the prior step (the Access step from the first) and back to Choose features", () => {
    const links = (index: number): Array<[string, string | null]> =>
      [
        ...dom(step({ stepIndex: index })).querySelectorAll("main a.kb-btn"),
      ].map((a) => [a.textContent?.trim() ?? "", a.getAttribute("href")]);
    expect(links(0)).toEqual([
      ["← Previous", "/admin/wizard?step=access"],
      ["← Back to Choose features", "/admin/wizard"],
    ]);
    expect(links(2)).toEqual([
      ["← Previous", "/admin/wizard?step=1"],
      ["← Back to Choose features", "/admin/wizard"],
    ]);
  });

  it("shows the flash before the settings", () => {
    const d = dom(
      step({ flash: { type: "err", text: "One value was rejected." } }),
    );
    const flash = d.querySelector("[data-flash]");
    expect(flash?.getAttribute("role")).toBe("alert");
    expect(
      flash!.compareDocumentPosition(d.querySelector("main form")!) & 0x04,
    ).toBeTruthy();
  });

  it("points leaderboard roles at the tier editor, in the help text of the form", () => {
    const d = dom(STEP_STATES.find(([n]) => n.includes("tier editor"))![1]);
    const link = [...d.querySelectorAll("form a")].find(
      (a) => a.getAttribute("href") === "/admin/leaderboard-roles",
    );
    expect(link?.textContent).toBe("Leaderboard Roles");
  });

  it("replaces the form with the Callout when settings are unavailable, keeping the way out", () => {
    const d = dom(
      STEP_STATES.find(([n]) => n === "step, settings unavailable, first")![1],
    );
    expect(d.querySelector("form[action^='/admin/wizard/step']")).toBeNull();
    const callout = d.querySelector("main .kb-callout--warn");
    expect(callout?.getAttribute("role")).toBe("status");
    expect(callout?.textContent).toContain("Settings could not be loaded");
    // Without a form there is nothing to go Next with, so no primary button.
    expect(d.querySelectorAll("main .kb-btn--primary")).toHaveLength(0);
    expect(
      [...d.querySelectorAll("main a.kb-btn")].map((a) => [
        a.textContent?.trim(),
        a.getAttribute("href"),
      ]),
    ).toEqual([
      ["← Previous", "/admin/wizard?step=access"],
      ["← Back to Choose features", "/admin/wizard"],
    ]);
  });

  it("keeps the Picker create rows, their data-picker-meta and what they post", () => {
    const meta = (name: string): { create?: Record<string, unknown> } => {
      const d = dom(STEP_STATES.find(([n]) => n === name)![1]);
      const picker = d.querySelector("main .kb-picker[data-picker-meta]");
      expect(picker?.closest(".kb-setting__control")).not.toBeNull();
      expect(
        d.querySelector("main select[name='value_quotes.channel_id']"),
      ).not.toBeNull();
      return JSON.parse(picker!.getAttribute("data-picker-meta")!);
    };
    expect(meta("step, a channel to be created").create).toEqual({
      kind: "channel",
      channelKind: "text",
      ok: true,
    });
    expect(meta("step, creating a channel is not possible").create).toEqual({
      kind: "channel",
      channelKind: "text",
      ok: false,
      reason: "The bot needs Manage Channels to create a channel.",
    });
    const pending = dom(
      STEP_STATES.find(([n]) => n === "step, a channel to be created")![1],
    ).querySelector("main option[data-create]");
    expect(pending?.getAttribute("value")).toBe("create:Quote Wall");
    expect(pending?.hasAttribute("selected")).toBe(true);
  });
});
