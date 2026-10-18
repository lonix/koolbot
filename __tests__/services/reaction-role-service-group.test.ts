import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { PermissionFlagsBits, type Client } from "discord.js";

jest.mock("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  isDebugMode: jest.fn(() => false),
}));

jest.mock("../../src/models/reaction-role-config.js");

import { reactionRoleGuildLock } from "../../src/services/reaction-role-guild-lock.js";
import { ReactionRoleService } from "../../src/services/reaction-role-service.js";
import { ReactionRoleConfig } from "../../src/models/reaction-role-config.js";
import { RoleGroupService } from "../../src/services/role-group-service.js";

const model = ReactionRoleConfig as unknown as {
  findOne: jest.Mock;
  find: jest.Mock;
  insertMany: jest.Mock;
  deleteMany: jest.Mock;
  countDocuments: jest.Mock;
};
model.findOne = jest.fn();
model.find = jest.fn();
model.insertMany = jest.fn();
model.deleteMany = jest.fn();
model.countDocuments = jest.fn();

function createService(client: Partial<Client>) {
  const service = ReactionRoleService.getInstance(client as Client);
  const mockConfigService = {
    getBoolean: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
    getString: jest.fn<() => Promise<string>>().mockResolvedValue("msgchan"),
    getNumber: jest.fn(),
  };
  (service as never)["configService"] = mockConfigService;
  return { service, mockConfigService };
}

/**
 * Build a guild whose role/channel/message creation all succeed, capturing the
 * created message's reactions and the sent payload.
 */
function makeCreateClient() {
  let roleSeq = 0;
  const message = {
    id: "grp1",
    react: jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
    delete: jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
  };
  const category = {
    id: "cat1",
    permissionOverwrites: {
      edit: jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
    },
    delete: jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
  };
  const channel = {
    id: "chan1",
    delete: jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
  };
  const messageChannel = {
    isTextBased: () => true,
    send: jest.fn<() => Promise<unknown>>().mockResolvedValue(message),
  };
  const guild = {
    id: "g1",
    roles: {
      everyone: { id: "everyone" },
      create: jest.fn<() => Promise<unknown>>().mockImplementation(async () => {
        roleSeq += 1;
        return {
          id: `role${roleSeq}`,
          name: `role${roleSeq}`,
          delete: jest
            .fn<() => Promise<unknown>>()
            .mockResolvedValue(undefined),
        };
      }),
    },
    channels: {
      // First create() is the category, second is the text channel.
      create: jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValueOnce(category)
        .mockResolvedValueOnce(channel),
      fetch: jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(messageChannel),
    },
    members: { me: { id: "bot" } },
  };
  const client = {
    guilds: {
      fetch: jest.fn<() => Promise<unknown>>().mockResolvedValue(guild),
    },
  };
  return { client, guild, message, category, channel, messageChannel };
}

