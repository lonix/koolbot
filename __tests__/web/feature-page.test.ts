/**
 * @jest-environment <rootDir>/__tests__/jsdom-node-env.cjs
 */

/* global document, window, Event, DOMParser, HTMLDetailsElement, HTMLElement, HTMLInputElement, Storage, localStorage, Document */
/**
 * Feature pages show the usable part first and fold their settings (#1301):
 * the status line, the folded settings card (when it opens, what its summary
 * counts, where a save's flash goes), the script that remembers the fold, the
 * Events page's list and form, and the redirect flag that reopens the fold.
 * Markup is checked through a DOM, never with regular expressions over HTML.
 */

import { ChannelType } from "discord.js";
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { readFileSync } from "node:fs";
import {
  renderEventsPage,
  renderTicketsPage,
  renderFeatureSettingsCard,
  renderPageFlash,
  type EventRow,
  type EventsProps,
  type SettingRow,
} from "../../src/web/admin-views.js";
import {
  renderStatusLine,
  SETTINGS_FOLD_SCRIPT,
  settingHref,
} from "../../src/web/feature-page.js";
import { readFlash } from "../../src/web/read-only-routes.js";
import { signFlash } from "../../src/web/http-flash.js";
import { adminPages } from "./a11y-pages.js";

function row(
  over: Partial<SettingRow> & Pick<SettingRow, "key" | "type">,
): SettingRow {
  return {
    label: over.key,
    current: "",
    defaultValue: "",
    description: "",
    category: over.key.split(".")[0],
    ...over,
  };
}

const ROWS: SettingRow[] = [
  row({
    key: "x.enabled",
    type: "boolean",
    current: true,
    defaultValue: false,
  }),
  row({ key: "x.size", type: "number", current: 10, defaultValue: 10 }),
  row({ key: "x.name", type: "string", current: "a", defaultValue: "a" }),
];

type CardProps = Parameters<typeof renderFeatureSettingsCard>[0];

function card(over: Partial<CardProps> = {}): string {
  return renderFeatureSettingsCard({
    category: "x",
    settingRows: ROWS,
    returnTo: "/admin/x",
    csrfToken: "tok",
    ...over,
  });
}

function mount(html: string): void {
  document.body.innerHTML = html;
}

function fold(): HTMLDetailsElement {
  const d = document.querySelector<HTMLDetailsElement>(
    "details[data-settings-fold]",
  );
  if (!d) throw new Error("no settings fold");
  return d;
}

const summaryText = (): string =>
  document.querySelector("details[data-settings-fold] > summary")
    ?.textContent ?? "";

describe("the status line", () => {
  it("opens with an On or Off badge, in words as well as colour", () => {
    mount(renderStatusLine({ enabled: true, chips: [] }));
    expect(document.querySelector(".kb-badge--on")?.textContent).toBe("On");
    mount(renderStatusLine({ enabled: false, chips: [] }));
    expect(document.querySelector(".kb-badge--off")?.textContent).toBe("Off");
    mount(
      renderStatusLine({
        enabled: false,
        offLabel: "Logging off",
        chips: [],
      }),
    );
    expect(document.querySelector(".kb-badge--off")?.textContent).toBe(
      "Logging off",
    );
  });

  it("is one labelled group of chips", () => {
    mount(
      renderStatusLine({
        enabled: true,
        chips: [{ text: "3 schedules" }, { text: "0 9 * * 1", mono: true }],
      }),
    );
    const line = document.querySelector(".kb-statusline");
    expect(line?.getAttribute("role")).toBe("group");
    expect(line?.getAttribute("aria-label")).toBe("Status");
    const chips = [...document.querySelectorAll(".kb-chip")];
    expect(chips.map((c) => c.textContent)).toEqual([
      "3 schedules",
      "0 9 * * 1",
    ]);
    expect(chips[1].querySelector(".kb-mono")).not.toBeNull();
  });

  it("makes a warning a link with an icon, so it is not colour alone", () => {
    mount(
      renderStatusLine({
        enabled: true,
        chips: [
          {
            text: "No channel set",
            warn: true,
            href: settingHref("quotes.channel_id"),
          },
        ],
      }),
    );
    const a = document.querySelector("a.kb-chip--warn");
    expect(a?.getAttribute("href")).toBe("#set-quotes.channel_id");
    expect(a?.querySelector("svg.kb-icon")).not.toBeNull();
    expect(a?.textContent).toBe("No channel set");
  });

  it("renders a warning without a target as plain text, never an empty link", () => {
    mount(
      renderStatusLine({
        enabled: true,
        chips: [{ text: "Category not found", warn: true }],
      }),
    );
    expect(document.querySelector("a")).toBeNull();
    expect(document.querySelector("span.kb-chip--warn")).not.toBeNull();
  });

  it("escapes what it is given", () => {
    mount(
      renderStatusLine({
        enabled: true,
        chips: [{ text: "<img src=x onerror=1>", href: '"><b>' }],
      }),
    );
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("b")).toBeNull();
  });
});

