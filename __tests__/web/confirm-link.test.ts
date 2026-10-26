/**
 * @jest-environment <rootDir>/__tests__/jsdom-node-env.cjs
 */

/**
 * Delete… (Channel manager) and Restore… (Adoption history) ask in the shared
 * dialog (#1536). The links stay links to the confirmation pages; with
 * JavaScript the script fetches the page with GET, checks that it is the
 * expected confirmation page, and shows its title, consequences and options in
 * the shared `kb-dialog` (`CONFIRM_SCRIPT`). Only the dialog's confirm button
 * posts the page's own form fields.
 *
 * Driven against the REAL renderers (the a11y fixtures) and the real scripts.
 * Every answer that is not the expected confirmation page ends in a normal
 * navigation to the link (today's page), never in a dialog or a post.
 */
import { describe, it, expect, jest, afterEach } from "@jest/globals";
import { axe, toHaveNoViolations } from "jest-axe";
import { CONFIRM_SCRIPT } from "../../src/web/html.js";
import {
  CONFIRM_LINK_SCRIPT,
  CONFIRM_PAGE_HEADER,
} from "../../src/web/confirm-fetch.js";
import { allPages } from "./a11y-pages.js";
import type { ManagedChannelView } from "../../src/web/channel-manager.js";
import { renderChannelDeleteConfirmPage } from "../../src/web/channel-manager-view.js";
import { installDocumentForAxe } from "./a11y-dom.js";

expect.extend(toHaveNoViolations);

const page = (name: string): string => {
  const p = allPages().find((x) => x.name === name);
  if (!p) throw new Error(`no fixture ${name}`);
  return p.html;
};

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

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

const GENERAL: ManagedChannelView = {
  id: "100000000000000002",
  name: "general",
  kind: "text",
  typeLabel: "text",
  parentId: "100000000000000001",
  position: 0,
  topic: "Say hi",
  userLimit: null,
  bitrate: null,
};

const DELETE_LINK = "a[data-confirm-link=channel-delete]";
const RESTORE_LINK = "a[data-confirm-link=snapshot-restore]";

interface Answer {
  status?: number;
  contentType?: string | null;
  header?: string | null;
  redirected?: boolean;
  html?: string;
  reject?: boolean;
}

interface Run {
  prevented: boolean;
  fetched: Array<{ url: string; method: string }>;
  dialog: boolean;
  title: string | null;
  items: string[];
  verb: string | null;
  okClass: string | null;
  options: string[];
  namedBoxes: number;
  navigations: number;
  buttons: string[];
  posts: Array<{ action: string; method: string; fields: string[] }>;
}

interface Scenario {
  list: string;
  link: string;
  /** Pick the link whose href equals this (default: the first). */
  href?: string;
  answer: Answer;
  kind: "channel-delete" | "snapshot-restore";
  then?: "confirm" | "go-back" | "none";
  tick?: boolean;
  showModal?: boolean;
  clickInit?: ConstructorParameters<typeof window.MouseEvent>[1];
  loadDialog?: boolean;
}

function confirmFor(kind: Scenario["kind"]): string {
  return kind === "channel-delete"
    ? page("Channel delete confirmation")
    : page("Restore snapshot");
}

function answerHtml(s: Scenario): string {
  return s.answer.html ?? confirmFor(s.kind);
}

