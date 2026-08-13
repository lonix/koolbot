import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { Client, Role, Message } from "discord.js";

jest.mock("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../../src/models/reaction-role-config.js");

import { ReactionRoleService } from "../../src/services/reaction-role-service.js";
import { ReactionRoleConfig } from "../../src/models/reaction-role-config.js";

const find = ((ReactionRoleConfig as unknown as { find: jest.Mock }).find =
  jest.fn());

// One shared client for every test. reconcileConfigs constructs the real
// CommandManager (and, transitively, PermissionsService) via getInstance, both
// of which are singletons that reject a *different* client — so all tests must
// hand them the same client reference. The real makeDiscordApiCall simply races
// the wrapped REST call against a timeout, so it resolves instantly here.
const guildFetch = jest.fn<() => Promise<unknown>>();
const sharedClient = { guilds: { fetch: guildFetch } } as unknown as Client;

interface FakeConfig {
  _id: string;
  guildId: string;
  roleId: string;
  messageId: string;
  emoji: string;
  roleName: string;
  isArchived: boolean;
  archivedAt?: Date;
  save: jest.Mock;
}

function makeConfig(overrides: Partial<FakeConfig> = {}): FakeConfig {
  return {
    _id: "cfg1",
    guildId: "g1",
    roleId: "role1",
    messageId: "msg1",
    emoji: "🎮",
    roleName: "Cool",
    isArchived: false,
    save: jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createService() {
  const service = ReactionRoleService.getInstance(sharedClient);
  const mockConfigService = {
    getBoolean: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
    getString: jest.fn<() => Promise<string>>().mockResolvedValue("chan1"),
    getNumber: jest.fn(),
  };
  (service as never)["configService"] = mockConfigService;
  return { service, mockConfigService };
}

/**
 * Wire the shared client's guild.fetch to return a guild whose role/message
 * lookups resolve to the supplied values.
 */
function primeGuild(opts: {
  role?: unknown;
  message?: unknown;
  roleError?: unknown;
  messageError?: unknown;
}): void {
  const roleFetch = jest.fn<() => Promise<unknown>>();
  if (opts.roleError !== undefined) {
    roleFetch.mockRejectedValue(opts.roleError);
  } else {
    roleFetch.mockResolvedValue(opts.role);
  }

  const messageFetch = jest.fn<() => Promise<unknown>>();
  if (opts.messageError !== undefined) {
    messageFetch.mockRejectedValue(opts.messageError);
  } else {
    messageFetch.mockResolvedValue(opts.message);
  }

  const messageChannel = {
    isTextBased: () => true,
    messages: { fetch: messageFetch },
  };
  const guild = {
    id: "g1",
    roles: { fetch: roleFetch },
    channels: {
      fetch: jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(messageChannel),
    },
  };
  guildFetch.mockResolvedValue(guild);
}

function makeMessage(opts: { hasOwnReaction: boolean }): {
  react: jest.Mock;
  reactions: { cache: { some: (p: (r: unknown) => boolean) => boolean } };
} {
  const reactions = opts.hasOwnReaction
    ? [{ emoji: { id: null, name: "🎮" }, me: true }]
    : [];
  return {
    react: jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
    reactions: {
      cache: {
        some: (pred: (r: unknown) => boolean) => reactions.some(pred),
      },
    },
  };
}

describe("ReactionRoleService.reconcileConfigs", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (
      ReactionRoleService as unknown as { instance?: ReactionRoleService }
    ).instance = undefined;
  });

  it("archives a config whose role no longer exists", async () => {
    const config = makeConfig();
    find.mockResolvedValue([config]);
    primeGuild({ role: null, message: makeMessage({ hasOwnReaction: true }) });
    const { service } = createService();

    await service.reconcileConfigs();

    expect(config.isArchived).toBe(true);
    expect(config.save).toHaveBeenCalledTimes(1);
  });

  it("archives a config whose reaction message no longer exists", async () => {
    const config = makeConfig();
    find.mockResolvedValue([config]);
    primeGuild({ role: { id: "role1", name: "Cool" }, message: null });
    const { service } = createService();

    await service.reconcileConfigs();

    expect(config.isArchived).toBe(true);
    expect(config.save).toHaveBeenCalledTimes(1);
  });

  it("re-adds the bot's base reaction when it went missing", async () => {
    const config = makeConfig();
    find.mockResolvedValue([config]);
    const message = makeMessage({ hasOwnReaction: false });
    primeGuild({ role: { id: "role1", name: "Cool" }, message });
    const { service } = createService();

    await service.reconcileConfigs();

    expect(message.react).toHaveBeenCalledWith("🎮");
    expect(config.isArchived).toBe(false);
    expect(config.save).not.toHaveBeenCalled();
  });

  it("leaves a fully-healthy config untouched", async () => {
    const config = makeConfig();
    find.mockResolvedValue([config]);
    const message = makeMessage({ hasOwnReaction: true });
    primeGuild({ role: { id: "role1", name: "Cool" }, message });
    const { service } = createService();

    await service.reconcileConfigs();

    expect(message.react).not.toHaveBeenCalled();
    expect(config.save).not.toHaveBeenCalled();
  });

  it("does NOT archive on a transient role-fetch error", async () => {
    const config = makeConfig();
    find.mockResolvedValue([config]);
    // A plain Error is not a confirmed Unknown Role (10011), so it must be
    // treated as transient and skipped — never archived.
    primeGuild({ roleError: new Error("network blip") });
    const { service } = createService();

    await service.reconcileConfigs();

    expect(config.isArchived).toBe(false);
    expect(config.save).not.toHaveBeenCalled();
  });

  it("does NOT archive on a transient message-fetch error", async () => {
    const config = makeConfig();
    find.mockResolvedValue([config]);
    primeGuild({
      role: { id: "role1", name: "Cool" },
      messageError: new Error("504 gateway timeout"),
    });
    const { service } = createService();

    await service.reconcileConfigs();

    expect(config.isArchived).toBe(false);
    expect(config.save).not.toHaveBeenCalled();
  });

  it("is a no-op when there are no active configs", async () => {
    find.mockResolvedValue([]);
    const { service } = createService();

    await service.reconcileConfigs();

    // No config processing means no guild is ever fetched.
    expect(guildFetch).not.toHaveBeenCalled();
  });
});

