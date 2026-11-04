/**
 * @jest-environment <rootDir>/__tests__/jsdom-node-env.cjs
 */
/* global DOMParser, Element */

/**
 * The Quotes and Birthdays pages are built from the kb- components (#1641).
 *
 * `renderQuotesPage` and `renderBirthdaysPage` render no class from the old
 * inline `STYLE` set (docs/design/patterns.md, From the old classes), and keep
 * their routes, field names and confirmation dialogs. The folded Settings card
 * and the flash are shared helpers that the Settings issue (#1647) moves, so
 * the pages here are drawn with no settings rows and no flash.
 */

import { describe, it, expect } from "@jest/globals";
import { ChannelType } from "discord.js";
import {
  renderBirthdaysPage,
  renderQuotesPage,
  type BirthdaysProps,
  type QuotesProps,
} from "../../src/web/admin-views.js";

const COMMON = { csrfToken: "csrf", remainingMs: 600_000 };

const QUOTES: QuotesProps = {
  ...COMMON,
  enabled: true,
  channel: { name: "quotes", id: "c1", type: ChannelType.GuildText },
  headerMessageId: "900000000000000001",
  settingRows: [],
  maxLength: 1000,
  rows: [],
  total: 0,
  page: 1,
  pageSize: 25,
  search: "",
};

const QUOTE = {
  id: "0123456789abcdef01234567",
  content: "Stay hydrated.",
  authorId: "111111111111111111",
  authorLabel: "Alice",
  addedByLabel: "Bob",
  addedAt: "2026-09-01T00:00:00.000Z",
  likes: 3,
  dislikes: 1,
  messageId: "333333333333333333",
};

const BIRTHDAYS: BirthdaysProps = {
  ...COMMON,
  enabled: true,
  channel: { name: "general", id: "c1", type: ChannelType.GuildText },
  role: { name: "Birthday", id: "r1" },
  cron: "0 * * * *",
  settingRows: [],
  preview: {
    mentionUserId: "999999999999999999",
    mentionLabel: "Admin",
    mention: true,
    withAge: "Happy birthday, <@999999999999999999>! You turn 30",
    withoutAge: "Happy birthday, <@999999999999999999>!",
    sampleAge: 30,
  },
  rows: [],
  total: 0,
  page: 1,
  pageSize: 25,
};

const BIRTHDAY = {
  userId: "111111111111111111",
  userLabel: "Alice",
  month: 9,
  day: 25,
  hasYear: true,
  nextDate: "2026-09-25",
  daysUntil: 1,
  roleGranted: true,
  lastAnnouncedYear: 2025,
};

const PAGES: ReadonlyArray<{ name: string; html: string }> = [
  { name: "Quotes, empty", html: renderQuotesPage(QUOTES) },
  {
    name: "Quotes, feature off and no channel",
    html: renderQuotesPage({
      ...QUOTES,
      enabled: false,
      channel: null,
      headerMessageId: "",
    }),
  },
  {
    name: "Quotes, search without a match",
    html: renderQuotesPage({ ...QUOTES, search: "zz" }),
  },
  {
    name: "Quotes, a page of quotes",
    html: renderQuotesPage({
      ...QUOTES,
      rows: [QUOTE],
      total: 80,
      page: 2,
      search: "a",
    }),
  },
  {
    name: "Quotes, edit refused",
    html: renderQuotesPage({
      ...QUOTES,
      rows: [QUOTE],
      total: 1,
      refusedForm: {
        formId: `quote-edit-${QUOTE.id}`,
        errors: { author_id: "Enter the Discord user ID of the author." },
        values: { content: "Stay hydrated.", author_id: "alice" },
      },
    }),
  },
  { name: "Birthdays, empty", html: renderBirthdaysPage(BIRTHDAYS) },
  {
    name: "Birthdays, feature off, no role and no channel",
    html: renderBirthdaysPage({
      ...BIRTHDAYS,
      enabled: false,
      channel: null,
      role: null,
      preview: { ...BIRTHDAYS.preview, withoutAge: null, mention: false },
    }),
  },
  {
    name: "Birthdays, stored birthdays unreadable",
    html: renderBirthdaysPage({ ...BIRTHDAYS, listUnavailable: true }),
  },
  {
    name: "Birthdays, a page of members",
    html: renderBirthdaysPage({
      ...BIRTHDAYS,
      rows: [
        BIRTHDAY,
        {
          ...BIRTHDAY,
          userId: "2",
          hasYear: false,
          roleGranted: false,
          lastAnnouncedYear: null,
        },
      ],
      total: 60,
      page: 2,
    }),
  },
  {
    name: "Birthdays, edit refused",
    html: renderBirthdaysPage({
      ...BIRTHDAYS,
      rows: [BIRTHDAY],
      total: 1,
      refusedForm: {
        formId: `birthday-edit-${BIRTHDAY.userId}`,
        errors: { month: "Choose a month." },
        values: { month: "", day: "20", clear_year: "1" },
      },
    }),
  },
];

