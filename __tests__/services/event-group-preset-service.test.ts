/**
 * The preset library service (#1200). The Mongoose models are replaced by
 * small fakes, so these tests cover the merging, fail-closed and validation
 * logic. The real unique constraints and the "no collection yet" case are in
 * `__tests__/integration/event-group-presets.integration.test.ts`.
 */
import { describe, it, expect, jest, beforeEach } from "@jest/globals";

type Rows = Array<Record<string, unknown>>;

let toggleRows: Rows = [];
let libraryRows: Rows = [];
let toggleFindError: Error | null = null;
let libraryFindError: Error | null = null;
let libraryFindThrows = false;

const lean = (rows: () => Rows, err: () => Error | null) => ({
  sort: () => lean(rows, err),
  lean: async (): Promise<Rows> => {
    const e = err();
    if (e) throw e;
    return rows();
  },
});

const mockCount = jest.fn<(q: unknown) => Promise<number>>();
const mockCreate = jest.fn<(doc: unknown) => Promise<{ _id: string }>>();
const mockFindOneAndUpdate =
  jest.fn<(q: unknown, u: unknown, o: unknown) => Promise<unknown>>();
const mockDeleteOne =
  jest.fn<(q: unknown) => Promise<{ deletedCount: number }>>();
const mockToggleUpdateOne =
  jest.fn<(q: unknown, u: unknown, o: unknown) => Promise<unknown>>();

jest.unstable_mockModule("../../src/models/event-group-preset.js", () => ({
  EventGroupPreset: {
    find: () => {
      if (libraryFindThrows) throw new Error("query could not be built");
      return lean(
        () => libraryRows,
        () => libraryFindError,
      );
    },
    countDocuments: mockCount,
    create: mockCreate,
    findOneAndUpdate: mockFindOneAndUpdate,
    deleteOne: mockDeleteOne,
  },
  EventGroupPresetToggle: {
    find: () =>
      lean(
        () => toggleRows,
        () => toggleFindError,
      ),
    updateOne: mockToggleUpdateOne,
  },
}));
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const svc = await import("../../src/services/event-group-preset-service.js");
const { validateGroupSetup, parseGroupForm } =
  await import("../../src/services/event-groups.js");

const OID = "0123456789abcdef01234567";

beforeEach(() => {
  jest.clearAllMocks();
  toggleRows = [];
  libraryRows = [];
  toggleFindError = null;
  libraryFindError = null;
  libraryFindThrows = false;
  mockCount.mockResolvedValue(0);
});

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: OID,
    name: "Clan match",
    description: "",
    groupLabel: "Squad",
    leaderLabel: "Lead",
    channelLeadMinutes: 30,
    groups: [
      { name: "Assault", kind: "team", size: 8, tag: "", marker: "" },
      { name: "Command", kind: "leads", size: null, tag: "", marker: "" },
    ],
    enabled: true,
    ...over,
  };
}

