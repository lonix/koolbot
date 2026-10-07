import { describe, it, expect } from "@jest/globals";
import { PermissionsBitField } from "discord.js";
import {
  planAdoption,
  isApplicable,
  type ScannedState,
  type ChannelState,
  type DesiredState,
  type RoleState,
} from "../../src/services/server-adoption-planner.js";

const F = PermissionsBitField.Flags;
const VIEW = F.ViewChannel.toString();
const ADMIN = F.Administrator.toString();

const role = (over: Partial<RoleState> & { id: string }): RoleState => ({
  name: over.id,
  color: 0,
  permissions: "0",
  position: 1,
  managed: false,
  ...over,
});

const channel = (
  over: Partial<ChannelState> & { id: string },
): ChannelState => ({
  name: over.id,
  kind: "text",
  parentId: null,
  position: 0,
  topic: null,
  overwrites: [],
  voiceMemberCount: 0,
  ...over,
});

function scan(over: Partial<ScannedState> = {}): ScannedState {
  return {
    guildId: "g1",
    ownerId: "owner",
    botUserId: "bot",
    botRoleIds: ["botrole"],
    botHighestRolePosition: 10,
    adminUserId: "admin",
    adminRoleIds: ["staff"],
    otherBotIds: ["otherbot"],
    roles: [
      role({ id: "g1", name: "@everyone", permissions: VIEW, position: 0 }),
      role({
        id: "botrole",
        name: "KoolBot",
        permissions: ADMIN,
        position: 10,
        managed: true,
      }),
      role({ id: "staff", name: "Staff", permissions: "0", position: 5 }),
      role({ id: "member", name: "Member", position: 3 }),
      role({ id: "high", name: "High", position: 11 }),
      role({ id: "integ", name: "Integration", position: 2, managed: true }),
    ],
    channels: [
      channel({ id: "cat", name: "Cat", kind: "category" }),
      channel({ id: "chat", name: "chat", parentId: "cat" }),
    ],
    config: {},
    boundChannelIds: [],
    koolbotCreatedIds: [],
    ...over,
  };
}

const codes = (p: { errors: Array<{ code: string }> }) =>
  p.errors.map((e) => e.code);
const approval = (
  kind: "channel.delete" | "role.delete" | "overwrite.remove",
  targetId: string,
) => ({
  kind,
  targetId,
  approvedBy: "admin",
  approvedAt: "2026-10-01T10:00:00Z",
});

