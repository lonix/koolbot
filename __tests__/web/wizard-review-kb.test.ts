/* global Document, DocumentFragment, ParentNode, HTMLButtonElement, HTMLFormElement, HTMLInputElement */
import { describe, it, expect } from "@jest/globals";
import { JSDOM } from "jsdom";
import {
  renderWizardConfirmPage,
  type WizardConfirmPageProps,
} from "../../src/web/admin-views.js";
import {
  renderAccessReview,
  renderWizardAccessPage,
} from "../../src/web/wizard-access-view.js";
import type { AccessChange } from "../../src/services/wizard-access.js";

/**
 * The Setup wizard Review page and the Access step's action row on the kb-
 * components (#1752, part of #1639): every class in the page's own markup is a
 * kb- class (plus the two state hooks of the Steps and AccessCard lists), no
 * table is bare, the panels, buttons and callouts follow the manual, and the
 * routes, field names, hidden fields, the Apply gating and the no-JavaScript
 * Cancel are unchanged.
 */

const COMMON = { csrfToken: "csrf-token", remainingMs: 900_000 };

const change = (name: string, kind: "create" | "update" = "create") =>
  ({
    kind,
    roleId: `r-${name}`,
    roleName: name,
    groupId: null,
    groupName: name,
    scopesBefore: [],
    scopesAfter: ["staff"],
    capabilitiesBefore: [],
    capabilitiesAfter: ["staff"],
  }) as AccessChange;

const SETTINGS: Pick<WizardConfirmPageProps, "pending" | "metadata"> = {
  pending: [
    ["voicechannels.enabled", true],
    ["quotes.max_length", 500],
  ],
  metadata: {
    "voicechannels.enabled": {
      description: "Turn dynamic voice channels on.",
      category: "voicechannels",
    },
  },
};

const NO_SETTINGS = { pending: [], metadata: {} };

const ROLE_REVIEW = {
  roles: [{ name: "Quartermaster", scopes: ["staff" as const] }],
  planId: "0123456789abcdef",
  problems: [] as string[],
};

const CREATIONS = [
  {
    kind: "text" as const,
    name: "quotes",
    settingLabel: "Quotes channel",
    parent: { name: "Community" },
  },
  {
    kind: "category" as const,
    name: "Hangout",
    settingLabel: "Voice category",
  },
];

const CASCADE = {
  cascade: [
    { key: "voicetracking.enabled", dependents: ["achievements.enabled"] },
  ],
  cascadeKeys: ["achievements.enabled"],
  fingerprint: "achievements.enabled",
  blockers: [],
};

const BLOCKED = {
  cascade: [],
  cascadeKeys: [],
  fingerprint: "",
  blockers: [
    {
      key: "achievements.enabled",
      direction: "enable" as const,
      related: ["voicetracking.enabled"],
    },
  ],
};

interface State {
  name: string;
  props: Partial<WizardConfirmPageProps>;
  /** Apply is disabled in this state. */
  disabled: boolean;
  /** The Apply form carries an id so outside switches can join it. */
  formId: boolean;
}

