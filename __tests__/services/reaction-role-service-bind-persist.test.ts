import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { Client } from "discord.js";

// The rest of the reaction-role suites rely on the global mongoose mock, under
// which `ReactionRoleConfig` is a non-constructible plain object — so those
// tests can only assert branch behaviour up to the DB write. Here we use the
// ESM-correct `jest.unstable_mockModule` + dynamic import so the model is a
// real constructor with a spy-able `save`, letting us assert that a successful
// bind actually persists the expected mapping payload (issue #813 review).

const mockSave = jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined);
const constructed: Array<Record<string, unknown>> = [];

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
  // reaction-role-service now transitively imports CommandManager, which pulls
  // in the named `isDebugMode` export — the native ESM mock must provide it.
  isDebugMode: jest.fn(() => false),
}));

jest.unstable_mockModule("../../src/models/reaction-role-config.js", () => {
  class ReactionRoleConfig {
    constructor(data: Record<string, unknown>) {
      Object.assign(this, data);
      constructed.push(data);
    }
    save = mockSave;
    static findOne = jest.fn();
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

const Model = ReactionRoleConfig as unknown as { findOne: jest.Mock };

function makeService(guild: unknown) {
  const client = {
    guilds: {
      fetch: jest.fn<() => Promise<unknown>>().mockResolvedValue(guild),
    },
    user: { id: "bot1" },
  } as unknown as Client;
  const service = ReactionRoleService.getInstance(client);
  (service as never)["configService"] = {
    getString: jest.fn<() => Promise<string>>().mockResolvedValue("chan1"),
    getBoolean: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
    getNumber: jest.fn(),
  };
  return service;
}

function buildGuild() {
  const newMessage = {
    id: "newmsg",
    react: jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
    delete: jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
  };
  const botMember = {
    permissions: { has: jest.fn().mockReturnValue(true) },
    roles: { highest: { comparePositionTo: jest.fn().mockReturnValue(1) } },
  };
  const messageChannel = {
    isTextBased: () => true,
    send: jest.fn<() => Promise<unknown>>().mockResolvedValue(newMessage),
    messages: { fetch: jest.fn() },
  };
  const guild = {
    id: "guild1",
    members: {
      me: botMember,
      fetchMe: jest.fn<() => Promise<unknown>>().mockResolvedValue(botMember),
    },
    roles: {
      everyone: { id: "guild1" },
      fetch: jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue({ id: "role1", name: "Gamer", managed: false }),
    },
    channels: {
      fetch: jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(messageChannel),
    },
  };
  return { guild, newMessage };
}

beforeEach(() => {
  jest.clearAllMocks();
  constructed.length = 0;
  Model.findOne = jest.fn();
  (ReactionRoleService as unknown as { instance?: unknown }).instance =
    undefined;
});

describe("bindReactionRole persistence", () => {
  it("succeeds and persists a bound (autoCreated=false) mapping", async () => {
    const { guild, newMessage } = buildGuild();
    Model.findOne.mockResolvedValue(null);
    const service = makeService(guild);

    const result = await service.bindReactionRole("guild1", "<@&role1>", "🎨");

    expect(result.success).toBe(true);
    expect(result.messageId).toBe("newmsg");
    expect(newMessage.react).toHaveBeenCalledWith("🎨");
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(constructed).toHaveLength(1);
    expect(constructed[0]).toMatchObject({
      guildId: "guild1",
      messageId: "newmsg",
      roleId: "role1",
      emoji: "🎨",
      roleName: "Gamer",
      autoCreated: false,
    });
    // Bound mappings own no category/channel.
    expect(constructed[0].categoryId).toBeUndefined();
    expect(constructed[0].channelId).toBeUndefined();
  });
});
