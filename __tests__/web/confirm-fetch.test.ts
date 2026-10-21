/**
 * @jest-environment <rootDir>/__tests__/jsdom-node-env.cjs
 */

/**
 * The panel's fetch-and-upgrade (#1344), driven in jsdom against the REAL
 * markup (`renderGroupsSwitchForms`, `renderGroupSetForms`, `renderConfirmBody`)
 * and the real shared dialog (`CONFIRM_SCRIPT`).
 *
 * The question under test is the security one: the dialog opens only for the
 * expected confirmation page, shows server text as text, and only the dialog's
 * confirm button posts the server's own confirm fields to the confirm route.
 * Every other answer ends in no dialog, no post and a message. Each guard of
 * the script is mutation-checked at the bottom.
 */
import { describe, it, expect, jest, afterEach } from "@jest/globals";
import { axe, toHaveNoViolations } from "jest-axe";
import { CONFIRM_SCRIPT } from "../../src/web/html.js";
import {
  CONFIRM_FETCH_ATTR,
  CONFIRM_FETCH_SCRIPT,
  CONFIRM_ONLY_HEADER,
  CONFIRM_ONLY_VALUE,
  CONFIRM_PAGE_HEADER,
  CONFIRM_PAGE_VALUE,
} from "../../src/web/confirm-fetch.js";
import { renderConfirmBody } from "../../src/web/host-settings-view.js";
import {
  renderGroupsSwitchForms,
  type GroupsSwitchView,
} from "../../src/web/host-settings-groups-switch.js";

expect.extend(toHaveNoViolations);

const ACTION = "/me/events/65a000000000000000000001/host/settings";
const CONFIRM_ACTION = `${ACTION}-confirm`;
const PANEL = "/me/events/65a000000000000000000001/host";
const HOSTILE = `<img src=x onerror="alert(1)"> & 'quotes'`;

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

