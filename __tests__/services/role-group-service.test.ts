import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { PermissionsBitField, type GuildMember } from "discord.js";

type Doc = Record<string, unknown> & { _id: string };
let store: Doc[] = [];
let seq = 0;

const matches = (d: Doc, f: Record<string, unknown>): boolean =>
  Object.entries(f).every(([k, v]) => (k === "_id" ? d._id === v : d[k] === v));

jest.unstable_mockModule("../../src/models/role-group.js", () => ({
  ROLE_GROUP_CAPABILITIES: ["admin", "staff", "bot"],
  RoleGroup: {
    find: jest.fn((f: Record<string, unknown>) => ({
      sort: async () =>
        store
          .filter((d) => matches(d, f))
          .sort((a, b) => (b.rank as number) - (a.rank as number)),
    })),
    create: jest.fn(async (data: Record<string, unknown>) => {
      if (
        store.some((d) => d.guildId === data.guildId && d.name === data.name)
      ) {
        throw Object.assign(new Error("dup"), { code: 11000 });
      }
      const doc = { ...data, _id: `id${++seq}`, createdAt: new Date() } as Doc;
      store.push(doc);
      return doc;
    }),
    findOneAndUpdate: jest.fn(
      async (
        f: Record<string, unknown>,
        u: { $set: Record<string, unknown> },
      ) => {
        const doc = store.find((d) => matches(d, f));
        if (doc) Object.assign(doc, u.$set);
        return doc ?? null;
      },
    ),
    updateOne: jest.fn(
      async (
        f: Record<string, unknown>,
        u: { $set: Record<string, unknown> },
      ) => {
        const doc = store.find((d) => matches(d, f));
        if (doc) Object.assign(doc, u.$set);
        return { modifiedCount: doc ? 1 : 0 };
      },
    ),
    deleteOne: jest.fn(async (f: Record<string, unknown>) => {
      const before = store.length;
      store = store.filter((d) => !matches(d, f));
      return { deletedCount: before - store.length };
    }),
    bulkWrite: jest.fn(
      async (
        ops: Array<{
          updateOne: {
            filter: Record<string, unknown>;
            update: { $set: Record<string, unknown> };
          };
        }>,
      ) => {
        for (const { updateOne } of ops) {
          const doc = store.find((d) => matches(d, updateOne.filter));
          if (doc) Object.assign(doc, updateOne.update.$set);
        }
      },
    ),
  },
}));
jest.unstable_mockModule("../../src/models/reaction-role-config.js", () => ({
  ReactionRoleConfig: { exists: jest.fn(async () => null) },
}));
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: () => ({ getString: jest.fn(async () => "") }),
  },
}));
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { RoleGroupService, scanGuildRoles, koolbotCreatedRoleIds } =
  await import("../../src/services/role-group-service.js");

const G = "guild";
const member = (
  id: string,
  roleIds: string[],
  opts: { bot?: boolean; admin?: boolean; owner?: boolean } = {},
): GuildMember =>
  ({
    id,
    user: { bot: opts.bot === true },
    guild: { id: G, ownerId: opts.owner ? id : "someone-else" },
    permissions: {
      has: (flag: bigint) =>
        opts.admin === true && flag === PermissionsBitField.Flags.Administrator,
    },
    roles: { cache: new Map(roleIds.map((r) => [r, {}])) },
  }) as unknown as GuildMember;

let svc: InstanceType<typeof RoleGroupService>;

async function seed(): Promise<void> {
  const ok = async (p: ReturnType<typeof svc.create>): Promise<string> => {
    const r = await p;
    if (!r.ok) throw new Error(r.error);
    return r.group.id;
  };
  await ok(
    svc.create(G, {
      name: "Admin",
      roleId: "rAdmin",
      capabilities: ["admin"],
      rank: 3,
    }),
  );
  await ok(
    svc.create(G, {
      name: "Mod",
      roleId: "rMod",
      capabilities: ["staff"],
      rank: 2,
    }),
  );
  await ok(svc.create(G, { name: "VIP", roleId: "rVip", rank: 1 }));
  await ok(
    svc.create(G, {
      name: "Bots",
      roleId: "rBot",
      capabilities: ["bot"],
      rank: 0,
    }),
  );
}

beforeEach(() => {
  store = [];
  seq = 0;
  RoleGroupService.reset();
  svc = RoleGroupService.getInstance();
});

