import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { Client } from "discord.js";

const mockApi = jest.fn(async (fn: () => Promise<unknown>) => fn());
const mockValidate = jest.fn<(...a: unknown[]) => Promise<{ ok: true }>>(
  async () => ({ ok: true }),
);
const mockGetString = jest.fn<(k: string, d: string) => Promise<string>>();
const model = {
  find: jest.fn<() => Promise<unknown[]>>(),
  insertMany: jest.fn<() => Promise<unknown>>(),
  updateMany: jest.fn<() => Promise<unknown>>(),
  deleteMany: jest.fn<() => Promise<unknown>>(),
};

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));
jest.unstable_mockModule("../../src/services/command-manager.js", () => ({
  CommandManager: { getInstance: () => ({ makeDiscordApiCall: mockApi }) },
}));
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: { getInstance: () => ({ getString: mockGetString }) },
}));
jest.unstable_mockModule("../../src/services/reaction-role-service.js", () => ({
  ReactionRoleService: {
    getInstance: () => ({
      normalizeEmoji: (e: string) => e,
      validateRoleAssignable: mockValidate,
    }),
  },
}));
jest.unstable_mockModule("../../src/models/reaction-role-config.js", () => ({
  ReactionRoleConfig: model,
  REACTION_ROLE_MODES: ["toggle", "sticky", "unique"],
}));

const { ReactionRoleGroupService, parseRoleColour } =
  await import("../../src/services/reaction-role-group-service.js");

// Bot sits at position 10; a role at or above it is not assignable.
const botMember = () => ({
  id: "bot",
  roles: {
    highest: {
      comparePositionTo: (r: { position?: number }) => 10 - (r.position ?? 0),
    },
  },
});

function setup(existingRoles: Array<{ id: string; name: string }>) {
  const created: Array<Record<string, unknown>> = [];
  const del = jest.fn(async () => undefined);
  const message = {
    id: "m1",
    react: jest.fn(async () => undefined),
    edit: jest.fn(async () => message),
    delete: jest.fn(async () => undefined),
  };
  const channel = {
    isTextBased: () => true,
    send: jest.fn(async () => message),
    messages: { fetch: jest.fn(async () => message) },
  };
  const roles = new Map(
    existingRoles.map((r) => [r.id, { ...r, managed: false }]),
  );
  const guild = {
    roles: {
      everyone: { id: "everyone" },
      fetch: jest.fn(async () => roles),
      create: jest.fn(async (opts: Record<string, unknown>) => {
        created.push(opts);
        return {
          id: `new${created.length}`,
          name: opts.name,
          delete: del,
        };
      }),
    },
    channels: { fetch: jest.fn(async () => channel) },
    members: { me: botMember(), fetchMe: jest.fn() },
  };
  const client = {
    user: { id: "bot" },
    guilds: { fetch: jest.fn(async () => guild) },
  };
  return {
    client: client as unknown as Client,
    created,
    message,
    channel,
    guild,
    del,
  };
}

const entries = [
  { roleName: "Europe", emoji: "🇪🇺" },
  { roleName: "Asia", emoji: "🌏" },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockValidate.mockImplementation(async () => ({ ok: true }));
  (ReactionRoleGroupService as unknown as { instance?: unknown }).instance =
    undefined;
  mockGetString.mockImplementation(async (k, d) =>
    k === "reactionroles.message_channel_id"
      ? "chan"
      : k === "reactionroles.group_role_colour"
        ? "#336699"
        : d,
  );
  model.find.mockResolvedValue([]);
  model.insertMany.mockResolvedValue([]);
  model.updateMany.mockResolvedValue({});
  model.deleteMany.mockResolvedValue({});
});

describe("parseRoleColour", () => {
  it("parses valid hex and ignores junk", () => {
    expect(parseRoleColour("#336699")).toBe(0x336699);
    expect(parseRoleColour("336699")).toBe(0x336699);
    expect(parseRoleColour("")).toBeUndefined();
    expect(parseRoleColour("red")).toBeUndefined();
  });
});

