import { describe, it, expect, jest, beforeEach } from "@jest/globals";

/**
 * The leader customiser's writer (#1196) against the in-memory stand-in for the
 * Event model (`event-customise-fake-event.ts`), with the REAL group lock, the
 * REAL rules and the REAL rename queue. The real write shapes are proven against
 * MongoDB in `__tests__/integration/event-leader-customise.integration.test.ts`.
 */

import {
  cstore,
  cupdates,
  cfake,
  CEventMock,
  cclone,
  type CDoc,
  type CGroup,
} from "./event-customise-fake-event.js";

jest.unstable_mockModule("../../src/models/event.js", () => ({
  Event: CEventMock,
}));
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: () => ({ getBoolean: async () => true }),
  },
}));
jest.unstable_mockModule(
  "../../src/services/tracking-opt-out-service.js",
  () => ({
    TrackingOptOutService: {
      getInstance: () => ({ admission: () => 1 }),
    },
  }),
);
const syncMember = jest.fn(async () => "none");
const requestSweep = jest.fn();
jest.unstable_mockModule("../../src/services/event-nickname-tags.js", () => ({
  EventNicknameTags: {
    getInstance: () => ({ syncMember, requestSweep }),
  },
}));
const recordAudit = jest.fn(async () => undefined);
jest.unstable_mockModule("../../src/web/audit.js", () => ({
  recordAudit,
  boundAuditEntry: <T>(e: T): T => e,
}));

const {
  customiseGroup,
  resetGroupCustomisation,
  auditLeaderEdit,
  describeNameOutcome,
  createCustomiseDeps,
  LEADER_AUDIT_ACTION,
} = await import("../../src/services/event-leader-customise.js");
type Deps =
  import("../../src/services/event-leader-customise.js").CustomiseDeps;
const { getRenameQueue } =
  await import("../../src/services/event-rename-queue.js");

const GUILD = "guild-1";
const EV = "65a000000000000000000001";
const RED = "g_00000001";
const BLUE = "g_00000002";
const LEADER = "100000000000000001";
const OTHER = "100000000000000002";
const MEMBER = "100000000000000003";
const STRANGER = "100000000000000009";
const RED_CH = "200000000000000001";
const BLUE_CH = "200000000000000002";

function red(over: Partial<CGroup> = {}): CGroup {
  return {
    key: RED,
    name: "Red",
    tag: "RED",
    kind: "team",
    channelId: RED_CH,
    captainId: LEADER,
    memberIds: [LEADER, MEMBER],
    ...over,
  };
}
function blue(over: Partial<CGroup> = {}): CGroup {
  return {
    key: BLUE,
    name: "Blue",
    tag: "BLU",
    kind: "team",
    channelId: BLUE_CH,
    captainId: OTHER,
    memberIds: [OTHER],
    ...over,
  };
}
function seed(over: Partial<CDoc> = {}): CDoc {
  const doc: CDoc = {
    _id: EV,
    guildId: GUILD,
    state: "active",
    groupsEnabled: true,
    captainsEnabled: true,
    captainCustomisationEnabled: true,
    tagsEnabled: true,
    leaderLabel: "Captain",
    groups: [red(), blue()],
    ...over,
  };
  cstore.set(EV, doc);
  return doc;
}
const stored = (key = RED): CGroup =>
  cstore.get(EV)!.groups.find((g) => g.key === key)!;

let eventsEnabled: boolean | null = true;
const syncName = jest.fn<Deps["syncName"]>();
const retag = jest.fn<Deps["retag"]>();
const deps: Deps = {
  eventsEnabled: async () => eventsEnabled,
  syncName: (g, e, k) => syncName(g, e, k),
  retag: (g, e, m) => retag(g, e, m),
};

function run(
  over: Partial<Parameters<typeof customiseGroup>[0]> = {},
  d: Deps = deps,
): ReturnType<typeof customiseGroup> {
  return customiseGroup(
    {
      guildId: GUILD,
      eventId: EV,
      groupKey: RED,
      actorId: LEADER,
      channelId: RED_CH,
      rawName: "Crimson",
      rawTag: "CRM",
      ...over,
    },
    d,
  );
}

