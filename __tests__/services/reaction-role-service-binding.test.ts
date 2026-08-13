import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { Client } from "discord.js";

// This suite follows the repo's model-testing convention: the global mongoose
// mock in __tests__/setup.ts already replaces `mongoose.model(...)` with a
// plain object, so we assign the statics we need directly onto the imported
// model rather than trying to construct it. Assertions therefore target the
// service's branch behaviour and Discord side effects up to (and including)
// the point where the DB row would be written — which is exactly where the
// #813 validation logic lives.
jest.mock("../../src/models/reaction-role-config.js");

import { ReactionRoleService } from "../../src/services/reaction-role-service.js";
import { ReactionRoleConfig } from "../../src/models/reaction-role-config.js";

const Model = ReactionRoleConfig as unknown as {
  findOne: jest.Mock;
  countDocuments: jest.Mock;
  deleteOne: jest.Mock;
};

interface BuildOpts {
  role?: Record<string, unknown> | null;
  botHasManageRoles?: boolean;
  botHigher?: boolean;
  roleManaged?: boolean;
  existingMessage?: Record<string, unknown> | null;
}

function buildGuild(opts: BuildOpts) {
  const newMessage = {
    id: "newmsg",
    react: jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
    delete: jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
  };
  const botMember = {
    permissions: {
      has: jest.fn().mockReturnValue(opts.botHasManageRoles ?? true),
    },
    roles: {
      highest: {
        comparePositionTo: jest
          .fn()
          .mockReturnValue((opts.botHigher ?? true) ? 1 : -1),
      },
    },
  };
  const messageChannel = {
    isTextBased: () => true,
    send: jest.fn<() => Promise<unknown>>().mockResolvedValue(newMessage),
    messages: {
      fetch: jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(opts.existingMessage ?? null),
    },
  };
  const role =
    "role" in opts
      ? opts.role
      : { id: "role1", name: "Gamer", managed: opts.roleManaged ?? false };
  const guild = {
    id: "guild1",
    members: {
      me: botMember,
      fetchMe: jest.fn<() => Promise<unknown>>().mockResolvedValue(botMember),
    },
    roles: {
      everyone: { id: "guild1" },
      fetch: jest.fn<() => Promise<unknown>>().mockResolvedValue(role),
    },
    channels: {
      fetch: jest.fn<() => Promise<unknown>>().mockResolvedValue(messageChannel),
    },
  };
  return { guild, messageChannel, newMessage, botMember };
}

function makeService(guild: unknown, messageChannelId = "chan1") {
  const client = {
    guilds: {
      fetch: jest.fn<() => Promise<unknown>>().mockResolvedValue(guild),
    },
    user: { id: "bot1" },
  } as unknown as Client;
  const service = ReactionRoleService.getInstance(client);
  (service as never)["configService"] = {
    getString: jest
      .fn<() => Promise<string>>()
      .mockResolvedValue(messageChannelId),
    getBoolean: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
    getNumber: jest.fn(),
  };
  return service;
}

beforeEach(() => {
  jest.clearAllMocks();
  Model.findOne = jest.fn();
  Model.countDocuments = jest.fn();
  Model.deleteOne = jest.fn();
  (
    ReactionRoleService as unknown as { instance?: ReactionRoleService }
  ).instance = undefined;
});

