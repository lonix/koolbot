import { describe, it, expect } from "@jest/globals";
import { renderEventsPage } from "../../src/web/admin-views.js";

const COMMON = {
  csrfToken: "csrf-tok",
  remainingMs: 60_000,
  categoryConfigured: true,
  announcementConfigured: true,
  timezone: "UTC",
  settingRows: [],
  enabled: true,
};

const EDIT = 'href="/me/events/e1/host/edit"';

function page(extra: Record<string, unknown>): string {
  return renderEventsPage({
    ...COMMON,
    rows: [
      {
        id: "e1",
        title: "Quiz",
        when: "2030-01-01 20:00 (UTC)",
        state: "scheduled",
        channelId: null,
        ...extra,
      },
    ],
  } as never);
}

describe("the Edit link on the admin Events page (#1298)", () => {
  it("is offered for an upcoming one-off event, and for a running one", () => {
    expect(page({})).toContain(EDIT);
    expect(page({ state: "active" })).toContain(EDIT);
  });

  it.each([
    ["an ended event", { state: "ended" }],
    ["a cancelled event", { state: "cancelled" }],
    ["a recurring event", { recurrence: "weekly" }],
    ["an adopted event", { nativeAdopted: true }],
  ])("is not offered for %s", (_n, extra) => {
    expect(page(extra)).not.toContain(EDIT);
  });
});
