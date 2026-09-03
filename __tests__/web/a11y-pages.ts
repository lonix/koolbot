/**
 * Shared page fixtures for the accessibility gate (issue #856).
 *
 * Every WebUI page renderer is a pure function returning a complete HTML
 * document, so the a11y checks need no browser and no HTTP round-trip —
 * they render a page here and hand the markup to axe (`a11y-axe.test.ts`).
 *
 * Keep this list exhaustive: a page that isn't in it isn't gated, which is
 * exactly how the violations in #853 / #855 accumulated unnoticed. When you
 * add a page renderer, add a fixture for it in the matching group below.
 */

import {
  renderAnalyticsPage,
  renderAnnouncementsPage,
  renderBootstrapPage,
  renderBotStatusPage,
  renderCommandAuditPage,
  renderCommandMetricsPage,
  renderDashboardPage,
  renderDatabasePage,
  renderDigestPage,
  renderEventsPage,
  renderImportDiffPage,
  renderModerationPage,
  renderNoticesPage,
  renderPermissionsPage,
  renderPollsPage,
  renderReactionRolesPage,
  renderSettingsPage,
  renderVoiceChannelsPage,
  renderWizardConfirmPage,
  renderWizardPage,
  renderWizardStepPage,
  type SettingRow,
} from "../../src/web/admin-views.js";
import {
  renderUserBirthdayBody,
  renderUserIndexBody,
  renderUserNotificationsBody,
  renderUserPage,
  renderUserRewindBody,
  renderUserTimezoneBody,
  renderUserVoiceBody,
} from "../../src/web/user-layout.js";
import {
  renderConsent,
  renderErrorPage,
  renderInvalidLink,
  renderSignedOut,
} from "../../src/web/views.js";

/** One page under test: a human-readable name and the document to scan. */
export interface A11yPage {
  name: string;
  html: string;
}

const COMMON = { csrfToken: "csrf-token", remainingMs: 900_000 };

const CHANNELS = [
  { id: "c1", name: "general" },
  { id: "c2", name: "announcements" },
];
const VOICE_CHANNELS = [{ id: "v1", name: "Lounge" }];
const CATEGORIES = [{ id: "cat1", name: "Voice Channels" }];
const ROLES = [
  { id: "r1", name: "Admin" },
  { id: "r2", name: "Member" },
];

const PICKERS = {
  textChannels: CHANNELS,
  voiceChannels: VOICE_CHANNELS,
  categoryChannels: CATEGORIES,
  roles: ROLES,
};

const FLASH = { type: "ok" as const, text: "Saved 3 settings." };

/**
 * One row per control shape the Settings renderer can produce, so the scan
 * covers every kind of label/description wiring rather than just text inputs.
 */
const SETTING_ROWS: SettingRow[] = [
  {
    key: "voicechannels.enabled",
    label: "Enabled",
    current: true,
    defaultValue: false,
    type: "boolean",
    description: "Turn dynamic voice channels on.",
    category: "voicechannels",
  },
  {
    key: "voicechannels.lobby_channel_name",
    label: "Lobby channel name",
    current: "Lobby",
    defaultValue: "Lobby",
    type: "string",
    description: "Name of the channel members join to get their own room.",
    category: "voicechannels",
  },
  {
    key: "voicechannels.cleanup.interval_minutes",
    label: "Cleanup interval (minutes)",
    current: 2,
    defaultValue: 5,
    type: "number",
    description: "How often empty managed channels are swept.",
    category: "voicechannels",
    min: 1,
    warnBelow: { value: 5, message: "Values under 5 minutes are chatty." },
  },
  {
    key: "voicechannels.category_id",
    label: "Category",
    current: "cat1",
    defaultValue: "",
    type: "category",
    description: "Category the managed channels are created in.",
    category: "voicechannels",
  },
  {
    key: "voicetracking.excluded_channels",
    label: "Excluded channels",
    current: "c1,c2",
    defaultValue: "",
    type: "channel_list",
    description: "Channels excluded from tracking.",
    category: "voicetracking",
  },
  {
    key: "voicetracking.announcer_role",
    label: "Announcer role",
    current: "r1",
    defaultValue: "",
    type: "role",
    description: "Role pinged by the announcer.",
    category: "voicetracking",
  },
  {
    key: "voicetracking.notify_roles",
    label: "Notify roles",
    current: "r1,r2",
    defaultValue: "",
    type: "role_list",
    description: "Roles notified about weekly stats.",
    category: "voicetracking",
  },
  {
    key: "digest.schedule",
    label: "Digest schedule",
    current: "0 16 * * 5",
    defaultValue: "0 16 * * 5",
    type: "cron",
    description: "When the weekly digest is sent.",
    category: "digest",
  },
  {
    key: "core.log_level",
    label: "Log level",
    current: "info",
    defaultValue: "info",
    type: "string",
    description: "Verbosity of the console logger.",
    category: "core",
    options: [
      { value: "info", label: "info" },
      { value: "debug", label: "debug" },
    ],
  },
];

