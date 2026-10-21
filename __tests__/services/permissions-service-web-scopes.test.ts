/**
 * `PermissionsService.resolveWebScopes` (#1316): the `/me` scopes of a member,
 * read live from their roles and the guild's role groups, failing closed.
 * Real `RoleGroupService.memberHasCapability`; only the group list, the
 * Discord client and the database models are stubbed.
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { GatewayIntentBits, PermissionsBitField } from "discord.js";
import { PermissionsService } from "../../src/services/permissions-service.js";
import {
  RoleGroupService,
  type RoleGroupView,
} from "../../src/services/role-group-service.js";

jest.mock("../../src/services/config-service.js");
jest.mock("../../src/models/command-permissions.js");
jest.mock("../../src/utils/logger.js");

const GUILD = "guild1";

const group = (
  name: string,
  roleId: string | null,
  capabilities: RoleGroupView["capabilities"],
): RoleGroupView =>
  ({
    id: `id-${name}`,
    guildId: GUILD,
    name,
    roleId,
    rank: 1,
    capabilities,
    gateOnly: false,
    unlinked: false,
  }) as unknown as RoleGroupView;

const GROUPS = [
  group("Admin", "rAdmin", ["admin"]),
  group("Mod", "rMod", ["staff"]),
  group("Host", "rHost", ["host"]),
  group("VIP", "rVip", []),
  // A host group whose role was deleted: it has no role, so it grants nothing.
  group("Lost hosts", null, ["host"]),
];

function member(
  roleIds: string[],
  opts: { admin?: boolean; owner?: boolean } = {},
): unknown {
  return {
    id: "user1",
    user: { bot: false },
    guild: { id: GUILD, ownerId: opts.owner ? "user1" : "someone-else" },
    permissions: {
      has: (flag: bigint): boolean =>
        opts.admin === true && flag === PermissionsBitField.Flags.Administrator,
    },
    roles: { cache: new Map(roleIds.map((r) => [r, {}])) },
  };
}

let fetchMember: jest.Mock<(...a: unknown[]) => Promise<unknown>>;
let listGroups: jest.SpiedFunction<RoleGroupService["list"]>;
let service: PermissionsService;

beforeEach(() => {
  jest.clearAllMocks();
  fetchMember = jest.fn(async () => member([]));
  const client = {
    // Intent on: the lookup is a plain fetch every time (no TTL cache), so a
    // changed answer is seen on the very next call.
    options: {
      intents: { has: (bit: number) => bit === GatewayIntentBits.GuildMembers },
    },
    guilds: {
      fetch: jest.fn(async () => ({ members: { fetch: fetchMember } })),
    },
  };
  (PermissionsService as unknown as { instance: unknown }).instance = undefined;
  service = PermissionsService.getInstance(client as never);
  listGroups = jest
    .spyOn(RoleGroupService.getInstance(), "list")
    .mockResolvedValue(GROUPS);
});

const scopesOf = (m: unknown): Promise<string[]> => {
  fetchMember.mockResolvedValue(m);
  return service.resolveWebScopes("user1", GUILD);
};

describe("resolveWebScopes (#1316)", () => {
  it("member only: no group, or a group with no capability", async () => {
    expect(await scopesOf(member([]))).toEqual(["member"]);
    expect(await scopesOf(member(["rVip"]))).toEqual(["member"]);
    expect(await scopesOf(member(["unknown-role"]))).toEqual(["member"]);
  });

  it("host only: the Event host group gives host and nothing else", async () => {
    expect(await scopesOf(member(["rHost"]))).toEqual(["member", "host"]);
  });

  it("moderator only: the staff capability gives moderator and nothing else", async () => {
    expect(await scopesOf(member(["rMod"]))).toEqual(["member", "moderator"]);
  });

  it("host and moderator together", async () => {
    expect(await scopesOf(member(["rHost", "rMod"]))).toEqual([
      "member",
      "host",
      "moderator",
    ]);
  });

  it("the admin capability implies both lower scopes", async () => {
    expect(await scopesOf(member(["rAdmin"]))).toEqual([
      "member",
      "host",
      "moderator",
    ]);
    expect(await scopesOf(member(["rAdmin", "rHost"]))).toEqual([
      "member",
      "host",
      "moderator",
    ]);
  });

  it("an Administrator or the owner holds both, with no groups at all", async () => {
    listGroups.mockResolvedValue([]);
    const both = ["member", "host", "moderator"];
    expect(await scopesOf(member([], { admin: true }))).toEqual(both);
    expect(await scopesOf(member([], { owner: true }))).toEqual(both);
  });

  it("a group without a backing role grants nothing", async () => {
    // No role id to match, so there is nothing for a member to hold.
    expect(await scopesOf(member(["null", "undefined", ""]))).toEqual([
      "member",
    ]);
  });

  it("removal takes effect on the next call: roles are read again each time", async () => {
    expect(await scopesOf(member(["rHost"]))).toEqual(["member", "host"]);
    expect(await scopesOf(member([]))).toEqual(["member"]);
    expect(fetchMember).toHaveBeenCalledTimes(2);
  });

  it("an admin edit of the group's capabilities is seen on the next call", async () => {
    expect(await scopesOf(member(["rHost"]))).toEqual(["member", "host"]);
    listGroups.mockResolvedValue([group("Host", "rHost", [])]);
    expect(await scopesOf(member(["rHost"]))).toEqual(["member"]);
  });

  it("fails closed when the role groups cannot be read (a plain member stays a member)", async () => {
    listGroups.mockRejectedValue(new Error("mongo down"));
    expect(await scopesOf(member(["rHost", "rMod"]))).toEqual(["member"]);
  });

  it("fails closed when the member lookup fails or the member left the guild", async () => {
    fetchMember.mockRejectedValue(new Error("503 from Discord"));
    expect(await service.resolveWebScopes("user1", GUILD)).toEqual(["member"]);
    fetchMember.mockRejectedValue(
      Object.assign(new Error("Unknown Member"), { code: 10007 }),
    );
    expect(await service.resolveWebScopes("user1", GUILD)).toEqual(["member"]);
  });

  it("fails closed when the guild lookup fails", async () => {
    (service as never)["client"] = {
      guilds: {
        fetch: jest.fn(async () => {
          throw new Error("no guild");
        }),
      },
    };
    expect(await service.resolveWebScopes("user1", GUILD)).toEqual(["member"]);
  });

  it("is all-or-nothing with the REAL group code: one failed group read never leaves a partial answer", async () => {
    // A member who holds both scopes. The first group read fails, any later
    // one would succeed: with separate per-capability reads (the swallowing
    // `memberHasCapability`) that gave ["member", "moderator"].
    listGroups.mockRejectedValueOnce(new Error("mongo blip"));
    expect(await scopesOf(member(["rHost", "rMod"]))).toEqual(["member"]);
    // Both scopes come from a single snapshot: one read per resolution.
    listGroups.mockClear();
    await scopesOf(member(["rHost", "rMod"]));
    expect(listGroups).toHaveBeenCalledTimes(1);
  });
});

describe("resolveWebScopeReasons (#1317)", () => {
  const named = (
    roles: Record<string, string>,
    opts: { admin?: boolean; owner?: boolean } = {},
  ): unknown => {
    const base = member([], opts) as { roles: unknown };
    base.roles = {
      cache: new Map(Object.entries(roles).map(([id, name]) => [id, { name }])),
    };
    return base;
  };
  const reasonsOf = (m: unknown) => {
    fetchMember.mockResolvedValue(m);
    return service.resolveWebScopeReasons("user1", GUILD);
  };
  const none = { host: [], staff: [], elevated: false };

  it("names the Discord roles that grant each scope", async () => {
    expect(
      await reasonsOf(named({ rHost: "Event hosts", rMod: "Moderators" })),
    ).toEqual({
      host: ["Event hosts"],
      staff: ["Moderators"],
      elevated: false,
    });
  });

  it("lists nothing for a plain member or a role with no capability", async () => {
    expect(await reasonsOf(named({ rVip: "VIP" }))).toEqual(none);
  });

  it("an admin group counts for both scopes", async () => {
    expect(await reasonsOf(named({ rAdmin: "Admins" }))).toEqual({
      host: ["Admins"],
      staff: ["Admins"],
      elevated: false,
    });
  });

  it("falls back to the stored role name, then the group name", async () => {
    listGroups.mockResolvedValue([
      { ...group("Host", "rHost", ["host"]), roleName: "stored" },
      group("Mod", "rMod", ["staff"]),
    ]);
    expect(await reasonsOf(member(["rHost", "rMod"]))).toEqual({
      host: ["stored"],
      staff: ["Mod"],
      elevated: false,
    });
  });

  it("flags an Administrator or the owner as elevated, with no group read", async () => {
    listGroups.mockClear();
    expect(await reasonsOf(named({}, { admin: true }))).toEqual({
      host: [],
      staff: [],
      elevated: true,
    });
    expect(await reasonsOf(named({}, { owner: true }))).toMatchObject({
      elevated: true,
    });
    expect(listGroups).not.toHaveBeenCalled();
  });

  it("is cosmetic: any failure gives no reasons instead of throwing", async () => {
    listGroups.mockRejectedValue(new Error("mongo down"));
    expect(await reasonsOf(named({ rHost: "Event hosts" }))).toEqual(none);
    fetchMember.mockRejectedValue(new Error("503"));
    expect(await service.resolveWebScopeReasons("user1", GUILD)).toEqual(none);
  });
});
