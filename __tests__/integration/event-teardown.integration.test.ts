import { it, expect, beforeAll, beforeEach } from "@jest/globals";
import { describeWithMongo, useRealMongo } from "./mongo-harness.js";
import { Event } from "../../src/models/event.js";
import { EventTeardown } from "../../src/services/event-teardown.js";

/**
 * The shared teardown (#1193) saves the end with one atomic `findOneAndUpdate`
 * (a state filter, `$set` of `state` and `endedAt`, `new: true`) and clears the
 * group leaders with `$set: { "groups.$[].captainId": null }`. The unit suites
 * mock the model, so they cannot tell whether MongoDB accepts those shapes or
 * that only one of several concurrent callers wins the claim; these run the
 * real `EventTeardown` against a real server and read the stored documents
 * back. Discord is stubbed (no pull-back, no channels).
 */
describeWithMongo("event teardown against a real MongoDB (#1193)", () => {
  useRealMongo();

  beforeAll(async () => {
    await Event.init();
  });

  beforeEach(async () => {
    await Event.deleteMany({});
  });

  const GUILD = "guild-1";
  const START = new Date("2030-01-01T19:00:00.000Z");
  const END = new Date("2030-01-01T21:00:00.000Z");

  let cleanups = 0;
  function teardown(): EventTeardown {
    cleanups = 0;
    return new EventTeardown({
      client: {} as never,
      updateAnnouncement: async () => true,
      syncNative: async () => undefined,
      cleanupGroupChannels: async () => {
        cleanups += 1;
        return {
          created: 0,
          removed: 0,
          occupied: 0,
          failures: [],
          warnings: [],
        };
      },
      logLifecycle: async () => undefined,
      getGraceMinutes: async () => 15,
      beginEnding: () => 1,
      abortEnding: () => undefined,
      finishEnding: () => undefined,
      settleMs: 0,
    });
  }

  async function makeEvent(
    over: Record<string, unknown> = {},
  ): Promise<string> {
    const event = await Event.create({
      guildId: GUILD,
      title: "Quiz night",
      startTime: START,
      durationMinutes: 120,
      createdBy: "host",
      state: "active",
      groupsEnabled: true,
      groups: [
        {
          key: "g_a",
          name: "Red",
          kind: "team",
          channelId: "ch-a",
          captainId: "cap-1",
          memberIds: ["m1", "m2"],
        },
        {
          key: "g_b",
          name: "Blue",
          kind: "team",
          channelId: "ch-b",
          captainId: "cap-2",
          memberIds: ["m3"],
        },
      ],
      ...over,
    });
    return String(event._id);
  }

  const input = (id: string, over: Record<string, unknown> = {}): never =>
    ({
      eventId: id,
      guildId: GUILD,
      trigger: "manual",
      pullBack: false,
      now: new Date(),
      endedAt: new Date("2030-01-01T20:00:00.000Z"),
      fromStates: ["active"],
      guild: {} as never,
      syncNative: false,
      ...over,
    }) as never;

  const stored = async (id: string) => {
    const row = await Event.findById(id).lean();
    if (!row) throw new Error("event missing");
    return row;
  };

  it("a new event has no end recorded", async () => {
    const id = await makeEvent();
    expect((await stored(id)).endedAt).toBeNull();
  });

  it("the claim stores the state and the end time, and returns the stored row", async () => {
    const id = await makeEvent();
    const endedAt = new Date("2030-01-01T20:00:00.000Z");
    const outcome = await teardown().run(input(id, { endedAt }));
    expect(outcome.status).toBe("ended");
    const row = await stored(id);
    expect(row.state).toBe("ended");
    expect(row.endedAt).toEqual(endedAt);
    if (outcome.status === "ended") {
      expect(outcome.event.state).toBe("ended");
      expect(outcome.event.endedAt).toEqual(endedAt);
    }
  });

  it("clears every group leader and leaves the assignments alone", async () => {
    const id = await makeEvent();
    await teardown().run(input(id));
    const row = await stored(id);
    expect(row.groups.map((g) => g.captainId)).toEqual([null, null]);
    expect(row.groups.map((g) => g.memberIds)).toEqual([["m1", "m2"], ["m3"]]);
    expect(row.groups.map((g) => g.channelId)).toEqual(["ch-a", "ch-b"]);
  });

  it("the second end is a no-op and keeps the first end time", async () => {
    const id = await makeEvent();
    const t = teardown();
    const first = new Date("2030-01-01T20:00:00.000Z");
    await t.run(input(id, { endedAt: first }));
    const again = await t.run(
      input(id, { endedAt: new Date("2030-01-01T20:30:00.000Z") }),
    );
    expect(again.status).toBe("already-ended");
    expect((await stored(id)).endedAt).toEqual(first);
    expect(cleanups).toBe(1);
  });

  it("only one of several simultaneous ends runs the teardown", async () => {
    const id = await makeEvent();
    const t = teardown();
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () => t.run(input(id))),
    );
    expect(outcomes.filter((o) => o.status === "ended")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "already-ended")).toHaveLength(
      5,
    );
    expect(cleanups).toBe(1);
  });

  it("a manual end claims only an active event; a scheduled or cancelled one is untouched", async () => {
    const scheduled = await makeEvent({ state: "scheduled" });
    const cancelled = await makeEvent({ state: "cancelled" });
    const t = teardown();
    expect(await t.run(input(scheduled))).toEqual({
      status: "not-running",
      state: "scheduled",
    });
    expect(await t.run(input(cancelled))).toEqual({
      status: "not-running",
      state: "cancelled",
    });
    expect((await stored(scheduled)).state).toBe("scheduled");
    expect((await stored(cancelled)).state).toBe("cancelled");
    expect((await stored(cancelled)).groups[0]?.captainId).toBe("cap-1");
  });

  it("the scheduled end claims a scheduled event on the times the scan read, and not on others", async () => {
    const id = await makeEvent({ state: "scheduled" });
    const t = teardown();
    const scheduledInput = (duration: number): never =>
      input(id, {
        trigger: "scheduled",
        fromStates: ["scheduled", "active"],
        endedAt: END,
        expectTimes: { startTime: START, durationMinutes: duration },
      });
    // The scan read 90 minutes; the stored event says 120 (edited meanwhile).
    expect(await t.run(scheduledInput(90))).toEqual({ status: "changed" });
    expect((await stored(id)).state).toBe("scheduled");
    const ended = await t.run(scheduledInput(120));
    expect(ended.status).toBe("ended");
    expect((await stored(id)).endedAt).toEqual(END);
  });

  it("the scan's own copy does not write the claimed end again, so a cancel that lands meanwhile survives its save", async () => {
    const id = await makeEvent({ state: "scheduled" });
    // The scan's copy of the row, loaded before the end.
    const doc = await Event.findById(id);
    if (!doc) throw new Error("event missing");
    const outcome = await teardown().run(
      input(id, {
        trigger: "scheduled",
        fromStates: ["scheduled", "active"],
        endedAt: END,
        expectTimes: { startTime: START, durationMinutes: 120 },
        event: doc,
      }),
    );
    expect(outcome.status).toBe("ended");
    expect(doc.state).toBe("ended");
    expect(doc.endedAt).toEqual(END);
    // A cancel lands, then the scan saves its copy for another change.
    await Event.updateOne({ _id: id }, { $set: { state: "cancelled" } });
    doc.reminderSent = true;
    await doc.save();
    const row = await stored(id);
    expect(row.state).toBe("cancelled");
    expect(row.reminderSent).toBe(true);
  });

  it("the scheduled end claims only while the channels it checked are still the stored ones", async () => {
    const t = teardown();
    const scheduledInput = (id: string, expectChannels: unknown): never =>
      input(id, {
        trigger: "scheduled",
        fromStates: ["scheduled", "active"],
        endedAt: END,
        expectTimes: { startTime: START, durationMinutes: 120 },
        expectChannels,
      });
    const id = await makeEvent();
    const stored1 = await stored(id);
    const matching = {
      main: stored1.channelId ?? null,
      groups: stored1.groups.map((g) => ({
        key: g.key,
        channelId: g.channelId ?? null,
      })),
    };
    // A channel recorded since the check: refused, nothing runs.
    expect(
      await t.run(
        scheduledInput(id, {
          ...matching,
          groups: matching.groups.map((g) =>
            g.key === "g_a" ? { ...g, channelId: "ch-other" } : g,
          ),
        }),
      ),
    ).toEqual({ status: "changed" });
    expect(
      await t.run(scheduledInput(id, { ...matching, groups: [] })),
    ).toEqual({ status: "changed" });
    expect((await stored(id)).state).toBe("active");
    // The same channels (a null matches a stored null): claimed.
    expect((await t.run(scheduledInput(id, matching))).status).toBe("ended");
    expect((await stored(id)).state).toBe("ended");
  });

  it("a stored event with no groups field at all (made before groups existed) can still be ended on schedule", async () => {
    // Written straight to the collection: the model would fill in `groups: []`,
    // which hides that `$size: 0` does not match a missing field.
    const inserted = await Event.collection.insertOne({
      guildId: GUILD,
      title: "Old event",
      startTime: START,
      durationMinutes: 120,
      createdBy: "host",
      state: "active",
      // no channelId, no groups, no groupsEnabled
    });
    const id = String(inserted.insertedId);
    const raw = await Event.collection.findOne({ _id: inserted.insertedId });
    expect(raw && "groups" in raw).toBe(false);
    const scheduledInput = (groupsExpected: number): never =>
      input(id, {
        trigger: "scheduled",
        fromStates: ["scheduled", "active"],
        endedAt: END,
        expectTimes: { startTime: START, durationMinutes: 120 },
        expectChannels: {
          main: null,
          groups: Array.from({ length: groupsExpected }, (_v, i) => ({
            key: `g_${i}`,
            channelId: null,
          })),
        },
      });
    const t = teardown();
    // A group the check never saw is still refused.
    expect(await t.run(scheduledInput(1))).toEqual({ status: "changed" });
    expect((await stored(id)).state).toBe("active");
    // No groups expected, none stored (absent): the end goes through.
    expect((await t.run(scheduledInput(0))).status).toBe("ended");
    expect((await stored(id)).state).toBe("ended");
  });

  it("an event of another server is not found and not ended", async () => {
    const id = await makeEvent();
    const outcome = await teardown().run(input(id, { guildId: "guild-2" }));
    expect(outcome.status).toBe("not-found");
    expect((await stored(id)).state).toBe("active");
  });
});
