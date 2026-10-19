/**
 * `loadEventPresetsPage` (#1200): what the admin page prefills for Edit,
 * Duplicate and "Save an event's groups as a preset". The catalog and the event
 * lookup are mocked; the prefill logic is real.
 */
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { Client } from "discord.js";

const mockGetEvent = jest.fn<(id: string) => Promise<unknown>>();

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: (): unknown => ({
      getNumber: async (key: string, fallback: number) =>
        key === "events.groups.max_count" ? 6 : fallback,
    }),
  },
}));
jest.unstable_mockModule("../../src/services/event-service.js", () => ({
  EventService: { getInstance: (): unknown => ({ getEvent: mockGetEvent }) },
}));

const LIB_ID = "lib:0123456789abcdef01234567";
let mockState: "ok" | "library-unreadable" = "ok";
const mockCatalog = {
  entries: [
    {
      id: "builtin:red-vs-blue",
      source: "builtin" as const,
      enabled: true,
      label: "Red vs Blue",
      description: "Two teams.",
      groupLabel: "Team",
      groups: [
        { name: "Red", kind: "team", size: null, tag: "", marker: "🔴" },
        { name: "Blue", kind: "team", size: null, tag: "", marker: "🔵" },
      ],
    },
    {
      id: LIB_ID,
      source: "library" as const,
      enabled: true,
      label: "Clan match",
      description: "",
      groupLabel: "Squad",
      leaderLabel: "Lead",
      channelLeadMinutes: 30,
      groups: [{ name: "Assault", kind: "team", size: 8, tag: "", marker: "" }],
    },
  ],
  get state(): "ok" | "library-unreadable" {
    return mockState;
  },
};
const actualService =
  await import("../../src/services/event-group-preset-service.js");
jest.unstable_mockModule(
  "../../src/services/event-group-preset-service.js",
  () => ({
    ...actualService,
    loadPresetCatalog: async () => mockCatalog,
  }),
);

// The hosts' personal presets for the publish card (#1216).
const mockListHostPresets =
  jest.fn<
    (guildId: string) => Promise<{ rows: unknown[]; truncated: boolean }>
  >();
const actualPersonal =
  await import("../../src/services/event-personal-preset-service.js");
jest.unstable_mockModule(
  "../../src/services/event-personal-preset-service.js",
  () => ({ ...actualPersonal, listHostPresetsForAdmin: mockListHostPresets }),
);

const { loadEventPresetsPage } =
  await import("../../src/web/event-presets-page.js");

const client = {} as Client;

beforeEach(() => {
  jest.clearAllMocks();
  mockState = "ok";
  mockListHostPresets.mockResolvedValue({ rows: [], truncated: false });
});

describe("loadEventPresetsPage: the hosts' presets (#1216)", () => {
  const row = (ownerId: string): unknown => ({
    ownerId,
    publishedAs: null,
    entry: { id: `my:${"a".repeat(24)}`, label: "Night raid", groups: [] },
  });

  it("adds a display name from the member cache only, and falls back to an empty name", async () => {
    mockListHostPresets.mockResolvedValue({
      rows: [row("u1"), row("u2")],
      truncated: true,
    });
    const withCache = {
      guilds: {
        cache: {
          get: () => ({
            members: {
              cache: {
                get: (id: string) =>
                  id === "u1" ? { displayName: "Ada" } : undefined,
              },
            },
          }),
        },
      },
    } as unknown as Client;
    const page = await loadEventPresetsPage(withCache, "g1", {});
    expect(mockListHostPresets).toHaveBeenCalledWith("g1");
    expect(page.hostPresets?.truncated).toBe(true);
    expect(page.hostPresets?.rows.map((r) => [r.ownerId, r.ownerName])).toEqual(
      [
        ["u1", "Ada"],
        ["u2", ""],
      ],
    );
  });

  it("reports an unreadable list as null, so the page says so instead of failing", async () => {
    mockListHostPresets.mockRejectedValue(new Error("down"));
    const page = await loadEventPresetsPage(client, "g1", {});
    expect(page.hostPresets).toBeNull();
    expect(page.entries.length).toBeGreaterThan(0);
  });
});

