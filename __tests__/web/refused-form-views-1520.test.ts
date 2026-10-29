/* global Document, Element, HTMLInputElement, HTMLSelectElement, HTMLTextAreaElement */
/**
 * How a refused form is drawn on the Reaction roles, Notices, Quotes and
 * Presence pages (#1520): the shared FormView on each form, the per-row
 * disclosures that open on the row that was refused, and a page that was not
 * refused staying exactly as it was.
 */
import { describe, it, expect } from "@jest/globals";
import { JSDOM } from "jsdom";
import {
  renderBotStatusPage,
  renderNoticesPage,
  renderQuotesPage,
  renderReactionRolesPage,
} from "../../src/web/admin-views.js";
import type { RefusedForm } from "../../src/web/form-errors.js";
import {
  BOT_STATUS_POOLS,
  BOT_STATUS_POOL_META,
} from "../../src/content/statuses.js";

const BASE = {
  guildId: "g1",
  csrfToken: "csrf",
  remainingMs: 60_000,
  navFeatureStatus: {},
  enabled: true,
};

const reactionRoles = (refusedForm?: RefusedForm | null): string =>
  renderReactionRolesPage({
    ...BASE,
    configChannel: null,
    active: [],
    archived: [],
    refusedForm,
  });

const notices = (refusedForm?: RefusedForm | null): string =>
  renderNoticesPage({
    ...BASE,
    channel: null,
    total: 2,
    settingRows: [],
    textChannels: [],
    categoryOptions: [
      { value: "general", label: "General" },
      { value: "rules", label: "Rules" },
    ],
    groups: [
      {
        category: "general",
        rows: [0, 1].map((n) => ({
          id: `n${n}`,
          order: n,
          title: `Title ${n}`,
          content: `Text ${n}`,
          preview: `Text ${n}`,
          category: "general",
          messageId: "",
          updatedAt: "2026-01-01",
        })),
      },
    ],
    refusedForm,
  });

const quotes = (
  refusedForm?: RefusedForm | null,
  search = "",
  page = 1,
): string =>
  renderQuotesPage({
    ...BASE,
    channel: null,
    headerMessageId: "",
    settingRows: [],
    maxLength: 1000,
    rows: [0, 1].map((n) => ({
      id: `q${n}`,
      content: `Quote ${n}`,
      authorId: "111111111111111111",
      authorLabel: "Ada",
      addedByLabel: "Bo",
      addedAt: "2026-01-01",
      likes: 0,
      dislikes: 0,
      messageId: "",
    })),
    total: 60,
    page,
    pageSize: 25,
    search,
    refusedForm,
  });

const presence = (refusedForm?: RefusedForm | null): string =>
  renderBotStatusPage({
    ...BASE,
    maxLength: 128,
    pools: BOT_STATUS_POOLS.map((pool) => ({
      pool,
      label: BOT_STATUS_POOL_META[pool].label,
      description: BOT_STATUS_POOL_META[pool].description,
      requiresCount: BOT_STATUS_POOL_META[pool].requiresCount,
      items:
        pool === "single"
          ? [0, 1].map((n) => ({ id: `e${n}`, order: n, text: `Entry ${n}` }))
          : [],
      usingDefaults: pool !== "single",
      exportText: "stored one\nstored two",
    })),
    refusedForm,
  });

const doc = (html: string): Document => new JSDOM(html).window.document;
const OTHER: RefusedForm = {
  formId: "elsewhere",
  errors: { name: "x" },
  values: { name: "y" },
};

describe("a form that was not refused", () => {
  const pages: Array<[string, (r?: RefusedForm | null) => string]> = [
    ["Reaction roles", reactionRoles],
    ["Notices", notices],
    ["Quotes", (r) => quotes(r)],
    ["Presence", presence],
  ];

  it.each(pages)("%s renders no refusal markup", (_name, render) => {
    for (const html of [render(), render(null), render(OTHER)]) {
      expect(html).not.toMatch(/<(input|select|textarea)[^>]*aria-invalid/);
      expect(html).not.toContain('class="kb-field__error"');
      expect(html).not.toContain('class="helper edit-details" open');
      expect(html).not.toContain("<details open>");
    }
  });

  it.each(pages)(
    "%s is unchanged when the refused form belongs to another page's id",
    (_name, render) => {
      expect(render(OTHER)).toBe(render());
    },
  );
});

