/**
 * The admin width rule (#1734): one narrow cap (`content-max`) and one wide
 * column (`content-max-wide`), each defined once from the tokens, in the
 * admin page's own sheet and in kb.css, so the two cannot disagree.
 */
import { describe, it, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderAdminPage } from "../../src/web/admin-layout.js";
import { adminPages } from "./a11y-pages.js";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const KB_CSS = fs.readFileSync(path.join(ROOT, "docs/design/kb.css"), "utf8");
const TOKENS = JSON.parse(
  fs.readFileSync(path.join(ROOT, "docs/design/tokens.json"), "utf8"),
) as {
  layout: { tokens: { name: string; value: string }[] };
  spacing: { tokens: { name: string; value: string }[] };
};

const rule = (css: string, selector: string): string => {
  const start = css.indexOf(`${selector} {`);
  const at = start > -1 ? start : css.indexOf(`${selector}{`);
  expect(at).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
};

describe("admin width rule (#1734)", () => {
  it("declares content-max-wide as 96rem next to content-max", () => {
    const token = (name: string): string | undefined =>
      TOKENS.layout.tokens.find((t) => t.name === name)?.value;
    expect(token("content-max")).toBe("72rem");
    expect(token("content-max-wide")).toBe("96rem");
  });

  it("defines the wide class in kb.css from the same two tokens", () => {
    expect(rule(KB_CSS, ".kb-main__inner")).toContain(
      "max-width: var(--content-max)",
    );
    expect(rule(KB_CSS, ".kb-main--wide .kb-main__inner")).toContain(
      "max-width: var(--content-max-wide)",
    );
  });

  it("keeps descriptions, help text and callouts at content-max on a wide page", () => {
    const text = rule(
      KB_CSS,
      ".kb-main--wide :is(.kb-pagehead__sub, .kb-help, .kb-callout, p.kb-muted)",
    );
    expect(text).toContain("max-width: var(--content-max)");
  });

  it("gives the admin page the same two caps, plus the two space-8 gutters", () => {
    const html = renderAdminPage({
      title: "T",
      active: "/admin/",
      body: "<p>x</p>",
      csrfToken: "c",
      remainingMs: 1,
      wide: true,
    });
    expect(rule(html, "main")).toContain(
      "max-width:calc(var(--content-max) + 2 * var(--space-8))",
    );
    expect(rule(html, "main.kb-main--wide")).toContain(
      "max-width:calc(var(--content-max-wide) + 2 * var(--space-8))",
    );
    // The gutter token is the one `main` pads with.
    expect(rule(html, "main")).toContain("padding:1.5rem 2rem");
    expect(TOKENS.spacing.tokens.find((t) => t.name === "space-8")?.value).toBe(
      "2rem",
    );
  });
});

describe("which admin pages take the wide column (#1734)", () => {
  /** Titles (the `<title>` before " — KoolBot Admin") of the table and board pages that opt in. */
  const WIDE_TITLES = new Set([
    "Announcements",
    "Birthdays",
    "Channel Claims",
    "Command audit",
    "Database",
    "Events",
    "Moderation log",
    "Notices",
    "Polls",
    "Quotes",
    "Reaction Roles",
    "Role Groups",
    "Server scan",
    "Support tickets",
    "Voice analytics",
  ]);
  // Role Groups also renders two plan pages (delete review, administrators outside the group) and Server scan
  // and Channel claims a failed scan: a message, not a table. Those stay at content-max.
  const NARROW_FIXTURES = [
    /^Role group deletion review/,
    /^Administrators outside the admin group/,
    /^Server scan \(failed\)/,
    /^Channel claims with a failed scan/,
  ];

  const pages = adminPages().filter((p) =>
    p.html.includes("KoolBot Admin</title>"),
  );

  it("opts in exactly the table and board pages, and no other admin page", () => {
    expect(pages.length).toBeGreaterThan(100);
    const wrong: string[] = [];
    for (const page of pages) {
      const title =
        /<title>(.*?) — KoolBot Admin<\/title>/.exec(page.html)?.[1] ?? "";
      const isWide = /<main [^>]*class="[^"]*kb-main--wide/.test(page.html);
      const expected =
        WIDE_TITLES.has(title) &&
        !NARROW_FIXTURES.some((re) => re.test(page.name));
      if (isWide !== expected) wrong.push(`${page.name} (wide: ${isWide})`);
    }
    expect(wrong).toEqual([]);
  });

  it("sets no width of its own on any page", () => {
    // The only width a page body may set is through the layout's option; no max-width or width in a style attribute.
    const own = pages.filter((p) =>
      /<main[\s\S]*?style="[^"]*max-width/.test(p.html),
    );
    expect(own.map((p) => p.name)).toEqual([]);
  });

  it("caps the legacy text blocks in the admin sheet only, and covers every one a wide page renders", () => {
    // kb.css is the post-#1652 sheet and carries no legacy class names; the admin sheet's rule goes with them.
    expect(KB_CSS).not.toMatch(/\.subtitle|\.notice/);
    const html = renderAdminPage({
      title: "T",
      active: "/admin/",
      body: "<p>x</p>",
      csrfToken: "c",
      remainingMs: 1,
      wide: true,
    });
    const legacy = rule(
      html,
      "main.kb-main--wide :is(.subtitle,.notice,p.muted)",
    );
    expect(legacy).toContain("max-width:var(--content-max)");
    // Every legacy text class that appears in a wide fixture's page column is in that list.
    const used = new Set<string>();
    for (const page of pages) {
      if (!/<main [^>]*class="[^"]*kb-main--wide/.test(page.html)) continue;
      if (/class="subtitle"/.test(page.html)) used.add("subtitle");
      if (/class="notice[ "]/.test(page.html)) used.add("notice");
      if (/<p class="muted"/.test(page.html)) used.add("p.muted");
      for (const m of page.html.matchAll(
        /<(p|div) class="(subtitle|notice|help|helper|lead|hint)[ "]/g,
      )) {
        used.add(
          m[2] === "subtitle" || m[2] === "notice" ? m[2] : `unlisted:${m[2]}`,
        );
      }
    }
    expect([...used].filter((c) => c.startsWith("unlisted:"))).toEqual([]);
    expect(
      used.has("subtitle") && used.has("notice") && used.has("p.muted"),
    ).toBe(true);
  });
});
