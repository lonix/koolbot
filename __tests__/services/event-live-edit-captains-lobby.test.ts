import { describe, it, expect, jest, beforeEach } from "@jest/globals";

/**
 * The Captains lobby switch of the live edit (#1251): the row of
 * `event-live-edit-captains-lobby.ts` run through the REAL core (planner,
 * executor, both locks, confirmation round trip, result text) against the
 * in-memory Event stand-in of `event-live-edit-groups-fake-event.ts`, with the
 * channel effects replaced by fakes that behave like the real passes (the pass
 * records a channel for every group that has none; the removal pulls the group,
 * as `EventGroupChannels.removeGroup` does). The stand-in throws on any filter
 * or update shape the row does not use; the real shapes are proven against
 * MongoDB in `__tests__/integration/event-live-edit-captains-lobby.integration.test.ts`.
 *
 * Expected values are literals, never computed by a copy of the logic under test.
 */

import {
  store,
  writes,
  fake,
  SETTABLE,
  EventMock,
  type Json,
} from "./event-live-edit-groups-fake-event.js";

jest.unstable_mockModule("../../src/models/event.js", () => ({
  Event: EventMock,
}));
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: { getInstance: () => ({}) },
}));
jest.unstable_mockModule(
  "../../src/services/tracking-opt-out-service.js",
  () => ({
    TrackingOptOutService: {
      getInstance: () => ({
        admission: () => 1,
        resetAwareWrite: async (
          ids: string[],
          _guildId: string,
          write: (ids: string[]) => Promise<unknown>,
        ) => ({ admitted: ids, value: await write(ids) }),
      }),
    },
  }),
);

process.env.WEBUI_SESSION_SECRET = "live-edit-captains-lobby-test-secret";

const live = await import("../../src/services/event-live-edit.js");
const { captainsLobbyRow, CAPTAINS_LOBBY_ROW_ID } =
  await import("../../src/services/event-live-edit-captains-lobby.js");
const { GROUP_REMOVE_ROW_ID } =
  await import("../../src/services/event-live-edit-group-set.js");
const { groupNameRowId } =
  await import("../../src/services/event-live-edit-groups.js");
const { makeEffects } =
  await import("./event-live-edit-groups-effects-fake.js");
const { resetMoveGuardForTests } =
  await import("../../src/services/event-move-guard.js");
type LiveEditDeps =
  import("../../src/services/event-live-edit.js").LiveEditDeps;
type LiveEditEffects =
  import("../../src/services/event-live-edit.js").LiveEditEffects;
type LiveEditOutcome =
  import("../../src/services/event-live-edit.js").LiveEditOutcome;
type EmptyChannelOutcome =
  import("../../src/services/event-live-edit.js").EmptyChannelOutcome;
type GroupRemoveResult =
  import("../../src/services/event-live-edit.js").GroupRemoveResult;

const GUILD = "guild-1";
const EV = "65a000000000000000000001";
const HOST = "host-1";
const A = "g_00000001";
const B = "g_00000002";
const LOBBY = "g_000000a1";

const teamGroup = (key: string, name: string, over: Json = {}): Json => ({
  key,
  name,
  kind: "team",
  size: 3,
  tag: "",
  marker: "",
  channelId: `c-${key}`,
  captainId: null,
  memberIds: [],
  ...over,
});
const lobbyGroup = (over: Json = {}): Json => ({
  key: LOBBY,
  name: "Leader lobby",
  kind: "leads",
  size: null,
  tag: "",
  marker: "",
  channelId: "c-lobby",
  captainId: null,
  memberIds: [],
  ...over,
});

function seed(groups: Json[], over: Json = {}): void {
  store.set(EV, {
    _id: EV,
    guildId: GUILD,
    state: "active",
    groupsEnabled: true,
    captainsEnabled: true,
    presetId: null,
    groupLabel: "Team",
    leaderLabel: "Leader",
    channelLeadMinutes: null,
    channelId: "c-main",
    tagsEnabled: false,
    groups,
    ...over,
  });
}

const groupsOf = (): Json[] => store.get(EV)?.groups as Json[];
const leadsRows = (): Json[] => groupsOf().filter((g) => g.kind === "leads");
const rowWrites = (): typeof writes =>
  writes.filter((w) => !("$inc" in w.update));

let enabled: boolean | null = true;
let ending = false;
let effects: LiveEditEffects | undefined;
const deps: LiveEditDeps = {
  isEventsEnabled: async () => enabled,
  maxGroups: async () => 15,
  isEnding: () => ending,
  get effects(): LiveEditEffects | undefined {
    return effects;
  },
};

const calls: string[] = [];
/** Channel ids somebody is connected to, as the gateway cache shows them. */
let connected: Set<string>;
/** The channel ids the core asked about, one entry per ask. */
const asked: string[][] = [];
let emptyResult: () => EmptyChannelOutcome;
let removeResult: () => GroupRemoveResult | null;
let createResult: () => {
  failures: Array<{ key: string; reason: string }>;
} | null;

