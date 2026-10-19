import { it, expect, beforeAll, beforeEach } from "@jest/globals";
import { describeWithMongo, useRealMongo } from "./mongo-harness.js";
import { Event } from "../../src/models/event.js";
import {
  LIVE_EDIT_ROWS,
  runLiveEdit,
  type LiveEditDeps,
} from "../../src/services/event-live-edit.js";

/**
 * The live edit (#1239) writes with filters the unit suite's stand-in can only
 * imitate: `$nor` over a main channel and over `groups: { $elemMatch }`, `$type`
 * string with `$ne: ""`, `channelLeadMinutes: null` matching a missing field and
 * `groupsLocked: { $ne: true }` matching a row from before the field existed.
 * These run the real service against a real server and read the raw stored
 * documents back.
 */
describeWithMongo("event live edit against a real MongoDB (#1239)", () => {
  useRealMongo();

  beforeAll(async () => {
    await Event.init();
  });
  beforeEach(async () => {
    await Event.deleteMany({});
  });

  const GUILD = "guild-1";
  const deps: LiveEditDeps = {
    isEventsEnabled: async () => true,
    maxGroups: async () => 15,
    isEnding: () => false,
  };

  async function makeEvent(
    over: Record<string, unknown> = {},
  ): Promise<string> {
    const event = await Event.create({
      guildId: GUILD,
      title: "Clan match",
      startTime: new Date(Date.now() + 3_600_000),
      createdBy: "host",
      state: "active",
      groupsEnabled: true,
      channelLeadMinutes: 30,
      groups: [
        {
          key: "g_a",
          name: "Heli",
          kind: "team",
          size: 2,
          memberIds: ["u1", "u2", "u3"],
        },
        { key: "g_b", name: "Logi", kind: "team" },
      ],
      ...over,
    });
    return String(event._id);
  }

  const raw = async (id: string): Promise<Record<string, unknown>> => {
    const doc = await Event.collection.findOne({
      _id: new (await import("mongoose")).default.Types.ObjectId(id),
    });
    if (!doc) throw new Error("event missing");
    return doc as unknown as Record<string, unknown>;
  };

  const run = (
    eventId: string,
    entries: Array<{ rowId: string; to: unknown; base: unknown }>,
  ) =>
    runLiveEdit({
      guildId: GUILD,
      eventId,
      deps,
      rows: LIVE_EDIT_ROWS,
      submission: entries as never,
    });

  it("changes the lead time and the lock, and touches nothing else (groups, over-size, state, channelId)", async () => {
    const id = await makeEvent();
    const before = await raw(id);
    const out = await run(id, [
      { rowId: "channelLeadMinutes", to: 45, base: 30 },
      { rowId: "groupsLocked", to: true, base: false },
    ]);
    expect(out).toMatchObject({ status: "done", notApplied: [] });
    const after = await raw(id);
    expect(after.channelLeadMinutes).toBe(45);
    expect(after.groupsLocked).toBe(true);
    expect(after.groups).toEqual(before.groups);
    expect(after.state).toBe("active");
    expect(after.channelId).toBe(before.channelId);
    // Over size (3 people in a group of 2) is computed on read, never stored.
    for (const g of after.groups as Array<Record<string, unknown>>) {
      expect(Object.keys(g)).not.toContain("overSize");
    }
  });

  it("counts each applying save in liveEditRevision, from a row that has none, conditional on the revision it planned at", async () => {
    const id = await makeEvent();
    expect((await raw(id)).liveEditRevision).toBeUndefined();
    await run(id, [{ rowId: "channelLeadMinutes", to: 45, base: 30 }]);
    expect((await raw(id)).liveEditRevision).toBe(1);
    // Nothing to do: the revision does not move.
    await run(id, [{ rowId: "channelLeadMinutes", to: 45, base: 30 }]);
    expect((await raw(id)).liveEditRevision).toBe(1);
    await run(id, [{ rowId: "groupsLocked", to: true, base: false }]);
    expect((await raw(id)).liveEditRevision).toBe(2);
  });

  it("a token issued at an older revision cannot apply again after the value went back (real MongoDB)", async () => {
    const id = await makeEvent();
    const confirmedChanges = [
      { rowId: "channelLeadMinutes", from: 30, to: 45 },
    ];
    const replay = () =>
      runLiveEdit({
        guildId: GUILD,
        eventId: id,
        deps,
        rows: LIVE_EDIT_ROWS,
        confirmed: confirmedChanges,
        confirmedRevision: 0,
      });
    expect(await replay()).toMatchObject({ status: "done" });
    await run(id, [{ rowId: "channelLeadMinutes", to: 30, base: 45 }]);
    expect((await raw(id)).channelLeadMinutes).toBe(30);
    expect(await replay()).toMatchObject({ status: "stale" });
    expect((await raw(id)).channelLeadMinutes).toBe(30);
  });

  it("the lead time is refused once the main channel exists, and a write racing it is lost", async () => {
    const id = await makeEvent({ channelId: "c-main" });
    expect(
      await run(id, [{ rowId: "channelLeadMinutes", to: 45, base: 30 }]),
    ).toMatchObject({ status: "invalid" });
    expect((await raw(id)).channelLeadMinutes).toBe(30);

    // The row's own conditional write, decided before the channel appeared.
    const row = LIVE_EDIT_ROWS.find((r) => r.id === "channelLeadMinutes");
    const loose = await makeEvent();
    const event = (await Event.findById(loose).lean()) as never;
    await Event.updateOne({ _id: loose }, { $set: { channelId: "c-main" } });
    expect(
      await row?.apply({
        event,
        eventId: loose,
        guildId: GUILD,
        from: 30,
        to: 45,
        ending: () => false,
      }),
    ).toEqual({ status: "lost" });
    expect((await raw(loose)).channelLeadMinutes).toBe(30);
  });

  it("one group channel among groups without one is enough to refuse (not `groups.channelId: null`)", async () => {
    const id = await makeEvent({
      groups: [
        { key: "g_a", name: "Heli", kind: "team", channelId: "c-a" },
        { key: "g_b", name: "Logi", kind: "team" },
      ],
    });
    expect(
      await run(id, [{ rowId: "channelLeadMinutes", to: 45, base: 30 }]),
    ).toMatchObject({ status: "invalid" });
    expect((await raw(id)).channelLeadMinutes).toBe(30);
  });

  it("an event with no channel anywhere accepts the lead time, from the server default (field null) too", async () => {
    const id = await makeEvent({ channelLeadMinutes: null });
    expect(
      await run(id, [{ rowId: "channelLeadMinutes", to: 10, base: null }]),
    ).toMatchObject({ status: "done", notApplied: [] });
    expect((await raw(id)).channelLeadMinutes).toBe(10);
    expect(
      await run(id, [{ rowId: "channelLeadMinutes", to: null, base: 10 }]),
    ).toMatchObject({ status: "done", notApplied: [] });
    expect((await raw(id)).channelLeadMinutes).toBeNull();
  });

  it("a legacy row without the lock, lead and channel fields can be edited", async () => {
    const id = await makeEvent();
    await Event.collection.updateOne(
      { _id: new (await import("mongoose")).default.Types.ObjectId(id) },
      { $unset: { groupsLocked: "", channelLeadMinutes: "", channelId: "" } },
    );
    const out = await run(id, [
      { rowId: "channelLeadMinutes", to: 20, base: null },
      { rowId: "groupsLocked", to: true, base: false },
    ]);
    expect(out).toMatchObject({ status: "done", notApplied: [] });
    const after = await raw(id);
    expect(after.channelLeadMinutes).toBe(20);
    expect(after.groupsLocked).toBe(true);
  });

  it("the lock write is conditional on the stored value and on the event being open", async () => {
    const id = await makeEvent({ groupsLocked: true });
    const row = LIVE_EDIT_ROWS.find((r) => r.id === "groupsLocked");
    const event = (await Event.findById(id).lean()) as never;
    const ctx = {
      event,
      eventId: id,
      guildId: GUILD,
      ending: () => false,
    };
    // Decided from "unlocked" while it is locked: lost, value kept.
    expect(await row?.apply({ ...ctx, from: false, to: true })).toEqual({
      status: "lost",
    });
    expect(await row?.apply({ ...ctx, from: true, to: false })).toEqual({
      status: "applied",
    });
    await Event.updateOne({ _id: id }, { $set: { state: "ended" } });
    expect(await row?.apply({ ...ctx, from: false, to: true })).toEqual({
      status: "lost",
    });
    expect((await raw(id)).groupsLocked).toBe(false);
  });

  it("refuses an ended event and another guild's event without writing", async () => {
    const ended = await makeEvent({ state: "ended" });
    expect(
      await run(ended, [{ rowId: "groupsLocked", to: true, base: false }]),
    ).toMatchObject({ status: "refused", code: "not-open" });
    const other = await makeEvent({ guildId: "guild-2" });
    expect(
      await run(other, [{ rowId: "groupsLocked", to: true, base: false }]),
    ).toMatchObject({ status: "refused", code: "no-event" });
    expect((await raw(ended)).groupsLocked).toBe(false);
    expect((await raw(other)).groupsLocked).toBe(false);
  });
});