const VIEW: GroupsSwitchView = {
  on: true,
  groupLabel: "Team",
  channelOwed: false,
  blocked: null,
  kept: [],
  presets: [],
  presetNotice: null,
  groupCount: 2,
  channelCount: 2,
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

function confirmHtml(
  over: {
    action?: string;
    csrf?: string;
    token?: string;
    reasons?: string[];
    changes?: Array<{ label: string; from: string; to: string }>;
  } = {},
): string {
  return `<!doctype html><html><body>${renderConfirmBody({
    csrfToken: over.csrf ?? "tok",
    actionPath: over.action ?? CONFIRM_ACTION,
    panelPath: PANEL,
    token: over.token ?? "signed.token",
    reasons: over.reasons ?? [
      `Switching groups off: ${HOSTILE}. Everybody is moved first.`,
    ],
    changes: over.changes ?? [{ label: "Groups", from: "on", to: "off" }],
  })}</body></html>`;
}

interface Answer {
  status?: number;
  contentType?: string | null;
  pageHeader?: string | null;
  redirected?: boolean;
  type?: string;
  url?: string;
  html?: string;
  reject?: boolean;
  /** Holds the answer until `release()` (for the in-flight guard). */
  hold?: boolean;
}

function fakeResponse(a: Answer): unknown {
  const headers: Record<string, string> = {};
  const ct =
    a.contentType === undefined ? "text/html; charset=utf-8" : a.contentType;
  if (ct !== null) headers["content-type"] = ct;
  const ph = a.pageHeader === undefined ? CONFIRM_PAGE_VALUE : a.pageHeader;
  if (ph !== null) headers[CONFIRM_PAGE_HEADER.toLowerCase()] = ph;
  return {
    status: a.status ?? 200,
    redirected: a.redirected ?? false,
    type: a.type ?? "basic",
    url: a.url ?? `http://localhost${ACTION}`,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    text: async () => a.html ?? confirmHtml(),
  };
}

interface Observed {
  prevented: boolean;
  fetches: number;
  fetchUrl: string | null;
  fetchMethod: string | null;
  fetchHeader: string | null;
  fetchBody: string | null;
  dialog: boolean;
  title: string | null;
  items: string[];
  verb: string | null;
  hostileAsText: boolean;
  posts: Array<{ action: string; method: string; fields: string[] }>;
  error: string;
  navigations: number;
  disabledDuring: boolean | null;
  disabledAfter: boolean | null;
}

interface Scenario {
  answer?: Answer;
  /** Replace the form's markup (default: the real switch-off form). */
  form?: string;
  loadDialog?: boolean;
  showModal?: boolean;
  /** Steps after the dialog opened. */
  then?: "confirm" | "confirm-twice" | "go-back" | "none";
  /** A second submit while the first is in flight. */
  doubleSubmit?: boolean;
}

function realForm(): string {
  return renderGroupsSwitchForms(VIEW, ACTION, "tok");
}

async function observe(
  script: string,
  s: Scenario,
  dialogScript = CONFIRM_SCRIPT,
): Promise<Observed> {
  if (s.showModal === false) removeDialogStandIn();
  else installDialogStandIn();
  document.body.innerHTML = s.form ?? realForm();
  const unloadDialog = s.loadDialog === false ? () => {} : load(dialogScript);
  const unload = load(script);
  const form = document.querySelector("form") as HTMLFormElement;
  const button = form.querySelector(
    "button[type=submit]",
  ) as HTMLButtonElement | null;
  const posts: Observed["posts"] = [];
  const submitSpy = jest
    .spyOn(HTMLFormElement.prototype, "submit")
    .mockImplementation(function (this: HTMLFormElement) {
      posts.push({
        action: this.getAttribute("action") ?? "",
        method: (this.getAttribute("method") ?? "").toUpperCase(),
        fields: Array.from(this.elements).map(
          (e) =>
            `${(e as HTMLInputElement).name}=${(e as HTMLInputElement).value}`,
        ),
      });
    });
  const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  let calls = 0;
  let init: RequestInit | undefined;
  let url: string | null = null;
  let release: () => void = () => {};
  (window as unknown as { fetch: unknown }).fetch = (
    u: string,
    i: RequestInit,
  ) => {
    calls += 1;
    url = String(u);
    init = i;
    if (s.answer?.reject) return Promise.reject(new Error("network"));
    const res = fakeResponse(s.answer ?? {});
    if (s.answer?.hold) {
      return new Promise((r) => {
        release = () => r(res);
      });
    }
    return Promise.resolve(res);
  };
  const obs = {} as Observed;
  try {
    const ev = new window.Event("submit", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "submitter", { value: button });
    form.dispatchEvent(ev);
    obs.prevented = ev.defaultPrevented;
    obs.disabledDuring = button ? button.disabled : null;
    if (s.doubleSubmit) {
      form.dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      );
      release();
    }
    await flush();
    const d = document.querySelector<HTMLDialogElement>("dialog.kb-dialog");
    obs.dialog = d !== null;
    obs.title = d?.querySelector(".kb-dialog__title")?.textContent ?? null;
    const lis = Array.from(d?.querySelectorAll("li") ?? []);
    obs.items = lis.map((l) => l.textContent ?? "");
    obs.hostileAsText =
      d !== null &&
      d.querySelector("img") === null &&
      lis.every((l) => l.children.length === 0);
    const foot = d?.querySelectorAll<HTMLElement>(".kb-dialog__foot button");
    obs.verb = foot ? (foot[1].textContent ?? null) : null;
    obs.posts = posts;
    // Nothing is posted while the dialog is open.
    if (d && posts.length > 0) throw new Error("posted before the confirm");
    if (d && s.then === "go-back") foot![0].click();
    if (d && s.then === "confirm") foot![1].click();
    if (d && s.then === "confirm-twice") {
      foot![1].click();
      foot![1].click();
    }
    obs.fetches = calls;
    obs.fetchUrl = url;
    obs.fetchMethod = init?.method ?? null;
    obs.fetchHeader =
      (init?.headers as Record<string, string> | undefined)?.[
        CONFIRM_ONLY_HEADER
      ] ?? null;
    obs.fetchBody = init?.body === undefined ? null : String(init.body);
    obs.error =
      form.querySelector("[data-confirm-fetch-error]")?.textContent ?? "";
    obs.navigations = errorSpy.mock.calls.filter((c) =>
      String(c[0]).includes("navigation"),
    ).length;
    obs.disabledAfter = button ? button.disabled : null;
    obs.posts = posts.slice();
    obs.dialog = obs.dialog && s.then === "none" ? true : obs.dialog;
    return obs;
  } finally {
    submitSpy.mockRestore();
    errorSpy.mockRestore();
    unload();
    unloadDialog();
    document.body.innerHTML = "";
    removeDialogStandIn();
  }
}

