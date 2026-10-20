import { it, expect, beforeAll, beforeEach } from "@jest/globals";
import mongoose from "mongoose";
import { describeWithMongo, useRealMongo } from "./mongo-harness.js";
import { Event } from "../../src/models/event.js";
import {
  EventGroupPreset,
  EventGroupPresetToggle,
} from "../../src/models/event-group-preset.js";
import {
  createLibraryPreset,
  deleteLibraryPreset,
  enabledPresets,
  loadPresetCatalog,
  presetResolver,
  setPresetEnabled,
  updateLibraryPreset,
  type PresetData,
} from "../../src/services/event-group-preset-service.js";
import { validateGroupSetup } from "../../src/services/event-groups.js";

/**
 * The preset library against a real MongoDB (#1200). The unit tests replace
 * the models, so they cannot show the unique indexes, the duplicate-key
 * handling, or that an install with no such collection yet behaves as "every
 * built-in is on".
 */
describeWithMongo("event group preset library (#1200)", () => {
  useRealMongo();

  beforeAll(async () => {
    await Promise.all([
      EventGroupPreset.init(),
      EventGroupPresetToggle.init(),
      Event.init(),
    ]);
  });

  beforeEach(async () => {
    await Promise.all([
      EventGroupPreset.deleteMany({}),
      EventGroupPresetToggle.deleteMany({}),
      Event.deleteMany({}),
    ]);
  });

  const data = (name: string, over: Partial<PresetData> = {}): PresetData => ({
    name,
    description: "",
    groupLabel: "Squad",
    leaderLabel: "Lead",
    channelLeadMinutes: 30,
    groups: [
      { name: "Assault", kind: "team", size: 8, tag: "", marker: "" },
      { name: "Command", kind: "leads", size: null, tag: "", marker: "" },
    ],
    ...over,
  });

  it("an install without the collections yet has every built-in on", async () => {
    // Drop the collections as an old install would not have them at all.
    for (const name of ["eventgrouppresets", "eventgrouppresettoggles"]) {
      await mongoose.connection.db?.dropCollection(name).catch(() => undefined);
    }
    try {
      const catalog = await loadPresetCatalog("guild-1");
      expect(catalog.state).toBe("ok");
      expect(enabledPresets(catalog).map((p) => p.id)).toEqual([
        "builtin:red-vs-blue",
        "builtin:eve-factions",
        "builtin:wardogs",
      ]);
    } finally {
      // Dropping the collections dropped their unique indexes; the tests
      // after this one rely on them.
      await Promise.all([
        EventGroupPreset.createIndexes(),
        EventGroupPresetToggle.createIndexes(),
      ]);
    }
  });

  it("refuses a name that differs only in case or spacing, per guild", async () => {
    const first = await createLibraryPreset("guild-1", data("Clan match"));
    expect(first.ok).toBe(true);
    const dup = await createLibraryPreset("guild-1", data("clan match"));
    expect(dup.ok).toBe(false);
    expect(!dup.ok && dup.error).toMatch(/already exists/);
    expect(await EventGroupPreset.countDocuments({ guildId: "guild-1" })).toBe(
      1,
    );
    // Another guild may use the same name.
    const other = await createLibraryPreset("guild-2", data("Clan match"));
    expect(other.ok).toBe(true);
  });

  it("refuses renaming a preset onto another one's name, and keeps its id on a rename", async () => {
    const a = await createLibraryPreset("guild-1", data("Alpha"));
    const b = await createLibraryPreset("guild-1", data("Bravo"));
    if (!a.ok || !b.ok) throw new Error("setup failed");
    const clash = await updateLibraryPreset("guild-1", b.id, data("ALPHA"));
    expect(clash.ok).toBe(false);
    const renamed = await updateLibraryPreset("guild-1", b.id, data("Charlie"));
    expect(renamed.ok).toBe(true);
    const catalog = await loadPresetCatalog("guild-1");
    const lib = catalog.entries.filter((e) => e.source === "library");
    expect(lib.map((e) => [e.id, e.label])).toEqual([
      [a.id, "Alpha"],
      [b.id, "Charlie"],
    ]);
  });

  it("does not let one guild edit, switch or delete another guild's preset", async () => {
    const a = await createLibraryPreset("guild-1", data("Alpha"));
    if (!a.ok) throw new Error("setup failed");
    expect(
      (await updateLibraryPreset("guild-2", a.id, data("Hijack"))).ok,
    ).toBe(false);
    expect((await setPresetEnabled("guild-2", a.id, false)).ok).toBe(false);
    expect((await deleteLibraryPreset("guild-2", a.id)).ok).toBe(false);
    expect(await EventGroupPreset.countDocuments({ guildId: "guild-1" })).toBe(
      1,
    );
  });

  it("keeps one switch row per built-in however often it is switched", async () => {
    await setPresetEnabled("guild-1", "builtin:wardogs", false);
    await setPresetEnabled("guild-1", "builtin:wardogs", false);
    expect(
      await EventGroupPresetToggle.countDocuments({
        guildId: "guild-1",
        builtinId: "builtin:wardogs",
      }),
    ).toBe(1);
    let catalog = await loadPresetCatalog("guild-1");
    expect(enabledPresets(catalog).map((p) => p.id)).not.toContain(
      "builtin:wardogs",
    );
    await setPresetEnabled("guild-1", "builtin:wardogs", true);
    catalog = await loadPresetCatalog("guild-1");
    expect(enabledPresets(catalog).map((p) => p.id)).toContain(
      "builtin:wardogs",
    );
    // The switch is per guild.
    const other = await loadPresetCatalog("guild-2");
    expect(enabledPresets(other)).toHaveLength(3);
  });

  it("switches a library preset in its own row and the resolver follows", async () => {
    const created = await createLibraryPreset("guild-1", data("Clan match"));
    if (!created.ok) throw new Error("setup failed");
    await setPresetEnabled("guild-1", created.id, false);
    let resolve = presetResolver(await loadPresetCatalog("guild-1"));
    expect(resolve(created.id)).toMatchObject({ refused: "disabled" });
    await setPresetEnabled("guild-1", created.id, true);
    resolve = presetResolver(await loadPresetCatalog("guild-1"));
    expect(resolve(created.id)).toHaveProperty("preset");
    await deleteLibraryPreset("guild-1", created.id);
    resolve = presetResolver(await loadPresetCatalog("guild-1"));
    expect(resolve(created.id)).toMatchObject({ refused: "unknown" });
  });

  it("an event keeps its own copy: editing, switching off and deleting the preset change nothing on it", async () => {
    const created = await createLibraryPreset("guild-1", data("Clan match"));
    if (!created.ok) throw new Error("setup failed");

    // Create an event from the preset the way the form route does.
    const catalog = await loadPresetCatalog("guild-1");
    const result = validateGroupSetup(
      {
        enabled: true,
        presetId: created.id,
        groupLabel: "",
        leaderLabel: "",
        channelLeadMinutes: "",
        // The preset's leads row is the captains lobby (#1263): added while leaders are on.
        captainsEnabled: true,
        rows: [],
      },
      { maxCount: 15, resolvePreset: presetResolver(catalog) },
    );
    if (!result.ok) throw new Error(result.errors.join(" "));
    const event = await Event.create({
      guildId: "guild-1",
      title: "Clan match night",
      startTime: new Date(Date.now() + 3_600_000),
      createdBy: "host",
      ...result.setup,
    });
    const snapshot = async () => {
      const row = await Event.findById(event._id).lean();
      return JSON.parse(JSON.stringify(row));
    };
    const before = await snapshot();
    expect(before.presetId).toBe(created.id);
    expect(before.groups.map((g: { name: string }) => g.name)).toEqual([
      "Assault",
      "Lead lobby",
    ]);

    await updateLibraryPreset(
      "guild-1",
      created.id,
      data("Renamed", {
        groups: [
          { name: "Totally", kind: "team", size: 2, tag: "", marker: "" },
        ],
      }),
    );
    expect(await snapshot()).toEqual(before);
    await setPresetEnabled("guild-1", created.id, false);
    expect(await snapshot()).toEqual(before);
    await deleteLibraryPreset("guild-1", created.id);
    expect(await snapshot()).toEqual(before);
  });
});
