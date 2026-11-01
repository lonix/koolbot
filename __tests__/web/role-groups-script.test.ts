/**
 * The Role groups page script (#1615), run for real in jsdom: it folds the
 * permission groups with nothing on, keeps each "N on" in step, opens a fold a
 * preset ticks into, and leaves a refused form's folds open. The script under
 * test is the production string (`PRESET_SCRIPT`), and the page it runs on is
 * the real renderer's output, with an Add form and two Edit forms on one page.
 *
 * Page scripts do not run on their own (`runScripts: "outside-only"`); the test
 * evaluates the string once, as the browser does at the end of the body.
 */
import { describe, it, expect } from "@jest/globals";
import { JSDOM } from "jsdom";
import {
  PRESET_SCRIPT,
  renderRoleGroupsPage,
  type RoleGroupRow,
  type RoleGroupsPageProps,
} from "../../src/web/role-groups-views.js";
import { allPages } from "./a11y-pages.js";

const row = (over: Partial<RoleGroupRow>): RoleGroupRow => ({
  id: "g1",
  name: "Mods",
  roleId: "r1",
  rank: 2,
  permissions: "0",
  capabilities: [],
  colour: null,
  hoist: false,
  createdByKoolbot: false,
  gateOnly: false,
  createdAt: new Date(),
  roleName: "Moderator",
  unlinked: false,
  lostRoleId: null,
  recreateRequestedAt: null,
  syncPolicy: null,
  driftSignature: null,
  roleMissing: false,
  memberCount: 3,
  roleLock: null,
  drift: [],
  ...over,
});

const MODERATE_MEMBERS = (1n << 40n).toString();
const SEND_AND_MANAGE_MESSAGES = ((1n << 11n) | (1n << 13n)).toString();

const props = (
  over: Partial<RoleGroupsPageProps> = {},
): RoleGroupsPageProps => ({
  csrfToken: "tok",
  remainingMs: 1000,
  groups: [
    row({ id: "g1", name: "Mods", permissions: MODERATE_MEMBERS }),
    row({ id: "g2", name: "Helpers", permissions: "0" }),
  ],
  roleOptions: [],
  plan: null,
  extraErrors: [],
  botScanUnavailable: false,
  botsMissing: 0,
  adminReport: { humans: [], bots: [] },
  adminGroupLacksAdministrator: false,
  membersUnavailable: false,
  roleNames: {},
  globalPolicy: "flag",
  ...over,
});

interface El {
  checked: boolean;
  value: string;
  hasAttribute(n: string): boolean;
  getAttribute(n: string): string | null;
  textContent: string | null;
  dispatchEvent(e: unknown): boolean;
  querySelector(s: string): El | null;
  querySelectorAll(s: string): unknown;
  closest(s: string): El | null;
}

/** The elements a selector matches, as an array (a NodeList has no filter or some). */
const all = (e: El, s: string): El[] =>
  Array.from(e.querySelectorAll(s) as ArrayLike<El>);

interface Page {
  win: { Event: new (t: string, i?: unknown) => unknown };
  form: (action: string) => El;
  fold: (form: El, key: string) => El;
  isOpen: (form: El, key: string) => boolean;
  count: (form: El, key: string) => string;
  box: (form: El, value: string) => El;
  tick: (form: El, value: string, on: boolean) => void;
  choosePreset: (form: El, key: string) => void;
  openFolds: (form: El) => string[];
}

