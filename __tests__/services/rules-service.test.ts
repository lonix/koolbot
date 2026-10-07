import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import {
  Collection,
  PermissionFlagsBits as P,
  type ButtonInteraction,
} from "discord.js";

const mockGetBoolean =
  jest.fn<(key: string, def?: boolean) => Promise<boolean>>();
const mockGetString = jest.fn<(key: string, def?: string) => Promise<string>>();
const mockSet = jest.fn<(...args: unknown[]) => Promise<void>>();
const mockEnv = { guildId: "g1", guildMembersIntent: true };
const mockLogger = {
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
};
const mockUpdateOne = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: jest.fn(() => ({
      getBoolean: mockGetBoolean,
      getString: mockGetString,
      set: mockSet,
    })),
  },
}));
jest.unstable_mockModule("../../src/config/env.js", () => ({ env: mockEnv }));
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: mockLogger,
}));
jest.unstable_mockModule("../../src/models/rules-acceptance.js", () => ({
  RulesAcceptance: {
    updateOne: mockUpdateOne,
    find: jest.fn(),
    bulkWrite: jest.fn(),
  },
}));

const {
  RulesService,
  roleProblem,
  RULES_ACCEPT_CUSTOM_ID,
  UNSAFE_ACCEPTANCE_PERMISSIONS,
} = await import("../../src/services/rules-service.js");

describe("roleProblem", () => {
  const role = { id: "r1", managed: false, position: 2 };
  it("accepts a normal role below the bot", () => {
    expect(roleProblem(role, "g1", 5, true)).toBeNull();
  });
  it("refuses missing, @everyone, managed, too-high roles and no permission", () => {
    expect(roleProblem(undefined, "g1", 5, true)).toBe("role-missing");
    expect(roleProblem({ ...role, id: "g1" }, "g1", 5, true)).toBe(
      "role-everyone",
    );
    expect(roleProblem({ ...role, managed: true }, "g1", 5, true)).toBe(
      "role-managed",
    );
    expect(roleProblem({ ...role, position: 5 }, "g1", 5, true)).toBe(
      "role-too-high",
    );
    expect(roleProblem(role, "g1", 5, false)).toBe("no-manage-roles");
  });
  it("refuses a role carrying unsafe permissions, however they are given", () => {
    for (const bit of UNSAFE_ACCEPTANCE_PERMISSIONS) {
      expect(roleProblem({ ...role, permissions: bit }, "g1", 5, true)).toBe(
        "role-privileged",
      );
    }
    expect(
      roleProblem(
        { ...role, permissions: { bitfield: P.Administrator } },
        "g1",
        5,
        true,
      ),
    ).toBe("role-privileged");
    expect(
      roleProblem(
        { ...role, permissions: String(P.BanMembers) },
        "g1",
        5,
        true,
      ),
    ).toBe("role-privileged");
    expect(
      roleProblem(
        { ...role, permissions: P.ViewChannel | P.SendMessages },
        "g1",
        5,
        true,
      ),
    ).toBeNull();
  });
});

