import { escapeHtml } from "./html.js";

/** What the Environment page shows about the signed-in session (#1635). */
export interface SessionDiagnostics {
  /** When the session was issued (sign-in), in ms since the epoch. */
  issuedAt?: number;
  /** When the PREVIOUS real request was, before this page renewed the session. */
  previousActivityAt?: number;
  /** The server's clock for this page, in ms since the epoch. */
  now: number;
  /** The inactivity window in ms. */
  windowMs: number;
  /** The server-side hard cap. */
  expiresAt: Date;
}

/** "2026-11-01 08:59 UTC", or an em dash when the value is not known. */
function utc(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "—";
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function minutes(n: number): string {
  return `${n} ${n === 1 ? "minute" : "minutes"}`;
}

/**
 * The session's real state, as a Panel with a KeyValue list (components.md).
 * The previous request is the one that matters: this page is itself a request
 * and has just renewed the session, so only the request before it shows what
 * kept the session alive.
 */
export function renderSessionPanel(s: SessionDiagnostics): string {
  const previous =
    s.previousActivityAt === undefined
      ? "—"
      : `${utc(s.previousActivityAt)} (${Math.max(0, Math.round((s.now - s.previousActivityAt) / 60000))} min before this page)`;
  const windowText = minutes(Math.max(1, Math.round(s.windowMs / 60000)));
  return `<section class="kb-panel" aria-labelledby="session-title">
  <header class="kb-panel__head"><h2 class="kb-panel__title" id="session-title">Your session</h2></header>
  <div class="kb-panel__body">
    <dl class="kb-kv"><dt>Signed in</dt><dd>${escapeHtml(utc(s.issuedAt))}</dd><dt>Previous request</dt><dd>${escapeHtml(previous)}</dd><dt>Inactivity window</dt><dd>${escapeHtml(windowText)}</dd><dt>Hard cap</dt><dd>${escapeHtml(utc(s.expiresAt.getTime()))}</dd></dl>
  </div>
  <footer class="kb-panel__foot">You are signed out after the inactivity window without a request, or at the hard cap, whichever comes first. Opening or saving a page counts as a request; the countdown in the top bar does not.</footer>
</section>`;
}
