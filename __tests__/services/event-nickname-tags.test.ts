import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type {
  BackupRow,
  EventNicknameTags,
  TagDiscord,
  TagEventRow,
  TagStore,
} from "../../src/services/event-nickname-tags.js";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * Temporary clan tags (#1194) against an in-memory store and a fake Discord,
 * with the REAL decision code, the REAL per-member lock and the REAL end-hook
 * runner. The Mongo write shapes are proven against a real server in
 * `__tests__/integration/event-nickname-tags.integration.test.ts`.
 */

jest.unstable_mockModule("../../src/models/event.js", () => ({ Event: {} }));
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

/** Members whose data reset is "running": the barrier refuses to admit them. */
const resetting = new Set<string>();
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
        ) => {
          const ok = ids.filter((id) => !resetting.has(id));
          if (ok.length === 0) return { admitted: [], value: undefined };
          return { admitted: ok, value: await write(ok) };
        },
      }),
    },
  }),
);

type Listener = (change: {
  guildId: string;
  eventId: string;
  userId: string;
  fromKey: string | null;
  toKey: string | null;
  source: string;
}) => Promise<void> | void;
const assignmentListeners = new Set<Listener>();
jest.unstable_mockModule(
  "../../src/services/event-group-assignment.js",
  () => ({
    onGroupAssignmentChange: (l: Listener) => {
      assignmentListeners.add(l);
      return () => assignmentListeners.delete(l);
    },
  }),
);

const tags = await import("../../src/services/event-nickname-tags.js");
const { runEventEndHooks, resetEventEndHooksForTests } =
  await import("../../src/services/event-end-hooks.js");

const GUILD = "guild-1";
const EV = "65a000000000000000000001";
const EV2 = "65a000000000000000000002";

// ---------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------

interface FakeEvent extends TagEventRow {
  _id: string;
}

class MemStore implements TagStore {
  events = new Map<string, FakeEvent>();
  rows = new Map<string, BackupRow>();
  log: string[] = [];
  /** Throws once, at this step (a crash injected between two steps). */
  failNext: "advance" | "confirm" | null = null;
  /** Runs before every readEvent (lets a test change the world mid-decision). */
  beforeReadEvent: ((nth: number) => void) | null = null;
  reads = 0;

  async readEvent(_g: string, id: string) {
    this.reads += 1;
    this.beforeReadEvent?.(this.reads);
    const e = this.events.get(id);
    return e ? clone(e) : null;
  }
  async readBackup(_g: string, memberId: string) {
    const r = this.rows.get(memberId);
    return r ? { ...r } : null;
  }
  async listBackups() {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }
  async listBackupsOfEvent(_g: string, eventId: string) {
    return [...this.rows.values()]
      .filter((r) => r.eventId === eventId)
      .map((r) => ({ ...r }));
  }
  async listTaggedEvents() {
    return [...this.events.values()]
      .filter(
        (e) =>
          e.state === "active" &&
          e.tagsEnabled === true &&
          e.groupsEnabled === true,
      )
      .map((e) => clone(e));
  }
  async claim(_g: string, row: BackupRow) {
    this.log.push(`claim:${row.memberId}`);
    if (this.rows.has(row.memberId)) return "exists" as const;
    this.rows.set(row.memberId, { ...row, confirmedTarget: null });
    return "claimed" as const;
  }
  async advance(
    _g: string,
    row: BackupRow,
    intended: string,
    attemptedAt: number,
  ) {
    const cur = this.rows.get(row.memberId);
    if (!cur || cur.eventId !== row.eventId || cur.intended !== row.intended) {
      return false;
    }
    if (this.failNext === "advance") {
      this.failNext = null;
      throw new Error("crash before the target was recorded");
    }
    cur.intended = intended;
    if (!cur.owned.includes(intended)) cur.owned.push(intended);
    cur.confirmedTarget = null;
    cur.attemptedAt = attemptedAt;
    cur.mismatches = 0;
    this.log.push(`advance:${row.memberId}`);
    return true;
  }
  async markAttempt(_g: string, row: BackupRow, attemptedAt: number) {
    const cur = this.rows.get(row.memberId);
    if (!cur || cur.eventId !== row.eventId || cur.intended !== row.intended) {
      return false;
    }
    cur.attemptedAt = attemptedAt;
    cur.confirmedTarget = null;
    cur.mismatches = 0;
    this.log.push(`attempt:${row.memberId}`);
    return true;
  }
  async noteMismatch(_g: string, row: BackupRow) {
    const cur = this.rows.get(row.memberId);
    if (!cur || cur.eventId !== row.eventId || cur.intended !== row.intended) {
      return false;
    }
    cur.mismatches += 1;
    return true;
  }
  async confirm(_g: string, row: BackupRow, shown: string | null) {
    const cur = this.rows.get(row.memberId);
    if (!cur || cur.eventId !== row.eventId || cur.intended !== row.intended) {
      return false;
    }
    if (this.failNext === "confirm") {
      this.failNext = null;
      throw new Error("crash before the edit was recorded as confirmed");
    }
    cur.confirmedTarget = row.intended;
    if (shown && !cur.owned.includes(shown)) cur.owned.push(shown);
    this.log.push(`confirm:${row.memberId}`);
    return true;
  }
  async drop(_g: string, row: BackupRow) {
    const cur = this.rows.get(row.memberId);
    if (!cur || cur.eventId !== row.eventId || cur.intended !== row.intended) {
      return false;
    }
    this.rows.delete(row.memberId);
    this.log.push(`drop:${row.memberId}`);
    return true;
  }
}

interface FakeMember {
  nickname: string | null;
  displayName: string;
  isOwner?: boolean;
  manageable?: boolean;
  gone?: boolean;
}

class FakeDiscord implements TagDiscord {
  members = new Map<string, FakeMember>();
  canManage: boolean | null = true;
  fetches = 0;
  edits: Array<{ userId: string; nickname: string | null }> = [];
  /** Throws on the next setNickname for a user (consumed). */
  editFailure = new Map<string, unknown>();
  /** Applies the nickname, THEN throws (the response was lost). Consumed. */
  appliedThenLost = new Map<string, unknown>();
  /** Every setNickname for these users is refused for permission. */
  alwaysRefuse = new Set<string>();
  /** What Discord shows after an edit (simulates whitespace normalisation). */
  normalise: (n: string | null) => string | null = (n) => n;
  log: string[] | null = null;

  async fetchMember(_g: string, userId: string) {
    this.fetches += 1;
    const m = this.members.get(userId);
    if (!m || m.gone) return "gone" as const;
    return {
      nickname: m.nickname,
      displayName: m.displayName,
      isOwner: m.isOwner === true,
      manageable: m.manageable !== false,
    };
  }
  async canManageNicknames() {
    return this.canManage;
  }
  async setNickname(_g: string, userId: string, nickname: string | null) {
    this.log?.push(`edit:${userId}`);
    if (this.alwaysRefuse.has(userId)) {
      throw Object.assign(new Error("Missing Permissions"), { code: 50013 });
    }
    const lost = this.appliedThenLost.get(userId);
    if (lost) {
      this.appliedThenLost.delete(userId);
      const member = this.members.get(userId);
      if (member) member.nickname = this.normalise(nickname);
      throw lost;
    }
    const failure = this.editFailure.get(userId);
    if (failure) {
      this.editFailure.delete(userId);
      throw failure;
    }
    const m = this.members.get(userId);
    if (!m) throw Object.assign(new Error("Unknown Member"), { code: 10007 });
    m.nickname = this.normalise(nickname);
    this.edits.push({ userId, nickname });
    return m.nickname;
  }
}

function team(
  key: string,
  tag: string,
  memberIds: string[],
): NonNullable<TagEventRow["groups"]>[number] {
  return { key, kind: "team", tag, memberIds };
}

function makeEvent(over: Partial<FakeEvent> = {}): FakeEvent {
  return {
    _id: EV,
    state: "active",
    tagsEnabled: true,
    tagsSuffix: false,
    groupsEnabled: true,
    groups: [team("red", "RED", ["alice"]), team("blue", "BLUE", ["bob"])],
    ...over,
  };
}

let clock = 1_000_000_000_000;
let store: MemStore;
let discord: FakeDiscord;
let eventsOn = true;
let svc: EventNicknameTags;

function setup(event: FakeEvent = makeEvent()): void {
  store.events.set(event._id, event);
  discord.members.set("alice", { nickname: "Alice", displayName: "Alice" });
  discord.members.set("bob", { nickname: null, displayName: "Bob G" });
}

beforeEach(() => {
  store = new MemStore();
  discord = new FakeDiscord();
  eventsOn = true;
  clock = 1_000_000_000_000;
  resetting.clear();
  assignmentListeners.clear();
  resetEventEndHooksForTests();
  svc = new tags.EventNicknameTags({} as never, {
    store,
    discord,
    eventsEnabled: async () => eventsOn,
    paceMs: 0,
    now: () => clock,
  });
});

const sync = (userId = "alice", eventId = EV, admission?: number) =>
  svc.syncMember({ guildId: GUILD, eventId, userId, admission });

// ---------------------------------------------------------------------
// buildTaggedName
// ---------------------------------------------------------------------

describe("buildTaggedName", () => {
  it("puts the tag before the name by default and after it as a suffix", () => {
    expect(tags.buildTaggedName("Alice", "RED", false)).toBe("[RED] Alice");
    expect(tags.buildTaggedName("Alice", "RED", true)).toBe("Alice [RED]");
  });

  it("truncates the BASE, never the tag, to fit 32 characters", () => {
    const long = "A".repeat(60);
    for (const suffix of [false, true]) {
      const out = tags.buildTaggedName(long, "ABCDEFGH", suffix) as string;
      expect(out.length).toBeLessThanOrEqual(32);
      expect(out).toContain("[ABCDEFGH]");
      // 32 - "[ABCDEFGH]" (10) - space (1) = 21 characters of the name survive.
      expect(out.replace("[ABCDEFGH]", "").trim()).toBe("A".repeat(21));
    }
  });

  it("fits exactly at the limit without cutting anything", () => {
    const base = "B".repeat(32 - "[RED] ".length);
    expect(tags.buildTaggedName(base, "RED", false)).toBe(`[RED] ${base}`);
  });

  it("never splits a surrogate pair and trims a trailing space", () => {
    // 27 characters of room for "[RED] " (6): the pair would straddle the cut.
    const base = `${"x".repeat(25)}😀😀`;
    const out = tags.buildTaggedName(base, "RED", false) as string;
    expect(out.length).toBeLessThanOrEqual(32);
    expect(out).not.toMatch(/[\ud800-\udbff]$/);
    const spaced = tags.buildTaggedName(`${"y".repeat(25)} zzzz`, "RED", false);
    expect(spaced).toBe(`[RED] ${"y".repeat(25)}`);
  });

  it("does not wrap a tag that already has its brackets", () => {
    expect(tags.buildTaggedName("Alice", "[RED]", false)).toBe("[RED] Alice");
    expect(tags.buildTaggedName("Alice", " [RED] ", true)).toBe("Alice [RED]");
    expect(tags.buildTaggedName("Alice", "[]", false)).toBeNull();
    // A bracket in the middle is part of the tag.
    expect(tags.buildTaggedName("Alice", "R[E]D", false)).toBe("[R[E]D] Alice");
  });

  it("gives null for an empty tag, an empty base or a tag with no room left", () => {
    expect(tags.buildTaggedName("Alice", "  ", false)).toBeNull();
    expect(tags.buildTaggedName("  ", "RED", false)).toBeNull();
    expect(tags.buildTaggedName("Alice", "T".repeat(40), false)).toBeNull();
  });
});

