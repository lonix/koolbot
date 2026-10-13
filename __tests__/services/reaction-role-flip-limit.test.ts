import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import {
  PermissionFlagsBits,
  type Client,
  type MessageReaction,
  type User,
} from "discord.js";

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
import { resetMemberCooldowns } from "../../src/utils/member-cooldown.js";

const findOne = ((
  ReactionRoleConfig as unknown as { findOne: jest.Mock }
).findOne = jest.fn());

function createService(maxToggles: number) {
  const service = ReactionRoleService.getInstance({} as Client);
  (service as never)["configService"] = {
    getBoolean: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
    getString: jest.fn(),
    getNumber: jest.fn(async (key: string) =>
      key === "reactionroles.max_toggles" ? maxToggles : 30,
    ),
  };
  return service;
}

/** A member whose roles are backed by a real Set so flips change state. */
function makeReaction(
  liveBits: bigint = 0n,
  fetchMode: "ok" | "reject" | "null" = "ok",
) {
  const held = new Set<string>();
  const rolesAdd = jest.fn(async (role: { id: string }) => {
    held.add(role.id);
  });
  const rolesRemove = jest.fn(async (role: { id: string }) => {
    held.delete(role.id);
  });
  const usersRemove = jest.fn(async () => undefined);
  const member = {
    id: "user1",
    roles: {
      cache: { has: (id: string) => held.has(id) },
      add: rolesAdd,
      remove: rolesRemove,
    },
  };
  const guild = {
    id: "guild1",
    members: { fetch: jest.fn(async () => member) },
    roles: {
      // The cache is deliberately stale (no permissions): only the live fetch
      // knows what the role carries now.
      cache: { get: (id: string) => ({ id, name: "Cool" }) },
      fetch: jest.fn(async (id: string) => {
        if (fetchMode === "reject") throw new Error("REST down");
        if (fetchMode === "null") return null;
        return { id, name: "Cool", permissions: { bitfield: liveBits } };
      }),
    },
  };
  const reaction = {
    partial: false,
    emoji: { id: null, name: "🎮", animated: false },
    users: { remove: usersRemove },
    message: {
      id: "msg1",
      guild,
      reactions: { cache: { find: () => undefined } },
    },
  } as unknown as MessageReaction;
  return { reaction, rolesAdd, rolesRemove, usersRemove };
}

const user = {
  partial: false,
  id: "user1",
  tag: "User#0001",
  bot: false,
} as unknown as User;

