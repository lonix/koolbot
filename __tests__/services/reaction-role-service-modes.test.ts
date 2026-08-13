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
const find = ((ReactionRoleConfig as unknown as { find: jest.Mock }).find =
  jest.fn());

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
 * Build a reaction whose message lives in a guild. `heldRoles` is the set of
 * role ids the member currently has; `rolesAdd`/`rolesRemove` capture mutations.
 */
function makeReaction(opts: {
  heldRoles: Set<string>;
  rolesAdd: jest.Mock;
  rolesRemove: jest.Mock;
  emojiName?: string;
  // Sibling reactions cached on the message, keyed by emoji name; each value's
  // `users.remove` captures the per-member reaction-clear call (unique mode).
  siblingReactions?: Array<{ name: string; usersRemove: jest.Mock }>;
}): MessageReaction {
  const member = {
    id: "user1",
    roles: {
      cache: { has: (id: string) => opts.heldRoles.has(id) },
      add: opts.rolesAdd,
      remove: opts.rolesRemove,
    },
  };
  const guild = {
    members: {
      fetch: jest.fn<() => Promise<unknown>>().mockResolvedValue(member),
    },
    roles: {
      cache: {
        get: (id: string) => ({ id, name: id === "role1" ? "Cool" : id }),
      },
    },
  };
  const cachedReactions = (opts.siblingReactions ?? []).map((s) => ({
    emoji: { id: null, name: s.name, animated: false },
    users: { remove: s.usersRemove },
  }));
  const reactions = {
    cache: {
      find: (pred: (r: unknown) => boolean) => cachedReactions.find(pred),
    },
  };
  return {
    partial: false,
    emoji: { id: null, name: opts.emojiName ?? "🎮", animated: false },
    message: { id: "msg1", guild, reactions },
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

describe("ReactionRoleService assignment modes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (
      ReactionRoleService as unknown as { instance?: ReactionRoleService }
    ).instance = undefined;
  });

  describe("sticky mode", () => {
    it("handleReactionRemove does NOT revoke the role", async () => {
      const { service } = createService();
      findOne.mockResolvedValue({
        roleId: "role1",
        roleName: "Cool",
        mode: "sticky",
      });
      const rolesAdd = jest.fn();
      const rolesRemove = jest.fn();

      await service.handleReactionRemove(
        makeReaction({
          heldRoles: new Set(["role1"]),
          rolesAdd,
          rolesRemove,
        }),
        makeUser(),
      );

      expect(rolesRemove).not.toHaveBeenCalled();
    });

    it("handleReactionAdd still grants the role", async () => {
      const { service } = createService();
      findOne.mockResolvedValue({
        roleId: "role1",
        roleName: "Cool",
        mode: "sticky",
      });
      const rolesAdd = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(undefined);
      const rolesRemove = jest.fn();

      await service.handleReactionAdd(
        makeReaction({ heldRoles: new Set(), rolesAdd, rolesRemove }),
        makeUser(),
      );

      expect(rolesAdd).toHaveBeenCalledTimes(1);
    });
  });

  describe("toggle mode", () => {
    it("handleReactionRemove revokes the role", async () => {
      const { service } = createService();
      findOne.mockResolvedValue({
        roleId: "role1",
        roleName: "Cool",
        mode: "toggle",
      });
      const rolesAdd = jest.fn();
      const rolesRemove = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(undefined);

      await service.handleReactionRemove(
        makeReaction({
          heldRoles: new Set(["role1"]),
          rolesAdd,
          rolesRemove,
        }),
        makeUser(),
      );

      expect(rolesRemove).toHaveBeenCalledTimes(1);
    });
  });

  describe("unique mode", () => {
    it("handleReactionAdd removes sibling roles on the same message", async () => {
      const { service } = createService();
      findOne.mockResolvedValue({
        roleId: "role1",
        roleName: "Cool",
        messageId: "msg1",
        emoji: "🎮",
        mode: "unique",
      });
      // One sibling config on the same message granting role2, which the
      // member currently holds.
      find.mockResolvedValue([
        { roleId: "role2", roleName: "Warm", emoji: "🔥" },
      ]);
      const rolesAdd = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(undefined);
      const rolesRemove = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(undefined);

      await service.handleReactionAdd(
        makeReaction({
          heldRoles: new Set(["role2"]),
          rolesAdd,
          rolesRemove,
        }),
        makeUser(),
      );

      expect(rolesAdd).toHaveBeenCalledTimes(1);
      expect(rolesRemove).toHaveBeenCalledTimes(1);
      expect(rolesRemove).toHaveBeenCalledWith("role2");
      // Sibling lookup is scoped to the same message and excludes the picked role.
      expect(find).toHaveBeenCalledWith({
        messageId: "msg1",
        isArchived: false,
        roleId: { $ne: "role1" },
      });
    });

    it("handleReactionAdd leaves sibling roles the member does not hold", async () => {
      const { service } = createService();
      findOne.mockResolvedValue({
        roleId: "role1",
        roleName: "Cool",
        messageId: "msg1",
        emoji: "🎮",
        mode: "unique",
      });
      find.mockResolvedValue([
        { roleId: "role2", roleName: "Warm", emoji: "🔥" },
      ]);
      const rolesAdd = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(undefined);
      const rolesRemove = jest.fn();

      await service.handleReactionAdd(
        makeReaction({ heldRoles: new Set(), rolesAdd, rolesRemove }),
        makeUser(),
      );

      expect(rolesRemove).not.toHaveBeenCalled();
    });

    it("handleReactionAdd clears the member's reaction on sibling emojis", async () => {
      const { service } = createService();
      findOne.mockResolvedValue({
        roleId: "role1",
        roleName: "Cool",
        messageId: "msg1",
        emoji: "🎮",
        mode: "unique",
      });
      find.mockResolvedValue([
        { roleId: "role2", roleName: "Warm", emoji: "🔥" },
      ]);
      const rolesAdd = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(undefined);
      const rolesRemove = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(undefined);
      const usersRemove = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(undefined);

      await service.handleReactionAdd(
        makeReaction({
          heldRoles: new Set(["role2"]),
          rolesAdd,
          rolesRemove,
          siblingReactions: [{ name: "🔥", usersRemove }],
        }),
        makeUser(),
      );

      // The sibling emoji reaction is cleared for this member (user1).
      expect(usersRemove).toHaveBeenCalledWith("user1");
    });

    it("handleReactionAdd fails soft when clearing a sibling reaction throws", async () => {
      const { service } = createService();
      findOne.mockResolvedValue({
        roleId: "role1",
        roleName: "Cool",
        messageId: "msg1",
        emoji: "🎮",
        mode: "unique",
      });
      find.mockResolvedValue([
        { roleId: "role2", roleName: "Warm", emoji: "🔥" },
      ]);
      const rolesAdd = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(undefined);
      const rolesRemove = jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(undefined);
      // Simulate a missing Manage Messages permission — clearing the sibling
      // reaction rejects, but the role mutation must still have happened and
      // handleReactionAdd must not throw.
      const usersRemove = jest
        .fn<() => Promise<unknown>>()
        .mockRejectedValue(new Error("Missing Permissions"));

      await expect(
        service.handleReactionAdd(
          makeReaction({
            heldRoles: new Set(["role2"]),
            rolesAdd,
            rolesRemove,
            siblingReactions: [{ name: "🔥", usersRemove }],
          }),
          makeUser(),
        ),
      ).resolves.toBeUndefined();

      expect(rolesRemove).toHaveBeenCalledWith("role2");
      expect(usersRemove).toHaveBeenCalledWith("user1");
    });
  });
});
