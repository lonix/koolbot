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
  renderWizardConfirmPage,
  renderWizardPage,
  renderWizardStepPage,
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

  it("renders inline set/reset forms with the current value pre-filled", () => {
    const html = renderSettingsPage({
      ...COMMON,
      groups: [
        {
          category: "quotes",
          rows: [
            {
              key: "quotes.max_length",
              current: 500,
              defaultValue: 1000,
              type: "number",
              description: "",
              category: "quotes",
            },
            {
              key: "quotes.channel_id",
              current: "12345",
              defaultValue: "",
              type: "string",
              description: "",
              category: "quotes",
            },
          ],
        },
      ],
    });
    expect(html).toContain('action="/admin/settings/set"');
    expect(html).toContain('action="/admin/settings/reset"');
    expect(html).toContain('name="key" value="quotes.max_length"');
    expect(html).toContain('value="500"');
    expect(html).toContain('value="12345"');
  });

  it("renders the action bar and import textarea", () => {
    const html = renderSettingsPage({ ...COMMON, groups: [] });
    expect(html).toContain('action="/admin/settings/reload"');
    expect(html).toContain('href="/admin/settings/export"');
    expect(html).toContain('href="/admin/wizard"');
    expect(html).toContain('action="/admin/settings/import"');
    expect(html).toContain('<textarea name="yaml"');
  });

  it("renders a flash banner when provided", () => {
    const html = renderSettingsPage({
      ...COMMON,
      groups: [],
      flash: { type: "warn", text: "1 setting skipped." },
    });
    expect(html).toContain("1 setting skipped.");
    expect(html).toContain('class="notice warn"');
  });

  it("pre-checks boolean inputs based on the current value", () => {
    const onHtml = renderSettingsPage({
      ...COMMON,
      groups: [
        {
          category: "x",
          rows: [
            {
              key: "x.enabled",
              current: true,
              defaultValue: false,
              type: "boolean",
              description: "",
              category: "x",
            },
          ],
        },
      ],
    });
    expect(onHtml).toMatch(/type="checkbox" name="value" value="true" checked/);

    const offHtml = renderSettingsPage({
      ...COMMON,
      groups: [
        {
          category: "x",
          rows: [
            {
              key: "x.enabled",
              current: false,
              defaultValue: false,
              type: "boolean",
              description: "",
              category: "x",
            },
          ],
        },
      ],
    });
    expect(offHtml).not.toMatch(
      /type="checkbox" name="value" value="true" checked/,
    );
  });
});

