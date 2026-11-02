/* global Document, Element, HTMLInputElement, HTMLTextAreaElement, HTMLButtonElement, HTMLSelectElement */
/**
 * The Announcements and Notices pages, and the string-list editor the Presence
 * page uses, are built from the design system's components and no longer from
 * the old inline classes (#1642): PageHeader, Panel, DataTable, Button, Badge,
 * EmptyState, Callout, Field, Switch, KeyValue, Disclosure, SegmentedControl and
 * ReorderList (docs/design/components.md). Checked on the markup the pages
 * send, with the shared settings card and flash left out (#1647, #1684).
 */
import { describe, it, expect } from "@jest/globals";
import { JSDOM } from "jsdom";
import { ChannelType } from "discord.js";
import {
  renderAnnouncementsPage,
  renderBotStatusPage,
  renderNoticesPage,
  type AnnouncementsProps,
  type BotStatusProps,
  type NoticesProps,
} from "../../src/web/admin-views.js";
import type { RefusedForm } from "../../src/web/form-errors.js";

const CHANNELS = [{ id: "c1", name: "general", type: ChannelType.GuildText }];

const ANNOUNCEMENTS_BASE: AnnouncementsProps = {
  csrfToken: "csrf",
  remainingMs: 60_000,
  enabled: true,
  rows: [],
  textChannels: CHANNELS,
};

const ANNOUNCEMENT_ROWS: AnnouncementsProps["rows"] = [
  {
    id: "a1",
    channelName: "general",
    channelType: ChannelType.GuildText,
    cron: "0 9 * * 1",
    enabled: true,
    messagePreview: "Good morning!",
    embedTitle: "Weekly",
    placeholders: true,
    createdAt: "2026-01-01",
  },
  {
    id: "a2",
    channelName: "general",
    channelType: ChannelType.GuildText,
    cron: "0 18 * * 5",
    enabled: false,
    messagePreview: "Weekend!",
    embedTitle: null,
    placeholders: false,
    createdAt: "2026-01-02",
  },
];

const NOTICES_BASE: NoticesProps = {
  csrfToken: "csrf",
  remainingMs: 60_000,
  enabled: true,
  channel: { name: "rules", id: "c1", type: ChannelType.GuildText },
  total: 0,
  headerMessageId: "900000000000000002",
  headerEnabled: true,
  textChannels: [{ id: "c1", name: "rules", type: ChannelType.GuildText }],
  settingRows: [],
  groups: [],
  categoryOptions: [
    { value: "rules", label: "Rules" },
    { value: "info", label: "Info" },
  ],
};

const noticeRow = (id: string, order: number, category: string) => ({
  id,
  order,
  title: `Title ${id}`,
  content: `Content ${id}`,
  preview: `Preview ${id}`,
  category,
  messageId: `msg-${id}`,
  updatedAt: "2026-01-01",
});

const NOTICE_GROUPS: NoticesProps["groups"] = [
  {
    category: "Rules",
    rows: [noticeRow("n1", 0, "rules"), noticeRow("n2", 1, "rules")],
  },
  { category: "Info", rows: [noticeRow("n3", 0, "info")] },
];

const POOLS: BotStatusProps["pools"] = [
  {
    pool: "playing",
    label: "Playing",
    description: "Shown as Playing.",
    requiresCount: true,
    items: [
      { id: "i1", order: 0, text: "with the config" },
      { id: "i2", order: 1, text: "with the logs" },
    ],
    usingDefaults: false,
    exportText: "with the config\nwith the logs",
  },
  {
    pool: "watching",
    label: "Watching",
    description: "Shown as Watching.",
    requiresCount: false,
    items: [],
    usingDefaults: true,
    exportText: "",
  },
];

const BOT_STATUS_BASE: BotStatusProps = {
  csrfToken: "csrf",
  remainingMs: 60_000,
  maxLength: 100,
  pools: POOLS,
};

const announcements = (over: Partial<AnnouncementsProps> = {}): string =>
  renderAnnouncementsPage({ ...ANNOUNCEMENTS_BASE, ...over });
const notices = (over: Partial<NoticesProps> = {}): string =>
  renderNoticesPage({ ...NOTICES_BASE, ...over });
const presence = (over: Partial<BotStatusProps> = {}): string =>
  renderBotStatusPage({ ...BOT_STATUS_BASE, ...over });

const dom = (html: string): Document => new JSDOM(html).window.document;
const main = (html: string): Element => {
  const el = dom(html).querySelector("main");
  if (!el) throw new Error("no <main>");
  return el;
};

/** The old classes the issue lists, and the spellings that went with them. */
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
  "inline-form",
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

/**
 * The Presence page keeps its own heading and flash (not part of #1642); only
 * the editor panels are checked, so they are cut out of the page by their class.
 */