describe("planAdoption: planning and ordering", () => {
  it("orders roles → categories → channels → members → config", () => {
    const desired: DesiredState = {
      roles: [{ name: "New", permissions: "0" }],
      overwrites: [
        {
          channelId: "chat",
          target: { roleName: "New" },
          allow: VIEW,
          deny: "0",
        },
        {
          channelId: "cat",
          target: { roleName: "New" },
          allow: VIEW,
          deny: "0",
        },
      ],
      memberGrants: [{ role: { roleName: "New" }, memberIds: ["a", "b"] }],
      config: { "adoption.snapshot.retention_days": 30 },
    };
    const plan = planAdoption(scan(), desired);
    expect(plan.errors).toEqual([]);
    expect(plan.operations.map((o) => o.type)).toEqual([
      "role.create",
      "overwrite.set",
      "overwrite.set",
      "member.role.add",
      "config.set",
    ]);
    const sets = plan.operations.filter((o) => o.type === "overwrite.set");
    expect(sets.map((o) => (o as { channelId: string }).channelId)).toEqual([
      "cat",
      "chat",
    ]);
    expect(plan.operations.map((o) => o.id)).toEqual([
      "op-1",
      "op-2",
      "op-3",
      "op-4",
      "op-5",
    ]);
  });

  it("is idempotent: planning against an already-applied state gives an empty plan", () => {
    const state = scan({
      roles: [
        ...scan().roles,
        role({
          id: "new",
          name: "New",
          color: 5,
          permissions: VIEW,
          position: 2,
        }),
      ],
      channels: [
        channel({
          id: "chat",
          overwrites: [{ id: "new", type: "role", allow: VIEW, deny: "0" }],
        }),
      ],
      config: { "adoption.snapshot.retention_days": 30 },
      memberRoles: { a: ["new"] },
    });
    const desired: DesiredState = {
      roles: [{ name: "New", color: 5, permissions: VIEW, position: 2 }],
      overwrites: [
        {
          channelId: "chat",
          target: { roleName: "New" },
          allow: VIEW,
          deny: "0",
        },
      ],
      memberGrants: [{ role: { roleName: "New" }, memberIds: ["a"] }],
      config: { "adoption.snapshot.retention_days": 30 },
      deletions: [{ kind: "channel", id: "gone" }],
      overwriteRemovals: [{ channelId: "chat", targetId: "nobody" }],
    };
    const plan = planAdoption(state, desired);
    expect(plan.operations).toEqual([]);
    expect(plan.errors).toEqual([]);
  });

  it("is deterministic: the same inputs give the same plan id", () => {
    const desired: DesiredState = { roles: [{ name: "New" }] };
    expect(planAdoption(scan(), desired).id).toBe(
      planAdoption(scan(), desired).id,
    );
  });

  it("summarises member grants as counts with a sample", () => {
    const ids = Array.from({ length: 5000 }, (_, i) => `m${i}`);
    const started = Date.now();
    const plan = planAdoption(scan({ memberRoles: { m0: ["member"] } }), {
      memberGrants: [{ role: { id: "member" }, memberIds: ids }],
    });
    expect(Date.now() - started).toBeLessThan(2000);
    const op = plan.operations[0] as {
      memberCount: number;
      sample: string[];
      memberIds: string[];
    };
    expect(op.memberCount).toBe(4999);
    expect(op.sample).toHaveLength(5);
    expect(op.memberIds).not.toContain("m0");
  });

  it("rejects unknown config keys, channels and roles", () => {
    const plan = planAdoption(scan(), {
      config: { "nope.key": 1 },
      overwrites: [
        {
          channelId: "missing",
          target: { id: "member" },
          allow: VIEW,
          deny: "0",
        },
        {
          channelId: "chat",
          target: { roleName: "Ghost" },
          allow: VIEW,
          deny: "0",
        },
      ],
    });
    expect(codes(plan).sort()).toEqual([
      "unknown-channel",
      "unknown-config-key",
      "unknown-role",
    ]);
  });
});

