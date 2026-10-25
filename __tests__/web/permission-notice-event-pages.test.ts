/**
 * The permission notice (#1253) on the other event pages and next to the
 * fields it belongs to (#1478): the shared slicing and the inline form of the
 * notice, the New event form, the Edit event form, the adoption page and the
 * admin Events page. The notice logic itself is in `permission-notice.test.ts`;
 * the host panel and the first consumers are in `permission-notice-pages.test.ts`.
 */

import { describe, it, expect } from "@jest/globals";
import {
  hostEditPermissionFeatures,
  type HostPanelEvent,
} from "../../src/web/host-panel-view.js";
import { renderEventsPage } from "../../src/web/admin-views.js";
import { renderNewEventBody } from "../../src/web/event-new-view.js";
import {
  renderEventEditBody,
  type EventEditView,
} from "../../src/web/event-edit-view.js";
import { renderEventAdoptionPage } from "../../src/web/event-adoption-view.js";
import {
  partitionNotice,
  renderInlinePermissionNotice,
  splitEventFormNotice,
  EVENT_FORM_NOTICE_SLOTS,
  type PermissionNotice,
} from "../../src/web/permission-notice.js";
import { FEATURE_REQUIREMENTS } from "../../src/services/bot-permission-registry.js";
import { planned } from "./event-adoption-fixtures.js";

function ref(id: string): PermissionNotice["missing"][number]["feature"] {
  const r = FEATURE_REQUIREMENTS.find((x) => x.id === id);
  if (!r) throw new Error(id);
  return {
    id: r.id,
    area: r.area,
    feature: r.feature,
    effect: r.effect,
    fix: r.fix,
  };
}

const CATEGORY = { kind: "category", id: "c1", name: "Events" } as const;
const SERVER = { kind: "server", id: "g1", name: "Server" } as const;

const missing = (
  id: string,
  permissions: string[],
  target: PermissionNotice["missing"][number]["target"] = CATEGORY,
): PermissionNotice["missing"][number] => ({
  feature: ref(id),
  permissions,
  target,
});

function notice(over: Partial<PermissionNotice> = {}): PermissionNotice {
  return {
    unavailable: null,
    missing: [],
    unchecked: [],
    stale: false,
    ...over,
  };
}

/** One finding for every Events field, and one (the Events list card) for none. */
const everyField = notice({
  missing: [
    missing("event-native", ["Create Events"], SERVER),
    missing("event-channels", ["Manage Channels"]),
    missing("event-moves", ["Move Members"]),
    missing("event-leads-channel", ["Manage Roles"]),
  ],
  unchecked: [
    {
      feature: ref("event-tags"),
      target: SERVER,
      note: "The bot's own membership could not be read.",
    },
  ],
});

const unavailable = notice({
  unavailable: "The bot could not read this server from Discord.",
});

describe("partitionNotice", () => {
  it("gives each slot the findings of its entries and leaves the rest", () => {
    const { rest, slots } = partitionNotice(
      everyField,
      EVENT_FORM_NOTICE_SLOTS,
    );
    expect(slots.groups?.missing.map((m) => m.feature.id)).toEqual([
      "event-channels",
      "event-moves",
    ]);
    expect(slots.leaders?.missing.map((m) => m.feature.id)).toEqual([
      "event-leads-channel",
    ]);
    expect(slots.tags?.missing).toEqual([]);
    expect(slots.tags?.unchecked.map((u) => u.feature.id)).toEqual([
      "event-tags",
    ]);
    expect(rest?.missing.map((m) => m.feature.id)).toEqual(["event-native"]);
    expect(rest?.unchecked).toEqual([]);
  });

  it("loses nothing: every finding is in a slot or in the rest", () => {
    const { rest, slots } = partitionNotice(
      everyField,
      EVENT_FORM_NOTICE_SLOTS,
    );
    const all = [rest, ...Object.values(slots)].flatMap((n) => [
      ...(n?.missing.map((m) => m.feature.id) ?? []),
      ...(n?.unchecked.map((u) => u.feature.id) ?? []),
    ]);
    expect(all.sort()).toEqual(
      [
        ...everyField.missing.map((m) => m.feature.id),
        ...everyField.unchecked.map((u) => u.feature.id),
      ].sort(),
    );
  });

  it("carries the stale label to every slice", () => {
    const { rest, slots } = partitionNotice(
      { ...everyField, stale: true },
      EVENT_FORM_NOTICE_SLOTS,
    );
    expect(rest?.stale).toBe(true);
    expect(slots.groups?.stale).toBe(true);
    expect(slots.tags?.stale).toBe(true);
  });

  it("keeps a check that could not run in the rest, once", () => {
    const { rest, slots } = partitionNotice(
      unavailable,
      EVENT_FORM_NOTICE_SLOTS,
    );
    expect(rest).toEqual(unavailable);
    expect(slots).toEqual({ groups: null, leaders: null, tags: null });
  });

  it("has nothing for a page with no notice, and no rest when the slots took everything", () => {
    expect(partitionNotice(null, EVENT_FORM_NOTICE_SLOTS)).toEqual({
      rest: null,
      slots: { groups: null, leaders: null, tags: null },
    });
    const onlyChannels = notice({
      missing: [missing("event-channels", ["Manage Channels"])],
    });
    expect(partitionNotice(onlyChannels, EVENT_FORM_NOTICE_SLOTS).rest).toBe(
      null,
    );
  });
});

