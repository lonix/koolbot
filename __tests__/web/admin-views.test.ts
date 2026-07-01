import { describe, it, expect } from "@jest/globals";
import {
  findCascadeMasterKey,
  parseCronToPickerState,
  renderAnalyticsPage,
  renderAnnouncementsPage,
  renderBootstrapPage,
  renderCommandAuditPage,
  renderDashboardPage,
  renderDatabasePage,
  renderDigestPage,
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

// Empty guild picker lists + dependency map for wizard-step tests that don't
// exercise the channel/category/role dropdowns or dependency locking. Tests
// override the pieces they need (issues #702 / #703 / #666).
const EMPTY_PICKERS = {
  textChannels: [] as Array<{ id: string; name: string }>,
  voiceChannels: [] as Array<{ id: string; name: string }>,
  categoryChannels: [] as Array<{ id: string; name: string }>,
  roles: [] as Array<{ id: string; name: string }>,
  enabledByKey: {} as Record<string, boolean>,
};

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
  it("renders the human label as primary text and the dotted key as a muted reference", () => {
    const html = renderSettingsPage({
      ...COMMON,
      groups: [
        {
          category: "voicechannels",
          rows: [
            {
              key: "voicechannels.enabled",
              label: "Voice Channel Management enabled",
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
    // Human label appears as bold primary text.
    expect(html).toContain("<strong>Voice Channel Management enabled</strong>");
    // Raw dotted key still rendered, but de-emphasised as a small code ref.
    expect(html).toMatch(
      /<code class="mono muted"[^>]*>voicechannels\.enabled<\/code>/,
    );
  });

  it("renders the category title and description from categoryMetadata", () => {
    const html = renderSettingsPage({
      ...COMMON,
      groups: [
        {
          category: "voicechannels",
          rows: [
            {
              key: "voicechannels.enabled",
              label: "Voice Channel Management enabled",
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
    // Human title, not the slug.
    expect(html).toContain("<h2>Voice Channels</h2>");
    expect(html).not.toContain("<h2>voicechannels</h2>");
    // Category description rendered as muted helper text under the title.
    expect(html).toMatch(
      /<p class="muted"[^>]*>Dynamic voice channel management/,
    );
  });

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

  it("wraps each section in one save form, exposes per-row reset, and pre-fills values (issue #433)", () => {
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
    // Single per-section save form (replaces the per-row "Set" button).
    expect(html).toContain('action="/admin/settings/save-section"');
    expect(html).toContain('name="category" value="quotes"');
    expect(html).toContain(
      '<button type="submit" class="btn btn-primary">Save</button>',
    );
    // Each row contributes its key via a hidden `keys` input so the
    // handler can enumerate the section without trusting `value_*` names.
    expect(html).toContain('name="keys" value="quotes.max_length"');
    expect(html).toContain('name="keys" value="quotes.channel_id"');
    // Per-row Reset is retained via HTML5 formaction so a single click
    // posts just that key to the existing /settings/reset handler.
    expect(html).toContain('formaction="/admin/settings/reset"');
    expect(html).toContain('name="key" value="quotes.max_length"');
    // Value controls use the per-row name and round-trip the current value.
    expect(html).toContain('name="value_quotes.max_length"');
    expect(html).toContain('name="value_quotes.channel_id"');
    expect(html).toContain('value="500"');
    expect(html).toContain('value="12345"');
    // No per-row "Set" submit survives.
    expect(html).not.toContain('action="/admin/settings/set"');
  });

  it("tags the value and default cells so long values stay bounded, not nowrap (issue #489)", () => {
    const longTiers =
      "role-aaaaaaaaaaaaaaaa:1000,role-bbbbbbbbbbbbbbbb:2500,role-cccccccccccccccc:5000,role-dddddddddddddddd:10000";
    const html = renderSettingsPage({
      ...COMMON,
      groups: [
        {
          category: "leaderboard_roles",
          rows: [
            {
              key: "leaderboard_roles.tiers",
              current: longTiers,
              defaultValue: longTiers,
              type: "string",
              description: "",
              category: "leaderboard_roles",
            },
          ],
        },
      ],
    });
    // The editable value cell and the default cell carry the classes the
    // stylesheet uses to bound long content within the column.
    expect(html).toContain('<td class="settings-value">');
    expect(html).toContain('<td class="settings-default">');
    // The previous fixed `white-space:nowrap` on the default cell forced
    // long values to push the table wide — it must be gone.
    expect(html).not.toContain('<td style="white-space:nowrap">');
  });

  it("shows the warnBelow warning when a value is below the threshold (#575)", () => {
    const html = renderSettingsPage({
      ...COMMON,
      groups: [
        {
          category: "voicetracking",
          rows: [
            {
              key: "voicetracking.cleanup.retention.detailed_sessions_days",
              current: 30,
              defaultValue: 400,
              type: "number",
              description: "",
              category: "voicetracking",
              warnBelow: {
                value: 366,
                message: "Rewind needs 366 days of detailed data.",
              },
            },
          ],
        },
      ],
    });
    expect(html).toContain('class="settings-warn"');
    expect(html).toContain("Rewind needs 366 days of detailed data.");
  });

  it("hides the warnBelow warning at or above the threshold (#575)", () => {
    const html = renderSettingsPage({
      ...COMMON,
      groups: [
        {
          category: "voicetracking",
          rows: [
            {
              key: "voicetracking.cleanup.retention.detailed_sessions_days",
              current: 400,
              defaultValue: 400,
              type: "number",
              description: "",
              category: "voicetracking",
              warnBelow: {
                value: 366,
                message: "Rewind needs 366 days of detailed data.",
              },
            },
          ],
        },
      ],
    });
    expect(html).not.toContain('class="settings-warn"');
    expect(html).not.toContain("Rewind needs 366 days of detailed data.");
  });

  it("does not warn on an unset (empty/null) value despite a warnBelow hint (#575)", () => {
    for (const current of ["", null, undefined] as const) {
      const html = renderSettingsPage({
        ...COMMON,
        groups: [
          {
            category: "voicetracking",
            rows: [
              {
                key: "voicetracking.cleanup.retention.detailed_sessions_days",
                current,
                defaultValue: 400,
                type: "number",
                description: "",
                category: "voicetracking",
                warnBelow: {
                  value: 366,
                  message: "Rewind needs 366 days of detailed data.",
                },
              },
            ],
          },
        ],
      });
      expect(html).not.toContain('class="settings-warn"');
    }
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
    expect(onHtml).toMatch(
      /type="checkbox" name="value_x\.enabled" value="true" checked/,
    );

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
      /type="checkbox" name="value_x\.enabled" value="true" checked/,
    );
  });

  it("renders a channel-type setting as a single-select dropdown populated from textChannels", () => {
    const html = renderSettingsPage({
      ...COMMON,
      textChannels: [
        { id: "111", name: "general" },
        { id: "222", name: "voice-stats" },
      ],
      categoryChannels: [],
      roles: [],
      groups: [
        {
          category: "voicetracking",
          rows: [
            {
              key: "voicetracking.announcements.channel_id",
              label: "Announcement channel",
              current: "222",
              defaultValue: "",
              type: "channel",
              description: "",
              category: "voicetracking",
            },
          ],
        },
      ],
    });
    expect(html).toContain(
      '<select name="value_voicetracking.announcements.channel_id">',
    );
    expect(html).toContain('<option value="111">#general</option>');
    expect(html).toContain(
      '<option value="222" selected>#voice-stats</option>',
    );
  });

  it("renders a category-type setting from categoryChannels", () => {
    const html = renderSettingsPage({
      ...COMMON,
      textChannels: [],
      categoryChannels: [{ id: "cat-1", name: "Voice Channels" }],
      roles: [],
      groups: [
        {
          category: "voicechannels",
          rows: [
            {
              key: "voicechannels.category_id",
              label: "Managed category",
              current: "cat-1",
              defaultValue: "",
              type: "category",
              description: "",
              category: "voicechannels",
            },
          ],
        },
      ],
    });
    expect(html).toContain(
      '<option value="cat-1" selected>#Voice Channels</option>',
    );
  });

  it("renders a role-type setting from roles with the @ prefix", () => {
    const html = renderSettingsPage({
      ...COMMON,
      textChannels: [],
      categoryChannels: [],
      roles: [
        { id: "r1", name: "Admin" },
        { id: "r2", name: "Member" },
      ],
      groups: [
        {
          category: "amikool",
          rows: [
            {
              key: "amikool.role_id",
              label: "Kool role",
              current: "r1",
              defaultValue: "",
              type: "role",
              description: "",
              category: "amikool",
            },
          ],
        },
      ],
    });
    expect(html).toContain('<option value="r1" selected>@Admin</option>');
    expect(html).toContain('<option value="r2">@Member</option>');
  });

  it("renders a text channel_list-type setting as a multi-select with CSV pre-selection", () => {
    const html = renderSettingsPage({
      ...COMMON,
      textChannels: [
        { id: "111", name: "general" },
        { id: "222", name: "afk" },
        { id: "333", name: "other" },
      ],
      voiceChannels: [],
      categoryChannels: [],
      roles: [],
      groups: [
        {
          category: "messagetracking",
          rows: [
            {
              key: "messagetracking.excluded_channels",
              label: "Excluded channels",
              current: "111,333",
              defaultValue: "",
              type: "channel_list",
              description: "",
              category: "messagetracking",
            },
          ],
        },
      ],
    });
    expect(html).toMatch(
      /<select name="value_messagetracking\.excluded_channels" multiple/,
    );
    expect(html).toContain('<option value="111" selected>#general</option>');
    expect(html).toContain('<option value="222">#afk</option>');
    expect(html).toContain('<option value="333" selected>#other</option>');
  });

  it("renders a voice channel_list (channelKind: voice) from voiceChannels, not textChannels (#611)", () => {
    const html = renderSettingsPage({
      ...COMMON,
      textChannels: [{ id: "t1", name: "general-text" }],
      voiceChannels: [
        { id: "v1", name: "Lounge" },
        { id: "v2", name: "Gaming" },
        { id: "v3", name: "AFK" },
      ],
      categoryChannels: [],
      roles: [],
      groups: [
        {
          category: "voicetracking",
          rows: [
            {
              key: "voicetracking.excluded_channels",
              label: "Excluded channels",
              current: "v1,v3",
              defaultValue: "",
              type: "channel_list",
              description: "",
              category: "voicetracking",
              channelKind: "voice",
            },
          ],
        },
      ],
    });
    // Voice channels are offered…
    expect(html).toContain('<option value="v1" selected>#Lounge</option>');
    expect(html).toContain('<option value="v2">#Gaming</option>');
    expect(html).toContain('<option value="v3" selected>#AFK</option>');
    // …and the text channel is NOT present in this control.
    expect(html).not.toContain("general-text");
    // Selected channels render as a readable, separated summary (no blob).
    expect(html).toContain("Selected: #Lounge, #AFK");
  });

  it("renders a role_list-type setting as a multi-select with CSV pre-selection", () => {
    const html = renderSettingsPage({
      ...COMMON,
      textChannels: [],
      categoryChannels: [],
      roles: [
        { id: "r1", name: "Admin" },
        { id: "r2", name: "Mod" },
      ],
      groups: [
        {
          category: "quotes",
          rows: [
            {
              key: "quotes.delete_roles",
              label: "Roles allowed to delete quotes",
              current: "r2",
              defaultValue: "",
              type: "role_list",
              description: "",
              category: "quotes",
            },
          ],
        },
      ],
    });
    expect(html).toMatch(/<select name="value_quotes\.delete_roles" multiple/);
    expect(html).toContain('<option value="r1">@Admin</option>');
    expect(html).toContain('<option value="r2" selected>@Mod</option>');
  });

  it("surfaces stored IDs that aren't in the live options as `(missing) <id>` and keeps them selected", () => {
    // The configured channel was deleted from Discord (or the bot's
    // cache is stale). The dropdown must still preserve the stored value
    // so saving the form doesn't silently clear the setting.
    const singleSelect = renderSettingsPage({
      ...COMMON,
      textChannels: [{ id: "111", name: "general" }],
      categoryChannels: [],
      roles: [],
      groups: [
        {
          category: "voicetracking",
          rows: [
            {
              key: "voicetracking.announcements.channel_id",
              label: "Announcement channel",
              current: "999-deleted",
              defaultValue: "",
              type: "channel",
              description: "",
              category: "voicetracking",
            },
          ],
        },
      ],
    });
    expect(singleSelect).toContain(
      '<option value="999-deleted" selected>(missing) 999-deleted</option>',
    );
    // And the "(none)" placeholder should NOT be the selected one in this
    // case — the missing-ID option carries the selection.
    expect(singleSelect).toMatch(/<option value=""[^>]*>\(none\)<\/option>/);
    expect(singleSelect).not.toMatch(
      /<option value="" selected>\(none\)<\/option>/,
    );

    // Multi-select case: one known + one missing.
    const multiSelect = renderSettingsPage({
      ...COMMON,
      textChannels: [{ id: "111", name: "general" }],
      categoryChannels: [],
      roles: [],
      groups: [
        {
          category: "voicetracking",
          rows: [
            {
              key: "voicetracking.excluded_channels",
              label: "Excluded channels",
              current: "111,999-deleted",
              defaultValue: "",
              type: "channel_list",
              description: "",
              category: "voicetracking",
            },
          ],
        },
      ],
    });
    expect(multiSelect).toContain(
      '<option value="111" selected>#general</option>',
    );
    expect(multiSelect).toContain(
      '<option value="999-deleted" selected>(missing) 999-deleted</option>',
    );
  });

  it("renders an options-typed setting as a single-select with the current value pre-selected", () => {
    const html = renderSettingsPage({
      ...COMMON,
      textChannels: [],
      categoryChannels: [],
      roles: [],
      groups: [
        {
          category: "leaderboard_roles",
          rows: [
            {
              key: "leaderboard_roles.period",
              label: "Period",
              current: "month",
              defaultValue: "alltime",
              type: "string",
              description: "",
              category: "leaderboard_roles",
              options: [
                { value: "week", label: "This week" },
                { value: "month", label: "This month" },
                { value: "alltime", label: "All time" },
              ],
            },
          ],
        },
      ],
    });
    expect(html).toContain('<select name="value_leaderboard_roles.period">');
    expect(html).toContain('<option value="week">This week</option>');
    expect(html).toContain(
      '<option value="month" selected>This month</option>',
    );
    expect(html).toContain('<option value="alltime">All time</option>');
    // No free-text input is emitted for an options key.
    expect(html).not.toContain(
      '<input type="text" name="value_leaderboard_roles.period"',
    );
  });

  it("surfaces an out-of-range options value as a selected `(unknown)` option", () => {
    const html = renderSettingsPage({
      ...COMMON,
      textChannels: [],
      categoryChannels: [],
      roles: [],
      groups: [
        {
          category: "leaderboard_roles",
          rows: [
            {
              key: "leaderboard_roles.period",
              label: "Period",
              current: "fortnight",
              defaultValue: "alltime",
              type: "string",
              description: "",
              category: "leaderboard_roles",
              options: [
                { value: "week", label: "This week" },
                { value: "month", label: "This month" },
                { value: "alltime", label: "All time" },
              ],
            },
          ],
        },
      ],
    });
    expect(html).toContain(
      '<option value="fortnight" selected>(unknown) fortnight</option>',
    );
    // None of the known options should be selected when the stored value is
    // out of range.
    expect(html).not.toMatch(/value="(week|month|alltime)" selected/);
  });

  it("surfaces an empty options value as a selected `(choose a value)` placeholder rather than defaulting to the first option", () => {
    const html = renderSettingsPage({
      ...COMMON,
      textChannels: [],
      categoryChannels: [],
      roles: [],
      groups: [
        {
          category: "leaderboard_roles",
          rows: [
            {
              key: "leaderboard_roles.period",
              label: "Period",
              current: "",
              defaultValue: "alltime",
              type: "string",
              description: "",
              category: "leaderboard_roles",
              options: [
                { value: "week", label: "This week" },
                { value: "month", label: "This month" },
                { value: "alltime", label: "All time" },
              ],
            },
          ],
        },
      ],
    });
    // An empty stored value is out-of-range for an options key (coerceConfigValue
    // rejects ""), so it must not silently select+submit the first valid option.
    expect(html).toContain(
      '<option value="" selected>(choose a value)</option>',
    );
    expect(html).not.toMatch(/value="(week|month|alltime)" selected/);
  });

  // ---- Feature-dependency greying (#666) ----

  it("greys + disables a control whose hard dependsOn target is off, with a 'requires X' hint", () => {
    const html = renderSettingsPage({
      ...COMMON,
      groups: [
        {
          category: "voicetracking",
          rows: [
            {
              key: "voicetracking.enabled",
              current: false,
              defaultValue: false,
              type: "boolean",
              description: "",
              category: "voicetracking",
            },
          ],
        },
        {
          category: "achievements",
          rows: [
            {
              key: "achievements.enabled",
              current: false,
              defaultValue: false,
              type: "boolean",
              description: "",
              category: "achievements",
            },
          ],
        },
      ],
    });
    // The dependent control renders disabled and dep-locked so the cascade
    // script can't re-enable it under an enabled section master.
    expect(html).toMatch(
      /name="value_achievements\.enabled"[^>]*\bdisabled\b[^>]*data-dep-locked/,
    );
    // Its row is greyed via the static dependency class.
    expect(html).toContain('<tr class="dep-off">');
    // The hint names the unmet dependency by its human label and links to its
    // section, using the same dependsOn graph the write-time validator uses.
    expect(html).toContain(
      'Requires <a href="#section-voicetracking">Voice Tracking enabled</a> enabled',
    );
  });

  it("round-trips a dep-locked control's current value via a hidden input so a section Save can't clobber it (#666)", () => {
    const html = renderSettingsPage({
      ...COMMON,
      groups: [
        {
          category: "voicetracking",
          rows: [
            {
              key: "voicetracking.enabled",
              current: true,
              defaultValue: false,
              type: "boolean",
              description: "",
              category: "voicetracking",
            },
          ],
        },
        {
          category: "achievements",
          rows: [
            {
              key: "achievements.enabled",
              current: false,
              defaultValue: false,
              type: "boolean",
              description: "",
              category: "achievements",
            },
          ],
        },
        {
          category: "digest",
          rows: [
            // Section master is ON (depends only on voice tracking, which is
            // on), so the cascade-skip in save-section does NOT protect the
            // dependent below — it's the cross-section case the hidden
            // round-trip exists for.
            {
              key: "digest.enabled",
              current: true,
              defaultValue: false,
              type: "boolean",
              description: "",
              category: "digest",
            },
            // Dep-locked: depends on achievements.enabled, which is off. Its
            // disabled checkbox wouldn't be submitted, so a hidden input must
            // round-trip the stored `true` or Save would flip it to false.
            {
              key: "digest.include_achievements",
              current: true,
              defaultValue: false,
              type: "boolean",
              description: "",
              category: "digest",
            },
          ],
        },
      ],
    });
    // Hidden input carries the current value so the disabled (unsubmitted)
    // checkbox can't be clobbered on Save.
    expect(html).toContain(
      '<input type="hidden" name="value_digest.include_achievements" value="true">',
    );
    // The visible checkbox is still disabled + dep-locked.
    expect(html).toMatch(
      /type="checkbox" name="value_digest\.include_achievements"[^>]*\bdisabled\b[^>]*data-dep-locked/,
    );
    // The master toggle (dependency met) is neither locked nor round-tripped
    // with a hidden value field.
    expect(html).not.toMatch(
      /name="value_digest\.enabled"[^>]*data-dep-locked/,
    );
    expect(html).not.toContain(
      '<input type="hidden" name="value_digest.enabled"',
    );
  });

  it("leaves the control editable once its dependency is enabled", () => {
    const html = renderSettingsPage({
      ...COMMON,
      groups: [
        {
          category: "voicetracking",
          rows: [
            {
              key: "voicetracking.enabled",
              current: true,
              defaultValue: false,
              type: "boolean",
              description: "",
              category: "voicetracking",
            },
          ],
        },
        {
          category: "achievements",
          rows: [
            {
              key: "achievements.enabled",
              current: false,
              defaultValue: false,
              type: "boolean",
              description: "",
              category: "achievements",
            },
          ],
        },
      ],
    });
    // Dependency met → the control isn't locked, greyed, or hinted. (The
    // cascade script always mentions `data-dep-locked`, so assert against the
    // specific control rather than the whole document.)
    expect(html).not.toMatch(
      /name="value_achievements\.enabled"[^>]*data-dep-locked/,
    );
    expect(html).not.toContain('<tr class="dep-off">');
    expect(html).not.toContain("settings-dep-hint");
  });

  it("never greys rewind toggles for dependency reasons even when voice tracking is off", () => {
    const html = renderSettingsPage({
      ...COMMON,
      groups: [
        {
          category: "voicetracking",
          rows: [
            {
              key: "voicetracking.enabled",
              current: false,
              defaultValue: false,
              type: "boolean",
              description: "",
              category: "voicetracking",
            },
          ],
        },
        {
          category: "rewind",
          rows: [
            {
              key: "rewind.nudge.enabled",
              current: false,
              defaultValue: false,
              type: "boolean",
              description: "",
              category: "rewind",
            },
          ],
        },
      ],
    });
    // Rewind declares no dependsOn, so its control is never dep-locked or
    // dep-greyed regardless of voice-tracking state. (The cascade script always
    // mentions `data-dep-locked`, so assert against the specific control.)
    expect(html).not.toMatch(
      /name="value_rewind\.nudge\.enabled"[^>]*data-dep-locked/,
    );
    expect(html).not.toContain('<tr class="dep-off">');
    expect(html).not.toContain("settings-dep-hint");
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

  it("renders a per-row Post now action", () => {
    const html = renderAnnouncementsPage({
      ...COMMON,
      enabled: true,
      rows: [
        {
          id: "a1",
          channelName: "general",
          cron: "0 9 * * *",
          enabled: true,
          messagePreview: "hi",
          embedTitle: null,
          placeholders: false,
          createdAt: "2026-05-08T00:00:00.000Z",
        },
      ],
      textChannels: [{ id: "c1", name: "general" }],
    });
    expect(html).toContain("/admin/announcements/a1/post-now");
    expect(html).toContain(">Post now<");
  });

  it("renders the compose & send-once form and expanded placeholders", () => {
    const html = renderAnnouncementsPage({
      ...COMMON,
      enabled: true,
      rows: [],
      textChannels: [{ id: "c1", name: "general" }],
    });
    expect(html).toContain("/admin/announcements/post-once");
    expect(html).toContain("Compose &amp; send once");
    // New placeholder tokens surfaced in the reference help.
    expect(html).toContain("{online_count}");
    expect(html).toContain("{boost_count}");
    expect(html).toContain("{random_member}");
    expect(html).toContain("{datetime_iso}");
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

  it("renders an enable banner with an inline action when disabled (#610)", () => {
    const html = renderPollsPage({
      ...COMMON,
      enabled: false,
      defaultDurationHours: 24,
      cooldownDays: 7,
      schedules: [],
      items: [],
      textChannels: [],
      roles: [],
    });
    // The disabled page explains the state instead of looking blank...
    expect(html).toContain('class="notice warn feature-disabled"');
    expect(html).toContain("Polls are disabled");
    // ...and offers an inline enable that flips polls.enabled and returns here.
    expect(html).toContain('action="/admin/settings/set"');
    expect(html).toContain('name="key" value="polls.enabled"');
    expect(html).toContain('name="value" value="true"');
    expect(html).toContain('name="redirect" value="/admin/polls"');
    expect(html).toContain("Open Settings");
  });

  it("omits the enable banner when polls are enabled (#610)", () => {
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
    // The CSS rule for the banner is always present; assert on the rendered
    // notice element rather than the bare class name.
    expect(html).not.toContain('class="notice warn feature-disabled"');
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
          channelId: "c1",
          channelName: "polls",
          cron: "0 12 * * 1",
          durationHours: 12,
          pingRoleId: "r1",
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
          multiSelect: false,
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

  it("renders pre-filled edit forms for each schedule and item row", () => {
    const html = renderPollsPage({
      ...COMMON,
      enabled: true,
      defaultDurationHours: 24,
      cooldownDays: 7,
      schedules: [
        {
          id: "s1",
          channelId: "c1",
          channelName: "polls",
          cron: "0 12 * * 1",
          durationHours: 12,
          pingRoleId: "r1",
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
          multiSelect: true,
          usageCount: 3,
          lastUsed: "—",
          enabled: true,
          source: "manual",
        },
      ],
      textChannels: [{ id: "c1", name: "polls" }],
      roles: [{ id: "r1", name: "Members" }],
    });
    // Edit routes are present per row.
    expect(html).toContain("/admin/polls/schedules/s1/edit");
    expect(html).toContain("/admin/polls/items/i1/edit");
    // Edit forms are pre-filled with the row's current values.
    expect(html).toContain('value="0 12 * * 1"');
    expect(html).toContain('value="Yes, No"');
    expect(html).toContain('value="food"');
    // The selected channel/role and multiSelect state are reflected.
    expect(html).toContain('value="c1" selected');
    expect(html).toContain('value="r1" selected');
    expect(html).toContain('name="multiSelect" value="1" checked');
  });

  it("preserves a deleted channel/role id in the edit form instead of defaulting", () => {
    const html = renderPollsPage({
      ...COMMON,
      enabled: true,
      defaultDurationHours: 24,
      cooldownDays: 7,
      schedules: [
        {
          id: "s1",
          channelId: "gone-chan",
          channelName: "gone-chan",
          cron: "0 12 * * 1",
          durationHours: 12,
          pingRoleId: "gone-role",
          pingRoleName: "gone-role",
          enabled: true,
          lastRun: "—",
        },
      ],
      items: [],
      textChannels: [{ id: "c1", name: "polls" }],
      roles: [{ id: "r1", name: "Members" }],
    });
    // The saved-but-missing ids stay selected so a cron-only edit can't
    // silently reassign the channel or clear the ping role.
    expect(html).toContain('value="gone-chan" selected');
    expect(html).toContain('value="gone-role" selected');
    expect(html).toContain("(unavailable)");
  });

  it("renders write forms for schedules, items and file/paste import", () => {
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
    // The sole import path is the file-upload/paste form (#646): no URL import.
    expect(html).toContain("/admin/polls/items/import-text");
    expect(html).toContain('id="poll-import-file"');
    expect(html).not.toContain('action="/admin/polls/items/import"');
    expect(html).not.toContain('name="url"');
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
      settingRows: [],
      categoryChannels: [],
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
      settingRows: [],
      categoryChannels: [],
    });
    expect(html).toContain('class="tag tag-info">lobby');
    expect(html).toContain('class="tag tag-warn">dynamic');
    expect(html).toContain('class="tag tag-warn">LIVE');
    expect(html).toContain("Friday night");
    expect(html).toContain("/admin/voice-channels/force-reload");
    expect(html).not.toContain('action="/admin/voice-channels/reload"');
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
      settingRows: [],
      categoryChannels: [],
    });
    expect(html).toMatch(
      /<button[^>]*type="submit"[^>]*disabled[^>]*>Force VC cleanup<\/button>/,
    );
    expect(html).not.toContain("Clean up empty channels");
  });

  it("renders editable voicechannels settings that post through save-section", () => {
    const html = renderVoiceChannelsPage({
      ...COMMON,
      enabled: true,
      controlPanelEnabled: true,
      categoryName: "Voice",
      lobbyName: "Lobby",
      offlineLobbyName: "Offline Lobby",
      prefix: "🎮",
      totalManaged: 0,
      totalEmpty: 0,
      channels: [],
      categoryFound: true,
      categoryChannels: [{ id: "cat-1", name: "Voice Channels" }],
      settingRows: [
        {
          key: "voicechannels.category_id",
          label: "Managed category",
          current: "cat-1",
          defaultValue: "",
          type: "category",
          description: "The managed category.",
          category: "voicechannels",
        },
        {
          key: "voicechannels.lobby.name",
          label: "Lobby channel display name",
          current: "Lobby",
          defaultValue: "Lobby",
          type: "string",
          description: "Lobby name.",
          category: "voicechannels",
        },
        {
          key: "voicechannels.controlpanel.enabled",
          label: "In-channel control panel enabled",
          current: true,
          defaultValue: true,
          type: "boolean",
          description: "Control panel.",
          category: "voicechannels",
        },
      ],
    });
    // Posts through the shared settings route, back to this page, cascade off.
    expect(html).toContain(
      '<form method="POST" action="/admin/settings/save-section">',
    );
    expect(html).toContain(
      '<input type="hidden" name="redirect" value="/admin/voice-channels">',
    );
    expect(html).toContain(
      '<input type="hidden" name="no_cascade" value="1">',
    );
    expect(html).toContain(
      '<input type="hidden" name="category" value="voicechannels">',
    );
    // The category key renders as a picker sourced from categoryChannels.
    expect(html).toContain(
      '<option value="cat-1" selected>#Voice Channels</option>',
    );
    // The lobby name renders as a text input carrying its current value.
    expect(html).toContain('name="value_voicechannels.lobby.name"');
    // The control-panel flag renders as a checkbox.
    expect(html).toContain('name="value_voicechannels.controlpanel.enabled"');
    expect(html).toContain(">Save settings</button>");
  });

  it("omits the settings card when there are no editable rows", () => {
    const html = renderVoiceChannelsPage({
      ...COMMON,
      enabled: true,
      controlPanelEnabled: true,
      categoryName: "Voice",
      lobbyName: "Lobby",
      offlineLobbyName: "Offline Lobby",
      prefix: "🎮",
      totalManaged: 0,
      totalEmpty: 0,
      channels: [],
      categoryFound: true,
      settingRows: [],
      categoryChannels: [],
    });
    // No settings form is emitted (the substring in the shared AJAX script
    // doesn't count — assert on this page's own form markup instead).
    expect(html).not.toContain(
      '<form method="POST" action="/admin/settings/save-section">',
    );
    expect(html).not.toContain(">Save settings</button>");
  });
});

describe("renderDigestPage", () => {
  const DIGEST_CONFIG = {
    enabled: true,
    cron: "0 9 * * 1",
    minActiveMinutes: 30,
    streakMinMinutes: 30,
    includeAchievements: true,
  };

  it("renders the feature-disabled banner and disables actions when off", () => {
    const html = renderDigestPage({
      ...COMMON,
      ...DIGEST_CONFIG,
      enabled: false,
      preview: null,
    });
    expect(html).toContain("feature-disabled");
    expect(html).toMatch(
      /<button[^>]*name="preview"[^>]*disabled[^>]*>Preview digest<\/button>/,
    );
    expect(html).toMatch(
      /<button[^>]*type="submit"[^>]*disabled[^>]*>Send now<\/button>/,
    );
  });

  it("exposes the preview (GET) and send-now (POST) actions when enabled", () => {
    const html = renderDigestPage({
      ...COMMON,
      ...DIGEST_CONFIG,
      preview: null,
    });
    expect(html).toContain('method="GET" action="/admin/digest"');
    expect(html).toContain('action="/admin/digest/send-now"');
    // No preview requested → no rendered embed card (the CSS in <style> stays).
    expect(html).not.toContain('<div class="digest-embed">');
  });

  it("renders the summary line and embed cards for a preview", () => {
    const html = renderDigestPage({
      ...COMMON,
      ...DIGEST_CONFIG,
      preview: {
        generatedAt: "2026-06-22T09:00:00.000Z",
        weekRange: "Jun 15 – Jun 22",
        qualifying: 3,
        optedIn: 2,
        skippedOptOut: 1,
        alreadySentAt: null,
        includeAchievements: true,
        limit: 25,
        entries: [
          {
            username: "alice",
            rank: 1,
            title: "📊 Your weekly voice digest",
            description: "Here's a snapshot, alice.",
            fields: [
              {
                name: "This week",
                value: "5h\n▲ 1h vs last week",
                inline: true,
              },
              { name: "Rank", value: "#1", inline: true },
            ],
            footer: "Keep it up!\nDon't want these? Run /config.",
          },
        ],
      },
    });
    expect(html).toContain("members qualify");
    expect(html).toContain("opted in");
    expect(html).toContain("opted out");
    expect(html).toContain("digest has not been sent yet this week");
    expect(html).toContain('<div class="digest-embed">');
    expect(html).toContain("alice");
    // Newlines in field values become <br> in the HTML approximation.
    expect(html).toContain("▲ 1h vs last week");
  });

  it("shows the already-sent state when a delivery landed this week", () => {
    const html = renderDigestPage({
      ...COMMON,
      ...DIGEST_CONFIG,
      preview: {
        generatedAt: "2026-06-22T09:00:00.000Z",
        weekRange: "Jun 15 – Jun 22",
        qualifying: 1,
        optedIn: 1,
        skippedOptOut: 0,
        alreadySentAt: "2026-06-22T09:00:00.000Z",
        includeAchievements: false,
        limit: 25,
        entries: [],
      },
    });
    expect(html).toContain("already sent at");
    // Achievements-off note surfaces.
    expect(html).toContain("digest.include_achievements");
    expect(html).toContain(
      "No opted-in members qualify for the digest this week",
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
  it("renders every feature checkbox unchecked regardless of current status", () => {
    const html = renderWizardPage({
      ...COMMON,
      featureOrder: ["voicechannels", "polls"],
      featureStatus: { voicechannels: true, polls: false },
    });
    expect(html).toContain("Voice Channels");
    expect(html).toContain("Polls");
    // Neither checkbox should be pre-ticked, even though voicechannels is
    // currently enabled. The wizard treats each run as a fresh declaration.
    expect(html).not.toMatch(
      /value="voicechannels" id="feat-voicechannels" checked/,
    );
    expect(html).not.toMatch(/value="polls" id="feat-polls" checked/);
    expect(html).toContain('action="/admin/wizard/start"');
  });

  it("shows ON/OFF indicator next to each feature label", () => {
    const html = renderWizardPage({
      ...COMMON,
      featureOrder: ["voicechannels", "polls"],
      featureStatus: { voicechannels: true, polls: false },
    });
    // voicechannels is currently enabled → tag-on.
    expect(html).toMatch(
      /Voice Channels\s*<span class="fc-current"><span class="tag tag-on">ON<\/span><\/span>/,
    );
    // polls is currently disabled → tag-off.
    expect(html).toMatch(
      /Polls\s*<span class="fc-current"><span class="tag tag-off">OFF<\/span><\/span>/,
    );
  });

  it("sorts enabled features above disabled ones, stable within each group", () => {
    const html = renderWizardPage({
      ...COMMON,
      featureOrder: [
        "voicechannels",
        "voicetracking",
        "quotes",
        "achievements",
        "reactionroles",
        "announcements",
      ],
      featureStatus: {
        voicechannels: true,
        voicetracking: false,
        quotes: true,
        achievements: false,
        reactionroles: true,
        announcements: false,
      },
    });
    // Enabled (voicechannels, quotes, reactionroles) keep their relative order
    // and precede disabled (voicetracking, achievements, announcements), which
    // also keep their relative order.
    const order = [
      "voicechannels",
      "quotes",
      "reactionroles",
      "voicetracking",
      "achievements",
      "announcements",
    ].map((fk) => html.indexOf(`id="feat-${fk}"`));
    for (const idx of order) expect(idx).toBeGreaterThanOrEqual(0);
    const sorted = [...order].sort((a, b) => a - b);
    expect(order).toEqual(sorted);
  });
});

describe("renderWizardStepPage", () => {
  it("renders boolean/number/string controls with the current value and human labels", () => {
    const html = renderWizardStepPage({
      ...COMMON,
      ...EMPTY_PICKERS,
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
        "voicechannels.enabled": {
          label: "Voice Channel Management enabled",
          description: "Enable VC",
          category: "voicechannels",
          type: "boolean",
        },
        "quotes.max_length": {
          label: "Max quote length",
          description: "Max characters",
          category: "quotes",
          type: "number",
        },
        "voicechannels.lobby.name": {
          label: "Lobby channel display name",
          description: "Lobby name",
          category: "voicechannels",
          type: "string",
        },
      },
    });
    expect(html).toContain("Step 1 of 2");
    expect(html).toContain('action="/admin/wizard/step/0"');
    // Human-readable label shown; the raw dotted key is demoted to monospace
    // helper text rather than used as the field label (#702).
    expect(html).toContain("Voice Channel Management enabled");
    expect(html).toContain('<code class="mono muted"');
    // Every field posts the value_-prefixed name shared with the Settings page.
    expect(html).toMatch(
      /type="checkbox"[^>]*name="value_voicechannels.enabled"[^>]*value="true" checked/,
    );
    expect(html).toMatch(
      /type="number"[^>]*name="value_quotes.max_length"[^>]*value="500"/,
    );
    expect(html).toContain('value="Lobby"');
    expect(html).toContain("Enable VC");
    // Each field label is associated with its control via matching for/id so
    // screen readers and click-to-focus keep working (#703).
    expect(html).toContain('for="wiz-voicechannels.enabled"');
    expect(html).toMatch(/type="checkbox" id="wiz-voicechannels.enabled"/);
    expect(html).toMatch(/type="number" id="wiz-quotes.max_length"/);
  });

  it("renders a channel key as a real channel dropdown instead of a free-text ID box (#703)", () => {
    const html = renderWizardStepPage({
      ...COMMON,
      ...EMPTY_PICKERS,
      textChannels: [
        { id: "chan-1", name: "general" },
        { id: "chan-2", name: "announcements" },
      ],
      stepIndex: 0,
      totalSteps: 1,
      featureKey: "reactionroles",
      settingKeys: [
        "reactionroles.enabled",
        "reactionroles.message_channel_id",
      ],
      currentValues: {
        "reactionroles.enabled": true,
        "reactionroles.message_channel_id": "chan-2",
      },
      defaultValues: {
        "reactionroles.enabled": false,
        "reactionroles.message_channel_id": "",
      },
      metadata: {
        "reactionroles.enabled": {
          label: "Reaction roles enabled",
          description: "",
          category: "reactionroles",
          type: "boolean",
        },
        "reactionroles.message_channel_id": {
          label: "Reaction-role message channel",
          description: "Channel that hosts the reaction-role message",
          category: "reactionroles",
          type: "channel",
        },
      },
    });
    // A real channel <select> populated from the picker, with the current
    // channel pre-selected — not a raw-ID text box.
    expect(html).toMatch(
      /<select[^>]*name="value_reactionroles.message_channel_id"/,
    );
    expect(html).toContain(
      '<option value="chan-2" selected>#announcements</option>',
    );
    expect(html).toContain("Reaction-role message channel");
    expect(html).not.toMatch(
      /type="text"[^>]*name="value_reactionroles.message_channel_id"/,
    );
  });

  it("renders channel/category/role picker keys as dropdowns from the guild lists (#703)", () => {
    const html = renderWizardStepPage({
      ...COMMON,
      ...EMPTY_PICKERS,
      textChannels: [
        { id: "chan-1", name: "announcements" },
        { id: "chan-2", name: "general" },
      ],
      categoryChannels: [{ id: "cat-1", name: "Voice Channels" }],
      roles: [{ id: "role-1", name: "Moderator" }],
      stepIndex: 0,
      totalSteps: 1,
      featureKey: "reactionroles",
      settingKeys: [
        "reactionroles.message_channel_id",
        "voicechannels.category_id",
        "leaderboard_roles.some_role",
      ],
      currentValues: {
        "reactionroles.message_channel_id": "chan-1",
        "voicechannels.category_id": "",
        "leaderboard_roles.some_role": "",
      },
      defaultValues: {
        "reactionroles.message_channel_id": "",
        "voicechannels.category_id": "",
        "leaderboard_roles.some_role": "",
      },
      metadata: {
        "reactionroles.message_channel_id": {
          label: "Message channel",
          description: "Message channel",
          category: "reactionroles",
          type: "channel",
        },
        "voicechannels.category_id": {
          label: "Managed category",
          description: "Voice channel category",
          category: "voicechannels",
          type: "category",
        },
        "leaderboard_roles.some_role": {
          label: "Reward role",
          description: "A role",
          category: "leaderboard_roles",
          type: "role",
        },
      },
    });
    // Channel key → text-channel dropdown with the current value selected,
    // carrying an id its label points at (#703).
    expect(html).toMatch(
      /<select id="wiz-reactionroles.message_channel_id" name="value_reactionroles.message_channel_id">/,
    );
    expect(html).toContain('for="wiz-reactionroles.message_channel_id"');
    expect(html).toContain(
      '<option value="chan-1" selected>#announcements</option>',
    );
    expect(html).toContain('<option value="chan-2">#general</option>');
    // Category key → category dropdown.
    expect(html).toMatch(
      /<select id="wiz-voicechannels.category_id" name="value_voicechannels.category_id">/,
    );
    expect(html).toContain('<option value="cat-1">#Voice Channels</option>');
    // Role key → role dropdown with the `@` prefix.
    expect(html).toMatch(
      /<select id="wiz-leaderboard_roles.some_role" name="value_leaderboard_roles.some_role">/,
    );
    expect(html).toContain('<option value="role-1">@Moderator</option>');
    // No raw free-text input is emitted for any of these picker keys.
    expect(html).not.toContain('<input type="text"');
  });

  it("renders an options-backed key as a <select> using the value_ field name and pre-selects the current value", () => {
    const html = renderWizardStepPage({
      ...COMMON,
      ...EMPTY_PICKERS,
      stepIndex: 0,
      totalSteps: 1,
      featureKey: "leaderboard_roles",
      settingKeys: ["leaderboard_roles.period"],
      currentValues: { "leaderboard_roles.period": "month" },
      defaultValues: { "leaderboard_roles.period": "alltime" },
      metadata: {
        "leaderboard_roles.period": {
          label: "Leaderboard window",
          description: "Activity window",
          category: "leaderboard_roles",
          type: "string",
          options: [
            { value: "week", label: "This week" },
            { value: "month", label: "This month" },
            { value: "alltime", label: "All time" },
          ],
        },
      },
    });
    // The wizard shares the Settings page's value_-prefixed field name, with an
    // id the label points at.
    expect(html).toMatch(
      /<select name="value_leaderboard_roles.period" id="wiz-leaderboard_roles.period">/,
    );
    expect(html).toContain('for="wiz-leaderboard_roles.period"');
    expect(html).toContain(
      '<option value="month" selected>This month</option>',
    );
    expect(html).toContain('<option value="week">This week</option>');
    // No free-text input for an options key.
    expect(html).not.toMatch(
      /type="text"[^>]*name="value_leaderboard_roles.period"/,
    );
  });

  it("surfaces an out-of-range options value in the wizard as a selected `(unknown)` option", () => {
    const html = renderWizardStepPage({
      ...COMMON,
      ...EMPTY_PICKERS,
      stepIndex: 0,
      totalSteps: 1,
      featureKey: "leaderboard_roles",
      settingKeys: ["leaderboard_roles.period"],
      currentValues: { "leaderboard_roles.period": "fortnight" },
      defaultValues: { "leaderboard_roles.period": "alltime" },
      metadata: {
        "leaderboard_roles.period": {
          label: "Leaderboard window",
          description: "Activity window",
          category: "leaderboard_roles",
          type: "string",
          options: [
            { value: "week", label: "This week" },
            { value: "month", label: "This month" },
            { value: "alltime", label: "All time" },
          ],
        },
      },
    });
    expect(html).toContain(
      '<option value="fortnight" selected>(unknown) fortnight</option>',
    );
    expect(html).not.toMatch(/value="(week|month|alltime)" selected/);
  });

  it("renders a flash banner when coercion drops fields", () => {
    const html = renderWizardStepPage({
      ...COMMON,
      ...EMPTY_PICKERS,
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
      ...EMPTY_PICKERS,
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

  it("omits the Previous button on the first step (#485)", () => {
    const html = renderWizardStepPage({
      ...COMMON,
      ...EMPTY_PICKERS,
      stepIndex: 0,
      totalSteps: 3,
      featureKey: "quotes",
      settingKeys: [],
      currentValues: {},
      defaultValues: {},
      metadata: {},
    });
    expect(html).not.toContain("← Previous");
  });

  it("shows a Previous button linking to the prior step on later steps (#485)", () => {
    const html = renderWizardStepPage({
      ...COMMON,
      ...EMPTY_PICKERS,
      stepIndex: 2,
      totalSteps: 3,
      featureKey: "quotes",
      settingKeys: [],
      currentValues: {},
      defaultValues: {},
      metadata: {},
    });
    expect(html).toContain("← Previous");
    expect(html).toContain('href="/admin/wizard?step=1"');
  });

  it("marks the feature master toggle and form scope for cascading disable (#485)", () => {
    const html = renderWizardStepPage({
      ...COMMON,
      ...EMPTY_PICKERS,
      stepIndex: 0,
      totalSteps: 1,
      featureKey: "voicetracking",
      settingKeys: [
        "voicetracking.enabled",
        "voicetracking.announcements.enabled",
        "voicetracking.announcements.channel_id",
      ],
      currentValues: {
        "voicetracking.enabled": true,
        "voicetracking.announcements.enabled": false,
        "voicetracking.announcements.channel_id": "",
      },
      defaultValues: {
        "voicetracking.enabled": false,
        "voicetracking.announcements.enabled": false,
        "voicetracking.announcements.channel_id": "",
      },
      metadata: {
        "voicetracking.enabled": {
          label: "Voice Tracking enabled",
          description: "",
          category: "voicetracking",
          type: "boolean",
        },
        "voicetracking.announcements.enabled": {
          label: "Scheduled announcements enabled",
          description: "",
          category: "voicetracking",
          type: "boolean",
        },
        "voicetracking.announcements.channel_id": {
          label: "Announcement channel",
          description: "",
          category: "voicetracking",
          type: "channel",
        },
      },
    });
    // The step form is the cascade scope.
    expect(html).toContain('action="/admin/wizard/step/0" data-cascade-scope');
    // Only the top-level feature toggle is the master; the sub-toggle is a
    // dependent (no data-cascade-master attribute).
    expect(html).toMatch(
      /name="value_voicetracking.enabled"[^>]*value="true"[^>]*data-cascade-master/,
    );
    expect(html).not.toMatch(
      /name="value_voicetracking.announcements.enabled"[^>]*data-cascade-master/,
    );
  });

  it("greys out a control whose cross-feature dependency is unmet (#666)", () => {
    const html = renderWizardStepPage({
      ...COMMON,
      ...EMPTY_PICKERS,
      stepIndex: 0,
      totalSteps: 1,
      featureKey: "achievements",
      settingKeys: ["achievements.enabled"],
      currentValues: { "achievements.enabled": false },
      defaultValues: { "achievements.enabled": false },
      // achievements.enabled depends on voicetracking.enabled, which lives on
      // another step and is currently off.
      enabledByKey: {
        "achievements.enabled": false,
        "voicetracking.enabled": false,
      },
      metadata: {
        "achievements.enabled": {
          label: "Achievements enabled",
          description: "",
          category: "achievements",
          type: "boolean",
        },
      },
    });
    expect(html).toContain("dep-off");
    expect(html).toContain("Requires");
    // The disabled control round-trips its value via a sibling hidden input.
    expect(html).toMatch(
      /type="checkbox"[^>]*name="value_achievements.enabled"[^>]*disabled/,
    );
  });
});

describe("findCascadeMasterKey", () => {
  const row = (key: string, type: string) => ({
    key,
    label: key,
    current: undefined,
    defaultValue: undefined,
    type,
    description: "",
    category: key.split(".")[0],
  });

  it("returns the shortest boolean .enabled key as the master", () => {
    expect(
      findCascadeMasterKey([
        row("voicetracking.enabled", "boolean"),
        row("voicetracking.announcements.enabled", "boolean"),
        row("voicetracking.announcements.channel_id", "channel"),
      ]),
    ).toBe("voicetracking.enabled");
  });

  it("ignores non-boolean .enabled keys", () => {
    expect(findCascadeMasterKey([row("quotes.enabled", "string")])).toBeNull();
  });

  it("returns null when no .enabled key exists", () => {
    expect(
      findCascadeMasterKey([
        row("quotes.max_length", "number"),
        row("quotes.channel_id", "channel"),
      ]),
    ).toBeNull();
  });
});

describe("renderSettingsPage cascading disable (#485)", () => {
  it("marks the section master toggle and scopes the form when a .enabled row exists", () => {
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
              description: "",
              category: "voicechannels",
            },
            {
              key: "voicechannels.controlpanel.enabled",
              current: true,
              defaultValue: false,
              type: "boolean",
              description: "",
              category: "voicechannels",
            },
            {
              key: "voicechannels.lobby.name",
              current: "Lobby",
              defaultValue: "Lobby",
              type: "string",
              description: "",
              category: "voicechannels",
            },
          ],
        },
      ],
    });
    expect(html).toContain(
      'action="/admin/settings/save-section" data-cascade-scope',
    );
    expect(html).toMatch(
      /name="value_voicechannels.enabled"[^>]*data-cascade-master/,
    );
    // The sub-toggle is a dependent, not a master.
    expect(html).not.toMatch(
      /name="value_voicechannels.controlpanel.enabled"[^>]*data-cascade-master/,
    );
  });

  it("does not scope sections without a boolean .enabled row", () => {
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
          ],
        },
      ],
    });
    // The save-section form carries no cascade-scope attribute, and no
    // control is tagged as a master. (The shared client script — which
    // references these attribute names as query selectors — is always
    // embedded, so assert against the form/control markup specifically.)
    expect(html).toContain('action="/admin/settings/save-section">');
    expect(html).not.toMatch(/<form[^>]*data-cascade-scope/);
    expect(html).not.toMatch(/name="value_[^"]*"[^>]*data-cascade-master/);
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

describe("parseCronToPickerState", () => {
  it("recognises a daily schedule", () => {
    expect(parseCronToPickerState("0 0 * * *")).toMatchObject({
      mode: "daily",
      minute: 0,
      hour: 0,
    });
    expect(parseCronToPickerState("30 8 * * *")).toMatchObject({
      mode: "daily",
      minute: 30,
      hour: 8,
    });
  });

  it("recognises a weekly schedule and normalises Sunday-7 to Sunday-0", () => {
    expect(parseCronToPickerState("0 16 * * 5")).toMatchObject({
      mode: "weekly",
      minute: 0,
      hour: 16,
      dayOfWeek: 5,
    });
    expect(parseCronToPickerState("0 0 * * 7")).toMatchObject({
      mode: "weekly",
      dayOfWeek: 0,
    });
  });

  it("recognises a monthly schedule", () => {
    expect(parseCronToPickerState("0 0 1 * *")).toMatchObject({
      mode: "monthly",
      minute: 0,
      hour: 0,
      dayOfMonth: 1,
    });
    expect(parseCronToPickerState("45 9 15 * *")).toMatchObject({
      mode: "monthly",
      minute: 45,
      hour: 9,
      dayOfMonth: 15,
    });
  });

  it("falls back to custom for patterns the picker can't represent", () => {
    // Step values, ranges, lists, named months, and anything that doesn't
    // fit the three supported shapes must round-trip verbatim so the
    // operator's intent isn't lost.
    for (const raw of [
      "*/15 * * * *", // every 15 minutes
      "0 9-17 * * 1-5", // ranges in hours and days
      "0 0 1,15 * *", // first and 15th of month
      "0 12 * JAN *", // named month
      "garbage", // not a cron at all
      "0 0 * *", // 4 fields
      "0 0 32 * *", // dom out of range
    ]) {
      expect(parseCronToPickerState(raw)).toMatchObject({
        mode: "custom",
        raw,
      });
    }
  });

  it("preserves the raw cron verbatim on custom-mode fallback", () => {
    const raw = "*/5 * * * MON-FRI";
    expect(parseCronToPickerState(raw).raw).toBe(raw);
  });

  it("strips surrounding quotes before parsing, matching runtime services", () => {
    // voice-channel-truncation, voice-channel-announcer, and
    // scheduled-announcement-service all apply `.replace(/^["']|["']$/g, "")`
    // before handing the cron to CronJob. The picker must agree, or a
    // stored value like `"0 16 * * 5"` would round-trip as custom even
    // though the bot itself treats it as the unquoted form.
    expect(parseCronToPickerState('"0 16 * * 5"')).toMatchObject({
      mode: "weekly",
      minute: 0,
      hour: 16,
      dayOfWeek: 5,
    });
    expect(parseCronToPickerState("'0 0 * * *'")).toMatchObject({
      mode: "daily",
      minute: 0,
      hour: 0,
    });
  });
});

describe("renderSettingsPage cron picker", () => {
  const cronCommon = {
    ...COMMON,
    textChannels: [],
    categoryChannels: [],
    roles: [],
  };

  function withCron(current: string) {
    return renderSettingsPage({
      ...cronCommon,
      groups: [
        {
          category: "voicetracking",
          rows: [
            {
              key: "voicetracking.announcements.schedule",
              label: "Announcement schedule",
              current,
              defaultValue: "0 16 * * 5",
              type: "cron",
              description: "",
              category: "voicetracking",
            },
          ],
        },
      ],
    });
  }

  it("renders the cron picker with mode selector and a hidden value field", () => {
    const html = withCron("0 16 * * 5");
    expect(html).toContain('<div class="cron-picker" data-mode="weekly">');
    // The hidden input is found by the bootstrap script via `.cron-hidden`
    // so its `name` can vary per row under the per-section save form.
    expect(html).toContain(
      '<input type="hidden" class="cron-hidden" name="value_voicetracking.announcements.schedule" value="0 16 * * 5">',
    );
    expect(html).toContain('<select class="cron-mode"');
    expect(html).toContain('<option value="weekly" selected>Weekly</option>');
    // Weekly mode reveals the day-of-week control with the right day picked.
    expect(html).toMatch(/<option value="5" selected>Friday<\/option>/);
    // Other mode-specific wrappers are present but hidden.
    expect(html).toMatch(/<span class="cron-dom-wrap" hidden>/);
    expect(html).toMatch(/<span class="cron-custom-wrap" hidden>/);
  });

  it("falls back to custom mode with the raw cron preserved for unrecognised patterns", () => {
    const html = withCron("*/15 * * * *");
    expect(html).toContain('<div class="cron-picker" data-mode="custom">');
    expect(html).toContain(
      '<option value="custom" selected>Custom (cron)</option>',
    );
    // The custom text input is visible (no `hidden` attr on its wrapper)
    // and pre-populated with the raw value.
    expect(html).toMatch(
      /<span class="cron-custom-wrap"[^h]*>.*<input[^>]*class="cron-custom"[^>]*value="\*\/15 \* \* \* \*"/,
    );
  });

  it("renders a daily schedule with the time pre-populated", () => {
    const html = withCron("30 8 * * *");
    expect(html).toContain('<div class="cron-picker" data-mode="daily">');
    expect(html).toContain('<option value="daily" selected>Daily</option>');
    expect(html).toContain(
      '<input type="time" class="cron-time" value="08:30">',
    );
  });

  it("renders a monthly schedule with the day-of-month pre-populated", () => {
    const html = withCron("0 0 15 * *");
    expect(html).toContain('<div class="cron-picker" data-mode="monthly">');
    expect(html).toMatch(
      /<input type="number" class="cron-dom"[^>]*value="15"/,
    );
  });
});

describe("renderCommandAuditPage", () => {
  const BASE_FILTERS = {
    commandName: "",
    userId: "",
    result: "",
    from: "",
    to: "",
  };

  it("renders the empty state when no rows match", () => {
    const html = renderCommandAuditPage({
      ...COMMON,
      enabled: true,
      retentionDays: 90,
      commandOptions: ["ping", "quote"],
      userOptions: [],
      filters: BASE_FILTERS,
      rows: [],
      total: 0,
      page: 1,
      pageSize: 50,
    });
    expect(html).toContain("Slash-command audit log");
    expect(html).toContain("No command invocations match");
    expect(html).toContain('class="tag tag-on">enabled');
    expect(html).toContain("90 days");
    // Prev/Next are disabled buttons on a single-page result set.
    expect(html).toMatch(/<button[^>]*disabled[^>]*>← Prev<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Next →<\/button>/);
  });

  it("renders an invocation row with the user, command, and result tag", () => {
    const html = renderCommandAuditPage({
      ...COMMON,
      enabled: true,
      retentionDays: 30,
      commandOptions: ["quote"],
      userOptions: [{ id: "u1", label: "Alice" }],
      filters: BASE_FILTERS,
      rows: [
        {
          createdAt: "2026-05-08T12:34:56.000Z",
          discordUserId: "u1",
          userLabel: "Alice",
          commandName: "quote",
          subcommand: "add",
          channelId: "c1",
          channelLabel: "general",
          result: "success",
          errorMessage: null,
          durationMs: 123,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 50,
    });
    expect(html).toContain("Alice");
    expect(html).toContain("/quote add");
    expect(html).toContain("general");
    expect(html).toContain('class="tag tag-on">success');
    expect(html).toContain("123ms");
  });

  it("preserves filters in pagination links and form state", () => {
    const html = renderCommandAuditPage({
      ...COMMON,
      enabled: true,
      retentionDays: 90,
      commandOptions: ["quote", "ping"],
      userOptions: [{ id: "u1", label: "Alice" }],
      filters: {
        commandName: "quote",
        userId: "u1",
        result: "error",
        from: "2026-05-01",
        to: "2026-05-31",
      },
      rows: Array.from({ length: 50 }, (_, i) => ({
        createdAt: `2026-05-${(i + 1).toString().padStart(2, "0")}T00:00:00.000Z`,
        discordUserId: "u1",
        userLabel: "Alice",
        commandName: "quote",
        subcommand: null,
        channelId: null,
        channelLabel: null,
        result: "error" as const,
        errorMessage: "boom",
        durationMs: 1,
      })),
      total: 120,
      page: 1,
      pageSize: 50,
    });
    expect(html).toContain('value="quote" selected');
    expect(html).toContain('value="u1" selected');
    expect(html).toContain('value="error" selected');
    expect(html).toContain('value="2026-05-01"');
    expect(html).toContain('value="2026-05-31"');
    // Next link carries every active filter plus the next page number.
    expect(html).toMatch(
      /href="\/admin\/audit\/commands\?command=quote&user=u1&result=error&from=2026-05-01&to=2026-05-31&page=2"/,
    );
  });

  it("renders the disabled-feature hint when audit logging is off", () => {
    const html = renderCommandAuditPage({
      ...COMMON,
      enabled: false,
      retentionDays: 90,
      commandOptions: [],
      userOptions: [],
      filters: BASE_FILTERS,
      rows: [],
      total: 0,
      page: 1,
      pageSize: 50,
    });
    expect(html).toContain('class="tag tag-off">disabled');
    expect(html).toContain("core.command_audit.enabled");
  });
});

describe("renderAnalyticsPage (#675 Part B)", () => {
  const emptyHeatmap = {
    matrix: Array.from({ length: 7 }, () => new Array(24).fill(0)),
    byHour: new Array(24).fill(0),
    byDay: new Array(7).fill(0),
    totalMinutes: 0,
    peak: null,
    timeZone: "UTC",
  };

  it("renders the empty state and disabled notice when off", () => {
    const html = renderAnalyticsPage({
      ...COMMON,
      enabled: false,
      windowDays: 90,
      heatmap: emptyHeatmap,
    });
    expect(html).toContain("Voice analytics");
    expect(html).toContain("No voice activity recorded");
    expect(html).toContain("voicetracking.enabled");
  });

  it("renders the heatmap grid and peak slot when data exists", () => {
    const matrix = Array.from({ length: 7 }, () => new Array(24).fill(0));
    matrix[5][22] = 200; // Friday 10 PM
    matrix[1][9] = 50; // Monday 9 AM
    const byDay = new Array(7).fill(0);
    byDay[5] = 200;
    byDay[1] = 50;
    const byHour = new Array(24).fill(0);
    byHour[22] = 200;
    byHour[9] = 50;
    const html = renderAnalyticsPage({
      ...COMMON,
      enabled: true,
      windowDays: 30,
      heatmap: {
        matrix,
        byHour,
        byDay,
        totalMinutes: 250,
        peak: { day: 5, hour: 22, minutes: 200 },
        timeZone: "UTC",
      },
    });
    expect(html).toContain("heatgrid");
    expect(html).toContain("Busiest slot");
    expect(html).toContain("Friday");
    expect(html).toContain("10 PM");
    expect(html).toContain("hg-cell peak");
    // No disabled notice when tracking is on.
    expect(html).not.toContain("voicetracking.enabled");
  });
});
