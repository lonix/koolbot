import { describe, it, expect, jest, beforeEach } from "@jest/globals";

/**
 * The tick "also for the next occurrences" of the live edit (#1266): the row of
 * `event-live-edit-series.ts` run through the REAL core (planner, executor,
 * both locks, revision claim) with the lock row, against the in-memory Event
 * stand-in of `event-live-edit-fake-event.ts`. The real filter shapes are
 * proven against MongoDB in `__tests__/integration/event-series-setup.integration.test.ts`.
 *
 * Expected values are literals, never computed by a copy of the logic under test.
 */

import {
  store,
  writes,
  claims,
  fake,
  SETTABLE,
  EventMock,
  type Json,
} from "./event-live-edit-fake-event.js";

jest.unstable_mockModule("../../src/models/event.js", () => ({
  Event: EventMock,
}));
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: { getInstance: () => ({}) },
}));
jest.unstable_mockModule(
  "../../src/services/tracking-opt-out-service.js",
  () => ({ TrackingOptOutService: { getInstance: () => ({}) } }),
);

process.env.WEBUI_SESSION_SECRET = "live-edit-series-test-secret";

const live = await import("../../src/services/event-live-edit.js");
const { seriesSetupRow, SERIES_SETUP_ROW_ID } =
  await import("../../src/services/event-live-edit-series.js");
const { resetMoveGuardForTests } =
  await import("../../src/services/event-move-guard.js");
type LiveEditDeps =
  import("../../src/services/event-live-edit.js").LiveEditDeps;
type IEvent = import("../../src/models/event.js").IEvent;

const GUILD = "guild-1";
const EV = "65a000000000000000000001";

let ending = false;
const deps = (): LiveEditDeps => ({
  isEventsEnabled: async () => true,
  maxGroups: async () => 15,
  isEnding: () => ending,
});

const ROWS = [live.lockGroupsRow, seriesSetupRow];

function seed(over: Json = {}): Json {
  const doc: Json = {
    _id: EV,
    guildId: GUILD,
    state: "active",
    recurrence: "weekly",
    seriesId: "series-1",
    seriesCancelled: false,
    groupsEnabled: true,
    groupsLocked: false,
    presetId: "builtin:eve",
    groupLabel: "Squad",
    leaderLabel: "Captain",
    captainsEnabled: true,
    captainCustomisationEnabled: true,
    tagsEnabled: true,
    tagsSuffix: false,
    channelLeadMinutes: 30,
    channelId: "c-main",
    groups: [
      {
        key: "g_a",
        // A leader renamed the host's "Caldari" and retagged it.
        name: "Quizzzzbois",
        kind: "team",
        size: 6,
        tag: "QZ",
        marker: "",
        originalName: "Caldari",
        originalTag: "CAL",
        channelId: "c-a",
        captainId: "u-leader",
        memberIds: ["u1", "u2"],
      },
      {
        key: "g_b",
        name: "Gallente",
        kind: "open",
        size: null,
        tag: "",
        marker: "",
        channelId: "c-b",
        captainId: null,
        memberIds: [],
      },
    ],
    ...over,
  };
  store.set(EV, doc);
  return doc;
}

const save = (submission: unknown[]) =>
  live.runLiveEdit({
    guildId: GUILD,
    eventId: EV,
    deps: deps(),
    rows: ROWS,
    submission: submission as never,
  });

const tick = { rowId: SERIES_SETUP_ROW_ID, to: true, base: false };
const lock = (to: boolean) => ({
  rowId: "groupsLocked",
  to,
  base: !to,
});

beforeEach(() => {
  store.clear();
  writes.length = 0;
  claims.length = 0;
  fake.beforeWrite = null;
  fake.failReads = false;
  fake.afterFind = null;
  SETTABLE.add("seriesGroupSetup");
  ending = false;
  resetMoveGuardForTests();
});

