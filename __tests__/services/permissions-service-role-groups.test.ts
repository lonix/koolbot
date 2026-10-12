import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import {
  PermissionsService,
  PermissionCheckError,
} from "../../src/services/permissions-service.js";
import { CommandPermission } from "../../src/models/command-permissions.js";
import {
  RoleGroupService,
  type RoleGroupView,
} from "../../src/services/role-group-service.js";

jest.mock("../../src/services/config-service.js");
jest.mock("../../src/models/command-permissions.js");
jest.mock("../../src/utils/logger.js");

/**
 * Role group support in command permissions (#1023): group and
 * "group and above" entries, the staff default for moderation commands once
 * groups exist, and the unchanged fallback when none do.
 */

const group = (
  id: string,
  rank: number,
  roleId: string | null,
  capabilities: RoleGroupView["capabilities"] = [],
): RoleGroupView =>
  ({ id, name: id, rank, roleId, capabilities }) as unknown as RoleGroupView;

const GROUPS = [
  group("admin", 3, "rAdmin", ["admin"]),
  group("mod", 2, "rMod", ["staff"]),
  group("vip", 1, "rVip"),
];

let service: PermissionsService;
let listSpy: jest.SpiedFunction<RoleGroupService["list"]>;

/** The bits of discord.js's Collection the service uses. */
class RoleCache extends Map<string, { id: string }> {
  map<T>(fn: (role: { id: string }) => T): T[] {
    return [...this.values()].map(fn);
  }
  some(fn: (role: { id: string }) => boolean): boolean {
    return [...this.values()].some(fn);
  }
}

/** Build a service whose guild has one member holding `roleIds`. */
async function setup(
  roleIds: string[],
  rows: Array<{
    commandName: string;
    roleIds?: string[];
    groupRefs?: string[];
  }> = [],
): Promise<void> {
  const member = {
    id: "u1",
    permissions: { has: jest.fn().mockReturnValue(false) },
    roles: {
      cache: new RoleCache(roleIds.map((id) => [id, { id }])),
    },
  };
  const client = {
    guilds: {
      fetch: jest
        .fn()
        .mockResolvedValue({ members: { fetch: async () => member } }),
    },
    commands: new Map(
      ["ping", "warn", "ban", "quote"].map((n) => [n, {}] as const),
    ),
  };
  (CommandPermission.find as jest.Mock) = jest.fn().mockResolvedValue(
    rows.map((r) => ({
      guildId: "g1",
      commandName: r.commandName,
      roleIds: r.roleIds ?? [],
      groupRefs: r.groupRefs ?? [],
    })) as never,
  );
  (PermissionsService as unknown as { instance: unknown }).instance = undefined;
  service = PermissionsService.getInstance(client as never);
  (service as never)["configService"] = {
    getString: jest.fn().mockResolvedValue("g1"),
  };
}

const check = (command: string, opts?: { onUnavailable?: "deny" | "throw" }) =>
  service.checkCommandPermission("u1", "g1", command, opts);

beforeEach(() => {
  jest.restoreAllMocks();
  listSpy = jest
    .spyOn(RoleGroupService.getInstance(), "list")
    .mockResolvedValue(GROUPS);
});