describe("queries", () => {
  it("lists highest rank first and filters by capability", async () => {
    await seed();
    expect((await svc.list(G)).map((g) => g.name)).toEqual([
      "Admin",
      "Mod",
      "VIP",
      "Bots",
    ]);
    expect((await svc.getGroupsWith(G, "staff")).map((g) => g.name)).toEqual([
      "Mod",
    ]);
    expect(await svc.getRoleIdsWith(G, "admin")).toEqual(["rAdmin"]);
  });

  it("returns a group and everything above it", async () => {
    await seed();
    const vip = (await svc.list(G)).find((g) => g.name === "VIP");
    const above = await svc.getGroupsAtOrAbove(G, vip?.id ?? "");
    expect(above.map((g) => g.name)).toEqual(["Admin", "Mod", "VIP"]);
    expect(await svc.getGroupsAtOrAbove(G, "missing")).toEqual([]);
  });

  it("answers memberHasCapability from group roles; admin implies staff", async () => {
    await seed();
    expect(await svc.memberHasCapability(member("m", ["rMod"]), "staff")).toBe(
      true,
    );
    expect(await svc.memberHasCapability(member("m", ["rMod"]), "admin")).toBe(
      false,
    );
    expect(
      await svc.memberHasCapability(member("a", ["rAdmin"]), "staff"),
    ).toBe(true);
    expect(await svc.memberHasCapability(member("v", ["rVip"]), "staff")).toBe(
      false,
    );
  });

  it("always counts the owner and Administrator holders as admin, with no groups", async () => {
    expect(
      await svc.memberHasCapability(member("o", [], { owner: true }), "admin"),
    ).toBe(true);
    expect(
      await svc.memberHasCapability(member("o", [], { owner: true }), "staff"),
    ).toBe(true);
    expect(
      await svc.memberHasCapability(member("x", [], { admin: true }), "admin"),
    ).toBe(true);
    expect(await svc.memberHasCapability(member("n", []), "admin")).toBe(false);
  });

  it("matches the bot capability only for bot accounts", async () => {
    await seed();
    expect(
      await svc.memberHasCapability(
        member("b", ["rBot"], { bot: true }),
        "bot",
      ),
    ).toBe(true);
    expect(await svc.memberHasCapability(member("h", ["rBot"]), "bot")).toBe(
      false,
    );
    // The owner shortcut does not make a human a bot.
    expect(
      await svc.memberHasCapability(member("o", [], { owner: true }), "bot"),
    ).toBe(false);
  });

  it("answers 'this group and above', and always for the owner", async () => {
    await seed();
    const mod = (await svc.list(G)).find((g) => g.name === "Mod");
    const id = mod?.id ?? "";
    expect(await svc.memberIsAtOrAbove(member("a", ["rAdmin"]), id)).toBe(true);
    expect(await svc.memberIsAtOrAbove(member("m", ["rMod"]), id)).toBe(true);
    expect(await svc.memberIsAtOrAbove(member("v", ["rVip"]), id)).toBe(false);
    expect(
      await svc.memberIsAtOrAbove(member("o", [], { owner: true }), id),
    ).toBe(true);
  });

  it("fails closed when the groups can't be read", async () => {
    const { RoleGroup } = await import("../../src/models/role-group.js");
    (RoleGroup.find as jest.Mock).mockImplementationOnce(() => {
      throw new Error("db down");
    });
    expect(await svc.memberHasCapability(member("m", ["rMod"]), "staff")).toBe(
      false,
    );
  });
});

describe("writes", () => {
  it("puts new groups on top and rejects duplicates and shared roles", async () => {
    await svc.create(G, { name: "Low", rank: 1 });
    const top = await svc.create(G, { name: "High" });
    expect(top.ok && top.group.rank).toBe(2);
    expect((await svc.create(G, { name: "low" })).ok).toBe(false);
    await svc.create(G, { name: "Linked", roleId: "r1" });
    const dup = await svc.create(G, { name: "Other", roleId: "r1" });
    expect(dup).toMatchObject({
      ok: false,
      error: expect.stringMatching(/already backs/),
    });
  });

  it("edits, and keeps gate-only groups capability-free and unedited", async () => {
    const created = await svc.create(G, {
      name: "Boost",
      roleId: "rb",
      gateOnly: true,
    });
    if (!created.ok) throw new Error("setup");
    const bad = await svc.update(G, created.group.id, {
      name: "Boost",
      capabilities: ["staff"],
    });
    expect(bad.ok).toBe(false);
    const ok = await svc.update(G, created.group.id, {
      name: "Booster",
      permissions: "8",
      colour: 5,
    });
    expect(ok.ok && ok.group).toMatchObject({
      name: "Booster",
      permissions: null,
      colour: null,
    });
    expect((await svc.update(G, "nope", { name: "x" })).ok).toBe(false);
  });

  it("reorders from the top and refuses a stale order", async () => {
    await seed();
    const ids = (await svc.list(G)).map((g) => g.id);
    expect((await svc.reorder(G, [...ids].reverse())).ok).toBe(true);
    expect((await svc.list(G)).map((g) => g.name)).toEqual([
      "Bots",
      "VIP",
      "Mod",
      "Admin",
    ]);
    expect((await svc.reorder(G, ids.slice(1))).ok).toBe(false);
  });

  it("links a created role once and removes groups without touching roles", async () => {
    const g = await svc.create(G, { name: "New" });
    if (!g.ok) throw new Error("setup");
    await svc.linkRole(G, g.group.id, "r42", true);
    expect(await svc.get(G, g.group.id)).toMatchObject({
      roleId: "r42",
      createdByKoolbot: true,
    });
    expect(await svc.remove(G, g.group.id)).toBe(true);
    expect(await svc.remove(G, g.group.id)).toBe(false);
  });
});

