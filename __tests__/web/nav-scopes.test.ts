/**
 * Navigation and scope invariants (#1333, part of #1326).
 *
 * Two registries drive the sidebars, and each has a rule a new entry could
 * silently break:
 *
 *  - `NAV_ITEMS` (`admin-layout.ts`), the admin console sidebar. Every entry
 *    needs a group from the fixed task-based set (#1296), the `admin` scope, a
 *    unique `/admin` href, and a valid `featureKey` where the page is
 *    feature-gated (and only those pages are in Features).
 *  - `SHELL_NAV` (`app-shell.ts`), the `/me` sidebar. Every entry belongs to
 *    exactly one non-admin scope, and a viewer is only ever shown the sections
 *    of the scopes they hold; nothing in it links into `/admin`.
 *
 * The admin refusal itself (every registered `/admin` route answers a host or
 * moderator session with 403) is walked route by route in
 * `admin-scope-refusal.test.ts`. This file adds the nav side of it: every page
 * the admin sidebar links to is refused for those sessions.
 *
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import type { RequestHandler } from "express";
import {
  startAdminHarness,
  createTestSession,
  type AdminHarness,
} from "./admin-harness.js";
import {
  NAV_ITEMS,
  NAV_GROUP_ORDER,
  NAV_HEADED_GROUPS,
} from "../../src/web/admin-layout.js";
import {
  SHELL_NAV,
  renderSideNav,
  scopeOfPath,
  sectionsFor,
  type ShellNavItem,
  type ShellViewer,
} from "../../src/web/app-shell.js";
import { defaultConfig } from "../../src/services/config-schema.js";
import type { WebSessionContext } from "../../src/web/session.js";

process.env.WEBUI_SESSION_SECRET = "test-secret-for-nav-scopes";

const { createWriteRouter } = await import("../../src/web/write-routes.js");
const { createReadOnlyRouter } =
  await import("../../src/web/read-only-routes.js");

/** The scopes a non-admin `/me` sidebar section can belong to. */
const SHELL_SCOPES = ["member", "host", "moderator"] as const;

/**
 * The admin console's groups (#1296), written out here on purpose: a group
 * added or renamed in `NAV_GROUP_ORDER` fails this file until the person doing
 * it has decided that the sidebar should change.
 */
const ADMIN_GROUPS = [
  "Top",
  "Features",
  "Access",
  "Server setup",
  "Bot",
  "Pinned",
] as const;

describe("admin NAV_ITEMS: group and feature key", () => {
  it("has a group from the allowed set on every entry", () => {
    const allowed = new Set<string>(ADMIN_GROUPS);
    const bad = NAV_ITEMS.filter(
      (item) => typeof item.group !== "string" || !allowed.has(item.group),
    ).map((item) => `${item.label} (${String(item.group)})`);
    expect(bad).toEqual([]);
  });

  it("renders every group in the fixed order, and every group has an entry", () => {
    expect(new Set(NAV_GROUP_ORDER).size).toBe(NAV_GROUP_ORDER.length);
    for (const group of NAV_GROUP_ORDER) {
      expect(NAV_ITEMS.some((item) => item.group === group)).toBe(true);
    }
  });

  it("gives every Features entry a featureKey", () => {
    const missing = NAV_ITEMS.filter(
      (item) => item.group === "Features" && !item.featureKey,
    ).map((item) => item.label);
    expect(missing).toEqual([]);
  });

  it("uses a real <feature>.enabled switch for every featureKey", () => {
    for (const item of NAV_ITEMS) {
      if (!item.featureKey) continue;
      expect(item.featureKey).toMatch(/\.enabled$/);
      expect(Object.keys(defaultConfig)).toContain(item.featureKey);
    }
  });

  it("keeps each entry's label, and an /admin href that is unique", () => {
    const hrefs = NAV_ITEMS.map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const item of NAV_ITEMS) {
      expect(item.label.trim()).not.toBe("");
      expect(item.href.startsWith("/admin/") || item.href === "/admin").toBe(
        true,
      );
    }
  });

  it("has a scope on every entry, and it is the admin console's, not a /me scope", () => {
    const bad = NAV_ITEMS.filter(
      (item) => (item.scope as unknown) !== "admin",
    ).map((item) => `${item.label} (${String(item.scope)})`);
    expect(bad).toEqual([]);
    for (const item of NAV_ITEMS) {
      expect(SHELL_SCOPES as readonly string[]).not.toContain(item.scope);
    }
  });

  it("takes its groups from the task-based set, not Info/Settings/Features", () => {
    expect([...NAV_GROUP_ORDER]).toEqual([...ADMIN_GROUPS]);
    expect([...NAV_HEADED_GROUPS]).toEqual([
      "Features",
      "Access",
      "Server setup",
      "Bot",
    ]);
    const used = new Set<string>(NAV_ITEMS.map((item) => item.group));
    expect(used).not.toContain("Info");
    expect(used).not.toContain("Settings");
  });

  it("keeps Dashboard alone at the top and All settings alone at the bottom", () => {
    const groupOf = (group: string): string[] =>
      NAV_ITEMS.filter((item) => item.group === group).map((item) => item.href);
    expect(groupOf("Top")).toEqual(["/admin/"]);
    expect(groupOf("Pinned")).toEqual(["/admin/settings"]);
  });

  it("only puts feature-gated pages in Features", () => {
    const stray = NAV_ITEMS.filter(
      (item) => item.featureKey && item.group !== "Features",
    ).map((item) => `${item.label} (${item.group})`);
    expect(stray).toEqual([]);
  });
});

