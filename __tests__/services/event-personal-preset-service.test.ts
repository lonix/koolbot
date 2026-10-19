/**
 * A host's personal event group presets (#1216): ownership, limits, the
 * catalog the picker reads, and the admin's publish. The Mongoose models are
 * replaced by one small in-memory fake that matches on equality, so a query
 * that forgets the owner would return another host's row here too. The real
 * unique indexes and the round trip through Mongo are in
 * `__tests__/integration/event-personal-presets.integration.test.ts`.
 */
import { describe, it, expect, jest, beforeEach } from "@jest/globals";

import { makeStore, type Row } from "./preset-fake-store.js";

const personal = makeStore("personal");
const library = makeStore("library");

jest.unstable_mockModule(
  "../../src/models/event-group-personal-preset.js",
  () => ({
    EventGroupPersonalPreset: personal.model,
  }),
);
jest.unstable_mockModule("../../src/models/event-group-preset.js", () => ({
  EventGroupPreset: {
    ...library.model,
    // The library's own create goes through `create`, as in the real service.
  },
  EventGroupPresetToggle: {
    find: () => ({ lean: async (): Promise<Row[]> => [] }),
  },
}));
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const catalogSvc =
  await import("../../src/services/event-group-preset-service.js");
const svc = await import("../../src/services/event-personal-preset-service.js");

const G = "guild-1";
const A = "111111111111111111";
const B = "222222222222222222";

function data(
  over: Partial<
    import("../../src/services/event-group-preset-service.js").PresetData
  > = {},
) {
  return {
    name: "Clan match",
    description: "",
    groupLabel: "Squad",
    leaderLabel: "Leader",
    channelLeadMinutes: 30 as number | null,
    tagsEnabled: false,
    groups: [
      {
        name: "Assault",
        kind: "team" as const,
        size: 8 as number | null,
        tag: "",
        marker: "",
      },
      {
        name: "Command",
        kind: "leads" as const,
        size: null,
        tag: "",
        marker: "",
      },
    ],
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  personal.state.reset();
  library.state.reset();
});

