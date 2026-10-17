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

function row(extra: Record<string, unknown>) {
  return {
    id: "e1",
    title: "Game <b>Night</b>",
    when: "2026-07-04 20:00 (UTC)",
    state: "scheduled",
    channelId: null,
    ...extra,
  };
}

describe("renderEventsPage cover image column (#1181)", () => {
  it("offers an upload for an event without a cover, and no remove button", () => {
    const html = renderEventsPage({
      ...COMMON,
      rows: [
        row({ cover: { kind: "editable", hasCover: false, series: false } }),
      ],
    } as never);
    expect(html).toContain('action="/admin/events/e1/cover"');
    expect(html).toContain(
      '<form method="POST" action="/admin/events/e1/cover"',
    );
    expect(html).toContain("Upload cover");
    expect(html).not.toContain("/cover/remove");
    expect(html).toContain("PNG, JPEG or GIF, up to 2 MB");
  });

  it("offers replace and remove for an event with a cover, noting series scope", () => {
    const html = renderEventsPage({
      ...COMMON,
      rows: [
        row({ cover: { kind: "editable", hasCover: true, series: true } }),
      ],
    } as never);
    expect(html).toContain("Replace cover");
    expect(html).toContain('action="/admin/events/e1/cover/remove"');
    expect(html).toContain("every occurrence of the series");
  });

  it("explains why an adopted event has no control", () => {
    const html = renderEventsPage({
      ...COMMON,
      rows: [row({ cover: { kind: "adopted" } })],
    } as never);
    expect(html).toContain("Managed in Discord");
    expect(html).not.toContain('/admin/events/e1/cover"');
    expect(html).not.toContain("/cover");
  });

  it("explains that a detached event cannot take a cover", () => {
    const html = renderEventsPage({
      ...COMMON,
      rows: [row({ cover: { kind: "detached" } })],
    } as never);
    expect(html).toContain("deleted from Discord");
    expect(html).not.toContain('/admin/events/e1/cover"');
  });

  it("shows nothing for a finished event and escapes titles", () => {
    const html = renderEventsPage({
      ...COMMON,
      rows: [row({ state: "ended", cover: null })],
    } as never);
    expect(html).not.toContain('/admin/events/e1/cover"');
    expect(html).not.toContain("<b>Night</b>");
  });
});
