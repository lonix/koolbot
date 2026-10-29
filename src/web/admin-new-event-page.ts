/**
 * `/admin/events/new` (#1527): an admin schedules an event with the same New
 * event form an event host uses (`renderNewEventBody`), inside the admin
 * layout. What differs is passed in, not forked: Repeat is shown, the form posts
 * to `POST /admin/events/create`, the blank timezone means the server zone, and
 * the permission and setup notes link to the admin pages that fix them.
 *
 * The page is its own page, not a card on the Events list: the form brings its
 * own page header, and a refused post is drawn on it again (422) with the field
 * marked and everything typed put back, Groups included.
 */

import { renderAdminPage, type NavFeatureStatus } from "./admin-layout.js";
import { renderFlash, type FlashMessage } from "./admin-views.js";
import {
  renderNewEventBody,
  type NewEventValues,
  type NewEventViewProps,
} from "./event-new-view.js";
import {
  isEventFormField,
  type EventFormRefusal,
} from "./event-field-errors.js";
import type { RefusedForm } from "./form-errors.js";
import { groupPrefillFromPost, valuesFromPost } from "./event-new-posted.js";
import { parseEventWhen, type EventWhen } from "./event-when.js";
import type { GroupFormPrefill } from "../services/event-last-setup-service.js";

export const ADMIN_NEW_EVENT_PATH = "/admin/events/new";

/** Form id of the refused New event form: the prefix of its error line ids (`new-event-title-error`). */
export const ADMIN_NEW_EVENT_FORM = "new-event";

// Switching Events on is the Events page's job (its callout has the button); this
// page only says why a created event would be refused.
const DISABLED_CALLOUT =
  '<div class="kb-callout kb-callout--warn" role="status"><div class="kb-callout__body"><p class="kb-callout__title">The Events feature is off.</p><p class="kb-callout__text">Events cannot be created until it is on. <a href="/admin/events">Turn it on from the Events page</a>.</p></div></div>';

export interface AdminNewEventProps {
  /** Everything the shared form takes; the admin differences are filled in here. */
  form: Omit<
    NewEventViewProps,
    | "formAction"
    | "presetsHref"
    | "allowRecurrence"
    | "timezoneBlank"
    | "setupHelp"
    | "canLinkToPermissions"
  >;
  enabled: boolean;
  csrfToken: string;
  remainingMs: number;
  navFeatureStatus?: NavFeatureStatus;
  flash?: FlashMessage | null;
}

export function renderAdminNewEventPage(props: AdminNewEventProps): string {
  const body = `<p><a href="/admin/events">Back to Events</a></p>
${renderFlash(props.flash)}${props.enabled ? "" : DISABLED_CALLOUT}
${renderNewEventBody({
  ...props.form,
  formAction: "/admin/events/create",
  presetsHref: "/admin/events/presets",
  allowRecurrence: true,
  timezoneBlank: true,
  canLinkToPermissions: true,
  setupHelp: {
    text: "Finish the setup on the Events page.",
    href: "/admin/events",
  },
})}
`;
  return renderAdminPage({
    title: "New event",
    active: "/admin/events",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
    navFeatureStatus: props.navFeatureStatus,
  });
}

/**
 * A refused post, read back into what the form shows: the first error as the
 * refusal (a key that is not a form field, such as `form`, is a message with no
 * field and becomes the page's callout), the typed text, the When choice and
 * the Groups rows as posted (#1531, #1527).
 */
export function refusedNewEventForm(
  refused: RefusedForm,
  timezone: string,
  defaultDuration: number,
): {
  refusal: EventFormRefusal;
  values: NewEventValues;
  initialWhen: EventWhen;
  groups: { prefill: GroupFormPrefill; enabled: boolean };
} {
  const [key, message] = Object.entries(refused.errors)[0] ?? ["form", ""];
  return {
    refusal: { message, ...(isEventFormField(key) ? { field: key } : {}) },
    values: valuesFromPost(refused.values, timezone, defaultDuration),
    initialWhen: parseEventWhen(refused.values.when ?? "") ?? "pick",
    groups: groupPrefillFromPost(refused.values),
  };
}
