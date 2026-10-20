import { describe, it, expect } from "@jest/globals";
// @ts-expect-error -- plain Node ESM tooling script, no type declarations
import * as render from "../../scripts/render-ui-preview.mjs";
// @ts-expect-error -- plain Node ESM tooling script, no type declarations
import * as planner from "../../scripts/ui-preview-plan.mjs";
// @ts-expect-error -- plain Node ESM tooling script, no type declarations
import * as comment from "../../scripts/ui-preview-comment.mjs";
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

  it("every sample page names a real fixture", () => {
    const names = allPages().map((p) => p.name);
    for (const name of planner.SAMPLE_PAGES as string[]) {
      expect(names).toContain(name);
    }
  });
});

describe("UI preview page selection (#1341)", () => {
  const page = (name: string, sha256: string, mobile = false) => ({
    name,
    file: `${name}.html`,
    sha256,
    mobile,
  });
  const manifest = (
    pages: ReturnType<typeof page>[],
    assets: Record<string, string> = { "kb.css": "x", "tokens.css": "y" },
  ) => ({ pages, assets });
  const names = (pages: { name: string }[]) => pages.map((p) => p.name);
  const heads = [
    page("Dashboard", "1", true),
    page("Settings", "2", true),
    page("Polls", "3"),
    page("Quotes", "4"),
  ];

  it("selects only the pages whose HTML differs", () => {
    const base = manifest([
      page("Dashboard", "1", true),
      page("Settings", "2", true),
      page("Polls", "other"),
      page("Quotes", "4"),
    ]);
    const out = planner.plan(manifest(heads), base);
    expect(out.mode).toBe("some");
    expect(names(out.changed)).toEqual(["Polls"]);
    expect(out.added).toEqual([]);
    expect(out.cssChanged).toEqual([]);
  });

  it("says nothing changed when every hash and stylesheet matches", () => {
    const out = planner.plan(manifest(heads), manifest(heads));
    expect(out.mode).toBe("none");
    expect(out.changed).toEqual([]);
    expect(planner.shotSets(out)).toEqual([]);
  });

  it("treats a stylesheet change as everything changed, though no page HTML differs", () => {
    const out = planner.plan(
      manifest(heads),
      manifest(heads, { "kb.css": "old", "tokens.css": "y" }),
    );
    expect(out.mode).toBe("all");
    expect(out.cssChanged).toEqual(["kb.css"]);
    expect(out.changed).toEqual([]);
  });

  it("treats every page differing as everything changed", () => {
    const base = manifest(
      heads.map((p) => ({ ...p, sha256: `old-${p.sha256}` })),
    );
    expect(planner.plan(manifest(heads), base).mode).toBe("all");
  });

  it("marks a new page as changed (no before) and lists a removed one", () => {
    const base = manifest([
      page("Dashboard", "1", true),
      page("Settings", "2", true),
      page("Polls", "3"),
      page("Gone", "9"),
    ]);
    const out = planner.plan(manifest(heads), base);
    expect(out.mode).toBe("some");
    expect(names(out.changed)).toEqual(["Quotes"]);
    expect(names(out.added)).toEqual(["Quotes"]);
    expect(names(out.removed)).toEqual(["Gone"]);
  });

  it("falls back to the all-pages path when there is no base render", () => {
    const out = planner.plan(manifest(heads), null);
    expect(out.mode).toBe("no-base");
    expect(out.changed).toEqual([]);
  });

  it("highlights the sample and keeps the full set when everything changed", () => {
    const out = planner.plan(manifest(heads), null);
    expect(names(out.sample)).toEqual(["Dashboard", "Settings"]);
    const sets = planner.shotSets(out);
    expect(sets.map((s: { folder: string }) => s.folder)).toEqual([
      "sample",
      "all-pages",
    ]);
    expect(sets[1].pages).toBeNull();
    // before shots only exist when a base render does
    expect(sets[0].base).toBe(false);
    const all = planner.plan(
      manifest(heads),
      manifest(heads, { "kb.css": "old" }),
    );
    expect(planner.shotSets(all)[0].base).toBe(true);
    expect(planner.shotSets(all)[1].base).toBe(false);
  });

  it("photographs only the changed pages, with before shots, in changed/", () => {
    const base = manifest([...heads.slice(0, 2), page("Polls", "x"), heads[3]]);
    const sets = planner.shotSets(planner.plan(manifest(heads), base));
    expect(sets).toHaveLength(1);
    expect(sets[0].folder).toBe("changed");
    expect(sets[0].base).toBe(true);
    expect(names(sets[0].pages)).toEqual(["Polls"]);
  });
});

