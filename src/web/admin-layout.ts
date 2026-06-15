/**
 * Shared layout for the read-only admin pages added in #381. The scaffold's
 * `views.ts` keeps tiny static pages for sign-in / sign-out flows; this
 * module renders the navigated pages with the always-visible "session
 * expires in X · [Finish]" banner mandated by #367.
 */

import type { ConfigSchema } from "../services/config-schema.js";
import { getInactivityWindowMs } from "./session.js";
import { THEME } from "./theme.js";

// Re-exported from session.ts so the renderer and the cookie middleware
// share a single source of truth for the inactivity sliding window.
// Existing call sites and tests can keep importing it from this module.
export { getInactivityWindowMs };

/**
 * Enabled-state of feature-gated nav items, keyed by config-schema key.
 * `Partial` because callers legitimately omit keys — an absent key is
 * treated as enabled (fail-open) by `renderNav`.
 */
export type NavFeatureStatus = Partial<Record<keyof ConfigSchema, boolean>>;

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

interface NavItem {
  href: string;
  label: string;
  /**
   * Config key (a `<feature>.enabled` boolean) that gates this page. When
   * set and the feature resolves to `false`, the item is hidden from the
   * sidebar. Items without a `featureKey` — Dashboard, Settings, etc. —
   * are always shown. The page URL itself stays reachable by direct
   * navigation; only the nav advertisement is suppressed.
   *
   * Typed as `keyof ConfigSchema` so a typo in `NAV_ITEMS` fails at
   * compile time rather than silently never matching at runtime.
   */
  featureKey?: keyof ConfigSchema;
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/admin/", label: "Dashboard" },
  { href: "/admin/settings", label: "Settings" },
  { href: "/admin/permissions", label: "Permissions" },
  { href: "/admin/wizard", label: "Setup Wizard" },
  {
    href: "/admin/announcements",
    label: "Announcements",
    featureKey: "announcements.enabled",
  },
  { href: "/admin/polls", label: "Polls", featureKey: "polls.enabled" },
  {
    href: "/admin/reaction-roles",
    label: "Reaction Roles",
    featureKey: "reactionroles.enabled",
  },
  {
    href: "/admin/notices",
    label: "Notices",
    featureKey: "notices.enabled",
  },
  {
    href: "/admin/voice-channels",
    label: "Voice Channels",
    featureKey: "voicechannels.enabled",
  },
  { href: "/admin/bot-status", label: "Bot Status" },
  { href: "/admin/database", label: "Database" },
  { href: "/admin/audit/commands", label: "Command Audit" },
  { href: "/admin/bootstrap", label: "Bootstrap" },
];

/**
 * Resolve the enabled-state of every feature-gated nav item. Takes an
 * async boolean reader (in practice `ConfigService.getBoolean`) so this
 * module stays free of a direct ConfigService dependency and remains
 * unit-testable. The returned map is keyed by `featureKey`.
 *
 * Distinct feature keys are resolved in parallel (and de-duplicated, so
 * two nav items sharing a key would only trigger one read).
 */
export async function resolveNavFeatureStatus(
  isEnabled: (key: keyof ConfigSchema) => Promise<boolean>,
): Promise<NavFeatureStatus> {
  const keys = [
    ...new Set(
      NAV_ITEMS.flatMap((item) => (item.featureKey ? [item.featureKey] : [])),
    ),
  ];
  const results = await Promise.all(keys.map((key) => isEnabled(key)));
  const status: NavFeatureStatus = {};
  keys.forEach((key, i) => {
    status[key] = results[i];
  });
  return status;
}

export interface AdminPageOptions {
  title: string;
  active: string;
  body: string;
  csrfToken: string;
  remainingMs: number;
  /**
   * Enabled-state of feature-gated nav items. When omitted, every nav
   * item is shown (keeps direct callers and tests that don't care about
   * nav filtering working unchanged).
   */
  navFeatureStatus?: NavFeatureStatus;
}

