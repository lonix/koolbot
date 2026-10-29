/**
 * @jest-environment <rootDir>/__tests__/jsdom-node-env.cjs
 */

/* global Document, DOMParser, Element */
/**
 * The app shell (#1317): top bar, scope badges, the sidebar per scope and the
 * "why you see this" line. Markup is read through the DOM, never filtered with
 * regular expressions.
 */

import fs from "node:fs";
import { describe, it, expect, jest } from "@jest/globals";
import {
  SCOPE_INFO,
  SHELL_NAV,
  hasSideNav,
  renderScopeWhy,
  renderSideNav,
  renderTopBar,
  resolveShellFeatures,
  scopeOfPath,
  sectionsFor,
  type ShellNavItem,
  type ShellViewer,
} from "../../src/web/app-shell.js";
import { getBotVersion } from "../../src/utils/version.js";
import { formatVersion } from "../../src/utils/semver.js";
import { renderUserPage } from "../../src/web/user-layout.js";
import { renderAdminPage } from "../../src/web/admin-layout.js";

const parse = (html: string): Document =>
  new DOMParser().parseFromString(html, "text/html");

const text = (el: Element | null | undefined): string => el?.textContent ?? "";

const member: ShellViewer = {
  displayName: "Kari",
  role: "user",
  scopes: ["member"],
};
const host: ShellViewer = { ...member, scopes: ["member", "host"] };
const moderator: ShellViewer = { ...member, scopes: ["member", "moderator"] };
const both: ShellViewer = {
  ...member,
  scopes: ["member", "host", "moderator"],
};
const admin: ShellViewer = {
  displayName: "Ola",
  role: "admin",
  scopes: ["member", "host", "moderator"],
};

/** A registry where every page is built, to prove each scope's section. */
const BUILT: ShellNavItem[] = SHELL_NAV.map((item) => ({
  ...item,
  available: true,
  featureKey: undefined,
}));

const COMMON = { csrfToken: "csrf", remainingMs: 600_000 };

function userPage(
  viewer: ShellViewer | undefined,
  over: {
    active?: string;
    navRegistry?: readonly ShellNavItem[];
    isAdmin?: boolean;
  } = {},
): Document {
  return parse(
    renderUserPage({
      title: "Overview",
      active: over.active ?? "/me/",
      body: "<p id='body'>Body</p>",
      isAdmin: over.isAdmin ?? viewer?.role === "admin",
      viewer,
      navRegistry: over.navRegistry,
      ...COMMON,
    }),
  );
}

const headings = (doc: Document): string[] =>
  Array.from(doc.querySelectorAll(".kb-sidenav__heading")).map((h) =>
    text(h).trim(),
  );
const badges = (doc: Document): string[] =>
  Array.from(doc.querySelectorAll(".kb-topbar .kb-scope")).map((b) =>
    text(b).trim(),
  );
const links = (doc: Document): string[] =>
  Array.from(doc.querySelectorAll(".kb-sidenav a")).map((a) => text(a).trim());

