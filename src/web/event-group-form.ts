/**
 * Shared pieces of the event group form (#1299): the marker emoji list, the
 * colour order the quick builder uses, and the script that turns a group row's
 * marker text box into an emoji picker.
 *
 * The same rows render on the event form, on both preset editors and (later)
 * the host panel, so the list and the picker live here once.
 */

import { GROUP_MARKER_MAX_CHARS } from "../services/event-groups.js";

export interface MarkerChoice {
  /** The emoji, as it goes into the group's voice channel name. */
  emoji: string;
  /** Spoken name and search keywords. */
  name: string;
}

/**
 * The colour order for generated groups: the same list the picker shows first,
 * so a generated "Red, Blue, Green, Yellow" gets 🔴🔵🟢🟡 in that order.
 */
export const MARKER_COLOURS: readonly (MarkerChoice & { colour: string })[] = [
  { emoji: "🔴", name: "red circle", colour: "Red" },
  { emoji: "🔵", name: "blue circle", colour: "Blue" },
  { emoji: "🟢", name: "green circle", colour: "Green" },
  { emoji: "🟡", name: "yellow circle", colour: "Yellow" },
  { emoji: "🟠", name: "orange circle", colour: "Orange" },
  { emoji: "🟣", name: "purple circle", colour: "Purple" },
  { emoji: "🟤", name: "brown circle", colour: "Brown" },
  { emoji: "⚫", name: "black circle", colour: "Black" },
  { emoji: "⚪", name: "white circle", colour: "White" },
];

/** Squares, then common team icons. */
const MARKER_OTHERS: readonly MarkerChoice[] = [
  { emoji: "🟥", name: "red square" },
  { emoji: "🟧", name: "orange square" },
  { emoji: "🟨", name: "yellow square" },
  { emoji: "🟩", name: "green square" },
  { emoji: "🟦", name: "blue square" },
  { emoji: "🟪", name: "purple square" },
  { emoji: "🟫", name: "brown square" },
  { emoji: "⚔️", name: "crossed swords" },
  { emoji: "🛡️", name: "shield" },
  { emoji: "🏹", name: "bow and arrow" },
  { emoji: "🚀", name: "rocket" },
  { emoji: "⭐", name: "star" },
  { emoji: "🔥", name: "fire" },
  { emoji: "💀", name: "skull" },
  { emoji: "🐺", name: "wolf" },
  { emoji: "🦅", name: "eagle" },
  { emoji: "🐉", name: "dragon" },
];

/** Everything the picker offers, in order. Unicode emoji only, each within the marker limit. */
export const MARKER_CHOICES: readonly MarkerChoice[] = [
  ...MARKER_COLOURS.map(({ emoji, name }) => ({ emoji, name })),
  ...MARKER_OTHERS,
];

/** Number of code points in a marker, counted the way the validator counts. */
export function markerLength(marker: string): number {
  return Array.from(marker).length;
}

/** True when a marker fits the limit the server enforces. */
export function markerFits(marker: string): boolean {
  return markerLength(marker) <= GROUP_MARKER_MAX_CHARS;
}

/** The emoji that was not rejected for length, so a pick can never fail validation. */
export function pickableMarkers(): readonly MarkerChoice[] {
  return MARKER_CHOICES.filter((c) => markerFits(c.emoji));
}

/**
 * The script every group editor loads: it turns each row's marker text box into
 * a small button that opens a grid, and folds each row's kind select behind
 * "More". Without it the text box and the select stay as they are.
 *
 * Other scripts call `window.koolGroupRows.enhance(row)` after cloning a row
 * and `window.koolGroupRows.syncAll()` after setting a value by hand.
 */