async function run(s: Scenario): Promise<Run> {
  if (s.showModal === false) removeDialogStandIn();
  else installDialogStandIn();
  installDocumentForAxe(s.list);
  const unloadDialog = s.loadDialog === false ? () => {} : load(CONFIRM_SCRIPT);
  const unload = load(CONFIRM_LINK_SCRIPT);
  const links = Array.from(document.querySelectorAll<HTMLElement>(s.link));
  const link = s.href
    ? links.find((l) => l.getAttribute("href") === s.href)
    : links[0];
  if (!link) throw new Error("link not found");
  const posts: Run["posts"] = [];
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
  const fetched: Run["fetched"] = [];
  (window as unknown as { fetch: unknown }).fetch = (
    u: string,
    i?: RequestInit,
  ) => {
    fetched.push({ url: String(u), method: i?.method ?? "GET" });
    if (s.answer.reject) return Promise.reject(new Error("network"));
    const headers: Record<string, string> = {};
    const ct =
      s.answer.contentType === undefined
        ? "text/html; charset=utf-8"
        : s.answer.contentType;
    if (ct !== null) headers["content-type"] = ct;
    const h = s.answer.header === undefined ? s.kind : s.answer.header;
    if (h !== null) headers[CONFIRM_PAGE_HEADER.toLowerCase()] = h;
    return Promise.resolve({
      status: s.answer.status ?? 200,
      redirected: s.answer.redirected ?? false,
      type: "basic",
      url: `http://localhost${link.getAttribute("href")}`,
      headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
      text: async () => answerHtml(s),
    });
  };
  try {
    const ev = new window.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      ...s.clickInit,
    });
    link.dispatchEvent(ev);
    const out = {} as Run;
    out.prevented = ev.defaultPrevented;
    await flush();
    const d = document.querySelector<HTMLDialogElement>("dialog.kb-dialog");
    out.dialog = d !== null;
    out.title = d?.querySelector(".kb-dialog__title")?.textContent ?? null;
    out.items = Array.from(d?.querySelectorAll("li") ?? []).map(
      (l) => l.textContent ?? "",
    );
    out.options = Array.from(
      d?.querySelectorAll<HTMLInputElement>("input[type=checkbox]") ?? [],
    ).map((c) => `${c.closest("label")?.textContent?.trim()}`);
    // The dialog's own checkbox is not a form field: only the script posts it.
    out.namedBoxes = Array.from(
      d?.querySelectorAll<HTMLInputElement>("input[name]") ?? [],
    ).length;
    const foot = d?.querySelectorAll<HTMLElement>(".kb-dialog__foot button");
    out.buttons = Array.from(foot ?? []).map((b) => b.textContent ?? "");
    out.verb = foot && foot[1] ? (foot[1].textContent ?? null) : null;
    out.okClass = foot && foot[1] ? foot[1].className : null;
    if (d && posts.length > 0) throw new Error("posted before the confirm");
    if (d && s.tick) {
      d.querySelector<HTMLInputElement>("input[type=checkbox]")!.click();
    }
    if (d && s.then === "go-back") foot![0].click();
    if (d && s.then === "confirm") foot![1].click();
    out.fetched = fetched;
    out.navigations = errorSpy.mock.calls.filter((c) =>
      String(c[0]).includes("navigation"),
    ).length;
    out.posts = posts;
    return out;
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

const channelScenario = (over: Partial<Scenario> = {}): Scenario => {
  const action = /action="(\/admin\/channels\/[^"]+\/delete)"/.exec(
    page("Channel delete confirmation"),
  )![1];
  return {
    list: page("Channel manager"),
    link: DELETE_LINK,
    href: action,
    kind: "channel-delete",
    answer: {},
    then: "none",
    ...over,
  };
};

const restoreScenario = (over: Partial<Scenario> = {}): Scenario => ({
  list: page("Adoption history"),
  link: RESTORE_LINK,
  kind: "snapshot-restore",
  answer: {},
  then: "none",
  ...over,
});

describe("what the list pages render", () => {
  it("keeps Delete… and Restore… as links to the confirmation pages, marked for the script", () => {
    const list = page("Channel manager");
    expect(list).toMatch(
      /<a class="[^"]*btn-danger[^"]*" href="\/admin\/channels\/\d+\/delete" data-confirm-link="channel-delete"/,
    );
    const hist = page("Adoption history");
    expect(hist).toMatch(
      /href="\/admin\/adopt\/history\/a{24}\/restore"[^>]*data-confirm-link="snapshot-restore"/,
    );
  });

  it("loads the link script only on pages that have such a link", () => {
    expect(page("Channel manager")).toContain(CONFIRM_LINK_SCRIPT);
    expect(page("Adoption history")).toContain(CONFIRM_LINK_SCRIPT);
    expect(page("Permissions")).not.toContain(CONFIRM_LINK_SCRIPT);
    expect(page("Channel manager (server unreadable)")).not.toContain(
      CONFIRM_LINK_SCRIPT,
    );
  });
});