describe("SHELL_NAV: scope and feature key", () => {
  it("puts every entry in a non-admin scope, with a label and an icon", () => {
    for (const item of SHELL_NAV) {
      expect(SHELL_SCOPES as readonly string[]).toContain(item.scope);
      expect(item.label.trim()).not.toBe("");
      expect(item.icon).toBeTruthy();
    }
  });

  it("uses a real <feature>.enabled switch for every featureKey", () => {
    for (const item of SHELL_NAV) {
      if (!item.featureKey) continue;
      expect(item.featureKey).toMatch(/\.enabled$/);
      expect(Object.keys(defaultConfig)).toContain(item.featureKey);
    }
  });

  it("never links into /admin, and keeps each href in its own scope's area", () => {
    for (const item of SHELL_NAV) {
      expect(item.href.startsWith("/admin")).toBe(false);
      expect(scopeOfPath(item.href)).toBe(item.scope);
    }
  });
});

describe("the /me sidebar shows only the viewer's own sections", () => {
  // Every page built and ungated, so each scope has its full section.
  const BUILT: ShellNavItem[] = SHELL_NAV.map((item) => ({
    ...item,
    available: true,
    featureKey: undefined,
  }));

  const VIEWERS: Array<[string, ShellViewer]> = [
    ["member", { displayName: "A", role: "user", scopes: ["member"] }],
    ["host", { displayName: "A", role: "user", scopes: ["member", "host"] }],
    [
      "moderator",
      { displayName: "A", role: "user", scopes: ["member", "moderator"] },
    ],
    [
      "host and moderator",
      {
        displayName: "A",
        role: "user",
        scopes: ["member", "host", "moderator"],
      },
    ],
  ];

  it.each(VIEWERS)(
    "gives a %s session items from its own scopes only",
    (_name, viewer) => {
      const held = new Set<string>(viewer.scopes);
      const sections = sectionsFor(viewer, BUILT);
      expect(sections.length).toBeGreaterThan(0);
      for (const section of sections) {
        expect(held.has(section.scope)).toBe(true);
        for (const item of section.items) {
          expect(item.scope).toBe(section.scope);
          expect(held.has(scopeOfPath(item.href))).toBe(true);
        }
      }
    },
  );

  it.each(VIEWERS)(
    "renders no link into /admin for a %s session",
    (_name, viewer) => {
      const html = renderSideNav(sectionsFor(viewer, BUILT), "/me/");
      expect(html).not.toContain('href="/admin');
    },
  );

  it("does not widen for an unlisted scope: a forged admin scope shows no admin section", () => {
    const forged = {
      displayName: "A",
      role: "user",
      scopes: ["member", "admin"],
    } as unknown as ShellViewer;
    const scopes = sectionsFor(forged, BUILT).map((s) => s.scope as string);
    expect(scopes).toEqual(["member"]);
  });
});

describe("every page the admin sidebar links to refuses host and moderator sessions", () => {
  let current: WebSessionContext | null = null;
  let harness: AdminHarness;
  let readOnly: AdminHarness;

  const stubSession: RequestHandler = (req, _res, next): void => {
    if (current) Object.assign(req, { webSession: current });
    next();
  };

  beforeAll(async () => {
    const write = createWriteRouter({} as never, stubSession);
    const read = createReadOnlyRouter({} as never, stubSession);
    harness = await startAdminHarness([write, read], "/admin");
    // The read-only router alone: composed, the write router's gate answers
    // every path first and would hide a nav link outside the read router's gate
    // (as `/admin/session/ping` is, on purpose).
    readOnly = await startAdminHarness([read], "/admin");
  });

  afterAll(async () => {
    await harness.close();
    await readOnly.close();
  });

  const SCOPE_SETS: Array<[string, WebSessionContext["scopes"]]> = [
    ["member only", ["member"]],
    ["host", ["member", "host"]],
    ["moderator", ["member", "moderator"]],
    ["host and moderator", ["member", "host", "moderator"]],
  ];

  it.each(SCOPE_SETS)(
    "answers 403 on each NAV_ITEMS href: %s",
    async (_name, scopes) => {
      current = createTestSession({
        discordUserId: "u-1",
        guildId: "guild-1",
        role: "user",
        scopes,
      });
      const reachable: string[] = [];
      for (const item of NAV_ITEMS) {
        const path = item.href.replace(/^\/admin/, "") || "/";
        for (const [name, target] of [
          ["composed", harness],
          ["read-only alone", readOnly],
        ] as const) {
          const res = await target.get(path);
          if (res.status !== 403) {
            reachable.push(`${item.href} (${name}) -> ${res.status}`);
          }
        }
      }
      expect(reachable).toEqual([]);
    },
    60_000,
  );

  it("control: an admin session is not refused by the gate on the same pages", async () => {
    current = createTestSession({
      discordUserId: "u-1",
      guildId: "guild-1",
      role: "admin",
      scopes: [],
    });
    let passed = false;
    for (const item of NAV_ITEMS) {
      const res = await harness.get(item.href.replace(/^\/admin/, "") || "/");
      if (res.status !== 403) {
        passed = true;
        break;
      }
    }
    expect(passed).toBe(true);
  }, 60_000);
});
