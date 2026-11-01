/* global Document, Element, HTMLInputElement, HTMLLabelElement */
/**
 * The Polls page is built from the design system's components and no longer
 * from the old inline classes (#1640): PageHeader, Panel, DataTable, Button,
 * Badge, EmptyState, Field, Switch and Disclosure (docs/design/components.md).
 * Checked on the markup the page sends, with the settings card left out (it is
 * the shared `renderFeatureSettingsCard`, moved in #1647).
 */
import { describe, it, expect } from "@jest/globals";
import { JSDOM } from "jsdom";
import { ChannelType } from "discord.js";
import { renderPollsPage, type PollsProps } from "../../src/web/admin-views.js";
import type { RefusedForm } from "../../src/web/form-errors.js";

const BASE: PollsProps = {
  csrfToken: "csrf",
  remainingMs: 60_000,
  enabled: true,
  defaultDurationHours: 24,
  cooldownDays: 7,
  settingRows: [],
  schedules: [],
  items: [],
  textChannels: [{ id: "c1", name: "polls", type: ChannelType.GuildText }],
  roles: [{ id: "r1", name: "Members" }],
};

const SCHEDULES: PollsProps["schedules"] = [
  {
    id: "s1",
    channelId: "c1",
    channelName: "polls",
    channelType: ChannelType.GuildText,
    cron: "0 12 * * 1",
    durationHours: 12,
    pingRoleId: "r1",
    pingRoleName: "Members",
    enabled: true,
    lastRun: "2026-10-01",
  },
  {
    id: "s2",
    channelId: "c1",
    channelName: "polls",
    channelType: ChannelType.GuildText,
    cron: "0 18 * * 5",
    durationHours: 24,
    pingRoleId: null,
    pingRoleName: null,
    enabled: false,
    lastRun: "—",
  },
];

const ITEMS: PollsProps["items"] = [
  {
    id: "i1",
    question: "Pineapple on pizza?",
    answers: ["Yes", "No"],
    tags: ["food", "fun"],
    multiSelect: true,
    usageCount: 3,
    lastUsed: "2026-10-01",
    enabled: true,
    source: "manual",
  },
  {
    id: "i2",
    question: "Best colour?",
    answers: ["Red", "Blue"],
    tags: [],
    multiSelect: false,
    usageCount: 0,
    lastUsed: "—",
    enabled: false,
    source: "import",
  },
];

const render = (over: Partial<PollsProps> = {}): string =>
  renderPollsPage({ ...BASE, ...over });
const dom = (html: string): Document => new JSDOM(html).window.document;
// The page body, without the layout around it.
const main = (html: string): Element => {
  const el = dom(html).querySelector("main");
  if (!el) throw new Error("no <main>");
  return el;
};

const REFUSED_SCHEDULE: RefusedForm = {
  formId: "poll-schedule-create",
  errors: { cron: "Use five fields." },
  values: { channelId: "c1", cron: "bad", durationHours: "24" },
};
const REFUSED_ITEM_EDIT: RefusedForm = {
  formId: "poll-item-edit-i1",
  errors: { answers: "Give 2 to 10 answers, one in each box." },
  values: { question: "Pineapple on pizza?", "answers-0": "only one" },
};

const CASES: Array<[string, Partial<PollsProps>]> = [
  ["empty", {}],
  ["feature off", { enabled: false }],
  ["rows", { schedules: SCHEDULES, items: ITEMS }],
  [
    "a refused schedule form",
    { schedules: SCHEDULES, items: ITEMS, refusedForm: REFUSED_SCHEDULE },
  ],
  [
    "a refused question edit",
    { schedules: SCHEDULES, items: ITEMS, refusedForm: REFUSED_ITEM_EDIT },
  ],
];

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
  "actions",
  "edit-details",
  "checkbox",
  "field-row",
  "help",
  "data",
];

