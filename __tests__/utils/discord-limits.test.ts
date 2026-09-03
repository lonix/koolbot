import { describe, it, expect } from "@jest/globals";
import {
  clampToLimit,
  truncateText,
  DISCORD_MESSAGE_CONTENT_LIMIT,
  DISCORD_EMBED_DESCRIPTION_LIMIT,
  DISCORD_EMBED_FIELD_VALUE_LIMIT,
} from "../../src/utils/discord-limits.js";

describe("discord-limits", () => {
  it("exposes Discord's documented payload limits", () => {
    expect(DISCORD_MESSAGE_CONTENT_LIMIT).toBe(2000);
    expect(DISCORD_EMBED_DESCRIPTION_LIMIT).toBe(4096);
    expect(DISCORD_EMBED_FIELD_VALUE_LIMIT).toBe(1024);
  });

  describe("truncateText", () => {
    it("returns text that already fits unchanged", () => {
      expect(truncateText("hello", 5)).toBe("hello");
      expect(truncateText("hello", 10)).toBe("hello");
    });

    it("cuts to the limit including the ellipsis", () => {
      const result = truncateText("a".repeat(20), 10);
      expect(result).toBe(`${"a".repeat(9)}…`);
      expect(result.length).toBe(10);
    });

    it("supports a custom ellipsis", () => {
      const result = truncateText("a".repeat(20), 10, "...");
      expect(result).toBe(`${"a".repeat(7)}...`);
      expect(result.length).toBe(10);
    });

    it("never exceeds the limit even when it is smaller than the ellipsis", () => {
      expect(truncateText("abcdef", 2, "...").length).toBeLessThanOrEqual(2);
      expect(truncateText("abcdef", 0)).toBe("");
    });
  });

  describe("clampToLimit", () => {
    it("joins rows verbatim when they fit", () => {
      expect(clampToLimit(["a", "b", "c"], 100)).toBe("a\nb\nc");
      expect(clampToLimit(["a", "b", "c"], 5)).toBe("a\nb\nc");
    });

    it("returns an empty string for no rows", () => {
      expect(clampToLimit([], 10)).toBe("");
    });

    it("drops whole trailing rows and appends an overflow line", () => {
      const rows = Array.from({ length: 50 }, (_, i) => `row ${i + 1}`);
      const result = clampToLimit(rows, 100);

      expect(result.length).toBeLessThanOrEqual(100);
      expect(result.startsWith("row 1\nrow 2\n")).toBe(true);
      expect(result).toMatch(/\n…and \d+ more$/);

      const kept = result.split("\n").filter((l) => l.startsWith("row "));
      const dropped = Number(/…and (\d+) more$/.exec(result)?.[1]);
      expect(kept.length + dropped).toBe(50);
      // No kept row is ever partially cut.
      kept.forEach((line, i) => expect(line).toBe(`row ${i + 1}`));
    });

    it("keeps rows intact right up to the limit", () => {
      // "aaaa\nbbbb" (9 chars) plus "\n…and 3 more" (12 chars) is 21; adding
      // the third row would need 26, so exactly two rows survive.
      const result = clampToLimit(["aaaa", "bbbb", "cccc", "dddd", "eeee"], 22);
      expect(result).toBe("aaaa\nbbbb\n…and 3 more");
      expect(result.length).toBeLessThanOrEqual(22);
    });

    it("honours a custom separator and overflow label", () => {
      const rows = ["one", "two", "three", "four", "five"];
      const result = clampToLimit(rows, 22, {
        separator: "\n\n",
        overflowLabel: (n) => `(+${n})`,
      });
      expect(result).toBe("one\n\ntwo\n\nthree\n\n(+2)");
      expect(result.length).toBeLessThanOrEqual(22);
    });

    it("truncates the first row when it alone exceeds the limit", () => {
      const result = clampToLimit(["x".repeat(500), "second"], 50);
      expect(result.length).toBeLessThanOrEqual(50);
      expect(result.endsWith("\n…and 1 more")).toBe(true);
      expect(result.startsWith("xxxx")).toBe(true);
    });

    it("truncates a single oversized row without an overflow note", () => {
      const result = clampToLimit(["x".repeat(500)], 50);
      expect(result.length).toBe(50);
      expect(result.endsWith("…")).toBe(true);
      expect(result).not.toContain("…and");
    });

    it("stays within the limit for every row count up to the leaderboard maximum", () => {
      // Worst-case /voicestats rows: 32-char usernames and five-digit hours.
      const row = (i: number) => `${i + 1}. ${"w".repeat(32)}: 99999h 59m`;
      for (let count = 1; count <= 50; count++) {
        const rows = Array.from({ length: count }, (_, i) => row(i));
        const result = clampToLimit(rows, DISCORD_MESSAGE_CONTENT_LIMIT);
        expect(result.length).toBeLessThanOrEqual(
          DISCORD_MESSAGE_CONTENT_LIMIT,
        );
      }
    });
  });
});