beforeEach(() => {
  store.clear();
  writes.length = 0;
  calls.length = 0;
  fake.beforeWrite = null;
  fake.afterFind = null;
  fake.extraGroupFields = new Set(["memberIds"]);
  fake.failReads = false;
  // The leaders row writes `captainsEnabled`; the stand-in lets it through for
  // the tests of this file that save it together with the lobby.
  SETTABLE.add("captainsEnabled");
  SETTABLE.add("leaderLabel");
  enabled = true;
  ending = false;
  connected = new Set(["c-lobby"]);
  asked.length = 0;
  emptyResult = () => ({ status: "empty", moved: [] });
  removeResult = () => ({ status: "removed" });
  createResult = () => ({ failures: [] });
  resetMoveGuardForTests();
  seed([teamGroup(A, "Alpha"), teamGroup(B, "Bravo")]);
  effects = makeEffects({
    eventVoiceInUse: (_g, ids) => {
      asked.push([...ids]);
      return ids.some((id) => connected.has(id));
    },
    async syncGroupName(_g, _e, key) {
      return { groupKey: key, status: "applied" };
    },
    async syncGroupUserLimit(_g, _e, key) {
      return { groupKey: key, status: "applied" };
    },
    async createGroupChannels() {
      calls.push("create");
      const result = createResult();
      // The real pass records a channel for every group that has none.
      if (result && result.failures.length === 0) {
        for (const g of groupsOf()) {
          if (!g.channelId) g.channelId = `made-${String(g.key)}`;
        }
      }
      return result;
    },
    async emptyGroupChannel(_g, _e, key, channelId) {
      calls.push(`empty:${key}:${channelId}`);
      return emptyResult();
    },
    async removeGroupChannel(_g, _e, key, channelId) {
      calls.push(`remove:${key}:${channelId}`);
      const result = removeResult();
      if (result?.status === "removed") {
        store.get(EV)!.groups = groupsOf().filter((g) => g.key !== key);
      }
      return result;
    },
  });
  effects.syncLeadsAccess = async (): Promise<void> => {
    calls.push("leads");
  };
  effects.syncGroupControls = async (): Promise<void> => {
    calls.push("controls");
  };
});

const entry = (rowId: string, to: unknown, base: unknown) => ({
  rowId,
  to,
  base,
});
const run = (
  entries: Array<{ rowId: string; to: unknown; base: unknown }>,
  d: LiveEditDeps = deps,
): Promise<LiveEditOutcome> =>
  live.runLiveEdit({
    guildId: GUILD,
    eventId: EV,
    deps: d,
    submission: entries as never,
  });
const lobbyOn = () => run([entry(CAPTAINS_LOBBY_ROW_ID, true, false)]);
const lobbyOff = () => run([entry(CAPTAINS_LOBBY_ROW_ID, false, true)]);

type Done = Extract<LiveEditOutcome, { status: "done" }>;
const done = (o: LiveEditOutcome): Done => {
  expect(o.status).toBe("done");
  return o as Done;
};
const text = (o: LiveEditOutcome): string =>
  live.describeLiveEditOutcome(o).message;

/** The two steps of a confirmed change: the confirmation page, then the confirmed run. */
async function confirmed(
  entries: Array<{ rowId: string; to: unknown; base: unknown }>,
): Promise<{ first: LiveEditOutcome; second: LiveEditOutcome }> {
  const first = await run(entries);
  expect(first.status).toBe("needs-confirmation");
  if (first.status !== "needs-confirmation") return { first, second: first };
  const token = live.signConfirmation({
    eventId: EV,
    guildId: GUILD,
    userId: HOST,
    changes: first.changes.map((c) => ({
      rowId: c.rowId,
      from: c.from,
      to: c.to,
      guard: c.guard,
    })),
    revision: first.revision,
    voiceInUse: first.voiceInUse,
  });
  const check = live.verifyConfirmation(token, {
    eventId: EV,
    guildId: GUILD,
    userId: HOST,
  });
  if (!check.ok) throw new Error("token refused");
  const second = await live.runLiveEdit({
    guildId: GUILD,
    eventId: EV,
    deps,
    confirmed: check.changes,
    confirmedRevision: check.revision,
    confirmedVoiceInUse: check.voiceInUse,
  });
  return { first, second };
}

describe("registration and reading", () => {
  it("is the row before the groups switch (#1243), with a letters-only id", () => {
    const ids = live.LIVE_EDIT_ROWS.map((r) => r.id);
    expect(ids[ids.length - 3]).toBe("captainsLobby");
    expect(ids[ids.length - 2]).toBe("groupsEnabled");
    expect(CAPTAINS_LOBBY_ROW_ID).toMatch(/^[A-Za-z]+$/);
  });

  it("reads the switch from the presence of a leads group, whatever its name or channel", () => {
    const read = (groups: Json[]): boolean =>
      captainsLobbyRow.read({ groups } as never) as boolean;
    expect(read([teamGroup(A, "Alpha")])).toBe(false);
    expect(read([teamGroup(A, "Alpha"), lobbyGroup()])).toBe(true);
    expect(read([lobbyGroup({ name: "Command", channelId: null })])).toBe(true);
  });
});

