import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import {
  ChannelType,
  DiscordAPIError,
  PermissionFlagsBits,
  type Client,
} from "discord.js";
import { usePerModelStubs } from "../test-utils.js";

// Same model-testing convention as the binding suite: the model is a plain
// object whose statics are assigned below.
jest.mock("../../src/models/reaction-role-config.js");
usePerModelStubs();
// REST goes through CommandManager.makeDiscordApiCall; run the call directly.
jest.unstable_mockModule("../../src/services/command-manager.js", () => ({
  CommandManager: {
    getInstance: () => ({
      makeDiscordApiCall: async (call: () => Promise<unknown>) => call(),
    }),
  },
}));

const { ReactionRoleService } =
  await import("../../src/services/reaction-role-service.js");
import { ReactionRoleConfig } from "../../src/models/reaction-role-config.js";

const Model = ReactionRoleConfig as unknown as {
  findOne: jest.Mock;
  deleteOne: jest.Mock;
};

const OWNER = "snap-1:op-1";
const input = (over: Record<string, unknown> = {}) => ({
  roleId: "role1",
  categoryId: "cat1",
  emoji: "🎮",
  channelId: "picker",
  ownerKey: OWNER,
  ...over,
});

const unknown = (code: number): DiscordAPIError =>
  new DiscordAPIError(
    { code, message: "Unknown" } as never,
    code,
    404,
    "GET",
    "https://discord.test",
    {},
  );

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
  const messageFetch = jest
    .fn<() => Promise<unknown>>()
    .mockResolvedValue(message);
  const pickerChannel = {
    isTextBased: () => true,
    messages: { fetch: messageFetch },
  };
  const botMember = {
    permissions: { has: jest.fn().mockReturnValue(true) },
    roles: { highest: { comparePositionTo: jest.fn().mockReturnValue(1) } },
  };
  const channelFetch = jest
    .fn<(id: string) => Promise<unknown>>()
    .mockImplementation(async (id) =>
      id === "cat1" ? category : pickerChannel,
    );
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
    channels: { fetch: channelFetch },
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
  return { service, role, category, message, messageFetch, channelFetch };
}

beforeEach(() => {
  jest.clearAllMocks();
  Model.findOne = jest.fn<() => Promise<unknown>>().mockResolvedValue(null);
  Model.deleteOne = jest.fn<() => Promise<unknown>>().mockResolvedValue({});
  (ReactionRoleService as unknown as { instance?: unknown }).instance =
    undefined;
});

describe("ReactionRoleService.registerGatedPairing (#1022)", () => {
  it("refuses a role with Administrator before posting anything", async () => {
    const { service } = build(PermissionFlagsBits.Administrator);
    const bind = jest.spyOn(service, "bindReactionRole");
    await expect(
      service.registerGatedPairing("guild1", input()),
    ).rejects.toThrow(/powerful permissions \(Administrator\)/);
    expect(bind).not.toHaveBeenCalled();
  });

  it.each([
    ["ManageRoles", PermissionFlagsBits.ManageRoles],
    ["ManageGuild", PermissionFlagsBits.ManageGuild],
    ["BanMembers", PermissionFlagsBits.BanMembers],
  ])("refuses a role that carries %s", async (_name, bit) => {
    const { service } = build(bit);
    await expect(
      service.registerGatedPairing("guild1", input()),
    ).rejects.toThrow(/powerful permissions/);
  });

  it("requires a real category", async () => {
    const { service } = build(0n, ChannelType.GuildText);
    await expect(
      service.registerGatedPairing("guild1", input()),
    ).rejects.toThrow(/Category cat1 was not found/);
  });

  it("refuses when the reaction-role channel changed since the preview", async () => {
    const { service } = build();
    const bind = jest.spyOn(service, "bindReactionRole");
    await expect(
      service.registerGatedPairing("guild1", input({ channelId: "old" })),
    ).rejects.toThrow(/channel changed since the plan was previewed/);
    expect(bind).not.toHaveBeenCalled();
  });

  it("binds the existing role in the planned channel, storing category and owner with the mapping", async () => {
    const { service, role, category } = build();
    const bind = jest.spyOn(service, "bindReactionRole").mockResolvedValue({
      success: true,
      message: "ok",
      roleId: "role1",
      messageId: "msg1",
    });
    const result = await service.registerGatedPairing("guild1", input());
    expect(result).toEqual({
      messageId: "msg1",
      channelId: "picker",
      reused: false,
    });
    expect(bind).toHaveBeenCalledWith("guild1", "role1", "🎮", {
      messageChannelId: "picker",
      categoryId: "cat1",
      adoptionOpKey: OWNER,
    });
    // The role and the category are only read.
    expect(role.delete).not.toHaveBeenCalled();
    expect(category.delete).not.toHaveBeenCalled();
    expect(category.permissionOverwrites.edit).not.toHaveBeenCalled();
    expect(category.permissionOverwrites.delete).not.toHaveBeenCalled();
  });

  it("a mapping with the same owner key is this step's own (a late first attempt)", async () => {
    const { service } = build();
    Model.findOne.mockResolvedValueOnce({
      messageId: "msg-late",
      adoptionOpKey: OWNER,
    });
    const bind = jest.spyOn(service, "bindReactionRole");
    const result = await service.registerGatedPairing("guild1", input());
    expect(result).toEqual({
      messageId: "msg-late",
      channelId: "picker",
      reused: false,
    });
    expect(bind).not.toHaveBeenCalled();
  });

  it("a mapping another plan (or none) made is reported as reused, never as owned", async () => {
    const { service } = build();
    const bind = jest.spyOn(service, "bindReactionRole");
    Model.findOne.mockResolvedValueOnce({
      messageId: "msg-b",
      adoptionOpKey: "snap-2:op-1",
    });
    expect(await service.registerGatedPairing("guild1", input())).toMatchObject(
      { messageId: "msg-b", reused: true },
    );
    Model.findOne.mockResolvedValueOnce({ messageId: "msg-page" });
    expect(await service.registerGatedPairing("guild1", input())).toMatchObject(
      { messageId: "msg-page", reused: true },
    );
    expect(bind).not.toHaveBeenCalled();
  });

  it("does not register a role that is already a reaction role elsewhere", async () => {
    const { service } = build();
    Model.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ messageId: "other" });
    await expect(
      service.registerGatedPairing("guild1", input()),
    ).rejects.toThrow(/already a reaction role/);
  });

  it("a second attempt waits for a first one still running and then finds its mapping, never posting twice", async () => {
    const { service } = build();
    let stored: { messageId: string; adoptionOpKey: string } | null = null;
    Model.findOne.mockImplementation(async (query: unknown) =>
      (query as { categoryId?: string }).categoryId ? stored : null,
    );
    let release!: () => void;
    const bind = jest.spyOn(service, "bindReactionRole").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => {
            stored = { messageId: "msg1", adoptionOpKey: OWNER };
            resolve({
              success: true,
              message: "ok",
              roleId: "role1",
              messageId: "msg1",
            });
          };
        }),
    );
    // The first attempt's caller gave up (timeout) but the work continues.
    const first = service.registerGatedPairing("guild1", input());
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(bind).toHaveBeenCalledTimes(1);
    const second = service.registerGatedPairing("guild1", input());
    for (let i = 0; i < 50; i++) await Promise.resolve();
    // Still waiting: it has not run its existence checks or posted.
    expect(bind).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(await second).toEqual({
      messageId: "msg1",
      channelId: "picker",
      reused: false,
    });
    expect(bind).toHaveBeenCalledTimes(1);
  });
});