const editorPanels = (html: string): Element => {
  const holder = dom("<div></div>").createElement("div");
  for (const p of main(html).querySelectorAll("section.kb-panel")) {
    holder.appendChild(p.cloneNode(true));
  }
  return holder;
};

const REFUSED_CREATE: RefusedForm = {
  formId: "announcement-create",
  errors: { cron: "Use five fields.", embedColor: "Use six hex digits." },
  values: {
    channelId: "c1",
    cron: "bad",
    message: "Hello",
    embedTitle: "Title",
    embedColor: "#12",
  },
};
const REFUSED_ONCE: RefusedForm = {
  formId: "announcement-once",
  errors: { message: "Write a message." },
  values: { channelId: "c1", message: "" },
};
const REFUSED_NOTICE_CREATE: RefusedForm = {
  formId: "notice-create",
  errors: { title: "Give the notice a title." },
  values: { title: "", content: "Body", category: "rules" },
};
const REFUSED_NOTICE_EDIT: RefusedForm = {
  formId: "notice-edit-n1",
  errors: { content: "Write the notice." },
  values: { title: "Title n1", content: "", category: "rules" },
};
const REFUSED_ENTRY_EDIT: RefusedForm = {
  formId: "bot-status-edit-i1",
  errors: { text: "Write something." },
  values: { text: "" },
};
const REFUSED_IMPORT: RefusedForm = {
  formId: "bot-status-import-playing",
  errors: { items: "Paste at least one entry." },
  values: { items: "", mode: "append" },
};

const ANNOUNCEMENT_CASES: Array<[string, Partial<AnnouncementsProps>]> = [
  ["nothing scheduled", {}],
  ["feature off", { enabled: false }],
  ["rows", { rows: ANNOUNCEMENT_ROWS }],
  [
    "a refused create form",
    { rows: ANNOUNCEMENT_ROWS, refusedForm: REFUSED_CREATE },
  ],
  [
    "a refused one-off form",
    { rows: ANNOUNCEMENT_ROWS, refusedForm: REFUSED_ONCE },
  ],
];

const NOTICE_CASES: Array<[string, Partial<NoticesProps>]> = [
  ["nothing stored", {}],
  ["feature off", { enabled: false }],
  ["no channel", { channel: null, groups: NOTICE_GROUPS, total: 3 }],
  ["groups", { groups: NOTICE_GROUPS, total: 3 }],
  [
    "a refused create form",
    { groups: NOTICE_GROUPS, total: 3, refusedForm: REFUSED_NOTICE_CREATE },
  ],
  [
    "a refused edit form",
    { groups: NOTICE_GROUPS, total: 3, refusedForm: REFUSED_NOTICE_EDIT },
  ],
  [
    "a permission check that could not run",
    {
      groups: NOTICE_GROUPS,
      total: 3,
      permissionNotice: {
        unavailable: "The bot could not read its permissions.",
        missing: [],
        unchecked: [],
        stale: false,
      },
    },
  ],
];

const PRESENCE_CASES: Array<[string, Partial<BotStatusProps>]> = [
  ["entries and an empty pool", {}],
  ["a refused entry edit", { refusedForm: REFUSED_ENTRY_EDIT }],
  ["a refused import", { refusedForm: REFUSED_IMPORT }],
];

describe("the Announcements page renders only kb- components (#1642)", () => {
  it.each(ANNOUNCEMENT_CASES)(
    "uses none of the old classes: %s",
    (_n, over) => {
      expect(oldClassesIn(main(announcements(over)))).toEqual([]);
    },
  );

  it.each(ANNOUNCEMENT_CASES)(
    "has no bare table or heading: %s",
    (_n, over) => {
      const body = main(announcements(over));
      for (const t of body.querySelectorAll("table")) {
        expect(t.classList.contains("kb-table")).toBe(true);
      }
      const h1 = body.querySelectorAll("h1");
      expect(h1).toHaveLength(1);
      expect(h1[0].className).toBe("kb-pagehead__title");
      expect(h1[0].textContent).toBe("Announcements");
      expect(body.querySelector("fieldset")?.className ?? "kb-field").toBe(
        "kb-field",
      );
    },
  );

  it.each(ANNOUNCEMENT_CASES)(
    "has one primary button per view: %s",
    (_n, over) => {
      expect(
        main(announcements(over)).querySelectorAll(".kb-btn--primary"),
      ).toHaveLength(1);
    },
  );

  it("makes Create announcement the primary while the feature is on", () => {
    const primary = main(announcements()).querySelector(".kb-btn--primary");
    expect(primary?.textContent).toBe("Create announcement");
  });

  it("makes the callout's Enable the primary while the feature is off", () => {
    const body = main(announcements({ enabled: false }));
    expect(body.querySelector(".kb-btn--primary")?.textContent).toBe(
      "Enable announcements",
    );
    const create = Array.from(body.querySelectorAll("button")).find(
      (b) => b.textContent === "Create announcement",
    );
    expect(create?.className).toBe("kb-btn");
  });

  it("leaves the page's own markup on kb- classes next to the shared flash and settings", () => {
    const body = main(
      announcements({
        rows: ANNOUNCEMENT_ROWS,
        flash: { type: "err", text: "Nope." },
        settingRows: [
          {
            key: "announcements.enabled",
            label: "Scheduled announcements enabled",
            current: true,
            defaultValue: false,
            type: "boolean",
            description: "Enable scheduled announcements.",
            category: "announcements",
          },
        ],
      }),
    );
    for (const el of body.querySelectorAll("[data-flash], .notice")) {
      el.remove();
    }
    expect(oldClassesIn(body)).toEqual([]);
  });
});

