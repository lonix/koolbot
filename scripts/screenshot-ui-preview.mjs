#!/usr/bin/env node
/**
 * Screenshot the pages written by render-ui-preview.mjs (#1327).
 *
 * Uses playwright-core with the browser already on the machine (Google Chrome
 * on GitHub's ubuntu runners via `channel: "chrome"`); nothing is downloaded.
 * Set UI_PREVIEW_CHROME to a browser executable to use a different one.
 *
 * One full-page PNG per page at 1280px wide (`<slug>.png`), plus a 390px
 * variant (`<slug>@390.png`) for the pages the manifest marks `mobile`.
 *
 * Usage: node scripts/screenshot-ui-preview.mjs --html <dir> --out <dir>
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`Missing ${name}`);
  return path.resolve(process.argv[i + 1]);
};

async function main() {
  const htmlDir = arg("--html");
  const outDir = arg("--out");
  const { pages } = JSON.parse(
    fs.readFileSync(path.join(htmlDir, "manifest.json"), "utf8"),
  );
  fs.mkdirSync(outDir, { recursive: true });

  const executablePath = process.env.UI_PREVIEW_CHROME;
  const browser = await chromium.launch(
    executablePath ? { executablePath } : { channel: "chrome" },
  );
  try {
    for (const width of [1280, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: 800 },
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      for (const entry of pages) {
        if (width === 390 && !entry.mobile) continue;
        await page.goto(pathToFileURL(path.join(htmlDir, entry.file)).href, {
          waitUntil: "load",
        });
        const suffix = width === 390 ? "@390.png" : ".png";
        await page.screenshot({
          path: path.join(outDir, entry.file.replace(/\.html$/, suffix)),
          fullPage: true,
        });
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`Screenshots written to ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
