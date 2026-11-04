/* global Document, Element, HTMLInputElement, HTMLButtonElement */
/**
 * The Environment page and the Import preview page are built from the design
 * system's components and no longer from the old inline classes (#1753):
 * PageHeader, Panel, DataTable, Badge, Callout, EmptyState, Button and
 * KeyValue (docs/design/components.md). Checked on the markup the pages send.
 */
import { describe, it, expect } from "@jest/globals";
import { JSDOM } from "jsdom";
import {
  renderBootstrapPage,
  renderImportDiffPage,
  type BootstrapProps,
  type ImportDiffProps,
} from "../../src/web/admin-views.js";

const COMMON = { csrfToken: "csrf-tok", remainingMs: 60_000 };

const dom = (html: string): Document => new JSDOM(html).window.document;
const main = (html: string): Element => {
  const el = dom(html).querySelector("main");
  if (!el) throw new Error("no <main>");
  return el;
};

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
  "tag-diff-change",
  "tag-diff-reject",
  "actions",
  "field-row",
  "help",
];

const oldClassesIn = (root: Element): string[] => {
  const used = new Set<string>();
  for (const el of root.querySelectorAll("[class]")) {
    for (const token of el.getAttribute("class")?.split(/\s+/) ?? []) {
      used.add(token);
    }
  }
  return OLD_CLASSES.filter((c) => used.has(c));
};

/** The structure every page of the two keeps: one h1, a DataTable in a flush panel, no bare table. */
const expectKbShape = (root: Element): void => {
  expect(oldClassesIn(root)).toEqual([]);
  expect(root.querySelectorAll("h1")).toHaveLength(1);
  expect(root.querySelector("h1")?.className).toBe("kb-pagehead__title");
  expect(root.querySelector("[style]")).toBeNull();
  for (const table of root.querySelectorAll("table")) {
    expect(table.className).toBe("kb-table");
    expect(table.closest(".kb-panel__body--flush")).not.toBeNull();
    expect(table.querySelector("caption.kb-visually-hidden")).not.toBeNull();
  }
  expect(root.querySelectorAll(".kb-btn--primary").length).toBeLessThanOrEqual(
    1,
  );
};

// A value that only looks like a secret to a reader: no real credential here.
const SECRET_TAIL = "SECRET-TAIL-VALUE";

const ENV_BASE: BootstrapProps = {
  ...COMMON,
  groups: [
    {
      category: "Discord",
      rows: [
        {
          key: "DISCORD_TOKEN",
          present: true,
          isSecret: true,
          display: SECRET_TAIL,
        },
        { key: "GUILD_ID", present: false, isSecret: false },
        {
          key: "CLIENT_ID",
          present: true,
          isSecret: false,
          display: "123456789",
        },
      ],
    },
    {
      category: "Web UI",
      rows: [{ key: "WEBUI_ENABLED", present: true, isSecret: false }],
    },
  ],
};

const SESSION = {
  issuedAt: Date.UTC(2026, 10, 1, 3, 59),
  previousActivityAt: Date.UTC(2026, 10, 1, 8, 45),
  now: Date.UTC(2026, 10, 1, 8, 59),
  windowMs: 30 * 60 * 1000,
  expiresAt: new Date(Date.UTC(2026, 10, 2, 3, 59)),
};

