#!/usr/bin/env node
/**
 * Screenshot the pages written by render-ui-preview.mjs (#1327, #1341).
 *
 * Uses playwright-core with the browser already on the machine (Google Chrome
 * on GitHub's ubuntu runners via `channel: "chrome"`); nothing is downloaded.
 * Set UI_PREVIEW_CHROME to a browser executable to use a different one.
 *
 * One full-page PNG per page at 1280px wide (`<slug>.png`), plus a 390px
 * variant (`<slug>@390.png`) for the pages the manifest marks `mobile`. A
 * "before" shot of the base branch's render is `<slug>.base.png`.
 *
 * Two ways to run it:
 *
 *   --html <dir> --out <dir>
 *       every page of one render (the local-use form)
 *
 *   --plan <plan.json> --head <dir> [--base <dir>] --out <dir>
 *       the PR form: stages the artifact under --out as
 *         changed/    changed pages, before and after   (mode some)
 *         sample/     the highlighted sample             (mode all, no-base)
 *         all-pages/  every page, after only             (mode all, no-base)
 *         html/       the head render (pages, stylesheets)
 *         manifest.json, plan.json
 *       and nothing but the two JSON files when no page changed (mode none).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { readManifest, shotSets } from "./ui-preview-plan.mjs";

const arg = (name, required = true) => {
  const i = process.argv.indexOf(name);
  if (i < 0 || !process.argv[i + 1]) {
    if (required) throw new Error(`Missing ${name}`);
    return undefined;
  }
  return path.resolve(process.argv[i + 1]);
};

/**
 * Photograph `pages` (manifest entries) of the render in `htmlDir` into `outDir`.
 * `tag` is ".base" for before shots. A page whose HTML is missing is skipped.
 */
export async function shoot(browser, htmlDir, outDir, pages, tag = "") {
  fs.mkdirSync(outDir, { recursive: true });
  for (const width of [1280, 390]) {
    const context = await browser.newContext({
      viewport: { width, height: 800 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    for (const entry of pages) {
      if (width === 390 && !entry.mobile) continue;
      const file = path.join(htmlDir, entry.file);
      if (!fs.existsSync(file)) continue;
      await page.goto(pathToFileURL(file).href, { waitUntil: "load" });
      const suffix = `${width === 390 ? "@390" : ""}${tag}.png`;
      await page.screenshot({
        path: path.join(outDir, entry.file.replace(/\.html$/, suffix)),
        fullPage: true,
      });
    }
    await context.close();
  }
}

const launch = () => {
  const executablePath = process.env.UI_PREVIEW_CHROME;
  return chromium.launch(
    executablePath ? { executablePath } : { channel: "chrome" },
  );
};

async function main() {
  const outDir = arg("--out");
  const planFile = arg("--plan", false);

  if (!planFile) {
    const htmlDir = arg("--html");
    const { pages } = readManifest(htmlDir);
    const browser = await launch();
    try {
      await shoot(browser, htmlDir, outDir, pages);
    } finally {
      await browser.close();
    }
    console.log(`Screenshots written to ${outDir}`);
    return;
  }

  const headDir = arg("--head");
  const baseDir = arg("--base", false);
  const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
  const head = readManifest(headDir);
  const sets = shotSets(plan);

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(
    path.join(headDir, "manifest.json"),
    path.join(outDir, "manifest.json"),
  );
  fs.copyFileSync(planFile, path.join(outDir, "plan.json"));

  if (sets.length === 0) {
    console.log("No page changed: no screenshots taken.");
    return;
  }

  fs.cpSync(headDir, path.join(outDir, "html"), { recursive: true });
  const browser = await launch();
  try {
    for (const set of sets) {
      const folder = path.join(outDir, set.folder);
      const pages = set.pages ?? head.pages;
      await shoot(browser, headDir, folder, pages);
      if (set.base && baseDir)
        await shoot(browser, baseDir, folder, pages, ".base");
    }
  } finally {
    await browser.close();
  }
  console.log(`Screenshots written to ${outDir} (${plan.mode})`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