describe("loadPresetCatalog", () => {
  it("has every built-in on when nothing was ever switched (no rows, no collection)", async () => {
    const catalog = await svc.loadPresetCatalog("g1");
    expect(catalog.state).toBe("ok");
    expect(catalog.entries.map((e) => [e.id, e.enabled])).toEqual([
      ["builtin:red-vs-blue", true],
      ["builtin:eve-factions", true],
      ["builtin:wardogs", true],
    ]);
  });

  it("applies built-in switches and lists library presets with their id", async () => {
    toggleRows = [{ builtinId: "builtin:eve-factions", enabled: false }];
    libraryRows = [
      row(),
      row({ _id: "a".repeat(24), name: "Off", enabled: false }),
    ];
    const catalog = await svc.loadPresetCatalog("g1");
    const byId = new Map(catalog.entries.map((e) => [e.id, e]));
    expect(byId.get("builtin:eve-factions")?.enabled).toBe(false);
    expect(byId.get(`lib:${OID}`)).toMatchObject({
      source: "library",
      label: "Clan match",
      leaderLabel: "Lead",
      channelLeadMinutes: 30,
      enabled: true,
    });
    expect(svc.enabledPresets(catalog).map((p) => p.id)).toEqual([
      "builtin:red-vs-blue",
      "builtin:wardogs",
      `lib:${OID}`,
    ]);
  });

  it("fails closed when the switches cannot be read: nothing is offered", async () => {
    toggleFindError = new Error("down");
    const catalog = await svc.loadPresetCatalog("g1");
    expect(catalog.state).toBe("all-unreadable");
    expect(svc.enabledPresets(catalog)).toEqual([]);
    expect(svc.catalogNotice(catalog.state)).toMatch(/Custom still works/);
  });

  it("offers only the enabled built-ins when just the library cannot be read", async () => {
    libraryFindError = new Error("down");
    toggleRows = [{ builtinId: "builtin:wardogs", enabled: false }];
    const catalog = await svc.loadPresetCatalog("g1");
    expect(catalog.state).toBe("library-unreadable");
    expect(svc.enabledPresets(catalog).map((p) => p.id)).toEqual([
      "builtin:red-vs-blue",
      "builtin:eve-factions",
    ]);
  });

  it("treats a model that throws while building the query as unreadable too", async () => {
    libraryFindThrows = true;
    const catalog = await svc.loadPresetCatalog("g1");
    expect(catalog.state).toBe("library-unreadable");
  });
});

describe("presetResolver", () => {
  it("separates enabled, disabled, unknown and unreadable", async () => {
    toggleRows = [{ builtinId: "builtin:wardogs", enabled: false }];
    libraryRows = [
      row(),
      row({ _id: "b".repeat(24), name: "Off", enabled: false }),
    ];
    const resolve = svc.presetResolver(await svc.loadPresetCatalog("g1"));
    expect(resolve("builtin:red-vs-blue")).toHaveProperty("preset");
    expect(resolve(`lib:${OID}`)).toHaveProperty("preset");
    expect(resolve("builtin:wardogs")).toMatchObject({ refused: "disabled" });
    expect(resolve(`lib:${"b".repeat(24)}`)).toMatchObject({
      refused: "disabled",
      label: "Off",
    });
    expect(resolve("lib:ffffffffffffffffffffffff")).toMatchObject({
      refused: "unknown",
    });
    expect(resolve("builtin:nope")).toMatchObject({ refused: "unknown" });
  });

  it("refuses everything it cannot confirm when the catalog is unreadable", () => {
    const all = svc.presetResolver({ entries: [], state: "all-unreadable" });
    expect(all("builtin:wardogs")).toMatchObject({ refused: "unreadable" });
    const lib = svc.presetResolver({
      entries: [],
      state: "library-unreadable",
    });
    expect(lib("lib:ffffffffffffffffffffffff")).toMatchObject({
      refused: "unreadable",
    });
  });
});

