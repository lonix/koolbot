/**
 * @jest-environment <rootDir>/__tests__/jsdom-node-env.cjs
 */

/**
 * The native confirmation dialog behind `data-confirm` (#1343).
 *
 * jsdom has no `HTMLDialogElement.showModal`, so the suite installs a small
 * stand-in that opens, closes and fires `close` the way a browser does. The
 * markup is built and read through the DOM only (no HTML string filtering).
 */
import { describe, it, expect, jest, afterEach } from "@jest/globals";
import { axe, toHaveNoViolations } from "jest-axe";
import {
  CONFIRM_SCRIPT,
  confirmListAttr,
  escapeHtml,
  NONCE_MARKER,
  scriptTag,
} from "../../src/web/html.js";
import { applyNonce, buildCsp } from "../../src/web/security-headers.js";
import { installDocumentForAxe } from "./a11y-dom.js";
import { allPages } from "./a11y-pages.js";

expect.extend(toHaveNoViolations);

const proto = window.HTMLDialogElement.prototype as unknown as Record<
  string,
  unknown
>;

function installDialogStandIn(): void {
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  proto.close = function (this: HTMLDialogElement) {
    if (!this.hasAttribute("open")) return;
    this.removeAttribute("open");
    this.dispatchEvent(new window.Event("close"));
  };
}

function removeDialogStandIn(): void {
  delete proto.showModal;
  delete proto.close;
}

/** Run a script copy against the document and return a function that unloads it. */
function load(script: string): () => void {
  const spy = jest.spyOn(document, "addEventListener");
  let added: Array<Parameters<Document["addEventListener"]>> = [];
  try {
    new Function(script)();
    added = spy.mock.calls.slice() as typeof added;
  } finally {
    spy.mockRestore();
  }
  return () => {
    for (const [type, listener, options] of added) {
      document.removeEventListener(
        type,
        listener as EventListener,
        options as boolean,
      );
    }
  };
}

function dialog(): HTMLDialogElement | null {
  return document.querySelector<HTMLDialogElement>("dialog.kb-dialog");
}

function buttons(d: HTMLDialogElement): { back: HTMLElement; ok: HTMLElement } {
  const found = d.querySelectorAll<HTMLElement>(".kb-dialog__foot button");
  return { back: found[0], ok: found[1] };
}

function submitEvent(): Event {
  return new window.Event("submit", { bubbles: true, cancelable: true });
}

const HOSTILE = `<img src=x onerror="alert(1)"> & 'quotes'`;

function fixtureHtml(): string {
  return (
    `<form id="f" method="POST" action="/admin/reaction-roles/delete" data-confirm="Delete it?"` +
    `${confirmListAttr(["The role is deleted.", HOSTILE])}>` +
    `<input type="hidden" name="_csrf" value="tok"><button id="del" type="submit">Delete</button></form>` +
    `<form id="g" method="POST" action="/x"><button id="perm" type="submit" formaction="/y/permanent" ` +
    `data-confirm="Make permanent?">Make permanent</button></form>`
  );
}

interface Observations {
  opensOnSubmit: boolean;
  blockedUntilConfirm: boolean;
  titleIsText: boolean;
  labelledBy: boolean;
  listAsText: boolean;
  confirmRepeatsVerb: boolean;
  cancelFocused: boolean;
  goBackClosesWithoutSubmit: boolean;
  focusRestoredOnGoBack: boolean;
  escapeCancels: boolean;
  focusRestoredOnEscape: boolean;
  confirmResubmitsSameForm: boolean;
  csrfSurvives: boolean;
  buttonSubmitterKept: boolean;
}

