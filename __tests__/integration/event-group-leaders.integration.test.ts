import {
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import { ConfigService } from "../../src/services/config-service.js";
import { describeWithMongo, useRealMongo } from "./mongo-harness.js";
import { Event } from "../../src/models/event.js";
import { TrackingOptOutService } from "../../src/services/tracking-opt-out-service.js";
import {
  assignMember as assignMemberReal,
  removeMemberFromEvents,
} from "../../src/services/event-group-assignment.js";
import {
  clearOrphanedLeaders,
  installLeaderCleanup,
  removeLeaderFromEvents,
  setGroupLeader as setGroupLeaderReal,
  setLeaderLabel,
} from "../../src/services/event-group-leaders.js";

/**
 * Group leaders (#1195) write `groups.$[g].captainId` with `arrayFilters` (one
 * and several array filters, with a `$elemMatch` precondition in the filter).
 * The unit suites use an in-memory stand-in for the model, so they cannot tell
 * whether MongoDB accepts those shapes, whether `modifiedCount` is what the
 * service relies on, or what the writes do to the other fields of the same
 * array; these run the real services against a real server.
 */
const setGroupLeader = (
  o: Omit<Parameters<typeof setGroupLeaderReal>[0], "admission">,
) =>
  setGroupLeaderReal({
    admission: TrackingOptOutService.getInstance().admission(),
    ...o,
  });
const assignMember = (
  o: Omit<Parameters<typeof assignMemberReal>[0], "admission" | "isConnected">,
) =>
  assignMemberReal({
    admission: TrackingOptOutService.getInstance().admission(),
    isConnected: () => true,
    ...o,
  });

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++)
    await new Promise((r) => globalThis.setTimeout(r, 0));
};