describe("planAdoption: safety rules", () => {
  it("blocks editing managed roles and roles at or above the bot's highest", () => {
    const plan = planAdoption(scan(), {
      roles: [
        { id: "integ", name: "Integration", color: 9 },
        { id: "high", name: "High", color: 9 },
      ],
    });
    expect(codes(plan)).toEqual(["role-protected", "role-protected"]);
    expect(isApplicable(plan)).toBe(false);
  });

  it("blocks moving a role to or above the bot's highest, and creating there", () => {
    const plan = planAdoption(scan(), {
      roles: [
        { id: "member", name: "Member", position: 10 },
        { name: "Fresh", position: 12 },
      ],
    });
    expect(codes(plan)).toEqual(["role-position", "role-position"]);
  });

  it("blocks granting permissions the bot does not hold", () => {
    const limited = scan({
      roles: scan().roles.map((r) =>
        r.id === "botrole"
          ? {
              ...r,
              permissions: (
                F.ViewChannel |
                F.ManageRoles |
                F.ManageChannels
              ).toString(),
            }
          : r,
      ),
    });
    const plan = planAdoption(limited, {
      roles: [{ name: "Mod", permissions: F.BanMembers.toString() }],
    });
    expect(codes(plan)).toEqual(["bot-lacks-permission"]);
  });

  it("blocks a change that removes the invoking admin's own access", () => {
    const state = scan({
      roles: scan().roles.map((r) =>
        r.id === "g1" ? { ...r, permissions: "0" } : r,
      ),
      channels: [
        channel({
          id: "chat",
          overwrites: [{ id: "staff", type: "role", allow: VIEW, deny: "0" }],
        }),
      ],
    });
    const plan = planAdoption(state, {
      overwrites: [
        { channelId: "chat", target: { id: "staff" }, allow: "0", deny: VIEW },
      ],
    });
    expect(codes(plan)).toEqual(["admin-access-lost"]);
  });

  it("blocks removing Administrator from the admin's only admin role", () => {
    const state = scan({
      roles: scan().roles.map((r) =>
        r.id === "staff" ? { ...r, permissions: ADMIN } : r,
      ),
    });
    const plan = planAdoption(state, {
      roles: [{ id: "staff", name: "Staff", permissions: "0" }],
    });
    expect(codes(plan)).toContain("admin-access-lost");
  });

  it("does not flag the guild owner, who bypasses overwrites", () => {
    const state = scan({ adminUserId: "owner", ownerId: "owner" });
    const plan = planAdoption(state, {
      overwrites: [
        { channelId: "chat", target: { id: "g1" }, allow: "0", deny: VIEW },
      ],
    });
    expect(codes(plan)).toEqual([]);
  });

  it("blocks locking the bot out of a channel a feature needs", () => {
    const state = scan({
      roles: scan().roles.map((r) =>
        r.id === "botrole"
          ? {
              ...r,
              permissions: (
                F.ViewChannel |
                F.ManageRoles |
                F.ManageChannels
              ).toString(),
            }
          : r,
      ),
    });
    const plan = planAdoption(state, {
      overwrites: [
        {
          channelId: "chat",
          target: { id: "botrole" },
          allow: "0",
          deny: VIEW,
        },
      ],
      featureChannels: [{ channelId: "chat", feature: "quotes" }],
    });
    expect(codes(plan)).toEqual(["bot-lockout"]);
  });

  it("blocks touching another bot's overwrites unless the caller opts in", () => {
    const state = scan({
      channels: [
        channel({
          id: "chat",
          overwrites: [
            { id: "otherbot", type: "member", allow: VIEW, deny: "0" },
          ],
        }),
      ],
    });
    const desired: DesiredState = {
      overwrites: [
        {
          channelId: "chat",
          target: { id: "otherbot" },
          targetType: "member",
          allow: "0",
          deny: VIEW,
        },
      ],
    };
    expect(codes(planAdoption(state, desired))).toEqual([
      "other-bot-overwrite",
    ]);
    expect(
      codes(planAdoption(state, desired, { allowOtherBotOverwrites: true })),
    ).toEqual([]);
    const managedTarget = planAdoption(state, {
      overwrites: [
        { channelId: "chat", target: { id: "integ" }, allow: VIEW, deny: "0" },
      ],
    });
    expect(codes(managedTarget)).toEqual(["other-bot-overwrite"]);
  });

  it("leaves untouched overwrites (including other bots') alone", () => {
    const state = scan({
      channels: [
        channel({
          id: "chat",
          overwrites: [
            { id: "otherbot", type: "member", allow: VIEW, deny: "0" },
          ],
        }),
      ],
    });
    const plan = planAdoption(state, {
      overwrites: [
        { channelId: "chat", target: { id: "member" }, allow: VIEW, deny: "0" },
      ],
    });
    expect(plan.errors).toEqual([]);
    expect(plan.operations).toHaveLength(1);
  });
});