describe("ReactionRoleService.bindReactionRole validation", () => {
  it("fails when the target role does not exist", async () => {
    const { guild } = buildGuild({ role: null });
    const service = makeService(guild);

    const result = await service.bindReactionRole("guild1", "missing", "🎨");

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not found/i);
  });

  it("fails with an actionable message when the bot lacks Manage Roles", async () => {
    const { guild } = buildGuild({ botHasManageRoles: false });
    const service = makeService(guild);

    const result = await service.bindReactionRole("guild1", "role1", "🎨");

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Manage Roles/);
  });

  it("fails when the bot's highest role is not above the target role", async () => {
    const { guild } = buildGuild({ botHigher: false });
    const service = makeService(guild);

    const result = await service.bindReactionRole("guild1", "role1", "🎨");

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/highest role/i);
  });

  it("fails when the target role is integration-managed", async () => {
    const { guild } = buildGuild({ roleManaged: true });
    const service = makeService(guild);

    const result = await service.bindReactionRole("guild1", "role1", "🎨");

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/managed/i);
  });

  it("rejects a duplicate emoji already mapped on the same message", async () => {
    const existingMessage = {
      id: "picker1",
      react: jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
    };
    const { guild } = buildGuild({ existingMessage });
    Model.findOne.mockResolvedValue({ _id: "dup" }); // duplicate exists
    const service = makeService(guild);

    const result = await service.bindReactionRole("guild1", "role1", "🎨", {
      messageId: "picker1",
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/already mapped/i);
    expect(existingMessage.react).not.toHaveBeenCalled();
  });

  it("errors when the referenced picker message cannot be fetched", async () => {
    const { guild } = buildGuild({ existingMessage: null });
    Model.findOne.mockResolvedValue(null);
    const service = makeService(guild);

    const result = await service.bindReactionRole("guild1", "role1", "🎨", {
      messageId: "ghost",
    });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not found/i);
  });

  it("reacts to a freshly posted message for a valid new binding", async () => {
    const { guild, messageChannel, newMessage } = buildGuild({});
    Model.findOne.mockResolvedValue(null);
    const service = makeService(guild);

    // The DB write itself can't complete under the global mongoose mock, but
    // the service reaches it only after posting + reacting, which is the
    // behaviour we assert here.
    await service.bindReactionRole("guild1", "role1", "🎨");

    expect(messageChannel.send).toHaveBeenCalledTimes(1);
    expect(newMessage.react).toHaveBeenCalledWith("🎨");
  });

  it("adds to an existing picker message instead of posting a new one", async () => {
    const existingMessage = {
      id: "picker1",
      react: jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
    };
    const { guild, messageChannel } = buildGuild({ existingMessage });
    Model.findOne.mockResolvedValue(null);
    const service = makeService(guild);

    await service.bindReactionRole("guild1", "role1", "🎨", {
      messageId: "picker1",
    });

    expect(messageChannel.send).not.toHaveBeenCalled();
    expect(existingMessage.react).toHaveBeenCalledWith("🎨");
  });
});

describe("ReactionRoleService.createReactionRole channel opt-out", () => {
  function buildCreateGuild(botHasManageRoles = true) {
    const rolesCreate = jest
      .fn<() => Promise<unknown>>()
      .mockResolvedValue({ id: "role1", name: "Gamer" });
    const channelsCreate = jest.fn<() => Promise<unknown>>();
    const newMessage = {
      id: "newmsg",
      react: jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
      delete: jest.fn(),
    };
    const messageChannel = {
      isTextBased: () => true,
      send: jest.fn<() => Promise<unknown>>().mockResolvedValue(newMessage),
    };
    const guild = {
      id: "guild1",
      members: {
        me: { permissions: { has: jest.fn().mockReturnValue(botHasManageRoles) } },
        fetchMe: jest.fn(),
      },
      roles: { create: rolesCreate, everyone: { id: "guild1" } },
      channels: {
        create: channelsCreate,
        fetch: jest
          .fn<() => Promise<unknown>>()
          .mockResolvedValue(messageChannel),
      },
    };
    return { guild, rolesCreate, channelsCreate, messageChannel };
  }

  it("creates the role but no category/channel when createChannel is false", async () => {
    const { guild, rolesCreate, channelsCreate } = buildCreateGuild();
    Model.findOne.mockResolvedValue(null);
    const service = makeService(guild);

    await service.createReactionRole("guild1", "Gamer", "🎮", {
      createChannel: false,
    });

    expect(rolesCreate).toHaveBeenCalledTimes(1);
    expect(channelsCreate).not.toHaveBeenCalled();
  });

  it("creates a category + channel when createChannel is true (default)", async () => {
    const channelsCreate = jest.fn<() => Promise<unknown>>().mockResolvedValue({
      id: "cat1",
      name: "Gamer",
      permissionOverwrites: { edit: jest.fn().mockResolvedValue(undefined) },
    });
    const rolesCreate = jest
      .fn<() => Promise<unknown>>()
      .mockResolvedValue({ id: "role1", name: "Gamer" });
    const messageChannel = {
      isTextBased: () => true,
      send: jest.fn<() => Promise<unknown>>().mockResolvedValue({
        id: "newmsg",
        react: jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
      }),
    };
    const guild = {
      id: "guild1",
      members: {
        me: {
          permissions: { has: jest.fn().mockReturnValue(true) },
        },
        fetchMe: jest.fn(),
      },
      roles: { create: rolesCreate, everyone: { id: "guild1" } },
      channels: {
        create: channelsCreate,
        fetch: jest
          .fn<() => Promise<unknown>>()
          .mockResolvedValue(messageChannel),
      },
    };
    Model.findOne.mockResolvedValue(null);
    const service = makeService(guild);

    await service.createReactionRole("guild1", "Gamer", "🎮");

    // One create for the category, one for the text channel.
    expect(channelsCreate).toHaveBeenCalledTimes(2);
  });

  it("refuses to create when the bot lacks Manage Roles", async () => {
    const { guild, rolesCreate } = buildCreateGuild(false);
    Model.findOne.mockResolvedValue(null);
    const service = makeService(guild);

    const result = await service.createReactionRole("guild1", "Gamer", "🎮");

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Manage Roles/);
    expect(rolesCreate).not.toHaveBeenCalled();
  });
});