describe("the validator with the resolver", () => {
  const input = (
    presetId: string,
  ): Parameters<typeof validateGroupSetup>[0] => ({
    enabled: true,
    presetId,
    groupLabel: "",
    leaderLabel: "",
    channelLeadMinutes: "",
    rows: [],
  });

  it("uses a library preset's groups and leader label as the fallback", async () => {
    libraryRows = [row()];
    const resolve = svc.presetResolver(await svc.loadPresetCatalog("g1"));
    const result = validateGroupSetup(input(`lib:${OID}`), {
      maxCount: 15,
      resolvePreset: resolve,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.setup.presetId).toBe(`lib:${OID}`);
    expect(result.setup.groupLabel).toBe("Squad");
    expect(result.setup.leaderLabel).toBe("Lead");
    expect(result.setup.groups.map((g) => [g.name, g.kind, g.size])).toEqual([
      ["Assault", "team", 8],
      ["Command", "leads", null],
    ]);
  });

  it("refuses a disabled preset with a message saying so", async () => {
    toggleRows = [{ builtinId: "builtin:wardogs", enabled: false }];
    const resolve = svc.presetResolver(await svc.loadPresetCatalog("g1"));
    const result = validateGroupSetup(input("builtin:wardogs"), {
      maxCount: 15,
      resolvePreset: resolve,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toContain(
      'Preset "Wardogs" is switched off on this server',
    );
  });

  it("keeps knowing every built-in when no resolver is given", () => {
    const result = validateGroupSetup(input("builtin:wardogs"), {
      maxCount: 15,
    });
    expect(result.ok).toBe(true);
  });
});

describe("validatePresetForm", () => {
  const body = (over: Record<string, string> = {}): Record<string, string> => ({
    preset_name: "Clan match",
    group_0_name: "Assault",
    group_0_size: "8",
    group_1_name: "Command",
    group_1_kind: "leads",
    ...over,
  });

  it("accepts a preset and returns clean data", () => {
    const r = svc.validatePresetForm(
      body({ groups_label: " Squad ", groups_lead_minutes: "30" }),
      { maxCount: 15 },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({
      name: "Clan match",
      groupLabel: "Squad",
      leaderLabel: "Leader",
      channelLeadMinutes: 30,
    });
    expect(r.data.groups).toHaveLength(2);
  });

  it("runs the event form's own rules on the groups", () => {
    const r = svc.validatePresetForm(
      body({
        group_0_size: "100",
        group_1_kind: "leads",
        group_2_name: "X",
        group_2_kind: "leads",
      }),
      { maxCount: 15 },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const text = r.errors.join(" ");
    expect(text).toContain("Group 1 size");
    expect(text).toContain("only one leads group");
  });

  it("matches what the event form would accept: same input, same verdict", () => {
    const cases = [
      body(),
      body({ group_1_name: "assault" }),
      body({ group_0_tag: "TOOLONGTAG" }),
      body({ group_0_marker: "12345" }),
      body({ groups_lead_minutes: "9999" }),
    ];
    for (const c of cases) {
      const lib = svc.validatePresetForm(c, { maxCount: 15 });
      const form = validateGroupSetup(
        { ...parseGroupForm(c), enabled: true, presetId: "" },
        { maxCount: 15 },
      );
      expect(lib.ok).toBe(form.ok);
    }
  });

  it("requires a name, bounds its length and refuses a built-in's name ignoring case", () => {
    expect(
      svc.validatePresetForm(body({ preset_name: "  " }), { maxCount: 15 }).ok,
    ).toBe(false);
    const long = svc.validatePresetForm(body({ preset_name: "x".repeat(51) }), {
      maxCount: 15,
    });
    expect(!long.ok && long.errors.join(" ")).toContain("at most 50");
    const builtin = svc.validatePresetForm(body({ preset_name: "WARDOGS" }), {
      maxCount: 15,
    });
    expect(!builtin.ok && builtin.errors.join(" ")).toContain("built-in");
  });

  it("refuses too many groups, no groups and a long description", () => {
    const many: Record<string, string> = { preset_name: "Big" };
    for (let i = 0; i < 5; i++) many[`group_${i}_name`] = `G${i}`;
    const tooMany = svc.validatePresetForm(many, { maxCount: 4 });
    expect(!tooMany.ok && tooMany.errors.join(" ")).toContain("at most 4");
    const none = svc.validatePresetForm(
      { preset_name: "Empty" },
      { maxCount: 4 },
    );
    expect(!none.ok && none.errors[0]).toBe(
      "Add at least one group, each with a name.",
    );
    const desc = svc.validatePresetForm(
      body({ preset_description: "d".repeat(201) }),
      { maxCount: 15 },
    );
    expect(!desc.ok && desc.errors.join(" ")).toContain("description");
  });
});

describe("writes", () => {
  const data = {
    name: "Clan match",
    description: "",
    groupLabel: "Squad",
    leaderLabel: "Leader",
    channelLeadMinutes: null,
    groups: [
      { name: "A", kind: "team" as const, size: null, tag: "", marker: "" },
    ],
  };

  it("creates with a lower-cased nameKey and returns the lib: id", async () => {
    mockCreate.mockResolvedValue({ _id: OID });
    const r = await svc.createLibraryPreset("g1", data);
    expect(r).toEqual({ ok: true, id: `lib:${OID}` });
    expect(mockCreate.mock.calls[0][0]).toMatchObject({
      guildId: "g1",
      name: "Clan match",
      nameKey: "clan match",
      enabled: true,
    });
  });

  it("two concurrent creates at one below the cap give one success", async () => {
    let stored = svc.MAX_LIBRARY_PRESETS - 1;
    mockCount.mockImplementation(async () => stored);
    mockCreate.mockImplementation(async () => {
      // A real insert takes a round trip; the count of a second create that is
      // not serialised would land inside this window.
      await new Promise((resolve) => setTimeout(resolve, 5));
      stored++;
      return { _id: OID };
    });
    const [a, b] = await Promise.all([
      svc.createLibraryPreset("g1", data),
      svc.createLibraryPreset("g1", { ...data, name: "Other" }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(stored).toBe(svc.MAX_LIBRARY_PRESETS);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("refuses beyond the cap without writing", async () => {
    mockCount.mockResolvedValue(svc.MAX_LIBRARY_PRESETS);
    const r = await svc.createLibraryPreset("g1", data);
    expect(r.ok).toBe(false);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("turns a duplicate-key error into a clean message, on create and update", async () => {
    mockCreate.mockRejectedValue(
      Object.assign(new Error("dup"), { code: 11000 }),
    );
    const created = await svc.createLibraryPreset("g1", data);
    expect(!created.ok && created.error).toMatch(/already exists/);
    mockFindOneAndUpdate.mockRejectedValue(
      Object.assign(new Error("dup"), { code: 11000 }),
    );
    const updated = await svc.updateLibraryPreset("g1", `lib:${OID}`, data);
    expect(!updated.ok && updated.error).toMatch(/already exists/);
  });

  it("scopes update, delete and toggle to the guild and rejects malformed ids", async () => {
    mockFindOneAndUpdate.mockResolvedValue({ name: "Clan match" });
    await svc.updateLibraryPreset("g1", `lib:${OID}`, data);
    expect(mockFindOneAndUpdate.mock.calls[0][0]).toEqual({
      _id: OID,
      guildId: "g1",
    });
    mockDeleteOne.mockResolvedValue({ deletedCount: 0 });
    expect((await svc.deleteLibraryPreset("g1", `lib:${OID}`)).ok).toBe(false);
    expect(mockDeleteOne.mock.calls[0][0]).toEqual({ _id: OID, guildId: "g1" });
    for (const bad of ["", "lib:zz", "builtin:wardogs", `lib:${OID}x`]) {
      expect((await svc.deleteLibraryPreset("g1", bad)).ok).toBe(false);
      expect((await svc.updateLibraryPreset("g1", bad, data)).ok).toBe(false);
    }
    expect(mockDeleteOne).toHaveBeenCalledTimes(1);
  });

  it("switches a built-in with an upsert of the wanted state, and rejects unknown built-ins", async () => {
    mockToggleUpdateOne.mockResolvedValue({});
    const r = await svc.setPresetEnabled("g1", "builtin:wardogs", false);
    expect(r).toEqual({ ok: true, label: "Wardogs" });
    expect(mockToggleUpdateOne).toHaveBeenCalledWith(
      { guildId: "g1", builtinId: "builtin:wardogs" },
      { $set: { enabled: false } },
      { upsert: true },
    );
    const bad = await svc.setPresetEnabled("g1", "builtin:nope", false);
    expect(bad.ok).toBe(false);
    expect(mockToggleUpdateOne).toHaveBeenCalledTimes(1);
  });

  it("switches a library preset in its own row and reports a missing one", async () => {
    mockFindOneAndUpdate.mockResolvedValueOnce({ name: "Clan match" });
    expect(await svc.setPresetEnabled("g1", `lib:${OID}`, true)).toEqual({
      ok: true,
      label: "Clan match",
    });
    mockFindOneAndUpdate.mockResolvedValueOnce(null);
    expect((await svc.setPresetEnabled("g1", `lib:${OID}`, true)).ok).toBe(
      false,
    );
  });
});