describe("nav registry rules", () => {
  it("never renders an item whose page is not built", () => {
    // Every feature on, so a feature-gated page that is built (New event, #1305)
    // is not hidden for another reason.
    const features = Object.fromEntries(
      SHELL_NAV.flatMap((i) => (i.featureKey ? [[i.featureKey, true]] : [])),
    );
    const sections = sectionsFor(admin, SHELL_NAV, features);
    const shown = sections.flatMap((s) => s.items.map((i) => i.href));
    for (const item of SHELL_NAV) {
      expect(shown.includes(item.href)).toBe(item.available);
    }
  });

  it("keeps every href unique, under /me, and inside its scope's area", () => {
    const hrefs = SHELL_NAV.map((i) => i.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const item of SHELL_NAV) {
      expect(item.href.startsWith("/me/")).toBe(true);
      expect(scopeOfPath(item.href)).toBe(item.scope);
    }
  });

  it("hides a feature-gated item until the feature is on", () => {
    const registry: ShellNavItem[] = [
      ...BUILT.filter((i) => i.label !== "Tickets"),
      {
        scope: "moderator",
        label: "Tickets",
        href: "/me/moderation/tickets",
        icon: "ticket",
        featureKey: "tickets.enabled",
        available: true,
      },
    ];
    const labels = (status?: { "tickets.enabled"?: boolean }): string[] =>
      sectionsFor(moderator, registry, status)
        .flatMap((s) => s.items)
        .map((i) => i.label);
    expect(labels()).not.toContain("Tickets");
    expect(labels({ "tickets.enabled": false })).not.toContain("Tickets");
    expect(labels({ "tickets.enabled": true })).toContain("Tickets");
  });

  it("shows a section only to the people who hold its scope, Member first", () => {
    const scopesOf = (v: ShellViewer): string[] =>
      sectionsFor(v, BUILT).map((s) => s.scope);
    expect(scopesOf(member)).toEqual(["member"]);
    expect(scopesOf(host)).toEqual(["member", "host"]);
    expect(scopesOf(moderator)).toEqual(["member", "moderator"]);
    expect(scopesOf(both)).toEqual(["member", "host", "moderator"]);
    expect(scopesOf(admin)).toEqual(["member", "host", "moderator"]);
  });

  it("drops a section with nothing to show and needs two sections for a sidebar", () => {
    // A moderator has Moderation (Mod log, Command audit) beside You.
    expect(hasSideNav(sectionsFor(moderator))).toBe(true);
    expect(hasSideNav(sectionsFor(member))).toBe(false);
    expect(hasSideNav(sectionsFor(member, BUILT))).toBe(false);
    // A section with no visible item drops out, leaving one: no sidebar.
    const noModeration = SHELL_NAV.map((i) =>
      i.scope === "moderator" ? { ...i, available: false } : i,
    );
    expect(hasSideNav(sectionsFor(moderator, noModeration))).toBe(false);
  });

  it("names the sections after the scopes", () => {
    expect(SCOPE_INFO.member.section).toBe("You");
    expect(SCOPE_INFO.host.section).toBe("Hosting");
    expect(SCOPE_INFO.moderator.section).toBe("Moderation");
  });
});

