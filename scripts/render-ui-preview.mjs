#!/usr/bin/env node
/**
 * Render every Web UI page to static HTML for the UI preview (#1327).
 *
 * Every page renderer is a pure function and `__tests__/web/a11y-pages.ts`
 * holds one fixture per page (the a11y gate scans the same list), so this
 * needs no Discord token, MongoDB or secrets. The fixtures are TypeScript, so
 * the script registers the repo's ts-node ESM loader itself (transpile only:
 * `npm run build` is the type gate) and imports them from the repository the
 * script lives in. The workflow copies this file into a base checkout to
 * render the base branch with the same code.
 *
 * Output (`--out <dir>`, default `ui-preview/html`):
 *   <slug>.html          one page per fixture
 *   tokens.css, kb.css   the generated design assets; the pages' `/admin/_assets/`
 *                        and `/me/_assets/` links (with the `?v=` hash) are
 *                        rewritten to these local copies
 *   manifest.json        { pages: [{ name, file, sha256, mobile }], assets: { name: sha256 } }
 *
 * Usage: node scripts/render-ui-preview.mjs [--out <dir>]
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Pages that also get a 390px screenshot: both shells, a form page, a table page (reflow, #855). */
export const MOBILE_PAGES = [
  "Dashboard",
  "Settings",
  "Channel manager",
  "/me overview",
  "/me birthday",
  "Signed out",
];

export function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Make the markup local and deterministic: point the shared stylesheet links
 * at the copies next to the page, and replace the per-render CSP nonce, so
 * rendering twice gives byte-identical HTML (the changed-pages comparison
 * hashes it).
 */
export function rewriteAssetUrls(html) {
  return html
    .replace(
      /(href=")\/(?:admin|me)\/_assets\/((?:tokens|kb)\.css)(?:\?v=[^"]*)?(")/g,
      "$1$2$3",
    )
    .replace(/koolbot-nonce-[0-9a-f]+/g, "koolbot-nonce-preview");
}

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

async function main() {
  const flag = process.argv.indexOf("--out");
  const out = path.resolve(
    flag > -1 ? process.argv[flag + 1] : path.join(root, "ui-preview/html"),
  );

  process.env.TS_NODE_TRANSPILE_ONLY = "1";
  register("ts-node/esm", pathToFileURL(`${root}/`));
  const { allPages } = await import(
    pathToFileURL(path.join(root, "__tests__/web/a11y-pages.ts")).href
  );
  const { loadDesignAssets } = await import(
    pathToFileURL(path.join(root, "src/web/design-assets.ts")).href
  );

  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  const assets = {};
  for (const [file, css] of Object.entries(loadDesignAssets().files)) {
    fs.writeFileSync(path.join(out, file), css);
    assets[file] = sha256(css);
  }

  const pages = [];
  const seen = new Set();
  for (const page of allPages()) {
    const file = `${slugify(page.name)}.html`;
    if (seen.has(file)) throw new Error(`Duplicate page file name: ${file}`);
    seen.add(file);
    const html = rewriteAssetUrls(page.html);
    fs.writeFileSync(path.join(out, file), html);
    pages.push({
      name: page.name,
      file,
      sha256: sha256(html),
      mobile: MOBILE_PAGES.includes(page.name),
    });
  }

  fs.writeFileSync(
    path.join(out, "manifest.json"),
    JSON.stringify({ pages, assets }, null, 2) + "\n",
  );
  console.log(`Rendered ${pages.length} pages to ${out}`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