describe("renderPermissionsPage", () => {
  it("falls back to an empty state when no roles are configured", () => {
    const html = renderPermissionsPage({
      ...COMMON,
      commands: ["ping"],
      roleIds: [],
      allRoleIds: [],
      roleNames: new Map(),
      perCommand: new Map(),
    });
    expect(html).toContain("No restricted commands");
    expect(html).toContain("/ping");
    expect(html).toContain("No roles available in this guild");
  });

  it("renders a matrix when roles exist", () => {
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
  });

  it("renders an editable multi-select per command using allRoleIds", () => {
    const html = renderPermissionsPage({
      ...COMMON,
      commands: ["dbtrunk"],
      roleIds: ["r1"],
      // allRoleIds intentionally larger than the restricted set so the
      // dropdown surfaces every role even ones not currently in use.
      allRoleIds: ["r1", "r2"],
      roleNames: new Map([
        ["r1", "Admins"],
        ["r2", "Members"],
      ]),
      perCommand: new Map([["dbtrunk", ["r1"]]]),
    });
    expect(html).toContain('action="/admin/permissions/set"');
    expect(html).toContain('name="command" value="dbtrunk"');
    expect(html).toContain('value="r1"');
    expect(html).toContain('value="r2"');
    expect(html).toContain(">Members<");
    // The currently-restricted role must be pre-selected.
    expect(html).toMatch(/value="r1"\s+selected/);
    // Non-restricted role must NOT be pre-selected.
    expect(html).not.toMatch(/value="r2"\s+selected/);
  });

  it("renders a flash when provided", () => {
    const html = renderPermissionsPage({
      ...COMMON,
      commands: ["ping"],
      roleIds: [],
      allRoleIds: [],
      roleNames: new Map(),
      perCommand: new Map(),
      flash: { type: "ok", text: "Cleared /ping." },
    });
    expect(html).toContain("Cleared /ping.");
    expect(html).toContain('class="notice ok"');
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

  it("renders an active row with category/channel resolution and write controls", () => {
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
    expect(html).toContain("/admin/reaction-roles/create");
    expect(html).toContain("/admin/reaction-roles/archive");
    expect(html).toContain("/admin/reaction-roles/delete");
  });

  it("renders unarchive control for archived rows", () => {
    const html = renderReactionRolesPage({
      ...COMMON,
      enabled: true,
      configChannel: { name: "roles", id: "c1" },
      active: [],
      archived: [
        {
          emoji: "📦",
          roleName: "Old",
          roleId: "r2",
          categoryName: "Roles",
          channelName: "old",
          messageId: "m2",
          isArchived: true,
          archivedAt: "2026-05-08T00:00:00.000Z",
        },
      ],
    });
    expect(html).toContain("/admin/reaction-roles/unarchive");
    expect(html).toContain("/admin/reaction-roles/delete");
  });
});

const NOTICE_CATEGORY_OPTIONS = [
  { value: "general", label: "📋 General" },
  { value: "rules", label: "📜 Rules" },
];

describe("renderNoticesPage", () => {
  it("renders the empty state when no notices exist", () => {
    const html = renderNoticesPage({
      ...COMMON,
      enabled: false,
      channel: null,
      headerEnabled: false,
      total: 0,
      groups: [],
      categoryOptions: NOTICE_CATEGORY_OPTIONS,
    });
    expect(html).toContain("No notices stored");
    expect(html).toContain("Create a notice");
  });

  it("groups by category, exposes per-row edit/delete, and escapes content", () => {
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
              id: "n1",
              order: 1,
              title: "Be nice",
              content: "<3 everyone",
              preview: "<3 everyone",
              category: "rules",
              messageId: "m1",
              updatedAt: "2026-05-08T00:00:00.000Z",
            },
          ],
        },
      ],
      categoryOptions: NOTICE_CATEGORY_OPTIONS,
    });
    expect(html).toContain("rules");
    expect(html).toContain("Be nice");
    expect(html).toContain("&lt;3 everyone");
    expect(html).toContain("/admin/notices/n1/update");
    expect(html).toContain("/admin/notices/n1/delete");
    expect(html).toContain("/admin/notices/n1/order");
    expect(html).toContain("/admin/notices/sync");
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
      trunkHistory: [],
      collections: [],
    });
    expect(html).toContain("connected");
    expect(html).toContain("No collection statistics");
    expect(html).toContain("30 days");
    expect(html).toContain("No prior cleanup runs recorded");
    // Disabled feature → cleanup button is rendered but disabled.
    expect(html).toMatch(
      /<button[^>]*type="submit"[^>]*disabled[^>]*>Run cleanup now<\/button>/,
    );
  });

  it("lists collections with counts and history when present", () => {
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
      trunkHistory: [
        {
          ranAt: "2026-05-08T00:00:00.000Z",
          sessionsRemoved: 17,
          dataAggregated: 4,
          executionMs: 1234,
          errors: 0,
          result: "success",
          errorMessage: null,
        },
      ],
      collections: [{ name: "configs", count: 42 }],
    });
    expect(html).toContain("configs");
    expect(html).toContain("42");
    expect(html).toContain("0 0 * * *");
    expect(html).toContain("/admin/database/run-cleanup");
    expect(html).toContain("17");
    expect(html).toContain("1234ms");
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

  it("renders managed channels with lobby/dynamic/live tags and cleanup actions", () => {
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
    expect(html).toContain("/admin/voice-channels/reload");
    expect(html).toContain("/admin/voice-channels/force-reload");
  });

  it("disables cleanup actions when the feature is off or the category is missing", () => {
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
    expect(html).toMatch(
      /<button[^>]*type="submit"[^>]*disabled[^>]*>Clean up empty channels<\/button>/,
    );
    expect(html).toMatch(
      /<button[^>]*type="submit"[^>]*disabled[^>]*>Force cleanup/,
    );
  });
});

describe("renderImportDiffPage", () => {
  it("summarises pending vs rejected and shows a per-row table", () => {
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
        { key: "bogus.key", status: "rejected", reason: "unknown key" },
      ],
    });
    expect(html).toContain("2 rejected");
    expect(html).toContain("1 key(s) will be written");
    expect(html).toContain("voicechannels.enabled");
    expect(html).toContain("protected key");
    expect(html).toContain("unknown key");
    expect(html).toContain('action="/admin/settings/import/apply"');
  });

  it("disables Apply when there are no pending rows", () => {
    const html = renderImportDiffPage({
      ...COMMON,
      yamlText: "",
      rows: [{ key: "x", status: "rejected", reason: "unknown key" }],
    });
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Apply import<\/button>/);
  });

  it("flags no-change rows when before equals after (after string coercion)", () => {
    const html = renderImportDiffPage({
      ...COMMON,
      yamlText: "x: 5",
      // YAML number, DB string — these round-trip equal at apply.
      rows: [{ key: "x", status: "pending", before: "5", after: 5 }],
    });
    expect(html).toContain("no change");
  });

  it("escapes the YAML payload inside the round-trip hidden field", () => {
    const html = renderImportDiffPage({
      ...COMMON,
      yamlText: "<script>alert(1)</script>",
      rows: [],
    });
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
  });
});

