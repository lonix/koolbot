import crypto from "node:crypto";
import { Buffer } from "buffer";
import type { Response } from "express";
import { env } from "../config/env.js";

/**
 * Shared flash/error helpers for the WebUI's state-changing routes.
 *
 * Lives in its own module (rather than with the write-route helpers) so the
 * CSRF and rate-limit middleware and the router-level error handler can reuse
 * `wantsJson` / `respondFlashError` without importing the write routers (which
 * themselves import the CSRF middleware — a cycle we avoid here).
 */

/** Max length for inline flash/toast text, shared by redirect + JSON paths. */
export const FLASH_MAX = 500;

/**
 * Flash redirects carry their text in the query string, which anyone can
 * forge into a link (#1149). Redirects the server issues therefore add
 * `sig = HMAC(WEBUI_SESSION_SECRET, type + text)` and pages only render a
 * flash whose signature verifies, so a crafted `?flash=err&msg=...` link
 * shows nothing. The signature is not session-bound: a replayed link can
 * only ever show a message the server itself produced.
 */
function flashMac(type: string, text: string): string | null {
  const secret = env.webui.sessionSecret;
  if (!secret) return null;
  return crypto
    .createHmac("sha256", secret)
    .update(`flash\0${type}\0${text}`)
    .digest("base64url");
}

export function signFlash(type: string, text: string): string {
  return flashMac(type, text) ?? "";
}

export function verifyFlashSignature(
  type: string,
  text: string,
  sig: unknown,
): boolean {
  if (typeof sig !== "string" || !sig) return false;
  const expected = flashMac(type, text);
  if (!expected) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export interface SignedFlash {
  type: "ok" | "warn" | "err";
  text: string;
}

/**
 * Read a flash banner from a request's query string, returning it only when
 * the server signed it (see `signFlash`). Anything else, including a crafted
 * link, yields `null` and nothing is shown. One shared reader so each page
 * does not re-implement the check.
 */
export function readSignedFlash(query: {
  flash?: unknown;
  msg?: unknown;
  sig?: unknown;
}): SignedFlash | null {
  const type = String(query.flash ?? "");
  const text = String(query.msg ?? "");
  if (!text) return null;
  if (type !== "ok" && type !== "warn" && type !== "err") return null;
  if (!verifyFlashSignature(type, text, query.sig)) return null;
  return { type, text };
}

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