const STYLE = [
  "*,*::before,*::after{box-sizing:border-box}",
  // Core palette is shared with the pre-auth pages via THEME (issue #569).
  `body{margin:0;font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:${THEME.bg};color:${THEME.text}}`,
  `a{color:${THEME.link};text-decoration:none}`,
  "a:hover{text-decoration:underline}",
  ".banner{background:#1f2937;border-bottom:1px solid #2d3748;padding:.5rem 1rem;display:flex;justify-content:space-between;align-items:center;font-size:.85rem}",
  ".banner .left{display:flex;gap:.75rem;align-items:center}",
  ".banner .pill{background:#374151;color:#d1d5db;padding:.15rem .5rem;border-radius:999px;font-size:.75rem}",
  ".banner form{display:inline;margin:0}",
  ".banner button{background:#ef4444;color:#fff;border:0;padding:.3rem .7rem;border-radius:4px;cursor:pointer;font-weight:600}",
  ".banner button:hover{background:#dc2626}",
  ".banner a.surface{color:#cbd5e1;background:#374151;padding:.25rem .55rem;border-radius:4px;font-weight:600;text-decoration:none;margin-right:.5rem}",
  ".banner a.surface:hover{background:#4b5563;color:#fff}",
  ".shell{display:flex;min-height:calc(100vh - 41px)}",
  "nav.side{background:#161a22;border-right:1px solid #2d3748;width:220px;padding:1rem .5rem;flex-shrink:0}",
  "nav.side ul{list-style:none;padding:0;margin:0}",
  "nav.side a{display:block;padding:.5rem .75rem;border-radius:6px;color:#cbd5e1}",
  "nav.side a:hover{background:#1f2937;text-decoration:none}",
  "nav.side a.active{background:#1d2a44;color:#fff}",
  "main{flex:1;padding:1.5rem 2rem;max-width:1100px}",
  "h1{margin:0 0 .25rem;font-size:1.5rem}",
  "h2{margin:1.5rem 0 .5rem;font-size:1.15rem;color:#cbd5e1}",
  ".subtitle{color:#94a3b8;margin:0 0 1rem}",
  ".card{background:#161a22;border:1px solid #2d3748;border-radius:8px;padding:1rem 1.25rem;margin:0 0 1rem}",
  ".card h2{margin-top:0}",
  "table{width:100%;border-collapse:collapse;font-size:.9rem}",
  "th,td{text-align:left;padding:.5rem .6rem;border-bottom:1px solid #2d3748;vertical-align:top}",
  "th{font-weight:600;color:#94a3b8;background:#1a1f2a}",
  "tr:hover td{background:#1a1f2a}",
  // Settings page: keep editable controls inside their cell and let long
  // current/default values wrap instead of pushing the table wide (issue #489).
  "td.settings-value{min-width:12rem}",
  "td.settings-value input[type=text],td.settings-value select{width:100%;box-sizing:border-box}",
  "td.settings-default{overflow-wrap:anywhere;word-break:break-word}",
  ".muted{color:#94a3b8}",
  ".mono{font-family:ui-monospace,SFMono-Regular,SF Mono,Menlo,monospace;font-size:.85rem}",
  ".tag{display:inline-block;padding:.1rem .45rem;border-radius:4px;font-size:.7rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em}",
  ".tag-on{background:#14532d;color:#bbf7d0}",
  ".tag-off{background:#4b1e1e;color:#fecaca}",
  ".tag-info{background:#1e3a8a;color:#bfdbfe}",
  ".tag-warn{background:#4a3a0d;color:#fde68a}",
  ".tag-diff-add{background:#14532d;color:#bbf7d0}",
  ".tag-diff-change{background:#4a3a0d;color:#fde68a}",
  ".tag-diff-reject{background:#4b1e1e;color:#fecaca}",
  ".empty{padding:1rem;color:#94a3b8;font-style:italic}",
  ".kv{display:grid;grid-template-columns:200px 1fr;gap:.4rem 1rem}",
  ".kv dt{color:#94a3b8}",
  ".kv dd{margin:0}",
  ".notice{padding:.6rem .8rem;border-radius:6px;margin:0 0 1rem}",
  ".notice.info{background:#1d2a44;color:#bfdbfe}",
  ".notice.ok{background:#14532d;color:#bbf7d0}",
  ".notice.warn{background:#4a3a0d;color:#fde68a}",
  ".notice.err{background:#4b1e1e;color:#fecaca}",
  "form.stack{display:flex;flex-direction:column;gap:.6rem}",
  "form.stack label{display:flex;flex-direction:column;gap:.25rem;font-size:.85rem;color:#cbd5e1}",
  "form.stack label.checkbox{flex-direction:row;align-items:center;gap:.5rem}",
  "form.stack input[type=text],form.stack input[type=number],form.stack input[type=url],form.stack textarea,form.stack select{background:#0f1115;color:#e4e6eb;border:1px solid #2d3748;border-radius:6px;padding:.4rem .55rem;font:inherit;font-size:.9rem}",
  "form.stack textarea{resize:vertical;min-height:5rem;font-family:ui-monospace,SFMono-Regular,SF Mono,Menlo,monospace}",
  "form.stack fieldset{border:1px solid #2d3748;border-radius:6px;padding:.5rem .75rem;display:flex;flex-direction:column;gap:.4rem}",
  "form.stack fieldset legend{color:#94a3b8;padding:0 .35rem}",
  ".inline-form{margin:.75rem 0 0;display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}",
  ".btn{background:#374151;color:#e4e6eb;border:0;padding:.35rem .7rem;border-radius:4px;cursor:pointer;font-size:.8rem;font-weight:600;display:inline-block;text-decoration:none}",
  ".btn:hover{background:#4b5563;text-decoration:none}",
  ".btn-primary{background:#2563eb;color:#fff}",
  ".btn-primary:hover{background:#1d4ed8}",
  ".btn-secondary{background:#374151;color:#d1d5db}",
  ".btn-secondary:hover{background:#4b5563}",
  ".btn-danger{background:#dc2626;color:#fff}",
  ".btn-danger:hover{background:#b91c1c}",
  ".btn-sm{padding:.2rem .5rem;font-size:.75rem}",
  ".btn[disabled],.btn[disabled]:hover{opacity:.5;cursor:not-allowed;background:#374151}",
  ".actions{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin-bottom:1rem}",
  ".actions form{margin:0}",
  ".field-row{display:flex;flex-direction:column;gap:.25rem;margin-bottom:.75rem}",
  ".field-row > label{font-size:.85rem;color:#94a3b8}",
  ".field-row .help{font-size:.75rem;color:#6b7280;margin-top:.15rem}",
  // Cascade greying: rows whose master `.enabled` toggle is off (#485).
  ".cascade-off{opacity:.5}",
  ".wizard-features{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:.75rem;margin-bottom:1rem}",
  ".feature-card{background:#0f1115;border:1px solid #2d3748;border-radius:6px;padding:.75rem 1rem;display:flex;gap:.75rem;align-items:flex-start}",
  ".feature-card input{margin-top:.2rem;flex-shrink:0}",
  ".feature-card .fc-info{flex:1}",
  ".feature-card .fc-name{font-weight:600;font-size:.9rem;color:#e4e6eb;display:block;cursor:pointer}",
  ".feature-card .fc-desc{font-size:.75rem;color:#94a3b8;margin-top:.1rem}",
  "select[multiple]{min-height:4rem;background:#0f1115;color:#e4e6eb;border:1px solid #2d3748;border-radius:6px;padding:.4rem .55rem;font:inherit;font-size:.9rem}",
  "td.actions{display:flex;gap:.35rem;flex-wrap:wrap}",
  "td.actions form{margin:0}",
  ".helper{background:#0f1115;border:1px solid #2d3748;border-radius:6px;padding:.4rem .6rem;font-size:.85rem}",
  ".helper summary{cursor:pointer;color:#cbd5e1;font-weight:600}",
  ".helper ul{margin:.4rem 0;padding-left:1.2rem}",
  "form.inline-order{display:flex;gap:.25rem;align-items:center;margin:0}",
  "form.inline-order input[type=number]{width:5rem;background:#0f1115;color:#e4e6eb;border:1px solid #2d3748;border-radius:6px;padding:.25rem .4rem;font:inherit;font-size:.85rem}",
  ".edit-details{flex:0 0 100%;margin-bottom:.35rem}",
  ".edit-details form.stack{margin-top:.5rem}",
  "button[disabled]{opacity:.5;cursor:not-allowed}",
  ".cron-picker{display:inline-flex;align-items:center;gap:.4rem;flex-wrap:wrap}",
  ".cron-picker select,.cron-picker input{font:inherit;font-size:.85rem;padding:.2rem .35rem;background:#0f1115;color:#e4e6eb;border:1px solid #2d3748;border-radius:6px}",
  ".cron-picker input[type=time]{width:7rem}",
  ".cron-picker[hidden]{display:none}",
].join("");

