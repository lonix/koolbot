import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import {
  store,
  fake,
  EventMock,
  type Doc,
  type Group,
} from "./event-group-fake-event.js";

/**
 * A member data reset against host assignment (#1191), with the REAL
 * tracking barrier (`TrackingOptOutService.withTrackingPaused`, the same one
 * the reset runs inside) and the in-memory Event stand-in. After a reset that
 * has finished the member must hold ZERO memberships, whichever way a host
 * write was timed against it.
 */

jest.unstable_mockModule("../../src/models/event.js", () => ({
  Event: EventMock,
}));

const { assignMember, randomiseMembers, removeMemberFromEvents } =
  await import("../../src/services/event-group-assignment.js");
const { TrackingOptOutService } =
  await import("../../src/services/tracking-opt-out-service.js");

const GUILD = "guild-1";
const EV = "65a000000000000000000001";
const ME = "111111111111111111";
const OTHER = "222222222222222222";

const group = (key: string, over: Partial<Group> = {}): Group => ({
  key,
  name: key,
  kind: "team",
  size: null,
  channelId: null,
  captainId: null,
  memberIds: [],
  ...over,
});

function seed(id = EV): Doc {
  const doc: Doc = {
    _id: id,
    guildId: GUILD,
    state: "active",
    groupsEnabled: true,
    groupsLocked: false,
    groups: [group("a"), group("b")],
  };
  store.set(id, doc);
  return doc;
}

const holders = (user: string): string[] =>
  [...store.values()].flatMap((d) =>
    d.groups.filter((g) => g.memberIds.includes(user)).map((g) => g.key),
  );

const tracking = (): InstanceType<typeof TrackingOptOutService> =>
  TrackingOptOutService.getInstance();

/** Let the reset reach its paused state. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

/** A reset the way the purge runs it: paused, drained, then the pull. */
const reset = (user: string, before?: () => Promise<void>): Promise<unknown> =>
  tracking().withTrackingPaused(user, GUILD, async () => {
    if (before) await before();
    await removeMemberFromEvents(GUILD, user);
  });

beforeEach(() => {
  store.clear();
  fake.failUpdatesFor = null;
  fake.delayFor = null;
  TrackingOptOutService.reset();
});

describe("host assignment against a member reset", () => {
  it("refuses an add that arrives while the reset is running, leaving zero memberships", async () => {
    seed();
    const ticket = tracking().admission();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const resetting = reset(ME, () => gate);
    // The reset is paused and waiting; the host's click lands now.
    await settle();
    const result = await assignMember({
      guildId: GUILD,
      eventId: EV,
      userId: ME,
      groupKey: "a",
      admission: ticket,
      isConnected: () => true,
    });
    expect(result).toMatchObject({ ok: false, code: "member-reset" });
    release();
    await resetting;
    expect(holders(ME)).toEqual([]);
  });

  it("refuses an add whose ticket predates a reset that has already finished", async () => {
    seed();
    const ticket = tracking().admission();
    await reset(ME);
    const result = await assignMember({
      guildId: GUILD,
      eventId: EV,
      userId: ME,
      groupKey: "a",
      admission: ticket,
      isConnected: () => true,
    });
    expect(result).toMatchObject({ ok: false, code: "member-reset" });
    expect(holders(ME)).toEqual([]);
  });

  it("makes the reset wait for an add already under way, so its pull sees the add", async () => {
    // The add is admitted and slow (queued reads). The reset starts meanwhile;
    // it must drain that write BEFORE it looks for memberships, or it would
    // find none and the add would land afterwards.
    seed();
    fake.delayFor = (filter) => ("_id" in filter ? 40 : 0);
    const adding = assignMember({
      guildId: GUILD,
      eventId: EV,
      userId: ME,
      groupKey: "a",
      admission: tracking().admission(),
      isConnected: () => true,
    });
    const resetting = reset(ME);
    const [added] = await Promise.all([adding, resetting]);
    expect(added).toMatchObject({ ok: true });
    expect(holders(ME)).toEqual([]);
  });

  it("covers an event that only gets the member after the reset's first query would have run", async () => {
    // Two events; the add targets the second while the reset is under way.
    seed(EV);
    seed("65a000000000000000000002");
    fake.delayFor = (filter) => ("_id" in filter ? 40 : 0);
    const adding = assignMember({
      guildId: GUILD,
      eventId: "65a000000000000000000002",
      userId: ME,
      groupKey: "b",
      admission: tracking().admission(),
      isConnected: () => true,
    });
    await Promise.all([adding, reset(ME)]);
    expect(holders(ME)).toEqual([]);
  });

  it("randomise leaves a member being reset out and still deals everyone else", async () => {
    seed();
    const ticket = tracking().admission();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const resetting = reset(ME, () => gate);
    await settle();
    const result = await randomiseMembers({
      guildId: GUILD,
      eventId: EV,
      candidateIds: [ME, OTHER],
      mode: "everyone",
      seed: 3,
      admission: ticket,
    });
    if (!result.ok) throw new Error("expected success");
    expect(result.placed.map((p) => p.userId)).toEqual([OTHER]);
    release();
    await resetting;
    expect(holders(ME)).toEqual([]);
    expect(holders(OTHER)).toHaveLength(1);
  });

  it("randomise refuses outright when its only candidate is being reset", async () => {
    seed();
    const ticket = tracking().admission();
    await reset(ME);
    expect(
      await randomiseMembers({
        guildId: GUILD,
        eventId: EV,
        candidateIds: [ME],
        mode: "unassigned",
        seed: 1,
        admission: ticket,
      }),
    ).toMatchObject({ ok: false, code: "member-reset" });
    expect(holders(ME)).toEqual([]);
  });

  it("does not let a tracking opt-out alone block a host assignment", async () => {
    seed();
    await tracking()
      .optOut(ME, GUILD)
      .catch(() => undefined);
    const result = await assignMember({
      guildId: GUILD,
      eventId: EV,
      userId: ME,
      groupKey: "a",
      admission: tracking().admission(),
      isConnected: () => true,
    });
    expect(result).toMatchObject({ ok: true, changed: true });
  });

  it("still lets a host assign a member no reset has touched", async () => {
    seed();
    expect(
      await assignMember({
        guildId: GUILD,
        eventId: EV,
        userId: ME,
        groupKey: "a",
        admission: tracking().admission(),
        isConnected: () => true,
      }),
    ).toMatchObject({ ok: true, changed: true });
    expect(holders(ME)).toEqual(["a"]);
  });
});
