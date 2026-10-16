import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { ChannelType, PermissionFlagsBits, type Client } from "discord.js";
import { usePerModelStubs } from "../test-utils.js";

// Same model-testing convention as the binding suite: the model is a plain
// object whose statics are assigned below.
jest.mock("../../src/models/reaction-role-config.js");
// REST goes through CommandManager.makeDiscordApiCall; run the call directly.
jest.unstable_mockModule("../../src/services/command-manager.js", () => ({
  CommandManager: {
    getInstance: () => ({
      makeDiscordApiCall: async (call: () => Promise<unknown>) => call(),
    }),
  },
}));
usePerModelStubs();

const { ReactionRoleService } =
  await import("../../src/services/reaction-role-service.js");
import { ReactionRoleConfig } from "../../src/models/reaction-role-config.js";

const Model = ReactionRoleConfig as unknown as {
  findOne: jest.Mock;
  updateOne: jest.Mock;
  deleteOne: jest.Mock;
};

function build(rolePermissions = 0n, categoryType = ChannelType.GuildCategory) {
  const role = {
    id: "role1",
    name: "Valorant",
    managed: false,
    permissions: { bitfield: rolePermissions },
    delete: jest.fn(),
  };
  const category = {
    id: "cat1",
    type: categoryType,
    delete: jest.fn(),
    permissionOverwrites: { edit: jest.fn(), delete: jest.fn() },
  };
  const message = {
    id: "msg1",
    delete: jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
  };
  const pickerChannel = {
    isTextBased: () => true,
    messages: {
      fetch: jest.fn<() => Promise<unknown>>().mockResolvedValue(message),
    },
  };
  const botMember = {
    permissions: { has: jest.fn().mockReturnValue(true) },
    roles: { highest: { comparePositionTo: jest.fn().mockReturnValue(1) } },
  };
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
      fetch: jest
        .fn<(id: string) => Promise<unknown>>()
        .mockImplementation(async (id) =>
          id === "cat1" ? category : pickerChannel,
        ),
    },
  };
  const client = {
    guilds: {
      fetch: jest.fn<() => Promise<unknown>>().mockResolvedValue(guild),
    },
    user: { id: "bot1" },
  } as unknown as Client;
  const service = ReactionRoleService.getInstance(client);
  (service as never)["configService"] = {
    getString: jest.fn<() => Promise<string>>().mockResolvedValue("picker"),
    getBoolean: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
    getNumber: jest.fn(),
  };
  return { service, role, category, message, guild };
}

beforeEach(() => {
  jest.clearAllMocks();
  Model.findOne = jest.fn<() => Promise<unknown>>().mockResolvedValue(null);
  Model.updateOne = jest
    .fn<() => Promise<unknown>>()
    .mockResolvedValue({ matchedCount: 1 });
  Model.deleteOne = jest.fn<() => Promise<unknown>>().mockResolvedValue({});
  (ReactionRoleService as unknown as { instance?: unknown }).instance =
    undefined;
});