// Session banner script (#367, refreshed in #435).
//
// In addition to the per-second local tick from #367, this:
//   - polls `GET /admin/session/ping` every 30s and re-syncs the local
//     deadline from the server's authoritative remaining time (the ping
//     endpoint is read-only and does NOT itself extend the session).
//   - resets the local deadline on `mousemove` / `keydown` (debounced)
//     to the inactivity window length so the visible number stays
//     snappy between polls when the admin is actually interacting.
//
// `data-inactivity-ms` is the full sliding window (matches the server's
// `WEBUI_INACTIVITY_TIMEOUT_MINUTES`); activity-driven local resets
// never push the deadline past that. The server's hard cap
// (`expiresAt`, from the ping response) is also tracked and used as a
// ceiling on the optimistic activity reset so the UI can't briefly
// promise more time than the session can actually deliver.
const SCRIPT =
  "(function(){var el=document.getElementById('session-countdown');if(!el)return;" +
  "function toMs(v){var n=Math.floor(Number(v));return isFinite(n)&&n>0?n:0}" +
  "var deadline=Date.now()+toMs(el.getAttribute('data-remaining-ms'));" +
  "var inactivityMs=toMs(el.getAttribute('data-inactivity-ms'));" +
  // Absolute timestamp (ms since epoch) of the server's hard cap; 0
  // means "unknown yet" — filled in on the first successful ping.
  "var hardCapAt=0;var fired=false;var lastReset=0;" +
  "function expire(){if(fired)return;fired=true;window.location.href='/admin/'}" +
  "function tick(){var r=Math.max(0,deadline-Date.now());var s=Math.floor(r/1000);" +
  "var m=Math.floor(s/60);var ss=s%60;el.textContent=m+':'+(ss<10?'0'+ss:ss);" +
  // When the countdown hits 0, navigate to /admin/. The session middleware
  // will reject the now-expired cookie and render the scaffold's 401 page.
  "if(r<=0)expire()}" +
  "function applyRemaining(ms){deadline=Date.now()+toMs(ms);tick()}" +
  "function onActivity(){if(inactivityMs<=0||fired)return;" +
  // Debounce so a stream of mousemove events doesn't reset every frame.
  // Only nudge the deadline forward (never back) — and never past the
  // server's hard cap if we know it.
  "var now=Date.now();if(now-lastReset<5000)return;lastReset=now;" +
  "var target=inactivityMs;" +
  "if(hardCapAt>0){var cap=hardCapAt-now;if(cap<target)target=cap}" +
  "if(target>0&&deadline-now<target)applyRemaining(target)}" +
  "function poll(){if(fired)return;" +
  "fetch('/admin/session/ping',{credentials:'same-origin',headers:{'Accept':'application/json'},cache:'no-store'})" +
  ".then(function(res){if(res.status===401){expire();return null}" +
  "if(!res.ok)return null;return res.json()})" +
  ".then(function(data){if(!data)return;" +
  "if(typeof data.expiresAt==='string'){var t=Date.parse(data.expiresAt);if(!isNaN(t))hardCapAt=t}" +
  "if(typeof data.remainingMs==='number')applyRemaining(data.remainingMs)})" +
  ".catch(function(){})}" +
  // Initial poll fills `hardCapAt` quickly so the activity reset has a
  // ceiling even before the first 30s interval elapses.
  "tick();poll();setInterval(tick,1000);setInterval(poll,30000);" +
  "document.addEventListener('mousemove',onActivity,{passive:true});" +
  "document.addEventListener('keydown',onActivity)})();";