describe("renderInlinePermissionNotice", () => {
  const channels = notice({
    missing: [missing("event-channels", ["Manage Channels"])],
  });

  it("is empty when there is nothing to say", () => {
    expect(renderInlinePermissionNotice(null, { canLinkToPage: true })).toBe(
      "",
    );
  });

  it("names the permission and where, what stops, and links an admin to Bot permissions", () => {
    const html = renderInlinePermissionNotice(channels, {
      canLinkToPage: true,
    });
    expect(html).toContain('data-permission-inline="event-channels"');
    expect(html).toContain(
      'class="kb-chip kb-chip--warn" href="/admin/bot-permissions"',
    );
    expect(html).toContain(
      "Bot lacks Manage Channels in the category “Events”",
    );
    expect(html).toContain("are not created, deleted or put in order");
    expect(html).not.toContain("Ask a server admin");
  });

  it("gives a host who is not an admin no link", () => {
    const html = renderInlinePermissionNotice(channels, {
      canLinkToPage: false,
    });
    expect(html).toContain("Ask a server admin");
    expect(html).not.toContain("/admin/bot-permissions");
    expect(html).toContain('<span class="kb-chip kb-chip--warn">');
  });

  it("says a server-wide permission as such", () => {
    const html = renderInlinePermissionNotice(
      notice({
        missing: [missing("event-tags", ["Manage Nicknames"], SERVER)],
      }),
      { canLinkToPage: true },
    );
    expect(html).toContain("Bot lacks Manage Nicknames server-wide");
  });

  it("says a permission could not be checked, with the reason, and never that all is well", () => {
    const html = renderInlinePermissionNotice(
      notice({
        unchecked: [
          { feature: ref("event-tags"), target: SERVER, note: "Not readable." },
        ],
      }),
      { canLinkToPage: true },
    );
    expect(html).toContain("Could not be checked");
    expect(html).toContain("Not readable.");
    expect(html).not.toContain("kb-chip--warn");
    expect(html).not.toMatch(/in place|all is well/i);
  });

  it("labels a cached read on the slice itself", () => {
    const html = renderInlinePermissionNotice(
      { ...channels, stale: true },
      { canLinkToPage: true },
    );
    expect(html).toContain("cached view and may be out of date");
  });

  it("escapes what comes from Discord", () => {
    const html = renderInlinePermissionNotice(
      notice({
        missing: [
          missing("event-channels", ["Manage Channels"], {
            kind: "category",
            id: "c",
            name: "<img src=x onerror=alert(1)>",
          }),
        ],
      }),
      { canLinkToPage: true },
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("splitEventFormNotice", () => {
  it("is empty for a page with nothing to say", () => {
    expect(splitEventFormNotice(null, { canLinkToPage: true })).toEqual({
      block: "",
      inline: { groups: "", leaders: "", tags: "" },
    });
  });

  it("puts a check that could not run in the block only", () => {
    const { block, inline } = splitEventFormNotice(unavailable, {
      canLinkToPage: true,
    });
    expect(block).toContain("Bot permissions could not be checked");
    expect(inline).toEqual({ groups: "", leaders: "", tags: "" });
  });
});

describe("hostEditPermissionFeatures", () => {
  const event = (over: Partial<HostPanelEvent> = {}): HostPanelEvent => ({
    id: "1",
    title: "Quiz night",
    description: "",
    state: "scheduled",
    when: "2030-01-01 19:00 (UTC)",
    durationMinutes: 60,
    recurrence: null,
    channel: null,
    groupsEnabled: false,
    groupLabel: "Team",
    leaderLabel: "Leader",
    channelLeadMinutes: null,
    groups: [],
    adopted: false,
    ...over,
  });

  it.each([
    ["an open event", {}, ["event-native", "events-announce"]],
    [
      "a running event",
      { state: "active" },
      ["event-native", "events-announce"],
    ],
    [
      "an adopted event: no Events list card of KoolBot's own",
      { adopted: true },
      ["events-announce"],
    ],
    [
      "an open event whose Discord event was detached",
      { nativeDetached: true },
      ["events-announce"],
    ],
    ["an ended event: nothing left to change", { state: "ended" }, []],
    ["a cancelled event", { state: "cancelled" }, []],
  ] as Array<[string, Partial<HostPanelEvent>, string[]]>)(
    "%s",
    (_name, over, expected) => {
      expect(hostEditPermissionFeatures(event(over))).toEqual(expected);
    },
  );
});

describe("New event form", () => {
  const props = {
    csrfToken: "t",
    timezone: "UTC",
    defaultDurationMinutes: 120,
    groupLimits: { defaultCount: 2, maxCount: 15 },
    groupPresets: [],
    groupPresetsNotice: null,
  };

  it("is byte-for-byte what it was when there is no notice, or nothing to say", () => {
    const plain = renderNewEventBody(props);
    expect(renderNewEventBody({ ...props, permissionNotice: null })).toBe(
      plain,
    );
    expect(plain).not.toContain("data-permission");
  });

  it("shows each finding next to its field and the rest above the form", () => {
    const html = renderNewEventBody({
      ...props,
      permissionNotice: everyField,
      canLinkToPermissions: true,
    });
    // The Events list card has no field: one block above the form.
    expect(html.match(/data-permission-notice/g)).toHaveLength(1);
    expect(html.indexOf("data-permission-notice")).toBeLessThan(
      html.indexOf("<form"),
    );
    expect(html).toContain("Create Events");
    // The others sit inside the Groups section, in field order.
    const at = (marker: string): number => html.indexOf(marker);
    expect(at("groups-enabled-help")).toBeLessThan(
      at('data-permission-inline="event-channels"'),
    );
    expect(at('data-permission-inline="event-channels"')).toBeLessThan(
      at('data-permission-inline="event-moves"'),
    );
    expect(at('data-permission-inline="event-moves"')).toBeLessThan(
      at("data-groups-body"),
    );
    expect(at("groups-captains-help")).toBeLessThan(
      at('data-permission-inline="event-leads-channel"'),
    );
    expect(at("groups-tags-help")).toBeLessThan(
      at('data-permission-inline="event-tags"'),
    );
    // Said once each.
    expect(html.split("Manage Channels").length - 1).toBe(1);
    expect(html).toContain('href="/admin/bot-permissions"');
  });

  it("gives a host who is not an admin 'Ask a server admin' and no link", () => {
    const html = renderNewEventBody({ ...props, permissionNotice: everyField });
    expect(html).toContain("Ask a server admin");
    expect(html).not.toContain("/admin/bot-permissions");
  });

  it("says the check could not run, and shows no field notices", () => {
    const html = renderNewEventBody({
      ...props,
      permissionNotice: unavailable,
    });
    expect(html).toContain("Bot permissions could not be checked");
    expect(html).toContain("The bot could not read this server from Discord.");
    expect(html).not.toContain("data-permission-inline");
  });
});

describe("Edit event form", () => {
  const event: EventEditView = {
    id: "65a000000000000000000001",
    title: "Quiz night",
    description: "",
    durationMinutes: 60,
    timezone: "UTC",
    date: "2030-01-01",
    time: "19:00",
    when: "2030-01-01 19:00",
    version: "v1",
    mode: "full",
    startLocked: false,
  };
  const withNotice = notice({
    missing: [missing("event-native", ["Create Events"], SERVER)],
  });

  it("is byte-for-byte what it was when there is no notice", () => {
    const plain = renderEventEditBody({ event, csrfToken: "t" });
    expect(
      renderEventEditBody({ event, csrfToken: "t", permissionNotice: null }),
    ).toBe(plain);
    expect(plain).not.toContain("data-permission-notice");
    expect(plain).toContain("</header>\n<form");
  });

  it("shows the missing permission between the header and the form, with the link for an admin", () => {
    const html = renderEventEditBody({
      event,
      csrfToken: "t",
      permissionNotice: withNotice,
      canLinkToPermissions: true,
    });
    expect(html).toContain("Create Events");
    expect(html).toContain("server-wide");
    expect(html).toContain('href="/admin/bot-permissions"');
    expect(html.indexOf("</header>")).toBeLessThan(
      html.indexOf("data-permission-notice"),
    );
    expect(html.indexOf("data-permission-notice")).toBeLessThan(
      html.indexOf("<form"),
    );
  });

  it("gives a host who is not an admin no link", () => {
    const html = renderEventEditBody({
      event,
      csrfToken: "t",
      permissionNotice: withNotice,
    });
    expect(html).toContain("Ask a server admin");
    expect(html).not.toContain("/admin/bot-permissions");
  });

  it("says the check could not run", () => {
    const html = renderEventEditBody({
      event,
      csrfToken: "t",
      permissionNotice: unavailable,
    });
    expect(html).toContain("Bot permissions could not be checked");
  });
});

describe("Adopt Discord events page", () => {
  const props = {
    csrfToken: "t",
    remainingMs: 60_000,
    navFeatureStatus: {},
    planned: planned(),
    previewing: false,
  };
  const withNotice = notice({
    missing: [missing("event-channels", ["Manage Channels"])],
  });

  it("is byte-for-byte what it was when there is no notice", () => {
    const plain = renderEventAdoptionPage(props);
    expect(renderEventAdoptionPage({ ...props, permissionNotice: null })).toBe(
      plain,
    );
    expect(plain).not.toContain("data-permission-notice");
  });

  it("shows the missing permission above the list, with the link (an admin page)", () => {
    const html = renderEventAdoptionPage({
      ...props,
      permissionNotice: withNotice,
    });
    expect(html).toContain("in the category “Events”");
    expect(html).toContain('href="/admin/bot-permissions"');
    expect(html.indexOf("data-permission-notice")).toBeLessThan(
      html.indexOf("Events to adopt"),
    );
  });

  it("says the check could not run", () => {
    const html = renderEventAdoptionPage({
      ...props,
      permissionNotice: unavailable,
    });
    expect(html).toContain("Bot permissions could not be checked");
  });
});

describe("admin Events page", () => {
  const props = {
    csrfToken: "t",
    remainingMs: 60_000,
    enabled: true,
    categoryConfigured: true,
    announcementConfigured: true,
    timezone: "UTC",
    settingRows: [],
    rows: [],
  };

  it("puts a finding next to each field of the schedule form and the rest under the status line", () => {
    const html = renderEventsPage({ ...props, permissionNotice: everyField });
    const at = (marker: string): number => html.indexOf(marker);
    expect(html.match(/data-permission-notice/g)).toHaveLength(1);
    expect(at("kb-statusline")).toBeLessThan(at("data-permission-notice"));
    expect(at("Schedule a new event")).toBeLessThan(
      at('data-permission-inline="event-channels"'),
    );
    expect(at('data-permission-inline="event-channels"')).toBeLessThan(
      at('data-permission-inline="event-leads-channel"'),
    );
    expect(at('data-permission-inline="event-leads-channel"')).toBeLessThan(
      at('data-permission-inline="event-tags"'),
    );
    expect(html).toContain("Could not be checked");
  });

  it("says a check that could not run once, not at every field", () => {
    const html = renderEventsPage({ ...props, permissionNotice: unavailable });
    expect(html.match(/Bot permissions could not be checked/g)).toHaveLength(1);
    expect(html).not.toContain("data-permission-inline");
  });

  it("is byte-for-byte what it was when there is nothing to say", () => {
    const plain = renderEventsPage(props);
    expect(renderEventsPage({ ...props, permissionNotice: null })).toBe(plain);
    expect(plain).not.toContain("data-permission");
  });
});
