/**
 * The save bar of a settings form (#1330, part of #1318): one sticky bar per
 * form that says how many settings changed and offers Discard and Save.
 *
 * Without JavaScript the bar renders visible with "Save your changes" and the
 * Save button posts the form as before; Discard is `hidden` because it cannot
 * work. The script hides the bar until something differs from the loaded
 * values, then shows "N unsaved changes".
 *
 * Changes are counted per `.kb-setting` row, by comparing each control with
 * its markup default (`defaultChecked`, `defaultSelected`, `defaultValue`), so
 * changing a value and changing it back counts as nothing. Only controls the
 * form owns count (`form.elements`): the per-row reset buttons submit a sibling
 * form through their `form` attribute, are buttons, and never count.
 */

import { escapeHtml } from "./html.js";

/** Markup of the bar. It must sit inside the form it saves. */
export function renderSaveBar(submitLabel: string, name = ""): string {
  // A page has one bar per form, and landmarks must be told apart: the form's
  // name goes into the label ("Unsaved changes: Voice channels").
  const label = name ? `Unsaved changes: ${name}` : "Unsaved changes";
  return `<div class="kb-savebar" role="region" aria-label="${escapeHtml(label)}" data-savebar>
      <span class="kb-status kb-status--warn" aria-hidden="true"></span>
      <span class="kb-savebar__text" role="status" data-savebar-text>Save your changes</span>
      <button type="button" class="kb-btn kb-btn--ghost" data-savebar-discard hidden>Discard</button>
      <button type="submit" class="btn btn-primary">${escapeHtml(submitLabel)}</button>
    </div>`;
}

/**
 * The enhancement, a trusted constant emitted through `scriptTag` (CSP nonce,
 * no inline handlers). `kb-saved` is dispatched on the form by the AJAX save
 * script after an accepted save: the saved values become the new baseline.
 */
export const SAVEBAR_SCRIPT =
  "(function(){" +
  "var NOT=/^(submit|button|reset|image|file)$/;" +
  "function defIndex(s){for(var i=0;i<s.options.length;i++){" +
  "if(s.options[i].defaultSelected)return i}" +
  "return(s.multiple||s.size>1)?-1:0}" +
  "function changed(el){if(el.disabled)return false;var t=el.type;" +
  "if(t==='checkbox'||t==='radio')return el.checked!==el.defaultChecked;" +
  "if(el.tagName==='SELECT'){" +
  "if(el.multiple){for(var i=0;i<el.options.length;i++){" +
  "if(el.options[i].selected!==el.options[i].defaultSelected)return true}return false}" +
  "return el.selectedIndex!==defIndex(el)}" +
  // A hidden field's value IS its default (the attribute), so it never
  // compares as changed: a cron picker's controls count, not its hidden copy.
  "if(t==='hidden'||NOT.test(t))return false;" +
  "return el.value!==el.defaultValue}" +
  "function changedControls(form){var out=[];" +
  "Array.prototype.forEach.call(form.elements,function(el){if(changed(el))out.push(el)});" +
  "return out}" +
  "function rowOf(el){return el.closest('.kb-setting')||el}" +
  "function count(form){var rows=[];" +
  "changedControls(form).forEach(function(el){var r=rowOf(el);if(rows.indexOf(r)<0)rows.push(r)});" +
  "return rows.length}" +
  "function fire(el,type){try{el.dispatchEvent(new Event(type,{bubbles:true}))}catch(e){}}" +
  "function restore(el){var t=el.type;" +
  "if(t==='checkbox'||t==='radio'){el.checked=el.defaultChecked}" +
  "else if(el.tagName==='SELECT'){" +
  "if(el.multiple){for(var i=0;i<el.options.length;i++)el.options[i].selected=el.options[i].defaultSelected}" +
  "else el.selectedIndex=defIndex(el)}" +
  "else el.value=el.defaultValue}" +
  "function commit(form){Array.prototype.forEach.call(form.elements,function(el){" +
  "if(el.disabled)return;var t=el.type;" +
  "if(t==='checkbox'||t==='radio')el.defaultChecked=el.checked;" +
  "else if(el.tagName==='SELECT'){for(var i=0;i<el.options.length;i++)el.options[i].defaultSelected=el.options[i].selected}" +
  "else if(t!=='hidden'&&!NOT.test(t))el.defaultValue=el.value})}" +
  "function wire(bar){var form=bar.closest('form');if(!form)return;" +
  "var text=bar.querySelector('[data-savebar-text]');" +
  "var discard=bar.querySelector('[data-savebar-discard]');" +
  "var shown=-1;" +
  "function update(){var n=count(form);if(n===shown)return;shown=n;" +
  "bar.hidden=n===0;" +
  "if(text)text.textContent=n+' unsaved change'+(n===1?'':'s')}" +
  "if(discard)discard.hidden=false;" +
  "update();" +
  "form.addEventListener('input',update);form.addEventListener('change',update);" +
  "form.addEventListener('kb-saved',function(){commit(form);update()});" +
  "if(discard)discard.addEventListener('click',function(){" +
  "var els=changedControls(form);els.forEach(function(el){restore(el);fire(el,'input');fire(el,'change')});" +
  "update();var f=els.filter(function(el){return el.type!=='hidden'})[0];" +
  "if(f){try{f.focus()}catch(e){}}})}" +
  "Array.prototype.forEach.call(document.querySelectorAll('[data-savebar]'),wire)})();";
