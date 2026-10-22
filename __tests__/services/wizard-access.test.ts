/**
 * Unit tests for the Access step's rules (#1321): which writes a pick turns
 * into, how new groups are ranked, the "nobody to run it" gaps, and the
 * all-or-nothing apply.
 */

import { describe, it, expect, jest } from "@jest/globals";
import {
  accessGaps,
  applyAccessChanges,
  capabilitiesFor,
  currentMapping,
  diffAccess,
  normaliseSelection,
  orderWithNewGroups,
  pickableRoles,
  rollbackAccess,
  scopesOf,
  validateSelection,
  type AccessChange,
  type AccessContext,
  type AccessDeps,
  type AccessRole,
} from "../../src/services/wizard-access.js";
import { buildDesiredState } from "../../src/services/role-group-plan.js";
import type { RoleGroupView } from "../../src/services/role-group-service.js";
import type { ScannedState } from "../../src/services/server-adoption-planner.js";

const GUILD = "g1";
const role = (
  id: string,
  name: string,
  position: number,
  managed = false,
): AccessRole => ({ id, name, managed, position });

const group = (over: Partial<RoleGroupView>): RoleGroupView =>
  ({
    id: "grp",
    name: "grp",
    roleId: null,
    rank: 1,
    permissions: null,
    capabilities: [],
    colour: null,
    hoist: false,
    createdByKoolbot: false,
    gateOnly: false,
    roleName: null,
    unlinked: false,
    lostRoleId: null,
    recreateRequestedAt: null,
    syncPolicy: null,
    driftSignature: null,
    createdAt: new Date(0),
    ...over,
  }) as RoleGroupView;

const roles = [
  role(GUILD, "@everyone", 0),
  role("mod", "Moderator", 5),
  role("host", "Event host", 4),
  role("admin", "Admins", 8),
  role("boost", "Booster", 3, true),
  role("top", "Above bot", 11),
];

function ctx(groups: RoleGroupView[], over: Partial<AccessContext> = {}) {
  return {
    groups,
    roles,
    guildId: GUILD,
    botHighest: 10,
    viewer: { elevated: true, roleIds: [] },
    ...over,
  } as AccessContext;
}

describe("scopes and capabilities", () => {
  it("reads admin as one scope, because it implies the others", () => {
    expect(scopesOf(["admin", "staff"])).toEqual(["admin"]);
    expect(scopesOf(["admin"])).toEqual(["admin"]);
    expect(scopesOf(["staff", "host"])).toEqual(["staff", "host"]);
    expect(scopesOf([])).toEqual([]);
  });

  it("writes the admin preset's capabilities for the admin scope", () => {
    expect(capabilitiesFor(["admin"])).toEqual(["admin", "staff"]);
    expect(capabilitiesFor(["host"])).toEqual(["host"]);
    expect(capabilitiesFor(["staff", "host"])).toEqual(["staff", "host"]);
  });

  it("lists a role in its highest scope only", () => {
    expect(
      normaliseSelection({ admin: ["a"], staff: ["a", "b"], host: ["a", "a"] }),
    ).toEqual({ admin: ["a"], staff: ["b"], host: [] });
  });
});

describe("currentMapping", () => {
  it("shows each linked group once, by its highest scope", () => {
    const groups = [
      group({ id: "1", roleId: "admin", capabilities: ["admin", "staff"] }),
      group({ id: "2", roleId: "mod", capabilities: ["staff"] }),
      group({ id: "3", roleId: "host", capabilities: ["host"] }),
    ];
    expect(currentMapping(groups)).toEqual({
      admin: ["admin"],
      staff: ["mod"],
      host: ["host"],
    });
  });

  it("skips bot, gate-only, unlinked and role-less groups", () => {
    const groups = [
      group({ id: "1", roleId: "mod", capabilities: ["bot"] }),
      group({ id: "2", roleId: "boost", gateOnly: true }),
      group({
        id: "3",
        roleId: "host",
        capabilities: ["host"],
        unlinked: true,
      }),
      group({ id: "4", roleId: null, capabilities: ["staff"] }),
    ];
    expect(currentMapping(groups)).toEqual({ admin: [], staff: [], host: [] });
  });
});

