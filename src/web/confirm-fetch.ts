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

/**
 * Fetch-and-upgrade for confirmation LINKS (#1536): Channel manager's
 * *Delete…* and Adoption history's *Restore…*.
 *
 * Both are plain links to a server-rendered confirmation page, and that page
 * stays the no-JavaScript route, unchanged in behaviour. With JavaScript (and
 * `<dialog>.showModal()`), a link marked `data-confirm-link="<kind>"` is
 * fetched with GET instead, so the verdict, the consequences and any signed
 * token are as fresh as that page, and the answer is shown in the shared
 * `kb-dialog` (`CONFIRM_SCRIPT`, event `kb-confirm-request`).
 *
 * The answer is used only if it is the expected confirmation page: status 200,
 * HTML, the response header `CONFIRM_PAGE_HEADER` equal to the link's kind
 * (the routes set it only on the confirmable variant; a refusal says
 * `<kind>-refused` and is shown, reason only, in a dialog with no confirm
 * button), a section of that kind holding a POST form to the SAME path on this origin
 * whose fields are exactly the kind's allowlist, and at least one consequence.
 * Anything else (a redirect, a changed page, a failed request) navigates to the link,
 * so the admin sees today's page; nothing is ever posted from a page that did
 * not pass. Only the dialog's confirm button posts, with the page's own
 * `_csrf` (which must equal this page's) and its own fields, plus each option
 * ticked in the dialog (a checkbox the script adds to the shared dialog).
 */

/** What each kind of confirmation page may carry in its form. */
export const CONFIRM_LINK_KINDS = {
  "channel-delete": {
    hidden: ["_csrf", "confirm"],
    boxes: [] as string[],
    refusal: true,
  },
  "snapshot-restore": {
    hidden: ["_csrf"],
    boxes: ["deleteCreatedRoles"],
    refusal: false,
  },
} as const;

export type ConfirmLinkKind = keyof typeof CONFIRM_LINK_KINDS;

/** Attribute (leading space) that upgrades a confirmation link. */
export function confirmLinkAttr(kind: ConfirmLinkKind): string {
  return ` data-confirm-link="${kind}"`;
}

/** Marker (leading space) of the section of a confirmation page the script reads. */
export function confirmLinkPageAttr(kind: ConfirmLinkKind): string {
  return ` data-confirm-link-page="${kind}"`;
}

