import { describe, it, expect } from "@jest/globals";
import {
  controlWanted,
  customiseCustomId,
  customiseRefusal,
  isOpenState,
  nameTakenByOther,
  parseCustomiseCustomId,
  refusalMessage,
  type CustomiseEvent,
  type CustomiseRefusal,
} from "../../src/services/event-customise-rules.js";

const EV = "65a000000000000000000001";
const RED = "g_00000001";
const BLUE = "g_00000002";
const LEADS = "g_00000003";

describe("custom ids (#1196)", () => {
  it("round-trips an event id and a group key that contains an underscore", () => {
    const id = customiseCustomId("btn", EV, RED);
    expect(id).toBe(`evcust:btn:${EV}:${RED}`);
    expect(parseCustomiseCustomId(id)).toEqual({
      kind: "btn",
      eventId: EV,
      groupKey: RED,
    });
    expect(
      parseCustomiseCustomId(customiseCustomId("modal", EV, BLUE)),
    ).toEqual({ kind: "modal", eventId: EV, groupKey: BLUE });
  });

  it.each([
    "",
    "evcust:btn",
    `evcust:btn:${EV}`,
    `evcust:btn:${EV}:${RED}:extra`,
    `evcust:other:${EV}:${RED}`,
    `evcust:btn:${EV.slice(1)}:${RED}`,
    `evcust:btn:${EV.toUpperCase()}:${RED}`,
    `evcust:btn:${EV}:g_0000000`,
    `evcust:btn:${EV}:g_000000011`,
    `evcust:btn:${EV}:x_00000001`,
    `xevcust:btn:${EV}:${RED}`,
    `evcust:btn:${EV}:${RED}\n`,
    `vc_control_name_1_2`,
  ])("rejects %j (nothing is trusted beyond the two fields)", (id) => {
    expect(parseCustomiseCustomId(id)).toBeNull();
  });
});

type Role = "leader" | "otherLeader" | "member" | "stranger" | "staleLeader";

const ACTORS: Record<Role, string> = {
  leader: "100000000000000001",
  otherLeader: "100000000000000002",
  member: "100000000000000003",
  stranger: "100000000000000004",
  staleLeader: "100000000000000005",
};

function event(over: Partial<CustomiseEvent> = {}): CustomiseEvent {
  return {
    state: "active",
    groupsEnabled: true,
    captainsEnabled: true,
    captainCustomisationEnabled: true,
    leaderLabel: "Captain",
    groups: [
      {
        key: RED,
        kind: "team",
        channelId: "200000000000000001",
        captainId: ACTORS.leader,
        memberIds: [ACTORS.leader, ACTORS.member],
        name: "Red",
      },
      {
        key: BLUE,
        kind: "team",
        channelId: "200000000000000002",
        captainId: ACTORS.otherLeader,
        memberIds: [ACTORS.otherLeader, ACTORS.staleLeader.replace("5", "6")],
        name: "Blue",
      },
      // A stored leader who is no longer a member of the group: not a leader.
      {
        key: "g_00000004",
        kind: "team",
        channelId: "200000000000000004",
        captainId: ACTORS.staleLeader,
        memberIds: [],
        name: "Green",
      },
      {
        key: LEADS,
        kind: "leads",
        channelId: "200000000000000003",
        captainId: ACTORS.leader,
        memberIds: [ACTORS.leader],
        name: "Leads",
      },
    ],
    ...over,
  };
}

