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
        r.id === "botrole" ? { ...r, permissions: VIEW } : r,
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
        r.id === "botrole" ? { ...r, permissions: VIEW } : r,
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
        channel({ id: "chat" }),
      ],
    });

  it("rejects an unapproved destructive operation as an error", () => {
    const plan = planAdoption(state(), {
      deletions: [
        { kind: "channel", id: "old" },
        { kind: "role", id: "member" },
      ],
      overwriteRemovals: [{ channelId: "old", targetId: "member" }],
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
      overwriteRemovals: [{ channelId: "old", targetId: "member" }],
      approvals: [
        approval("channel.delete", "old"),
        approval("role.delete", "member"),
        approval("overwrite.remove", "old:member"),
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
    expect(plan.baseline.channels.map((c) => c.id)).toEqual(["old"]);
    expect(plan.baseline.channels[0].overwrites).toHaveLength(1);
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