describe("renderWizardPage", () => {
  it("renders feature cards and reflects current enabled status", () => {
    const html = renderWizardPage({
      ...COMMON,
      featureOrder: ["voicechannels", "polls"],
      featureStatus: { voicechannels: true, polls: false },
    });
    expect(html).toContain("Voice Channels");
    expect(html).toContain("Polls");
    expect(html).toMatch(
      /value="voicechannels" id="feat-voicechannels" checked/,
    );
    expect(html).not.toMatch(/value="polls" id="feat-polls" checked/);
    expect(html).toContain('action="/admin/wizard/start"');
  });
});

describe("renderWizardStepPage", () => {
  it("renders boolean/number/string inputs with the current value", () => {
    const html = renderWizardStepPage({
      ...COMMON,
      stepIndex: 0,
      totalSteps: 2,
      featureKey: "voicechannels",
      settingKeys: [
        "voicechannels.enabled",
        "quotes.max_length",
        "voicechannels.lobby.name",
      ],
      currentValues: {
        "voicechannels.enabled": true,
        "quotes.max_length": 500,
        "voicechannels.lobby.name": "Lobby",
      },
      defaultValues: {
        "voicechannels.enabled": false,
        "quotes.max_length": 1000,
        "voicechannels.lobby.name": "Lobby",
      },
      metadata: {
        "voicechannels.enabled": { description: "Enable VC", category: "vc" },
      },
    });
    expect(html).toContain("Step 1 of 2");
    expect(html).toContain('action="/admin/wizard/step/0"');
    expect(html).toContain("Voice Channels");
    expect(html).toMatch(
      /type="checkbox"[^>]*name="voicechannels.enabled"[^>]*value="true" checked/,
    );
    expect(html).toMatch(
      /type="number"[^>]*name="quotes.max_length"[^>]*value="500"/,
    );
    expect(html).toContain('value="Lobby"');
    expect(html).toContain("Enable VC");
  });

  it("renders a flash banner when coercion drops fields", () => {
    const html = renderWizardStepPage({
      ...COMMON,
      stepIndex: 0,
      totalSteps: 1,
      featureKey: "quotes",
      settingKeys: [],
      currentValues: {},
      defaultValues: {},
      metadata: {},
      flash: {
        type: "warn",
        text: "1 field ignored (invalid input): quotes.max_length (invalid number).",
      },
    });
    expect(html).toContain("quotes.max_length (invalid number)");
    expect(html).toContain('class="notice warn"');
  });

  it("changes the submit label on the final step", () => {
    const html = renderWizardStepPage({
      ...COMMON,
      stepIndex: 1,
      totalSteps: 2,
      featureKey: "polls",
      settingKeys: [],
      currentValues: {},
      defaultValues: {},
      metadata: {},
    });
    expect(html).toContain("Review →");
    expect(html).not.toContain("Next →");
  });
});

describe("renderWizardConfirmPage", () => {
  it("lists pending settings and an Apply button", () => {
    const html = renderWizardConfirmPage({
      ...COMMON,
      pending: [
        ["voicechannels.enabled", true],
        ["quotes.max_length", 500],
      ],
      metadata: {
        "voicechannels.enabled": { description: "Enable VC", category: "vc" },
      },
    });
    expect(html).toContain("voicechannels.enabled");
    expect(html).toContain("quotes.max_length");
    expect(html).toContain('action="/admin/wizard/apply"');
    expect(html).toContain('action="/admin/wizard/cancel"');
    expect(html).toMatch(
      /<button[^>]*type="submit"[^>]*class="btn btn-primary"[^>]*>Apply<\/button>/,
    );
  });

  it("disables Apply when there are no pending settings", () => {
    const html = renderWizardConfirmPage({
      ...COMMON,
      pending: [],
      metadata: {},
    });
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Apply<\/button>/);
    expect(html).toContain("No settings configured");
  });
});