describe("the folded settings card", () => {
  it("is closed when the feature is on and configured, and says what is inside", () => {
    mount(card({ enabled: true }));
    const d = fold();
    expect(d.open).toBe(false);
    expect(d.hasAttribute("data-fold-forced")).toBe(false);
    expect(summaryText()).toContain("Settings");
    expect(
      document.querySelector("summary .kb-badge--count")?.textContent,
    ).toBe("3");
    // The form is still in the page, inside the fold, with its save bar.
    expect(d.querySelector("form[action$='save-section']")).not.toBeNull();
    expect(d.querySelector("[data-savebar]")).not.toBeNull();
  });

  it("keeps the .card that the AJAX save looks for around the form", () => {
    mount(card());
    const form = document.querySelector("form[action$='save-section']");
    expect(form?.closest(".card")?.classList.contains("card--savebar")).toBe(
      true,
    );
    expect(fold().closest(".card")).not.toBeNull();
  });

  it("opens when the page says the feature is off", () => {
    mount(card({ enabled: false }));
    expect(fold().open).toBe(true);
    expect(fold().hasAttribute("data-fold-forced")).toBe(true);
  });

  it("opens when its own enable row is off, with no page flag", () => {
    mount(
      card({
        settingRows: [
          row({
            key: "x.enabled",
            type: "boolean",
            current: false,
            defaultValue: false,
          }),
          ROWS[1],
        ],
      }),
    );
    expect(fold().open).toBe(true);
  });

  it("opens when a required setting is missing", () => {
    mount(card({ enabled: true, needsSetup: true }));
    expect(fold().open).toBe(true);
    expect(fold().hasAttribute("data-fold-forced")).toBe(true);
  });

  it("stays closed when only needsSetup is explicitly false", () => {
    mount(card({ enabled: true, needsSetup: false }));
    expect(fold().open).toBe(false);
  });

  it("opens after a save and shows the flash inside, once", () => {
    const html = card({
      enabled: true,
      flash: { type: "ok", text: "Saved 2 settings in x.", openSettings: true },
    });
    mount(html);
    expect(fold().open).toBe(true);
    const flashes = document.querySelectorAll("[data-flash]");
    expect(flashes).toHaveLength(1);
    expect(flashes[0].textContent).toBe("Saved 2 settings in x.");
    expect(fold().contains(flashes[0])).toBe(true);
  });

  it("does not take a flash that belongs to something else on the page", () => {
    mount(
      card({
        enabled: true,
        flash: { type: "ok", text: "Quote added." },
      }),
    );
    expect(fold().open).toBe(false);
    expect(document.querySelector("[data-flash]")).toBeNull();
  });

  it("leaves the page-level flash out when it belongs to the settings", () => {
    expect(
      renderPageFlash({ type: "ok", text: "Saved.", openSettings: true }),
    ).toBe("");
    expect(renderPageFlash({ type: "ok", text: "Quote added." })).toContain(
      "Quote added.",
    );
    expect(renderPageFlash(null)).toBe("");
  });

  it("still shows a settings flash when the card has no form to put it in", () => {
    const flash = { type: "err", text: "Nope.", openSettings: true } as const;
    expect(card({ settingRows: [], flash })).toContain("Nope.");
    const unavailable = card({ unavailable: true, flash });
    expect(unavailable).toContain("Nope.");
    expect(unavailable).toContain("Settings could not be loaded");
    expect(unavailable).not.toContain("<details");
    expect(card({ settingRows: [] })).toBe("");
  });

  it("counts the settings that differ from the default in the summary", () => {
    mount(
      card({
        settingRows: [
          row({ key: "x.a", type: "number", current: 5, defaultValue: 1 }),
          row({ key: "x.b", type: "number", current: 2, defaultValue: 2 }),
          row({ key: "x.c", type: "string", current: "z", defaultValue: "" }),
        ],
      }),
    );
    expect(summaryText()).toContain("2 changed from the default");
    mount(card({ settingRows: [ROWS[1], ROWS[2]] }));
    expect(summaryText()).not.toContain("changed from the default");
  });

  it("does not count a row whose dependency lives on another form", () => {
    // digest.enabled waits for voicetracking.enabled, which is not on this card.
    const rows = [
      row({
        key: "digest.enabled",
        type: "boolean",
        current: true,
        defaultValue: false,
      }),
    ];
    mount(
      card({
        category: "digest",
        settingRows: rows,
        dependencyState: new Map([["voicetracking.enabled", false]]),
      }),
    );
    expect(summaryText()).not.toContain("changed from the default");
    mount(
      card({
        category: "digest",
        settingRows: rows,
        dependencyState: new Map([["voicetracking.enabled", true]]),
      }),
    );
    expect(summaryText()).toContain("1 changed from the default");
  });

  it("uses the card title in the summary", () => {
    mount(card({ title: "Digest settings" }));
    expect(summaryText()).toContain("Digest settings");
  });

  it("keys the remembered state to the page it is on", () => {
    mount(card({ returnTo: "/admin/quotes" }));
    expect(fold().getAttribute("data-fold-key")).toBe("/admin/quotes");
  });
});