describe("the Environment page renders only kb- components (#1753)", () => {
  it.each([
    ["variables", ENV_BASE],
    ["variables with the session panel", { ...ENV_BASE, session: SESSION }],
    ["no groups", { ...ENV_BASE, groups: [] }],
  ] as Array<[string, BootstrapProps]>)("%s", (_name, props) => {
    expectKbShape(main(renderBootstrapPage(props)));
  });

  it("has a PageHeader and a status Callout that says secrets are presence-only", () => {
    const root = main(renderBootstrapPage(ENV_BASE));
    expect(root.querySelector("header.kb-pagehead h1")?.textContent).toBe(
      "Environment",
    );
    expect(root.querySelector(".kb-pagehead__sub")?.textContent).toContain(
      "Read-only",
    );
    const callout = root.querySelector(".kb-callout");
    expect(callout?.getAttribute("role")).toBe("status");
    expect(callout?.textContent).toContain("configured or unset only");
  });

  it("draws each group as a Panel titled by its name, with a DataTable inside", () => {
    const root = main(renderBootstrapPage(ENV_BASE));
    const panels = [...root.querySelectorAll("section.kb-panel")];
    expect(panels).toHaveLength(2);
    for (const p of panels) {
      const title = p.querySelector("h2.kb-panel__title");
      expect(p.getAttribute("aria-labelledby")).toBe(title?.id);
    }
    expect(panels[0].querySelector("h2")?.textContent).toBe("Discord");
    expect(
      [...panels[0].querySelectorAll("thead th")].map((th) => [
        th.textContent,
        th.getAttribute("scope"),
      ]),
    ).toEqual([
      ["Variable", "col"],
      ["Status", "col"],
      ["Value", "col"],
    ]);
    expect(panels[0].querySelector("caption")?.textContent).toBe(
      "Environment variables",
    );
    // Panels sit in a stack so they are spaced.
    expect(panels[0].parentElement?.className).toContain("kb-stack");
  });

  it("shows configured and unset as badges with the words", () => {
    const root = main(renderBootstrapPage(ENV_BASE));
    const rows = [...root.querySelectorAll("tbody tr")];
    const token = rows[0];
    expect(token.querySelector("th")?.getAttribute("scope")).toBe("row");
    expect(token.querySelector("th")?.className).toBe("kb-mono");
    expect(token.querySelector(".kb-badge--on")?.textContent).toBe(
      "configured",
    );
    expect(rows[1].querySelector(".kb-badge--off")?.textContent).toBe("unset");
  });

  it("never renders any part of a secret, and keeps a plain value in kb-mono", () => {
    const html = renderBootstrapPage({ ...ENV_BASE, session: SESSION });
    expect(html).not.toContain(SECRET_TAIL);
    expect(html).toContain('<span class="kb-mono">123456789</span>');
    const root = main(html);
    const cells = [...root.querySelectorAll("tbody tr")][0].querySelectorAll(
      "td",
    );
    expect(cells[1].textContent).toBe("");
  });

  it("keeps the session panel first, as KeyValue, ahead of the variables", () => {
    const html = renderBootstrapPage({ ...ENV_BASE, session: SESSION });
    expect(html.indexOf('id="session-title"')).toBeLessThan(
      html.indexOf("DISCORD_TOKEN"),
    );
    expect(html).toContain('<dl class="kb-kv">');
  });
});

const importPage = (over: Partial<ImportDiffProps> = {}): string =>
  renderImportDiffPage({
    ...COMMON,
    yamlText: "polls:\n  enabled: true\n",
    rows: [
      { key: "polls.enabled", status: "pending", before: false, after: true },
      { key: "polls.same", status: "pending", before: "5", after: 5 },
      { key: "polls.new", status: "pending", after: "x" },
      { key: "polls.bogus", status: "rejected", reason: "unknown key" },
    ],
    ...over,
  });

const REJECTED_ONLY: Partial<ImportDiffProps> = {
  rows: [{ key: "x", status: "rejected", reason: "unknown key" }],
};
const NO_ROWS: Partial<ImportDiffProps> = { rows: [] };

