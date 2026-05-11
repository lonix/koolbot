import { describe, it, expect } from "@jest/globals";
import {
  renderAnnouncementsPage,
  renderBootstrapPage,
  renderDashboardPage,
  renderDatabasePage,
  renderNoticesPage,
  renderPermissionsPage,
  renderPollsPage,
  renderReactionRolesPage,
  renderSettingsPage,
  renderVoiceChannelsPage,
} from "../../src/web/admin-views.js";

const COMMON = { csrfToken: "csrf", remainingMs: 60_000 };

describe("renderDashboardPage", () => {
  it("renders feature toggles with status tags", () => {
    const html = renderDashboardPage({
      ...COMMON,
      guild: {
        id: "g1",
        name: "Test Guild",
        memberCount: 42,
        voiceUsers: 3,
        botTag: "Bot#0001",
      },
      mongoState: "connected",
      counts: {
        announcements: 1,
        pollSchedules: 2,
        pollItems: 3,
        reactionRoles: 4,
        notices: 5,
      },
      features: [
        { key: "voicechannels.enabled", label: "Voice Channels", on: true },
        { key: "polls.enabled", label: "Polls", on: false },
      ],
    });
    expect(html).toContain("Test Guild");
    expect(html).toContain("Bot#0001");
    expect(html).toContain("voicechannels.enabled");
    expect(html).toContain('class="tag tag-on">ON');
    expect(html).toContain('class="tag tag-off">OFF');
  });
});

describe("renderBootstrapPage", () => {
  it("shows status tags + masked secrets", () => {
    const html = renderBootstrapPage({
      ...COMMON,
      groups: [
        {
          category: "WebUI",
          rows: [
            {
              key: "WEBUI_SESSION_SECRET",
              present: true,
              isSecret: true,
              display: "…abcd",
            },
            {
              key: "WEBUI_SESSION_TTL_MINUTES",
              present: false,
              isSecret: false,
            },
          ],
        },
      ],
    });
    expect(html).toContain("WEBUI_SESSION_SECRET");
    expect(html).toContain("…abcd");
    expect(html).toContain("configured");
    expect(html).toContain("unset");
  });
});

describe("renderSettingsPage", () => {
  it("renders one section per category and one row per setting", () => {
    const html = renderSettingsPage({
      ...COMMON,
      groups: [
        {
          category: "voicechannels",
          rows: [
            {
              key: "voicechannels.enabled",
              current: true,
              defaultValue: false,
              type: "boolean",
              description: "Enable VC mgmt",
              category: "voicechannels",
            },
          ],
        },
      ],
    });
    expect(html).toContain("voicechannels.enabled");
    expect(html).toContain("Enable VC mgmt");
    expect(html).toContain('class="tag tag-info">boolean');
  });
});

describe("renderPermissionsPage", () => {
  it("falls back to an empty state when no roles are configured", () => {
    const html = renderPermissionsPage({
      ...COMMON,
      commands: ["ping"],
      roleIds: [],
      roleNames: new Map(),
      perCommand: new Map(),
    });
    expect(html).toContain("No restricted commands");
    expect(html).toContain("/ping");
  });

  it("renders a matrix when roles exist", () => {
    const html = renderPermissionsPage({
      ...COMMON,
      commands: ["dbtrunk"],
      roleIds: ["r1"],
      roleNames: new Map([["r1", "Admins"]]),
      perCommand: new Map([["dbtrunk", ["r1"]]]),
    });
    expect(html).toContain(">Admins<");
    expect(html).toContain('class="tag tag-warn">restricted');
  });
});

