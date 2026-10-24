/**
 * Where the per-feature permission notice (#1253) is placed: the event host
 * panel, the admin Events page and the Voice Channels page. The notice logic
 * itself is in `permission-notice.test.ts`.
 */

import { describe, it, expect } from "@jest/globals";
import { ChannelType } from "discord.js";
import { nativeSyncPaused } from "../../src/services/event-native-rules.js";
import { eventPermissionTargets } from "../../src/web/host-panel-shared.js";
import {
  hostPanelPermissionFeatures,
  hostPanelShownWarnings,
  renderHostPanelBody,
  type HostPanelEvent,
} from "../../src/web/host-panel-view.js";
import {
  renderVoiceChannelsPage,
  renderEventsPage,
} from "../../src/web/admin-views.js";
import {
  buildPermissionNotice,
  inAreas,
  inFeatures,
  type PermissionNotice,
} from "../../src/web/permission-notice.js";
import type {
  BotPermissionReport,
  FeatureCheck,
} from "../../src/services/bot-permission-check.js";
import {
  FEATURE_REQUIREMENTS,
  MANAGE_CHANNELS_CREATE_WARNING,
} from "../../src/services/bot-permission-registry.js";

const base: HostPanelEvent = {
  id: "1",
  title: "Quiz night",
  description: "",
  state: "scheduled",
  when: "2030-01-01 19:00 (UTC)",
  durationMinutes: 60,
  recurrence: null,
  channel: null,
  groupsEnabled: true,
  groupLabel: "Team",
  leaderLabel: "Leader",
  channelLeadMinutes: null,
  groups: [],
  adopted: false,
};

const group = (kind: "team" | "leads") => ({
  name: "Red",
  marker: "",
  kind,
  size: null,
  tag: "",
  hasChannel: false,
  memberCount: 0,
  fill: "0",
});