describe("planAdoption: destructive operations", () => {
  const state = () =>
    scan({
      channels: [
        channel({
          id: "old",
          name: "old",
          overwrites: [{ id: "member", type: "role", allow: VIEW, deny: "0" }],
        }),
        channel({
          id: "chat",
          overwrites: [{ id: "member", type: "role", allow: VIEW, deny: "0" }],
        }),
      ],
    });

  it("rejects an unapproved destructive operation as an error", () => {
    const plan = planAdoption(state(), {
      deletions: [
        { kind: "channel", id: "old" },
        { kind: "role", id: "member" },
      ],
      overwriteRemovals: [{ channelId: "chat", targetId: "member" }],
    });
    expect(codes(plan)).toEqual([
      "approval-required",
      "approval-required",
      "approval-required",
    ]);
    expect(plan.operations).toEqual([]);
  });

  it("requires the approval to name the exact target and carry who/when", () => {
    const wrongTarget = planAdoption(state(), {
      deletions: [{ kind: "channel", id: "old" }],
      approvals: [approval("channel.delete", "chat")],
    });
    expect(codes(wrongTarget)).toEqual(["approval-required"]);
    const noWho = planAdoption(state(), {
      deletions: [{ kind: "channel", id: "old" }],
      approvals: [{ ...approval("channel.delete", "old"), approvedBy: "" }],
    });
    expect(codes(noWho)).toEqual(["approval-required"]);
    const badKind = planAdoption(state(), {
      deletions: [{ kind: "channel", id: "old" }],
      approvals: [approval("role.delete", "old")],
    });
    expect(codes(badKind)).toEqual(["approval-required"]);
  });

  it("accepts approved destructive operations and orders them last", () => {
    const plan = planAdoption(state(), {
      config: { "adoption.snapshot.retention_days": 5 },
      roles: [{ name: "New" }],
      deletions: [
        { kind: "channel", id: "old" },
        { kind: "role", id: "member" },
      ],
      overwriteRemovals: [{ channelId: "chat", targetId: "member" }],
      approvals: [
        approval("channel.delete", "old"),
        approval("role.delete", "member"),
        approval("overwrite.remove", "chat:member"),
      ],
    });
    expect(plan.errors).toEqual([]);
    const classes = plan.operations.map((o) => o.class);
    expect(classes).toEqual([
      "additive",
      "additive",
      "destructive",
      "destructive",
      "destructive",
    ]);
    expect(plan.operations.at(-1)?.type).toBeDefined();
    const del = plan.operations.find((o) => o.type === "channel.delete");
    expect(del && "approval" in del && del.approval?.approvedBy).toBe("admin");
  });

  it("snapshots the structure of what is about to be deleted", () => {
    const plan = planAdoption(state(), {
      deletions: [
        { kind: "channel", id: "old" },
        { kind: "role", id: "member" },
      ],
      approvals: [
        approval("channel.delete", "old"),
        approval("role.delete", "member"),
      ],
    });
    expect(plan.baseline.channels.map((c) => c.id).sort()).toEqual([
      "chat",
      "old",
    ]);
    expect(
      plan.baseline.channels.find((c) => c.id === "old")!.overwrites,
    ).toHaveLength(1);
    expect(plan.baseline.roles.map((r) => r.id)).toEqual(["member"]);
  });

  it("always rejects: managed roles, the bot's roles, @everyone and roles above the bot — even with approval", () => {
    const plan = planAdoption(scan(), {
      deletions: [
        { kind: "role", id: "integ" },
        { kind: "role", id: "botrole" },
        { kind: "role", id: "g1" },
        { kind: "role", id: "high" },
      ],
      approvals: ["integ", "botrole", "g1", "high"].map((id) =>
        approval("role.delete", id),
      ),
    });
    expect(codes(plan)).toEqual([
      "role-protected",
      "role-protected",
      "role-protected",
      "role-protected",
    ]);
    expect(plan.operations).toEqual([]);
  });

  it("always rejects: deleting channels in use, even with approval", () => {
    const busy = scan({
      boundChannelIds: ["bound"],
      channels: [
        channel({ id: "bound" }),
        channel({ id: "voice", kind: "voice", voiceMemberCount: 2 }),
        channel({ id: "needed" }),
      ],
    });
    const plan = planAdoption(busy, {
      deletions: ["bound", "voice", "needed"].map((id) => ({
        kind: "channel" as const,
        id,
      })),
      featureChannels: [{ channelId: "needed", feature: "quotes" }],
      approvals: ["bound", "voice", "needed"].map((id) =>
        approval("channel.delete", id),
      ),
    });
    expect(codes(plan)).toEqual([
      "channel-in-use",
      "channel-in-use",
      "channel-in-use",
    ]);
  });

  it("always rejects: removing an overwrite that cuts the admin off, even with approval", () => {
    const state2 = scan({
      roles: scan().roles.map((r) =>
        r.id === "g1" ? { ...r, permissions: "0" } : r,
      ),
      channels: [
        channel({
          id: "chat",
          overwrites: [{ id: "staff", type: "role", allow: VIEW, deny: "0" }],
        }),
      ],
    });
    const plan = planAdoption(state2, {
      overwriteRemovals: [{ channelId: "chat", targetId: "staff" }],
      approvals: [approval("overwrite.remove", "chat:staff")],
    });
    expect(codes(plan)).toEqual(["admin-access-lost"]);
  });

  it("lets KoolBot delete what it created itself without approval", () => {
    const ours = scan({
      koolbotCreatedIds: ["ours"],
      channels: [channel({ id: "ours" })],
      roles: [
        ...scan().roles,
        role({ id: "myrole", name: "Mine", position: 2 }),
      ],
    });
    ours.koolbotCreatedIds.push("myrole");
    const plan = planAdoption(ours, {
      deletions: [
        { kind: "channel", id: "ours" },
        { kind: "role", id: "myrole" },
      ],
    });
    expect(plan.errors).toEqual([]);
    expect(plan.operations.map((o) => o.type)).toEqual([
      "channel.delete",
      "role.delete",
    ]);
  });
});

