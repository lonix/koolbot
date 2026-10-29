/**
 * Pickers for settings (and event forms) whose value has a known set (#1426):
 * a searchable timezone select, a colour input with a "Use default" box, and
 * the emoji picker the event group marker uses. Number settings with a small
 * range or common durations get a stepper or preset buttons (#1427).
 *
 * Like the other controls in `setting-controls.ts` these are string renderers
 * over real form inputs, so they work without JavaScript and the server checks
 * every value again (`utils/setting-formats.ts`). A stored value that the
 * picker cannot produce (an old custom timezone, a colour that is not
 * `#RRGGBB`, a prefix that is now too long) is shown as it is and posts
 * unchanged, so opening and saving a page never rewrites it.
 */

import { channelKindIcons } from "./discord-labels.js";
import { escapeHtml } from "./html.js";
import { ICONS } from "./icons.js";
import type { ReactionRoleMessageOptions } from "./reaction-role-messages.js";
import { renderSegmented, type ControlAttrs } from "./setting-controls.js";
import { listSupportedTimezones } from "../utils/timezone.js";
import {
  DEFAULT_COLOUR_SWATCH,
  validateSettingFormat,
} from "../utils/setting-formats.js";

function attr(name: string, value: string | undefined): string {
  return value ? ` ${name}="${escapeHtml(value)}"` : "";
}

function invalidAttrs(a: ControlAttrs): string {
  return a.invalid
    ? ` aria-invalid="true" data-describedby-base="${escapeHtml(a.describedByBase ?? "")}"`
    : "";
}

const LOCK = " disabled data-dep-locked";

// ---------- Timezone ----------

export interface TimezoneSelectOptions extends ControlAttrs {
  /**
   * The zone the first option stands for: the server's, or the zone a new event
   * would use anyway. It is listed first, labelled "Default".
   */
  defaultZone: string;
  /**
   * The first option posts `""` ("use the default") instead of `defaultZone`.
   * Settings and the edit form use it, because a blank value there means "the
   * server zone" and must stay blank rather than become a pinned zone.
   */
  blank?: boolean;
  /** What the first option is called, before the zone: "Default" unless it is the event's own zone. */
  firstLabel?: string;
}

/** Every IANA zone, UTC included, each once, with `first` leading when given. */
export function timezoneChoices(first?: string): string[] {
  const zones = listSupportedTimezones().filter((z) => z !== first);
  return first ? [first, ...zones] : zones;
}

/**
 * A searchable timezone select: `span.kb-tz` around a `select.kb-select` and a
 * search box that only appears with JavaScript (`TIMEZONE_SELECT_SCRIPT`).
 *
 * - the first option is the default (see `TimezoneSelectOptions`);
 * - a `current` zone the runtime does not list stays selectable as a
 *   "(custom)" option, so it is shown and posted unchanged;
 * - the search box has `form="none"` so it never posts.
 */
