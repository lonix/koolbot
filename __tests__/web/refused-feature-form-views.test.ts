/**
 * How a refused form is drawn on the Birthdays, Leaderboard roles, Moderation,
 * Role groups, Group presets, Channel manager and New event pages (#1523, #1527): a form
 * that was not refused renders exactly as before, and the pieces that differ
 * from a plain form (the Moderation log's query, the Tiers rows) behave.
 */
import { describe, it, expect } from "@jest/globals";
import { ChannelType } from "discord.js";
import {
  renderBirthdaysPage,
  renderLeaderboardRolesPage,
  renderModerationPage,
} from "../../src/web/admin-views.js";
import {
  ADMIN_NEW_EVENT_FORM,
  refusedNewEventForm,
  renderAdminNewEventPage,
} from "../../src/web/admin-new-event-page.js";
import { renderEventPresetsPage } from "../../src/web/event-presets-page.js";
import { renderRoleGroupsPage } from "../../src/web/role-groups-views.js";
import { renderChannelManagerPage } from "../../src/web/channel-manager-view.js";
import { buildChannelTree } from "../../src/web/channel-manager.js";
import type { RefusedForm } from "../../src/web/form-errors.js";

const COMMON = {
  guildId: "g1",
  csrfToken: "csrf",
  remainingMs: 60_000,
  navFeatureStatus: {},
};

const ENTRY = "a".repeat(24);

const birthdays = (refusedForm?: RefusedForm | null): string =>
  renderBirthdaysPage({
    ...COMMON,
    enabled: true,
    channel: null,
    role: null,
    cron: "0 * * * *",
    settingRows: [],
    preview: {
      mentionUserId: "1",
      mentionLabel: "Admin",
      mention: true,
      withAge: "Hi",
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
        lastAnnouncedYear: null,
      },
    ],
    total: 1,
    page: 1,
    pageSize: 25,
    refusedForm,
  });

const leaderboard = (refusedForm?: RefusedForm | null): string =>
  renderLeaderboardRolesPage({
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
    roles: [{ id: "r1", name: "Admin" }],
    settingRows: [],
    refusedForm,
  });

const moderation = (
  over: { page?: number; action?: string } = {},
  refusedForm?: RefusedForm | null,
): string =>
  renderModerationPage({
    ...COMMON,
    enabled: true,
    actionOptions: ["kick", "ban"],
    userOptions: [],
    settingRows: [],
    casesEnabled: true,
    defaultReviewDays: 90,
    caseGroups: null,
    filters: { action: over.action ?? "", userId: "" },
    rows: [
      {
        entryId: ENTRY,
        caseNumber: null,
        caseStatus: null,
        createdAt: "2026-01-01 10:00",
        userId: "1",
        userLabel: "Alice",
        moderatorId: null,
        moderatorLabel: null,
        action: "kick",
        reason: null,
        source: "command",
      },
    ],
    total: 120,
    page: over.page ?? 1,
    pageSize: 50,
    refusedForm,
  });

