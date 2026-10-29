/**
 * @jest-environment <rootDir>/__tests__/jsdom-node-env.cjs
 */

/* global DOMParser, Document, Element */
/**
 * The shared admin shell (#1542): a page icon on every sidebar entry, the
 * motto in the TopBar brand and the space under a PageHeader. Markup is read
 * through the DOM, never filtered with regular expressions.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "@jest/globals";
import { NAV_ITEMS, renderAdminPage } from "../../src/web/admin-layout.js";
import { BRAND_MOTTO, renderTopBar } from "../../src/web/app-shell.js";
import { ICONS, icon } from "../../src/web/icons.js";
import { adminPages } from "./a11y-pages.js";

const parse = (html: string): Document =>
  new DOMParser().parseFromString(html, "text/html");

const adminHtml = (navFeatureStatus?: Record<string, boolean>): string =>
  renderAdminPage({
    title: "Dashboard",
    active: "/admin/events",
    body: "",
    csrfToken: "c",
    remainingMs: 60_000,
    navFeatureStatus,
  } as Parameters<typeof renderAdminPage>[0]);

/** DESIGN.md > Iconography page table as { page label -> icon name }. */
function designTable(): Map<string, string> {
  const design = fs.readFileSync(path.join(process.cwd(), "DESIGN.md"), "utf8");
  const section =
    design.split("## Iconography")[1]?.split("**As built")[0] ?? "";
  const map = new Map<string, string>();
  for (const line of section.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    for (let i = 0; i + 1 < cells.length; i += 2) {
      const name = /^`([a-z0-9-]+)`$/.exec(cells[i + 1] ?? "")?.[1];
      if (name) {
        map.set(cells[i].replace(/ \(a subpage of .*\)$/, ""), name);
      }
    }
  }
  return map;
}

describe("admin sidebar page icons (#1542)", () => {
  it("gives every NAV_ITEMS entry an icon icons.ts exports", () => {
    for (const item of NAV_ITEMS) {
      expect(Object.keys(ICONS)).toContain(item.icon);
    }
  });

  it("matches the icon DESIGN.md > Iconography lists for the page", () => {
    const table = designTable();
    expect(table.size).toBeGreaterThan(25);
    for (const item of NAV_ITEMS) {
      expect({ label: item.label, icon: table.get(item.label) }).toEqual({
        label: item.label,
        icon: item.icon,
      });
    }
  });

  it("draws the icon, decorative, before the label of every link", () => {
    const doc = parse(adminHtml());
    const links = Array.from(doc.querySelectorAll(".kb-sidenav a"));
    expect(links).toHaveLength(NAV_ITEMS.length);
    for (const item of NAV_ITEMS) {
      const a = doc.querySelector(`.kb-sidenav a[href="${item.href}"]`);
      const svg = a?.firstElementChild;
      expect(svg?.tagName.toLowerCase()).toBe("svg");
      expect(svg?.getAttribute("aria-hidden")).toBe("true");
      expect(svg?.outerHTML).toBe(
        parse(icon(item.icon)).querySelector("svg")?.outerHTML,
      );
      // The accessible name is still the words alone.
      expect(a?.textContent?.trim().startsWith(item.label)).toBe(true);
    }
  });

  it("keeps the icon on the links folded under 'N turned off'", () => {
    const doc = parse(adminHtml({ "events.enabled": false }));
    const off = doc.querySelector(
      '.kb-sidenav details a.is-off[href="/admin/events"]',
    );
    expect(off?.querySelector("svg.kb-icon")).not.toBeNull();
  });
});

describe("TopBar motto (#1542)", () => {
  const common = {
    viewer: { displayName: "Kari", role: "admin", scopes: ["member"] },
    csrfToken: "c",
    remainingMs: 1,
    inactivityMs: 1,
  } as const;

  it.each([
    ["admin", "/admin/"],
    ["me", "/me/"],
  ] as const)("prints the motto inside the %s brand link", (surface, home) => {
    const doc = parse(
      renderTopBar({ ...common, surface, home } as Parameters<
        typeof renderTopBar
      >[0]),
    );
    const brand = doc.querySelector("a.kb-topbar__brand");
    expect(brand?.getAttribute("href")).toBe(home);
    expect(brand?.querySelector("span.kb-topbar__motto")?.textContent).toBe(
      BRAND_MOTTO,
    );
    expect(BRAND_MOTTO).toBe("Keeper of our lore");
    // Name and motto are read as words, not run together.
    expect(brand?.textContent).toBe("KoolBot Keeper of our lore");
  });
});

describe("space under a PageHeader (#1542)", () => {
  it("never leaves a PageHeader flush against what follows it", () => {
    const pages = adminPages();
    let checked = 0;
    const flush: string[] = [];
    for (const page of pages) {
      const doc = parse(page.html);
      for (const head of Array.from(
        doc.querySelectorAll("main header.kb-pagehead"),
      )) {
        checked += 1;
        const parent = head.parentElement as Element;
        const followed = head.nextElementSibling !== null;
        const spaced =
          parent.classList.contains("kb-stack") ||
          parent.classList.contains("kb-main__inner");
        if (followed && !spaced) flush.push(page.name);
      }
    }
    expect(flush).toEqual([]);
    expect(checked).toBeGreaterThan(5);
  });
});