beforeEach(() => {
  cstore.clear();
  cupdates.length = 0;
  cfake.beforeNextUpdate = null;
  cfake.failFind = false;
  eventsEnabled = true;
  syncName.mockReset();
  syncName.mockResolvedValue({ groupKey: RED, status: "applied" });
  retag.mockReset();
  syncMember.mockClear();
  requestSweep.mockClear();
  recordAudit.mockClear();
  getRenameQueue().forget(RED_CH);
  getRenameQueue().forget(BLUE_CH);
  seed();
});

describe("customiseGroup: who may, from a fresh read (#1196)", () => {
  it("the team's leader renames the team and sets its tag", async () => {
    const r = await run();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changed).toBe(true);
    expect(r.nameChanged && r.tagChanged).toBe(true);
    expect(stored().name).toBe("Crimson");
    expect(stored().tag).toBe("CRM");
    // The host's values are kept once, in the same write.
    expect(stored().originalName).toBe("Red");
    expect(stored().originalTag).toBe("RED");
    expect(stored().nameSyncPending).toBe(true);
    expect(syncName).toHaveBeenCalledWith(GUILD, EV, RED);
    expect(retag).toHaveBeenCalledWith(GUILD, EV, [LEADER, MEMBER]);
    expect(r.lines.join(" ")).toContain("Crimson");
    expect(cupdates).toHaveLength(1);
  });

  it("a second edit keeps the host's original values", async () => {
    await run();
    await run({ rawName: "Scarlet", rawTag: "SCR" });
    expect(stored().name).toBe("Scarlet");
    expect(stored().originalName).toBe("Red");
    expect(stored().originalTag).toBe("RED");
    // The second write does not even try to set them again.
    const second = cupdates[1].update as { $set: Record<string, unknown> };
    expect(second.$set["groups.$[g].originalName"]).toBeUndefined();
  });

  type Case = {
    name: string;
    actor: string;
    group?: string;
    mutate?: () => void;
    enabled?: boolean | null;
    code: string;
  };
  const refusals: Case[] = [
    { name: "another team's leader", actor: OTHER, code: "not-leader" },
    { name: "a plain member of the team", actor: MEMBER, code: "not-leader" },
    { name: "a stranger", actor: STRANGER, code: "not-leader" },
    {
      name: "the stored leader who left the team (not an effective leader)",
      actor: LEADER,
      mutate: () => void (stored().memberIds = [MEMBER]),
      code: "not-leader",
    },
    {
      name: "the leader of the other team on this one",
      actor: OTHER,
      group: RED,
      code: "not-leader",
    },
    {
      name: "leaders switched off",
      actor: LEADER,
      mutate: () => void (cstore.get(EV)!.captainsEnabled = false),
      code: "leaders-off",
    },
    {
      name: "customisation switched off",
      actor: LEADER,
      mutate: () => void (cstore.get(EV)!.captainCustomisationEnabled = false),
      code: "customise-off",
    },
    {
      name: "event ended",
      actor: LEADER,
      mutate: () => void (cstore.get(EV)!.state = "ended"),
      code: "closed",
    },
    {
      name: "event cancelled",
      actor: LEADER,
      mutate: () => void (cstore.get(EV)!.state = "cancelled"),
      code: "closed",
    },
    {
      name: "events.enabled off",
      actor: LEADER,
      enabled: false,
      code: "events-off",
    },
    {
      name: "events.enabled unreadable",
      actor: LEADER,
      enabled: null,
      code: "events-off",
    },
    {
      name: "groups off",
      actor: LEADER,
      mutate: () => void (cstore.get(EV)!.groupsEnabled = false),
      code: "no-groups",
    },
    {
      name: "an unknown group",
      actor: LEADER,
      group: "g_ffffffff",
      code: "no-group",
    },
  ];
  it.each(refusals)("refuses $name and writes nothing", async (c) => {
    c.mutate?.();
    eventsEnabled = c.enabled === undefined ? true : c.enabled;
    const before = cclone(cstore.get(EV));
    const r = await run({ actorId: c.actor, groupKey: c.group ?? RED });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe(c.code);
      expect(r.message.length).toBeGreaterThan(10);
    }
    expect(cstore.get(EV)).toEqual(before);
    expect(cupdates).toHaveLength(0);
    expect(syncName).not.toHaveBeenCalled();
    expect(retag).not.toHaveBeenCalled();
  });

  it("refuses an event of another guild and an event that does not exist", async () => {
    expect((await run({ guildId: "guild-2" })).ok).toBe(false);
    expect((await run({ eventId: "65a0000000000000000000ff" })).ok).toBe(false);
    expect((await run({ eventId: "not-an-id" })).ok).toBe(false);
    expect(cupdates).toHaveLength(0);
  });

  it("fails closed when the event cannot be read", async () => {
    cfake.failFind = true;
    const r = await run();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unreadable");
    expect(cupdates).toHaveLength(0);
  });

  it("refuses an interaction that did not come from the team's own channel", async () => {
    const r = await run({ channelId: BLUE_CH });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("wrong-channel");
    expect(cupdates).toHaveLength(0);
  });
});

