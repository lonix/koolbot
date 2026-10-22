import { describe, it, expect } from "@jest/globals";
import {
  renderSettingsPage,
  renderWizardStepPage,
} from "../../src/web/admin-views.js";

/**
 * `quotes.delete_roles` takes role groups (#1023). The Settings page and the
 * wizard step must offer them and render a stored group token by name, not as
 * "⚠ group:... (unavailable)". Other role lists must not offer groups.
 */
const ROLES = [{ id: "111111111111111111", name: "Mods" }];
const GROUP_ROLES = [
  { id: "group:g1", name: "Staff (group)" },
  { id: "group:g1+", name: "Staff and above (group)" },
  ...ROLES,
];

const row = (key: string, current: string) => ({
  key,
  label: key,
  current,
  defaultValue: "",
  type: "role_list",
  description: "",
  category: "quotes",
});

const COMMON = { csrfToken: "csrf", remainingMs: 60_000 };
const PICKERS = {
  textChannels: [],
  voiceChannels: [],
  categoryChannels: [],
  roles: ROLES,
};

describe("role group pickers on Settings and the wizard (#1023)", () => {
  it("Settings offers groups for quotes.delete_roles and names a stored token", () => {
    const html = renderSettingsPage({
      ...COMMON,
      ...PICKERS,
      groupRoles: GROUP_ROLES,
      guildId: "g",
      guildName: "G",
      groups: [
        {
          category: "quotes",
          rows: [
            row("quotes.delete_roles", "group:g1+,111111111111111111"),
            row("birthdays.allowed_roles", "group:g1"),
          ] as never,
        },
      ],
    });
    expect(html).toContain(
      '<option value="group:g1+" selected>@Staff and above (group)</option>',
    );
    expect(html).toContain('<option value="group:g1">@Staff (group)</option>');
    expect(html).not.toContain("⚠ group:g1+");
    // A role list that doesn't resolve groups never offers them; a stored
    // token there stays visible as unknown instead of silently vanishing.
    const other = html.slice(
      html.indexOf('name="value_birthdays.allowed_roles"'),
    );
    expect(other).toContain("⚠ group:g1 (unavailable)");
    expect(other).not.toContain("Staff (group)");
  });

  it("Settings keeps raw roles when no group list was supplied", () => {
    const html = renderSettingsPage({
      ...COMMON,
      ...PICKERS,
      guildId: "g",
      guildName: "G",
      groups: [
        {
          category: "quotes",
          rows: [row("quotes.delete_roles", "")] as never,
        },
      ],
    });
    expect(html).not.toContain("(group)");
    expect(html).toContain("@Mods");
  });

  it("the wizard step offers groups for quotes.delete_roles", () => {
    const html = renderWizardStepPage({
      ...COMMON,
      ...PICKERS,
      groupRoles: GROUP_ROLES,
      enabledByKey: {},
      stepIndex: 0,
      totalSteps: 1,
      featureKey: "quotes",
      settingKeys: ["quotes.delete_roles"],
      currentValues: { "quotes.delete_roles": "group:g1" },
      defaultValues: { "quotes.delete_roles": "" },
      metadata: {
        "quotes.delete_roles": {
          label: "Delete roles",
          description: "",
          category: "quotes",
          type: "role_list",
        },
      },
    } as never);
    expect(html).toContain(
      '<option value="group:g1" selected>@Staff (group)</option>',
    );
    expect(html).not.toContain("⚠ group:g1 (unavailable)");
  });
});
