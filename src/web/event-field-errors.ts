/**
 * Which field of the event form a refusal is about (#1531), and how a view
 * marks it: `aria-invalid="true"` on the control, a `p.kb-field__error` linked
 * by `aria-describedby`, and focus on the first marked field when the page
 * loads (docs/design/components.md → Field, DESIGN.md → Accessibility).
 *
 * Shared by the event validator, the create pipeline, and the New event and
 * Edit event views. Deliberately small and not tied to one form, so another
 * form can adopt it.
 */

import { escapeHtml } from "./html.js";
import { toneIcon } from "./icons.js";

/**
 * The fields a refusal can name. `groups` is the Groups section as a whole (its
 * rows are shown as posted, with the message above them).
 */
export const EVENT_FORM_FIELDS = [
  "title",
  "description",
  "when",
  "date",
  "time",
  "timezone",
  "duration",
  "recurrence",
  "groups",
] as const;

export type EventFormField = (typeof EVENT_FORM_FIELDS)[number];

/** Whether a refused form's error key names a field of the event form. */
export function isEventFormField(
  name: string | undefined,
): name is EventFormField {
  return (EVENT_FORM_FIELDS as readonly string[]).includes(name ?? "");
}

/** A refusal: always a message, and the field when it is about exactly one. */
export interface EventFormRefusal {
  message: string;
  field?: EventFormField;
}

/** What a view needs to mark one field. */
export interface FieldMark {
  /** True when this field is the one refused. */
  invalid: boolean;
  /** Id of the error line, or undefined when the field is fine. */
  errorId: string | undefined;
  /** ` aria-invalid="true" aria-describedby="…"` for a control, or "". */
  attrs: string;
  /** The `p.kb-field__error` line, or "". */
  line: string;
  /**
   * The line on a row of its own at this indent, or "" so an unmarked field
   * leaves the markup byte for byte as it was.
   */
  after: (indent: number) => string;
}

/**
 * The mark for `field` given the refusal (if any). `id` is the control's id;
 * the error line is `<id>-error`.
 */
export function markField(
  refusal: EventFormRefusal | null | undefined,
  field: EventFormField,
  id: string,
): FieldMark {
  if (!refusal || refusal.field !== field) {
    return {
      invalid: false,
      errorId: undefined,
      attrs: "",
      line: "",
      after: () => "",
    };
  }
  const errorId = `${id}-error`;
  const line = `<p class="kb-field__error" id="${escapeHtml(errorId)}"${field === "groups" ? " data-field-error-target" : ""}>${toneIcon("err")}${escapeHtml(refusal.message)}</p>`;
  return {
    invalid: true,
    errorId,
    attrs: ` aria-invalid="true" aria-describedby="${escapeHtml(errorId)}"`,
    line,
    after: (indent) => `\n${" ".repeat(indent)}${line}`,
  };
}

/**
 * The short callout at the top of a refused form. A refusal that names a field
 * says so and leaves the reason to the field's own line; one that does not (the
 * open-event cap, a Discord failure) carries the reason itself.
 */
export function renderRefusalCallout(
  refusal: EventFormRefusal,
  heading: string,
): string {
  const text = refusal.field
    ? "Check the field marked below, change it and try again."
    : refusal.message;
  return `<div class="kb-callout kb-callout--err" role="alert" tabindex="-1" data-refusal-callout>${toneIcon("err")}<div class="kb-callout__body"><p class="kb-callout__title">${escapeHtml(heading)}</p><p class="kb-callout__text">${escapeHtml(text)}</p></div></div>`;
}

/**
 * Moves focus to the first marked field on load. Without JavaScript the error
 * line is still read through `aria-describedby`. A refusal that is not about
 * one field (the open-event limit, a Discord failure) has none, so focus falls
 * back to the callout that carries the reason. A control is focused as it is;
 * the Groups error line is not a control, so it takes a temporary tabindex.
 */
export const FOCUS_FIRST_INVALID_SCRIPT =
  "(function(){" +
  "var el=document.querySelector('[aria-invalid=\"true\"],[data-field-error-target]')||document.querySelector('[data-refusal-callout]');" +
  "if(!el)return;" +
  "if(!/^(a|button|input|select|textarea)$/i.test(el.tagName)&&!el.hasAttribute('tabindex'))el.setAttribute('tabindex','-1');" +
  "try{el.focus()}catch(e){}" +
  "try{el.scrollIntoView({block:'center'})}catch(e){}" +
  "})();";
