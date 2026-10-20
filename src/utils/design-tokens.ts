import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where `docs/design/tokens.json` lives, and a cached reader for it. Shared by
 * the Web UI stylesheets (`web/design-assets.ts`) and the Discord embed
 * colours (`utils/embed-style.ts`) so the path logic exists once.
 *
 * `docs/design/` is resolved relative to this module (`src/utils/` under
 * `npm run dev`, `dist/utils/` under `npm start` and in the image: both are two
 * levels below the repository root). The Dockerfiles copy `docs/design/` next
 * to `dist/`, so no build step is involved.
 */
export const DESIGN_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../docs/design",
);

let cachedJson: unknown = null;

/** Parse `tokens.json` once; later calls reuse the result. */
export function readDesignTokensJson(): unknown {
  if (cachedJson === null) {
    cachedJson = JSON.parse(
      fs.readFileSync(path.join(DESIGN_DIR, "tokens.json"), "utf8"),
    );
  }
  return cachedJson;
}

/** Test seam: drop the in-memory copy so the next call re-reads the file. */
export function resetDesignTokensForTests(): void {
  cachedJson = null;
}
