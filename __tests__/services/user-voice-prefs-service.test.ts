import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import {
  applyNamePattern,
  UserVoicePrefsService,
  VoicePrefsValidationError,
} from "../../src/services/user-voice-prefs-service.js";
import { UserVoicePreferences } from "../../src/models/user-voice-preferences.js";

jest.mock("../../src/models/user-voice-preferences.js");
jest.mock("../../src/utils/logger.js");

const mockModel = UserVoicePreferences as unknown as {
  findOne: jest.Mock;
  create: jest.Mock;
};

interface FakeDoc {
  userId: string;
  namePattern?: string;
  presets: Array<{
    name: string;
    channelName?: string;
    userLimit?: number;
    bitrate?: number;
    isDefault?: boolean;
  }>;
  save: jest.Mock;
  markModified: jest.Mock;
}

function makeDoc(overrides: Partial<FakeDoc> = {}): FakeDoc {
  return {
    userId: "u1",
    presets: [],
    save: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    markModified: jest.fn(),
    ...overrides,
  };
}

// getPrefs awaits findOne() directly; point it at our fake doc so the
// lazy-create branch is never taken.
function stubGetPrefs(doc: FakeDoc): void {
  mockModel.findOne.mockResolvedValue(doc as never);
}

describe("applyNamePattern", () => {
  it("substitutes {username} (case-insensitive) with the display name", () => {
    expect(applyNamePattern("{username}'s Room", "Ada")).toBe("Ada's Room");
    expect(applyNamePattern("🎮 {USERNAME}", "Ada")).toBe("🎮 Ada");
    expect(applyNamePattern("{displayName} HQ", "Ada")).toBe("Ada HQ");
  });

  it("trims and clamps to 100 characters", () => {
    expect(applyNamePattern("  spaced  ", "Ada")).toBe("spaced");
    const long = applyNamePattern("{username}".padEnd(200, "x"), "Ada");
    expect(long).not.toBeNull();
    expect(long!.length).toBe(100);
  });

  it("returns null when the result is empty", () => {
    expect(applyNamePattern("   ", "Ada")).toBeNull();
  });
});

describe("UserVoicePrefsService validation", () => {
  let service: UserVoicePrefsService;
  beforeEach(() => {
    jest.clearAllMocks();
    service = UserVoicePrefsService.getInstance();
  });

  it("setNamePattern clears on empty input", async () => {
    const doc = makeDoc({ namePattern: "old" });
    stubGetPrefs(doc);
    const result = await service.setNamePattern("u1", "  ");
    expect(result).toBeNull();
    expect(doc.namePattern).toBeUndefined();
    expect(doc.save).toHaveBeenCalled();
  });

  it("setNamePattern rejects an over-long pattern", async () => {
    const doc = makeDoc();
    stubGetPrefs(doc);
    await expect(
      service.setNamePattern("u1", "x".repeat(101)),
    ).rejects.toBeInstanceOf(VoicePrefsValidationError);
    expect(doc.save).not.toHaveBeenCalled();
  });

  it("setNamePattern stores a trimmed pattern", async () => {
    const doc = makeDoc();
    stubGetPrefs(doc);
    const result = await service.setNamePattern("u1", "  {username} HQ ");
    expect(result).toBe("{username} HQ");
    expect(doc.namePattern).toBe("{username} HQ");
  });
});

