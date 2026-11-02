/* global Document, Element */
/**
 * The Settings and Permissions pages, and the settings every feature page folds
 * at its bottom, are built from the design system's components and no longer
 * from the old inline classes (#1647): PageHeader, Panel, Callout, Button,
 * DataTable, EmptyState, Field, Badge and the folded Settings Disclosure
 * (docs/design/components.md).
 */
import { describe, it, expect } from "@jest/globals";
import { JSDOM } from "jsdom";
import {
  renderFeatureSettingsCard,
  renderPermissionsPage,
  renderSettingsPage,
  renderSettingsUnavailableNotice,
  type SettingRow,
  type SettingsProps,
  type PermissionsProps,
} from "../../src/web/admin-views.js";
import type { PermissionNotice } from "../../src/web/permission-notice.js";

const ROW: SettingRow = {
  key: "polls.enabled",
  label: "Polls system enabled",
  current: true,
  defaultValue: false,
  type: "boolean",
  description: "Enable the poll system.",
  category: "polls",
};

const SETTINGS: SettingsProps = {
  csrfToken: "csrf",
  remainingMs: 60_000,
  groups: [{ category: "polls", rows: [ROW] }],
  textChannels: [],
  voiceChannels: [],
  categoryChannels: [],
  roles: [],
  guildId: "g1",
  guildName: "Test Guild",
};

const PERMISSIONS: PermissionsProps = {
  csrfToken: "csrf",
  remainingMs: 60_000,
  commands: ["ping", "quote"],
  roleIds: ["r1"],
  allRoleIds: ["r1", "r2"],
  roleNames: new Map([
    ["r1", "Admin"],
    ["r2", "Member"],
  ]),
  perCommand: new Map([["quote", ["r1"]]]),
};

const dom = (html: string): Document => new JSDOM(html).window.document;
const main = (html: string): Element => {
  const el = dom(html).querySelector("main");
  if (!el) throw new Error("no <main>");
  return el;
};

/** The old classes the listed functions must no longer carry. */
const OLD_CLASSES = [
  "card",
  "card--savebar",
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
  "tag",
  "tag-info",
  "tag-warn",
  "actions",
  "stack",
  "inline-form",
  "visually-hidden",
];

const usedClasses = (root: Element): Set<string> => {
  const used = new Set<string>();
  for (const el of root.querySelectorAll("[class]")) {
    for (const t of el.getAttribute("class")?.split(/\s+/) ?? []) used.add(t);
  }
  return used;
};

const SYNC = {
  state: "out-of-sync" as const,
  checkedAt: 0,
  added: ["ping"],
  removed: [],
  changed: [],
};

describe("the Settings page", () => {
  const MISSING: PermissionNotice = {
    missing: [],
    unchecked: [],
    unavailable: "Discord is down.",
    stale: false,
  };

  it.each([
    ["rows", {}],
    ["a flash", { flash: { type: "ok" as const, text: "Saved." } }],
    ["unreadable settings", { settingsUnavailable: true }],
    ["a permission notice", { permissionNotices: { polls: MISSING } }],
  ])("renders only kb- classes with %s", (_n, over) => {
    const html = renderSettingsPage({ ...SETTINGS, ...over });
    const body = main(html);
    const used = usedClasses(body);
    expect(OLD_CLASSES.filter((c) => used.has(c))).toEqual([]);
    expect(body.querySelector("table:not(.kb-table)")).toBeNull();
    expect(body.querySelector("h1:not(.kb-pagehead__title)")).toBeNull();
  });

  it("opens with a PageHeader and puts each category in a Panel with a save bar", () => {
    const body = main(renderSettingsPage(SETTINGS));
    expect(
      body.querySelector("header.kb-pagehead h1.kb-pagehead__title")
        ?.textContent,
    ).toBe("All settings");
    const panel = body.querySelector("section#section-polls.kb-panel");
    expect(panel?.querySelector(".kb-panel__title")?.id).toBe(
      "section-polls-h",
    );
    expect(panel?.getAttribute("aria-labelledby")).toBe("section-polls-h");
    const form = panel?.querySelector("form[action$='save-section']");
    expect(form?.closest(".kb-panel")).toBe(panel);
    expect(form?.querySelector("[data-savebar]")).not.toBeNull();
  });

  it("keeps the Reload, Export, Import and Setup wizard actions as Buttons", () => {
    const body = main(renderSettingsPage({ ...SETTINGS, commandSync: SYNC }));
    const sync = body.querySelector("#commands-sync");
    expect(
      sync?.querySelector("form[action='/admin/settings/reload']"),
    ).not.toBeNull();
    const labels = Array.from(body.querySelectorAll("a.kb-btn")).map(
      (a) => a.textContent,
    );
    expect(labels).toEqual(["Export YAML", "Import YAML", "Setup wizard"]);
    // One primary per view: the save bars own it, so no page action is one.
    const primaries = Array.from(body.querySelectorAll(".kb-btn--primary"));
    expect(primaries.filter((b) => !b.closest("[data-savebar]"))).toEqual([]);
  });

  it("shows a warn Callout, not the forms, when the stored config cannot be read", () => {
    const body = main(
      renderSettingsPage({ ...SETTINGS, settingsUnavailable: true }),
    );
    expect(body.querySelector("form[action$='save-section']")).toBeNull();
    const c = body.querySelector(".kb-callout--warn[data-flash]");
    expect(c?.getAttribute("role")).toBe("status");
    expect(c?.getAttribute("tabindex")).toBe("-1");
    expect(c?.querySelector(".kb-callout__title")?.textContent).toBe(
      "Settings could not be loaded, so they can't be edited here right now.",
    );
  });

  it("posts the import form as before, with the help line tied to the textarea", () => {
    const body = main(renderSettingsPage(SETTINGS));
    const form = body.querySelector("form[action='/admin/settings/import']");
    expect(form?.querySelector("input[name=_csrf]")).not.toBeNull();
    const area = form?.querySelector("textarea.kb-textarea[name=yaml]");
    expect(area?.getAttribute("aria-describedby")).toBe("import-yaml-help");
    expect(form?.querySelector("label.kb-label")?.getAttribute("for")).toBe(
      "import-yaml",
    );
    expect(body.querySelector("#import-yaml-help.kb-help")).not.toBeNull();
  });
});