describe("explicit group restrictions", () => {
  it("lets a member of the named group in and keeps others out", async () => {
    await setup(["rMod"], [{ commandName: "quote", groupRefs: ["group:mod"] }]);
    expect(await check("quote")).toBe(true);
    await setup(["rVip"], [{ commandName: "quote", groupRefs: ["group:mod"] }]);
    expect(await check("quote")).toBe(false);
  });

  it("'and above' lets higher groups in but not lower ones", async () => {
    const rows = [{ commandName: "quote", groupRefs: ["group:mod+"] }];
    await setup(["rAdmin"], rows);
    expect(await check("quote")).toBe(true);
    await setup(["rMod"], rows);
    expect(await check("quote")).toBe(true);
    await setup(["rVip"], rows);
    expect(await check("quote")).toBe(false);
  });

  it("a plain group does not include the groups above it", async () => {
    await setup(
      ["rAdmin"],
      [{ commandName: "quote", groupRefs: ["group:mod"] }],
    );
    expect(await check("quote")).toBe(false);
  });

  it("combines raw roles and groups with OR", async () => {
    const rows = [
      { commandName: "quote", roleIds: ["rawRole"], groupRefs: ["group:mod"] },
    ];
    await setup(["rawRole"], rows);
    expect(await check("quote")).toBe(true);
    await setup(["rMod"], rows);
    expect(await check("quote")).toBe(true);
    await setup(["other"], rows);
    expect(await check("quote")).toBe(false);
  });

  it("stays restricted when the named group has been deleted", async () => {
    await setup(
      ["rMod"],
      [{ commandName: "quote", groupRefs: ["group:gone"] }],
    );
    expect(await check("quote")).toBe(false);
  });

  it("does not read groups for a role-only restriction", async () => {
    await setup(["rawRole"], [{ commandName: "quote", roleIds: ["rawRole"] }]);
    expect(await check("quote")).toBe(true);
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("reports an unreadable group list as PermissionCheckError in throw mode", async () => {
    listSpy.mockRejectedValue(new Error("database offline"));
    await setup(["rMod"], [{ commandName: "quote", groupRefs: ["group:mod"] }]);
    await expect(check("quote", { onUnavailable: "throw" })).rejects.toThrow(
      PermissionCheckError,
    );
    expect(await check("quote")).toBe(false);
  });
});

describe("staff default for moderation commands", () => {
  it("requires staff once a staff or admin group exists and nothing is set", async () => {
    await setup(["rMod"]);
    expect(await check("warn")).toBe(true);
    await setup(["rAdmin"]);
    expect(await check("ban")).toBe(true);
    await setup(["rVip"]);
    expect(await check("warn")).toBe(false);
    await setup([]);
    expect(await check("ban")).toBe(false);
  });

  it("leaves other commands open", async () => {
    await setup([]);
    expect(await check("ping")).toBe(true);
    expect(await check("quote")).toBe(true);
  });

  it("falls back to open when no groups are defined", async () => {
    listSpy.mockResolvedValue([]);
    await setup([]);
    expect(await check("warn")).toBe(true);
  });

  it("falls back to open when groups exist but none is staff or admin", async () => {
    listSpy.mockResolvedValue([group("vip", 1, "rVip")]);
    await setup([]);
    expect(await check("warn")).toBe(true);
  });

  it("an explicit restriction replaces the default", async () => {
    await setup(["rVip"], [{ commandName: "warn", roleIds: ["rVip"] }]);
    expect(await check("warn")).toBe(true);
  });

  it("denies, or throws in throw mode, when the groups can't be read", async () => {
    listSpy.mockRejectedValue(new Error("database offline"));
    await setup(["rMod"]);
    expect(await check("warn")).toBe(false);
    await expect(check("warn", { onUnavailable: "throw" })).rejects.toThrow(
      PermissionCheckError,
    );
    // Commands outside the staff default never touch the groups.
    expect(await check("ping")).toBe(true);
  });
});

describe("storing group references", () => {
  it("writes groupRefs only when given, so role edits keep the groups", async () => {
    const update = jest.fn().mockResolvedValue({});
    (CommandPermission.findOneAndUpdate as jest.Mock) = update;
    await setup([]);
    await service.setCommandPermissions("g1", "quote", ["r1"]);
    expect(update).toHaveBeenLastCalledWith(
      { guildId: "g1", commandName: "quote" },
      { roleIds: ["r1"] },
      { upsert: true, new: true },
    );
    await service.setCommandPermissions("g1", "quote", [], ["group:mod"]);
    expect(update).toHaveBeenLastCalledWith(
      { guildId: "g1", commandName: "quote" },
      { roleIds: [], groupRefs: ["group:mod"] },
      { upsert: true, new: true },
    );
  });

  it("keeps the entry when the last raw role is removed but a group remains", async () => {
    const deleteOne = jest.fn().mockResolvedValue({});
    const update = jest.fn().mockResolvedValue({});
    (CommandPermission.deleteOne as jest.Mock) = deleteOne;
    (CommandPermission.findOneAndUpdate as jest.Mock) = update;
    (CommandPermission.findOne as jest.Mock) = jest.fn().mockResolvedValue({
      roleIds: ["r1"],
      groupRefs: ["group:mod"],
    } as never);
    await setup([]);
    await service.removeCommandPermissions("g1", "quote", ["r1"]);
    expect(deleteOne).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalled();
  });

  it("lists commands through the groups for getUserPermissions", async () => {
    await setup(
      ["rMod"],
      [{ commandName: "quote", groupRefs: ["group:admin"] }],
    );
    const names = await service.getUserPermissions("u1", "g1");
    expect(names).toEqual(expect.arrayContaining(["ping", "warn", "ban"]));
    expect(names).not.toContain("quote");
  });

  it("lists commands through the groups for getRolePermissions", async () => {
    await setup([], [{ commandName: "quote", groupRefs: ["group:mod+"] }]);
    expect(await service.getRolePermissions("rAdmin", "g1")).toContain("quote");
    expect(await service.getRolePermissions("rVip", "g1")).not.toContain(
      "quote",
    );
    // The staff default applies to the moderation commands.
    expect(await service.getRolePermissions("rVip", "g1")).not.toContain(
      "warn",
    );
    expect(await service.getRolePermissions("rMod", "g1")).toContain("warn");
  });
});