describe("renderAnnouncementsPage", () => {
  it("shows the empty state when no schedules exist", () => {
    const html = renderAnnouncementsPage({
      ...COMMON,
      enabled: false,
      rows: [],
      textChannels: [],
    });
    expect(html).toContain("No scheduled announcements");
    expect(html).toContain("disabled");
  });

  it("renders a row with cron + escapes the message preview", () => {
    const html = renderAnnouncementsPage({
      ...COMMON,
      enabled: true,
      rows: [
        {
          id: "a1",
          channelName: "general",
          cron: "0 9 * * *",
          enabled: true,
          messagePreview: "<b>hi</b>",
          embedTitle: null,
          placeholders: false,
          createdAt: "2026-05-08T00:00:00.000Z",
        },
      ],
      textChannels: [{ id: "c1", name: "general" }],
    });
    expect(html).toContain("0 9 * * *");
    expect(html).toContain("&lt;b&gt;hi&lt;/b&gt;");
    expect(html).toContain("#general");
  });

  it("renders the create form and post-vc-stats button", () => {
    const html = renderAnnouncementsPage({
      ...COMMON,
      enabled: true,
      rows: [],
      textChannels: [{ id: "c1", name: "general" }],
    });
    expect(html).toContain("/admin/announcements/create");
    expect(html).toContain("/admin/announcements/post-vc-stats");
    expect(html).toContain("Process placeholders");
  });

  it("renders a flash banner when provided", () => {
    const html = renderAnnouncementsPage({
      ...COMMON,
      enabled: true,
      rows: [],
      textChannels: [],
      flash: { type: "ok", text: "Created announcement abc." },
    });
    expect(html).toContain("Created announcement abc.");
    expect(html).toContain('class="notice ok"');
  });
});

describe("renderPollsPage", () => {
  it("shows empty state for both schedules and items", () => {
    const html = renderPollsPage({
      ...COMMON,
      enabled: true,
      defaultDurationHours: 24,
      cooldownDays: 7,
      schedules: [],
      items: [],
      textChannels: [],
      roles: [],
    });
    expect(html).toContain("No poll schedules");
    expect(html).toContain("No poll questions");
  });

  it("renders schedules and items with channel + role mentions", () => {
    const html = renderPollsPage({
      ...COMMON,
      enabled: true,
      defaultDurationHours: 24,
      cooldownDays: 7,
      schedules: [
        {
          id: "s1",
          channelName: "polls",
          cron: "0 12 * * 1",
          durationHours: 12,
          pingRoleName: "Members",
          enabled: true,
          lastRun: "—",
        },
      ],
      items: [
        {
          id: "i1",
          question: "Pineapple on pizza?",
          answers: ["Yes", "No"],
          tags: ["food"],
          usageCount: 0,
          lastUsed: "—",
          enabled: true,
          source: "manual",
        },
      ],
      textChannels: [{ id: "c1", name: "polls" }],
      roles: [{ id: "r1", name: "Members" }],
    });
    expect(html).toContain("Pineapple on pizza?");
    expect(html).toContain("@Members");
    expect(html).toContain("Yes • No");
    expect(html).toContain("/admin/polls/schedules/s1/test");
    expect(html).toContain("/admin/polls/items/i1/delete");
  });

  it("renders write forms for schedules, items and bulk import", () => {
    const html = renderPollsPage({
      ...COMMON,
      enabled: true,
      defaultDurationHours: 24,
      cooldownDays: 7,
      schedules: [],
      items: [],
      textChannels: [{ id: "c1", name: "polls" }],
      roles: [{ id: "r1", name: "Members" }],
    });
    expect(html).toContain("/admin/polls/schedules/create");
    expect(html).toContain("/admin/polls/items/create");
    expect(html).toContain("/admin/polls/items/import");
  });
});

describe("renderReactionRolesPage", () => {
  it("shows the empty state for active and archived", () => {
    const html = renderReactionRolesPage({
      ...COMMON,
      enabled: false,
      configChannel: null,
      active: [],
      archived: [],
    });
    expect(html).toContain("No active reaction-role mappings");
    expect(html).toContain("No archived mappings");
  });

  it("renders an active row with category/channel resolution", () => {
    const html = renderReactionRolesPage({
      ...COMMON,
      enabled: true,
      configChannel: { name: "roles", id: "c1" },
      active: [
        {
          emoji: "🎮",
          roleName: "Gamer",
          roleId: "r1",
          categoryName: "Roles",
          channelName: "roles",
          messageId: "m1",
          isArchived: false,
          archivedAt: null,
        },
      ],
      archived: [],
    });
    expect(html).toContain("🎮");
    expect(html).toContain("Gamer");
    expect(html).toContain("#roles");
    expect(html).toContain('class="tag tag-on">active');
  });
});

