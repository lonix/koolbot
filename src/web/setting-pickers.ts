/**
 * Pickers for settings (and event forms) whose value has a known set (#1426):
 * a searchable timezone select, a colour input with a "Use default" box, and
 * the emoji picker the event group marker uses.
 *
 * Like the other controls in `setting-controls.ts` these are string renderers
 * over real form inputs, so they work without JavaScript and the server checks
 * every value again (`utils/setting-formats.ts`). A stored value that the
 * picker cannot produce (an old custom timezone, a colour that is not
 * `#RRGGBB`, a prefix that is not an emoji) is shown as it is and posts
 * unchanged, so opening and saving a page never rewrites it.
 */

import { escapeHtml } from "./html.js";
import type { ControlAttrs } from "./setting-controls.js";
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
 * match (`hidden` and `disabled`, so the option indexes the save bar compares
 * never change, and the selected and the original option always stay), and
 * Enter picks the first match. Underscores and slashes count as spaces, so
 * "new york" finds America/New_York.
 */
export const TIMEZONE_SELECT_SCRIPT =
  "(function(){" +
  "function norm(x){return String(x).toLowerCase().replace(/[_\\/]+/g,' ')}" +
  "function init(box){var s=box.querySelector('[data-tz-search]'),sel=box.querySelector('select'),st=box.querySelector('[data-tz-status]');" +
  "if(!s||!sel||box.hasAttribute('data-ready'))return;box.setAttribute('data-ready','');s.hidden=false;" +
  "function run(){var q=norm(s.value.trim()),n=0,first=null,i,o,hit,keep;" +
  "for(i=0;i<sel.options.length;i++){o=sel.options[i];hit=!q||norm(o.value+' '+o.textContent).indexOf(q)!==-1;" +
  "if(hit){n++;if(!first)first=o}keep=hit||o.selected||o.defaultSelected;o.hidden=!keep;o.disabled=!keep}" +
  "if(st){st.hidden=!q;st.textContent=n?n+(n===1?' timezone matches':' timezones match'):'No timezones match'}" +
  "return first}" +
  "s.addEventListener('input',run);" +
  "s.addEventListener('keydown',function(e){if(e.key!=='Enter')return;e.preventDefault();var f=run();" +
  "if(f&&s.value.trim()){sel.value=f.value;sel.dispatchEvent(new Event('change',{bubbles:true}));sel.focus()}})}" +
  "Array.prototype.forEach.call(document.querySelectorAll('[data-tz]'),init)" +
  "})();";

// ---------- Colour ----------

/**
 * A colour input with a "Use default" checkbox. `<input type="color">` always
 * holds a colour, but `""` is how the setting says "Discord's default", so the
 * checkbox posts `<defaultName>=true` and the save handlers read it through
 * `readSettingField`; it wins over the swatch, with or without JavaScript.
 *
 * A stored value that is not `#RRGGBB` (the service ignores it with a warning)
 * is posted unchanged from a hidden field and noted under the control, until a
 * colour is picked (script) or the default is ticked. The swatch has no name in
 * that case, because it would otherwise post black over the stored value.
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
  return (
    `<span class="kb-colour" data-colour>` +
    (legacy
      ? `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(current)}" data-colour-mirror data-stored="${escapeHtml(current)}"${lock}>`
      : "") +
    `<input type="color" class="kb-colour__swatch" data-colour-input${attr("id", a.id)}` +
    `${attr("aria-describedby", a.describedBy)}${invalidAttrs(a)}` +
    `${legacy ? "" : ` name="${escapeHtml(name)}"`} value="${escapeHtml(shown)}"${lock}>` +
    `<label class="kb-colour__default"><input type="checkbox" data-colour-default ` +
    `name="${escapeHtml(defaultName)}" value="true"${empty ? " checked" : ""}${lock}> Use default</label>` +
    (legacy
      ? `<span class="kb-help">Stored value <span class="kb-mono">${escapeHtml(current)}</span> is not a #RRGGBB colour. It stays as it is until you pick a colour or use the default.</span>`
      : "") +
    `</span>`
  );
}

/**
 * Keeps a colour input and its "Use default" box in step: picking a colour
 * unticks the box, ticking it greys the swatch out, and a stored value that is
 * not a colour is replaced by the first colour picked. Delegated, and it leaves
 * a control the dependency lock disabled alone.
 */