export function groupRowsScript(): string {
  const choices = JSON.stringify(
    pickableMarkers().map((c) => [c.emoji, c.name]),
  );
  return (
    "(function(){" +
    `var CHOICES=${choices};` +
    "var pop=null,popFor=null;" +
    "function wrapOf(row){return row.querySelector('[data-marker-wrap]')}" +
    "function input(row){return row.querySelector('[data-marker-input]')}" +
    "function btn(row){return row.querySelector('[data-marker-btn]')}" +
    "function label(row){var b=btn(row),i=input(row);if(!b||!i)return;var v=i.value.trim();" +
    "var g=row.getAttribute('aria-label')||'Group';b.textContent=v||'+';b.setAttribute('aria-label',g+' marker: '+(v||'none')+'. '+(v?'Change it':'Choose one'))}" +
    "function closePop(focus){if(!pop||!popFor)return;var b=btn(popFor);pop.hidden=true;if(b){b.setAttribute('aria-expanded','false');if(focus)b.focus()}popFor=null}" +
    "function mark(i){var cur=i.value.trim();Array.prototype.forEach.call(pop.querySelectorAll('.kb-emoji-grid button'),function(x){x.setAttribute('aria-pressed',x.getAttribute('data-emoji')===cur?'true':'false')})}" +
    "function choose(v){if(!popFor)return;var i=input(popFor);i.value=v;label(popFor);" +
    "i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new Event('change',{bubbles:true}));closePop(true)}" +
    "function build(){pop=document.createElement('div');pop.className='kb-emoji-pop';pop.hidden=true;pop.setAttribute('role','group');pop.setAttribute('aria-label','Choose a marker');" +
    "var s=document.createElement('input');s.type='search';s.className='kb-input kb-input--sm';s.setAttribute('aria-label','Search markers');s.setAttribute('form','none');s.placeholder='Search';s.setAttribute('data-emoji-search','');" +
    "var h=document.createElement('p');h.className='kb-picker__group';h.textContent='Markers';" +
    "var g=document.createElement('div');g.className='kb-emoji-grid';" +
    "CHOICES.forEach(function(c){var b=document.createElement('button');b.type='button';b.textContent=c[0];b.title=c[1];b.setAttribute('aria-label',c[1]);b.setAttribute('data-emoji',c[0]);b.setAttribute('data-name',c[1]);b.setAttribute('aria-pressed','false');g.appendChild(b)});" +
    "var n=document.createElement('button');n.type='button';n.className='kb-btn kb-btn--ghost kb-btn--sm';n.textContent='No marker';n.setAttribute('data-emoji','');" +
    "var e=document.createElement('p');e.className='kb-help';e.textContent='No markers match.';e.hidden=true;e.setAttribute('data-emoji-empty','');" +
    "pop.appendChild(s);pop.appendChild(h);pop.appendChild(g);pop.appendChild(e);pop.appendChild(n);" +
    "s.addEventListener('keydown',function(ev){if(ev.key==='Enter')ev.preventDefault()});" +
    "s.addEventListener('input',function(){var q=s.value.trim().toLowerCase(),any=false;" +
    "Array.prototype.forEach.call(g.children,function(b){var ok=!q||b.getAttribute('data-name').indexOf(q)!==-1;b.hidden=!ok;if(ok)any=true});e.hidden=any});" +
    "pop.addEventListener('click',function(ev){var b=ev.target.closest('button[data-emoji]');if(b&&pop.contains(b))choose(b.getAttribute('data-emoji'))});" +
    "pop.addEventListener('keydown',function(ev){if(ev.key==='Escape'){ev.stopPropagation();closePop(true)}})}" +
    "function openPop(row){if(!pop)build();if(popFor===row){closePop(true);return}closePop(false);" +
    "popFor=row;var w=wrapOf(row);w.appendChild(pop);pop.hidden=false;btn(row).setAttribute('aria-expanded','true');" +
    "var s=pop.querySelector('[data-emoji-search]');s.value='';s.dispatchEvent(new Event('input'));mark(input(row));s.focus()}" +
    "function enhance(row){if(!row||row.hasAttribute('data-enhanced'))return;row.setAttribute('data-enhanced','');" +
    "var w=wrapOf(row),i=input(row),b=btn(row);" +
    "if(w&&i&&b){i.hidden=true;b.hidden=false;label(row);" +
    "b.addEventListener('click',function(){openPop(row)});" +
    // A value typed or restored by hand keeps the button in step.
    "i.addEventListener('input',function(){label(row)})}" +
    "var more=row.querySelector('[data-kind-toggle]'),panel=row.querySelector('[data-kind-panel]');" +
    "if(more&&panel){var sel=panel.querySelector('select');var open=!!sel&&sel.value!=='team';" +
    "more.hidden=false;panel.hidden=!open;more.setAttribute('aria-expanded',open?'true':'false');" +
    "more.addEventListener('click',function(){var o=panel.hidden;panel.hidden=!o;more.setAttribute('aria-expanded',o?'true':'false')})}}" +
    "function syncAll(){Array.prototype.forEach.call(document.querySelectorAll('[data-group-row]'),function(r){enhance(r);label(r);" +
    "var more=r.querySelector('[data-kind-toggle]'),panel=r.querySelector('[data-kind-panel]');" +
    "if(more&&panel&&panel.hidden){var sel=panel.querySelector('select');if(sel&&sel.value!=='team'){panel.hidden=false;more.setAttribute('aria-expanded','true')}}})}" +
    "document.addEventListener('click',function(ev){if(pop&&!pop.hidden&&!pop.contains(ev.target)&&!ev.target.closest('[data-marker-btn]'))closePop(false)});" +
    "window.koolGroupRows={enhance:enhance,syncAll:syncAll,closePicker:function(){closePop(false)}};" +
    "syncAll();" +
    "})();"
  );
}