describe("diffAccess", () => {
  it("creates a group for a picked role that backs none", () => {
    const [change] = diffAccess([], roles, {
      admin: [],
      staff: ["mod"],
      host: [],
    });
    expect(change).toMatchObject({
      kind: "create",
      roleId: "mod",
      groupName: "Moderator",
      capabilitiesAfter: ["staff"],
    });
  });

  it("writes nothing when the picks match the saved groups", () => {
    const groups = [
      group({ id: "1", roleId: "admin", capabilities: ["admin"] }),
      group({ id: "2", roleId: "mod", capabilities: ["staff"] }),
    ];
    expect(
      diffAccess(groups, roles, { admin: ["admin"], staff: ["mod"], host: [] }),
    ).toEqual([]);
  });

  it("leaves a bot group alone", () => {
    const groups = [
      group({ id: "1", roleId: "mod", capabilities: ["staff", "bot"] }),
    ];
    // a bot group isn't mappable, so it is left alone entirely
    expect(
      diffAccess(groups, roles, { admin: [], staff: [], host: ["mod"] }),
    ).toEqual([]);
  });

  it("removes only the scope from a role dropped from every card", () => {
    const groups = [group({ id: "1", roleId: "host", capabilities: ["host"] })];
    const [change] = diffAccess(groups, roles, {
      admin: [],
      staff: [],
      host: [],
    });
    expect(change).toMatchObject({
      kind: "update",
      groupId: "1",
      capabilitiesBefore: ["host"],
      capabilitiesAfter: [],
    });
  });

  it("moves a role between scopes with one update", () => {
    const groups = [group({ id: "1", roleId: "mod", capabilities: ["staff"] })];
    const changes = diffAccess(groups, roles, {
      admin: [],
      staff: [],
      host: ["mod"],
    });
    expect(changes).toHaveLength(1);
    expect(changes[0].capabilitiesAfter).toEqual(["host"]);
  });
});

describe("validateSelection", () => {
  const none = { admin: [], staff: [], host: [] };

  it.each([
    ["staff", ["boost"], "managed by an integration"],
    ["host", ["top"], "at or above the bot"],
    ["host", [GUILD], "@everyone"],
    ["host", ["gone"], "no longer exists"],
  ] as const)("refuses a bad %s pick %j", (scope, ids, text) => {
    expect(
      validateSelection(ctx([]), { ...none, [scope]: [...ids] }),
    ).toContain(text);
  });

  it("refuses a role behind a bot or gate-only group", () => {
    expect(
      validateSelection(
        ctx([group({ roleId: "mod", capabilities: ["bot"] })]),
        { ...none, staff: ["mod"] },
      ),
    ).toContain("bot group");
    expect(
      validateSelection(ctx([group({ roleId: "host", gateOnly: true })]), {
        ...none,
        host: ["host"],
      }),
    ).toContain("gate-only");
  });

  it("accepts a clean pick", () => {
    expect(validateSelection(ctx([]), { ...none, staff: ["mod"] })).toBeNull();
  });

  it("won't let a non-elevated admin drop the role they sign in with", () => {
    const groups = [group({ roleId: "admin", capabilities: ["admin"] })];
    const viewer = { elevated: false, roleIds: ["admin"] };
    expect(
      validateSelection(ctx(groups, { viewer }), { ...none, staff: ["mod"] }),
    ).toContain("admin role you sign in with");
    expect(
      validateSelection(ctx(groups, { viewer }), {
        ...none,
        admin: ["admin"],
      }),
    ).toBeNull();
  });

  it("lets the owner or an Administrator change the admin mapping freely", () => {
    const groups = [group({ roleId: "admin", capabilities: ["admin"] })];
    expect(
      validateSelection(
        ctx(groups, { viewer: { elevated: true, roleIds: ["admin"] } }),
        none,
      ),
    ).toBeNull();
  });
});

describe("pickableRoles", () => {
  it("offers roles below the bot, highest first, without managed or protected ones", () => {
    const picked = pickableRoles(
      ctx([group({ roleId: "host", capabilities: ["bot"] })]),
    ).map((r) => r.id);
    expect(picked).toEqual(["admin", "mod"]);
  });
});

describe("accessGaps", () => {
  const none = { admin: [], staff: [], host: [] };
  it("flags Events on with nobody to host, and Moderation with nobody to moderate", () => {
    expect(
      accessGaps(new Set(["events", "moderation"]), none).map((g) => g.message),
    ).toEqual([
      "Events is on and nobody can host yet.",
      "Moderation is on and nobody can moderate yet.",
    ]);
  });

  it("says nothing about a feature that is off", () => {
    expect(accessGaps(new Set(), none)).toEqual([]);
  });

  it("counts an admin role as someone who can run both", () => {
    expect(
      accessGaps(new Set(["events", "moderation"]), { ...none, admin: ["a"] }),
    ).toEqual([]);
  });

  it("is cleared by the matching scope only", () => {
    const gaps = accessGaps(new Set(["events", "moderation"]), {
      ...none,
      host: ["h"],
    });
    expect(gaps.map((g) => g.feature)).toEqual(["moderation"]);
  });
});