const STATES: State[] = [
  { name: "settings only", props: SETTINGS, disabled: false, formId: false },
  {
    name: "nothing to apply",
    props: NO_SETTINGS,
    disabled: true,
    formId: false,
  },
  {
    name: "flash after a redirect",
    props: { ...SETTINGS, flash: { type: "err", text: "Apply failed." } },
    disabled: false,
    formId: false,
  },
  {
    name: "administrator present",
    props: {
      ...SETTINGS,
      admin: { check: { state: "has" }, inviteUrl: null },
    },
    disabled: false,
    formId: false,
  },
  {
    name: "administrator missing",
    props: {
      ...SETTINGS,
      admin: {
        check: { state: "missing" },
        inviteUrl: "https://discord.com/oauth2/authorize?client_id=1",
      },
    },
    disabled: false,
    formId: true,
  },
  {
    name: "administrator unknown",
    props: {
      ...SETTINGS,
      admin: {
        check: { state: "unknown", reason: "Discord could not be reached." },
        inviteUrl: null,
      },
    },
    disabled: false,
    formId: false,
  },
  {
    name: "role mapping changes and a gap",
    props: {
      ...SETTINGS,
      accessChanges: [change("Moderator")],
      accessFingerprint: "fp-1",
      accessGaps: [
        {
          feature: "events",
          scope: "host",
          message: "Events is on and nobody can host yet.",
        },
      ],
    },
    disabled: false,
    formId: false,
  },
  {
    name: "role mapping only",
    props: { ...NO_SETTINGS, accessChanges: [change("Moderator", "update")] },
    disabled: false,
    formId: false,
  },
  {
    name: "role mapping blocked",
    props: {
      ...NO_SETTINGS,
      accessChanges: [],
      accessProblem: "A role you picked no longer exists in Discord.",
    },
    disabled: true,
    formId: false,
  },
  {
    name: "typed names are existing roles",
    props: {
      ...NO_SETTINGS,
      roleMatches: [
        { name: "Moderator", scopes: ["admin"], members: 12 },
        { name: "Event crew", scopes: ["host"], members: null },
      ],
    },
    disabled: true,
    formId: false,
  },
  {
    name: "roles to create",
    props: {
      ...NO_SETTINGS,
      accessChanges: [change("Quartermaster")],
      roleReview: ROLE_REVIEW,
    },
    disabled: false,
    formId: false,
  },
  {
    name: "roles can't be created",
    props: {
      ...NO_SETTINGS,
      roleReview: {
        roles: ROLE_REVIEW.roles,
        planId: null,
        problems: ["The bot needs Manage Roles."],
      },
    },
    disabled: true,
    formId: false,
  },
  {
    name: "channels and categories to create",
    props: {
      ...NO_SETTINGS,
      creations: CREATIONS,
      createPlanId: "abcdef0123456789",
    },
    disabled: false,
    formId: false,
  },
  {
    name: "channels can't be created",
    props: {
      ...SETTINGS,
      creations: CREATIONS,
      createProblems: ["Two channels are named quotes."],
    },
    disabled: true,
    formId: false,
  },
  {
    name: "a feature turned off with parts that need it",
    props: { ...SETTINGS, dependencies: CASCADE },
    disabled: false,
    formId: true,
  },
  {
    name: "settings that cannot be applied together",
    props: { ...SETTINGS, dependencies: BLOCKED },
    disabled: true,
    formId: true,
  },
  {
    name: "everything at once",
    props: {
      ...SETTINGS,
      flash: { type: "warn", text: "Check the plan." },
      admin: { check: { state: "missing" }, inviteUrl: null },
      accessChanges: [change("Quartermaster")],
      accessFingerprint: "fp-2",
      accessGaps: [
        {
          feature: "events",
          scope: "host",
          message: "Events is on and nobody can host yet.",
        },
      ],
      roleMatches: [{ name: "Moderator", scopes: ["admin"], members: 3 }],
      roleReview: ROLE_REVIEW,
      creations: CREATIONS,
      createPlanId: "abcdef0123456789",
      dependencies: CASCADE,
    },
    disabled: false,
    formId: true,
  },
];

const render = (s: State): string =>
  renderWizardConfirmPage({
    ...COMMON,
    pending: [],
    metadata: {},
    ...s.props,
  });

/** `is-done` and `is-not` are the state hooks of the Steps bar and the AccessCard list. */
const STATE_HOOKS = new Set(["is-done", "is-not"]);

/**
 * Every class that is not a kb- class (bar the state hooks), every table that
 * is not a `kb-table`, and every inline style, found on the parsed DOM.
 */
const nonKbClasses = (root: ParentNode): string[] => {
  const found: string[] = [];
  for (const el of root.querySelectorAll("*")) {
    for (const t of el.classList) {
      if (!t.startsWith("kb-") && !STATE_HOOKS.has(t)) found.push(t);
    }
    if (el.tagName === "TABLE" && !el.classList.contains("kb-table")) {
      found.push("<table>");
    }
    if (el.hasAttribute("style")) found.push("style");
  }
  return found;
};