describe("customiseGroup: the write is the authorisation (changes while the modal was open)", () => {
  const midFlight: Array<[string, () => void]> = [
    ["the leader was replaced", () => void (stored().captainId = MEMBER)],
    ["the leader was unassigned", () => void (stored().memberIds = [MEMBER])],
    [
      "leaders were switched off",
      () => void (cstore.get(EV)!.captainsEnabled = false),
    ],
    [
      "customisation was switched off",
      () => void (cstore.get(EV)!.captainCustomisationEnabled = false),
    ],
    ["the event ended", () => void (cstore.get(EV)!.state = "ended")],
    [
      "the host renamed the team meanwhile",
      () => void (stored().name = "Host's pick"),
    ],
    [
      "the event stopped using groups",
      () => void (cstore.get(EV)!.groupsEnabled = false),
    ],
  ];
  it.each(midFlight)(
    "%s between the read and the write: nothing is stored",
    async (_n, change) => {
      cfake.beforeNextUpdate = change;
      const r = await run();
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("write-failed");
      // Only the interleaved change is in the store.
      expect(stored().name).not.toBe("Crimson");
      expect(stored().tag).not.toBe("CRM");
      expect(stored().originalName).toBeUndefined();
      expect(stored().nameSyncPending).toBeUndefined();
      expect(syncName).not.toHaveBeenCalled();
      expect(retag).not.toHaveBeenCalled();
    },
  );

  it("the write's filter carries every condition the decision used", async () => {
    await run();
    const filter = cupdates[0].filter as Record<string, unknown>;
    expect(filter).toMatchObject({
      _id: EV,
      guildId: GUILD,
      groupsEnabled: true,
      captainsEnabled: true,
      captainCustomisationEnabled: true,
      state: { $in: ["scheduled", "active"] },
    });
    expect(
      (filter.groups as { $elemMatch: Record<string, unknown> }).$elemMatch,
    ).toMatchObject({
      key: RED,
      kind: "team",
      captainId: LEADER,
      memberIds: LEADER,
      name: "Red",
    });
  });

  it("two leaders submitting at once cannot both win a name", async () => {
    const [a, b] = await Promise.all([
      run({ rawName: "Alpha", rawTag: null }),
      run({
        groupKey: BLUE,
        actorId: OTHER,
        channelId: BLUE_CH,
        rawName: "Alpha",
        rawTag: null,
      }),
    ]);
    // Whoever the lock lets in first takes it; the other is told it is taken.
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const loser = a.ok ? b : a;
    if (!loser.ok) expect(loser.code).toBe("name-taken");
  });
});