describe("the Announcements header and panels", () => {
  const body = main(announcements({ rows: ANNOUNCEMENT_ROWS }));

  it("opens with a PageHeader holding the sub line and the status line", () => {
    const head = body.querySelector("header.kb-pagehead");
    expect(head?.querySelector(".kb-pagehead__sub")?.textContent).toBe(
      "Scheduled announcements posted on a cron.",
    );
    expect(head?.querySelector(".kb-statusline")?.textContent).toContain(
      "2 schedules",
    );
  });

  it("puts each topic in a titled Panel", () => {
    const titles = Array.from(
      body.querySelectorAll("section.kb-panel > .kb-panel__head h2"),
    ).map((h) => h.textContent);
    expect(titles).toEqual([
      "Schedules",
      "Create a new announcement",
      "Compose & send once",
    ]);
    for (const section of body.querySelectorAll("section.kb-panel")) {
      expect(section.getAttribute("aria-labelledby")).toBe(
        section.querySelector("h2")?.id,
      );
    }
  });

  it("keeps the post-weekly-stats action in the Schedules panel", () => {
    const form = body.querySelector(
      'section.kb-panel form[action="/admin/announcements/post-vc-stats"]',
    );
    expect(form?.querySelector("button")?.className).toBe("kb-btn");
    expect(form?.querySelector("button")?.textContent).toBe(
      "Post weekly VC stats now",
    );
  });

  it("shows an EmptyState that says how the list fills when nothing is scheduled", () => {
    const empty = main(announcements()).querySelector(".kb-empty");
    expect(empty?.querySelector(".kb-empty__title")?.textContent).toBe(
      "No scheduled announcements configured.",
    );
    expect(empty?.querySelector(".kb-empty__text")?.textContent).toMatch(
      /Create one below/,
    );
    expect(main(announcements()).querySelector("table")).toBeNull();
  });
});

describe("the Announcements table", () => {
  const tableOf = (): Element =>
    main(announcements({ rows: ANNOUNCEMENT_ROWS })).querySelector(
      "table.kb-table",
    ) as Element;
  const rowsOf = (): Element[] =>
    Array.from(tableOf().querySelectorAll("tbody tr"));

  it("is a DataTable run edge to edge, with row headers kept", () => {
    expect(tableOf().closest(".kb-panel__body--flush")).not.toBeNull();
    const heads = Array.from(tableOf().querySelectorAll("thead th")).map(
      (h) => [h.getAttribute("scope"), h.textContent],
    );
    expect(heads).toEqual([
      ["col", "ID"],
      ["col", "Channel"],
      ["col", "Cron"],
      ["col", "Status"],
      ["col", "Message"],
      ["col", "Placeholders"],
      ["col", "Created"],
      ["col", "Actions"],
    ]);
    const th = rowsOf()[0].querySelector('th[scope="row"]');
    expect(th?.className).toBe("kb-mono");
    expect(th?.textContent).toBe("a1");
  });

  it("shows state and placeholders as Badges with words", () => {
    const rows = rowsOf();
    const cell = (r: number, i: number): Element =>
      rows[r].querySelectorAll("td")[i];
    expect(cell(0, 2).querySelector(".kb-badge")?.className).toBe(
      "kb-badge kb-badge--on",
    );
    expect(cell(0, 2).textContent).toBe("On");
    expect(cell(1, 2).querySelector(".kb-badge")?.className).toBe(
      "kb-badge kb-badge--off",
    );
    expect(cell(0, 4).querySelector(".kb-badge")?.className).toBe(
      "kb-badge kb-badge--info",
    );
    expect(cell(1, 4).querySelector("span")?.className).toBe("kb-muted");
    expect(cell(0, 3).querySelector(".kb-muted.kb-mono")?.textContent).toBe(
      "embed: Weekly",
    );
  });

  it("keeps every row action as a form post to the same route, as small Buttons", () => {
    const actions = rowsOf()[0].querySelector("td.kb-actions") as Element;
    const posts = Array.from(actions.querySelectorAll("form")).map((f) => [
      f.getAttribute("action"),
      f.querySelector("button")?.textContent,
      f.querySelector("button")?.className,
    ]);
    expect(posts).toEqual([
      ["/admin/announcements/a1/post-now", "Post now", "kb-btn kb-btn--sm"],
      ["/admin/announcements/a1/toggle", "Disable", "kb-btn kb-btn--sm"],
      [
        "/admin/announcements/a1/delete",
        "Delete",
        "kb-btn kb-btn--sm kb-btn--danger",
      ],
    ]);
    expect(
      rowsOf()[1].querySelector('form[action$="/toggle"] button')?.textContent,
    ).toBe("Enable");
  });

  it("keeps the Delete confirmation dialog on its form", () => {
    expect(
      rowsOf()[0]
        .querySelector('form[action$="/a1/delete"]')
        ?.getAttribute("data-confirm"),
    ).toBe("Delete announcement a1?");
  });
});