/** Drive one copy of the script through every behaviour the issue lists. */
function observe(script: string): Observations {
  installDialogStandIn();
  document.body.innerHTML = fixtureHtml();
  const unload = load(script);
  const form = document.getElementById("f") as HTMLFormElement;
  const del = document.getElementById("del") as HTMLButtonElement;
  const seen: Array<{
    target: EventTarget | null;
    csrf: unknown;
    submitter: unknown;
  }> = [];
  // A bubble listener sees only a submit that got past the capture handler.
  const sink = (e: Event): void => {
    const t = e.target as HTMLFormElement;
    seen.push({
      target: t,
      csrf: new FormData(t).get("_csrf"),
      submitter: (e as SubmitEvent).submitter,
    });
    e.preventDefault();
  };
  document.addEventListener("submit", sink);
  const obs = {} as Observations;
  try {
    del.focus();
    const first = submitEvent();
    form.dispatchEvent(first);
    const d = dialog();
    obs.opensOnSubmit = !!d && first.defaultPrevented;
    obs.blockedUntilConfirm = seen.length === 0;
    if (!d) return { ...obs } as Observations;

    const title = d.querySelector(".kb-dialog__title");
    obs.titleIsText = title?.textContent === "Delete it?";
    obs.labelledBy =
      !!title?.id && d.getAttribute("aria-labelledby") === title.id;
    const items = Array.from(d.querySelectorAll("li"));
    obs.listAsText =
      items.length === 2 &&
      items[1].textContent === HOSTILE &&
      d.querySelector("img") === null &&
      items[1].children.length === 0;
    const { back, ok } = buttons(d);
    obs.confirmRepeatsVerb = ok.textContent === "Delete";
    obs.cancelFocused = document.activeElement === back;

    // Go back.
    back.click();
    obs.goBackClosesWithoutSubmit = dialog() === null && seen.length === 0;
    obs.focusRestoredOnGoBack = document.activeElement === del;

    // Escape: the browser fires `cancel`, then closes.
    del.blur();
    form.dispatchEvent(submitEvent());
    const d2 = dialog();
    if (d2) {
      const cancel = new window.Event("cancel", { cancelable: true });
      d2.dispatchEvent(cancel);
      if (!cancel.defaultPrevented) (d2 as HTMLDialogElement).close();
    }
    obs.escapeCancels = d2 !== null && dialog() === null && seen.length === 0;
    obs.focusRestoredOnEscape = document.activeElement === del;

    // Confirm.
    form.dispatchEvent(submitEvent());
    const d3 = dialog();
    if (d3) buttons(d3).ok.click();
    obs.confirmResubmitsSameForm =
      d3 !== null &&
      dialog() === null &&
      seen.length === 1 &&
      seen[0].target === form;
    obs.csrfSurvives = seen[0]?.csrf === "tok";

    // A submit button that carries its own data-confirm (formaction).
    seen.length = 0;
    const perm = document.getElementById("perm") as HTMLButtonElement;
    perm.click();
    const d4 = dialog();
    const before = seen.length;
    if (d4) buttons(d4).ok.click();
    obs.buttonSubmitterKept =
      d4 !== null &&
      before === 0 &&
      seen.length === 1 &&
      seen[0].submitter === perm;
    return obs;
  } finally {
    document.removeEventListener("submit", sink);
    unload();
    document.body.innerHTML = "";
    removeDialogStandIn();
  }
}

afterEach(() => {
  document.body.innerHTML = "";
  removeDialogStandIn();
});

