import { describe, it, expect, jest, beforeEach } from "@jest/globals";

/**
 * The revision contract of the live edit (#1239, rule 6) for the fields the
 * preset switch owns (#1241): any other writer of a group's name or tag must
 * move `liveEditRevision` too, or a change set confirmed on the host's page
 * could be applied after the same values were reached again by that writer
 * (a leader renames a team and the host resets it, the page's change set is
 * valid again). The writer here is the REAL leader customiser, the REAL core
 * and the REAL group lock, against the in-memory Event stand-in.
 */

import {
  store,
  writes,
  fake,
  EventMock,
  type Json,
} from "./event-live-edit-groups-fake-event.js";

jest.unstable_mockModule("../../src/models/event.js", () => ({
  Event: EventMock,
}));
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: { getInstance: () => ({ getBoolean: async () => true }) },
}));
jest.unstable_mockModule(
  "../../src/services/tracking-opt-out-service.js",
  () => ({
    TrackingOptOutService: { getInstance: () => ({ admission: () => 1 }) },
  }),
);
jest.unstable_mockModule("../../src/services/event-nickname-tags.js", () => ({
  EventNicknameTags: {
    getInstance: () => ({
      syncMember: async () => "none",
      requestSweep: () => {},
    }),
  },
}));
jest.unstable_mockModule("../../src/web/audit.js", () => ({
  recordAudit: async () => undefined,
  boundAuditEntry: <T>(e: T): T => e,
}));

process.env.WEBUI_SESSION_SECRET = "live-edit-groups-revision-secret";

const { runLiveEdit } = await import("../../src/services/event-live-edit.js");
type LiveEditOutcome =
  import("../../src/services/event-live-edit.js").LiveEditOutcome;
const { readPresetValue, GROUP_PRESET_ROW_ID } =
  await import("../../src/services/event-live-edit-groups.js");
const { customiseGroup, resetGroupCustomisation } =
  await import("../../src/services/event-leader-customise.js");
const { resetMoveGuardForTests } =
  await import("../../src/services/event-move-guard.js");

const GUILD = "guild-1";
const EV = "65a000000000000000000001";
const RED = "g_00000001";
const BLUE = "g_00000002";
const LEADER = "100000000000000001";
const { makeEffects } =
  await import("./event-live-edit-groups-effects-fake.js");
const deps = {
  isEventsEnabled: async (): Promise<boolean | null> => true,
  maxGroups: async (): Promise<number | null> => 15,
  isEnding: (): boolean => false,
  effects: makeEffects({
    syncGroupName: async (_g, _e, k) => ({ groupKey: k, status: "applied" }),
    syncGroupUserLimit: async (_g, _e, k) => ({
      groupKey: k,
      status: "applied",
    }),
  }),
};
const customiseDeps = {
  eventsEnabled: async (): Promise<boolean | null> => true,
  syncName: async () => null,
  retag: () => {},
};

function seed(): void {
  store.set(EV, {
    _id: EV,
    guildId: GUILD,
    state: "active",
    groupsEnabled: true,
    captainsEnabled: true,
    captainCustomisationEnabled: true,
    tagsEnabled: false,
    presetId: null,
    groups: [
      {
        key: RED,
        name: "Red",
        kind: "team",
        size: null,
        tag: "RED",
        marker: "",
        channelId: "c1",
        captainId: LEADER,
        memberIds: [LEADER],
      },
      {
        key: BLUE,
        name: "Blue",
        kind: "team",
        size: null,
        tag: "BLU",
        marker: "",
        channelId: "c2",
        captainId: null,
        memberIds: [],
      },
    ],
  });
}

const squads = (): Json => ({
  id: "builtin:squads",
  groups: [
    { name: "Squad 1", kind: "team", size: null, tag: "S1" },
    { name: "Squad 2", kind: "team", size: null, tag: "S2" },
  ],
});

const rename = (to: string, tag = "RED") =>
  customiseGroup(
    {
      guildId: GUILD,
      eventId: EV,
      groupKey: RED,
      actorId: LEADER,
      channelId: "c1",
      rawName: to,
      rawTag: tag,
    },
    customiseDeps as never,
  );

beforeEach(() => {
  store.clear();
  writes.length = 0;
  fake.beforeWrite = null;
  fake.failReads = false;
  resetMoveGuardForTests();
  seed();
});

const revision = (): unknown => store.get(EV)?.liveEditRevision;

async function pageShown(): Promise<
  Extract<LiveEditOutcome, { status: "needs-confirmation" }>
> {
  const out = await runLiveEdit({
    guildId: GUILD,
    eventId: EV,
    deps,
    submission: [
      {
        rowId: GROUP_PRESET_ROW_ID,
        to: squads(),
        base: readPresetValue(store.get(EV) as never),
      },
    ] as never,
  });
  if (out.status !== "needs-confirmation") throw new Error(out.status);
  return out;
}

const confirm = (
  page: Extract<LiveEditOutcome, { status: "needs-confirmation" }>,
): Promise<LiveEditOutcome> =>
  runLiveEdit({
    guildId: GUILD,
    eventId: EV,
    deps,
    confirmed: page.changes.map((c) => ({
      rowId: c.rowId,
      from: c.from,
      to: c.to,
    })),
    confirmedRevision: page.revision,
  });

describe("a leader's edit and the host's reset move the live edit revision", () => {
  it("a leader's rename is counted", async () => {
    expect(revision()).toBeUndefined();
    const out = await rename("Crimson", "CRM");
    expect(out.ok).toBe(true);
    expect(revision()).toBe(1);
    const write = writes.at(-1);
    expect(write?.update).toMatchObject({ $inc: { liveEditRevision: 1 } });
  });

  it("the host's reset of a leader's rename is counted", async () => {
    await rename("Crimson", "CRM");
    const out = await resetGroupCustomisation(
      { guildId: GUILD, eventId: EV, groupKey: RED },
      customiseDeps as never,
    );
    expect(out.ok).toBe(true);
    expect(revision()).toBe(2);
  });

  it("a refused edit that wrote nothing does not move it", async () => {
    const out = await rename("Blue", "RED");
    expect(out.ok).toBe(false);
    expect(revision()).toBeUndefined();
  });
});

describe("a confirmed preset switch after the leader reached the same values again", () => {
  it("is stale: the leader renamed Red and the host reset it, the page's change set is valid again, but the revision moved", async () => {
    const page = await pageShown();
    await rename("Crimson", "CRM");
    await resetGroupCustomisation(
      { guildId: GUILD, eventId: EV, groupKey: RED },
      customiseDeps as never,
    );
    // Back to exactly what the page showed.
    expect(
      (store.get(EV)?.groups as Json[]).map((g) => [g.name, g.tag]),
    ).toEqual([
      ["Red", "RED"],
      ["Blue", "BLU"],
    ]);
    const before = writes.length;
    const out = await confirm(page);
    expect(out.status).toBe("stale");
    expect(writes).toHaveLength(before);
    expect(store.get(EV)?.presetId).toBeNull();
  });

  it("without any leader edit in between the same confirmation applies", async () => {
    const page = await pageShown();
    const out = await confirm(page);
    expect(out.status).toBe("done");
    expect(store.get(EV)?.presetId).toBe("builtin:squads");
  });
});
