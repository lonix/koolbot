import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { PermissionFlagsBits } from "discord.js";

const mockGetString = jest.fn<(key: string, def?: string) => Promise<string>>();
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: jest.fn(() => ({
      getString: mockGetString,
      getBoolean: jest.fn(),
      set: jest.fn(),
    })),
  },
}));
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));
jest.unstable_mockModule("../../src/models/adoption-snapshot.js", () => ({
  AdoptionSnapshot: { find: jest.fn() },
}));

const {
  gateBits,
  planRulesGate,
  countLockedOut,
  linkCreatedRulesRole,
  RULES_ROLE_REF,
  rulesPlanIsApplicable,
  DEFAULT_RULES_ROLE_NAME,
} = await import("../../src/services/rules-adoption.js");
const { parseRulesOptions, gateableChannels } =
  await import("../../src/web/rules-page.js");

const VIEW = PermissionFlagsBits.ViewChannel;

describe("gateBits", () => {
  it("denies ViewChannel for @everyone and keeps other bits", () => {
    const out = gateBits({ allow: String(VIEW), deny: "0" }, "everyone");
    expect(BigInt(out.deny) & VIEW).toBe(VIEW);
    expect(BigInt(out.allow) & VIEW).toBe(0n);
  });
  it("allows ViewChannel for the role and clears a deny", () => {
    const out = gateBits({ allow: "0", deny: String(VIEW) }, "role");
    expect(BigInt(out.allow) & VIEW).toBe(VIEW);
    expect(BigInt(out.deny) & VIEW).toBe(0n);
  });
});

describe("parseRulesOptions", () => {
  it("defaults to a no-op rollout", () => {
    expect(parseRulesOptions({})).toEqual({
      createRole: false,
      grantExisting: false,
      gateChannelIds: [],
    });
  });
  it("reads flags and keeps only valid, unique channel ids", () => {
    expect(
      parseRulesOptions({
        createRole: "1",
        grantExisting: "1",
        gate: ["12345", "12345", "nope"],
      }),
    ).toEqual({
      createRole: true,
      grantExisting: true,
      gateChannelIds: ["12345"],
    });
  });
});

interface FakeRole {
  id: string;
  name: string;
  color: number;
  permissions: { bitfield: bigint };
  position: number;
  managed: boolean;
}

function fakeGuild(
  memberRoleIds: Record<string, string[]>,
  extraRoles: FakeRole[] = [],
) {
  const everyone = {
    id: "g1",
    name: "@everyone",
    color: 0,
    permissions: { bitfield: VIEW },
    position: 0,
    managed: false,
  };
  const roles = [
    everyone,
    ...extraRoles,
    {
      id: "100",
      name: "Bot",
      color: 0,
      permissions: {
        bitfield:
          PermissionFlagsBits.Administrator |
          PermissionFlagsBits.ManageRoles |
          PermissionFlagsBits.ManageChannels |
          PermissionFlagsBits.ViewChannel,
      },
      position: 10,
      managed: false,
    },
  ];
  const member = (id: string, rids: string[], bot = false) => ({
    id,
    user: { bot },
    roles: {
      cache: new Map(rids.map((r) => [r, {}])),
      highest: { position: 10 },
    },
    permissions: { has: () => false },
  });
  const me = member("bot", ["100"], true);
  const members = new Map(
    Object.entries(memberRoleIds).map(([id, r]) => [id, member(id, r)]),
  );
  members.set("bot", me);
  const channel = (id: string) => ({
    id,
    name: `chan-${id}`,
    type: 0,
    parentId: null,
    rawPosition: 0,
    topic: null,
    permissionOverwrites: { cache: new Map() },
  });
  return {
    id: "g1",
    ownerId: "owner",
    roles: { fetch: async () => new Map(roles.map((r) => [r.id, r])) },
    channels: {
      fetch: async () =>
        new Map([
          ["11111", channel("11111")],
          ["22222", channel("22222")],
        ]),
    },
    members: {
      me,
      fetchMe: async () => me,
      fetch: async (arg?: string) => (arg ? members.get(arg) : members),
    },
  };
}

