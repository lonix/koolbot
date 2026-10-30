/**
 * Renders the admin New event page (#1527) from the props the Schedule form
 * used to take on the Events page, so the tests of the Groups section, the
 * When script and the permission notes keep checking what ships.
 */
import { EVENT_GROUP_PRESETS } from "../../src/content/event-group-presets.js";
import { resolveGroupCountLimits } from "../../src/services/event-groups.js";
import { renderAdminNewEventPage } from "../../src/web/admin-new-event-page.js";
import type { NewEventViewProps } from "../../src/web/event-new-view.js";
import type { PermissionNotice } from "../../src/web/permission-notice.js";

export interface NewEventTestProps {
  csrfToken?: string;
  remainingMs?: number;
  enabled?: boolean;
  timezone?: string;
  groupLimits?: {
    defaultCount: number;
    maxCount: number;
    wording?: { group: string; leader: string };
  };
  groupPresets?: NewEventViewProps["groupPresets"];
  groupPresetsNotice?: string | null;
  groupRemembered?: NewEventViewProps["groupRemembered"];
  permissionNotice?: PermissionNotice | null;
  setupNotice?: string | null;
  [extra: string]: unknown;
}

export function renderAdminNewEvent(props: NewEventTestProps = {}): string {
  const csrfToken = props.csrfToken ?? "csrf";
  return renderAdminNewEventPage({
    csrfToken,
    remainingMs: props.remainingMs ?? 60_000,
    enabled: props.enabled ?? true,
    form: {
      csrfToken,
      timezone: props.timezone ?? "UTC",
      defaultDurationMinutes: 120,
      // Clamped as the route clamps what it reads from the config.
      groupLimits: {
        ...resolveGroupCountLimits(
          props.groupLimits?.defaultCount ?? 2,
          props.groupLimits?.maxCount ?? 15,
        ),
        ...(props.groupLimits?.wording
          ? { wording: props.groupLimits.wording }
          : {}),
      },
      groupPresets: props.groupPresets ?? EVENT_GROUP_PRESETS,
      groupPresetsNotice: props.groupPresetsNotice ?? null,
      groupRemembered: props.groupRemembered ?? null,
      permissionNotice: props.permissionNotice ?? null,
      setupNotice: props.setupNotice ?? null,
    },
  });
}