/** Every authenticated admin page, rendered as a full document. */
export function adminPages(): A11yPage[] {
  return [
    {
      name: "Dashboard",
      html: renderDashboardPage({
        ...COMMON,
        guild: {
          id: "g1",
          name: "Test Guild",
          memberCount: 42,
          voiceUsers: 3,
          botTag: "Koolbot#0001",
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
      }),
    },
    {
      name: "Bootstrap",
      html: renderBootstrapPage({
        ...COMMON,
        groups: [
          {
            category: "Discord",
            rows: [
              { key: "DISCORD_TOKEN", present: true, isSecret: true, display: "…ab12" },
              { key: "GUILD_ID", present: false, isSecret: false },
            ],
          },
        ],
      }),
    },
    {
      name: "Settings",
      html: renderSettingsPage({
        ...COMMON,
        ...PICKERS,
        groups: [{ category: "voicechannels", rows: SETTING_ROWS }],
        guildId: "g1",
        guildName: "Test Guild",
        flash: FLASH,
      }),
    },
    {
      name: "Settings (rejected value)",
      html: renderSettingsPage({
        ...COMMON,
        ...PICKERS,
        groups: [{ category: "voicechannels", rows: SETTING_ROWS }],
        guildId: "g1",
        guildName: "Test Guild",
        flash: { type: "err", text: "One value was rejected." },
        invalidKeys: ["voicechannels.lobby_channel_name"],
      }),
    },
    {
      name: "Import diff",
      html: renderImportDiffPage({
        ...COMMON,
        rows: [
          { key: "polls.enabled", status: "pending", before: false, after: true },
          {
            key: "polls.bogus",
            status: "rejected",
            reason: "unknown key",
            after: "x",
          },
        ],
        yamlText: "polls:\n  enabled: true\n",
      }),
    },
    {
      name: "Permissions",
      html: renderPermissionsPage({
        ...COMMON,
        commands: ["ping", "quote"],
        roleIds: ["r1"],
        allRoleIds: ["r1", "r2"],
        roleNames: new Map([
          ["r1", "Admin"],
          ["r2", "Member"],
        ]),
        perCommand: new Map([["quote", ["r1"]]]),
        flash: FLASH,
      }),
    },
    {
      name: "Setup wizard",
      html: renderWizardPage({
        ...COMMON,
        featureOrder: ["voicechannels", "polls"],
        featureStatus: { voicechannels: true, polls: false },
      }),
    },
    {
      name: "Setup wizard step",
      html: renderWizardStepPage({
        ...COMMON,
        ...PICKERS,
        stepIndex: 0,
        totalSteps: 2,
        featureKey: "voicechannels",
        settingKeys: ["voicechannels.enabled", "voicechannels.category_id"],
        currentValues: {
          "voicechannels.enabled": true,
          "voicechannels.category_id": "cat1",
        },
        metadata: {},
        defaultValues: {
          "voicechannels.enabled": false,
          "voicechannels.category_id": "",
        },
        enabledByKey: { "voicechannels.enabled": true },
        flash: FLASH,
      }),
    },
    {
      name: "Setup wizard confirm",
      html: renderWizardConfirmPage({
        ...COMMON,
        pending: [["voicechannels.enabled", true]],
        metadata: {
          "voicechannels.enabled": {
            description: "Turn dynamic voice channels on.",
            category: "voicechannels",
          },
        },
      }),
    },
    {
      name: "Announcements",
      html: renderAnnouncementsPage({
        ...COMMON,
        enabled: true,
        textChannels: CHANNELS,
        rows: [
          {
            id: "a1",
            channelName: "general",
            cron: "0 9 * * 1",
            enabled: true,
            messagePreview: "Good morning!",
            embedTitle: null,
            placeholders: true,
            createdAt: "2026-01-01",
          },
        ],
        flash: FLASH,
      }),
    },
    {
      name: "Events",
      html: renderEventsPage({
        ...COMMON,
        enabled: true,
        categoryConfigured: true,
        announcementConfigured: false,
        timezone: "Europe/Stockholm",
        rows: [
          {
            id: "e1",
            title: "Game night",
            when: "2026-02-01 20:00",
            state: "scheduled",
            going: 4,
            maybe: 1,
            cant: 0,
            channelId: "c1",
          },
        ],
        flash: FLASH,
      }),
    },
    {
      name: "Polls",
      html: renderPollsPage({
        ...COMMON,
        enabled: true,
        defaultDurationHours: 24,
        cooldownDays: 30,
        textChannels: CHANNELS,
        roles: ROLES,
        schedules: [
          {
            id: "s1",
            channelId: "c1",
            channelName: "general",
            cron: "0 12 * * 3",
            durationHours: 24,
            pingRoleId: "r2",
            pingRoleName: "Member",
            enabled: true,
            lastRun: "2026-01-07",
          },
        ],
        items: [
          {
            id: "p1",
            question: "Best pizza topping?",
            answers: ["Pineapple", "Not pineapple"],
            tags: ["food"],
            multiSelect: false,
            usageCount: 2,
            lastUsed: "2026-01-07",
            enabled: true,
            source: "library",
          },
        ],
        flash: FLASH,
      }),
    },
    {
      name: "Reaction roles",
      html: renderReactionRolesPage({
        ...COMMON,
        enabled: true,
        configChannel: { name: "roles", id: "c1" },
        active: [
          {
            mappingId: "m1",
            emoji: "🎮",
            roleName: "Gamer",
            roleId: "r2",
            categoryName: "Games",
            channelName: "roles",
            messageId: "msg1",
            autoCreated: true,
            mode: "toggle",
            groupId: null,
            isArchived: false,
            archivedAt: null,
          },
        ],
        archived: [
          {
            mappingId: "m2",
            emoji: "📼",
            roleName: "Retro",
            roleId: "r2",
            categoryName: "Games",
            channelName: "roles",
            messageId: "msg2",
            autoCreated: false,
            mode: "toggle",
            groupId: "g",
            isArchived: true,
            archivedAt: "2026-01-01",
          },
        ],
        flash: FLASH,
      }),
    },
    {
      name: "Notices",
      html: renderNoticesPage({
        ...COMMON,
        enabled: true,
        channel: { name: "rules", id: "c1" },
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
                content: "Be nice to each other.",
                preview: "Be nice to each other.",
                category: "rules",
                messageId: "msg1",
                updatedAt: "2026-01-01",
              },
            ],
          },
        ],
        categoryOptions: [{ value: "rules", label: "Rules" }],
        flash: FLASH,
      }),
    },
    {
      name: "Database",
      html: renderDatabasePage({
        ...COMMON,
        connection: { state: "connected", name: "koolbot", host: "mongo:27017" },
        trunk: {
          enabled: true,
          schedule: "0 3 * * 0",
          isScheduled: true,
          isRunning: false,
          lastRun: "2026-01-04",
          detailedDays: 30,
          monthlyMonths: 12,
          yearlyYears: 3,
        },
        trunkHistory: [
          {
            ranAt: "2026-01-04",
            sessionsRemoved: 10,
            dataAggregated: 4,
            executionMs: 120,
            errors: 0,
            result: "success",
            errorMessage: null,
          },
        ],
        collections: [{ name: "voicechannelsessions", count: 1200 }],
        flash: FLASH,
      }),
    },
    {
      name: "Bot status",
      html: renderBotStatusPage({
        ...COMMON,
        maxLength: 100,
        pools: [
          {
            pool: "playing",
            label: "Playing",
            description: "Shown as “Playing …”.",
            requiresCount: false,
            items: [{ id: "i1", order: 1, text: "with the config" }],
            usingDefaults: false,
            exportText: "with the config",
          },
        ],
        flash: FLASH,
      }),
    },
    {
      name: "Voice channels",
      html: renderVoiceChannelsPage({
        ...COMMON,
        enabled: true,
        controlPanelEnabled: true,
        categoryName: "Voice Channels",
        lobbyName: "Lobby",
        offlineLobbyName: "Offline",
        prefix: "",
        totalManaged: 2,
        totalEmpty: 1,
        categoryFound: true,
        channels: [
          {
            name: "Lobby",
            isLobby: true,
            isLive: false,
            memberCount: 0,
            customName: null,
            channelId: "v1",
          },
          {
            name: "Alice's channel",
            isLobby: false,
            isLive: true,
            memberCount: 3,
            customName: "Alice's channel",
            channelId: "v2",
          },
        ],
        settingRows: SETTING_ROWS.slice(0, 4),
        categoryChannels: CATEGORIES,
        flash: FLASH,
      }),
    },
    {
      name: "Digest",
      html: renderDigestPage({
        ...COMMON,
        enabled: true,
        cron: "0 16 * * 5",
        minActiveMinutes: 60,
        streakMinMinutes: 15,
        includeAchievements: true,
        preview: {
          generatedAt: "2026-01-09 16:00",
          weekRange: "2026-01-02 – 2026-01-08",
          qualifying: 3,
          optedIn: 2,
          skippedOptOut: 1,
          alreadySentAt: null,
          includeAchievements: true,
          limit: 10,
          entries: [
            {
              username: "alice",
              rank: 1,
              title: "Your week in voice",
              description: "5 hr 12 min across 9 sessions.",
              fields: [{ name: "Streak", value: "4 days", inline: true }],
              footer: "Reply /digest off to opt out.",
            },
          ],
        },
        flash: FLASH,
      }),
    },
    {
      name: "Command audit",
      html: renderCommandAuditPage({
        ...COMMON,
        enabled: true,
        retentionDays: 30,
        commandOptions: ["ping", "quote"],
        userOptions: [{ id: "u1", label: "alice" }],
        filters: { commandName: "", userId: "", result: "", from: "", to: "" },
        rows: [
          {
            createdAt: "2026-01-09 12:00",
            discordUserId: "u1",
            userLabel: "alice",
            commandName: "quote",
            subcommand: "add",
            channelId: "c1",
            channelLabel: "general",
            result: "success",
            errorMessage: null,
            durationMs: 42,
          },
          {
            createdAt: "2026-01-09 12:01",
            discordUserId: "u1",
            userLabel: "alice",
            commandName: "warn",
            subcommand: null,
            channelId: null,
            channelLabel: null,
            result: "denied",
            errorMessage: "missing role",
            durationMs: 3,
          },
        ],
        total: 2,
        page: 1,
        pageSize: 50,
      }),
    },
    {
      name: "Moderation",
      html: renderModerationPage({
        ...COMMON,
        enabled: true,
        actionOptions: ["warn", "kick", "ban"],
        userOptions: [{ id: "u1", label: "alice" }],
        filters: { action: "", userId: "" },
        rows: [
          {
            createdAt: "2026-01-09 12:00",
            userId: "u1",
            userLabel: "alice",
            moderatorId: "u2",
            moderatorLabel: "bob",
            action: "warn",
            reason: "spam",
            source: "command",
          },
        ],
        total: 1,
        page: 1,
        pageSize: 50,
      }),
    },
    {
      name: "Command metrics",
      html: renderCommandMetricsPage({
        ...COMMON,
        enabled: true,
        retentionDays: 30,
        windowDays: 7,
        totalUsage: 120,
        totalErrors: 4,
        rows: [
          {
            command: "quote",
            usageCount: 100,
            errorCount: 2,
            errorRate: 0.02,
            avgResponseMs: 41.2,
            lastUsedAt: "2026-01-09",
          },
          {
            command: "seen",
            usageCount: 20,
            errorCount: 2,
            errorRate: 0.1,
            avgResponseMs: 88,
            lastUsedAt: null,
          },
        ],
        dailyTotals: [{ date: "2026-01-09", usageCount: 20, errorCount: 1 }],
      }),
    },
    {
      name: "Analytics",
      html: renderAnalyticsPage({
        ...COMMON,
        enabled: true,
        windowDays: 30,
        heatmap: {
          matrix: Array.from({ length: 7 }, (_, d) =>
            Array.from({ length: 24 }, (_, h) => (d + h) % 5),
          ),
          byHour: Array.from({ length: 24 }, (_, h) => h),
          byDay: Array.from({ length: 7 }, (_, d) => d * 10),
          totalMinutes: 500,
          peak: { day: 5, hour: 20, minutes: 90 },
          timeZone: "Europe/Stockholm",
        },
      }),
    },
  ];
}