describe("UI preview comment (#1341)", () => {
  const now = new Date("2026-10-20T18:02:33Z");
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const ctx = {
    artifactUrl: "https://github.com/o/r/actions/runs/1/artifacts/2",
    sha,
    repoUrl: "https://github.com/o/r",
    runUrl: "https://github.com/o/r/actions/runs/1",
    now,
  };
  const entry = (name: string, mobile = false) => ({
    name,
    file: `${name.toLowerCase()}.html`,
    mobile,
  });
  const some = {
    mode: "some",
    total: 78,
    changed: [entry("Polls"), entry("Dashboard", true)],
    added: [],
    removed: [],
    cssChanged: [],
    sample: [],
  };

  it("starts with the marker and carries commit, UTC time and artifact link", () => {
    const body = comment.buildComment(some, ctx) as string;
    expect(body.startsWith("<!-- ui-preview -->\n")).toBe(true);
    expect(body).toContain(
      `[\`0123456\`](https://github.com/o/r/commit/${sha})`,
    );
    expect(body).toContain("2026-10-20 18:02 UTC");
    expect(body).toContain(`(${ctx.artifactUrl})`);
    expect(body).toContain("2 of 78 pages changed");
    expect(body).toContain("- `Polls`: `polls.base.png`, `polls.png`\n");
    expect(body).toContain(
      "- `Dashboard`: `dashboard.base.png`, `dashboard.png`, `dashboard@390.png`, `dashboard@390.base.png`",
    );
  });

  it("links the run when there is no artifact URL, and survives no context at all", () => {
    const withRun = comment.buildComment(some, {
      ...ctx,
      artifactUrl: undefined,
    }) as string;
    expect(withRun).toContain(`[this run](${ctx.runUrl})`);
    expect(withRun).not.toContain("artifacts/2");

    const bare = comment.buildComment(some, { now }) as string;
    expect(bare.startsWith(comment.MARKER)).toBe(true);
    expect(bare).toContain("attached to this run");
    expect(bare).not.toContain("Commit");
  });

  it("ignores a link that is not https and a sha that is not hex", () => {
    const body = comment.buildComment(some, {
      ...ctx,
      artifactUrl: "javascript:alert(1)",
      sha: "not-a-sha) [x](y",
      repoUrl: "http://example.com",
    }) as string;
    expect(body).not.toContain("javascript:");
    expect(body).not.toContain("not-a-sha");
    expect(body).toContain(`[this run](${ctx.runUrl})`);
  });

  it("keeps hostile page names inert inside code spans", () => {
    expect(comment.code("a`b")).toBe("``a`b``");
    expect(comment.code("`edge`")).toBe("`` `edge` ``");
    expect(comment.code("two\nlines")).toBe("`two lines`");
    const hostile = "x`<b>hi</b>](http://evil) @everyone";
    const body = comment.buildComment(
      { ...some, changed: [{ ...entry(hostile), file: "hostile.html" }] },
      ctx,
    ) as string;
    const span = comment.code(hostile) as string;
    expect(span).toBe("``x`<b>hi</b>](http://evil) @everyone``");
    expect(body).toContain(`- ${span}: `);
    // the only raw occurrence of the hostile text is inside that span
    expect(body.split(hostile).length - 1).toBe(1);
  });

  it("says nothing changed and promises no screenshots", () => {
    const none = { ...some, mode: "none", changed: [] };
    const body = comment.buildComment(none, ctx) as string;
    expect(body).toContain("No rendered page differs from the base branch");
    expect(body).toContain("no screenshots were taken");
    expect(body).not.toContain(".png");
  });

  it("describes the all-changed case with the sample and the full-set folder", () => {
    const all = {
      ...some,
      mode: "all",
      changed: [],
      cssChanged: ["kb.css"],
      sample: [entry("Dashboard", true)],
    };
    const body = comment.buildComment(all, ctx) as string;
    expect(body).toContain("All 78 pages changed");
    expect(body).toContain("`kb.css`");
    expect(body).toContain("`sample/`");
    expect(body).toContain("`all-pages/`");
    expect(body).toContain("- `Dashboard`: `dashboard.base.png`");
  });

  it("lists no before shot for a new page in the all-changed sample", () => {
    const all = {
      ...some,
      mode: "all",
      changed: [],
      cssChanged: ["kb.css"],
      added: [entry("Fresh", true)],
      sample: [entry("Dashboard"), entry("Fresh", true)],
    };
    const body = comment.buildComment(all, ctx) as string;
    expect(body).toContain("- `Dashboard`: `dashboard.base.png`");
    expect(body).toContain(
      "- `Fresh`: `fresh.png`, `fresh@390.png` (new page, no before)",
    );
    expect(body).not.toContain("fresh.base.png");
    expect(body).not.toContain("fresh@390.base.png");
  });

  it("explains a missing base and lists no before shots", () => {
    const noBase = {
      ...some,
      mode: "no-base",
      changed: [],
      sample: [entry("Dashboard")],
    };
    const body = comment.buildComment(noBase, ctx) as string;
    expect(body).toContain("base branch could not be rendered");
    expect(body).toContain("- `Dashboard`: `dashboard.png`");
    expect(body).not.toContain(".base.png`");
  });

  it("marks new pages and lists removed ones", () => {
    const body = comment.buildComment(
      {
        ...some,
        changed: [entry("Polls"), entry("Fresh")],
        added: [entry("Fresh")],
        removed: [entry("Gone")],
      },
      ctx,
    ) as string;
    expect(body).toContain("- `Fresh`: `fresh.png` (new page, no before)");
    expect(body).toContain("1 page no longer rendered");
    expect(body).toContain("- `Gone`");
  });

  it("caps a long list, and the summary variant has no marker", () => {
    const many = Array.from({ length: 60 }, (_, i) => entry(`P${i}`));
    const body = comment.buildComment(
      { ...some, changed: many },
      ctx,
    ) as string;
    expect(body).toContain(`- and ${60 - comment.MAX_LISTED} more`);
    expect(body).not.toContain("`P59`");
    const summary = comment.buildComment(some, {
      ...ctx,
      summary: true,
    }) as string;
    expect(summary).not.toContain(comment.MARKER);
    expect(summary.startsWith("## UI preview")).toBe(true);
  });
});
