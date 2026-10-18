import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { DiscordAPIError, type Client } from "discord.js";

/**
 * A mapping remembers the channel its picker was posted in (#1207), and every
 * lifecycle path looks the picker up there, falling back to the configured
 * `reactionroles.message_channel_id` only for older rows without the field.
 *
 * The fake guild resolves channels BY ID, so a lookup in the wrong channel
 * fails the way Discord would (10003 / 10008) instead of silently succeeding.
 */

const mockSave = jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined);
const constructed: Array<Record<string, unknown>> = [];

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
  isDebugMode: jest.fn(() => false),
}));
const mockApi = jest.fn<
  (fn: () => Promise<unknown>, label: string) => Promise<unknown>
>(async (fn) => fn());
jest.unstable_mockModule("../../src/services/command-manager.js", () => ({
  CommandManager: { getInstance: () => ({ makeDiscordApiCall: mockApi }) },
}));
jest.unstable_mockModule("../../src/models/reaction-role-config.js", () => {
  class ReactionRoleConfig {
    constructor(data: Record<string, unknown>) {
      Object.assign(this, data);
      constructed.push(data);
    }
    save = mockSave;
    static find = jest.fn();
    static findOne = jest.fn();
    static countDocuments = jest.fn();
    static deleteOne = jest.fn();
    static deleteMany = jest.fn();
    static insertMany = jest.fn();
  }
  return {
    ReactionRoleConfig,
    REACTION_ROLE_STYLES: ["reaction", "button", "select"],
    REACTION_ROLE_MODES: ["toggle", "sticky", "unique"],
  };
});

const { ReactionRoleService } =
  await import("../../src/services/reaction-role-service.js");
const { ReactionRoleConfig } =
  await import("../../src/models/reaction-role-config.js");

const Model = ReactionRoleConfig as unknown as {
  find: jest.Mock;
  findOne: jest.Mock;
  countDocuments: jest.Mock;
  deleteOne: jest.Mock;
  deleteMany: jest.Mock;
  insertMany: jest.Mock;
};

const CONFIGURED = "new-chan";
const OLD = "old-chan";

function discordError(code: number): DiscordAPIError {
  return Object.assign(Object.create(DiscordAPIError.prototype), {
    code,
    message: `Unknown entity (${code})`,
  }) as DiscordAPIError;
}

interface FakeMessage {
  id: string;
  delete: jest.Mock;
  react: jest.Mock;
  reactions: { cache: { some: () => boolean; find: () => undefined } };
}

function fakeMessage(id: string): FakeMessage {
  return {
    id,
    delete: jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
    react: jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
    reactions: { cache: { some: () => true, find: () => undefined } },
  };
}

interface FakeChannel {
  id: string;
  isTextBased: () => boolean;
  messages: { fetch: jest.Mock };
  send: jest.Mock;
}

/** A text channel holding the given messages; any other id is Unknown Message. */
function fakeChannel(
  id: string,
  held: FakeMessage[] = [],
  posted: FakeMessage = fakeMessage("posted"),
): FakeChannel {
  return {
    id,
    isTextBased: () => true,
    messages: {
      fetch: jest.fn(async (messageId: string) => {
        const found = held.find((m) => m.id === messageId);
        if (!found) throw discordError(10008);
        return found;
      }),
    },
    send: jest.fn<() => Promise<unknown>>().mockResolvedValue(posted),
  };
}

/** A guild whose `channels.fetch` resolves by id; unknown ids are 10003. */
function fakeGuild(
  channels: FakeChannel[],
  extra: Record<string, unknown> = {},
) {
  const byId = new Map(channels.map((c) => [c.id, c]));
  const botMember = {
    permissions: { has: jest.fn().mockReturnValue(true) },
    roles: { highest: { comparePositionTo: jest.fn().mockReturnValue(1) } },
  };
  return {
    id: "g1",
    members: {
      me: botMember,
      fetchMe: jest.fn<() => Promise<unknown>>().mockResolvedValue(botMember),
    },
    roles: {
      everyone: { id: "g1" },
      fetch: jest.fn(async (id: string) => ({
        id,
        name: "Gamer",
        managed: false,
        delete: jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
      })),
      create: jest.fn(async () => ({
        id: "newrole",
        name: "Gamer",
        delete: jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
      })),
    },
    channels: {
      fetch: jest.fn(async (id: string) => {
        const c = byId.get(id);
        if (!c) throw discordError(10003);
        return c;
      }),
    },
    ...extra,
  };
}

