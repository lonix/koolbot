/**
 * HTML escaping helpers shared by every WebUI renderer.
 *
 * The views build markup by string concatenation, so every dynamic value has
 * to be escaped at the interpolation site. These two functions are the only
 * sanctioned way to do that; `admin-layout.ts` and `views.ts` each used to
 * define their own `escapeHtml` (#851).
 */

import crypto from "node:crypto";

/** Escape a value for interpolation into HTML text or a quoted attribute. */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Escape a value for safe interpolation into a single-quoted JavaScript
 * string inside an HTML attribute (e.g. `onsubmit="return confirm('...')"`).
 *
 * `escapeHtml` is not enough: HTML entities are decoded back to characters
 * before the JS engine sees them, so a `'` in the input would terminate the
 * JS string and let surrounding markup leak into the script context. Strip
 * the dangerous characters here, then HTML-escape the result so the
 * attribute itself is also safe.
 */
export function escapeJsInAttr(value: unknown): string {
  if (value === null || value === undefined) return "";
  const jsSafe = String(value)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
    // Break any </script> sequence so the string can't escape its tag context.
    .replace(/<\/(script)/gi, "<\\/$1");
  return escapeHtml(jsSafe);
}

/**
 * Delegated confirmation for destructive actions. Inline `onsubmit` /
 * `onclick` handlers are blocked by the Web UI's Content-Security-Policy
 * (#1149), so a `<form data-confirm="...">` or `<button data-confirm="...">`
 * asks here instead (#1343).
 *
 * With JavaScript and `<dialog>.showModal()` the question opens as a native
 * `dialog.kb-dialog`: the `data-confirm` text is the title, an optional
 * `data-confirm-list` (a JSON array of strings, see `confirmListAttr`) lists the
 * consequences, and the confirm button repeats the verb of the trigger (its text,
 * or `data-confirm-verb`). Focus starts on the go-back button, Escape closes, and
 * focus returns to the trigger. Every string reaches the page through
 * `textContent`, never as HTML. Confirming re-submits the SAME form with
 * `requestSubmit`, so the CSRF token, the typed-name guard and the other submit
 * handlers behave as before. Without `showModal` it falls back to
 * `window.confirm()`; without JavaScript the form submits at once, as it always did.
 *
 * Registered in the capture phase so a declined question also stops the other
 * submit handlers (e.g. the Settings fetch() save).
 */
export const CONFIRM_SCRIPT = [
  "(function(){",
  "var bypass=null;",
  "function canDialog(){var d=document.createElement('dialog');return typeof d.showModal==='function'}",
  "function listOf(el){var raw=el.getAttribute('data-confirm-list');if(!raw)return[];",
  "try{var v=JSON.parse(raw);return Array.isArray(v)?v.filter(function(s){return typeof s==='string'&&s}):[]}catch(x){return[]}}",
  "function verbOf(src,btn){var v=src.getAttribute('data-confirm-verb');",
  "if(!v&&btn)v=btn.tagName==='INPUT'?btn.value:btn.textContent;",
  "v=(v||'').replace(/\\s+/g,' ').trim();return v||'Confirm'}",
  "function el(tag,cls,text){var n=document.createElement(tag);if(cls)n.className=cls;if(text)n.textContent=text;return n}",
  "function ask(src,btn,trigger,go){",
  "var d=el('dialog','kb-dialog'),title=el('h2','kb-dialog__title',src.getAttribute('data-confirm')),confirmed=false;",
  "title.id='kb-confirm-title';d.setAttribute('aria-labelledby',title.id);",
  "var head=el('div','kb-dialog__head'),body=el('div','kb-dialog__body'),foot=el('div','kb-dialog__foot');",
  "head.appendChild(title);var items=listOf(src);",
  "if(items.length){var ul=el('ul');items.forEach(function(t){ul.appendChild(el('li','',t))});body.appendChild(ul);",
  "body.id='kb-confirm-body';d.setAttribute('aria-describedby',body.id)}",
  "var back=el('button','kb-btn kb-btn--ghost','Go back'),ok=el('button','kb-btn '+(src.getAttribute('data-confirm-tone')==='neutral'?'kb-btn--primary':'kb-btn--danger'),verbOf(src,btn));",
  "back.type='button';ok.type='button';",
  "back.addEventListener('click',function(){d.close()});",
  "ok.addEventListener('click',function(){confirmed=true;d.close();go()});",
  "d.addEventListener('close',function(){if(d.parentNode)d.parentNode.removeChild(d);",
  "if(!confirmed&&trigger&&trigger.focus)trigger.focus()});",
  "foot.appendChild(back);foot.appendChild(ok);",
  "d.appendChild(head);d.appendChild(body);d.appendChild(foot);",
  "document.body.appendChild(d);d.showModal();back.focus()}",
  "document.addEventListener('submit',function(e){var f=e.target;",
  "if(!f||!f.getAttribute)return;var m=f.getAttribute('data-confirm');if(!m)return;",
  "if(bypass===f)return;",
  "if(!canDialog()){if(!window.confirm(m)){e.preventDefault();e.stopImmediatePropagation()}return}",
  "e.preventDefault();e.stopImmediatePropagation();",
  "var sub=e.submitter||f.querySelector('button[type=submit],button:not([type]),input[type=submit]');",
  "ask(f,sub,sub||document.activeElement,function(){bypass=f;",
  "try{if(f.requestSubmit){f.requestSubmit(e.submitter||undefined)}else{f.submit()}}",
  "catch(x){f.submit()}finally{bypass=null}})},true);",
  "document.addEventListener('click',function(e){",
  "var b=e.target&&e.target.closest?e.target.closest('button[data-confirm],input[data-confirm]'):null;",
  "if(!b)return;var m=b.getAttribute('data-confirm');if(!m||bypass===b)return;",
  "if(!canDialog()){if(!window.confirm(m)){e.preventDefault();e.stopImmediatePropagation()}return}",
  "e.preventDefault();e.stopImmediatePropagation();",
  "ask(b,b,b,function(){bypass=b;try{b.click()}finally{bypass=null}})},true)",
  "})();",
].join("");