describe("ReactionRoleGroupService.provisionGroup", () => {
  it("creates permissionless roles, reuses same-name roles and posts one message", async () => {
    const s = setup([{ id: "old1", name: "europe" }]);
    const svc = ReactionRoleGroupService.getInstance(s.client);
    const r = await svc.provisionGroup("g1", "Region", entries, "unique");
    expect(r.success).toBe(true);
    expect(s.created).toHaveLength(1);
    expect(s.created[0]).toMatchObject({
      name: "Asia",
      permissions: [],
      mentionable: false,
      colors: { primaryColor: 0x336699 },
    });
    expect(s.created[0]).not.toHaveProperty("colour");
    expect(r.reusedRoles).toEqual(["old1"]);
    expect(s.channel.send).toHaveBeenCalledTimes(1);
    expect(s.message.react).toHaveBeenCalledTimes(2);
    const docs = (
      model.insertMany.mock.calls[0] as unknown as [
        Array<Record<string, unknown>>,
      ]
    )[0];
    expect(docs.find((d) => d.roleId === "old1")?.autoCreated).toBe(false);
    expect(docs.find((d) => d.roleName === "Asia")?.autoCreated).toBe(true);
    expect(docs[0]).toMatchObject({
      groupId: "m1",
      groupKey: "region",
      mode: "unique",
    });
  });

  it("fetches the bot member through the API wrapper when it is not cached", async () => {
    const s = setup([{ id: "old1", name: "europe" }]);
    const me = botMember();
    const fetchMe = jest.fn(async () => me);
    (s.guild as unknown as Record<string, unknown>).members = {
      me: null,
      fetchMe,
    };
    const svc = ReactionRoleGroupService.getInstance(s.client);
    const r = await svc.provisionGroup("g1", "Region", entries, "unique");
    expect(r.success).toBe(true);
    expect(fetchMe).toHaveBeenCalledTimes(1);
    expect(mockApi.mock.calls.map((c) => c[1])).toContain("fetch bot member");
    expect(mockValidate).toHaveBeenCalledWith(s.guild, expect.anything(), me);
  });

  it("is a no-op when everything is already present", async () => {
    const s = setup([
      { id: "r1", name: "Europe" },
      { id: "r2", name: "Asia" },
    ]);
    model.find.mockResolvedValue([
      {
        roleId: "r1",
        emoji: "🇪🇺",
        roleName: "Europe",
        messageId: "m1",
        groupId: "m1",
        mode: "unique",
      },
      {
        roleId: "r2",
        emoji: "🌏",
        roleName: "Asia",
        messageId: "m1",
        groupId: "m1",
        mode: "unique",
      },
    ]);
    const svc = ReactionRoleGroupService.getInstance(s.client);
    const r = await svc.provisionGroup("g1", "Region", entries);
    expect(r).toMatchObject({
      success: true,
      addedEntries: 0,
      skippedEntries: 2,
    });
    expect(s.guild.roles.create).not.toHaveBeenCalled();
    expect(s.channel.send).not.toHaveBeenCalled();
    expect(model.insertMany).not.toHaveBeenCalled();
  });

  it("adds only missing options by editing the existing message", async () => {
    const s = setup([{ id: "r1", name: "Europe" }]);
    model.find.mockResolvedValue([
      {
        roleId: "r1",
        emoji: "🇪🇺",
        roleName: "Europe",
        messageId: "m1",
        groupId: "m1",
        mode: "unique",
      },
    ]);
    const svc = ReactionRoleGroupService.getInstance(s.client);
    const r = await svc.provisionGroup("g1", "Region", entries);
    expect(r).toMatchObject({
      success: true,
      addedEntries: 1,
      skippedEntries: 1,
    });
    expect(s.channel.send).not.toHaveBeenCalled();
    expect(s.message.edit).toHaveBeenCalledTimes(1);
    expect(s.message.react).toHaveBeenCalledTimes(1);
  });

  it("rolls back created roles and the posted message on failure", async () => {
    const s = setup([]);
    model.insertMany.mockRejectedValue(new Error("db down"));
    const svc = ReactionRoleGroupService.getInstance(s.client);
    const r = await svc.provisionGroup("g1", "Region", entries);
    expect(r.success).toBe(false);
    expect(s.message.delete).toHaveBeenCalled();
    expect(s.del).toHaveBeenCalledTimes(2);
    // rollback cleanup is retried via the shared Discord API wrapper
    const labels = mockApi.mock.calls.map((c) => String(c[1]));
    expect(labels).toContain("delete group message m1");
    expect(
      labels.filter((l) => l.startsWith("delete group role")),
    ).toHaveLength(2);
  });

  it("ignores archived rows of earlier pickers and generates a fresh group", async () => {
    const s = setup([{ id: "old1", name: "Europe" }]);
    model.find.mockImplementation(async (q: unknown) =>
      (q as { isArchived?: boolean }).isArchived === true
        ? [{ roleId: "old1", autoCreated: true, messageId: "dead" }]
        : [],
    );
    const svc = ReactionRoleGroupService.getInstance(s.client);
    const r = await svc.provisionGroup("g1", "Region", entries);
    expect(r.success).toBe(true);
    expect(s.channel.send).toHaveBeenCalledTimes(1);
    expect(model.updateMany).not.toHaveBeenCalled();
    const docs = (
      model.insertMany.mock.calls[0] as unknown as [
        Array<Record<string, unknown>>,
      ]
    )[0];
    // reused role is never re-owned from an archived incarnation
    expect(docs.find((d) => d.roleId === "old1")?.autoCreated).toBe(false);
    expect(docs.every((d) => d.groupId === "m1")).toBe(true);
  });

  it("serialises overlapping runs for the same guild", async () => {
    const s = setup([]);
    // Second run must see the first run's rows, as it would in the database.
    let rows: unknown[] = [];
    model.find.mockImplementation(async () => rows);
    model.insertMany.mockImplementation(async (docs: unknown) => {
      rows = docs as unknown[];
      return docs;
    });
    s.guild.roles.fetch.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return new Map(
        s.created.map((c, i) => [
          `new${i + 1}`,
          { id: `new${i + 1}`, name: c.name, managed: false },
        ]),
      );
    });
    const svc = ReactionRoleGroupService.getInstance(s.client);
    const [a, b] = await Promise.all([
      svc.provisionGroup("g1", "Region", entries),
      svc.provisionGroup("g1", "Region", entries),
    ]);
    expect(a.addedEntries).toBe(2);
    expect(b.addedEntries).toBe(0);
    expect(s.guild.roles.create).toHaveBeenCalledTimes(2);
    expect(s.channel.send).toHaveBeenCalledTimes(1);
  });

  const liveRow = {
    roleId: "r1",
    emoji: "🇪🇺",
    roleName: "Europe",
    messageId: "m1",
    groupId: "m1",
    mode: "unique",
  };

  it("stops without changes when the picker fetch fails transiently", async () => {
    const s = setup([{ id: "r1", name: "Europe" }]);
    model.find.mockResolvedValue([liveRow]);
    s.channel.messages.fetch.mockRejectedValue(
      Object.assign(new Error("Missing Access"), { code: 50001 }),
    );
    const svc = ReactionRoleGroupService.getInstance(s.client);
    const r = await svc.provisionGroup("g1", "Region", entries);
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/try again/i);
    expect(model.updateMany).not.toHaveBeenCalled();
    expect(s.channel.send).not.toHaveBeenCalled();
    expect(s.guild.roles.create).not.toHaveBeenCalled();
    expect(model.insertMany).not.toHaveBeenCalled();
  });

  it("stops without changes when the picker message was deleted (10008)", async () => {
    const s = setup([]);
    model.find.mockResolvedValue([liveRow]);
    s.channel.messages.fetch.mockRejectedValue(
      Object.assign(new Error("Unknown Message"), { code: 10008 }),
    );
    const svc = ReactionRoleGroupService.getInstance(s.client);
    const r = await svc.provisionGroup("g1", "Region", entries);
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/deleted/);
    expect(r.message).toMatch(/Reaction Roles page/);
    expect(model.updateMany).not.toHaveBeenCalled();
    expect(model.insertMany).not.toHaveBeenCalled();
    expect(model.deleteMany).not.toHaveBeenCalled();
    expect(s.channel.send).not.toHaveBeenCalled();
    expect(s.guild.roles.create).not.toHaveBeenCalled();
    expect(s.guild.roles.fetch).not.toHaveBeenCalled();
  });

  it("routes guild and channel fetches through the API wrapper", async () => {
    const s = setup([]);
    const svc = ReactionRoleGroupService.getInstance(s.client);
    await svc.provisionGroup("g1", "Region", entries);
    const labels = mockApi.mock.calls.map((c) => (c as unknown[])[1]);
    expect(labels).toEqual(
      expect.arrayContaining(["fetch guild", "fetch group channel"]),
    );
  });

  it("reports a transient channel failure as an error, not 'not found'", async () => {
    const s = setup([]);
    s.guild.channels.fetch.mockRejectedValue(new Error("boom"));
    const svc = ReactionRoleGroupService.getInstance(s.client);
    const r = await svc.provisionGroup("g1", "Region", entries);
    expect(r.success).toBe(false);
    expect(r.message).not.toMatch(/not found/i);
  });

  it("restores the embed and removes added reactions when a top-up fails", async () => {
    const s = setup([{ id: "r1", name: "Europe" }]);
    const reactionRemove = jest.fn(async () => undefined);
    const botReactionRemove = jest.fn(async () => undefined);
    Object.assign(s.message, {
      embeds: [{ data: { title: "Region" } }],
      reactions: {
        resolve: jest.fn(() => ({
          remove: reactionRemove,
          users: { remove: botReactionRemove },
        })),
      },
    });
    model.find.mockResolvedValue([liveRow]);
    model.insertMany.mockRejectedValue(new Error("db down"));
    const svc = ReactionRoleGroupService.getInstance(s.client);
    const r = await svc.provisionGroup("g1", "Region", entries);
    expect(r.success).toBe(false);
    // edited once to add the option, then restored to the prior embed
    expect(s.message.edit).toHaveBeenCalledTimes(2);
    expect(s.message.react).toHaveBeenCalledTimes(1);
    // only the bot's own reaction goes; members' reactions are untouched
    expect(botReactionRemove).toHaveBeenCalledTimes(1);
    expect(botReactionRemove).toHaveBeenCalledWith("bot");
    expect(reactionRemove).not.toHaveBeenCalled();
    const labels = mockApi.mock.calls.map((c) => String(c[1]));
    expect(labels).toContain("restore group message m1");
    expect(labels.some((l) => l.startsWith("remove reaction"))).toBe(true);
    expect(s.message.delete).not.toHaveBeenCalled();
  });

  it("tells the admin to check the picker by hand when a top-up edit times out", async () => {
    const s = setup([{ id: "r1", name: "Europe" }]);
    model.find.mockResolvedValue([liveRow]);
    s.message.edit.mockRejectedValue(
      new Error("Discord API timeout for edit group message m1"),
    );
    const svc = ReactionRoleGroupService.getInstance(s.client);
    const r = await svc.provisionGroup("g1", "Region", entries);
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/picker message and its reactions by hand/);
  });

  it("drops retired rows holding an emoji being re-added on a top-up", async () => {
    // handleRoleDelete archived the Asia row; the picker and Europe stay live.
    const s = setup([{ id: "r1", name: "Europe" }]);
    model.find.mockResolvedValue([liveRow]);
    const order: string[] = [];
    model.deleteMany.mockImplementation(async () => {
      order.push("deleteMany");
      return {};
    });
    model.insertMany.mockImplementation(async () => {
      order.push("insertMany");
      return [];
    });
    const svc = ReactionRoleGroupService.getInstance(s.client);
    const r = await svc.provisionGroup("g1", "Region", entries);
    expect(r).toMatchObject({ success: true, addedEntries: 1 });
    expect(s.channel.send).not.toHaveBeenCalled();
    expect(model.deleteMany).toHaveBeenCalledWith({
      guildId: "g1",
      messageId: "m1",
      emoji: { $in: ["🌏"] },
      isArchived: true,
    });
    expect(order).toEqual(["deleteMany", "insertMany"]);
  });

  it("removes this run's mappings when insertMany fails on a fresh group", async () => {
    const s = setup([{ id: "r1", name: "Europe" }]);
    model.insertMany.mockRejectedValue(new Error("partial write"));
    const svc = ReactionRoleGroupService.getInstance(s.client);
    const r = await svc.provisionGroup("g1", "Region", entries);
    expect(r.success).toBe(false);
    expect(model.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "g1",
        messageId: "m1",
        isArchived: false,
      }),
    );
    expect(model.updateMany).not.toHaveBeenCalled();
    expect(s.message.delete).toHaveBeenCalled();
  });

  it("does not retry role creation on timeout and tells the admin to check", async () => {
    const s = setup([]);
    s.guild.roles.create.mockRejectedValueOnce(
      new Error("Discord API timeout for create role Europe; not retried"),
    );
    const svc = ReactionRoleGroupService.getInstance(s.client);
    const r = await svc.provisionGroup("g1", "Region", entries);
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/Roles list/);
    expect(s.guild.roles.create).toHaveBeenCalledTimes(1);
    expect(s.channel.send).not.toHaveBeenCalled();
    const create = mockApi.mock.calls.find((c) =>
      String(c[1]).startsWith("create role"),
    ) as unknown[];
    expect(create.slice(2)).toEqual([30000, 3, false]);
  });

  it("does not retry the picker post on timeout and rolls back only known roles", async () => {
    const s = setup([]);
    s.channel.send.mockRejectedValueOnce(
      new Error("Discord API timeout for post group message; not retried"),
    );
    const svc = ReactionRoleGroupService.getInstance(s.client);
    const r = await svc.provisionGroup("g1", "Region", entries);
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/channel for a half-created role or message/);
    expect(s.channel.send).toHaveBeenCalledTimes(1);
    expect(s.del).toHaveBeenCalledTimes(2);
    expect(s.message.delete).not.toHaveBeenCalled();
    const post = mockApi.mock.calls.find(
      (c) => c[1] === "post group message",
    ) as unknown[];
    expect(post.slice(2)).toEqual([30000, 3, false]);
  });

  it("reports an unassignable same-name role instead of creating a duplicate", async () => {
    const s = setup([]);
    const roles = new Map<string, unknown>([
      ["int1", { id: "int1", name: "Europe", managed: true }],
    ]);
    s.guild.roles.fetch.mockResolvedValue(roles as never);
    mockValidate.mockImplementation(async (...a: unknown[]) =>
      (a[1] as { managed: boolean }).managed
        ? ({ ok: false, message: "Europe is managed" } as never)
        : { ok: true },
    );
    const svc = ReactionRoleGroupService.getInstance(s.client);
    const r = await svc.provisionGroup("g1", "Region", entries);
    expect(r).toMatchObject({ success: false, message: "Europe is managed" });
    expect(s.guild.roles.create).not.toHaveBeenCalled();
    expect(s.channel.send).not.toHaveBeenCalled();
  });

  it("prefers an assignable same-name role over a managed one", async () => {
    const s = setup([]);
    const roles = new Map<string, unknown>([
      ["int1", { id: "int1", name: "Europe", managed: true }],
      ["ok1", { id: "ok1", name: "europe", managed: false }],
    ]);
    s.guild.roles.fetch.mockResolvedValue(roles as never);
    const svc = ReactionRoleGroupService.getInstance(s.client);
    const r = await svc.provisionGroup("g1", "Region", entries);
    expect(r.success).toBe(true);
    expect(r.reusedRoles).toEqual(["ok1"]);
  });

  it("reuses the assignable same-name role when another sits above the bot", async () => {
    const s = setup([]);
    const roles = new Map<string, unknown>([
      ["high", { id: "high", name: "Europe", managed: false, position: 20 }],
      ["low", { id: "low", name: "europe", managed: false, position: 3 }],
    ]);
    s.guild.roles.fetch.mockResolvedValue(roles as never);
    const svc = ReactionRoleGroupService.getInstance(s.client);
    const r = await svc.provisionGroup("g1", "Region", entries);
    expect(r.success).toBe(true);
    expect(r.reusedRoles).toEqual(["low"]);
    expect(s.created.map((c) => c.name)).toEqual(["Asia"]);
  });

  it("passes an explicit null bot member and does not refetch outside the wrapper", async () => {
    const s = setup([{ id: "old1", name: "europe" }]);
    const fetchMe = jest.fn(async () => {
      throw new Error("down");
    });
    (s.guild as unknown as Record<string, unknown>).members = {
      me: null,
      fetchMe,
    };
    mockValidate.mockImplementation(async (...a: unknown[]) =>
      a[2] === null
        ? ({ ok: false, message: "couldn't resolve my membership" } as never)
        : { ok: true },
    );
    const svc = ReactionRoleGroupService.getInstance(s.client);
    const r = await svc.provisionGroup("g1", "Region", entries);
    expect(r.success).toBe(false);
    expect(mockValidate).toHaveBeenCalledWith(s.guild, expect.anything(), null);
    expect(fetchMe).toHaveBeenCalledTimes(1);
    expect(s.guild.roles.create).not.toHaveBeenCalled();
  });

  it("rejects a malformed non-empty role colour instead of ignoring it", async () => {
    const s = setup([]);
    mockGetString.mockImplementation(async (k, d) =>
      k === "reactionroles.message_channel_id"
        ? "chan"
        : k === "reactionroles.group_role_colour"
          ? "teal"
          : d,
    );
    const svc = ReactionRoleGroupService.getInstance(s.client);
    const r = await svc.provisionGroup("g1", "Region", entries);
    expect(r.success).toBe(false);
    expect(r.message).toContain("reactionroles.group_role_colour");
    expect(s.created).toHaveLength(0);
    expect(s.channel.send).not.toHaveBeenCalled();
  });

  it("validates input before touching Discord", async () => {
    const s = setup([]);
    const svc = ReactionRoleGroupService.getInstance(s.client);
    const dup = await svc.provisionGroup("g1", "X", [
      { roleName: "A", emoji: "1" },
      { roleName: "a", emoji: "2" },
    ]);
    expect(dup.success).toBe(false);
    expect(s.guild.roles.create).not.toHaveBeenCalled();
  });
});