describe("sidebar per scope (non-admin /me)", () => {
  it("gives a Member-only person no sidebar and one centred column", () => {
    const doc = userPage(member, { navRegistry: BUILT });
    expect(doc.querySelector(".kb-sidenav")).toBeNull();
    expect(doc.querySelector(".kb-shell")).toBeNull();
    expect(doc.querySelector("body > main#main.kb-member")).not.toBeNull();
    // The My preferences tabs stay in that column.
    expect(doc.querySelector("nav.kb-tabs")).not.toBeNull();
    expect(badges(doc)).toEqual([]);
  });

  it("gives a host You and Hosting only", () => {
    const doc = userPage(host, { navRegistry: BUILT });
    expect(headings(doc)).toEqual(["You", "Hosting"]);
    expect(links(doc)).toEqual([
      "My preferences",
      "Your events",
      "New event",
      "Event presets",
    ]);
    expect(badges(doc)).toEqual(["Event host"]);
  });

  it("gives a moderator You and Moderation only", () => {
    const doc = userPage(moderator, { navRegistry: BUILT });
    expect(headings(doc)).toEqual(["You", "Moderation"]);
    expect(links(doc)).toEqual([
      "My preferences",
      "Mod log",
      "Command audit",
      "Tickets",
    ]);
    expect(badges(doc)).toEqual(["Moderator"]);
  });

  it("gives a host who moderates all three sections", () => {
    const doc = userPage(both, { navRegistry: BUILT });
    expect(headings(doc)).toEqual(["You", "Hosting", "Moderation"]);
    expect(badges(doc)).toEqual(["Event host", "Moderator"]);
  });

  it("offers New event and Event presets to a host only while Events is on (#1305, #1528)", () => {
    const on = { ...host, features: { "events.enabled": true } as const };
    expect(links(userPage(on))).toEqual([
      "My preferences",
      "Your events",
      "New event",
      "Event presets",
    ]);
    const off = { ...host, features: { "events.enabled": false } as const };
    expect(links(userPage(off))).not.toContain("New event");
    expect(links(userPage(off))).not.toContain("Event presets");
    // A moderator who does not host is never offered it.
    const mod = { ...moderator, features: { "events.enabled": true } as const };
    expect(links(userPage(mod))).not.toContain("New event");
    expect(links(userPage(mod))).not.toContain("Event presets");
  });

  it("gives Event presets its own icon, not the one of Your events", () => {
    const iconOf = (label: string): string => {
      const on = { ...host, features: { "events.enabled": true } as const };
      const link = Array.from(
        userPage(on).querySelectorAll(".kb-sidenav a"),
      ).find((a) => text(a).trim() === label);
      return link?.querySelector("svg")?.innerHTML ?? "";
    };
    expect(iconOf("Event presets")).not.toBe("");
    expect(iconOf("Event presets")).not.toBe(iconOf("Your events"));
  });

  it("uses the real registry: host, moderator, both and member", () => {
    expect(headings(userPage(host))).toEqual(["You", "Hosting"]);
    // New event and Event presets need Events, which no status says is on here.
    expect(links(userPage(host))).toEqual(["My preferences", "Your events"]);
    // A moderator now sees You and Moderation and a sidebar; Tickets has no
    // page yet, so it never renders.
    expect(headings(userPage(moderator))).toEqual(["You", "Moderation"]);
    expect(links(userPage(moderator))).toEqual([
      "My preferences",
      "Mod log",
      "Command audit",
    ]);
    expect(badges(userPage(moderator))).toEqual(["Moderator"]);
    expect(headings(userPage(both))).toEqual(["You", "Hosting", "Moderation"]);
    expect(links(userPage(both))).toEqual([
      "My preferences",
      "Your events",
      "Mod log",
      "Command audit",
    ]);
    expect(userPage(member).querySelector(".kb-sidenav")).toBeNull();
  });

  it("marks the right item on each moderator page, live registry", () => {
    const current = (active: string): string[] =>
      Array.from(
        userPage(moderator, { active }).querySelectorAll(
          ".kb-sidenav a[aria-current='page']",
        ),
      ).map((a) => text(a).trim());
    expect(current("/me/moderation")).toEqual(["Mod log"]);
    expect(current("/me/moderation/cases/abc")).toEqual(["Mod log"]);
    expect(current("/me/moderation/audit")).toEqual(["Command audit"]);
  });

  it("marks the current page and nothing else", () => {
    const current = (active: string): string[] =>
      Array.from(
        userPage(both, { active, navRegistry: BUILT }).querySelectorAll(
          ".kb-sidenav a[aria-current='page']",
        ),
      ).map((a) => text(a).trim());
    expect(current("/me/")).toEqual(["My preferences"]);
    expect(current("/me/notifications")).toEqual(["My preferences"]);
    expect(current("/me/events/presets")).toEqual(["Event presets"]);
    expect(current("/me/events/123/host")).toEqual(["Your events"]);
    expect(current("/me/moderation")).toEqual(["Mod log"]);
  });

  it("keeps the My preferences tabs off host and moderator pages", () => {
    expect(
      userPage(host, { active: "/me/events/presets" }).querySelector(
        "nav.kb-tabs",
      ),
    ).toBeNull();
    expect(userPage(host).querySelector("nav.kb-tabs")).not.toBeNull();
  });

  it("labels the landmarks apart", () => {
    const doc = userPage(host);
    expect(doc.querySelectorAll("header").length).toBe(1);
    const names = Array.from(doc.querySelectorAll("nav")).map((n) =>
      n.getAttribute("aria-label"),
    );
    expect(new Set(names).size).toBe(names.length);
    const nav = doc.querySelector(".kb-sidenav");
    for (const ul of Array.from(nav?.querySelectorAll("ul") ?? [])) {
      const id = ul.getAttribute("aria-labelledby") ?? "";
      expect(doc.getElementById(id)).not.toBeNull();
    }
  });

  it("renders the body once, inside main, next to the sidebar", () => {
    const doc = userPage(host);
    expect(doc.querySelectorAll("#body").length).toBe(1);
    expect(doc.querySelector(".kb-shell > nav.kb-sidenav")).not.toBeNull();
    expect(doc.querySelector(".kb-shell > main#main.kb-main #body")).not.toBe(
      null,
    );
  });
});

