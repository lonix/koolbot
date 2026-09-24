/**
 * `loadLeaderboardRoleState` (#985): the guild-side state behind the
 * Leaderboard Roles page — tier roles, assignability, and the holders the
 * service last recorded. The roster model is mocked; the guild is a stub.
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { Client } from "discord.js";

const mockFind = jest.fn();

jest.unstable_mockModule(
  "../../src/models/leaderboard-role-assignment.js",
  () => ({
    LeaderboardRoleAssignment: { find: mockFind },
  }),
);

const { loadLeaderboardRoleState, LEADERBOARD_ROLES_SETTING_KEYS } =
  await import("../../src/web/read-only-routes.js");
const { getDependencies } = await import("../../src/services/config-schema.js");

function roster(rows: unknown[] | Error): void {
  mockFind.mockReturnValue({
    lean: () =>
      rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows),
  });
}

function makeClient(
  opts: { fetchFails?: boolean; noBotMember?: boolean } = {},
): {
  client: Client;
  membersFetch: jest.Mock;
} {
  const roles = new Map<string, unknown>([
    ["guild-1", { id: "guild-1", name: "@everyone", position: 0 }],
    ["111", { id: "111", name: "Champion", position: 2, managed: false }],
    ["222", { id: "222", name: "Podium", position: 8, managed: false }],
    ["999", { id: "999", name: "BotRole", position: 1, managed: true }],
  ]);
  const memberCache = new Map<string, unknown>([
    ["u1", { displayName: "alice", user: { username: "alice_" } }],
  ]);
  const membersFetch = jest.fn(
    async () =>
      new Map([["u2", { displayName: "bob", user: { username: "bob_" } }]]),
  );
  const guild = {
    id: "guild-1",
    roles: { fetch: async () => undefined, cache: roles },
    members: {
      me: opts.noBotMember ? null : { roles: { highest: { position: 5 } } },
      fetchMe: async () => {
        throw new Error("unknown member");
      },
      cache: memberCache,
      fetch: membersFetch,
    },
  };
  const client = {
    guilds: {
      fetch: async () => {
        if (opts.fetchFails) throw new Error("discord down");
        return guild;
      },
    },
  } as unknown as Client;
  return { client, membersFetch };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("LEADERBOARD_ROLES_SETTING_KEYS (#985)", () => {
  it("covers every leaderboard_roles key except the tier string", () => {
    expect([...LEADERBOARD_ROLES_SETTING_KEYS]).toEqual([
      "leaderboard_roles.enabled",
      "leaderboard_roles.period",
      "leaderboard_roles.update_cron",
      "leaderboard_roles.announcement_channel_id",
    ]);
    // The master depends on voice tracking, which lives off the card, so the
    // route must resolve it through loadFeatureSettings' dependency state.
    expect(getDependencies("leaderboard_roles.enabled")).toContain(
      "voicetracking.enabled",
    );
  });
});

describe("loadLeaderboardRoleState (#985)", () => {
  it("resolves roles, assignability and holder names", async () => {
    const updatedAt = new Date("2026-01-05T00:00:00Z");
    roster([
      { roleId: "111", userIds: ["u1", "u2", "u3"], updatedAt },
      { roleId: "222", userIds: [], updatedAt },
    ]);
    const { client, membersFetch } = makeClient();
    const state = await loadLeaderboardRoleState(client, "guild-1", [
      { topN: 1, roleId: "111" },
      { topN: 3, roleId: "222" },
      { topN: 10, roleId: "404" },
      { topN: 20, roleId: "999" },
    ]);

    expect(mockFind).toHaveBeenCalledWith({ guildId: "guild-1" });
    // Cache hits are not re-fetched; the misses go in one batch.
    expect(membersFetch).toHaveBeenCalledTimes(1);
    expect(membersFetch).toHaveBeenCalledWith({ user: ["u2", "u3"] });

    expect(state.tiers).toEqual([
      {
        topN: 1,
        roleId: "111",
        roleName: "Champion",
        assignable: true,
        roleIssue: null,
        holders: [
          { id: "u1", label: "alice" },
          { id: "u2", label: "bob" },
          // Unresolved member falls back to the raw id.
          { id: "u3", label: "u3" },
        ],
        lastUpdated: "2026-01-05T00:00:00.000Z",
      },
      {
        topN: 3,
        roleId: "222",
        roleName: "Podium",
        // Position 8 is above the bot's highest role (5).
        assignable: false,
        roleIssue: "hierarchy",
        holders: [],
        lastUpdated: "2026-01-05T00:00:00.000Z",
      },
      {
        topN: 10,
        roleId: "404",
        roleName: null,
        assignable: null,
        roleIssue: null,
        holders: [],
        lastUpdated: null,
      },
      {
        topN: 20,
        roleId: "999",
        roleName: "BotRole",
        // Managed, not "above the bot's role" (it sits below it).
        assignable: false,
        roleIssue: "managed",
        holders: [],
        lastUpdated: null,
      },
    ]);
    // Pickers exclude @everyone and managed roles, sorted by name.
    expect(state.roles).toEqual([
      { id: "111", name: "Champion" },
      { id: "222", name: "Podium" },
    ]);
  });

  it("degrades when the guild and roster cannot be read", async () => {
    roster(new Error("mongo down"));
    const { client } = makeClient({ fetchFails: true });
    const state = await loadLeaderboardRoleState(client, "guild-1", [
      { topN: 1, roleId: "111" },
    ]);
    expect(state.roles).toEqual([]);
    expect(state.tiers).toEqual([
      {
        topN: 1,
        roleId: "111",
        // Unknown, not "not found": the guild was never read.
        roleName: "111",
        assignable: null,
        roleIssue: null,
        holders: [],
        lastUpdated: null,
      },
    ]);
  });

  it("reports assignability as unknown when the bot's member can't be read", async () => {
    roster([]);
    const { client } = makeClient({ noBotMember: true });
    const state = await loadLeaderboardRoleState(client, "guild-1", [
      { topN: 1, roleId: "222" },
      { topN: 3, roleId: "999" },
    ]);
    // Position 8 would be above the bot, but the hierarchy was never checked,
    // so it is unknown rather than assignable.
    expect(state.tiers[0]).toMatchObject({
      roleName: "Podium",
      assignable: null,
      roleIssue: null,
    });
    // A managed role is unassignable whatever the hierarchy.
    expect(state.tiers[1]).toMatchObject({
      assignable: false,
      roleIssue: "managed",
    });
  });

  it("fetches uncached holders in batches of at most 100", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `m${i}`);
    roster([{ roleId: "111", userIds: ids, updatedAt: new Date() }]);
    const { client, membersFetch } = makeClient();
    membersFetch.mockImplementation(async () => new Map());
    await loadLeaderboardRoleState(client, "guild-1", [
      { topN: 250, roleId: "111" },
    ]);
    const sizes = membersFetch.mock.calls.map(
      (c) => (c[0] as unknown as { user: string[] }).user.length,
    );
    expect(sizes).toEqual([100, 100, 50]);
  });
});
