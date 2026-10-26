/* global HTMLInputElement */
import { describe, it, expect } from "@jest/globals";
import { JSDOM, VirtualConsole } from "jsdom";

/**
 * A group row whose marker the server refused (#1523): the rows script turns
 * the marker box into a picker button and hides the box, but a refused box is
 * the control `aria-invalid` and its error line point at, and the one the
 * layout moves focus to, so it stays visible.
 */
const { renderGroupRow } = await import("../../src/web/admin-views.js");
const { groupRowsScript } = await import("../../src/web/event-group-form.js");

function boot(attrs: string): JSDOM {
  const row = renderGroupRow(
    "0",
    "1",
    { name: "Red", marker: "x" },
    attrs ? { attrs: { marker: attrs } } : undefined,
  );
  const dom = new JSDOM(`<!doctype html><body><form>${row}</form></body>`, {
    runScripts: "outside-only",
  });
  dom.window.eval(groupRowsScript());
  return dom;
}

describe("the rows script and a refused marker", () => {
  it("keeps the refused marker box visible so focus can reach it", () => {
    const dom = boot(' id="m" aria-invalid="true" aria-describedby="m-error"');
    const box = dom.window.document.querySelector<HTMLInputElement>(
      "[data-marker-input]",
    );
    expect(box?.hidden).toBe(false);
  });

  it("still folds a marker box that was not refused behind its picker button", () => {
    const dom = boot("");
    const box = dom.window.document.querySelector<HTMLInputElement>(
      "[data-marker-input]",
    );
    expect(box?.hidden).toBe(true);
  });
});

describe("a refused marker on the real Group presets page (#1523)", () => {
  it("is visible and focused after the page's own scripts have run, in their real order", async () => {
    const { renderEventPresetsPage } =
      await import("../../src/web/event-presets-page.js");
    const html = renderEventPresetsPage({
      csrfToken: "csrf",
      remainingMs: 60_000,
      entries: [],
      state: "ok",
      maxCount: 15,
      defaultCount: 2,
      editing: null,
      prefillNote: null,
      values: {
        preset_name: "Clan",
        group_0_name: "Red",
        group_0_marker: "??",
      },
      refusedForm: {
        formId: "event-preset",
        errors: { group_0_marker: "Not a marker." },
        values: {},
      },
    });
    const dom = new JSDOM(html, {
      runScripts: "dangerously",
      url: "http://localhost/admin/events/presets",
      virtualConsole: new VirtualConsole(),
    });
    const doc = dom.window.document;
    const marker = doc.querySelector<HTMLInputElement>(
      '[name="group_0_marker"]',
    );
    expect(marker?.getAttribute("aria-invalid")).toBe("true");
    expect(marker?.hidden).toBe(false);
    expect(doc.activeElement).toBe(marker);
    const target = doc.getElementById(
      marker?.getAttribute("aria-describedby") ?? "",
    );
    expect(target?.textContent).toBe("Not a marker.");
  });
});