describe("the fold script", () => {
  beforeEach(() => {
    localStorage.clear();
    window.location.hash = "";
    jest.restoreAllMocks();
  });

  function run(): void {
    new Function(SETTINGS_FOLD_SCRIPT)();
  }

  /** What a click on the summary does: the browser flips `open` after it. */
  async function userToggle(): Promise<void> {
    const d = fold();
    d.querySelector("summary")?.dispatchEvent(
      new Event("click", { bubbles: true }),
    );
    d.open = !d.open;
    await new Promise((r) => setTimeout(r, 0));
  }

  it("opens a fold the admin left open on this page", () => {
    localStorage.setItem("kb-settings-open:/admin/x", "1");
    mount(card({ enabled: true }));
    run();
    expect(fold().open).toBe(true);
  });

  it("does not open a fold another page left open", () => {
    localStorage.setItem("kb-settings-open:/admin/other", "1");
    mount(card({ enabled: true }));
    run();
    expect(fold().open).toBe(false);
  });

  it("remembers a choice made by clicking the summary, both ways", async () => {
    mount(card({ enabled: true }));
    run();
    await userToggle();
    expect(localStorage.getItem("kb-settings-open:/admin/x")).toBe("1");
    await userToggle();
    expect(localStorage.getItem("kb-settings-open:/admin/x")).toBe("0");
  });

  it("does not take the fold's own opening as the admin's choice", async () => {
    // Opened by the script (a remembered state) or by a link to a control.
    localStorage.setItem("kb-settings-open:/admin/x", "1");
    mount(card({ enabled: true }));
    run();
    await new Promise((r) => setTimeout(r, 0));
    localStorage.clear();
    fold().open = false;
    await new Promise((r) => setTimeout(r, 0));
    fold().open = true;
    await new Promise((r) => setTimeout(r, 0));
    expect(localStorage.getItem("kb-settings-open:/admin/x")).toBeNull();
  });

  it("never stores a setup visit as a choice, so the fold can close once configured", async () => {
    mount(card({ enabled: false }));
    run();
    await new Promise((r) => setTimeout(r, 0));
    expect(localStorage.getItem("kb-settings-open:/admin/x")).toBeNull();
  });

  it("keeps a forced-open fold open whatever was remembered", () => {
    localStorage.setItem("kb-settings-open:/admin/x", "0");
    mount(card({ enabled: false }));
    run();
    expect(fold().open).toBe(true);
  });

  it("works when storage throws", async () => {
    jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    mount(card({ enabled: true }));
    expect(() => run()).not.toThrow();
    expect(fold().open).toBe(false);
    await expect(userToggle()).resolves.toBeUndefined();
    expect(fold().open).toBe(true);
  });

  it("drops the changed-from-default count once a save is accepted, since it is stale", () => {
    mount(
      card({
        settingRows: [
          row({ key: "x.a", type: "number", current: 5, defaultValue: 1 }),
        ],
      }),
    );
    run();
    expect(summaryText()).toContain("1 changed from the default");
    // An edit that has not been saved leaves the loaded count alone.
    document
      .querySelector("form")
      ?.dispatchEvent(new Event("input", { bubbles: true }));
    expect(summaryText()).toContain("1 changed from the default");
    document
      .querySelector("form[action$='save-section']")
      ?.dispatchEvent(new Event("kb-saved"));
    expect(summaryText()).not.toContain("changed from the default");
    expect(summaryText()).toContain("Settings");
  });

  it("works for a card with no count to drop", () => {
    mount(card({ settingRows: [ROWS[1]] }));
    expect(() => run()).not.toThrow();
  });

  it("opens the fold for a link to a control inside it", () => {
    mount(card({ enabled: true }));
    window.location.hash = "#set-x.size";
    run();
    expect(fold().open).toBe(true);
  });

  it("ignores a hash that points elsewhere, or at nothing", () => {
    mount(`${card({ enabled: true })}<p id="elsewhere"></p>`);
    window.location.hash = "#elsewhere";
    run();
    expect(fold().open).toBe(false);
    window.location.hash = "#%E0%A4%A";
    expect(() => run()).not.toThrow();
  });

  it("has a control to land on: the row ids are the ones the chips link to", () => {
    mount(card({ enabled: true }));
    expect(document.getElementById("set-x.size")).not.toBeNull();
    expect(
      document.querySelector(`a[href="${settingHref("x.size")}"]`),
    ).toBeNull();
  });
});