describe("customiseGroup: input (#1196)", () => {
  it.each([
    ["an empty name", { rawName: "   " }],
    ["a name over 50 characters", { rawName: "x".repeat(51) }],
    ["a name with a control character", { rawName: "Re\u0007d" }],
    ["a tag over 8 characters", { rawTag: "123456789" }],
    ["a tag with a control character", { rawTag: "R\u0000D" }],
  ])("%s is refused before anything is read or written", async (_n, over) => {
    const r = await run(over);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("invalid");
      expect(r.errors?.length).toBeGreaterThan(0);
    }
    expect(cupdates).toHaveLength(0);
  });

  it("collapses whitespace like the event form does", async () => {
    const r = await run({ rawName: "  Dark   Red  ", rawTag: " D  R " });
    expect(r.ok).toBe(true);
    expect(stored().name).toBe("Dark Red");
    expect(stored().tag).toBe("D R");
  });

  it("an empty tag clears the tag; a tag field that was not posted leaves it alone", async () => {
    await run({ rawName: null, rawTag: "" });
    expect(stored().tag).toBe("");
    expect(stored().name).toBe("Red");
    await run({ rawName: "Crimson", rawTag: null });
    expect(stored().tag).toBe("");
    expect(stored().name).toBe("Crimson");
  });

  it("a name another team already uses (any case) is refused, the team's own is not", async () => {
    const r = await run({ rawName: "BLUE" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("name-taken");
    const same = await run({ rawName: "RED", rawTag: null });
    expect(same.ok).toBe(true); // a case-only change of its own name
    expect(stored().name).toBe("RED");
  });

  it("nothing to change writes nothing", async () => {
    const r = await run({ rawName: "Red", rawTag: "RED" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.changed).toBe(false);
    expect(cupdates).toHaveLength(0);
    expect(syncName).not.toHaveBeenCalled();
    expect(retag).not.toHaveBeenCalled();
  });

  it("escapes member text in what it says back", async () => {
    const r = await run({ rawName: "@everyone <@123> [x](y)", rawTag: null });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const text = r.lines.join(" ");
      expect(text).not.toContain("<@123>");
      expect(text).toContain("@​everyone");
    }
  });
});

describe("customiseGroup: the channel and the nicknames follow (#1196)", () => {
  it("a team without a channel yet just stores the name (no pending rename)", async () => {
    stored().channelId = null;
    const r = await run({ channelId: null, rawTag: null });
    expect(r.ok).toBe(true);
    expect(stored().nameSyncPending).toBeUndefined();
    expect(syncName).not.toHaveBeenCalled();
  });

  it("only a tag change does not rename anything", async () => {
    const r = await run({ rawName: null });
    expect(r.ok).toBe(true);
    expect(syncName).not.toHaveBeenCalled();
    expect(stored().nameSyncPending).toBeUndefined();
    expect(retag).toHaveBeenCalledTimes(1);
  });

  it("does not start nickname work when tags are off or the event has not started", async () => {
    cstore.get(EV)!.tagsEnabled = false;
    await run({ rawName: null });
    expect(retag).not.toHaveBeenCalled();
    cstore.get(EV)!.tagsEnabled = true;
    cstore.get(EV)!.state = "scheduled";
    await run({ rawName: null, rawTag: "ZZZ" });
    expect(retag).not.toHaveBeenCalled();
    expect(stored().tag).toBe("ZZZ"); // stored for when the event starts
  });

  it.each([
    [
      "applied",
      { groupKey: RED, status: "applied" as const },
      "channel are now called",
    ],
    [
      "limited",
      { groupKey: RED, status: "limited" as const, retryAfterMs: 7 * 60_000 },
      "about 7 minutes",
    ],
    [
      "failed",
      { groupKey: RED, status: "failed" as const, reason: "x" },
      "did not confirm",
    ],
    [
      "unconfirmed",
      { groupKey: RED, status: "unconfirmed" as const },
      "did not confirm",
    ],
    [
      "skipped",
      { groupKey: RED, status: "skipped" as const },
      "will use the new name",
    ],
  ])(
    "tells the leader what happened to the channel: %s",
    async (_n, outcome, text) => {
      syncName.mockResolvedValue(outcome);
      const r = await run({ rawTag: null });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.lines.join(" ")).toContain(text);
      // Whatever the channel did, the stored name stays, and the flag is the pass's to clear.
      expect(stored().name).toBe("Crimson");
      expect(stored().nameSyncPending).toBe(true);
    },
  );

  it("a channel pass that throws still leaves a saved, pending name", async () => {
    syncName.mockRejectedValue(new Error("boom"));
    const r = await run({ rawTag: null });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lines.join(" ")).toContain("did not confirm");
    expect(stored().nameSyncPending).toBe(true);
  });

  it("never holds the group lock while the channel is renamed", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    syncName.mockImplementation(async (_g, _e, key) => {
      if (key === RED) await gate;
      return { groupKey: key, status: "applied" as const };
    });
    const first = run({ rawTag: null });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    // A second leader's edit goes through while the first rename is waiting.
    const second = await run({
      groupKey: BLUE,
      actorId: OTHER,
      channelId: BLUE_CH,
      rawName: "Navy",
      rawTag: null,
    });
    expect(second.ok).toBe(true);
    release();
    expect((await first).ok).toBe(true);
  });
});