describe("Channel manager: Delete… opens the dialog", () => {
  it("asks with the title, the consequences and the verb in danger, and posts nothing yet", async () => {
    const o = await run(channelScenario());
    expect(o.prevented).toBe(true);
    expect(o.fetched).toHaveLength(1);
    expect(o.fetched[0].method).toBe("GET");
    expect(o.fetched[0].url).toBe(channelScenario().href);
    expect(o.dialog).toBe(true);
    expect(o.title).toBe("Delete general?");
    expect(o.items).toEqual([
      "Its messages are deleted with it.",
      "This can't be undone.",
    ]);
    expect(o.verb).toBe("Delete permanently");
    expect(o.okClass).toContain("kb-btn--danger");
    expect(o.options).toEqual([]);
    expect(o.posts).toEqual([]);
    expect(o.navigations).toBe(0);
  });

  it("posts the page's own CSRF and confirmation token to the delete route on confirm", async () => {
    const o = await run(channelScenario({ then: "confirm" }));
    expect(o.posts).toEqual([
      {
        action: channelScenario().href,
        method: "POST",
        fields: ["_csrf=csrf-token", "confirm=token"],
      },
    ]);
  });

  it("posts nothing on go back", async () => {
    const o = await run(channelScenario({ then: "go-back" }));
    expect(o.dialog).toBe(true);
    expect(o.posts).toEqual([]);
  });
});

describe("Adoption history: Restore… opens an Options dialog", () => {
  it("lists the steps, the engine's note, the repairs and the interrupted steps, with the checkbox inside", async () => {
    const o = await run(restoreScenario());
    expect(o.title).toBe("Restore this snapshot?");
    expect(o.items).toEqual([
      "Messages and pins cannot be restored.",
      "Delete #old (destructive)",
      "Make #news read-only",
      "2 follow-up repair(s) from an earlier restore are still pending (permissions on recreated roles, channels placed back under recreated categories). Restoring again retries them.",
      "1 more step(s) were interrupted (started but not recorded as finished, or in flight). The restore checks Discord first and also reverts any that did go through.",
    ]);
    expect(o.options).toEqual([
      "Also delete the 2 role(s) this plan created (1 of them only if the restore finds the role on the server). Unticked, they are left in place (members who hold them keep them).",
    ]);
    expect(o.namedBoxes).toBe(0);
    expect(o.verb).toBe("Restore this snapshot");
    expect(o.okClass).toContain("kb-btn--danger");
    expect(o.posts).toEqual([]);
  });

  it("posts the checkbox only when it is ticked", async () => {
    const unticked = await run(restoreScenario({ then: "confirm" }));
    expect(unticked.posts).toHaveLength(1);
    expect(unticked.posts[0].method).toBe("POST");
    expect(unticked.posts[0].action).toMatch(
      /^\/admin\/adopt\/history\/a{24}\/restore$/,
    );
    expect(unticked.posts[0].fields).toEqual(["_csrf=csrf-token"]);
    const ticked = await run(restoreScenario({ then: "confirm", tick: true }));
    expect(ticked.posts[0].fields).toEqual([
      "_csrf=csrf-token",
      "deleteCreatedRoles=1",
    ]);
  });

  it("falls back to the page when the snapshot cannot be restored", async () => {
    const o = await run(
      restoreScenario({
        answer: {
          html: page("Restore snapshot (nothing left, not restorable)"),
        },
      }),
    );
    expect(o.dialog).toBe(false);
    expect(o.navigations).toBe(1);
    expect(o.posts).toEqual([]);
  });
});

