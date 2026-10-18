import { describe, it, expect } from "@jest/globals";
import { OverwriteType, PermissionFlagsBits } from "discord.js";
import {
  LEADS_BOT_PERMISSIONS,
  LEADS_HOST_PERMISSIONS,
  LEADS_LEADER_PERMISSIONS,
  buildLeadsOverwrites,
  desiredMembers,
  leadsLeaderIds,
  planLeadsEviction,
  planLeadsSync,
  revokedUserIds,
  type LeadsAccessContext,
  type OverwriteSpec,
} from "../../src/services/event-leads-access.js";

const V = PermissionFlagsBits.ViewChannel;
const C = PermissionFlagsBits.Connect;
const S = PermissionFlagsBits.Speak;
const M = PermissionFlagsBits.MoveMembers;

const GUILD = "g1";
const HOST = "host";
const BOT = "bot";

const ctx = (over: Partial<LeadsAccessContext> = {}): LeadsAccessContext => ({
  everyoneId: GUILD,
  hostId: HOST,
  botId: BOT,
  leaderIds: ["l1"],
  adminRoleIds: new Set(),
  ...over,
});
const role = (id: string, allow = 0n, deny = 0n): OverwriteSpec => ({
  id,
  type: OverwriteType.Role,
  allow,
  deny,
});
const member = (id: string, allow = 0n, deny = 0n): OverwriteSpec => ({
  id,
  type: OverwriteType.Member,
  allow,
  deny,
});
const find = (specs: OverwriteSpec[], type: OverwriteType, id: string) =>
  specs.find((s) => s.type === type && s.id === id);

describe("buildLeadsOverwrites", () => {
  it("denies Connect to @everyone, keeps View, and gives the host, leaders and bot their bits", () => {
    const out = buildLeadsOverwrites([], ctx());
    const everyone = find(out, OverwriteType.Role, GUILD);
    expect(everyone?.deny & C).toBe(C);
    expect(everyone?.allow & V).toBe(V);
    expect(everyone?.allow & C).toBe(0n);
    expect(find(out, OverwriteType.Member, HOST)).toMatchObject({
      allow: LEADS_HOST_PERMISSIONS,
      deny: 0n,
    });
    expect(find(out, OverwriteType.Member, "l1")).toMatchObject({
      allow: LEADS_LEADER_PERMISSIONS,
      deny: 0n,
    });
    expect(find(out, OverwriteType.Member, BOT)).toMatchObject({
      allow: LEADS_BOT_PERMISSIONS,
      deny: 0n,
    });
    // The bot's entry is what lets it connect to move people in.
    expect((LEADS_BOT_PERMISSIONS & (C | M | V)) === (C | M | V)).toBe(true);
  });

  it("copies the category's overwrites first (a private category stays private)", () => {
    const out = buildLeadsOverwrites(
      [role(GUILD, 0n, V), role("staff", V, 0n), member("x", 0n, S)],
      ctx(),
    );
    // The category hides the channel from @everyone: that is never lifted.
    const everyone = find(out, OverwriteType.Role, GUILD);
    expect(everyone?.deny & V).toBe(V);
    expect(everyone?.allow & V).toBe(0n);
    expect(everyone?.deny & C).toBe(C);
    expect(find(out, OverwriteType.Role, "staff")?.allow).toBe(V);
    expect(find(out, OverwriteType.Member, "x")).toMatchObject({ deny: S });
  });

  it("removes Connect and Speak from the allow of copied roles, adding no deny", () => {
    const out = buildLeadsOverwrites(
      [role("verified", V | C | S, 0n), role("admins", V | C, 0n)],
      ctx({ adminRoleIds: new Set(["admins"]) }),
    );
    // A role allow would defeat @everyone's deny (roles apply after it).
    expect(find(out, OverwriteType.Role, "verified")).toMatchObject({
      allow: V,
      deny: 0n,
    });
    // An Administrator role is left exactly as it is.
    expect(find(out, OverwriteType.Role, "admins")).toMatchObject({
      allow: V | C,
      deny: 0n,
    });
  });

  it("never adds a deny for anyone but @everyone", () => {
    const out = buildLeadsOverwrites(
      [role("r", C, 0n), member("m", C | V, 0n)],
      ctx(),
    );
    for (const o of out) {
      if (o.type === OverwriteType.Role && o.id === GUILD) continue;
      expect(o.deny & (C | S)).toBe(0n);
    }
  });

  it("strips the granted bits from a copied member entry that is not the host, bot or a leader, and drops it when empty", () => {
    const out = buildLeadsOverwrites(
      [member("old", V | C | S, 0n), member("keepdeny", C, S)],
      ctx(),
    );
    expect(find(out, OverwriteType.Member, "old")).toBeUndefined();
    expect(find(out, OverwriteType.Member, "keepdeny")).toMatchObject({
      allow: 0n,
      deny: S,
    });
  });

  it("widens the host's own entry from the category instead of replacing it", () => {
    const out = buildLeadsOverwrites([member(HOST, 0n, C | S)], ctx());
    const host = find(out, OverwriteType.Member, HOST);
    expect(host?.allow).toBe(LEADS_HOST_PERMISSIONS);
    expect(host?.deny & (C | S)).toBe(0n);
  });

  it("leaves out a host that is not a Discord user and a bot that is unknown", () => {
    const out = buildLeadsOverwrites([], ctx({ hostId: null, botId: null }));
    expect(
      out.filter((o) => o.type === OverwriteType.Member).map((o) => o.id),
    ).toEqual(["l1"]);
  });
});

