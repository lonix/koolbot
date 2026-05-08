import { describe, it, expect } from "@jest/globals";
import {
  renderBootstrapPage,
  renderDashboardPage,
  renderPermissionsPage,
  renderSettingsPage,
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
            { key: "WEBUI_SESSION_TTL_MINUTES", present: false, isSecret: false },
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
