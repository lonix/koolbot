import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { Client } from "discord.js";

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

import { ReactionRoleService } from "../../src/services/reaction-role-service.js";
import { ReactionRoleConfig } from "../../src/models/reaction-role-config.js";

const model = ReactionRoleConfig as unknown as {
  findOne: jest.Mock;
  find: jest.Mock;
  insertMany: jest.Mock;
  deleteMany: jest.Mock;
};
model.findOne = jest.fn();
model.find = jest.fn();
model.insertMany = jest.fn();
model.deleteMany = jest.fn();

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

    const result = await service.deleteReactionRoleGroup("g1", "grp1");

    expect(result.success).toBe(true);
    expect(message.delete).toHaveBeenCalledTimes(1);
    expect(category.delete).toHaveBeenCalledTimes(1);
    expect(roleDelete).toHaveBeenCalledTimes(2);
    expect(model.deleteMany).toHaveBeenCalledWith({
      guildId: "g1",
      groupId: "grp1",
    });
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