describe("the Reaction roles forms", () => {
  it("marks the refused create field and keeps the typed values and choices", () => {
    const d = doc(
      reactionRoles({
        formId: "reaction-role-create",
        errors: { name: "At most 100 characters." },
        values: {
          name: "<VIP>",
          emoji: "🎉",
          createChannel: "",
          mode: "sticky",
        },
      }),
    );
    const invalid = d.querySelectorAll('[aria-invalid="true"]');
    expect(invalid).toHaveLength(1);
    expect(invalid[0].getAttribute("name")).toBe("name");
    expect(invalid[0].getAttribute("aria-describedby")).toBe(
      "reaction-role-create-name-error",
    );
    expect(
      d.getElementById("reaction-role-create-name")?.getAttribute("value"),
    ).toBe("<VIP>");
    const form = d.querySelector('form[action="/admin/reaction-roles/create"]');
    expect(
      form?.querySelector<HTMLInputElement>("[name=createChannel]")?.checked,
    ).toBe(false);
    expect(form?.querySelector<HTMLSelectElement>("[name=mode]")?.value).toBe(
      "sticky",
    );
    // The other three forms are drawn as usual.
    expect(
      d.querySelector('form[action="/admin/reaction-roles/bind"] [id]'),
    ).toBeNull();
  });

  it("marks one option row of a group form and keeps every typed row", () => {
    const d = doc(
      reactionRoles({
        formId: "reaction-role-group-create",
        errors: {
          "roleName-1": "A role group needs at least two options.",
        },
        values: {
          groupName: "Colour",
          mode: "toggle",
          "roleName-0": "Red",
          "emoji-0": "🔴",
          "roleName-1": "",
          "emoji-1": "",
        },
      }),
    );
    const invalid = d.querySelectorAll('[aria-invalid="true"]');
    expect(invalid).toHaveLength(1);
    expect(invalid[0].id).toBe("reaction-role-group-create-roleName-1");
    const form = d.querySelector(
      'form[action="/admin/reaction-roles/group/create"]',
    );
    expect(
      form?.querySelectorAll<HTMLInputElement>("[name=roleName]")[0].value,
    ).toBe("Red");
    expect(form?.querySelector<HTMLSelectElement>("[name=mode]")?.value).toBe(
      "toggle",
    );
    // Nothing typed in the folded rows: they stay folded.
    expect(form?.querySelector("details")?.hasAttribute("open")).toBe(false);
  });

  it("opens the folded rows when a refused form typed into one", () => {
    const d = doc(
      reactionRoles({
        formId: "reaction-role-group-generate",
        errors: { groupName: "Enter a name for the custom group." },
        values: { preset: "custom", "emoji-10": "🎮" },
      }),
    );
    const form = d.querySelector(
      'form[action="/admin/reaction-roles/group/generate"]',
    );
    expect(form?.querySelector("details")?.hasAttribute("open")).toBe(true);
    expect(form?.querySelector<HTMLSelectElement>("[name=preset]")?.value).toBe(
      "custom",
    );
  });
});

