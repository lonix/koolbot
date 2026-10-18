import { it, expect, beforeAll, beforeEach } from "@jest/globals";
import { describeWithMongo, useRealMongo } from "./mongo-harness.js";
import { Event } from "../../src/models/event.js";
import { EventNicknameBackup } from "../../src/models/event-nickname-backup.js";
import { EventGroupPreset } from "../../src/models/event-group-preset.js";
import {
  EventNicknameTags,
  mongoTagStore,
  type BackupRow,
  type MemberView,
  type TagDiscord,
} from "../../src/services/event-nickname-tags.js";
import { loadPresetCatalog } from "../../src/services/event-group-preset-service.js";

/**
 * The write shapes of the clan tags (#1194) against a real MongoDB: the claim
 * is an upsert with `$setOnInsert` on a unique (guild, member) index, and every
 * later write matches the row it decided from. The unit suite replaces the
 * store with an in-memory one, so this is what proves MongoDB accepts those
 * shapes and what they do under concurrency.
 */

const GUILD = "guild-1";

function row(over: Partial<BackupRow> = {}): BackupRow {
  return {
    eventId: "65a000000000000000000001",
    memberId: "alice",
    original: "Alice",
    base: "Alice",
    intended: "[RED] Alice",
    owned: ["[RED] Alice"],
    confirmedTarget: null,
    attemptedAt: Date.now(),
    ...over,
  };
}

class FakeDiscord implements TagDiscord {
  nicknames = new Map<string, string | null>();
  edits = 0;
  async fetchMember(_g: string, userId: string): Promise<MemberView | "gone"> {
    if (!this.nicknames.has(userId)) return "gone";
    return {
      nickname: this.nicknames.get(userId) ?? null,
      displayName: userId,
      isOwner: false,
      manageable: true,
    };
  }
  async canManageNicknames(): Promise<boolean> {
    return true;
  }
  async setNickname(
    _g: string,
    userId: string,
    nickname: string | null,
  ): Promise<string | null> {
    this.edits += 1;
    this.nicknames.set(userId, nickname);
    return nickname;
  }
}

