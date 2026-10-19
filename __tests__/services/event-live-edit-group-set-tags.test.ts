import {
  describe,
  it,
  expect,
  jest,
  beforeAll,
  beforeEach,
} from "@jest/globals";

/**
 * Removing a group restores the clan tags of its members (#1242, the tags of
 * #1194 and #1228), through the REAL nickname tag logic with a fake Discord and
 * the REAL assignment hook (`installEventNicknameTags`): the removal unassigns
 * the members, and the one decision function brings every nickname back to the
 * stored original, once, never `[TAG] [TAG] Name` and never a lost original.
 * The group live edit runs through the real core against the in-memory Event
 * stand-in; the channel effects are fakes.
 */

import {
  store,
  writes,
  fake,
  EventMock,
  type Json,
} from "./event-live-edit-groups-fake-event.js";
import { MemTagStore, FakeTagDiscord } from "./event-nickname-tags-fakes.js";

jest.unstable_mockModule("../../src/models/event.js", () => ({
  Event: EventMock,
}));
jest.unstable_mockModule("../../src/models/event-nickname-backup.js", () => ({
  EventNicknameBackup: {},
}));
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: () => ({
      getBoolean: async () => true,
      getString: async () => "guild-1",
    }),
  },
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

process.env.WEBUI_SESSION_SECRET = "group-set-tags-test-secret";

const live = await import("../../src/services/event-live-edit.js");
const { GROUP_REMOVE_ROW_ID } =
  await import("../../src/services/event-live-edit-group-set.js");
const { makeEffects } =
  await import("./event-live-edit-groups-effects-fake.js");
const { createLiveEditEffects } =
  await import("../../src/services/event-live-edit-effects.js");
const tagsMod = await import("../../src/services/event-nickname-tags.js");
const { resetMoveGuardForTests } =
  await import("../../src/services/event-move-guard.js");
type LiveEditEffects =
  import("../../src/services/event-live-edit.js").LiveEditEffects;
type LiveEditDeps =
  import("../../src/services/event-live-edit.js").LiveEditDeps;

const GUILD = "guild-1";
const EV = "65a000000000000000000001";
const HOST = "host-1";
const RED = "g_00000001";
const BLUE = "g_00000002";
const OPEN = "g_00000003";

const discord = new FakeTagDiscord();
const tagStore = new MemTagStore(() => store.values());
let tagService: InstanceType<typeof tagsMod.EventNicknameTags>;
let removeResult: () =>
  { status: "removed" } | { status: "failed"; reason: string };

function seed(): void {
  store.set(EV, {
    _id: EV,
    guildId: GUILD,
    state: "active",
    groupsEnabled: true,
    captainsEnabled: false,
    tagsEnabled: true,
    tagsSuffix: false,
    channelId: "c-main",
    groups: [
      {
        key: RED,
        name: "Red",
        kind: "team",
        size: null,
        tag: "RED",
        marker: "",
        channelId: "c1",
        captainId: null,
        memberIds: ["alice", "carol"],
      },
      {
        key: BLUE,
        name: "Blue",
        kind: "team",
        size: null,
        tag: "BLUE",
        marker: "",
        channelId: "c2",
        captainId: null,
        memberIds: ["bob"],
      },
      {
        key: OPEN,
        name: "Spectators",
        kind: "open",
        size: null,
        tag: "",
        marker: "",
        channelId: null,
        captainId: null,
        memberIds: [],
      },
    ],
  });
}
const keysOf = (): string[] =>
  (store.get(EV)?.groups as Json[]).map((g) => g.key as string);
const nick = (id: string): string | null =>
  discord.members.get(id)?.nickname ?? null;
const editsOf = (id: string): Array<string | null> =>
  discord.edits.filter((e) => e.userId === id).map((e) => e.nickname);

