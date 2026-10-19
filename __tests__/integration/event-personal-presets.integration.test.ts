import { it, expect, beforeAll, beforeEach } from "@jest/globals";
import { describeWithMongo, useRealMongo } from "./mongo-harness.js";
import { EventGroupPersonalPreset } from "../../src/models/event-group-personal-preset.js";
import { EventGroupPreset } from "../../src/models/event-group-preset.js";
import {
  enabledPresets,
  loadPresetCatalog,
  MAX_PERSONAL_PRESETS,
  presetResolver,
  validatePresetForm,
  type PresetData,
} from "../../src/services/event-group-preset-service.js";
import {
  createPersonalPreset,
  deletePersonalPreset,
  listHostPresetsForAdmin,
  listPersonalPresets,
  publishPersonalPreset,
  unpublishPersonalPreset,
  updatePersonalPreset,
} from "../../src/services/event-personal-preset-service.js";

/**
 * A host's personal presets against a real MongoDB (#1216). The unit tests
 * replace the models, so they cannot show the unique index per owner, that
 * what is stored reads back exactly as written (the model has no defaults to
 * fill in or hide a field), or that a published copy outlives the personal
 * row.
 */
describeWithMongo("event personal presets (#1216)", () => {
  useRealMongo();

  const G = "guild-1";
  const A = "111111111111111111";
  const B = "222222222222222222";

  beforeAll(async () => {
    await Promise.all([
      EventGroupPersonalPreset.init(),
      EventGroupPreset.init(),
    ]);
  });

  beforeEach(async () => {
    await Promise.all([
      EventGroupPersonalPreset.deleteMany({}),
      EventGroupPreset.deleteMany({}),
    ]);
  });

  const data = (name: string, over: Partial<PresetData> = {}): PresetData => ({
    name,
    description: "",
    groupLabel: "Squad",
    leaderLabel: "Lead",
    channelLeadMinutes: 30,
    tagsEnabled: false,
    groups: [
      { name: "Assault", kind: "team", size: 8, tag: "AS", marker: "🟢" },
      { name: "Command", kind: "leads", size: null, tag: "", marker: "" },
    ],
    ...over,
  });

  it("stores exactly what was validated and reads it back unchanged", async () => {
    const checked = validatePresetForm(
      {
        preset_name: "Clan match",
        groups_label: "Squad",
        groups_leader_label: "Lead",
        groups_lead_minutes: "30",
        group_0_name: "Assault",
        group_0_size: "8",
        group_0_tag: "AS",
        group_0_marker: "🟢",
        group_1_name: "Command",
        group_1_kind: "leads",
        groups_captains_lobby: "1",
      },
      { maxCount: 15 },
    );
    if (!checked.ok) throw new Error(checked.errors.join(" "));
    const created = await createPersonalPreset(G, A, checked.data);
    expect(created.ok).toBe(true);

    const stored = (await EventGroupPersonalPreset.findOne({
      guildId: G,
      ownerId: A,
    }).lean()) as Record<string, unknown> | null;
    expect(stored).toMatchObject({
      guildId: G,
      ownerId: A,
      name: "Clan match",
      nameKey: "clan match",
      description: "",
      groupLabel: "Squad",
      leaderLabel: "Lead",
      channelLeadMinutes: 30,
      tagsEnabled: false,
    });
    // The groups are stored as written: a null size stays null, nothing is
    // added by the schema and nothing is lost.
    expect(stored?.groups).toEqual(checked.data.groups);

    const [entry] = await listPersonalPresets(G, A);
    expect(entry).toMatchObject({
      source: "personal",
      label: "Clan match",
      groupLabel: "Squad",
      leaderLabel: "Lead",
      channelLeadMinutes: 30,
      tagsEnabled: false,
    });
    expect(entry.groups).toEqual(checked.data.groups);
  });

  it("round-trips a server-default lead time and the clan tags default", async () => {
    await createPersonalPreset(
      G,
      A,
      data("Quiz", { channelLeadMinutes: null, tagsEnabled: true }),
    );
    const [entry] = await listPersonalPresets(G, A);
    expect(entry.channelLeadMinutes).toBeNull();
    expect(entry.tagsEnabled).toBe(true);
  });

  it("accepts a 50-unit name whose lower-cased key is 51 units long", async () => {
    const name = `${"a".repeat(49)}İ`;
    expect((await createPersonalPreset(G, A, data(name))).ok).toBe(true);
  });

  it("keeps names unique per owner ignoring case, and allows the same name for another host", async () => {
    expect((await createPersonalPreset(G, A, data("Clan match"))).ok).toBe(
      true,
    );
    const dup = await createPersonalPreset(G, A, data("clan match"));
    expect(dup.ok).toBe(false);
    expect(!dup.ok && dup.error).toMatch(/already have a preset/);
    expect((await createPersonalPreset(G, B, data("Clan match"))).ok).toBe(
      true,
    );
    expect(await EventGroupPersonalPreset.countDocuments({})).toBe(2);
  });

  it("refuses renaming onto one's own other preset, and keeps the id through a rename", async () => {
    const a = await createPersonalPreset(G, A, data("Alpha"));
    const b = await createPersonalPreset(G, A, data("Bravo"));
    if (!a.ok || !b.ok) throw new Error("setup failed");
    expect((await updatePersonalPreset(G, A, b.id, data("ALPHA"))).ok).toBe(
      false,
    );
    expect((await updatePersonalPreset(G, A, b.id, data("Charlie"))).ok).toBe(
      true,
    );
    expect(
      (await listPersonalPresets(G, A)).map((p) => [p.id, p.label]),
    ).toEqual([
      [a.id, "Alpha"],
      [b.id, "Charlie"],
    ]);
  });

  it("does not let another host edit or delete a preset, and the picker never lists it", async () => {
    const a = await createPersonalPreset(G, A, data("Alpha"));
    if (!a.ok) throw new Error("setup failed");
    expect((await updatePersonalPreset(G, B, a.id, data("Hijack"))).ok).toBe(
      false,
    );
    expect((await deletePersonalPreset(G, B, a.id)).ok).toBe(false);
    expect((await updatePersonalPreset("guild-2", A, a.id, data("X"))).ok).toBe(
      false,
    );
    expect(await EventGroupPersonalPreset.countDocuments({})).toBe(1);

    const forB = await loadPresetCatalog(G, { ownerId: B });
    expect(forB.entries.some((e) => e.id === a.id)).toBe(false);
    expect(presetResolver(forB)(a.id)).toEqual({ refused: "unknown" });
    const forA = await loadPresetCatalog(G, { ownerId: A });
    expect(enabledPresets(forA).some((e) => e.id === a.id)).toBe(true);
  });

  it("holds the per-host limit under concurrent creates", async () => {
    const results = await Promise.all(
      Array.from({ length: MAX_PERSONAL_PRESETS + 5 }, (_, i) =>
        createPersonalPreset(G, A, data(`Preset ${i}`)),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(MAX_PERSONAL_PRESETS);
    expect(await EventGroupPersonalPreset.countDocuments({ ownerId: A })).toBe(
      MAX_PERSONAL_PRESETS,
    );
  });

  it("publishes a copy that outlives the personal row and holds no owner", async () => {
    const created = await createPersonalPreset(G, A, data("Clan match"));
    if (!created.ok) throw new Error("setup failed");
    const published = await publishPersonalPreset(G, created.id, {
      maxCount: 15,
    });
    expect(published.ok).toBe(true);

    const copy = (await EventGroupPreset.findOne({
      guildId: G,
      name: "Clan match",
    }).lean()) as Record<string, unknown> | null;
    expect(copy).toMatchObject({
      enabled: true,
      publishedFrom: created.id.slice(3),
    });
    expect(JSON.stringify(copy)).not.toContain(A);
    expect(copy).not.toHaveProperty("ownerId");

    const listing = await listHostPresetsForAdmin(G);
    expect(listing.rows[0].publishedAs).toMatch(/^lib:/);

    // Everyone's picker has it.
    const forB = await loadPresetCatalog(G, { ownerId: B });
    expect(enabledPresets(forB).map((p) => p.label)).toContain("Clan match");

    // The owner's reset removes the personal rows; the copy stays and works.
    await EventGroupPersonalPreset.deleteMany({ ownerId: A, guildId: G });
    const after = await loadPresetCatalog(G, { ownerId: B });
    expect(enabledPresets(after).map((p) => p.label)).toContain("Clan match");
    expect(await EventGroupPreset.countDocuments({ guildId: G })).toBe(1);
  });

  it("refuses a second publish, then allows it once the copy is unpublished", async () => {
    const created = await createPersonalPreset(G, A, data("Clan match"));
    if (!created.ok) throw new Error("setup failed");
    expect(
      (await publishPersonalPreset(G, created.id, { maxCount: 15 })).ok,
    ).toBe(true);
    expect(
      (await publishPersonalPreset(G, created.id, { maxCount: 15 })).ok,
    ).toBe(false);
    expect(await EventGroupPreset.countDocuments({ guildId: G })).toBe(1);
    expect((await unpublishPersonalPreset(G, created.id)).ok).toBe(true);
    expect(await EventGroupPreset.countDocuments({ guildId: G })).toBe(0);
    expect(await EventGroupPersonalPreset.countDocuments({ ownerId: A })).toBe(
      1,
    );
    expect(
      (await publishPersonalPreset(G, created.id, { maxCount: 15 })).ok,
    ).toBe(true);
  });

  it("applies the library's unique name rule when publishing", async () => {
    const a = await createPersonalPreset(G, A, data("Clan match"));
    const b = await createPersonalPreset(G, B, data("clan MATCH"));
    if (!a.ok || !b.ok) throw new Error("setup failed");
    expect((await publishPersonalPreset(G, a.id, { maxCount: 15 })).ok).toBe(
      true,
    );
    const clash = await publishPersonalPreset(G, b.id, { maxCount: 15 });
    expect(clash.ok).toBe(false);
    expect(!clash.ok && clash.error).toMatch(/library already has a preset/);
    expect(await EventGroupPreset.countDocuments({ guildId: G })).toBe(1);
  });
});