describe("ReactionRoleService.unregisterGatedPairing (#1022)", () => {
  const un = (over: Record<string, unknown> = {}) => ({
    roleId: "role1",
    messageId: "msg1",
    channelId: "picker",
    ownerKey: OWNER,
    ...over,
  });

  it("deletes the picker in the recorded channel and then the mapping, never the role or the category", async () => {
    const { service, message, role, category, channelFetch } = build();
    Model.findOne.mockResolvedValue({ _id: "row1" });
    await service.unregisterGatedPairing("guild1", un());
    expect(Model.findOne).toHaveBeenCalledWith({
      guildId: "guild1",
      messageId: "msg1",
      roleId: "role1",
      autoCreated: false,
      adoptionOpKey: OWNER,
    });
    expect(channelFetch).toHaveBeenCalledWith("picker");
    expect(message.delete).toHaveBeenCalledTimes(1);
    expect(Model.deleteOne).toHaveBeenCalledWith({ _id: "row1" });
    expect(role.delete).not.toHaveBeenCalled();
    expect(category.delete).not.toHaveBeenCalled();
  });

  it("does nothing for a mapping another plan owns", async () => {
    const { service, message } = build();
    await service.unregisterGatedPairing("guild1", un());
    expect(message.delete).not.toHaveBeenCalled();
    expect(Model.deleteOne).not.toHaveBeenCalled();
  });

  it("an Unknown Message counts as already removed and the mapping is deleted", async () => {
    const { service, messageFetch } = build();
    Model.findOne.mockResolvedValue({ _id: "row1" });
    messageFetch.mockRejectedValue(unknown(10008));
    await service.unregisterGatedPairing("guild1", un());
    expect(Model.deleteOne).toHaveBeenCalledWith({ _id: "row1" });
  });

  it("an Unknown Channel counts as already removed and the mapping is deleted", async () => {
    const { service, channelFetch } = build();
    Model.findOne.mockResolvedValue({ _id: "row1" });
    channelFetch.mockRejectedValue(unknown(10003));
    await service.unregisterGatedPairing("guild1", un());
    expect(Model.deleteOne).toHaveBeenCalledWith({ _id: "row1" });
  });

  it("any other failure keeps the mapping and throws, and a retry then finishes", async () => {
    const { service, message, messageFetch } = build();
    Model.findOne.mockResolvedValue({ _id: "row1" });
    messageFetch.mockRejectedValueOnce(new Error("Discord is down"));
    await expect(
      service.unregisterGatedPairing("guild1", un()),
    ).rejects.toThrow("Discord is down");
    expect(Model.deleteOne).not.toHaveBeenCalled();
    message.delete.mockRejectedValueOnce(new Error("Missing Permissions"));
    await expect(
      service.unregisterGatedPairing("guild1", un()),
    ).rejects.toThrow("Missing Permissions");
    expect(Model.deleteOne).not.toHaveBeenCalled();
    await service.unregisterGatedPairing("guild1", un());
    expect(Model.deleteOne).toHaveBeenCalledWith({ _id: "row1" });
  });
});