describe("handleAcceptButton", () => {
  const order: string[] = [];
  const add = jest.fn<(...args: unknown[]) => Promise<unknown>>();
  let hasRole = false;
  let rolePerms: bigint = 0n;
  let config: Record<string, boolean | string>;

  const interaction = (): ButtonInteraction =>
    ({
      customId: RULES_ACCEPT_CUSTOM_ID,
      user: { id: "u1" },
      channelId: "c1",
      message: { id: "m1" },
      deferReply: jest.fn(async () => {
        order.push("defer");
      }),
      editReply: jest.fn(async () => {
        order.push("edit");
      }),
      guild: {
        id: "g1",
        roles: {
          fetch: jest.fn(
            async () =>
              new Map([
                [
                  "r1",
                  {
                    id: "r1",
                    managed: false,
                    position: 1,
                    permissions: { bitfield: rolePerms },
                  },
                ],
              ]),
          ),
        },
        members: {
          me: {
            roles: { highest: { position: 5 } },
            permissions: { has: () => true },
          },
          fetch: jest.fn(async () => ({
            id: "u1",
            roles: { cache: { has: () => hasRole }, add },
          })),
        },
      },
    }) as unknown as ButtonInteraction;

  beforeEach(() => {
    jest.clearAllMocks();
    order.length = 0;
    hasRole = false;
    rolePerms = 0n;
    config = {
      "rules.enabled": true,
      "rules.role_id": "r1",
      "rules.channel_id": "c1",
      "rules.message_id": "m1",
    };
    mockGetBoolean.mockImplementation(async (k) => Boolean(config[k]));
    mockGetString.mockImplementation(async (k) => String(config[k] ?? ""));
    add.mockResolvedValue(undefined);
    mockUpdateOne.mockResolvedValue({});
  });

  const service = (): InstanceType<typeof RulesService> => {
    RulesService.reset();
    return RulesService.getInstance({} as never);
  };

  it("defers before any other work, grants the role and records it", async () => {
    const i = interaction();
    await service().handleAcceptButton(i);
    expect(order[0]).toBe("defer");
    expect(add).toHaveBeenCalledTimes(1);
    const [filter, update] = mockUpdateOne.mock.calls[0] as [
      Record<string, string>,
      { $setOnInsert: { source: string } },
    ];
    expect(filter).toEqual({ userId: "u1", guildId: "g1" });
    expect(update.$setOnInsert.source).toBe("button");
  });

  it.each([
    ["message", { "rules.message_id": "m2" }],
    ["channel", { "rules.channel_id": "c2" }],
    ["cleared message id", { "rules.message_id": "" }],
  ])("rejects a click from an outdated rules %s", async (_n, change) => {
    Object.assign(config, change);
    const i = interaction();
    await service().handleAcceptButton(i);
    expect(order[0]).toBe("defer");
    expect(add).not.toHaveBeenCalled();
    expect(mockUpdateOne).not.toHaveBeenCalled();
    expect(i.editReply).toHaveBeenCalledWith({
      content: expect.stringContaining("out of date"),
    });
  });

  it("never grants a role that carries Administrator", async () => {
    rolePerms = P.Administrator;
    const i = interaction();
    await service().handleAcceptButton(i);
    expect(add).not.toHaveBeenCalled();
    expect(mockUpdateOne).not.toHaveBeenCalled();
    expect(i.editReply).toHaveBeenCalledWith({
      content: expect.stringContaining("can't grant"),
    });
  });

  it("records an existing holder as adopted without re-granting", async () => {
    hasRole = true;
    await service().handleAcceptButton(interaction());
    expect(add).not.toHaveBeenCalled();
    const update = mockUpdateOne.mock.calls[0][1] as {
      $setOnInsert: { source: string };
    };
    expect(update.$setOnInsert.source).toBe("adopted");
  });

  it("does nothing when the feature is off", async () => {
    config["rules.enabled"] = false;
    await service().handleAcceptButton(interaction());
    expect(order[0]).toBe("defer");
    expect(add).not.toHaveBeenCalled();
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it("never throws and tells the member when Discord rejects the grant", async () => {
    add.mockRejectedValue(new Error("Missing Permissions"));
    const i = interaction();
    await expect(service().handleAcceptButton(i)).resolves.toBeUndefined();
    expect(i.editReply).toHaveBeenCalled();
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });
});

describe("recordExistingHolders", () => {
  const bulkWrite = jest.fn<(...args: unknown[]) => Promise<unknown>>();
  let roleCfg = "r1";

  type TestRole = {
    id: string;
    managed: boolean;
    position: number;
    permissions?: bigint;
  };
  const makeGuild = (role: TestRole | undefined, canManage = true): never =>
    ({
      id: "g1",
      roles: {
        fetch: jest.fn(async () => new Map(role ? [[role.id, role]] : [])),
      },
      members: {
        me: {
          roles: { highest: { position: 5 } },
          permissions: { has: () => canManage },
        },
        fetch: jest.fn(async () => {
          const m = new Collection<string, unknown>();
          for (const id of ["u1", "u2"]) {
            m.set(id, {
              user: { bot: false },
              roles: { cache: { has: () => true } },
            });
          }
          return m;
        }),
      },
    }) as never;

  beforeEach(async () => {
    jest.clearAllMocks();
    roleCfg = "r1";
    mockGetString.mockImplementation(async (k) =>
      k === "rules.role_id" ? roleCfg : "",
    );
    const { RulesAcceptance } =
      await import("../../src/models/rules-acceptance.js");
    (RulesAcceptance as unknown as Record<string, unknown>).bulkWrite =
      bulkWrite;
    (RulesAcceptance as unknown as Record<string, unknown>).find = jest.fn(
      () => ({ select: () => ({ lean: async () => [] }) }),
    );
    bulkWrite.mockResolvedValue({});
  });

  const service = (): InstanceType<typeof RulesService> => {
    RulesService.reset();
    return RulesService.getInstance({} as never);
  };
  const ok: TestRole = { id: "r1", managed: false, position: 1 };

  it("records holders of a valid role", async () => {
    expect(await service().recordExistingHolders(makeGuild(ok))).toEqual({
      recorded: 2,
    });
    expect(bulkWrite).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "@everyone",
      "g1",
      { id: "g1", managed: false, position: 0 },
      "role-everyone",
    ],
    ["a managed role", "r1", { ...ok, managed: true }, "role-managed"],
    ["a role above the bot", "r1", { ...ok, position: 5 }, "role-too-high"],
    ["a deleted role", "r1", undefined, "role-missing"],
    [
      "a role with Administrator",
      "r1",
      { ...ok, permissions: P.Administrator },
      "role-privileged",
    ],
  ])("refuses %s and records nothing", async (_n, cfgId, role, problem) => {
    roleCfg = cfgId;
    expect(
      await service().recordExistingHolders(
        makeGuild(role as TestRole | undefined),
      ),
    ).toEqual({ problem });
    expect(bulkWrite).not.toHaveBeenCalled();
  });

  it("refuses when the bot lacks Manage Roles", async () => {
    expect(await service().recordExistingHolders(makeGuild(ok, false))).toEqual(
      { problem: "no-manage-roles" },
    );
    expect(bulkWrite).not.toHaveBeenCalled();
  });

  it("records nothing when no role is configured", async () => {
    roleCfg = "";
    expect(await service().recordExistingHolders(makeGuild(ok))).toEqual({
      recorded: 0,
    });
  });
});