function makeService(guild: unknown, configured = CONFIGURED) {
  const client = {
    guilds: {
      fetch: jest.fn<() => Promise<unknown>>().mockResolvedValue(guild),
    },
    user: { id: "bot1" },
  } as unknown as Client;
  const service = ReactionRoleService.getInstance(client);
  (service as never)["configService"] = {
    getString: jest.fn<() => Promise<string>>().mockResolvedValue(configured),
    getBoolean: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
    getNumber: jest.fn(),
  };
  return service;
}

interface RowOpts {
  _id?: string;
  guildId?: string;
  messageId?: string;
  messageChannelId?: string;
  roleId?: string;
  emoji?: string;
  roleName?: string;
  autoCreated?: boolean;
  groupId?: string;
  categoryId?: string;
  isArchived?: boolean;
}

function row(o: RowOpts = {}) {
  return {
    _id: "cfg",
    guildId: "g1",
    messageId: "m1",
    roleId: "role1",
    emoji: "🎮",
    roleName: "Gamer",
    autoCreated: false,
    isArchived: false,
    mode: "toggle",
    style: "reaction",
    save: jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
    ...o,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  constructed.length = 0;
  Model.find.mockReset();
  Model.findOne.mockReset();
  Model.countDocuments.mockReset().mockResolvedValue(0);
  Model.deleteOne.mockReset().mockResolvedValue({});
  Model.insertMany.mockReset().mockResolvedValue([]);
  Model.deleteMany.mockReset().mockResolvedValue({});
  (ReactionRoleService as unknown as { instance?: unknown }).instance =
    undefined;
});