describe("the per-row edit forms", () => {
  it("opens only the Notices row that was refused, holding its typed values", () => {
    const d = doc(
      notices({
        formId: "notice-edit-n1",
        errors: { title: "Enter a title." },
        values: { title: "", content: "New", category: "rules" },
      }),
    );
    const open = d.querySelectorAll("details.edit-details[open]");
    expect(open).toHaveLength(1);
    expect(open[0].querySelector("form")?.getAttribute("action")).toBe(
      "/admin/notices/n1/update",
    );
    expect(
      open[0].querySelector<HTMLSelectElement>("[name=category]")?.value,
    ).toBe("rules");
    // Order is not a field any more (#1540).
    expect(open[0].querySelector("[name=order]")).toBeNull();
    const other = d.querySelector(
      'form[action="/admin/notices/n0/update"] [name=title]',
    ) as HTMLInputElement;
    expect(other.value).toBe("Title 0");
  });

  it("opens only the Quotes row that was refused", () => {
    const d = doc(
      quotes({
        formId: "quote-edit-q1",
        errors: {
          author_id:
            "Enter the Discord user ID of the author: 17 to 20 digits.",
        },
        values: { content: "Edited", author_id: "bob" },
      }),
    );
    const open = d.querySelectorAll("details.edit-details[open]");
    expect(open).toHaveLength(1);
    expect(
      open[0].querySelector<HTMLInputElement>("[name=author_id]")?.value,
    ).toBe("bob");
    expect(
      open[0].querySelector<HTMLTextAreaElement>("[name=content]")?.value,
    ).toBe("Edited");
  });

  it("carries the page and the search in the Quotes edit action, escaped", () => {
    const d = doc(quotes(null, "a&b", 2));
    const action = d
      .querySelector('form[action^="/admin/quotes/q0/edit"]')
      ?.getAttribute("action");
    expect(action).toBe("/admin/quotes/q0/edit?q=a%26b&page=2");
    expect(quotes(null)).toContain('action="/admin/quotes/q0/edit"');
  });

  it("opens only the Presence entry that was refused", () => {
    const d = doc(
      presence({
        formId: "bot-status-edit-e0",
        errors: { text: "Enter the status text." },
        values: { text: "" },
      }),
    );
    const open = d.querySelectorAll("details.edit-details[open]");
    expect(open).toHaveLength(1);
    expect(open[0].querySelector("form")?.getAttribute("action")).toBe(
      "/admin/bot-status/entry/e0/update",
    );
  });
});

describe("the Presence add and import forms", () => {
  it("marks only the refused pool's add form", () => {
    const d = doc(
      presence({
        formId: "bot-status-add-multiple",
        errors: { text: "This pool needs the {count} placeholder." },
        values: { text: "people" },
      }),
    );
    const invalid = d.querySelectorAll('[aria-invalid="true"]');
    expect(invalid).toHaveLength(1);
    expect(invalid[0].id).toBe("bot-status-add-multiple-text");
    // Order is not a field any more (#1540).
    expect(d.querySelector("[name=order]")).toBeNull();
  });

  it("opens the Import / export section of the refused pool, with the typed list", () => {
    const d = doc(
      presence({
        formId: "bot-status-import-lonely",
        errors: { items: "Paste at least one entry." },
        values: { items: "pasted", mode: "append" },
      }),
    );
    const form = d.querySelector(
      'form[action="/admin/bot-status/pool/lonely/import"]',
    ) as Element;
    expect(form.closest("details")?.hasAttribute("open")).toBe(true);
    expect(form.querySelector<HTMLTextAreaElement>("[name=items]")?.value).toBe(
      "pasted",
    );
    expect(
      form.querySelector<HTMLInputElement>("[value=append]")?.checked,
    ).toBe(true);
    // The other pools' import sections stay closed.
    const other = d.querySelector(
      'form[action="/admin/bot-status/pool/single/import"]',
    ) as Element;
    expect(other.closest("details")?.hasAttribute("open")).toBe(false);
  });
});

describe("element ids on a refused page", () => {
  it.each([
    [
      "Reaction roles",
      reactionRoles({
        formId: "reaction-role-group-create",
        errors: { "roleName-0": "x" },
        values: { "roleName-0": "a" },
      }),
    ],
    [
      "Notices",
      notices({ formId: "notice-edit-n0", errors: { title: "x" }, values: {} }),
    ],
    [
      "Quotes",
      quotes({ formId: "quote-edit-q0", errors: { content: "x" }, values: {} }),
    ],
    [
      "Presence",
      presence({
        formId: "bot-status-add-lonely",
        errors: { text: "x" },
        values: {},
      }),
    ],
  ])("%s has no duplicate ids", (_name, html) => {
    const ids = Array.from(doc(html).querySelectorAll("[id]")).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
