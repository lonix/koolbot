import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { Client } from "discord.js";

const mockApi = jest.fn(async (fn: () => Promise<unknown>) => fn());
const mockGetString = jest.fn<(k: string, d: string) => Promise<string>>();
const model = {
  find: jest.fn<() => Promise<unknown[]>>(),
  insertMany: jest.fn<() => Promise<unknown>>(),
  updateMany: jest.fn<() => Promise<unknown>>(),
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
      validateRoleAssignable: async () => ({ ok: true }),
    }),
  },
}));
jest.unstable_mockModule("../../src/models/reaction-role-config.js", () => ({
  ReactionRoleConfig: model,
  REACTION_ROLE_MODES: ["toggle", "sticky", "unique"],
}));

const { ReactionRoleGroupService, parseRoleColour } =
  await import("../../src/services/reaction-role-group-service.js");

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
  };
  const client = { guilds: { fetch: jest.fn(async () => guild) } };
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
      colour: 0x336699,
    });
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