// Cron schedule picker (#444). Each .cron-picker on the page wraps a
// hidden input (located via the `.cron-hidden` class — its form-field
// name varies per row under the per-section save form, e.g.
// `value_<key>`) that the form actually submits, plus a mode <select>
// ("daily" / "weekly" / "monthly" / "custom"), a time picker, and
// day-of-week / day-of-month controls. This script keeps the hidden
// input in sync as the operator changes the controls so the form posts
// a canonical cron string. Custom mode just mirrors the raw text input
// verbatim, which is what server-side coercion expects for a `cron`-
// typed key today.
const CRON_PICKER_SCRIPT =
  "(function(){" +
  "function clamp(n,lo,hi){return Math.max(lo,Math.min(hi,n))}" +
  "function wire(p){var hidden=p.querySelector('.cron-hidden');" +
  "var mode=p.querySelector('.cron-mode');" +
  "var time=p.querySelector('.cron-time');" +
  "var dow=p.querySelector('.cron-dow');" +
  "var dom=p.querySelector('.cron-dom');" +
  "var custom=p.querySelector('.cron-custom');" +
  "var timeWrap=p.querySelector('.cron-time-wrap');" +
  "var dowWrap=p.querySelector('.cron-dow-wrap');" +
  "var domWrap=p.querySelector('.cron-dom-wrap');" +
  "var customWrap=p.querySelector('.cron-custom-wrap');" +
  "function show(el,on){if(el)el.hidden=!on}" +
  "function compute(){var m=mode.value;" +
  "if(m==='custom'){return custom.value}" +
  // Clamp every numeric field defensively. The day-of-month <input>
  // carries min/max but browsers only enforce that on form-submit
  // (and unevenly across vendors), so an operator typing 32 or 0 can
  // still end up with an invalid cron string here. Time inputs are
  // browser-constrained but we clamp anyway in case parseInt yields
  // something silly.
  "var parts=(time.value||'00:00').split(':');" +
  "var h=clamp(parseInt(parts[0],10)||0,0,23);" +
  "var mi=clamp(parseInt(parts[1],10)||0,0,59);" +
  "if(m==='daily')return mi+' '+h+' * * *';" +
  "if(m==='weekly')return mi+' '+h+' * * '+clamp(parseInt(dow.value,10)||0,0,6);" +
  "if(m==='monthly')return mi+' '+h+' '+clamp(parseInt(dom.value,10)||1,1,31)+' * *';" +
  "return hidden.value}" +
  "function refresh(){var m=mode.value;" +
  "show(timeWrap,m==='daily'||m==='weekly'||m==='monthly');" +
  "show(dowWrap,m==='weekly');" +
  "show(domWrap,m==='monthly');" +
  "show(customWrap,m==='custom');" +
  "hidden.value=compute();p.setAttribute('data-mode',m)}" +
  "function update(){hidden.value=compute()}" +
  "mode.addEventListener('change',refresh);" +
  // Listen for both `input` and `change`. Text/number inputs fire
  // `input` continuously; <select> elements only reliably fire
  // `change` (some browsers don't fire `input` for selects at all).
  "[time,dow,dom,custom].forEach(function(el){if(!el)return;" +
  "el.addEventListener('input',update);el.addEventListener('change',update)});" +
  "refresh()}" +
  "document.querySelectorAll('.cron-picker').forEach(wire)})();";

