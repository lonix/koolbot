#!/usr/bin/env node
/**
 * Decide which pages the UI preview screenshots (#1341).
 *
 * Compares the head render with the base branch's render by the SHA-256 of
 * each page's HTML (never pixels, so it cannot flake) and by the hash of the
 * shared stylesheets. A stylesheet change leaves every page's HTML identical
 * (the `?v=` hash is stripped), so it is its own signal and forces `all`.
 *
 * `mode`:
 *   none     nothing differs: no screenshots, only the manifest is uploaded
 *   some     only the pages in `changed` (head and base screenshots)
 *   all      the stylesheet differs, or every page's HTML does: a representative
 *            `sample` is highlighted and the full set goes in `all-pages/`
 *   no-base  the base could not be rendered, so nothing can be told apart; treated like `all`
 *
 * Usage: node scripts/ui-preview-plan.mjs --head <dir> [--base <dir>] --out <plan.json>
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MOBILE_PAGES } from "./render-ui-preview.mjs";

/**
 * Pages highlighted when everything changed: the dashboard, one settings page,
 * one /me page, and the pages that also get a 390px reflow screenshot.
 */
export const SAMPLE_PAGES = [
  "Dashboard",
  "Settings",
  "/me overview",
  ...MOBILE_PAGES,
];

export function plan(head, base) {
  const brief = (p) => ({ name: p.name, file: p.file, mobile: !!p.mobile });
  const sample = head.pages
    .filter((p) => SAMPLE_PAGES.includes(p.name))
    .map(brief);
  const out = {
    mode: "none",
    total: head.pages.length,
    changed: [],
    added: [],
    removed: [],
    cssChanged: [],
    sample,
  };

  if (!base) {
    out.mode = "no-base";
    return out;
  }

  const baseHash = new Map(base.pages.map((p) => [p.file, p.sha256]));
  out.changed = head.pages
    .filter((p) => baseHash.get(p.file) !== p.sha256)
    .map(brief);
  out.added = head.pages.filter((p) => !baseHash.has(p.file)).map(brief);
  out.removed = base.pages
    .filter((p) => !head.pages.some((h) => h.file === p.file))
    .map(brief);
  out.cssChanged = Object.keys({ ...head.assets, ...base.assets })
    .filter((f) => head.assets?.[f] !== base.assets?.[f])
    .sort();

  if (
    out.cssChanged.length > 0 ||
    (out.changed.length > 0 && out.changed.length === head.pages.length)
  ) {
    out.mode = "all";
  } else if (out.changed.length > 0 || out.removed.length > 0) {
    out.mode = "some";
  }
  return out;
}

/**
 * The pages to photograph, per artifact folder (`pages: null` is every page).
 * `base` marks a folder that also gets before screenshots.
 */
export function shotSets(p) {
  if (p.mode === "none") return [];
  if (p.mode === "some") {
    return [{ folder: "changed", pages: p.changed, base: true }];
  }
  return [
    { folder: "sample", pages: p.sample, base: p.mode === "all" },
    { folder: "all-pages", pages: null, base: false },
  ];
}

export const readManifest = (dir) => {
  if (!dir) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  } catch {
    return null;
  }
};

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const flag = (name) => {
    const i = process.argv.indexOf(name);
    return i > -1 ? process.argv[i + 1] : undefined;
  };
  const head = readManifest(flag("--head"));
  const outFile = flag("--out");
  if (!head || !outFile) {
    console.error("Usage: --head <dir> [--base <dir>] --out <plan.json>");
    process.exit(1);
  }
  const result = plan(head, readManifest(flag("--base")));
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2) + "\n");
  console.log(
    `UI preview plan: ${result.mode} (${result.changed.length} of ${result.total} pages changed)`,
  );
}
