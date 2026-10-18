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

  it("removes the View the bot gave an admin or other role once the category hides channels, unless the category grants it", () => {
    const base = ctx({
      leaderIds: ["l1", "l2"],
      adminRoleIds: new Set(["mods", "vip"]),
      adminGrantRoleIds: new Set(["mods", "vip"]),
    });
    const current = [
      ...right(),
      role("mods", V | C | S, 0n),
      role("vip", V | C | S, 0n),
      role("fan", V, 0n),
      role("granted", V, 0n),
    ];
    const privateCat = [
      role(GUILD, 0n, V),
      role("granted", V, 0n),
      role("vip", V, 0n),
    ];
    const ops = planLeadsSync(
      // @everyone already carries the deny (written earlier).
      current.map((o) =>
        o.id === GUILD ? { ...o, allow: 0n, deny: C | V } : o,
      ),
      { ...base, categoryOverwrites: privateCat },
    );
    const byId = Object.fromEntries(
      ops.map((o) =>
        o.kind === "put"
          ? [o.spec.id, o.spec]
          : [o.id, { id: o.id, allow: 0n, deny: 0n }],
      ),
    );
    // The admin role loses the channel-level View (the category gives it none)
    // but keeps Connect and Speak; another role loses it too; a role the
    // category grants View keeps it.
    expect(byId.mods).toMatchObject({ allow: C | S });
    expect(byId.fan).toMatchObject({ allow: 0n });
    expect(byId.granted).toBeUndefined();
    // An admin role the category itself grants View keeps it.
    expect(byId.vip).toBeUndefined();
    // With a public category nothing changes.
    expect(planLeadsSync(current, { ...base, categoryOverwrites: [] })).toEqual(
      [],
    );
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
        revoke: true,
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

// ---------------------------------------------------------------------
// The View rule for roles: regressions, then the whole matrix
// ---------------------------------------------------------------------

/** What a plan leaves in the channel (an op replaces or deletes an entry). */
function applyPlan(
  current: OverwriteSpec[],
  ops: ReturnType<typeof planLeadsSync>,
): OverwriteSpec[] {
  const map = new Map(current.map((o) => [`${o.type}:${o.id}`, o]));
  for (const op of ops) {
    if (op.kind === "delete") map.delete(`${op.type}:${op.id}`);
    else map.set(`${op.spec.type}:${op.spec.id}`, op.spec);
  }
  return [...map.values()];
}

describe("a role's View follows the category's entry for that role", () => {
  const base = ctx({ leaderIds: [] });
  const channel = (): OverwriteSpec[] =>
    buildLeadsOverwrites([], ctx({ leaderIds: [] }));

  it("copies a category View deny on an ordinary role, with or without a channel entry", () => {
    const cat = [role("muted", 0n, V)];
    // The channel kept an old View allow for the role.
    const existing = planLeadsSync([...channel(), role("muted", V, 0n)], {
      ...base,
      categoryOverwrites: cat,
    });
    expect(existing).toEqual([
      {
        kind: "put",
        revoke: true,
        spec: { id: "muted", type: OverwriteType.Role, allow: 0n, deny: V },
      },
    ]);
    // The role has no channel entry at all yet.
    const missing = planLeadsSync(channel(), {
      ...base,
      categoryOverwrites: cat,
    });
    expect(missing).toEqual([
      {
        kind: "put",
        revoke: false,
        spec: { id: "muted", type: OverwriteType.Role, allow: 0n, deny: V },
      },
    ]);
  });

  it("copies a private category's View grant to an admin group's role whose entry is missing or lacks View", () => {
    const admin = ctx({
      leaderIds: [],
      adminRoleIds: new Set(["mods"]),
      adminGrantRoleIds: new Set(["mods"]),
      categoryOverwrites: [role(GUILD, 0n, V), role("mods", V, 0n)],
    });
    const hidden = channel().map((o) =>
      o.id === GUILD ? { ...o, allow: 0n, deny: C | V } : o,
    );
    const missing = planLeadsSync(hidden, admin);
    expect(missing).toEqual([
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
    const lacking = planLeadsSync([...hidden, role("mods", C | S, 0n)], admin);
    expect(lacking).toMatchObject([{ spec: { id: "mods", allow: V | C | S } }]);
  });

  // Rows: the kind of account. Columns: the category's View entry for it
  // (none, allow, deny) and the channel's own (missing, allow, deny).
  type Cat = "none" | "allow" | "deny";
  type Chan = "missing" | "allow" | "deny";
  const catOf = (id: string, c: Cat): OverwriteSpec[] =>
    c === "allow" ? [role(id, V, 0n)] : c === "deny" ? [role(id, 0n, V)] : [];
  const chanOf = (id: string, c: Chan): OverwriteSpec[] =>
    c === "allow" ? [role(id, V, 0n)] : c === "deny" ? [role(id, 0n, V)] : [];
  const cats: Cat[] = ["none", "allow", "deny"];
  const chans: Chan[] = ["missing", "allow", "deny"];
  const viewOf = (
    specs: OverwriteSpec[],
    id: string,
    type = OverwriteType.Role,
  ) => {
    const o = specs.find((x) => x.id === id && x.type === type);
    return {
      allow: ((o?.allow ?? 0n) & V) !== 0n,
      deny: ((o?.deny ?? 0n) & V) !== 0n,
    };
  };

  for (const everyoneHidden of [false, true]) {
    const everyoneCat = everyoneHidden ? [role(GUILD, 0n, V)] : [];
    for (const c of cats) {
      for (const h of chans) {
        const where = `category ${c}, channel ${h}, category ${everyoneHidden ? "hides" : "shows"} the channel to @everyone`;
        // The channel's @everyone entry as the rule leaves it (or it was).
        const everyoneChan = everyoneHidden
          ? [role(GUILD, 0n, C | V)]
          : [role(GUILD, V, C)];

        it(`ordinary role: ${where}`, () => {
          const c0 = ctx({
            leaderIds: [],
            categoryOverwrites: [...everyoneCat, ...catOf("r", c)],
          });
          const out = applyPlan(
            [...everyoneChan, ...chanOf("r", h)],
            planLeadsSync([...everyoneChan, ...chanOf("r", h)], c0),
          );
          const v = viewOf(out, "r");
          if (c === "deny") expect(v).toEqual({ allow: false, deny: true });
          else if (c === "allow")
            expect(v).toEqual(
              h === "deny"
                ? { allow: false, deny: true }
                : { allow: true, deny: false },
            );
          else if (everyoneHidden) expect(v.allow).toBe(false);
          // Never joinable by an allow, and nothing left to do.
          expect((out.find((x) => x.id === "r")?.allow ?? 0n) & (C | S)).toBe(
            0n,
          );
          expect(planLeadsSync(out, c0)).toEqual([]);
          // Creation agrees with what a pass leaves.
          const built = buildLeadsOverwrites(
            [...everyoneCat, ...catOf("r", c)],
            c0,
          );
          expect(viewOf(built, "r")).toEqual(
            c === "deny"
              ? { allow: false, deny: true }
              : c === "allow"
                ? { allow: true, deny: false }
                : viewOf(built, "r"),
          );
        });

        it(`admin group role: ${where}`, () => {
          const c0 = ctx({
            leaderIds: [],
            adminRoleIds: new Set(["a"]),
            adminGrantRoleIds: new Set(["a"]),
            categoryOverwrites: [...everyoneCat, ...catOf("a", c)],
          });
          const start = [...everyoneChan, ...chanOf("a", h)];
          const out = applyPlan(start, planLeadsSync(start, c0));
          const v = viewOf(out, "a");
          const entry = out.find((x) => x.id === "a");
          if (c === "deny") expect(v).toEqual({ allow: false, deny: true });
          else if (c === "allow")
            expect(v.allow).toBe(h === "deny" ? false : true);
          else if (everyoneHidden) expect(v.allow).toBe(false);
          else if (h !== "deny") expect(v.allow).toBe(true);
          // Admins are given Connect and Speak (unless denied), always.
          if (!v.deny || h !== "deny") {
            expect(
              ((entry?.allow ?? 0n) & (C | S)) === (C | S) || c === "deny",
            ).toBe(true);
          }
          expect(planLeadsSync(out, c0)).toEqual([]);
          const built = buildLeadsOverwrites(
            [...everyoneCat, ...catOf("a", c)],
            c0,
          );
          expect(planLeadsSync(built, c0)).toEqual([]);
        });
      }
    }
  }

  for (const c of cats) {
    for (const h of chans) {
      it(`bot, host and leader keep their View whatever the category says (category ${c}, channel ${h})`, () => {
        const c0 = ctx({
          leaderIds: ["l1"],
          categoryOverwrites: [role(GUILD, 0n, V), ...catOf("r", c)],
        });
        const own = (id: string): OverwriteSpec[] =>
          h === "allow"
            ? [member(id, V, 0n)]
            : h === "deny"
              ? [member(id, 0n, V)]
              : [];
        const start = [
          role(GUILD, 0n, C | V),
          ...own(BOT),
          ...own(HOST),
          ...own("l1"),
        ];
        const out = applyPlan(start, planLeadsSync(start, c0));
        for (const id of [BOT, HOST, "l1"]) {
          expect(viewOf(out, id, OverwriteType.Member)).toEqual({
            allow: true,
            deny: false,
          });
        }
        expect(planLeadsSync(out, c0)).toEqual([]);
      });
    }
  }

  it("@everyone: the category's deny wins, otherwise View is allowed unless the channel denies it", () => {
    for (const c of cats) {
      for (const h of chans) {
        const c0 = ctx({
          leaderIds: [],
          categoryOverwrites:
            c === "none"
              ? []
              : [role(GUILD, c === "allow" ? V : 0n, c === "deny" ? V : 0n)],
        });
        const start = [
          ...(h === "missing"
            ? []
            : [
                role(
                  GUILD,
                  h === "allow" ? V : 0n,
                  (h === "deny" ? V : 0n) | C,
                ),
              ]),
        ];
        const out = applyPlan(start, planLeadsSync(start, c0));
        const v = viewOf(out, GUILD);
        if (c === "deny" || h === "deny")
          expect(v).toEqual({ allow: false, deny: true });
        else expect(v.allow).toBe(true);
        expect(((out.find((x) => x.id === GUILD)?.deny ?? 0n) & C) !== 0n).toBe(
          true,
        );
        expect(planLeadsSync(out, c0)).toEqual([]);
      }
    }
  });
});