describe("Channel manager: a delete that is refused says why, in a dialog with no confirm button", () => {
  const refused = (over: Partial<Scenario> = {}): Scenario =>
    channelScenario({
      answer: {
        header: "channel-delete-refused",
        html: page("Channel delete refused"),
      },
      ...over,
    });

  it("shows the reason as the only content and offers only go back", async () => {
    const o = await run(refused());
    expect(o.dialog).toBe(true);
    expect(o.title).toBe("Can't delete Lobby");
    expect(o.items).toEqual([
      'KoolBot manages "Lobby": it is the voicechannels.lobby.channel_id setting.',
    ]);
    expect(o.buttons).toEqual(["Go back"]);
    expect(o.posts).toEqual([]);
    expect(o.navigations).toBe(0);
  });

  it.each([
    ["a channel that is gone", { channel: null }, "Can't delete this channel"],
    [
      "a missing Manage Channels permission",
      { botCanManage: false },
      "Can't delete general",
    ],
    [
      "a category that still holds channels",
      {
        verdict: {
          ok: false as const,
          reasons: [],
          message:
            '"Community" still holds 2 channels. Move or delete them first.',
        },
      },
      "Can't delete general",
    ],
  ])("%s", async (_n, over, title) => {
    const general = GENERAL;
    const html = renderChannelDeleteConfirmPage({
      csrfToken: "csrf-token",
      remainingMs: 900_000,
      navFeatureStatus: {},
      channel: general,
      verdict: { ok: true },
      confirmToken: "token",
      botCanManage: true,
      ...over,
    });
    const o = await run(
      refused({ answer: { header: "channel-delete-refused", html } }),
    );
    expect(o.title).toBe(title);
    expect(o.buttons).toEqual(["Go back"]);
    expect(o.items).toHaveLength(1);
    expect(o.posts).toEqual([]);
  });

  it("is not accepted for a kind without refusals, or without the refusal header", async () => {
    const wrongKind = await run(
      restoreScenario({
        answer: {
          header: "snapshot-restore-refused",
          html: page("Channel delete refused"),
        },
      }),
    );
    expect(wrongKind.dialog).toBe(false);
    expect(wrongKind.navigations).toBe(1);
    const noHeader = await run(
      refused({
        answer: { header: null, html: page("Channel delete refused") },
      }),
    );
    expect(noHeader.dialog).toBe(false);
    expect(noHeader.navigations).toBe(1);
  });
});

describe("hostile text stays text", () => {
  it("shows a channel name as text, never as markup", async () => {
    const hostile = `<img src=x onerror="alert(1)">`;
    const html = page("Channel delete confirmation").replace(
      /general/g,
      hostile
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;"),
    );
    const o = await run(channelScenario({ answer: { html } }));
    expect(o.dialog).toBe(true);
    expect(o.title).toBe(`Delete ${hostile}?`);
    expect(document.querySelector("img")).toBeNull();
  });
});

describe("anything but the expected confirmation page navigates to the link", () => {
  const swap = (from: string | RegExp, to: string): string =>
    page("Channel delete confirmation").replace(from, to);
  const cases: Array<[string, Partial<Scenario>]> = [
    ["a refusal page (no confirmation header)", { answer: { header: null } }],
    [
      "the header of the other page",
      { answer: { header: "snapshot-restore" } },
    ],
    ["a server error", { answer: { status: 500 } }],
    ["a redirect (flash)", { answer: { redirected: true } }],
    ["a non-HTML answer", { answer: { contentType: "text/plain" } }],
    ["a failed request", { answer: { reject: true } }],
    [
      "a form that posts somewhere else",
      {
        answer: {
          html: swap(
            /action="\/admin\/channels\/\d+\/delete"/,
            'action="/admin/channels/1/purge"',
          ),
        },
      },
    ],
    [
      "a form that posts to another origin",
      {
        answer: {
          html: swap(
            /action="\/admin\/channels\/\d+\/delete"/,
            'action="https://evil.example/admin/channels/1/delete"',
          ),
        },
      },
    ],
    [
      "a form with an extra field",
      {
        answer: {
          html: swap(
            '<input type="hidden" name="confirm"',
            '<input type="hidden" name="extra" value="1"><input type="hidden" name="confirm"',
          ),
        },
      },
    ],
    [
      "a form with another CSRF token",
      {
        answer: {
          html: swap(
            /name="_csrf" value="csrf-token">(\s*<input type="hidden" name="confirm")/,
            'name="_csrf" value="other">$1',
          ),
        },
      },
    ],
    [
      "a form without the confirmation token",
      {
        answer: {
          html: swap(/<input type="hidden" name="confirm"[^>]*>/, ""),
        },
      },
    ],
    [
      "a page with no consequences listed",
      { answer: { html: swap(/data-confirm-item/g, "data-x") } },
    ],
    [
      "a page for another kind of confirmation",
      {
        answer: {
          html: swap(
            'data-confirm-link-page="channel-delete"',
            'data-confirm-link-page="snapshot-restore"',
          ),
        },
      },
    ],
  ];
  it.each(cases)("%s", async (_name, over) => {
    const o = await run(channelScenario(over));
    expect(o.dialog).toBe(false);
    expect(o.navigations).toBe(1);
    expect(o.posts).toEqual([]);
  });

  it("a checkbox the page was not expected to have is refused", async () => {
    const html = page("Restore snapshot").replace(
      'name="deleteCreatedRoles"',
      'name="somethingElse"',
    );
    const o = await run(restoreScenario({ answer: { html } }));
    expect(o.dialog).toBe(false);
    expect(o.navigations).toBe(1);
  });
});

