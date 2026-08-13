import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { Client, MessageReaction, User } from "discord.js";

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

const findOne = ((
  ReactionRoleConfig as unknown as { findOne: jest.Mock }
).findOne = jest.fn());

function createService() {
  const service = ReactionRoleService.getInstance({} as Client);
  const mockConfigService = {
    getBoolean: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
    getString: jest.fn(),
    getNumber: jest.fn(),
  };
  (service as never)["configService"] = mockConfigService;
  return { service, mockConfigService };
}

/**
 * Build a reaction whose message lives in a guild whose member has (or lacks)
 * the target role. `rolesAdd` / `rolesRemove` capture the role mutation calls.
 */
function makeReaction(opts: {
  hasRole: boolean;
  rolesAdd: jest.Mock;
  rolesRemove: jest.Mock;
  emojiName?: string;
}): MessageReaction {
  const roleId = "role1";
  const member = {
    roles: {
      cache: { has: () => opts.hasRole },
      add: opts.rolesAdd,
      remove: opts.rolesRemove,
    },
  };
  const guild = {
    members: {
      fetch: jest.fn<() => Promise<unknown>>().mockResolvedValue(member),
    },
    roles: { cache: { get: () => ({ id: roleId, name: "Cool" }) } },
  };
  return {
    partial: false,
    emoji: { id: null, name: opts.emojiName ?? "🎮", animated: false },
    message: { id: "msg1", guild },
  } as unknown as MessageReaction;
}

function makeUser(): User {
  return {
    partial: false,
    id: "user1",
    tag: "User#0001",
    bot: false,
  } as unknown as User;
}

describe("ReactionRoleService reaction handlers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("handleReactionAdd is a no-op when reactionroles.enabled is false", async () => {
    const { service, mockConfigService } = createService();
    mockConfigService.getBoolean.mockResolvedValue(false);
    const rolesAdd = jest.fn();
    const rolesRemove = jest.fn();

    await service.handleReactionAdd(
      makeReaction({ hasRole: false, rolesAdd, rolesRemove }),
      makeUser(),
    );

    expect(findOne).not.toHaveBeenCalled();
    expect(rolesAdd).not.toHaveBeenCalled();
  });

  it("handleReactionAdd grants the role when a matching config exists", async () => {
    const { service } = createService();
    findOne.mockResolvedValue({ roleId: "role1", roleName: "Cool" });
    const rolesAdd = jest
      .fn<() => Promise<unknown>>()
      .mockResolvedValue(undefined);
    const rolesRemove = jest.fn();

    await service.handleReactionAdd(
      makeReaction({ hasRole: false, rolesAdd, rolesRemove }),
      makeUser(),
    );

    expect(rolesAdd).toHaveBeenCalledTimes(1);
  });

  it("handleReactionAdd skips granting when the member already has the role", async () => {
    const { service } = createService();
    findOne.mockResolvedValue({ roleId: "role1", roleName: "Cool" });
    const rolesAdd = jest.fn();
    const rolesRemove = jest.fn();

    await service.handleReactionAdd(
      makeReaction({ hasRole: true, rolesAdd, rolesRemove }),
      makeUser(),
    );

    expect(rolesAdd).not.toHaveBeenCalled();
  });

  it("handleReactionRemove is a no-op when reactionroles.enabled is false", async () => {
    const { service, mockConfigService } = createService();
    mockConfigService.getBoolean.mockResolvedValue(false);
    const rolesAdd = jest.fn();
    const rolesRemove = jest.fn();

    await service.handleReactionRemove(
      makeReaction({ hasRole: true, rolesAdd, rolesRemove }),
      makeUser(),
    );

    expect(findOne).not.toHaveBeenCalled();
    expect(rolesRemove).not.toHaveBeenCalled();
  });

  it("handleReactionRemove revokes the role when a matching config exists", async () => {
    const { service } = createService();
    findOne.mockResolvedValue({ roleId: "role1", roleName: "Cool" });
    const rolesAdd = jest.fn();
    const rolesRemove = jest
      .fn<() => Promise<unknown>>()
      .mockResolvedValue(undefined);

    await service.handleReactionRemove(
      makeReaction({ hasRole: true, rolesAdd, rolesRemove }),
      makeUser(),
    );

    expect(rolesRemove).toHaveBeenCalledTimes(1);
  });
});