/** Every `/me` member-facing page, rendered through the user layout. */
export function userPages(): A11yPage[] {
  const shell = (title: string, active: string, body: string): string =>
    renderUserPage({
      title,
      active,
      body,
      csrfToken: COMMON.csrfToken,
      remainingMs: COMMON.remainingMs,
      isAdmin: true,
      flash: { type: "ok", text: "Preferences saved." },
    });

  return [
    {
      name: "/me overview",
      html: shell(
        "Overview",
        "/me/",
        renderUserIndexBody({
          discordUserId: "u1",
          guildId: "g1",
          isAdmin: true,
          rewindEnabled: true,
          presetsEnabled: false,
          birthdayEnabled: true,
          pollParticipation: {
            totalVotes: 12,
            thisYearVotes: 4,
            thisWeekVotes: 1,
            lastVoted: "2026-01-07",
          },
        }),
      ),
    },
    {
      name: "/me notifications",
      html: shell(
        "Notifications",
        "/me/notifications",
        renderUserNotificationsBody({
          csrfToken: COMMON.csrfToken,
          rows: [
            {
              key: "digest",
              label: "Weekly digest",
              description: "Your week in voice, every Friday.",
              enabled: true,
            },
            {
              key: "birthday",
              label: "Birthday wishes",
              description: "A DM on your birthday.",
              enabled: false,
              comingSoon: "Coming soon",
            },
          ],
        }),
      ),
    },
    {
      name: "/me birthday",
      html: shell(
        "Birthday",
        "/me/birthday",
        renderUserBirthdayBody({
          csrfToken: COMMON.csrfToken,
          selected: { month: 4, day: 12, year: null },
          featureEnabled: false,
        }),
      ),
    },
    {
      name: "/me timezone",
      html: shell(
        "Timezone",
        "/me/timezone",
        renderUserTimezoneBody({
          csrfToken: COMMON.csrfToken,
          zones: ["Europe/Stockholm", "Europe/London", "UTC"],
          selected: "Europe/Stockholm",
          serverTimezone: "UTC",
        }),
      ),
    },
    {
      name: "/me voice",
      html: shell(
        "Voice",
        "/me/voice",
        renderUserVoiceBody({
          csrfToken: COMMON.csrfToken,
          namePattern: "{user}'s room",
          displayName: "Alice",
          presets: [
            {
              index: 0,
              name: "Chill",
              channelName: "Chill zone",
              userLimit: null,
              bitrate: null,
              isDefault: true,
            },
          ],
          maxPerUser: 5,
          featureEnabled: true,
        }),
      ),
    },
    {
      name: "/me rewind",
      html: shell("Rewind", "/me/rewind", renderUserRewindBody(REWIND)),
    },
  ];
}

