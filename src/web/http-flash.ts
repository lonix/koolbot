import type { Response } from "express";

/**
 * Shared flash/error helpers for the WebUI's state-changing routes.
 *
 * Lives in its own module (rather than `write-routes.ts`) so the CSRF and
 * rate-limit middleware and the router-level error handler can reuse
 * `wantsJson` / `respondFlashError` without importing the heavyweight write
 * router (which itself imports the CSRF middleware — a cycle we avoid here).
 */

/** Max length for inline flash/toast text, shared by redirect + JSON paths. */
export const FLASH_MAX = 500;

export function truncateFlash(text: string): string {
  return text.length > FLASH_MAX ? `${text.slice(0, FLASH_MAX - 1)}…` : text;
}

/**
 * Whether the client wants a JSON reply instead of the usual 303 flash
 * redirect. The Settings page's per-section Save is progressively enhanced to
 * submit via `fetch()` (issue #555) so the page no longer reloads and jumps to
 * the top; that request advertises itself with `X-Requested-With: fetch` (and
 * `Accept: application/json`). A plain form POST — the no-JS fallback — sends
 * neither and keeps the redirect path.
 */
/** A request we can read headers off — either `get` or its `header` alias. */
type HeaderReadable = {
  get?(name: string): string | string[] | undefined;
  header?(name: string): string | string[] | undefined;
};

export function wantsJson(req: HeaderReadable): boolean {
  // Express exposes header lookup as both `.get` and its `.header` alias; use
  // whichever is present so callers (and test stubs) can supply either.
  const lookup =
    typeof req.get === "function"
      ? req.get.bind(req)
      : typeof req.header === "function"
        ? req.header.bind(req)
        : undefined;
  // Header values are compared case-insensitively: media types (RFC 9110)
  // and our `fetch` sentinel are both case-insensitive, so a client sending
  // `Accept: Application/JSON` must still get the JSON reply.
  const header = (name: string): string => {
    const raw = lookup?.(name);
    return (Array.isArray(raw) ? raw.join(",") : (raw ?? "")).toLowerCase();
  };
  if (header("X-Requested-With") === "fetch") {
    return true;
  }
  return header("Accept").includes("application/json");
}

/**
 * Reply to a failed state-changing request with a structured error. AJAX
 * callers (`wantsJson`) get `{ type: 'err', text }` carrying the real HTTP
 * status so the client can surface the actual reason instead of a flat
 * "unexpected server response" (issue #612); the no-JS fallback gets the same
 * text as plain text. Text is capped so a noisy failure can't blow past
 * header/body limits.
 */
export function respondFlashError(
  req: HeaderReadable,
  res: Response,
  status: number,
  text: string,
): void {
  const body = truncateFlash(text);
  if (wantsJson(req)) {
    res.status(status).json({ type: "err", text: body });
    return;
  }
  res.status(status).type("text/plain").send(body);
}