/**
 * The tone of a confirmation (`data-confirm-tone`): `danger` (the default, so a
 * site that says nothing fails closed to red) or `neutral`, which gives the
 * confirm button the primary fill. Red is kept for actions that delete, remove,
 * cancel or reset, so admins do not learn to read it as routine.
 */
export const CONFIRM_NEUTRAL_ATTR = ` data-confirm-tone="neutral"`;

/**
 * The single source of truth for which `data-confirm` actions are NOT
 * destructive (form `action`, or a button's `formaction`). Only these may carry
 * `CONFIRM_NEUTRAL_ATTR`, and every one of them must: the drift test in
 * `__tests__/web/confirm-dialog.test.ts` checks both directions, and that no site
 * with a consequence list is ever neutral. Everything else is `danger`.
 */
export const NEUTRAL_CONFIRM_ACTIONS: readonly RegExp[] = [
  /^\/admin\/settings\/reload$/,
  /^\/admin\/birthdays\/run-now$/,
  /^\/admin\/digest\/send-now$/,
  /^\/admin\/leaderboard-roles\/run-now$/,
  /^\/admin\/moderation\/cases\/run-review$/,
  /^\/admin\/moderation\/cases\/[^/]+\/readmit$/,
  /^\/admin\/reaction-roles\/archive$/,
  /^\/admin\/rules\/sync$/,
  /^\/admin\/rules\/apply$/,
  /^\/admin\/adopt\/claims\/apply$/,
  /^\/admin\/adopt\/events\/apply$/,
  /^\/admin\/role-groups\/apply$/,
  /^\/admin\/role-groups\/admin-fix\/apply$/,
];

/** True when `action` is one of the non-destructive confirmations. */
export function isNeutralConfirmAction(action: string): boolean {
  return NEUTRAL_CONFIRM_ACTIONS.some((re) => re.test(action));
}

/**
 * The `data-confirm-list` attribute (leading space included) that gives a
 * `data-confirm` dialog its consequence list. The items are JSON inside an
 * HTML-escaped attribute and `CONFIRM_SCRIPT` renders them with `textContent`,
 * so they are plain text: pass them unescaped.
 */
export function confirmListAttr(items: readonly string[]): string {
  return ` data-confirm-list="${escapeHtml(JSON.stringify(items))}"`;
}

/**
 * Server-only marker standing in for the CSP nonce inside trusted inline
 * `<script>` blocks (#1149). It is random per process and never sent to a
 * client: the response middleware (`security-headers.ts`) replaces every
 * occurrence with the request's real nonce. Because only `scriptTag()` emits
 * it, a `<script>` that reaches the page through unescaped content (which
 * cannot know the marker) gets no valid nonce and the browser refuses to run
 * it.
 */
export const NONCE_MARKER = `koolbot-nonce-${crypto.randomBytes(24).toString("hex")}`;

/** A trusted inline script block; only call with a server-authored constant. */
export function scriptTag(js: string): string {
  return `<script nonce="${NONCE_MARKER}">${js}</script>`;
}
