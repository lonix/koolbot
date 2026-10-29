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

import { ChannelType, PermissionFlagsBits } from "discord.js";
import { settingsMetadata } from "../../src/services/config-schema.js";
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
  renderLeaderboardRolesPage,
  renderEventsPage,
  renderImportDiffPage,
  renderModerationPage,
  renderNoticesPage,
  renderPermissionsPage,
  renderPollsPage,
  renderTicketsPage,
  renderQuotesPage,
  renderBirthdaysPage,
  renderReactionRolesPage,
  renderSettingsPage,
  renderVoiceChannelsPage,
  renderWizardConfirmPage,
  renderWizardPage,
  renderWizardStepPage,
  type SettingRow,
} from "../../src/web/admin-views.js";
import { renderEventPresetsPage } from "../../src/web/event-presets-page.js";
import {
  renderHostEventsPage,
  type HostEventListRow,
} from "../../src/web/me-events-page.js";
import { renderMyEventPresetsBody } from "../../src/web/me-event-presets-page.js";
import {
  renderModAuditBody,
  renderModCaseBody,
  renderModCaseMissingBody,
  renderModLogBody,
  type ModLogBodyProps,
} from "../../src/web/me-moderation-page.js";
import type { CaseView } from "../../src/web/moderation-case-groups.js";
import { EVENT_GROUP_PRESETS } from "../../src/content/event-group-presets.js";
import {
  UPDATE_AVAILABLE,
  busyDashboard,
  calmDashboard,
} from "./dashboard-fixtures.js";
import { renderAdoptPage } from "../../src/web/adopt-view.js";
import { busyScan } from "./server-scan-fixtures.js";
import { channelsScan, scanChannel } from "./channels-scan-fixtures.js";
import { renderBotPermissionsPage } from "../../src/web/bot-permissions-view.js";
import { renderWizardAccessPage } from "../../src/web/wizard-access-view.js";
import type {
  BotPermissionReport,
  FeatureCheck,
  FeatureRef,
  PermissionTarget,
} from "../../src/services/bot-permission-check.js";
import {
  FEATURE_REQUIREMENTS,
  ROLE_HIERARCHY_REQUIREMENTS,
} from "../../src/services/bot-permission-registry.js";
import { renderRulesPage } from "../../src/web/rules-page.js";
import { renderChannelClaimsPage } from "../../src/web/channel-claims-view.js";
import { renderEventAdoptionPage } from "../../src/web/event-adoption-view.js";
import { renderBotCleanupPage } from "../../src/web/bot-cleanup-view.js";
import type { RemovedBotCandidate } from "../../src/services/bot-removal-cleanup.js";
import {
  renderAdminFixPage,
  renderRoleDeletePage,
  renderRoleGroupsPage,
} from "../../src/web/role-groups-views.js";
import { planned as plannedEventAdoption } from "./event-adoption-fixtures.js";
import {
  renderChannelDeleteConfirmPage,
  renderChannelManagerPage,
} from "../../src/web/channel-manager-view.js";
import {
  buildChannelTree,
  type ManagedChannelView,
} from "../../src/web/channel-manager.js";
import {
  renderAdoptionHistoryPage,
  renderRestoreConfirmPage,
} from "../../src/web/adoption-history-view.js";
import {
  renderUserBirthdayBody,
  renderUserIndexBody,
  renderUserNotificationsBody,
  renderUserPage,
  renderUserPrivacyBody,
  renderUserRewindBody,
  renderUserTimezoneBody,
  renderUserVoiceBody,
} from "../../src/web/user-layout.js";
import {
  renderHostPanelBody,
  type HostPanelEvent,
} from "../../src/web/host-panel-view.js";
import type { PermissionNotice } from "../../src/web/permission-notice.js";
import {
  renderEventEditBody,
  type EventEditView,
} from "../../src/web/event-edit-view.js";
import { renderNewEventBody } from "../../src/web/event-new-view.js";
import {
  refusedNewEventForm,
  renderAdminNewEventPage,
} from "../../src/web/admin-new-event-page.js";
import type { RefusedForm } from "../../src/web/form-errors.js";

/** The props a refused New event form adds, built the way the page's route builds them. */
function refusedNewEvent(refused: RefusedForm): {
  refusal: ReturnType<typeof refusedNewEventForm>["refusal"];
  values: ReturnType<typeof refusedNewEventForm>["values"];
  initialWhen: ReturnType<typeof refusedNewEventForm>["initialWhen"];
  groupRemembered: {
    prefill: ReturnType<typeof refusedNewEventForm>["groups"]["prefill"];
    resetHref: null;
    enabled: boolean;
  };
} {
  const v = refusedNewEventForm(refused, "Europe/Stockholm", 120);
  return {
    refusal: v.refusal,
    values: v.values,
    initialWhen: v.initialWhen,
    groupRemembered: {
      prefill: v.groups.prefill,
      resetHref: null,
      enabled: v.groups.enabled,
    },
  };
}
import {
  renderHostBoard,
  type HostBoardData,
} from "../../src/web/host-board-view.js";
import {
  renderConfirmBody,
  renderEventSettings,
  renderGroupChanges,
  type SettingsViewData,
} from "../../src/web/host-settings-view.js";
import { renderEndSection } from "../../src/web/event-end-view.js";
import {
  SHELL_NAV,
  type ShellNavItem,
  type ShellViewer,
} from "../../src/web/app-shell.js";
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

/** The per-feature permission notice (#1253): a missing permission, and a check that could not run. */
const MISSING_PERMISSION_NOTICE: PermissionNotice = {
  unavailable: null,
  stale: true,
  unchecked: [
    {
      feature: {
        id: "event-moves",
        area: "Events",
        feature: "Moving members between event channels",
        effect: "",
        fix: "",
      },
      target: { kind: "category", id: "gone", name: "gone" },
      note: "The configured category could not be found.",
    },
  ],
  missing: [
    {
      feature: {
        id: "event-channels",
        area: "Events",
        feature: "Event and group channels",
        effect:
          "Event voice channels and group channels are not created, deleted or put in order.",
        fix: "",
      },
      permissions: ["Manage Channels", "Move Members"],
      target: { kind: "category", id: "c1", name: "Events" },
    },
  ],
};
/**
 * The Events form notice (#1478): one finding with no field (the Events list
 * card) and one next to each of the group channels and the leaders-only
 * channel, plus a result that could not be checked, which stays in the block.
 */
const eventFeature = (id: string, feature: string, effect: string) => ({
  id,
  area: "Events",
  feature,
  effect,
  fix: "",
});
const EVENT_FORM_PERMISSION_NOTICE: PermissionNotice = {
  unavailable: null,
  stale: true,
  unchecked: [
    {
      feature: eventFeature(
        "event-tags",
        "Clan tags on nicknames",
        "Clan tags are not applied to nicknames and old tags are not restored.",
      ),
      target: { kind: "server", id: "g1", name: "Server" },
      note: "The bot's own membership could not be read.",
    },
  ],
  missing: [
    {
      feature: eventFeature(
        "event-native",
        "Discord Events list card",
        "Events get no card in Discord's Events list.",
      ),
      permissions: ["Create Events"],
      target: { kind: "server", id: "g1", name: "Server" },
    },
    {
      feature: eventFeature(
        "event-channels",
        "Event and group channels",
        "Event voice channels and group channels are not created, deleted or put in order.",
      ),
      permissions: ["Manage Channels"],
      target: { kind: "category", id: "c1", name: "Events" },
    },
    {
      feature: eventFeature(
        "event-leads-channel",
        "Leaders-only group channel",
        "A leaders-only channel is created without its restriction.",
      ),
      permissions: ["Manage Roles"],
      target: { kind: "category", id: "c1", name: "Events" },
    },
  ],
};
/** The Moderation page's notice (#1488): the anti-raid alert channel and a moderation log channel. */
const MODERATION_MISSING_PERMISSION_NOTICE: PermissionNotice = {
  unavailable: null,
  stale: true,
  unchecked: [
    {
      feature: {
        id: "log-moderation-review",
        area: "Discord logging",
        feature: "Moderation case review log channel",
        effect: "",
        fix: "",
      },
      target: { kind: "channel", id: "gone", name: "gone" },
      note: "The configured channel could not be found.",
    },
  ],
  missing: [
    {
      feature: {
        id: "raid-alerts",
        area: "Moderation",
        feature: "Anti-raid alerts",
        effect: "Raid alerts are not posted.",
        fix: "",
      },
      permissions: ["Send Messages"],
      target: { kind: "channel", id: "c1", name: "mod-alerts" },
    },
  ],
};
const UNAVAILABLE_PERMISSION_NOTICE: PermissionNotice = {
  unavailable: "The bot could not read this server from Discord.",
  stale: false,
  unchecked: [],
  missing: [],
};

/** The Quotes and Notices pages' notice (#1489): a missing permission in the bot-managed channel, and a check that could not run. */
const channelNotice = (
  id: string,
  area: string,
  feature: string,
  channel: string,
): PermissionNotice => ({
  unavailable: null,
  stale: true,
  unchecked: [],
  missing: [
    {
      feature: {
        id,
        area,
        feature,
        effect: `Messages in the ${area} channel are not handled.`,
        fix: "",
      },
      permissions: ["Send Messages", "Manage Messages"],
      target: { kind: "channel", id: "c1", name: channel },
    },
  ],
});
const QUOTES_MISSING_PERMISSION_NOTICE = channelNotice(
  "quotes-post",
  "Quotes",
  "Posting quotes",
  "quotes",
);
const NOTICES_MISSING_PERMISSION_NOTICE = channelNotice(
  "notices-post",
  "Notices",
  "Posting notices",
  "rules",
);

/** The role pages' notice (#1490): a missing permission in the picker channel, a role above the bot, and a hierarchy that could not be read. */
const roleFeature = (id: string, area: string, feature: string) => ({
  id,
  area,
  feature,
  effect: `${feature} does not work.`,
  fix: "",
});
const REACTION_ROLES_MISSING_PERMISSION_NOTICE: PermissionNotice = {
  unavailable: null,
  stale: true,
  unchecked: [],
  missing: [
    {
      feature: roleFeature(
        "reaction-picker-post",
        "Reaction roles",
        "Posting the role pickers",
      ),
      permissions: ["Send Messages", "Embed Links"],
      target: { kind: "channel", id: "c1", name: "roles" },
    },
    {
      feature: roleFeature(
        "reaction-roles",
        "Reaction roles",
        "Handing out roles",
      ),
      permissions: ["Manage Roles"],
      target: { kind: "server", id: null, name: "the server" },
    },
  ],
};
const ROLE_GROUPS_MISSING_PERMISSION_NOTICE: PermissionNotice = {
  unavailable: null,
  stale: false,
  unchecked: [],
  missing: [
    {
      feature: roleFeature(
        "role-groups",
        "Role groups",
        "Managing role groups",
      ),
      permissions: ["Manage Roles"],
      target: { kind: "server", id: null, name: "the server" },
    },
    {
      feature: roleFeature(
        "log-role-groups",
        "Discord logging",
        "Role groups log channel",
      ),
      permissions: ["Embed Links"],
      target: { kind: "channel", id: "c1", name: "role-log" },
    },
  ],
};
const LEADERBOARD_ROLES_MISSING_PERMISSION_NOTICE: PermissionNotice = {
  unavailable: null,
  stale: false,
  missing: [
    {
      feature: roleFeature(
        "leaderboard-roles-hierarchy",
        "Leaderboard roles",
        "Handing out leaderboard roles",
      ),
      permissions: ["Bot role below this role"],
      target: { kind: "role", id: "r1", name: "Admin" },
    },
  ],
  unchecked: [
    {
      feature: roleFeature(
        "leaderboard-roles-hierarchy",
        "Leaderboard roles",
        "Handing out leaderboard roles",
      ),
      target: { kind: "role", id: "r9", name: "r9" },
      note: "The configured role could not be found.",
    },
  ],
};

/** The Birthdays and Rules pages' notice (#1491): a missing permission, and an unreadable role position. */
const BIRTHDAYS_MISSING_PERMISSION_NOTICE = channelNotice(
  "birthdays-post",
  "Birthdays",
  "Birthday announcements",
  "general",
);
const RULES_MISSING_PERMISSION_NOTICE: PermissionNotice = {
  unavailable: null,
  stale: false,
  unchecked: [
    {
      feature: {
        id: "rules-role-hierarchy",
        area: "Rules",
        feature: "Granting the acceptance role",
        effect: "",
        fix: "",
      },
      target: { kind: "role", id: "100000000000000011", name: "Accepted" },
      note: "The bot's own roles could not be read.",
    },
  ],
  missing: [
    {
      feature: {
        id: "rules-message",
        area: "Rules",
        feature: "The rules message",
        effect: "Posting the rules message fails.",
        fix: "",
      },
      permissions: ["Read Message History"],
      target: { kind: "channel", id: "100000000000000010", name: "rules" },
    },
  ],
};

/** The bot's reaction-role messages as the welcome roles picker lists them (#1433). */
const WELCOME_MESSAGES = {
  options: [
    {
      messageId: "100000000000000001",
      label: "# roles · 🎮 Gamer, 🎨 Artist",
    },
    { messageId: "100000000000000002", label: "# roles · 📚 Reader" },
  ],
  truncated: false,
};

/** A Settings group holding the welcome roles message row, `current` stored. */
function WELCOME_ROLES_GROUP(current: string): {
  category: string;
  rows: SettingRow[];
} {
  return {
    category: "welcome",
    rows: [
      {
        key: "welcome.roles_message_id",
        label: "Self-assign roles message",
        current,
        defaultValue: "",
        type: "string",
        description:
          "Optional reaction-role message that {roles} links to, picked from the messages the bot posted.",
        category: "welcome",
        format: "reaction_role_message",
      },
    ],
  };
}

/** A bot-permission report from real registry ids, so the matrix joins to the registry. */
function botPermissionReport(kind: "ok" | "mixed"): BotPermissionReport {
  const ref = (id: string): FeatureRef => {
    const r =
      FEATURE_REQUIREMENTS.find((x) => x.id === id) ??
      ROLE_HIERARCHY_REQUIREMENTS.find((x) => x.id === id);
    if (!r) throw new Error(`no registry entry ${id}`);
    return {
      id: r.id,
      area: r.area,
      feature: r.feature,
      effect: r.effect,
      fix: r.fix,
    };
  };
  const server: PermissionTarget = {
    kind: "server",
    id: null,
    name: "Test Guild",
  };
  const events: PermissionTarget = {
    kind: "category",
    id: "c1",
    name: "Events",
    channelType: ChannelType.GuildCategory,
  };
  const quotes: PermissionTarget = {
    kind: "channel",
    id: "c3",
    name: "quotes",
    channelType: ChannelType.GuildText,
  };
  // A voice room, a channel the bot cannot find and a role: every kind the
  // "Where" cell labels (#1394).
  const lobby: PermissionTarget = {
    kind: "channel",
    id: "c5",
    name: "Lobby",
    channelType: ChannelType.GuildVoice,
  };
  const gone: PermissionTarget = {
    kind: "channel",
    id: "999000111",
    name: "999000111",
  };
  const check = (
    id: string,
    outcome: FeatureCheck["outcome"],
    target: PermissionTarget | null,
    enabled = true,
    missing: string[] = [],
  ): FeatureCheck => ({
    feature: ref(id),
    kind: "permission",
    enabled,
    outcome,
    target,
    missing,
  });
  const base = {
    available: true,
    reason: null,
    fresh: true,
    problems: [],
    unknown: [],
    quiet: [],
    okFeatures: [],
    notes: [],
  };
  if (kind === "ok") {
    return {
      ...base,
      checks: [
        check("event-tags", "ok", server),
        check("event-channels", "ok", events),
        check("quotes-post", "ok", quotes),
        check("voice-lobby", "ok", lobby),
        check("reaction-roles", "ok", server, false),
      ],
    };
  }
  return {
    ...base,
    problems: [
      {
        permission: "Manage Nicknames",
        target: server,
        features: [ref("event-tags")],
      },
      {
        permission: "Send Messages",
        target: quotes,
        features: [ref("quotes-post"), ref("log-moderation")],
      },
    ],
    unknown: [
      {
        feature: ref("voice-rooms"),
        target: { kind: "category", id: "c2", name: "Voice" },
        note: "The configured category could not be found.",
      },
    ],
    notes: ["Polls are on but no channel is set."],
    checks: [
      check("event-tags", "missing", server, true, ["Manage Nicknames"]),
      check("event-channels", "ok", events),
      check("quotes-post", "missing", quotes, true, ["Send Messages"]),
      check("log-moderation", "missing", quotes, true, ["Send Messages"]),
      check("raid-alerts", "unknown", {
        kind: "channel",
        id: "c4",
        name: "raid-alerts",
        channelType: ChannelType.GuildText,
      }),
      check("lfg-post", "unknown", gone),
      check("voice-lobby", "ok", lobby),
      {
        feature: ref("rules-role-hierarchy"),
        kind: "role-position",
        enabled: true,
        outcome: "ok",
        target: { kind: "role", id: "r9", name: "Members" },
        missing: [],
      },
      check("notices-pin", "ok", quotes, false),
      check("event-moves", "unchecked", null),
      check("voice-rooms", "unknown", {
        kind: "category",
        id: "c2",
        name: "Voice",
        channelType: ChannelType.GuildCategory,
      }),
      check("reaction-roles", "ok", server, false),
    ],
  };
}

const MANAGER_CHANNELS: ManagedChannelView[] = [
  {
    id: "100000000000000001",
    name: "Community",
    kind: "category",
    typeLabel: "category",
    parentId: null,
    position: 0,
    topic: null,
    userLimit: null,
    bitrate: null,
  },
  {
    id: "100000000000000002",
    name: "general",
    kind: "text",
    typeLabel: "text",
    parentId: "100000000000000001",
    position: 0,
    topic: "Say hi",
    userLimit: null,
    bitrate: null,
  },
  {
    id: "100000000000000003",
    name: "Lobby",
    kind: "voice",
    typeLabel: "voice",
    parentId: "100000000000000001",
    position: 1,
    topic: null,
    userLimit: 5,
    bitrate: 64000,
  },
  {
    id: "100000000000000004",
    name: "welcome-stage",
    kind: "other",
    typeLabel: "GuildStageVoice",
    parentId: null,
    position: 2,
    topic: null,
    userLimit: null,
    bitrate: null,
  },
];

/** The Role groups page the refused-form fixtures start from (#1523). */
const ROLE_GROUPS_REFUSED_BASE = {
  ...COMMON,
  groups: [
    {
      id: "g1",
      name: "Mods",
      roleId: "r1",
      rank: 2,
      permissions: "0",
      capabilities: ["staff"],
      colour: null,
      hoist: false,
      createdByKoolbot: false,
      gateOnly: false,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      roleName: "Moderator",
      unlinked: false,
      lostRoleId: null,
      recreateRequestedAt: null,
      syncPolicy: null,
      driftSignature: null,
      roleMissing: false,
      memberCount: 3,
      roleLock: null,
      drift: [],
    },
  ],
  roleOptions: [
    { id: "r1", name: "Moderator", memberCount: 3, lock: null, taken: true },
    { id: "r3", name: "Helpers", memberCount: 5, lock: null, taken: false },
  ],
  plan: null,
  extraErrors: [],
  botScanUnavailable: false,
  botsMissing: 0,
  adminReport: { humans: [], bots: [] },
  adminGroupLacksAdministrator: false,
  membersUnavailable: false,
  roleNames: {},
  globalPolicy: "flag",
} as const;