describe("confirmation dialog (#1343)", () => {
  it("does everything the issue asks of it", () => {
    const o = observe(CONFIRM_SCRIPT);
    expect(o).toEqual({
      opensOnSubmit: true,
      blockedUntilConfirm: true,
      titleIsText: true,
      labelledBy: true,
      listAsText: true,
      confirmRepeatsVerb: true,
      cancelFocused: true,
      goBackClosesWithoutSubmit: true,
      focusRestoredOnGoBack: true,
      escapeCancels: true,
      focusRestoredOnEscape: true,
      confirmResubmitsSameForm: true,
      csrfSurvives: true,
      buttonSubmitterKept: true,
    });
  });

  it("is title-only when there is no list, and ignores a malformed one", () => {
    installDialogStandIn();
    document.body.innerHTML =
      `<form id="a" data-confirm="Plain?"><button>Remove</button></form>` +
      `<form id="b" data-confirm="Broken?" data-confirm-list="not json"><button>Go</button></form>` +
      `<form id="c" data-confirm="Mixed?" data-confirm-list='[1,"ok",{"a":1}]'><button>Go</button></form>`;
    const unload = load(CONFIRM_SCRIPT);
    try {
      for (const [id, items] of [
        ["a", 0],
        ["b", 0],
        ["c", 1],
      ] as const) {
        document.getElementById(id)!.dispatchEvent(submitEvent());
        const d = dialog()!;
        expect(d.querySelectorAll("li")).toHaveLength(items);
        expect(d.getAttribute("aria-describedby") !== null).toBe(items > 0);
        d.close();
      }
    } finally {
      unload();
    }
  });

  it("takes the verb from data-confirm-verb, then the button, then a default", () => {
    installDialogStandIn();
    document.body.innerHTML =
      `<form id="a" data-confirm="Q?" data-confirm-verb="Wipe it"><button>Delete</button></form>` +
      `<form id="b" data-confirm="Q?"><input type="submit" value="Resync"></form>` +
      `<form id="c" data-confirm="Q?"></form>`;
    const unload = load(CONFIRM_SCRIPT);
    try {
      for (const [id, verb] of [
        ["a", "Wipe it"],
        ["b", "Resync"],
        ["c", "Confirm"],
      ] as const) {
        document.getElementById(id)!.dispatchEvent(submitEvent());
        const d = dialog()!;
        expect(buttons(d).ok.textContent).toBe(verb);
        d.close();
      }
    } finally {
      unload();
    }
  });

  it("falls back to window.confirm when showModal is missing", () => {
    removeDialogStandIn();
    const confirmMock = jest.fn<(msg?: string) => boolean>(() => false);
    (window as unknown as { confirm: unknown }).confirm = confirmMock;
    document.body.innerHTML = `<form id="f" data-confirm="Delete it?"><button>Go</button></form>`;
    const unload = load(CONFIRM_SCRIPT);
    try {
      const ev = submitEvent();
      document.getElementById("f")!.dispatchEvent(ev);
      expect(confirmMock).toHaveBeenCalledWith("Delete it?");
      expect(ev.defaultPrevented).toBe(true);
      expect(dialog()).toBeNull();
      confirmMock.mockReturnValue(true);
      const ev2 = submitEvent();
      document.getElementById("f")!.dispatchEvent(ev2);
      expect(ev2.defaultPrevented).toBe(false);
    } finally {
      unload();
    }
  });

  it("without the script the form is untouched (no-JavaScript path)", () => {
    document.body.innerHTML = fixtureHtml();
    const ev = submitEvent();
    const sink = jest.fn((e: Event) => e.preventDefault());
    document.addEventListener("submit", sink);
    document.getElementById("f")!.dispatchEvent(ev);
    document.removeEventListener("submit", sink);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
    const f = document.getElementById("f")!;
    expect(f.getAttribute("method")).toBe("POST");
    expect(f.getAttribute("action")).toBe("/admin/reaction-roles/delete");
  });

  it("writes the list as escaped JSON that round-trips as plain text", () => {
    const attr = confirmListAttr([HOSTILE]);
    document.body.innerHTML = `<div id="x"${attr}></div>`;
    expect(document.querySelectorAll("img")).toHaveLength(0);
    expect(
      JSON.parse(
        document.getElementById("x")!.getAttribute("data-confirm-list")!,
      ),
    ).toEqual([HOSTILE]);
    expect(attr).toContain(escapeHtml('"'));
  });

  it("opened dialog has no axe violations", async () => {
    installDialogStandIn();
    document.body.innerHTML = `<main>${fixtureHtml()}</main>`;
    const unload = load(CONFIRM_SCRIPT);
    try {
      document.getElementById("f")!.dispatchEvent(submitEvent());
      const results = await axe(document.body, {
        rules: { "color-contrast": { enabled: false } },
      });
      expect(results).toHaveNoViolations();
    } finally {
      unload();
    }
  });
});