/** The pre-auth / error shell pages from `views.ts`. */
export function preAuthPages(): A11yPage[] {
  return [
    {
      name: "Consent",
      html: renderConsent({ token: "tok", csrfToken: COMMON.csrfToken }),
    },
    { name: "Signed out", html: renderSignedOut() },
    { name: "Invalid link", html: renderInvalidLink() },
    {
      name: "Error page",
      html: renderErrorPage({
        title: "Not authorised",
        heading: "Not authorised",
        bodyHtml:
          "<p>Run <code>/config</code> in Discord to get a fresh sign-in link.</p>",
      }),
    },
  ];
}

const REWIND = {
  year: 2026,
  availableYears: [2025, 2026],
  hasData: true,
  totalDuration: "42 hr 10 min",
  funComparison: "That's 14 feature films.",
  sessionCount: 87,
  daysActive: 51,
  topCompanions: [{ userId: "u2", displayName: "bob", duration: "9 hr" }],
  peakDay: { date: "2026-01-03", duration: "4 hr 20 min" },
  longestSession: {
    duration: "3 hr 5 min",
    date: "2026-01-03",
    channelName: "Lounge",
  },
  longestStreakDays: 6,
  longestStreakRange: { startDate: "2026-01-01", endDate: "2026-01-06" },
  accolades: [
    {
      emoji: "🌙",
      name: "Night owl",
      description: "Most active after midnight.",
      earnedAt: "2026-01-05",
    },
  ],
  achievements: [
    {
      emoji: "🏅",
      name: "Regular",
      description: "Active 50 days this year.",
      earnedAt: "2026-01-08",
    },
  ],
  annualRank: 3,
  annualGuildMembers: 120,
  percentAboveMedian: 180,
  weeklyJourney: {
    first: { isoYear: 2026, isoWeek: 1, rank: 12 },
    last: { isoYear: 2026, isoWeek: 6, rank: 3 },
    best: { isoYear: 2026, isoWeek: 5, rank: 2 },
  },
  messagesSent: 430,
  topTextChannels: [{ channelId: "c1", channelName: "general", count: 300 }],
  peakMessageDay: { date: "2026-01-04", count: 60 },
  reactionsGiven: 90,
  reactionsReceived: 120,
  hourOfDayDistribution: Array.from({ length: 24 }, (_, h) => h * 3),
  dayOfWeekDistribution: Array.from({ length: 7 }, (_, d) => d * 20),
  pollVotesCast: 12,
};

/** Every page the a11y gate scans. */
export function allPages(): A11yPage[] {
  return [...adminPages(), ...userPages(), ...preAuthPages()];
}
