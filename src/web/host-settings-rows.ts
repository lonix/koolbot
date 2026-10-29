/**
 * The setting rows of the host panel's "Event settings" form (#1514): the
 * SettingRow markup shared by its parts, and the one step that turns what the
 * form posts into what `parseSubmission` reads.
 *
 * A switch posts `s_<row>=1` while checked and nothing while unchecked, but the
 * live-edit parsers accept only `"1"` or `"0"` (an absent value means the row is
 * untouched). So every switch also carries the value it showed (`b_<row>`), and
 * `prepareSettingsBody` reads "base posted, value not" as an explicit "0". A
 * form without the base (the group forms post to the same action) leaves the
 * row alone. Everything dynamic goes through `escapeHtml`.
 */

import { escapeHtml } from "./html.js";
import { icon } from "./icons.js";
import { renderSwitch } from "./setting-controls.js";
import { pickPreset } from "./setting-pickers.js";
import { baseField, valueField } from "../services/event-live-edit.js";

/** The rows of the form that are switches (the posted value is `"1"` or `"0"`). */
export const SWITCH_ROW_IDS = [
  "captainsEnabled",
  "captainCustomisationEnabled",
  "captainsLobby",
  "tagsEnabled",
] as const;

/** The lead time row and the radio group of its presets. */
export const LEAD_ROW_ID = "channelLeadMinutes";
export const LEAD_PRESET_FIELD = "preset_channelLeadMinutes";
/** Presets of the channel lead time, in minutes (0 to 1440 stays the bound). */
export const LEAD_PRESETS: readonly number[] = [0, 5, 10, 15, 30, 60, 120];

export function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

/** The inline "More" of a row: what happens without a confirmation, behind a summary. */
export function renderMore(text: string): string {
  if (!text) return "";
  return `<details class="kb-disclosure kb-disclosure--inline"><summary>${icon("chevron-right", { className: "kb-chev" })}More</summary><div class="kb-disclosure__body"><p>${escapeHtml(text)}</p></div></details>`;
}

export interface SettingRowOptions {
  /** Id prefix: the name and the line get `<id>-name` and `<id>-desc`. */
  id: string;
  name: string;
  /** The one line under the name. */
  line: string;
  /** The control (its markup names the row through `<id>-name`). */
  control: string;
  /** The rest, behind More. */
  more?: string;
  /** Hidden fields (the shown values), placed in the row. */
  fields?: string;
  /** Child rows, nested under this one. */
  nested?: string;
  /** The name is a label for this control id (a text input), not a heading. */
  labelFor?: string;
}

/** One SettingRow: name and line left, control right, More and children below. */
export function renderSettingRow(o: SettingRowOptions): string {
  const nameId = `${o.id}-name`;
  const name = escapeHtml(o.name);
  const nameHtml = o.labelFor
    ? `<p class="kb-setting__name"><label id="${escapeHtml(nameId)}" for="${escapeHtml(o.labelFor)}">${name}</label></p>`
    : `<p class="kb-setting__name" id="${escapeHtml(nameId)}">${name}</p>`;
  const extra = `${o.fields ?? ""}${renderMore(o.more ?? "")}${o.nested ? `<div class="kb-nested">${o.nested}</div>` : ""}`;
  return `<div class="kb-setting">
<div>${nameHtml}<p class="kb-setting__desc" id="${escapeHtml(o.id)}-desc">${escapeHtml(o.line)}</p></div>
<div class="kb-setting__control">${o.control}</div>${extra ? `\n<div class="kb-setting__extra">${extra}</div>` : ""}
</div>`;
}

/** A switch row of the live-edit form: posts `"1"` while on, with the value it showed. */
export function renderSwitchRow(
  rowId: string,
  label: string,
  on: boolean,
  text: { line: string; more?: string },
  nested?: string,
): string {
  const id = `host-settings-${rowId}`;
  return renderSettingRow({
    id,
    name: label,
    line: text.line,
    more: text.more,
    nested,
    fields: hidden(baseField(rowId), on ? "1" : "0"),
    control: renderSwitch(valueField(rowId), on, {
      id: `${id}-input`,
      labelledBy: `${id}-name`,
      describedBy: `${id}-desc`,
      onValue: "1",
    }),
  });
}

type Body = Record<string, unknown>;

/**
 * The posted form as `parseSubmission` reads it:
 * - a switch row whose shown value (`b_`) came back without a value (`s_`) was
 *   switched off, so it is posted as `"0"`;
 * - the lead time's preset choice (`preset_channelLeadMinutes`) wins over the
 *   box: "default" is an empty value, a listed preset is its number, anything
 *   else ("custom", no radio, a crafted value) means the box.
 */
export function prepareSettingsBody(body: unknown): Body {
  const source: Body = { ...((body ?? {}) as Body) };
  for (const id of SWITCH_ROW_IDS) {
    if (
      typeof source[baseField(id)] === "string" &&
      typeof source[valueField(id)] !== "string"
    ) {
      source[valueField(id)] = "0";
    }
  }
  const choice = source[LEAD_PRESET_FIELD];
  delete source[LEAD_PRESET_FIELD];
  if (typeof source[baseField(LEAD_ROW_ID)] === "string") {
    if (choice === "default") {
      source[valueField(LEAD_ROW_ID)] = "";
    } else {
      const preset = pickPreset(choice, LEAD_PRESETS);
      if (preset !== null) source[valueField(LEAD_ROW_ID)] = preset;
    }
  }
  return source;
}
