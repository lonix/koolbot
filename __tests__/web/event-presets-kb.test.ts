/**
 * @jest-environment <rootDir>/__tests__/jsdom-node-env.cjs
 */
/* global DOMParser, HTMLInputElement */
/**
 * The admin Group presets page and the member My presets page render only
 * kb- components (#1708, part of #1639): PageHeader, Panel, DataTable, Button,
 * Badge, Callout, EmptyState, Field and Switch. Checked on every fixture state
 * of both pages, inside the page's own content (the layout around it is not
 * part of this migration).
 */
import { describe, expect, it } from "@jest/globals";
import { allPages } from "./a11y-pages.js";

const PAGES = allPages().filter(
  (p) =>
    p.name.startsWith("Group presets") ||
    p.name.startsWith("/me event presets"),
);

describe("the presets pages on the kb- components (#1708)", () => {
  it("covers every state of both pages", () => {
    expect(PAGES.length).toBeGreaterThanOrEqual(12);
  });

  it.each(PAGES)("$name renders no class that is not a kb- one", ({ html }) => {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const head = doc.querySelector(".kb-pagehead");
    expect(head).not.toBeNull();
    const content = head!.parentElement!;
    const old = new Set<string>();
    [content, ...Array.from(content.querySelectorAll("[class]"))].forEach(
      (el) =>
        el.classList.forEach((c) => {
          if (!c.startsWith("kb-")) old.add(c);
        }),
    );
    expect([...old]).toEqual([]);
  });

  it("keeps the preset editor's form hooks and field names", () => {
    const page = PAGES.find((p) => p.name === "Group presets")!;
    const doc = new DOMParser().parseFromString(page.html, "text/html");
    const form = doc.querySelector("form[data-preset-form]")!;
    expect(form.getAttribute("action")).toBe("/admin/events/presets/save");
    for (const name of [
      "preset_name",
      "preset_description",
      "groups_label",
      "groups_leader_label",
      "groups_lead_minutes",
      "groups_tags",
      "groups_captains_lobby",
    ]) {
      expect(form.querySelector(`[name="${name}"]`)).not.toBeNull();
    }
    for (const name of ["groups_tags", "groups_captains_lobby"]) {
      const box = form.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
      expect(box.getAttribute("role")).toBe("switch");
      expect(box.value).toBe("1");
      expect(
        doc.getElementById(box.getAttribute("aria-describedby")!),
      ).not.toBeNull();
    }
    expect(form.querySelector("[data-group-rows]")).not.toBeNull();
    expect(
      form.querySelector("template[data-group-row-template]"),
    ).not.toBeNull();
    expect(form.querySelector("[data-add-group]")).not.toBeNull();
  });
});