describe("ReactionRoleService stale-config cleanup handlers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (
      ReactionRoleService as unknown as { instance?: ReactionRoleService }
    ).instance = undefined;
  });

  it("handleMessageDelete archives configs backed by the deleted message", async () => {
    const config = makeConfig();
    find.mockResolvedValue([config]);
    const { service } = createService();

    await service.handleMessageDelete({ id: "msg1" } as unknown as Message);

    expect(find).toHaveBeenCalledWith({
      messageId: "msg1",
      isArchived: false,
    });
    expect(config.isArchived).toBe(true);
    expect(config.save).toHaveBeenCalledTimes(1);
  });

  it("handleRoleDelete archives configs that granted the deleted role", async () => {
    const config = makeConfig();
    find.mockResolvedValue([config]);
    const { service } = createService();

    await service.handleRoleDelete({
      id: "role1",
      guild: { id: "g1" },
    } as unknown as Role);

    expect(find).toHaveBeenCalledWith({
      guildId: "g1",
      roleId: "role1",
      isArchived: false,
    });
    expect(config.isArchived).toBe(true);
    expect(config.save).toHaveBeenCalledTimes(1);
  });

  it("handleChannelDelete archives configs whose backing channel was deleted", async () => {
    const config = makeConfig();
    find.mockResolvedValue([config]);
    const { service, mockConfigService } = createService();
    // Message channel is a different channel, so this exercises the
    // category/channel branch rather than the "message channel deleted" branch.
    mockConfigService.getString.mockResolvedValue("some-other-channel");

    await service.handleChannelDelete({
      id: "chan1",
      guild: { id: "g1" },
    } as never);

    expect(config.isArchived).toBe(true);
    expect(config.save).toHaveBeenCalledTimes(1);
  });

  it("handleChannelDelete ignores DM channels (no guild)", async () => {
    const { service } = createService();

    await service.handleChannelDelete({ id: "dm1" } as never);

    expect(find).not.toHaveBeenCalled();
  });
});
