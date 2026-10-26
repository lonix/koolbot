/* global Element, Document, Window, HTMLElement, HTMLFormElement, HTMLInputElement, HTMLTextAreaElement, HTMLSelectElement */
/**
 * How a refused form is drawn (#1517): the shared FormView on the Announcements
 * and Polls pages, the flash roles, and the on-load focus.
 */
import { describe, it, expect } from "@jest/globals";
import { JSDOM, VirtualConsole } from "jsdom";
import {
  renderAnnouncementsPage,
  renderFlash,
  renderPollsPage,
  renderSettingsPage,
} from "../../src/web/admin-views.js";
import type { RefusedForm } from "../../src/web/form-errors.js";

const BASE = {
  guildId: "g1",
  csrfToken: "csrf",
  remainingMs: 60_000,
  navFeatureStatus: {},
  enabled: true,
  settingRows: [],
  textChannels: [
    { id: "c1", name: "general", type: 0 },
    { id: "c2", name: "random", type: 0 },
  ],
};

const announcements = (
  refusedForm?: RefusedForm | null,
  flash?: { type: "ok" | "warn" | "err"; text: string },
): string => renderAnnouncementsPage({ ...BASE, rows: [], refusedForm, flash });

const polls = (refusedForm?: RefusedForm | null): string =>
  renderPollsPage({
    ...BASE,
    defaultDurationHours: 24,
    cooldownDays: 7,
    roles: [],
    schedules: [0, 1].map((n) => ({
      id: `s${n}`,
      channelId: "c1",
      channelName: "general",
      channelType: 0,
      cron: "0 12 * * 5",
      durationHours: 24,
      pingRoleId: null,
      pingRoleName: null,
      enabled: true,
      lastRun: "—",
    })),
    items: [0, 1].map((n) => ({
      id: `i${n}`,
      question: `Q${n}?`,
      answers: ["Yes", "No"],
      tags: [],
      multiSelect: false,
      usageCount: 0,
      lastUsed: "—",
      enabled: true,
      source: "manual",
    })),
    refusedForm,
  });

describe("a form that was not refused", () => {
  it("renders no refusal markup on either page", () => {
    for (const html of [announcements(), polls(), polls(null)]) {
      // The layout's stylesheet names the attribute; no control carries it.
      expect(html).not.toMatch(/<(input|select|textarea)[^>]*aria-invalid/);
      expect(html).not.toContain('class="kb-field__error"');
      expect(html).not.toContain('class="helper edit-details" open');
    }
  });

  it("is unchanged when the refused form belongs to another page's id", () => {
    const other: RefusedForm = {
      formId: "elsewhere",
      errors: { cron: "x" },
      values: { cron: "y" },
    };
    expect(announcements(other)).toBe(announcements());
    expect(polls(other)).toBe(polls());
  });
});