describe("reconcileConfigs with a remembered picker channel", () => {
  it("looks a stored mapping up in its own channel after the setting changed", async () => {
    const msg = fakeMessage("m1");
    const old = fakeChannel(OLD, [msg]);
    const guild = fakeGuild([old, fakeChannel(CONFIGURED)]);
    const stored = row({ messageChannelId: OLD });
    Model.find.mockResolvedValue([stored]);

    await makeService(guild).reconcileConfigs();

    expect(guild.channels.fetch).toHaveBeenCalledWith(OLD, { force: true });
    expect(guild.channels.fetch).not.toHaveBeenCalledWith(
      CONFIGURED,
      expect.anything(),
    );
    expect(stored.isArchived).toBe(false);
    expect(stored.save).not.toHaveBeenCalled();
  });

  it("keeps old pickers when a new picker is created in the new channel", async () => {
    // The case #1201 could not handle: the channel was changed, then a picker
    // was created in the new channel. Both pickers are live in their channels.
    const oldPicker = row({
      _id: "a",
      messageId: "m-old",
      messageChannelId: OLD,
    });
    const newPicker = row({
      _id: "b",
      messageId: "m-new",
      roleId: "role2",
      messageChannelId: CONFIGURED,
    });
    const guild = fakeGuild([
      fakeChannel(OLD, [fakeMessage("m-old")]),
      fakeChannel(CONFIGURED, [fakeMessage("m-new")]),
    ]);
    Model.find.mockResolvedValue([oldPicker, newPicker]);

    await makeService(guild).reconcileConfigs();

    expect(oldPicker.isArchived).toBe(false);
    expect(newPicker.isArchived).toBe(false);
  });

  it("archives a stored mapping whose picker was deleted, with no guard", async () => {
    // Nothing else in the guild resolves, which would trip the legacy guard.
    // A stored channel makes the 10008 a confirmed deletion instead.
    const gone = row({ messageId: "m-gone", messageChannelId: OLD });
    const guild = fakeGuild([fakeChannel(OLD)]);
    Model.find.mockResolvedValue([gone]);

    await makeService(guild).reconcileConfigs();

    expect(gone.isArchived).toBe(true);
    expect(gone.save).toHaveBeenCalledTimes(1);
  });

  it("does not let a resolving stored picker make older rows look deleted-vs-moved", async () => {
    // Legacy row: its picker is in the OLD channel, the setting moved on. The
    // stored row resolving in the new channel says nothing about the legacy
    // one, so the legacy guard must still keep it.
    const legacy = row({ _id: "legacy", messageId: "m-legacy" });
    const stored = row({
      _id: "stored",
      messageId: "m-new",
      roleId: "role2",
      messageChannelId: CONFIGURED,
    });
    const guild = fakeGuild([
      fakeChannel(CONFIGURED, [fakeMessage("m-new")]),
      fakeChannel(OLD, [fakeMessage("m-legacy")]),
    ]);
    Model.find.mockResolvedValue([legacy, stored]);

    await makeService(guild).reconcileConfigs();

    expect(legacy.isArchived).toBe(false);
    expect(stored.isArchived).toBe(false);
  });

  it("still archives a legacy row whose picker is gone once another legacy picker resolves", async () => {
    const live = row({ _id: "live", messageId: "m-live" });
    const gone = row({ _id: "gone", messageId: "m-gone", roleId: "role2" });
    const guild = fakeGuild([fakeChannel(CONFIGURED, [fakeMessage("m-live")])]);
    Model.find.mockResolvedValue([live, gone]);

    await makeService(guild).reconcileConfigs();

    expect(live.isArchived).toBe(false);
    expect(gone.isArchived).toBe(true);
  });

  it("archives only the mappings of a stored channel that was deleted while offline", async () => {
    const inDeleted = row({
      _id: "a",
      messageId: "m-a",
      messageChannelId: OLD,
    });
    const elsewhere = row({
      _id: "b",
      messageId: "m-b",
      roleId: "role2",
      messageChannelId: CONFIGURED,
    });
    // OLD is not in the guild any more: 10003.
    const guild = fakeGuild([fakeChannel(CONFIGURED, [fakeMessage("m-b")])]);
    Model.find.mockResolvedValue([inDeleted, elsewhere]);

    await makeService(guild).reconcileConfigs();

    expect(inDeleted.isArchived).toBe(true);
    expect(elsewhere.isArchived).toBe(false);
  });

  it("fetches each picker channel once, however many mappings live in it", async () => {
    const rows = [
      row({ _id: "a", messageId: "m1", messageChannelId: OLD }),
      row({ _id: "b", messageId: "m2", roleId: "r2", messageChannelId: OLD }),
      row({
        _id: "c",
        messageId: "m3",
        roleId: "r3",
        messageChannelId: CONFIGURED,
      }),
    ];
    const guild = fakeGuild([
      fakeChannel(OLD, [fakeMessage("m1"), fakeMessage("m2")]),
      fakeChannel(CONFIGURED, [fakeMessage("m3")]),
    ]);
    Model.find.mockResolvedValue(rows);

    await makeService(guild).reconcileConfigs();

    const ids = guild.channels.fetch.mock.calls.map((c) => c[0]);
    expect(ids.filter((id) => id === OLD)).toHaveLength(1);
    expect(ids.filter((id) => id === CONFIGURED)).toHaveLength(1);
  });

  it("fetches picker channels through the shared Discord API wrapper", async () => {
    const guild = fakeGuild([fakeChannel(OLD, [fakeMessage("m1")])]);
    Model.find.mockResolvedValue([row({ messageChannelId: OLD })]);

    await makeService(guild).reconcileConfigs();

    expect(mockApi.mock.calls.map((c) => c[1])).toContain(
      `fetch picker channel ${OLD}`,
    );
  });

  it("gives a sibling on the same message the channel its row remembers", async () => {
    const withChannel = row({
      _id: "a",
      messageId: "shared",
      messageChannelId: OLD,
    });
    const sibling = row({ _id: "b", messageId: "shared", roleId: "role2" });
    const guild = fakeGuild([fakeChannel(OLD, [fakeMessage("shared")])]);
    Model.find.mockResolvedValue([withChannel, sibling]);

    await makeService(guild).reconcileConfigs();

    expect(guild.channels.fetch).not.toHaveBeenCalledWith(
      CONFIGURED,
      expect.anything(),
    );
    expect(sibling.isArchived).toBe(false);
  });

  it("does not archive a stored mapping on a transient message error", async () => {
    const stored = row({ messageChannelId: OLD });
    const old = fakeChannel(OLD);
    old.messages.fetch.mockRejectedValue(new Error("network"));
    const guild = fakeGuild([old]);
    Model.find.mockResolvedValue([stored]);

    await makeService(guild).reconcileConfigs();

    expect(stored.isArchived).toBe(false);
  });

  it("reconciles a stored mapping even when no channel is configured", async () => {
    const stored = row({ messageChannelId: OLD });
    const guild = fakeGuild([fakeChannel(OLD, [fakeMessage("m1")])]);
    Model.find.mockResolvedValue([stored]);

    await makeService(guild, "").reconcileConfigs();

    expect(guild.channels.fetch).toHaveBeenCalledWith(OLD, { force: true });
    expect(stored.isArchived).toBe(false);
  });
});