describe("the Polls page renders only kb- components (#1640)", () => {
  it.each(CASES)("uses none of the old classes: %s", (_name, over) => {
    const body = main(render(over));
    const used = new Set<string>();
    for (const el of body.querySelectorAll("[class]")) {
      for (const token of el.getAttribute("class")?.split(/\s+/) ?? []) {
        used.add(token);
      }
    }
    expect(OLD_CLASSES.filter((c) => used.has(c))).toEqual([]);
  });

  it.each(CASES)("has no bare table or heading: %s", (_name, over) => {
    const body = main(render(over));
    for (const t of body.querySelectorAll("table")) {
      expect(t.classList.contains("kb-table")).toBe(true);
    }
    const h1 = body.querySelectorAll("h1");
    expect(h1).toHaveLength(1);
    expect(h1[0].className).toBe("kb-pagehead__title");
    expect(h1[0].textContent).toBe("Polls");
  });

  it.each(CASES)("has one primary button per view: %s", (_name, over) => {
    const body = main(render(over));
    // The feature-off callout's Enable is the primary while polls are off; the
    // page's own main button is neutral then (#1512).
    expect(body.querySelectorAll(".kb-btn--primary")).toHaveLength(1);
  });

  it("makes Create schedule the primary button while polls are on", () => {
    const body = main(render());
    const primary = body.querySelector(".kb-btn--primary");
    expect(primary?.textContent).toBe("Create schedule");
  });

  it("makes the callout's Enable the primary button while polls are off", () => {
    const body = main(render({ enabled: false }));
    const primary = body.querySelector(".kb-btn--primary");
    expect(primary?.textContent).toBe("Enable polls");
    const create = Array.from(body.querySelectorAll("button")).find(
      (b) => b.textContent === "Create schedule",
    );
    expect(create?.className).toBe("kb-btn");
  });
});

describe("what the page still takes from shared helpers", () => {
  // `renderFlash` (any flash), `renderFeatureSettingsCard` and
  // `renderSettingsUnavailableNotice` are shared by every feature page and still
  // draw the old `notice` and `card`. #1647 moves the settings ones; the flash
  // helper is named in no sub-issue of #1639. Their subtrees are cut out here by
  // name, so the page's own markup is checked and the exclusion is visible.
  const SETTING_ROW = {
    key: "polls.enabled",
    label: "Polls system enabled",
    current: true,
    defaultValue: false,
    type: "boolean" as const,
    description: "Enable the poll system.",
    category: "polls",
  };
  const OLD_SHARED = [
    "[data-flash]",
    ".card",
    ".notice",
    "#feature-settings",
  ].join(",");

  it.each([
    ["a flash", { flash: { type: "ok" as const, text: "Saved." } }],
    ["the settings card", { settingRows: [SETTING_ROW] }],
    ["unreadable settings", { settingsUnavailable: true }],
    [
      "all three",
      {
        flash: { type: "err" as const, text: "Nope." },
        settingRows: [SETTING_ROW],
        settingsUnavailable: true,
      },
    ],
  ])("leaves the page's own markup on kb- classes with %s", (_n, over) => {
    const body = main(render({ schedules: SCHEDULES, items: ITEMS, ...over }));
    for (const el of body.querySelectorAll(OLD_SHARED)) el.remove();
    const used = new Set<string>();
    for (const el of body.querySelectorAll("[class]")) {
      for (const token of el.getAttribute("class")?.split(/\s+/) ?? []) {
        used.add(token);
      }
    }
    expect(OLD_CLASSES.filter((c) => used.has(c))).toEqual([]);
  });
});

