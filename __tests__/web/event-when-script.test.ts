/* global HTMLInputElement, HTMLElement */
/**
 * The create form's When script and the shared draft serializer, run for real
 * in jsdom (#1305). The markup and scripts come from the host's New event page,
 * so what is tested is what ships.
 */
import { describe, it, expect } from "@jest/globals";
import { JSDOM } from "jsdom";
import { renderNewEventBody } from "../../src/web/event-new-view.js";
import { renderEventsPage } from "../../src/web/admin-views.js";

const DRAFT_KEY = "koolbot-event-form-draft";

function hostPage(flash = false): string {
  const body = renderNewEventBody({
    csrfToken: "csrf-tok",
    timezone: "UTC",
    defaultDurationMinutes: 120,
    groupLimits: { defaultCount: 2, maxCount: 15 },
    groupPresets: [],
    groupPresetsNotice: null,
  });
  return `<!doctype html><html><body>${
    flash ? '<div class="notice err" data-flash>nope</div>' : ""
  }${body}</body></html>`;
}

function boot(html: string, draft?: Record<string, unknown>): JSDOM {
  const dom = new JSDOM(html, {
    url: "http://localhost/me/events/new",
    runScripts: "outside-only",
  });
  if (draft) {
    dom.window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  }
  // The page's own order: the groups script (draft restore), then When.
  const scripts = [
    ...html.matchAll(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g),
  ].map((m) => m[1]);
  expect(scripts.length).toBeGreaterThanOrEqual(2);
  for (const code of scripts) dom.window.eval(code);
  return dom;
}

const radio = (dom: JSDOM, value: string): HTMLInputElement => {
  const el = dom.window.document.querySelector(
    `input[name="when"][value="${value}"]`,
  );
  if (!el) throw new Error(`no radio ${value}`);
  return el as HTMLInputElement;
};

const pickBlock = (dom: JSDOM): HTMLElement =>
  dom.window.document.querySelector("[data-when-pick]") as HTMLElement;

function choose(dom: JSDOM, value: string): void {
  radio(dom, value).checked = true;
  radio(dom, value).dispatchEvent(
    new dom.window.Event("change", { bubbles: true }),
  );
}

describe("the When script hides the date and time (#1305)", () => {
  it("shows them for Pick date & time and really hides them otherwise", () => {
    const dom = boot(hostPage());
    const block = pickBlock(dom);
    // Pick is the default: shown, and the fields are required.
    expect(block.hidden).toBe(false);
    expect(block.style.display).toBe("");
    for (const name of ["date", "time"]) {
      const input = block.querySelector(
        `input[name=${name}]`,
      ) as HTMLInputElement;
      expect(input.required).toBe(true);
    }
    for (const value of ["now", "15", "30", "60"]) {
      choose(dom, value);
      // `hidden` alone loses to `.kb-fields { display: grid }`, so the inline
      // display must say none as well.
      expect(block.hidden).toBe(true);
      expect(block.style.display).toBe("none");
      expect(
        (block.querySelector("input[name=date]") as HTMLInputElement).required,
      ).toBe(false);
    }
    choose(dom, "pick");
    expect(block.hidden).toBe(false);
    expect(block.style.display).toBe("");
  });

  it("does the same on the admin form's select, whose labels are display:flex", () => {
    const html = renderEventsPage({
      csrfToken: "csrf-tok",
      remainingMs: 60_000,
      categoryConfigured: true,
      announcementConfigured: true,
      timezone: "UTC",
      settingRows: [],
      enabled: true,
      rows: [],
    } as never);
    const dom = new JSDOM(html, {
      url: "http://localhost/admin/events",
      runScripts: "outside-only",
    });
    const when = [
      ...html.matchAll(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g),
    ]
      .map((m) => m[1])
      .find((code) => code.includes("data-when-pick"));
    if (!when) throw new Error("when script not found");
    dom.window.eval(when);
    const select = dom.window.document.querySelector(
      "select[name=when]",
    ) as unknown as HTMLInputElement;
    const labels = [
      ...dom.window.document.querySelectorAll("label[data-when-pick]"),
    ] as HTMLElement[];
    expect(labels).toHaveLength(2);
    select.value = "now";
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    for (const l of labels) expect(l.style.display).toBe("none");
    select.value = "pick";
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    for (const l of labels) expect(l.style.display).toBe("");
  });
});

describe("the draft kept across a refused submit (#1305)", () => {
  function submit(dom: JSDOM): void {
    const form = dom.window.document.querySelector("form[data-event-form]");
    form?.dispatchEvent(
      new dom.window.Event("submit", { bubbles: true, cancelable: true }),
    );
  }

  it("saves only the checked When option, not the last radio", () => {
    const dom = boot(hostPage());
    choose(dom, "now");
    (
      dom.window.document.querySelector(
        'input[name="title"]',
      ) as HTMLInputElement
    ).value = "Right now";
    submit(dom);
    const saved = JSON.parse(dom.window.sessionStorage.getItem(DRAFT_KEY)!);
    expect(saved.when).toBe("now");
    expect(saved.title).toBe("Right now");
  });

  it("saves nothing for a radio group with no choice, rather than a wrong one", () => {
    const dom = boot(hostPage());
    for (const r of dom.window.document.querySelectorAll(
      'input[name="when"]',
    )) {
      (r as HTMLInputElement).checked = false;
    }
    submit(dom);
    const saved = JSON.parse(dom.window.sessionStorage.getItem(DRAFT_KEY)!);
    expect("when" in saved).toBe(false);
  });

  it("puts Now back after the page returns with an error, and hides the date", () => {
    const dom = boot(hostPage(true), {
      when: "now",
      title: "Right now",
      duration: "90",
    });
    expect(radio(dom, "now").checked).toBe(true);
    expect(radio(dom, "pick").checked).toBe(false);
    expect(pickBlock(dom).style.display).toBe("none");
    expect(
      (
        dom.window.document.querySelector(
          'input[name="title"]',
        ) as HTMLInputElement
      ).value,
    ).toBe("Right now");
  });

  it("round trips a delay choice through submit and restore", () => {
    const first = boot(hostPage());
    choose(first, "30");
    submit(first);
    const draft = JSON.parse(first.window.sessionStorage.getItem(DRAFT_KEY)!);
    const second = boot(hostPage(true), draft);
    expect(radio(second, "30").checked).toBe(true);
    expect(radio(second, "pick").checked).toBe(false);
  });
});