function load(html: string): Page {
  const dom = new JSDOM(html, { runScripts: "outside-only" });
  const win = dom.window as unknown as Page["win"] & { eval(s: string): void };
  // The page must carry the very script under test (the nonce is a marker here).
  expect(html).toContain(PRESET_SCRIPT);
  win.eval(PRESET_SCRIPT);
  const doc = dom.window.document as unknown as {
    querySelector(s: string): El | null;
  };
  const form = (action: string): El => {
    const f = doc.querySelector(`form[action$="${action}"]`);
    if (!f) throw new Error(`no form ${action}`);
    return f;
  };
  const fold = (f: El, key: string): El => {
    const d = f.querySelector(`details[data-perm-group="${key}"]`);
    if (!d) throw new Error(`no fold ${key}`);
    return d;
  };
  const box = (f: El, value: string): El => {
    const b = f.querySelector(`input[name="perm"][value="${value}"]`);
    if (!b) throw new Error(`no switch ${value}`);
    return b;
  };
  return {
    win,
    form,
    fold,
    isOpen: (f, k) => fold(f, k).hasAttribute("open"),
    count: (f, k) =>
      fold(f, k).querySelector(".rg-perm-count")?.textContent ?? "?",
    box,
    tick: (f, v, on) => {
      const b = box(f, v);
      b.checked = on;
      b.dispatchEvent(new win.Event("change", { bubbles: true }));
    },
    choosePreset: (f, key) => {
      const sel = f.querySelector("select.rg-preset") as unknown as {
        value: string;
        dispatchEvent(e: unknown): boolean;
      };
      sel.value = key;
      sel.dispatchEvent(new win.Event("change", { bubbles: true }));
    },
    openFolds: (f) =>
      all(f, "details[data-perm-group]")
        .filter((d) => d.hasAttribute("open"))
        .map((d) => d.getAttribute("data-perm-group") ?? ""),
  };
}

const EDIT1 = "/g1/edit";
const EDIT2 = "/g2/edit";
const ADD = "/role-groups/create";