describe("planRulesGate", () => {
  beforeEach(() => {
    mockGetString.mockReset();
    mockGetString.mockImplementation(async (k) =>
      k === "rules.channel_id" ? "11111" : "",
    );
  });

  it("plans nothing by default", async () => {
    const guild = fakeGuild({ admin: ["g1"], a: [] });
    const p = await planRulesGate(guild as never, "admin", {
      createRole: false,
      grantExisting: false,
      gateChannelIds: [],
    });
    expect(p.plan.operations).toHaveLength(0);
    expect(p.extraErrors).toHaveLength(0);
  });

  it("creates the role, grants existing members and gates a channel", async () => {
    const guild = fakeGuild({ admin: [], a: [], b: [] });
    const p = await planRulesGate(guild as never, "admin", {
      createRole: true,
      grantExisting: true,
      gateChannelIds: ["22222"],
    });
    const types = p.plan.operations.map((o) => o.type);
    expect(types).toContain("role.create");
    expect(types).toContain("member.role.add");
    expect(types.filter((t) => t === "overwrite.set")).toHaveLength(2);
    expect(p.plan.operations.every((o) => o.class === "additive")).toBe(true);
    expect(p.preview.lockedOut).toBe(0);
    expect(rulesPlanIsApplicable(p)).toBe(true);
    expect(DEFAULT_RULES_ROLE_NAME).toBe("Rules accepted");
  });

  it("previews who would be locked out when existing members aren't granted", async () => {
    mockGetString.mockImplementation(async (k) =>
      k === "rules.role_id" ? "100" : "",
    );
    const guild = fakeGuild({ admin: [], a: [], b: ["100"] });
    const p = await planRulesGate(guild as never, "admin", {
      createRole: false,
      grantExisting: false,
      gateChannelIds: ["22222"],
    });
    expect(p.preview.totalMembers).toBe(3);
    expect(p.preview.holders).toBe(1);
    expect(p.preview.lockedOut).toBe(2);
  });

  const role = (over: Partial<FakeRole>): FakeRole => ({
    id: "200",
    name: "Accepted",
    color: 0,
    permissions: { bitfield: 0n },
    position: 2,
    managed: false,
    ...over,
  });
  const gateOnly = {
    createRole: false,
    grantExisting: false,
    gateChannelIds: ["22222"],
  };

  it("blocks creating a role when one with that name already exists", async () => {
    const guild = fakeGuild({ admin: [], a: [] }, [
      role({ id: "300", name: "rules ACCEPTED" }),
    ]);
    const p = await planRulesGate(guild as never, "admin", {
      createRole: true,
      grantExisting: true,
      gateChannelIds: ["22222"],
    });
    expect(p.extraErrors.map((e) => e.code)).toContain("role-name-taken");
    expect(p.plan.operations).toHaveLength(0);
    expect(rulesPlanIsApplicable(p)).toBe(false);
  });

  it("refuses a configured role the Accept handler would refuse", async () => {
    for (const [r, code] of [
      [role({ managed: true }), "role-managed"],
      [role({ position: 10 }), "role-too-high"],
    ] as const) {
      mockGetString.mockImplementation(async (k) =>
        k === "rules.role_id" ? "200" : "",
      );
      const guild = fakeGuild({ admin: [], a: [] }, [r]);
      const p = await planRulesGate(guild as never, "admin", gateOnly);
      expect(p.extraErrors.map((e) => e.code)).toContain(code);
      expect(rulesPlanIsApplicable(p)).toBe(false);
    }
  });

  it("orders grants before the gating overwrites", async () => {
    mockGetString.mockImplementation(async (k) =>
      k === "rules.role_id" ? "200" : "",
    );
    const guild = fakeGuild({ admin: [], a: [], b: [] }, [role({})]);
    const p = await planRulesGate(guild as never, "admin", {
      ...gateOnly,
      grantExisting: true,
    });
    expect(p.plan.operations.map((o) => o.type)).toEqual([
      "member.role.add",
      "overwrite.set",
      "overwrite.set",
    ]);
  });

  it("refuses to gate the rules channel itself", async () => {
    const guild = fakeGuild({ admin: [] });
    const p = await planRulesGate(guild as never, "admin", {
      createRole: true,
      grantExisting: false,
      gateChannelIds: ["11111"],
    });
    expect(p.extraErrors.map((e) => e.code)).toContain("gate-rules-channel");
    expect(rulesPlanIsApplicable(p)).toBe(false);
  });

  it("asks for a role before granting or gating", async () => {
    const guild = fakeGuild({ admin: [] });
    const p = await planRulesGate(guild as never, "admin", {
      createRole: false,
      grantExisting: true,
      gateChannelIds: [],
    });
    expect(p.extraErrors.map((e) => e.code)).toContain("no-role");
  });
});