describe("create, list, update and delete are scoped to the owner", () => {
  it("stores the owner and every field, and lists only that owner's presets", async () => {
    const mine = await svc.createPersonalPreset(G, A, data());
    await svc.createPersonalPreset(G, B, data({ name: "Theirs" }));
    expect(mine).toMatchObject({ ok: true });
    expect(personal.state.rows[0]).toMatchObject({
      guildId: G,
      ownerId: A,
      name: "Clan match",
      nameKey: "clan match",
      groupLabel: "Squad",
      channelLeadMinutes: 30,
      tagsEnabled: false,
    });
    const listA = await svc.listPersonalPresets(G, A);
    expect(listA.map((p) => p.label)).toEqual(["Clan match"]);
    expect(listA[0]).toMatchObject({ source: "personal", enabled: true });
    expect(listA[0].id).toMatch(/^my:[0-9]{24}$/);
    expect((await svc.listPersonalPresets(G, B)).map((p) => p.label)).toEqual([
      "Theirs",
    ]);
  });

  it("answers 'not found' to another host's id on update and delete, and changes nothing", async () => {
    const created = await svc.createPersonalPreset(G, A, data());
    if (!created.ok) throw new Error("setup");
    const update = await svc.updatePersonalPreset(
      G,
      B,
      created.id,
      data({ name: "Hijacked" }),
    );
    expect(update).toEqual({ ok: false, error: "That preset was not found." });
    const del = await svc.deletePersonalPreset(G, B, created.id);
    expect(del).toEqual({ ok: false, error: "That preset was not found." });
    expect(personal.state.rows).toHaveLength(1);
    expect(personal.state.rows[0].name).toBe("Clan match");
    // The owner can.
    expect(
      await svc.updatePersonalPreset(
        G,
        A,
        created.id,
        data({ name: "Renamed" }),
      ),
    ).toEqual({ ok: true });
    expect(personal.state.rows[0].name).toBe("Renamed");
    expect(await svc.deletePersonalPreset(G, A, created.id)).toEqual({
      ok: true,
      name: "Renamed",
    });
    expect(personal.state.rows).toHaveLength(0);
  });

  it("refuses an id of the wrong shape and empty owners", async () => {
    expect(
      await svc.updatePersonalPreset(G, A, "lib:" + "a".repeat(24), data()),
    ).toMatchObject({ ok: false });
    expect(await svc.deletePersonalPreset(G, A, "my:nope")).toMatchObject({
      ok: false,
    });
    expect(await svc.createPersonalPreset(G, "", data())).toMatchObject({
      ok: false,
    });
    expect(await svc.listPersonalPresets(G, "")).toEqual([]);
  });

  it("holds at most MAX_PERSONAL_PRESETS per host, and the limit is per host", async () => {
    for (let i = 0; i < catalogSvc.MAX_PERSONAL_PRESETS; i++) {
      expect(
        await svc.createPersonalPreset(G, A, data({ name: `Preset ${i}` })),
      ).toMatchObject({ ok: true });
    }
    const over = await svc.createPersonalPreset(
      G,
      A,
      data({ name: "One too many" }),
    );
    expect(over.ok).toBe(false);
    expect(over.ok === false && over.error).toContain(
      `${catalogSvc.MAX_PERSONAL_PRESETS}`,
    );
    expect(
      await svc.createPersonalPreset(G, B, data({ name: "Mine" })),
    ).toMatchObject({ ok: true });
  });

  it("serialises two creates at the limit: only one gets the last slot", async () => {
    for (let i = 0; i < catalogSvc.MAX_PERSONAL_PRESETS - 1; i++) {
      await svc.createPersonalPreset(G, A, data({ name: `Preset ${i}` }));
    }
    const results = await Promise.all([
      svc.createPersonalPreset(G, A, data({ name: "Late 1" })),
      svc.createPersonalPreset(G, A, data({ name: "Late 2" })),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(personal.state.rows).toHaveLength(catalogSvc.MAX_PERSONAL_PRESETS);
  });

  it("refuses the same name twice for one host (ignoring case) but not across hosts", async () => {
    await svc.createPersonalPreset(G, A, data());
    const again = await svc.createPersonalPreset(
      G,
      A,
      data({ name: "CLAN MATCH" }),
    );
    expect(again.ok).toBe(false);
    expect(again.ok === false && again.error).toContain(
      "already have a preset",
    );
    expect(await svc.createPersonalPreset(G, B, data())).toMatchObject({
      ok: true,
    });
  });
});

describe("the catalog a host reads", () => {
  it("includes only the asking host's presets, always on, after the library", async () => {
    await svc.createPersonalPreset(G, A, data());
    await svc.createPersonalPreset(G, B, data({ name: "Theirs" }));
    library.state.rows.push({
      _id: "a".repeat(24),
      guildId: G,
      name: "Library one",
      groups: [],
      enabled: true,
    });

    const forA = await catalogSvc.loadPresetCatalog(G, { ownerId: A });
    const mine = forA.entries.filter((e) => e.source === "personal");
    expect(mine.map((e) => e.label)).toEqual(["Clan match"]);
    expect(forA.entries.map((e) => e.source)).toEqual([
      "builtin",
      "builtin",
      "builtin",
      "library",
      "personal",
    ]);
    const forB = await catalogSvc.loadPresetCatalog(G, { ownerId: B });
    expect(
      forB.entries.filter((e) => e.source === "personal").map((e) => e.label),
    ).toEqual(["Theirs"]);
    const anonymous = await catalogSvc.loadPresetCatalog(G);
    expect(anonymous.entries.some((e) => e.source === "personal")).toBe(false);
  });

  it("resolves a my: id only for its owner; for anyone else it is unknown", async () => {
    const created = await svc.createPersonalPreset(G, A, data());
    if (!created.ok) throw new Error("setup");
    const own = catalogSvc.presetResolver(
      await catalogSvc.loadPresetCatalog(G, { ownerId: A }),
    );
    expect(own(created.id)).toMatchObject({ preset: { label: "Clan match" } });
    const other = catalogSvc.presetResolver(
      await catalogSvc.loadPresetCatalog(G, { ownerId: B }),
    );
    expect(other(created.id)).toEqual({ refused: "unknown" });
    const none = catalogSvc.presetResolver(
      await catalogSvc.loadPresetCatalog(G),
    );
    expect(none(created.id)).toEqual({ refused: "unknown" });
  });

  it("fails closed when only the personal read fails: built-ins and library stay, my: ids are refused, and it says so", async () => {
    const created = await svc.createPersonalPreset(G, A, data());
    if (!created.ok) throw new Error("setup");
    personal.state.failFind = true;
    const catalog = await catalogSvc.loadPresetCatalog(G, { ownerId: A });
    expect(catalog.state).toBe("ok");
    expect(catalog.personalUnreadable).toBe(true);
    expect(catalog.entries.every((e) => e.source !== "personal")).toBe(true);
    expect(catalogSvc.presetResolver(catalog)(created.id)).toEqual({
      refused: "unreadable",
    });
    expect(
      catalogSvc.catalogNotice(catalog.state, catalog.personalUnreadable),
    ).toContain("Your own presets");
    expect(catalogSvc.catalogNotice("ok", false)).toBeNull();
  });
});

describe("publish and unpublish", () => {
  async function seed(): Promise<string> {
    const created = await svc.createPersonalPreset(G, A, data());
    if (!created.ok) throw new Error("setup");
    return created.id;
  }

  it("copies the preset into the library, on, with a pointer to the personal row and no owner", async () => {
    const id = await seed();
    const out = await svc.publishPersonalPreset(G, id, { maxCount: 15 });
    expect(out).toMatchObject({ ok: true, name: "Clan match" });
    expect(library.state.rows).toHaveLength(1);
    const copy = library.state.rows[0];
    expect(copy).toMatchObject({
      guildId: G,
      name: "Clan match",
      enabled: true,
      groupLabel: "Squad",
      publishedFrom: id.slice(3),
    });
    expect(JSON.stringify(copy)).not.toContain(A);
    expect(Object.keys(copy)).not.toContain("ownerId");
    // The library entry is a normal library preset to every reader.
    const catalog = await catalogSvc.loadPresetCatalog(G, { ownerId: B });
    expect(catalogSvc.enabledPresets(catalog).map((p) => p.label)).toContain(
      "Clan match",
    );
  });

  it("keeps working after the owner deletes the preset (a copy, not a reference)", async () => {
    const id = await seed();
    await svc.publishPersonalPreset(G, id, { maxCount: 15 });
    await svc.deletePersonalPreset(G, A, id);
    expect(personal.state.rows).toHaveLength(0);
    expect(library.state.rows).toHaveLength(1);
    expect(library.state.rows[0].name).toBe("Clan match");
  });

  it("refuses a second publish while the copy exists, and allows it again once the copy is gone", async () => {
    const id = await seed();
    await svc.publishPersonalPreset(G, id, { maxCount: 15 });
    const twice = await svc.publishPersonalPreset(G, id, { maxCount: 15 });
    expect(twice.ok).toBe(false);
    expect(twice.ok === false && twice.error).toContain("already published");
    expect(library.state.rows).toHaveLength(1);
    library.state.rows.length = 0;
    expect(
      await svc.publishPersonalPreset(G, id, { maxCount: 15 }),
    ).toMatchObject({ ok: true });
  });

  it("validates again with the editor's validator against the current group cap", async () => {
    const id = await seed();
    const out = await svc.publishPersonalPreset(G, id, { maxCount: 1 });
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.error).toContain("no longer passes");
    expect(library.state.rows).toHaveLength(0);
  });

  it("applies the library's own limit and name rule", async () => {
    const id = await seed();
    library.state.duplicateOnCreate = true;
    const dup = await svc.publishPersonalPreset(G, id, { maxCount: 15 });
    expect(dup.ok).toBe(false);
    expect(dup.ok === false && dup.error).toContain(
      "library already has a preset with that name",
    );
    library.state.duplicateOnCreate = false;
    for (let i = 0; i < catalogSvc.MAX_LIBRARY_PRESETS; i++) {
      library.state.rows.push({
        _id: String(i + 100).padStart(24, "0"),
        guildId: G,
        name: `L${i}`,
      });
    }
    const full = await svc.publishPersonalPreset(G, id, { maxCount: 15 });
    expect(full.ok).toBe(false);
    expect(full.ok === false && full.error).toContain("library is full");
  });

  it("answers 'not found' for an unknown or foreign-guild preset", async () => {
    const id = await seed();
    expect(
      await svc.publishPersonalPreset("other-guild", id, { maxCount: 15 }),
    ).toEqual({ ok: false, error: "That preset was not found." });
    expect(
      await svc.publishPersonalPreset(G, "lib:" + "a".repeat(24), {
        maxCount: 15,
      }),
    ).toMatchObject({ ok: false });
  });

  it("unpublish deletes only the copy; the host keeps their preset; an unpublished one says so", async () => {
    const id = await seed();
    expect(await svc.unpublishPersonalPreset(G, id)).toEqual({
      ok: false,
      error: "That preset is not published.",
    });
    await svc.publishPersonalPreset(G, id, { maxCount: 15 });
    library.state.rows.push({
      _id: "f".repeat(24),
      guildId: G,
      name: "Admin's own",
    });
    const out = await svc.unpublishPersonalPreset(G, id);
    expect(out).toMatchObject({ ok: true });
    expect(library.state.rows.map((r) => r.name)).toEqual(["Admin's own"]);
    expect(personal.state.rows).toHaveLength(1);
  });

  it("pages the admin list so every host's presets stay reachable past one page", async () => {
    const total = svc.ADMIN_PERSONAL_PAGE_SIZE * 2 + 5;
    for (let i = 0; i < total; i++) {
      personal.state.rows.push({
        _id: String(i + 1).padStart(24, "0"),
        guildId: G,
        ownerId: `owner-${String(i).padStart(4, "0")}`,
        name: `Preset ${i}`,
        nameKey: `preset ${i}`,
        groups: [],
      });
    }
    const seen: string[] = [];
    for (let page = 0; ; page++) {
      const out = await svc.listHostPresetsForAdmin(G, page);
      seen.push(...out.rows.map((r) => r.ownerId));
      expect(out.rows.length).toBeLessThanOrEqual(svc.ADMIN_PERSONAL_PAGE_SIZE);
      if (!out.hasMore) break;
      expect(page).toBeLessThan(10);
    }
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    // An absurd page is read as the first, and a page past the end is empty.
    expect((await svc.listHostPresetsForAdmin(G, -3)).rows[0].ownerId).toBe(
      "owner-0000",
    );
    expect((await svc.listHostPresetsForAdmin(G, 50)).rows).toEqual([]);
  });

  it("lists every host's presets for the admin with their published state", async () => {
    const idA = await seed();
    await svc.createPersonalPreset(G, B, data({ name: "Theirs" }));
    await svc.publishPersonalPreset(G, idA, { maxCount: 15 });
    const { rows, hasMore } = await svc.listHostPresetsForAdmin(G);
    expect(hasMore).toBe(false);
    expect(
      rows.map((r) => [r.entry.label, r.ownerId, r.publishedAs !== null]),
    ).toEqual([
      ["Clan match", A, true],
      ["Theirs", B, false],
    ]);
    expect(rows[0].publishedAs).toMatch(/^lib:/);
  });
});
