import { describe, it, expect } from "@jest/globals";
import { JSDOM } from "jsdom";
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

const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Event ${id}`,
  when: "2030-01-01 20:00 (UTC)",
  state: "scheduled",
  channelId: null,
  ...extra,
});

function doc(rows: unknown[]) {
  return new JSDOM(renderEventsPage({ ...COMMON, rows } as never)).window
    .document;
}

const titles = (d: ReturnType<typeof doc>, sel: string): string[] =>
  Array.from(d.querySelectorAll(`${sel} tbody tr td:first-child`)).map((c) =>
    (c.textContent ?? "").trim(),
  );

describe("Events page header and sections (#1525)", () => {
  it("opens with a PageHeader holding the title, one sentence, the status line and the actions", () => {
    const d = doc([]);
    const head = d.querySelector("header.kb-pagehead");
    expect(head).not.toBeNull();
    expect(head?.querySelector("h1.kb-pagehead__title")?.textContent).toBe(
      "Events",
    );
    expect(d.querySelectorAll("h1")).toHaveLength(1);
    expect(d.querySelector("p.subtitle")).toBeNull();
    expect(head?.querySelector(".kb-pagehead__sub")?.textContent).toMatch(
      /\.$/,
    );
    expect(
      head?.querySelector(".kb-pagehead__text .kb-statusline"),
    ).not.toBeNull();
    const actions = Array.from(
      head?.querySelectorAll(".kb-pagehead__actions a") ?? [],
    );
    expect(actions.map((a) => a.textContent?.trim())).toEqual([
      "Start now",
      "Schedule event",
    ]);
    expect(actions.map((a) => a.getAttribute("href"))).toEqual([
      "/admin/events/new?when=now",
      "/admin/events/new",
    ]);
    // At most one primary button, and it goes last.
    expect(head?.querySelectorAll(".kb-btn--primary")).toHaveLength(1);
    expect(actions[1].classList.contains("kb-btn--primary")).toBe(true);
  });

  it("puts a running event in Live now and the rest in Upcoming", () => {
    const d = doc([
      row("live", { state: "active", running: true }),
      row("soon", { state: "scheduled" }),
      row("early", { state: "active", running: false }),
    ]);
    expect(titles(d, "#live-events")).toEqual(["Event live"]);
    expect(titles(d, "#upcoming-events")).toEqual([
      "Event soon",
      "Event early",
    ]);
    expect(d.querySelector("#live-events .kb-panel__meta")?.textContent).toBe(
      "1",
    );
    expect(
      d.querySelector("#upcoming-events .kb-panel__meta")?.textContent,
    ).toBe("2");
    // The prepared-early event keeps End now and is called Planned, not Live.
    const early = Array.from(
      d.querySelectorAll("#upcoming-events tbody tr"),
    ).find((r) => r.textContent?.includes("Event early"));
    expect(early?.querySelector(".end-now")).not.toBeNull();
    expect(early?.querySelector(".kb-badge")?.textContent).toBe("Planned");
    expect(d.querySelector("#live-events tbody .kb-badge")?.textContent).toBe(
      "Live",
    );
  });

  it("keeps the row actions where they apply", () => {
    const d = doc([
      row("live", { state: "active", running: true }),
      row("soon"),
    ]);
    const live = d.querySelector("#live-events tbody tr");
    expect(live?.textContent).toContain("Host panel");
    expect(live?.textContent).toContain("End now");
    const soon = d.querySelector("#upcoming-events tbody tr");
    expect(soon?.textContent).toContain("Edit");
    expect(soon?.textContent).toContain("Start now");
    expect(soon?.textContent).toContain("Cancel");
    expect(soon?.querySelector(".end-now")).toBeNull();
  });

  it("says how Start now works when nothing is live, and keeps empty states apart", () => {
    const none = doc([]);
    expect(none.querySelector("#live-events")?.textContent).toContain(
      "Nothing is running",
    );
    expect(none.querySelector("#upcoming-events")?.textContent).toContain(
      "No events scheduled yet.",
    );
    expect(none.querySelector("#live-events table")).toBeNull();

    const onlyLive = doc([row("l", { state: "active", running: true })]);
    expect(onlyLive.querySelector("#upcoming-events")?.textContent).toContain(
      "No upcoming events.",
    );
    expect(onlyLive.querySelector("#live-events table")).not.toBeNull();
  });

  it("applies the empty-column rule per section", () => {
    const d = doc([
      row("live", { state: "active", running: true, channelId: "c1" }),
      row("soon"),
    ]);
    expect(d.querySelector("#live-events thead")?.textContent).toContain(
      "Channel",
    );
    expect(
      d.querySelector("#upcoming-events thead")?.textContent,
    ).not.toContain("Channel");
  });

  it("folds past events with a count and keeps a finished occurrence awaiting its successor in Upcoming", () => {
    const d = doc([
      row("old", { state: "ended" }),
      row("gone", { state: "cancelled" }),
      row("wait", {
        state: "ended",
        recurrence: "weekly",
        awaitingSuccessor: true,
      }),
    ]);
    expect(titles(d, "#past-events")).toEqual(["Event old", "Event gone"]);
    expect(d.querySelector("#past-events summary")?.textContent).toContain("2");
    expect(titles(d, "#upcoming-events").join()).toContain("Event wait");
    expect(d.querySelector("#live-events table")).toBeNull();
  });

  it("never lists a stale running flag on a finished event as live", () => {
    const d = doc([row("x", { state: "ended", running: true })]);
    expect(d.querySelector("#live-events table")).toBeNull();
    expect(titles(d, "#past-events")).toEqual(["Event x"]);
  });

  it("keeps the settings fold after the lists", () => {
    const html = renderEventsPage({
      ...COMMON,
      rows: [],
      settingRows: [
        {
          key: "events.enabled",
          label: "Events enabled",
          current: true,
          defaultValue: false,
          type: "boolean",
          description: "Enable scheduled events.",
          category: "events",
        },
      ],
    } as never);
    expect(html.indexOf('id="upcoming-events"')).toBeLessThan(
      html.indexOf('id="feature-settings"'),
    );
  });
});