describe("the Announcements forms", () => {
  const forms = (over: Partial<AnnouncementsProps> = {}): Element[] =>
    Array.from(
      main(announcements(over)).querySelectorAll("section.kb-panel form"),
    );
  const formAt = (
    action: string,
    over: Partial<AnnouncementsProps> = {},
  ): Element =>
    forms(over).find((f) => f.getAttribute("action") === action) as Element;

  it("posts the create form to the same route with the same field names", () => {
    const f = formAt("/admin/announcements/create");
    const names = Array.from(f.querySelectorAll("[name]")).map((e) =>
      e.getAttribute("name"),
    );
    expect(names).toEqual(
      expect.arrayContaining([
        "_csrf",
        "channelId",
        "cron",
        "message",
        "placeholders",
        "embedTitle",
        "embedDescription",
        "embedColor",
        "use_default_embedColor",
      ]),
    );
    expect(f.className).toBe("kb-stack");
  });

  it("posts the one-off form without a schedule", () => {
    const f = formAt("/admin/announcements/post-once");
    const names = Array.from(f.querySelectorAll("[name]")).map((e) =>
      e.getAttribute("name"),
    );
    expect(names).not.toContain("cron");
    expect(names).toEqual(
      expect.arrayContaining([
        "channelId",
        "message",
        "placeholders",
        "embedTitle",
      ]),
    );
    expect(f.querySelector('button[type="submit"]')?.textContent).toBe(
      "Post now",
    );
    expect(f.querySelector('button[type="submit"]')?.className).toBe("kb-btn");
  });

  it("ties every labelled control to its label by id", () => {
    for (const f of forms()) {
      for (const label of f.querySelectorAll("label.kb-label[for]")) {
        const target = f.querySelector(`#${label.getAttribute("for")}`);
        expect(target).not.toBeNull();
      }
    }
    const f = formAt("/admin/announcements/create");
    const message = f.querySelector(
      'textarea[name="message"]',
    ) as HTMLTextAreaElement;
    expect(message.className).toBe("kb-textarea");
    expect(message.id).toBe("announcement-create-message");
    expect(
      f.querySelector('label[for="announcement-create-message"]')?.textContent,
    ).toBe("Message");
    const channel = f.querySelector(
      'select[name="channelId"]',
    ) as HTMLSelectElement;
    expect(channel.className).toBe("kb-select");
    expect(channel.id).toBe("announcement-create-channelId");
  });

  it("draws Process placeholders as a Switch", () => {
    const f = formAt("/admin/announcements/create");
    const input = f.querySelector(
      'input[name="placeholders"]',
    ) as HTMLInputElement;
    expect(input.getAttribute("role")).toBe("switch");
    expect(input.closest("label")?.className).toBe("kb-switch");
    expect(input.closest("label")?.textContent).toContain(
      "Process placeholders",
    );
  });

  it("lists the placeholders as KeyValue inside an inline Disclosure", () => {
    const f = formAt("/admin/announcements/create");
    const d = f.querySelector("details.kb-disclosure--inline") as Element;
    expect(d.querySelector("summary")?.textContent).toBe(
      "Available placeholders",
    );
    expect(d.querySelector("summary svg.kb-chev")).not.toBeNull();
    expect(d.querySelectorAll("dl.kb-kv dt")).toHaveLength(17);
    expect(d.querySelector("dl.kb-kv dt")?.textContent).toBe("{server_name}");
  });

  it("keeps the optional embed as a labelled group of Fields", () => {
    const f = formAt("/admin/announcements/create");
    const group = f.querySelector("fieldset") as Element;
    expect(group.className).toBe("kb-field");
    expect(group.querySelector("legend")?.className).toBe("kb-label");
    expect(group.querySelector("legend")?.textContent).toBe("Optional embed");
    expect(group.querySelectorAll(".kb-field")).toHaveLength(3);
  });

  it("draws a refused create form again with its values and error lines", () => {
    const f = formAt("/admin/announcements/create", {
      refusedForm: REFUSED_CREATE,
    });
    const err = f.querySelectorAll("p.kb-field__error");
    expect(Array.from(err).map((e) => e.textContent)).toEqual([
      "Use five fields.",
      "Use six hex digits.",
    ]);
    const message = f.querySelector(
      'textarea[name="message"]',
    ) as HTMLTextAreaElement;
    expect(message.value).toBe("Hello");
    expect(
      (f.querySelector('input[name="embedTitle"]') as HTMLInputElement).value,
    ).toBe("Title");
    // The one-off form was not the refused one: no errors there.
    const once = formAt("/admin/announcements/post-once", {
      refusedForm: REFUSED_CREATE,
    });
    expect(once.querySelectorAll("p.kb-field__error")).toHaveLength(0);
  });

  it("marks the refused control invalid and links its error", () => {
    const f = formAt("/admin/announcements/post-once", {
      refusedForm: REFUSED_ONCE,
    });
    const message = f.querySelector('textarea[name="message"]') as Element;
    expect(message.getAttribute("aria-invalid")).toBe("true");
    expect(message.getAttribute("aria-describedby")).toBe(
      "announcement-once-message-error",
    );
    expect(
      f.querySelector("#announcement-once-message-error")?.textContent,
    ).toBe("Write a message.");
  });
});