describe("handleChannelDelete with a remembered picker channel", () => {
  const deleted = (id: string) => ({ id, guild: { id: "g1" } }) as never;

  it("matches mappings stored in the deleted channel, and legacy rows only for the configured one", async () => {
    Model.find.mockResolvedValue([]);
    const service = makeService(fakeGuild([]));

    await service.handleChannelDelete(deleted(OLD));
    expect(Model.find).toHaveBeenLastCalledWith({
      guildId: "g1",
      isArchived: false,
      $or: [{ messageChannelId: OLD }, { channelId: OLD }, { categoryId: OLD }],
    });

    await service.handleChannelDelete(deleted(CONFIGURED));
    expect(Model.find).toHaveBeenLastCalledWith({
      guildId: "g1",
      isArchived: false,
      $or: [
        { messageChannelId: CONFIGURED },
        { messageChannelId: { $in: [null, ""] } },
        { channelId: CONFIGURED },
        { categoryId: CONFIGURED },
      ],
    });
  });

  it("also archives unstamped rows that share a deleted picker with a stamped one", async () => {
    // A legacy picker topped up after #1207: one row stamped, one not. Only the
    // stamped row matches the channel; the picker is gone for both.
    const stamped = row({
      _id: "stamped",
      messageId: "shared",
      messageChannelId: OLD,
    });
    const sibling = row({ _id: "sibling", messageId: "shared", roleId: "r2" });
    Model.find.mockResolvedValueOnce([stamped]);
    Model.find.mockResolvedValueOnce([stamped, sibling]);

    await makeService(fakeGuild([])).handleChannelDelete(deleted(OLD));

    expect(Model.find).toHaveBeenLastCalledWith({
      guildId: "g1",
      isArchived: false,
      messageId: { $in: ["shared"] },
    });
    expect(stamped.isArchived).toBe(true);
    expect(sibling.isArchived).toBe(true);
    expect(sibling.save).toHaveBeenCalledTimes(1);
    expect(stamped.save).toHaveBeenCalledTimes(1);
  });

  it("archives the matched mappings", async () => {
    const stored = row({ messageChannelId: OLD });
    const legacy = row({ _id: "legacy", roleId: "role2" });
    Model.find.mockResolvedValue([stored, legacy]);

    await makeService(fakeGuild([])).handleChannelDelete(deleted(OLD));

    expect(stored.isArchived).toBe(true);
    expect(legacy.isArchived).toBe(true);
  });
});