describe("turning it on", () => {
  it("creates the restricted channel through the group pass and brings the leaders-only access in line afterwards", async () => {
    const out = await lobbyOn();
    expect(done(out).applied).toHaveLength(1);
    expect(leadsRows()).toEqual([
      {
        key: expect.stringMatching(/^g_[0-9a-f]{8}$/),
        name: "Leader lobby",
        kind: "leads",
        size: null,
        tag: "",
        marker: "",
        channelId: expect.stringMatching(/^made-g_/),
        captainId: null,
        memberIds: [],
      },
    ]);
    // The pass first (inside the save), the leaders-only access after both
    // locks are released.
    expect(calls).toEqual(["create", "leads"]);
    expect(groupsOf().map((g) => g.key)).toEqual([A, B, leadsRows()[0].key]);
  });

  it("is one conditional push: open event, groups on, leaders on, the exact count and no leads group", async () => {
    await lobbyOn();
    expect(rowWrites()).toHaveLength(1);
    expect(rowWrites()[0].filter).toEqual({
      _id: EV,
      guildId: GUILD,
      state: { $in: ["scheduled", "active"] },
      groupsEnabled: true,
      groups: { $size: 2 },
      "groups.key": { $ne: expect.stringMatching(/^g_[0-9a-f]{8}$/) },
      "groups.kind": { $ne: "leads" },
      captainsEnabled: true,
    });
  });

  it("reports one result in the host's words", async () => {
    const out = await lobbyOn();
    expect(text(out)).toBe(
      "Saved: Captains lobby is now on (a leaders-only channel that only the host and the current leaders can join).",
    );
    expect(live.describeLiveEditOutcome(out).details).toMatchObject({
      outcome: "applied",
      changes: [{ row: "captainsLobby", from: false, to: true }],
    });
  });

  it("names it after the leader label and keeps the name unique", async () => {
    seed([teamGroup(A, "Alpha"), teamGroup(B, "Captain lobby")], {
      leaderLabel: "Captain",
    });
    await lobbyOn();
    expect(leadsRows()[0].name).toBe("Captain lobby 2");
  });

  it("needs leaders on (stored, or turned on by the same save), and says so; nothing is written", async () => {
    store.get(EV)!.captainsEnabled = false;
    const out = await lobbyOn();
    expect(out).toMatchObject({ status: "invalid" });
    expect(text(out)).toContain("turn leaders on first");
    expect(leadsRows()).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("is refused while events are off", async () => {
    enabled = false;
    const out = await lobbyOn();
    expect(out).toMatchObject({ status: "refused", code: "events-off" });
    expect(writes).toEqual([]);
  });

  it("an event without groups cannot have one", async () => {
    store.get(EV)!.groupsEnabled = false;
    const out = await lobbyOn();
    expect(out).toMatchObject({ status: "invalid" });
    expect(writes).toEqual([]);
  });

  it("an event that has not started creates no channel: the group is made with the others later", async () => {
    store.get(EV)!.channelId = null;
    store.get(EV)!.groups = [
      teamGroup(A, "Alpha", { channelId: null }),
      teamGroup(B, "Bravo", { channelId: null }),
    ];
    const out = await lobbyOn();
    expect(done(out).applied).toHaveLength(1);
    expect(leadsRows()[0].channelId).toBeNull();
    expect(calls).toEqual(["leads"]);
  });

  it("saving the same form again is already applied and writes nothing", async () => {
    await lobbyOn();
    writes.length = 0;
    calls.length = 0;
    const again = done(await lobbyOn());
    expect(again.applied).toEqual([]);
    expect(again.alreadyApplied).toEqual(["captainsLobby"]);
    expect(writes).toEqual([]);
    expect(calls).toEqual([]);
    expect(leadsRows()).toHaveLength(1);
  });

  it("an untouched switch (value equals base) is never written", async () => {
    const out = done(await run([entry(CAPTAINS_LOBBY_ROW_ID, false, false)]));
    expect(out.applied).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("another save that turned it on meanwhile is a conflict, not a second lobby", async () => {
    // The form showed "off"; the stored state is "on" and the form asks for off:
    // the base is stale.
    seed([teamGroup(A, "Alpha"), teamGroup(B, "Bravo"), lobbyGroup()]);
    const out = done(await run([entry(CAPTAINS_LOBBY_ROW_ID, false, false)]));
    expect(out.applied).toEqual([]);
    expect(leadsRows()).toHaveLength(1);
  });

  it("never pushes a second leads group when one appears between the plan and the write", async () => {
    // A concurrent writer turns a group into a leads group without changing the
    // count: only the `groups.kind $ne` condition notices.
    // Before the push (the second write: the first is the save's claim), after
    // the row's own fresh read.
    fake.beforeWrite = () => {
      if (writes.length >= 1) {
        fake.beforeWrite = null;
        groupsOf()[1].kind = "leads";
      }
    };
    const out = done(await lobbyOn());
    expect(out.applied).toEqual([]);
    expect(out.notApplied).toMatchObject([{ rowId: "captainsLobby" }]);
    expect(text(out)).toContain("changed by someone else");
    expect(leadsRows()).toHaveLength(1);
    expect(groupsOf()).toHaveLength(2);
  });

  it("leaders on and the lobby on are ONE valid save, whatever order the form posts them in", async () => {
    const posted = [
      entry("captainsEnabled", true, false),
      entry(CAPTAINS_LOBBY_ROW_ID, true, false),
    ];
    for (const entries of [posted, [...posted].reverse()]) {
      seed([teamGroup(A, "Alpha"), teamGroup(B, "Bravo")], {
        captainsEnabled: false,
      });
      calls.length = 0;
      const out = done(await run(entries));
      // Executed in registry order: leaders first, then the lobby.
      expect(out.applied.map((c) => c.rowId)).toEqual([
        "captainsEnabled",
        "captainsLobby",
      ]);
      expect(out.notApplied).toEqual([]);
      expect(store.get(EV)!.captainsEnabled).toBe(true);
      expect(leadsRows()).toHaveLength(1);
      expect(leadsRows()[0].channelId).toMatch(/^made-/);
      expect(calls).toContain("leads");
    }
  });

  it("is named from the state the save leaves: the leader label changed in the same save", async () => {
    const out = done(
      await run([
        entry("leaderLabel", "Captain", "Leader"),
        entry(CAPTAINS_LOBBY_ROW_ID, true, false),
      ]),
    );
    expect(out.applied.map((c) => c.rowId)).toEqual([
      "leaderLabel",
      "captainsLobby",
    ]);
    expect(leadsRows()[0].name).toBe("Captain lobby");
  });

  it("picks a unique name when another group is renamed to the lobby's name in the same save", async () => {
    const out = done(
      await run([
        entry(groupNameRowId(0), "Leader lobby", "Alpha"),
        entry(CAPTAINS_LOBBY_ROW_ID, true, false),
      ]),
    );
    expect(out.applied.map((c) => c.rowId)).toEqual([
      groupNameRowId(0),
      "captainsLobby",
    ]);
    expect(out.notApplied).toEqual([]);
    expect(groupsOf()[0].name).toBe("Leader lobby");
    expect(leadsRows()[0].name).toBe("Leader lobby 2");
  });

  it("holds events.groups.max_count against a group added in the same save: 14 plus the new group is 15, the lobby would be 16", async () => {
    const many = Array.from({ length: 14 }, (_, i) =>
      teamGroup(`g_${(i + 16).toString(16).padStart(8, "0")}`, `Team ${i}`, {
        channelId: null,
      }),
    );
    seed(many);
    const out = done(
      await run([
        entry(
          "groupAdd",
          [
            {
              key: "g_0000abcd",
              name: "Extra",
              kind: "team",
              size: null,
              tag: "",
            },
          ],
          [],
        ),
        entry(CAPTAINS_LOBBY_ROW_ID, true, false),
      ]),
    );
    expect(out.applied.map((c) => c.rowId)).toEqual(["groupAdd"]);
    expect(out.notApplied).toHaveLength(1);
    expect(text(out)).toContain("the limit is 15");
    expect(groupsOf()).toHaveLength(15);
    expect(leadsRows()).toEqual([]);
  });

  it("leaders off and the lobby on in one save is refused, and nothing at all is written", async () => {
    const out = await run([
      entry("captainsEnabled", false, true),
      entry(CAPTAINS_LOBBY_ROW_ID, true, false),
    ]);
    expect(out).toMatchObject({ status: "invalid" });
    expect(text(out)).toContain("turn leaders on first");
    expect(store.get(EV)!.captainsEnabled).toBe(true);
    expect(leadsRows()).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("leaders off and the lobby off in one save: both are applied", async () => {
    seed([teamGroup(A, "Alpha"), teamGroup(B, "Bravo"), lobbyGroup()]);
    connected = new Set();
    const out = done(
      await run([
        entry("captainsEnabled", false, true),
        entry(CAPTAINS_LOBBY_ROW_ID, false, true),
      ]),
    );
    expect(out.applied.map((c) => c.rowId)).toEqual([
      "captainsEnabled",
      "captainsLobby",
    ]);
    expect(store.get(EV)!.captainsEnabled).toBe(false);
    expect(leadsRows()).toEqual([]);
  });

  it("leaders turned off by an earlier row after the plan: the lobby write holds leaders and is lost, never a lobby without leaders", async () => {
    // The plan saw leaders on. Another writer turns them off right before the
    // lobby's push (the second write: the first is the save's claim).
    fake.beforeWrite = () => {
      if (writes.length >= 1) {
        fake.beforeWrite = null;
        store.get(EV)!.captainsEnabled = false;
      }
    };
    const out = done(await lobbyOn());
    expect(out.applied).toEqual([]);
    expect(out.notApplied).toMatchObject([{ rowId: "captainsLobby" }]);
    expect(leadsRows()).toEqual([]);
  });

  it("is not made once an end or cancel holds the event", async () => {
    // The hold is asked at the gate, at the claim, before the row and right
    // before the write: it appears at the last of these.
    let asked = 0;
    const holding: LiveEditDeps = { ...deps, isEnding: () => ++asked > 3 };
    const out = await run([entry(CAPTAINS_LOBBY_ROW_ID, true, false)], holding);
    expect(done(out).notApplied).toHaveLength(1);
    expect(text(out)).toContain("the event is being ended");
    expect(leadsRows()).toEqual([]);
    expect(rowWrites()).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("a channel that could not be made (re-save after a partial failure)", () => {
  it("stores the lobby, reports the channel as owed, and a re-save finishes it without a second group", async () => {
    createResult = () => {
      const key = leadsRows()[0].key as string;
      return {
        failures: [{ key, reason: "Discord refused: Missing Permissions" }],
      };
    };
    const first = await lobbyOn();
    const d = done(first);
    expect(d.partial).toHaveLength(1);
    expect(d.partial[0].owed).toContain("not created yet");
    expect(d.partial[0].owed).toContain("Missing Permissions");
    expect(text(first)).toContain("Save again to finish");
    expect(leadsRows()).toHaveLength(1);
    expect(leadsRows()[0].channelId).toBeNull();
    // The access follow-up still ran: the lobby is stored.
    expect(calls).toEqual(["create", "leads"]);

    // The refreshed form shows the stored value as both value and base.
    createResult = () => ({ failures: [] });
    calls.length = 0;
    writes.length = 0;
    const again = done(await run([entry(CAPTAINS_LOBBY_ROW_ID, true, true)]));
    expect(again.applied).toMatchObject([
      { rowId: "captainsLobby", reconcile: true },
    ]);
    expect(leadsRows()).toHaveLength(1);
    expect(leadsRows()[0].channelId).toMatch(/^made-/);
    expect(calls).toEqual(["create", "leads"]);
    // No group was pushed by the retry: only the revision claim was written.
    expect(rowWrites()).toEqual([]);
  });

  it("an unreachable server is owed too, never success", async () => {
    createResult = () => null;
    const out = done(await lobbyOn());
    expect(out.partial).toHaveLength(1);
    expect(out.partial[0].owed).toContain("the server could not be reached");
  });

  it("a lobby whose channel exists owes nothing: a same-value save is already applied", async () => {
    seed([teamGroup(A, "Alpha"), teamGroup(B, "Bravo"), lobbyGroup()]);
    const out = done(await run([entry(CAPTAINS_LOBBY_ROW_ID, true, false)]));
    expect(out.alreadyApplied).toEqual(["captainsLobby"]);
    expect(out.partial).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("turning it off", () => {
  beforeEach(() => {
    seed([teamGroup(A, "Alpha"), teamGroup(B, "Bravo"), lobbyGroup()]);
  });

  it("asks first when the lobby has a channel, and changes nothing until confirmed", async () => {
    const first = await lobbyOff();
    expect(first.status).toBe("needs-confirmation");
    if (first.status === "needs-confirmation") {
      expect(first.reasons).toHaveLength(1);
      expect(first.reasons[0]).toContain("moves everybody in its channel");
      expect(first.reasons[0]).toContain("deletes the channel");
    }
    expect(writes).toEqual([]);
    expect(calls).toEqual([]);
    expect(leadsRows()).toHaveLength(1);
  });

  it("moves everybody to the main channel first, then deletes the channel and the group", async () => {
    const { second } = await confirmed([
      entry(CAPTAINS_LOBBY_ROW_ID, false, true),
    ]);
    expect(done(second).applied).toHaveLength(1);
    expect(calls).toEqual([
      `empty:${LOBBY}:c-lobby`,
      `remove:${LOBBY}:c-lobby`,
    ]);
    expect(leadsRows()).toEqual([]);
    expect(groupsOf().map((g) => g.key)).toEqual([A, B]);
    expect(text(second)).toBe(
      "Saved: Captains lobby is now off (the channel is removed; leaders talk in the main channel).",
    );
  });

  it("a confirmation is single use", async () => {
    const first = await lobbyOff();
    if (first.status !== "needs-confirmation") throw new Error("expected");
    const token = live.signConfirmation({
      eventId: EV,
      guildId: GUILD,
      userId: HOST,
      changes: first.changes.map((c) => ({
        rowId: c.rowId,
        from: c.from,
        to: c.to,
        guard: c.guard,
      })),
      revision: first.revision,
      voiceInUse: first.voiceInUse,
    });
    const check = live.verifyConfirmation(token, {
      eventId: EV,
      guildId: GUILD,
      userId: HOST,
    });
    if (!check.ok) throw new Error("token refused");
    const useIt = (): Promise<LiveEditOutcome> =>
      live.runLiveEdit({
        guildId: GUILD,
        eventId: EV,
        deps,
        confirmed: check.changes,
        confirmedRevision: check.revision,
        confirmedVoiceInUse: check.voiceInUse,
      });
    expect(done(await useIt()).applied).toHaveLength(1);
    // The lobby is turned on again, then the old token is replayed.
    await lobbyOn();
    calls.length = 0;
    const replay = await useIt();
    expect(replay.status).toBe("stale");
    expect(calls).toEqual([]);
    expect(leadsRows()).toHaveLength(1);
  });

  it("asks only when somebody is connected to a voice channel of the event: the main channel, a group's or the lobby's", async () => {
    for (const where of ["c-main", `c-${A}`, "c-lobby"]) {
      connected = new Set([where]);
      const first = await lobbyOff();
      expect(first.status).toBe("needs-confirmation");
      if (first.status === "needs-confirmation") {
        expect(first.voiceInUse).toBe(true);
        expect(first.reasons[0]).toContain("Somebody is connected");
      }
    }
    // Somebody in a voice channel that is not the event's does not count.
    connected = new Set(["c-elsewhere"]);
    expect(done(await lobbyOff()).applied).toHaveLength(1);
    expect(asked[0]).toEqual(["c-main", `c-${A}`, `c-${B}`, "c-lobby"]);
  });

  it("nobody connected: no confirmation even though the lobby has a channel", async () => {
    connected = new Set();
    const out = done(await lobbyOff());
    expect(out.applied).toHaveLength(1);
    expect(calls).toEqual([
      `empty:${LOBBY}:c-lobby`,
      `remove:${LOBBY}:c-lobby`,
    ]);
    expect(leadsRows()).toEqual([]);
  });

  it("an unreadable cache is in use: it asks", async () => {
    effects!.eventVoiceInUse = () => {
      throw new Error("cache gone");
    };
    expect((await lobbyOff()).status).toBe("needs-confirmation");
    effects = undefined;
    expect((await lobbyOff()).status).toBe("needs-confirmation");
  });

  it("somebody connecting between the page and the confirmed run needs a fresh confirmation", async () => {
    connected = new Set();
    // Another row of the same save needs a confirmation, so a token exists
    // while the lobby change itself needs none (nobody is connected).
    const first = await run([
      entry(CAPTAINS_LOBBY_ROW_ID, false, true),
      entry(GROUP_REMOVE_ROW_ID, [B], []),
    ]);
    expect(first.status).toBe("needs-confirmation");
    if (first.status !== "needs-confirmation") return;
    expect(first.voiceInUse).toBe(false);
    const token = live.signConfirmation({
      eventId: EV,
      guildId: GUILD,
      userId: HOST,
      changes: first.changes.map((c) => ({
        rowId: c.rowId,
        from: c.from,
        to: c.to,
        guard: c.guard,
      })),
      revision: first.revision,
      voiceInUse: first.voiceInUse,
    });
    const check = live.verifyConfirmation(token, {
      eventId: EV,
      guildId: GUILD,
      userId: HOST,
    });
    if (!check.ok) throw new Error("token refused");
    expect(check.voiceInUse).toBe(false);
    const confirmRun = (): Promise<LiveEditOutcome> =>
      live.runLiveEdit({
        guildId: GUILD,
        eventId: EV,
        deps,
        confirmed: check.changes,
        confirmedRevision: check.revision,
        confirmedVoiceInUse: check.voiceInUse,
      });
    // Somebody joins the lobby after the page was shown.
    connected = new Set(["c-lobby"]);
    const stale = await confirmRun();
    expect(stale.status).toBe("stale");
    expect(leadsRows()).toHaveLength(1);
    expect(groupsOf()).toHaveLength(3);
    expect(calls).toEqual([]);
  });

  it("everybody leaving between the page and the confirmed run is fine: the confirmation was for more", async () => {
    connected = new Set(["c-lobby"]);
    const first = await lobbyOff();
    if (first.status !== "needs-confirmation") throw new Error("expected");
    const token = live.signConfirmation({
      eventId: EV,
      guildId: GUILD,
      userId: HOST,
      changes: first.changes.map((c) => ({
        rowId: c.rowId,
        from: c.from,
        to: c.to,
        guard: c.guard,
      })),
      revision: first.revision,
      voiceInUse: first.voiceInUse,
    });
    const check = live.verifyConfirmation(token, {
      eventId: EV,
      guildId: GUILD,
      userId: HOST,
    });
    if (!check.ok) throw new Error("token refused");
    connected = new Set();
    const out = await live.runLiveEdit({
      guildId: GUILD,
      eventId: EV,
      deps,
      confirmed: check.changes,
      confirmedRevision: check.revision,
      confirmedVoiceInUse: check.voiceInUse,
    });
    expect(done(out).applied).toHaveLength(1);
    expect(leadsRows()).toEqual([]);
  });

  it("a channel recorded after the plan is not part of what was asked: nothing is moved or deleted, the next save asks", async () => {
    connected = new Set();
    seed([
      teamGroup(A, "Alpha"),
      teamGroup(B, "Bravo"),
      lobbyGroup({ channelId: null }),
    ]);
    // The plan sees no channel and nobody connected, so no confirmation. The
    // channel pass (its own lock, no revision) records one before the row runs.
    fake.beforeWrite = () => {
      fake.beforeWrite = null;
      groupsOf()[2].channelId = "c-late";
      connected = new Set(["c-late"]);
    };
    const out = done(await lobbyOff());
    expect(out.applied).toEqual([]);
    expect(text(out)).toContain("its channel changed since you reviewed it");
    expect(calls).toEqual([]);
    expect(leadsRows()).toHaveLength(1);
    expect(leadsRows()[0].channelId).toBe("c-late");
    // Saved again, it is planned from the new state and asks.
    expect((await lobbyOff()).status).toBe("needs-confirmation");
  });

  it("the confirmation is for the lobby and channel the host was shown: a channel recorded between the page and the confirmation is not deleted", async () => {
    seed([
      teamGroup(A, "Alpha"),
      teamGroup(B, "Bravo"),
      lobbyGroup({ channelId: null }),
    ]);
    // Somebody is in the main channel, so the page asks (the lobby has no
    // channel yet).
    connected = new Set(["c-main"]);
    const first = await lobbyOff();
    if (first.status !== "needs-confirmation") throw new Error("expected");
    const token = live.signConfirmation({
      eventId: EV,
      guildId: GUILD,
      userId: HOST,
      changes: first.changes.map((c) => ({
        rowId: c.rowId,
        from: c.from,
        to: c.to,
        guard: c.guard,
      })),
      revision: first.revision,
      voiceInUse: first.voiceInUse,
    });
    const check = live.verifyConfirmation(token, {
      eventId: EV,
      guildId: GUILD,
      userId: HOST,
    });
    if (!check.ok) throw new Error("token refused");
    // The channel pass (own lock, no revision) records the lobby's channel, and
    // somebody is in it, before the host confirms.
    groupsOf()[2].channelId = "c-new";
    connected = new Set(["c-main", "c-new"]);
    const out = await live.runLiveEdit({
      guildId: GUILD,
      eventId: EV,
      deps,
      confirmed: check.changes,
      confirmedRevision: check.revision,
      confirmedVoiceInUse: check.voiceInUse,
    });
    expect(out.status).toBe("stale");
    expect(calls).toEqual([]);
    expect(leadsRows()).toHaveLength(1);
    expect(leadsRows()[0].channelId).toBe("c-new");
  });

  it("nobody was connected at the plan, so nobody was confirmed: somebody who joins the lobby before the move is not moved", async () => {
    connected = new Set();
    // The plan sees every channel empty and asks nothing. Somebody joins the
    // lobby before the row runs (at the save's claim).
    fake.beforeWrite = () => {
      fake.beforeWrite = null;
      connected = new Set(["c-lobby"]);
    };
    const out = done(await lobbyOff());
    expect(out.applied).toEqual([]);
    expect(text(out)).toContain("somebody joined its channel");
    expect(calls).toEqual([]);
    expect(leadsRows()).toHaveLength(1);
    // Saved again, it is planned from the new state and asks.
    expect((await lobbyOff()).status).toBe("needs-confirmation");
  });

  it("a lobby that has no channel yet is removed without asking, by one conditional pull", async () => {
    connected = new Set();
    seed([
      teamGroup(A, "Alpha"),
      teamGroup(B, "Bravo"),
      lobbyGroup({ channelId: null }),
    ]);
    const out = done(await lobbyOff());
    expect(out.applied).toHaveLength(1);
    expect(leadsRows()).toEqual([]);
    expect(calls).toEqual([]);
    expect(rowWrites()).toHaveLength(1);
    expect(rowWrites()[0].update).toEqual({
      $pull: { groups: { key: LOBBY, channelId: null } },
    });
  });

  it("keeps the lobby and its channel when somebody cannot be moved, and a re-save finishes it", async () => {
    emptyResult = () => ({
      status: "occupied",
      moved: [],
      remaining: 1,
      detail: "u9: Missing Permissions",
    });
    const { second } = await confirmed([
      entry(CAPTAINS_LOBBY_ROW_ID, false, true),
    ]);
    const d = done(second);
    expect(d.applied).toEqual([]);
    expect(d.notApplied).toHaveLength(1);
    expect(text(second)).toContain("still in its channel");
    expect(text(second)).toContain("u9: Missing Permissions");
    expect(text(second)).toContain("Save again");
    // Nothing was deleted: the lobby and its channel are as they were.
    expect(calls).toEqual([`empty:${LOBBY}:c-lobby`]);
    expect(leadsRows()).toHaveLength(1);
    expect(leadsRows()[0].channelId).toBe("c-lobby");

    // The people left; the same form again (confirmed again) removes it.
    emptyResult = () => ({ status: "empty", moved: [] });
    calls.length = 0;
    const retry = await confirmed([entry(CAPTAINS_LOBBY_ROW_ID, false, true)]);
    expect(done(retry.second).applied).toHaveLength(1);
    expect(leadsRows()).toEqual([]);
    expect(calls).toEqual([
      `empty:${LOBBY}:c-lobby`,
      `remove:${LOBBY}:c-lobby`,
    ]);
  });

  it("keeps the lobby when its channel could not be deleted, and says the retry is a save away", async () => {
    removeResult = () => ({ status: "failed", reason: "Missing Permissions" });
    const { second } = await confirmed([
      entry(CAPTAINS_LOBBY_ROW_ID, false, true),
    ]);
    expect(done(second).notApplied).toHaveLength(1);
    expect(text(second)).toContain("its channel could not be deleted");
    expect(text(second)).toContain("Save again to retry");
    // A lobby has no members: the text must not claim any were unassigned.
    expect(text(second)).not.toContain("unassigned");
    expect(leadsRows()).toHaveLength(1);
  });

  it("stops before deleting when an end or cancel took its hold after the people were moved", async () => {
    effects!.emptyGroupChannel = async (_g, _e, key, channelId) => {
      calls.push(`empty:${key}:${channelId}`);
      ending = true;
      return { status: "empty", moved: [] };
    };
    const { second } = await confirmed([
      entry(CAPTAINS_LOBBY_ROW_ID, false, true),
    ]);
    expect(done(second).notApplied).toHaveLength(1);
    expect(text(second)).toContain("the event is being ended");
    expect(calls).toEqual([`empty:${LOBBY}:c-lobby`]);
    expect(leadsRows()).toHaveLength(1);
  });

  it("is allowed with leaders off, so a lobby left behind can always be removed", async () => {
    store.get(EV)!.captainsEnabled = false;
    const { second } = await confirmed([
      entry(CAPTAINS_LOBBY_ROW_ID, false, true),
    ]);
    expect(done(second).applied).toHaveLength(1);
    expect(leadsRows()).toEqual([]);
  });

  it("no follow-up runs for a lobby that is gone", async () => {
    await confirmed([entry(CAPTAINS_LOBBY_ROW_ID, false, true)]);
    expect(calls).not.toContain("leads");
  });
});

describe("leaders switched off while the lobby exists", () => {
  it("keeps the lobby group (stored data is kept, the switches hide it) and still reads as on", async () => {
    seed([teamGroup(A, "Alpha"), teamGroup(B, "Bravo"), lobbyGroup()]);
    const out = done(await run([entry("captainsEnabled", false, true)]));
    expect(out.applied).toHaveLength(1);
    expect(leadsRows()).toHaveLength(1);
    expect(leadsRows()[0].channelId).toBe("c-lobby");
    expect(captainsLobbyRow.read(store.get(EV) as never)).toBe(true);
    // The leaders-only pass runs (it takes the leaders' access away).
    expect(calls).toContain("leads");
  });
});

describe("the hidden group in the group rows", () => {
  it("is not a group an event keeps: the last visible group cannot be removed even with a lobby", async () => {
    seed([teamGroup(A, "Alpha"), lobbyGroup()]);
    const out = await run([entry(GROUP_REMOVE_ROW_ID, [A], [])]);
    expect(out).toMatchObject({ status: "invalid" });
    expect(text(out)).toContain("an event keeps at least one group");
    expect(groupsOf()).toHaveLength(2);
  });

  it("the write-time check holds too: a group another save removed meanwhile makes the last visible group stay", async () => {
    seed([teamGroup(A, "Alpha"), teamGroup(B, "Bravo"), lobbyGroup()]);
    // After the plan (two visible groups) and before the row runs, another save
    // removes Alpha: Bravo is the last visible group, the lobby is not one.
    fake.beforeWrite = () => {
      fake.beforeWrite = null;
      store.get(EV)!.groups = groupsOf().filter((g) => g.key !== A);
    };
    const { second } = await confirmed([entry(GROUP_REMOVE_ROW_ID, [B], [])]);
    expect(text(second)).toContain("is the last group of the event");
    expect(groupsOf().map((g) => g.key)).toEqual([B, LOBBY]);
    expect(calls).toEqual([]);
  });

  it("a name typed for another group that is the lobby's says so, instead of naming a group nobody can see", async () => {
    seed([teamGroup(A, "Alpha"), teamGroup(B, "Bravo"), lobbyGroup()]);
    const add = await run([
      entry(
        "groupAdd",
        [
          {
            key: "g_0000abcd",
            name: "LEADER lobby",
            kind: "team",
            size: null,
            tag: "",
          },
        ],
        [],
      ),
    ]);
    expect(add).toMatchObject({ status: "invalid" });
    expect(text(add)).toContain(
      '"LEADER lobby" is the name of the captains lobby, which is not listed here',
    );
    const rename = await run([
      entry(groupNameRowId(0), "Leader Lobby", "Alpha"),
    ]);
    expect(rename).toMatchObject({ status: "invalid" });
    expect(text(rename)).toContain("is the name of the captains lobby");
    expect(groupsOf().map((g) => g.name)).toEqual([
      "Alpha",
      "Bravo",
      "Leader lobby",
    ]);
    expect(writes).toEqual([]);
  });

  it("a legacy event with only a leads group keeps it on 'off' and says how to get rid of it: an event keeps at least one group", async () => {
    seed([lobbyGroup()]);
    connected = new Set();
    const out = done(await lobbyOff());
    expect(out.applied).toEqual([]);
    expect(out.notApplied).toHaveLength(1);
    expect(text(out)).toContain("only group of the event");
    expect(text(out)).toContain("Groups on or off");
    expect(groupsOf()).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it("a group can still be removed while another visible group stays", async () => {
    seed([teamGroup(A, "Alpha"), teamGroup(B, "Bravo"), lobbyGroup()]);
    const { second } = await confirmed([entry(GROUP_REMOVE_ROW_ID, [B], [])]);
    expect(done(second).applied).toHaveLength(1);
    expect(groupsOf().map((g) => g.key)).toEqual([A, LOBBY]);
  });
});
