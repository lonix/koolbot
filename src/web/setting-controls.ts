/**
 * Form controls for the settings rows (#1318, design system: Switch,
 * SegmentedControl, SettingRow).
 *
 * Everything here is a pure string renderer with no dependency on the page
 * renderers, so each control can be tested on its own. The controls are real
 * form inputs and work without JavaScript, as follows.
 *
 * - a switch is `<input type=checkbox role=switch>` and posts `value=true` only
 *   while checked. An unchecked switch posts nothing, and the save handlers
 *   already treat a key that is listed in `keys` but absent as `false`
 *   (`coerceConfigValue`), so no companion field is needed;
 * - a segmented control is a `radiogroup` of radio inputs that post the
 *   selected option's value.
 *
 * The On/Off text of a switch is drawn by kb.css from the checked state, so it
 * stays in step with the input without a script.
 */

import { icon } from "./icons.js";
import { escapeHtml } from "./admin-layout.js";
import type { SettingOption } from "../services/config-schema.js";

/** Most options a segmented control shows; more than this stays a select. */
export const SEGMENTED_MAX_OPTIONS = 4;
/** Longest option label a segment holds; longer labels stay in a select. */
const SEGMENTED_MAX_LABEL = 28;

/** Attributes shared by the controls: ids, description links, state. */
export interface ControlAttrs {
  /** DOM id of the control (the input of a switch, the group of a segmented control). */
  id?: string;
  /** Space-separated ids that describe the control. */
  describedBy?: string;
  /** Id of the element that names the control (the row name). */
  labelledBy?: string;
  disabled?: boolean;
  /** The last save rejected this value. */
  invalid?: boolean;
  /** `data-describedby-base` for the AJAX save script (see `ControlA11y`). */
  describedByBase?: string;
}

function attr(name: string, value: string | undefined): string {
  return value ? ` ${name}="${escapeHtml(value)}"` : "";
}

function invalidAttrs(a: ControlAttrs): string {
  return a.invalid
    ? ` aria-invalid="true" data-describedby-base="${escapeHtml(a.describedByBase ?? "")}"`
    : "";
}

/**
 * A switch: `label.kb-switch` around a real checkbox with `role=switch`.
 *
 * The accessible name comes from `labelledBy` (the row's name element); the
 * On/Off text is `aria-hidden` because the switch role already announces its
 * state. `extra` carries data attributes such as `data-cascade-master`.
 */
export function renderSwitch(
  name: string,
  checked: boolean,
  a: ControlAttrs = {},
  extra = "",
): string {
  return (
    `<label class="kb-switch">` +
    `<input type="checkbox" role="switch"${attr("id", a.id)} name="${escapeHtml(name)}" value="true"` +
    `${checked ? " checked" : ""}${attr("aria-labelledby", a.labelledBy)}` +
    `${attr("aria-describedby", a.describedBy)}${invalidAttrs(a)}${a.disabled ? " disabled data-dep-locked" : ""}${extra}>` +
    `<span class="kb-switch__track" aria-hidden="true"></span>` +
    `<span class="kb-switch__state" aria-hidden="true"></span>` +
    `</label>`
  );
}

/**
 * Whether an enum renders as a segmented control: two to four options whose
 * labels are short, and a current value that is one of them. Anything else
 * stays a `<select>`. The last condition matters: with no radio checked a form
 * posts nothing for the key, which would save it as empty and silently lose a
 * stored value that is not in the option list; the select keeps such a value
 * as a selected "(unknown)" placeholder instead.
 */
export function segmentedFits(
  options: readonly SettingOption[] | undefined,
  current: string,
): boolean {
  if (!options) return false;
  if (options.length < 2 || options.length > SEGMENTED_MAX_OPTIONS) {
    return false;
  }
  if (options.some((o) => o.label.length > SEGMENTED_MAX_LABEL)) return false;
  return options.some((o) => o.value === current);
}

