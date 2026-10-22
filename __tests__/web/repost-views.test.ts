/**
 * @jest-environment <rootDir>/__tests__/jsdom-node-env.cjs
 */

/* global Document, DOMParser, HTMLButtonElement, HTMLElement, HTMLInputElement */
/**
 * The Re-post cards on the Quotes, Notices and Rules pages (#1428). Markup is
 * checked through a DOM, never with regular expressions over HTML.
 */

import { describe, it, expect } from "@jest/globals";
import { ChannelType } from "discord.js";
import {
  renderNoticesPage,
  renderQuotesPage,
  renderRepostCard,
} from "../../src/web/admin-views.js";
import { renderRulesPage } from "../../src/web/rules-page.js";
import { renderManagedValue } from "../../src/web/setting-controls.js";
import {
  MANAGED_REPOST_LINKS,
  repostHrefFor,
} from "../../src/web/managed-messages.js";
import {
  NEUTRAL_CONFIRM_ACTIONS,
  isNeutralConfirmAction,
} from "../../src/web/html.js";

const COMMON = { csrfToken: "tok", remainingMs: 60_000 };
const parse = (html: string): Document =>
  new DOMParser().parseFromString(html, "text/html");
const CHANNEL = { name: "chan", id: "c1", type: ChannelType.GuildText };

function quotes(over: Record<string, unknown> = {}): Document {
  return parse(
    renderQuotesPage({
      ...COMMON,
      enabled: true,
      channel: CHANNEL,
      headerMessageId: "900000000000000001",
      settingRows: [],
      maxLength: 1000,
      rows: [],
      total: 0,
      page: 1,
      pageSize: 25,
      search: "",
      ...over,
    } as never),
  );
}

function notices(over: Record<string, unknown> = {}): Document {
  return parse(
    renderNoticesPage({
      ...COMMON,
      enabled: true,
      channel: CHANNEL,
      total: 0,
      headerMessageId: "900000000000000002",
      textChannels: [],
      settingRows: [],
      groups: [],
      categoryOptions: [],
      ...over,
    } as never),
  );
}

function rules(over: Record<string, unknown> = {}): Document {
  return parse(
    renderRulesPage({
      ...COMMON,
      enabled: true,
      channelId: "100000000000000010",
      roleId: "100000000000000011",
      messagePosted: true,
      messageId: "900000000000000003",
      accepted: 0,
      native: { screening: false, community: false },
      intentMissing: false,
      plan: null,
      channels: [],
      roleName: null,
      unavailable: null,
      options: { createRole: false, grantExisting: false, gateChannelIds: [] },
      jobId: null,
      ...over,
    } as never),
  );
}

const PAGES = [
  {
    name: "Quotes",
    doc: quotes,
    anchor: "repost-header",
    action: "/admin/quotes/header/repost",
    id: "900000000000000001",
    blocked: [
      [{ enabled: false }, "Turn on Quotes first."],
      [{ headerEnabled: false }, "switched off"],
      [{ channel: null }, "Set the quote channel first."],
    ],
  },
  {
    name: "Notices",
    doc: notices,
    anchor: "repost-header",
    action: "/admin/notices/header/repost",
    id: "900000000000000002",
    blocked: [
      [{ enabled: false }, "Turn on Notices first."],
      [{ headerEnabled: false }, "switched off"],
      [{ channel: null }, "Set the notices channel first."],
    ],
  },
  {
    name: "Rules",
    doc: rules,
    anchor: "repost-message",
    action: "/admin/rules/repost",
    id: "900000000000000003",
    blocked: [
      [{ enabled: false }, "Turn on Rules acceptance in Settings first."],
      [{ channelId: "" }, "Set the rules channel first."],
    ],
  },
] as const;

