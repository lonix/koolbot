import { readFileSync } from "fs";
import logger from "./logger.js";

// `package.json` sits two levels above this module both in source
// (`src/utils/version.ts`) and in the compiled build (`dist/utils/version.js`),
// and the Docker image copies it next to `dist/`. It is read with `fs` rather
// than a JSON import because `rootDir: ./src` keeps the file outside the build.
const PACKAGE_JSON_URL = new URL("../../package.json", import.meta.url);

let cachedVersion: string | null = null;

/**
 * The running bot version, read once from `package.json` and cached for the
 * life of the process. Returns `"unknown"` when the file is missing or has no
 * `version`, so callers never have to handle a failure.
 */
export function getBotVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_URL, "utf8")) as {
      version?: unknown;
    };
    cachedVersion =
      typeof pkg.version === "string" && pkg.version.trim()
        ? pkg.version.trim()
        : "unknown";
  } catch (error) {
    logger.warn("Could not read bot version from package.json:", error);
    cachedVersion = "unknown";
  }
  return cachedVersion;
}