describe("top bar", () => {
  it("shows the avatar initial, display name, session timer and Sign out", () => {
    const doc = userPage(member);
    const bar = doc.querySelector("header.kb-topbar");
    expect(text(bar?.querySelector(".kb-avatar"))).toBe("K");
    expect(text(bar?.querySelector(".kb-whoami"))).toContain("Kari");
    const timer = bar?.querySelector("#session-countdown");
    expect(timer?.getAttribute("data-remaining-ms")).toBe("600000");
    expect(timer?.hasAttribute("data-inactivity-ms")).toBe(true);
    const form = bar?.querySelector("form");
    expect(form?.getAttribute("action")).toBe("/me/finish");
    expect(form?.getAttribute("method")).toBe("POST");
    expect(text(form?.querySelector("button"))).toBe("Sign out");
    expect(
      form?.querySelector("input[name='_csrf']")?.getAttribute("value"),
    ).toBe("csrf");
  });

  it("gives a non-admin no Admin console link", () => {
    const doc = userPage(both);
    expect(doc.querySelector("a[href='/admin/']")).toBeNull();
  });

  it("gives an admin on /me the Admin console link and every badge", () => {
    const doc = userPage(admin);
    const link = doc.querySelector(".kb-topbar a[href='/admin/']");
    expect(text(link).trim()).toBe("Admin console");
    expect(badges(doc)).toEqual(["Event host", "Moderator", "Admin"]);
    expect(headings(doc)).toEqual(["You", "Hosting", "Moderation"]);
  });

  it("falls back to a stand-in viewer from isAdmin when none is known", () => {
    const html = renderUserPage({
      title: "Overview",
      active: "/me/",
      body: "",
      isAdmin: true,
      ...COMMON,
    });
    const doc = parse(html);
    expect(text(doc.querySelector(".kb-whoami"))).toContain("Signed in");
    expect(badges(doc)).toContain("Admin");
    expect(text(doc.querySelector("a[href='/admin/']")).trim()).toBe(
      "Admin console",
    );
  });

  it("ends the admin console with Finish and links back to My preferences", () => {
    const doc = parse(
      renderAdminPage({
        title: "Dashboard",
        active: "/admin/",
        body: "",
        viewer: admin,
        ...COMMON,
      }),
    );
    const bar = doc.querySelector("header.kb-topbar");
    expect(text(bar?.querySelector(".kb-whoami"))).toContain("Ola");
    expect(badges(doc)).toEqual(["Event host", "Moderator", "Admin"]);
    expect(text(bar?.querySelector("a[href='/me/']")).trim()).toBe(
      "My preferences",
    );
    expect(bar?.querySelector("a[href='/admin/']")?.textContent).toContain(
      "KoolBot",
    );
    const form = bar?.querySelector("form");
    expect(form?.getAttribute("action")).toBe("/admin/finish");
    expect(text(form?.querySelector("button"))).toBe("Finish");
    // The console's sidebar is the shared SideNav too (#1296), labelled for admins.
    expect(
      doc.querySelector("nav.kb-sidenav")?.getAttribute("aria-label"),
    ).toBe("Admin sections");
    expect(doc.querySelector("nav.side")).toBeNull();
  });

  it("escapes the display name and takes its initial by code point", () => {
    const nasty: ShellViewer = {
      ...member,
      displayName: `<img src=x onerror=alert(1)>"&`,
    };
    const html = renderUserPage({
      title: "t",
      active: "/me/",
      body: "",
      isAdmin: false,
      viewer: nasty,
      ...COMMON,
    });
    const doc = parse(html);
    expect(doc.querySelector(".kb-topbar img")).toBeNull();
    expect(text(doc.querySelector(".kb-whoami"))).toContain(
      `<img src=x onerror=alert(1)>"&`,
    );
    expect(html.includes("<img src=x")).toBe(false);
    expect(text(doc.querySelector(".kb-avatar"))).toBe("<");

    const emoji = parse(
      renderTopBar({
        viewer: { ...member, displayName: "\u{1F600} Smile" },
        home: "/me/",
        surface: "me",
        csrfToken: "c",
        remainingMs: 1,
        inactivityMs: 1,
      }),
    );
    expect(text(emoji.querySelector(".kb-avatar"))).toBe("\u{1F600}");
  });

  it("marks icons decorative and adds no inline event handlers", () => {
    const html = renderUserPage({
      title: "t",
      active: "/me/",
      body: "",
      isAdmin: true,
      viewer: admin,
      navRegistry: BUILT,
      ...COMMON,
    });
    const doc = parse(html);
    for (const svg of Array.from(
      doc.querySelectorAll(".kb-topbar svg, .kb-sidenav svg"),
    )) {
      expect(svg.getAttribute("aria-hidden")).toBe("true");
    }
    for (const el of Array.from(doc.querySelectorAll("*"))) {
      for (const name of el.getAttributeNames()) {
        expect(name.startsWith("on")).toBe(false);
      }
    }
    for (const script of Array.from(doc.querySelectorAll("script"))) {
      expect(script.getAttribute("nonce")).not.toBeNull();
    }
  });
});

