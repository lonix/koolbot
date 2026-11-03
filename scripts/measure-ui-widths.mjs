#!/usr/bin/env node
/**
 * Measure which rendered Web UI pages scroll sideways at wide screens (#1629).
 *
 * Loads every page of a `render-ui-preview.mjs` render in one headless browser at each width and, for the
 * `main` column, every `.card`, `.kb-panel__body--flush` and `table`, records `scrollWidth - clientWidth`
 * (cards, panels and main) or the table's width past its scroll container, the table columns that sit past
 * the container's right edge, and the widest descendant that causes it. jsdom has no layout, so this needs
 * a real browser.
 *
 * Usage: node scripts/measure-ui-widths.mjs --html <render dir> [--widths 1280,1600,1920,2560] [--json <file>] [--open-details] [--strict]
 *   --css <rules>   inject extra CSS into every page first, to try a width rule before building it
 *   --strict        exit 1 when any page scrolls sideways as a whole (the "never the page" rule, #855)
 *   --open-details  open every <details> first: the worst state an admin can put a page in (folded controls shown)
 *   UI_PREVIEW_CHROME=<path>  use that browser binary instead of the installed Chrome
 * Prints a markdown table (page, width, element, overflow px, columns hidden, widest descendant).
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const htmlDir = path.resolve(arg("--html", "ui-preview/head"));
const widths = arg("--widths", "1280,1600,1920,2560").split(",").map(Number);
const jsonOut = arg("--json");
const openDetails = process.argv.includes("--open-details");
const strict = process.argv.includes("--strict");
const extraCss = arg("--css", "");

/* global document, getComputedStyle, window */
/** Runs in the page: one record per overflowing element. */
function measure() {
  // A refused form focuses its invalid control, which can leave a panel scrolled sideways; measure from the left edge.
  for (const el of document.querySelectorAll("*")) {
    if (el.scrollLeft) el.scrollLeft = 0;
  }
  window.scrollTo(0, 0);
  const text = (el) => (el.textContent || "").replace(/\s+/g, " ").trim();
  const label = (el) => {
    if (el.caption) return `table "${text(el.caption).slice(0, 28)}"`;
    const h = el
      .closest("section,div,form")
      ?.querySelector("h1,h2,h3,.kb-panel__title");
    const cls = (el.getAttribute("class") || "").split(" ")[0];
    return `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}${h ? ` "${text(h).slice(0, 28)}"` : ""}`;
  };
  const clipper = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (/auto|scroll|hidden|clip/.test(getComputedStyle(p).overflowX))
        return p;
    }
    return document.documentElement;
  };
  const rightEdge = (c) =>
    c.getBoundingClientRect().left + c.clientLeft + c.clientWidth;
  const widest = (el, limit) => {
    let best = null;
    for (const d of el.querySelectorAll("*")) {
      const r = d.getBoundingClientRect();
      if (r.width && r.right > limit + 1 && (!best || r.right > best.right))
        best = { d, right: r.right };
    }
    if (!best) return "";
    const cls = (best.d.getAttribute("class") || "").split(" ")[0];
    return `${best.d.tagName.toLowerCase()}${cls ? "." + cls : ""} +${Math.round(best.right - limit)}px`;
  };
  const out = [];
  const seen = new Set();
  const add = (el, kind) => {
    if (seen.has(el)) return;
    seen.add(el);
    const isTable = el.tagName === "TABLE";
    const box = isTable ? clipper(el) : el;
    const limit = rightEdge(box);
    const px = isTable
      ? Math.round(el.getBoundingClientRect().right - limit)
      : el.scrollWidth - el.clientWidth;
    if (px <= 1) return;
    const table = isTable ? el : el.querySelector("table");
    const cells = table
      ? [...(table.tHead?.rows[0] ?? table.rows[0]).cells]
      : [];
    const hidden = cells
      .filter((c) => c.getBoundingClientRect().right > limit + 1)
      .map((c) => text(c).slice(0, 24) || "(actions)");
    out.push({
      element: label(el),
      kind,
      px,
      hidden,
      cause: widest(el, limit),
      colsTotal: cells.length,
    });
  };
  for (const el of document.querySelectorAll(
    "main, .kb-main__inner, .kb-member",
  ))
    add(el, "main");
  for (const el of document.querySelectorAll(".card, .kb-panel__body--flush"))
    add(el, "box");
  for (const el of document.querySelectorAll("table")) add(el, "table");
  const de = document.documentElement;
  if (de.scrollWidth > de.clientWidth) {
    // The widest element no scroll container holds back (an absolutely positioned one is only clipped by a
    // scroller at or below its containing block): what makes the whole page scroll sideways.
    const escapes = (d) => {
      let free = getComputedStyle(d).position === "absolute";
      for (
        let p = d.parentElement;
        p && p !== document.body;
        p = p.parentElement
      ) {
        const cs = getComputedStyle(p);
        if (free && cs.position !== "static") free = false;
        if (!free && cs.overflowX !== "visible") return false;
      }
      return d.getBoundingClientRect().right > de.clientWidth + 1;
    };
    const far = [...document.body.querySelectorAll("*")]
      .filter(escapes)
      .sort(
        (a, b) =>
          b.getBoundingClientRect().right - a.getBoundingClientRect().right,
      )[0];
    const cls = far ? (far.getAttribute("class") || "").split(" ")[0] : "";
    out.push({
      element: "page (documentElement)",
      kind: "page",
      px: de.scrollWidth - de.clientWidth,
      hidden: [],
      colsTotal: 0,
      cause: far
        ? `${far.tagName.toLowerCase()}${cls ? "." + cls : ""} +${Math.round(far.getBoundingClientRect().right - de.clientWidth)}px`
        : "",
    });
  }
  const m = document.querySelector("main");
  const inner = document.querySelector(".kb-main__inner, .kb-member");
  return {
    main: m ? Math.round(m.getBoundingClientRect().width) : null,
    inner: inner ? Math.round(inner.getBoundingClientRect().width) : null,
    rows: out,
  };
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(htmlDir, "manifest.json"), "utf8"),
);
const executablePath = process.env.UI_PREVIEW_CHROME;
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : { channel: "chrome" }),
  args: ["--disable-dev-shm-usage"],
});
const results = [];
for (const width of widths) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    reducedMotion: "reduce",
  });
  // The pages are static and local: refuse anything else so a stalled network cannot hold a page load.
  await context.route(/^(?!file:)/, (route) => route.abort());
  let page = await context.newPage();
  for (const entry of manifest.pages) {
    const url = pathToFileURL(path.join(htmlDir, entry.file)).href;
    let measured;
    // A tab can crash on a busy machine: open a fresh one and try again.
    for (let attempt = 1; !measured; attempt++) {
      try {
        await page.goto(url, { waitUntil: "load" });
        if (extraCss) await page.addStyleTag({ content: extraCss });
        if (openDetails)
          await page.evaluate(() =>
            document
              .querySelectorAll("details")
              .forEach((d) => (d.open = true)),
          );
        measured = await page.evaluate(measure);
      } catch (err) {
        if (attempt >= 3) throw err;
        await page.close().catch(() => {});
        page = await context.newPage();
      }
    }
    results.push({
      page: entry.name,
      width,
      mainWidth: measured.main,
      innerWidth: measured.inner,
      rows: measured.rows,
    });
  }
  await context.close();
}
await browser.close();
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(results, null, 2) + "\n");

console.log(
  "| Page | Width | Element | Overflow px | Columns hidden | Widest descendant |\n| --- | --- | --- | --- | --- | --- |",
);
for (const r of results) {
  for (const o of r.rows) {
    const cols = o.hidden.length
      ? `${o.hidden.length} of ${o.colsTotal}: ${o.hidden.join(", ")}`
      : "";
    console.log(
      `| ${r.page} | ${r.width} | ${o.element} | ${o.px} | ${cols} | ${o.cause} |`.replace(
        /\|\|/g,
        "| |",
      ),
    );
  }
}
if (strict && results.some((r) => r.rows.some((o) => o.kind === "page"))) {
  console.error(
    "A page scrolls sideways as a whole (rows marked page (documentElement)).",
  );
  process.exit(1);
}