describe("the redirect flag that reopens the fold", () => {
  it("reads it next to a signed flash", () => {
    process.env.WEBUI_SESSION_SECRET = "test-secret-for-feature-page-flash-01";
    const msg = "Saved 2 settings in polls.";
    const query = {
      flash: "ok",
      msg,
      sig: signFlash("ok", msg),
    };
    expect(readFlash({ query: { ...query, settings: "open" } })).toEqual({
      type: "ok",
      text: msg,
      openSettings: true,
    });
    expect(readFlash({ query })).toEqual({ type: "ok", text: msg });
    // Any other value opens nothing.
    expect(readFlash({ query: { ...query, settings: "1" } })).toEqual({
      type: "ok",
      text: msg,
    });
  });

  it("does not make a flash out of the flag alone, or a forged one", () => {
    process.env.WEBUI_SESSION_SECRET = "test-secret-for-feature-page-flash-01";
    expect(readFlash({ query: { settings: "open" } })).toBeNull();
    expect(
      readFlash({
        query: { flash: "ok", msg: "Forged.", sig: "nope", settings: "open" },
      }),
    ).toBeNull();
  });
});

describe("every feature page", () => {
  const TITLES = [
    "Announcements",
    "Events",
    "Polls",
    "Reaction Roles",
    "Notices",
    "Quotes",
    "Birthdays",
    "Voice Channels",
    "Weekly Digest",
    "Leaderboard Roles",
    "Command audit",
    "Moderation log",
    "Support tickets",
    "Command metrics",
  ];
  const parse = (html: string): Document =>
    new DOMParser().parseFromString(html, "text/html");
  const withFold = adminPages().filter((p) =>
    p.html.includes("data-settings-fold"),
  );

  it("is covered by a fixture for each of the 14 pages that share the card", () => {
    const titles = new Set(
      withFold.map((p) =>
        (parse(p.html).title ?? "").replace(/ — Koolbot Admin$/, ""),
      ),
    );
    expect([...titles].sort()).toEqual([...TITLES].sort());
  });

  it("puts the status line first and the folded settings last", () => {
    for (const p of withFold) {
      const doc = parse(p.html);
      const main = doc.querySelector("main") as HTMLElement;
      const html = main.innerHTML;
      const status = html.indexOf('class="kb-statusline"');
      const settings = html.indexOf('id="feature-settings"');
      expect(status).toBeGreaterThan(-1);
      expect(settings).toBeGreaterThan(status);
      // Nothing the admin came for sits below the settings: no further card
      // or heading follows the fold (page scripts only).
      const after = html.slice(html.indexOf("</details>", settings));
      expect(after).not.toMatch(/<h[12][ >]/);
      expect(after).not.toContain('class="card');
      // No legacy Status card is left in front of it.
      expect(html.slice(0, settings)).not.toContain("<h2>Status</h2>");
      expect(html.slice(0, settings)).not.toContain("<h2>Overview</h2>");
    }
  });

  it("folds the settings unless the fixture is off, unset or just saved", () => {
    for (const p of withFold) {
      const d = parse(p.html).querySelector("details[data-settings-fold]");
      expect(d?.hasAttribute("open")).toBe(d?.hasAttribute("data-fold-forced"));
    }
  });

  it("hands its flash to the card and keeps it off the top when it is the card's", () => {
    // A page that forgot either half would lose the message of a settings save.
    const src = readFileSync("src/web/admin-views.ts", "utf8");
    const pages = [
      "Announcements",
      "Events",
      "Polls",
      "ReactionRoles",
      "Notices",
      "Quotes",
      "Birthdays",
      "VoiceChannels",
      "Digest",
      "LeaderboardRoles",
      "CommandAudit",
      "Moderation",
      "Tickets",
      "CommandMetrics",
    ];
    for (const name of pages) {
      const start = src.indexOf(`export function render${name}Page(`);
      expect(start).toBeGreaterThan(-1);
      const end = src.indexOf("\nexport function ", start + 10);
      const body = src.slice(start, end === -1 ? undefined : end);
      expect(body).toContain("renderPageFlash(props.flash)");
      expect(body).not.toContain("${renderFlash(props.flash)}");
      expect(body).toContain("flash: props.flash");
    }
  });
});