export const COLOUR_INPUT_SCRIPT =
  "(function(){" +
  "function parts(el){var box=el.closest('[data-colour]');if(!box)return null;" +
  "return{box:box,color:box.querySelector('[data-colour-input]'),def:box.querySelector('[data-colour-default]'),mirror:box.querySelector('[data-colour-mirror]')}}" +
  // The swatch is off while Use default is ticked, and while the box itself is
  // off: the section's cascade (its feature switch is off) disables every
  // control, and the dependency lock marks its own.
  "function sync(p){if(!p.color||!p.def||p.def.hasAttribute('data-dep-locked'))return;p.color.disabled=p.def.checked||p.def.disabled}" +
  // A hidden input's value IS its default attribute, so the mirror keeps the
  // stored text in `data-stored`. A pick that lands back on the swatch's first
  // colour is "no pick", so the stored text returns: the save bar cannot see a
  // hidden field change.
  "function mirrorFor(p){if(p.mirror)p.mirror.value=p.color.value===p.color.defaultValue?p.mirror.getAttribute('data-stored'):p.color.value}" +
  // Capture phase: the save bar listens on the form while bubbling, so it must
  // find the swatch and the box already in step. Discard's restoring events
  // (`kbRestore`) are not picks: the box and the mirror go back together.
  "document.addEventListener('input',function(e){var el=e.target;if(!el||!el.matches||!el.matches('[data-colour-input]'))return;" +
  "var p=parts(el);if(!p)return;" +
  "if(e.kbRestore){if(p.mirror)p.mirror.value=p.mirror.getAttribute('data-stored');sync(p);return}" +
  "if(p.def&&p.def.checked){p.def.checked=false;sync(p);p.def.dispatchEvent(new Event('change',{bubbles:true}))}" +
  "mirrorFor(p)},true);" +
  "document.addEventListener('change',function(e){var el=e.target;if(!el||!el.matches||!el.matches('[data-colour-default]'))return;var p=parts(el);" +
  "if(!p)return;if(e.kbRestore&&p.mirror)p.mirror.value=p.mirror.getAttribute('data-stored');sync(p)},true);" +
  // What a save sends is taken at submit, as the save bar takes its own
  // baseline: the effective value (Use default means empty) and the mirror it
  // came from. Edits made while the request is out are not part of it.
  "document.addEventListener('submit',function(e){var f=e.target;if(!f||!f.querySelectorAll)return;" +
  "Array.prototype.forEach.call(f.querySelectorAll('[data-colour-mirror]'),function(m){var p=parts(m);if(!p)return;" +
  "m.removeAttribute('data-sent');m.removeAttribute('data-sent-raw');" +
  // A disabled box means the section is off (or locked): the server skips
  // the key, so what was sent is not the new baseline.
  "if(p.def&&p.def.disabled)return;" +
  "m.setAttribute('data-sent',p.def&&p.def.checked?'':m.value);m.setAttribute('data-sent-raw',m.value)})},true);" +
  // An accepted save makes the sent value the stored one. The field follows
  // unless it was edited since submit, in which case that edit is still unsaved.
  "document.addEventListener('kb-saved',function(e){var f=e.target;if(!f||!f.querySelectorAll)return;" +
  "Array.prototype.forEach.call(f.querySelectorAll('[data-colour-mirror]'),function(m){if(!m.hasAttribute('data-sent'))return;" +
  "var sent=m.getAttribute('data-sent');m.setAttribute('data-stored',sent);" +
  "if(m.value===m.getAttribute('data-sent-raw'))m.value=sent;" +
  "m.removeAttribute('data-sent');m.removeAttribute('data-sent-raw')})},true);" +
  // The cascade script re-enables or disables every control when its master
  // changes; this listener was added after it, so it runs after it on the
  // master and before the save bar, and puts the swatch back in step.
  "function all(){Array.prototype.forEach.call(document.querySelectorAll('[data-colour]'),function(box){var p=parts(box);if(p)sync(p)})}" +
  "Array.prototype.forEach.call(document.querySelectorAll('[data-cascade-master]'),function(m){m.addEventListener('change',all)});" +
  "all()" +
  "})();";

// ---------- Emoji ----------

export interface EmojiFieldOptions extends ControlAttrs {
  /** Names the field for the picker button and group, e.g. the setting's label. */
  label: string;
}

/**
 * An emoji field for a channel-name prefix or suffix: the text box stays, so a
 * value such as `🎮 | ` can still be typed, and a button beside it opens the
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
    `<input type="text" class="kb-input" data-marker-input${attr("id", o.id)}` +
    `${attr("aria-describedby", o.describedBy)}${invalidAttrs(o)} name="${escapeHtml(name)}" ` +
    `value="${escapeHtml(value)}" autocomplete="off" style="width:8rem"${o.disabled ? LOCK : ""}>` +
    `<button type="button" data-marker-btn class="kb-emoji-btn" aria-haspopup="true" aria-expanded="false" ` +
    `aria-label="Choose an emoji for ${escapeHtml(o.label)}" hidden${o.disabled ? LOCK : ""}>😀</button>` +
    `</span></span>`
  );
}