describe("deleting a picker uses its own channel", () => {
  it("deleteReactionRoleGroup removes the original picker from its own channel", async () => {
    const picker = fakeMessage("m1");
    const old = fakeChannel(OLD, [picker]);
    const configured = fakeChannel(CONFIGURED);
    const guild = fakeGuild([old, configured]);
    Model.find.mockResolvedValue([
      row({ groupId: "g", messageChannelId: OLD, autoCreated: true }),
      row({
        _id: "b",
        roleId: "role2",
        groupId: "g",
        messageChannelId: OLD,
        autoCreated: true,
      }),
    ]);

    const result = await makeService(guild).deleteReactionRoleGroup("g1", "g");

    expect(result.success).toBe(true);
    expect(picker.delete).toHaveBeenCalledTimes(1);
    expect(guild.channels.fetch).toHaveBeenCalledWith(OLD);
    expect(configured.messages.fetch).not.toHaveBeenCalled();
  });

  it("deleteReactionRoleGroup takes the channel from whichever row remembers it", async () => {
    const picker = fakeMessage("m1");
    const guild = fakeGuild([fakeChannel(OLD, [picker])]);
    Model.find.mockResolvedValue([
      row({ groupId: "g", autoCreated: true }),
      row({
        _id: "b",
        roleId: "role2",
        groupId: "g",
        messageChannelId: OLD,
        autoCreated: true,
      }),
    ]);

    await makeService(guild).deleteReactionRoleGroup("g1", "g");

    expect(picker.delete).toHaveBeenCalledTimes(1);
  });

  it("deleteReactionRoleGroup still uses the configured channel for a legacy group", async () => {
    const picker = fakeMessage("m1");
    const guild = fakeGuild([fakeChannel(CONFIGURED, [picker])]);
    Model.find.mockResolvedValue([
      row({ groupId: "g", autoCreated: true }),
      row({ _id: "b", roleId: "role2", groupId: "g", autoCreated: true }),
    ]);

    await makeService(guild).deleteReactionRoleGroup("g1", "g");

    expect(picker.delete).toHaveBeenCalledTimes(1);
  });

  const ID = "507f1f77bcf86cd799439011";

  it("deleteReactionRole removes a managed picker from its own channel", async () => {
    const picker = fakeMessage("m1");
    const guild = fakeGuild([fakeChannel(OLD, [picker])]);
    Model.findOne.mockResolvedValue(
      row({ messageChannelId: OLD, autoCreated: true }),
    );

    const result = await makeService(guild).deleteReactionRole("g1", ID);

    expect(result.success).toBe(true);
    expect(picker.delete).toHaveBeenCalledTimes(1);
  });

  it("deleteReactionRole falls back to the configured channel for a legacy row", async () => {
    const picker = fakeMessage("m1");
    const guild = fakeGuild([fakeChannel(CONFIGURED, [picker])]);
    // First findOne is the row itself; the sibling lookup finds nothing.
    Model.findOne
      .mockResolvedValueOnce(row({ autoCreated: true }))
      .mockResolvedValue(null);

    await makeService(guild).deleteReactionRole("g1", ID);

    expect(picker.delete).toHaveBeenCalledTimes(1);
  });

  it("deleteReactionRole finds the channel a sibling row remembers for a legacy row", async () => {
    const picker = fakeMessage("m1");
    const guild = fakeGuild([fakeChannel(OLD, [picker])]);
    Model.findOne
      .mockResolvedValueOnce(row({ autoCreated: true }))
      .mockResolvedValueOnce(row({ _id: "sib", messageChannelId: OLD }));

    await makeService(guild).deleteReactionRole("g1", ID);

    expect(picker.delete).toHaveBeenCalledTimes(1);
  });

  it("archiveReactionRole removes the picker from its own channel", async () => {
    const picker = fakeMessage("m1");
    const guild = fakeGuild([fakeChannel(OLD, [picker])]);
    Model.findOne.mockResolvedValue(
      row({ messageChannelId: OLD, autoCreated: true }),
    );

    const result = await makeService(guild).archiveReactionRole("g1", ID);

    expect(result.success).toBe(true);
    expect(picker.delete).toHaveBeenCalledTimes(1);
  });

  it("removeReactionRoleMapping tidies the bot reaction on the picker in its own channel", async () => {
    const picker = fakeMessage("m1");
    const botReaction = {
      emoji: { id: null, name: "🎨" },
      users: {
        remove: jest.fn<() => Promise<unknown>>().mockResolvedValue({}),
      },
    };
    picker.reactions = {
      cache: {
        some: () => true,
        find: ((pred: (r: unknown) => boolean) =>
          pred(botReaction) ? botReaction : undefined) as never,
      },
    };
    const guild = fakeGuild([fakeChannel(OLD, [picker])]);
    Model.findOne.mockResolvedValue(
      row({ messageChannelId: OLD, emoji: "🎨", autoCreated: false }),
    );

    const result = await makeService(guild).removeReactionRoleMapping(
      "g1",
      "m1",
      "🎨",
    );

    expect(result.success).toBe(true);
    expect(botReaction.users.remove).toHaveBeenCalledWith("bot1");
  });
});