describeWithMongo("event clan tags against a real MongoDB (#1194)", () => {
  useRealMongo();

  beforeAll(async () => {
    await Event.init();
    await EventNicknameBackup.init();
    await EventGroupPreset.init();
  });

  beforeEach(async () => {
    await Event.deleteMany({});
    await EventNicknameBackup.deleteMany({});
    await EventGroupPreset.deleteMany({});
  });

  it("has the unique (guild, member) index and the by-event index", async () => {
    const indexes = await EventNicknameBackup.collection.indexes();
    const unique = indexes.find(
      (i) => i.unique && Object.keys(i.key).join(",") === "guildId,memberId",
    );
    expect(unique).toBeDefined();
    expect(indexes.map((i) => Object.keys(i.key).join(","))).toContain(
      "eventId",
    );
  });

  it("two concurrent claims for one member: exactly one wins and the original is kept", async () => {
    const results = await Promise.all([
      mongoTagStore.claim(GUILD, row({ original: "Alice", base: "Alice" })),
      mongoTagStore.claim(
        GUILD,
        row({ eventId: "65a000000000000000000002", original: "[RED] Alice" }),
      ),
      mongoTagStore.claim(GUILD, row({ original: "Alice" })),
    ]);
    expect(results.filter((r) => r === "claimed")).toHaveLength(1);
    expect(results.filter((r) => r === "exists")).toHaveLength(2);
    expect(await EventNicknameBackup.countDocuments({ guildId: GUILD })).toBe(
      1,
    );
  });

  it("a claim never overwrites an existing backup (the second event cannot replace the original)", async () => {
    expect(await mongoTagStore.claim(GUILD, row())).toBe("claimed");
    const second = await mongoTagStore.claim(
      GUILD,
      row({
        eventId: "65a000000000000000000002",
        original: "[RED] Alice",
        intended: "[BLUE] [RED] Alice",
      }),
    );
    expect(second).toBe("exists");
    const stored = await mongoTagStore.readBackup(GUILD, "alice");
    expect(stored).toMatchObject({
      eventId: "65a000000000000000000001",
      original: "Alice",
      confirmedTarget: null,
    });
  });

  it("stores a null original and reads it back as null (no server nickname)", async () => {
    await mongoTagStore.claim(GUILD, row({ original: null, base: "Alice G" }));
    expect(await mongoTagStore.readBackup(GUILD, "alice")).toMatchObject({
      original: null,
      base: "Alice G",
    });
  });

  it("advance APPENDS to owned (nothing the bot set is forgotten), clears the confirmation and stamps the attempt", async () => {
    await mongoTagStore.claim(GUILD, row({ attemptedAt: 1000 }));
    const read = (await mongoTagStore.readBackup(GUILD, "alice")) as BackupRow;
    expect(read).toMatchObject({
      owned: ["[RED] Alice"],
      confirmedTarget: null,
      attemptedAt: 1000,
    });
    expect(await mongoTagStore.confirm(GUILD, read, "[RED]  Alice")).toBe(true);
    const confirmed = (await mongoTagStore.readBackup(
      GUILD,
      "alice",
    )) as BackupRow;
    // The nickname Discord reported (normalised) is owned too.
    expect(confirmed).toMatchObject({
      confirmedTarget: "[RED] Alice",
      owned: ["[RED] Alice", "[RED]  Alice"],
    });

    expect(
      await mongoTagStore.advance(GUILD, confirmed, "[BLUE] Alice", 2000),
    ).toBe(true);
    const moved = (await mongoTagStore.readBackup(GUILD, "alice")) as BackupRow;
    expect(moved).toMatchObject({
      intended: "[BLUE] Alice",
      confirmedTarget: null,
      attemptedAt: 2000,
      owned: ["[RED] Alice", "[RED]  Alice", "[BLUE] Alice"],
    });
    // A stale reading no longer matches: it cannot advance, confirm, mark or
    // delete the moved row.
    expect(
      await mongoTagStore.advance(GUILD, confirmed, "[X] Alice", 3000),
    ).toBe(false);
    expect(await mongoTagStore.confirm(GUILD, confirmed, "x")).toBe(false);
    expect(await mongoTagStore.markAttempt(GUILD, confirmed, 4000)).toBe(false);
    expect(await mongoTagStore.drop(GUILD, confirmed)).toBe(false);
    expect(await EventNicknameBackup.countDocuments({})).toBe(1);

    // An attempt (a PATCH about to be dispatched) clears the confirmation.
    await mongoTagStore.confirm(GUILD, moved, null);
    expect(
      ((await mongoTagStore.readBackup(GUILD, "alice")) as BackupRow)
        .confirmedTarget,
    ).toBe("[BLUE] Alice");
    expect(await mongoTagStore.markAttempt(GUILD, moved, 5000)).toBe(true);
    const marked = (await mongoTagStore.readBackup(
      GUILD,
      "alice",
    )) as BackupRow;
    expect(marked.attemptedAt).toBe(5000);
    expect(marked.confirmedTarget).toBeNull();
    expect(await mongoTagStore.drop(GUILD, marked)).toBe(true);
    expect(await mongoTagStore.drop(GUILD, marked)).toBe(false);
  });

  it("tags from a stored event and restores after the end, through the real store", async () => {
    const event = await Event.create({
      guildId: GUILD,
      title: "Quiz",
      startTime: new Date(Date.now() + 3_600_000),
      createdBy: "host",
      state: "active",
      groupsEnabled: true,
      tagsEnabled: true,
      tagsSuffix: true,
      groups: [
        {
          key: "g_a",
          name: "Red",
          kind: "team",
          tag: "RED",
          memberIds: ["alice"],
        },
        { key: "g_b", name: "Blue", kind: "team", tag: "", memberIds: ["bob"] },
        {
          key: "g_o",
          name: "Watch",
          kind: "open",
          tag: "W",
          memberIds: ["carol"],
        },
      ],
    });
    const eventId = String(event._id);
    const discord = new FakeDiscord();
    discord.nicknames.set("alice", "Alice");
    discord.nicknames.set("bob", "Bob");
    discord.nicknames.set("carol", "Carol");
    const svc = new EventNicknameTags({} as never, {
      store: mongoTagStore,
      discord,
      eventsEnabled: async () => true,
      paceMs: 0,
    });

    const swept = await svc.sweep(GUILD);

    // Only the team with a tag is tagged; the empty-tag team and the open group are not.
    expect(swept.attempted).toBe(1);
    expect(discord.nicknames.get("alice")).toBe("Alice [RED]");
    expect(discord.nicknames.get("bob")).toBe("Bob");
    expect(discord.nicknames.get("carol")).toBe("Carol");
    expect(await mongoTagStore.readBackup(GUILD, "alice")).toMatchObject({
      eventId,
      original: "Alice",
      confirmedTarget: "Alice [RED]",
      owned: ["Alice [RED]"],
    });
    // A second sweep makes no edit.
    await svc.sweep(GUILD);
    expect(discord.edits).toBe(1);

    await Event.updateOne({ _id: eventId }, { $set: { state: "ended" } });
    const summary = await svc.restoreEvent(GUILD, eventId);
    expect(summary).toMatchObject({ restored: 1, kept: 0 });
    expect(discord.nicknames.get("alice")).toBe("Alice");
    expect(await EventNicknameBackup.countDocuments({})).toBe(0);
  });

  it("a restart reconcile restores the backup of an event that ended while the bot was down", async () => {
    const event = await Event.create({
      guildId: GUILD,
      title: "Quiz",
      startTime: new Date(Date.now() - 3_600_000),
      createdBy: "host",
      state: "ended",
      groupsEnabled: true,
      tagsEnabled: true,
      groups: [
        {
          key: "g_a",
          name: "Red",
          kind: "team",
          tag: "RED",
          memberIds: ["alice"],
        },
      ],
    });
    await mongoTagStore.claim(
      GUILD,
      row({ eventId: String(event._id), intended: "[RED] Alice" }),
    );
    const stored = (await mongoTagStore.readBackup(
      GUILD,
      "alice",
    )) as BackupRow;
    await mongoTagStore.confirm(GUILD, stored, "[RED] Alice");
    const discord = new FakeDiscord();
    discord.nicknames.set("alice", "[RED] Alice");
    const svc = new EventNicknameTags({} as never, {
      store: mongoTagStore,
      discord,
      eventsEnabled: async () => true,
      paceMs: 0,
    });

    await svc.sweep(GUILD);

    expect(discord.nicknames.get("alice")).toBe("Alice");
    expect(await EventNicknameBackup.countDocuments({})).toBe(0);
  });

  it("the event's tag fields default to off for events made before them", async () => {
    await Event.collection.insertOne({
      guildId: GUILD,
      title: "Old",
      startTime: new Date(),
      createdBy: "host",
      state: "active",
    });
    const lean = (await Event.findOne({ title: "Old" }).lean()) as {
      tagsEnabled?: boolean;
      tagsSuffix?: boolean;
    };
    expect(lean.tagsEnabled ?? false).toBe(false);
    expect(lean.tagsSuffix ?? false).toBe(false);
    expect(await mongoTagStore.listTaggedEvents(GUILD)).toEqual([]);
  });

  it("a preset row from before the field is off; one with it stored is on (no migration)", async () => {
    await EventGroupPreset.collection.insertOne({
      guildId: GUILD,
      name: "Old preset",
      nameKey: "old preset",
      groupLabel: "Team",
      leaderLabel: "Leader",
      channelLeadMinutes: null,
      groups: [{ name: "A", kind: "team", size: null, tag: "", marker: "" }],
      enabled: true,
    });
    await EventGroupPreset.create({
      guildId: GUILD,
      name: "Quiz",
      nameKey: "quiz",
      tagsEnabled: true,
      groups: [{ name: "A", kind: "team", size: null, tag: "A", marker: "" }],
    });
    const catalog = await loadPresetCatalog(GUILD);
    const byLabel = new Map(catalog.entries.map((e) => [e.label, e]));
    expect(byLabel.get("Old preset")?.tagsEnabled).toBe(false);
    expect(byLabel.get("Quiz")?.tagsEnabled).toBe(true);
  });
});