const FEATURE_ROWS: SettingRow[] = [
  row({
    key: "events.enabled",
    type: "boolean",
    current: true,
    defaultValue: false,
  }),
  row({
    key: "events.category_id",
    type: "category",
    current: "cat1",
    defaultValue: "",
  }),
  row({
    key: "events.announcement_channel_id",
    type: "channel",
    current: "c1",
    defaultValue: "",
  }),
];

function eventRow(over: Partial<EventRow> = {}): EventRow {
  return {
    id: "0123456789abcdef01234567",
    title: "Game night",
    when: "2099-02-01 20:00",
    state: "scheduled",
    channelId: null,
    ...over,
  };
}

function eventsPage(
  rows: EventRow[],
  over: Partial<EventsProps> = {},
): Document {
  const html = renderEventsPage({
    csrfToken: "tok",
    remainingMs: 60_000,
    enabled: true,
    categoryConfigured: true,
    announcementConfigured: true,
    timezone: "Europe/Oslo",
    rows,
    settingRows: FEATURE_ROWS,
    settingsPickers: {
      textChannels: [{ id: "c1", name: "events", type: ChannelType.GuildText }],
      categoryChannels: [
        { id: "cat1", name: "Events", type: ChannelType.GuildCategory },
      ],
    },
    ...over,
  });
  return new DOMParser().parseFromString(html, "text/html");
}