describe("sync with Discord (#1021)", () => {
  it("marks a group unlinked when its role is gone, once", async () => {
    const g = await svc.create(G, {
      name: "Mods",
      roleId: "r1",
      roleName: "M",
    });
    if (!g.ok) throw new Error("setup");
    expect(await svc.markUnlinked(G, g.group.id, "wrong")).toBe(false);
    expect(await svc.markUnlinked(G, g.group.id, "r1")).toBe(true);
    expect(await svc.get(G, g.group.id)).toMatchObject({
      roleId: null,
      unlinked: true,
      lostRoleId: "r1",
    });
    expect(await svc.markUnlinked(G, g.group.id, "r1")).toBe(false);
  });

  it("asks for a new role only for an unlinked, editable group", async () => {
    const a = await svc.create(G, { name: "A", roleId: "r1" });
    const b = await svc.create(G, { name: "B", roleId: "r2", gateOnly: true });
    if (!a.ok || !b.ok) throw new Error("setup");
    expect(await svc.requestRecreate(G, a.group.id)).toBe(false);
    await svc.markUnlinked(G, a.group.id, "r1");
    await svc.markUnlinked(G, b.group.id, "r2");
    expect(await svc.requestRecreate(G, b.group.id)).toBe(false);
    expect(await svc.requestRecreate(G, a.group.id)).toBe(true);
    const after = await svc.get(G, a.group.id);
    expect(after).toMatchObject({ unlinked: false, roleId: null });
    expect(after?.recreateRequestedAt).toBeInstanceOf(Date);
  });

  it("re-links an unlinked group to another role, but not one that is taken", async () => {
    const a = await svc.create(G, { name: "A", roleId: "r1" });
    await svc.create(G, { name: "B", roleId: "r2" });
    if (!a.ok) throw new Error("setup");
    expect((await svc.relinkTo(G, a.group.id, "r9", "N")).ok).toBe(false);
    await svc.markUnlinked(G, a.group.id, "r1");
    expect((await svc.relinkTo(G, a.group.id, "r2", "N")).ok).toBe(false);
    const ok = await svc.relinkTo(G, a.group.id, "r9", "Nine");
    expect(ok.ok && ok.group).toMatchObject({
      roleId: "r9",
      roleName: "Nine",
      unlinked: false,
      lostRoleId: null,
      createdByKoolbot: false,
    });
  });

  it("linking a created role clears the unlinked state and tracks its name", async () => {
    const g = await svc.create(G, { name: "New" });
    if (!g.ok) throw new Error("setup");
    await svc.linkRole(G, g.group.id, "r42", true, "New");
    expect(await svc.get(G, g.group.id)).toMatchObject({
      roleId: "r42",
      roleName: "New",
      unlinked: false,
    });
  });

  it("applies adopted values, a per-group policy and the drift signature", async () => {
    const g = await svc.create(G, {
      name: "A",
      roleId: "r1",
      permissions: "1",
    });
    if (!g.ok) throw new Error("setup");
    await svc.applyAdopted(G, [
      { groupId: g.group.id, set: { permissions: "4", rank: 7 } },
    ]);
    await svc.setSyncPolicy(G, g.group.id, "adopt");
    await svc.setDriftSignature(G, g.group.id, "sig");
    expect(await svc.get(G, g.group.id)).toMatchObject({
      permissions: "4",
      rank: 7,
      syncPolicy: "adopt",
      driftSignature: "sig",
    });
    await svc.setSyncPolicy(G, g.group.id, null);
    expect((await svc.get(G, g.group.id))?.syncPolicy).toBeNull();
    await svc.applyAdopted(G, []);
  });
});

