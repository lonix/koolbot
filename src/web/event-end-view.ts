/**
 * The "End event now" form (#1193), shared by the host panel's End section and
 * the admin Events list so both say and post the same thing.
 *
 * The confirmation is a required checkbox that the server checks again
 * (`confirm` must be `"1"`), so it holds without JavaScript and cannot be
 * skipped by posting the form directly. Everyone in a group channel is always
 * moved back to the main channel first (#1441), so there is no option for it;
 * the form only says so when the event has group channels.
 */

import { escapeHtml } from "./html.js";

/** Form field names, shared with the two routes that read them. */
export const END_CONFIRM_FIELD = "confirm";

export interface EndFormOptions {
  /** URL the form posts to. */
  actionPath: string;
  csrfToken: string;
  /** Distinguishes the ids of several forms on one page. */
  idSuffix: string;
  /** The event has group channels: the text says they are emptied and removed. */
  hasGroupChannels: boolean;
  /**
   * An adopted Discord event (#1177) is one KoolBot never wrote: ending only
   * releases KoolBot's link to it, the Discord event is left as it is.
   */
  adopted?: boolean;
}

export function renderEndEventForm(opts: EndFormOptions): string {
  const id = `end-${escapeHtml(opts.idSuffix)}`;
  return `<form method="POST" action="${escapeHtml(opts.actionPath)}" class="end-event-form" aria-describedby="${id}-what">
<input type="hidden" name="_csrf" value="${escapeHtml(opts.csrfToken)}">
<p id="${id}-what">Ending the event now stops its reminders and host actions. ${
    opts.hasGroupChannels
      ? "Everyone in a group channel is moved back to the main channel first, the group channels are then removed, and any group leaders are cleared. "
      : ""
  }The main channel is removed after the usual grace period, once it is empty, and ${
    opts.adopted === true
      ? "KoolBot stops tracking the Discord event; the Discord event is left as it is"
      : "the Discord event is closed"
  }. This cannot be undone.</p>
<p><label><input type="checkbox" name="${END_CONFIRM_FIELD}" value="1" required> I want to end this event now</label></p>
<button type="submit" class="btn btn-danger">End event now</button>
</form>`;
}

/** The End section for a host panel: the form for a running event, else why not. */
export function renderEndSection(opts: {
  state: string;
  actionPath: string;
  csrfToken: string;
  hasGroupChannels: boolean;
  adopted?: boolean;
}): string {
  if (opts.state !== "active") {
    return `<p class="muted">Only a running event can be ended. This one has not started yet; it can be ended once it has.</p>`;
  }
  return renderEndEventForm({
    actionPath: opts.actionPath,
    csrfToken: opts.csrfToken,
    idSuffix: "host",
    hasGroupChannels: opts.hasGroupChannels,
    adopted: opts.adopted,
  });
}