describe("customiseRefusal: actor x switches x event state (#1196)", () => {
  const actors: Role[] = [
    "leader",
    "otherLeader",
    "member",
    "stranger",
    "staleLeader",
  ];

  // The expected answer for the RED group when everything is on and open.
  const base: Record<Role, CustomiseRefusal | null> = {
    leader: null,
    otherLeader: "not-leader",
    member: "not-leader",
    stranger: "not-leader",
    staleLeader: "not-leader",
  };

  it.each(actors)("everything on, event open: %s", (role) => {
    expect(
      customiseRefusal({
        event: event(),
        eventsEnabled: true,
        groupKey: RED,
        actorId: ACTORS[role],
      }),
    ).toBe(base[role]);
  });

  type Case = {
    name: string;
    event: CustomiseEvent | null;
    eventsEnabled: boolean | null;
    expected: CustomiseRefusal;
  };
  const cases: Case[] = [
    {
      name: "events off",
      event: event(),
      eventsEnabled: false,
      expected: "events-off",
    },
    {
      name: "events unreadable",
      event: event(),
      eventsEnabled: null,
      expected: "events-off",
    },
    {
      name: "event missing",
      event: null,
      eventsEnabled: true,
      expected: "not-found",
    },
    {
      name: "event ended",
      event: event({ state: "ended" }),
      eventsEnabled: true,
      expected: "closed",
    },
    {
      name: "event cancelled",
      event: event({ state: "cancelled" }),
      eventsEnabled: true,
      expected: "closed",
    },
    {
      name: "event state unknown",
      event: event({ state: undefined }),
      eventsEnabled: true,
      expected: "closed",
    },
    {
      name: "groups off",
      event: event({ groupsEnabled: false }),
      eventsEnabled: true,
      expected: "no-groups",
    },
    {
      name: "no groups",
      event: event({ groups: [] }),
      eventsEnabled: true,
      expected: "no-groups",
    },
    {
      name: "leaders off",
      event: event({ captainsEnabled: false }),
      eventsEnabled: true,
      expected: "leaders-off",
    },
    {
      name: "leaders field missing",
      event: event({ captainsEnabled: undefined }),
      eventsEnabled: true,
      expected: "leaders-off",
    },
    {
      name: "customisation off",
      event: event({ captainCustomisationEnabled: false }),
      eventsEnabled: true,
      expected: "customise-off",
    },
    {
      name: "customisation missing",
      event: event({ captainCustomisationEnabled: undefined }),
      eventsEnabled: true,
      expected: "customise-off",
    },
    {
      name: "leaders off and customisation on (customisation alone is not enough)",
      event: event({
        captainsEnabled: false,
        captainCustomisationEnabled: true,
      }),
      eventsEnabled: true,
      expected: "leaders-off",
    },
  ];

  for (const c of cases) {
    it.each(actors)(`${c.name}: %s is refused (${c.expected})`, (role) => {
      expect(
        customiseRefusal({
          event: c.event,
          eventsEnabled: c.eventsEnabled,
          groupKey: RED,
          actorId: ACTORS[role],
        }),
      ).toBe(c.expected);
    });
  }

  it("a leader works only on their own team", () => {
    const e = event();
    expect(
      customiseRefusal({
        event: e,
        eventsEnabled: true,
        groupKey: BLUE,
        actorId: ACTORS.leader,
      }),
    ).toBe("not-leader");
    expect(
      customiseRefusal({
        event: e,
        eventsEnabled: true,
        groupKey: BLUE,
        actorId: ACTORS.otherLeader,
      }),
    ).toBeNull();
  });

  it("an unknown group, and a non-team group, are refused", () => {
    expect(
      customiseRefusal({
        event: event(),
        eventsEnabled: true,
        groupKey: "g_ffffffff",
        actorId: ACTORS.leader,
      }),
    ).toBe("no-group");
    expect(
      customiseRefusal({
        event: event(),
        eventsEnabled: true,
        groupKey: LEADS,
        actorId: ACTORS.leader,
      }),
    ).toBe("not-team");
  });

  it("a scheduled event is open too", () => {
    expect(
      customiseRefusal({
        event: event({ state: "scheduled" }),
        eventsEnabled: true,
        groupKey: RED,
        actorId: ACTORS.leader,
      }),
    ).toBeNull();
  });

  it("the interaction's channel must be the group's current channel", () => {
    const ok = {
      event: event(),
      eventsEnabled: true as const,
      groupKey: RED,
      actorId: ACTORS.leader,
    };
    expect(
      customiseRefusal({ ...ok, channelId: "200000000000000001" }),
    ).toBeNull();
    expect(customiseRefusal({ ...ok, channelId: "299999999999999999" })).toBe(
      "wrong-channel",
    );
    // A group whose channel is gone has no current channel to match.
    const noChannel = event();
    (noChannel.groups ?? [])[0].channelId = null;
    expect(
      customiseRefusal({
        ...ok,
        event: noChannel,
        channelId: "200000000000000001",
      }),
    ).toBe("wrong-channel");
  });

  it("every refusal has a message that names the role the host chose", () => {
    const codes: CustomiseRefusal[] = [
      "events-off",
      "not-found",
      "closed",
      "no-groups",
      "leaders-off",
      "customise-off",
      "no-group",
      "not-team",
      "not-leader",
      "wrong-channel",
    ];
    for (const code of codes) {
      expect(refusalMessage(code, "Captain").length).toBeGreaterThan(10);
    }
    expect(refusalMessage("not-leader", "Squad Lead")).toContain("squad lead");
  });
});

describe("controlWanted (#1196)", () => {
  const team = { key: RED, kind: "team", channelId: "200000000000000001" };
  it("is wanted only with everything on, the event open and a team channel", () => {
    expect(controlWanted(event(), team, true)).toBe(true);
    expect(controlWanted(event({ state: "scheduled" }), team, true)).toBe(true);
    expect(controlWanted(event(), team, false)).toBe(false);
    expect(controlWanted(event(), team, null)).toBe(false);
    expect(controlWanted(event({ state: "ended" }), team, true)).toBe(false);
    expect(controlWanted(event({ captainsEnabled: false }), team, true)).toBe(
      false,
    );
    expect(
      controlWanted(event({ captainCustomisationEnabled: false }), team, true),
    ).toBe(false);
    expect(controlWanted(event({ groupsEnabled: false }), team, true)).toBe(
      false,
    );
    expect(controlWanted(event(), { ...team, kind: "open" }, true)).toBe(false);
    expect(controlWanted(event(), { ...team, kind: "leads" }, true)).toBe(
      false,
    );
    expect(controlWanted(event(), { ...team, channelId: null }, true)).toBe(
      false,
    );
  });
});

describe("helpers", () => {
  it("isOpenState", () => {
    expect(isOpenState("scheduled")).toBe(true);
    expect(isOpenState("active")).toBe(true);
    expect(isOpenState("ended")).toBe(false);
    expect(isOpenState(undefined)).toBe(false);
  });
  it("nameTakenByOther folds case and ignores the group itself", () => {
    const groups = [
      { key: RED, name: "Red" },
      { key: BLUE, name: "Blue" },
    ];
    expect(nameTakenByOther(groups, RED, "blue")).toBe(true);
    expect(nameTakenByOther(groups, RED, "RED")).toBe(false);
    expect(nameTakenByOther(groups, RED, "Green")).toBe(false);
    expect(nameTakenByOther(null, RED, "Green")).toBe(false);
  });
});
