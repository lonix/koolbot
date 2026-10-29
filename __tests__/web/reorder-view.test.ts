/**
 * @jest-environment <rootDir>/__tests__/jsdom-node-env.cjs
 */
/* global document, Event, DOMParser, Document, Element, HTMLButtonElement, HTMLInputElement, HTMLElement, HTMLFormElement */

/**
 * Move up / Move down and the drag upgrade of the Notices and Presence lists
 * (#1540): the buttons are plain forms that work with scripts off, the page
 * script only upgrades a mouse drag, and a dropped row submits the same form.
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import {
  renderNoticesPage,
  renderBotStatusPage,
} from "../../src/web/admin-views.js";
import {
  REORDER_SCRIPT,
  REORDER_STATUS_HTML,
  renderReorderCell,
  reorderListAttrs,
  reorderRowAttrs,
} from "../../src/web/reorder-view.js";
import {
  BOT_STATUS_POOLS,
  BOT_STATUS_POOL_META,
} from "../../src/content/statuses.js";

const BASE = {
  guildId: "g1",
  csrfToken: "csrf<1>",
  remainingMs: 60_000,
  navFeatureStatus: {},
  enabled: true,
};

const noticeRow = (id: string, category: string, n: number) => ({
  id,
  order: n,
  title: `Title ${id}`,
  content: "Text",
  preview: "Text",
  category,
  messageId: "",
  updatedAt: "2026-01-01",
});

const noticesHtml = (): string =>
  renderNoticesPage({
    ...BASE,
    channel: null,
    total: 4,
    settingRows: [],
    textChannels: [],
    categoryOptions: [{ value: "general", label: "General" }],
    groups: [
      {
        category: "General",
        rows: ["n0", "n1", "n2"].map((id, i) => noticeRow(id, "general", i)),
      },
      { category: "Rules", rows: [noticeRow("r0", "rules", 0)] },
    ],
  });

const presenceHtml = (): string =>
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
          ? [0, 1, 2].map((n) => ({
              id: `e${n}`,
              order: n,
              text: `Entry ${n}`,
            }))
          : [],
      usingDefaults: pool !== "single",
      exportText: "stored",
    })),
  });

const parse = (html: string): Document =>
  new DOMParser().parseFromString(html, "text/html");

const buttons = (row: Element): HTMLButtonElement[] =>
  Array.from(row.querySelectorAll<HTMLButtonElement>("button[name=to]"));

describe("renderReorderCell", () => {
  const cell = (index: number, count: number): Document =>
    parse(
      renderReorderCell({
        action: "/x/<id>/move",
        csrfInput: '<input type="hidden" name="_csrf" value="t">',
        index,
        count,
        label: 'A "quoted" <b>',
      }),
    );

  it("posts a form with the place the row has now and the list length", () => {
    const form = cell(1, 4).querySelector("form")!;
    expect(form.getAttribute("method")).toBe("POST");
    expect(form.getAttribute("action")).toBe("/x/<id>/move");
    expect(form.querySelector<HTMLInputElement>("[name=_csrf]")?.value).toBe(
      "t",
    );
    expect(form.querySelector<HTMLInputElement>("[name=from]")?.value).toBe(
      "1",
    );
    expect(form.querySelector<HTMLInputElement>("[name=count]")?.value).toBe(
      "4",
    );
  });

  it("has a Move up to the place before and a Move down to the place after", () => {
    const [up, down] = buttons(cell(1, 4).body);
    expect(up.value).toBe("0");
    expect(down.value).toBe("2");
    expect(up.disabled).toBe(false);
    expect(down.disabled).toBe(false);
  });

  it("names each button with its visible text first, then the row", () => {
    const [up, down] = buttons(cell(1, 4).body);
    expect(up.textContent).toBe('Move up: A "quoted" <b>');
    expect(down.textContent).toBe('Move down: A "quoted" <b>');
  });

  it("switches Move up off on the first row and Move down off on the last", () => {
    expect(buttons(cell(0, 3).body).map((b) => b.disabled)).toEqual([
      true,
      false,
    ]);
    expect(buttons(cell(2, 3).body).map((b) => b.disabled)).toEqual([
      false,
      true,
    ]);
    expect(buttons(cell(0, 1).body).map((b) => b.disabled)).toEqual([
      true,
      true,
    ]);
  });

  it("shows the place (1-based) and reads it as 'of N'", () => {
    const place = cell(1, 4).querySelector(".kb-reorder__place")!;
    expect(place.textContent).toBe("2 of 4");
    expect(place.querySelector(".kb-visually-hidden")?.textContent).toBe(
      " of 4",
    );
  });

  it("draws the grip handle as a decorative icon", () => {
    const handle = cell(0, 2).querySelector("[data-reorder-handle]")!;
    expect(handle.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("escapes the row and list labels", () => {
    expect(reorderRowAttrs("notice-1", '"><x>')).not.toContain("<x>");
    expect(reorderListAttrs('"><x>')).not.toContain("<x>");
  });
});

describe("the Notices page", () => {
  const d = parse(noticesHtml());

  it("lists each category as its own reorderable group, with buttons that post a form", () => {
    const lists = d.querySelectorAll("tbody[data-reorder-list]");
    expect(lists).toHaveLength(2);
    const rows = lists[0].querySelectorAll("tr[data-reorder-row]");
    expect(Array.from(rows).map((r) => r.id)).toEqual([
      "notice-n0",
      "notice-n1",
      "notice-n2",
    ]);
    const form = rows[1].querySelector("form[data-reorder-form]")!;
    expect(form.getAttribute("action")).toBe("/admin/notices/n1/move");
    expect(buttons(rows[1]).map((b) => b.value)).toEqual(["0", "2"]);
    expect(buttons(rows[0])[0].disabled).toBe(true);
    expect(buttons(rows[2])[1].disabled).toBe(true);
  });

  it("has no Order number box anywhere: not inline, not in Edit, not in Create", () => {
    expect(d.querySelector("[name=order]")).toBeNull();
    expect(d.body.textContent).not.toContain("lower posts first");
  });

  it("says a new order shows in the channel after Resync notices to channel", () => {
    expect(d.getElementById("notices-order-note")?.textContent).toContain(
      "after Resync notices to channel",
    );
  });

  it("has one polite live region and loads the page script", () => {
    const live = d.querySelectorAll("#reorder-status");
    expect(live).toHaveLength(1);
    expect(live[0].getAttribute("role")).toBe("status");
    expect(live[0].getAttribute("aria-live")).toBe("polite");
    expect(noticesHtml()).toContain("data-reorder-handle");
    expect(noticesHtml()).toContain("requestSubmit");
  });
});

describe("the Presence page", () => {
  const d = parse(presenceHtml());

  it("has Move up / Move down for the entries of a pool, and no Order number box", () => {
    const rows = d.querySelectorAll(
      "tbody[data-reorder-list] tr[data-reorder-row]",
    );
    expect(rows).toHaveLength(3);
    expect(
      rows[1].querySelector("form[data-reorder-form]")?.getAttribute("action"),
    ).toBe("/admin/bot-status/entry/e1/move");
    expect(buttons(rows[0])[0].disabled).toBe(true);
    expect(d.querySelector("[name=order]")).toBeNull();
  });

  it("says the bot picks at random, so the order only shapes the list and its export", () => {
    expect(d.body.textContent).toContain(
      "The bot picks one message at random, so the order only decides how a pool reads here and in its export.",
    );
  });
});

describe("the page script (progressive enhancement)", () => {
  function setup(): void {
    document.body.innerHTML = `${REORDER_STATUS_HTML}
<table><tbody${reorderListAttrs("General")}>
${["a", "b", "c"]
  .map(
    (id, i) =>
      `<tr${reorderRowAttrs(`n-${id}`, `Notice ${id}`)}><td>${renderReorderCell({ action: `/m/${id}`, csrfInput: "", index: i, count: 3, label: id })}</td></tr>`,
  )
  .join("")}
</tbody></table>
<table><tbody${reorderListAttrs("Rules")}>
<tr${reorderRowAttrs("n-r", "Notice r")}><td>${renderReorderCell({ action: "/m/r", csrfInput: "", index: 0, count: 1, label: "r" })}</td></tr>
</tbody></table>`;
    for (const f of Array.from(document.querySelectorAll("form"))) {
      (f as unknown as Record<string, unknown>).requestSubmit = jest.fn();
    }
    new Function(REORDER_SCRIPT)();
  }
  const row = (id: string): HTMLElement => document.getElementById(`n-${id}`)!;
  const form = (id: string): HTMLFormElement & { requestSubmit: jest.Mock } =>
    row(id).querySelector("form") as never;
  const status = (): string =>
    document.getElementById("reorder-status")!.textContent ?? "";
  const ev = (type: string): Event =>
    new Event(type, { bubbles: true, cancelable: true });
  const drag = (from: string, onto: string): void => {
    row(from)
      .querySelector("[data-reorder-handle]")!
      .dispatchEvent(ev("mousedown"));
    row(from).dispatchEvent(ev("dragstart"));
    row(onto).dispatchEvent(ev("dragover"));
    row(onto).dispatchEvent(ev("drop"));
  };

  beforeEach(setup);

  it("only starts a drag from the handle", () => {
    const start = ev("dragstart");
    row("a").dispatchEvent(start);
    expect(start.defaultPrevented).toBe(true);
    expect(row("a").classList.contains("is-dragging")).toBe(false);
  });

  it("puts the dropped row's new place into its own form and submits it", () => {
    drag("a", "c");
    const f = form("a");
    const to = f.querySelectorAll<HTMLInputElement>("input[name=to]");
    expect(to).toHaveLength(1);
    expect(to[0].value).toBe("2");
    expect(f.requestSubmit).toHaveBeenCalledTimes(1);
    // No submitter: the buttons' own `to` values are not posted.
    expect(f.requestSubmit.mock.calls[0]).toHaveLength(0);
    expect(status()).toBe("Moving Notice a to place 3 of 3.");
  });

  it("moves up as well as down", () => {
    drag("c", "a");
    expect(
      form("c").querySelector<HTMLInputElement>("input[name=to]")?.value,
    ).toBe("0");
  });

  it("does nothing for a drop on the row itself", () => {
    drag("b", "b");
    expect(form("b").requestSubmit).not.toHaveBeenCalled();
  });

  it("reads out a drop on another list instead of moving", () => {
    drag("a", "r");
    expect(form("a").requestSubmit).not.toHaveBeenCalled();
    expect(status()).toBe("Notice a can only be moved within General.");
  });

  it("leaves the buttons alone when the browser cannot requestSubmit", () => {
    const proto = HTMLFormElement.prototype as unknown as Record<
      string,
      unknown
    >;
    const saved = proto.requestSubmit;
    proto.requestSubmit = undefined;
    try {
      document.body.innerHTML = `<table><tbody>${renderReorderCell({ action: "/m", csrfInput: "", index: 0, count: 2, label: "x" })}</tbody></table>`;
      expect(() => new Function(REORDER_SCRIPT)()).not.toThrow();
    } finally {
      proto.requestSubmit = saved;
    }
  });
});