describe("Role groups page script (#1615), run in jsdom", () => {
  it("folds the groups with nothing on and keeps open the one with a permission on", () => {
    const p = load(renderRoleGroupsPage(props()));
    expect(p.openFolds(p.form(EDIT1))).toEqual(["membership"]);
    expect(p.openFolds(p.form(EDIT2))).toEqual([]);
    expect(p.openFolds(p.form(ADD))).toEqual([]);
    // The count the server wrote stays right after the first pass.
    expect(p.count(p.form(EDIT1), "membership")).toBe(", 1 on");
    expect(p.count(p.form(EDIT1), "text")).toBe(", none on");
  });

  it("keeps each fold's count in step with its switches, in both directions", () => {
    const p = load(renderRoleGroupsPage(props()));
    const edit = p.form(EDIT2);
    p.tick(edit, "SendMessages", true);
    expect(p.count(edit, "text")).toBe(", 1 on");
    p.tick(edit, "ManageMessages", true);
    expect(p.count(edit, "text")).toBe(", 2 on");
    p.tick(edit, "SendMessages", false);
    expect(p.count(edit, "text")).toBe(", 1 on");
    p.tick(edit, "ManageMessages", false);
    expect(p.count(edit, "text")).toBe(", none on");
    // Other folds of the same form are untouched.
    expect(p.count(edit, "voice")).toBe(", none on");
  });

  it("opens the folds a preset ticks into, ticks its capabilities and the set-permissions switch, and counts", () => {
    const p = load(renderRoleGroupsPage(props()));
    const add = p.form(ADD);
    p.choosePreset(add, "moderator");
    const open = p.openFolds(add);
    expect(open.length).toBeGreaterThan(0);
    for (const key of open) {
      expect(p.count(add, key)).toMatch(/^, \d+ on$/);
      expect(p.count(add, key)).not.toBe(", none on");
    }
    // Every fold left closed has nothing on.
    for (const d of all(add, "details[data-perm-group]")) {
      const key = d.getAttribute("data-perm-group") ?? "";
      if (!open.includes(key)) {
        expect(all(d, 'input[name="perm"]').some((b) => b.checked)).toBe(false);
        expect(p.count(add, key)).toBe(", none on");
      }
    }
    expect(
      (add.querySelector('input[name="editPermissions"]') as El).checked,
    ).toBe(true);
    expect(
      add.querySelector('input[name="capability"][value="staff"]')?.checked,
    ).toBe(true);
    expect(
      add.querySelector('input[name="capability"][value="admin"]')?.checked,
    ).toBe(false);
  });

  it("keeps the Add form and each Edit form apart", () => {
    const p = load(renderRoleGroupsPage(props()));
    const add = p.form(ADD);
    const edit1 = p.form(EDIT1);
    const edit2 = p.form(EDIT2);
    p.choosePreset(add, "moderator");
    // The preset in the Add form did not touch either Edit form.
    expect(p.openFolds(edit1)).toEqual(["membership"]);
    expect(p.openFolds(edit2)).toEqual([]);
    expect(all(edit2, 'input[name="perm"]').some((b) => b.checked)).toBe(false);
    // Ticking in one Edit form moves only its own counts.
    const addText = p.count(add, "text");
    p.tick(edit2, "SendMessages", true);
    expect(p.count(edit2, "text")).toBe(", 1 on");
    expect(p.count(edit1, "text")).toBe(", none on");
    expect(p.count(add, "text")).toBe(addText);
    // A preset in one Edit form leaves the other alone too.
    p.choosePreset(edit1, "admin");
    expect(p.count(edit2, "text")).toBe(", 1 on");
  });

  it("leaves every fold of a refused form open, and still folds the other forms", () => {
    const html = renderRoleGroupsPage(
      props({
        groups: [
          row({
            id: "g1",
            name: "Mods",
            permissions: SEND_AND_MANAGE_MESSAGES,
          }),
          row({ id: "g2", name: "Helpers", permissions: "0" }),
        ],
        refusedForm: {
          formId: "role-group-edit-g1",
          errors: { name: "Taken." },
          values: { name: "Mods", "perm-SendMessages": "1" },
        },
      }),
    );
    const p = load(html);
    const refused = p.form(EDIT1);
    // Every fold has data-keep-open, so none closes, even with nothing on in it.
    expect(p.openFolds(refused)).toHaveLength(8);
    expect(p.count(refused, "text")).toBe(", 1 on");
    expect(p.count(refused, "voice")).toBe(", none on");
    // The forms that were not refused fold as usual.
    expect(p.openFolds(p.form(EDIT2))).toEqual([]);
    expect(p.openFolds(p.form(ADD))).toEqual([]);
  });

  it("leaves a refused form's keep-open folds open when a count drops to none", () => {
    const html = renderRoleGroupsPage(
      props({
        refusedForm: {
          formId: "role-group-edit-g2",
          errors: { name: "Taken." },
          values: { name: "Helpers", "perm-SendMessages": "1" },
        },
      }),
    );
    const p = load(html);
    const edit = p.form(EDIT2);
    p.tick(edit, "SendMessages", false);
    expect(p.count(edit, "text")).toBe(", none on");
    expect(p.isOpen(edit, "text")).toBe(true);
  });

  // The a11y fixtures draw the folded state by text replacement; the real script
  // must leave the same folds open and closed.
  it("agrees with the a11y fixtures that stand in for its result", () => {
    const pages = allPages();
    const get = (n: string): string => {
      const found = pages.find((x) => x.name === n);
      if (!found) throw new Error(`no fixture ${n}`);
      return found.html;
    };
    const state = (html: string): string[] => {
      const dom = new JSDOM(html);
      return [
        ...dom.window.document.querySelectorAll("details[data-perm-group]"),
      ].map(
        (d, i) =>
          `${i}:${d.getAttribute("data-perm-group")}:${d.hasAttribute("open")}`,
      );
    };
    const pairs: Array<[string, string]> = [
      [
        "Role groups (permission groups open, no JavaScript)",
        "Role groups (permission groups folded, one open)",
      ],
    ];
    for (const [open, folded] of pairs) {
      const p = load(get(open));
      const real = [
        ...all(p.form(EDIT1), "details[data-perm-group]"),
        ...all(p.form(ADD), "details[data-perm-group]"),
      ].map(
        (d) => `${d.getAttribute("data-perm-group")}:${d.hasAttribute("open")}`,
      );
      const fixture = state(get(folded)).map((s) => s.replace(/^\d+:/, ""));
      expect(real).toEqual(fixture);
    }
  });
});