/**
 * A segmented control: `div.kb-segmented[role=radiogroup]` of radio inputs.
 * A group is not a labelable element, so it is named with `aria-labelledby`.
 * Radio ids are `<id>-<n>`, keeping the group's own `id` unique.
 */
export function renderSegmented(
  name: string,
  options: readonly SettingOption[],
  current: string,
  a: ControlAttrs = {},
): string {
  const items = options
    .map((o, i) => {
      const id = a.id ? ` id="${escapeHtml(a.id)}-${i}"` : "";
      return (
        `<label><input type="radio"${id} name="${escapeHtml(name)}" value="${escapeHtml(o.value)}"` +
        `${o.value === current ? " checked" : ""}${a.disabled ? " disabled data-dep-locked" : ""}>` +
        `<span>${escapeHtml(o.label)}</span></label>`
      );
    })
    .join("");
  return (
    `<div class="kb-segmented" role="radiogroup"${attr("id", a.id)}${attr("aria-labelledby", a.labelledBy)}` +
    `${attr("aria-describedby", a.describedBy)}${invalidAttrs(a)}>${items}</div>`
  );
}

// ---------- Numbers ----------

/** How many characters a whole number up to `max` (and its sign) can take. */
function numberMaxLength(
  min: number | undefined,
  max: number | undefined,
): number {
  const digits = max === undefined ? 9 : String(Math.abs(max)).length;
  return digits + (min !== undefined && min < 0 ? 1 : 0);
}

/**
 * A bounded whole number (#1304). A `type="number"` input lets letters in on
 * Safari and Firefox and ignores `pattern`, so this is a text input with
 * `inputmode="numeric"` (the digit keypad on phones) and `pattern`, plus
 * `data-min` / `data-max` that `NUMBER_INPUT_SCRIPT` (number-input.ts) turns into a range
 * check and a digit filter. Without the script the pattern and `maxlength`
 * still hold, and the server refuses anything out of range either way.
 */
export function renderNumberInput(
  name: string,
  value: string | number,
  bounds: { min?: number; max?: number },
  a: ControlAttrs = {},
): string {
  const { min, max } = bounds;
  const signed = min !== undefined && min < 0;
  const range =
    min !== undefined && max !== undefined
      ? `Whole number from ${min} to ${max}`
      : "Whole number";
  return (
    `<input type="text" class="kb-input"${attr("id", a.id)}` +
    `${attr("aria-describedby", a.describedBy)}${invalidAttrs(a)}` +
    ` name="${escapeHtml(name)}" value="${escapeHtml(value)}"` +
    ` inputmode="numeric" autocomplete="off" pattern="${signed ? "-?[0-9]*" : "[0-9]*"}"` +
    ` maxlength="${numberMaxLength(min, max)}" title="${escapeHtml(range)}" data-number` +
    `${min !== undefined ? ` data-min="${min}"` : ""}${max !== undefined ? ` data-max="${max}"` : ""}` +
    ` required style="width:8rem"${a.disabled ? " disabled data-dep-locked" : ""}>`
  );
}

// ---------- Bot-managed values ----------

/**
 * The value of a bot-managed key (the id of a message the bot posted) as text
 * with a jump link, never an input (#1304). `jumpUrl` is absent when the
 * message or its channel is not known.
 */
export function renderManagedValue(
  messageId: string,
  jumpUrl: string | undefined,
): string {
  if (!messageId) {
    return `<span class="kb-help">Not posted yet. KoolBot sets this when it posts the message.</span>`;
  }
  const link = jumpUrl
    ? ` <a class="kb-chip" href="${escapeHtml(jumpUrl)}" target="_blank" rel="noopener noreferrer">Jump to message</a>`
    : "";
  return `<span class="kb-mono">${escapeHtml(messageId)}</span>${link}`;
}

// ---------- Setting rows ----------

/** Inline icon for the reset button: a counter-clockwise arrow. */
const RESET_ICON = icon("rotate-ccw");