function channelManagerPages(): A11yPage[] {
  const base = {
    ...COMMON,
    navFeatureStatus: {},
    channels: MANAGER_CHANNELS,
    tree: buildChannelTree(MANAGER_CHANNELS),
    protection: new Map([
      ["100000000000000003", ["the voicechannels.lobby.channel_id setting"]],
    ]),
    botCanManage: true,
    maxBitrate: 96000,
  };
  const lobby = MANAGER_CHANNELS[2];
  const general = MANAGER_CHANNELS[1];
  return [
    { name: "Channel manager", html: renderChannelManagerPage(base) },
    {
      name: "Channel manager (no Manage Channels)",
      html: renderChannelManagerPage({ ...base, botCanManage: false }),
    },
    {
      name: "Channel manager (server unreadable)",
      html: renderChannelManagerPage({
        ...base,
        channels: null,
        tree: null,
        protection: null,
        error: "Discord couldn't be reached.",
      }),
    },
    {
      name: "Channel delete confirmation",
      html: renderChannelDeleteConfirmPage({
        ...COMMON,
        navFeatureStatus: {},
        channel: general,
        verdict: { ok: true },
        confirmToken: "token",
        botCanManage: true,
      }),
    },
    {
      name: "Channel delete refused",
      html: renderChannelDeleteConfirmPage({
        ...COMMON,
        navFeatureStatus: {},
        channel: lobby,
        verdict: {
          ok: false,
          reasons: ["the voicechannels.lobby.channel_id setting"],
          message:
            'KoolBot manages "Lobby": it is the voicechannels.lobby.channel_id setting.',
        },
        confirmToken: "token",
        botCanManage: true,
      }),
    },
    {
      name: "Channel manager (create form refused)",
      html: renderChannelManagerPage({
        ...base,
        refusedForm: {
          formId: "channel-create",
          errors: {
            name: "The name is 101 characters; Discord allows at most 100.",
            userLimit: "The user limit can be at most 99 (0 means no limit).",
          },
          values: {
            type: "voice",
            name: "x".repeat(101),
            userLimit: "100",
            bitrate: "64",
            parent: "100000000000000001",
          },
        },
      }),
    },
    {
      name: "Channel manager (edit form refused)",
      html: renderChannelManagerPage({
        ...base,
        refusedForm: {
          formId: `channel-edit-${general.id}`,
          errors: {
            topic: "The topic is 1030 characters; Discord allows at most 1024.",
          },
          values: {
            orig_name: general.name,
            orig_topic: general.topic ?? "",
            orig_parent: general.parentId ?? "",
            name: general.name,
            topic: "t".repeat(1030),
            parent: general.parentId ?? "",
          },
        },
      }),
    },
  ];
}

const ADOPTION_SNAPSHOT = {
  id: "a".repeat(24),
  planId: "plan-1",
  appliedBy: "123456789",
  status: "applied" as const,
  createdAt: new Date("2026-10-01T10:00:00Z"),
  rolledBackBy: null,
  rolledBackAt: null,
  applied: 3,
  failed: 0,
  skipped: 1,
  destructive: 1,
  createdRoles: 2,
};

const CHANNELS = [
  { id: "c1", name: "general", type: ChannelType.GuildText },
  { id: "c2", name: "announcements", type: ChannelType.GuildAnnouncement },
];
const VOICE_CHANNELS = [
  {
    id: "v1",
    name: "Lounge",
    type: ChannelType.GuildVoice,
    parentName: "Voice Channels",
  },
];
const CATEGORIES = [
  { id: "cat1", name: "Voice Channels", type: ChannelType.GuildCategory },
];
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

/**
 * Rows for the nested-dependents state of the Settings page (#1318): a changed
 * three-option enum (segmented control, with a reset button), a locked child
 * nested under its off parent, and a child whose parent is on another card
 * (no control, a "requires" note). Real schema keys, because the dependency
 * graph comes from the schema.
 */
const NESTED_GROUPS: Array<{ category: string; rows: SettingRow[] }> = [
  {
    category: "voicetracking",
    rows: [
      {
        key: "voicetracking.enabled",
        label: "Voice tracking",
        current: false,
        defaultValue: false,
        type: "boolean",
        description: "Track time spent in voice channels.",
        category: "voicetracking",
      },
      {
        key: "voicetracking.announcements.enabled",
        label: "Announcements",
        current: true,
        defaultValue: false,
        type: "boolean",
        description: "Announce milestones in a channel.",
        category: "voicetracking",
      },
    ],
  },
  {
    category: "leaderboard_roles",
    rows: [
      {
        key: "leaderboard_roles.period",
        label: "Period",
        current: "week",
        defaultValue: "alltime",
        type: "string",
        description: "Which window the leaderboard covers.",
        category: "leaderboard_roles",
        options: [
          { value: "week", label: "This week" },
          { value: "month", label: "This month" },
          { value: "alltime", label: "All time" },
        ],
      },
    ],
  },
  {
    category: "digest",
    rows: [
      {
        key: "digest.include_achievements",
        label: "Include achievements",
        current: true,
        defaultValue: false,
        type: "boolean",
        description: "Add achievements to the weekly digest.",
        category: "digest",
      },
    ],
  },
];

/** Props for the Channel Claims page; `over` swaps in a previewed plan. */
function claimsProps(
  over: Partial<Parameters<typeof renderChannelClaimsPage>[0]> = {},
): Parameters<typeof renderChannelClaimsPage>[0] {
  return {
    ...COMMON,
    navFeatureStatus: {},
    groups: [],
    claims: [],
    problems: [],
    previewToken: null,
    plan: null,
    scan: {
      guildName: "Guild",
      guildId: "g",
      scanned: {
        botRoleIds: [],
        botHighestRolePosition: 50,
        roles: [
          { id: "r1", permissions: "0", position: 3 },
          { id: "r2", permissions: "8", position: 4 },
        ],
      },
      webhooks: {
        known: true,
        unavailable: null,
        list: [{ id: "w1", name: "bridge", channelId: "11", kind: "incoming" }],
      },
      roles: [
        {
          id: "r1",
          name: "Mod",
          position: 3,
          managed: false,
          isEveryone: false,
          botId: null,
          usedBy: [],
        },
        {
          id: "r2",
          name: "Admins",
          position: 4,
          managed: false,
          isEveryone: false,
          botId: null,
          usedBy: [],
        },
      ],
      channels: [
        {
          id: "10",
          name: "Games",
          kind: "category",
          typeName: "GuildCategory",
          parentId: null,
          position: 0,
          usedBy: [],
          gatedByRoleIds: ["r1"],
          syncedToParent: null,
          overwrites: [
            { id: "g", type: "role", allow: [], deny: ["ViewChannel"] },
            { id: "r1", type: "role", allow: ["ViewChannel"], deny: [] },
          ],
          flags: {},
        },
        {
          id: "20",
          name: "Staff",
          kind: "category",
          typeName: "GuildCategory",
          parentId: null,
          position: 2,
          usedBy: [],
          gatedByRoleIds: ["r2"],
          syncedToParent: null,
          overwrites: [
            { id: "g", type: "role", allow: [], deny: ["ViewChannel"] },
            { id: "r2", type: "role", allow: ["ViewChannel"], deny: [] },
          ],
          flags: {},
        },
        {
          id: "11",
          name: "news",
          kind: "text",
          typeName: "GuildText",
          parentId: "10",
          position: 1,
          usedBy: [],
          gatedByRoleIds: [],
          syncedToParent: true,
          overwrites: [],
          flags: {},
        },
      ],
      naming: { suggestedPrefix: null },
    } as never,
    ...over,
  };
}

/** A previewed plan with an additive and a destructive step (#1184). */
const CLAIMS_DESTRUCTIVE_PLAN = {
  scan: null,
  groups: [],
  errors: [],
  warnings: [],
  claims: [],
  plan: {
    id: "plan-1",
    guildId: "g",
    plannedBy: "a",
    operations: [
      {
        id: "op-1",
        type: "overwrite.set",
        class: "additive",
        channelId: "11",
        overwriteTargetId: "g",
        overwriteTargetType: "role",
        allow: "0",
        deny: "1024",
        summary: 'Edit overwrite on "news"',
        targetId: "11",
        before: { allow: "0", deny: "0" },
        after: { allow: "0", deny: "1024" },
      },
      {
        id: "op-2",
        type: "overwrite.remove",
        class: "destructive",
        channelId: "11",
        overwriteTargetId: "r1",
        approval: {
          kind: "overwrite.remove",
          targetId: "11:r1",
          approvedBy: "a",
          approvedAt: "2026-10-17T10:00:00.000Z",
        },
        summary: 'Remove overwrite on "news"',
        targetId: "11",
        before: { allow: "1024", deny: "0" },
        after: null,
      },
    ],
    warnings: [],
    errors: [],
    baseline: { absentRoleNames: [], roles: [], channels: [], config: {} },
  },
} as never;

