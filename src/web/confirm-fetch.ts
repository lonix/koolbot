/**
 * Fetch-and-upgrade for the host panel's two-step settings routes (#1344, part
 * of #1330 and #1318).
 *
 * Turning groups off and removing groups always need a confirmation: the
 * server answers the form POST with a confirmation PAGE (`renderConfirmBody`)
 * whose signed single-use token binds the exact changes, the event revision and
 * who was connected. That page stays the no-JavaScript route, unchanged.
 *
 * With JavaScript (and `<dialog>.showModal()`), a form marked
 * `data-confirm-fetch` is posted with `fetch()` instead. The answer is used
 * only if it is the expected confirmation page (status, content type, the
 * server-only response header and the page marker); the plan-derived reasons
 * and changes are read from it as TEXT and shown in the shared `kb-dialog`
 * (`CONFIRM_SCRIPT`, event `kb-confirm-request`: one dialog system). Pressing
 * the dialog's confirm button posts the server's own confirm form fields
 * (`_csrf`, `token`) to `.../settings-confirm`; nothing else sends them.
 *
 * What the request can and cannot do is enforced on the server, not here: the
 * fetch carries `CONFIRM_ONLY_HEADER`, and `runLiveEdit` then refuses, before
 * it claims the revision or writes anything, every plan that would not end in
 * a confirmation page.
 */

/** Request header of the panel's fetch: "confirm this or change nothing". */
export const CONFIRM_ONLY_HEADER = "X-Kb-Confirm-Only";
export const CONFIRM_ONLY_VALUE = "1";

/** Response header only the confirmation page carries (never set by anything else). */
export const CONFIRM_PAGE_HEADER = "X-Kb-Confirm-Page";
export const CONFIRM_PAGE_VALUE = "needs-confirmation";

/**
 * The page marker of the confirmation page's section, and the markers of the
 * lists and the form the script reads. `renderConfirmBody` writes them; the
 * script reads nothing else from the response.
 */
export const CONFIRM_PAGE_MARKER = "live-settings";

/** Attribute (leading space) that upgrades a form. Only for actions the server always confirms. */
export const CONFIRM_FETCH_ATTR = " data-confirm-fetch";

/** The empty live region the script reports a problem in (inside the form). */
export function confirmFetchError(): string {
  return `<p class="kb-field__error" role="alert" data-confirm-fetch-error></p>`;
}