describe("a refused Announcements form", () => {
  const refused: RefusedForm = {
    formId: "announcement-create",
    errors: { cron: "Use five fields." },
    values: { channelId: "c2", cron: "<x>", message: "Hello & bye" },
  };
  const html = announcements(refused);
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  it("marks only the refused field, linked to its error line", () => {
    const invalid = doc.querySelectorAll('[aria-invalid="true"]');
    expect(invalid).toHaveLength(1);
    const cron = invalid[0];
    expect(cron.getAttribute("name")).toBe("cron");
    expect(cron.getAttribute("aria-describedby")).toBe(
      "announcement-create-cron-error",
    );
    const line = doc.getElementById("announcement-create-cron-error");
    expect(line?.tagName).toBe("P");
    expect(line?.className).toBe("kb-field__error");
    expect(line?.textContent).toBe("Use five fields.");
    expect(line?.hasAttribute("role")).toBe(false);
  });

  it("keeps the typed values in that form only", () => {
    const forms = doc.querySelectorAll("form.stack");
    const create = Array.from(forms).find((f) =>
      f.getAttribute("action")?.endsWith("/announcements/create"),
    ) as Element;
    const once = Array.from(forms).find((f) =>
      f.getAttribute("action")?.endsWith("/announcements/post-once"),
    ) as Element;
    expect(create.querySelector<HTMLInputElement>("[name=cron]")?.value).toBe(
      "<x>",
    );
    expect(
      create.querySelector<HTMLTextAreaElement>("[name=message]")?.value,
    ).toBe("Hello & bye");
    expect(
      create.querySelector<HTMLSelectElement>("[name=channelId]")?.value,
    ).toBe("c2");
    expect(
      once.querySelector<HTMLTextAreaElement>("[name=message]")?.value,
    ).toBe("");
  });

  it("gives the labels' controls ids that are unique on the page", () => {
    const ids = Array.from(doc.querySelectorAll("[id]")).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("a refused Polls edit form", () => {
  it("opens only the row that was refused", () => {
    const html = polls({
      formId: "poll-item-edit-i1",
      errors: { answers: "Give 2 to 10 answers, separated by commas." },
      values: {
        question: "Q1?",
        answers: "only one",
        tags: "",
        multiSelect: "",
      },
    });
    const doc = new JSDOM(html).window.document;
    const open = Array.from(doc.querySelectorAll("details.edit-details")).map(
      (d) => d.hasAttribute("open"),
    );
    // Two schedule rows, then two question rows: only the second question.
    expect(open).toEqual([false, false, false, true]);
    expect(
      doc.querySelector('[aria-invalid="true"]')?.getAttribute("name"),
    ).toBe("answers");
    expect(
      doc.querySelector<HTMLInputElement>("#poll-item-edit-i1-answers")?.value,
    ).toBe("only one");
    // The same field in the other row keeps its stored value, unmarked.
    expect(
      doc.querySelector<HTMLInputElement>(
        'form[action$="/items/i0/edit"] [name=answers]',
      )?.value,
    ).toBe("Yes, No");
  });
});

describe("flash roles", () => {
  it.each([
    ["err", "alert"],
    ["ok", "status"],
    ["warn", "status"],
  ] as const)("a %s flash is role=%s", (type, role) => {
    expect(renderFlash({ type, text: "x" })).toContain(
      `role="${role}" tabindex="-1" data-flash`,
    );
  });
});

describe("focus on load", () => {
  const focused = (html: string): string => {
    const vc = new VirtualConsole();
    const dom = new JSDOM(html, {
      runScripts: "dangerously",
      virtualConsole: vc,
    });
    const el = dom.window.document.activeElement;
    return el?.id || el?.getAttribute("data-flash") !== null
      ? `${el?.tagName}#${el?.id}${el?.hasAttribute("data-flash") ? "[flash]" : ""}`
      : "";
  };

  it("moves to the first refused field, not to the failure flash", () => {
    const refused: RefusedForm = {
      formId: "announcement-create",
      errors: { cron: "a", message: "b" },
      values: {},
    };
    expect(
      focused(announcements(refused, { type: "err", text: "Not saved." })),
    ).toBe("INPUT#announcement-create-cron");
  });

  it("moves to a failure flash when no field is marked", () => {
    expect(
      focused(announcements(null, { type: "err", text: "Not saved." })),
    ).toBe("DIV#[flash]");
  });
});

describe("All settings: the reason under a rejected row (#1517)", () => {
  const GROUPS = [
    {
      category: "x",
      rows: [
        {
          key: "x.count",
          label: "Count",
          current: 2,
          defaultValue: 10,
          type: "number" as const,
          description: "How many.",
          category: "x",
        },
        {
          key: "x.other",
          label: "Other",
          current: 3,
          defaultValue: 10,
          type: "number" as const,
          description: "Another.",
          category: "x",
        },
      ],
    },
  ];
  const page = (): string =>
    renderSettingsPage({
      csrfToken: "csrf",
      remainingMs: 60_000,
      navFeatureStatus: {},
      groups: GROUPS,
    });

  const flush = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 20));

  async function save(reply: unknown): Promise<Document> {
    const vc = new VirtualConsole();
    const dom = new JSDOM(page(), {
      runScripts: "dangerously",
      pretendToBeVisual: true,
      virtualConsole: vc,
    });
    const win = dom.window as unknown as Window & {
      fetch: unknown;
      HTMLFormElement: typeof HTMLFormElement;
    };
    win.fetch = async () => ({
      status: 200,
      ok: true,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify(reply),
      json: async () => reply,
    });
    // The script is already installed at the end of the body; submit the form.
    const form = dom.window.document.querySelector(
      'form[action="/admin/settings/save-section"]',
    ) as HTMLFormElement;
    form.dispatchEvent(
      new dom.window.Event("submit", { bubbles: true, cancelable: true }),
    );
    await flush();
    return dom.window.document;
  }

  it("prints each rejected key's own reason, as text, and links it from the control", async () => {
    const doc = await save({
      type: "err",
      text: "No changes saved.",
      invalidKeys: ["x.count"],
      invalidReasons: { "x.count": "At most 240 minutes. <b>no</b>" },
    });
    const note = doc.getElementById("set-x.count-err");
    expect(note?.tagName).toBe("P");
    expect(note?.className).toBe("kb-field__error settings-error");
    expect(note?.textContent).toBe("At most 240 minutes. <b>no</b>");
    expect(note?.querySelector("b")).toBeNull();
    const control = doc.getElementById("set-x.count") as HTMLElement;
    expect(control.getAttribute("aria-invalid")).toBe("true");
    expect(control.getAttribute("aria-describedby")).toContain(
      "set-x.count-err",
    );
    // The row is not marked or described for a key that was not rejected.
    expect(doc.getElementById("set-x.other-err")).toBeNull();
    // A failure is announced as an alert.
    const flash = doc.querySelector(".section-flash");
    expect(flash?.getAttribute("role")).toBe("alert");
    expect(flash?.hasAttribute("aria-live")).toBe(false);
  });

  it("falls back to the generic line for a key without a reason", async () => {
    const doc = await save({
      type: "err",
      text: "No changes saved.",
      invalidKeys: ["x.count"],
    });
    expect(doc.getElementById("set-x.count-err")?.textContent).toMatch(
      /^Rejected — not saved\./,
    );
  });

  it("clears the reason once a later save is accepted", async () => {
    const vc = new VirtualConsole();
    const dom = new JSDOM(page(), {
      runScripts: "dangerously",
      pretendToBeVisual: true,
      virtualConsole: vc,
    });
    const replies = [
      {
        type: "err",
        text: "No.",
        invalidKeys: ["x.count"],
        invalidReasons: { "x.count": "Too big." },
      },
      { type: "ok", text: "Saved 2 settings in x.", invalidKeys: [] },
    ];
    (dom.window as unknown as { fetch: unknown }).fetch = async () => {
      const reply = replies.shift();
      return {
        status: 200,
        ok: true,
        headers: { get: () => "application/json" },
        text: async () => JSON.stringify(reply),
      };
    };
    const form = dom.window.document.querySelector(
      'form[action="/admin/settings/save-section"]',
    ) as HTMLFormElement;
    for (let i = 0; i < 2; i++) {
      form.dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true }),
      );
      await flush();
    }
    const doc = dom.window.document;
    expect(doc.getElementById("set-x.count-err")).toBeNull();
    expect(
      doc.getElementById("set-x.count")?.hasAttribute("aria-invalid"),
    ).toBe(false);
    expect(doc.querySelector(".section-flash")?.getAttribute("role")).toBe(
      "status",
    );
  });
});