describe("countLockedOut", () => {
  const roles = [
    { id: "g1", permissions: String(VIEW) },
    { id: "acc", permissions: "0" },
    { id: "vip", permissions: "0" },
    { id: "admin", permissions: String(PermissionFlagsBits.Administrator) },
  ];
  const base = {
    roles,
    everyoneId: "g1",
    ownerId: "owner",
    roleId: "acc",
    grantExisting: false,
    gateChannelIds: ["c1"],
  };
  const viewAllow = {
    id: "vip",
    type: "role" as const,
    allow: String(VIEW),
    deny: "0",
  };

  it("counts unique members who lose sight, ignoring holders, admins and others who can't see it anyway", () => {
    const hidden = {
      id: "g1",
      type: "role" as const,
      allow: "0",
      deny: String(VIEW),
    };
    const n = countLockedOut({
      ...base,
      memberRoles: {
        plain: [],
        holder: ["acc"],
        admin: ["admin"],
        // Admin and holder at once: counted by neither list twice.
        both: ["admin", "acc"],
        // Sees it only through an allow overwrite for vip, which the gate keeps.
        vip: ["vip"],
      },
      channels: [{ id: "c1", overwrites: [viewAllow] }],
    });
    // plain loses it; vip keeps it via the overwrite allow.
    expect(n).toBe(1);
    // Already hidden from everyone: nobody loses anything.
    expect(
      countLockedOut({
        ...base,
        memberRoles: { plain: [] },
        channels: [{ id: "c1", overwrites: [hidden] }],
      }),
    ).toBe(0);
  });

  it("respects member overwrites and the grant", () => {
    const memberDeny = {
      id: "u1",
      type: "member" as const,
      allow: "0",
      deny: String(VIEW),
    };
    const channels = [{ id: "c1", overwrites: [memberDeny] }];
    const memberRoles = { u1: [], u2: [] };
    // u1 never saw the channel; only u2 loses it.
    expect(countLockedOut({ ...base, memberRoles, channels })).toBe(1);
    expect(
      countLockedOut({ ...base, memberRoles, channels, grantExisting: true }),
    ).toBe(0);
  });
});

describe("linkCreatedRulesRole", () => {
  it("stores only the exact role the apply created, when none is set", async () => {
    const set = jest.fn();
    mockGetString.mockResolvedValue("");
    const { ConfigService } =
      await import("../../src/services/config-service.js");
    (ConfigService.getInstance as jest.Mock).mockReturnValue({
      getString: mockGetString,
      set,
    });
    const { AdoptionSnapshot } =
      await import("../../src/models/adoption-snapshot.js");
    const lean = jest.fn();
    (AdoptionSnapshot as unknown as { findById: jest.Mock }).findById = jest
      .fn()
      .mockReturnValue({ lean });
    lean.mockResolvedValueOnce({
      createdRoles: [{ ref: "new:other", roleId: "9", name: "Rules accepted" }],
    });
    expect(await linkCreatedRulesRole("snap")).toBe(false);
    lean.mockResolvedValueOnce({
      createdRoles: [
        { ref: RULES_ROLE_REF, roleId: "42", name: "Rules accepted" },
      ],
    });
    expect(await linkCreatedRulesRole("snap")).toBe(true);
    expect(set).toHaveBeenCalledWith(
      "rules.role_id",
      "42",
      expect.any(String),
      "rules",
    );
  });
});

describe("gateableChannels", () => {
  it("drops threads and non-text/voice channels", () => {
    const ch = (id: string, thread: boolean, text: boolean) =>
      ({
        id,
        name: id,
        isThread: () => thread,
        isTextBased: () => text,
        isVoiceBased: () => false,
      }) as never;
    expect(
      gateableChannels([
        ch("b", false, true),
        ch("t", true, true),
        ch("cat", false, false),
        null,
      ]),
    ).toEqual([{ id: "b", name: "b" }]);
  });
});