describe("ReactionRoleService.createReactionRoleGroup", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (
      ReactionRoleService as unknown as { instance?: ReactionRoleService }
    ).instance = undefined;
    model.findOne.mockResolvedValue(null);
    model.insertMany.mockResolvedValue([]);
  });

  it("creates one shared message and persists a mapping per option", async () => {
    const { client, message } = makeCreateClient();
    const { service } = createService(client);

    const result = await service.createReactionRoleGroup(
      "g1",
      "Colour",
      [
        { roleName: "Red", emoji: "🔴" },
        { roleName: "Blue", emoji: "🔵" },
      ],
      "unique",
    );

    expect(result.success).toBe(true);
    expect(result.groupId).toBe("grp1");
    expect(result.roleIds).toEqual(["role1", "role2"]);

    // Both emojis reacted onto the single shared message.
    expect(message.react).toHaveBeenNthCalledWith(1, "🔴");
    expect(message.react).toHaveBeenNthCalledWith(2, "🔵");

    // One insertMany with two docs sharing message/group/mode.
    expect(model.insertMany).toHaveBeenCalledTimes(1);
    const docs = model.insertMany.mock.calls[0][0] as Array<
      Record<string, unknown>
    >;
    expect(docs).toHaveLength(2);
    expect(docs.every((d) => d.messageId === "grp1")).toBe(true);
    expect(docs.every((d) => d.groupId === "grp1")).toBe(true);
    expect(docs.every((d) => d.mode === "unique")).toBe(true);
    expect(docs.map((d) => d.emoji)).toEqual(["🔴", "🔵"]);
  });

  it("remembers the channel the shared picker was posted in (#1207)", async () => {
    const { client } = makeCreateClient();
    const { service } = createService(client);

    await service.createReactionRoleGroup("g1", "Colour", [
      { roleName: "Red", emoji: "🔴" },
      { roleName: "Blue", emoji: "🔵" },
    ]);

    const docs = model.insertMany.mock.calls[0][0] as Array<
      Record<string, unknown>
    >;
    // The private channel (`channelId`) and the picker's channel differ.
    expect(docs.every((d) => d.messageChannelId === "msgchan")).toBe(true);
    expect(docs.every((d) => d.channelId === "chan1")).toBe(true);
  });

  it("rejects a group with fewer than two options without touching Discord", async () => {
    const { client, guild } = makeCreateClient();
    const { service } = createService(client);

    const result = await service.createReactionRoleGroup("g1", "Solo", [
      { roleName: "OnlyOne", emoji: "1️⃣" },
    ]);

    expect(result.success).toBe(false);
    expect(guild.roles.create).not.toHaveBeenCalled();
    expect(model.insertMany).not.toHaveBeenCalled();
  });

  it("rejects duplicate emojis within the group", async () => {
    const { client, guild } = makeCreateClient();
    const { service } = createService(client);

    const result = await service.createReactionRoleGroup("g1", "Dup", [
      { roleName: "Red", emoji: "🔴" },
      { roleName: "Crimson", emoji: "🔴" },
    ]);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/emoji/i);
    expect(guild.roles.create).not.toHaveBeenCalled();
  });

  it("rolls back created roles/channels/message when persistence fails", async () => {
    const { client, message, category, channel } = makeCreateClient();
    const { service } = createService(client);
    model.insertMany.mockRejectedValue(new Error("db down"));

    const result = await service.createReactionRoleGroup("g1", "Colour", [
      { roleName: "Red", emoji: "🔴" },
      { roleName: "Blue", emoji: "🔵" },
    ]);

    expect(result.success).toBe(false);
    // Shared resources are torn down on failure.
    expect(message.delete).toHaveBeenCalledTimes(1);
    expect(channel.delete).toHaveBeenCalledTimes(1);
    expect(category.delete).toHaveBeenCalledTimes(1);
  });

  it("rejects when a role name already exists", async () => {
    const { client, guild } = makeCreateClient();
    const { service } = createService(client);
    model.findOne.mockResolvedValue({ roleName: "Red" });

    const result = await service.createReactionRoleGroup("g1", "Colour", [
      { roleName: "Red", emoji: "🔴" },
      { roleName: "Blue", emoji: "🔵" },
    ]);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/already exists/i);
    expect(guild.roles.create).not.toHaveBeenCalled();
  });
});