const headers = (doc: Document, scope: string): string[] =>
  [...doc.querySelectorAll(`${scope} table thead th`)].map(
    (th) => th.textContent ?? "",
  );

describe("the Events page", () => {
  it("offers Schedule event at the top, as a link to the form", () => {
    const doc = eventsPage([eventRow()]);
    const link = doc.querySelector<HTMLElement>('a[href="#schedule-event"]');
    expect(link?.textContent).toBe("Schedule event");
    // Not primary: the form's own submit is the view's one primary button.
    expect(link?.className).toBe("kb-btn");
    const form = doc.getElementById("schedule-event");
    expect(form?.querySelector("form[data-event-form]")).not.toBeNull();
    // The link sits before the list, the form after it.
    const order = [link, doc.querySelector("table"), form];
    for (let i = 1; i < order.length; i++) {
      expect(
        order[i - 1]!.compareDocumentPosition(order[i]!) &
          4 /* DOCUMENT_POSITION_FOLLOWING */,
      ).toBeTruthy();
    }
  });

  it("uses date and time inputs, and keeps the field names the form script reads", () => {
    const doc = eventsPage([]);
    const date = doc.querySelector<HTMLInputElement>('input[name="date"]');
    const time = doc.querySelector<HTMLInputElement>('input[name="time"]');
    expect(date?.type).toBe("date");
    expect(time?.type).toBe("time");
    // A browser sends HH:MM unless a step under a minute is set.
    expect(time?.hasAttribute("step")).toBe(false);
    // The past date that used to be the placeholder is gone.
    expect(doc.body.innerHTML).not.toContain("2026-07-04");
    // The timezone box and the number bounds stay as they were (#1304).
    expect(
      doc.querySelector<HTMLInputElement>('input[name="timezone"]')?.type,
    ).toBe("text");
    expect(doc.querySelector("[data-event-form]")).not.toBeNull();
  });

  it("folds ended and cancelled events under Past events (n)", () => {
    const doc = eventsPage([
      eventRow({ id: "a".repeat(24), title: "Upcoming one" }),
      eventRow({ id: "b".repeat(24), title: "Old one", state: "ended" }),
      eventRow({
        id: "c".repeat(24),
        title: "Dropped one",
        state: "cancelled",
      }),
    ]);
    const past = doc.querySelector<HTMLDetailsElement>("details#past-events");
    expect(past).not.toBeNull();
    expect(past?.open).toBe(false);
    expect(past?.querySelector("summary")?.textContent).toContain(
      "Past events",
    );
    expect(past?.querySelector(".kb-badge--count")?.textContent).toBe("2");
    expect(past?.textContent).toContain("Old one");
    expect(past?.textContent).toContain("Dropped one");
    expect(past?.textContent).not.toContain("Upcoming one");
    // The list outside the fold holds the upcoming event only.
    const outside = [...doc.querySelectorAll("table")].filter(
      (t) => !past?.contains(t),
    );
    expect(outside).toHaveLength(1);
    expect(outside[0].textContent).toContain("Upcoming one");
    expect(outside[0].textContent).not.toContain("Old one");
  });

  it("keeps a finished occurrence that still holds a live series out of the fold", () => {
    const doc = eventsPage([
      eventRow({
        title: "Weekly quiz",
        state: "ended",
        recurrence: "weekly",
        awaitingSuccessor: true,
      }),
    ]);
    expect(doc.querySelector("details#past-events")).toBeNull();
    expect(doc.body.textContent).toContain("Cancel series");
  });

  it("has no Past events fold when nothing is past", () => {
    expect(eventsPage([eventRow()]).querySelector("#past-events")).toBeNull();
  });

  it("says so when everything is past, or there is nothing at all", () => {
    expect(
      eventsPage([eventRow({ state: "ended" })]).body.textContent,
    ).toContain("No upcoming events.");
    expect(eventsPage([]).body.textContent).toContain(
      "No events scheduled yet.",
    );
  });

  it("drops the raw id column and every column that is empty for all rows", () => {
    const doc = eventsPage([eventRow()]);
    expect(headers(doc, "main")).toEqual(["Title", "When", "State", "Actions"]);
    expect(doc.body.innerHTML).not.toContain(
      `<td class="mono">${"0123456789abcdef01234567"}</td>`,
    );
  });

  it("shows a column as soon as one row has something in it", () => {
    const doc = eventsPage([
      eventRow({ channelId: "ch-9" }),
      eventRow({
        title: "Second",
        expected: { kind: "ok", count: 2, names: [], page: 0, hasMore: false },
        cover: { kind: "editable", hasCover: false, series: false },
      }),
    ]);
    expect(headers(doc, "main")).toEqual([
      "Title",
      "When",
      "State",
      "Expected to show up",
      "Channel",
      "Cover image",
      "Actions",
    ]);
    // Every row has a cell for each shown column.
    const widths = [...doc.querySelectorAll("tbody tr")].map(
      (tr) => tr.children.length,
    );
    expect(new Set(widths)).toEqual(new Set([7]));
  });

  it("counts old RSVP buttons as something in the Expected column", () => {
    const doc = eventsPage([
      eventRow({ legacyRsvps: { going: 1, maybe: 0, cant: 0 } }),
    ]);
    expect(headers(doc, "main")).toContain("Expected to show up");
  });

  it("decides each table's columns from its own rows", () => {
    const doc = eventsPage([
      eventRow({ title: "Next", channelId: "ch-1" }),
      eventRow({ title: "Gone", state: "ended" }),
    ]);
    expect(headers(doc, "details#past-events").includes("Channel")).toBe(false);
    const outside = [...doc.querySelectorAll("table")].find(
      (t) => !t.closest("details#past-events"),
    );
    expect(outside?.textContent).toContain("Channel");
  });

  it("turns the warnings into chips that link to the setting or the permission", () => {
    const doc = eventsPage([], {
      categoryConfigured: false,
      announcementConfigured: false,
      nativePermissionMissing: true,
    });
    const links = [...doc.querySelectorAll("a.kb-chip--warn")].map((a) =>
      a.getAttribute("href"),
    );
    expect(links).toEqual([
      "#set-events.category_id",
      "#set-events.announcement_channel_id",
      "/admin/bot-permissions",
    ]);
    // Both settings are unset, so the settings are open for the admin to fix them.
    expect(
      doc.querySelector<HTMLDetailsElement>("details[data-settings-fold]")
        ?.open,
    ).toBe(true);
    // The first link lands on a control that exists.
    expect(doc.getElementById("set-events.category_id")).not.toBeNull();
  });

  it("folds the settings when the feature is on and configured", () => {
    const doc = eventsPage([eventRow()]);
    expect(
      doc.querySelector<HTMLDetailsElement>("details[data-settings-fold]")
        ?.open,
    ).toBe(false);
    expect(doc.querySelector("a.kb-chip--warn")).toBeNull();
  });

  it("opens the settings when the feature is off", () => {
    const doc = eventsPage([], {
      enabled: false,
      settingRows: FEATURE_ROWS.map((r) =>
        r.key === "events.enabled" ? { ...r, current: false } : r,
      ),
    });
    expect(
      doc.querySelector<HTMLDetailsElement>("details[data-settings-fold]")
        ?.open,
    ).toBe(true);
    expect(doc.querySelector(".kb-badge--off")).not.toBeNull();
  });

  it("shows a settings flash inside the open settings, not at the top", () => {
    const doc = eventsPage([eventRow()], {
      flash: {
        type: "ok",
        text: "Saved 1 setting in events.",
        openSettings: true,
      },
    });
    const flashes = doc.querySelectorAll("[data-flash]");
    expect(flashes).toHaveLength(1);
    const d = doc.querySelector<HTMLDetailsElement>(
      "details[data-settings-fold]",
    );
    expect(d?.open).toBe(true);
    expect(d?.contains(flashes[0])).toBe(true);
  });

  it("shows another flash at the top and leaves the settings folded", () => {
    const doc = eventsPage([eventRow()], {
      flash: { type: "ok", text: "Event created." },
    });
    const flash = doc.querySelector("[data-flash]");
    expect(flash?.textContent).toBe("Event created.");
    const d = doc.querySelector<HTMLDetailsElement>(
      "details[data-settings-fold]",
    );
    expect(d?.open).toBe(false);
    expect(d?.contains(flash!)).toBe(false);
  });
});

