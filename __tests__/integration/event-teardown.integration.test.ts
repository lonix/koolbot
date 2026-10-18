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
      beginEnding: () => undefined,
      abortEnding: () => undefined,
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

  it("an event of another server is not found and not ended", async () => {
    const id = await makeEvent();
    const outcome = await teardown().run(input(id, { guildId: "guild-2" }));
    expect(outcome.status).toBe("not-found");
    expect((await stored(id)).state).toBe("active");
  });
});