describe("ReactionRoleService.deleteReactionRoleGroup", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (
      ReactionRoleService as unknown as { instance?: ReactionRoleService }
    ).instance = undefined;
  });

  it("tears down every role plus the shared category, channel, and message", async () => {
    const message = {
      delete: jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
    };
    const messageChannel = {
      messages: {
        fetch: jest.fn<() => Promise<unknown>>().mockResolvedValue(message),
      },
    };
    const category = {
      children: { cache: new Map() },
      delete: jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
    };
    const roleDelete = jest
      .fn<() => Promise<unknown>>()
      .mockResolvedValue(undefined);
    const guild = {
      channels: {
        fetch: jest
          .fn<() => Promise<unknown>>()
          // message channel first, then the group category
          .mockResolvedValueOnce(messageChannel)
          .mockResolvedValueOnce(category),
      },
      roles: {
        fetch: jest
          .fn<() => Promise<unknown>>()
          .mockResolvedValue({ delete: roleDelete }),
      },
    };
    const client = {
      guilds: {
        fetch: jest.fn<() => Promise<unknown>>().mockResolvedValue(guild),
      },
    };
    const { service } = createService(client);
    model.find.mockResolvedValue([
      { roleId: "role1", messageId: "grp1", categoryId: "cat1" },
      { roleId: "role2", messageId: "grp1", categoryId: "cat1" },
    ]);
    model.deleteMany.mockResolvedValue({ deletedCount: 2 });
    model.countDocuments.mockResolvedValue(0);

    const result = await service.deleteReactionRoleGroup("g1", "grp1");

    expect(result.success).toBe(true);
    expect(result.rolesDeleted).toBe(2);
    expect(result.rolesKept).toBe(0);
    expect(result.message).toBe(
      "Successfully deleted role group and its 2 roles.",
    );
    expect(message.delete).toHaveBeenCalledTimes(1);
    expect(category.delete).toHaveBeenCalledTimes(1);
    expect(roleDelete).toHaveBeenCalledTimes(2);
    expect(model.deleteMany).toHaveBeenCalledWith({
      guildId: "g1",
      groupId: "grp1",
    });
  });

  it("keeps a role that a mapping outside the group still references", async () => {
    const roleDelete = jest
      .fn<() => Promise<unknown>>()
      .mockResolvedValue(undefined);
    const guild = {
      channels: {
        fetch: jest.fn<() => Promise<unknown>>().mockResolvedValue(null),
      },
      roles: {
        fetch: jest
          .fn<() => Promise<unknown>>()
          .mockResolvedValue({ delete: roleDelete }),
      },
    };
    const client = {
      guilds: {
        fetch: jest.fn<() => Promise<unknown>>().mockResolvedValue(guild),
      },
    };
    const { service } = createService(client);
    model.find.mockResolvedValue([
      {
        roleId: "shared",
        messageId: "grp1",
        autoCreated: true,
        groupKey: "region",
      },
      {
        roleId: "own",
        messageId: "grp1",
        autoCreated: true,
        groupKey: "region",
      },
    ]);
    model.deleteMany.mockResolvedValue({ deletedCount: 2 });
    model.countDocuments.mockImplementation(async (q: unknown) =>
      (q as { roleId: string }).roleId === "shared" ? 1 : 0,
    );

    const result = await service.deleteReactionRoleGroup("g1", "grp1");

    expect(result.rolesDeleted).toBe(1);
    expect(result.rolesKept).toBe(1);
    expect(result.message).toMatch(/removed 1 role, kept 1 that was reused/);
    expect(model.countDocuments).toHaveBeenCalledWith({
      guildId: "g1",
      roleId: "shared",
      groupId: { $ne: "grp1" },
    });
    expect(roleDelete).toHaveBeenCalledTimes(1);
  });

  it("never deletes a reused role (autoCreated false)", async () => {
    const roleDelete = jest
      .fn<() => Promise<unknown>>()
      .mockResolvedValue(undefined);
    const fetchRole = jest
      .fn<(id: string) => Promise<unknown>>()
      .mockResolvedValue({ delete: roleDelete });
    const guild = {
      channels: {
        fetch: jest.fn<() => Promise<unknown>>().mockResolvedValue(null),
      },
      roles: { fetch: fetchRole },
    };
    const client = {
      guilds: {
        fetch: jest.fn<() => Promise<unknown>>().mockResolvedValue(guild),
      },
    };
    const { service } = createService(client);
    model.find.mockResolvedValue([
      { roleId: "mine", messageId: "grp1", autoCreated: true },
      { roleId: "reused", messageId: "grp1", autoCreated: false },
    ]);
    model.deleteMany.mockResolvedValue({ deletedCount: 2 });
    model.countDocuments.mockResolvedValue(0);

    const result = await service.deleteReactionRoleGroup("g1", "grp1");

    expect(result.rolesDeleted).toBe(1);
    expect(result.rolesKept).toBe(1);
    expect(fetchRole.mock.calls.map((c) => c[0])).toEqual(["mine"]);
    expect(roleDelete).toHaveBeenCalledTimes(1);
  });

  it("returns not-found when the group has no configs", async () => {
    const client = {
      guilds: { fetch: jest.fn<() => Promise<unknown>>() },
    };
    const { service } = createService(client);
    model.find.mockResolvedValue([]);

    const result = await service.deleteReactionRoleGroup("g1", "nope");

    expect(result.success).toBe(false);
    expect(model.deleteMany).not.toHaveBeenCalled();
  });
});

