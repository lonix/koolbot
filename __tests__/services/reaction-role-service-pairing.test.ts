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
import { reactionRoleGuildLock } from "../../src/services/reaction-role-guild-lock.js";

const Model = ReactionRoleConfig as unknown as {
  findOne: jest.Mock;
  deleteOne: jest.Mock;
  countDocuments: jest.Mock;
};

const OWNER = "snap-1:op-1";
type Binder = {
  bindReactionRoleUnlocked: (...args: unknown[]) => Promise<unknown>;
};
// The registrar holds the guild lock itself, so it calls the unlocked bind.
const spyBind = (service: unknown) =>
  jest.spyOn(service as Binder, "bindReactionRoleUnlocked");
const MARK = ` · ref ${OWNER}`;
const picker = (id: string, footer: string, authorId = "bot1") => ({
  id,
  author: { id: authorId },
  embeds: [{ footer: { text: footer } }],
  delete: jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
});
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

function build(
  rolePermissions = 0n,
  categoryType = ChannelType.GuildCategory,
  overwriteAllow = 0n,
) {
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
    name: "Valorant",
    permissionOverwrites: {
      edit: jest.fn(),
      delete: jest.fn(),
      cache: new Map([["role1", { allow: { bitfield: overwriteAllow } }]]),
    },
  };
  const botReaction = {
    emoji: { id: null, name: "🎮" },
    users: { remove: jest.fn<() => Promise<unknown>>().mockResolvedValue({}) },
  };
  const message = {
    id: "msg1",
    delete: jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
    reactions: {
      cache: {
        find: (fn: (r: typeof botReaction) => boolean) =>
          fn(botReaction) ? botReaction : undefined,
      },
    },
  };
  const messageFetch = jest
    .fn<() => Promise<unknown>>()
    .mockResolvedValue(message);
  const sent = {
    id: "sent1",
    react: jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
    delete: jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
  };
  const send = jest
    .fn<(payload: unknown) => Promise<unknown>>()
    .mockResolvedValue(sent);
  const pickerChannel = {
    isTextBased: () => true,
    send,
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
  return {
    service,
    role,
    category,
    message,
    messageFetch,
    channelFetch,
    botReaction,
    guild,
    send,
    pickerChannel,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  Model.findOne = jest.fn<() => Promise<unknown>>().mockResolvedValue(null);
  Model.deleteOne = jest.fn<() => Promise<unknown>>().mockResolvedValue({});
  Model.countDocuments = jest.fn<() => Promise<number>>().mockResolvedValue(0);
  (ReactionRoleService as unknown as { instance?: unknown }).instance =
    undefined;
});

