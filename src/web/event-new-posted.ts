/**
 * A refused New event post, read back into the shape the form shows (#1531,
 * #1527). Shared by the host's page (`/me/events/new`) and the admin's
 * (`/admin/events/new`) so the two put back the same fields and the same
 * Groups rows.
 */

import { parseGroupForm } from "../services/event-groups.js";
import type { GroupFormPrefill } from "../services/event-last-setup-service.js";
import type { NewEventValues } from "./event-new-view.js";

export function posted(body: Record<string, unknown>, name: string): string {
  const raw = body[name];
  return typeof raw === "string" ? raw.trim() : "";
}

/** The text fields as posted. The zone and duration fall back to the page's own when absent or unusable. */
export function valuesFromPost(
  body: Record<string, unknown>,
  timezone: string,
  defaultDuration: number,
): NewEventValues {
  const minutes = Number(posted(body, "duration"));
  return {
    date: posted(body, "date"),
    time: posted(body, "time"),
    title: posted(body, "title"),
    description: posted(body, "description"),
    durationMinutes:
      Number.isInteger(minutes) && minutes > 0 ? minutes : defaultDuration,
    timezone: posted(body, "timezone") || timezone,
    recurrence: posted(body, "recurrence"),
  };
}

/**
 * The group section as posted, in the shape the form prefills from. The values
 * are kept whether or not the Groups switch was on (`enabled` restores the
 * switch itself), and each row goes back at the position it was posted in:
 * `parseGroupForm` drops blank rows but keeps their position for messages, so
 * the gaps are refilled to make "Group 2" in a message the second row shown.
 */
export function groupPrefillFromPost(body: Record<string, unknown>): {
  prefill: GroupFormPrefill;
  enabled: boolean;
} {
  const input = parseGroupForm(body);
  const blank = { name: "", kind: "team", size: "", tag: "", marker: "" };
  const rows: GroupFormPrefill["rows"] = [];
  for (const r of input.rows) {
    while (rows.length < r.position - 1) rows.push({ ...blank });
    rows.push({
      name: r.name,
      kind: r.kind,
      size: r.size,
      tag: r.tag,
      marker: r.marker,
    });
  }
  return {
    enabled: input.enabled,
    prefill: {
      presetId: input.presetId === "custom" ? "" : input.presetId,
      groupLabel: input.groupLabel,
      leaderLabel: input.leaderLabel,
      channelLeadMinutes: input.channelLeadMinutes,
      rows,
      captainsEnabled: input.captainsEnabled === true,
      captainCustomisationEnabled: input.captainCustomisationEnabled === true,
      captainsLobby: input.captainsLobby === true,
      tagsEnabled: input.tagsEnabled === true,
      tagsSuffix: input.tagsSuffix === true,
    },
  };
}