/** Every authenticated admin page, rendered as a full document. */
export function adminPages(): A11yPage[] {
  return [
    {
      // Everything read, nothing to fix, and the update-available Version panel (#1029).
      name: "Dashboard",
      html: renderDashboardPage({
        ...COMMON,
        data: calmDashboard(),
        version: UPDATE_AVAILABLE,
      }),
    },
    {
      // Problems, a recent scan and sources that could not be read (#1322).
      name: "Dashboard with problems",
      html: renderDashboardPage({
        ...COMMON,
        data: busyDashboard(),
        version: { ...UPDATE_AVAILABLE, status: "error", lastError: "offline" },
      }),
    },
    {
      // The destructive section and the typed-name confirmation (#1184).
      name: "Role group deletion review",
      html: renderRoleDeletePage({
        ...COMMON,
        navFeatureStatus: {},
        groupId: "g1",
        groupName: "Moderators",
        plan: {
          id: "plan-1",
          guildId: "g",
          plannedBy: "a",
          operations: [
            {
              id: "op-1",
              type: "role.delete",
              class: "destructive",
              roleId: "r1",
              approval: {
                kind: "role.delete",
                targetId: "r1",
                approvedBy: "a",
                approvedAt: "2026-10-17T10:00:00.000Z",
              },
              summary: 'Delete role "Moderators"',
              targetId: "r1",
              before: { name: "Moderators", permissions: "8" },
              after: null,
            },
          ],
          warnings: [],
          errors: [],
          baseline: {
            absentRoleNames: [],
            roles: [],
            channels: [],
            config: {},
          },
        } as never,
        extraErrors: [],
        approvedAt: "2026-10-17T10:00:00.000Z",
        reviewToken: "review-token",
        confirmName: "Moderators",
        roleId: "r1",
        validForMinutes: 15,
      }),
    },
    {
      name: "Server scan (ready, overview)",
      html: renderAdoptPage({
        ...COMMON,
        navFeatureStatus: {},
        sampled: false,
        tab: "overview",
        scan: {
          guildId: "g1",
          guildName: "Guild",
          scannedAt: "2026-10-07T00:00:00Z",
          scanned: {} as never,
          roles: [
            {
              id: "r1",
              name: "Mod",
              color: 0,
              position: 3,
              managed: false,
              isEveryone: false,
              permissions: [],
              memberCount: 2,
              memberCountApproximate: false,
              botId: null,
              botCanManage: true,
              usedBy: [],
              onboardingManaged: false,
            },
          ],
          channels: [],
          bots: [],
          readiness: {
            botUserId: "b",
            botRoleIds: [],
            highestRoleId: null,
            highestRoleName: "KoolBot",
            highestRolePosition: 2,
            roleCount: 2,
            administrator: false,
            permissions: [
              {
                name: "ManageRoles",
                granted: true,
                purpose: "p",
                required: true,
              },
            ],
            rolesAboveBot: [],
            membersIntent: true,
            issues: [],
            ready: true,
          },
          community: {
            community: false,
            features: [],
            rulesChannelId: null,
            systemChannelId: null,
            publicUpdatesChannelId: null,
            onboardingEnabled: null,
            onboardingRoleIds: [],
            onboardingChannelIds: [],
            onboardingPrompts: [],
          },
          naming: {
            pattern: null,
            separator: null,
            confidence: 0,
            samples: [],
            categoryEmojiPrefix: false,
            suggestedPrefix: null,
            suggestedSuffix: null,
          },
          scheduledEvents: [],
          suggestions: [],
          webhooks: { known: true, list: [], unavailable: null },
          partial: [],
        },
      }),
    },
    {
      name: "Server scan (overview, with problems)",
      html: renderAdoptPage({
        ...COMMON,
        navFeatureStatus: {},
        sampled: true,
        tab: "overview",
        scan: busyScan(),
      }),
    },
    {
      name: "Server scan (roles, with problems)",
      html: renderAdoptPage({
        ...COMMON,
        navFeatureStatus: {},
        sampled: false,
        tab: "roles",
        scan: busyScan(),
      }),
    },
    {
      name: "Server scan (channels, with problems)",
      html: renderAdoptPage({
        ...COMMON,
        navFeatureStatus: {},
        sampled: false,
        tab: "channels",
        scan: busyScan(),
      }),
    },
    {
      // The tree: uncategorised channels, a category with its voice channel
      // last, Custom permissions, overwrites and Claim (#1364).
      name: "Server scan (channels, tree)",
      html: renderAdoptPage({
        ...COMMON,
        navFeatureStatus: {},
        sampled: true,
        tab: "channels",
        scan: channelsScan(),
      }),
    },
    {
      name: "Server scan (channels, could be claimed)",
      html: renderAdoptPage({
        ...COMMON,
        navFeatureStatus: {},
        sampled: false,
        tab: "channels",
        filter: "claimable",
        scan: channelsScan(),
      }),
    },
    {
      name: "Server scan (channels, nothing matches)",
      html: renderAdoptPage({
        ...COMMON,
        navFeatureStatus: {},
        sampled: false,
        tab: "channels",
        filter: "used",
        scan: {
          ...busyScan(),
          channels: [scanChannel({ id: "1", name: "general" })],
        },
      }),
    },
    {
      name: "Server scan (other bots, with problems)",
      html: renderAdoptPage({
        ...COMMON,
        navFeatureStatus: {},
        sampled: false,
        tab: "bots",
        scan: busyScan(),
      }),
    },
    {
      name: "Server scan (other bots, with a removed bot)",
      html: renderAdoptPage({
        ...COMMON,
        navFeatureStatus: {},
        sampled: false,
        tab: "bots",
        scan: removedBotScan(),
      }),
    },
    {
      name: "Bot cleanup (no removed bot)",
      html: renderBotCleanupPage({
        ...COMMON,
        navFeatureStatus: {},
        botId: null,
        candidates: [],
        planned: null,
        selectedChannelIds: [],
        sampled: false,
        approvedAt: null,
      }),
    },
    {
      name: "Bot cleanup (server could not be read)",
      html: renderBotCleanupPage({
        ...COMMON,
        navFeatureStatus: {},
        botId: null,
        candidates: null,
        planned: null,
        selectedChannelIds: [],
        sampled: false,
        approvedAt: null,
        error: "Discord couldn't be reached.",
      }),
    },
    {
      name: "Bot cleanup (bot chosen, nothing ticked)",
      html: renderBotCleanupPage({
        ...COMMON,
        navFeatureStatus: {},
        botId: REMOVED_BOT.userId,
        candidates: [REMOVED_BOT],
        planned: null,
        selectedChannelIds: [],
        sampled: true,
        nextAfter: "300000000000000009",
        unchecked: 1,
        approvedAt: null,
      }),
    },
    {
      // The preview with its destructive section and separate confirmation.
      name: "Bot cleanup (previewed plan)",
      html: renderBotCleanupPage({
        ...COMMON,
        navFeatureStatus: {},
        botId: REMOVED_BOT.userId,
        candidates: [REMOVED_BOT],
        planned: CLEANUP_PLAN,
        selectedChannelIds: ["11"],
        sampled: false,
        approvedAt: "2026-10-17T10:00:00.000Z",
      }),
    },
    {
      name: "Bot cleanup (plan refused)",
      html: renderBotCleanupPage({
        ...COMMON,
        navFeatureStatus: {},
        botId: REMOVED_BOT.userId,
        candidates: [REMOVED_BOT],
        planned: {
          ...(CLEANUP_PLAN as object),
          errors: [
            {
              code: "bot-still-present",
              message: "That bot is still in the server.",
            },
          ],
          plan: { ...(CLEANUP_PLAN as { plan: object }).plan, operations: [] },
        } as never,
        selectedChannelIds: ["11"],
        sampled: false,
        approvedAt: "2026-10-17T10:00:00.000Z",
      }),
    },
    {
      name: "Server scan (Discord, with problems)",
      html: renderAdoptPage({
        ...COMMON,
        navFeatureStatus: {},
        sampled: false,
        tab: "discord",
        scan: busyScan(),
      }),
    },
    {
      name: "Server scan (failed)",
      html: renderAdoptPage({
        ...COMMON,
        navFeatureStatus: {},
        sampled: false,
        tab: "overview",
        scan: null,
        error: "Discord couldn't be reached.",
      }),
    },
    ...channelManagerPages(),
    {
      name: "Adopt Discord events (preview)",
      html: renderEventAdoptionPage({
        ...COMMON,
        navFeatureStatus: {},
        planned: plannedEventAdoption(),
        previewing: true,
      }),
    },
    {
      name: "Adopt Discord events (missing bot permissions)",
      html: renderEventAdoptionPage({
        ...COMMON,
        navFeatureStatus: {},
        planned: plannedEventAdoption(),
        previewing: false,
        permissionNotice: EVENT_FORM_PERMISSION_NOTICE,
      }),
    },
    {
      name: "Adopt Discord events (bot permission check unavailable)",
      html: renderEventAdoptionPage({
        ...COMMON,
        navFeatureStatus: {},
        planned: plannedEventAdoption(),
        previewing: false,
        permissionNotice: UNAVAILABLE_PERMISSION_NOTICE,
      }),
    },
    {
      name: "Adopt Discord events (unreadable)",
      html: renderEventAdoptionPage({
        ...COMMON,
        navFeatureStatus: {},
        planned: null,
        error: "Discord couldn't be reached.",
        previewing: false,
      }),
    },
    {
      name: "Channel claims",
      html: renderChannelClaimsPage(claimsProps()),
    },
    {
      // Arriving from the Server scan's Claim link (#1364).
      name: "Channel claims with a prefilled feature",
      html: renderChannelClaimsPage(
        claimsProps({
          claims: [
            {
              channelId: "10",
              action: "leave",
              bindKey: "voicechannels.category_id",
            },
          ],
          prefill: {
            channelId: "10",
            channelName: "Games",
            featureLabel: "Voice channels category",
          },
        }),
      ),
    },
    {
      // Destructive section and its separate confirmation in the apply form.
      name: "Channel claims with a destructive plan",
      html: renderChannelClaimsPage(
        claimsProps({
          plan: CLAIMS_DESTRUCTIVE_PLAN,
          previewToken: "preview-token",
        }),
      ),
    },
    {
      // Plan preview under its own heading (#1184).
      name: "Administrators outside the admin group",
      html: renderAdminFixPage({
        ...COMMON,
        navFeatureStatus: {},
        plan: (CLAIMS_DESTRUCTIVE_PLAN as { plan: never }).plan,
        extraErrors: [],
        moveIds: ["u1"],
        dropIds: [],
        grant: false,
        losing: [],
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
              {
                key: "DISCORD_TOKEN",
                present: true,
                isSecret: true,
                display: "…ab12",
              },
              { key: "GUILD_ID", present: false, isSecret: false },
            ],
          },
        ],
      }),
    },
    {
      // The sidebar's "N turned off" list is only rendered when a feature is
      // off, so no other fixture puts it in front of axe (#1296).
      name: "Bootstrap (features switched off, list folded)",
      html: renderBootstrapPage({
        ...COMMON,
        navFeatureStatus: { "polls.enabled": false, "notices.enabled": false },
        groups: [
          {
            category: "Discord",
            rows: [{ key: "GUILD_ID", present: false, isSecret: false }],
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
      // The bot-permission notice at the top of two sections (#1487): welcome
      // messages with a missing permission, the log channels with a check that
      // could not run.
      name: "Settings (permission notice: missing, unavailable)",
      html: renderSettingsPage({
        ...COMMON,
        ...PICKERS,
        groups: [
          {
            category: "welcome",
            rows: [
              {
                key: "welcome.enabled",
                label: "Enable welcome messages",
                current: true,
                defaultValue: false,
                type: "boolean",
                description: "Greet new members in the welcome channel.",
                category: "welcome",
              },
            ],
          },
          {
            category: "core",
            rows: [
              {
                key: "core.errors.enabled",
                label: "Post errors to a channel",
                current: true,
                defaultValue: false,
                type: "boolean",
                description: "Post errors in the log channel.",
                category: "core",
              },
            ],
          },
        ],
        permissionNotices: {
          welcome: MISSING_PERMISSION_NOTICE,
          core: UNAVAILABLE_PERMISSION_NOTICE,
        },
        guildId: "g1",
        guildName: "Test Guild",
      }),
    },
    {
      name: "Settings (nested dependents, segmented control, reset)",
      html: renderSettingsPage({
        ...COMMON,
        ...PICKERS,
        groups: NESTED_GROUPS,
        guildId: "g1",
        guildName: "Test Guild",
      }),
    },
    {
      // The no-JavaScript render of a rejected save (#1517): the row is marked
      // and its line points at the failure flash, which is an alert.
      name: "Settings (a rejected row, failure flash)",
      html: renderSettingsPage({
        ...COMMON,
        ...PICKERS,
        groups: NESTED_GROUPS,
        guildId: "g1",
        guildName: "Test Guild",
        flash: {
          type: "err",
          text: "No changes saved — 1 invalid value in voicetracking: voicetracking.announcements.enabled (Turn on voicetracking first).",
        },
        invalidKeys: ["voicetracking.announcements.enabled"],
      }),
    },
    {
      // A bounded number box and bot-managed values: text with a jump link, no
      // field to submit (#1304).
      name: "Settings (bounded number, bot-managed message id)",
      html: renderSettingsPage({
        ...COMMON,
        ...PICKERS,
        groups: [
          {
            category: "quotes",
            rows: [
              {
                key: "quotes.max_length",
                label: "Maximum quote length (characters)",
                current: 500,
                defaultValue: 1000,
                type: "number",
                description: "Maximum length of a single quote in characters.",
                category: "quotes",
                min: 1,
                max: 4000,
              },
              {
                key: "quotes.header_message_id",
                label: "Header message ID (auto-managed)",
                current: "333333333333333333",
                defaultValue: "",
                type: "string",
                description:
                  "Auto-managed message ID of the quote channel header post.",
                category: "quotes",
                managed: { channelKey: "quotes.channel_id" },
                jumpUrl:
                  "https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333",
                repostHref: "/admin/quotes#repost-header",
              },
              {
                key: "rules.message_id",
                label: "Rules message ID",
                current: "",
                defaultValue: "",
                type: "string",
                description: "Managed by KoolBot.",
                category: "rules",
                managed: { channelKey: "rules.channel_id" },
              },
            ],
          },
        ],
        guildId: "g1",
        guildName: "Test Guild",
      }),
    },
    {
      // The number controls of #1427: a stepper, preset durations (one on a
      // preset, one on a custom value, one with its Off label) and a locked one.
      name: "Settings (stepper, duration presets)",
      html: renderSettingsPage({
        ...COMMON,
        ...PICKERS,
        groups: [
          {
            category: "events",
            rows: [
              {
                key: "events.groups.default_count",
                label: "Event groups offered by default",
                current: 2,
                defaultValue: 2,
                type: "number",
                description: "How many empty group rows the event form shows.",
                category: "events",
                min: 1,
                max: 25,
                stepper: true,
              },
              {
                key: "events.reminder_minutes",
                label: "Reminder lead time (minutes)",
                current: 30,
                defaultValue: 30,
                type: "number",
                description: "Minutes before an event starts.",
                category: "events",
                min: 0,
                max: 10080,
                presets: [0, 5, 10, 15, 30, 60],
                presetZeroLabel: "Off",
              },
              {
                key: "events.default_duration_minutes",
                label: "Default event duration (minutes)",
                current: 45,
                defaultValue: 120,
                type: "number",
                description: "Duration applied when none is given.",
                category: "events",
                min: 1,
                max: 1440,
                presets: [30, 60, 90, 120, 180],
              },
            ],
          },
        ],
        guildId: "g1",
        guildName: "Test Guild",
      }),
    },
    {
      // The pickers of #1426 in their normal states: a listed zone, a colour
      // and emoji prefixes, one of them empty.
      name: "Settings (timezone select, colour input, emoji fields)",
      html: renderSettingsPage({
        ...COMMON,
        ...PICKERS,
        groups: [
          {
            category: "events",
            rows: [
              {
                key: "events.timezone",
                label: "Event timezone (IANA)",
                current: "Europe/Oslo",
                defaultValue: "",
                type: "string",
                description:
                  "IANA timezone used to interpret the start time of an event. Empty falls back to the server timezone.",
                category: "events",
                format: "timezone",
              },
              {
                key: "events.channel_prefix",
                label: "Event channel name prefix",
                current: "📅",
                defaultValue: "",
                type: "string",
                description:
                  "Prefix prepended to the event title when naming the temporary voice channel.",
                category: "events",
                format: "affix",
              },
            ],
          },
          {
            category: "reactionroles",
            rows: [
              {
                key: "reactionroles.group_role_colour",
                label: "Generated group role colour",
                current: "#a95f55",
                defaultValue: "",
                type: "string",
                description:
                  "Colour given to roles the grouped-role generator creates.",
                category: "reactionroles",
                format: "colour",
              },
            ],
          },
          {
            category: "voicechannels",
            rows: [
              {
                key: "voicechannels.channel.prefix",
                label: "Per-user channel name prefix",
                current: "🎮",
                defaultValue: "",
                type: "string",
                description:
                  "Prefix prepended to dynamically created voice channel names.",
                category: "voicechannels",
                format: "affix",
              },
              {
                key: "voicechannels.channel.suffix",
                label: "Per-user channel name suffix",
                current: "",
                defaultValue: "",
                type: "string",
                description:
                  "Suffix appended to dynamically created voice channel names.",
                category: "voicechannels",
                format: "affix",
              },
            ],
          },
        ],
        guildId: "g1",
        guildName: "Test Guild",
      }),
    },
    {
      // The channel, category and role pickers (#1394) as the server renders
      // them, before the script runs: a native select in span.kb-picker with
      // optgroups, a voice setting, and a stored id that is not in the list.
      // The script-built states are scanned in channel-picker-a11y.test.ts.
      name: "Settings (channel, category and role pickers, stored id not listed)",
      html: renderSettingsPage({
        ...COMMON,
        ...PICKERS,
        groups: [
          {
            category: "voicechannels",
            rows: [
              {
                key: "voicechannels.lobby_channel_id",
                label: "Lobby channel",
                current: "v1",
                defaultValue: "",
                type: "channel",
                channelKind: "voice",
                description: "The channel members join to get their own room.",
                category: "voicechannels",
              },
              {
                key: "voicechannels.category_id",
                label: "Category",
                current: "999999999999999999",
                defaultValue: "",
                type: "category",
                description: "Category the managed channels are created in.",
                category: "voicechannels",
              },
              {
                key: "voicetracking.announcer_role",
                label: "Announcer role",
                current: "r2",
                defaultValue: "",
                type: "role",
                description: "Role pinged by the announcer.",
                category: "voicetracking",
              },
            ],
          },
        ],
        guildId: "g1",
        guildName: "Test Guild",
      }),
    },
    {
      // The welcome roles message picker (#1433): the bot's reaction-role
      // messages by label, and a stored id that is not among them.
      name: "Settings (welcome roles message picker, stored id not found)",
      html: renderSettingsPage({
        ...COMMON,
        ...PICKERS,
        groups: [WELCOME_ROLES_GROUP("999999999999999999")],
        reactionRoleMessages: WELCOME_MESSAGES,
        guildId: "g1",
        guildName: "Test Guild",
      }),
    },
    {
      // No reaction-role messages yet, the choice rejected on the last save:
      // the plain empty state points at the Reaction Roles page.
      name: "Settings (welcome roles message picker, none yet, rejected)",
      html: renderSettingsPage({
        ...COMMON,
        ...PICKERS,
        groups: [WELCOME_ROLES_GROUP("")],
        reactionRoleMessages: { options: [], truncated: false },
        guildId: "g1",
        guildName: "Test Guild",
        flash: { type: "err", text: "One value was rejected." },
        invalidKeys: ["welcome.roles_message_id"],
      }),
    },
    {
      name: "Setup wizard step (welcome roles message picker)",
      html: renderWizardStepPage({
        ...COMMON,
        ...PICKERS,
        stepIndex: 0,
        totalSteps: 1,
        featureKey: "welcome",
        settingKeys: ["welcome.enabled", "welcome.roles_message_id"],
        currentValues: {
          "welcome.enabled": true,
          "welcome.roles_message_id": "100000000000000001",
        },
        metadata: settingsMetadata,
        defaultValues: {
          "welcome.enabled": false,
          "welcome.roles_message_id": "",
        },
        reactionRoleMessages: {
          ...WELCOME_MESSAGES,
          truncated: true,
        },
        enabledByKey: { "welcome.enabled": true },
      }),
    },
    {
      // Values a picker cannot produce keep showing and saving as they are:
      // an old custom zone, a colour that is not #RRGGBB, a prefix that is not
      // an emoji, and the colour default (#1426).
      name: "Settings (pickers holding values they cannot produce, rejected)",
      html: renderSettingsPage({
        ...COMMON,
        ...PICKERS,
        groups: [
          {
            category: "events",
            rows: [
              {
                key: "events.timezone",
                label: "Event timezone (IANA)",
                current: "Mars/Olympus",
                defaultValue: "",
                type: "string",
                description:
                  "IANA timezone used to interpret the start time of an event. Empty falls back to the server timezone.",
                category: "events",
                format: "timezone",
              },
              {
                key: "events.channel_prefix",
                label: "Event channel name prefix",
                current: "[Events]",
                defaultValue: "",
                type: "string",
                description:
                  "Prefix prepended to the event title when naming the temporary voice channel.",
                category: "events",
                format: "affix",
              },
            ],
          },
          {
            category: "reactionroles",
            rows: [
              {
                key: "reactionroles.group_role_colour",
                label: "Generated group role colour",
                current: "red",
                defaultValue: "",
                type: "string",
                description:
                  "Colour given to roles the grouped-role generator creates.",
                category: "reactionroles",
                format: "colour",
              },
            ],
          },
          {
            category: "voicechannels",
            rows: [
              {
                key: "voicechannels.channel.suffix",
                label: "Per-user channel name suffix",
                current: "🎮 | ",
                defaultValue: "",
                type: "string",
                description:
                  "Suffix appended to dynamically created voice channel names.",
                category: "voicechannels",
                format: "affix",
              },
            ],
          },
        ],
        guildId: "g1",
        guildName: "Test Guild",
        flash: { type: "err", text: "One value was rejected." },
        invalidKeys: ["events.timezone", "reactionroles.group_role_colour"],
      }),
    },
    {
      name: "Setup wizard step (timezone and emoji settings)",
      html: renderWizardStepPage({
        ...COMMON,
        ...PICKERS,
        stepIndex: 0,
        totalSteps: 1,
        featureKey: "events",
        settingKeys: [
          "events.enabled",
          "events.timezone",
          "events.channel_prefix",
        ],
        currentValues: {
          "events.enabled": true,
          "events.timezone": "",
          "events.channel_prefix": "📅",
        },
        metadata: {
          "events.enabled": settingsMetadata["events.enabled"],
          "events.timezone": settingsMetadata["events.timezone"],
          "events.channel_prefix": settingsMetadata["events.channel_prefix"],
        },
        defaultValues: {
          "events.enabled": false,
          "events.timezone": "",
          "events.channel_prefix": "📅",
        },
        enabledByKey: { "events.enabled": true },
      }),
    },
    {
      // The state the save bar script leaves behind after two edits: the bar
      // shown with its count and Discard (#1330). The scripts do not run under
      // axe, so the markup is put in that state here.
      name: "Settings (save bar with unsaved changes)",
      html: renderSettingsPage({
        ...COMMON,
        ...PICKERS,
        groups: [{ category: "voicechannels", rows: SETTING_ROWS }],
        guildId: "g1",
        guildName: "Test Guild",
      })
        .split("Save your changes")
        .join("2 unsaved changes")
        .split(" data-savebar-discard hidden>")
        .join(" data-savebar-discard>"),
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
          {
            key: "polls.enabled",
            status: "pending",
            before: false,
            after: true,
          },
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
        // A group, "and above", and a reference to a deleted group exercise
        // every row kind of the role Picker (#1547).
        groups: [{ id: "g1", name: "Mods" }],
        groupRefsPerCommand: new Map([["quote", ["group:g1+", "group:gone"]]]),
        flash: FLASH,
      }),
    },
    {
      name: "Adoption history",
      html: renderAdoptionHistoryPage({
        ...COMMON,
        navFeatureStatus: {},
        flash: FLASH,
        jobId: "11111111-1111-1111-1111-111111111111",
        page: 2,
        hasMore: true,
        snapshots: [
          ADOPTION_SNAPSHOT,
          {
            ...ADOPTION_SNAPSHOT,
            id: "b".repeat(24),
            status: "rolled_back",
            rolledBackBy: "9",
            rolledBackAt: new Date("2026-10-02T10:00:00Z"),
          },
          {
            ...ADOPTION_SNAPSHOT,
            id: "c".repeat(24),
            status: "partial",
            failed: 1,
          },
          { ...ADOPTION_SNAPSHOT, id: "d".repeat(24), status: "rolling_back" },
        ],
      }),
    },
    {
      name: "Adoption history (empty)",
      html: renderAdoptionHistoryPage({
        ...COMMON,
        navFeatureStatus: {},
        snapshots: [],
      }),
    },
    {
      name: "Adoption history (unreadable)",
      html: renderAdoptionHistoryPage({
        ...COMMON,
        navFeatureStatus: {},
        snapshots: null,
      }),
    },
    {
      name: "Restore snapshot",
      html: renderRestoreConfirmPage({
        ...COMMON,
        navFeatureStatus: {},
        destructiveNote: "Messages and pins cannot be restored.",
        snapshot: {
          ...ADOPTION_SNAPSHOT,
          operations: [
            { summary: "Delete #old", destructive: true },
            { summary: "Make #news read-only", destructive: false },
          ],
          interrupted: 1,
          revertibleCreatedRoles: 1,
          uncertainCreatedRoles: 1,
          dependentRepairs: 2,
        },
      }),
    },
    {
      name: "Restore snapshot (nothing left, not restorable)",
      html: renderRestoreConfirmPage({
        ...COMMON,
        navFeatureStatus: {},
        destructiveNote: "n",
        snapshot: {
          ...ADOPTION_SNAPSHOT,
          status: "rolled_back",
          destructive: 0,
          createdRoles: 0,
          operations: [],
          interrupted: 0,
          revertibleCreatedRoles: 0,
          uncertainCreatedRoles: 0,
          dependentRepairs: 0,
        },
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
      name: "Setup wizard access",
      html: renderWizardAccessPage({
        ...COMMON,
        // "r-gone" is a saved role that can no longer be picked (#1547).
        selection: { admin: ["r-admin"], staff: ["r-mod", "r-gone"], host: [] },
        options: [
          { id: "r-admin", name: "Admins", managed: false, position: 8 },
          { id: "r-mod", name: "Moderator", managed: false, position: 5 },
          { id: "r-vip", name: "VIP", managed: false, position: 2 },
        ],
        gaps: [
          {
            feature: "events",
            scope: "host",
            message: "Events is on and nobody can host yet.",
          },
        ],
        flash: FLASH,
      }),
    },
    {
      name: "Setup wizard access, create Event host offered",
      html: renderWizardAccessPage({
        ...COMMON,
        selection: { admin: [], staff: [], host: [] },
        options: [
          { id: "r-mod", name: "Moderator", managed: false, position: 5 },
        ],
        gaps: [],
        hostCreate: { available: true },
        createHost: true,
      }),
    },
    {
      name: "Setup wizard access, create Event host refused",
      html: renderWizardAccessPage({
        ...COMMON,
        selection: { admin: [], staff: [], host: [] },
        options: [
          { id: "r-mod", name: "Moderator", managed: false, position: 5 },
        ],
        gaps: [],
        hostCreate: {
          available: false,
          reason: "permission",
          message:
            "The bot needs the Manage Roles permission to create a role. Give it that in Discord, or pick an existing role instead.",
        },
      }),
    },
    {
      name: "Setup wizard access, roles unavailable",
      html: renderWizardAccessPage({
        ...COMMON,
        selection: { admin: [], staff: [], host: [] },
        options: null,
        gaps: [],
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
        accessChanges: [
          {
            kind: "create",
            roleId: "r-mod",
            roleName: "Moderator",
            groupId: null,
            groupName: "Moderator",
            scopesBefore: [],
            scopesAfter: ["staff"],
            capabilitiesBefore: [],
            capabilitiesAfter: ["staff"],
          },
        ],
        accessGaps: [
          {
            feature: "events",
            scope: "host",
            message: "Events is on and nobody can host yet.",
          },
        ],
      }),
    },
    {
      name: "Setup wizard confirm, Event host role",
      html: renderWizardConfirmPage({
        ...COMMON,
        pending: [],
        metadata: {},
        accessChanges: [],
        hostRole: {
          planId: "0123456789abcdef01234567",
          operations: ['Create role "Event host"'],
          problems: [],
        },
      }),
    },
    {
      name: "Setup wizard confirm, Event host role blocked",
      html: renderWizardConfirmPage({
        ...COMMON,
        pending: [],
        metadata: {},
        accessChanges: [],
        hostRole: {
          planId: null,
          operations: [],
          problems: [
            "The bot needs the Manage Roles permission for these changes.",
          ],
        },
      }),
    },
    {
      name: "Setup wizard confirm, role mapping blocked",
      html: renderWizardConfirmPage({
        ...COMMON,
        pending: [],
        metadata: {},
        accessChanges: [],
        accessProblem: "A role you picked no longer exists in Discord.",
      }),
    },
    {
      name: "Announcements",
      html: renderAnnouncementsPage({
        ...COMMON,
        enabled: true,
        textChannels: CHANNELS,
        settingRows: [
          {
            key: "announcements.enabled",
            label: "Scheduled announcements enabled",
            current: true,
            defaultValue: false,
            type: "boolean",
            description: "Enable scheduled announcements.",
            category: "announcements",
          },
        ],
        rows: [
          {
            id: "a1",
            channelName: "general",
            channelType: ChannelType.GuildText,
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
      name: "Announcements (create form refused)",
      html: renderAnnouncementsPage({
        ...COMMON,
        enabled: true,
        textChannels: CHANNELS,
        settingRows: [
          {
            key: "announcements.enabled",
            label: "Scheduled announcements enabled",
            current: true,
            defaultValue: false,
            type: "boolean",
            description: "Enable scheduled announcements.",
            category: "announcements",
          },
        ],
        rows: [
          {
            id: "a1",
            channelName: "general",
            channelType: ChannelType.GuildText,
            cron: "0 9 * * 1",
            enabled: true,
            messagePreview: "Good morning!",
            embedTitle: null,
            placeholders: true,
            createdAt: "2026-01-01",
          },
        ],
        refusedForm: {
          formId: "announcement-create",
          errors: {
            cron: "Not a valid cron expression. Use five fields (minute hour day-of-month month day-of-week), for example 0 9 * * *.",
            embedColor: "Use six hex digits, for example #5865F2.",
          },
          values: {
            channelId: "c1",
            cron: "every monday",
            message: "Standup in 5 <minutes>",
            placeholders: "1",
            embedTitle: "Notice",
            embedColor: "blurple",
          },
        },
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
        settingRows: [
          {
            key: "events.timezone",
            label: "Event timezone (IANA)",
            current: "",
            defaultValue: "",
            type: "string",
            description:
              "IANA timezone used to interpret the start time of an event. Empty falls back to the server timezone.",
            category: "events",
            format: "timezone",
          },
          {
            key: "events.channel_prefix",
            label: "Event channel name prefix",
            current: "📅",
            defaultValue: "",
            type: "string",
            description:
              "Prefix prepended to the event title when naming the temporary voice channel.",
            category: "events",
            format: "affix",
          },
          {
            key: "events.enabled",
            label: "Events enabled",
            current: true,
            defaultValue: false,
            type: "boolean",
            description: "Enable scheduled events.",
            category: "events",
          },
          {
            key: "events.category_id",
            label: "Event channel category",
            current: "cat1",
            defaultValue: "",
            type: "category",
            description: "Category the temporary event voice channels go in.",
            category: "events",
          },
          {
            key: "events.announcement_channel_id",
            label: "Event announcement channel",
            current: "",
            defaultValue: "",
            type: "channel",
            description: "Channel where RSVP and reminder messages post.",
            category: "events",
          },
          {
            key: "events.reminder_minutes",
            label: "Reminder lead time (minutes)",
            current: 30,
            defaultValue: 30,
            type: "number",
            description: "How long before start the reminder is posted.",
            category: "events",
          },
        ],
        settingsPickers: {
          textChannels: CHANNELS,
          categoryChannels: CATEGORIES,
        },
        rows: [
          {
            // Live now (#1525): active and the start has arrived.
            id: "e0",
            title: "Open mic",
            when: "2026-01-31 19:00",
            state: "active",
            running: true,
            channelId: "c1",
            channelName: "Open mic",
            channelType: ChannelType.GuildVoice,
          },
          {
            id: "e1",
            title: "Game night",
            when: "2026-02-01 20:00",
            state: "scheduled",
            expected: {
              kind: "ok",
              count: 4,
              names: ["Alice", "Bob"],
              page: 0,
              hasMore: false,
            },
            legacyRsvps: { going: 4, maybe: 1, cant: 0 },
            channelId: "c1",
            channelName: "Game night",
            channelType: ChannelType.GuildVoice,
            groupCount: 3,
          },
          {
            id: "e2",
            title: "Old game night",
            when: "2026-03-01 20:00",
            state: "scheduled",
            // The channel was deleted: shown by its id as unavailable (#1394).
            channelId: "999000111",
            channelName: null,
            channelType: null,
          },
        ],
        flash: FLASH,
      }),
    },
    {
      name: "Events (past events folded, settings just saved)",
      html: renderEventsPage({
        ...COMMON,
        enabled: true,
        categoryConfigured: true,
        announcementConfigured: true,
        timezone: "Europe/Oslo",
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
          {
            key: "events.reminder_minutes",
            label: "Reminder lead time (minutes)",
            current: 45,
            defaultValue: 30,
            type: "number",
            description: "How long before start the reminder is posted.",
            category: "events",
          },
        ],
        rows: [
          {
            id: "e1",
            title: "Game night",
            when: "2099-02-01 20:00",
            state: "scheduled",
            channelId: null,
          },
          {
            id: "e2",
            title: "Last week's quiz",
            when: "2026-01-01 20:00",
            state: "ended",
            channelId: null,
          },
        ],
        flash: {
          type: "ok",
          text: "Saved 1 setting in events.",
          openSettings: true,
        },
      }),
    },
    {
      name: "Events (running events with End now)",
      html: renderEventsPage({
        ...COMMON,
        enabled: true,
        categoryConfigured: true,
        announcementConfigured: true,
        timezone: "UTC",
        settingRows: [],
        rows: [
          {
            id: "e1",
            title: "Quiz night",
            when: "2026-02-01 20:00",
            state: "active",
            running: true,
            channelId: "c1",
            groupCount: 2,
            hasGroupChannels: true,
          },
          {
            id: "e2",
            title: "Game night",
            when: "2026-02-02 20:00",
            state: "active",
            running: true,
            channelId: "c2",
          },
        ],
      }),
    },
    {
      name: "Events (missing bot permission notice)",
      html: renderEventsPage({
        ...COMMON,
        enabled: true,
        categoryConfigured: true,
        announcementConfigured: true,
        timezone: "UTC",
        settingRows: [],
        rows: [],
        permissionNotice: MISSING_PERMISSION_NOTICE,
      }),
    },
    {
      name: "Events (new event, missing bot permissions next to their fields)",
      html: renderAdminNewEventPage({
        ...COMMON,
        enabled: true,
        form: {
          csrfToken: COMMON.csrfToken,
          timezone: "UTC",
          defaultDurationMinutes: 120,
          groupLimits: { defaultCount: 2, maxCount: 15 },
          groupPresets: EVENT_GROUP_PRESETS,
          groupPresetsNotice: null,
          permissionNotice: EVENT_FORM_PERMISSION_NOTICE,
        },
      }),
    },
    {
      name: "Events (bot permission check unavailable)",
      html: renderEventsPage({
        ...COMMON,
        enabled: true,
        categoryConfigured: true,
        announcementConfigured: true,
        timezone: "UTC",
        settingRows: [],
        rows: [],
        permissionNotice: UNAVAILABLE_PERMISSION_NOTICE,
      }),
    },
    {
      name: "Events (new event, library presets, unreadable notice)",
      html: renderAdminNewEventPage({
        ...COMMON,
        enabled: true,
        form: {
          csrfToken: COMMON.csrfToken,
          timezone: "UTC",
          defaultDurationMinutes: 120,
          groupLimits: { defaultCount: 2, maxCount: 8 },
          groupPresets: [
            EVENT_GROUP_PRESETS[0],
            {
              id: "lib:0123456789abcdef01234567",
              label: "Clan match",
              description: "Five roles",
              groupLabel: "Squad",
              leaderLabel: "Lead",
              channelLeadMinutes: 30,
              groups: [
                { name: "Assault", kind: "team", size: 8, tag: "", marker: "" },
              ],
            },
          ],
          groupPresetsNotice:
            "The server's own presets could not be read, so only the built-in presets that are switched on are offered.",
        },
      }),
    },
    {
      // The group setup form (#1299): choice cards with some over the cap
      // (disabled), the nested options, the compact rows and the Advanced section.
      name: "Events (new event, group setup cards, one over the cap)",
      html: renderAdminNewEventPage({
        ...COMMON,
        enabled: true,
        form: {
          csrfToken: COMMON.csrfToken,
          timezone: "UTC",
          defaultDurationMinutes: 120,
          groupLimits: { defaultCount: 3, maxCount: 3 },
          groupPresets: [
            ...EVENT_GROUP_PRESETS,
            {
              id: "my:0123456789abcdef01234567",
              label: "Clan match",
              description: "Five roles",
              groupLabel: "Squad",
              groups: [
                {
                  name: "Assault",
                  kind: "team",
                  size: 8,
                  tag: "AS",
                  marker: "🟢",
                },
                { name: "Logi", kind: "open", size: null, tag: "", marker: "" },
              ],
            },
          ],
          groupPresetsNotice: null,
        },
      }),
    },
    {
      name: "Group presets",
      html: renderEventPresetsPage({
        ...COMMON,
        entries: [
          ...EVENT_GROUP_PRESETS.map((p, i) => ({
            ...p,
            source: "builtin" as const,
            enabled: i !== 1,
          })),
          {
            id: "lib:0123456789abcdef01234567",
            source: "library" as const,
            enabled: true,
            label: "Clan match",
            description: "Five roles",
            groupLabel: "Squad",
            leaderLabel: "Lead",
            channelLeadMinutes: 30,
            groups: [
              { name: "Assault", kind: "team", size: 8, tag: "", marker: "🟢" },
            ],
          },
        ],
        state: "ok",
        maxCount: 15,
        defaultCount: 2,
        editing: null,
        values: {},
        prefillNote: null,
        flash: FLASH,
      }),
    },
    {
      // The Generate builder ships hidden and the page script shows it, but the
      // a11y gate drops scripts: show it here so the gate scans its fields (#1472).
      name: "Group presets (Generate builder shown)",
      html: renderEventPresetsPage({
        ...COMMON,
        entries: [],
        state: "ok",
        maxCount: 15,
        defaultCount: 2,
        editing: null,
        values: {},
        prefillNote: null,
      }).replace("data-group-builder hidden", "data-group-builder"),
    },
    {
      name: "Group presets (hosts' presets card)",
      html: renderEventPresetsPage({
        ...COMMON,
        entries: EVENT_GROUP_PRESETS.map((p) => ({
          ...p,
          source: "builtin" as const,
          enabled: true,
        })),
        state: "ok",
        maxCount: 15,
        defaultCount: 2,
        editing: null,
        values: {},
        prefillNote: null,
        hostPresets: {
          page: 0,
          hasMore: false,
          rows: [
            {
              ownerId: "111111111111111111",
              ownerName: "Ada",
              publishedAs: null,
              entry: {
                id: "my:0123456789abcdef01234567",
                source: "personal" as const,
                enabled: true,
                label: "Night raid",
                description: "Three squads",
                groupLabel: "Squad",
                groups: [
                  { name: "Alpha", kind: "team", size: 6, tag: "", marker: "" },
                ],
              },
            },
            {
              ownerId: "222222222222222222",
              ownerName: "",
              publishedAs: "lib:0123456789abcdef01234568",
              entry: {
                id: "my:0123456789abcdef01234569",
                source: "personal" as const,
                enabled: true,
                label: "Clan match",
                description: "",
                groupLabel: "Team",
                groups: [
                  {
                    name: "Red",
                    kind: "team",
                    size: null,
                    tag: "",
                    marker: "",
                  },
                ],
              },
            },
          ],
        },
      }),
    },
    {
      name: "Group presets (editing, library unreadable)",
      html: renderEventPresetsPage({
        ...COMMON,
        entries: EVENT_GROUP_PRESETS.map((p) => ({
          ...p,
          source: "builtin" as const,
          enabled: true,
        })),
        state: "library-unreadable",
        maxCount: 8,
        defaultCount: 2,
        editing: { id: "lib:0123456789abcdef01234567", label: "Clan match" },
        values: {
          preset_name: "Clan match",
          groups_label: "Squad",
          group_0_name: "Assault",
          group_0_kind: "team",
          group_0_size: "8",
          group_1_name: "Command",
          group_1_kind: "leads",
        },
        prefillNote: 'Prefilled from the groups of the event "Game night".',
      }),
    },
    {
      // The disabled-feature callout with its Enable button and All settings link (#1544).
      name: "Polls (feature off)",
      html: renderPollsPage({
        ...COMMON,
        enabled: false,
        defaultDurationHours: 24,
        cooldownDays: 7,
        settingRows: [],
        schedules: [],
        items: [],
        textChannels: [],
        roles: [],
      }),
    },
    {
      name: "Polls",
      html: renderPollsPage({
        ...COMMON,
        enabled: true,
        defaultDurationHours: 24,
        cooldownDays: 30,
        settingRows: [
          {
            key: "polls.enabled",
            label: "Polls system enabled",
            current: true,
            defaultValue: false,
            type: "boolean",
            description: "Enable the poll system.",
            category: "polls",
          },
          {
            key: "polls.default_duration_hours",
            label: "Default poll duration (hours)",
            current: 24,
            defaultValue: 24,
            type: "number",
            description: "Default poll duration in hours (1–768).",
            category: "polls",
          },
          {
            key: "polls.turnout.retention_days",
            label: "Poll turnout retention (days)",
            current: 90,
            defaultValue: 90,
            type: "number",
            description: "Days to keep the per-poll turnout rows.",
            category: "polls",
            min: 0,
          },
        ],
        textChannels: CHANNELS,
        roles: ROLES,
        schedules: [
          {
            id: "s1",
            channelId: "c1",
            channelName: "general",
            channelType: ChannelType.GuildText,
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
      name: "Polls (question edit refused)",
      html: renderPollsPage({
        ...COMMON,
        enabled: true,
        defaultDurationHours: 24,
        cooldownDays: 30,
        settingRows: [
          {
            key: "polls.enabled",
            label: "Polls system enabled",
            current: true,
            defaultValue: false,
            type: "boolean",
            description: "Enable the poll system.",
            category: "polls",
          },
          {
            key: "polls.default_duration_hours",
            label: "Default poll duration (hours)",
            current: 24,
            defaultValue: 24,
            type: "number",
            description: "Default poll duration in hours (1–768).",
            category: "polls",
          },
          {
            key: "polls.turnout.retention_days",
            label: "Poll turnout retention (days)",
            current: 90,
            defaultValue: 90,
            type: "number",
            description: "Days to keep the per-poll turnout rows.",
            category: "polls",
            min: 0,
          },
        ],
        textChannels: CHANNELS,
        roles: ROLES,
        schedules: [
          {
            id: "s1",
            channelId: "c1",
            channelName: "general",
            channelType: ChannelType.GuildText,
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
        refusedForm: {
          formId: "poll-item-edit-p1",
          errors: { answers: "Give 2 to 10 answers, separated by commas." },
          values: {
            question: "Best snack?",
            answers: "only one",
            tags: "",
            multiSelect: "",
          },
        },
      }),
    },
    {
      name: "Events (new event refused)",
      html: renderAdminNewEventPage({
        ...COMMON,
        enabled: true,
        form: {
          csrfToken: COMMON.csrfToken,
          timezone: "Europe/Stockholm",
          defaultDurationMinutes: 120,
          groupLimits: { defaultCount: 2, maxCount: 8 },
          groupPresets: EVENT_GROUP_PRESETS,
          groupPresetsNotice: null,
          ...refusedNewEvent({
            formId: "new-event",
            errors: { title: "Enter a title." },
            values: {
              title: "",
              description: "Bring <snacks>",
              when: "pick",
              date: "2000-01-01",
              time: "18:00",
              duration: "5000",
              timezone: "",
              recurrence: "weekly",
            },
          }),
        },
      }),
    },
    {
      name: "Events (new event, Groups refused)",
      html: renderAdminNewEventPage({
        ...COMMON,
        enabled: true,
        form: {
          csrfToken: COMMON.csrfToken,
          timezone: "Europe/Stockholm",
          defaultDurationMinutes: 120,
          groupLimits: { defaultCount: 2, maxCount: 8 },
          groupPresets: EVENT_GROUP_PRESETS,
          groupPresetsNotice: null,
          ...refusedNewEvent({
            formId: "new-event",
            errors: { groups: "Groups: Give each group a name." },
            values: {
              title: "Raid",
              when: "pick",
              date: "2999-01-01",
              time: "18:00",
              groups_enabled: "1",
              group_0_name: "Red",
              group_0_size: "5",
              group_1_size: "5",
            },
          }),
        },
      }),
    },
    {
      name: "Events (new event, setup missing, from the Start now link)",
      html: renderAdminNewEventPage({
        ...COMMON,
        enabled: true,
        form: {
          csrfToken: COMMON.csrfToken,
          timezone: "Europe/Stockholm",
          defaultDurationMinutes: 120,
          groupLimits: { defaultCount: 2, maxCount: 8 },
          groupPresets: EVENT_GROUP_PRESETS,
          groupPresetsNotice: null,
          setupNotice:
            "No channel category is set, so event channels cannot be created yet.",
          initialWhen: "now",
        },
      }),
    },
    {
      name: "Events (new event)",
      html: renderAdminNewEventPage({
        ...COMMON,
        enabled: true,
        form: {
          csrfToken: COMMON.csrfToken,
          timezone: "Europe/Stockholm",
          defaultDurationMinutes: 120,
          groupLimits: { defaultCount: 2, maxCount: 8 },
          groupPresets: EVENT_GROUP_PRESETS,
          groupPresetsNotice: null,
        },
      }),
    },
    {
      name: "Group presets (editor refused)",
      html: renderEventPresetsPage({
        ...COMMON,
        entries: EVENT_GROUP_PRESETS.map((p) => ({
          ...p,
          source: "builtin" as const,
          enabled: true,
        })),
        state: "ok",
        maxCount: 15,
        defaultCount: 2,
        editing: { id: "lib:0123456789abcdef01234567", label: "Clan match" },
        prefillNote: null,
        values: {
          preset_id: "lib:0123456789abcdef01234567",
          preset_name: "",
          groups_label: "Squad",
          groups_lead_minutes: "9999",
          group_0_name: "Assault",
          group_0_kind: "team",
          group_0_size: "500",
          group_1_name: "Command",
          group_1_kind: "team",
        },
        refusedForm: {
          formId: "event-preset",
          errors: {
            preset_name: "A name is required.",
            groups_lead_minutes:
              "Channel creation time must be a whole number of minutes from 0 to 1440, or empty to use the server default.",
            group_0_size: "A whole number from 1 to 99, or empty for no limit.",
          },
          values: {},
        },
      }),
    },
    {
      name: "Birthdays (edit refused)",
      html: renderBirthdaysPage({
        ...COMMON,
        enabled: true,
        channel: { name: "general", id: "c1", type: ChannelType.GuildText },
        role: null,
        cron: "0 * * * *",
        settingRows: [],
        preview: {
          mentionUserId: "999999999999999999",
          mentionLabel: "Admin",
          mention: true,
          withAge: "Happy birthday",
          withoutAge: null,
          sampleAge: 30,
        },
        rows: [
          {
            userId: "111111111111111111",
            userLabel: "Alice",
            month: 9,
            day: 25,
            hasYear: true,
            nextDate: "2026-09-25",
            daysUntil: 1,
            roleGranted: false,
            lastAnnouncedYear: 2025,
          },
        ],
        total: 1,
        page: 1,
        pageSize: 25,
        refusedForm: {
          formId: "birthday-edit-111111111111111111",
          errors: { month: "Choose a month." },
          values: { month: "", day: "20", clear_year: "1" },
        },
      }),
    },
    {
      name: "Leaderboard roles (tiers refused)",
      html: renderLeaderboardRolesPage({
        ...COMMON,
        enabled: true,
        voiceTrackingEnabled: true,
        period: "week",
        cron: "0 0 * * 1",
        tiers: [
          {
            topN: 1,
            roleId: "r1",
            roleName: "Admin",
            assignable: true,
            holders: [],
            lastUpdated: null,
          },
        ],
        ignoredEntries: [],
        roles: ROLES,
        settingRows: [],
        refusedForm: {
          formId: "leaderboard-tiers",
          errors: {
            "topN-1": "Another tier has this Top N. Each Top N must be unique.",
            "roleId-2": "Pick a role.",
          },
          values: {
            rows: "3",
            "topN-0": "1",
            "roleId-0": "r1",
            "topN-1": "1",
            "roleId-1": "r2",
            "topN-2": "5",
            "roleId-2": "",
          },
        },
      }),
    },
    {
      name: "Moderation (open case refused)",
      html: renderModerationPage({
        ...COMMON,
        enabled: true,
        actionOptions: ["warn", "kick", "ban"],
        userOptions: [],
        settingRows: [],
        casesEnabled: true,
        defaultReviewDays: 90,
        caseGroups: null,
        filters: { action: "", userId: "" },
        rows: [
          {
            entryId: "a".repeat(24),
            caseNumber: null,
            caseStatus: null,
            createdAt: "2026-01-09 12:00",
            userId: "u1",
            userLabel: "alice",
            moderatorId: "u2",
            moderatorLabel: "bob",
            action: "kick",
            reason: "spam",
            source: "command",
          },
        ],
        total: 1,
        page: 1,
        pageSize: 50,
        refusedForm: {
          formId: `moderation-case-open-${"a".repeat(24)}`,
          errors: {
            review_in_days:
              "Review days must be a whole number from 1 to 3650.",
          },
          values: { review_in_days: "0", note: "Repeat offender" },
        },
      }),
    },
    {
      name: "Moderation (case decision refused)",
      html: renderModerationPage({
        ...COMMON,
        enabled: true,
        actionOptions: ["warn", "kick", "ban"],
        userOptions: [],
        settingRows: [],
        casesEnabled: true,
        defaultReviewDays: 90,
        caseGroups: {
          overdue: [
            {
              id: "case1",
              caseNumber: 1,
              userId: "u3",
              userLabel: "carol",
              action: "ban",
              status: "under_review",
              reviewAt: "2026-01-02T00:00:00.000Z",
              openedAt: "2025-10-02T00:00:00.000Z",
              openedByLabel: "bob",
              originModeratorLabel: "bob",
              reason: "spam",
              events: [],
              history: [],
              live: true,
            },
          ],
          dueSoon: [],
          scheduled: [],
          indefinite: [],
          recentlyResolved: [],
        },
        filters: { action: "", userId: "" },
        rows: [],
        total: 0,
        page: 1,
        pageSize: 50,
        refusedForm: {
          formId: "moderation-case-decide-case1",
          // Days the browser accepts: a control its own checks call invalid
          // cannot be submitted, which the confirm dialog test needs.
          errors: { note: "At most 500 characters." },
          values: { next_review_in_days: "90", note: "A very long note" },
        },
      }),
    },
    {
      name: "Role groups (create form refused)",
      html: renderRoleGroupsPage({
        ...ROLE_GROUPS_REFUSED_BASE,
        refusedForm: {
          formId: "role-group-create",
          errors: {
            colour: "Colour must look like #RRGGBB.",
            capability:
              "The bot capability can't be combined with other capabilities.",
          },
          values: {
            roleId: "",
            name: "Helpers",
            colour: "red",
            "capability-bot": "1",
            "capability-staff": "1",
          },
        },
      }),
    },
    {
      name: "Role groups (edit refused)",
      html: renderRoleGroupsPage({
        ...ROLE_GROUPS_REFUSED_BASE,
        refusedForm: {
          formId: "role-group-edit-g1",
          errors: { name: 'A group called "Mods" already exists.' },
          values: {
            name: "Mods",
            colour: "",
            syncPolicy: "enforce",
            "capability-staff": "1",
          },
        },
      }),
    },
    {
      name: "Reaction roles",
      html: renderReactionRolesPage({
        ...COMMON,
        enabled: true,
        configChannel: { name: "roles", id: "c1", type: ChannelType.GuildText },
        active: [
          {
            mappingId: "m1",
            emoji: "🎮",
            roleName: "Gamer",
            roleId: "r2",
            categoryName: "Games",
            categoryType: ChannelType.GuildCategory,
            channelName: "roles",
            channelType: ChannelType.GuildText,
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
            categoryType: ChannelType.GuildCategory,
            channelName: "roles",
            channelType: ChannelType.GuildText,
            messageId: "msg2",
            autoCreated: false,
            mode: "toggle",
            groupId: "g",
            isArchived: true,
            archivedAt: "2026-01-01",
          },
        ],
        settingRows: [
          {
            key: "reactionroles.enabled",
            label: "Reaction roles enabled",
            current: true,
            defaultValue: false,
            type: "boolean",
            description: "Enable the reaction-role system.",
            category: "reactionroles",
          },
          {
            key: "reactionroles.message_channel_id",
            label: "Reaction-role message channel",
            current: CHANNELS[0].id,
            defaultValue: "",
            type: "channel",
            description: "Channel where reaction-role messages are posted.",
            category: "reactionroles",
          },
          {
            key: "reactionroles.style",
            label: "Self-assign surface style",
            current: "reaction",
            defaultValue: "reaction",
            type: "string",
            description: "Surface style for new role messages.",
            category: "reactionroles",
            options: [
              { value: "reaction", label: "Emoji reaction (classic)" },
              { value: "button", label: "Button" },
            ],
          },
        ],
        textChannels: CHANNELS,
        flash: FLASH,
      }),
    },
    {
      name: "Notices",
      html: renderNoticesPage({
        ...COMMON,
        enabled: true,
        channel: { name: "rules", id: "c1", type: ChannelType.GuildText },
        total: 3,
        headerMessageId: "900000000000000002",
        headerEnabled: true,
        textChannels: [
          { id: "c1", name: "rules", type: ChannelType.GuildText },
        ],
        settingRows: [
          {
            key: "notices.enabled",
            label: "Notices system enabled",
            current: true,
            defaultValue: false,
            type: "boolean",
            description: "Enable the notices system.",
            category: "notices",
          },
          {
            key: "notices.channel_id",
            label: "Notices channel",
            current: "c1",
            defaultValue: "",
            type: "channel",
            description: "Channel ID where notice messages are posted.",
            category: "notices",
          },
        ],
        groups: [
          {
            category: "rules",
            // Three rows, so the first (Move up off), a middle and the last
            // (Move down off) row each draw their buttons (#1540).
            rows: [
              {
                id: "n1",
                order: 0,
                title: "Be nice",
                content: "Be nice to each other.",
                preview: "Be nice to each other.",
                category: "rules",
                messageId: "msg1",
                updatedAt: "2026-01-01",
              },
              {
                id: "n2",
                order: 1,
                title: "No spoilers",
                content: "Use spoiler tags.",
                preview: "Use spoiler tags.",
                category: "rules",
                messageId: "msg2",
                updatedAt: "2026-01-01",
              },
              {
                id: "n3",
                order: 2,
                title: "Stay on topic",
                content: "Keep channels on topic.",
                preview: "Keep channels on topic.",
                category: "rules",
                messageId: "msg3",
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
      name: "Quotes",
      html: renderQuotesPage({
        ...COMMON,
        enabled: true,
        channel: { name: "quotes", id: "c1", type: ChannelType.GuildText },
        headerMessageId: "900000000000000001",
        settingsPickers: {
          textChannels: [
            { id: "c1", name: "quotes", type: ChannelType.GuildText },
          ],
          roles: [{ id: "r1", name: "Mods" }],
        },
        settingRows: [
          {
            key: "quotes.enabled",
            label: "Quote system enabled",
            current: true,
            defaultValue: false,
            type: "boolean",
            description: "Enable the quotes system.",
            category: "quotes",
          },
          {
            key: "quotes.channel_id",
            label: "Quote channel",
            current: "c1",
            defaultValue: "",
            type: "channel",
            description: "Channel ID where quote messages are posted.",
            category: "quotes",
          },
          {
            key: "quotes.delete_roles",
            label: "Roles allowed to delete quotes",
            current: "r1",
            defaultValue: "",
            type: "role_list",
            description: "Role IDs allowed to delete quotes.",
            category: "quotes",
          },
        ],
        maxLength: 1000,
        rows: [
          {
            id: "0123456789abcdef01234567",
            content: "Stay hydrated.",
            authorId: "111111111111111111",
            authorLabel: "Alice",
            addedByLabel: "Bob",
            addedAt: "2026-09-01T00:00:00.000Z",
            likes: 3,
            dislikes: 0,
            messageId: "333333333333333333",
          },
        ],
        total: 30,
        page: 1,
        pageSize: 25,
        search: "hydrated",
        flash: FLASH,
      }),
    },
    {
      name: "Birthdays (missing bot permission notice)",
      html: renderBirthdaysPage({
        ...COMMON,
        enabled: true,
        permissionNotice: BIRTHDAYS_MISSING_PERMISSION_NOTICE,
        channel: { name: "general", id: "c1", type: ChannelType.GuildText },
        role: null,
        cron: "0 * * * *",
        settingRows: [],
        settingsPickers: {},
        preview: {
          mentionUserId: "999999999999999999",
          mentionLabel: "Admin",
          mention: true,
          withAge: "Happy birthday!",
          withoutAge: null,
          sampleAge: 30,
        },
        rows: [],
        total: 0,
        page: 1,
        pageSize: 25,
      }),
    },
    {
      name: "Birthdays (permission check unavailable)",
      html: renderBirthdaysPage({
        ...COMMON,
        enabled: true,
        permissionNotice: UNAVAILABLE_PERMISSION_NOTICE,
        channel: { name: "general", id: "c1", type: ChannelType.GuildText },
        role: null,
        cron: "0 * * * *",
        settingRows: [],
        settingsPickers: {},
        preview: {
          mentionUserId: "999999999999999999",
          mentionLabel: "Admin",
          mention: true,
          withAge: "Happy birthday!",
          withoutAge: null,
          sampleAge: 30,
        },
        rows: [],
        total: 0,
        page: 1,
        pageSize: 25,
      }),
    },
    {
      name: "Birthdays",
      html: renderBirthdaysPage({
        ...COMMON,
        enabled: true,
        channel: { name: "general", id: "c1", type: ChannelType.GuildText },
        role: { name: "Birthday", id: "r1" },
        cron: "0 * * * *",
        settingsPickers: {
          textChannels: [
            { id: "c1", name: "general", type: ChannelType.GuildText },
          ],
          roles: [{ id: "r1", name: "Birthday" }],
        },
        settingRows: [
          {
            key: "birthdays.enabled",
            label: "Birthday celebrations enabled",
            current: true,
            defaultValue: false,
            type: "boolean",
            description: "Post a birthday message.",
            category: "birthdays",
          },
          {
            key: "birthdays.cron",
            label: "Birthday check schedule (cron)",
            current: "0 * * * *",
            defaultValue: "0 * * * *",
            type: "cron",
            description: "How often the birthday check runs.",
            category: "birthdays",
          },
          {
            key: "birthdays.role_id",
            label: "Temporary birthday role",
            current: "r1",
            defaultValue: "",
            type: "role",
            description: "Optional role granted on a member's birthday.",
            category: "birthdays",
          },
        ],
        preview: {
          mentionUserId: "999999999999999999",
          mentionLabel: "Admin",
          mention: true,
          withAge: "Happy birthday, <@999999999999999999>! You turn 30",
          withoutAge: "Happy birthday, <@999999999999999999>! You turn",
          sampleAge: 30,
        },
        rows: [
          {
            userId: "111111111111111111",
            userLabel: "Alice",
            month: 9,
            day: 25,
            hasYear: true,
            nextDate: "2026-09-25",
            daysUntil: 1,
            roleGranted: false,
            lastAnnouncedYear: 2025,
          },
        ],
        total: 30,
        page: 1,
        pageSize: 25,
        flash: FLASH,
      }),
    },
    {
      name: "Database",
      html: renderDatabasePage({
        ...COMMON,
        connection: {
          state: "connected",
          name: "koolbot",
          host: "mongo:27017",
        },
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
            items: [
              { id: "i1", order: 0, text: "with the config" },
              { id: "i2", order: 1, text: "with the logs" },
              { id: "i3", order: 2, text: "with the dashboard" },
            ],
            usingDefaults: false,
            exportText: "with the config",
          },
        ],
        flash: FLASH,
      }),
    },
    {
      // A refused group form (#1520): the first blank option row is marked, and
      // its line points at the message.
      name: "Reaction roles (group create form refused)",
      html: renderReactionRolesPage({
        ...COMMON,
        enabled: true,
        configChannel: { name: "roles", id: "c1", type: ChannelType.GuildText },
        active: [],
        archived: [],
        settingRows: [],
        textChannels: CHANNELS,
        refusedForm: {
          formId: "reaction-role-group-create",
          errors: {
            "roleName-1":
              "A role group needs at least two options, each with a role name and an emoji.",
          },
          values: {
            groupName: "Colour",
            mode: "unique",
            "roleName-0": "Red",
            "emoji-0": "🔴",
          },
        },
      }),
    },
    {
      // A refused per-row edit (#1520): that notice's details element is open.
      name: "Notices (edit form refused)",
      html: renderNoticesPage({
        ...COMMON,
        enabled: true,
        channel: { name: "rules", id: "c1", type: ChannelType.GuildText },
        total: 1,
        textChannels: [
          { id: "c1", name: "rules", type: ChannelType.GuildText },
        ],
        settingRows: [],
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
        refusedForm: {
          formId: "notice-edit-n1",
          errors: { title: "Enter a title." },
          values: {
            title: "",
            content: "Be nice to each other.",
            category: "rules",
            order: "1",
          },
        },
      }),
    },
    {
      name: "Quotes (edit form refused)",
      html: renderQuotesPage({
        ...COMMON,
        enabled: true,
        channel: { name: "quotes", id: "c1", type: ChannelType.GuildText },
        headerMessageId: "",
        settingRows: [],
        maxLength: 1000,
        rows: [
          {
            id: "0123456789abcdef01234567",
            content: "Stay hydrated.",
            authorId: "111111111111111111",
            authorLabel: "Alice",
            addedByLabel: "Bob",
            addedAt: "2026-09-01T00:00:00.000Z",
            likes: 3,
            dislikes: 0,
            messageId: "333333333333333333",
          },
        ],
        total: 1,
        page: 1,
        pageSize: 25,
        search: "",
        refusedForm: {
          formId: "quote-edit-0123456789abcdef01234567",
          errors: {
            author_id:
              "Enter the Discord user ID of the author: 17 to 20 digits.",
          },
          values: { content: "Stay hydrated.", author_id: "alice" },
        },
      }),
    },
    {
      // The Import form sits in a closed disclosure; a refusal opens it (#1520).
      name: "Bot status (import form refused)",
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
        refusedForm: {
          formId: "bot-status-import-playing",
          errors: {
            items: "Paste at least one entry: one per line, or a JSON array.",
          },
          values: { items: "", mode: "replace" },
        },
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
        settingRows: [
          ...SETTING_ROWS.slice(0, 4),
          {
            key: "voicechannels.channel.prefix",
            label: "Per-user channel name prefix",
            current: "🎮",
            defaultValue: "",
            type: "string",
            description:
              "Prefix prepended to dynamically created voice channel names.",
            category: "voicechannels",
            format: "affix",
          },
          {
            key: "voicechannels.channel.suffix",
            label: "Per-user channel name suffix",
            current: "",
            defaultValue: "",
            type: "string",
            description:
              "Suffix appended to dynamically created voice channel names.",
            category: "voicechannels",
            format: "affix",
          },
        ],
        categoryChannels: CATEGORIES,
        flash: FLASH,
      }),
    },
    {
      name: "Digest",
      html: renderDigestPage({
        ...COMMON,
        enabled: true,
        settingRows: [
          {
            key: "digest.enabled",
            label: "Weekly voice-activity digest enabled",
            current: true,
            defaultValue: false,
            type: "boolean",
            description: "Send a personalised weekly DM.",
            category: "digest",
          },
          {
            key: "digest.cron",
            label: "Digest schedule (cron)",
            current: "0 16 * * 5",
            defaultValue: "0 9 * * 1",
            type: "cron",
            description: "When the weekly digest job runs.",
            category: "digest",
          },
          {
            key: "digest.min_active_minutes",
            label: "Minimum active minutes to qualify",
            current: 60,
            defaultValue: 30,
            type: "number",
            description: "Users below this are skipped.",
            category: "digest",
          },
          {
            key: "digest.include_achievements",
            label: "Include weekly achievements in digest",
            current: true,
            defaultValue: true,
            type: "boolean",
            description: "Embed the week's achievements.",
            category: "digest",
          },
        ],
        dependencyState: new Map([
          ["voicetracking.enabled", true],
          ["achievements.enabled", true],
        ]),
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
      name: "Leaderboard roles",
      html: renderLeaderboardRolesPage({
        ...COMMON,
        enabled: true,
        voiceTrackingEnabled: false,
        period: "week",
        cron: "0 0 * * 1",
        tiers: [
          {
            topN: 1,
            roleId: "r1",
            roleName: "Admin",
            assignable: false,
            roleIssue: "managed",
            holders: [{ id: "u1", label: "alice" }],
            lastUpdated: "2026-01-05T00:00:00.000Z",
          },
          {
            topN: 3,
            roleId: "r9",
            roleName: null,
            assignable: null,
            holders: [],
            lastUpdated: null,
          },
        ],
        ignoredEntries: ["oops"],
        roles: ROLES,
        settingRows: [
          {
            key: "leaderboard_roles.enabled",
            label: "Leaderboard role rewards enabled",
            current: true,
            defaultValue: false,
            type: "boolean",
            description: "Auto-assign roles by leaderboard position.",
            category: "leaderboard_roles",
          },
          {
            key: "leaderboard_roles.announcement_channel_id",
            label: "Role-change announcements channel",
            current: "c1",
            defaultValue: "",
            type: "channel",
            description: "Where role changes are announced.",
            category: "leaderboard_roles",
          },
        ],
        pickers: { textChannels: CHANNELS },
        flash: FLASH,
      }),
    },
    {
      name: "Command audit",
      html: renderCommandAuditPage({
        ...COMMON,
        enabled: true,
        retentionDays: 30,
        settingRows: [
          {
            key: "core.command_audit.enabled",
            label: "Slash-command audit log enabled",
            current: true,
            defaultValue: true,
            type: "boolean",
            description: "Slash-command audit log enabled.",
            category: "core",
          },
          {
            key: "core.command_audit.retention_days",
            label: "Slash-command audit retention (days)",
            current: 90,
            defaultValue: 90,
            type: "number",
            description: "Slash-command audit retention (days).",
            category: "core",
            min: 0,
          },
          {
            key: "core.web_audit.retention_days",
            label: "WebUI audit retention (days)",
            current: 90,
            defaultValue: 90,
            type: "number",
            description: "WebUI audit retention (days).",
            category: "core",
            min: 0,
          },
        ],
        flash: FLASH,
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
            channelType: ChannelType.GuildText,
            channelStoredName: null,
            result: "success",
            errorMessage: null,
            durationMs: 42,
          },
          {
            createdAt: "2026-01-09 12:02",
            discordUserId: "u1",
            userLabel: "alice",
            commandName: "vc",
            subcommand: null,
            channelId: "c-gone",
            channelLabel: "c-gone",
            channelType: null,
            channelStoredName: "Alice's room",
            result: "success",
            errorMessage: null,
            durationMs: 9,
          },
          {
            createdAt: "2026-01-09 12:01",
            discordUserId: "u1",
            userLabel: "alice",
            commandName: "warn",
            subcommand: null,
            channelId: null,
            channelLabel: null,
            channelType: null,
            channelStoredName: null,
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
        settingRows: [
          {
            key: "moderation.enabled",
            label: "Moderation log enabled",
            current: true,
            defaultValue: false,
            type: "boolean",
            description: "Enable the moderation log.",
            category: "moderation",
          },
          {
            key: "moderation.retention_days",
            label: "Moderation log retention (days)",
            current: 365,
            defaultValue: 365,
            type: "number",
            description: "Days to keep moderation-log rows.",
            category: "moderation",
            min: 0,
          },
          {
            key: "core.moderation.enabled",
            label: "Moderation log to Discord",
            current: true,
            defaultValue: false,
            type: "boolean",
            description: "Post moderation actions to a channel.",
            category: "core",
          },
          {
            key: "core.moderation.channel_id",
            label: "Moderation log channel",
            current: "c1",
            defaultValue: "",
            type: "channel",
            description: "Channel that receives moderation embeds.",
            category: "core",
          },
        ],
        pickers: { textChannels: CHANNELS },
        flash: FLASH,
        casesEnabled: true,
        defaultReviewDays: 90,
        caseGroups: {
          overdue: [
            {
              id: "case1",
              caseNumber: 1,
              userId: "u3",
              userLabel: "carol",
              action: "ban",
              status: "under_review",
              reviewAt: "2026-01-02T00:00:00.000Z",
              openedAt: "2025-10-02T00:00:00.000Z",
              openedByLabel: "bob",
              originModeratorLabel: "bob",
              reason: "spam",
              events: [],
              history: [],
              live: true,
            },
          ],
          dueSoon: [],
          scheduled: [],
          indefinite: [],
          recentlyResolved: [],
        },
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
      name: "Moderation (missing bot permission notice)",
      html: renderModerationPage({
        ...COMMON,
        enabled: true,
        actionOptions: ["warn", "kick", "ban"],
        userOptions: [],
        filters: { action: "", userId: "" },
        rows: [],
        total: 0,
        page: 1,
        pageSize: 50,
        permissionNotice: MODERATION_MISSING_PERMISSION_NOTICE,
      }),
    },
    {
      name: "Moderation (bot permission check unavailable)",
      html: renderModerationPage({
        ...COMMON,
        enabled: true,
        actionOptions: ["warn", "kick", "ban"],
        userOptions: [],
        filters: { action: "", userId: "" },
        rows: [],
        total: 0,
        page: 1,
        pageSize: 50,
        permissionNotice: UNAVAILABLE_PERMISSION_NOTICE,
      }),
    },
    {
      name: "Command metrics",
      html: renderCommandMetricsPage({
        ...COMMON,
        enabled: true,
        retentionDays: 30,
        settingRows: [
          {
            key: "monitoring.metrics_persistence.enabled",
            label: "Persist command metrics",
            current: true,
            defaultValue: true,
            type: "boolean",
            description: "Persist command metrics.",
            category: "core",
          },
          {
            key: "monitoring.metrics_retention_days",
            label: "Command-metrics retention (days)",
            current: 30,
            defaultValue: 30,
            type: "number",
            description: "Command-metrics retention (days).",
            category: "core",
            min: 1,
          },
        ],
        flash: FLASH,
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
        dailyTotals: [
          { date: "2026-01-08", usageCount: 8, errorCount: 0 },
          { date: "2026-01-09", usageCount: 20, errorCount: 1 },
          { date: "2026-01-10", usageCount: 0, errorCount: 0 },
        ],
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
    {
      name: "Bot permissions",
      html: renderBotPermissionsPage({
        ...COMMON,
        report: botPermissionReport("mixed"),
      }),
    },
    {
      name: "Bot permissions (all in place)",
      html: renderBotPermissionsPage({
        ...COMMON,
        report: botPermissionReport("ok"),
      }),
    },
    {
      name: "Bot permissions (all permissions listed, Administrator held)",
      html: renderBotPermissionsPage({
        ...COMMON,
        report: {
          ...botPermissionReport("ok"),
          serverPermissions:
            PermissionFlagsBits.Administrator |
            PermissionFlagsBits.ManageChannels |
            PermissionFlagsBits.SendMessages,
        },
      }),
    },
    {
      name: "Bot permissions (unavailable)",
      html: renderBotPermissionsPage({
        ...COMMON,
        report: {
          available: false,
          reason: "The bot could not read this server from Discord.",
          fresh: false,
          problems: [],
          unknown: [],
          quiet: [],
          okFeatures: [],
          notes: [],
          checks: [],
        },
      }),
    },
    {
      name: "Role groups",
      html: renderRoleGroupsPage({
        ...COMMON,
        groups: [
          {
            id: "g1",
            name: "Mods",
            roleId: "r1",
            rank: 2,
            permissions: "0",
            capabilities: ["staff"],
            colour: null,
            hoist: false,
            createdByKoolbot: false,
            gateOnly: false,
            createdAt: new Date("2026-01-01T00:00:00Z"),
            roleName: "Moderator",
            unlinked: false,
            lostRoleId: null,
            recreateRequestedAt: null,
            syncPolicy: null,
            driftSignature: null,
            roleMissing: false,
            memberCount: 3,
            roleLock: null,
            drift: [],
          },
        ],
        roleOptions: [
          {
            id: "r1",
            name: "Moderator",
            memberCount: 3,
            lock: null,
            taken: true,
          },
          {
            id: "r2",
            name: "Server Booster",
            memberCount: 40,
            lock: "managed",
            taken: false,
          },
        ],
        plan: null,
        extraErrors: [],
        botScanUnavailable: false,
        botsMissing: 0,
        adminReport: { humans: [], bots: [] },
        adminGroupLacksAdministrator: false,
        membersUnavailable: false,
        roleNames: {},
        globalPolicy: "flag",
      }),
    },
    {
      name: "Rules acceptance (missing bot permission notice)",
      html: renderRulesPage({
        ...COMMON,
        permissionNotice: RULES_MISSING_PERMISSION_NOTICE,
        enabled: true,
        channelId: "100000000000000010",
        roleId: "100000000000000011",
        messagePosted: true,
        messageId: "900000000000000003",
        accepted: 12,
        native: { screening: false, community: false },
        intentMissing: false,
        plan: null,
        channels: [],
        roleName: "Accepted",
        unavailable: null,
        options: {
          createRole: false,
          grantExisting: false,
          gateChannelIds: [],
        },
        jobId: null,
      }),
    },
    {
      name: "Rules acceptance (permission check unavailable)",
      html: renderRulesPage({
        ...COMMON,
        permissionNotice: UNAVAILABLE_PERMISSION_NOTICE,
        enabled: true,
        channelId: "100000000000000010",
        roleId: "100000000000000011",
        messagePosted: true,
        messageId: "900000000000000003",
        accepted: 12,
        native: { screening: false, community: false },
        intentMissing: false,
        plan: null,
        channels: [],
        roleName: "Accepted",
        unavailable: null,
        options: {
          createRole: false,
          grantExisting: false,
          gateChannelIds: [],
        },
        jobId: null,
      }),
    },
    {
      name: "Rules acceptance",
      html: renderRulesPage({
        ...COMMON,
        enabled: true,
        channelId: "100000000000000010",
        roleId: "100000000000000011",
        messagePosted: true,
        messageId: "900000000000000003",
        accepted: 12,
        native: { screening: false, community: true },
        intentMissing: true,
        plan: null,
        channels: [
          {
            id: "100000000000000010",
            name: "rules",
            type: ChannelType.GuildText,
          },
        ],
        roleName: "Accepted",
        unavailable: null,
        options: {
          createRole: false,
          grantExisting: false,
          gateChannelIds: [],
        },
        jobId: null,
      }),
    },
    {
      // A switched-off feature's own page: the sidebar's "N turned off" list
      // opens so the current link is not hidden (#1296).
      name: "Rules acceptance (feature off, sidebar list open)",
      html: renderRulesPage({
        ...COMMON,
        navFeatureStatus: { "rules.enabled": false },
        enabled: false,
        channelId: "",
        roleId: "",
        messagePosted: false,
        messageId: "",
        accepted: 0,
        native: { screening: false, community: true },
        intentMissing: false,
        plan: null,
        channels: [
          {
            id: "100000000000000010",
            name: "rules",
            type: ChannelType.GuildText,
          },
        ],
        roleName: null,
        unavailable: null,
        options: {
          createRole: false,
          grantExisting: false,
          gateChannelIds: [],
        },
        jobId: null,
      }),
    },
    {
      // The Re-post cards with the button off and the reason shown (#1428).
      name: "Quotes (header switched off, re-post blocked)",
      html: renderQuotesPage({
        ...COMMON,
        enabled: true,
        channel: { name: "quotes", id: "c1", type: ChannelType.GuildText },
        headerMessageId: "",
        headerEnabled: false,
        settingRows: [],
        maxLength: 1000,
        rows: [],
        total: 0,
        page: 1,
        pageSize: 25,
        search: "",
      }),
    },
    {
      name: "Notices (no channel, re-post blocked)",
      html: renderNoticesPage({
        ...COMMON,
        enabled: true,
        channel: null,
        total: 0,
        headerMessageId: "",
        headerEnabled: true,
        textChannels: [],
        settingRows: [],
        groups: [],
        categoryOptions: [],
      }),
    },
    {
      name: "Quotes (missing bot permission notice)",
      html: renderQuotesPage({
        ...COMMON,
        enabled: true,
        channel: { name: "quotes", id: "c1", type: ChannelType.GuildText },
        headerMessageId: "",
        headerEnabled: true,
        settingRows: [],
        maxLength: 1000,
        rows: [],
        total: 0,
        page: 1,
        pageSize: 25,
        search: "",
        permissionNotice: QUOTES_MISSING_PERMISSION_NOTICE,
      }),
    },
    {
      name: "Quotes (bot permission check unavailable)",
      html: renderQuotesPage({
        ...COMMON,
        enabled: true,
        channel: { name: "quotes", id: "c1", type: ChannelType.GuildText },
        headerMessageId: "",
        headerEnabled: true,
        settingRows: [],
        maxLength: 1000,
        rows: [],
        total: 0,
        page: 1,
        pageSize: 25,
        search: "",
        permissionNotice: UNAVAILABLE_PERMISSION_NOTICE,
      }),
    },
    {
      name: "Notices (missing bot permission notice)",
      html: renderNoticesPage({
        ...COMMON,
        enabled: true,
        channel: { name: "rules", id: "c1", type: ChannelType.GuildText },
        total: 0,
        headerMessageId: "",
        headerEnabled: true,
        textChannels: [],
        settingRows: [],
        groups: [],
        categoryOptions: [],
        permissionNotice: NOTICES_MISSING_PERMISSION_NOTICE,
      }),
    },
    {
      name: "Notices (bot permission check unavailable)",
      html: renderNoticesPage({
        ...COMMON,
        enabled: true,
        channel: { name: "rules", id: "c1", type: ChannelType.GuildText },
        total: 0,
        headerMessageId: "",
        headerEnabled: true,
        textChannels: [],
        settingRows: [],
        groups: [],
        categoryOptions: [],
        permissionNotice: UNAVAILABLE_PERMISSION_NOTICE,
      }),
    },
    {
      name: "Reaction roles (missing bot permission notice)",
      html: renderReactionRolesPage({
        ...COMMON,
        enabled: true,
        configChannel: { name: "roles", id: "c1", type: ChannelType.GuildText },
        active: [],
        archived: [],
        textChannels: CHANNELS,
        permissionNotice: REACTION_ROLES_MISSING_PERMISSION_NOTICE,
      }),
    },
    {
      name: "Reaction roles (bot permission check unavailable)",
      html: renderReactionRolesPage({
        ...COMMON,
        enabled: true,
        configChannel: { name: "roles", id: "c1", type: ChannelType.GuildText },
        active: [],
        archived: [],
        textChannels: CHANNELS,
        permissionNotice: UNAVAILABLE_PERMISSION_NOTICE,
      }),
    },
    ...[
      ["missing bot permission notice", ROLE_GROUPS_MISSING_PERMISSION_NOTICE],
      ["bot permission check unavailable", UNAVAILABLE_PERMISSION_NOTICE],
    ].map(([label, notice]) => ({
      name: `Role groups (${label as string})`,
      html: renderRoleGroupsPage({
        ...COMMON,
        groups: [],
        roleOptions: [],
        plan: null,
        extraErrors: [],
        botScanUnavailable: false,
        botsMissing: 0,
        adminReport: { humans: [], bots: [] },
        adminGroupLacksAdministrator: false,
        membersUnavailable: false,
        roleNames: {},
        globalPolicy: "flag",
        permissionNotice: notice as PermissionNotice,
      }),
    })),
    ...[
      [
        "missing bot permission notice",
        LEADERBOARD_ROLES_MISSING_PERMISSION_NOTICE,
      ],
      ["bot permission check unavailable", UNAVAILABLE_PERMISSION_NOTICE],
    ].map(([label, notice]) => ({
      name: `Leaderboard roles (${label as string})`,
      html: renderLeaderboardRolesPage({
        ...COMMON,
        enabled: true,
        voiceTrackingEnabled: true,
        period: "week",
        cron: "0 0 * * 1",
        tiers: [],
        ignoredEntries: [],
        roles: ROLES,
        settingRows: [],
        pickers: PICKERS,
        permissionNotice: notice as PermissionNotice,
      }),
    })),
    {
      name: "Support tickets",
      html: renderTicketsPage({
        ...COMMON,
        guildId: "g1",
        enabled: true,
        statusFilter: "",
        statusOptions: ["open", "claimed", "closed"],
        total: 2,
        page: 1,
        pageSize: 50,
        settingRows: [
          {
            key: "tickets.enabled",
            label: "Tickets enabled",
            current: true,
            defaultValue: false,
            type: "boolean",
            description: "Let members open private help channels.",
            category: "tickets",
          },
          {
            key: "tickets.staff_role_id",
            label: "Staff role",
            current: "r1",
            defaultValue: "",
            type: "role",
            description: "Role that sees and handles every ticket.",
            category: "tickets",
          },
          {
            key: "tickets.transcript_on_close",
            label: "Save a transcript on close",
            current: true,
            defaultValue: true,
            type: "boolean",
            description:
              "Attach a plain-text message log when a ticket closes.",
            category: "tickets",
          },
        ],
        pickers: { roles: ROLES },
        rows: [
          {
            id: "a".repeat(24),
            createdAt: "2026-01-01T00:00:00.000Z",
            authorId: "u1",
            authorLabel: "alice",
            channelId: "c1",
            subject: "Cannot join voice",
            status: "open",
            claimedByLabel: null,
            closedByLabel: null,
            closedAt: null,
          },
          {
            id: "b".repeat(24),
            createdAt: "2026-01-02T00:00:00.000Z",
            authorId: "u2",
            authorLabel: "bob",
            channelId: "c2",
            subject: "Role request",
            status: "closed",
            claimedByLabel: "mod",
            closedByLabel: "mod",
            closedAt: "2026-01-03T00:00:00.000Z",
          },
        ],
      }),
    },
  ];
}

/** A host-panel event (#1189); `groupsEnabled` adds two groups. */
/** A host panel board (#1424): two teams with people, one of them led, and people in no team. */
function boardData(over: Partial<HostBoardData> = {}): HostBoardData {
  return {
    csrfToken: "token",
    actionPath: (name) => `/me/events/65a000000000000000000001/host/${name}`,
    groupLabel: "Team",
    leaderLabel: "Captain",
    locked: false,
    presenceOk: true,
    teams: [
      {
        key: "g_00000001",
        name: "Reds",
        marker: "🔴",
        tag: "RED",
        size: 4,
        hasChannel: true,
        customised: true,
        people: [
          {
            id: "111111111111111111",
            name: "Ana",
            connected: true,
            where: "Reds",
            leaderLabel: null,
          },
          {
            id: "222222222222222222",
            name: "Ben",
            connected: false,
            where: null,
            leaderLabel: null,
          },
        ],
      },
      {
        key: "g_00000002",
        name: "Blues",
        marker: "",
        tag: "",
        size: null,
        hasChannel: false,
        customised: false,
        people: [],
      },
    ],
    loose: [
      {
        id: "333333333333333333",
        name: "Cal",
        connected: true,
        where: "Main channel",
        leaderLabel: null,
      },
    ],
    connectedCount: 2,
    moveBlocker: null,
    sendableTeams: 1,
    waitingForChannel: 0,
    hasMain: true,
    destinations: [
      { value: "main", label: "Main channel", occupants: 1, limit: 0 },
      { value: "g_00000001", label: "🔴 Reds", occupants: 4, limit: 4 },
    ],
    movePeople: [
      { id: "111111111111111111", name: "Ana", where: "Reds" },
      { id: "333333333333333333", name: "Cal", where: "Main channel" },
    ],
    ...over,
  };
}

/** The whole host panel body around a board (the folds are filled by their own fixtures). */
function boardPage(
  data: HostBoardData,
  over: Partial<HostPanelEvent> = {},
): string {
  return renderHostPanelBody({
    event: {
      ...hostEvent({ groupsEnabled: true, state: "active" }),
      ...over,
    },
    controls: {
      board: renderHostBoard(data),
      end: renderEndSection({
        state: "active",
        actionPath: "/me/events/65a000000000000000000001/host/end",
        csrfToken: "token",
        hasGroupChannels: true,
      }),
    },
  });
}

/** What the two folds read: lead time, leaders and tags, and the groups. */
function settingsData(over: Partial<SettingsViewData> = {}): SettingsViewData {
  return {
    csrfToken: COMMON.csrfToken,
    actionPath: (name) => `/me/events/65a000000000000000000001/host/${name}`,
    blocker: null,
    leadMinutes: 30,
    leadReadOnly: "The channels already exist.",
    groupLabel: "Team",
    groups: [],
    groupEdit: {
      groupLabel: "Team",
      presets: [],
      presetNotice: null,
      presetBase: "[]",
      addKey: "g_00000003",
      groups: [
        {
          key: "g_00000001",
          kind: "team",
          name: "Red",
          marker: "",
          size: null,
          memberCount: 2,
          overSize: false,
          namePending: false,
          sizePending: false,
          hasChannel: true,
        },
        {
          key: "g_00000002",
          kind: "team",
          name: "Blue",
          marker: "",
          size: 4,
          memberCount: 0,
          overSize: false,
          namePending: false,
          sizePending: false,
          hasChannel: false,
        },
      ],
    },
    groupsSwitch: {
      on: true,
      groupLabel: "Team",
      channelOwed: false,
      blocked: null,
      kept: [],
      presets: [],
      presetNotice: null,
      groupCount: 2,
      channelCount: 1,
    },
    leadersTags: {
      leaders: true,
      customisation: true,
      leaderLabel: "Captain",
      tags: true,
      tagsSuffix: false,
      lobby: false,
      teams: [
        { key: "g_00000001", name: "Red", marker: "", tag: "RED" },
        { key: "g_00000002", name: "Blue", marker: "", tag: "" },
      ],
    },
    leaderExtras: {
      leaderLabel: "Captain",
      edits: [
        {
          at: "2030-01-01 19:00 (Europe/Oslo)",
          who: "Ana",
          text: 'renamed Red to "Rubies"',
        },
      ],
    },
    ...over,
  };
}

function hostEvent(over: Partial<HostPanelEvent>): HostPanelEvent {
  const groupsEnabled = over.groupsEnabled === true;
  return {
    id: "65a000000000000000000001",
    title: "Quiz night",
    description: "Bring a pen.",
    state: "scheduled",
    when: "2030-01-01 20:00 (Europe/Oslo)",
    durationMinutes: 90,
    recurrence: "weekly",
    channel: "quiz-night",
    channelType: ChannelType.GuildVoice,
    groupsEnabled,
    groupLabel: "Team",
    leaderLabel: "Leader",
    channelLeadMinutes: 30,
    groups: groupsEnabled
      ? [
          {
            name: "Reds",
            marker: "🔴",
            kind: "team",
            size: 4,
            tag: "RED",
            hasChannel: true,
            memberCount: 3,
            fill: "3/4",
          },
          {
            name: "Spectators",
            marker: "",
            kind: "open",
            size: null,
            tag: "",
            hasChannel: false,
            memberCount: 0,
            fill: "0",
          },
        ]
      : [],
    adopted: false,
    ...over,
  };
}

function editEventView(over: Partial<EventEditView>): EventEditView {
  return {
    id: "65a000000000000000000001",
    title: "Quiz night",
    description: "Bring a friend",
    durationMinutes: 90,
    timezone: "Europe/Oslo",
    date: "2099-06-01",
    time: "20:00",
    when: "2099-06-01 20:00 (Europe/Oslo)",
    version: "abc123",
    mode: "full",
    ...over,
  };
}

function yourEventRow(over: Partial<HostEventListRow>): HostEventListRow {
  return {
    id: "65a000000000000000000001",
    title: "Quiz night",
    when: "2030-01-01 20:00 (Europe/Oslo)",
    state: "scheduled",
    durationMinutes: 90,
    running: false,
    editable: true,
    recurring: false,
    ...over,
  };
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
          preferenceValues: {
            notifications: "1 of 2 on",
            timezone: "Europe/Oslo · 10:59 now",
            birthday: "14 March",
            privacy: "Tracking on",
          },
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
      // Every gated feature off (#1292): a short tab bar, no cards for them,
      // and a notifications page with nothing to offer (no form).
      name: "/me notifications with no feature on",
      html: renderUserPage({
        title: "Notifications",
        active: "/me/notifications",
        body: renderUserNotificationsBody({
          csrfToken: COMMON.csrfToken,
          rows: [],
        }),
        csrfToken: COMMON.csrfToken,
        remainingMs: COMMON.remainingMs,
        isAdmin: false,
        rewindEnabled: false,
        presetsEnabled: false,
        birthdayEnabled: false,
        privacyEnabled: false,
      }),
    },
    {
      name: "/me overview with every gated feature off",
      html: renderUserPage({
        title: "Overview",
        active: "/me/",
        body: renderUserIndexBody({
          discordUserId: "u1",
          guildId: "g1",
          isAdmin: false,
          rewindEnabled: false,
          presetsEnabled: false,
          birthdayEnabled: false,
          privacyEnabled: false,
          preferenceValues: {
            notifications: "None of 1 on",
            timezone: "Server default (UTC) · 10:59 now",
          },
        }),
        csrfToken: COMMON.csrfToken,
        remainingMs: COMMON.remainingMs,
        isAdmin: false,
        rewindEnabled: false,
        presetsEnabled: false,
        birthdayEnabled: false,
        privacyEnabled: false,
      }),
    },
    {
      name: "/me overview with a live hosted event",
      html: shell(
        "Overview",
        "/me/",
        renderUserIndexBody({
          discordUserId: "u1",
          guildId: "g1",
          isAdmin: false,
          hostedEvents: [
            {
              id: "65a000000000000000000002",
              title: "Live quiz",
              when: "2030-01-01 19:00 (UTC)",
              state: "active",
              running: true,
            },
            {
              id: "65a000000000000000000001",
              title: "Quiz night",
              when: "2030-01-02 19:00 (UTC)",
              state: "scheduled",
              running: false,
            },
          ],
          preferenceValues: {
            notifications: "2 of 3 on",
            timezone: "Europe/Oslo · 10:59 now",
            voice: "Server default naming · No presets",
            birthday: "Not set",
            privacy: "Tracking on",
          },
        }),
      ),
    },
    {
      name: "/me overview with hosted events",
      html: shell(
        "Overview",
        "/me/",
        renderUserIndexBody({
          discordUserId: "u1",
          guildId: "g1",
          isAdmin: false,
          hostedEvents: [
            {
              id: "65a000000000000000000001",
              title: "Quiz night",
              when: "2030-01-01 20:00 (Europe/Oslo)",
              state: "scheduled",
              running: false,
            },
          ],
        }),
      ),
    },
    {
      name: "/me/events Your events (live, upcoming, past)",
      html: shell(
        "Your events",
        "/me/events",
        renderHostEventsPage({
          csrfToken: COMMON.csrfToken,
          eventsEnabled: true,
          events: {
            live: [
              yourEventRow({
                id: "65a000000000000000000002",
                state: "active",
                running: true,
                title: "Live quiz",
              }),
            ],
            upcoming: [
              yourEventRow({}),
              yourEventRow({
                id: "65a000000000000000000003",
                title: "Weekly game",
                recurring: true,
              }),
            ],
            past: [
              yourEventRow({
                id: "65a000000000000000000004",
                state: "ended",
                title: "Old quiz",
                editable: false,
              }),
              yourEventRow({
                id: "65a000000000000000000005",
                state: "cancelled",
                title: "Called off",
                editable: false,
              }),
            ],
          },
        }),
      ),
    },
    {
      name: "/me/events Your events (nothing yet)",
      html: shell(
        "Your events",
        "/me/events",
        renderHostEventsPage({
          csrfToken: COMMON.csrfToken,
          eventsEnabled: true,
          events: { live: [], upcoming: [], past: [] },
        }),
      ),
    },
    {
      name: "/me/events Your events (Events off, unreadable)",
      html: shell(
        "Your events",
        "/me/events",
        renderHostEventsPage({
          csrfToken: COMMON.csrfToken,
          eventsEnabled: false,
          events: null,
        }),
      ),
    },
    {
      name: "/me/events Your events (Events off, past only)",
      html: shell(
        "Your events",
        "/me/events",
        renderHostEventsPage({
          csrfToken: COMMON.csrfToken,
          eventsEnabled: false,
          events: {
            live: [],
            upcoming: [],
            past: [yourEventRow({ state: "ended", editable: false })],
          },
        }),
      ),
    },
    {
      // Problems first (#1518): both warnings render as warn Callouts above
      // the folded group details, which hold the clan tags status.
      name: "/me host panel (scheduled, groups)",
      html: shell(
        "Host panel: Quiz night",
        "/me/events",
        renderHostPanelBody({
          event: hostEvent({
            groupsEnabled: true,
            groupNotices: ["Reds: the channel could not be created."],
            tagsEnabled: true,
            tagNotices: ["The bot cannot change nicknames."],
            tagSkipped: [
              {
                name: "Server owner",
                reason: "A bot cannot rename the owner.",
              },
            ],
            captainsLobby: { hasChannel: false },
          }),
        }),
      ),
    },
    {
      name: "/me host panel (missing bot permission notice, host)",
      html: shell(
        "Host panel: Quiz night",
        "/me/events",
        renderHostPanelBody({
          event: hostEvent({ groupsEnabled: true }),
          permissionNotice: MISSING_PERMISSION_NOTICE,
        }),
      ),
    },
    {
      // The main channel was deleted: the id shown as unavailable (#1394).
      name: "/me host panel (main channel gone)",
      html: shell(
        "Host panel: Quiz night",
        "/me/events",
        renderHostPanelBody({
          event: hostEvent({ channel: "999000111", channelType: null }),
        }),
      ),
    },
    {
      // The settings fold open (after a save): summary, hint and body.
      name: "/me host panel (settings fold open)",
      html: shell(
        "Host panel: Quiz night",
        "/me/events",
        renderHostPanelBody({
          event: hostEvent({ groupsEnabled: true }),
          controls: {
            settings: "<p>Settings body.</p>",
            groupchanges: "<p>Group changes body.</p>",
          },
          settingsOpen: true,
        }),
      ),
    },
    {
      // The two always-confirmed forms (#1344): switch groups off and remove
      // groups, each with its empty live region for a fetch problem; now in
      // the "Change the groups" fold (#1424).
      name: "/me host panel settings (groups on: switch off and remove)",
      html: shell(
        "Host panel: Quiz night",
        "/me/events",
        renderGroupChanges(settingsData({ seriesTick: true })),
      ),
    },
    {
      // Groups off, nothing kept (#1469): the own-groups rows are the event
      // form's rows, with the marker picker.
      name: "/me host panel settings (groups off: switch on with own groups)",
      html: shell(
        "Host panel: Quiz night",
        "/me/",
        renderGroupChanges(
          settingsData({
            groupEdit: undefined,
            groups: [],
            groupsSwitch: {
              on: false,
              groupLabel: "Team",
              channelOwed: false,
              blocked: null,
              kept: [],
              presets: [{ id: "builtin:duel", label: "Duel", count: 2 }],
              presetNotice: null,
              groupCount: 0,
              channelCount: 0,
            },
          }),
        ),
      ),
    },
    {
      // The "Event settings" fold (#1514): SettingRows with switches, the lead
      // time presets, the leader label field, one save bar and what leaders changed.
      name: "/me host panel (event settings, leaders and tags on)",
      html: shell(
        "Host panel: Quiz night",
        "/me/",
        renderEventSettings(
          settingsData({ leadReadOnly: null, seriesTick: true }),
        ),
      ),
    },
    {
      // No lead time stored (the server default is ticked), leaders off and a lobby
      // that still exists: the lobby switch stays enabled so it can be turned off.
      name: "/me host panel (event settings, server default lead time, leaders off)",
      html: shell(
        "Host panel: Quiz night",
        "/me/",
        renderEventSettings(
          settingsData({
            leadReadOnly: null,
            leadMinutes: null,
            leaderExtras: undefined,
            leadersTags: {
              leaders: false,
              customisation: false,
              leaderLabel: "Leader",
              tags: false,
              tagsSuffix: true,
              lobby: true,
              teams: [{ key: "g_00000001", name: "Red", marker: "", tag: "" }],
            },
          }),
        ),
      ),
    },
    {
      // The channels exist: the lead time is text with the reason.
      name: "/me host panel (event settings, channels exist)",
      html: shell(
        "Host panel: Quiz night",
        "/me/",
        renderEventSettings(settingsData()),
      ),
    },
    {
      name: "/me host panel (event settings, blocked)",
      html: shell(
        "Host panel: Quiz night",
        "/me/events",
        renderEventSettings(
          settingsData({
            blocker: "Events are turned off, so settings cannot be changed.",
          }),
        ) +
          renderGroupChanges(
            settingsData({
              blocker: "Events are turned off, so settings cannot be changed.",
              groups: [
                {
                  name: "Red",
                  marker: "",
                  size: null,
                  memberCount: 2,
                  overSize: false,
                },
              ],
            }),
          ),
      ),
    },
    {
      name: "/me host panel settings confirmation",
      html: shell(
        "Confirm changes: Quiz night",
        "/me/events",
        renderConfirmBody({
          csrfToken: COMMON.csrfToken,
          actionPath:
            "/me/events/65a000000000000000000001/host/settings-confirm",
          panelPath: "/me/events/65a000000000000000000001/host",
          token: "signed.token",
          reasons: [
            "Switching groups off: Red (2 assigned); Blue (nobody assigned).",
          ],
          changes: [{ label: "Groups", from: "on", to: "off" }],
        }),
      ),
    },
    {
      // Unlocked, with people: a team with a leader-less member who is not
      // connected, an empty team and a person in no team.
      name: "/me host panel (board, unlocked, with people)",
      html: shell("Host panel: Quiz night", "/me/", boardPage(boardData())),
    },
    {
      name: "/me host panel (board, locked)",
      html: shell(
        "Host panel: Quiz night",
        "/me/events",
        boardPage(boardData({ locked: true })),
      ),
    },
    {
      // An empty team and nobody in "Not in a team".
      name: "/me host panel (board, empty team, nobody unassigned)",
      html: shell(
        "Host panel: Quiz night",
        "/me/",
        boardPage(
          boardData({
            loose: [],
            connectedCount: 0,
            movePeople: [],
            teams: boardData().teams.map((t) => ({ ...t, people: [] })),
          }),
        ),
      ),
    },
    {
      // Only people in no team: the "Not in a team" column is the whole board.
      name: "/me host panel (board, not in a team)",
      html: shell(
        "Host panel: Quiz night",
        "/me/",
        boardPage(
          boardData({
            teams: boardData().teams.map((t) => ({ ...t, people: [] })),
            loose: [
              {
                id: "333333333333333333",
                name: "Cal",
                connected: true,
                where: "Main channel",
                leaderLabel: null,
              },
              {
                id: "444444444444444444",
                name: "Dee",
                connected: true,
                where: "Reds",
                leaderLabel: null,
              },
            ],
            connectedCount: 2,
          }),
        ),
      ),
    },
    {
      name: "/me host panel (board, leaders on, with a leader and the pull form)",
      html: shell(
        "Host panel: Quiz night",
        "/me/events",
        boardPage(
          boardData({
            teams: boardData().teams.map((t, i) =>
              i === 0
                ? {
                    ...t,
                    people: t.people.map((p, j) =>
                      j === 0 ? { ...p, leaderLabel: "Captain" } : p,
                    ),
                  }
                : t,
            ),
            leaders: {
              defaultWhere:
                "the main channel (the event has no leaders-only channel yet).",
              destinations: [
                { value: "default", label: "Default" },
                { value: "main", label: "Main channel" },
                { value: "here", label: "The channel I am in" },
                { value: "g_00000001", label: "Reds" },
              ],
            },
          }),
          { captainsEnabled: true, leaderLabel: "Captain" },
        ),
      ),
    },
    {
      name: "/me host panel (board, voice state unreadable, moves switched off)",
      html: shell(
        "Host panel: Quiz night",
        "/me/events",
        boardPage(
          boardData({
            presenceOk: false,
            loose: [],
            connectedCount: 0,
            movePeople: [],
            moveBlocker:
              "The bot could not read who is in the voice channels, so moving people is switched off.",
          }),
        ),
      ),
    },
    {
      name: "/me host panel (board, channels missing, people waiting)",
      html: shell(
        "Host panel: Quiz night",
        "/me/events",
        boardPage(
          boardData({
            sendableTeams: 0,
            waitingForChannel: 2,
            hasMain: false,
            destinations: [],
            teams: boardData().teams.map((t) => ({ ...t, hasChannel: false })),
          }),
        ),
      ),
    },
    {
      // Long unbroken member, team and channel names. Axe cannot see overflow;
      // the wrapping rules are asserted on kb.css in host-board-view.test.ts.
      name: "/me host panel (board, long names)",
      html: shell(
        "Host panel: Quiz night",
        "/me/",
        boardPage(
          boardData({
            teams: boardData().teams.map((t, i) => ({
              ...t,
              name:
                i === 0 ? "TheVeryLongTeamNameWithoutAnySpacesAtAll" : t.name,
              people: t.people.map((p) => ({
                ...p,
                name: "AVeryLongUnbrokenMemberNameFromDiscord0123456789",
                where: p.connected
                  ? "a-very-long-voice-channel-name-for-the-team"
                  : null,
              })),
            })),
          }),
        ),
      ),
    },
    {
      name: "/me host panel (board, no team groups, people and Move people kept)",
      html: shell(
        "Host panel: Quiz night",
        "/me/events",
        boardPage(boardData({ teams: [], sendableTeams: 0 })),
      ),
    },
    {
      name: "/me host panel (end the event, running group event)",
      html: shell(
        "Host panel: Quiz night",
        "/me/events",
        renderHostPanelBody({
          event: hostEvent({
            groupsEnabled: true,
            state: "active",
            running: true,
          }),
          controls: {
            end: renderEndSection({
              state: "active",
              actionPath: "/me/events/65a000000000000000000001/host/end",
              csrfToken: "token",
              hasGroupChannels: true,
            }),
          },
        }),
      ),
    },
    {
      name: "/me event presets (list and editor)",
      html: shell(
        "Event presets",
        "/me/events/presets",
        renderMyEventPresetsBody({
          csrfToken: COMMON.csrfToken,
          presets: [
            {
              id: "my:0123456789abcdef01234567",
              source: "personal",
              enabled: true,
              label: "Night raid",
              description: "Three squads",
              groupLabel: "Squad",
              groups: [
                { name: "Alpha", kind: "team", size: 6, tag: "", marker: "" },
              ],
            },
          ],
          editing: null,
          editUnavailable: false,
          values: {},
          prefillNote: 'Prefilled from the groups of your event "Quiz night".',
          maxCount: 15,
          defaultCount: 2,
        }),
      ),
    },
    {
      // As for the admin editor: the builder is shown, scripts are not run (#1472).
      name: "/me event presets (Generate builder shown)",
      html: shell(
        "Event presets",
        "/me/events/presets",
        renderMyEventPresetsBody({
          csrfToken: COMMON.csrfToken,
          presets: [],
          editing: null,
          editUnavailable: false,
          values: {},
          prefillNote: null,
          maxCount: 15,
          defaultCount: 2,
        }).replace("data-group-builder hidden", "data-group-builder"),
      ),
    },
    {
      name: "/me event presets (editing, read failed)",
      html: shell(
        "Event presets",
        "/me/events/presets",
        renderMyEventPresetsBody({
          csrfToken: COMMON.csrfToken,
          presets: null,
          editing: null,
          editUnavailable: true,
          values: {},
          prefillNote: null,
          maxCount: 15,
          defaultCount: 2,
        }),
      ),
    },
    ...moderatorPages(shell),
    {
      name: "/me host panel (end the event, running plain event)",
      html: shell(
        "Host panel: Quiz night",
        "/me/events",
        renderHostPanelBody({
          event: hostEvent({ state: "active", running: true }),
          controls: {
            end: renderEndSection({
              state: "active",
              actionPath: "/me/events/65a000000000000000000001/host/end",
              csrfToken: "token",
              hasGroupChannels: false,
            }),
          },
        }),
      ),
    },
    {
      name: "/me host panel (scheduled, no groups)",
      html: shell(
        "Host panel: Quiz night",
        "/me/events",
        renderHostPanelBody({ event: hostEvent({}) }),
      ),
    },
    {
      name: "/me host panel (ended)",
      html: shell(
        "Host panel: Quiz night",
        "/me/events",
        renderHostPanelBody({
          event: hostEvent({ groupsEnabled: true, state: "ended" }),
        }),
      ),
    },
    {
      name: "/me new event",
      html: shell(
        "New event",
        "/me/events/new",
        renderNewEventBody({
          csrfToken: COMMON.csrfToken,
          timezone: "Europe/Oslo",
          defaultDurationMinutes: 120,
          groupLimits: { defaultCount: 2, maxCount: 15 },
          groupPresets: EVENT_GROUP_PRESETS,
          groupPresetsNotice: null,
        }),
      ),
    },
    {
      name: "/me new event (missing bot permissions, admin)",
      html: shell(
        "New event",
        "/me/events/new",
        renderNewEventBody({
          csrfToken: COMMON.csrfToken,
          timezone: "Europe/Oslo",
          defaultDurationMinutes: 120,
          groupLimits: { defaultCount: 2, maxCount: 15 },
          groupPresets: EVENT_GROUP_PRESETS,
          groupPresetsNotice: null,
          permissionNotice: EVENT_FORM_PERMISSION_NOTICE,
          canLinkToPermissions: true,
        }),
      ),
    },
    {
      name: "/me new event (missing bot permissions, host)",
      html: shell(
        "New event",
        "/me/events/new",
        renderNewEventBody({
          csrfToken: COMMON.csrfToken,
          timezone: "Europe/Oslo",
          defaultDurationMinutes: 120,
          groupLimits: { defaultCount: 2, maxCount: 15 },
          groupPresets: EVENT_GROUP_PRESETS,
          groupPresetsNotice: null,
          permissionNotice: EVENT_FORM_PERMISSION_NOTICE,
        }),
      ),
    },
    {
      name: "/me new event (bot permission check unavailable)",
      html: shell(
        "New event",
        "/me/events/new",
        renderNewEventBody({
          csrfToken: COMMON.csrfToken,
          timezone: "Europe/Oslo",
          defaultDurationMinutes: 120,
          groupLimits: { defaultCount: 2, maxCount: 15 },
          groupPresets: EVENT_GROUP_PRESETS,
          groupPresetsNotice: null,
          permissionNotice: UNAVAILABLE_PERMISSION_NOTICE,
        }),
      ),
    },
    {
      name: "/me new event (prefilled from the last event)",
      html: shell(
        "New event",
        "/me/events/new",
        renderNewEventBody({
          csrfToken: COMMON.csrfToken,
          timezone: "Europe/Oslo",
          defaultDurationMinutes: 120,
          groupLimits: { defaultCount: 2, maxCount: 15 },
          groupPresets: EVENT_GROUP_PRESETS,
          groupPresetsNotice: null,
          groupRemembered: {
            resetHref: "/me/events/new?defaults=1",
            prefill: {
              presetId: "",
              groupLabel: "Squad",
              leaderLabel: "Captain",
              channelLeadMinutes: "10",
              rows: [
                {
                  name: "Red",
                  kind: "team",
                  size: "5",
                  tag: "RED",
                  marker: "🔴",
                },
                {
                  name: "Blue",
                  kind: "team",
                  size: "5",
                  tag: "BLU",
                  marker: "🔵",
                },
                { name: "Green", kind: "team", size: "", tag: "", marker: "" },
              ],
              captainsEnabled: true,
              captainCustomisationEnabled: true,
              captainsLobby: true,
              tagsEnabled: true,
              tagsSuffix: true,
            },
          },
        }),
      ),
    },
    {
      name: "/me new event (setup missing, presets unreadable)",
      html: shell(
        "New event",
        "/me/events/new",
        renderNewEventBody({
          csrfToken: COMMON.csrfToken,
          timezone: "UTC",
          defaultDurationMinutes: 75,
          groupLimits: { defaultCount: 2, maxCount: 15 },
          groupPresets: [],
          groupPresetsNotice:
            "The preset library could not be read, so no presets are offered right now. Custom still works.",
          setupNotice:
            "No channel category is set, so event channels cannot be created yet.",
        }),
      ),
    },
    {
      name: "/me new event (rejected start time)",
      html: shell(
        "New event",
        "/me/events/new",
        renderNewEventBody({
          csrfToken: COMMON.csrfToken,
          timezone: "Europe/Oslo",
          defaultDurationMinutes: 120,
          groupLimits: { defaultCount: 2, maxCount: 15 },
          groupPresets: EVENT_GROUP_PRESETS,
          groupPresetsNotice: null,
          refusal: { field: "date", message: "Pick a time in the future." },
          values: {
            date: "2020-01-01",
            time: "18:30",
            title: "Game night",
            description: "Bring snacks",
            durationMinutes: 90,
            timezone: "Europe/Oslo",
          },
        }),
      ),
    },
    {
      name: "/me edit event (not started)",
      html: shell(
        "Edit event: Quiz night",
        "/me/events",
        renderEventEditBody({
          event: editEventView({}),
          csrfToken: COMMON.csrfToken,
        }),
      ),
    },
    {
      name: "/me edit event (rejected duration)",
      html: shell(
        "Edit event: Quiz night",
        "/me/events",
        renderEventEditBody({
          event: editEventView({}),
          csrfToken: COMMON.csrfToken,
          refused: {
            refusal: { field: "duration", message: "At most 1440 minutes." },
            values: {
              title: "Quiz night",
              description: "Bring a friend",
              duration: "5000",
              date: "2099-06-01",
              time: "18:00",
              timezone: "UTC",
              scope: "",
            },
          },
        }),
      ),
    },
    {
      name: "/me edit event (missing bot permissions, admin)",
      html: shell(
        "Edit event: Quiz night",
        "/me/events",
        renderEventEditBody({
          event: editEventView({}),
          csrfToken: COMMON.csrfToken,
          permissionNotice: EVENT_FORM_PERMISSION_NOTICE,
          canLinkToPermissions: true,
        }),
      ),
    },
    {
      name: "/me edit event (bot permission check unavailable, host)",
      html: shell(
        "Edit event: Quiz night",
        "/me/events",
        renderEventEditBody({
          event: editEventView({}),
          csrfToken: COMMON.csrfToken,
          permissionNotice: UNAVAILABLE_PERMISSION_NOTICE,
        }),
      ),
    },
    {
      name: "/me edit event (recurring: asks how far the change reaches)",
      html: shell(
        "Edit event: Quiz night",
        "/me/events",
        renderEventEditBody({
          event: editEventView({ series: { cadence: "weekly" } }),
          csrfToken: COMMON.csrfToken,
        }),
      ),
    },
    {
      name: "/me edit event (start held by a running Discord event)",
      html: shell(
        "Edit event: Quiz night",
        "/me/events",
        renderEventEditBody({
          event: editEventView({ startLocked: true }),
          csrfToken: COMMON.csrfToken,
        }),
      ),
    },
    {
      name: "/me edit event (started: description and duration only)",
      html: shell(
        "Edit event: Quiz night",
        "/me/events",
        renderEventEditBody({
          event: editEventView({ mode: "limited" }),
          csrfToken: COMMON.csrfToken,
        }),
      ),
    },
    {
      name: "/me edit event (cover: none yet)",
      html: shell(
        "Edit event: Quiz night",
        "/me/events",
        renderEventEditBody({
          event: editEventView({}),
          csrfToken: COMMON.csrfToken,
          cover: { kind: "editable", hasCover: false, series: false },
        }),
      ),
    },
    {
      name: "/me edit event (cover set on a series, admin link)",
      html: shell(
        "Edit event: Quiz night",
        "/me/events",
        renderEventEditBody({
          event: editEventView({}),
          csrfToken: COMMON.csrfToken,
          cover: { kind: "editable", hasCover: true, series: true },
          adminEventsHref: "/admin/events",
        }),
      ),
    },
    {
      name: "/me edit event (cover unavailable)",
      html: shell(
        "Edit event: Quiz night",
        "/me/events",
        renderEventEditBody({
          event: editEventView({}),
          csrfToken: COMMON.csrfToken,
          cover: {
            kind: "unavailable",
            reason:
              "This event was adopted from an existing Discord event, so its cover is managed in Discord and KoolBot never changes it.",
          },
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
        }),
      ),
    },
    {
      name: "/me birthday (rejected date)",
      html: shell(
        "Birthday",
        "/me/birthday",
        renderUserBirthdayBody({
          csrfToken: COMMON.csrfToken,
          selected: { month: 4, day: 12, year: null },
          refusedForm: {
            formId: "birthday",
            errors: {
              date: "That date does not exist. Choose a day that fits the month.",
            },
            values: { month: "2", day: "30", year: "" },
          },
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
        }),
      ),
    },
    {
      name: "/me voice (rejected user limit)",
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
          refusedForm: {
            formId: "voice-preset-0",
            errors: {
              userLimit:
                "User limit must be a whole number between 0 and 99 (0 = unlimited).",
            },
            values: {
              name: "Chill",
              channelName: "Chill zone",
              userLimit: "150",
              bitrate: "",
            },
          },
        }),
      ),
    },
    {
      name: "/me rewind",
      html: shell("Rewind", "/me/rewind", renderUserRewindBody(REWIND)),
    },
    {
      name: "/me rewind (nothing to recap yet)",
      html: shell(
        "Rewind",
        "/me/rewind",
        renderUserRewindBody({ ...REWIND, year: 2024, hasData: false }),
      ),
    },
    {
      name: "/me rewind (by room kind)",
      html: shell(
        "Rewind",
        "/me/rewind",
        renderUserRewindBody({
          ...REWIND,
          voiceByKind: [
            { kind: "dynamic", duration: "30 hr" },
            { kind: "event", duration: "8 hr 10 min" },
            { kind: "permanent", duration: "2 hr" },
            { kind: "other", duration: "2 hr" },
          ],
          longestSession: {
            duration: "3 hr 5 min",
            date: "2026-01-03",
            roomKind: "dynamic",
          },
        }),
      ),
    },
    {
      name: "/me privacy",
      html: shell(
        "Privacy",
        "/me/privacy",
        renderUserPrivacyBody({
          featureEnabled: true,
          included: [
            {
              collection: "voice-channel-tracking",
              note: "Your voice history and per-session detail.",
            },
            {
              collection: "quote",
              note: "Quotes attributed to you, and quotes you saved.",
            },
          ],
          excluded: [
            {
              collection: "moderation-log",
              note: "Moderation record — not self-service.",
            },
          ],
          maxItems: 5000,
        }),
      ),
    },
    {
      // The reset card as a danger panel (#1544).
      name: "/me privacy (reset card)",
      html: shell(
        "Privacy",
        "/me/privacy",
        renderUserPrivacyBody({
          featureEnabled: true,
          included: [],
          excluded: [],
          maxItems: 5000,
          reset: { enabled: true, cooldownHours: 24, csrfToken: "tok" },
        }),
      ),
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
  // No `voiceByKind` and no kind on the longest session: an older snapshot (#1420).
  longestSession: {
    duration: "3 hr 5 min",
    date: "2026-01-03",
    roomKind: "other",
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
  topTextChannels: [
    {
      channelId: "c1",
      channelName: "general",
      channelType: ChannelType.GuildText,
      count: 300,
    },
  ],
  peakMessageDay: { date: "2026-01-04", count: 60 },
  reactionsGiven: 90,
  reactionsReceived: 120,
  hourOfDayDistribution: Array.from({ length: 24 }, (_, h) => h * 3),
  dayOfWeekDistribution: Array.from({ length: 7 }, (_, d) => d * 20),
  pollVotesCast: 12,
};

/** A removed bot with leftovers, as the cleanup page lists it (#1179). */
const REMOVED_BOT: RemovedBotCandidate = {
  userId: "155149108183695360",
  name: "Dyno",
  evidence: "catalogue",
  needsCheck: false,
  reason: "Its id is in the bot catalogue and it is no longer in the server.",
  overwriteChannels: [
    { id: "11", name: "news", typeName: "GuildText" },
    { id: "12", name: "chat", typeName: "GuildVoice" },
    { id: "14", name: "archive" },
  ],
  ownedChannels: [
    {
      id: "13",
      name: "log",
      typeName: "GuildText",
      usedBy: ["core"],
      claimKey: "core.errors.channel_id",
    },
  ],
  boundFeatures: [
    { channel: "log", typeName: "GuildText", features: ["core"] },
  ],
};

/** A cleanup plan with one approved overwrite removal (#1179). */
const CLEANUP_PLAN = {
  scan: {} as never,
  candidate: REMOVED_BOT,
  channelIds: ["11"],
  errors: [],
  plan: {
    ...CLAIMS_DESTRUCTIVE_PLAN.plan,
    operations: [CLAIMS_DESTRUCTIVE_PLAN.plan.operations[1]],
    warnings: [
      {
        code: "feature-bound",
        message: '"log" is bound to core and stays so.',
      },
    ],
  },
} as never;

/** The busy scan, plus an overwrite for a catalogue bot that is no longer here. */
function removedBotScan(): ReturnType<typeof busyScan> {
  const scan = busyScan();
  scan.channels[1]!.overwrites.push({
    id: "235148962103951360",
    type: "member",
    label: "235148962103951360",
    allow: ["ViewChannel"],
    deny: [],
  });
  return scan;
}

/**
 * The app shell (#1317) for each scope combination: top bar, scope badges, the
 * sidebar (or its absence) and the "why you see this" line. `renderUserPage`
 * is given the viewer directly; `userPages()` above covers the admin on `/me`.
 */
export function shellPages(): A11yPage[] {
  const viewer = (
    scopes: ShellViewer["scopes"],
    reasons?: ShellViewer["reasons"],
  ): ShellViewer => ({
    displayName: "Kari Nordmann",
    role: "user",
    scopes,
    reasons,
  });
  // Every page built, so the Moderation section and Tickets are scanned too.
  const everything = SHELL_NAV.map((item) => ({
    ...item,
    available: true,
    featureKey: undefined,
  }));
  const page = (
    title: string,
    active: string,
    v: ShellViewer,
    navRegistry?: readonly ShellNavItem[],
  ): string =>
    renderUserPage({
      title,
      active,
      body: `<header class="kb-pagehead"><div class="kb-pagehead__text"><h1 class="kb-pagehead__title">${title}</h1></div></header><p>Page content.</p>`,
      csrfToken: COMMON.csrfToken,
      remainingMs: COMMON.remainingMs,
      isAdmin: v.role === "admin",
      viewer: v,
      navRegistry,
    });
  const hostRoles = { host: ["Event hosts"], staff: [], elevated: false };
  const modRoles = { host: [], staff: ["Moderators"], elevated: false };

  return [
    {
      name: "shell: member only (no sidebar)",
      html: page("My preferences", "/me/", viewer(["member"])),
    },
    {
      name: "shell: host (You and Hosting) with why line",
      html: page(
        "Event presets",
        "/me/events/presets",
        viewer(["member", "host"], hostRoles),
      ),
    },
    {
      name: "shell: moderator (You and Moderation) with why line",
      html: page(
        "Mod log",
        "/me/moderation",
        viewer(["member", "moderator"], modRoles),
      ),
    },
    {
      name: "shell: host and moderator, every section",
      html: page(
        "Your events",
        "/me/events",
        viewer(["member", "host", "moderator"], {
          host: ["Event hosts", "Crew"],
          staff: ["Moderators"],
          elevated: false,
        }),
        everything,
      ),
    },
    {
      name: "shell: admin on /me with the Admin console link",
      html: page("My preferences", "/me/", {
        displayName: "Ola <Admin>",
        role: "admin",
        scopes: ["member", "host", "moderator"],
      }),
    },
  ];
}

/** Every page the a11y gate scans. */
export function allPages(): A11yPage[] {
  return [...adminPages(), ...userPages(), ...shellPages(), ...preAuthPages()];
}

// ---------- /me/moderation (#1320) ----------

const modLogProps = (over: Partial<ModLogBodyProps> = {}): ModLogBodyProps => ({
  enabled: true,
  casesEnabled: true,
  tiles: {
    openCases: 2,
    overdueCases: 1,
    actionsLast7Days: 9,
    timeoutsNow: 1,
  },
  openCases: [
    {
      id: "65a000000000000000000001",
      caseNumber: 4,
      userId: "u-1",
      userLabel: "Bad Ben",
      action: "ban",
      status: "under_review",
      reviewAt: "2026-01-10T09:00:00.000Z",
      due: true,
    },
    {
      id: "65a000000000000000000002",
      caseNumber: 5,
      userId: "u-2",
      userLabel: "Kick Kim",
      action: "kick",
      status: "open",
      reviewAt: null,
      due: false,
    },
  ],
  kind: "all",
  rows: [
    {
      entryId: "e1",
      caseId: "65a000000000000000000001",
      caseNumber: 4,
      caseStatus: "under_review",
      createdAt: "2026-01-01T10:00:00.000Z",
      userId: "u-1",
      userLabel: "Bad Ben",
      moderatorId: "m-1",
      moderatorLabel: "Mod Mia",
      action: "ban",
      reason: "spam <b>links</b>",
      source: "audit",
    },
    {
      entryId: "e2",
      caseId: null,
      caseNumber: null,
      caseStatus: null,
      createdAt: "2026-01-02T10:00:00.000Z",
      userId: "u-2",
      userLabel: "Kick Kim",
      moderatorId: null,
      moderatorLabel: null,
      action: "warn",
      reason: null,
      source: "command",
    },
  ],
  rowsUnavailable: false,
  caseLookupFailed: false,
  total: 120,
  page: 2,
  pageSize: 50,
  ...over,
});

const modCase = (over: Partial<CaseView> = {}): CaseView => ({
  id: "65a000000000000000000001",
  caseNumber: 4,
  userId: "u-1",
  userLabel: "Bad Ben",
  action: "ban",
  status: "open",
  reviewAt: "2026-02-01T09:00:00.000Z",
  openedAt: "2026-01-01T10:00:00.000Z",
  openedByLabel: "Mod Mia",
  originModeratorLabel: "Mod Mia",
  reason: "spam",
  events: [
    {
      at: "2026-01-05T09:00:00.000Z",
      byLabel: "KoolBot",
      to: "under_review",
      outcome: null,
      note: null,
    },
    {
      at: "2026-01-06T09:00:00.000Z",
      byLabel: "Mod Mia",
      to: "open",
      outcome: "upheld",
      note: "still a risk",
    },
  ],
  history: [
    { createdAt: "2025-12-01T10:00:00.000Z", action: "warn", reason: "caps" },
    { createdAt: "2025-11-01T10:00:00.000Z", action: "timeout", reason: null },
  ],
  live: true,
  ...over,
});

function moderatorPages(
  shell: (title: string, active: string, body: string) => string,
): A11yPage[] {
  const page = (name: string, title: string, body: string): A11yPage => ({
    name: `/me/moderation ${name}`,
    // The Command audit page marks its own sidebar item, the others Mod log.
    html: shell(
      title,
      title === "Command audit" ? "/me/moderation/audit" : "/me/moderation",
      body,
    ),
  });
  const auditProps = {
    enabled: true,
    commandOptions: ["warn", "component:poll-vote"],
    userOptions: [{ id: "u-1", label: "Mod Mia" }],
    filters: { commandName: "", userId: "", result: "", from: "", to: "" },
    rows: [
      {
        createdAt: "2026-01-03T09:30:00.000Z",
        discordUserId: "u-1",
        userLabel: "Mod Mia",
        commandName: "warn",
        subcommand: null,
        channelId: "c-1",
        channelLabel: "general",
        channelType: ChannelType.GuildText,
        channelStoredName: null,
        result: "denied" as const,
        errorMessage: "Missing permission",
        durationMs: 12,
      },
      {
        createdAt: "2026-01-03T09:40:00.000Z",
        discordUserId: "u-1",
        userLabel: "Mod Mia",
        commandName: "vc",
        subcommand: null,
        channelId: "c-gone",
        channelLabel: "c-gone",
        channelType: null,
        channelStoredName: "Mia's room",
        result: "success" as const,
        errorMessage: null,
        durationMs: 8,
      },
    ],
    total: 80,
    page: 1,
    pageSize: 50,
  };
  return [
    page(
      "mod log (tiles, open cases, actions)",
      "Mod log",
      renderModLogBody(modLogProps()),
    ),
    page(
      "mod log (timeouts filter, no cases)",
      "Mod log",
      renderModLogBody(
        modLogProps({
          casesEnabled: false,
          kind: "timeouts",
          openCases: null,
          tiles: {
            openCases: null,
            overdueCases: 0,
            actionsLast7Days: 0,
            timeoutsNow: null,
          },
          rows: [],
          total: 0,
          page: 1,
        }),
      ),
    ),
    page(
      "mod log (nothing open, administrator)",
      "Mod log",
      renderModLogBody(
        modLogProps({
          openCases: [],
          tiles: {
            openCases: 0,
            overdueCases: 0,
            actionsLast7Days: 3,
            timeoutsNow: 0,
          },
        }),
      ),
    ),
    page(
      "mod log (cases unreadable)",
      "Mod log",
      renderModLogBody(modLogProps({ openCases: null })),
    ),
    page(
      "mod log (log and case lookup unavailable)",
      "Mod log",
      renderModLogBody(
        modLogProps({
          rowsUnavailable: true,
          caseLookupFailed: true,
          tiles: {
            openCases: 2,
            overdueCases: null,
            actionsLast7Days: null,
            timeoutsNow: null,
          },
        }),
      ),
    ),
    page(
      "mod log (case lookup failed)",
      "Mod log",
      renderModLogBody(modLogProps({ caseLookupFailed: true })),
    ),
    page(
      "mod log (moderation off)",
      "Mod log",
      renderModLogBody(modLogProps({ enabled: false })),
    ),
    page(
      "case (live, with the Review form)",
      "Case #4",
      renderModCaseBody({
        csrfToken: COMMON.csrfToken,
        case: modCase(),
        defaultReviewDays: 90,
      }),
    ),
    page(
      "case (resolved)",
      "Case #4",
      renderModCaseBody({
        csrfToken: COMMON.csrfToken,
        case: modCase({
          live: false,
          status: "lifted",
          events: [],
          history: [],
        }),
        defaultReviewDays: 90,
      }),
    ),
    page("case (not found)", "Case not found", renderModCaseMissingBody(true)),
    page(
      "command audit (read only)",
      "Command audit",
      renderModAuditBody(auditProps),
    ),
    page(
      "command audit (unavailable)",
      "Command audit",
      renderModAuditBody({
        ...auditProps,
        unavailable: true,
        rows: [],
        total: 0,
      }),
    ),
    page(
      "case (history unavailable)",
      "Case #4",
      renderModCaseBody({
        csrfToken: COMMON.csrfToken,
        case: modCase({ historyUnavailable: true, history: [] }),
        defaultReviewDays: 90,
      }),
    ),
    page(
      "command audit (empty, auditing off)",
      "Command audit",
      renderModAuditBody({ ...auditProps, enabled: false, rows: [], total: 0 }),
    ),
  ];
}
