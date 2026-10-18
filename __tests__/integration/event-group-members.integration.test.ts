import { it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import { ConfigService } from "../../src/services/config-service.js";
import { describeWithMongo, useRealMongo } from "./mongo-harness.js";
import { Event } from "../../src/models/event.js";
import { TrackingOptOutService } from "../../src/services/tracking-opt-out-service.js";
import {
  assignMember as assignMemberReal,
  handleGroupSelfJoin,
  randomiseMembers as randomiseMembersReal,
  removeMemberFromEvents,
  setGroupsLocked,
} from "../../src/services/event-group-assignment.js";

/**
 * Group membership (#1191) writes `groups.$[g].memberIds` with `arrayFilters`
 * and erases a member with `$pull` on `groups.$[].memberIds`. The unit suite
 * mocks the model, so it cannot tell whether MongoDB accepts those shapes or
 * what they do to the other fields of the same array; these run the real
 * service against a real server and read the stored documents back.
 */
type AssignOpts = Parameters<typeof assignMemberReal>[0];
type RandomiseOpts = Parameters<typeof randomiseMembersReal>[0];
// The service refuses a missing ticket or presence check on purpose (it fails
// closed), so these helpers pass explicit ones: a real ticket, and "connected".
const assignMember = (
  o: Omit<AssignOpts, "admission" | "isConnected"> &
    Partial<Pick<AssignOpts, "isConnected">>,
) =>
  assignMemberReal({
    admission: TrackingOptOutService.getInstance().admission(),
    isConnected: () => true,
    ...o,
  });
const randomiseMembers = (o: Omit<RandomiseOpts, "admission">) =>
  randomiseMembersReal({
    admission: TrackingOptOutService.getInstance().admission(),
    ...o,
  });

describeWithMongo("event group members against a real MongoDB (#1191)", () => {
  useRealMongo();

  beforeAll(async () => {
    await Event.init();
    await TrackingOptOutService.getInstance().initialize();
  });

  beforeEach(async () => {
    await Event.deleteMany({});
    // Self-join is gated on the Events master switch; the config store is not
    // what these tests are about, so the key is read as on.
    jest
      .spyOn(ConfigService.getInstance(), "getBoolean")
      .mockImplementation(async (key: string) => key === "events.enabled");
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
      groups: [
        {
          key: "g_a",
          name: "Heli",
          kind: "team",
          size: 3,
          channelId: "ch-a",
          captainId: "cap-1",
        },
        { key: "g_b", name: "Logi", kind: "team", channelId: "ch-b" },
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
  const members = async (id: string, key: string): Promise<string[]> =>
    (await stored(id)).groups.find((g) => g.key === key)?.memberIds ?? [];

  it("has the indexes the export, the reset and the voice lookup use", async () => {
    const keys = (await Event.collection.indexes()).map((i) =>
      Object.keys(i.key).join(","),
    );
    expect(keys).toContain("groups.memberIds");
    expect(keys).toContain("groups.channelId");
  });

  it("assigns, moves and unassigns without touching the other fields of the groups", async () => {
    const { id } = await makeEvent();
    expect(
      await assignMember({
        guildId: GUILD,
        eventId: id,
        userId: "u1",
        groupKey: "g_a",
      }),
    ).toMatchObject({ ok: true, changed: true });
    expect(await members(id, "g_a")).toEqual(["u1"]);

    await assignMember({
      guildId: GUILD,
      eventId: id,
      userId: "u1",
      groupKey: "g_b",
    });
    expect(await members(id, "g_a")).toEqual([]);
    expect(await members(id, "g_b")).toEqual(["u1"]);

    await assignMember({
      guildId: GUILD,
      eventId: id,
      userId: "u1",
      groupKey: null,
    });
    expect(await members(id, "g_b")).toEqual([]);

    // Names, sizes, channels and captains of every group are as they were.
    const row = await stored(id);
    expect(
      row.groups.map((g) => [g.key, g.name, g.size, g.channelId, g.captainId]),
    ).toEqual([
      ["g_a", "Heli", 3, "ch-a", "cap-1"],
      ["g_b", "Logi", null, "ch-b", null],
      ["g_o", "Spectators", null, "ch-o", null],
    ]);
  });

  it("refuses an add for someone not connected or with an unreadable voice state, and writes nothing", async () => {
    const { id } = await makeEvent();
    for (const answer of [false, null]) {
      const result = await assignMember({
        guildId: GUILD,
        eventId: id,
        userId: "u1",
        groupKey: "g_a",
        isConnected: () => answer,
      });
      expect(result).toMatchObject({
        ok: false,
        code: answer === null ? "no-voice-state" : "not-connected",
      });
    }
    expect(await members(id, "g_a")).toEqual([]);
  });

  it("keeps a group within its size when many assignments arrive at once", async () => {
    const { id } = await makeEvent();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        assignMember({
          guildId: GUILD,
          eventId: id,
          userId: `u${i}`,
          groupKey: "g_a",
        }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(await members(id, "g_a")).toHaveLength(3);
  });

  it("keeps a member in one group when they are assigned to two at once", async () => {
    const { id } = await makeEvent();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        assignMember({
          guildId: GUILD,
          eventId: id,
          userId: "same",
          groupKey: i % 2 === 0 ? "g_a" : "g_b",
        }),
      ),
    );
    const row = await stored(id);
    expect(row.groups.filter((g) => g.memberIds.includes("same"))).toHaveLength(
      1,
    );
  });

  it("refuses a finished event and writes nothing", async () => {
    const { id } = await makeEvent({ state: "ended" });
    expect(
      await assignMember({
        guildId: GUILD,
        eventId: id,
        userId: "u1",
        groupKey: "g_a",
      }),
    ).toMatchObject({ ok: false, code: "closed" });
    expect(await members(id, "g_a")).toEqual([]);
  });

  it("randomises into the team groups, within sizes, in one write", async () => {
    const { id } = await makeEvent();
    const result = await randomiseMembers({
      guildId: GUILD,
      eventId: id,
      candidateIds: Array.from({ length: 8 }, (_, i) => `u${i}`),
      mode: "unassigned",
      seed: 11,
    });
    if (!result.ok) throw new Error("expected success");
    // Even deal until Heli's size (3) is reached, then the rest go to Logi.
    expect(await members(id, "g_a")).toHaveLength(3);
    expect(await members(id, "g_b")).toHaveLength(5);
    expect(await members(id, "g_o")).toEqual([]);
    expect(result.unplaced).toEqual([]);
  });

  it("stores the host's lock", async () => {
    const { id } = await makeEvent();
    await setGroupsLocked({ guildId: GUILD, eventId: id, locked: true });
    expect((await stored(id)).groupsLocked).toBe(true);
    await setGroupsLocked({ guildId: GUILD, eventId: id, locked: false });
    expect((await stored(id)).groupsLocked).toBe(false);
  });

  it("records a self-join only for a team channel of an open, unlocked event", async () => {
    const { id } = await makeEvent();
    const ticket = TrackingOptOutService.getInstance().admission();
    const join = (userId: string, channelId: string) =>
      handleGroupSelfJoin({
        guildId: GUILD,
        userId,
        channelId,
        admission: ticket,
      });

    expect(await join("u1", "ch-a")).toBe("recorded");
    expect(await join("u1", "ch-b")).toBe("recorded");
    expect(await members(id, "g_a")).toEqual([]);
    expect(await members(id, "g_b")).toEqual(["u1"]);
    expect(await join("u1", "ch-o")).toBe("not-team");
    expect(await join("u1", "ch-elsewhere")).toBe("no-event");
    expect(await members(id, "g_b")).toEqual(["u1"]);

    await setGroupsLocked({ guildId: GUILD, eventId: id, locked: true });
    expect(await join("u1", "ch-a")).toBe("locked");
    expect(await members(id, "g_b")).toEqual(["u1"]);
  });

  it("pulls a member out of every group of every event, finished ones too, and nobody else", async () => {
    const withMembers = (state: string, extra: string[]) =>
      makeEvent({
        state,
        groups: [
          { key: "g_a", name: "A", kind: "team", memberIds: ["me", ...extra] },
          { key: "g_b", name: "B", kind: "team", memberIds: ["me-too"] },
        ],
      });
    const active = await withMembers("active", ["x"]);
    const ended = await withMembers("ended", []);
    const none = await makeEvent();

    const result = await removeMemberFromEvents(GUILD, "me");
    expect(result).toEqual({ matched: 2, removed: 2, failed: 0 });
    expect(await members(active.id, "g_a")).toEqual(["x"]);
    expect(await members(ended.id, "g_a")).toEqual([]);
    expect(await members(ended.id, "g_b")).toEqual(["me-too"]);
    expect(await members(none.id, "g_a")).toEqual([]);

    // Safe to run twice.
    expect(await removeMemberFromEvents(GUILD, "me")).toEqual({
      matched: 0,
      removed: 0,
      failed: 0,
    });
  });

  it("does not touch another guild's events", async () => {
    const other = await makeEvent({
      guildId: "guild-2",
      groups: [{ key: "g_a", name: "A", kind: "team", memberIds: ["me"] }],
    });
    expect(await removeMemberFromEvents(GUILD, "me")).toMatchObject({
      matched: 0,
    });
    expect(await members(other.id, "g_a")).toEqual(["me"]);
  });
});