describe("ReactionRoleService.removeReactionRoleMapping", () => {
  function reactionlessChannel() {
    return {
      messages: {
        fetch: jest.fn<() => Promise<unknown>>().mockResolvedValue({
          reactions: { cache: { find: jest.fn().mockReturnValue(undefined) } },
        }),
      },
    };
  }

  it("returns an error when no mapping matches", async () => {
    Model.findOne.mockResolvedValue(null);
    const guild = { channels: { fetch: jest.fn() } };
    const service = makeService(guild);

    const result = await service.removeReactionRoleMapping(
      "guild1",
      "m1",
      "🎨",
    );

    expect(result.success).toBe(false);
    expect(Model.deleteOne).not.toHaveBeenCalled();
  });

  it("never deletes the role for a bound (non-auto-created) mapping", async () => {
    Model.findOne.mockResolvedValue({
      _id: "cfg1",
      roleId: "role1",
      roleName: "Gamer",
      messageId: "m1",
      emoji: "🎨",
      autoCreated: false,
    });
    Model.deleteOne.mockResolvedValue({ deletedCount: 1 });
    const roleDelete = jest.fn();
    const guild = {
      channels: {
        fetch: jest
          .fn<() => Promise<unknown>>()
          .mockResolvedValue(reactionlessChannel()),
      },
      roles: {
        fetch: jest
          .fn<() => Promise<unknown>>()
          .mockResolvedValue({ delete: roleDelete }),
      },
    };
    const service = makeService(guild);

    const result = await service.removeReactionRoleMapping(
      "guild1",
      "m1",
      "🎨",
    );

    expect(result.success).toBe(true);
    expect(roleDelete).not.toHaveBeenCalled();
    expect(Model.deleteOne).toHaveBeenCalledWith({ _id: "cfg1" });
  });

  it("deletes an auto-created role when no other mapping references it", async () => {
    Model.findOne.mockResolvedValue({
      _id: "cfg1",
      roleId: "role1",
      roleName: "Gamer",
      messageId: "m1",
      emoji: "🎮",
      autoCreated: true,
    });
    Model.countDocuments.mockResolvedValue(0);
    Model.deleteOne.mockResolvedValue({ deletedCount: 1 });
    const roleDelete = jest
      .fn<() => Promise<unknown>>()
      .mockResolvedValue(undefined);
    const guild = {
      channels: {
        fetch: jest
          .fn<() => Promise<unknown>>()
          .mockResolvedValue(reactionlessChannel()),
      },
      roles: {
        fetch: jest
          .fn<() => Promise<unknown>>()
          .mockResolvedValue({ delete: roleDelete }),
      },
    };
    const service = makeService(guild);

    const result = await service.removeReactionRoleMapping(
      "guild1",
      "m1",
      "🎮",
    );

    expect(result.success).toBe(true);
    expect(roleDelete).toHaveBeenCalledTimes(1);
    expect(Model.deleteOne).toHaveBeenCalledWith({ _id: "cfg1" });
  });

  it("keeps an auto-created role that other mappings still reference", async () => {
    Model.findOne.mockResolvedValue({
      _id: "cfg1",
      roleId: "role1",
      roleName: "Gamer",
      messageId: "m1",
      emoji: "🎮",
      autoCreated: true,
    });
    Model.countDocuments.mockResolvedValue(2); // still referenced elsewhere
    Model.deleteOne.mockResolvedValue({ deletedCount: 1 });
    const roleDelete = jest.fn();
    const guild = {
      channels: {
        fetch: jest
          .fn<() => Promise<unknown>>()
          .mockResolvedValue(reactionlessChannel()),
      },
      roles: {
        fetch: jest
          .fn<() => Promise<unknown>>()
          .mockResolvedValue({ delete: roleDelete }),
      },
    };
    const service = makeService(guild);

    const result = await service.removeReactionRoleMapping(
      "guild1",
      "m1",
      "🎮",
    );

    expect(result.success).toBe(true);
    expect(roleDelete).not.toHaveBeenCalled();
  });
});