describe("wantedTag", () => {
  it("wants a tag only for an active, tagged event and a member of a team with a tag", () => {
    const e = makeEvent();
    expect(tags.wantedTag(e, "alice")).toMatchObject({ tag: "RED" });
    expect(tags.wantedTag(e, "nobody")).toBeNull();
    expect(tags.wantedTag({ ...e, state: "scheduled" }, "alice")).toBeNull();
    expect(tags.wantedTag({ ...e, state: "ended" }, "alice")).toBeNull();
    expect(tags.wantedTag({ ...e, state: "cancelled" }, "alice")).toBeNull();
    expect(tags.wantedTag({ ...e, tagsEnabled: false }, "alice")).toBeNull();
    expect(tags.wantedTag({ ...e, groupsEnabled: false }, "alice")).toBeNull();
    expect(
      tags.wantedTag({ ...e, groups: [team("x", "  ", ["alice"])] }, "alice"),
    ).toBeNull();
    expect(
      tags.wantedTag(
        {
          ...e,
          groups: [{ key: "o", kind: "open", tag: "T", memberIds: ["alice"] }],
        },
        "alice",
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------

describe("apply", () => {
  it("writes the backup BEFORE the first edit, then tags from the stored original", async () => {
    setup();
    const order: string[] = [];
    discord.log = order;
    const claim = store.claim.bind(store);
    store.claim = async (g, row) => {
      order.push("claim");
      return claim(g, row);
    };

    expect(await sync("alice")).toBe("tagged");

    expect(order).toEqual(["claim", "edit:alice"]);
    expect(discord.members.get("alice")?.nickname).toBe("[RED] Alice");
    expect(store.rows.get("alice")).toMatchObject({
      eventId: EV,
      original: "Alice",
      base: "Alice",
      intended: "[RED] Alice",
      owned: ["[RED] Alice"],
      confirmedTarget: "[RED] Alice",
    });
  });

  it("uses the display name as the base when the member has no server nickname, and restores to none", async () => {
    setup();
    expect(await sync("bob")).toBe("tagged");
    expect(discord.members.get("bob")?.nickname).toBe("[BLUE] Bob G");
    expect(store.rows.get("bob")).toMatchObject({
      original: null,
      base: "Bob G",
    });

    store.events.get(EV)!.state = "ended";
    expect(await sync("bob")).toBe("restored");
    expect(discord.members.get("bob")?.nickname).toBeNull();
    expect(discord.edits.at(-1)).toEqual({ userId: "bob", nickname: null });
  });

  it("does nothing when the event is not active, tags are off, or the member is in no tagged team", async () => {
    setup(makeEvent({ state: "scheduled" }));
    expect(await sync("alice")).toBe("none");
    store.events.set(EV, makeEvent({ tagsEnabled: false }));
    expect(await sync("alice")).toBe("none");
    store.events.set(EV, makeEvent());
    expect(await sync("carol")).toBe("none");
    expect(discord.edits).toEqual([]);
    expect(store.rows.size).toBe(0);
  });

  it("is idempotent: a second pass makes no call at all", async () => {
    setup();
    await sync("alice");
    const fetches = discord.fetches;
    const edits = discord.edits.length;
    expect(await sync("alice")).toBe("none");
    expect(discord.fetches).toBe(fetches);
    expect(discord.edits).toHaveLength(edits);
  });

  it("two concurrent passes for one member tag once and keep one backup", async () => {
    setup();
    const [a, b] = await Promise.all([sync("alice"), sync("alice")]);
    expect([a, b].sort()).toEqual(["none", "tagged"]);
    expect(discord.edits).toHaveLength(1);
    expect(store.rows.size).toBe(1);
  });

  it("does not apply when events are off, but does restore", async () => {
    setup();
    eventsOn = false;
    expect(await sync("alice")).toBe("none");
    expect(discord.edits).toEqual([]);

    eventsOn = true;
    await sync("alice");
    eventsOn = false;
    expect(await sync("alice")).toBe("restored");
    expect(discord.members.get("alice")?.nickname).toBe("Alice");
  });

  it("supports the suffix format", async () => {
    setup(makeEvent({ tagsSuffix: true }));
    await sync("alice");
    expect(discord.members.get("alice")?.nickname).toBe("Alice [RED]");
  });

  it("moves a member to another team's tag from the stored original, never double-tagging", async () => {
    setup();
    await sync("alice");
    const ev = store.events.get(EV)!;
    ev.groups = [team("red", "RED", []), team("blue", "BLUE", ["alice"])];

    expect(await sync("alice")).toBe("retagged");

    expect(discord.members.get("alice")?.nickname).toBe("[BLUE] Alice");
    expect(store.rows.get("alice")).toMatchObject({
      original: "Alice",
      intended: "[BLUE] Alice",
      // The earlier target stays recognisable: owned is appended to, never replaced.
      owned: ["[RED] Alice", "[BLUE] Alice"],
      confirmedTarget: "[BLUE] Alice",
    });
    // The new target is recorded BEFORE the edit.
    expect(store.log.indexOf("advance:alice")).toBeGreaterThan(-1);
  });

  it("stores the nickname Discord reported, so a normalised name is still recognised as ours at restore", async () => {
    setup();
    discord.normalise = (n) => (n ? n.replace("[RED] ", "[RED]  ") : n);
    await sync("alice");
    expect(store.rows.get("alice")?.owned).toContain("[RED]  Alice");
    store.events.get(EV)!.state = "ended";
    expect(await sync("alice")).toBe("restored");
    expect(discord.members.get("alice")?.nickname).toBe("Alice");
  });

  it("skips the server owner and members above the bot, writes no row and reports them", async () => {
    setup();
    discord.members.get("alice")!.isOwner = true;
    discord.members.get("bob")!.manageable = false;

    expect(await sync("alice")).toBe("skipped");
    expect(await sync("bob")).toBe("skipped");

    expect(discord.edits).toEqual([]);
    expect(store.rows.size).toBe(0);
    const report = svc.getReport(EV);
    expect(report?.skipped.map((s) => s.userId).sort()).toEqual([
      "alice",
      "bob",
    ]);
    expect(report?.skipped.find((s) => s.userId === "alice")?.reason).toMatch(
      /owner/,
    );
    expect(report?.skipped.find((s) => s.userId === "bob")?.reason).toMatch(
      /at or above the bot/,
    );
  });

  it("without Manage Nicknames nothing is applied and the host sees a warning; it clears once granted", async () => {
    setup();
    discord.canManage = false;
    expect(await sync("alice")).toBe("skipped");
    expect(discord.edits).toEqual([]);
    expect(store.rows.size).toBe(0);
    expect(svc.getReport(EV)?.warnings.join(" ")).toMatch(/Manage Nicknames/);

    discord.canManage = true;
    expect(await sync("alice")).toBe("tagged");
    expect(svc.getReport(EV)).toBeNull();
  });

  it("an edit Discord refuses outright changes nothing: no backup is left and the member is reported", async () => {
    setup();
    discord.editFailure.set(
      "alice",
      Object.assign(new Error("x"), { code: 50013 }),
    );
    expect(await sync("alice")).toBe("skipped");
    expect(store.rows.size).toBe(0);
    expect(discord.members.get("alice")?.nickname).toBe("Alice");
    expect(svc.getReport(EV)?.skipped[0]?.reason).toMatch(/missing permission/);
  });

  it("an edit with an unknown outcome KEEPS the backup (it may have gone through) and the next pass finishes it", async () => {
    setup();
    discord.editFailure.set("alice", new Error("socket hang up"));
    expect(await sync("alice")).toBe("kept");
    expect(store.rows.get("alice")).toMatchObject({ confirmedTarget: null });
    expect(discord.members.get("alice")?.nickname).toBe("Alice");

    // The edit may still be in flight: nothing is decided until it has settled.
    expect(await sync("alice")).toBe("kept");
    expect(discord.edits).toEqual([]);

    // Settled: the retry sees the nickname still at the original and tags it.
    clock += tags.OUTCOME_SETTLE_MS + 1;
    expect(await sync("alice")).toBe("retagged");
    expect(discord.members.get("alice")?.nickname).toBe("[RED] Alice");
    expect(store.rows.get("alice")?.confirmedTarget).toBe("[RED] Alice");
  });

  it("an event that ends between the claim and the edit is not edited; the unedited backup is dropped", async () => {
    setup();
    let nth = 0;
    store.beforeReadEvent = (n) => {
      nth = n;
      // The first read decides "tag"; by the second (after the claim) it has ended.
      if (n === 2) store.events.get(EV)!.state = "ended";
    };
    expect(await sync("alice")).toBe("none");
    expect(nth).toBeGreaterThanOrEqual(2);
    expect(discord.edits).toEqual([]);
    expect(store.rows.size).toBe(0);
  });

  it("a member whose data reset is running is not tagged and no backup is written", async () => {
    setup();
    resetting.add("alice");
    expect(await sync("alice", EV, 1)).toBe("none");
    expect(discord.edits).toEqual([]);
    expect(store.rows.size).toBe(0);
  });

  it("a member still carrying another event's tag is skipped and reported, and the other event's backup is untouched", async () => {
    setup();
    store.events.set(EV2, makeEvent({ _id: EV2 }));
    discord.members.get("alice")!.nickname = "[RED] Alice";
    store.rows.set("alice", {
      eventId: EV2,
      memberId: "alice",
      original: "Alice",
      base: "Alice",
      intended: "[RED] Alice",
      owned: ["[RED] Alice"],
      confirmedTarget: "[RED] Alice",
      attemptedAt: 0,
      mismatches: 0,
    });

    expect(await sync("alice", EV)).toBe("skipped");
    expect(discord.edits).toEqual([]);
    expect(store.rows.get("alice")?.eventId).toBe(EV2);
    // Ending the first event never restores a backup it does not own.
    store.events.get(EV)!.state = "ended";
    expect(await sync("alice", EV)).toBe("none");
    expect(store.rows.get("alice")?.eventId).toBe(EV2);
  });
});

// ---------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------

describe("restore", () => {
  async function tagged(): Promise<void> {
    setup();
    await sync("alice");
    await sync("bob");
    discord.edits.length = 0;
  }

  it("restores on the end of the event (the end hook) and deletes each backup", async () => {
    await tagged();
    store.events.get(EV)!.state = "ended";

    const summary = await svc.restoreEvent(GUILD, EV);

    expect(summary).toMatchObject({ restored: 2, kept: 0, warnings: [] });
    expect(discord.members.get("alice")?.nickname).toBe("Alice");
    expect(discord.members.get("bob")?.nickname).toBeNull();
    expect(store.rows.size).toBe(0);
  });

  it("runs from the registered end hook through the real hook runner", async () => {
    await tagged();
    tags.EventNicknameTags.setInstanceForTests(svc);
    const off = tags.installEventNicknameTags({} as never);
    try {
      store.events.get(EV)!.state = "ended";
      const results = await runEventEndHooks({
        eventId: EV,
        guildId: GUILD,
        trigger: "manual",
        client: {} as never,
      });
      expect(results).toEqual([
        { name: tags.TAGS_END_HOOK, ok: true, warnings: [] },
      ]);
      expect(discord.members.get("alice")?.nickname).toBe("Alice");
      expect(store.rows.size).toBe(0);
    } finally {
      off();
      tags.EventNicknameTags.reset();
    }
  });

  it("the end hook hands what could not be restored to the host's summary", async () => {
    await tagged();
    tags.EventNicknameTags.setInstanceForTests(svc);
    const off = tags.installEventNicknameTags({} as never);
    try {
      store.events.get(EV)!.state = "ended";
      discord.editFailure.set("alice", new Error("boom"));
      const results = await runEventEndHooks({
        eventId: EV,
        guildId: GUILD,
        trigger: "scheduled",
        client: {} as never,
      });
      expect(results[0].ok).toBe(true);
      expect(results[0].warnings.join(" ")).toMatch(
        /1 nickname could not be restored/,
      );
      // The backup stays, so the sweep finishes it.
      expect(store.rows.has("alice")).toBe(true);
    } finally {
      off();
      tags.EventNicknameTags.reset();
    }
  });

  it("restores a cancelled event the same way", async () => {
    await tagged();
    store.events.get(EV)!.state = "cancelled";
    await svc.restoreEvent(GUILD, EV);
    expect(discord.members.get("alice")?.nickname).toBe("Alice");
    expect(store.rows.size).toBe(0);
  });

  it("restores a member who is unassigned while the event is still running", async () => {
    await tagged();
    store.events.get(EV)!.groups = [
      team("red", "RED", []),
      team("blue", "BLUE", ["bob"]),
    ];
    expect(await sync("alice")).toBe("restored");
    expect(discord.members.get("alice")?.nickname).toBe("Alice");
    expect(store.rows.has("alice")).toBe(false);
    expect(discord.members.get("bob")?.nickname).toBe("[BLUE] Bob G");
  });

  it("restores a member unassigned AFTER the event ended or was cancelled", async () => {
    await tagged();
    const ev = store.events.get(EV)!;
    ev.state = "cancelled";
    ev.groups = [team("red", "RED", []), team("blue", "BLUE", ["bob"])];
    expect(await sync("alice")).toBe("restored");
    expect(discord.members.get("alice")?.nickname).toBe("Alice");
  });

  it("leaves a nickname the member changed themselves and drops the backup", async () => {
    await tagged();
    discord.members.get("alice")!.nickname = "Ally";
    store.events.get(EV)!.state = "ended";
    expect(await sync("alice")).toBe("dropped");
    expect(discord.members.get("alice")?.nickname).toBe("Ally");
    expect(discord.edits).toEqual([]);
    expect(store.rows.has("alice")).toBe(false);
  });

  it("decides from a fresh read of the member, not from anything cached", async () => {
    await tagged();
    store.events.get(EV)!.state = "ended";
    const before = discord.fetches;
    await sync("alice");
    expect(discord.fetches).toBeGreaterThan(before);
  });

  it("a member who left the server (10007) just loses the backup", async () => {
    await tagged();
    discord.members.get("alice")!.gone = true;
    store.events.get(EV)!.state = "ended";
    expect(await sync("alice")).toBe("dropped");
    expect(store.rows.has("alice")).toBe(false);
  });

  it("missing permission on a restore keeps the backup and reports; a later pass restores", async () => {
    await tagged();
    store.events.get(EV)!.state = "ended";
    discord.editFailure.set(
      "alice",
      Object.assign(new Error("x"), { code: 50013 }),
    );
    expect(await sync("alice")).toBe("kept");
    expect(store.rows.has("alice")).toBe(true);
    expect(discord.members.get("alice")?.nickname).toBe("[RED] Alice");

    const summary = await svc.restoreEvent(GUILD, EV);
    expect(summary.kept).toBe(0);
    expect(discord.members.get("alice")?.nickname).toBe("Alice");
  });

  it("a rate limit or timeout on a restore never drops the backup", async () => {
    await tagged();
    store.events.get(EV)!.state = "ended";
    discord.editFailure.set(
      "alice",
      new Error("Failed to set nickname after 3 attempts", {
        cause: Object.assign(new Error("429"), { status: 429 }),
      }),
    );
    expect(await sync("alice")).toBe("kept");
    expect(store.rows.has("alice")).toBe(true);
  });

  it("reports what could not be restored from the hook, and keeps the rows", async () => {
    await tagged();
    store.events.get(EV)!.state = "ended";
    discord.editFailure.set("alice", new Error("boom"));
    const summary = await svc.restoreEvent(GUILD, EV);
    expect(summary.kept).toBe(1);
    expect(summary.warnings.join(" ")).toMatch(
      /1 nickname could not be restored/,
    );
  });

  it("without Manage Nicknames a restore is not attempted and the backup stays", async () => {
    await tagged();
    store.events.get(EV)!.state = "ended";
    discord.canManage = false;
    expect(await sync("alice")).toBe("kept");
    expect(discord.edits).toEqual([]);
    expect(store.rows.has("alice")).toBe(true);
  });
});

// ---------------------------------------------------------------------
// Crash recovery
// ---------------------------------------------------------------------

describe("a crash between tag and restore", () => {
  it("startup reconcile restores the backup of an ended event (the process died after tagging)", async () => {
    setup();
    await sync("alice");
    // ...the process dies here; the event ended meanwhile, no hook ever ran.
    store.events.get(EV)!.state = "ended";
    discord.edits.length = 0;

    const fresh = new tags.EventNicknameTags({} as never, {
      store,
      discord,
      eventsEnabled: async () => eventsOn,
      paceMs: 0,
    });
    const { attempted } = await fresh.sweep(GUILD);

    expect(attempted).toBe(1);
    expect(discord.members.get("alice")?.nickname).toBe("Alice");
    expect(store.rows.size).toBe(0);
  });

  it("restores the backup of a cancelled event, and of an event that no longer exists", async () => {
    setup();
    await sync("alice");
    await sync("bob");
    store.events.get(EV)!.state = "cancelled";
    await svc.sweep(GUILD);
    expect(discord.members.get("alice")?.nickname).toBe("Alice");

    store.rows.set("bob", {
      eventId: EV2,
      memberId: "bob",
      original: null,
      base: "Bob G",
      intended: "[BLUE] Bob G",
      owned: ["[BLUE] Bob G"],
      confirmedTarget: "[BLUE] Bob G",
      attemptedAt: 0,
      mismatches: 0,
    });
    store.events.delete(EV2);
    discord.members.get("bob")!.nickname = "[BLUE] Bob G";
    await svc.sweep(GUILD);
    expect(discord.members.get("bob")?.nickname).toBeNull();
    expect(store.rows.size).toBe(0);
  });

  it("a crash after the backup but BEFORE the edit leaves the nickname alone and just drops the row", async () => {
    setup(makeEvent({ state: "ended" }));
    store.rows.set("alice", {
      eventId: EV,
      memberId: "alice",
      original: "Alice",
      base: "Alice",
      intended: "[RED] Alice",
      owned: ["[RED] Alice"],
      confirmedTarget: null,
      attemptedAt: 0,
      mismatches: 0,
    });
    expect(await sync("alice")).toBe("dropped");
    expect(discord.edits).toEqual([]);
    expect(discord.members.get("alice")?.nickname).toBe("Alice");
    expect(store.rows.size).toBe(0);
  });

  it("a crash after the edit but before it was recorded still restores (the intended name counts as ours)", async () => {
    setup(makeEvent({ state: "ended" }));
    discord.members.get("alice")!.nickname = "[RED] Alice";
    store.rows.set("alice", {
      eventId: EV,
      memberId: "alice",
      original: "Alice",
      base: "Alice",
      intended: "[RED] Alice",
      owned: ["[RED] Alice"],
      confirmedTarget: null,
      attemptedAt: 0,
      mismatches: 0,
    });
    expect(await sync("alice")).toBe("restored");
    expect(discord.members.get("alice")?.nickname).toBe("Alice");
    expect(store.rows.size).toBe(0);
  });

  it("a pending backup of a running event is finished by the sweep", async () => {
    setup();
    discord.editFailure.set("alice", new Error("socket hang up"));
    await sync("alice");
    expect(store.rows.get("alice")?.confirmedTarget).toBeNull();

    // Not before it has settled...
    await svc.sweep(GUILD);
    expect(discord.edits.filter((e) => e.userId === "alice")).toEqual([]);
    // ...and then the sweep finishes it.
    clock += tags.OUTCOME_SETTLE_MS + 1;
    await svc.sweep(GUILD);
    expect(discord.members.get("alice")?.nickname).toBe("[RED] Alice");
    expect(store.rows.get("alice")?.confirmedTarget).toBe("[RED] Alice");
  });
});

// ---------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------

describe("sweep", () => {
  it("tags team members of a running event who have no tag yet (assignments in place when it goes active)", async () => {
    setup();
    const { attempted } = await svc.sweep(GUILD);
    expect(attempted).toBe(2);
    expect(discord.members.get("alice")?.nickname).toBe("[RED] Alice");
    expect(discord.members.get("bob")?.nickname).toBe("[BLUE] Bob G");
  });

  it("makes no Discord call for members who are already tagged correctly", async () => {
    setup();
    await svc.sweep(GUILD);
    discord.fetches = 0;
    discord.edits.length = 0;
    const { attempted } = await svc.sweep(GUILD);
    expect(attempted).toBe(0);
    expect(discord.fetches).toBe(0);
    expect(discord.edits).toEqual([]);
  });

  it("does not hammer a member it had to skip: the cooldown holds the sweep back", async () => {
    setup();
    discord.members.get("alice")!.isOwner = true;
    await svc.sweep(GUILD);
    const fetches = discord.fetches;
    await svc.sweep(GUILD);
    // Alice is cooling down; only Bob (already tagged, no call) remains.
    expect(discord.fetches).toBe(fetches);
  });

  it("with Events off the sweep restores the tags of a RUNNING event (a restart must not leave them on) and applies nothing", async () => {
    setup();
    await svc.sweep(GUILD);
    expect(discord.members.get("alice")?.nickname).toBe("[RED] Alice");

    eventsOn = false;
    const fresh = new tags.EventNicknameTags({} as never, {
      store,
      discord,
      eventsEnabled: async () => eventsOn,
      paceMs: 0,
    });
    await fresh.sweep(GUILD);
    expect(discord.members.get("alice")?.nickname).toBe("Alice");
    expect(discord.members.get("bob")?.nickname).toBeNull();
    expect(store.rows.size).toBe(0);

    // And with Events still off a later sweep tags nobody.
    await fresh.sweep(GUILD);
    expect(store.rows.size).toBe(0);
    expect(discord.members.get("alice")?.nickname).toBe("Alice");
  });

  it("syncEvent (the event just went active) tags every assigned member", async () => {
    setup();
    await svc.syncEvent(GUILD, EV);
    expect(discord.members.get("alice")?.nickname).toBe("[RED] Alice");
    expect(discord.members.get("bob")?.nickname).toBe("[BLUE] Bob G");
  });
});

// ---------------------------------------------------------------------
// Pacing
// ---------------------------------------------------------------------

describe("pacing", () => {
  it("queues nickname edits at least paceMs apart", async () => {
    setup(
      makeEvent({
        groups: [team("red", "RED", ["alice", "bob", "carol"])],
      }),
    );
    discord.members.set("carol", { nickname: "Carol", displayName: "Carol" });
    const paced = new tags.EventNicknameTags({} as never, {
      store,
      discord,
      eventsEnabled: async () => true,
      paceMs: 40,
    });
    const times: number[] = [];
    const edit = discord.setNickname.bind(discord);
    discord.setNickname = async (g, u, n) => {
      times.push(Date.now());
      return edit(g, u, n);
    };
    await Promise.all(
      ["alice", "bob", "carol"].map((userId) =>
        paced.syncMember({ guildId: GUILD, eventId: EV, userId }),
      ),
    );
    expect(times).toHaveLength(3);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(35);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(35);
  });
});

// ---------------------------------------------------------------------
// Member data reset
// ---------------------------------------------------------------------

describe("restoreForMember (member data reset)", () => {
  it("puts the nickname back and deletes the backup", async () => {
    setup();
    await sync("alice");
    expect(await svc.restoreForMember(GUILD, "alice")).toEqual({
      matched: 1,
      removed: 1,
      failed: 0,
    });
    expect(discord.members.get("alice")?.nickname).toBe("Alice");
    expect(store.rows.size).toBe(0);
  });

  it("deletes the backup anyway when Discord refuses, and reports the shortfall", async () => {
    setup();
    await sync("alice");
    discord.editFailure.set(
      "alice",
      Object.assign(new Error("x"), { code: 50013 }),
    );
    expect(await svc.restoreForMember(GUILD, "alice")).toEqual({
      matched: 1,
      removed: 1,
      failed: 1,
    });
    expect(store.rows.size).toBe(0);
  });

  it("is a no-op for a member with no backup", async () => {
    setup();
    expect(await svc.restoreForMember(GUILD, "alice")).toEqual({
      matched: 0,
      removed: 0,
      failed: 0,
    });
  });
});

// ---------------------------------------------------------------------
// The backup row's state machine (review of #1228)
// ---------------------------------------------------------------------

describe("the owned set: what the bot may have put on a nickname", () => {
  const settle = (): void => {
    clock += tags.OUTCOME_SETTLE_MS + 1;
  };
  const endEvent = (): void => {
    store.events.get(EV)!.state = "ended";
  };
  const moveToBlue = (): void => {
    store.events.get(EV)!.groups = [
      team("red", "RED", []),
      team("blue", "BLUE", ["alice"]),
    ];
  };

  it("a tag edit that times out is not resolved while it may still land; a late PATCH is still restored afterwards", async () => {
    setup();
    discord.editFailure.set("alice", new Error("Discord API timeout"));
    expect(await sync("alice")).toBe("kept");
    // The event ends at once: restore sees the unchanged original and must NOT
    // delete the backup, because the PATCH may still be in flight.
    endEvent();
    expect(await sync("alice")).toBe("kept");
    expect(store.rows.has("alice")).toBe(true);
    // The late PATCH lands.
    discord.members.get("alice")!.nickname = "[RED] Alice";
    // Still inside the window: still nothing decided.
    expect(await sync("alice")).toBe("kept");
    settle();
    expect(await sync("alice")).toBe("restored");
    expect(discord.members.get("alice")?.nickname).toBe("Alice");
    expect(store.rows.size).toBe(0);
  });

  it("an unconfirmed edit that never landed is dropped once it has settled, with no edit", async () => {
    setup();
    discord.editFailure.set("alice", new Error("Discord API timeout"));
    await sync("alice");
    endEvent();
    settle();
    expect(await sync("alice")).toBe("dropped");
    expect(discord.edits).toEqual([]);
    expect(discord.members.get("alice")?.nickname).toBe("Alice");
  });

  it("RED applied but unconfirmed, then a move to BLUE that fails: RED is still recognised as the bot's, so the original is restored (finding 2)", async () => {
    setup();
    store.failNext = "confirm";
    // The process dies after the edit, before it is recorded as confirmed.
    expect(await sync("alice")).toBe("kept");
    expect(discord.members.get("alice")?.nickname).toBe("[RED] Alice");
    expect(store.rows.get("alice")).toMatchObject({
      owned: ["[RED] Alice"],
      confirmedTarget: null,
    });

    settle();
    moveToBlue();
    discord.editFailure.set("alice", new Error("socket hang up"));
    expect(await sync("alice")).toBe("kept");
    expect(store.rows.get("alice")?.owned).toEqual([
      "[RED] Alice",
      "[BLUE] Alice",
    ]);

    endEvent();
    settle();
    expect(await sync("alice")).toBe("restored");
    expect(discord.members.get("alice")?.nickname).toBe("Alice");
    expect(store.rows.size).toBe(0);
  });

  it("a crash between recording the new target and nothing else still leaves the old tag recognised", async () => {
    setup();
    await sync("alice");
    moveToBlue();
    store.failNext = "advance";
    await expect(sync("alice")).rejects.toThrow(/crash/);
    // The row still says RED, confirmed; the nickname is RED.
    endEvent();
    expect(await sync("alice")).toBe("restored");
    expect(discord.members.get("alice")?.nickname).toBe("Alice");
  });

  it("after a confirmed RED, a move to BLUE whose edit fails is NOT treated as done: the next pass retries it (finding 3)", async () => {
    setup();
    await sync("alice");
    moveToBlue();
    discord.editFailure.set("alice", new Error("socket hang up"));
    expect(await sync("alice")).toBe("kept");
    expect(store.rows.get("alice")).toMatchObject({
      intended: "[BLUE] Alice",
      confirmedTarget: null,
    });
    expect(discord.members.get("alice")?.nickname).toBe("[RED] Alice");

    settle();
    // The sweep's fast path must not skip it either.
    const { attempted } = await svc.sweep(GUILD);
    expect(attempted).toBeGreaterThan(0);
    expect(discord.members.get("alice")?.nickname).toBe("[BLUE] Alice");
    expect(store.rows.get("alice")).toMatchObject({
      confirmedTarget: "[BLUE] Alice",
      owned: ["[RED] Alice", "[BLUE] Alice"],
    });
  });

  it("a crash after the BLUE edit but before it was confirmed restores from BLUE or RED alike", async () => {
    setup();
    await sync("alice");
    moveToBlue();
    store.failNext = "confirm";
    expect(await sync("alice")).toBe("kept");
    expect(discord.members.get("alice")?.nickname).toBe("[BLUE] Alice");
    endEvent();
    settle();
    expect(await sync("alice")).toBe("restored");
    expect(discord.members.get("alice")?.nickname).toBe("Alice");
  });

  it("a member who clears their nickname while an edit is unconfirmed is left alone: null is never 'ours' (finding 4)", async () => {
    setup();
    discord.editFailure.set("alice", new Error("Discord API timeout"));
    await sync("alice"); // unconfirmed; nothing landed
    discord.members.get("alice")!.nickname = null; // the member cleared it
    endEvent();
    settle();
    // Ambiguous (a rename, or a spelling we do not know): kept for a few
    // settled re-reads, then taken for the member's own change.
    for (let i = 1; i < tags.MISMATCH_READS_BEFORE_RENAME; i++) {
      expect(await sync("alice")).toBe("kept");
    }
    expect(await sync("alice")).toBe("dropped");
    expect(discord.edits).toEqual([]);
    expect(discord.members.get("alice")?.nickname).toBeNull();
    expect(store.rows.size).toBe(0);
  });

  it("the same member on a team move is tagged from their NEW name, not the obsolete base (finding 4)", async () => {
    setup();
    discord.members.get("alice")!.displayName = "Alice D";
    discord.editFailure.set("alice", new Error("Discord API timeout"));
    await sync("alice");
    discord.members.get("alice")!.nickname = null;
    settle();
    moveToBlue();
    for (let i = 1; i < tags.MISMATCH_READS_BEFORE_RENAME; i++) {
      expect(await sync("alice")).toBe("kept");
    }
    expect(await sync("alice")).toBe("tagged");
    expect(discord.members.get("alice")?.nickname).toBe("[BLUE] Alice D");
    expect(store.rows.get("alice")).toMatchObject({
      original: null,
      base: "Alice D",
    });
  });

  it("a restore whose edit has an unknown outcome keeps the row; the next read decides", async () => {
    setup();
    await sync("alice");
    endEvent();
    discord.editFailure.set("alice", new Error("socket hang up"));
    expect(await sync("alice")).toBe("kept");
    expect(store.rows.has("alice")).toBe(true);
    // The restore did land after all: the next read finds the original.
    discord.members.get("alice")!.nickname = "Alice";
    // Still inside the window: the restore may be the one that landed.
    expect(await sync("alice")).toBe("kept");
    clock += tags.OUTCOME_SETTLE_MS + 1;
    expect(await sync("alice")).toBe("dropped");
    expect(store.rows.size).toBe(0);
  });
});

describe("in-memory data about a member (finding 5)", () => {
  it("unassigning a skipped member removes them from the host panel's list", async () => {
    setup();
    discord.members.get("alice")!.isOwner = true;
    await sync("alice");
    expect(svc.getReport(EV)?.skipped).toHaveLength(1);
    store.events.get(EV)!.groups = [team("red", "RED", [])];
    await sync("alice");
    expect(svc.getReport(EV)).toBeNull();
  });

  it("a data reset clears the skipped entry and the sweep cooldown even when there is no backup", async () => {
    setup();
    discord.members.get("alice")!.isOwner = true;
    await sync("alice");
    // Bob gets tagged by the first sweep; after that only Alice could cost a
    // call, and she is cooling down: the sweep leaves her be.
    await svc.sweep(GUILD);
    discord.fetches = 0;
    await svc.sweep(GUILD);
    expect(discord.fetches).toBe(0);

    expect(await svc.restoreForMember(GUILD, "alice")).toEqual({
      matched: 0,
      removed: 0,
      failed: 0,
    });
    expect(svc.getReport(EV)).toBeNull();
    // The cooldown is gone too: the sweep looks at them again.
    discord.fetches = 0;
    await svc.sweep(GUILD);
    expect(discord.fetches).toBeGreaterThan(0);
  });

  it("clears them when the restore fails too", async () => {
    setup();
    await sync("alice");
    discord.members.get("alice")!.isOwner = true;
    store.events.get(EV)!.state = "ended";
    discord.editFailure.set(
      "alice",
      Object.assign(new Error("x"), { code: 50013 }),
    );
    expect(await svc.restoreForMember(GUILD, "alice")).toMatchObject({
      failed: 1,
    });
    expect(svc.getReport(EV)).toBeNull();
  });
});

// A table over (row state x nickname read from Discord x what is wanted now):
// the same rules, written once as an oracle, against every combination.
describe("state table: every row state against every nickname and every want", () => {
  type StateName =
    "claimed" | "confirmed" | "retargeted" | "retargetedConfirmed" | "settling";
  const ORIG = "Alice";
  const RED = "[RED] Alice";
  const BLUE = "[BLUE] Alice";
  const STATES: Record<StateName, () => BackupRow> = {
    claimed: () => ({
      eventId: EV,
      memberId: "alice",
      original: ORIG,
      base: ORIG,
      intended: RED,
      owned: [RED],
      confirmedTarget: null,
      attemptedAt: 0,
      mismatches: 0,
    }),
    confirmed: () => ({
      eventId: EV,
      memberId: "alice",
      original: ORIG,
      base: ORIG,
      intended: RED,
      owned: [RED],
      confirmedTarget: RED,
      attemptedAt: 0,
      mismatches: 0,
    }),
    retargeted: () => ({
      eventId: EV,
      memberId: "alice",
      original: ORIG,
      base: ORIG,
      intended: BLUE,
      owned: [RED, BLUE],
      confirmedTarget: null,
      attemptedAt: 0,
      mismatches: 0,
    }),
    retargetedConfirmed: () => ({
      eventId: EV,
      memberId: "alice",
      original: ORIG,
      base: ORIG,
      intended: BLUE,
      owned: [RED, BLUE],
      confirmedTarget: BLUE,
      attemptedAt: 0,
      mismatches: 0,
    }),
    settling: () => ({
      eventId: EV,
      memberId: "alice",
      original: ORIG,
      base: ORIG,
      intended: RED,
      owned: [RED],
      confirmedTarget: null,
      attemptedAt: clock - 1000,
      mismatches: 0,
    }),
  };
  const CURRENTS: Array<string | null> = [
    ORIG,
    RED,
    BLUE,
    "[RED]  Alice",
    "[BLUE]  Alice",
    "Ally",
    null,
  ];
  const WANTS = ["none", "RED", "BLUE"] as const;

  type Expected =
    | { edit: string | null; row: "deleted" | "unchanged" | "noted" }
    | { edit: string | null; row: "confirmed"; target: string; fresh?: string };

  function oracle(
    state: StateName,
    current: string | null,
    want: (typeof WANTS)[number],
  ): Expected {
    const row = STATES[state]();
    const unresolved = row.confirmedTarget !== row.intended;
    const settling =
      unresolved && clock - row.attemptedAt < tags.OUTCOME_SETTLE_MS;
    // Discord-style normalisation, written out independently of the module.
    const norm = (n: string): string => n.trim().replace(/\s+/g, " ");
    const owned =
      current !== null && row.owned.some((o) => norm(o) === norm(current));
    const atOriginal = current === ORIG;
    // A nickname that matches nothing we know: ambiguous while unresolved.
    const ambiguous = !owned && !atOriginal && unresolved;
    if (want === "none") {
      if (settling) return { edit: null, row: "unchanged" };
      if (ambiguous) return { edit: null, row: "noted" };
      if (owned && current !== ORIG) return { edit: ORIG, row: "deleted" };
      return { edit: null, row: "deleted" };
    }
    const desired = want === "RED" ? RED : BLUE;
    if (row.confirmedTarget === desired && row.intended === desired) {
      return { edit: null, row: "unchanged" };
    }
    if (settling) return { edit: null, row: "unchanged" };
    if (ambiguous) return { edit: null, row: "noted" };
    if (!owned && !atOriginal) {
      // The member changed it: the row goes, and they are tagged from scratch.
      const base = current ?? "Alice D";
      const tag = want === "RED" ? "RED" : "BLUE";
      const target = `[${tag}] ${base}`;
      return { edit: target, row: "confirmed", target, fresh: current ?? "" };
    }
    if (current !== null && norm(current) === norm(desired))
      return { edit: null, row: "confirmed", target: desired };
    return { edit: desired, row: "confirmed", target: desired };
  }

  for (const state of Object.keys(STATES) as StateName[]) {
    for (const current of CURRENTS) {
      for (const want of WANTS) {
        it(`${state} / nickname ${JSON.stringify(current)} / wants ${want}`, async () => {
          const event = makeEvent({
            state: want === "none" ? "ended" : "active",
            groups: [
              team("red", "RED", want === "RED" ? ["alice"] : []),
              team("blue", "BLUE", want === "BLUE" ? ["alice"] : []),
            ],
          });
          store.events.set(EV, event);
          discord.members.set("alice", {
            nickname: current,
            displayName: "Alice D",
          });
          const before = STATES[state]();
          store.rows.set("alice", before);
          const expected = oracle(state, current, want);

          await sync("alice");

          const edits = discord.edits.filter((e) => e.userId === "alice");
          expect(edits.map((e) => e.nickname)).toEqual(
            expected.edit === null ? [] : [expected.edit],
          );
          const after = store.rows.get("alice");
          if (expected.row === "deleted") {
            expect(after).toBeUndefined();
          } else if (expected.row === "unchanged") {
            expect(after).toEqual(before);
          } else if (expected.row === "noted") {
            // Ambiguous: nothing is edited or decided, the re-read is counted.
            expect(after).toEqual({ ...before, mismatches: 1 });
          } else {
            expect(after).toMatchObject({
              intended: expected.target,
              confirmedTarget: expected.target,
            });
            // Nothing the bot ever set is forgotten along the way.
            if (expected.fresh === undefined) {
              for (const n of before.owned) expect(after?.owned).toContain(n);
            } else {
              expect(after?.original).toBe(current);
            }
          }
        });
      }
    }
  }
});

// ---------------------------------------------------------------------
// Dispatch stamping, the worker and the cooldown (second review of #1228)
// ---------------------------------------------------------------------

describe("the attempt is recorded when the PATCH is dispatched", () => {
  it("a tag edit that waited in the pacing queue is stamped AFTER the wait, not when it queued", async () => {
    setup(
      makeEvent({
        groups: [team("red", "RED", ["alice", "bob", "carol"])],
      }),
    );
    discord.members.set("carol", { nickname: "Carol", displayName: "Carol" });
    const real = Date.now();
    const paced = new tags.EventNicknameTags({} as never, {
      store,
      discord,
      eventsEnabled: async () => true,
      paceMs: 40,
      now: () => Date.now() - real,
    });
    const dispatchedAt = new Map<string, number>();
    const edit = discord.setNickname.bind(discord);
    discord.setNickname = async (g, u, n) => {
      dispatchedAt.set(u, store.rows.get(u)?.attemptedAt ?? -1);
      return edit(g, u, n);
    };
    const started = Date.now() - real;
    await Promise.all(
      ["alice", "bob", "carol"].map((userId) =>
        paced.syncMember({ guildId: GUILD, eventId: EV, userId }),
      ),
    );
    // The last member queued behind two others: its stamp (the claim carries it
    // now) is at least two pacing steps after the call started.
    const last = Math.max(...dispatchedAt.values());
    expect(last - started).toBeGreaterThanOrEqual(70);
  });

  it("the stamp is a conditional write: a row that changed meanwhile is not edited", async () => {
    setup();
    // A pending (settled) row about to be retried.
    store.rows.set("alice", {
      eventId: EV,
      memberId: "alice",
      original: "Alice",
      base: "Alice",
      intended: "[RED] Alice",
      owned: ["[RED] Alice"],
      confirmedTarget: null,
      attemptedAt: 0,
      mismatches: 0,
    });
    store.markAttempt = async () => false;
    expect(await sync("alice")).toBe("none");
    expect(discord.edits).toEqual([]);
  });

  it("a restore is recorded as unresolved BEFORE its PATCH; a lost response then reassignment does not take the confirmed fast path", async () => {
    setup();
    await sync("alice");
    expect(store.rows.get("alice")?.confirmedTarget).toBe("[RED] Alice");
    // Unassigned: the restore applies but its response is lost.
    store.events.get(EV)!.groups = [team("red", "RED", [])];
    discord.appliedThenLost.set("alice", new Error("socket hang up"));
    expect(await sync("alice")).toBe("kept");
    expect(discord.members.get("alice")?.nickname).toBe("Alice");
    expect(store.rows.get("alice")?.confirmedTarget).toBeNull();
    expect(store.log).toContain("attempt:alice");

    // Back in the same team at once: the outcome is still unknown.
    store.events.get(EV)!.groups = [team("red", "RED", ["alice"])];
    expect(await sync("alice")).toBe("kept");
    // Settled: the nickname is untagged, so it is tagged again (no fast path).
    clock += tags.OUTCOME_SETTLE_MS + 1;
    expect(await sync("alice")).toBe("retagged");
    expect(discord.members.get("alice")?.nickname).toBe("[RED] Alice");
    expect(store.rows.get("alice")?.confirmedTarget).toBe("[RED] Alice");
  });

  it("a restore that did NOT land is retried after it settled, never confirmed as done", async () => {
    setup();
    await sync("alice");
    store.events.get(EV)!.state = "ended";
    discord.editFailure.set("alice", new Error("socket hang up"));
    expect(await sync("alice")).toBe("kept");
    expect(discord.members.get("alice")?.nickname).toBe("[RED] Alice");
    clock += tags.OUTCOME_SETTLE_MS + 1;
    expect(await sync("alice")).toBe("restored");
    expect(discord.members.get("alice")?.nickname).toBe("Alice");
    expect(store.rows.size).toBe(0);
  });
});

describe("cooldowns", () => {
  it("waiting for another event's tag has no cooldown: the next pass tags the member as soon as it is released", async () => {
    setup();
    store.events.set(EV2, makeEvent({ _id: EV2, state: "ended" }));
    discord.members.get("alice")!.nickname = "[RED] Alice";
    store.rows.set("alice", {
      eventId: EV2,
      memberId: "alice",
      original: "Alice",
      base: "Alice",
      intended: "[RED] Alice",
      owned: ["[RED] Alice"],
      confirmedTarget: "[RED] Alice",
      attemptedAt: 0,
      mismatches: 0,
    });
    expect(await sync("alice", EV)).toBe("skipped");
    expect(svc.getReport(EV)?.skipped).toHaveLength(1);
    // The first event restores them (a pass), with no time passing...
    // and, in the same pass, tags them for this event (no cooldown held it back).
    await svc.sweep(GUILD);
    expect(discord.members.get("alice")?.nickname).toBe("[RED] Alice");
    expect(store.rows.get("alice")?.eventId).toBe(EV);
    expect(svc.getReport(EV)).toBeNull();
  });

  it("a refused tag edit still cools down (tagging jobs honour it)", async () => {
    setup();
    discord.editFailure.set(
      "alice",
      Object.assign(new Error("x"), { code: 50013 }),
    );
    await sync("alice");
    discord.fetches = 0;
    await svc.sweep(GUILD);
    expect(discord.edits.filter((e) => e.userId === "alice")).toEqual([]);
  });

  it("a restore refused for permission is retried on the next pass, with no cooldown", async () => {
    setup();
    await sync("alice");
    store.events.get(EV)!.state = "ended";
    discord.editFailure.set(
      "alice",
      Object.assign(new Error("x"), { code: 50013 }),
    );
    expect(await sync("alice")).toBe("kept");
    // Permission is back; no time has passed.
    await svc.sweep(GUILD);
    expect(discord.members.get("alice")?.nickname).toBe("Alice");
    expect(store.rows.size).toBe(0);
  });
});

describe("the restore-only worker", () => {
  const worker = (over: { eventsOn?: boolean; retryMs?: number } = {}) =>
    new tags.EventNicknameTags({ isReady: () => true } as never, {
      store,
      discord,
      eventsEnabled: async () => over.eventsOn ?? eventsOn,
      paceMs: 0,
      now: () => clock,
      retryMs: over.retryMs ?? 10,
    });
  const until = async (done: () => boolean): Promise<void> => {
    for (let i = 0; i < 100 && !done(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  it("finishes a restore that was inside its settle window at startup, with Events OFF (nothing else would retry)", async () => {
    setup();
    await sync("alice");
    store.events.get(EV)!.state = "ended";
    // A restore whose response was lost, just before the restart.
    discord.appliedThenLost.set("alice", new Error("socket hang up"));
    await sync("alice");
    expect(store.rows.has("alice")).toBe(true);

    const w = worker({ eventsOn: false });
    try {
      await w.reconcileOnStartup(); // inside the window: kept
      expect(store.rows.has("alice")).toBe(true);
      clock += tags.OUTCOME_SETTLE_MS + 1;
      await until(() => !store.rows.has("alice"));
      expect(store.rows.has("alice")).toBe(false);
      expect(discord.members.get("alice")?.nickname).toBe("Alice");
    } finally {
      w.destroy();
    }
  });

  it("never applies a tag, and leaves a member whose tag is still wanted alone", async () => {
    setup(); // active, tagged, alice and bob in teams, no backups
    await svc.sweep(GUILD, { restoreOnly: true });
    expect(discord.edits).toEqual([]);
    expect(store.rows.size).toBe(0);

    await sync("alice"); // tagged and wanted
    discord.edits.length = 0;
    discord.fetches = 0;
    await svc.sweep(GUILD, { restoreOnly: true });
    expect(discord.edits).toEqual([]);
    expect(discord.fetches).toBe(0);
    expect(store.rows.has("alice")).toBe(true);
  });

  it("does not finish a pending TAG of a wanted member either (the full pass owns that)", async () => {
    setup();
    discord.editFailure.set("alice", new Error("socket hang up"));
    await sync("alice"); // unconfirmed, nothing landed
    clock += tags.OUTCOME_SETTLE_MS + 1;
    discord.edits.length = 0;
    await svc.sweep(GUILD, { restoreOnly: true });
    expect(discord.edits.filter((e) => e.userId === "alice")).toEqual([]);
    expect(discord.members.get("alice")?.nickname).toBe("Alice");
    // The full pass does finish it.
    await svc.sweep(GUILD);
    expect(discord.members.get("alice")?.nickname).toBe("[RED] Alice");
  });

  it("restores the backups of an ended event, and runs whatever Events is set to", async () => {
    setup();
    await sync("alice");
    await sync("bob");
    store.events.get(EV)!.state = "ended";
    await svc.sweep(GUILD, { restoreOnly: true });
    expect(discord.members.get("alice")?.nickname).toBe("Alice");
    expect(discord.members.get("bob")?.nickname).toBeNull();
    expect(store.rows.size).toBe(0);
  });

  it("works on at most RESTORE_BATCH_MAX members per pass; the rest wait for the next", async () => {
    store.events.set(EV, makeEvent({ state: "ended" }));
    const total = tags.RESTORE_BATCH_MAX + 5;
    for (let i = 0; i < total; i++) {
      const id = `m${i}`;
      discord.members.set(id, { nickname: "[RED] X", displayName: "X" });
      store.rows.set(id, {
        eventId: EV,
        memberId: id,
        original: "X",
        base: "X",
        intended: "[RED] X",
        owned: ["[RED] X"],
        confirmedTarget: "[RED] X",
        attemptedAt: 0,
        mismatches: 0,
      });
    }
    const first = await svc.sweep(GUILD, { restoreOnly: true });
    expect(first.attempted).toBe(tags.RESTORE_BATCH_MAX);
    expect(store.rows.size).toBe(5);
    await svc.sweep(GUILD, { restoreOnly: true });
    expect(store.rows.size).toBe(0);
  });

  it("is stopped by destroy and survives a failing pass", async () => {
    store.listBackups = async () => {
      throw new Error("db down");
    };
    const w = worker({ retryMs: 5 });
    w.startWorker(GUILD);
    await new Promise((resolve) => setTimeout(resolve, 30));
    w.destroy();
    store.listBackups = async () => {
      throw new Error("must not be called after destroy");
    };
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
});

describe("requestSweep (what the Events scan calls)", () => {
  it("does not wait for the pass, and one pass runs at a time", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const list = store.listBackups.bind(store);
    store.listBackups = async () => {
      calls += 1;
      await gate;
      return list();
    };
    const t0 = svc.requestSweep(GUILD);
    svc.requestSweep(GUILD);
    svc.requestSweep(GUILD);
    expect(t0).toBeUndefined();
    await Promise.resolve();
    expect(calls).toBe(1);
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Finished: a new request starts a new pass.
    svc.requestSweep(GUILD);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toBe(2);
  });

  it("logs a failing pass and never throws", async () => {
    store.listBackups = async () => {
      throw new Error("db down");
    };
    expect(() => svc.requestSweep(GUILD)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});

// ---------------------------------------------------------------------
// Nothing is queued between a read and its PATCH (third review of #1228)
// ---------------------------------------------------------------------

describe("a change made while the edit was queued is never overwritten", () => {
  const queued = (): EventNicknameTags =>
    new tags.EventNicknameTags({} as never, {
      store,
      discord,
      eventsEnabled: async () => eventsOn,
      paceMs: 60,
      now: () => clock,
    });
  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));
  /** Put another member's restore in the slot first, so the one under test waits. */
  const prime = async (slow: EventNicknameTags): Promise<void> => {
    store.events.set(EV2, makeEvent({ _id: EV2, state: "ended" }));
    discord.members.set("zed", { nickname: "[X] Zed", displayName: "Zed" });
    store.rows.set("zed", {
      eventId: EV2,
      memberId: "zed",
      original: "Zed",
      base: "Zed",
      intended: "[X] Zed",
      owned: ["[X] Zed"],
      confirmedTarget: "[X] Zed",
      attemptedAt: 0,
      mismatches: 0,
    });
    await slow.syncMember({ guildId: GUILD, eventId: EV2, userId: "zed" });
  };

  it("restore: the member renames themselves while the restore waits in the pacing queue", async () => {
    setup();
    await sync("alice");
    store.events.get(EV)!.state = "ended";
    const slow = queued();
    discord.edits.length = 0;
    await prime(slow);
    const pending = slow.syncMember({
      guildId: GUILD,
      eventId: EV,
      userId: "alice",
    });
    await wait(15);
    discord.members.get("alice")!.nickname = "Ally";
    expect(await pending).toBe("dropped");
    expect(discord.members.get("alice")?.nickname).toBe("Ally");
    expect(discord.edits.filter((e) => e.userId === "alice")).toEqual([]);
    expect(store.rows.size).toBe(0);
  });

  it("apply: the member renames themselves while the tag waits; the tag is built from the NEW name and that is what is backed up", async () => {
    setup();
    const slow = queued();
    discord.edits.length = 0;
    await prime(slow);
    const pending = slow.syncMember({
      guildId: GUILD,
      eventId: EV,
      userId: "alice",
    });
    await wait(15);
    discord.members.get("alice")!.nickname = "Ally";
    expect(await pending).toBe("tagged");
    expect(discord.members.get("alice")?.nickname).toBe("[RED] Ally");
    expect(store.rows.get("alice")).toMatchObject({ original: "Ally" });
  });

  it("team move: a rename during the wait is seen (the member is tagged from the new name, never from the stored one)", async () => {
    setup();
    await sync("alice");
    store.events.get(EV)!.groups = [
      team("red", "RED", []),
      team("blue", "BLUE", ["alice"]),
    ];
    const slow = queued();
    discord.edits.length = 0;
    await prime(slow);
    const pending = slow.syncMember({
      guildId: GUILD,
      eventId: EV,
      userId: "alice",
    });
    await wait(15);
    discord.members.get("alice")!.nickname = "Ally";
    await pending;
    expect(discord.members.get("alice")?.nickname).toBe("[BLUE] Ally");
    expect(
      discord.edits.filter((e) => e.userId === "alice").map((e) => e.nickname),
    ).toEqual(["[BLUE] Ally"]);
  });

  it("team move: a member unassigned while the edit waits is not tagged for the team they just left", async () => {
    setup();
    await sync("alice");
    store.events.get(EV)!.groups = [
      team("red", "RED", []),
      team("blue", "BLUE", ["alice"]),
    ];
    const slow = queued();
    discord.edits.length = 0;
    await prime(slow);
    const pending = slow.syncMember({
      guildId: GUILD,
      eventId: EV,
      userId: "alice",
    });
    await wait(15);
    store.events.get(EV)!.groups = [
      team("red", "RED", []),
      team("blue", "BLUE", []),
    ];
    expect(await pending).toBe("none");
    expect(discord.edits.filter((e) => e.userId === "alice")).toEqual([]);
  });

  it("a failed read changes nothing on the row (nothing was sent, nothing was stamped)", async () => {
    setup();
    await sync("alice");
    const before = { ...store.rows.get("alice")! };
    store.events.get(EV)!.state = "ended";
    discord.fetchMember = async () => {
      throw new Error("socket hang up");
    };
    expect(await sync("alice")).toBe("kept");
    expect(store.rows.get("alice")).toEqual(before);
  });
});

describe("warnings and reports (third review of #1228)", () => {
  it("the restore-permission warning goes away once permission is back and everything is restored", async () => {
    setup();
    await sync("alice");
    store.events.get(EV)!.state = "ended";
    discord.canManage = false;
    const during = await svc.restoreEvent(GUILD, EV);
    expect(during.kept).toBe(1);
    expect(svc.getReport(EV)?.warnings.join(" ")).toMatch(/Manage Nicknames/);
    expect(during.warnings.join(" ")).toMatch(/Manage Nicknames/);

    discord.canManage = true;
    const after = await svc.restoreEvent(GUILD, EV);
    expect(after).toMatchObject({ restored: 1, kept: 0, warnings: [] });
    expect(svc.getReport(EV)).toBeNull();
  });

  it("the warning is also dropped by a pass that finds nothing owed (no backup left)", async () => {
    setup();
    await sync("alice");
    store.events.get(EV)!.state = "ended";
    discord.canManage = false;
    await svc.restoreEvent(GUILD, EV);
    expect(svc.getReport(EV)?.warnings).toHaveLength(1);
    // The backup is gone by other means (a data reset); the next pass prunes.
    store.rows.clear();
    await svc.sweep(GUILD);
    expect(svc.getReport(EV)).toBeNull();
    // And restoreEvent with nothing left reports nothing stale.
    expect((await svc.restoreEvent(GUILD, EV)).warnings).toEqual([]);
  });

  it("a member waiting for another event's tag is explained on the host panel by the sweep too (after a restart)", async () => {
    setup();
    store.events.set(EV2, makeEvent({ _id: EV2 }));
    discord.members.get("alice")!.nickname = "[RED] Alice";
    store.rows.set("alice", {
      eventId: EV2,
      memberId: "alice",
      original: "Alice",
      base: "Alice",
      intended: "[RED] Alice",
      owned: ["[RED] Alice"],
      confirmedTarget: "[RED] Alice",
      attemptedAt: 0,
      mismatches: 0,
    });
    // EV2 is still running and wants alice, so nobody restores her; a fresh
    // service (a restart) has an empty report.
    store.events.get(EV2)!.groups = [team("red", "RED", ["alice"])];
    store.events.get(EV)!.groups = [team("red", "RED", ["alice"])];
    const fresh = new tags.EventNicknameTags({} as never, {
      store,
      discord,
      eventsEnabled: async () => true,
      paceMs: 0,
      now: () => clock,
    });
    await fresh.sweep(GUILD);
    expect(
      fresh.getReport(EV)?.skipped.map((x) => [x.userId, x.reason]),
    ).toEqual([["alice", expect.stringMatching(/another event/)]]);
    // No cooldown: it is looked at again on the next pass.
    discord.fetches = 0;
    await fresh.sweep(GUILD);
    expect(fresh.getReport(EV)?.skipped).toHaveLength(1);
  });
});

describe("the restore-only worker does not starve members behind uneditable ones", () => {
  it("rotates: after a pass of persistent failures the next pass starts where the last stopped, so a restorable member behind them is reached", async () => {
    store.events.set(EV, makeEvent({ state: "ended" }));
    const stuck = tags.RESTORE_BATCH_MAX;
    const ids: string[] = [];
    for (let i = 0; i < stuck + 3; i++) {
      const id = `m${String(i).padStart(3, "0")}`;
      ids.push(id);
      discord.members.set(id, { nickname: "[RED] X", displayName: "X" });
      store.rows.set(id, {
        eventId: EV,
        memberId: id,
        original: "X",
        base: "X",
        intended: "[RED] X",
        owned: ["[RED] X"],
        confirmedTarget: "[RED] X",
        attemptedAt: 0,
        mismatches: 0,
      });
      if (i < stuck) discord.alwaysRefuse.add(id);
    }
    await svc.sweep(GUILD, { restoreOnly: true });
    // The first batch was all failures; the three restorable ones were not reached.
    expect(store.rows.size).toBe(stuck + 3);
    await svc.sweep(GUILD, { restoreOnly: true });
    expect(store.rows.size).toBe(stuck);
    expect(
      ids.slice(stuck).every((id) => discord.members.get(id)?.nickname === "X"),
    ).toBe(true);
    // And the cursor wraps: the stuck ones are tried again on a later pass.
    discord.fetches = 0;
    await svc.sweep(GUILD, { restoreOnly: true });
    expect(discord.fetches).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------
// Fail-fast PATCH, one read-to-PATCH job at a time, permission per pass
// (fourth review of #1228)
// ---------------------------------------------------------------------

describe("the PATCH never waits", () => {
  const rateLimited = (): Error =>
    Object.assign(new Error("A rate limit was hit"), {
      name: "RateLimitError",
    });

  it("a rate-limit rejection on a TAG edit means 'not sent': the row stays, the attempt is settled, the next pass reads again", async () => {
    setup();
    discord.editFailure.set("alice", rateLimited());
    expect(await sync("alice")).toBe("kept");
    expect(discord.members.get("alice")?.nickname).toBe("Alice");
    expect(store.rows.get("alice")).toMatchObject({
      attemptedAt: 0,
      mismatches: 0,
      confirmedTarget: null,
    });
    // No waiting out a window and no cooldown: the next pass just retries.
    expect(await sync("alice")).toBe("retagged");
    expect(discord.members.get("alice")?.nickname).toBe("[RED] Alice");
  });

  it("a rate-limit rejection on a RESTORE leaves the tag; if the member renames meanwhile, the retry leaves their name alone", async () => {
    setup();
    await sync("alice");
    store.events.get(EV)!.state = "ended";
    discord.editFailure.set("alice", rateLimited());
    expect(await sync("alice")).toBe("kept");
    expect(discord.members.get("alice")?.nickname).toBe("[RED] Alice");
    // Nothing was sent: the row is exactly as it was, still confirmed.
    expect(store.rows.get("alice")?.confirmedTarget).toBe("[RED] Alice");
    // They rename themselves while the bot was rate limited.
    discord.members.get("alice")!.nickname = "Ally";
    discord.edits.length = 0;
    expect(await sync("alice")).toBe("dropped");
    expect(discord.edits).toEqual([]);
    expect(discord.members.get("alice")?.nickname).toBe("Ally");
  });

  it("a rate limit wrapped by makeDiscordApiCall is still recognised as 'not sent'", async () => {
    setup();
    discord.editFailure.set(
      "alice",
      new Error("Failed to set nickname for tags after 1 attempts", {
        cause: rateLimited(),
      }),
    );
    expect(await sync("alice")).toBe("kept");
    expect(store.rows.get("alice")?.attemptedAt).toBe(0);
  });
});

describe("PATCHes are serialised: no two jobs are between their read and their PATCH at once", () => {
  it("a slow read in the first job cannot let the second dispatch together with it", async () => {
    setup(makeEvent({ groups: [team("red", "RED", ["alice", "bob"])] }));
    const paced = new tags.EventNicknameTags({} as never, {
      store,
      discord,
      eventsEnabled: async () => true,
      paceMs: 40,
      now: () => clock,
    });
    // Alice's read is slow; Bob's is instant.
    const fetchMember = discord.fetchMember.bind(discord);
    discord.fetchMember = async (g, u) => {
      if (u === "alice") await new Promise((r) => setTimeout(r, 60));
      return fetchMember(g, u);
    };
    const sentAt: number[] = [];
    const edit = discord.setNickname.bind(discord);
    discord.setNickname = async (g, u, n) => {
      sentAt.push(Date.now());
      return edit(g, u, n);
    };
    await Promise.all(
      ["alice", "bob"].map((userId) =>
        paced.syncMember({ guildId: GUILD, eventId: EV, userId }),
      ),
    );
    expect(sentAt).toHaveLength(2);
    expect(sentAt[1] - sentAt[0]).toBeGreaterThanOrEqual(35);
  });
});

describe("the permission is checked once per pass, not only when someone needs an edit", () => {
  it("a revoked Manage Nicknames shows on the host panel when every tag is already confirmed, and clears when it is back", async () => {
    setup();
    await svc.sweep(GUILD);
    expect(svc.getReport(EV)).toBeNull();
    // Everyone is tagged and confirmed: the sweep schedules no member work.
    discord.canManage = false;
    const { attempted } = await svc.sweep(GUILD);
    expect(attempted).toBe(0);
    expect(svc.getReport(EV)?.warnings.join(" ")).toMatch(/Manage Nicknames/);
    discord.canManage = true;
    await svc.sweep(GUILD);
    expect(svc.getReport(EV)).toBeNull();
  });

  it("the restore worker raises and clears the restore warning for backups it cannot work on", async () => {
    setup();
    await sync("alice");
    store.events.get(EV)!.state = "ended";
    discord.canManage = false;
    await svc.sweep(GUILD, { restoreOnly: true });
    expect(svc.getReport(EV)?.warnings.join(" ")).toMatch(/Manage Nicknames/);
    discord.canManage = true;
    await svc.sweep(GUILD, { restoreOnly: true });
    expect(svc.getReport(EV)).toBeNull();
    expect(discord.members.get("alice")?.nickname).toBe("Alice");
  });
});

describe("per-user report state is only written under the member lock", () => {
  it("a data reset finishing between the sweep's snapshot and its waiting report leaves no entry for the erased member", async () => {
    setup();
    store.events.set(EV2, makeEvent({ _id: EV2 }));
    discord.members.get("alice")!.nickname = "[RED] Alice";
    store.rows.set("alice", {
      eventId: EV2,
      memberId: "alice",
      original: "Alice",
      base: "Alice",
      intended: "[RED] Alice",
      owned: ["[RED] Alice"],
      confirmedTarget: "[RED] Alice",
      attemptedAt: 0,
      mismatches: 0,
    });
    store.events.get(EV2)!.groups = [team("red", "RED", ["alice"])];
    store.events.get(EV)!.groups = [team("red", "RED", ["alice"])];
    // The reset lands right after the sweep took its snapshot.
    const list = store.listTaggedEvents.bind(store);
    store.listTaggedEvents = async () => {
      const snapshot = await list();
      store.events.get(EV)!.groups = [team("red", "RED", [])];
      store.events.get(EV2)!.groups = [team("red", "RED", [])];
      store.rows.delete("alice");
      svc.forgetMemberInMemory("alice");
      return snapshot;
    };
    await svc.sweep(GUILD);
    expect(svc.getReport(EV)).toBeNull();
    expect(svc.getReport(EV2)).toBeNull();
  });
});

// ---------------------------------------------------------------------
// Normalisation and the dispatch stamp (fifth review of #1228)
// ---------------------------------------------------------------------

describe("normalizeNickname", () => {
  it("is conservative: NFC, trim and whitespace collapsing only; case is never folded", () => {
    expect(tags.normalizeNickname("  [RED]   Alice \t")).toBe("[RED] Alice");
    expect(tags.normalizeNickname("é")).toBe("é"); // NFC
    expect(tags.normalizeNickname("[red] alice")).toBe("[red] alice");
    expect(tags.sameNickname("[RED]  Alice", "[RED] Alice")).toBe(true);
    expect(tags.sameNickname("[red] Alice", "[RED] Alice")).toBe(false);
    expect(tags.sameNickname("[RED] Alicia", "[RED] Alice")).toBe(false);
    expect(tags.sameNickname(null, null)).toBe(true);
    expect(tags.sameNickname(null, "")).toBe(false);
  });
});

describe("a nickname Discord normalised", () => {
  const settle = (): void => {
    clock += tags.OUTCOME_SETTLE_MS + 1;
  };
  const endEvent = (): void => {
    store.events.get(EV)!.state = "ended";
  };

  it("PATCH applied with a normalised spelling but the response was lost: restore still restores the original", async () => {
    setup();
    discord.normalise = (n) => (n ? n.replace("[RED] ", "[RED]  ") : n);
    discord.appliedThenLost.set("alice", new Error("socket hang up"));
    expect(await sync("alice")).toBe("kept");
    expect(discord.members.get("alice")?.nickname).toBe("[RED]  Alice");
    // The row only knows the requested spelling.
    expect(store.rows.get("alice")?.owned).toEqual(["[RED] Alice"]);

    endEvent();
    settle();
    expect(await sync("alice")).toBe("restored");
    expect(discord.members.get("alice")?.nickname).toBe("Alice");
    expect(store.rows.size).toBe(0);
  });

  it("PATCH applied and normalised but the confirmation write failed: restore still restores the original", async () => {
    setup();
    discord.normalise = (n) => (n ? n.replace("[RED] ", "[RED]  ") : n);
    store.failNext = "confirm";
    expect(await sync("alice")).toBe("kept");
    expect(store.rows.get("alice")?.confirmedTarget).toBeNull();
    endEvent();
    settle();
    expect(await sync("alice")).toBe("restored");
    expect(discord.members.get("alice")?.nickname).toBe("Alice");
  });

  it("a team move does not back up the already-tagged (normalised) name: it tags from the stored base", async () => {
    setup();
    discord.normalise = (n) => (n ? n.replace("] ", "]  ") : n);
    discord.appliedThenLost.set("alice", new Error("socket hang up"));
    await sync("alice");
    settle();
    store.events.get(EV)!.groups = [
      team("red", "RED", []),
      team("blue", "BLUE", ["alice"]),
    ];
    expect(await sync("alice")).toBe("retagged");
    expect(store.rows.get("alice")).toMatchObject({
      original: "Alice",
      base: "Alice",
      intended: "[BLUE] Alice",
    });
    // Never "[RED]  Alice" as the original, never a double tag.
    expect(discord.edits.map((e) => e.nickname)).not.toContain(
      "[BLUE] [RED]  Alice",
    );
    endEvent();
    expect(await sync("alice")).toBe("restored");
    expect(discord.members.get("alice")?.nickname).toBe("Alice");
  });

  it("a deliberate rename that merely LOOKS similar is left alone (after the bounded re-reads)", async () => {
    setup();
    discord.editFailure.set("alice", new Error("socket hang up"));
    await sync("alice"); // unresolved, owned: [RED] Alice
    discord.members.get("alice")!.nickname = "[RED] Alicia";
    endEvent();
    settle();
    for (let i = 1; i < tags.MISMATCH_READS_BEFORE_RENAME; i++) {
      expect(await sync("alice")).toBe("kept");
      expect(store.rows.get("alice")?.mismatches).toBe(i);
    }
    expect(await sync("alice")).toBe("dropped");
    expect(discord.edits).toEqual([]);
    expect(discord.members.get("alice")?.nickname).toBe("[RED] Alicia");
  });

  it("a CONFIRMED row has no ambiguity: a similar-looking rename is the member's own, at once", async () => {
    setup();
    await sync("alice"); // confirmed
    discord.members.get("alice")!.nickname = "[RED] Alicia";
    endEvent();
    expect(await sync("alice")).toBe("dropped");
    expect(discord.edits.filter((e) => e.nickname === "Alice")).toEqual([]);
    expect(discord.members.get("alice")?.nickname).toBe("[RED] Alicia");
  });

  it("an unresolved row that has stayed ambiguous for a day is taken for a rename on its next read", async () => {
    setup();
    discord.editFailure.set("alice", new Error("socket hang up"));
    await sync("alice");
    discord.members.get("alice")!.nickname = "Ally";
    endEvent();
    clock += tags.MISMATCH_MAX_AGE_MS + 1;
    expect(await sync("alice")).toBe("dropped");
    expect(discord.members.get("alice")?.nickname).toBe("Ally");
  });

  it("a row whose spelling is only ambiguous is never lost: the worker does not loop on it forever", async () => {
    setup();
    discord.editFailure.set("alice", new Error("socket hang up"));
    await sync("alice");
    discord.members.get("alice")!.nickname = "Ally";
    endEvent();
    settle();
    for (let pass = 0; pass < tags.MISMATCH_READS_BEFORE_RENAME + 1; pass++) {
      await svc.sweep(GUILD, { restoreOnly: true });
    }
    expect(store.rows.size).toBe(0);
  });
});

describe("the attempt is stamped after a slow read, in the same step as the PATCH", () => {
  const real = Date.now();
  const timed = (): EventNicknameTags =>
    new tags.EventNicknameTags({} as never, {
      store,
      discord,
      eventsEnabled: async () => true,
      paceMs: 0,
      now: () => Date.now() - real,
    });
  const slowRead = (ms: number): void => {
    const fetchMember = discord.fetchMember.bind(discord);
    discord.fetchMember = async (g, u) => {
      await new Promise((r) => setTimeout(r, ms));
      return fetchMember(g, u);
    };
  };

  it("restore: a slow read does not use up the settle window; a lost response is then not overtaken by a reassignment", async () => {
    setup();
    await sync("alice");
    store.events.get(EV)!.state = "ended";
    const svc2 = timed();
    slowRead(60);
    discord.appliedThenLost.set("alice", new Error("socket hang up"));
    const started = Date.now() - real;
    expect(
      await svc2.syncMember({ guildId: GUILD, eventId: EV, userId: "alice" }),
    ).toBe("kept");
    // Stamped AFTER the 60 ms read, not before it.
    expect(
      (store.rows.get("alice")?.attemptedAt ?? 0) - started,
    ).toBeGreaterThanOrEqual(55);
    // Back in the team at once: still inside the window measured from dispatch.
    store.events.get(EV)!.state = "active";
    expect(
      await svc2.syncMember({ guildId: GUILD, eventId: EV, userId: "alice" }),
    ).toBe("kept");
    expect(discord.members.get("alice")?.nickname).toBe("Alice");
  });

  it("apply: the event re-check after the claim does not use up the window either", async () => {
    setup();
    const svc2 = timed();
    const read = store.readEvent.bind(store);
    let n = 0;
    store.readEvent = async (g, id) => {
      n += 1;
      // the re-check after the claim is the slow one
      if (n === 2) await new Promise((r) => setTimeout(r, 60));
      return read(g, id);
    };
    let claimedAt = 0;
    const claim = store.claim.bind(store);
    store.claim = async (g, row) => {
      claimedAt = row.attemptedAt;
      return claim(g, row);
    };
    let dispatchedAt = 0;
    const edit = discord.setNickname.bind(discord);
    discord.setNickname = async (g, u, nick) => {
      dispatchedAt = store.rows.get(u)?.attemptedAt ?? -1;
      return edit(g, u, nick);
    };
    await svc2.syncMember({ guildId: GUILD, eventId: EV, userId: "alice" });
    expect(dispatchedAt - claimedAt).toBeGreaterThanOrEqual(55);
  });

  it("the member read is a single attempt (no retry budget of its own)", async () => {
    // Asserted at the client in event-nickname-tags-discord.test.ts; here the
    // service never retries a failed read inside the slot either.
    setup();
    await sync("alice");
    store.events.get(EV)!.state = "ended";
    let reads = 0;
    discord.fetchMember = async () => {
      reads += 1;
      throw new Error("Discord API timeout");
    };
    await sync("alice");
    expect(reads).toBe(1);
  });
});

// ---------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------

describe("installEventNicknameTags", () => {
  it("syncs a member on every assignment change and registers the end hook once", async () => {
    tags.EventNicknameTags.setInstanceForTests(svc);
    setup();
    const off = tags.installEventNicknameTags({} as never);
    try {
      expect(tags.installEventNicknameTags({} as never)).toBe(off);
      expect(assignmentListeners.size).toBe(1);
      for (const l of assignmentListeners) {
        await l({
          guildId: GUILD,
          eventId: EV,
          userId: "alice",
          fromKey: null,
          toKey: "red",
          source: "host",
        });
      }
      expect(discord.members.get("alice")?.nickname).toBe("[RED] Alice");
    } finally {
      off();
      tags.EventNicknameTags.reset();
    }
    expect(assignmentListeners.size).toBe(0);
  });
});
