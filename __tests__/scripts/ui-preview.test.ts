import { describe, it, expect } from "@jest/globals";
// @ts-expect-error -- plain Node ESM tooling script, no type declarations
import * as render from "../../scripts/render-ui-preview.mjs";
// @ts-expect-error -- plain Node ESM tooling script, no type declarations
import * as summary from "../../scripts/ui-preview-summary.mjs";
import { allPages } from "../web/a11y-pages.js";

describe("UI preview scripts (#1327)", () => {
  it("gives every page fixture a distinct, non-empty file name", () => {
    const files = allPages().map((p) => render.slugify(p.name) as string);
    expect(files.every((f) => f.length > 0)).toBe(true);
    expect(new Set(files).size).toBe(files.length);
  });

  it("every mobile page names a real fixture", () => {
    const names = allPages().map((p) => p.name);
    for (const name of render.MOBILE_PAGES as string[]) {
      expect(names).toContain(name);
    }
  });

  it("points both asset prefixes at the local copies and fixes the nonce", () => {
    const html =
      '<link rel="stylesheet" href="/admin/_assets/tokens.css?v=abc123">' +
      '<link rel="stylesheet" href="/me/_assets/kb.css?v=abc123">' +
      '<script nonce="koolbot-nonce-0123abcd"></script>';
    expect(render.rewriteAssetUrls(html)).toBe(
      '<link rel="stylesheet" href="tokens.css">' +
        '<link rel="stylesheet" href="kb.css">' +
        '<script nonce="koolbot-nonce-preview"></script>',
    );
  });

  it("lists changed pages first, and every page when there is no base", () => {
    const page = (name: string, sha256: string) => ({
      name,
      file: `${name}.html`,
      sha256,
      mobile: false,
    });
    const head = {
      pages: [page("a", "1"), page("b", "2")],
      assets: { "kb.css": "x" },
    };
    const base = {
      pages: [page("a", "1"), page("b", "other")],
      assets: { "kb.css": "x" },
    };
    const out = summary.summarise(head, base) as string;
    expect(out).toMatch(/Changed pages \(1\)\n\n- b:/);
    expect(out.indexOf("Changed pages")).toBeLessThan(
      out.indexOf("Unchanged pages"),
    );

    const noBase = summary.summarise(head, null) as string;
    expect(noBase).toContain("could not be rendered");
    expect(noBase).toContain("- a:");
    expect(noBase).toContain("- b:");
  });
});