// Cascading disable (#485). When a master `.enabled` checkbox
// (`[data-cascade-master]`) inside a `[data-cascade-scope]` container is
// unchecked, every other input/select/textarea in that scope is disabled
// and its row greyed via `.cascade-off`. Re-checking re-enables them with
// their values intact (we only toggle `disabled`, never the value). Hidden
// inputs (csrf/keys/category) and buttons are left alone so the form still
// submits correctly. Used by both the wizard step form and the per-section
// Settings forms.
const CASCADE_DISABLE_SCRIPT =
  "(function(){" +
  "function wire(master){" +
  "var scope=master.closest('[data-cascade-scope]');if(!scope)return;" +
  "function apply(){var off=!master.checked;" +
  "scope.querySelectorAll('input,select,textarea').forEach(function(el){" +
  "if(el===master||el.type==='hidden')return;" +
  "el.disabled=off;" +
  "var row=el.closest('.field-row,tr');" +
  "if(row)row.classList.toggle('cascade-off',off)})}" +
  "master.addEventListener('change',apply);apply()}" +
  "document.querySelectorAll('[data-cascade-master]').forEach(wire)})();";

// AJAX section save (#555). Each Settings category is its own
// `POST /admin/settings/save-section` form. A plain submit 303-redirects
// back to /admin/settings, reloading the page and dropping the admin at the
// top — annoying when you just saved a section near the bottom. This
// progressively enhances the Save button: submit via fetch(), show the
// server's flash inline inside the same card, and leave scroll position
// untouched. The server returns JSON for these requests (Accept:
// application/json) and keeps the redirect for the no-JS path, so browsers
// without fetch/FormData/URLSearchParams fall back to the original
// full-page behaviour. The body is urlencoded (not multipart) so the
// router's express.urlencoded parser can read `_csrf` — see the body line.
//
// Per-row Reset buttons retarget /admin/settings/reset via `formaction`;
// those are left to submit natively (full reload). We track the clicked
// submitter manually as well as via `SubmitEvent.submitter` so a Reset on an
// older browser without `submitter` isn't mistakenly AJAX-posted to the
// save-section route.
const SETTINGS_SAVE_SCRIPT =
  "(function(){" +
  "var forms=document.querySelectorAll('form[action=\"/admin/settings/save-section\"]');" +
  "if(!forms.length)return;" +
  "function flashEl(form){var card=form.closest('.card');if(!card)return null;" +
  "var n=card.querySelector('.section-flash');" +
  "if(!n){n=document.createElement('div');n.className='notice section-flash';" +
  "form.parentNode.insertBefore(n,form)}return n}" +
  "function show(form,type,text){var n=flashEl(form);if(!n)return;" +
  "var cls=type==='ok'?'ok':type==='warn'?'warn':'err';" +
  "n.className='notice section-flash '+cls;n.textContent=text}" +
  "function submit(e,submitter){var form=e.currentTarget;" +
  // Reset buttons retarget via formaction — let those submit natively.
  "if(submitter&&submitter.getAttribute('formaction'))return;" +
  "if(typeof fetch!=='function'||typeof FormData!=='function'||typeof URLSearchParams!=='function')return;" +
  "e.preventDefault();" +
  "var save=form.querySelector('button[type=submit]:not([formaction])');" +
  "if(save)save.disabled=true;" +
  // Send as application/x-www-form-urlencoded, NOT multipart. The router
  // only mounts express.urlencoded (no multipart parser), so a multipart
  // FormData body would arrive empty server-side — losing `_csrf` and
  // tripping requireCsrf with "CSRF token missing" (issue #628). Wrapping
  // the FormData in URLSearchParams makes fetch send urlencoded, so the
  // CSRF token and every value_*/keys field round-trip through the parser.
  "fetch(form.action,{method:'POST',credentials:'same-origin',cache:'no-store'," +
  "headers:{'Accept':'application/json','X-Requested-With':'fetch'}," +
  "body:new URLSearchParams(new FormData(form))})" +
  ".then(function(res){if(res.status===401){window.location.href='/admin/';return null}" +
  // Read the body once as text and try to parse it as JSON. The server's
  // happy path and its error paths (CSRF/rate-limit/payload/unhandled) all
  // speak JSON now (issue #612); if something still returns non-JSON we keep
  // the HTTP status and the readable body so the toast says what went wrong
  // instead of a flat 'unexpected server response'.
  "var status=res.status;" +
  "return res.text().then(function(t){var d=null;try{d=JSON.parse(t)}catch(e){}" +
  "return{status:status,json:d,text:t}})})" +
  ".then(function(r){if(save)save.disabled=false;" +
  "if(!r)return;" +
  // A structured flash (server's happy path AND its error paths) carries a
  // non-empty `text`; show it, letting the HTTP status decide ok/err when the
  // server omits an explicit `type`. JSON without usable text (e.g. a proxy's
  // own envelope) must NOT be mistaken for a successful save, so fall through.
  "var jt=r.json&&typeof r.json==='object'?r.json.text:null;" +
  "var okStatus=r.status>=200&&r.status<300;" +
  "if(typeof jt==='string'&&jt){show(form,(r.json.type)||(okStatus?'ok':'err'),jt);return}" +
  "if(okStatus){show(form,'ok','Saved.');return}" +
  // Non-2xx with no usable JSON: surface the status plus any readable text.
  "var detail=(r.text||'').replace(/<[^>]*>/g,' ').replace(/\\s+/g,' ').trim();" +
  "var msg='Save failed ('+r.status+').';" +
  "if(detail)msg+=' '+(detail.length>200?detail.slice(0,199)+'…':detail);" +
  "show(form,'err',msg)})" +
  ".catch(function(){if(save)save.disabled=false;" +
  "show(form,'err','Save failed — network error. Your changes were not saved.')})}" +
  "function wire(form){var last=null;" +
  "form.addEventListener('click',function(ev){var t=ev.target;" +
  "if(t&&t.closest){var b=t.closest('button,input[type=submit]');" +
  "if(b&&form.contains(b))last=b}});" +
  "form.addEventListener('submit',function(e){submit(e,e.submitter||last);last=null})}" +
  "forms.forEach(wire)})();";