describe("the Tickets page", () => {
  const ticketsDoc = (staffRole: string, over: object = {}): Document =>
    new DOMParser().parseFromString(
      renderTicketsPage({
        csrfToken: "tok",
        remainingMs: 60_000,
        enabled: true,
        statusFilter: "",
        statusOptions: ["open", "closed"],
        rows: [],
        total: 0,
        page: 1,
        pageSize: 50,
        settingRows: [
          row({
            key: "tickets.enabled",
            type: "boolean",
            current: true,
            defaultValue: false,
          }),
          row({
            key: "tickets.staff_role_id",
            type: "role",
            current: staffRole,
          }),
        ],
        pickers: { roles: [{ id: "r1", name: "Mods" }] },
        ...over,
      }),
      "text/html",
    );

  it("opens the settings when the staff role is missing, with a chip that links to it", () => {
    const doc = ticketsDoc("");
    expect(
      doc.querySelector<HTMLDetailsElement>("details[data-settings-fold]")
        ?.open,
    ).toBe(true);
    expect(doc.querySelector("a.kb-chip--warn")?.getAttribute("href")).toBe(
      "#set-tickets.staff_role_id",
    );
  });

  it("keeps them folded once a staff role is set", () => {
    const doc = ticketsDoc("r1");
    expect(
      doc.querySelector<HTMLDetailsElement>("details[data-settings-fold]")
        ?.open,
    ).toBe(false);
    expect(doc.querySelector(".kb-chip--warn")).toBeNull();
  });
});

