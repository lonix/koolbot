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
  rulesPlanIsApplicable,
  DEFAULT_RULES_ROLE_NAME,
} = await import("../../src/services/rules-adoption.js");
const { parseRulesOptions } = await import("../../src/web/rules-page.js");

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

function fakeGuild(memberRoleIds: Record<string, string[]>) {
  const everyone = {
    id: "g1",
    name: "@everyone",
    color: 0,
    permissions: { bitfield: 0n },
    position: 0,
    managed: false,
  };
  const roles = [
    everyone,
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