describe("loadEventPresetsPage", () => {
  it("shows the catalog with the configured limits and an empty editor", async () => {
    const page = await loadEventPresetsPage(client, "g1", {});
    expect(page.entries).toHaveLength(2);
    expect(page.maxCount).toBe(6);
    expect(page.editing).toBeNull();
    expect(page.values).toEqual({});
  });

  it("edit= prefills an own preset and carries its id", async () => {
    const page = await loadEventPresetsPage(client, "g1", { edit: LIB_ID });
    expect(page.editing).toEqual({ id: LIB_ID, label: "Clan match" });
    expect(page.values).toMatchObject({
      preset_name: "Clan match",
      groups_label: "Squad",
      groups_leader_label: "Lead",
      groups_lead_minutes: "30",
      group_0_name: "Assault",
      group_0_size: "8",
    });
  });

  it("edit= while the library is unreadable keeps the request as unavailable instead of a blank add form", async () => {
    mockState = "library-unreadable";
    const page = await loadEventPresetsPage(client, "g1", {
      edit: "lib:ffffffffffffffffffffffff",
    });
    expect(page.editUnavailable).toBe(true);
    expect(page.editing).toBeNull();
    expect(page.values).toEqual({});
  });

  it("edit= of a deleted preset says so instead of silently adding", async () => {
    const page = await loadEventPresetsPage(client, "g1", {
      edit: "lib:ffffffffffffffffffffffff",
    });
    expect(page.editUnavailable).toBe(false);
    expect(page.prefillNote).toContain("no longer exists");
  });

  it("edit= of a built-in or an unknown id prefills nothing", async () => {
    for (const edit of [
      "builtin:red-vs-blue",
      "lib:ffffffffffffffffffffffff",
    ]) {
      const page = await loadEventPresetsPage(client, "g1", { edit });
      expect(page.editing).toBeNull();
      expect(page.values).toEqual({});
    }
  });

  it("from= duplicates a built-in as a new preset with a '(copy)' name and no id", async () => {
    const page = await loadEventPresetsPage(client, "g1", {
      from: "builtin:red-vs-blue",
    });
    expect(page.editing).toBeNull();
    expect(page.values.preset_name).toBe("Red vs Blue (copy)");
    expect(page.values.group_1_name).toBe("Blue");
    expect(page.values.group_1_marker).toBe("🔵");
    expect(page.prefillNote).toContain("Red vs Blue");
  });

  it("fromEvent= copies only the setup of an event in this guild", async () => {
    mockGetEvent.mockResolvedValue({
      guildId: "g1",
      title: "Game night",
      groupsEnabled: true,
      groupLabel: "Room",
      leaderLabel: "Host",
      channelLeadMinutes: null,
      groups: [
        {
          key: "g_00000001",
          name: "Room 1",
          kind: "team",
          size: 5,
          tag: "",
          marker: "",
          channelId: "123",
          captainId: "u1",
          memberIds: ["u1", "u2"],
        },
      ],
    });
    const page = await loadEventPresetsPage(client, "g1", { fromEvent: "e1" });
    expect(page.values).toMatchObject({
      groups_label: "Room",
      group_0_name: "Room 1",
      group_0_size: "5",
    });
    expect(JSON.stringify(page.values)).not.toContain("u1");
    expect(JSON.stringify(page.values)).not.toContain("123");
  });

  it("fromEvent= copies the event's clan tags setting as the preset's default, and leaves the format behind (#1194)", async () => {
    const event = (tagsEnabled: boolean): Record<string, unknown> => ({
      guildId: "g1",
      title: "Quiz",
      groupsEnabled: true,
      groupLabel: "Team",
      leaderLabel: "Leader",
      channelLeadMinutes: null,
      tagsEnabled,
      tagsSuffix: true,
      groups: [
        {
          key: "g_00000001",
          name: "Red",
          kind: "team",
          size: null,
          tag: "RED",
          marker: "",
          channelId: null,
          captainId: null,
          memberIds: [],
        },
      ],
    });
    mockGetEvent.mockResolvedValueOnce(event(true));
    const on = await loadEventPresetsPage(client, "g1", { fromEvent: "e1" });
    expect(on.values.groups_tags).toBe("1");
    expect(on.values).not.toHaveProperty("groups_tags_suffix");
    mockGetEvent.mockResolvedValueOnce(event(false));
    const off = await loadEventPresetsPage(client, "g1", { fromEvent: "e1" });
    expect(off.values).not.toHaveProperty("groups_tags");
  });

  it("from= duplicates a preset's clan tags default (#1194)", async () => {
    // The mocked catalog's first built-in has no default: nothing is ticked.
    const page = await loadEventPresetsPage(client, "g1", {
      from: "builtin:red-vs-blue",
    });
    expect(page.values).not.toHaveProperty("groups_tags");
  });

  it("fromEvent= of another guild's event, a plain event or a failed lookup prefills nothing", async () => {
    mockGetEvent.mockResolvedValueOnce({
      guildId: "other",
      title: "x",
      groupsEnabled: true,
      groups: [],
    });
    expect(
      (await loadEventPresetsPage(client, "g1", { fromEvent: "e1" })).values,
    ).toEqual({});
    mockGetEvent.mockResolvedValueOnce({
      guildId: "g1",
      title: "x",
      groupsEnabled: false,
      groups: [],
    });
    expect(
      (await loadEventPresetsPage(client, "g1", { fromEvent: "e1" })).values,
    ).toEqual({});
    mockGetEvent.mockRejectedValueOnce(new Error("bad id"));
    expect(
      (await loadEventPresetsPage(client, "g1", { fromEvent: "e1" })).values,
    ).toEqual({});
  });
});
