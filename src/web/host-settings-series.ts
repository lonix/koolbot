/**
 * The tick "also for the next occurrences" of the host panel's settings forms
 * (#1266). It is the control of the `seriesSetup` live-edit row
 * (`services/event-live-edit-series.ts`): ticked, the save also stores the
 * event's group setup as the setup of every following occurrence; unticked (the
 * default) a change applies to this occurrence only. Shown only for an event
 * that repeats.
 */

import { baseField, valueField } from "../services/event-live-edit.js";
import { SERIES_SETUP_ROW_ID } from "../services/event-live-edit-series.js";
import { renderMore } from "./host-settings-rows.js";

/** The tick and the base value the form showed (the row is always shown as off). */
export function renderSeriesTick(show: boolean | undefined): string {
  if (!show) return "";
  return `<div class="kb-groupopt"><label class="kb-switch"><input type="checkbox" role="switch" name="${valueField(SERIES_SETUP_ROW_ID)}" value="1"><span class="kb-switch__track" aria-hidden="true"></span><span class="kb-switch__state" aria-hidden="true"></span>Also for the next occurrences</label>
<input type="hidden" name="${baseField(SERIES_SETUP_ROW_ID)}" value="0">
<p class="kb-help">The following occurrences start with this event's groups after this save, and its leader and tag settings.</p>
${renderMore("Names, sizes, kinds, tags, labels, leader and tag settings, and whether groups are on, are carried over until you change them again. People, leaders and channels are never carried over, and a name or tag a leader chose is not either: the next occurrence gets your names. The lock always starts off. Unticked, this change is for this occurrence only.")}</div>`;
}