/**
 * Reset-to-default button for a row whose value differs from its default.
 * It submits the card's separate reset form (`formId`, see
 * `renderSettingsForms`) rather than being a submit button of the settings
 * form itself: a submit button inside the form would become the default
 * button, so pressing Enter in a text field would reset a row instead of
 * saving. Without JavaScript it is an ordinary POST.
 */
export function renderResetControl(
  key: string,
  label: string,
  defaultText: string,
  formId: string,
  fullDefaultText = defaultText,
): string {
  const name = escapeHtml(label || key);
  const text = escapeHtml(defaultText);
  const full = escapeHtml(fullDefaultText);
  // The default is only in the accessible name and the tooltip, never visible
  // text: a long default (a message template) beside the control would not
  // wrap and would break reflow on a narrow screen (WCAG 1.4.10).
  return (
    `<button type="submit" form="${escapeHtml(formId)}" name="key" value="${escapeHtml(key)}" ` +
    `class="kb-btn kb-btn--ghost kb-btn--icon kb-btn--sm" ` +
    `aria-label="Reset ${name} to its default, ${text}" title="Reset to default: ${full}">${RESET_ICON}</button>`
  );
}

/** The dot after a changed row's name, with a text alternative. */
export function renderChangedMark(): string {
  return `<span class="kb-setting__changed" aria-hidden="true"></span><span class="kb-visually-hidden"> (changed)</span>`;
}

/**
 * Split a description into the one line shown on the row and the rest, which
 * goes behind More. Short descriptions stay whole. The split is at the first
 * sentence end, skipping "e.g." and "i.e.", so the line never ends mid-phrase.
 */
export function splitDescription(description: string): {
  short: string;
  rest: string;
} {
  const text = description.trim();
  if (text.length <= 140) return { short: text, rest: "" };
  let from = 0;
  for (;;) {
    const at = text.indexOf(". ", from);
    if (at < 0) return { short: text, rest: "" };
    const head = text.slice(0, at);
    if (at >= 30 && !head.endsWith("e.g") && !head.endsWith("i.e")) {
      return { short: head + ".", rest: text.slice(at + 2).trim() };
    }
    from = at + 2;
  }
}

/** One node of the nested settings tree. */
export interface SettingNode<T> {
  row: T;
  children: SettingNode<T>[];
}

/**
 * Arrange rows so each dependent sits under its parent.
 *
 * A row's parent is, in order: the first of its `dependsOn` targets that is a
 * row of this form (preferring one that is off, so a locked child is always
 * right under what it waits for), else the form's master toggle, which every
 * other row of a cascading form already depends on. A row with neither stays
 * at the top level. Sibling order is the input order, a parent that would make
 * a cycle is ignored, and every row appears exactly once.
 */
export function buildSettingTree<T extends { key: string }>(
  rows: readonly T[],
  masterKey: string | null,
  dependencies: (key: string) => readonly string[],
  isOn: (key: string) => boolean,
): SettingNode<T>[] {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const parentOf = new Map<string, string>();
  for (const r of rows) {
    if (r.key === masterKey) continue;
    const inForm = dependencies(r.key).filter(
      (d) => d !== r.key && byKey.has(d),
    );
    const parent = inForm.find((d) => !isOn(d)) ?? inForm[0] ?? masterKey;
    if (parent && parent !== r.key) parentOf.set(r.key, parent);
  }
  // Drop any parent link that closes a loop.
  for (const r of rows) {
    const seen = new Set<string>([r.key]);
    let at = parentOf.get(r.key);
    while (at !== undefined) {
      if (seen.has(at)) {
        parentOf.delete(r.key);
        break;
      }
      seen.add(at);
      at = parentOf.get(at);
    }
  }
  const nodes = new Map<string, SettingNode<T>>(
    rows.map((r) => [r.key, { row: r, children: [] }]),
  );
  const roots: SettingNode<T>[] = [];
  for (const r of rows) {
    const node = nodes.get(r.key) as SettingNode<T>;
    const parent = parentOf.get(r.key);
    if (parent) (nodes.get(parent) as SettingNode<T>).children.push(node);
    else roots.push(node);
  }
  return roots;
}