describe("status line chips", () => {
  it("wrap long messages instead of running off a narrow screen", () => {
    const css = readFileSync("docs/design/kb.css", "utf8");
    const rule = css
      .split("\n")
      .find((l) => l.startsWith(".kb-statusline .kb-chip"));
    expect(rule).toContain("white-space: normal");
    expect(rule).toContain("max-width: 100%");
    expect(rule).toContain("overflow-wrap: anywhere");
  });
});

describe("warning chips when the settings cannot be read", () => {
  it("name the problem without a link to a control that is not there", () => {
    const html = renderEventsPage({
      csrfToken: "tok",
      remainingMs: 60_000,
      enabled: true,
      categoryConfigured: false,
      announcementConfigured: true,
      timezone: "UTC",
      rows: [],
      settingRows: [],
      settingsUnavailable: true,
    });
    expect(html).not.toContain('href="#set-');
  });

  it("holds on every page that links a missing setting", () => {
    const src = readFileSync("src/web/admin-views.ts", "utf8");
    const at = [...src.matchAll(/settingHref\("/g)].map((m) => m.index ?? 0);
    expect(at.length).toBeGreaterThanOrEqual(6);
    for (const i of at) {
      expect(src.slice(i - 90, i)).toContain("props.settingsUnavailable");
    }
  });
});
