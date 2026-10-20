import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router, type Request, type Response } from "express";
import logger from "../utils/logger.js";
import { createRateLimiter } from "./rate-limit.js";

/**
 * The Web UI's design assets (#1315): one `tokens.css` generated from
 * `docs/design/tokens.json` plus the `kb.css` component stylesheet, served as
 * two static files and linked from every page (both layouts and the pre-auth
 * pages) so the palette lives in exactly one place.
 *
 * Where the files come from. `docs/design/` is read relative to this module
 * (`src/web/` under `npm run dev`, `dist/web/` under `npm start` and in the
 * image: both are two levels below the repository root), so the same code
 * works in all three without a build step. `tokens.css` is generated on first
 * use from `tokens.json` and cached in memory together with a content-hash
 * version, so editing `tokens.json` or `kb.css` and restarting the bot changes
 * every page (`node --watch` does not watch files read at runtime, so
 * `npm run dev` needs a manual restart for these two); there is no generated
 * file to commit or forget to rebuild. The Dockerfiles copy `docs/design/` next to `dist/`.
 *
 * Serving. The files are served from a fixed two-entry map (never a directory
 * lookup from the request path, so there is nothing to traverse), under
 * `/admin/_assets/` and `/me/_assets/`, ahead of the security-header,
 * CSRF and session middleware: login, sign-out and error pages render before
 * any session exists and must be styled too, and the files are public design
 * data. They are cacheable (`immutable` when the `?v=` hash matches) and so
 * deliberately do not carry the `Cache-Control: no-store` of the pages.
 */

const DESIGN_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../docs/design",
);

const ASSET_PATH = "_assets";

interface ColorToken {
  name: string;
  value: string;
}

interface TypeStyle {
  name: string;
  fontSize: string;
  lineHeight: number | string;
  fontWeight: number | string;
  letterSpacing?: string;
}

interface ScalarToken {
  name: string;
  value: string;
}

export interface DesignTokens {
  color: { tokens: ColorToken[] };
  type: {
    families: Record<string, string>;
    groups: { name: string; styles: TypeStyle[] }[];
  };
  spacing: { tokens: ScalarToken[] };
  radius: { tokens: ScalarToken[] };
  shadow: { tokens: ScalarToken[] };
  layout: { tokens: ScalarToken[] };
}

/** `{warn}` in tokens.json means "the same as the `warn` token". */
function resolveValue(value: string): string {
  const ref = /^\{([a-z0-9-]+)\}$/.exec(value);
  return ref ? `var(--${ref[1]})` : value;
}

/**
 * Turn the parsed `tokens.json` into the `:root` custom properties: colours
 * and shadows, then spacing, radius and layout, the two font stacks
 * (`--font-sans`, `--font-mono`) and, for every type style,
 * `--type-<style>-size|line-height|weight` plus `-letter-spacing` where set.
 */
export function buildTokensCss(tokens: DesignTokens): string {
  const lines: string[] = [];
  const add = (name: string, value: string | number): void => {
    lines.push(`  --${name}: ${resolveValue(String(value))};`);
  };
  for (const t of tokens.color.tokens) add(t.name, t.value);
  for (const t of tokens.shadow.tokens) add(t.name, t.value);
  for (const t of tokens.spacing.tokens) add(t.name, t.value);
  for (const t of tokens.radius.tokens) add(t.name, t.value);
  for (const t of tokens.layout.tokens) add(t.name, t.value);
  for (const [family, stack] of Object.entries(tokens.type.families)) {
    add(`font-${family}`, stack);
  }
  for (const group of tokens.type.groups) {
    for (const s of group.styles) {
      add(`type-${s.name}-size`, s.fontSize);
      add(`type-${s.name}-line-height`, s.lineHeight);
      add(`type-${s.name}-weight`, s.fontWeight);
      if (s.letterSpacing)
        add(`type-${s.name}-letter-spacing`, s.letterSpacing);
    }
  }
  return (
    "/* Generated from docs/design/tokens.json by src/web/design-assets.ts. Do not edit. */\n" +
    `:root {\n${lines.join("\n")}\n}\n`
  );
}

export interface DesignAssets {
  files: Record<string, string>;
  version: string;
}

let cached: DesignAssets | null = null;

/** Read, generate and hash the assets once; later calls reuse the result. */
export function loadDesignAssets(): DesignAssets {
  if (cached) return cached;
  const tokens = JSON.parse(
    fs.readFileSync(path.join(DESIGN_DIR, "tokens.json"), "utf8"),
  ) as DesignTokens;
  const files: Record<string, string> = {
    "tokens.css": buildTokensCss(tokens),
    "kb.css": fs.readFileSync(path.join(DESIGN_DIR, "kb.css"), "utf8"),
  };
  const hash = crypto.createHash("sha256");
  for (const name of Object.keys(files).sort()) hash.update(files[name]);
  cached = { files, version: hash.digest("hex").slice(0, 12) };
  return cached;
}

/** Test seam: drop the in-memory copy so the next call re-reads the files. */
export function resetDesignAssetsForTests(): void {
  cached = null;
}

/**
 * The two `<link rel="stylesheet">` tags for a page served under `surface`
 * (`/admin` or `/me`). The `?v=` hash busts the browser cache whenever
 * `tokens.json` or `kb.css` changes. If the files cannot be read the links
 * are still emitted (without a version), so the failure shows up as one
 * logged error and a 500 on the stylesheet rather than a crash per page.
 */
export function designStylesheetLinks(surface: "/admin" | "/me"): string {
  let query = "";
  try {
    query = `?v=${loadDesignAssets().version}`;
  } catch (err) {
    logger.error("Web UI design assets could not be loaded", err);
  }
  return ["tokens.css", "kb.css"]
    .map(
      (file) =>
        `<link rel="stylesheet" href="${surface}/${ASSET_PATH}/${file}${query}">`,
    )
    .join("");
}

/** Public, unauthenticated, no-session router for the two stylesheets. */
export function createDesignAssetsRouter(): Router {
  const router = Router();
  // Generous: each page load fetches two files. It bounds the (cached) file read per client.
  router.use(
    createRateLimiter({ windowMs: 60_000, max: 300, keyName: "design-assets" }),
  );
  router.get("/:file", (req: Request, res: Response) => {
    const name = String(req.params.file);
    let assets: DesignAssets;
    try {
      assets = loadDesignAssets();
    } catch (err) {
      logger.error("Web UI design assets could not be loaded", err);
      res.status(500).type("text/plain").send("Stylesheet unavailable");
      return;
    }
    // Own-property lookup in a fixed map: any other name is a plain 404.
    if (!Object.prototype.hasOwnProperty.call(assets.files, name)) {
      res.status(404).type("text/plain").send("Not found");
      return;
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Cache-Control",
      req.query.v === assets.version
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    );
    res.type("text/css").send(assets.files[name]);
  });
  return router;
}