describe("why you see this", () => {
  const whyText = (viewer: ShellViewer, active: string): string => {
    const doc = parse(renderScopeWhy(viewer, active));
    return text(doc.querySelector("[data-why]")).trim();
  };

  it("names the role the person is in", () => {
    const viewer: ShellViewer = {
      ...host,
      reasons: { host: ["Event hosts"], staff: [], elevated: false },
    };
    expect(whyText(viewer, "/me/events/presets")).toBe(
      "Event host You can host because you are in @Event hosts.",
    );
  });

  it("lists several roles, and uses the staff roles for moderation", () => {
    const viewer: ShellViewer = {
      ...both,
      reasons: { host: ["Hosts", "Crew"], staff: ["Mods"], elevated: false },
    };
    expect(whyText(viewer, "/me/events/9/host")).toContain("@Hosts, @Crew");
    expect(whyText(viewer, "/me/moderation")).toContain(
      "You can moderate because you are in @Mods.",
    );
  });

  it("falls back to the capability when no role name is known", () => {
    expect(whyText(host, "/me/events")).toContain(
      "You can host because you hold the Event host role.",
    );
    expect(whyText(moderator, "/me/moderation")).toContain(
      "You can moderate because you hold the Moderator role.",
    );
  });

  it("says Administrator for admins and for the owner shortcut", () => {
    expect(whyText(admin, "/me/events")).toContain("you are an Administrator");
    const owner: ShellViewer = {
      ...host,
      reasons: { host: [], staff: [], elevated: true },
    };
    expect(whyText(owner, "/me/events")).toContain("you are an Administrator");
  });

  it("escapes role names", () => {
    const viewer: ShellViewer = {
      ...host,
      reasons: { host: ["<b>x</b>"], staff: [], elevated: false },
    };
    const doc = parse(renderScopeWhy(viewer, "/me/events"));
    expect(doc.querySelector("b")).toBeNull();
    expect(text(doc.body)).toContain("@<b>x</b>");
  });

  it("appears on host and moderator pages only", () => {
    expect(renderScopeWhy(both, "/me/")).toBe("");
    expect(renderScopeWhy(both, "/me/notifications")).toBe("");
    expect(renderScopeWhy(both, "/me/events/presets")).not.toBe("");
    expect(renderScopeWhy(both, "/me/moderation")).not.toBe("");
  });

  it("is shown by the layout above the page body on a host page", () => {
    const doc = userPage(
      {
        ...host,
        reasons: { host: ["Event hosts"], staff: [], elevated: false },
      },
      { active: "/me/events/presets" },
    );
    const why = doc.querySelector("main [data-why='host']");
    expect(text(why)).toContain("because you are in @Event hosts");
    expect(userPage(host).querySelector("[data-why]")).toBeNull();
  });
});

describe("reflow (#855)", () => {
  const css = fs.readFileSync(
    new URL("../../docs/design/kb.css", import.meta.url),
    "utf8",
  );
  const narrow = css.slice(css.indexOf("@media (max-width: 760px)"));

  it("has kb.css rules at 760px for every shell hook the markup uses", () => {
    for (const hook of [
      ".kb-shell { flex-direction: column; }",
      ".kb-sidenav { width: auto;",
      ".kb-topbar {",
      ".kb-whoami {",
    ]) {
      expect(css.includes(hook)).toBe(true);
    }
    expect(narrow.length).toBeGreaterThan(0);
  });

  /** The declarations of the first top-level kb.css rule for `selector`. */
  const rule = (selector: string): string => {
    const line = css.split("\n").find((l) => l.startsWith(`${selector} { `));
    return line ?? "";
  };

  it("lets a long name and three badges wrap instead of scrolling the page", () => {
    // jsdom has no layout, so the contract is the rules themselves, at every
    // width (not only inside the 760px query).
    expect(rule(".kb-topbar")).toContain("flex-wrap: wrap");
    expect(rule(".kb-topbar")).toContain("min-height: var(--topbar-height)");
    expect(rule(".kb-topbar")).not.toContain(" height: var(--topbar-height)");
    expect(rule(".kb-topbar__end")).toContain("flex-wrap: wrap");
    expect(rule(".kb-topbar__end")).toContain("min-width: 0");
    expect(rule(".kb-topbar__end")).toContain("max-width: 100%");
    expect(rule(".kb-whoami")).toContain("flex-wrap: wrap");
    expect(rule(".kb-whoami")).toContain("min-width: 0");
    expect(rule(".kb-whoami")).toContain("max-width: 100%");
  });

  it("shrinks and breaks an unbroken display name", () => {
    const name = rule(".kb-whoami__name");
    expect(name).toContain("min-width: 0");
    expect(name).toContain("max-width: 18rem");
    expect(name).toContain("overflow-wrap: anywhere");
    const doc = userPage({ ...member, displayName: "x".repeat(200) });
    expect(doc.querySelector(".kb-whoami > .kb-whoami__name")).not.toBeNull();
  });

  it("emits those hook classes", () => {
    const doc = userPage(host);
    for (const sel of [
      ".kb-topbar",
      ".kb-topbar__end",
      ".kb-whoami",
      ".kb-shell",
      ".kb-sidenav",
      ".kb-main",
    ]) {
      expect(doc.querySelector(sel)).not.toBeNull();
    }
    // The column inside the sidebar page is kb-main__inner, not a bare `main` rule (#1541).
    expect(
      doc.querySelector("main#main.kb-main > .kb-main__inner"),
    ).not.toBeNull();
  });
});