describe("when the link should behave as a link", () => {
  it.each([
    ["ctrl-click", { ctrlKey: true }],
    ["meta-click", { metaKey: true }],
    ["shift-click", { shiftKey: true }],
    ["middle click", { button: 1 }],
  ])("%s is left alone", async (_n, clickInit) => {
    const o = await run(channelScenario({ clickInit }));
    expect(o.prevented).toBe(false);
    expect(o.fetched).toHaveLength(0);
    expect(o.dialog).toBe(false);
  });

  it("is left alone without <dialog>.showModal()", async () => {
    const o = await run(channelScenario({ showModal: false }));
    expect(o.prevented).toBe(false);
    expect(o.fetched).toHaveLength(0);
  });

  it("navigates, and posts nothing, when the shared dialog script is not loaded", async () => {
    const o = await run(channelScenario({ loadDialog: false }));
    expect(o.dialog).toBe(false);
    expect(o.posts).toEqual([]);
    expect(o.navigations).toBe(1);
  });
});

describe("accessibility of the dialogs", () => {
  // The dialog is built at runtime, so the static fixtures in `a11y-pages.ts`
  // (scripts are dropped by `installDocumentForAxe`) cannot hold it. Open it
  // in the real page and scan the whole document, as page-level rules need.
  const cases: Array<[string, string, string, string, string]> = [
    [
      "Delete… (Confirm)",
      "Channel manager",
      DELETE_LINK,
      "channel-delete",
      "Channel delete confirmation",
    ],
    [
      "Delete… refused (explanation only)",
      "Channel manager",
      DELETE_LINK,
      "channel-delete-refused",
      "Channel delete refused",
    ],
    [
      "Restore… (Options)",
      "Adoption history",
      RESTORE_LINK,
      "snapshot-restore",
      "Restore snapshot",
    ],
  ];
  it.each(cases)(
    "has no axe violations with the %s dialog open",
    async (_n, list, link, header, confirm) => {
      installDialogStandIn();
      installDocumentForAxe(page(list));
      const unloadDialog = load(CONFIRM_SCRIPT);
      const unload = load(CONFIRM_LINK_SCRIPT);
      (window as unknown as { fetch: unknown }).fetch = () =>
        Promise.resolve({
          status: 200,
          redirected: false,
          type: "basic",
          url: "http://localhost/x",
          headers: {
            get: (n: string) =>
              n.toLowerCase() === "content-type"
                ? "text/html"
                : n.toLowerCase() === CONFIRM_PAGE_HEADER.toLowerCase()
                  ? header
                  : null,
          },
          text: async () => page(confirm),
        });
      try {
        const own = /action="(\/admin\/channels\/[^"]+\/delete)"/.exec(
          page(confirm),
        );
        document
          .querySelector<HTMLElement>(own ? `a[href="${own[1]}"]` : link)!
          .dispatchEvent(
            new window.MouseEvent("click", { bubbles: true, cancelable: true }),
          );
        await flush();
        expect(document.querySelector("dialog.kb-dialog")).not.toBeNull();
        expect(await axe(document.documentElement)).toHaveNoViolations();
      } finally {
        unload();
        unloadDialog();
        removeDialogStandIn();
      }
    },
  );
});
