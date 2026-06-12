import { describe, it, expect } from "@jest/globals";
import {
  resolveEmojiShortcodes,
  findUnknownShortcodes,
  EMOJI_SHORTCODES,
} from "../../src/utils/emoji-shortcodes.js";

describe("resolveEmojiShortcodes (#558)", () => {
  it("resolves a known shortcode to its Unicode emoji", () => {
    expect(resolveEmojiShortcodes(":green_circle:")).toBe("🟢");
    expect(resolveEmojiShortcodes(":red_circle:")).toBe("🔴");
    expect(resolveEmojiShortcodes(":video_game:")).toBe("🎮");
  });

  it("resolves a shortcode embedded in surrounding text", () => {
    expect(resolveEmojiShortcodes(":green_circle: Lobby")).toBe("🟢 Lobby");
    expect(resolveEmojiShortcodes("Lobby :red_circle:")).toBe("Lobby 🔴");
  });

  it("resolves multiple shortcodes in one value", () => {
    expect(resolveEmojiShortcodes(":green_circle: and :red_circle:")).toBe(
      "🟢 and 🔴",
    );
  });

  it("leaves unknown shortcodes untouched (no data loss)", () => {
    expect(resolveEmojiShortcodes(":not_a_real_emoji:")).toBe(
      ":not_a_real_emoji:",
    );
    // Custom/server emoji can't appear in channel names — passed through.
    expect(resolveEmojiShortcodes(":myserveremoji:")).toBe(":myserveremoji:");
  });

  it("resolves only the known token in a mixed string", () => {
    expect(resolveEmojiShortcodes(":green_circle: :unknown:")).toBe(
      "🟢 :unknown:",
    );
  });

  it("returns a value with no shortcode unchanged", () => {
    expect(resolveEmojiShortcodes("Lobby")).toBe("Lobby");
    expect(resolveEmojiShortcodes("")).toBe("");
    expect(resolveEmojiShortcodes("🟢 Lobby")).toBe("🟢 Lobby");
  });

  it("does not treat colon-delimited non-emoji text as a shortcode", () => {
    // A time like 12:34 has no surrounding word boundary the regex would
    // misread, and `http://` / bare colons stay intact.
    expect(resolveEmojiShortcodes("12:34")).toBe("12:34");
    expect(resolveEmojiShortcodes("https://example.com")).toBe(
      "https://example.com",
    );
    expect(resolveEmojiShortcodes("a :: b")).toBe("a :: b");
  });

  it("matches shortcode names case-insensitively", () => {
    expect(resolveEmojiShortcodes(":GREEN_CIRCLE:")).toBe("🟢");
    expect(resolveEmojiShortcodes(":Green_Circle:")).toBe("🟢");
  });

  it("coerces non-string input to a string", () => {
    expect(resolveEmojiShortcodes(undefined)).toBe("");
    expect(resolveEmojiShortcodes(null)).toBe("");
    expect(resolveEmojiShortcodes(42)).toBe("42");
  });

  it("every mapped value is a non-empty string", () => {
    for (const [name, glyph] of Object.entries(EMOJI_SHORTCODES)) {
      expect(typeof glyph).toBe("string");
      expect(glyph.length).toBeGreaterThan(0);
      expect(name).toMatch(/^[a-z0-9_+-]+$/);
    }
  });
});

describe("findUnknownShortcodes (#558)", () => {
  it("returns an empty array when there are no shortcodes", () => {
    expect(findUnknownShortcodes("Lobby")).toEqual([]);
    expect(findUnknownShortcodes("")).toEqual([]);
  });

  it("returns an empty array when every shortcode is known", () => {
    expect(findUnknownShortcodes(":green_circle: :red_circle:")).toEqual([]);
  });

  it("lists unknown shortcodes in order, deduplicated", () => {
    expect(
      findUnknownShortcodes(":green_circle: :bogus: :bogus: :nope:"),
    ).toEqual([":bogus:", ":nope:"]);
  });

  it("preserves the original token casing in the result", () => {
    expect(findUnknownShortcodes(":Bogus:")).toEqual([":Bogus:"]);
  });
});
