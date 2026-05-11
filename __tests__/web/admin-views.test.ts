import { describe, it, expect } from "@jest/globals";
import {
  renderAnnouncementsPage,
  renderBootstrapPage,
  renderDashboardPage,
  renderDatabasePage,
  renderImportDiffPage,
  renderNoticesPage,
  renderPermissionsPage,
  renderPollsPage,
  renderReactionRolesPage,
  renderSettingsPage,
  renderVoiceChannelsPage,
  renderWizardPage,
  renderWizardConfirmPage,
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
  it("renders empty options when no roles are in the guild", () => {
    const html = renderPermissionsPage({
      ...COMMON,
      commands: ["ping"],
      roleIds: [],
      allRoleIds: [],
      roleNames: new Map(),
      perCommand: new Map(),
    });
    expect(html).toContain("/ping");
    expect(html).toContain("No roles found in this guild");
  });

  it("renders a multi-select with guild roles and marks current restrictions", () => {
    const html = renderPermissionsPage({
      ...COMMON,
      commands: ["dbtrunk"],
      roleIds: ["r1"],
      allRoleIds: ["r1"],
      roleNames: new Map([["r1", "Admins"]]),
      perCommand: new Map([["dbtrunk", ["r1"]]]),
    });
    expect(html).toContain(">Admins<");
    expect(html).toContain('class="tag tag-warn">restricted');
    expect(html).toContain("selected");
  });
});

describe("renderAnnouncementsPage", () => {
  it("shows the empty state when no schedules exist", () => {
    const html = renderAnnouncementsPage({
      ...COMMON,
      enabled: false,
      rows: [],
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
    });
    expect(html).toContain("0 9 * * *");
    expect(html).toContain("&lt;b&gt;hi&lt;/b&gt;");
    expect(html).toContain("#general");
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
          question: "Pineapple on pizza?",
          answers: ["Yes", "No"],
          tags: ["food"],
          usageCount: 0,
          lastUsed: "—",
          enabled: true,
          source: "manual",
        },
      ],
    });
    expect(html).toContain("Pineapple on pizza?");
    expect(html).toContain("@Members");
    expect(html).toContain("Yes • No");
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

describe("renderSettingsPage (editable)", () => {
  it("renders form controls for boolean, number, and string types", () => {
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
            {
              key: "voicechannels.presets.max_per_user",
              current: 3,
              defaultValue: 3,
              type: "number",
              description: "Max presets",
              category: "voicechannels",
            },
            {
              key: "voicechannels.lobby.name",
              current: "Lobby",
              defaultValue: "Lobby",
              type: "string",
              description: "Lobby name",
              category: "voicechannels",
            },
          ],
        },
      ],
    });
    expect(html).toContain('action="/admin/settings/set"');
    expect(html).toContain('action="/admin/settings/reset"');
    expect(html).toContain('action="/admin/settings/reload"');
    expect(html).toContain('href="/admin/settings/export"');
    expect(html).toContain('action="/admin/settings/import"');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('type="number"');
    expect(html).toContain('type="text"');
    expect(html).toContain("Enable VC mgmt");
  });
});

describe("renderImportDiffPage", () => {
  it("shows pending and rejected rows", () => {
    const html = renderImportDiffPage({
      ...COMMON,
      yamlText: "voicechannels.enabled: true",
      rows: [
        {
          key: "voicechannels.enabled",
          status: "pending",
          before: false,
          after: true,
        },
        { key: "DISCORD_TOKEN", status: "rejected", reason: "protected key" },
      ],
    });
    expect(html).toContain("voicechannels.enabled");
    expect(html).toContain("DISCORD_TOKEN");
    expect(html).toContain("protected key");
    expect(html).toContain('action="/admin/settings/import/apply"');
    expect(html).toContain("Cancel");
  });

  it("disables the Apply button when there are no pending rows", () => {
    const html = renderImportDiffPage({
      ...COMMON,
      yamlText: "DISCORD_TOKEN: secret",
      rows: [
        { key: "DISCORD_TOKEN", status: "rejected", reason: "protected key" },
      ],
    });
    expect(html).toContain("disabled");
  });
});

describe("renderWizardPage", () => {
  it("renders feature checkboxes with current status pre-checked", () => {
    const html = renderWizardPage({
      ...COMMON,
      featureOrder: ["voicechannels", "quotes"],
      featureStatus: { voicechannels: true, quotes: false },
    });
    expect(html).toContain("Voice Channels");
    expect(html).toContain("Quote System");
    expect(html).toContain('action="/admin/wizard/start"');
    // voicechannels enabled → should be checked
    expect(html).toMatch(/value="voicechannels"[^>]* checked/);
    // quotes disabled → should NOT be checked in this span
    expect(html).toContain('value="quotes"');
  });
});

describe("renderWizardConfirmPage", () => {
  it("shows pending settings and an Apply button", () => {
    const html = renderWizardConfirmPage({
      ...COMMON,
      pending: [["voicechannels.enabled", true]],
      metadata: {
        "voicechannels.enabled": {
          description: "Enable voice channels",
          category: "voicechannels",
        },
      },
    });
    expect(html).toContain("voicechannels.enabled");
    expect(html).toContain("Enable voice channels");
    expect(html).toContain('action="/admin/wizard/apply"');
    expect(html).toContain('action="/admin/wizard/cancel"');
  });

  it("disables Apply when there are no pending settings", () => {
    const html = renderWizardConfirmPage({
      ...COMMON,
      pending: [],
      metadata: {},
    });
    expect(html).toContain("disabled");
  });
});
