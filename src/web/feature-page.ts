/**
 * Shared pieces of a feature page (#1301): the status line that opens it and
 * the script that remembers whether its folded settings were left open.
 *
 * A feature page reads status line, then the usable part (what the feature
 * holds and its main actions), then the settings, folded. The settings card
 * itself is `renderFeatureSettingsCard` in `admin-views.ts`.
 */

import { escapeHtml } from "./html.js";
import { icon } from "./icons.js";

/** The disclosure chevron; `.kb-disclosure[open]` turns it down. */
export const CHEVRON_ICON = icon("chevron-right", { className: "kb-chev" });

/** One fact on the status line. */
export interface StatusChip {
  /** Plain text, escaped on output ("Channel #quotes"). */
  text: string;
  /**
   * Marks something that is not set or not working. A warning chip carries an
   * icon as well as its colour, and links to where it is fixed when `href` is
   * given: a setting's control (`#set-<key>`) or another admin page.
   */
  warn?: boolean;
  href?: string;
  /** Set in the mono face, for ids, schedules and keys. */
  mono?: boolean;
}

/**
 * The status line at the top of a feature page: an On/Off badge, then one chip
 * per fact that is worth knowing before anything else. It replaces the Status
 * card, so the usable part of the page starts higher.
 */
export function renderStatusLine(opts: {
  enabled: boolean;
  /** Badge words; the default reads On / Off. */
  onLabel?: string;
  offLabel?: string;
  chips: readonly StatusChip[];
}): string {
  const badge = opts.enabled
    ? `<span class="kb-badge kb-badge--on">${escapeHtml(opts.onLabel ?? "On")}</span>`
    : `<span class="kb-badge kb-badge--off">${escapeHtml(opts.offLabel ?? "Off")}</span>`;
  const chips = opts.chips.map((c) => {
    const text = c.mono
      ? `<span class="kb-mono">${escapeHtml(c.text)}</span>`
      : escapeHtml(c.text);
    const cls = c.warn ? "kb-chip kb-chip--warn" : "kb-chip";
    const inner = `${c.warn ? icon("triangle-alert") : ""}${text}`;
    return c.href
      ? `<a class="${cls}" href="${escapeHtml(c.href)}">${inner}</a>`
      : `<span class="${cls}">${inner}</span>`;
  });
  return `<div class="kb-statusline" role="group" aria-label="Status">${[badge, ...chips].join("")}</div>`;
}

/** Link target of a setting's control on a feature page. */
export function settingHref(key: string): string {
  return `#set-${key}`;
}

/**
 * Remembers, per page, that the folded settings were left open, and opens them
 * when a link points at a control inside.
 *
 * - The server decides the first state (`open`, with `data-fold-forced`, when the
 *   feature is off or needs setup, and after a save). The script only ever opens
 *   a fold, so a remembered "closed" never closes one of those.
 * - Only a click on the summary counts as a choice, so opening the fold from
 *   script (a remembered state, a link to a control) is not remembered.
 * - Storage can be unavailable (private window, blocked site data): every
 *   access is in try/catch and the page works the same without it.
 * - A save made in place (`kb-saved`) removes the changed-from-default count,
 *   which was true only for the loaded values.
 * - Without JavaScript the `details` element still works natively.
 */
export const SETTINGS_FOLD_SCRIPT =
  "(function(){" +
  "var PREFIX='kb-settings-open:';" +
  "Array.prototype.forEach.call(document.querySelectorAll('details[data-settings-fold]'),function(d){" +
  "var key=PREFIX+(d.getAttribute('data-fold-key')||'');" +
  "try{if(window.localStorage.getItem(key)==='1')d.open=true}catch(e){}" +
  // The count was worked out when the page was built. A save through the page
  // makes it stale, so it goes until the next load rather than saying a wrong
  // number.
  "var h=d.querySelector('[data-fold-hint]');" +
  "if(h)d.addEventListener('kb-saved',function(){if(h.parentNode)h.parentNode.removeChild(h)},true);" +
  "var chosen=false;var s=d.querySelector('summary');" +
  "if(s)s.addEventListener('click',function(){chosen=true});" +
  "d.addEventListener('toggle',function(){if(!chosen)return;chosen=false;" +
  "try{window.localStorage.setItem(key,d.open?'1':'0')}catch(e){}})});" +
  "function reveal(){var h=window.location.hash;if(h.length<2)return;var el;" +
  "try{el=document.getElementById(decodeURIComponent(h.slice(1)))}catch(e){return}" +
  "var d=el&&el.closest?el.closest('details[data-settings-fold]'):null;" +
  "if(d&&!d.open){d.open=true;try{el.scrollIntoView()}catch(e){}}}" +
  "reveal();window.addEventListener('hashchange',reveal)})();";