describe("planAdoption: review hardening", () => {
  it("only accepts approvals made by the applying admin", () => {
    const state = scan({ channels: [channel({ id: "old" })] });
    const desired: DesiredState = {
      deletions: [{ kind: "channel", id: "old" }],
      approvals: [
        { ...approval("channel.delete", "old"), approvedBy: "someone-else" },
      ],
    };
    expect(codes(planAdoption(state, desired))).toEqual(["approval-required"]);
    expect(
      codes(planAdoption(state, desired, { approverId: "someone-else" })),
    ).toEqual([]);
  });

  it("rejects member grants to unknown, managed or above-bot roles", () => {
    const plan = planAdoption(scan(), {
      memberGrants: [
        { role: { id: "ghost" }, memberIds: ["a"] },
        { role: { id: "integ" }, memberIds: ["a"] },
        { role: { id: "high" }, memberIds: ["a"] },
      ],
    });
    expect(codes(plan)).toEqual([
      "unknown-role",
      "role-protected",
      "role-protected",
    ]);
  });

  it("snapshots channels whose overwrites a deleted role takes with it", () => {
    const state = scan({
      channels: [
        channel({
          id: "chat",
          overwrites: [{ id: "member", type: "role", allow: VIEW, deny: "0" }],
        }),
        channel({ id: "other" }),
      ],
    });
    const plan = planAdoption(state, {
      deletions: [{ kind: "role", id: "member" }],
      approvals: [approval("role.delete", "member")],
    });
    expect(plan.errors).toEqual([]);
    expect(plan.baseline.channels.map((c) => c.id)).toEqual(["chat"]);
  });
});

describe("planAdoption: bot management permissions", () => {
  const limited = (perms: bigint) =>
    scan({
      roles: scan().roles.map((r) =>
        r.id === "botrole" ? { ...r, permissions: perms.toString() } : r,
      ),
    });

  it("requires Manage Roles for role and member operations", () => {
    const plan = planAdoption(limited(F.ManageChannels), {
      roles: [{ name: "New" }],
    });
    expect(codes(plan)).toEqual(["bot-lacks-permission"]);
    expect(plan.errors[0].message).toMatch(/Manage Roles/);
    expect(
      codes(planAdoption(limited(F.ManageRoles), { roles: [{ name: "New" }] })),
    ).toEqual([]);
  });

  it("requires Manage Roles (not Manage Channels) for overwrites, Manage Channels for deletes", () => {
    const desired: DesiredState = {
      overwrites: [
        { channelId: "chat", target: { id: "member" }, allow: VIEW, deny: "0" },
      ],
    };
    const noRoles = planAdoption(
      limited(F.ManageChannels | F.ViewChannel),
      desired,
    );
    expect(noRoles.errors.map((e) => e.message).join()).toMatch(/Manage Roles/);
    expect(
      codes(planAdoption(limited(F.ManageRoles | F.ViewChannel), desired)),
    ).toEqual([]);
    const del: DesiredState = {
      deletions: [{ kind: "channel", id: "chat" }],
      approvals: [approval("channel.delete", "chat")],
    };
    const noChannels = planAdoption(
      limited(F.ManageRoles | F.ViewChannel),
      del,
    );
    expect(noChannels.errors.map((e) => e.message).join()).toMatch(
      /Manage Channels/,
    );
    expect(
      codes(planAdoption(limited(F.ManageChannels | F.ViewChannel), del)),
    ).toEqual([]);
  });
});