describe("renderNoticesPage", () => {
  it("renders the empty state when no notices exist", () => {
    const html = renderNoticesPage({
      ...COMMON,
      enabled: false,
      channel: null,
      headerEnabled: false,
      total: 0,
      groups: [],
    });
    expect(html).toContain("No notices stored");
  });

  it("groups by category and escapes content", () => {
    const html = renderNoticesPage({
      ...COMMON,
      enabled: true,
      channel: { name: "notices", id: "c1" },
      headerEnabled: true,
      total: 1,
      groups: [
        {
          category: "rules",
          rows: [
            {
              order: 1,
              title: "Be nice",
              preview: "<3 everyone",
              messageId: "m1",
              updatedAt: "2026-05-08T00:00:00.000Z",
            },
          ],
        },
      ],
    });
    expect(html).toContain("rules");
    expect(html).toContain("Be nice");
    expect(html).toContain("&lt;3 everyone");
  });
});

describe("renderDatabasePage", () => {
  it("renders connection state and an empty collection list", () => {
    const html = renderDatabasePage({
      ...COMMON,
      connection: {
        state: "connected",
        name: "koolbot",
        host: "mongodb",
      },
      trunk: {
        enabled: false,
        schedule: "",
        isScheduled: false,
        isRunning: false,
        lastRun: "—",
        notificationChannel: null,
        detailedDays: 30,
        monthlyMonths: 6,
        yearlyYears: 1,
      },
      collections: [],
    });
    expect(html).toContain("connected");
    expect(html).toContain("No collection statistics");
    expect(html).toContain("30 days");
  });

  it("lists collections with counts when present", () => {
    const html = renderDatabasePage({
      ...COMMON,
      connection: { state: "connected", name: "koolbot", host: "mongodb" },
      trunk: {
        enabled: true,
        schedule: "0 0 * * *",
        isScheduled: true,
        isRunning: false,
        lastRun: "—",
        notificationChannel: null,
        detailedDays: 30,
        monthlyMonths: 6,
        yearlyYears: 1,
      },
      collections: [{ name: "configs", count: 42 }],
    });
    expect(html).toContain("configs");
    expect(html).toContain("42");
    expect(html).toContain("0 0 * * *");
  });
});

describe("renderVoiceChannelsPage", () => {
  it("renders the not-found state when category is missing", () => {
    const html = renderVoiceChannelsPage({
      ...COMMON,
      enabled: false,
      controlPanelEnabled: true,
      categoryName: "Voice",
      lobbyName: "Lobby",
      offlineLobbyName: "Offline Lobby",
      prefix: "🎮",
      totalManaged: 0,
      totalEmpty: 0,
      channels: [],
      categoryFound: false,
    });
    expect(html).toContain("Voice channel category not found");
  });

  it("renders managed channels with lobby/dynamic/live tags", () => {
    const html = renderVoiceChannelsPage({
      ...COMMON,
      enabled: true,
      controlPanelEnabled: true,
      categoryName: "Voice",
      lobbyName: "Lobby",
      offlineLobbyName: "Offline Lobby",
      prefix: "🎮",
      totalManaged: 2,
      totalEmpty: 1,
      channels: [
        {
          name: "Lobby",
          isLobby: true,
          isLive: false,
          memberCount: 0,
          customName: null,
          channelId: "c1",
        },
        {
          name: "🎮 Game",
          isLobby: false,
          isLive: true,
          memberCount: 3,
          customName: "Friday night",
          channelId: "c2",
        },
      ],
      categoryFound: true,
    });
    expect(html).toContain('class="tag tag-info">lobby');
    expect(html).toContain('class="tag tag-warn">dynamic');
    expect(html).toContain('class="tag tag-warn">LIVE');
    expect(html).toContain("Friday night");
  });
});