function renderNav(
  active: string,
  navFeatureStatus?: NavFeatureStatus,
): string {
  return NAV_ITEMS.filter((item) => {
    // No status map → show everything. Otherwise hide items whose gating
    // feature resolves to false. An unknown featureKey (missing from the
    // map) is treated as enabled so a wiring gap never blanks the nav.
    if (!navFeatureStatus || !item.featureKey) return true;
    return navFeatureStatus[item.featureKey] !== false;
  })
    .map((item) => {
      const isActive =
        item.href === active ||
        (item.href === "/admin/" && active === "/admin");
      const cls = isActive ? ' class="active"' : "";
      return `<li><a href="${escapeHtml(item.href)}"${cls}>${escapeHtml(item.label)}</a></li>`;
    })
    .join("");
}

export function renderAdminPage(opts: AdminPageOptions): string {
  const remainingMs = Math.max(0, Math.floor(opts.remainingMs));
  const inactivityMs = getInactivityWindowMs();
  return [
    "<!doctype html>",
    '<html lang="en"><head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="referrer" content="strict-origin-when-cross-origin">',
    `<title>${escapeHtml(opts.title)} — Koolbot Admin</title>`,
    `<style>${STYLE}</style>`,
    "</head><body>",
    '<div class="banner">',
    '<div class="left"><strong>Koolbot Admin</strong></div>',
    '<div class="right">',
    // "My preferences" link to the parallel `/me` surface added in #481.
    // The same session covers both surfaces; clicking this never forces
    // a re-sign-in and never burns a new magic-link token.
    '<a class="surface" href="/me/">My preferences</a>',
    "Session expires in ",
    `<span id="session-countdown" data-remaining-ms="${remainingMs}" data-inactivity-ms="${inactivityMs}" class="mono">--:--</span> · `,
    '<form method="POST" action="/admin/finish">',
    `<input type="hidden" name="_csrf" value="${escapeHtml(opts.csrfToken)}">`,
    '<button type="submit">Finish</button>',
    "</form></div></div>",
    '<div class="shell">',
    `<nav class="side"><ul>${renderNav(opts.active, opts.navFeatureStatus)}</ul></nav>`,
    `<main>${opts.body}</main></div>`,
    `<script>${SCRIPT}</script>`,
    `<script>${CRON_PICKER_SCRIPT}</script>`,
    `<script>${CASCADE_DISABLE_SCRIPT}</script>`,
    `<script>${SETTINGS_SAVE_SCRIPT}</script>`,
    "</body></html>",
  ].join("");
}

/**
 * Remaining session lifetime in milliseconds for the banner countdown.
 *
 * Two ceilings apply, and the banner has to honour both:
 *   - the inactivity sliding window (`WEBUI_INACTIVITY_TIMEOUT_MINUTES`),
 *     which the cookie middleware just refreshed back to its full length.
 *   - the server-side hard cap from `dbSession.expiresAt`
 *     (`WEBUI_SESSION_TTL_MINUTES`), surfaced on `WebSessionContext`.
 *
 * We display whichever ends sooner. Without `session`, we conservatively
 * fall back to inactivity-only (used by tests).
 */
export function getDisplayedRemainingMs(session?: { expiresAt: Date }): number {
  const inactivityMs = getInactivityWindowMs();
  if (!session) return inactivityMs;
  const hardCapMs = Math.max(0, session.expiresAt.getTime() - Date.now());
  return Math.min(inactivityMs, hardCapMs);
}