describe("the tick 'also for the next occurrences' (#1266)", () => {
  it("stores the host's setup for the series: the host's names, no people, leaders or channels", async () => {
    seed();
    const out = await save([tick]);
    expect(out).toMatchObject({ status: "done" });
    const stored = store.get(EV)?.seriesGroupSetup;
    expect(stored).toEqual({
      groupsEnabled: true,
      presetId: "builtin:eve",
      groupLabel: "Squad",
      leaderLabel: "Captain",
      groupsLocked: false,
      captainsEnabled: true,
      captainCustomisationEnabled: true,
      tagsEnabled: true,
      tagsSuffix: false,
      groups: [
        {
          key: "g_a",
          name: "Caldari",
          kind: "team",
          size: 6,
          tag: "CAL",
          marker: "",
        },
        {
          key: "g_b",
          name: "Gallente",
          kind: "open",
          size: null,
          tag: "",
          marker: "",
        },
      ],
    });
    const text = JSON.stringify(stored);
    for (const forbidden of [
      "Quizzzzbois",
      "u1",
      "u-leader",
      "c-a",
      "c-main",
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("without the tick a change applies to this occurrence only: the series setup is not written", async () => {
    seed();
    const out = await save([lock(true)]);
    expect(out).toMatchObject({ status: "done" });
    expect(store.get(EV)?.groupsLocked).toBe(true);
    expect(store.get(EV)?.seriesGroupSetup).toBeUndefined();
    expect(writes.map((w) => Object.keys(w.set))).toEqual([["groupsLocked"]]);
  });

  it("with the tick the series setup is what the SAME save leaves behind", async () => {
    seed();
    const out = await save([lock(true), tick]);
    expect(out).toMatchObject({ status: "done" });
    expect(store.get(EV)?.groupsLocked).toBe(true);
    expect(
      (store.get(EV)?.seriesGroupSetup as { groupsLocked: boolean })
        .groupsLocked,
    ).toBe(true);
    // The lock row ran first, the tick last.
    expect(writes.map((w) => Object.keys(w.set))).toEqual([
      ["groupsLocked"],
      ["seriesGroupSetup"],
    ]);
  });

  it("saving the tick again replaces the stored setup with the then-current one", async () => {
    seed();
    await save([tick]);
    store.get(EV)!.groupsLocked = true;
    await save([tick]);
    expect(
      (store.get(EV)?.seriesGroupSetup as { groupsLocked: boolean })
        .groupsLocked,
    ).toBe(true);
  });

  it("with groups off the series is stored without groups", async () => {
    seed({ groupsEnabled: false });
    await save([tick]);
    expect(store.get(EV)?.seriesGroupSetup).toMatchObject({
      groupsEnabled: false,
      groups: [],
    });
  });

  it("is refused for an event that does not repeat, and writes nothing", async () => {
    seed({ recurrence: "none", seriesId: null });
    const out = await save([tick]);
    expect(out).toMatchObject({
      status: "invalid",
      errors: [
        "Group setup of the next occurrences: This event does not repeat.",
      ],
    });
    expect(writes).toEqual([]);
  });

  it("is refused for a cancelled series", async () => {
    seed({ seriesCancelled: true });
    const out = await save([tick]);
    expect(out).toMatchObject({ status: "invalid" });
    expect(writes).toEqual([]);
  });

  it("an event that ended between the plan and the write is a lost write, not a success", async () => {
    seed();
    fake.beforeWrite = (): void => {
      store.get(EV)!.state = "ended";
    };
    const out = await save([tick]);
    expect(out).toMatchObject({
      status: "done",
      applied: [],
      notApplied: [{ rowId: SERIES_SETUP_ROW_ID }],
    });
    expect(store.get(EV)?.seriesGroupSetup).toBeUndefined();
  });

  it("does not write while an end holds the event", async () => {
    seed();
    ending = true;
    const out = await save([tick]);
    expect(out).toMatchObject({ status: "refused", code: "ending" });
    expect(writes).toEqual([]);
  });

  it("an end that takes hold after the plan stops the tick before it writes (the other row was stored, by the core)", async () => {
    seed();
    // The lock row writes first; an end takes hold as that write starts.
    fake.beforeWrite = (): void => {
      ending = true;
    };
    const out = await save([lock(true), tick]);
    expect(out).toMatchObject({
      status: "done",
      notApplied: [{ rowId: SERIES_SETUP_ROW_ID }],
    });
    expect(store.get(EV)?.groupsLocked).toBe(true);
    expect(store.get(EV)?.seriesGroupSetup).toBeUndefined();
  });

  it("a hold that begins while the row reads the event stops the write, even though the core's own check passed", async () => {
    seed();
    // The core asks isEnding before calling the row; the hold starts DURING the
    // row's own read, after that check.
    let reads = 0;
    fake.afterFind = (): void => {
      reads += 1;
      // The first read is the core's fresh read; the second is the row's.
      if (reads === 2) ending = true;
    };
    const out = await save([tick]);
    expect(reads).toBe(2);
    expect(out).toMatchObject({
      status: "done",
      applied: [],
      notApplied: [{ rowId: SERIES_SETUP_ROW_ID }],
    });
    expect(writes).toEqual([]);
    expect(store.get(EV)?.seriesGroupSetup).toBeUndefined();
  });

  it("always reads as off, so the form shows the tick unticked", () => {
    expect(seriesSetupRow.read(seed() as unknown as IEvent)).toBe(false);
  });
});