afterEach(() => {
  document.body.innerHTML = "";
  removeDialogStandIn();
  jest.restoreAllMocks();
});

describe("what the form says", () => {
  it("the real forms carry the marker and an empty live region", () => {
    const html = realForm();
    expect(html).toContain(`<form method="POST" action="${ACTION}"`);
    expect(html).toContain(CONFIRM_FETCH_ATTR);
    expect(html).toContain("data-confirm-fetch-error");
  });
});

describe("the dialog from a confirmation page", () => {
  it("asks first, shows the server's reasons and changes as text, and posts nothing yet", async () => {
    const o = await observe(CONFIRM_FETCH_SCRIPT, { then: "none" });
    expect(o.prevented).toBe(true);
    expect(o.fetches).toBe(1);
    expect(o.fetchUrl).toBe(ACTION);
    expect(o.fetchMethod).toBe("POST");
    expect(o.fetchHeader).toBe(CONFIRM_ONLY_VALUE);
    const body = new globalThis.URLSearchParams(o.fetchBody ?? "");
    expect(body.get("_csrf")).toBe("tok");
    expect(body.get("s_groupsEnabled")).toBe('{"on":false}');
    expect(o.dialog).toBe(true);
    expect(o.title).toBe("Confirm these changes");
    expect(o.items).toEqual([
      `Switching groups off: ${HOSTILE}. Everybody is moved first.`,
      "Groups: on to off",
    ]);
    expect(o.hostileAsText).toBe(true);
    expect(o.verb).toBe("Switch groups off");
    expect(o.posts).toEqual([]);
    expect(o.error).toBe("");
  });

  it("disables the trigger while the request is in flight and enables it after", async () => {
    const o = await observe(CONFIRM_FETCH_SCRIPT, { then: "none" });
    expect(o.disabledDuring).toBe(true);
    expect(o.disabledAfter).toBe(false);
  });

  it("go back posts nothing", async () => {
    const o = await observe(CONFIRM_FETCH_SCRIPT, { then: "go-back" });
    expect(o.dialog).toBe(true);
    expect(o.posts).toEqual([]);
  });

  it("confirm posts the server's own fields to the confirm route, once", async () => {
    const o = await observe(CONFIRM_FETCH_SCRIPT, { then: "confirm-twice" });
    expect(o.posts).toEqual([
      {
        action: CONFIRM_ACTION,
        method: "POST",
        fields: ["_csrf=tok", "token=signed.token"],
      },
    ]);
  });

  it("works the same for the Remove selected form", async () => {
    const { renderGroupSetForms } =
      await import("../../src/web/host-settings-groups.js");
    const html = renderGroupSetForms(
      {
        groupLabel: "Team",
        groups: [
          {
            key: "g_1",
            name: "A",
            marker: "",
            size: null,
            tag: "",
            kind: "team",
            memberCount: 0,
            hasChannel: false,
          },
          {
            key: "g_2",
            name: "B",
            marker: "",
            size: null,
            tag: "",
            kind: "team",
            memberCount: 0,
            hasChannel: false,
          },
        ],
        addKey: "g_3",
      } as never,
      ACTION,
      "tok",
    );
    const o = await observe(CONFIRM_FETCH_SCRIPT, {
      form: html,
      then: "confirm",
    });
    expect(o.verb).toBe("Remove selected");
    expect(o.posts).toHaveLength(1);
    expect(o.posts[0].action).toBe(CONFIRM_ACTION);
  });

  it("the opened dialog has no axe violations", async () => {
    installDialogStandIn();
    document.body.innerHTML = `<main>${realForm()}</main>`;
    const unloadDialog = load(CONFIRM_SCRIPT);
    const unload = load(CONFIRM_FETCH_SCRIPT);
    (window as unknown as { fetch: unknown }).fetch = () =>
      Promise.resolve(fakeResponse({}));
    try {
      document
        .querySelector("form")!
        .dispatchEvent(
          new window.Event("submit", { bubbles: true, cancelable: true }),
        );
      await flush();
      expect(document.querySelector("dialog.kb-dialog")).not.toBeNull();
      const results = await axe(document.body, {
        rules: { "color-contrast": { enabled: false } },
      });
      expect(results).toHaveNoViolations();
    } finally {
      unload();
      unloadDialog();
    }
  });
});