describe("scanGuildRoles", () => {
  const roleObj = (id: string, position: number, managed = false) => ({
    id,
    name: `role-${id}`,
    color: 0,
    position,
    managed,
    permissions: { bitfield: 8n },
  });
  const memberObj = (id: string, bot: boolean, roleIds: string[]) => ({
    id,
    displayName: id,
    user: { bot },
    roles: { cache: new Map(roleIds.map((r) => [r, {}])) },
  });
  const makeGuild = (
    opts: { membersFail?: boolean; countsFail?: boolean } = {},
  ) => {
    const me = {
      id: "kool",
      roles: { cache: new Map([["rBot", {}]]), highest: { position: 9 } },
    };
    return {
      id: "g",
      ownerId: "owner",
      roles: {
        fetch: async () =>
          new Map([
            ["r1", roleObj("r1", 3)],
            ["rm", roleObj("rm", 4, true)],
          ]),
        fetchMemberCounts: async () => {
          if (opts.countsFail) throw new Error("nope");
          return new Map([["r1", 7]]);
        },
      },
      members: {
        me,
        fetchMe: async () => me,
        fetch: async (id?: string) => {
          if (id) return memberObj(id, false, ["r1"]);
          if (opts.membersFail) throw new Error("intent off");
          return new Map([
            ["kool", memberObj("kool", true, ["rBot"])],
            ["b1", memberObj("b1", true, ["r1"])],
            ["h1", memberObj("h1", false, [])],
          ]);
        },
      },
    } as never;
  };

  it("reads roles, the acting admin and per-role member counts", async () => {
    const { scanned, memberCounts, botIds } = await scanGuildRoles(
      makeGuild(),
      "admin",
      [],
      false,
    );
    expect(scanned).toMatchObject({
      guildId: "g",
      ownerId: "owner",
      botUserId: "kool",
      botHighestRolePosition: 9,
      adminUserId: "admin",
      adminRoleIds: ["r1"],
      channels: [],
    });
    expect(scanned.roles.find((r) => r.id === "rm")?.managed).toBe(true);
    expect(scanned.roles[0].permissions).toBe("8");
    expect(memberCounts.get("r1")).toBe(7);
    expect(botIds).toBeNull();
  });

  it("lists other bots (not KoolBot itself) only when asked", async () => {
    const { scanned, botIds } = await scanGuildRoles(
      makeGuild(),
      "admin",
      [],
      true,
    );
    expect(botIds).toEqual(["b1"]);
    expect(scanned.otherBotIds).toEqual(["b1"]);
    expect(scanned.memberRoles).toEqual({ b1: ["r1"] });
  });

  it("lists every member's roles when members are needed (#1021)", async () => {
    const scan = await scanGuildRoles(makeGuild(), "admin", [], false, true);
    expect(scan.members).toEqual([
      { id: "kool", name: "kool", bot: true, roleIds: ["rBot"] },
      { id: "b1", name: "b1", bot: true, roleIds: ["r1"] },
      { id: "h1", name: "h1", bot: false, roleIds: [] },
    ]);
    expect(scan.scanned.memberRoles).toMatchObject({ h1: [], b1: ["r1"] });
    expect(scan.botIds).toEqual(["b1"]);
    const none = await scanGuildRoles(makeGuild(), "admin", [], false);
    expect(none.members).toBeNull();
  });

  it("reports no member list when it can't be read", async () => {
    const scan = await scanGuildRoles(
      makeGuild({ membersFail: true }),
      "admin",
      [],
      false,
      true,
    );
    expect(scan.members).toBeNull();
  });

  it("degrades when members or counts can't be read", async () => {
    const scan = await scanGuildRoles(
      makeGuild({ membersFail: true, countsFail: true }),
      "admin",
      [],
      true,
    );
    expect(scan.botIds).toBeNull();
    expect(scan.scanned.otherBotIds).toEqual([]);
    expect(scan.memberCounts.size).toBe(0);
  });

  it("marks roles KoolBot created as deletable without approval", () => {
    const spec = (
      id: string,
      roleId: string | null,
      createdByKoolbot: boolean,
    ) => ({
      id,
      name: id,
      roleId,
      rank: 1,
      permissions: null,
      capabilities: [] as never[],
      colour: null,
      createdByKoolbot,
      gateOnly: false,
    });
    expect(
      koolbotCreatedRoleIds([
        spec("a", "r1", true),
        spec("b", "r2", false),
        spec("c", null, true),
      ]),
    ).toEqual(["r1"]);
  });
});