describe("unarchiveReactionRole", () => {
  it("reposts in the configured channel and remembers that channel", async () => {
    const posted = fakeMessage("reposted");
    const configured = fakeChannel(CONFIGURED, [], posted);
    const guild = fakeGuild([configured, fakeChannel(OLD)]);
    const archived = row({
      messageChannelId: OLD,
      isArchived: true,
      autoCreated: true,
    });
    Model.findOne.mockResolvedValue(archived);

    const result = await makeService(guild).unarchiveReactionRole(
      "g1",
      "507f1f77bcf86cd799439011",
    );

    expect(result.success).toBe(true);
    expect(configured.send).toHaveBeenCalledTimes(1);
    expect(archived.messageId).toBe("reposted");
    // Without this the row would point at a message in a channel it is not in,
    // and the next reconcile would archive it as a confirmed deletion.
    expect((archived as RowOpts).messageChannelId).toBe(CONFIGURED);
    expect(archived.save).toHaveBeenCalled();
  });
});

describe("new mappings remember their picker's channel", () => {
  it("createReactionRole stamps the channel it posted in", async () => {
    const posted = fakeMessage("created");
    const configured = fakeChannel(CONFIGURED, [], posted);
    const guild = fakeGuild([configured]);
    Model.findOne.mockResolvedValue(null);

    const result = await makeService(guild).createReactionRole(
      "g1",
      "Gamer",
      "🎮",
      { createChannel: false },
    );

    expect(result.success).toBe(true);
    expect(constructed[0]).toMatchObject({
      messageId: "created",
      messageChannelId: CONFIGURED,
    });
  });

  it("bindReactionRole stamps the channel of the fresh picker it posted", async () => {
    const posted = fakeMessage("bound");
    const guild = fakeGuild([fakeChannel(CONFIGURED, [], posted)]);
    Model.findOne.mockResolvedValue(null);

    const result = await makeService(guild).bindReactionRole(
      "g1",
      "role1",
      "🎨",
    );

    expect(result.success).toBe(true);
    expect(constructed[0]).toMatchObject({
      messageId: "bound",
      messageChannelId: CONFIGURED,
    });
  });

  it("bindReactionRole adds to an existing picker in the channel its mappings remember", async () => {
    const existing = fakeMessage("picker");
    const old = fakeChannel(OLD, [existing]);
    const configured = fakeChannel(CONFIGURED);
    const guild = fakeGuild([old, configured]);
    // 1st findOne: the sibling carrying the channel. 2nd: duplicate check.
    Model.findOne
      .mockResolvedValueOnce(row({ messageChannelId: OLD }))
      .mockResolvedValueOnce(null);

    const result = await makeService(guild).bindReactionRole(
      "g1",
      "role2",
      "🎨",
      { messageId: "picker" },
    );

    expect(result.success).toBe(true);
    expect(configured.messages.fetch).not.toHaveBeenCalled();
    expect(existing.react).toHaveBeenCalledWith("🎨");
    expect(constructed[0]).toMatchObject({
      messageId: "picker",
      messageChannelId: OLD,
    });
  });

  it("bindReactionRole adds to a legacy picker in the configured channel and stamps it", async () => {
    const existing = fakeMessage("picker");
    const guild = fakeGuild([fakeChannel(CONFIGURED, [existing])]);
    Model.findOne.mockResolvedValue(null);

    const result = await makeService(guild).bindReactionRole(
      "g1",
      "role2",
      "🎨",
      { messageId: "picker" },
    );

    expect(result.success).toBe(true);
    expect(constructed[0]).toMatchObject({ messageChannelId: CONFIGURED });
  });
});