describe("the Import preview page renders only kb- components (#1753)", () => {
  it.each([
    ["pending and rejected rows", {}],
    ["rejected rows only", REJECTED_ONLY],
    ["nothing in the file", NO_ROWS],
  ] as Array<[string, Partial<ImportDiffProps>]>)("%s", (_n, over) => {
    expectKbShape(main(importPage(over)));
  });

  it("has a PageHeader and a status Callout with the counts", () => {
    const root = main(importPage());
    expect(root.querySelector("header.kb-pagehead h1")?.textContent).toBe(
      "Import preview",
    );
    const callout = root.querySelector(".kb-callout");
    expect(callout?.getAttribute("role")).toBe("status");
    expect(callout?.textContent).toContain(
      "3 key(s) will be written; 1 rejected",
    );
    expect(callout?.classList.contains("kb-callout--warn")).toBe(false);
  });

  it("maps the three chips to badges with their words", () => {
    const root = main(importPage());
    const rows = [...root.querySelectorAll("tbody tr")];
    expect(rows[0].querySelector(".kb-badge--warn")?.textContent).toBe(
      "changed",
    );
    expect(rows[1].querySelector(".kb-badge--info")?.textContent).toBe(
      "no change",
    );
    expect(rows[3].querySelector(".kb-badge--off")?.textContent).toBe(
      "rejected",
    );
    expect(rows[3].textContent).toContain("unknown key");
    expect(rows[0].querySelector("th")?.getAttribute("scope")).toBe("row");
    expect(
      [...root.querySelectorAll("thead th")].map((th) => th.textContent),
    ).toEqual(["Key", "Status", "Current", "New value"]);
  });

  it("keeps the form, the field names and the posted values", () => {
    const root = main(importPage({ yamlText: '<b>&"x"</b>' }));
    const form = root.querySelector("form");
    expect(form?.getAttribute("method")).toBe("POST");
    expect(form?.getAttribute("action")).toBe("/admin/settings/import/apply");
    expect(
      (form?.querySelector('input[name="_csrf"]') as HTMLInputElement).value,
    ).toBe("csrf-tok");
    expect(
      (form?.querySelector('input[name="yaml"]') as HTMLInputElement).value,
    ).toBe('<b>&"x"</b>');
    expect(
      form?.querySelector('input[name="yaml"]')?.getAttribute("type"),
    ).toBe("hidden");
  });

  it("has one primary button, Apply import, and a Cancel link back to All settings", () => {
    const root = main(importPage());
    const primary = root.querySelectorAll(".kb-btn--primary");
    expect(primary).toHaveLength(1);
    expect(primary[0].textContent).toBe("Apply import");
    expect((primary[0] as HTMLButtonElement).disabled).toBe(false);
    expect(primary[0].getAttribute("type")).toBe("submit");
    const cancel = root.querySelector('a[href="/admin/settings"]');
    expect(cancel?.textContent).toBe("Cancel");
    expect(cancel?.className).toBe("kb-btn");
    expect(root.querySelector("form")?.contains(cancel as Element)).toBe(false);
  });

  it("disables Apply with nothing pending, says why, and does not read as nothing to do", () => {
    const html = importPage(REJECTED_ONLY);
    expect(html).toMatch(/<button[^>]*disabled>Apply import<\/button>/);
    const root = main(html);
    const apply = root.querySelector(".kb-btn--primary") as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    const help = root.querySelector(
      `#${apply.getAttribute("aria-describedby")}`,
    );
    expect(help?.className).toBe("kb-help");
    expect(help?.textContent).toContain("Nothing can be applied");
    const callout = root.querySelector(".kb-callout");
    expect(callout?.classList.contains("kb-callout--warn")).toBe(true);
    expect(callout?.textContent).toContain(
      "0 key(s) will be written; 1 rejected",
    );
  });

  it("gives an empty file an EmptyState instead of an empty table, and still disables Apply", () => {
    const root = main(importPage(NO_ROWS));
    expect(root.querySelector(".kb-empty")).not.toBeNull();
    expect(root.querySelector("table")).toBeNull();
    expect(
      (root.querySelector(".kb-btn--primary") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("does not describe Apply when it is enabled", () => {
    const root = main(importPage());
    expect(
      root.querySelector(".kb-btn--primary")?.hasAttribute("aria-describedby"),
    ).toBe(false);
    expect(root.querySelector(".kb-help")).toBeNull();
  });

  it("escapes keys, values and reasons", () => {
    const html = importPage({
      rows: [
        {
          key: "<i>k</i>",
          status: "pending",
          before: "<u>a</u>",
          after: "<s>b</s>",
        },
        { key: "r", status: "rejected", reason: "<em>why</em>" },
      ],
    });
    expect(html).not.toContain("<i>k");
    expect(html).not.toContain("<u>a");
    expect(html).not.toContain("<em>why");
    expect(html).toContain("&lt;em&gt;why");
  });
});