describe("planLeadsSync", () => {
  const right = (): OverwriteSpec[] =>
    buildLeadsOverwrites([], ctx({ leaderIds: ["l1", "l2"] }));

  it("is empty for a channel that is already right", () => {
    expect(planLeadsSync(right(), ctx({ leaderIds: ["l1", "l2"] }))).toEqual(
      [],
    );
  });

  it("grants a new leader with one put, and nothing else", () => {
    const ops = planLeadsSync(right(), ctx({ leaderIds: ["l1", "l2", "l3"] }));
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: "put",
      revoke: false,
      spec: {
        id: "l3",
        type: OverwriteType.Member,
        allow: LEADS_LEADER_PERMISSIONS,
      },
    });
  });

  it("deletes the entry of a leader who lost the role, revokes first", () => {
    const ops = planLeadsSync(right(), ctx({ leaderIds: ["l3"] }));
    expect(ops.map((o) => [o.kind, o.revoke])).toEqual([
      ["delete", true],
      ["delete", true],
      ["put", false],
    ]);
    expect(revokedUserIds(ops).sort()).toEqual(["l1", "l2"]);
  });

  it("rewrites instead of deleting when the entry holds something else", () => {
    const current = [...right(), member("old", V | C | S, M)];
    const ops = planLeadsSync(current, ctx({ leaderIds: ["l1", "l2"] }));
    expect(ops).toEqual([
      {
        kind: "put",
        revoke: true,
        spec: { id: "old", type: OverwriteType.Member, allow: 0n, deny: M },
      },
    ]);
  });

  it("restores a Connect deny that someone removed from @everyone", () => {
    const current = right().map((o) =>
      o.id === GUILD ? { ...o, deny: 0n } : o,
    );
    const ops = planLeadsSync(current, ctx({ leaderIds: ["l1", "l2"] }));
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: "put", spec: { id: GUILD } });
  });

  it("strips role allows on every pass, also when @everyone already denies Connect", () => {
    // A pre-existing or degraded channel can have the deny together with a
    // normal role's allow: the deny does not prove the clean-up ran.
    const current = [
      ...right().filter(
        (o) => o.type === OverwriteType.Member || o.id === GUILD,
      ),
      role("verified", V | C | S, 0n),
    ];
    const ops = planLeadsSync(current, ctx({ leaderIds: ["l1", "l2"] }));
    expect(ops).toEqual([
      {
        kind: "put",
        revoke: true,
        spec: { id: "verified", type: OverwriteType.Role, allow: V, deny: 0n },
      },
    ]);
  });

  it("repairs a missing View allow on @everyone when Connect is already denied, never lifting a View deny", () => {
    const noView = right().map((o) =>
      o.id === GUILD ? { ...o, allow: 0n, deny: C } : o,
    );
    const ops = planLeadsSync(noView, ctx({ leaderIds: ["l1", "l2"] }));
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: "put",
      spec: { id: GUILD, allow: V, deny: C },
    });
    const hidden = right().map((o) =>
      o.id === GUILD ? { ...o, allow: 0n, deny: C | V } : o,
    );
    expect(planLeadsSync(hidden, ctx({ leaderIds: ["l1", "l2"] }))).toEqual([]);
  });

  it("never grants View where the category denies it, whatever the channel's own entries say", () => {
    const privateCat = [role(GUILD, 0n, V)];
    // A degraded channel: Connect denied, but the View deny was lost.
    const degraded = right().map((o) =>
      o.id === GUILD ? { ...o, allow: 0n, deny: C } : o,
    );
    const c = ctx({
      leaderIds: ["l1", "l2"],
      categoryOverwrites: privateCat,
      adminGrantRoleIds: new Set(["mods"]),
    });
    const ops = planLeadsSync(degraded, c);
    // The category's deny is copied onto @everyone (never a View allow), and
    // the admin role gets no View.
    expect(
      ops.find((o) => o.kind === "put" && o.spec.id === GUILD),
    ).toMatchObject({ spec: { allow: 0n, deny: C | V } });
    expect(
      ops.find((o) => o.kind === "put" && o.spec.id === "mods"),
    ).toMatchObject({ spec: { allow: C | S } });
    // An @everyone entry that is missing altogether is restricted without View.
    const missing = planLeadsSync(
      right().filter((o) => o.id !== GUILD),
      ctx({ leaderIds: ["l1", "l2"], categoryOverwrites: privateCat }),
    );
    expect(missing).toEqual([
      {
        kind: "put",
        revoke: false,
        spec: { id: GUILD, type: OverwriteType.Role, allow: 0n, deny: C | V },
      },
    ]);
  });

  it("enforces a category that became private: the deny is copied and a View allow removed", () => {
    // The channel was made in a public category; the category now hides
    // channels from @everyone. The channel's own copy still allows View.
    const c = ctx({
      leaderIds: ["l1", "l2"],
      categoryOverwrites: [role(GUILD, 0n, V)],
    });
    const ops = planLeadsSync(right(), c);
    expect(ops).toEqual([
      {
        kind: "put",
        revoke: false,
        spec: { id: GUILD, type: OverwriteType.Role, allow: 0n, deny: C | V },
      },
    ]);
    // Once written there is nothing left to do.
    const done = right().map((o) =>
      o.id === GUILD ? { ...o, allow: 0n, deny: C | V } : o,
    );
    expect(planLeadsSync(done, c)).toEqual([]);
    // An unreadable category enforces nothing.
    expect(
      planLeadsSync(
        right(),
        ctx({ leaderIds: ["l1", "l2"], categoryUnknown: true }),
      ),
    ).toEqual([]);
  });

  it("enforces a category View deny on an admin group's role too, and copies none it does not have", () => {
    const base = ctx({
      leaderIds: ["l1", "l2"],
      adminRoleIds: new Set(["mods"]),
      adminGrantRoleIds: new Set(["mods"]),
    });
    const withMods = [...right(), role("mods", V | C | S, 0n)];
    const ops = planLeadsSync(withMods, {
      ...base,
      categoryOverwrites: [role("mods", 0n, V)],
    });
    expect(ops).toEqual([
      {
        kind: "put",
        revoke: false,
        spec: { id: "mods", type: OverwriteType.Role, allow: C | S, deny: V },
      },
    ]);
    // The category says nothing about this role: no deny is invented.
    expect(
      planLeadsSync(withMods, { ...base, categoryOverwrites: [] }),
    ).toEqual([]);
  });

  it("does not grant a deny the category has on the admin role itself, nor View without knowing the category", () => {
    const denied = planLeadsSync(
      right(),
      ctx({
        leaderIds: ["l1", "l2"],
        categoryOverwrites: [role("mods", 0n, C)],
        adminGrantRoleIds: new Set(["mods"]),
      }),
    );
    expect(denied).toMatchObject([
      { spec: { id: "mods", allow: V | S, deny: C } },
    ]);
    const unknown = planLeadsSync(
      right().map((o) => (o.id === GUILD ? { ...o, allow: 0n, deny: C } : o)),
      ctx({
        leaderIds: ["l1", "l2"],
        categoryUnknown: true,
        adminGrantRoleIds: new Set(["mods"]),
      }),
    );
    expect(unknown).toMatchObject([{ spec: { id: "mods", allow: C | S } }]);
  });

  it("touches no role when the admin groups are unknown", () => {
    const current = [...right(), role("verified", V | C, 0n)];
    expect(
      planLeadsSync(
        current,
        ctx({ leaderIds: ["l1", "l2"], allRolesExempt: true }),
      ),
    ).toEqual([]);
  });

  it("gives the role of an admin group an explicit allow, at creation and on a pass", () => {
    const c = ctx({
      leaderIds: [],
      adminRoleIds: new Set(["mods"]),
      adminGrantRoleIds: new Set(["mods"]),
    });
    const built = buildLeadsOverwrites([], c);
    expect(find(built, OverwriteType.Role, "mods")).toMatchObject({
      allow: V | C | S,
      deny: 0n,
    });
    const ops = planLeadsSync(
      buildLeadsOverwrites([], ctx({ leaderIds: [] })),
      c,
    );
    expect(ops).toEqual([
      {
        kind: "put",
        revoke: false,
        spec: {
          id: "mods",
          type: OverwriteType.Role,
          allow: V | C | S,
          deny: 0n,
        },
      },
    ]);
    // Once it has it, nothing is written.
    expect(planLeadsSync(built, c)).toEqual([]);
  });

  it("never lifts a category deny when granting an admin group's role", () => {
    const c = ctx({
      leaderIds: [],
      adminRoleIds: new Set(["mods"]),
      adminGrantRoleIds: new Set(["mods"]),
    });
    // The category hides channels from @everyone: no View grant, so the
    // channel stays hidden to those who cannot see it already.
    const priv = buildLeadsOverwrites([role(GUILD, 0n, V)], c);
    expect(find(priv, OverwriteType.Role, "mods")?.allow).toBe(C | S);
    // An explicit deny on the admin role itself stays.
    const denied = buildLeadsOverwrites([role("mods", 0n, C)], c);
    expect(find(denied, OverwriteType.Role, "mods")).toMatchObject({
      allow: V | S,
      deny: C,
    });
    expect(planLeadsSync(denied, c)).toEqual([]);
  });

  it("grants nothing to admin groups while they are unknown", () => {
    const c = ctx({
      leaderIds: [],
      adminGrantRoleIds: new Set(["mods"]),
      allRolesExempt: true,
    });
    expect(
      find(buildLeadsOverwrites([], c), OverwriteType.Role, "mods"),
    ).toBeUndefined();
  });

  it("never touches a pure deny entry or an Administrator role", () => {
    const current = [
      ...right(),
      member("muted", 0n, C),
      role("admins", V | C, 0n),
    ];
    expect(
      planLeadsSync(
        current,
        ctx({ leaderIds: ["l1", "l2"], adminRoleIds: new Set(["admins"]) }),
      ),
    ).toEqual([]);
  });

  it("re-grants a member whose bits were denied by hand", () => {
    const current = right().map((o) =>
      o.id === "l1" ? { ...o, allow: 0n, deny: C } : o,
    );
    const ops = planLeadsSync(current, ctx({ leaderIds: ["l1", "l2"] }));
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: "put",
      spec: { id: "l1", allow: LEADS_LEADER_PERMISSIONS, deny: 0n },
    });
  });
});