describe("the Notices page renders only kb- components (#1642)", () => {
  it.each(NOTICE_CASES)("uses none of the old classes: %s", (_n, over) => {
    expect(oldClassesIn(main(notices(over)))).toEqual([]);
  });

  it.each(NOTICE_CASES)("has no bare table or heading: %s", (_n, over) => {
    const body = main(notices(over));
    for (const t of body.querySelectorAll("table")) {
      expect(t.classList.contains("kb-table")).toBe(true);
    }
    const h1 = body.querySelectorAll("h1");
    expect(h1).toHaveLength(1);
    expect(h1[0].className).toBe("kb-pagehead__title");
    expect(h1[0].textContent).toBe("Notices");
  });

  it.each(NOTICE_CASES)("has one primary button per view: %s", (_n, over) => {
    expect(
      main(notices(over)).querySelectorAll(".kb-btn--primary"),
    ).toHaveLength(1);
  });

  it("makes Create notice the primary while the feature is on, and Enable while off", () => {
    expect(main(notices()).querySelector(".kb-btn--primary")?.textContent).toBe(
      "Create notice",
    );
    const off = main(notices({ enabled: false }));
    expect(off.querySelector(".kb-btn--primary")?.textContent).toBe(
      "Enable notices",
    );
  });

  it("leaves the page's own markup on kb- classes next to the shared flash and settings", () => {
    const body = main(
      notices({
        groups: NOTICE_GROUPS,
        total: 3,
        flash: { type: "ok", text: "Saved." },
        settingRows: [
          {
            key: "notices.enabled",
            label: "Notices system enabled",
            current: true,
            defaultValue: false,
            type: "boolean",
            description: "Enable the notices system.",
            category: "notices",
          },
        ],
      }),
    );
    for (const el of body.querySelectorAll("[data-flash], .notice")) {
      el.remove();
    }
    expect(oldClassesIn(body)).toEqual([]);
  });
});

