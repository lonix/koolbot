/**
 * @jest-environment <rootDir>/__tests__/jsdom-node-env.cjs
 */
/* global DOMParser */
/**
 * The event host pages render only kb- components (#1709, part of #1639):
 * the host panel's settings, result and confirmation bodies, the End section,
 * the admin End form and "Your events".
 */
import { describe, expect, it } from "@jest/globals";
import {
  renderConfirmBody,
  renderEventSettings,
  renderGroupChanges,
  renderResultBody,
  type SettingsViewData,
} from "../../src/web/host-settings-view.js";
import {
  renderEndEventForm,
  renderEndSection,
} from "../../src/web/event-end-view.js";
import { renderHostEventsPage } from "../../src/web/me-events-page.js";

const settings = (over: Partial<SettingsViewData> = {}): SettingsViewData => ({
  csrfToken: "csrf",
  actionPath: (n) => `/me/events/e1/host/${n}`,
  blocker: null,
  leadMinutes: 30,
  leadReadOnly: "The channels already exist.",
  groupLabel: "Team",
  groups: [
    {
      name: "Red",
      marker: "",
      size: 2,
      memberCount: 3,
      overSize: true,
    },
    { name: "Blue", marker: "", size: null, memberCount: 0, overSize: false },
  ],
  leaderExtras: { leaderLabel: "Leader", edits: [] },
  ...over,
});

const row = {
  id: "65a000000000000000000001",
  title: "Quiz night",
  when: "Fri 20:00",
  state: "scheduled",
  durationMinutes: 60,
  running: false,
  editable: true,
  recurring: false,
};

const PAGES: { name: string; html: string }[] = [
  { name: "settings", html: renderEventSettings(settings()) },
  {
    name: "settings blocked",
    html: renderEventSettings(settings({ blocker: "Events are off." })),
  },
  {
    name: "group changes, read-only table",
    html: renderGroupChanges(settings()),
  },
  {
    name: "group changes blocked",
    html: renderGroupChanges(settings({ blocker: "Events are off." })),
  },
  {
    name: "result",
    html: renderResultBody({ ok: true, message: "Saved.", panelPath: "/p" }),
  },
  {
    name: "result with something left",
    html: renderResultBody({
      ok: false,
      message: "Saved. One channel is left.",
      panelPath: "/p",
    }),
  },
  {
    name: "confirmation",
    html: renderConfirmBody({
      csrfToken: "csrf",
      actionPath: "/p/settings-confirm",
      panelPath: "/p",
      token: "t",
      reasons: ["Because."],
      changes: [{ label: "Groups", from: "on", to: "off" }],
    }),
  },
  {
    name: "end section",
    html: renderEndSection({
      state: "active",
      actionPath: "/p/end",
      csrfToken: "csrf",
      hasGroupChannels: true,
    }),
  },
  {
    name: "admin end form",
    html: renderEndEventForm({
      actionPath: "/p/end",
      csrfToken: "csrf",
      idSuffix: "1",
      hasGroupChannels: false,
    }),
  },
  {
    name: "your events",
    html: renderHostEventsPage({
      csrfToken: "csrf",
      eventsEnabled: true,
      events: { live: [], upcoming: [row], past: [{ ...row, state: "ended" }] },
    }),
  },
];

const OLD_CLASSES = [
  "card",
  "notice",
  "btn",
  "btn-primary",
  "btn-secondary",
  "btn-danger",
  "btn-sm",
  "empty",
  "helper",
  "muted",
  "stack",
  "tag",
  "tag-on",
  "tag-off",
  "tag-info",
  "tag-warn",
  "end-event-form",
];

describe("event host pages on the kb- components (#1709)", () => {
  it.each(PAGES)("$name renders no old class", ({ html }) => {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const found = new Set<string>();
    doc.querySelectorAll("[class]").forEach((el) => {
      el.classList.forEach((c) => {
        if (OLD_CLASSES.includes(c)) found.add(c);
      });
    });
    expect([...found]).toEqual([]);
  });

  it("keeps what the confirmation fetch reads", () => {
    const doc = new DOMParser().parseFromString(
      PAGES.find((p) => p.name === "confirmation")!.html,
      "text/html",
    );
    expect(doc.querySelector("[data-confirm-page]")).not.toBeNull();
    expect(doc.querySelector("h2")?.textContent).toBe("Confirm these changes");
    expect(doc.querySelectorAll("[data-confirm-reasons] li")).toHaveLength(1);
    expect(doc.querySelectorAll("[data-confirm-changes] li")).toHaveLength(1);
    expect(
      doc.querySelectorAll("form[data-confirm-form] input[name]"),
    ).toHaveLength(2);
  });
});