describe("planAdoption: input validation and conflicts", () => {
  it("rejects malformed permission bitfields instead of coercing them", () => {
    const plan = planAdoption(scan(), {
      roles: [
        { name: "Bad", permissions: "not-a-number" },
        { id: "member", name: "Member", permissions: "-5" },
      ],
      overwrites: [
        {
          channelId: "chat",
          target: { id: "member" },
          allow: "12abc",
          deny: "0",
        },
        {
          channelId: "chat",
          target: { id: "staff" },
          allow: "0",
          deny: "99999999999999999999999",
        },
      ],
    });
    expect(codes(plan)).toEqual([
      "invalid-permissions",
      "invalid-permissions",
      "invalid-permissions",
      "invalid-permissions",
    ]);
    expect(plan.operations).toEqual([]);
  });

  it("validates config values against the setting's type and constraints", () => {
    const plan = planAdoption(scan(), {
      config: {
        "adoption.snapshot.retention_days": -3,
        "voicechannels.enabled": "yes" as never,
        "core.web_audit.retention_days": Number.NaN,
      },
    });
    expect(codes(plan)).toEqual([
      "invalid-config-value",
      "invalid-config-value",
      "invalid-config-value",
    ]);
    expect(
      planAdoption(scan(), {
        config: { "adoption.snapshot.retention_days": 0 },
      }).errors,
    ).toEqual([]);
  });

  it("treats an overwrite removal on a channel being deleted as redundant", () => {
    const state = scan({
      channels: [
        channel({
          id: "old",
          overwrites: [{ id: "member", type: "role", allow: VIEW, deny: "0" }],
        }),
      ],
    });
    const plan = planAdoption(state, {
      deletions: [{ kind: "channel", id: "old" }],
      overwriteRemovals: [{ channelId: "old", targetId: "member" }],
      approvals: [approval("channel.delete", "old")],
    });
    expect(plan.errors).toEqual([]);
    expect(plan.operations.map((o) => o.type)).toEqual(["channel.delete"]);
  });

  it("snapshots a deleted category's children", () => {
    const state = scan({
      channels: [
        channel({ id: "cat", kind: "category" }),
        channel({ id: "kid", parentId: "cat" }),
        channel({ id: "other" }),
      ],
    });
    const plan = planAdoption(state, {
      deletions: [{ kind: "channel", id: "cat" }],
      approvals: [approval("channel.delete", "cat")],
    });
    expect(plan.baseline.channels.map((c) => c.id).sort()).toEqual([
      "cat",
      "kid",
    ]);
  });
});

describe("planAdoption: review hardening, round five", () => {
  it("does not let a KoolBot-created role exempt removing someone else's overwrite", () => {
    const state = scan({
      koolbotCreatedIds: ["member"],
      channels: [
        channel({
          id: "chat",
          overwrites: [{ id: "member", type: "role", allow: VIEW, deny: "0" }],
        }),
      ],
    });
    const plan = planAdoption(state, {
      overwriteRemovals: [{ channelId: "chat", targetId: "member" }],
    });
    expect(codes(plan)).toEqual(["approval-required"]);
  });

  it("resolves a role by the name it is renamed to", () => {
    const plan = planAdoption(scan(), {
      roles: [{ id: "member", name: "Regulars" }],
      overwrites: [
        {
          channelId: "chat",
          target: { roleName: "Regulars" },
          allow: VIEW,
          deny: "0",
        },
      ],
    });
    expect(plan.errors).toEqual([]);
    expect(plan.operations.map((o) => o.type)).toEqual([
      "role.edit",
      "overwrite.set",
    ]);
  });

  it("applies the settings write rules: cron syntax, length, exact type", () => {
    const plan = planAdoption(scan(), {
      config: {
        "digest.cron": "not a cron",
        "voicechannels.channel.prefix": "x".repeat(5000),
      },
    });
    expect(codes(plan)).toEqual([
      "invalid-config-value",
      "invalid-config-value",
    ]);
    const ok = planAdoption(scan(), {
      config: { "digest.cron": "0 9 * * 1" },
    });
    expect(ok.errors).toEqual([]);
    expect(ok.operations).toHaveLength(1);
  });

  it("computes a stable content hash that changes with the plan", async () => {
    const { computePlanId } =
      await import("../../src/services/server-adoption-planner.js");
    const p = planAdoption(scan(), { roles: [{ name: "New" }] });
    expect(computePlanId(p)).toBe(p.id);
    expect(computePlanId({ ...p, plannedBy: "someone" })).not.toBe(p.id);
  });
});