describe("the Polls page header and panels", () => {
  const body = main(render({ schedules: SCHEDULES, items: ITEMS }));

  it("opens with a PageHeader holding the sub line and the status line", () => {
    const head = body.querySelector("header.kb-pagehead");
    expect(head?.querySelector(".kb-pagehead__sub")?.textContent).toBe(
      "Poll schedules and the question library.",
    );
    const status = head?.querySelector(".kb-statusline");
    expect(status?.textContent).toContain("2 schedules");
    expect(status?.textContent).toContain("2 questions in the library");
  });

  it("puts each topic in a Panel with a titled head", () => {
    const titles = Array.from(
      body.querySelectorAll("section.kb-panel > .kb-panel__head h2"),
    ).map((h) => h.textContent);
    expect(titles).toEqual([
      "Schedules",
      "Create a new schedule",
      "Question library",
      "Add a poll question",
      "Import questions",
    ]);
    for (const section of body.querySelectorAll("section.kb-panel")) {
      const h2 = section.querySelector("h2");
      expect(section.getAttribute("aria-labelledby")).toBe(h2?.id);
    }
  });

  it("counts the rows in the panel head of each table", () => {
    const meta = (title: string): string | undefined =>
      Array.from(body.querySelectorAll("section.kb-panel"))
        .find((s) => s.querySelector("h2")?.textContent === title)
        ?.querySelector(".kb-panel__meta")?.textContent ?? undefined;
    expect(meta("Schedules")).toBe("2");
    expect(meta("Question library")).toBe("2");
  });

  it("keeps the folded settings at the end, after every panel", () => {
    const html = render({
      schedules: SCHEDULES,
      items: ITEMS,
      settingRows: [
        {
          key: "polls.enabled",
          label: "Polls system enabled",
          current: true,
          defaultValue: false,
          type: "boolean",
          description: "Enable the poll system.",
          category: "polls",
        },
      ],
    });
    const doc = dom(html);
    const panels = Array.from(doc.querySelectorAll("section.kb-panel"));
    const fold = doc.getElementById("feature-settings");
    expect(fold).not.toBeNull();
    const last = panels[panels.length - 1];
    expect(
      last.compareDocumentPosition(fold as Element) &
        doc.defaultView!.Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe("the schedules table", () => {
  // Looked up per test, so a missing table fails the test that needs it.
  const tableOf = (): Element =>
    main(render({ schedules: SCHEDULES })).querySelector(
      "table.kb-table",
    ) as Element;
  const rowsOf = (): Element[] =>
    Array.from(tableOf().querySelectorAll("tbody tr"));

  it("is a DataTable run edge to edge in its panel", () => {
    const table = tableOf();
    expect(table.closest(".kb-panel__body--flush")).not.toBeNull();
    const heads = Array.from(table.querySelectorAll("thead th")).map((h) => [
      h.getAttribute("scope"),
      h.textContent,
    ]);
    expect(heads).toEqual([
      ["col", "ID"],
      ["col", "Channel"],
      ["col", "Cron"],
      ["col", "Duration"],
      ["col", "Ping role"],
      ["col", "Status"],
      ["col", "Last run"],
      ["col", "Actions"],
    ]);
  });

  it("names each row by its id in mono, with the cron in mono", () => {
    const rows = rowsOf();
    const th = rows[0].querySelector('th[scope="row"]');
    expect(th?.className).toBe("kb-mono");
    expect(th?.textContent).toBe("s1");
    // The cells after the row header: channel, cron, duration, ping role, status, last run.
    expect(rows[0].querySelectorAll("td")[0].textContent).toContain("polls");
    expect(rows[0].querySelectorAll("td")[1].className).toBe("kb-mono");
  });

  it("shows the state as a Badge with a word, and none as muted text", () => {
    const rows = rowsOf();
    const badge = (i: number): Element | null =>
      rows[i].querySelectorAll("td")[4].querySelector(".kb-badge");
    expect(badge(0)?.className).toBe("kb-badge kb-badge--on");
    expect(badge(0)?.textContent).toBe("On");
    expect(badge(1)?.className).toBe("kb-badge kb-badge--off");
    expect(badge(1)?.textContent).toBe("Off");
    const ping = rows[1].querySelectorAll("td")[3].querySelector("span");
    expect(ping?.className).toBe("kb-muted");
    expect(ping?.textContent).toBe("none");
    expect(rows[0].querySelectorAll("td")[5].className).toBe("kb-muted");
  });

  it("keeps every row action as a form post to the same route, as small Buttons", () => {
    const rows = rowsOf();
    const actions = rows[0].querySelector("td.kb-actions") as Element;
    const posts = Array.from(actions.querySelectorAll("form")).map((f) => [
      f.getAttribute("action"),
      f.querySelector("button")?.textContent,
      f.querySelector("button")?.className,
    ]);
    expect(posts).toEqual([
      ["/admin/polls/schedules/s1/edit", "Save changes", "kb-btn"],
      ["/admin/polls/schedules/s1/toggle", "Disable", "kb-btn kb-btn--sm"],
      ["/admin/polls/schedules/s1/test", "Test", "kb-btn kb-btn--sm"],
      [
        "/admin/polls/schedules/s1/delete",
        "Delete",
        "kb-btn kb-btn--sm kb-btn--danger",
      ],
    ]);
    expect(
      rows[1].querySelector('form[action$="/toggle"] button')?.textContent,
    ).toBe("Enable");
  });

  it("keeps the Delete confirmation dialog on its form", () => {
    const rows = rowsOf();
    const del = rows[0].querySelector('form[action$="/s1/delete"]');
    expect(del?.getAttribute("data-confirm")).toBe("Delete schedule s1?");
  });

  it("opens Edit as a Disclosure holding the edit form, folded until refused", () => {
    const rows = rowsOf();
    const edit = rows[0].querySelector("details") as Element;
    expect(edit.className).toBe("kb-disclosure");
    expect(edit.hasAttribute("open")).toBe(false);
    expect(edit.querySelector("summary")?.textContent).toBe("Edit");
    expect(edit.querySelector("summary svg.kb-chev")).not.toBeNull();
    const form = edit.querySelector(".kb-disclosure__body > form");
    expect(form?.getAttribute("action")).toBe("/admin/polls/schedules/s1/edit");
    expect(form?.className).toBe("kb-stack");
  });

  it("builds the edit fields as Fields: label, control, kb- classes", () => {
    const rows = rowsOf();
    const form = rows[0].querySelector("details form") as Element;
    const channel = form.querySelector('select[name="channelId"]');
    expect(channel?.className).toBe("kb-select");
    expect(
      channel?.closest(".kb-field")?.querySelector("label")?.className,
    ).toBe("kb-label");
    const ping = form.querySelector('select[name="pingRoleId"]');
    expect(ping?.className).toBe("kb-select");
    expect(
      (ping?.closest(".kb-field")?.querySelector("label") as HTMLLabelElement)
        .textContent,
    ).toBe("Ping role");
  });

  it("ties every label to its control", () => {
    const doc = dom(render({ schedules: SCHEDULES, items: ITEMS }));
    for (const label of doc.querySelectorAll("main label.kb-label[for]")) {
      expect(
        doc.getElementById(label.getAttribute("for") ?? ""),
      ).not.toBeNull();
    }
    for (const select of doc.querySelectorAll("main select.kb-select")) {
      const id = select.getAttribute("id");
      expect(id).toBeTruthy();
      expect(doc.querySelector(`label[for="${id}"]`)).not.toBeNull();
    }
    const ids = Array.from(doc.querySelectorAll("[id]")).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("the question library table", () => {
  const tableOf = (): Element =>
    main(render({ items: ITEMS })).querySelector("table.kb-table") as Element;
  const rowsOf = (): Element[] =>
    Array.from(tableOf().querySelectorAll("tbody tr"));

  it("is a DataTable with the used count as a number column", () => {
    const table = tableOf();
    const rows = rowsOf();
    expect(table.closest(".kb-panel__body--flush")).not.toBeNull();
    const used = Array.from(table.querySelectorAll("thead th")).find(
      (h) => h.textContent === "Used",
    );
    expect(used?.classList.contains("kb-num")).toBe(true);
    expect(rows[0].querySelector("td.kb-num")?.textContent).toBe("3");
  });

  it("shows the answers in muted mono under the question", () => {
    const rows = rowsOf();
    const th = rows[0].querySelector('th[scope="row"]') as Element;
    expect(th.firstChild?.textContent).toBe("Pineapple on pizza?");
    const answers = th.querySelector("div");
    expect(answers?.className).toBe("kb-muted kb-mono");
    expect(answers?.textContent).toBe("Yes • No");
  });

  it("shows tags as Badges and none as a muted dash", () => {
    const rows = rowsOf();
    const tags = Array.from(
      rows[0].querySelectorAll("td")[0].querySelectorAll(".kb-badge"),
    ).map((b) => [b.className, b.textContent]);
    expect(tags).toEqual([
      ["kb-badge kb-badge--info", "food"],
      ["kb-badge kb-badge--info", "fun"],
    ]);
    const none = rows[1].querySelectorAll("td")[0].querySelector("span");
    expect(none?.className).toBe("kb-muted");
    expect(none?.textContent).toBe("—");
  });

  it("keeps every row action as a form post to the same route", () => {
    const rows = rowsOf();
    const actions = rows[0].querySelector("td.kb-actions") as Element;
    const posts = Array.from(actions.querySelectorAll("form")).map((f) => [
      f.getAttribute("action"),
      f.querySelector("button")?.textContent,
      f.querySelector("button")?.className,
    ]);
    expect(posts).toEqual([
      ["/admin/polls/items/i1/edit", "Save changes", "kb-btn"],
      ["/admin/polls/items/i1/toggle", "Disable", "kb-btn kb-btn--sm"],
      [
        "/admin/polls/items/i1/delete",
        "Delete",
        "kb-btn kb-btn--sm kb-btn--danger",
      ],
    ]);
    expect(
      rows[0]
        .querySelector('form[action$="/items/i1/delete"]')
        ?.getAttribute("data-confirm"),
    ).toBe("Delete poll question?");
  });

  it("shows multiple answers as a Switch that posts multiSelect=1 when ticked", () => {
    const rows = rowsOf();
    const box = (row: Element): HTMLInputElement =>
      row.querySelector('input[name="multiSelect"]') as HTMLInputElement;
    expect(box(rows[0]).getAttribute("role")).toBe("switch");
    expect(box(rows[0]).value).toBe("1");
    expect(box(rows[0]).checked).toBe(true);
    expect(box(rows[1]).checked).toBe(false);
    const label = box(rows[0]).closest("label");
    expect(label?.className).toBe("kb-switch");
    expect(label?.textContent).toContain("Allow multiple answer selections");
  });
});

describe("the empty states", () => {
  const body = main(render());

  it("say what is missing and how the area fills up", () => {
    const empties = Array.from(body.querySelectorAll(".kb-empty")).map((e) => [
      e.querySelector(".kb-empty__title")?.textContent,
      Boolean(e.querySelector(".kb-empty__text")?.textContent),
    ]);
    expect(empties).toEqual([
      ["No poll schedules configured.", true],
      ["No poll questions stored.", true],
    ]);
    expect(body.querySelectorAll("table")).toHaveLength(0);
  });
});

describe("the create, add and import forms", () => {
  const body = main(render({ schedules: SCHEDULES, items: ITEMS }));
  const form = (end: string): Element => {
    const f = Array.from(body.querySelectorAll("form")).find((x) =>
      x.getAttribute("action")?.endsWith(end),
    );
    if (!f) throw new Error(`no form ${end}`);
    return f;
  };

  it("builds Create a new schedule from Fields", () => {
    const f = form("/schedules/create");
    expect(f.className).toBe("kb-stack");
    expect(f.querySelector('select[name="channelId"]')?.className).toBe(
      "kb-select",
    );
    expect(f.querySelector('select[name="pingRoleId"]')?.className).toBe(
      "kb-select",
    );
    expect(f.querySelector('button[type="submit"]')?.textContent).toBe(
      "Create schedule",
    );
  });

  it("builds Add a poll question from Fields, a Switch and a neutral button", () => {
    const f = form("/items/create");
    expect(f.className).toBe("kb-stack");
    expect(f.querySelector('input[name="question"]')?.className).toBe(
      "kb-input",
    );
    expect(f.querySelector('input[name="tags"]')?.className).toBe("kb-input");
    expect(
      f.querySelector('input[name="multiSelect"]')?.getAttribute("role"),
    ).toBe("switch");
    expect(f.querySelector('button[type="submit"]')?.className).toBe("kb-btn");
    expect(f.querySelector('button[type="submit"]')?.textContent).toBe(
      "Add question",
    );
  });

  it("builds Import questions from Fields and keeps the upload script's ids", () => {
    const f = form("/items/import-text");
    const file = f.querySelector("#poll-import-file");
    expect(file?.getAttribute("type")).toBe("file");
    expect(file?.className).toBe("kb-input");
    const area = f.querySelector("#poll-import-content");
    expect(area?.tagName).toBe("TEXTAREA");
    expect(area?.className).toBe("kb-textarea");
    expect(area?.getAttribute("name")).toBe("content");
    expect(area?.getAttribute("maxlength")).toBe("200000");
    const msg = f.querySelector("#poll-import-msg");
    expect(msg?.getAttribute("role")).toBe("status");
    expect(msg?.className).toBe("kb-help");
    expect(f.querySelector('button[type="submit"]')?.className).toBe("kb-btn");
    expect(f.querySelector('button[type="submit"]')?.textContent).toBe(
      "Import",
    );
  });
});

describe("a refused form on the kb- page", () => {
  it("opens only the Disclosure of the refused row", () => {
    const body = main(
      render({
        schedules: SCHEDULES,
        items: ITEMS,
        refusedForm: REFUSED_ITEM_EDIT,
      }),
    );
    const open = Array.from(body.querySelectorAll("details.kb-disclosure")).map(
      (d) => d.hasAttribute("open"),
    );
    // Two schedule rows, then two question rows: only the first question.
    expect(open).toEqual([false, false, true, false]);
  });

  it("marks the refused field and links its error line", () => {
    const body = main(
      render({
        schedules: SCHEDULES,
        items: ITEMS,
        refusedForm: REFUSED_ITEM_EDIT,
      }),
    );
    // The answers are one box each, and the refusal marks every box of the field.
    const invalid = Array.from(body.querySelectorAll('[aria-invalid="true"]'));
    expect(invalid.length).toBeGreaterThan(0);
    expect(invalid.every((e) => e.getAttribute("name") === "answers")).toBe(
      true,
    );
    expect(invalid[0].getAttribute("aria-describedby")).toContain(
      "poll-item-edit-i1-answers-error",
    );
    const err = body.querySelector("#poll-item-edit-i1-answers-error");
    expect(err?.className).toBe("kb-field__error");
  });
});