/** The classes of the old inline `STYLE` set that these two pages used. */
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
  "muted",
  "mono",
  "inline-form",
  "stack",
  "actions",
  "edit-details",
  "checkbox",
  "tag",
  "tag-on",
  "tag-off",
  "tag-info",
  "tag-warn",
];

function mainOf(html: string): Element {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const main = doc.querySelector("main");
  if (!main) throw new Error("no main element");
  return main;
}

describe("Quotes and Birthdays pages on the kb- components (#1641)", () => {
  it.each(PAGES)("$name renders no old class and no bare table", ({ html }) => {
    const main = mainOf(html);
    const found = new Set<string>();
    main.querySelectorAll("[class]").forEach((el) => {
      el.classList.forEach((c) => {
        if (OLD_CLASSES.includes(c)) found.add(c);
      });
    });
    expect([...found]).toEqual([]);
    main.querySelectorAll("table").forEach((t) => {
      expect(t.classList.contains("kb-table")).toBe(true);
    });
    expect(main.querySelector("h1:not(.kb-pagehead__title)")).toBeNull();
  });

  it.each(PAGES)(
    "$name opens with a PageHeader holding the one h1",
    ({ html }) => {
      const main = mainOf(html);
      expect(main.querySelectorAll("h1")).toHaveLength(1);
      expect(
        main.querySelector("header.kb-pagehead h1.kb-pagehead__title"),
      ).not.toBeNull();
      expect(
        main.querySelector("header.kb-pagehead .kb-pagehead__sub"),
      ).not.toBeNull();
      expect(
        main.querySelector("header.kb-pagehead .kb-statusline"),
      ).not.toBeNull();
    },
  );

  it.each(PAGES)("$name has no primary button of its own", ({ html }) => {
    const main = mainOf(html);
    // Only the feature-off callout's Enable may be primary (components.md, Callout).
    const own = Array.from(main.querySelectorAll(".kb-btn--primary")).filter(
      (b) => !b.closest("dialog, .kb-savebar, .kb-callout"),
    );
    expect(own.map((b) => b.textContent?.trim())).toEqual([]);
  });

  it("Quotes puts the stored quotes in a Panel with a DataTable and a footer pager", () => {
    const main = mainOf(PAGES[3].html);
    const panel = main.querySelector("section.kb-panel#quotes-list");
    expect(panel).not.toBeNull();
    expect(
      panel?.querySelector(".kb-panel__body--flush table.kb-table"),
    ).not.toBeNull();
    const head = Array.from(panel?.querySelectorAll("thead th") ?? []).map(
      (th) => th.textContent?.trim(),
    );
    expect(head).toEqual([
      "Quote",
      "Author",
      "Added by",
      "Added",
      "Votes",
      "Message ID",
      "Actions",
    ]);
    expect(panel?.querySelector("tbody th[scope=row]")?.textContent).toContain(
      "Stay hydrated.",
    );
    expect(
      panel?.querySelector("tbody td[colspan] details.kb-disclosure"),
    ).not.toBeNull();
    const del = panel?.querySelector(
      `form[action="/admin/quotes/${QUOTE.id}/delete"] button.kb-btn--danger`,
    );
    expect(del?.getAttribute("aria-label")).toBe(`Delete quote ${QUOTE.id}`);
    expect(
      panel?.querySelector("footer.kb-panel__foot")?.textContent,
    ).toContain("Page 2 of 4");
  });

  it("Quotes shows an EmptyState that says how quotes arrive, or that the search found none", () => {
    const empty = mainOf(PAGES[0].html);
    expect(empty.querySelector(".kb-empty .kb-empty__title")?.textContent).toBe(
      "No quotes stored.",
    );
    expect(
      empty.querySelector(".kb-empty .kb-empty__text")?.textContent,
    ).toContain("/quote add");
    const none = mainOf(PAGES[2].html);
    expect(none.querySelector(".kb-empty .kb-empty__title")?.textContent).toBe(
      "No quotes match this search.",
    );
  });

  it("Quotes edit fields are labelled Fields and keep their names", () => {
    const main = mainOf(PAGES[4].html);
    const area = main.querySelector("textarea.kb-textarea[name=content]");
    const author = main.querySelector("input.kb-input[name=author_id]");
    expect(area).not.toBeNull();
    expect(author?.getAttribute("aria-invalid")).toBe("true");
    for (const el of [area, author]) {
      const id = el?.getAttribute("id") ?? "";
      expect(id).not.toBe("");
      expect(main.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
      expect(main.querySelector(`label.kb-label[for="${id}"]`)).not.toBeNull();
    }
    expect(main.querySelector("details.kb-disclosure[open]")).not.toBeNull();
  });

  it("Quotes keeps Resync behind its confirmation and says why it is off", () => {
    const on = mainOf(PAGES[0].html);
    const form = on.querySelector('form[action="/admin/quotes/sync"]');
    expect(form?.getAttribute("data-confirm")).toBe(
      "Rebuild the quote channel? This deletes every message in it and reposts all quotes with their saved votes.",
    );
    expect(
      form?.querySelector("button.kb-btn--danger")?.hasAttribute("disabled"),
    ).toBe(false);
    const off = mainOf(PAGES[1].html);
    const offBtn = off.querySelector(
      'form[action="/admin/quotes/sync"] button',
    );
    expect(offBtn?.hasAttribute("disabled")).toBe(true);
    expect(
      off.querySelector('form[action="/admin/quotes/sync"]')?.textContent,
    ).toContain("Turn on Quotes first.");
    expect(
      off.querySelector('a.kb-btn[href="/admin/quotes/export"]'),
    ).not.toBeNull();
  });

  it("Birthdays leads with the stored members, then the preview, then the run, and ends with the settings", () => {
    const main = mainOf(PAGES[8].html);
    const titles = Array.from(main.querySelectorAll("h2.kb-panel__title")).map(
      (h) => h.textContent?.trim(),
    );
    expect(titles).toEqual([
      "Stored birthdays",
      "Message preview",
      "Run the check",
    ]);
  });

  it("Birthdays draws the stored members as a DataTable with Badge and Switch", () => {
    const main = mainOf(PAGES[8].html);
    const table = main.querySelector("table.kb-table");
    expect(table).not.toBeNull();
    const head = Array.from(table?.querySelectorAll("thead th") ?? []).map(
      (th) => th.textContent?.trim(),
    );
    expect(head).toEqual([
      "Member",
      "Birthday",
      "Next",
      "Birth year",
      "Role grant",
      "Last handled",
      "Actions",
    ]);
    expect(table?.querySelector(".kb-badge.kb-badge--on")?.textContent).toBe(
      "granted",
    );
    expect(
      table?.querySelector(
        'form[action="/admin/birthdays/111111111111111111/edit"] label.kb-switch input[type=checkbox][role=switch][name=clear_year][value="1"]',
      ),
    ).not.toBeNull();
    expect(
      table?.querySelector(
        'form[action="/admin/birthdays/111111111111111111/edit"] select.kb-select[name=month]',
      ),
    ).not.toBeNull();
    const remove = table?.querySelector(
      'form[action="/admin/birthdays/111111111111111111/remove"]',
    );
    expect(remove?.getAttribute("data-confirm-list")).toContain(
      "The saved birthday is removed.",
    );
    expect(remove?.querySelector("button.kb-btn--danger")).not.toBeNull();
  });

  it("Birthdays reports an unreadable list as an error Callout and an empty one as an EmptyState", () => {
    const bad = mainOf(PAGES[7].html);
    const callout = bad.querySelector(
      ".kb-callout.kb-callout--err[role=alert]",
    );
    expect(callout?.textContent).toContain(
      "Stored birthdays could not be read.",
    );
    expect(bad.querySelector("table")).toBeNull();
    const empty = mainOf(PAGES[5].html);
    expect(empty.querySelector(".kb-empty .kb-empty__title")?.textContent).toBe(
      "No member has set a birthday yet.",
    );
    expect(
      empty.querySelector(".kb-empty .kb-empty__text")?.textContent,
    ).toContain("/me/birthday");
  });

  it("Birthdays preview is a KeyValue and keeps the mention as a chip", () => {
    const main = mainOf(PAGES[5].html);
    const kv = main.querySelector("dl.kb-kv");
    expect(kv).not.toBeNull();
    expect(kv?.querySelectorAll("dt")).toHaveLength(2);
    expect(kv?.querySelector(".kb-mention")?.textContent).toBe("@Admin");
  });

  it("Birthdays keeps Run now behind a neutral confirmation", () => {
    const main = mainOf(PAGES[5].html);
    const form = main.querySelector('form[action="/admin/birthdays/run-now"]');
    expect(form?.getAttribute("data-confirm")).toBe(
      "Run the birthday check now?",
    );
    expect(form?.getAttribute("data-confirm-tone")).toBe("neutral");
    const off = mainOf(PAGES[6].html);
    expect(
      off
        .querySelector('form[action="/admin/birthdays/run-now"] button')
        ?.hasAttribute("disabled"),
    ).toBe(true);
  });
});

describe("the row Edit disclosure sits under its record, not in the Actions cell (#1738)", () => {
  it.each(PAGES.filter((p) => p.name.includes("edit")))(
    "$name opens it in a full-width row spanning every column",
    ({ html }) => {
      const main = mainOf(html);
      const cols = main.querySelectorAll("thead th").length;
      const open = main.querySelectorAll(
        "tbody td[colspan] details.kb-disclosure[open]",
      );
      expect(open).toHaveLength(1);
      expect(open[0].closest("td")?.getAttribute("colspan")).toBe(String(cols));
      expect(main.querySelectorAll("td.kb-actions details")).toHaveLength(0);
      expect(
        main.querySelectorAll("td.kb-actions form").length,
      ).toBeGreaterThan(0);
    },
  );
});