describe("reaction role flip limit (#1147)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetMemberCooldowns();
    (
      ReactionRoleService as unknown as { instance?: ReactionRoleService }
    ).instance = undefined;
    findOne.mockResolvedValue({
      roleId: "role1",
      roleName: "Cool",
      mode: "toggle",
    });
  });

  it("stops granting and revoking once a member flips too fast", async () => {
    const service = createService(4);
    const { reaction, rolesAdd, rolesRemove } = makeReaction();

    // add, remove, add, remove use up the budget of 4 ...
    for (let i = 0; i < 2; i++) {
      await service.handleReactionAdd(reaction, user);
      await service.handleReactionRemove(reaction, user);
    }
    expect(rolesAdd).toHaveBeenCalledTimes(2);
    expect(rolesRemove).toHaveBeenCalledTimes(2);

    // ... and the fifth and later flips never reach Discord.
    await service.handleReactionAdd(reaction, user);
    await service.handleReactionAdd(reaction, user);
    expect(rolesAdd).toHaveBeenCalledTimes(2);
  });

  it("takes back the reaction of a refused add so the message stays truthful", async () => {
    const service = createService(1);
    const first = makeReaction();
    await service.handleReactionAdd(first.reaction, user);
    expect(first.usersRemove).not.toHaveBeenCalled();

    // Same member, a second message: over the limit, so no role and no pick.
    const second = makeReaction();
    await service.handleReactionAdd(second.reaction, user);
    expect(second.rolesAdd).not.toHaveBeenCalled();
    expect(second.usersRemove).toHaveBeenCalledWith("user1");
  });

  it("limits unique-mode sibling cleanup when the member already holds the role", async () => {
    findOne.mockResolvedValue({
      roleId: "role1",
      roleName: "Cool",
      mode: "unique",
      messageId: "msg1",
    });
    const find = (ReactionRoleConfig as unknown as { find: jest.Mock })
      .find as jest.Mock;
    find.mockReset();
    find.mockResolvedValue([]);
    const service = createService(1);
    const { reaction, rolesAdd } = makeReaction();

    // First add grants the role and spends the whole budget (and cleans up).
    await service.handleReactionAdd(reaction, user);
    expect(rolesAdd).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledTimes(1);

    // Re-adding while holding the role must not run the cleanup again.
    await service.handleReactionAdd(reaction, user);
    await service.handleReactionAdd(reaction, user);
    expect(find).toHaveBeenCalledTimes(1);
  });

  it("refuses to grant a bound role that now carries Administrator (#1145)", async () => {
    const service = createService(10);
    const { reaction, rolesAdd, usersRemove } = makeReaction(
      PermissionFlagsBits.Administrator,
    );
    await service.handleReactionAdd(reaction, user);
    expect(rolesAdd).not.toHaveBeenCalled();
    expect(usersRemove).toHaveBeenCalledWith("user1");
  });

  it.each(["reject", "null"] as const)(
    "fails closed when the live role cannot be verified (%s)",
    async (mode) => {
      const service = createService(10);
      const { reaction, rolesAdd, usersRemove } = makeReaction(0n, mode);
      await service.handleReactionAdd(reaction, user);
      expect(rolesAdd).not.toHaveBeenCalled();
      expect(usersRemove).toHaveBeenCalledWith("user1");
    },
  );

  it("still grants a safe role, judged on the live role", async () => {
    const service = createService(10);
    const { reaction, rolesAdd } = makeReaction(PermissionFlagsBits.Connect);
    await service.handleReactionAdd(reaction, user);
    expect(rolesAdd).toHaveBeenCalledTimes(1);
  });

  it("bounds how often a refused reaction is taken back", async () => {
    const service = createService(10);
    let removals = 0;
    for (let i = 0; i < 12; i++) {
      const r = makeReaction(PermissionFlagsBits.ManageGuild);
      await service.handleReactionAdd(r.reaction, user);
      removals += r.usersRemove.mock.calls.length;
    }
    expect(removals).toBe(5);
  });

  it("does not take back a reaction refused by the flip limit once the undo budget is spent", async () => {
    const service = createService(1);
    const first = makeReaction();
    await service.handleReactionAdd(first.reaction, user);
    let removals = 0;
    for (let i = 0; i < 12; i++) {
      const r = makeReaction();
      await service.handleReactionAdd(r.reaction, user);
      removals += r.usersRemove.mock.calls.length;
    }
    expect(removals).toBe(5);
  });

  it("stops refused attempts costing REST reads once the attempt cap is reached", async () => {
    const service = createService(10);
    let fetches = 0;
    for (let i = 0; i < 40; i++) {
      const r = makeReaction(PermissionFlagsBits.Administrator);
      await service.handleReactionAdd(r.reaction, user);
      fetches += (
        (
          r.reaction.message.guild as unknown as {
            roles: { fetch: jest.Mock };
          }
        ).roles.fetch as jest.Mock
      ).mock.calls.length;
    }
    // 30 attempts a minute, then no more live fetches (and no take-backs).
    expect(fetches).toBe(30);
  });

  it("does not spend a flip when the role change fails", async () => {
    const service = createService(1);
    const failing = makeReaction();
    failing.rolesAdd.mockRejectedValueOnce(new Error("Missing Permissions"));
    await service.handleReactionAdd(failing.reaction, user); // fails, released

    const next = makeReaction();
    await service.handleReactionAdd(next.reaction, user);
    expect(next.rolesAdd).toHaveBeenCalledTimes(1);
  });

  it("does not limit anything when max_toggles is 0", async () => {
    const service = createService(0);
    const { reaction, rolesAdd, rolesRemove } = makeReaction();
    for (let i = 0; i < 20; i++) {
      await service.handleReactionAdd(reaction, user);
      await service.handleReactionRemove(reaction, user);
    }
    expect(rolesAdd).toHaveBeenCalledTimes(20);
    expect(rolesRemove).toHaveBeenCalledTimes(20);
  });
});