describe("renderSideNav", () => {
  it("returns nothing for a single section", () => {
    expect(renderSideNav(sectionsFor(member, BUILT), "/me/")).toBe("");
  });

  it("escapes labels and hrefs from the registry", () => {
    const registry: ShellNavItem[] = [
      ...SHELL_NAV,
      {
        scope: "host",
        label: "<i>New</i>",
        href: '/me/events/"x"',
        icon: "calendar",
        available: true,
      },
    ];
    const doc = parse(renderSideNav(sectionsFor(host, registry), "/me/"));
    expect(doc.querySelector("nav i")).toBeNull();
    const labels = Array.from(doc.querySelectorAll("a")).map((a) => text(a));
    expect(labels).toContain("<i>New</i>");
  });
});

describe("running version in the top bar", () => {
  const version = formatVersion(getBotVersion());

  it("shows it on /me, without the admin update link", () => {
    const doc = userPage(member);
    const pill = doc.querySelector(".kb-topbar .kb-pill.kb-mono");
    expect(text(pill)).toBe(version);
    expect(doc.querySelector(".kb-topbar a.kb-pill")).toBeNull();
  });

  it("shows it in the admin console too", () => {
    const doc = parse(
      renderAdminPage({
        title: "Dashboard",
        active: "/admin/",
        body: "",
        viewer: admin,
        ...COMMON,
      }),
    );
    expect(text(doc.querySelector(".kb-topbar .kb-pill.kb-mono"))).toBe(
      version,
    );
  });
});

describe("feature-gated sidebar items through renderUserPage", () => {
  const registry: ShellNavItem[] = [
    ...BUILT.filter((i) => i.label !== "Tickets"),
    {
      scope: "moderator",
      label: "Tickets",
      href: "/me/moderation/tickets",
      icon: "ticket",
      featureKey: "tickets.enabled",
      available: true,
    },
  ];
  const withFeatures = (features: ShellViewer["features"]): string[] =>
    links(userPage({ ...moderator, features }, { navRegistry: registry }));

  it("shows the item when the viewer's feature is on", () => {
    expect(withFeatures({ "tickets.enabled": true })).toContain("Tickets");
  });

  it("hides it when the feature is off or unknown", () => {
    expect(withFeatures({ "tickets.enabled": false })).not.toContain("Tickets");
    expect(withFeatures(undefined)).not.toContain("Tickets");
  });
});

describe("resolveShellFeatures", () => {
  const gated = (available: boolean): ShellNavItem => ({
    scope: "moderator",
    label: "Tickets",
    href: "/me/moderation/tickets",
    icon: "ticket",
    featureKey: "tickets.enabled",
    available,
  });

  it("reads nothing for a gated page that is not built", async () => {
    const read = jest.fn(async () => true);
    expect(await resolveShellFeatures(read, [gated(false)])).toEqual({});
    expect(read).not.toHaveBeenCalled();
  });

  it("reads only the gated features of the built pages (New event needs Events)", async () => {
    const read = jest.fn(async () => true);
    expect(await resolveShellFeatures(read)).toEqual({
      "events.enabled": true,
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("reads each built gated feature once", async () => {
    const read = jest.fn(async () => true);
    const status = await resolveShellFeatures(read, [gated(true), gated(true)]);
    expect(status).toEqual({ "tickets.enabled": true });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith("tickets.enabled");
  });

  it("fails closed: a failed read is off", async () => {
    const read = jest.fn(async () => {
      throw new Error("mongo down");
    });
    expect(await resolveShellFeatures(read, [gated(true)])).toEqual({
      "tickets.enabled": false,
    });
  });
});