/** Wait until the nickname work the removal started has gone quiet. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  await tagService.sweep(GUILD);
}

const real = createLiveEditEffects({} as never);
const effects = (): LiveEditEffects => {
  const fx = makeEffects({
    async syncGroupName(_g, _e, key) {
      return { groupKey: key, status: "applied" };
    },
    async syncGroupUserLimit(_g, _e, key) {
      return { groupKey: key, status: "applied" };
    },
    async removeGroupChannel(_g, _e, key) {
      const result = removeResult();
      if (result.status === "removed") {
        store.get(EV)!.groups = (store.get(EV)!.groups as Json[]).filter(
          (g) => g.key !== key,
        );
      }
      return result;
    },
  });
  // The nickname effect is the real one: it asks the real tag logic.
  fx.syncTags = real.syncTags;
  return fx;
};

const deps = (): LiveEditDeps => ({
  isEventsEnabled: async () => true,
  maxGroups: async () => 15,
  isEnding: () => false,
  effects: effects(),
});

async function removeConfirmed(keys: string[]): Promise<void> {
  const entry = { rowId: GROUP_REMOVE_ROW_ID, to: keys, base: [] as unknown };
  const first = await live.runLiveEdit({
    guildId: GUILD,
    eventId: EV,
    deps: deps(),
    submission: [entry] as never,
  });
  if (first.status === "done") return;
  if (first.status !== "needs-confirmation") throw new Error(first.status);
  const token = live.signConfirmation({
    eventId: EV,
    guildId: GUILD,
    userId: HOST,
    changes: first.changes.map((c) => ({
      rowId: c.rowId,
      from: c.from,
      to: c.to,
    })),
    revision: first.revision,
  });
  const check = live.verifyConfirmation(token, {
    eventId: EV,
    guildId: GUILD,
    userId: HOST,
  });
  if (!check.ok) throw new Error("token");
  await live.runLiveEdit({
    guildId: GUILD,
    eventId: EV,
    deps: deps(),
    confirmed: check.changes,
    confirmedRevision: check.revision,
  });
}

beforeAll(() => {
  tagService = new tagsMod.EventNicknameTags({} as never, {
    store: tagStore,
    discord,
    eventsEnabled: async () => true,
    paceMs: 0,
    now: () => 1_000_000_000_000,
  });
  tagsMod.EventNicknameTags.setInstanceForTests(tagService);
  // The one subscription the running bot has: an unassignment restores.
  tagsMod.installEventNicknameTags({} as never);
});

beforeEach(async () => {
  store.clear();
  writes.length = 0;
  fake.beforeWrite = null;
  fake.afterFind = null;
  fake.extraGroupFields = new Set(["memberIds"]);
  fake.failReads = false;
  resetMoveGuardForTests();
  removeResult = () => ({ status: "removed" });
  tagStore.rows.clear();
  discord.edits.length = 0;
  discord.members.clear();
  discord.members.set("alice", { nickname: "Alice", displayName: "Alice" });
  discord.members.set("bob", { nickname: null, displayName: "Bob G" });
  discord.members.set("carol", { nickname: "Carol C", displayName: "Carol" });
  seed();
  // Everybody is tagged before the removal, as in a running event.
  await tagService.syncEvent(GUILD, EV);
});

describe("removing a tagged team restores its members' nicknames", () => {
  it("is set up as a running tagged event", () => {
    expect(nick("alice")).toBe("[RED] Alice");
    expect(nick("carol")).toBe("[RED] Carol C");
    expect(nick("bob")).toBe("[BLUE] Bob G");
    expect([...tagStore.rows.keys()].sort()).toEqual(["alice", "bob", "carol"]);
  });

  it("puts every original back once: no second tag, no lost original, the other team untouched", async () => {
    await removeConfirmed([RED]);
    await settle();
    expect(keysOf()).toEqual([BLUE, OPEN]);
    expect(nick("alice")).toBe("Alice");
    expect(nick("carol")).toBe("Carol C");
    // Each was edited exactly twice: tagged, then restored. Never double tagged.
    expect(editsOf("alice")).toEqual(["[RED] Alice", "Alice"]);
    expect(editsOf("carol")).toEqual(["[RED] Carol C", "Carol C"]);
    // The other team is as it was: one tag, no restore.
    expect(nick("bob")).toBe("[BLUE] Bob G");
    expect(editsOf("bob")).toEqual(["[BLUE] Bob G"]);
    // Their backups are gone; the other team's remains.
    expect([...tagStore.rows.keys()]).toEqual(["bob"]);
  });

  it("a member with no server nickname gets none back, not their display name", async () => {
    await removeConfirmed([BLUE]);
    await settle();
    expect(nick("bob")).toBeNull();
    expect(editsOf("bob")).toEqual(["[BLUE] Bob G", null]);
  });

  it("a nickname the member changed themselves is left alone", async () => {
    discord.members.get("alice")!.nickname = "Al the Great";
    await removeConfirmed([RED]);
    await settle();
    expect(nick("alice")).toBe("Al the Great");
    expect(nick("carol")).toBe("Carol C");
  });

  it("posting the removal again changes no nickname and tags nobody", async () => {
    await removeConfirmed([RED]);
    await settle();
    const edits = discord.edits.length;
    await removeConfirmed([RED]);
    await settle();
    expect(discord.edits).toHaveLength(edits);
    expect(nick("alice")).toBe("Alice");
  });

  it("a removal whose channel could not be deleted still restores the nicknames, and finishing it later touches them no more", async () => {
    removeResult = () => ({ status: "failed", reason: "Missing Permissions" });
    await removeConfirmed([RED]);
    await settle();
    // The group is still there, unassigned: nobody wears its tag any more.
    expect(keysOf()).toEqual([RED, BLUE, OPEN]);
    expect(nick("alice")).toBe("Alice");
    expect(nick("carol")).toBe("Carol C");
    const edits = discord.edits.length;
    removeResult = () => ({ status: "removed" });
    await removeConfirmed([RED]);
    await settle();
    expect(keysOf()).toEqual([BLUE, OPEN]);
    expect(discord.edits).toHaveLength(edits);
    expect(editsOf("alice")).toEqual(["[RED] Alice", "Alice"]);
  });

  it("a tag changed from A to B before the removal is restored to the original, not to the old tag", async () => {
    // The host re-tags the team, then removes it: the original still wins.
    (store.get(EV)!.groups as Json[])[0].tag = "SKY";
    await tagService.syncEvent(GUILD, EV);
    expect(nick("alice")).toBe("[SKY] Alice");
    await removeConfirmed([RED]);
    await settle();
    expect(nick("alice")).toBe("Alice");
    expect(editsOf("alice")).toEqual(["[RED] Alice", "[SKY] Alice", "Alice"]);
  });
});