describe("leadsLeaderIds and desiredMembers", () => {
  const groups = [
    { key: "a", kind: "team", memberIds: ["u1", "u2"], captainId: "u1" },
    { key: "b", kind: "team", memberIds: ["u3"], captainId: "u9" },
  ];
  it("counts only effective leaders, and none while leaders are off", () => {
    expect(leadsLeaderIds({ captainsEnabled: true, groups })).toEqual(["u1"]);
    expect(leadsLeaderIds({ captainsEnabled: false, groups })).toEqual([]);
    expect(leadsLeaderIds({ groups })).toEqual([]);
  });
  it("merges the bits when one id plays two roles", () => {
    const want = desiredMembers(ctx({ leaderIds: [HOST] }));
    expect(want.get(HOST)).toBe(
      LEADS_HOST_PERMISSIONS | LEADS_LEADER_PERMISSIONS,
    );
  });
});

describe("planLeadsEviction", () => {
  const event = {
    channelId: "main",
    createdBy: HOST,
    captainsEnabled: true,
    groups: [
      {
        key: "a",
        kind: "team",
        channelId: "chA",
        memberIds: ["u1", "u2"],
        captainId: "u1",
      },
      {
        key: "b",
        kind: "team",
        channelId: null,
        memberIds: ["u3"],
        captainId: null,
      },
      { key: "l", kind: "leads", channelId: "leads", memberIds: [] },
    ],
  };
  const presence = (...rows: Array<[string, string]>) => ({
    ok: true,
    members: rows.map(([id, channelId]) => ({ id, channelId })),
  });
  const probe = {
    isAdmin: (id: string) => id === "admin",
    canConnect: () => null as boolean | null,
  };

  it("sends a revoked person to their team's channel, else to main, pinned to the leads channel", () => {
    const plan = planLeadsEviction(
      event,
      presence(["u2", "leads"], ["u3", "leads"], ["u7", "leads"]),
      { ...probe, revoked: new Set(["u2", "u3", "u7"]) },
    );
    expect(plan).toEqual([
      { userId: "u2", toChannelId: "chA", fromChannelId: "leads" },
      { userId: "u3", toChannelId: "main", fromChannelId: "leads" },
      { userId: "u7", toChannelId: "main", fromChannelId: "leads" },
    ]);
  });

  it("never moves the host, a current leader, an administrator or someone elsewhere", () => {
    const plan = planLeadsEviction(
      event,
      presence(
        [HOST, "leads"],
        ["u1", "leads"],
        ["admin", "leads"],
        ["u2", "main"],
      ),
      { ...probe, revoked: new Set([HOST, "u1", "admin", "u2"]) },
    );
    expect(plan).toEqual([]);
  });

  it("moves someone the cache says cannot connect, but not someone who still can or is unknown", () => {
    const plan = planLeadsEviction(
      event,
      presence(["u2", "leads"], ["u3", "leads"], ["u7", "leads"]),
      {
        revoked: new Set(),
        isAdmin: () => false,
        canConnect: (id) => (id === "u2" ? false : id === "u3" ? true : null),
      },
    );
    expect(plan).toEqual([
      { userId: "u2", toChannelId: "chA", fromChannelId: "leads" },
    ]);
  });

  it("treats a leader as a stranger when leaders are switched off", () => {
    const plan = planLeadsEviction(
      { ...event, captainsEnabled: false },
      presence(["u1", "leads"]),
      { ...probe, revoked: new Set(["u1"]) },
    );
    expect(plan).toEqual([
      { userId: "u1", toChannelId: "chA", fromChannelId: "leads" },
    ]);
  });

  it("refuses when who is connected could not be read", () => {
    expect(
      planLeadsEviction(
        event,
        { ok: false, members: [] },
        {
          ...probe,
          revoked: new Set(["u2"]),
        },
      ),
    ).toHaveProperty("refuse");
  });
});