/**
 * The page's own content: the page parsed with jsdom (which runs no script),
 * reduced to its `<main>` element, with every `script` element removed.
 */
const docOf = (html: string): Document => {
  const doc = new JSDOM(html).window.document;
  const main = doc.querySelector("main");
  if (!main) throw new Error("the page has no <main>");
  for (const script of main.querySelectorAll("script")) script.remove();
  doc.body.replaceChildren(main);
  return doc;
};

describe("the class scan (#1752)", () => {
  it("finds an old class, a bare table and an inline style, and ignores the state hooks", () => {
    const old = JSDOM.fragment(
      '<div class="card kb-panel is-done"><table style="x"><tr><td class="muted">a</td></tr></table></div>',
    );
    expect(nonKbClasses(old)).toEqual(["card", "<table>", "style", "muted"]);
  });
});

describe("Review page markup (#1752)", () => {
  it.each(STATES)("$name: only kb- classes and no bare table", (s) => {
    expect(nonKbClasses(docOf(render(s)))).toEqual([]);
  });

  it.each(STATES)(
    "$name: one h1 in the page header, no kb-row on a panel title",
    (s) => {
      const doc = docOf(render(s));
      expect(doc.querySelectorAll("h1")).toHaveLength(1);
      const h1 = doc.querySelector("header.kb-pagehead h1.kb-pagehead__title");
      expect(h1?.textContent).toBe("Review configuration");
      expect(doc.querySelector(".kb-pagehead__sub strong")?.textContent).toBe(
        "Apply",
      );
      for (const t of doc.querySelectorAll(".kb-panel__title")) {
        expect(t.classList.contains("kb-row")).toBe(false);
      }
    },
  );

  it.each(STATES)(
    "$name: panels sit in a kb-stack, are named, and tables scroll inside them",
    (s) => {
      const doc = docOf(render(s));
      for (const p of doc.querySelectorAll(".kb-panel")) {
        expect(p.tagName).toBe("SECTION");
        expect(p.parentElement?.classList.contains("kb-stack")).toBe(true);
        const labelled = p.getAttribute("aria-labelledby");
        expect(labelled).toBeTruthy();
        expect(doc.getElementById(labelled as string)).not.toBeNull();
      }
      for (const t of doc.querySelectorAll("table")) {
        expect(t.classList.contains("kb-table")).toBe(true);
        expect(t.closest(".kb-panel__body--flush")).not.toBeNull();
        expect(t.getAttribute("aria-label")).toBeTruthy();
        // Hidden screen-reader text would escape the scroll box: aria-label instead.
        expect(
          t
            .closest(".kb-panel__body--flush")
            ?.querySelector(".kb-visually-hidden"),
        ).toBeNull();
      }
    },
  );

  it.each(STATES)("$name: exactly one primary button, and it is Apply", (s) => {
    const doc = docOf(render(s));
    const primary = [...doc.querySelectorAll(".kb-btn--primary")];
    expect(primary).toHaveLength(1);
    expect(primary[0].textContent?.trim()).toBe("Apply");
    expect(primary[0].getAttribute("type")).toBe("submit");
  });

  it.each(STATES)("$name: Apply gating and its reason", (s) => {
    const doc = docOf(render(s));
    const apply = doc.querySelector(
      "form[action='/admin/wizard/apply'] button.kb-btn--primary",
    ) as HTMLButtonElement;
    expect(apply.disabled).toBe(s.disabled);
    const why = doc.getElementById("wizard-apply-why");
    if (s.disabled) {
      expect(apply.getAttribute("aria-describedby")).toBe("wizard-apply-why");
      expect(why?.classList.contains("kb-help")).toBe(true);
      expect(why?.textContent?.length).toBeGreaterThan(10);
    } else {
      expect(apply.hasAttribute("aria-describedby")).toBe(false);
      expect(why).toBeNull();
    }
  });

  it.each(STATES)("$name: forms, CSRF and the no-JavaScript Cancel", (s) => {
    const doc = docOf(render(s));
    const apply = doc.querySelector(
      "form[action='/admin/wizard/apply']",
    ) as HTMLFormElement;
    const cancel = doc.querySelector(
      "form[action='/admin/wizard/cancel']",
    ) as HTMLFormElement;
    for (const f of [apply, cancel]) {
      expect(f.method).toBe("post");
      expect(
        (f.querySelector("input[name=_csrf]") as HTMLInputElement).value,
      ).toBe("csrf-token");
      expect(f.hasAttribute("data-confirm")).toBe(false);
    }
    expect(apply.hasAttribute("id")).toBe(s.formId);
    if (s.formId) expect(apply.id).toBe("wizard-apply-form");
    const btn = cancel.querySelector("button") as HTMLButtonElement;
    expect(btn.className).toBe("kb-btn kb-btn--danger");
    expect(btn.type).toBe("submit");
    expect(btn.textContent).toBe("Cancel");
    expect(cancel.querySelectorAll("input,button")).toHaveLength(2);
    expect(apply.className).toBe("");
  });

  it("posts the hidden fields Apply reads, and only those that are set", () => {
    const sink = STATES.find((s) => s.name === "everything at once")!;
    const doc = docOf(render(sink));
    const apply = doc.querySelector("form[action='/admin/wizard/apply']")!;
    const hidden = Object.fromEntries(
      [...apply.querySelectorAll("input[type=hidden]")].map((i) => [
        i.getAttribute("name"),
        i.getAttribute("value"),
      ]),
    );
    expect(hidden).toEqual({
      _csrf: "csrf-token",
      accessFingerprint: "fp-2",
      rolePlanId: "0123456789abcdef",
      channelPlanId: "abcdef0123456789",
    });
    const bare = docOf(render(STATES[0]));
    expect(
      [
        ...bare.querySelectorAll(
          "form[action='/admin/wizard/apply'] input[type=hidden]",
        ),
      ].map((i) => i.getAttribute("name")),
    ).toEqual(["_csrf"]);
    // The switches outside the form join it by id.
    expect(
      [...doc.querySelectorAll("input[form='wizard-apply-form']")].map((i) =>
        i.getAttribute("name"),
      ),
    ).toEqual(["continueWithoutAdmin", "cascadeOff"]);
  });

  it("keeps the order of the hosted panels", () => {
    const sink = STATES.find((s) => s.name === "everything at once")!;
    const html = render(sink);
    const at = (needle: string): number => html.indexOf(needle);
    const order = [
      "data-flash",
      'data-wizard-admin="missing"',
      'id="wizard-role-matches"',
      'id="wizard-access-review"',
      'id="wizard-role-review"',
      'id="wizard-create-review"',
      'id="cascade-desc"',
      'id="wizard-settings-review"',
      'action="/admin/wizard/apply"',
    ].map(at);
    expect(order.every((n) => n > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Problems come before the plan they block.
    const blocked = render(
      STATES.find((s) => s.name === "channels can't be created")!,
    );
    expect(blocked.indexOf('id="wizard-create-problems"')).toBeLessThan(
      blocked.indexOf('id="wizard-create-review"'),
    );
  });

  it("lists each setting in a row-header table inside the Settings panel", () => {
    const doc = docOf(render(STATES[0]));
    const panel = doc.getElementById("wizard-settings-review")!;
    expect(panel.querySelector(".kb-panel__title")?.textContent).toBe(
      "Settings to apply",
    );
    expect(panel.querySelector(".kb-panel__meta")?.textContent).toBe("2");
    expect(
      [...panel.querySelectorAll("thead th")].map((h) => h.textContent),
    ).toEqual(["Key", "New value", "Description"]);
    const rows = [...panel.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(2);
    const first = rows[0].querySelector("th[scope=row].kb-mono");
    expect(first?.textContent).toBe("voicechannels.enabled");
    const cells = rows[0].querySelectorAll("td");
    expect(cells[0].className).toBe("kb-mono");
    expect(cells[0].textContent).toBe("true");
    expect(cells[1].className).toBe("kb-muted");
    expect(cells[1].textContent).toBe("Turn dynamic voice channels on.");
  });

  it("shows an EmptyState instead of a table when no setting is chosen", () => {
    const doc = docOf(render(STATES[1]));
    const panel = doc.getElementById("wizard-settings-review")!;
    expect(panel.querySelector("table")).toBeNull();
    expect(panel.querySelector(".kb-empty__title")?.textContent).toBe(
      "No settings configured.",
    );
    // A blocked plan must not read as nothing to apply.
    const blocked = docOf(render(STATES[8]));
    expect(blocked.getElementById("wizard-apply-why")?.textContent).toContain(
      "blocked",
    );
    expect(blocked.getElementById("wizard-apply-why")?.textContent).not.toMatch(
      /nothing to apply/i,
    );
    expect(doc.getElementById("wizard-apply-why")?.textContent).toMatch(
      /nothing to apply/i,
    );
  });
});

describe("renderAccessReview (#1752)", () => {
  const roleBlock = (html: string): DocumentFragment => JSDOM.fragment(html);

  it("draws Role access as a Panel with a scrolling DataTable", () => {
    const html = renderAccessReview([change("Moderator")], null, []);
    const doc = roleBlock(html);
    expect(nonKbClasses(doc)).toEqual([]);
    const panel = doc.getElementById("wizard-access-review")!;
    expect(panel.tagName).toBe("SECTION");
    expect(panel.getAttribute("aria-labelledby")).toBe(
      "wizard-access-review-h",
    );
    expect(doc.getElementById("wizard-access-review-h")?.textContent).toBe(
      "Role access",
    );
    expect(panel.querySelector(".kb-panel__meta")?.textContent).toBe("1");
    const table = panel.querySelector(
      ".kb-panel__body--flush > table.kb-table",
    )!;
    expect(table.getAttribute("aria-label")).toBe("Role access");
    expect(
      [...table.querySelectorAll("thead th")].map((h) => h.textContent),
    ).toEqual(["Role", "Now", "After", "Change"]);
    expect(
      table.querySelector("tbody th[scope=row] .kb-mention"),
    ).not.toBeNull();
    expect(table.querySelector("td.kb-muted")?.textContent).toBe(
      'Creates the role group "Moderator"',
    );
    expect(
      panel.querySelector("footer.kb-panel__foot p.kb-help")?.textContent,
    ).toContain("Applying saves these role groups.");
  });

  it("draws the empty mapping as an EmptyState in a Panel", () => {
    const html = renderAccessReview([], null, []);
    const doc = roleBlock(html);
    expect(nonKbClasses(doc)).toEqual([]);
    const panel = doc.getElementById("wizard-access-review")!;
    expect(panel.querySelector("table")).toBeNull();
    expect(panel.querySelector(".kb-empty__title")?.textContent).toBe(
      "No role mapping changes.",
    );
  });

  it("draws no empty Role access panel when a problem or a role plan says more", () => {
    expect(
      renderAccessReview([], "Gone.", []).includes("wizard-access-review"),
    ).toBe(false);
    expect(
      renderAccessReview([], null, [], ROLE_REVIEW).includes(
        'id="wizard-access-review"',
      ),
    ).toBe(false);
  });
});

describe("the Access step's action row (#1752)", () => {
  const page = (options: null | []): string =>
    renderWizardAccessPage({
      ...COMMON,
      selection: { admin: [], staff: [], host: [] },
      options,
      gaps: [],
    });

  it.each([null, []] as const)(
    "is a kb-row of kb- buttons (options %j)",
    (o) => {
      const doc = docOf(page(o));
      expect(nonKbClasses(doc)).toEqual([]);
      const row = doc.querySelector(
        "form[action='/admin/wizard/access'] .kb-row",
      )!;
      const [save, back] = [...row.children];
      expect(save.className).toBe("kb-btn kb-btn--primary");
      expect(save.textContent).toBe("Save access and continue");
      expect((save as HTMLButtonElement).disabled).toBe(o === null);
      expect(back.className).toBe("kb-btn kb-btn--ghost");
      expect(back.getAttribute("href")).toBe("/admin/wizard");
      expect(doc.querySelectorAll(".kb-btn--primary")).toHaveLength(1);
    },
  );
});