describe("ranking new groups by where their roles sit", () => {
  it("puts a new group between the groups whose roles are above and below it", () => {
    const order = orderWithNewGroups(
      ["top", "low"],
      new Map([
        ["top", 9],
        ["low", 2],
      ]),
      [{ id: "new", position: 5 }],
    );
    expect(order).toEqual(["top", "new", "low"]);
  });

  it("puts it on top or at the bottom when its role is the highest or lowest", () => {
    const positions = new Map([["a", 5]]);
    expect(
      orderWithNewGroups(["a"], positions, [{ id: "n", position: 9 }]),
    ).toEqual(["n", "a"]);
    expect(
      orderWithNewGroups(["a"], positions, [{ id: "n", position: 1 }]),
    ).toEqual(["a", "n"]);
  });

  it("leaves the next Role groups plan with no role to move", () => {
    // Moderator (5) and Event host (4) already sit in this order in Discord.
    const scanned = {
      guildId: GUILD,
      ownerId: "o",
      botUserId: "b",
      botRoleIds: [],
      botHighestRolePosition: 10,
      adminUserId: "a",
      adminRoleIds: [],
      otherBotIds: [],
      roles: roles.map((r) => ({
        ...r,
        permissions: "0",
        color: 0,
        hoist: false,
        mentionable: false,
      })),
    } as unknown as ScannedState;
    const order = orderWithNewGroups([], new Map(), [
      { id: "mod-group", position: 5 },
      { id: "host-group", position: 4 },
    ]);
    const groups = order.map((id, i) =>
      group({
        id,
        name: id,
        roleId: id === "mod-group" ? "mod" : "host",
        rank: order.length - i,
        capabilities: ["staff"],
      }),
    );
    const { desired, issues } = buildDesiredState(groups, scanned);
    expect(issues).toEqual([]);
    expect(desired.roles.filter((r) => r.position !== undefined)).toEqual([]);
  });
});

describe("applyAccessChanges and rollbackAccess", () => {
  function deps(overrides: Partial<AccessDeps["groups"]> = {}) {
    const audit = jest.fn(async () => undefined);
    let n = 0;
    const groups = {
      list: jest.fn(async () => [] as RoleGroupView[]),
      create: jest.fn(async (_g: string, input: { name: string }) => ({
        ok: true as const,
        group: group({ id: `new-${++n}`, name: input.name }),
      })),
      update: jest.fn(async () => ({ ok: true as const, group: group({}) })),
      remove: jest.fn(async () => true),
      reorder: jest.fn(async () => ({ ok: true as const })),
      ...overrides,
    } as unknown as AccessDeps["groups"];
    return { deps: { groups, audit } as AccessDeps, groups, audit };
  }

  const create = (roleId: string, name: string): AccessChange => ({
    kind: "create",
    roleId,
    roleName: name,
    groupId: null,
    groupName: name,
    scopesBefore: [],
    scopesAfter: ["host"],
    capabilitiesBefore: [],
    capabilitiesAfter: ["host"],
  });

  it("moves new groups under higher roles and can put the order back", async () => {
    const existing = [group({ id: "top", roleId: "admin", rank: 2 })];
    const { deps: d, groups } = deps();
    // after the create, the new group sits on top; its role (5) is below admin (8)
    (
      groups.list as jest.Mock<() => Promise<RoleGroupView[]>>
    ).mockResolvedValue([group({ id: "new-1" }), ...existing]);
    const res = await applyAccessChanges(d, ctx(existing), [
      create("mod", "Moderator"),
    ]);
    expect(res.ok).toBe(true);
    expect(groups.reorder).toHaveBeenCalledWith(GUILD, ["top", "new-1"]);
    if (res.ok) {
      expect(res.undo).toContainEqual({ type: "reorder", ids: ["top"] });
    }
  });

  it("undoes the groups, then the order, when ranking fails", async () => {
    const existing = [group({ id: "top", roleId: "admin", rank: 2 })];
    const {
      deps: d,
      groups,
      audit,
    } = deps({
      reorder: jest.fn(async () => {
        throw new Error("mongo down");
      }) as never,
    });
    (
      groups.list as jest.Mock<() => Promise<RoleGroupView[]>>
    ).mockResolvedValue([group({ id: "new-1" }), ...existing]);
    const res = await applyAccessChanges(d, ctx(existing), [
      create("mod", "Moderator"),
    ]);
    expect(res.ok).toBe(false);
    // The failed reorder may have half-applied, so the order is put back too.
    expect(groups.reorder).toHaveBeenCalledTimes(2);
    if (!res.ok) expect(res.stuck).toEqual(["the group order"]);
    expect(groups.remove).toHaveBeenCalledWith(GUILD, "new-1");
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "wizard.access.reorder",
        result: "failure",
      }),
    );
  });

  it("rolls back in reverse and reports a step that cannot be undone", async () => {
    const { deps: d, groups } = deps({
      remove: jest
        .fn()
        .mockResolvedValueOnce(true as never)
        .mockRejectedValueOnce(new Error("still down") as never) as never,
    });
    const back = await rollbackAccess(d, GUILD, [
      { type: "remove", groupId: "a", groupName: "A" },
      { type: "remove", groupId: "b", groupName: "B" },
    ]);
    expect((groups.remove as jest.Mock).mock.calls.map((c) => c[1])).toEqual([
      "b",
      "a",
    ]);
    expect(back).toEqual({ restored: 1, stuck: ['"A"'] });
  });

  it("treats a group that was already gone as an undo that failed", async () => {
    const { deps: d } = deps({ remove: jest.fn(async () => false) as never });
    const back = await rollbackAccess(d, GUILD, [
      { type: "remove", groupId: "a", groupName: "A" },
    ]);
    expect(back.stuck).toEqual(['"A"']);
  });
});
