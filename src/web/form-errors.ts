/**
 * A refused form that comes back with what was typed and a message per field
 * (#1517).
 *
 * A write route that refuses a create or edit form collects one message per
 * field in a {@link FormErrors} map (`addFieldError`), then answers with
 * `refuseForm` (`routes/write/helpers.ts`): the page is rendered again with
 * status 422, so typed text never goes into a URL. The page renderer passes
 * the {@link RefusedForm} it receives to `formView` for each form it draws and
 * uses the view's methods while it writes the markup:
 *
 *   const f = formView(props.refusedForm, "announcement-create");
 *   `<label>Cron schedule
 *      <input type="text" name="cron" value="${escapeHtml(f.value("cron"))}"${f.attrs("cron")}>
 *    </label>${f.error("cron")}`
 *
 * For a form that was not refused every method returns its fallback or an
 * empty string, so the page renders exactly as it did before.
 *
 * The markup follows `docs/design/components.md` -> Field: the refused control
 * gets `aria-invalid="true"` and `aria-describedby` pointing at a
 * `p.kb-field__error` that says what to change. The layout's on-load script
 * moves focus to the first `[aria-invalid="true"]`, so the first refused field
 * (in page order) is announced with its message.
 */

import { escapeHtml } from "./html.js";

/** Field name -> what to change. */
export type FormErrors = Record<string, string>;

/** The submitted values of a refused form, by field name (checkbox: "1" or ""). */
export type FormValues = Record<string, string>;

export interface RefusedForm {
  /**
   * Which form on the page was refused. A page can hold several forms with the
   * same field names (a create form and one edit form per row), so errors and
   * values only apply to the form with this id. Also the prefix of element ids.
   */
  formId: string;
  errors: FormErrors;
  values: FormValues;
}

/** Record a message for a field; the first message for a field wins. */
export function addFieldError(
  errors: FormErrors,
  name: string,
  message: string,
): void {
  if (!Object.prototype.hasOwnProperty.call(errors, name)) {
    errors[name] = message;
  }
}

export interface FormView {
  /** This form is the one the server refused. */
  refused: boolean;
  /** The typed text of a field when refused, otherwise `fallback`. Escape it yourself. */
  value(name: string, fallback?: string): string;
  /**
   * ` value="..."` (escaped) for an input that is empty by default, or "" when
   * the refused form left it empty. For an input with a stored value, write
   * `value="${escapeHtml(view.value(name, stored))}"` instead.
   */
  valueAttr(name: string): string;
  /** The chosen option of a select when refused, otherwise `fallback`. */
  selected(name: string, fallback?: string): string;
  /** The state of a checkbox when refused, otherwise `fallback`. */
  checked(name: string, fallback?: boolean): boolean;
  /**
   * Attributes for the control: `id`, plus `aria-invalid` and `aria-describedby`
   * when the field was refused. `describedBy` lists ids the control already
   * points at (help text). Empty for a form that was not refused.
   */
  attrs(name: string, describedBy?: string): string;
  /** The `p.kb-field__error` line for a refused field, otherwise "". */
  error(name: string): string;
  /** ` open` for a disclosure that holds a refused form, otherwise "". */
  open(): string;
}

/** The view of one form of the page, given what the server refused (if anything). */
export function formView(
  refused: RefusedForm | null | undefined,
  formId: string,
): FormView {
  const state = refused && refused.formId === formId ? refused : null;
  const idOf = (name: string): string => `${formId}-${name}`;
  const errorId = (name: string): string => `${idOf(name)}-error`;
  const hasError = (name: string): boolean =>
    state !== null && Object.prototype.hasOwnProperty.call(state.errors, name);
  return {
    refused: state !== null,
    value: (name, fallback = "") =>
      state ? (state.values[name] ?? "") : fallback,
    valueAttr: (name): string => {
      const v = state ? (state.values[name] ?? "") : "";
      return v ? ` value="${escapeHtml(v)}"` : "";
    },
    selected: (name, fallback = "") =>
      state ? (state.values[name] ?? "") : fallback,
    checked: (name, fallback = false) =>
      state ? (state.values[name] ?? "") !== "" : fallback,
    attrs: (name, describedBy = ""): string => {
      if (!state) return "";
      let out = ` id="${escapeHtml(idOf(name))}"`;
      if (hasError(name)) {
        const ids = [describedBy, errorId(name)].filter(Boolean).join(" ");
        out += ` aria-invalid="true" aria-describedby="${escapeHtml(ids)}"`;
      } else if (describedBy) {
        out += ` aria-describedby="${escapeHtml(describedBy)}"`;
      }
      return out;
    },
    error: (name): string =>
      state && hasError(name)
        ? `<p class="kb-field__error" id="${escapeHtml(errorId(name))}">${escapeHtml(state.errors[name])}</p>`
        : "",
    open: () => (state ? " open" : ""),
  };
}