describe.each(PAGES)("$name page Re-post card", (p) => {
  it("is a confirm-gated POST form on the page's own card, with the CSRF token", () => {
    const doc = p.doc();
    const card = doc.getElementById(p.anchor);
    expect(card).not.toBeNull();
    const form = card!.querySelector("form") as HTMLElement;
    expect(form.getAttribute("method")).toBe("POST");
    expect(form.getAttribute("action")).toBe(p.action);
    expect(form.getAttribute("data-confirm")).toMatch(/^Re-post /);
    expect(form.querySelector('input[name="_csrf"]')).not.toBeNull();
    // Deleting a message is not routine: the confirm stays the red default.
    expect(form.hasAttribute("data-confirm-tone")).toBe(false);
    expect(isNeutralConfirmAction(p.action)).toBe(false);
    const list = JSON.parse(form.getAttribute("data-confirm-list") ?? "[]");
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.join(" ")).toMatch(/old (header|message)/i);
  });

  it("sends back the id the page showed, so a double submit re-posts once", () => {
    const hidden = p
      .doc()
      .querySelector(
        `#${p.anchor} input[name="expectedId"]`,
      ) as HTMLInputElement;
    expect(hidden.value).toBe(p.id);
  });

  it("enables the button when the feature is ready", () => {
    const button = p
      .doc()
      .querySelector(`#${p.anchor} button[type="submit"]`) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it.each(p.blocked.map((b) => [JSON.stringify(b[0]), b] as const))(
    "turns the button off and says why when %s",
    (_label, [over, reason]) => {
      const doc = p.doc(over as Record<string, unknown>);
      const button = doc.querySelector(
        `#${p.anchor} button[type="submit"]`,
      ) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(doc.getElementById(p.anchor)!.textContent).toContain(reason);
    },
  );
});

describe("renderRepostCard", () => {
  it("escapes everything it was given", () => {
    const html = renderRepostCard({
      id: 'a"b',
      heading: "<h>",
      intro: "<i>",
      action: "/x",
      csrfInput: "",
      messageId: '"><script>',
      buttonLabel: "<b>",
      confirmText: '"><x>',
      consequences: ["<c>"],
      blockedReason: "<r>",
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<h>");
    expect(html).not.toContain("<r>");
  });

  it("says so when nothing is posted yet", () => {
    const html = renderRepostCard({
      id: "x",
      heading: "H",
      intro: "I",
      action: "/x",
      csrfInput: "",
      messageId: "",
      buttonLabel: "B",
      confirmText: "C",
      consequences: [],
      blockedReason: null,
    });
    expect(html).toContain("Not posted yet.");
  });
});

describe("the managed row's Re-post link", () => {
  it("points each managed key at the card that holds its button", () => {
    expect(MANAGED_REPOST_LINKS["quotes.header_message_id"]).toBe(
      "/admin/quotes#repost-header",
    );
    expect(repostHrefFor("notices.header_message_id")).toBe(
      "/admin/notices#repost-header",
    );
    expect(repostHrefFor("rules.message_id")).toBe(
      "/admin/rules#repost-message",
    );
    expect(repostHrefFor("quotes.max_length")).toBeUndefined();
    expect(repostHrefFor("constructor")).toBeUndefined();
  });

  it("every link target exists as a card on its page", () => {
    expect(quotes().getElementById("repost-header")).not.toBeNull();
    expect(notices().getElementById("repost-header")).not.toBeNull();
    expect(rules().getElementById("repost-message")).not.toBeNull();
  });

  it("renders as a plain link, never a form, and only when a message exists", () => {
    const doc = parse(
      renderManagedValue("123", undefined, "/admin/quotes#repost-header"),
    );
    const link = doc.querySelector("a") as HTMLElement;
    expect(link.getAttribute("href")).toBe("/admin/quotes#repost-header");
    expect(link.textContent).toBe("Re-post");
    expect(doc.querySelector("form")).toBeNull();
    expect(
      parse(renderManagedValue("", undefined, "/admin/quotes#repost-header"))
        .body.innerHTML,
    ).not.toContain("<a ");
  });

  it("no Re-post action is on the neutral-confirm list", () => {
    for (const re of NEUTRAL_CONFIRM_ACTIONS) {
      expect(re.test("/admin/quotes/header/repost")).toBe(false);
      expect(re.test("/admin/notices/header/repost")).toBe(false);
      expect(re.test("/admin/rules/repost")).toBe(false);
    }
  });
});