describe("ReactionRoleService.registerGatedPairing (#1022)", () => {
  it("refuses a role with Administrator before posting anything", async () => {
    const { service } = build(PermissionFlagsBits.Administrator);
    const bind = spyBind(service);
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

  it.each([
    ["ManageChannels", PermissionFlagsBits.ManageChannels],
    ["ManageWebhooks", PermissionFlagsBits.ManageWebhooks],
    ["ManageRoles", PermissionFlagsBits.ManageRoles],
  ])(
    "refuses a plain role whose category overwrite grants %s",
    async (_name, bit) => {
      const { service } = build(
        0n,
        ChannelType.GuildCategory,
        PermissionFlagsBits.ViewChannel | bit,
      );
      const bind = spyBind(service);
      await expect(
        service.registerGatedPairing("guild1", input()),
      ).rejects.toThrow(/powerful permissions in its own overwrite/);
      expect(bind).not.toHaveBeenCalled();
    },
  );

  it("refuses a role whose overwrite on an unsynced child channel grants Manage Webhooks", async () => {
    const { service, guild } = build();
    (guild.channels as unknown as { cache: Map<string, unknown> }).cache =
      new Map([
        [
          "child1",
          {
            id: "child1",
            name: "games-chat",
            permissionOverwrites: {
              cache: new Map([
                [
                  "role1",
                  {
                    allow: {
                      bitfield:
                        PermissionFlagsBits.ViewChannel |
                        PermissionFlagsBits.ManageWebhooks,
                    },
                  },
                ],
              ]),
            },
          },
        ],
      ]);
    const bind = spyBind(service);
    await expect(
      service.registerGatedPairing("guild1", input()),
    ).rejects.toThrow(/games-chat gives Valorant powerful permissions/);
    expect(bind).not.toHaveBeenCalled();
  });

  it("requires a real category", async () => {
    const { service } = build(0n, ChannelType.GuildText);
    await expect(
      service.registerGatedPairing("guild1", input()),
    ).rejects.toThrow(/Category cat1 was not found/);
  });

  it("refuses when the reaction-role channel changed since the preview", async () => {
    const { service } = build();
    const bind = spyBind(service);
    await expect(
      service.registerGatedPairing("guild1", input({ channelId: "old" })),
    ).rejects.toThrow(/channel changed since the plan was previewed/);
    expect(bind).not.toHaveBeenCalled();
  });

  it("binds the existing role in the planned channel, storing category and owner with the mapping", async () => {
    const { service, role, category } = build();
    const bind = spyBind(service).mockResolvedValue({
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
    const bind = spyBind(service);
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
    const bind = spyBind(service);
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
    const bind = spyBind(service).mockImplementation(
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

  it("deletes the picker when nothing else shares it", async () => {
    const { service, message, botReaction } = build();
    Model.findOne.mockResolvedValue({ _id: "row1", emoji: "🎮" });
    await service.unregisterGatedPairing("guild1", un());
    expect(message.delete).toHaveBeenCalledTimes(1);
    expect(botReaction.users.remove).not.toHaveBeenCalled();
  });

  it("keeps a picker another mapping was added to: only this mapping's reaction goes", async () => {
    const { service, message, botReaction } = build();
    Model.findOne.mockResolvedValue({ _id: "row1", emoji: "🎮" });
    Model.countDocuments.mockResolvedValue(1);
    await service.unregisterGatedPairing("guild1", un());
    expect(Model.countDocuments).toHaveBeenCalledWith({
      guildId: "guild1",
      messageId: "msg1",
      isArchived: false,
      _id: { $ne: "row1" },
    });
    expect(message.delete).not.toHaveBeenCalled();
    expect(botReaction.users.remove).toHaveBeenCalledWith("bot1");
    expect(Model.deleteOne).toHaveBeenCalledWith({ _id: "row1" });
  });

  it("adding a mapping to an existing picker waits for the lock the rollback holds", async () => {
    const { service } = build();
    let release!: () => void;
    const held = reactionRoleGuildLock.run(
      "guild1",
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const binding = service.bindReactionRole("guild1", "role1", "🎮", {
      messageId: "msg1",
    });
    for (let i = 0; i < 50; i++) await Promise.resolve();
    // Blocked behind the in-flight rollback: nothing was looked up yet.
    expect(Model.findOne).not.toHaveBeenCalled();
    release();
    await held;
    await binding;
    expect(Model.findOne).toHaveBeenCalled();
  });

  it("finds the mapping a step saved, by its owner key, without posting", async () => {
    const { service, messageFetch } = build();
    Model.findOne.mockResolvedValueOnce({ messageId: "msg-saved" });
    const bind = spyBind(service);
    expect(
      await service.findOwnedPairing("guild1", {
        roleId: "role1",
        ownerKey: OWNER,
        channelId: "picker",
      }),
    ).toBe("msg-saved");
    expect(Model.findOne).toHaveBeenCalledWith({
      guildId: "guild1",
      roleId: "role1",
      adoptionOpKey: OWNER,
      autoCreated: false,
      isArchived: false,
    });
    expect(bind).not.toHaveBeenCalled();
    messageFetch.mockResolvedValue(new Map());
    expect(
      await service.findOwnedPairing("guild1", {
        roleId: "role1",
        ownerKey: "other",
        channelId: "picker",
      }),
    ).toBeNull();
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

describe("pickers that exist before their mapping is saved (#1022)", () => {
  const un = (over: Record<string, unknown> = {}) => ({
    roleId: "role1",
    messageId: "orphan1",
    channelId: "picker",
    ownerKey: OWNER,
    ...over,
  });

  it("a picker posted by an adoption step carries the step key in its footer", async () => {
    const { service, send } = build();
    // The mapping can't be saved under the global model mock; the post is what
    // matters here.
    await service.bindReactionRole("guild1", "role1", "🎮", {
      adoptionOpKey: OWNER,
    });
    const payload = send.mock.calls[0][0] as {
      embeds: Array<{ data: { footer: { text: string } } }>;
    };
    expect(payload.embeds[0].data.footer.text.endsWith(MARK)).toBe(true);
  });

  it("a retry completes the picker it posted before dying instead of posting a second one", async () => {
    const { service, pickerChannel, messageFetch } = build();
    messageFetch.mockResolvedValue(
      new Map([
        ["other", picker("other", "Remove your reaction to lose the role")],
        ["theirs", picker("theirs", `x${MARK}`, "someone-else")],
        ["orphan1", picker("orphan1", `Remove your reaction${MARK}`)],
      ]),
    );
    const bind = spyBind(service).mockResolvedValue({
      success: true,
      message: "ok",
      roleId: "role1",
      messageId: "orphan1",
    });
    const result = await service.registerGatedPairing(
      "guild1",
      input({ retry: true }),
    );
    expect(result).toEqual({
      messageId: "orphan1",
      channelId: "picker",
      reused: false,
    });
    // Completed on the existing message (reaction and mapping), nothing sent.
    expect(bind).toHaveBeenCalledWith("guild1", "role1", "🎮", {
      messageChannelId: "picker",
      categoryId: "cat1",
      adoptionOpKey: OWNER,
      messageId: "orphan1",
    });
    expect(pickerChannel.send).not.toHaveBeenCalled();
  });

  it("the first attempt reads no history", async () => {
    const { service, messageFetch } = build();
    spyBind(service).mockResolvedValue({
      success: true,
      message: "ok",
      roleId: "role1",
      messageId: "msg1",
    });
    await service.registerGatedPairing("guild1", input());
    expect(messageFetch).not.toHaveBeenCalled();
  });

  it("finds an unmapped picker by its marker for the rollback", async () => {
    const { service, messageFetch } = build();
    messageFetch.mockResolvedValue(
      new Map([["orphan1", picker("orphan1", `Remove${MARK}`)]]),
    );
    expect(
      await service.findOwnedPairing("guild1", {
        roleId: "role1",
        ownerKey: OWNER,
        channelId: "picker",
      }),
    ).toBe("orphan1");
    messageFetch.mockResolvedValue(
      new Map([["x", picker("x", "Remove your reaction to lose the role")]]),
    );
    expect(
      await service.findOwnedPairing("guild1", {
        roleId: "role1",
        ownerKey: OWNER,
        channelId: "picker",
      }),
    ).toBeNull();
  });

  it("a marked picker another mapping has since been added to is not deleted", async () => {
    const { service, messageFetch } = build();
    const mine = picker("orphan1", `Remove${MARK}`);
    messageFetch.mockResolvedValue(mine);
    Model.countDocuments.mockResolvedValue(1);
    await service.unregisterGatedPairing("guild1", un());
    expect(Model.countDocuments).toHaveBeenCalledWith({
      guildId: "guild1",
      messageId: "orphan1",
      isArchived: false,
    });
    expect(mine.delete).not.toHaveBeenCalled();
    expect(Model.deleteOne).not.toHaveBeenCalled();
  });

  it("a rollback deletes an unmapped picker only when its marker is this step's", async () => {
    const { service, messageFetch } = build();
    const mine = picker("orphan1", `Remove${MARK}`);
    messageFetch.mockResolvedValue(mine);
    await service.unregisterGatedPairing("guild1", un());
    expect(mine.delete).toHaveBeenCalledTimes(1);
    expect(Model.deleteOne).not.toHaveBeenCalled();
    const notMine = picker("orphan1", "Remove your reaction to lose the role");
    messageFetch.mockResolvedValue(notMine);
    await service.unregisterGatedPairing("guild1", un());
    expect(notMine.delete).not.toHaveBeenCalled();
    const other = picker("orphan1", `Remove${MARK}`, "someone-else");
    messageFetch.mockResolvedValue(other);
    await service.unregisterGatedPairing("guild1", un());
    expect(other.delete).not.toHaveBeenCalled();
  });
});