describe("customiseGroup: Discord's rename limit is reported, never slept on (#1196)", () => {
  function useBudget(): void {
    const q = getRenameQueue();
    q.reserve(RED_CH);
    q.reserve(RED_CH);
  }

  it("a name-only change is refused with the time to wait, before anything is written", async () => {
    useBudget();
    const r = await run({ rawTag: null });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("rename-limited");
      expect(r.message).toContain("try again in about");
      expect(r.retryAfterMs).toBeGreaterThan(0);
    }
    expect(stored().name).toBe("Red");
    expect(cupdates).toHaveLength(0);
    expect(syncName).not.toHaveBeenCalled();
  });

  it("a tag change still applies while the name waits", async () => {
    useBudget();
    const r = await run();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.nameChanged).toBe(false);
      expect(r.tagChanged).toBe(true);
      expect(r.lines.join(" ")).toContain("The name was not changed");
      expect(r.lines.join(" ")).toContain("Try again in about");
    }
    expect(stored().name).toBe("Red");
    expect(stored().tag).toBe("CRM");
    expect(stored().nameSyncPending).toBeUndefined();
    expect(syncName).not.toHaveBeenCalled();
  });

  it("another team's channel has its own budget", async () => {
    useBudget();
    const r = await run({
      groupKey: BLUE,
      actorId: OTHER,
      channelId: BLUE_CH,
      rawName: "Navy",
      rawTag: null,
    });
    expect(r.ok).toBe(true);
  });
});