/** The pieces of the script as separate constants so the tests can name each guard. */
const SCRIPT_LINES = [
  "(function(){",
  `var HEAD_ONLY=${JSON.stringify(CONFIRM_ONLY_HEADER)},ONLY=${JSON.stringify(CONFIRM_ONLY_VALUE)},`,
  `HEAD_PAGE=${JSON.stringify(CONFIRM_PAGE_HEADER.toLowerCase())},PAGE=${JSON.stringify(CONFIRM_PAGE_VALUE)},`,
  `MARK=${JSON.stringify(CONFIRM_PAGE_MARKER)},inflight=null;`,
  "function usable(){var d=document.createElement('dialog');",
  "return typeof d.showModal==='function'&&typeof fetch==='function'&&typeof DOMParser==='function'",
  "&&typeof FormData==='function'&&typeof URLSearchParams==='function'&&typeof URL==='function'&&typeof CustomEvent==='function'}",
  "function text(n){return(n.textContent||'').replace(/\\s+/g,' ').trim()}",
  "function say(f,msg){var n=f.querySelector('[data-confirm-fetch-error]');if(n)n.textContent=msg}",
  "function urlOf(raw){try{return new URL(raw||'',location.href)}catch(x){return null}}",
  // The confirm form's fields: exactly the CSRF token (the one this form was
  // rendered with) and the signed token, nothing else.
  "function read(html,f,want){var doc=new DOMParser().parseFromString(html,'text/html');",
  "var sec=doc.querySelector('[data-confirm-page]');",
  "if(!sec||sec.getAttribute('data-confirm-page')!==MARK)return null;",
  "var cf=sec.querySelector('form[data-confirm-form]');if(!cf)return null;",
  "if((cf.getAttribute('method')||'').toLowerCase()!=='post')return null;",
  "var u=urlOf(cf.getAttribute('action'));",
  "if(!u||u.origin!==location.origin||u.pathname!==want)return null;",
  "var named=cf.querySelectorAll('input[name],select[name],textarea[name]');if(named.length!==2)return null;",
  "var csrf=cf.querySelector('input[type=hidden][name=_csrf]'),tok=cf.querySelector('input[type=hidden][name=token]');",
  "if(!csrf||!tok||!csrf.value||!tok.value)return null;",
  "var mine=f.querySelector('input[name=_csrf]');if(!mine||mine.value!==csrf.value)return null;",
  "var why=[].map.call(sec.querySelectorAll('[data-confirm-reasons] li'),text).filter(Boolean);",
  "var what=[].map.call(sec.querySelectorAll('[data-confirm-changes] li'),text).filter(Boolean);",
  "if(!why.length||!what.length)return null;",
  "var h=sec.querySelector('h2');",
  "return{title:(h&&text(h))||'Confirm these changes',items:why.concat(what),action:u.pathname,csrf:csrf.value,token:tok.value}}",
  "function isConfirmPage(r){return r.status===200&&!r.redirected&&r.type!=='opaqueredirect'",
  "&&(r.headers.get('content-type')||'').toLowerCase().indexOf('text/html')===0&&r.headers.get(HEAD_PAGE)===PAGE}",
  "function post(page){var g=document.createElement('form');g.method='POST';g.action=page.action;g.hidden=true;",
  "[['_csrf',page.csrf],['token',page.token]].forEach(function(p){var i=document.createElement('input');",
  "i.type='hidden';i.name=p[0];i.value=p[1];g.appendChild(i)});document.body.appendChild(g);g.submit()}",
  "function ask(f,sub,page){var done=false,detail={title:page.title,items:page.items,",
  "verb:sub?(sub.tagName==='INPUT'?sub.value:text(sub)):'',trigger:sub||null,",
  "go:function(){if(done)return;done=true;post(page)},handled:false};",
  "document.dispatchEvent(new CustomEvent('kb-confirm-request',{detail:detail}));",
  "if(!detail.handled)say(f,'The confirmation could not be shown. Nothing was changed. Reload the page and try again.')}",
  "document.addEventListener('submit',function(e){var f=e.target;",
  "if(!f||!f.hasAttribute||!f.hasAttribute('data-confirm-fetch')||!usable())return;",
  "e.preventDefault();e.stopImmediatePropagation();if(inflight)return;",
  "var act=urlOf(f.getAttribute('action'));",
  "if(!act||act.origin!==location.origin||!/\\/settings$/.test(act.pathname)){say(f,'This form cannot be confirmed here. Nothing was changed.');return}",
  "var panel=act.pathname.replace(/\\/settings$/,''),want=act.pathname+'-confirm';",
  "var sub=e.submitter||null,headers={'Accept':'text/html'};headers[HEAD_ONLY]=ONLY;",
  "inflight=f;say(f,'');if(sub)sub.disabled=true;",
  "var body=new URLSearchParams(new FormData(f));",
  "function fail(msg){say(f,msg||'The server did not answer as expected, so the change was not confirmed. Reload the page to see where things stand, then try again.')}",
  "fetch(act.pathname,{method:'POST',body:body,headers:headers,credentials:'same-origin'}).then(function(r){",
  "if(r.redirected){var u=urlOf(r.url);",
  // The server answered with its own redirect (a refusal, a stale form, a
  // finished session) and the flash it carries: show that page, post nothing.
  "if(u&&u.origin===location.origin&&u.pathname===panel){location.assign(u.pathname+u.search);return}",
  "return fail()}",
  "if(!isConfirmPage(r))return fail();",
  "return r.text().then(function(html){var page=read(html,f,want);if(!page)return fail();ask(f,sub,page)})",
  "}).catch(function(){fail()}).then(function(){inflight=null;if(sub)sub.disabled=false})},true)",
  "})();",
];

export const CONFIRM_FETCH_SCRIPT = SCRIPT_LINES.join("");