describe("the Permissions page", () => {
  it.each([
    ["restrictions", {}],
    ["no restrictions", { roleIds: [], perCommand: new Map() }],
    ["a flash", { flash: { type: "ok" as const, text: "Saved." } }],
  ])("renders only kb- classes with %s", (_n, over) => {
    const body = main(renderPermissionsPage({ ...PERMISSIONS, ...over }));
    const used = usedClasses(body);
    expect(OLD_CLASSES.filter((c) => used.has(c))).toEqual([]);
    expect(body.querySelector("table:not(.kb-table)")).toBeNull();
  });

  it("has a PageHeader and two Panels, each table a DataTable with a caption", () => {
    const body = main(renderPermissionsPage(PERMISSIONS));
    expect(body.querySelector("header.kb-pagehead h1")?.textContent).toBe(
      "Command permissions",
    );
    expect(
      Array.from(body.querySelectorAll("section.kb-panel h2")).map(
        (h) => h.textContent,
      ),
    ).toEqual(["Edit", "Matrix"]);
    for (const t of body.querySelectorAll("table")) {
      expect(t.querySelector("caption")).not.toBeNull();
    }
  });

  it("keeps the per-command form, its field names and the label for the picker", () => {
    const body = main(renderPermissionsPage(PERMISSIONS));
    const form = body.querySelector("form[action='/admin/permissions/set']");
    expect(
      form?.querySelector("input[name=command]")?.getAttribute("value"),
    ).toBe("ping");
    expect(
      form?.querySelector("select[name=roleIds][multiple]"),
    ).not.toBeNull();
    expect(
      form?.querySelector("label.kb-visually-hidden")?.getAttribute("for"),
    ).toBe("perm-roles-ping");
    expect(form?.querySelector("button.kb-btn.kb-btn--sm")?.textContent).toBe(
      "Save",
    );
  });

  it("states each command's access with a Badge word", () => {
    const body = main(renderPermissionsPage(PERMISSIONS));
    const badges = Array.from(
      body.querySelectorAll("#perm-edit .kb-badge"),
    ).map((b) => `${b.className}:${b.textContent}`);
    expect(badges).toEqual([
      "kb-badge kb-badge--info:open",
      "kb-badge kb-badge--warn:restricted",
    ]);
  });

  it("explains an empty matrix with an EmptyState", () => {
    const body = main(
      renderPermissionsPage({
        ...PERMISSIONS,
        roleIds: [],
        perCommand: new Map(),
      }),
    );
    expect(
      body.querySelector("#perm-matrix .kb-empty__title")?.textContent,
    ).toBe("No restricted commands.");
    expect(body.querySelector("#perm-matrix table")).toBeNull();
  });
});

describe("the settings of a feature page", () => {
  const CARD = {
    category: "polls",
    settingRows: [ROW],
    returnTo: "/admin/polls",
    csrfToken: "csrf",
  };

  it("is one Panel holding the folded Settings (n) Disclosure and the save form", () => {
    const body = dom(
      renderFeatureSettingsCard({ ...CARD, intro: "Hello" }),
    ).body;
    const panel = body.querySelector("section.kb-panel");
    const fold = panel?.querySelector(
      ":scope > details.kb-disclosure#feature-settings",
    );
    expect(fold?.hasAttribute("data-settings-fold")).toBe(true);
    expect(fold?.querySelector("summary .kb-badge--count")?.textContent).toBe(
      "1",
    );
    expect(fold?.querySelector(".kb-help")?.textContent).toBe("Hello");
    expect(
      fold?.querySelector("form[action$='save-section'] .kb-settings"),
    ).not.toBeNull();
    expect(
      fold?.querySelector("form[action$='save-section'] [data-savebar]"),
    ).not.toBeNull();
    const used = usedClasses(body);
    expect(OLD_CLASSES.filter((c) => used.has(c))).toEqual([]);
  });

  it("shows the unreadable-settings Callout in a titled Panel", () => {
    const body = dom(
      renderFeatureSettingsCard({ ...CARD, unavailable: true }),
    ).body;
    expect(
      body.querySelector("section.kb-panel h2.kb-panel__title")?.textContent,
    ).toBe("Settings");
    expect(body.querySelector(".kb-callout--warn[data-flash]")).not.toBeNull();
    const used = usedClasses(body);
    expect(OLD_CLASSES.filter((c) => used.has(c))).toEqual([]);
  });

  it("gives the unavailable notice the focus hook the layout looks for", () => {
    const html = renderSettingsUnavailableNotice();
    expect(html).toContain('role="status" tabindex="-1" data-flash');
    expect(html).toContain("Reload the page to try again.");
  });
});