function ref(id: string): FeatureCheck["feature"] {
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

function missingChannelsReport(): BotPermissionReport {
  return {
    available: true,
    reason: null,
    fresh: true,
    problems: [],
    unknown: [],
    quiet: [],
    okFeatures: [],
    notes: [],
    checks: [
      {
        feature: ref("event-channels"),
        kind: "permission",
        enabled: true,
        outcome: "missing",
        target: { kind: "category", id: "c1", name: "Events" },
        missing: ["Manage Channels"],
      },
    ],
  };
}

function noticeFor(filter = inAreas("Events")): PermissionNotice | null {
  return buildPermissionNotice(missingChannelsReport(), {
    enabled: true,
    filter,
  });
}

describe("hostPanelPermissionFeatures", () => {
  it("is the event's channels and the Events list card for a plain event", () => {
    expect(
      hostPanelPermissionFeatures({ ...base, groupsEnabled: false }),
    ).toEqual(["event-channels", "event-native"]);
  });

  it("adds the group features only where the event uses them", () => {
    expect(
      hostPanelPermissionFeatures({ ...base, groups: [group("team")] }),
    ).toEqual([
      "event-channels",
      "event-native",
      "event-host-access",
      "event-moves",
    ]);
    const full = hostPanelPermissionFeatures({
      ...base,
      groups: [group("leads")],
      tagsEnabled: true,
    });
    expect(full).toContain("event-leads-channel");
    expect(full).toContain("event-tags");
  });

  it("includes the leaders-only channel for a Captains lobby", () => {
    expect(
      hostPanelPermissionFeatures({
        ...base,
        captainsLobby: { hasChannel: false },
      }),
    ).toContain("event-leads-channel");
  });

  it("leaves out the channel entry for an adopted event with no channel of KoolBot's own (#1467)", () => {
    // An adopted voice or stage event happens in its own Discord channel, so
    // KoolBot makes no temporary one and needs no Manage Channels for it.
    expect(
      hostPanelPermissionFeatures({ ...base, adopted: true, channel: null }),
    ).not.toContain("event-channels");
    // An adopted external event that got a temporary room still needs it.
    expect(
      hostPanelPermissionFeatures({ ...base, adopted: true, channel: "Room" }),
    ).toContain("event-channels");
    expect(hostPanelPermissionFeatures(base)).toContain("event-channels");
  });

  it("leaves out the Events list card for an event whose native event was detached (#1467)", () => {
    // `syncEvent` skips a detached, not yet finished event, so the permission
    // would not bring its card back.
    expect(
      hostPanelPermissionFeatures({ ...base, nativeDetached: true }),
    ).not.toContain("event-native");
    expect(
      hostPanelPermissionFeatures({ ...base, nativeDetached: false }),
    ).toContain("event-native");
  });

  it("moves need a group to move into, not only the groups switch", () => {
    expect(hostPanelPermissionFeatures({ ...base, groups: [] })).not.toContain(
      "event-moves",
    );
    expect(
      hostPanelPermissionFeatures({ ...base, groups: [group("team")] }),
    ).toContain("event-moves");
  });

  it("host access matters while a channel is still to be created, not once every channel exists", () => {
    const made = { ...group("team"), hasChannel: true };
    expect(
      hostPanelPermissionFeatures({ ...base, channel: "Main", groups: [made] }),
    ).not.toContain("event-host-access");
    expect(
      hostPanelPermissionFeatures({ ...base, channel: null, groups: [made] }),
    ).toContain("event-host-access");
    expect(
      hostPanelPermissionFeatures({
        ...base,
        channel: "Main",
        groups: [made, group("team")],
      }),
    ).toContain("event-host-access");
  });

  it("leaves out the Events list card for an adopted event, and everything for a finished one", () => {
    expect(
      hostPanelPermissionFeatures({ ...base, adopted: true }),
    ).not.toContain("event-native");
    expect(hostPanelPermissionFeatures({ ...base, state: "ended" })).toEqual(
      [],
    );
    expect(
      hostPanelPermissionFeatures({ ...base, state: "cancelled" }),
    ).toEqual([]);
  });
});

describe("eventPermissionTargets", () => {
  it("uses the main channel's category, as the group channels do", () => {
    expect(
      eventPermissionTargets({ channelId: "main", categoryId: "own" }, (id) =>
        id === "main" ? "parent-1" : undefined,
      ),
    ).toEqual({
      "event-channels": "parent-1",
      "event-host-access": "parent-1",
      "event-leads-channel": "parent-1",
      "event-moves": "parent-1",
    });
  });

  it("uses the event's category override before its channel exists", () => {
    expect(
      eventPermissionTargets(
        { channelId: null, categoryId: "own" },
        () => null,
      )["event-channels"],
    ).toBe("own");
  });

  it("leaves the configured category alone when the event names none", () => {
    expect(
      eventPermissionTargets({ channelId: null, categoryId: "" }, () => null),
    ).toEqual({});
    // A main channel not in the cache falls back to the override, then to the setting.
    expect(
      eventPermissionTargets({ channelId: "gone", categoryId: "" }, () => null),
    ).toEqual({});
  });
});

describe("nativeSyncPaused", () => {
  it("pauses an open detached event only", () => {
    expect(nativeSyncPaused({ state: "scheduled", nativeDetached: true })).toBe(
      true,
    );
    expect(nativeSyncPaused({ state: "active", nativeDetached: true })).toBe(
      true,
    );
    expect(nativeSyncPaused({ state: "ended", nativeDetached: true })).toBe(
      false,
    );
    expect(
      nativeSyncPaused({ state: "scheduled", nativeDetached: false }),
    ).toBe(false);
    expect(nativeSyncPaused({ state: "scheduled" })).toBe(false);
  });
});

describe("host panel", () => {
  it("shows the missing permission and the category next to the groups, with the link for an admin", () => {
    const html = renderHostPanelBody({
      event: base,
      permissionNotice: noticeFor(),
      canLinkToPermissions: true,
    });
    expect(html).toContain("data-permission-notice");
    expect(html).toContain("Manage Channels");
    expect(html).toContain("in the category “Events”");
    expect(html).toContain('href="/admin/bot-permissions"');
    // Between the summary and the groups.
    expect(html.indexOf("host-summary")).toBeLessThan(
      html.indexOf("data-permission-notice"),
    );
    expect(html.indexOf("data-permission-notice")).toBeLessThan(
      html.indexOf("host-groups"),
    );
  });

  it("gives a host who is not an admin no link to an admin-only page", () => {
    const html = renderHostPanelBody({
      event: base,
      permissionNotice: noticeFor(),
    });
    expect(html).toContain("Ask a server admin");
    expect(html).not.toContain("/admin/bot-permissions");
  });

  it("shows nothing when there is no notice, and leaves the markup as it was (no stray blank line)", () => {
    const html = renderHostPanelBody({ event: base });
    expect(html).not.toContain("data-permission-notice");
    expect(html).toContain(
      '</section>\n<section class="card" id="host-groups"',
    );
  });

  it("does not say a recorded group warning twice", () => {
    const event: HostPanelEvent = {
      ...base,
      groups: [group("team")],
      groupNotices: [MANAGE_CHANNELS_CREATE_WARNING],
    };
    const notice = buildPermissionNotice(missingChannelsReport(), {
      enabled: true,
      filter: inFeatures(...hostPanelPermissionFeatures(event)),
      shownWarnings: hostPanelShownWarnings(event),
    });
    const html = renderHostPanelBody({
      event,
      permissionNotice: notice,
      canLinkToPermissions: true,
    });
    expect(html).toContain("Some group channels could not be set up");
    expect(html).not.toContain("data-permission-notice");
    expect(html.split("Manage Channels").length - 1).toBe(1);
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

  it("shows the notice under the status line", () => {
    const html = renderEventsPage({ ...props, permissionNotice: noticeFor() });
    expect(html).toContain("data-permission-notice");
    expect(html).toContain("in the category “Events”");
    expect(html.indexOf("kb-statusline")).toBeLessThan(
      html.indexOf("data-permission-notice"),
    );
  });

  it("says the check could not run, not that all is well", () => {
    const unavailable = buildPermissionNotice(
      {
        ...missingChannelsReport(),
        available: false,
        reason: "The bot could not read this server from Discord.",
        checks: [],
      },
      { enabled: true, filter: inAreas("Events") },
    );
    const html = renderEventsPage({ ...props, permissionNotice: unavailable });
    expect(html).toContain("Bot permissions could not be checked");
  });
});

describe("Voice Channels page", () => {
  const props = {
    csrfToken: "t",
    remainingMs: 60_000,
    enabled: true,
    controlPanelEnabled: false,
    categoryName: "Voice",
    categoryType: ChannelType.GuildCategory,
    lobbyName: "Lobby",
    offlineLobbyName: "Offline Lobby",
    prefix: "G",
    totalManaged: 0,
    totalEmpty: 0,
    channels: [],
    categoryFound: true,
    categoryChannels: [],
    voiceChannels: [],
    settingRows: [],
  };

  it("shows the notice with the category named", () => {
    const report = missingChannelsReport();
    report.checks = [
      {
        feature: ref("voice-rooms"),
        kind: "permission",
        enabled: true,
        outcome: "missing",
        target: { kind: "category", id: "v1", name: "Voice" },
        missing: ["Manage Channels", "Move Members"],
      },
    ];
    const notice = buildPermissionNotice(report, {
      enabled: true,
      filter: inAreas("Voice channels"),
    });
    const html = renderVoiceChannelsPage({
      ...props,
      permissionNotice: notice,
    } as never);
    expect(html).toContain("Temporary voice rooms");
    expect(html).toContain("Manage Channels</strong>, <strong>Move Members");
    expect(html).toContain("in the category “Voice”");
  });

  it("shows no notice when the permissions are in place, and adds no blank line", () => {
    const html = renderVoiceChannelsPage({ ...props } as never);
    expect(html).not.toContain("data-permission-notice");
    expect(html).not.toMatch(/\n{3}<div class="card">\n {2}<h2>Cleanup/);
  });
});