describe("the Notices header, panels and order", () => {
  const body = main(notices({ groups: NOTICE_GROUPS, total: 3 }));

  it("opens with a PageHeader holding the sub line and the status line", () => {
    const head = body.querySelector("header.kb-pagehead");
    expect(head?.querySelector(".kb-pagehead__sub")?.textContent).toMatch(
      /^Notice posts grouped by category\./,
    );
    const status = head?.querySelector(".kb-statusline")?.textContent ?? "";
    expect(status).toContain("3 notices");
    expect(status).toMatch(/Channel #\s?rules/);
  });

  it("puts the notices first, then the forms and bot actions, with the settings last", () => {
    const titles = Array.from(
      body.querySelectorAll("section.kb-panel > .kb-panel__head h2"),
    ).map((h) => h.textContent);
    expect(titles).toEqual([
      "Rules",
      "Info",
      "Create a notice",
      "Header post",
      "Resync to the channel",
    ]);
    for (const section of body.querySelectorAll("section.kb-panel")) {
      expect(section.getAttribute("aria-labelledby")).toBe(
        section.querySelector("h2")?.id,
      );
    }
    const ids = Array.from(body.querySelectorAll("section.kb-panel")).map(
      (s) => s.id,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("counts the notices in the head of each category panel", () => {
    const meta = Array.from(
      body.querySelectorAll(
        "section.kb-panel > .kb-panel__head .kb-panel__meta",
      ),
    ).map((m) => m.textContent);
    expect(meta.slice(0, 2)).toEqual(["2", "1"]);
  });

  it("keeps the order note and the live region for moves", () => {
    expect(body.querySelector("#notices-order-note")?.className).toBe(
      "kb-help",
    );
    expect(body.querySelector("#reorder-status")?.getAttribute("role")).toBe(
      "status",
    );
  });

  it("shows an EmptyState that says how notices appear when none are stored", () => {
    const empty = main(notices()).querySelector(".kb-empty");
    expect(empty?.querySelector(".kb-empty__title")?.textContent).toBe(
      "No notices stored.",
    );
    expect(empty?.querySelector(".kb-empty__text")?.textContent).toMatch(
      /create below/,
    );
  });
});

describe("the Notices tables", () => {
  const body = main(notices({ groups: NOTICE_GROUPS, total: 3 }));
  const table = body.querySelector("table.kb-table") as Element;

  it("is a DataTable per category, run edge to edge, with its caption hidden", () => {
    expect(body.querySelectorAll("table.kb-table")).toHaveLength(2);
    expect(table.closest(".kb-panel__body--flush")).not.toBeNull();
    expect(table.querySelector("caption")?.className).toBe(
      "kb-visually-hidden",
    );
    expect(
      Array.from(table.querySelectorAll("thead th")).map((h) => [
        h.getAttribute("scope"),
        h.textContent,
      ]),
    ).toEqual([
      ["col", "Order"],
      ["col", "Title"],
      ["col", "Content"],
      ["col", "Message ID"],
      ["col", "Updated"],
      ["col", "Actions"],
    ]);
  });

  it("keeps the markup the drag script and its styles find", () => {
    const tbody = table.querySelector("tbody") as Element;
    expect(tbody.hasAttribute("data-reorder-list")).toBe(true);
    expect(tbody.getAttribute("data-reorder-group")).toBe("Rules");
    const rows = Array.from(tbody.querySelectorAll("tr"));
    expect(rows).toHaveLength(2);
    expect(rows[0].hasAttribute("data-reorder-row")).toBe(true);
    expect(rows[0].id).toBe("notice-n1");
    expect(rows[0].querySelector('th[scope="row"]')?.textContent).toContain(
      "Title n1",
    );
    expect(rows[0].querySelector(".kb-reorder")).not.toBeNull();
    expect(
      rows[0].querySelector('form[action="/admin/notices/n1/move"]'),
    ).not.toBeNull();
  });

  it("keeps every row action on the same route, Delete with its confirmation", () => {
    const row = table.querySelector("tbody tr") as Element;
    const del = row.querySelector(
      'form[action="/admin/notices/n1/delete"]',
    ) as Element;
    expect(del.getAttribute("data-confirm")).toBe("Delete notice 'Title n1'?");
    expect(del.querySelector("button")?.className).toBe(
      "kb-btn kb-btn--sm kb-btn--danger",
    );
    const edit = row.querySelector("details.kb-disclosure") as Element;
    expect(edit.hasAttribute("open")).toBe(false);
    expect(edit.querySelector("summary")?.textContent).toBe("Edit");
    const form = edit.querySelector('form[action="/admin/notices/n1/update"]');
    expect(form?.className).toBe("kb-stack");
    expect(
      Array.from(form?.querySelectorAll("[name]") ?? []).map((e) =>
        e.getAttribute("name"),
      ),
    ).toEqual(["_csrf", "title", "content", "category"]);
    expect(
      (form?.querySelector('select[name="category"]') as HTMLSelectElement)
        .className,
    ).toBe("kb-select");
  });

  it("gives each edit control an id unique to its notice, tied to its label", () => {
    const ids = Array.from(
      body.querySelectorAll("details input[name=title]"),
    ).map((e) => e.id);
    expect(ids).toEqual([
      "notice-edit-n1-title",
      "notice-edit-n2-title",
      "notice-edit-n3-title",
    ]);
    expect(
      body.querySelector('label[for="notice-edit-n1-title"]')?.textContent,
    ).toBe("Title");
  });

  it("opens only the refused row's Edit and shows its error", () => {
    const html = main(
      notices({
        groups: NOTICE_GROUPS,
        total: 3,
        refusedForm: REFUSED_NOTICE_EDIT,
      }),
    );
    const open = html.querySelectorAll("details.kb-disclosure[open]");
    expect(open).toHaveLength(1);
    expect(open[0].querySelector("p.kb-field__error")?.textContent).toBe(
      "Write the notice.",
    );
    expect(
      open[0]
        .querySelector('textarea[name="content"]')
        ?.getAttribute("aria-invalid"),
    ).toBe("true");
  });
});

describe("the Notices create form and bot actions", () => {
  const body = main(notices({ groups: NOTICE_GROUPS, total: 3 }));
  const create = body.querySelector(
    'form[action="/admin/notices/create"]',
  ) as Element;

  it("posts the create form with the same fields, as Fields", () => {
    expect(create.className).toBe("kb-stack");
    expect(
      Array.from(create.querySelectorAll("[name]")).map((e) =>
        e.getAttribute("name"),
      ),
    ).toEqual(["_csrf", "title", "content", "category"]);
    expect(create.querySelectorAll(".kb-field")).toHaveLength(3);
    expect(
      create.querySelector('label[for="notice-create-title"]')?.textContent,
    ).toBe("Title");
    expect(
      (create.querySelector('select[name="category"]') as HTMLSelectElement)
        .className,
    ).toBe("kb-select");
  });

  it("draws a refused create form again with its value and error", () => {
    const f = main(
      notices({
        groups: NOTICE_GROUPS,
        total: 3,
        refusedForm: REFUSED_NOTICE_CREATE,
      }),
    ).querySelector('form[action="/admin/notices/create"]') as Element;
    expect(f.querySelector("p.kb-field__error")?.textContent).toBe(
      "Give the notice a title.",
    );
    expect(
      (f.querySelector('textarea[name="content"]') as HTMLTextAreaElement)
        .value,
    ).toBe("Body");
  });

  it("keeps Resync with its confirmation and consequence list, as a danger Button", () => {
    const form = body.querySelector(
      'form[action="/admin/notices/sync"]',
    ) as Element;
    expect(form.getAttribute("data-confirm")).toBe(
      "Resync all notices? This deletes and reposts every notice message.",
    );
    expect(
      JSON.parse(form.getAttribute("data-confirm-list") ?? "[]"),
    ).toHaveLength(2);
    const button = form.querySelector("button") as HTMLButtonElement;
    expect(button.className).toBe("kb-btn kb-btn--danger");
    expect(button.textContent).toBe("Resync notices to channel");
    expect(form.querySelector(".kb-help")?.textContent).toBe(
      "Deletes and reposts every notice message in the channel.",
    );
  });

  it("keeps the Re-post card", () => {
    expect(
      body.querySelector('form[action="/admin/notices/header/repost"]'),
    ).not.toBeNull();
  });
});

describe("the string-list editor on the Presence page renders only kb- components (#1642)", () => {
  it.each(PRESENCE_CASES)("uses none of the old classes: %s", (_n, over) => {
    expect(oldClassesIn(editorPanels(presence(over)))).toEqual([]);
  });

  it.each(PRESENCE_CASES)("has no bare table: %s", (_n, over) => {
    for (const t of editorPanels(presence(over)).querySelectorAll("table")) {
      expect(t.classList.contains("kb-table")).toBe(true);
    }
  });

  it("draws one titled Panel per pool, with the count in its head", () => {
    const panels = Array.from(
      editorPanels(presence()).querySelectorAll("section.kb-panel"),
    );
    expect(panels.map((p) => p.querySelector("h2")?.textContent)).toEqual([
      "Playing",
      "Watching",
    ]);
    expect(
      panels.map((p) => p.querySelector(".kb-panel__meta")?.textContent),
    ).toEqual(["2", "0"]);
    for (const p of panels) {
      expect(p.getAttribute("aria-labelledby")).toBe(p.querySelector("h2")?.id);
    }
  });

  it("has no primary button of its own", () => {
    expect(
      editorPanels(presence()).querySelectorAll(".kb-btn--primary"),
    ).toHaveLength(0);
  });

  it("keeps the move markup and posts", () => {
    const panel = editorPanels(presence()).querySelector(
      "section.kb-panel",
    ) as Element;
    const tbody = panel.querySelector("table.kb-table tbody") as Element;
    expect(tbody.hasAttribute("data-reorder-list")).toBe(true);
    const row = tbody.querySelector("tr") as Element;
    expect(row.id).toBe("entry-i1");
    expect(row.hasAttribute("data-reorder-row")).toBe(true);
    expect(
      row.querySelector('form[action="/admin/bot-status/entry/i1/move"]'),
    ).not.toBeNull();
    expect(row.querySelector('th[scope="row"]')?.textContent).toContain(
      "with the config",
    );
  });

  it("keeps Edit and Delete on the same routes, Delete with its confirmation", () => {
    const row = editorPanels(presence()).querySelector("tbody tr") as Element;
    const edit = row.querySelector("details.kb-disclosure") as Element;
    expect(edit.querySelector("summary")?.textContent).toBe("Edit");
    expect(
      edit.querySelector(
        'form[action="/admin/bot-status/entry/i1/update"] input[name="text"]',
      ),
    ).not.toBeNull();
    const del = row.querySelector(
      'form[action="/admin/bot-status/entry/i1/delete"]',
    ) as Element;
    expect(del.getAttribute("data-confirm")).toBe("Delete this entry?");
    expect(del.querySelector("button")?.className).toBe(
      "kb-btn kb-btn--sm kb-btn--danger",
    );
  });

  it("shows an empty pool as an EmptyState and says the defaults are in use in a Callout", () => {
    const panel =
      editorPanels(presence()).querySelectorAll("section.kb-panel")[1];
    expect(panel.querySelector(".kb-empty__title")?.textContent).toBe(
      "No entries stored.",
    );
    expect(panel.querySelector("table")).toBeNull();
    const callout = panel.querySelector(".kb-callout") as Element;
    expect(callout.classList.contains("kb-callout--warn")).toBe(true);
    expect(callout.getAttribute("role")).toBe("status");
    expect(callout.querySelector(".kb-callout__title")?.textContent).toMatch(
      /^This pool has no stored entries/,
    );
    const seed = callout.querySelector(
      'form[action="/admin/bot-status/pool/watching/seed"] button',
    );
    expect(seed?.textContent).toBe("Seed defaults into store");
    expect(seed?.className).toBe("kb-btn kb-btn--sm");
  });

  it("adds entries from a Field with the hint under it", () => {
    const panel = editorPanels(presence()).querySelector(
      "section.kb-panel",
    ) as Element;
    const form = panel.querySelector(
      'form[action="/admin/bot-status/pool/playing/add"]',
    ) as Element;
    expect(form.className).toBe("kb-stack");
    const input = form.querySelector('input[name="text"]') as HTMLInputElement;
    expect(input.className).toBe("kb-input");
    expect(form.querySelector(`label[for="${input.id}"]`)?.textContent).toBe(
      "Add entry",
    );
    expect(form.querySelector(".kb-help")?.textContent).toBe(
      "Must contain the {count} placeholder.",
    );
    expect(form.querySelector("button")?.textContent).toBe("Add");
  });

  it("draws the import as a Disclosure with a SegmentedControl, folded until refused", () => {
    const folded = editorPanels(presence()).querySelector(
      ".kb-panel__body > details.kb-disclosure",
    ) as Element;
    expect(folded.querySelector("summary")?.textContent).toBe(
      "Import / export",
    );
    expect(folded.hasAttribute("open")).toBe(false);
    const seg = folded.querySelector("div.kb-segmented") as Element;
    expect(seg.getAttribute("role")).toBe("radiogroup");
    expect(seg.getAttribute("aria-label")).toBe("What to do with the pool");
    const radios = Array.from(
      seg.querySelectorAll("input[type=radio]"),
    ) as HTMLInputElement[];
    expect(radios.map((r) => [r.name, r.value, r.checked])).toEqual([
      ["mode", "replace", true],
      ["mode", "append", false],
    ]);
    expect(
      folded.querySelector(
        'form[action="/admin/bot-status/pool/playing/import"]',
      ),
    ).not.toBeNull();
  });

  it("opens a refused import with its value, error and chosen mode", () => {
    const open = editorPanels(
      presence({ refusedForm: REFUSED_IMPORT }),
    ).querySelector("details.kb-disclosure[open]") as Element;
    expect(open.querySelector("p.kb-field__error")?.textContent).toBe(
      "Paste at least one entry.",
    );
    const append = open.querySelector(
      'input[value="append"]',
    ) as HTMLInputElement;
    expect(append.checked).toBe(true);
  });

  it("opens a refused entry edit and shows its error", () => {
    const open = editorPanels(
      presence({ refusedForm: REFUSED_ENTRY_EDIT }),
    ).querySelectorAll("tbody details.kb-disclosure[open]");
    expect(open).toHaveLength(1);
    expect(open[0].querySelector("p.kb-field__error")?.textContent).toBe(
      "Write something.",
    );
  });
});

describe("review fixes on #1695", () => {
  const switchForms: Array<[string, string]> = [
    ["the create form", "/admin/announcements/create"],
    ["the one-off form", "/admin/announcements/post-once"],
  ];

  it.each(switchForms)(
    "keeps the whole switch sentence in one span: %s",
    (_n, action) => {
      const form = main(announcements()).querySelector(
        `form[action="${action}"]`,
      ) as Element;
      const labels = Array.from(form.querySelectorAll("label.kb-switch"));
      expect(labels.length).toBeGreaterThan(0);
      for (const label of labels) {
        // Track and state first, then one text span: the sentence and its
        // inline code wrap together instead of becoming flex items.
        const kids = Array.from(label.children).map((c) => c.tagName);
        expect(kids).toEqual(["INPUT", "SPAN", "SPAN", "SPAN"]);
        const text = label.lastElementChild as Element;
        expect(text.className).toBe("");
        expect(text.textContent).toContain("Process placeholders");
        expect(text.querySelectorAll("code")).toHaveLength(2);
        // No stray text node beside the spans.
        const loose = Array.from(label.childNodes).filter(
          (n) => n.nodeType === 3 && (n.textContent ?? "").trim() !== "",
        );
        expect(loose).toHaveLength(0);
      }
    },
  );

  it("puts the Presence pool panels in one kb-stack", () => {
    const panels = Array.from(
      main(presence()).querySelectorAll("section.kb-panel"),
    );
    expect(panels).toHaveLength(2);
    const parent = panels[0].parentElement as Element;
    expect(parent.classList.contains("kb-stack")).toBe(true);
    expect(panels[1].parentElement).toBe(parent);
  });
});
