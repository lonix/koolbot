/**
 * The "End event now" form (#1193) of the admin Events list, and the host
 * panel's End section (#1518), which asks in the shared confirm Dialog instead.
 *
 * The admin form's confirmation is a required checkbox that the server checks again
 * (`confirm` must be `"1"`), so it holds without JavaScript and cannot be
 * skipped by posting the form directly. Everyone in a group channel is always
 * moved back to the main channel first (#1441), so there is no option for it;
 * the form only says so when the event has group channels.
 */

import { confirmListAttr, escapeHtml } from "./html.js";

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

/**
 * What ending an event does, one consequence per line, for the confirm Dialog
 * (`data-confirm-list`, #1518). Exported so the admin Events list can use the
 * same words when its *End now* moves to the Dialog.
 */
export function endEventItems(
  hasGroupChannels: boolean,
  adopted = false,
): string[] {
  return [
    "The event's reminders and host actions stop.",
    ...(hasGroupChannels
      ? [
          "Everyone in a group channel is moved back to the main channel first.",
          "The group channels are then removed, and any group leaders are cleared.",
        ]
      : []),
    "The main channel is removed after the usual grace period, once it is empty.",
    adopted
      ? "KoolBot stops tracking the Discord event; the Discord event is left as it is."
      : "The Discord event is closed.",
    "This cannot be undone.",
  ];
}

/**
 * The body of the host panel's End the event panel: the form for a running
 * event, else why not. The form opens the shared confirm Dialog
 * (`data-confirm`, `CONFIRM_SCRIPT`), which lists `endEventItems`; the submit
 * button carries `confirm=1`, so confirming in the Dialog posts what the server
 * checks. Without JavaScript there is no Dialog, so a `noscript` block shows the
 * same consequences and a required checkbox that must be ticked
 * before the form can be posted (the box has no name, so only the button sends
 * `confirm=1`; two values would reach the server as an array and be refused); the server's check stays either way.
 */
export function renderEndSection(opts: {
  state: string;
  actionPath: string;
  csrfToken: string;
  hasGroupChannels: boolean;
  adopted?: boolean;
}): string {
  if (opts.state !== "active") {
    return `<p class="kb-muted">Only a running event can be ended. This one has not started yet; it can be ended once it has.</p>`;
  }
  const items = endEventItems(opts.hasGroupChannels, opts.adopted === true);
  return `<p class="kb-muted">Ends the event for everyone and tidies up its channels. You are asked to confirm first.</p>
<form method="POST" action="${escapeHtml(opts.actionPath)}" class="end-event-form" data-confirm="End this event now?"${confirmListAttr(items)}>
<input type="hidden" name="_csrf" value="${escapeHtml(opts.csrfToken)}">
<noscript><p>Ending the event does this:</p><ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul><p><label><input type="checkbox" required> I want to end this event now</label></p></noscript>
<button type="submit" class="kb-btn kb-btn--danger" name="${END_CONFIRM_FIELD}" value="1">End event now</button>
</form>`;
}