export function renderTimezoneSelect(
  name: string,
  current: string,
  o: TimezoneSelectOptions,
): string {
  const firstValue = o.blank ? "" : o.defaultZone;
  // With a blank first option the default zone is also listed, so it can be pinned.
  const zones = timezoneChoices().filter((z) => o.blank || z !== o.defaultZone);
  // Unset reads as the default; a pinned zone is matched exactly.
  const selected = current === "" ? firstValue : current;
  const known = selected === firstValue || zones.includes(selected);
  const option = (value: string, label: string): string =>
    `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
  const options = [
    option(firstValue, `${o.firstLabel ?? "Default"} (${o.defaultZone})`),
    ...(known ? [] : [option(selected, `${selected} (custom)`)]),
    ...zones.map((z) => option(z, z)),
  ].join("");
  return (
    `<span class="kb-tz" data-tz>` +
    `<input type="search" class="kb-input kb-input--sm" data-tz-search hidden form="none" autocomplete="off" ` +
    `placeholder="Search timezones" aria-label="Search timezones"${o.disabled ? LOCK : ""}>` +
    `<select class="kb-select"${attr("id", o.id)}${attr("aria-describedby", o.describedBy)}${invalidAttrs(o)} ` +
    `name="${escapeHtml(name)}"${o.disabled ? LOCK : ""}>${options}</select>` +
    `<span class="kb-help" data-tz-status role="status" hidden></span>` +
    `</span>`
  );
}

/**
 * Turns each `[data-tz]` search box on. Typing hides the zones that do not
 * match and never disables one: a disabled option is skipped when the form is
 * posted, so a selected option that was filtered out and then restored (a save
 * committing it as the baseline, then Discard) would post nothing and clear the
 * setting. Options are only hidden, so the option indexes the save bar compares
 * never change, and the selected and the original option always stay visible.
 * The filter runs again whenever the select changes, Discard's restoring
 * `change` included, so a restored zone is never left hidden. Enter picks the
 * first match. Underscores and slashes count as spaces, so
 * "new york" finds America/New_York.
 */
export const TIMEZONE_SELECT_SCRIPT =
  "(function(){" +
  "function norm(x){return String(x).toLowerCase().replace(/[_\\/]+/g,' ')}" +
  "function init(box){var s=box.querySelector('[data-tz-search]'),sel=box.querySelector('select'),st=box.querySelector('[data-tz-status]');" +
  "if(!s||!sel||box.hasAttribute('data-ready'))return;box.setAttribute('data-ready','');s.hidden=false;" +
  "function run(){var q=norm(s.value.trim()),n=0,first=null,i,o,hit,keep;" +
  "for(i=0;i<sel.options.length;i++){o=sel.options[i];hit=!q||norm(o.value+' '+o.textContent).indexOf(q)!==-1;" +
  "if(hit){n++;if(!first)first=o}keep=hit||o.selected||o.defaultSelected;o.hidden=!keep}" +
  "if(st){st.hidden=!q;st.textContent=n?n+(n===1?' timezone matches':' timezones match'):'No timezones match'}" +
  "return first}" +
  "s.addEventListener('input',run);" +
  // The selection can change without the search changing: the user picks, or
  // the save bar's Discard restores the select and fires `change`. Filtering
  // again keeps the selected and original option visible.
  "sel.addEventListener('change',run);" +
  "s.addEventListener('keydown',function(e){if(e.key!=='Enter')return;e.preventDefault();var f=run();" +
  "if(f&&s.value.trim()){sel.value=f.value;sel.dispatchEvent(new Event('change',{bubbles:true}));sel.focus()}})}" +
  "Array.prototype.forEach.call(document.querySelectorAll('[data-tz]'),init)" +
  "})();";

// ---------- Channel, category and role picker (#1394) ----------

const PICKER_CHEVRON = `<svg class="kb-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS["chevron-down"]}</svg>`;
const PICKER_X = `<svg class="kb-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS.x}</svg>`;
const PICKER_CHECK = `<svg class="kb-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS.check}</svg>`;

/**
 * Turns each `[data-picker]` (a `span.kb-picker` around a native `select`, see
 * `renderSettingControl`) into the searchable combobox of the design manual
 * (Picker): a trigger showing the current value as a mention, and a popover
 * with a search box, a group header per `optgroup`, an icon in front of each
 * row, the category muted on the right and a check on the selected row.
 *
 * The select stays the field. It keeps its name, its options and its value, so
 * without JavaScript it is what posts, and with JavaScript choosing a row sets
 * it and fires `input` and `change` (the save bar counts that like any select).
 * It is moved out of sight with `kb-visually-hidden`, not `hidden`, because the
 * save bar treats a `[hidden]` control as inactive; focusing it (a label click)
 * moves focus to the trigger. Searching only hides rows in the popover: no
 * option is ever disabled or removed, so a selected id that the search hides, or
 * that is no longer in the list (a `missing` entry in `data-picker-meta`), still posts
 * exactly as stored.
 *
 * Typing `#` lists text channels, `#!` voice channels and `@` roles, as in
 * Discord's composer; the rest of the text filters by name and category.
 * Keyboard: Enter or the arrow keys open the popover; arrows, Home and End move
 * `aria-activedescendant` in the search box, Enter chooses, Escape closes and
 * returns to the trigger, Tab leaves. Discard's `change` (and a cascade
 * master's) re-reads the select, so the trigger never shows a stale value.
 * Option text is only ever set as text, never as markup.
 */
export const CHANNEL_PICKER_SCRIPT =
  "(function(){" +
  `var ICONS=${JSON.stringify(channelKindIcons())},CHEVRON=${JSON.stringify(PICKER_CHEVRON)},CHECK=${JSON.stringify(PICKER_CHECK)},XICON=${JSON.stringify(PICKER_X)};` +
  "var KINDS={text:{text:1,announcement:1,forum:1,thread:1},voice:{voice:1,stage:1},role:{role:1}},uid=0;" +
  "function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}" +
  "function svg(h){var s=document.createElement('span');s.innerHTML=h;return s.firstChild}" +
  "function read(sel,meta){var out=[],i,j,c,g;" +
  "function one(o,group){var m=meta[out.length]||[];return{value:o.value,kind:m[0]||'',name:m[1]||o.textContent,cat:m[2]||'',group:group,text:o.textContent}}" +
  "for(i=0;i<sel.children.length;i++){c=sel.children[i];" +
  "if(c.tagName==='OPTGROUP'){g=c.getAttribute('label')||'';for(j=0;j<c.children.length;j++)out.push(one(c.children[j],g))}" +
  "else out.push(one(c,''))}return out}" +
  "function mention(it){var m=el('span','kb-mention'+(it.kind==='category'?' kb-mention--category':''));" +
  "if(it.kind==='role')m.textContent='@'+it.name;" +
  "else if(ICONS[it.kind]){m.appendChild(svg(ICONS[it.kind]));m.appendChild(document.createTextNode(it.name))}" +
  "else m.textContent=it.kind==='missing'?it.text:it.name;return m}" +
  "function parse(raw){var q=raw.trim(),k=null;" +
  "if(q.indexOf('#!')===0){k='voice';q=q.slice(2)}else if(q.charAt(0)==='#'){k='text';q=q.slice(1)}else if(q.charAt(0)==='@'){k='role';q=q.slice(1)}" +
  "return{k:k,q:q.trim().toLowerCase()}}" +
  "function hit(it,p){if(p.k&&!KINDS[p.k][it.kind])return false;return !p.q||(it.name+' '+it.cat).toLowerCase().indexOf(p.q)!==-1}" +
  "function init(box){var sel=box.querySelector('select');if(!sel||box.hasAttribute('data-ready'))return;box.setAttribute('data-ready','');" +
  "var meta=[];try{meta=JSON.parse(box.getAttribute('data-picker-meta')||'[]')||[]}catch(err){}" +
  "var n=++uid,items=read(sel,meta),rows=[],heads=[],vis=[],act=-1,open=false,i,lastGroup=null;" +
  "var multi=sel.multiple,expanded=false,tid='kb-picker-'+n,lid=tid+'-list',labels=[],ids=[];" +
  "for(i=0;sel.labels&&i<sel.labels.length;i++){if(!sel.labels[i].id)sel.labels[i].id=tid+'-label'+i;labels.push(sel.labels[i].textContent.trim());ids.push(sel.labels[i].id)}" +
  "var name=labels.join(' ')||sel.getAttribute('aria-label')||'Choose';" +
  "var trig=el('button','kb-picker__trigger');trig.type='button';trig.id=tid;trig.setAttribute('aria-haspopup','listbox');trig.setAttribute('aria-expanded','false');" +
  "trig.setAttribute('aria-controls',lid);" +
  "if(ids.length){ids.push(tid);trig.setAttribute('aria-labelledby',ids.join(' '))}else trig.setAttribute('aria-label',name);" +
  "var pop=el('div','kb-picker__pop kb-picker__pop--floating');pop.hidden=true;" +
  "var lab=el('label','kb-picker__search'),inp=el('input');inp.type='search';inp.setAttribute('form','none');inp.autocomplete='off';inp.id=tid+'-search';" +
  "inp.setAttribute('role','combobox');inp.setAttribute('aria-autocomplete','list');inp.setAttribute('aria-controls',lid);inp.setAttribute('aria-expanded','true');" +
  "inp.setAttribute('aria-label','Search '+name);inp.placeholder='Search';lab.appendChild(inp);" +
  "var ul=el('ul','kb-picker__list');ul.id=lid;ul.setAttribute('role','listbox');if(multi)ul.setAttribute('aria-multiselectable','true');ul.setAttribute('aria-label',name);" +
  "var st=el('p','kb-picker__hint');st.setAttribute('role','status');st.hidden=true;" +
  "var hint=el('p','kb-picker__hint'),kinds={};for(i=0;i<items.length;i++)kinds[items[i].kind]=1;" +
  "var parts=['Arrow keys move, Enter chooses, Esc closes.'];" +
  "if(kinds.voice||kinds.stage)parts.unshift('#! voice channels');if(kinds.text||kinds.announcement||kinds.forum||kinds.thread)parts.unshift('# text channels');" +
  "if(kinds.role)parts.unshift('@ roles');hint.textContent=(parts.length>1?'Type '+parts.slice(0,-1).join(', ')+'. ':'')+parts[parts.length-1];" +
  "for(i=0;i<items.length;i++){var it=items[i],li;" +
  "if(it.group&&it.group!==lastGroup){li=el('li','kb-picker__group',it.group);li.setAttribute('role','presentation');ul.appendChild(li);heads.push({el:li,group:it.group})}" +
  "lastGroup=it.group;li=el('li','kb-picker__opt');li.id=lid+'-'+i;li.setAttribute('role','option');li.setAttribute('data-i',String(i));" +
  "li.appendChild(mention(it));if(it.cat)li.appendChild(el('span','kb-picker__cat',it.cat));ul.appendChild(li);rows.push(li)}" +
  "pop.appendChild(lab);pop.appendChild(ul);pop.appendChild(st);pop.appendChild(hint);" +
  "sel.classList.add('kb-visually-hidden');sel.tabIndex=-1;sel.setAttribute('aria-hidden','true');" +
  // The save handlers mark a rejected field on the select (`aria-invalid`,
  // `aria-describedby`) without firing `change`, and then focus it. Mirror both
  // onto the trigger whenever they change, and again right before focus is
  // handed over, so the trigger never lacks the rejection or keeps a removed note.
  "function attrs(){var d=sel.getAttribute('aria-describedby');" +
  "if(d)trig.setAttribute('aria-describedby',d);else trig.removeAttribute('aria-describedby');" +
  "if(sel.getAttribute('aria-invalid')==='true')trig.setAttribute('aria-invalid','true');else trig.removeAttribute('aria-invalid');" +
  "trig.disabled=sel.disabled}" +
  "sel.addEventListener('focus',function(){attrs();trig.focus()});" +
  "if(window.MutationObserver)new MutationObserver(attrs).observe(sel,{attributes:true,attributeFilter:['aria-invalid','aria-describedby','disabled']});" +
  "box.classList.add('kb-picker--enhanced');" +
  // A multiple select shows its chips above the trigger (a button cannot hold
  // the chips' own remove buttons), and the no-JavaScript "Selected:" line
  // after the box becomes redundant.
  "var chips=null;if(multi){chips=el('div','kb-picker__chips');box.appendChild(chips);" +
  // Focusable by script only: it takes focus when a repaint leaves no button to
  // take it (a disabled select expanding "+N more"), and is named for that.
  "chips.tabIndex=-1;chips.setAttribute('role','group');" +
  "if(labels.length||sel.getAttribute('aria-label'))chips.setAttribute('aria-label','Selected '+name);" +
  "var nx=box.nextElementSibling;if(nx&&nx.hasAttribute('data-picker-summary'))nx.hidden=true}" +
  "box.appendChild(trig);box.appendChild(pop);" +
  "function isOn(k){return multi?sel.options[k].selected:k===sel.selectedIndex}" +
  "function chipLabel(it){return(it.kind==='role'?'@':(ICONS[it.kind]&&it.kind!=='category')?'#':'')+(it.kind==='missing'?it.text:it.name)}" +
  "function paintChips(){var sels=[],k,lim,c,b;for(k=0;k<items.length;k++)if(isOn(k))sels.push(k);" +
  "chips.textContent='';if(!sels.length)chips.appendChild(el('span','kb-picker__none','None selected'));" +
  "lim=expanded?sels.length:Math.min(sels.length,12);" +
  "for(k=0;k<lim;k++){c=el('span','kb-picker__chip');c.appendChild(mention(items[sels[k]]));" +
  "b=el('button','kb-picker__chip-remove');b.type='button';b.setAttribute('data-rm',String(sels[k]));" +
  "b.setAttribute('aria-label','Remove '+chipLabel(items[sels[k]]));b.disabled=sel.disabled;b.appendChild(svg(XICON));c.appendChild(b);chips.appendChild(c)}" +
  "if(sels.length>lim){b=el('button','kb-picker__more','+'+(sels.length-lim)+' more');b.type='button';b.setAttribute('data-more','');" +
  "b.setAttribute('aria-label','Show '+(sels.length-lim)+' more selected');chips.appendChild(b)}}" +
  "function paint(){var cur=items[sel.selectedIndex]||items[0];trig.textContent='';" +
  "if(multi){paintChips();trig.appendChild(el('span','kb-picker__add','Add'))}else if(cur)trig.appendChild(mention(cur));trig.appendChild(svg(CHEVRON));attrs();" +
  // Without a visible label the trigger's name is the select's `aria-label`, and
  // a fixed name would hide the choice: add it, as the label path does by
  // pointing at the trigger's own text.
  "if(!ids.length&&!multi&&cur)trig.setAttribute('aria-label',name+': '+chipLabel(cur));" +
  "for(var k=0;k<rows.length;k++){var on=isOn(k),c=rows[k].querySelector('svg[data-check]');" +
  "rows[k].setAttribute('aria-selected',on?'true':'false');" +
  "if(on&&!c){c=svg(CHECK);c.setAttribute('data-check','');rows[k].appendChild(c)}else if(!on&&c)rows[k].removeChild(c)}" +
  // The chips may have wrapped onto another row, which moves the Add trigger the
  // open menu hangs from: place it again (a closed menu is placed when it opens).
  "if(open)place()}" +
  "function setActive(k){if(act>=0&&rows[act])rows[act].classList.remove('is-active');act=k;" +
  "if(k<0||!rows[k]){inp.removeAttribute('aria-activedescendant');return}" +
  "rows[k].classList.add('is-active');inp.setAttribute('aria-activedescendant',rows[k].id);" +
  "reveal()}" +
  // Scrolls the active row into the visible part of the list. `place()` runs it
  // again after it has set the list's height, so a row that was in view at the
  // old height is not left outside the cut one.
  "function reveal(){var r=rows[act];if(r&&r.scrollIntoView)r.scrollIntoView({block:'nearest'})}" +
  "function filter(){var p=parse(inp.value),k,shown={};vis=[];" +
  "for(k=0;k<items.length;k++){var ok=hit(items[k],p);rows[k].hidden=!ok;if(ok){vis.push(k);shown[items[k].group]=1}}" +
  "for(k=0;k<heads.length;k++)heads[k].el.hidden=!shown[heads[k].group];" +
  "var on=-1,f0;for(f0=0;f0<vis.length&&on<0;f0++)if(isOn(vis[f0]))on=f0;setActive(vis.length?(on>=0?vis[on]:vis[0]):-1);" +
  "var q=inp.value.trim();st.hidden=!q;st.textContent=q?(vis.length?vis.length+(vis.length===1?' match':' matches'):'No matches'):'';" +
  // The menu's height follows the rows and the status line, so its place does too.
  "if(open)place()}" +
  // The popover is moved to the end of <body> while open and positioned with
  // `position: fixed` from the trigger's rectangle (custom properties, see
  // kb.css), because the settings rows and cards scroll (`overflow-x: auto`),
  // which also clips vertically and would turn a menu near the bottom into an
  // inner scroll area. It flips above the trigger when there is no room below,
  // and follows the trigger on scroll (any ancestor) and resize.
  // Below the trigger when the menu fits there or there is more room below than
  // above, otherwise above. When neither side fits it, the list's height is cut
  // to the room on the chosen side (the search box, status and hint rows
  // stay), so the whole menu is on screen and the list scrolls inside it.
  "function place(){var top0=ul.scrollTop;pop.style.removeProperty('--kb-picker-list-h');" +
  "var r=trig.getBoundingClientRect(),h=pop.offsetHeight,w=pop.offsetWidth,over=h-ul.offsetHeight," +
  "below=window.innerHeight-r.bottom-12,above=r.top-12,down=h<=below||below>=above,room=down?below:above;" +
  "if(h>room){var cap=Math.max(64,room-over);pop.style.setProperty('--kb-picker-list-h',cap+'px');h=over+cap}" +
  "var y=down?r.bottom+4:r.top-4-h;" +
  "pop.style.setProperty('--kb-picker-x',Math.max(0,Math.min(r.left,window.innerWidth-w))+'px');" +
  "pop.style.setProperty('--kb-picker-y',Math.max(0,y)+'px');ul.scrollTop=top0;reveal()}" +
  "function onScroll(e){var t=e.target;if(!(t&&t.nodeType&&pop.contains(t)))place()}" +
  "function close(back){if(!open)return;open=false;pop.hidden=true;box.appendChild(pop);" +
  "window.removeEventListener('scroll',onScroll,true);window.removeEventListener('resize',place);" +
  "trig.setAttribute('aria-expanded','false');if(back)trig.focus()}" +
  "function show(){if(open||sel.disabled)return;open=true;(box.closest('main')||document.body).appendChild(pop);pop.hidden=false;" +
  "window.addEventListener('scroll',onScroll,true);window.addEventListener('resize',place);" +
  "trig.setAttribute('aria-expanded','true');inp.value='';filter();inp.focus()}" +
  "function fireBoth(){sel.dispatchEvent(new Event('input',{bubbles:true}));sel.dispatchEvent(new Event('change',{bubbles:true}))}" +
  // A multiple select toggles the row and stays open, so several can be picked
  // in a row; Escape, Tab or a click outside closes it.
  // A click makes its row the active one, as Enter does, so the placement that
  // `paint()` runs while open scrolls to the row just toggled and not back to the
  // row that was active before.
  "function choose(k){if(k<0||!items[k])return;if(multi){setActive(k);sel.options[k].selected=!sel.options[k].selected;fireBoth();paint();return}" +
  "if(sel.selectedIndex!==k){sel.selectedIndex=k;fireBoth()}paint();close(true)}" +
  "function drop(k){if(!sel.options[k]||!sel.options[k].selected||sel.disabled)return;sel.options[k].selected=false;fireBoth();paint()}" +
  "function lastOn(){for(var k=items.length-1;k>=0;k--)if(sel.options[k].selected)return k;return -1}" +
  "if(chips)chips.addEventListener('click',function(e){var t=e.target&&e.target.closest?e.target.closest('button'):null;if(!t)return;" +
  // `paint()` replaces the focused "+N more" button: hand focus to the first
  // remove button it revealed (the ones before it were already shown), or to the
  // chip group when the select is disabled and every remove button is too.
  "if(t.hasAttribute('data-more')){var seen=chips.querySelectorAll('[data-rm]').length;expanded=true;paint();" +
  "var nb=chips.querySelectorAll('[data-rm]')[seen];(nb&&!nb.disabled?nb:chips).focus();return}" +
  "if(t.hasAttribute('data-rm')){drop(Number(t.getAttribute('data-rm')));if(!trig.disabled)trig.focus()}});" +
  "function move(by){if(!vis.length)return;var at=vis.indexOf(act),to=at<0?0:Math.min(vis.length-1,Math.max(0,at+by));setActive(vis[to])}" +
  "trig.addEventListener('click',function(){if(open)close(true);else show()});" +
  // Already open (focus came back to the trigger after a chip was removed): the
  // arrows go back to the search box instead of doing nothing.
  "trig.addEventListener('keydown',function(e){if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();if(open)inp.focus();else show()}});" +
  "inp.addEventListener('input',filter);" +
  "inp.addEventListener('keydown',function(e){var m=e.key;" +
  // An input method is composing (Enter confirms the composition, Escape cancels it): leave every key to it.
  "if(e.isComposing||e.keyCode===229)return;" +
  "if(m==='ArrowDown'){e.preventDefault();move(1)}else if(m==='ArrowUp'){e.preventDefault();move(-1)}" +
  "else if(m==='Home'&&vis.length){e.preventDefault();setActive(vis[0])}else if(m==='End'&&vis.length){e.preventDefault();setActive(vis[vis.length-1])}" +
  "else if(m==='Backspace'&&multi&&!inp.value){e.preventDefault();drop(lastOn())}else if(m==='Enter'){e.preventDefault();choose(act)}else if(m==='Tab')close(true)});" +
  // Escape closes from anywhere in the picker while it is open (the search box,
  // the trigger, a chip's remove button, "+N more"), not only from the search
  // box: a repaint moves focus off the box, and the open popover lives outside
  // the wrapper, so both listen. Closed, Escape is left to the page (a dialog).
  "function esc(e){if(!open||e.key!=='Escape'||e.isComposing||e.keyCode===229)return;e.preventDefault();e.stopPropagation();close(true)}" +
  "box.addEventListener('keydown',esc);pop.addEventListener('keydown',esc);" +
  "ul.addEventListener('mousedown',function(e){e.preventDefault()});" +
  "ul.addEventListener('click',function(e){var r=e.target&&e.target.closest?e.target.closest('[data-i]'):null;if(r)choose(Number(r.getAttribute('data-i')))});" +
  "function inside(t){return box.contains(t)||pop.contains(t)}" +
  // A handler on the way up may have repainted and removed the clicked node (a
  // chip's remove button, "+N more", the check on a chosen row), so it no longer
  // sits in the picker: ask the path the event took, which was fixed at dispatch.
  "document.addEventListener('click',function(e){if(!open)return;var p=e.composedPath?e.composedPath():[];" +
  "if(p.indexOf(box)<0&&p.indexOf(pop)<0&&!inside(e.target))close(false)});" +
  "function leave(e){if(open&&e.relatedTarget&&!inside(e.relatedTarget))close(false)}" +
  "box.addEventListener('focusout',leave);pop.addEventListener('focusout',leave);" +
  "sel.addEventListener('change',paint);" +
  "Array.prototype.forEach.call(document.querySelectorAll('[data-cascade-master]'),function(m){m.addEventListener('change',paint)});" +
  "paint()}" +
  "Array.prototype.forEach.call(document.querySelectorAll('[data-picker]'),init)" +
  "})();";

// ---------- Colour ----------

/**
 * A colour input with its two non-colour states as real checkboxes.
 *
 * `<input type="color">` always holds a colour, but `""` is how the setting
 * says "Discord's default", so a *Use default* checkbox stands for it. A stored
 * value that is not `#RRGGBB` (the service ignores it with a warning) gets a
 * second one, *Keep the stored value*, ticked. The three states are exclusive:
 *
 * - Use default ticked: the value is `""`;
 * - Keep ticked: the value is the stored one, whatever it is;
 * - neither: the value is the swatch.
 *
 * Every piece of state is a form control the save bar already compares, commits
 * on a saved response and restores on Discard, so this control has no state of
 * its own to keep in step. The save handlers turn the boxes into the value
 * (`readSettingField`, with the stored value for Keep); Use default wins over
 * Keep, which wins over the swatch, so a browser without JavaScript posts the
 * same thing a script would have.
 */
export function renderColourInput(
  name: string,
  defaultName: string,
  current: string,
  a: ControlAttrs = {},
): string {
  const checked = validateSettingFormat("colour", current);
  const empty = current.trim() === "";
  const legacy = !empty && !checked.ok;
  const shown =
    checked.ok && checked.value ? checked.value : DEFAULT_COLOUR_SWATCH;
  const lock = a.disabled ? LOCK : "";
  const keepName = defaultName.replace(/^use_default_/, "keep_");
  return (
    `<span class="kb-colour" data-colour>` +
    `<input type="color" class="kb-colour__swatch" data-colour-input${attr("id", a.id)}` +
    `${attr("aria-describedby", a.describedBy)}${invalidAttrs(a)}` +
    ` name="${escapeHtml(name)}" value="${escapeHtml(shown)}"${lock}>` +
    `<label class="kb-colour__default"><input type="checkbox" data-colour-default ` +
    `name="${escapeHtml(defaultName)}" value="true"${empty ? " checked" : ""}${lock}> Use default</label>` +
    (legacy
      ? `<label class="kb-colour__default"><input type="checkbox" data-colour-keep ` +
        `name="${escapeHtml(keepName)}" value="true" checked${lock}> Keep the stored value</label>` +
        `<span class="kb-help">The stored value <span class="kb-mono">${escapeHtml(current)}</span> is not a #RRGGBB colour. It stays as it is until you pick a colour or use the default.</span>`
      : "") +
    `</span>`
  );
}

/**
 * Keeps a colour input in step with its boxes. The swatch stays pickable in
 * every state (picking is how you leave Use default or Keep) and is off only
 * while its boxes are disabled (the section's cascade has its feature off, or
 * the dependency lock). Picking a colour unticks both boxes; ticking one
 * unticks the other. Nothing
 * else is stored: baselines, commits and Discard belong to the save bar, whose
 * restoring events (`kbRestore`) only need the swatch re-synchronised.
 *
 * The handlers run in the capture phase, so the save bar's bubbling listener on
 * the form finds the final state. Delegated; a dependency-locked control stays
 * as rendered.
 */
export const COLOUR_INPUT_SCRIPT =
  "(function(){" +
  "function parts(el){var box=el.closest('[data-colour]');if(!box)return null;" +
  "return{color:box.querySelector('[data-colour-input]'),def:box.querySelector('[data-colour-default]'),keep:box.querySelector('[data-colour-keep]')}}" +
  "function sync(p){if(!p.color||!p.def||p.def.hasAttribute('data-dep-locked'))return;" +
  "p.color.disabled=p.def.disabled}" +
  "document.addEventListener('input',function(e){var el=e.target;if(!el||!el.matches||!el.matches('[data-colour-input]'))return;" +
  "var p=parts(el);if(!p)return;" +
  "if(!e.kbRestore){if(p.def)p.def.checked=false;if(p.keep)p.keep.checked=false}" +
  "sync(p)},true);" +
  "document.addEventListener('change',function(e){var el=e.target;if(!el||!el.matches||!el.matches('[data-colour-default],[data-colour-keep]'))return;" +
  "var p=parts(el);if(!p)return;" +
  "if(!e.kbRestore&&el.checked){var other=el===p.def?p.keep:p.def;if(other)other.checked=false}" +
  "sync(p)},true);" +
  // The cascade script re-enables or disables every control when its master
  // changes; this listener was added after it, so it runs after it on the
  // master and before the save bar.
  "function all(){Array.prototype.forEach.call(document.querySelectorAll('[data-colour]'),function(box){var p=parts(box);if(p)sync(p)})}" +
  "Array.prototype.forEach.call(document.querySelectorAll('[data-cascade-master]'),function(m){m.addEventListener('change',all)});" +
  "all()" +
  "})();";

// ---------- Emoji ----------

export interface EmojiFieldOptions extends ControlAttrs {
  /** Names the field for the picker button and group, e.g. the setting's label. */
  label: string;
  /**
   * Names the text box itself (`aria-label`) when no `<label for>` points at it,
   * as in a table cell or an option row. The group and the grid's button keep
   * `label`.
   */
  inputLabel?: string;
  /** The box must be filled before the form posts. */
  required?: boolean;
  /** Example text shown in the empty box. */
  placeholder?: string;
  /** The longest text the server takes. */
  maxLength?: number;
}

/**
 * A free-text field for a channel-name prefix or suffix (#1435: not emoji-only,
 * so `Looking for group: ` is fine) with an emoji grid as a convenience: the
 * text box is the field, and a button beside it opens the
 * same grid the event group marker uses (`groupRowsScript` in
 * `event-group-form.ts`, which enhances every `[data-emoji-field]`). Picking an
 * emoji puts it in the box, replacing what was there; the server checks the box
 * either way. Without JavaScript the button stays hidden and the box is all
 * there is.
 */
export function renderEmojiField(
  name: string,
  value: string,
  o: EmojiFieldOptions,
): string {
  return (
    `<span class="kb-emoji-field" data-emoji-field data-emoji-noun="emoji" role="group" aria-label="${escapeHtml(o.label)}">` +
    `<span data-marker-wrap class="kb-emoji-wrap">` +
    `<input type="text" class="kb-input" data-marker-input${attr("id", o.id)}${attr("aria-label", o.inputLabel)}${attr("placeholder", o.placeholder)}${o.required ? " required" : ""}${o.maxLength ? ` maxlength="${o.maxLength}"` : ""}` +
    `${attr("aria-describedby", o.describedBy)}${invalidAttrs(o)} name="${escapeHtml(name)}" ` +
    `value="${escapeHtml(value)}" autocomplete="off" style="width:14rem"${o.disabled ? LOCK : ""}>` +
    `<button type="button" data-marker-btn class="kb-emoji-btn" aria-haspopup="true" aria-expanded="false" ` +
    `aria-label="Choose an emoji for ${escapeHtml(o.label)}" hidden${o.disabled ? LOCK : ""}>😀</button>` +
    `</span></span>`
  );
}

// ---------- Reaction-role message (#1433) ----------

export interface ReactionRoleMessageSelectOptions extends ControlAttrs {
  /**
   * The bot's reaction-role messages for this guild, newest first. `null` when
   * the list could not be read (the stored value is then kept and the control
   * says so, instead of claiming there are none).
   */
  messages: ReactionRoleMessageOptions | null;
  /**
   * What the empty option is called, when it is not "Link the channel instead":
   * the Reaction roles form calls it "Post a new message".
   */
  noneLabel?: string;
  /** Names the select (`aria-label`) when no `<label for>` points at it. */
  ariaLabel?: string;
  /** The line shown when the guild has no reaction-role messages yet; the default points at the Reaction Roles page. */
  emptyNote?: string;
  /** The line shown when the list could not be read; the default says the stored choice is kept, which a new entry does not have. */
  unreadableNote?: string;
}

/** What the empty option is called: `{roles}` then mentions the channel. */
export const REACTION_ROLE_MESSAGE_NONE_LABEL = "Link the channel instead";

/** The empty option on the Reaction roles page itself (#1530): no message chosen posts a new one. */
export const REACTION_ROLE_MESSAGE_NEW_LABEL = "Post a new message";

/**
 * A select of the bot's own reaction-role messages, the stored value being the
 * message id (`welcome.roles_message_id`, #1433).
 *
 * - The first option is empty: "Link the channel instead" (or `noneLabel`).
 * - A stored id that is not in the list (archived or deleted since, or older
 *   than the cap) is a selected `<id> (not found)` option, so it is shown and
 *   posts unchanged. If the list could not be read, it reads `(could not check)`.
 * - No option is ever `disabled`: a disabled option is not posted, so a
 *   selected one would clear the setting.
 * - With no messages the select still holds the empty choice (and the stored
 *   value), and a line beneath points at the Reaction Roles page.
 * - When the list is cut at the cap, a line says the newest are shown.
 *
 * It is a plain select, so it works without JavaScript; the server checks the
 * id again (`coerceConfigValue`).
 */
export function renderReactionRoleMessageSelect(
  name: string,
  current: string,
  o: ReactionRoleMessageSelectOptions,
): string {
  // The value is matched and posted exactly as stored: a legacy id with
  // surrounding spaces (the welcome service trims it) must round-trip
  // unchanged, because the server's exemption compares the exact string.
  const trimmed = current.trim();
  const noneLabel = o.noneLabel ?? REACTION_ROLE_MESSAGE_NONE_LABEL;
  const list = o.messages?.options ?? [];
  const listed = list.find((m) => m.messageId === current);
  const option = (value: string, label: string): string =>
    `<option value="${escapeHtml(value)}"${value === current ? " selected" : ""}>${escapeHtml(label)}</option>`;
  const stray = (): string => {
    const known = list.find((m) => m.messageId === trimmed);
    if (known) return known.label;
    if (trimmed === "") return `${noneLabel} (stored as blank text)`;
    return `${trimmed} (${o.messages ? "not found" : "could not check"})`;
  };
  const options = [
    option("", noneLabel),
    ...(current === "" || listed ? [] : [option(current, stray())]),
    ...list.map((m) => option(m.messageId, m.label)),
  ].join("");
  let note = "";
  if (o.messages === null) {
    note =
      o.unreadableNote !== undefined
        ? escapeHtml(o.unreadableNote)
        : "The list of reaction-role messages could not be read. The stored choice is kept.";
  } else if (list.length === 0) {
    note =
      o.emptyNote !== undefined
        ? escapeHtml(o.emptyNote)
        : 'There are no reaction-role messages yet. Post one on the <a href="/admin/reaction-roles">Reaction Roles</a> page, then choose it here.';
  } else if (o.messages.truncated) {
    note = `Showing the ${list.length} newest reaction-role messages. A choice made earlier stays selected.`;
  }
  return (
    `<span class="kb-msgpick">` +
    `<select class="kb-select"${attr("id", o.id)}${attr("aria-label", o.ariaLabel)}${attr("aria-describedby", o.describedBy)}${invalidAttrs(o)} ` +
    `name="${escapeHtml(name)}"${o.disabled ? LOCK : ""}>${options}</select>` +
    (note ? `<span class="kb-help">${note}</span>` : "") +
    `</span>`
  );
}

// ---------- Numbers: stepper and duration presets (#1427) ----------

export interface NumberControlBounds {
  min?: number;
  max?: number;
}

/** A stored negative whole number: its native `pattern` must let the minus through (#1437). */
function isStoredNegative(value: string | number): boolean {
  return /^-[0-9]+$/.test(String(value));
}

function boundAttrs(b: NumberControlBounds): string {
  return (
    (b.min !== undefined ? ` data-min="${b.min}"` : "") +
    (b.max !== undefined ? ` data-max="${b.max}"` : "")
  );
}

function rangeTitle(b: NumberControlBounds): string {
  return b.min !== undefined && b.max !== undefined
    ? `Whole number from ${b.min} to ${b.max}`
    : "Whole number";
}

/**
 * A stepper for a small range: `span.kb-stepper` around minus and plus buttons
 * and the digit box, which is the field that posts (`name`), so a browser
 * without JavaScript has the bounded box and the server checks the same range.
 * The buttons are `hidden` until `STEPPER_SCRIPT` runs, since without it they
 * do nothing. A stored value outside the range is shown as it is and never
 * clamped on render. A locked control (dependency lock) has its buttons locked
 * too, which the cascade script never touches.
 */
export function renderStepper(
  name: string,
  value: string | number,
  b: NumberControlBounds,
  label: string,
  a: ControlAttrs = {},
): string {
  const lock = a.disabled ? LOCK : "";
  const button = (step: -1 | 1, glyph: string, verb: string): string =>
    `<button type="button" data-step="${step}" aria-label="${verb} ${escapeHtml(label)}" hidden${lock}>` +
    `<span aria-hidden="true">${glyph}</span></button>`;
  return (
    `<span class="kb-stepper" data-stepper>` +
    button(-1, "−", "Decrease") +
    `<input type="text"${attr("id", a.id)}${attr("aria-describedby", a.describedBy)}${invalidAttrs(a)}` +
    ` name="${escapeHtml(name)}" value="${escapeHtml(value)}" inputmode="numeric" autocomplete="off"` +
    ` pattern="${isStoredNegative(value) ? "-?[0-9]*" : "[0-9]*"}" title="${escapeHtml(rangeTitle(b))}" data-number${boundAttrs(b)} required${lock}>` +
    button(1, "+", "Increase") +
    `</span>`
  );
}

export interface DurationPresetOptions extends ControlAttrs {
  /** Names the box, e.g. the setting's label. */
  label: string;
  /** "minutes", shown after the control. */
  unit: string;
  /** What `0` is called, when it is not a number ("Off"). */
  zeroLabel?: string;
  /**
   * A first choice for "no value" (an empty box, e.g. "Server default"). It posts
   * `emptyValue` as the preset and is ticked while `current` is empty.
   */
  emptyLabel?: string;
}

/** The preset a ticked "no value" choice posts (see `DurationPresetOptions.emptyLabel`). */
export const DURATION_EMPTY_PRESET = "default";

const PRESET_VALUE = /^\d+$/;

const UNIT_SECONDS: Record<string, number> = {
  seconds: 1,
  minutes: 60,
  hours: 3600,
  days: 86400,
};
const UNIT_STEPS: Array<[string, string, number]> = [
  ["s", "s", 1],
  ["min", "min", 60],
  ["h", "h", 3600],
  ["day", "days", 86400],
];

/**
 * A preset as people read it: "30 s", "5 min", "1 h", "2 days". The number is in
 * the key's unit (`seconds`, `minutes`, `hours`, `days`) and is shown in the
 * largest unit that divides it evenly, so `3600` seconds reads "1 h" and `10080`
 * minutes "7 days". An unknown unit shows the bare number.
 */
export function formatPresetLabel(n: number, unit: string): string {
  const base = UNIT_SECONDS[unit];
  if (!base || n === 0) return String(n);
  const total = n * base;
  let pick = UNIT_STEPS[0];
  for (const step of UNIT_STEPS) if (total % step[2] === 0) pick = step;
  const v = total / pick[2];
  return `${v} ${v === 1 ? pick[0] : pick[1]}`;
}

/**
 * The posted preset radio value when it names one of `presets`, else null.
 * The save handlers use it: a numeric preset wins over the box, anything else
 * ("custom", nothing, a value that is not a preset) means the box, whose value
 * goes through `coerceConfigValue` like any number.
 */
export function pickPreset(
  posted: unknown,
  presets: readonly number[],
): string | null {
  return typeof posted === "string" &&
    PRESET_VALUE.test(posted) &&
    presets.includes(Number(posted))
    ? posted
    : null;
}

/**
 * Preset durations: a radio group of the common values and a last "Custom…",
 * then the bounded box (`boxName`), then the unit.
 *
 * - The box always holds the effective number and `presetName` is the radio
 *   group. A numeric preset wins; "custom", or no radio at all (a locked
 *   control, a crafted post), means the box. So without JavaScript the box is
 *   simply there next to Custom…, and the number posted is the one a script
 *   would produce (`readSettingField`).
 * - A stored value that is not a preset (an old 45, or one outside the range)
 *   ticks Custom… and shows in the box, posting unchanged.
 * - The box has no `pattern`: a pattern is native validation that applies
 *   whether or not a preset is ticked, so without JavaScript a stray `1e3` in
 *   the box would block a form that posts the ticked preset. `NUMBER_INPUT_SCRIPT`
 *   checks the digit shape itself and the server refuses a malformed Custom
 *   value (`coerceConfigValue`).
 * - The script hides the box's wrapper unless Custom… is ticked; the save bar
 *   treats a hidden control as inactive.
 */
export function renderDurationPresets(
  presetName: string,
  boxName: string,
  current: string | number,
  presets: readonly number[],
  b: NumberControlBounds,
  o: DurationPresetOptions,
): string {
  // Matched as stored, untrimmed: a value such as "30 " is not a preset, so it
  // stays visible under Custom… where it can be corrected. Hiding a box that
  // holds it would leave a pattern mismatch that blocks the submit unseen.
  const text = String(current);
  const isPreset = PRESET_VALUE.test(text) && presets.includes(Number(text));
  const options = [
    ...(o.emptyLabel
      ? [{ value: DURATION_EMPTY_PRESET, label: o.emptyLabel }]
      : []),
    ...presets.map((n) => ({
      value: String(n),
      label:
        n === 0 && o.zeroLabel ? o.zeroLabel : formatPresetLabel(n, o.unit),
    })),
    { value: "custom", label: "Custom…" },
  ];
  const group = renderSegmented(
    presetName,
    options,
    o.emptyLabel && text === ""
      ? DURATION_EMPTY_PRESET
      : isPreset
        ? String(Number(text))
        : "custom",
    o,
  );
  const lock = o.disabled ? LOCK : "";
  return (
    `<div class="kb-duration" data-duration>` +
    group +
    `<span class="kb-duration__custom" data-duration-custom>` +
    `<input type="text" class="kb-input" data-duration-input name="${escapeHtml(boxName)}" value="${escapeHtml(current)}"` +
    ` inputmode="numeric" autocomplete="off" title="${escapeHtml(rangeTitle(b))}" data-number${boundAttrs(b)}` +
    ` aria-label="Custom ${escapeHtml(o.label)} in ${escapeHtml(o.unit)}" style="width:6rem"${lock}>` +
    `<span class="kb-unit">${escapeHtml(o.unit)}</span></span>` +
    `</div>`
  );
}

/**
 * Turns the stepper buttons on. A click moves the box by one inside
 * `data-min`..`data-max` and fires `input` and `change`, so the save bar counts
 * it like a keystroke. Each button is disabled at its bound, worked out again
 * on every `input` and `change` (typing, a click, Discard's restore) and after
 * the section's master changes: the cascade script re-enables only inputs and
 * selects, not buttons, so a button that should stay off at the bound would
 * otherwise be left as it was. A dependency-locked control keeps its locked
 * buttons as rendered. A value that is not a number leaves both buttons on,
 * and a click sets the minimum.
 */
export const STEPPER_SCRIPT =
  "(function(){" +
  "function bound(el,n){var v=el.getAttribute(n);return v===null?null:Number(v)}" +
  "function sync(box){var i=box.querySelector('input');if(!i)return;" +
  "var v=i.value.trim(),n=/^[0-9]+$/.test(v)?Number(v):null,lo=bound(i,'data-min'),hi=bound(i,'data-max');" +
  "Array.prototype.forEach.call(box.querySelectorAll('[data-step]'),function(b){b.hidden=false;" +
  "if(b.hasAttribute('data-dep-locked'))return;var d=Number(b.getAttribute('data-step'));" +
  "b.disabled=i.disabled||(n!==null&&((d<0&&lo!==null&&n<=lo)||(d>0&&hi!==null&&n>=hi)))})}" +
  "function boxOf(el){return el&&el.closest?el.closest('[data-stepper]'):null}" +
  "document.addEventListener('click',function(e){var b=e.target&&e.target.closest?e.target.closest('[data-step]'):null;" +
  "var box=boxOf(b);if(!box||b.disabled)return;var i=box.querySelector('input');if(!i||i.disabled)return;" +
  "var d=Number(b.getAttribute('data-step')),lo=bound(i,'data-min'),hi=bound(i,'data-max'),v=i.value.trim();" +
  "var n=/^[0-9]+$/.test(v)?Number(v)+d:(lo===null?0:lo);" +
  "if(lo!==null&&n<lo)n=lo;if(hi!==null&&n>hi)n=hi;" +
  "if(String(n)!==i.value){i.value=String(n);i.dispatchEvent(new Event('input',{bubbles:true}));" +
  "i.dispatchEvent(new Event('change',{bubbles:true}))}" +
  "sync(box);try{i.focus()}catch(err){}});" +
  "function onEdit(e){var box=boxOf(e.target);if(box&&e.target.tagName==='INPUT')sync(box)}" +
  "document.addEventListener('input',onEdit,true);document.addEventListener('change',onEdit,true);" +
  "function all(){Array.prototype.forEach.call(document.querySelectorAll('[data-stepper]'),sync)}" +
  "Array.prototype.forEach.call(document.querySelectorAll('[data-cascade-master]'),function(m){m.addEventListener('change',all)});" +
  "all()" +
  "})();";

/**
 * Keeps a preset group and its box in step. Ticking a number copies it into the
 * box, so the box always holds what the form means (and a hidden box never
 * keeps an out-of-range number that the browser would refuse to submit);
 * ticking Custom… keeps the number that was there. The box's wrapper is hidden
 * unless Custom… is ticked. Discard's restoring events (`kbRestore`) put the
 * radios and the box back themselves, so they only re-sync the wrapper.
 * Capture phase, so the save bar finds the final state.
 */
export const DURATION_PRESETS_SCRIPT =
  "(function(){" +
  "function sync(box,user){var radios=box.querySelectorAll('input[type=radio]'),cur=null,i;" +
  "for(i=0;i<radios.length;i++)if(radios[i].checked)cur=radios[i];" +
  "var input=box.querySelector('[data-duration-input]'),wrap=box.querySelector('[data-duration-custom]');" +
  "var custom=!cur||cur.value==='custom';" +
  // A choice that is not a number ("Server default") empties the box.
  "if(input&&user&&cur&&!custom)input.value=/^[0-9]+$/.test(cur.value)?cur.value:'';" +
  "if(input&&!custom)input.setCustomValidity('');" +
  // Only Custom… needs a number in the box: required then, so the browser
  // flags an empty box, and not otherwise, so a preset never depends on it.
  "if(input)input.required=custom;" +
  "if(wrap)wrap.hidden=!custom}" +
  "document.addEventListener('change',function(e){var el=e.target;" +
  "if(!el||!el.matches||!el.matches('[data-duration] input[type=radio]'))return;" +
  "sync(el.closest('[data-duration]'),!e.kbRestore)},true);" +
  "Array.prototype.forEach.call(document.querySelectorAll('[data-duration]'),function(b){sync(b,false)})" +
  "})();";