describe("mutation check on the confirm wiring", () => {
  const mutations: Array<[string, string, string]> = [
    ["focus starts on go back", "back.focus()", "0"],
    ["list is plain text", "n.textContent=text", "n.innerHTML=text"],
    ["bypass guard", "if(bypass===f)return;", ""],
    [
      "focus returns to the trigger",
      "if(!confirmed&&trigger&&trigger.focus)trigger.focus()",
      "0",
    ],
    [
      "submit is held back",
      "e.preventDefault();e.stopImmediatePropagation();",
      "",
    ],
    ["labelled by title", "d.setAttribute('aria-labelledby',title.id);", ""],
    [
      "confirm submits",
      "confirmed=true;d.close();go()",
      "confirmed=true;d.close()",
    ],
    [
      "go back closes",
      "back.addEventListener('click',function(){d.close()});",
      "",
    ],
    ["dialog is removed on close", "d.parentNode.removeChild(d)", "0"],
    [
      "button carries its submitter",
      "ask(b,b,b,function(){bypass=b;try{b.click()}finally{bypass=null}})",
      "ask(b,b,b,function(){bypass=b;try{b.form.requestSubmit()}finally{bypass=null}})",
    ],
  ];

  it("passes on the real script", () => {
    expect(Object.values(observe(CONFIRM_SCRIPT)).every(Boolean)).toBe(true);
  });

  for (const [name, from, to] of mutations) {
    it(`notices when "${name}" is broken`, () => {
      expect(CONFIRM_SCRIPT).toContain(from);
      const mutated = CONFIRM_SCRIPT.split(from).join(to);
      expect(mutated).not.toBe(CONFIRM_SCRIPT);
      let broken: boolean;
      try {
        broken = !Object.values(observe(mutated)).every(Boolean);
      } catch {
        broken = true;
      }
      expect(broken).toBe(true);
    });
  }
});

/** The high-impact actions that must carry a consequence list. */
const NEEDS_LIST: Array<[string, (a: string) => boolean]> = [
  ["reset defaults", (a) => a === "/admin/settings/reset-defaults"],
  ["notice resync", (a) => a === "/admin/notices/sync"],
  ["quote rebuild", (a) => a === "/admin/quotes/sync"],
  ["reaction-role delete", (a) => a === "/admin/reaction-roles/delete"],
  [
    "reaction-role group delete",
    (a) => a === "/admin/reaction-roles/group/delete",
  ],
  ["event cancel", (a) => /^\/admin\/events\/[^/]+\/cancel$/.test(a)],
  ["birthday remove", (a) => /^\/admin\/birthdays\/[^/]+\/remove$/.test(a)],
  ["moderation make permanent", (a) => a.endsWith("/permanent")],
  ["role-group delete", (a) => a.endsWith("/delete-role/apply")],
];