describeWithMongo("event group leaders against a real MongoDB (#1195)", () => {
  useRealMongo();

  let uninstall: () => void = () => undefined;

  beforeAll(async () => {
    await Event.init();
    await TrackingOptOutService.getInstance().initialize();
  });

  beforeEach(async () => {
    await Event.deleteMany({});
    jest
      .spyOn(ConfigService.getInstance(), "getBoolean")
      .mockImplementation(async (key: string) => key === "events.enabled");
    uninstall = installLeaderCleanup();
  });

  afterEach(() => {
    uninstall();
  });

  const GUILD = "guild-1";

  async function makeEvent(
    over: Record<string, unknown> = {},
  ): Promise<{ id: string }> {
    const event = await Event.create({
      guildId: GUILD,
      title: "Clan match",
      startTime: new Date(Date.now() + 3_600_000),
      createdBy: "host",
      state: "active",
      groupsEnabled: true,
      captainsEnabled: true,
      groups: [
        {
          key: "g_a",
          name: "Heli",
          kind: "team",
          size: 3,
          channelId: "ch-a",
          memberIds: ["u1", "u2"],
        },
        {
          key: "g_b",
          name: "Logi",
          kind: "team",
          channelId: "ch-b",
          memberIds: ["u3"],
        },
        { key: "g_o", name: "Spectators", kind: "open", channelId: "ch-o" },
      ],
      ...over,
    });
    return { id: String(event._id) };
  }

  const stored = async (id: string) => {
    const row = await Event.findById(id).lean();
    if (!row) throw new Error("event missing");
    return row;
  };
  const captain = async (id: string, key: string): Promise<string | null> =>
    (await stored(id)).groups.find((g) => g.key === key)?.captainId ?? null;

  it("has the index the export and the reset use", async () => {
    const keys = (await Event.collection.indexes()).map((i) =>
      Object.keys(i.key).join(","),
    );
    expect(keys).toContain("groups.captainId");
  });

  it("sets, replaces and clears a leader without touching the other fields of the groups", async () => {
    const { id } = await makeEvent();
    expect(
      await setGroupLeader({
        guildId: GUILD,
        eventId: id,
        groupKey: "g_a",
        userId: "u1",
      }),
    ).toMatchObject({ ok: true, changed: true });
    expect(await captain(id, "g_a")).toBe("u1");
    await setGroupLeader({
      guildId: GUILD,
      eventId: id,
      groupKey: "g_a",
      userId: "u2",
    });
    expect(await captain(id, "g_a")).toBe("u2");
    await setGroupLeader({
      guildId: GUILD,
      eventId: id,
      groupKey: "g_a",
      userId: null,
    });
    expect(await captain(id, "g_a")).toBeNull();
    const row = await stored(id);
    expect(
      row.groups.map((g) => [g.key, g.name, g.size, g.channelId, g.memberIds]),
    ).toEqual([
      ["g_a", "Heli", 3, "ch-a", ["u1", "u2"]],
      ["g_b", "Logi", null, "ch-b", ["u3"]],
      ["g_o", "Spectators", null, "ch-o", []],
    ]);
  });

  it("refuses a non-member, an open group and a switched-off event, storing nothing", async () => {
    const { id } = await makeEvent();
    expect(
      await setGroupLeader({
        guildId: GUILD,
        eventId: id,
        groupKey: "g_a",
        userId: "u3",
      }),
    ).toMatchObject({ ok: false, code: "not-member" });
    expect(
      await setGroupLeader({
        guildId: GUILD,
        eventId: id,
        groupKey: "g_o",
        userId: "u1",
      }),
    ).toMatchObject({ ok: false, code: "not-team" });
    await Event.updateOne({ _id: id }, { $set: { captainsEnabled: false } });
    expect(
      await setGroupLeader({
        guildId: GUILD,
        eventId: id,
        groupKey: "g_a",
        userId: "u1",
      }),
    ).toMatchObject({ ok: false, code: "leaders-off" });
    expect(await captain(id, "g_a")).toBeNull();
  });

  it("the write's own filter refuses a member who left the group (no silent no-op)", async () => {
    const { id } = await makeEvent();
    // Bypass the service's read: the filter alone must not store a stranger.
    const result = await Event.updateOne(
      {
        _id: id,
        groups: { $elemMatch: { key: "g_a", kind: "team", memberIds: "u3" } },
      },
      { $set: { "groups.$[g].captainId": "u3" } },
      { arrayFilters: [{ "g.key": "g_a" }] },
    );
    expect(result.matchedCount).toBe(0);
    expect(await captain(id, "g_a")).toBeNull();
  });

  it("unassigning clears the role through the real hook, and a reset clears it too", async () => {
    const { id } = await makeEvent();
    await setGroupLeader({
      guildId: GUILD,
      eventId: id,
      groupKey: "g_a",
      userId: "u1",
    });
    await setGroupLeader({
      guildId: GUILD,
      eventId: id,
      groupKey: "g_b",
      userId: "u3",
    });
    await assignMember({
      guildId: GUILD,
      eventId: id,
      userId: "u1",
      groupKey: null,
    });
    await settle();
    expect(await captain(id, "g_a")).toBeNull();
    expect(await captain(id, "g_b")).toBe("u3");
    await removeMemberFromEvents(GUILD, "u3");
    await settle();
    expect(await captain(id, "g_b")).toBeNull();
  });

  it("clears several orphaned leaders in one write, each conditional on its own id", async () => {
    const { id } = await makeEvent({
      groups: [
        {
          key: "g_a",
          name: "Heli",
          kind: "team",
          memberIds: ["u2"],
          captainId: "u1",
        },
        {
          key: "g_b",
          name: "Logi",
          kind: "team",
          memberIds: ["u4"],
          captainId: "u3",
        },
        {
          key: "g_c",
          name: "Fob",
          kind: "team",
          memberIds: ["u5"],
          captainId: "u5",
        },
      ],
    });
    expect(await clearOrphanedLeaders(GUILD, id)).toBe(2);
    expect(await captain(id, "g_a")).toBeNull();
    expect(await captain(id, "g_b")).toBeNull();
    expect(await captain(id, "g_c")).toBe("u5");
  });

  it("the reset removes a member as leader in every event of the guild, finished ones included", async () => {
    const one = await makeEvent();
    const two = await makeEvent({ state: "ended" });
    const other = await makeEvent({ guildId: "guild-2" });
    for (const { id } of [one, two, other]) {
      await Event.updateOne(
        { _id: id },
        { $set: { "groups.0.captainId": "u1" } },
      );
    }
    const result = await removeLeaderFromEvents(GUILD, "u1");
    expect(result).toEqual({ matched: 2, removed: 2, failed: 0 });
    expect(await captain(one.id, "g_a")).toBeNull();
    expect(await captain(two.id, "g_a")).toBeNull();
    expect(await captain(other.id, "g_a")).toBe("u1");
  });

  it("renames the label and nothing else", async () => {
    const { id } = await makeEvent();
    expect(
      await setLeaderLabel({ guildId: GUILD, eventId: id, label: "Captain" }),
    ).toEqual({ ok: true });
    const row = await stored(id);
    expect(row.leaderLabel).toBe("Captain");
    expect(row.groups).toHaveLength(3);
  });
});