/** Every answer that is not the expected confirmation page. */
const BAD_ANSWERS: Array<[string, Answer]> = [
  ["a server error", { status: 500 }],
  ["a 403", { status: 403 }],
  ["a JSON body", { contentType: "application/json" }],
  ["no content type", { contentType: null }],
  ["a page without the server-only header", { pageHeader: null }],
  ["a page with another header value", { pageHeader: "yes" }],
  [
    "a page without the page marker",
    { html: confirmHtml().replace(/data-confirm-page="[^"]*"/, "") },
  ],
  [
    "a page with another marker value",
    {
      html: confirmHtml().replace(
        'data-confirm-page="live-settings"',
        'data-confirm-page="other"',
      ),
    },
  ],
  [
    "a confirm form that posts to another site",
    { html: confirmHtml({ action: "https://evil.example/settings-confirm" }) },
  ],
  [
    "a confirm form that posts to the same path on another site",
    { html: confirmHtml({ action: `https://evil.example${CONFIRM_ACTION}` }) },
  ],
  [
    "a confirm form that posts to another path of this site",
    { html: confirmHtml({ action: `${PANEL}/cancel` }) },
  ],
  [
    "a confirm form that posts to another event",
    {
      html: confirmHtml({
        action: "/me/events/65a000000000000000000002/host/settings-confirm",
      }),
    },
  ],
  [
    "a confirm form whose CSRF token is not this form's",
    { html: confirmHtml({ csrf: "other" }) },
  ],
  ["a confirm form with an empty token", { html: confirmHtml({ token: "" }) }],
  [
    "a confirm form with an extra field",
    {
      html: confirmHtml().replace(
        'name="token"',
        'name="extra" value="1"><input type="hidden" name="token"',
      ),
    },
  ],
  [
    "a confirm form that does not POST",
    { html: confirmHtml().replace('method="POST"', 'method="GET"') },
  ],
  ["a confirmation without reasons", { html: confirmHtml({ reasons: [] }) }],
  ["a confirmation without changes", { html: confirmHtml({ changes: [] }) }],
  ["a redirect that carries the confirm page", { redirected: true }],
  ["a redirect to another site", { redirected: true, url: "https://x.test/" }],
  ["a redirect to another page here", { redirected: true, url: "/me/" }],
  ["an opaque redirect", { type: "opaqueredirect", status: 0 }],
  ["a network failure", { reject: true }],
];

describe("any other answer: no dialog, nothing posted, a message", () => {
  for (const [name, answer] of BAD_ANSWERS) {
    it(`${name}`, async () => {
      const o = await observe(CONFIRM_FETCH_SCRIPT, {
        answer,
        then: "confirm",
      });
      expect(o.prevented).toBe(true);
      expect(o.dialog).toBe(false);
      expect(o.posts).toEqual([]);
      expect(o.navigations).toBe(0);
      expect(o.error).toContain("Reload the page");
      expect(o.disabledAfter).toBe(false);
    });
  }

  it("a redirect to this event's own panel (the server's flash) is shown, not posted", async () => {
    const o = await observe(CONFIRM_FETCH_SCRIPT, {
      answer: {
        redirected: true,
        url: `http://localhost${PANEL}?flash=err&msg=Nothing&sig=x`,
      },
      then: "confirm",
    });
    expect(o.dialog).toBe(false);
    expect(o.posts).toEqual([]);
    expect(o.navigations).toBe(1);
    expect(o.error).toBe("");
  });

  it("no dialog script on the page: nothing is shown, nothing is posted, the host is told", async () => {
    const o = await observe(CONFIRM_FETCH_SCRIPT, {
      loadDialog: false,
      then: "confirm",
    });
    expect(o.dialog).toBe(false);
    expect(o.posts).toEqual([]);
    expect(o.error).toContain("could not be shown");
  });

  it("a second submit while the first is in flight sends one request", async () => {
    const o = await observe(CONFIRM_FETCH_SCRIPT, {
      answer: { hold: true },
      doubleSubmit: true,
      then: "none",
    });
    expect(o.fetches).toBe(1);
    expect(o.dialog).toBe(true);
  });

  it("an action that is not a settings route is refused before any request", async () => {
    const o = await observe(CONFIRM_FETCH_SCRIPT, {
      form: realForm().replace(ACTION, "/me/events/x/host/cancel"),
      then: "none",
    });
    expect(o.fetches).toBe(0);
    expect(o.error).toContain("cannot be confirmed here");
    expect(o.posts).toEqual([]);
  });
});

describe("without what it needs, the form is left to the browser (the no-JavaScript route)", () => {
  it("no showModal: the form is not intercepted and no fetch is made", async () => {
    const o = await observe(CONFIRM_FETCH_SCRIPT, {
      showModal: false,
      then: "none",
    });
    expect(o.prevented).toBe(false);
    expect(o.fetches).toBe(0);
    expect(o.dialog).toBe(false);
  });

  it("a form without the marker is not intercepted", async () => {
    const o = await observe(CONFIRM_FETCH_SCRIPT, {
      form: realForm().replace(CONFIRM_FETCH_ATTR, ""),
      then: "none",
    });
    expect(o.prevented).toBe(false);
    expect(o.fetches).toBe(0);
  });
});

describe("CSP and sinks", () => {
  it("is a plain script string without inline-HTML or inline-handler sinks", () => {
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
      "importNode",
      "cloneNode",
    ]) {
      expect(CONFIRM_FETCH_SCRIPT).not.toContain(sink);
    }
  });
});