describe("ReactionRoleService.registerGatedPairing (#1022)", () => {
  it("refuses a role with Administrator before posting anything", async () => {
    const { service } = build(PermissionFlagsBits.Administrator);
    const bind = jest.spyOn(service, "bindReactionRole");
    await expect(
      service.registerGatedPairing("guild1", {
        roleId: "role1",
        categoryId: "cat1",
        emoji: "🎮",
      }),
    ).rejects.toThrow(/powerful permissions \(Administrator\)/);
    expect(bind).not.toHaveBeenCalled();
    expect(Model.updateOne).not.toHaveBeenCalled();
  });

  it.each([
    ["ManageRoles", PermissionFlagsBits.ManageRoles],
    ["ManageGuild", PermissionFlagsBits.ManageGuild],
    ["BanMembers", PermissionFlagsBits.BanMembers],
  ])("refuses a role that carries %s", async (_name, bit) => {
    const { service } = build(bit);
    await expect(
      service.registerGatedPairing("guild1", {
        roleId: "role1",
        categoryId: "cat1",
        emoji: "🎮",
      }),
    ).rejects.toThrow(/powerful permissions/);
  });

  it("requires a real category", async () => {
    const { service } = build(0n, ChannelType.GuildText);
    await expect(
      service.registerGatedPairing("guild1", {
        roleId: "role1",
        categoryId: "cat1",
        emoji: "🎮",
      }),
    ).rejects.toThrow(/Category cat1 was not found/);
  });

  it("binds the existing role and links the category without editing either", async () => {
    const { service, role, category } = build();
    const bind = jest.spyOn(service, "bindReactionRole").mockResolvedValue({
      success: true,
      message: "ok",
      roleId: "role1",
      messageId: "msg1",
    });
    const result = await service.registerGatedPairing("guild1", {
      roleId: "role1",
      categoryId: "cat1",
      emoji: "🎮",
    });
    expect(result).toEqual({ messageId: "msg1", reused: false });
    // The category is stored by the mapping's own first save.
    expect(bind).toHaveBeenCalledWith("guild1", "role1", "🎮", {
      categoryId: "cat1",
    });
    expect(Model.updateOne).not.toHaveBeenCalled();
    // The role and the category are only read.
    expect(role.delete).not.toHaveBeenCalled();
    expect(category.delete).not.toHaveBeenCalled();
    expect(category.permissionOverwrites.edit).not.toHaveBeenCalled();
    expect(category.permissionOverwrites.delete).not.toHaveBeenCalled();
  });

  it("is idempotent: a mapping an earlier attempt stored is returned, not posted again", async () => {
    const { service } = build();
    Model.findOne.mockResolvedValueOnce({ messageId: "msg-earlier" });
    const bind = jest.spyOn(service, "bindReactionRole");
    const result = await service.registerGatedPairing("guild1", {
      roleId: "role1",
      categoryId: "cat1",
      emoji: "🎮",
    });
    expect(result).toEqual({ messageId: "msg-earlier", reused: true });
    expect(bind).not.toHaveBeenCalled();
  });

  it("does not register a role that is already a reaction role elsewhere", async () => {
    const { service } = build();
    Model.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ messageId: "other" });
    await expect(
      service.registerGatedPairing("guild1", {
        roleId: "role1",
        categoryId: "cat1",
        emoji: "🎮",
      }),
    ).rejects.toThrow(/already a reaction role/);
  });

  it("a resumed step reports an existing mapping as its own, so a rollback removes it", async () => {
    const { service } = build();
    Model.findOne.mockResolvedValueOnce({ messageId: "msg-late" });
    const bind = jest.spyOn(service, "bindReactionRole");
    const result = await service.registerGatedPairing("guild1", {
      roleId: "role1",
      categoryId: "cat1",
      emoji: "🎮",
      resumed: true,
    });
    expect(result).toEqual({ messageId: "msg-late", reused: false });
    expect(bind).not.toHaveBeenCalled();
  });
});

describe("ReactionRoleService.unregisterGatedPairing (#1022)", () => {
  it("deletes only the picker message and the mapping, never the role or the category", async () => {
    const { service, message, role, category } = build();
    Model.findOne.mockResolvedValue({ _id: "row1" });
    await service.unregisterGatedPairing("guild1", {
      roleId: "role1",
      messageId: "msg1",
    });
    expect(Model.findOne).toHaveBeenCalledWith({
      guildId: "guild1",
      messageId: "msg1",
      roleId: "role1",
      autoCreated: false,
    });
    expect(message.delete).toHaveBeenCalledTimes(1);
    expect(Model.deleteOne).toHaveBeenCalledWith({ _id: "row1" });
    expect(role.delete).not.toHaveBeenCalled();
    expect(category.delete).not.toHaveBeenCalled();
  });

  it("does nothing for a mapping that isn't a bound one", async () => {
    const { service, message } = build();
    await service.unregisterGatedPairing("guild1", {
      roleId: "role1",
      messageId: "msg1",
    });
    expect(message.delete).not.toHaveBeenCalled();
    expect(Model.deleteOne).not.toHaveBeenCalled();
  });
});