describe("every data-confirm site in the rendered pages (drift)", () => {
  it("opens the dialog, carries a valid list, and submits the same form", () => {
    installDialogStandIn();
    const matched = new Set<string>();
    let sites = 0;
    try {
      for (const page of allPages()) {
        installDocumentForAxe(page.html);
        const unload = load(CONFIRM_SCRIPT);
        const submits: Event[] = [];
        const sink = (e: Event): void => {
          submits.push(e);
          e.preventDefault();
        };
        document.addEventListener("submit", sink);
        try {
          for (const el of Array.from(
            document.querySelectorAll<HTMLElement>("[data-confirm]"),
          )) {
            sites += 1;
            const title = el.getAttribute("data-confirm")!;
            expect(title.length).toBeGreaterThan(0);
            const isControl = el.matches("button,input");
            const form = isControl
              ? (el as HTMLButtonElement).form
              : (el as HTMLFormElement);
            expect(form).not.toBeNull();
            const action =
              (el as HTMLButtonElement).getAttribute("formaction") ??
              form!.getAttribute("action") ??
              "";
            const raw = el.getAttribute("data-confirm-list");
            if (raw !== null) {
              const items = JSON.parse(raw) as unknown;
              expect(Array.isArray(items)).toBe(true);
              for (const item of items as unknown[]) {
                expect(typeof item).toBe("string");
                expect((item as string).length).toBeGreaterThan(0);
              }
            }
            for (const [name, test] of NEEDS_LIST) {
              if (test(action)) {
                matched.add(name);
                expect(raw).not.toBeNull();
              }
            }
            // A browser only fires submit once the form is valid (e.g. the
            // typed guild name), so satisfy the required fields first.
            for (const field of Array.from(
              form!.querySelectorAll<HTMLInputElement>("input[required]"),
            )) {
              if (field.type === "checkbox") field.checked = true;
              else if (!field.value) field.value = "x";
            }
            submits.length = 0;
            if (isControl) el.click();
            else el.dispatchEvent(submitEvent());
            const d = dialog();
            expect(d).not.toBeNull();
            expect(d!.querySelector(".kb-dialog__title")?.textContent).toBe(
              title,
            );
            expect(submits).toHaveLength(0);
            expect(document.activeElement).toBe(buttons(d!).back);
            buttons(d!).ok.click();
            expect(dialog()).toBeNull();
            if (submits.length !== 1) {
              throw new Error(
                `${page.name}: ${title} (${action}) did not resubmit; valid=${form!.checkValidity()}`,
              );
            }
            expect(submits[0].target as HTMLFormElement).toBe(form);
          }
        } finally {
          document.removeEventListener("submit", sink);
          unload();
        }
      }
    } finally {
      removeDialogStandIn();
    }
    expect(sites).toBeGreaterThan(10);
    expect(Array.from(matched).sort()).toEqual(
      NEEDS_LIST.map(([name]) => name).sort(),
    );
  }, 120_000);
});

describe("CSP and nonce", () => {
  it("ships as a nonce'd script block with no inline-HTML or inline-handler sinks", () => {
    const tag = scriptTag(CONFIRM_SCRIPT);
    expect(tag).toContain(`nonce="${NONCE_MARKER}"`);
    const out = applyNonce(tag, "N");
    expect(out).toBe(`<script nonce="N">${CONFIRM_SCRIPT}</script>`);
    expect(out).not.toContain(NONCE_MARKER);
    expect(buildCsp("N")).toContain("script-src 'nonce-N'");
    for (const sink of [
      "innerHTML",
      "outerHTML",
      "insertAdjacentHTML",
      "document.write",
      "eval(",
      "new Function",
      "setAttribute('style'",
      "setAttribute('on",
      ".style.",
      "<script",
      "javascript:",
    ]) {
      expect(CONFIRM_SCRIPT).not.toContain(sink);
    }
  });

  it("builds a dialog without style attributes or on* handlers", () => {
    installDialogStandIn();
    document.body.innerHTML = fixtureHtml();
    const unload = load(CONFIRM_SCRIPT);
    try {
      document.getElementById("f")!.dispatchEvent(submitEvent());
      const d = dialog()!;
      for (const node of [d, ...Array.from(d.querySelectorAll("*"))]) {
        expect(node.hasAttribute("style")).toBe(false);
        for (const name of node.getAttributeNames()) {
          expect(name.startsWith("on")).toBe(false);
        }
      }
      expect(d.querySelectorAll("script")).toHaveLength(0);
    } finally {
      unload();
    }
  });
});
