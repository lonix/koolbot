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

import { escapeHtml } from "./html.js";
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
    `<input type="text" class="kb-input" data-marker-input${attr("id", o.id)}` +
    `${attr("aria-describedby", o.describedBy)}${invalidAttrs(o)} name="${escapeHtml(name)}" ` +
    `value="${escapeHtml(value)}" autocomplete="off" style="width:14rem"${o.disabled ? LOCK : ""}>` +
    `<button type="button" data-marker-btn class="kb-emoji-btn" aria-haspopup="true" aria-expanded="false" ` +
    `aria-label="Choose an emoji for ${escapeHtml(o.label)}" hidden${o.disabled ? LOCK : ""}>😀</button>` +
    `</span></span>`
  );
}

// ---------- Numbers: stepper and duration presets (#1427) ----------

export interface NumberControlBounds {
  min?: number;
  max?: number;
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
    ` pattern="[0-9]*" title="${escapeHtml(rangeTitle(b))}" data-number${boundAttrs(b)} required${lock}>` +
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
}

const PRESET_VALUE = /^\d+$/;

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
    ...presets.map((n) => ({
      value: String(n),
      label: n === 0 && o.zeroLabel ? o.zeroLabel : String(n),
    })),
    { value: "custom", label: "Custom…" },
  ];
  const group = renderSegmented(
    presetName,
    options,
    isPreset ? String(Number(text)) : "custom",
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
    `</span><span class="kb-unit">${escapeHtml(o.unit)}</span>` +
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
  "if(input&&user&&cur&&!custom)input.value=cur.value;" +
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
