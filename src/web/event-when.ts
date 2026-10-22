/**
 * The create form's "When" choice (#1305), shared by the admin form, the host's
 * `New event` page and the create pipeline. A leaf module (no server imports)
 * so the view modules can use it without a cycle.
 */

import { scriptTag } from "./html.js";

/**
 * The form's "When" choice (#1305). `now` starts the event at once, the minute
 * options are planned events that start that long from now, and `pick` (the
 * default, so nothing changes for planned events) reads the date and time.
 */
export const EVENT_WHEN_CHOICES = ["now", "15", "30", "60", "pick"] as const;
export type EventWhen = (typeof EVENT_WHEN_CHOICES)[number];

/** Label of each choice, as the form shows it. */
export const EVENT_WHEN_LABELS: Record<EventWhen, string> = {
  now: "Now",
  "15": "In 15 min",
  "30": "In 30 min",
  "60": "In 1 hour",
  pick: "Pick date & time",
};

/** The posted choice; empty means `pick`, anything unknown is null (refused). */
export function parseEventWhen(raw: string): EventWhen | null {
  if (raw === "") return "pick";
  return (EVENT_WHEN_CHOICES as readonly string[]).includes(raw)
    ? (raw as EventWhen)
    : null;
}

/** Start of a "In N min" choice, or null for `now` and `pick` (see `createImpromptuEvent`). */
export function plannedStartFor(when: EventWhen, now: Date): Date | null {
  if (when === "now" || when === "pick") return null;
  return new Date(now.getTime() + Number(when) * 60_000);
}

/**
 * Hides the date and time fields unless "Pick date & time" is chosen, and makes
 * them required only then. Without scripts every field shows and the server
 * decides from the choice (a missing date or time is refused for a pick).
 */
export const EVENT_WHEN_SCRIPT = scriptTag(
  "(function(){" +
    "var form=document.querySelector('form[data-event-form]');" +
    "if(!form)return;" +
    "var picks=form.querySelectorAll('[data-when-pick]');" +
    "function val(){var w=form.elements['when'];return w?String(w.value||'pick'):'pick'}" +
    "function sync(){var pick=val()==='pick';" +
    "Array.prototype.forEach.call(picks,function(p){p.hidden=!pick;" +
    "Array.prototype.forEach.call(p.querySelectorAll('input[name=date],input[name=time]'),function(i){i.required=pick})})}" +
    "form.addEventListener('change',function(e){if(e.target&&e.target.name==='when')sync()});" +
    "sync()})();",
);