describe("planAdoption: review hardening, round six", () => {
  it("changes the plan id when blocking errors are removed", async () => {
    const { computePlanId } =
      await import("../../src/services/server-adoption-planner.js");
    const blocked = planAdoption(scan(), {
      roles: [{ id: "high", name: "High", color: 9 }],
    });
    expect(blocked.errors.length).toBeGreaterThan(0);
    expect(computePlanId({ ...blocked, errors: [] })).not.toBe(blocked.id);
  });

  it("rejects an overwrite for a role id that does not exist, but allows member targets", () => {
    const plan = planAdoption(scan(), {
      overwrites: [
        {
          channelId: "chat",
          target: { id: "ghost-role" },
          allow: VIEW,
          deny: "0",
        },
        {
          channelId: "chat",
          target: { id: "some-user" },
          targetType: "member",
          allow: VIEW,
          deny: "0",
        },
      ],
    });
    expect(codes(plan)).toEqual(["unknown-role"]);
    expect(plan.operations).toHaveLength(1);
  });

  it("blocks allowing permissions the bot does not hold", () => {
    const limited = scan({
      roles: scan().roles.map((r) =>
        r.id === "botrole"
          ? { ...r, permissions: (F.ViewChannel | F.ManageRoles).toString() }
          : r,
      ),
    });
    const plan = planAdoption(limited, {
      overwrites: [
        {
          channelId: "chat",
          target: { id: "member" },
          allow: F.BanMembers.toString(),
          deny: "0",
        },
      ],
    });
    expect(codes(plan)).toEqual(["bot-lacks-permission"]);
  });
});

describe("planAdoption: role identity", () => {
  const dupes = () =>
    scan({
      roles: [
        ...scan().roles,
        role({ id: "dup-a", name: "Mods", position: 2 }),
        role({ id: "dup-b", name: "mods", position: 2 }),
      ],
    });

  it("blocks an ambiguous role name instead of picking one", () => {
    const plan = planAdoption(dupes(), {
      roles: [{ name: "Mods", color: 3 }],
      overwrites: [
        {
          channelId: "chat",
          target: { roleName: "MODS" },
          allow: VIEW,
          deny: "0",
        },
      ],
      memberGrants: [{ role: { roleName: "Mods" }, memberIds: ["a"] }],
    });
    expect(codes(plan)).toEqual([
      "ambiguous-role",
      "ambiguous-role",
      "ambiguous-role",
    ]);
    expect(plan.operations).toEqual([]);
  });

  it("accepts a duplicated name when the role is given by id", () => {
    const plan = planAdoption(dupes(), {
      roles: [{ id: "dup-a", name: "Mods", color: 3 }],
    });
    expect(plan.errors).toEqual([]);
    expect(plan.operations).toHaveLength(1);
  });

  it("does not fall back to the name when an explicit role id is missing", () => {
    const plan = planAdoption(scan(), {
      roles: [{ id: "ghost", name: "Member", color: 3 }],
    });
    expect(codes(plan)).toEqual(["unknown-role"]);
    expect(plan.operations).toEqual([]);
  });
});

describe("planAdoption: duplicate creates and grant baselines", () => {
  it("rejects two new roles whose names normalise to the same ref", () => {
    const plan = planAdoption(scan(), {
      roles: [{ name: "Newcomers" }, { name: " newcomers " }],
    });
    expect(codes(plan)).toEqual(["duplicate-role"]);
    expect(
      plan.operations.filter((o) => o.type === "role.create"),
    ).toHaveLength(1);
  });

  it("snapshots an existing role that is only granted to members", () => {
    const plan = planAdoption(scan(), {
      memberGrants: [{ role: { id: "member" }, memberIds: ["a"] }],
    });
    expect(plan.baseline.roles.map((r) => r.id)).toEqual(["member"]);
  });
});