describe("ReactionRoleService single-role guards on group members", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (
      ReactionRoleService as unknown as { instance?: ReactionRoleService }
    ).instance = undefined;
  });

  // Mappings are addressed by their stable ObjectId (#813/#824), so the guards
  // are reached only for a valid id whose config carries a groupId.
  const MAPPING_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";

  it("deleteReactionRole refuses a grouped mapping", async () => {
    const guildFetch = jest.fn();
    const { service } = createService({
      guilds: { fetch: guildFetch },
    } as never);
    model.findOne.mockResolvedValue({
      roleName: "Red",
      groupId: "grp1",
    });

    const result = await service.deleteReactionRole("g1", MAPPING_ID);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/role group/i);
    // Guard returns before any Discord work.
    expect(guildFetch).not.toHaveBeenCalled();
  });

  it("archiveReactionRole refuses a grouped mapping", async () => {
    const { service } = createService({
      guilds: { fetch: jest.fn() },
    } as never);
    model.findOne.mockResolvedValue({
      roleName: "Red",
      groupId: "grp1",
      isArchived: false,
    });

    const result = await service.archiveReactionRole("g1", MAPPING_ID);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/role group/i);
  });
});

describe("ReactionRoleService.validateRoleAssignable bot member resolution", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (
      ReactionRoleService as unknown as { instance?: ReactionRoleService }
    ).instance = undefined;
  });

  const role = { id: "r1", name: "R", managed: false };
  const makeGuild = (me: unknown, fetchMe: jest.Mock) => ({
    members: { me, fetchMe },
    roles: { everyone: { id: "everyone" } },
  });

  describe("role group roles (#1023)", () => {
    const bot = {
      permissions: { has: () => true },
      roles: { highest: { comparePositionTo: () => 1 } },
    };
    const guild = {
      id: "g1",
      members: { me: bot, fetchMe: jest.fn() },
      roles: { everyone: { id: "everyone" } },
    };

    it("refuses a role that backs a group and names the group", async () => {
      const { service } = createService({});
      const spy = jest
        .spyOn(RoleGroupService.getInstance(), "groupBackedRoles")
        .mockResolvedValue([{ roleId: "r1", groupName: "Moderators" }]);
      const res = await service.validateRoleAssignable(
        guild as never,
        role as never,
      );
      expect(spy).toHaveBeenCalledWith("g1", ["r1"]);
      expect(res).toMatchObject({
        ok: false,
        message: expect.stringContaining("Moderators"),
      });
      spy.mockRestore();
    });

    it("allows a role no group backs", async () => {
      const { service } = createService({});
      const spy = jest
        .spyOn(RoleGroupService.getInstance(), "groupBackedRoles")
        .mockResolvedValue([]);
      const res = await service.validateRoleAssignable(
        guild as never,
        role as never,
      );
      expect(res).toEqual({ ok: true });
      spy.mockRestore();
    });

    it("allows the role when the groups can't be read (a guard, not an access check)", async () => {
      const { service } = createService({});
      const spy = jest
        .spyOn(RoleGroupService.getInstance(), "groupBackedRoles")
        .mockRejectedValue(new Error("database offline"));
      const res = await service.validateRoleAssignable(
        guild as never,
        role as never,
      );
      expect(res).toEqual({ ok: true });
      spy.mockRestore();
    });
  });

  describe("dangerous permissions (#1145)", () => {
    const bot = {
      permissions: { has: () => true },
      roles: { highest: { comparePositionTo: () => 1 } },
    };
    const guild = {
      id: "g1",
      members: { me: bot, fetchMe: jest.fn() },
      roles: { everyone: { id: "everyone" } },
    };
    const withPerms = (...bits: bigint[]) => ({
      id: "r1",
      name: "Boss",
      managed: false,
      permissions: { bitfield: bits.reduce((a, b) => a | b, 0n) },
    });

    let backedSpy: ReturnType<typeof jest.spyOn>;
    beforeEach(() => {
      backedSpy = jest
        .spyOn(RoleGroupService.getInstance(), "groupBackedRoles")
        .mockResolvedValue([]);
    });
    afterEach(() => backedSpy.mockRestore());

    it.each([
      ["Administrator", PermissionFlagsBits.Administrator],
      ["ManageGuild", PermissionFlagsBits.ManageGuild],
      ["ManageRoles", PermissionFlagsBits.ManageRoles],
      ["ManageChannels", PermissionFlagsBits.ManageChannels],
      ["BanMembers", PermissionFlagsBits.BanMembers],
      ["KickMembers", PermissionFlagsBits.KickMembers],
      ["ModerateMembers", PermissionFlagsBits.ModerateMembers],
      ["ManageWebhooks", PermissionFlagsBits.ManageWebhooks],
      ["MentionEveryone", PermissionFlagsBits.MentionEveryone],
    ])("refuses a role carrying %s and names it", async (name, bit) => {
      const { service } = createService({});
      const res = await service.validateRoleAssignable(
        guild as never,
        withPerms(PermissionFlagsBits.SendMessages, bit) as never,
      );
      expect(res).toMatchObject({
        ok: false,
        message: expect.stringContaining(name),
      });
      expect((res as { message: string }).message).toContain("**Boss**");
    });

    it("lists every offending permission", async () => {
      const { service } = createService({});
      const res = await service.validateRoleAssignable(
        guild as never,
        withPerms(
          PermissionFlagsBits.Administrator,
          PermissionFlagsBits.BanMembers,
        ) as never,
      );
      const message = (res as { message: string }).message;
      expect(message).toContain("Administrator");
      expect(message).toContain("BanMembers");
    });

    it("still allows an ordinary cosmetic role", async () => {
      const { service } = createService({});
      const res = await service.validateRoleAssignable(
        guild as never,
        withPerms(
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.Connect,
          PermissionFlagsBits.ChangeNickname,
        ) as never,
      );
      expect(res).toEqual({ ok: true });
    });
  });

  it("omitted argument keeps the cache/fetchMe fallback", async () => {
    const { service } = createService({});
    const fetchMe = jest.fn<() => Promise<unknown>>().mockResolvedValue(null);
    const res = await service.validateRoleAssignable(
      makeGuild(null, fetchMe) as never,
      role as never,
    );
    expect(fetchMe).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(false);
  });

  it("explicit null reports an error without calling fetchMe", async () => {
    const { service } = createService({});
    const fetchMe = jest.fn<() => Promise<unknown>>();
    const res = await service.validateRoleAssignable(
      makeGuild({ id: "bot" }, fetchMe) as never,
      role as never,
      null,
    );
    expect(fetchMe).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      ok: false,
      message: expect.stringContaining("own membership"),
    });
  });

  it("never deletes an existing category that a bound mapping points at (server adoption)", async () => {
    const message = {
      delete: jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
    };
    const messageChannel = {
      messages: {
        fetch: jest.fn<() => Promise<unknown>>().mockResolvedValue(message),
      },
    };
    const category = {
      children: { cache: new Map([["c1", { delete: jest.fn() }]]) },
      delete: jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
    };
    const fetchChannel = jest
      .fn<(id: string) => Promise<unknown>>()
      .mockImplementation(async (id) =>
        id === "cat1" ? category : messageChannel,
      );
    const guild = {
      channels: { fetch: fetchChannel },
      roles: { fetch: jest.fn<() => Promise<unknown>>() },
    };
    const client = {
      guilds: {
        fetch: jest.fn<() => Promise<unknown>>().mockResolvedValue(guild),
      },
    };
    const { service } = createService(client);
    model.find.mockResolvedValue([
      {
        roleId: "existing",
        messageId: "grp1",
        categoryId: "cat1",
        autoCreated: false,
      },
    ]);
    model.deleteMany.mockResolvedValue({ deletedCount: 1 });
    model.countDocuments.mockResolvedValue(0);

    const result = await service.deleteReactionRoleGroup("g1", "grp1");

    expect(result.success).toBe(true);
    expect(category.delete).not.toHaveBeenCalled();
    for (const child of category.children.cache.values()) {
      expect(child.delete).not.toHaveBeenCalled();
    }
    expect(fetchChannel).not.toHaveBeenCalledWith("cat1");
  });

  it("waits for the shared guild lock and releases it after a failure", async () => {
    const client = {
      guilds: { fetch: jest.fn<() => Promise<unknown>>() },
    };
    const { service } = createService(client);
    model.find.mockResolvedValue([]);
    let release!: () => void;
    const held = reactionRoleGuildLock.run(
      "g1",
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const deleting = service.deleteReactionRoleGroup("g1", "nope");
    for (let i = 0; i < 20; i++) await Promise.resolve();
    // blocked behind the in-flight provisioning/delete for the same guild
    expect(model.find).not.toHaveBeenCalled();
    release();
    await held;
    expect((await deleting).success).toBe(false);
    expect(model.find).toHaveBeenCalledTimes(1);

    // a failing holder does not block the next caller
    const failing = reactionRoleGuildLock.run("g1", async () => {
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");
    await service.deleteReactionRoleGroup("g1", "nope");
    expect(model.find).toHaveBeenCalledTimes(2);
  });
});
