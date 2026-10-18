/**
 * The "End event now" form (#1193), shared by the host panel's End section and
 * the admin Events list so both say and post the same thing.
 *
 * The confirmation is a required checkbox that the server checks again
 * (`confirm` must be `"1"`), so it holds without JavaScript and cannot be
 * skipped by posting the form directly. The pull-back checkbox is on by
 * default and only offered when the event has group channels.
 */

import { escapeHtml } from "./html.js";

/** Form field names, shared with the two routes that read them. */
export const END_CONFIRM_FIELD = "confirm";
export const END_PULL_BACK_FIELD = "pullBack";

export interface EndFormOptions {
  /** URL the form posts to. */
  actionPath: string;
  csrfToken: string;
  /** Distinguishes the ids of several forms on one page. */
  idSuffix: string;
  /** Offer "move everyone back to the main channel first". */
  offerPullBack: boolean;
}

export function renderEndEventForm(opts: EndFormOptions): string {
  const id = `end-${escapeHtml(opts.idSuffix)}`;
  const pull = opts.offerPullBack
    ? `<p><label><input type="checkbox" name="${END_PULL_BACK_FIELD}" value="1" checked> Move everyone in the group channels back to the main channel first</label></p>`
    : "";
  return `<form method="POST" action="${escapeHtml(opts.actionPath)}" class="end-event-form" aria-describedby="${id}-what">
<input type="hidden" name="_csrf" value="${escapeHtml(opts.csrfToken)}">
<p id="${id}-what">Ending the event now stops its reminders and host actions. ${
    opts.offerPullBack
      ? "Group channels are removed as soon as they are empty, and any group leaders are cleared. "
      : ""
  }The main channel is removed after the usual grace period, once it is empty, and the Discord event is closed. This cannot be undone.</p>
${pull}<p><label><input type="checkbox" name="${END_CONFIRM_FIELD}" value="1" required> I want to end this event now</label></p>
<button type="submit" class="btn btn-danger">End event now</button>
</form>`;
}

/** The End section for a host panel: the form for a running event, else why not. */
export function renderEndSection(opts: {
  state: string;
  actionPath: string;
  csrfToken: string;
  offerPullBack: boolean;
}): string {
  if (opts.state !== "active") {
    return `<p class="muted">Only a running event can be ended. This one has not started yet; it can be ended once it has.</p>`;
  }
  return renderEndEventForm({
    actionPath: opts.actionPath,
    csrfToken: opts.csrfToken,
    idSuffix: "host",
    offerPullBack: opts.offerPullBack,
  });
}