describe("mutation check on every guard", () => {
  type Mutation = [string, Array<[string, string]>];
  const mutations: Mutation[] = [
    [
      "submit is held back",
      [
        [
          "e.preventDefault();e.stopImmediatePropagation();if(inflight)return;",
          "if(inflight)return;",
        ],
      ],
    ],
    ["only marked forms", [["!f.hasAttribute('data-confirm-fetch')||", ""]]],
    ["needs showModal", [["typeof d.showModal==='function'&&", ""]]],
    [
      "only settings actions",
      [["!/\\/settings$/.test(act.pathname)", "false"]],
    ],
    ["the request says confirm only", [["headers[HEAD_ONLY]=ONLY;", ""]]],
    [
      "one request in flight",
      [
        [
          "e.stopImmediatePropagation();if(inflight)return;",
          "e.stopImmediatePropagation();",
        ],
      ],
    ],
    ["trigger is disabled", [["if(sub)sub.disabled=true;", ""]]],
    ["trigger is enabled again", [["if(sub)sub.disabled=false", "0"]]],
    [
      "a redirect is never a dialog",
      [
        [
          "if(r.redirected){var u=urlOf(r.url);",
          "if(false){var u=urlOf(r.url);",
        ],
        ["&&!r.redirected&&", "&&"],
      ],
    ],
    [
      "a redirect target must be this panel",
      [["u.origin===location.origin&&u.pathname===panel", "true"]],
    ],
    ["status must be 200", [["r.status===200&&", ""]]],
    [
      "content type must be html",
      [
        [
          "&&(r.headers.get('content-type')||'').toLowerCase().indexOf('text/html')===0",
          "",
        ],
      ],
    ],
    [
      "the server-only header is required",
      [["&&r.headers.get(HEAD_PAGE)===PAGE", ""]],
    ],
    [
      "the page marker value is checked",
      [["||sec.getAttribute('data-confirm-page')!==MARK", ""]],
    ],
    [
      "the confirm form posts",
      [
        [
          "if((cf.getAttribute('method')||'').toLowerCase()!=='post')return null;",
          "",
        ],
      ],
    ],
    [
      "same origin",
      [["u.origin!==location.origin||u.pathname!==want", "u.pathname!==want"]],
    ],
    ["the confirm route of this form", [["||u.pathname!==want", ""]]],
    ["exactly two fields", [["if(named.length!==2)return null;", ""]]],
    ["no empty token", [["||!csrf.value||!tok.value", ""]]],
    ["the CSRF token is this form's", [["||mine.value!==csrf.value", ""]]],
    [
      "reasons and changes are required",
      [["if(!why.length||!what.length)return null;", ""]],
    ],
    ["changes are shown too", [["items:why.concat(what)", "items:why"]]],
    ["the dialog must exist", [["if(!detail.handled)say(", "if(false)say("]]],
    ["confirm posts once", [["if(done)return;done=true;", ""]]],
    [
      "the post goes to the verified action",
      [["g.action=page.action;", "g.action='/x';"]],
    ],
    ["the token is copied", [["i.value=p[1];", "i.value='';"]]],
  ];

  const scenarios: Scenario[] = [
    { then: "confirm-twice" },
    { then: "go-back" },
    { showModal: false, then: "none" },
    { form: realForm().replace(CONFIRM_FETCH_ATTR, ""), then: "none" },
    {
      form: realForm().replace(ACTION, "/me/events/x/host/cancel"),
      then: "none",
    },
    { loadDialog: false, then: "confirm" },
    { answer: { hold: true }, doubleSubmit: true, then: "none" },
    ...BAD_ANSWERS.map(([, answer]): Scenario => ({ answer, then: "confirm" })),
    {
      answer: {
        redirected: true,
        url: `http://localhost${PANEL}?flash=err&msg=x&sig=y`,
      },
      then: "confirm",
    },
  ];

  async function battery(script: string): Promise<string> {
    const out: unknown[] = [];
    for (const s of scenarios) {
      try {
        out.push(await observe(script, s));
      } catch (err) {
        out.push(`threw: ${String(err)}`);
      }
    }
    return JSON.stringify(out);
  }

  it("the real script gives the expected battery (nothing opens or posts for a bad answer)", async () => {
    const real = JSON.parse(await battery(CONFIRM_FETCH_SCRIPT)) as Observed[];
    // Only the happy scenarios may show a dialog or post.
    const happy = real.filter((o) => typeof o !== "string" && o.dialog);
    expect(happy.length).toBe(3);
    const posted = real.filter((o) => o.posts.length > 0);
    expect(posted).toHaveLength(1);
  }, 60_000);

  for (const [name, replacements] of mutations) {
    it(`notices when "${name}" is broken`, async () => {
      let mutated = CONFIRM_FETCH_SCRIPT;
      for (const [from, to] of replacements) {
        expect(CONFIRM_FETCH_SCRIPT).toContain(from);
        mutated = mutated.split(from).join(to);
      }
      expect(mutated).not.toBe(CONFIRM_FETCH_SCRIPT);
      const [real, broken] = [
        await battery(CONFIRM_FETCH_SCRIPT),
        await battery(mutated),
      ];
      expect(broken).not.toBe(real);
    }, 60_000);
  }
});