const LINK_SCRIPT_LINES = [
  "(function(){",
  `var HEAD=${JSON.stringify(CONFIRM_PAGE_HEADER.toLowerCase())},KINDS=${JSON.stringify(CONFIRM_LINK_KINDS)},inflight=null;`,
  "function usable(){var d=document.createElement('dialog');",
  "return typeof d.showModal==='function'&&typeof fetch==='function'&&typeof DOMParser==='function'",
  "&&typeof URL==='function'&&typeof CustomEvent==='function'}",
  "function text(n){return(n.textContent||'').replace(/\\s+/g,' ').trim()}",
  "function urlOf(raw){try{return new URL(raw||'',location.href)}catch(x){return null}}",
  "function read(html,kind,link,refused){var doc=new DOMParser().parseFromString(html,'text/html');",
  // A refusal (a channel that may not be deleted, and why) has no form: the
  // reason is shown in the dialog with no confirm button.
  "if(refused){var rf=doc.querySelector('[data-confirm-refusal]'),rt=rf&&rf.getAttribute('data-confirm-title'),rm=rf&&text(rf);",
  "return rt&&rm?{refusal:true,title:rt,items:[rm],verb:'',boxes:[]}:null}",
  "var sec=doc.querySelector('[data-confirm-link-page]');",
  "if(!sec||sec.getAttribute('data-confirm-link-page')!==kind)return null;",
  "var f=sec.querySelector('form[data-confirm-form]');if(!f)return null;",
  "if((f.getAttribute('method')||'').toLowerCase()!=='post')return null;",
  "var u=urlOf(f.getAttribute('action'));",
  "if(!u||u.origin!==location.origin||u.pathname!==link.pathname)return null;",
  "var spec=KINDS[kind],named=f.querySelectorAll('input[name],select[name],textarea[name]'),fields=[],boxes=[],seen={};",
  "for(var i=0;i<named.length;i++){var n=named[i],name=n.getAttribute('name');if(seen[name])return null;seen[name]=1;",
  "if(n.tagName==='INPUT'&&n.type==='hidden'&&spec.hidden.indexOf(name)>=0){fields.push([name,n.value]);continue}",
  "if(n.tagName==='INPUT'&&n.type==='checkbox'&&spec.boxes.indexOf(name)>=0){var lab=n.closest('label');",
  "if(!lab||!text(lab))return null;boxes.push({name:name,value:n.value||'on',label:text(lab)});continue}",
  "return null}",
  "for(var j=0;j<spec.hidden.length;j++)if(!seen[spec.hidden[j]])return null;",
  "var mine=document.querySelector('input[name=_csrf]'),csrf=fields.filter(function(p){return p[0]==='_csrf'})[0];",
  "if(!mine||!csrf||!csrf[1]||csrf[1]!==mine.value)return null;",
  "var items=[].map.call(sec.querySelectorAll('[data-confirm-item]'),function(x){return x.getAttribute('data-confirm-item')||text(x)}).filter(Boolean);",
  "var title=f.getAttribute('data-confirm-title'),b=f.querySelector('button[type=submit]'),verb=b?text(b):'';",
  "if(!items.length||!title||!verb)return null;",
  "return{title:title,items:items,verb:verb,action:u.pathname,fields:fields,boxes:boxes}}",
  // 'ask' (the confirmation page), 'refuse' (its refusal, for kinds that have one) or null.
  "function which(r,kind){if(r.status!==200||r.redirected||r.type==='opaqueredirect')return null;",
  "if((r.headers.get('content-type')||'').toLowerCase().indexOf('text/html')!==0)return null;",
  "var h=r.headers.get(HEAD);if(h===kind)return'ask';",
  "return KINDS[kind].refusal&&h===kind+'-refused'?'refuse':null}",
  "function post(page,chosen){var g=document.createElement('form');g.method='POST';g.action=page.action;g.hidden=true;",
  "page.fields.concat(chosen.map(function(c){return[c.name,c.value]})).forEach(function(p){var i=document.createElement('input');",
  "i.type='hidden';i.name=p[0];i.value=p[1];g.appendChild(i)});document.body.appendChild(g);g.submit()}",
  "document.addEventListener('click',function(e){",
  "var a=e.target&&e.target.closest?e.target.closest('a[data-confirm-link]'):null;",
  "if(!a||e.defaultPrevented||e.button!==0||e.ctrlKey||e.metaKey||e.shiftKey||e.altKey||!usable())return;",
  "var kind=a.getAttribute('data-confirm-link');if(!Object.prototype.hasOwnProperty.call(KINDS,kind))return;",
  "var link=urlOf(a.getAttribute('href'));if(!link||link.origin!==location.origin)return;",
  "e.preventDefault();if(inflight)return;inflight=a;var to=link.pathname+link.search;",
  "fetch(to,{method:'GET',headers:{'Accept':'text/html'},credentials:'same-origin'}).then(function(r){",
  "var w=which(r,kind);if(!w)return null;return r.text().then(function(h){return read(h,kind,link,w==='refuse')})",
  "}).catch(function(){return null}).then(function(page){inflight=null;",
  "if(!page){location.assign(to);return}",
  // The shared dialog (`CONFIRM_SCRIPT`) shows title, items and verb. An
  // Options dialog adds its checkboxes to that same dialog's body here (labels
  // as text nodes), so the shared script stays as it is on every page; `go`
  // reads them when the confirm button runs it.
  "var done=false,boxes=[],d={title:page.title,items:page.items,verb:page.verb,trigger:a,",
  "go:function(){if(done)return;done=true;post(page,page.boxes.filter(function(b,i){return boxes[i]&&boxes[i].checked}))},handled:false};",
  "document.dispatchEvent(new CustomEvent('kb-confirm-request',{detail:d}));",
  "if(!d.handled){location.assign(to);return}",
  "var dlg=document.querySelector('dialog.kb-dialog'),body=dlg&&dlg.querySelector('.kb-dialog__body');",
  "if(page.refusal){var ok=dlg&&dlg.querySelectorAll('.kb-dialog__foot button')[1];if(ok)ok.parentNode.removeChild(ok);return}",
  "page.boxes.forEach(function(b){var l=document.createElement('label'),c=document.createElement('input'),w=document.createElement('div');",
  "c.type='checkbox';l.appendChild(c);l.appendChild(document.createTextNode(' '+b.label));w.appendChild(l);if(body)body.appendChild(w);boxes.push(c)})})},false)",
  "})();",
];

export const CONFIRM_LINK_SCRIPT = LINK_SCRIPT_LINES.join("");