const roleGroups = (refusedForm?: RefusedForm | null): string =>
  renderRoleGroupsPage({
    csrfToken: "csrf",
    remainingMs: 60_000,
    groups: [
      {
        id: "g1",
        name: "Mods",
        roleId: "r1",
        rank: 1,
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
    refusedForm,
  });

const presets = (refusedForm?: RefusedForm | null): string =>
  renderEventPresetsPage({
    ...COMMON,
    entries: [],
    state: "ok",
    maxCount: 15,
    defaultCount: 2,
    editing: null,
    values: refusedForm?.values ?? {},
    prefillNote: null,
    refusedForm,
  });

const CHANNELS = [
  {
    id: "100000000000000001",
    name: "Community",
    kind: "category" as const,
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
    kind: "text" as const,
    typeLabel: "text",
    parentId: "100000000000000001",
    position: 0,
    topic: "hi",
    userLimit: null,
    bitrate: null,
  },
];

const channels = (refusedForm?: RefusedForm | null): string =>
  renderChannelManagerPage({
    ...COMMON,
    channels: CHANNELS,
    tree: buildChannelTree(CHANNELS),
    protection: new Map(),
    botCanManage: true,
    maxBitrate: 96000,
    refusedForm,
  });

// The New event page (#1527): drawn from the refused form the way its route draws it.
const newEvent = (refusedForm?: RefusedForm | null): string => {
  const view =
    refusedForm?.formId === ADMIN_NEW_EVENT_FORM
      ? refusedNewEventForm(refusedForm, "UTC", 120)
      : null;
  return renderAdminNewEventPage({
    ...COMMON,
    enabled: true,
    form: {
      csrfToken: "csrf",
      timezone: "UTC",
      defaultDurationMinutes: 120,
      groupLimits: { defaultCount: 2, maxCount: 8 },
      groupPresets: [],
      groupPresetsNotice: null,
      ...(view
        ? {
            refusal: view.refusal,
            values: view.values,
            initialWhen: view.initialWhen,
          }
        : {}),
    },
  });
};

const PAGES: Array<[string, (r?: RefusedForm | null) => string]> = [
  ["Birthdays", birthdays],
  ["Leaderboard roles", leaderboard],
  ["Moderation", (r) => moderation({}, r)],
  ["Role groups", roleGroups],
  ["Group presets", presets],
  ["Channel manager", channels],
  ["New event", newEvent],
];

describe("a form that was not refused (#1523)", () => {
  it.each(PAGES)("%s renders no refusal markup", (_name, render) => {
    for (const html of [render(), render(null)]) {
      expect(html).not.toMatch(/<(input|select|textarea)[^>]*aria-invalid/);
      expect(html).not.toContain('class="kb-field__error"');
      expect(html).not.toMatch(
        /<details( class="(helper edit-details|inline-edit)")? open>/,
      );
    }
  });

  it.each(PAGES)(
    "%s is unchanged when the refused form belongs to another page's id",
    (_name, render) => {
      const other: RefusedForm = {
        formId: "elsewhere",
        errors: { name: "x" },
        values: { name: "y" },
      };
      expect(render(other)).toBe(render());
    },
  );
});

describe("the Moderation log's query (#1523)", () => {
  it("is handed back by an Open case form on a later page, so the refused row is on the page that returns", () => {
    expect(moderation({ page: 2, action: "kick" })).toContain(
      '<input type="hidden" name="view_query" value="?action=kick&amp;page=2">',
    );
  });

  it("is left out on the first unfiltered page, so that markup is as it was", () => {
    expect(moderation()).not.toContain("view_query");
  });
});

describe("the Leaderboard roles Tiers rows (#1523)", () => {
  it("draw from the submission, not the stored tiers, so an added row keeps its values", () => {
    const html = leaderboard({
      formId: "leaderboard-tiers",
      errors: { "roleId-1": "Pick a role." },
      values: {
        rows: "2",
        "topN-0": "1",
        "roleId-0": "r1",
        "topN-1": "7",
        "roleId-1": "",
      },
    });
    // Two submitted rows and the template for "Add tier".
    expect(html.match(/name="topN"/g)).toHaveLength(3);
    expect(html).toContain('value="7"');
    expect(html).toContain(
      'aria-describedby="leaderboard-tiers-roleId-1-error"',
    );
  });
});

describe("a refused Channel manager form (#1523)", () => {
  it("opens that channel's Edit disclosure and no other", () => {
    const html = channels({
      formId: "channel-edit-100000000000000002",
      errors: { name: "Give the name a name." },
      values: { name: "", orig_name: "general" },
    });
    expect(html.match(/<details class="inline-edit" open>/g)).toHaveLength(1);
    expect(html).toContain(ChannelType.GuildText === 0 ? "general" : "");
  });
});

describe("the Role groups backing role of a refused Add form (#1523)", () => {
  it("stays selected when it is no longer in the list, so a retry cannot create a new role", () => {
    const html = roleGroups({
      formId: "role-group-create",
      errors: { roleId: "That role couldn't be found." },
      values: { roleId: "999" },
    });
    expect(html).toContain(
      '<option value="999" selected>Role 999 (not found)</option>',
    );
  });
});