describe("UserVoicePrefsService preset CRUD", () => {
  let service: UserVoicePrefsService;
  beforeEach(() => {
    jest.clearAllMocks();
    service = UserVoicePrefsService.getInstance();
  });

  it("savePreset creates a new preset", async () => {
    const doc = makeDoc();
    stubGetPrefs(doc);
    const out = await service.savePreset(
      "u1",
      "Squad night",
      { channelName: "Squad", userLimit: 5, bitrate: 96 },
      3,
    );
    expect(out).toEqual({ updated: false, name: "Squad night" });
    expect(doc.presets).toHaveLength(1);
    expect(doc.presets[0]).toMatchObject({
      name: "Squad night",
      channelName: "Squad",
      userLimit: 5,
      bitrate: 96,
      isDefault: false,
    });
  });

  it("savePreset updates an existing preset by case-insensitive name and preserves isDefault", async () => {
    const doc = makeDoc({
      presets: [{ name: "Squad", channelName: "Old", isDefault: true }],
    });
    stubGetPrefs(doc);
    const out = await service.savePreset(
      "u1",
      "squad",
      { channelName: "New", userLimit: 2, bitrate: 64 },
      3,
    );
    expect(out.updated).toBe(true);
    expect(doc.presets).toHaveLength(1);
    expect(doc.presets[0]).toMatchObject({
      name: "squad",
      channelName: "New",
      isDefault: true,
    });
  });

  it("savePreset rejects when the max is reached for a new preset", async () => {
    const doc = makeDoc({
      presets: [{ name: "a" }, { name: "b" }, { name: "c" }],
    });
    stubGetPrefs(doc);
    await expect(
      service.savePreset("u1", "d", {}, 3),
    ).rejects.toBeInstanceOf(VoicePrefsValidationError);
    expect(doc.save).not.toHaveBeenCalled();
  });

  it("savePreset rejects an empty name", async () => {
    const doc = makeDoc();
    stubGetPrefs(doc);
    await expect(
      service.savePreset("u1", "   ", {}, 3),
    ).rejects.toBeInstanceOf(VoicePrefsValidationError);
  });

  it("editPreset validates bounds and updates fields", async () => {
    const doc = makeDoc({ presets: [{ name: "Squad", isDefault: true }] });
    stubGetPrefs(doc);
    await service.editPreset(
      "u1",
      0,
      { name: "Squad+", channelName: "Room", userLimit: 10, bitrate: 128 },
      "Squad",
    );
    expect(doc.presets[0]).toMatchObject({
      name: "Squad+",
      channelName: "Room",
      userLimit: 10,
      bitrate: 128,
      isDefault: true,
    });
  });

  it("editPreset rejects an out-of-range bitrate", async () => {
    const doc = makeDoc({ presets: [{ name: "Squad" }] });
    stubGetPrefs(doc);
    await expect(
      service.editPreset("u1", 0, { name: "Squad", bitrate: 999 }),
    ).rejects.toBeInstanceOf(VoicePrefsValidationError);
  });

  it("editPreset rejects a name collision with another preset", async () => {
    const doc = makeDoc({ presets: [{ name: "A" }, { name: "B" }] });
    stubGetPrefs(doc);
    await expect(
      service.editPreset("u1", 1, { name: "a" }),
    ).rejects.toBeInstanceOf(VoicePrefsValidationError);
  });

  it("renamePreset rejects when expectedName no longer matches", async () => {
    const doc = makeDoc({ presets: [{ name: "Renamed" }] });
    stubGetPrefs(doc);
    await expect(
      service.renamePreset("u1", 0, "New", "Stale"),
    ).rejects.toBeInstanceOf(VoicePrefsValidationError);
  });

  it("deletePreset removes the row and reports remaining count", async () => {
    const doc = makeDoc({ presets: [{ name: "A" }, { name: "B" }] });
    stubGetPrefs(doc);
    const out = await service.deletePreset("u1", 0, "A");
    expect(out).toEqual({ name: "A", remaining: 1 });
    expect(doc.presets).toEqual([{ name: "B" }]);
  });

  it("setDefault toggles the default and clears the others", async () => {
    const doc = makeDoc({
      presets: [
        { name: "A", isDefault: true },
        { name: "B", isDefault: false },
      ],
    });
    stubGetPrefs(doc);
    const out = await service.setDefault("u1", 1, "B");
    expect(out).toEqual({ name: "B", isDefault: true });
    expect(doc.presets[0].isDefault).toBe(false);
    expect(doc.presets[1].isDefault).toBe(true);
  });

  it("setDefault unsets when the target was already default", async () => {
    const doc = makeDoc({ presets: [{ name: "A", isDefault: true }] });
    stubGetPrefs(doc);
    const out = await service.setDefault("u1", 0, "A");
    expect(out.isDefault).toBe(false);
    expect(doc.presets[0].isDefault).toBe(false);
  });
});