describe("audit and the host reset (#1196)", () => {
  it("records a leader's edit under the leader's own id with what changed", async () => {
    const r = await run();
    await auditLeaderEdit({
      guildId: GUILD,
      eventId: EV,
      actorId: LEADER,
      groupKey: RED,
      result: r,
    });
    expect(recordAudit).toHaveBeenCalledTimes(1);
    const [session, entry] = recordAudit.mock.calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(session).toMatchObject({
      discordUserId: LEADER,
      guildId: GUILD,
      role: "user",
    });
    expect(entry).toMatchObject({
      action: LEADER_AUDIT_ACTION,
      targetId: EV,
      result: "success",
    });
    expect(entry.details).toMatchObject({
      group: RED,
      nameFrom: "Red",
      nameTo: "Crimson",
      tagFrom: "RED",
      tagTo: "CRM",
    });
  });

  it("an audit failure never throws", async () => {
    recordAudit.mockRejectedValueOnce(new Error("db down"));
    const r = await run();
    await expect(
      auditLeaderEdit({
        guildId: GUILD,
        eventId: EV,
        actorId: LEADER,
        groupKey: RED,
        result: r,
      }),
    ).resolves.toBeUndefined();
  });

  const resetDeps = {
    syncName: (g: string, e: string, k: string) => syncName(g, e, k),
    retag: (g: string, e: string, m: string[]) => retag(g, e, m),
  };

  it("reset puts back what the host set, clears the memory of it and finishes the channel", async () => {
    await run();
    syncName.mockClear();
    retag.mockClear();
    const r = await resetGroupCustomisation(
      { guildId: GUILD, eventId: EV, groupKey: RED },
      resetDeps,
    );
    expect(r.ok).toBe(true);
    expect(stored().name).toBe("Red");
    expect(stored().tag).toBe("RED");
    expect(stored().originalName).toBeUndefined();
    expect(stored().originalTag).toBeUndefined();
    expect(stored().nameSyncPending).toBe(true);
    expect(syncName).toHaveBeenCalledWith(GUILD, EV, RED);
    expect(retag).toHaveBeenCalledWith(GUILD, EV, [LEADER, MEMBER]);
  });

  it("reset works whatever the leaders' switches say", async () => {
    await run();
    const doc = cstore.get(EV)!;
    doc.captainsEnabled = false;
    doc.captainCustomisationEnabled = false;
    const r = await resetGroupCustomisation(
      { guildId: GUILD, eventId: EV, groupKey: RED },
      resetDeps,
    );
    expect(r.ok).toBe(true);
    expect(stored().name).toBe("Red");
  });

  it("reset of a team nobody changed is a no-op", async () => {
    const r = await resetGroupCustomisation(
      { guildId: GUILD, eventId: EV, groupKey: RED },
      resetDeps,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.changed).toBe(false);
    expect(cupdates).toHaveLength(0);
  });

  it("reset refuses when another team now has the original name", async () => {
    await run();
    stored(BLUE).name = "Red";
    const r = await resetGroupCustomisation(
      { guildId: GUILD, eventId: EV, groupKey: RED },
      resetDeps,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("name-taken");
    expect(stored().name).toBe("Crimson");
  });

  it("reset refuses a finished event, an unknown team and a race", async () => {
    await run();
    cstore.get(EV)!.state = "ended";
    expect(
      (
        await resetGroupCustomisation(
          { guildId: GUILD, eventId: EV, groupKey: RED },
          resetDeps,
        )
      ).ok,
    ).toBe(false);
    cstore.get(EV)!.state = "active";
    const unknown = await resetGroupCustomisation(
      { guildId: GUILD, eventId: EV, groupKey: "g_ffffffff" },
      resetDeps,
    );
    expect(unknown.ok).toBe(false);
    cfake.beforeNextUpdate = () => void (stored().name = "Someone else");
    const raced = await resetGroupCustomisation(
      { guildId: GUILD, eventId: EV, groupKey: RED },
      resetDeps,
    );
    expect(raced.ok).toBe(false);
    if (!raced.ok) expect(raced.code).toBe("write-failed");
    expect(stored().originalName).toBe("Red");
  });

  it("describeNameOutcome covers every status", () => {
    for (const status of [
      "applied",
      "limited",
      "failed",
      "unconfirmed",
      "skipped",
    ] as const) {
      expect(
        describeNameOutcome("Crimson", {
          groupKey: RED,
          status,
          retryAfterMs: 1000,
        }),
      ).toContain("Crimson");
    }
    expect(describeNameOutcome("Crimson", null)).toContain("Crimson");
  });
});

describe("the real dependencies (#1196)", () => {
  it("retag syncs each member through the one tag function, then sweeps", async () => {
    const d = createCustomiseDeps({} as never);
    d.retag(GUILD, EV, [LEADER, MEMBER]);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(syncMember).toHaveBeenCalledTimes(2);
    expect(syncMember).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: GUILD,
        eventId: EV,
        userId: LEADER,
        admission: 1,
      }),
    );
    expect(requestSweep).toHaveBeenCalledWith(GUILD);
  });

  it("one member's failure does not stop the others", async () => {
    syncMember.mockRejectedValueOnce(new Error("nope"));
    createCustomiseDeps({} as never).retag(GUILD, EV, [LEADER, MEMBER]);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(syncMember).toHaveBeenCalledTimes(2);
  });
});
