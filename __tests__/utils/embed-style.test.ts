/**
 * `embedColor` (#1324): every kind is read from the `embed-*` tokens in
 * `docs/design/tokens.json`, aliases are resolved, and a missing or malformed
 * token fails loudly instead of producing a wrong colour.
 */
import { beforeEach, describe, expect, it } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";

const TOKENS_JSON = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../docs/design/tokens.json",
);

interface Tokens {
  color: { tokens: { name: string; value: string }[] };
}

const tokens = JSON.parse(fs.readFileSync(TOKENS_JSON, "utf8")) as Tokens;
const byName = new Map(tokens.color.tokens.map((t) => [t.name, t.value]));

function expected(name: string): number {
  let value = byName.get(name) as string;
  while (/^\{.*\}$/.test(value)) {
    value = byName.get(value.slice(1, -1)) as string;
  }
  return parseInt(value.slice(1), 16);
}

const KINDS = ["brand", "ok", "warn", "danger", "neutral", "lore"] as const;

describe("embedColor", () => {
  beforeEach(async () => {
    const { resetEmbedStyleForTests } =
      await import("../../src/utils/embed-style.js");
    const { resetDesignTokensForTests } =
      await import("../../src/utils/design-tokens.js");
    resetEmbedStyleForTests();
    resetDesignTokensForTests();
  });

  it.each(KINDS)("%s equals the resolved embed-%s token", async (kind) => {
    const { embedColor } = await import("../../src/utils/embed-style.js");
    expect(embedColor(kind)).toBe(expected(`embed-${kind}`));
  });

  it("returns a 24-bit colour for every kind", async () => {
    const { embedColor } = await import("../../src/utils/embed-style.js");
    for (const kind of KINDS) {
      const c = embedColor(kind);
      expect(Number.isInteger(c)).toBe(true);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(0xffffff);
    }
  });

  it("resolves aliases (embed-warn -> warn, embed-neutral -> control)", async () => {
    const { embedColor } = await import("../../src/utils/embed-style.js");
    expect(byName.get("embed-warn")).toBe("{warn}");
    expect(embedColor("warn")).toBe(parseInt(byName.get("warn")!.slice(1), 16));
    expect(embedColor("neutral")).toBe(
      parseInt(byName.get("control")!.slice(1), 16),
    );
  });

  it("only accepts the six kinds at compile time", async () => {
    const { embedColor } = await import("../../src/utils/embed-style.js");
    // @ts-expect-error an unknown kind is a type error, not a runtime fallback
    const unknownKind: number = embedColor("purple");
    expect(unknownKind).toBeUndefined();
  });

  it("is token-driven: aliases and values come from the token list", async () => {
    const { resolveEmbedColors } =
      await import("../../src/utils/embed-style.js");
    const colors = resolveEmbedColors({
      color: {
        tokens: [
          { name: "base", value: "#010203" },
          { name: "embed-brand", value: "#0a0b0c" },
          { name: "embed-ok", value: "{base}" },
          { name: "embed-warn", value: "#000001" },
          { name: "embed-danger", value: "#000002" },
          { name: "embed-neutral", value: "#000003" },
          { name: "embed-lore", value: "#000004" },
        ],
      },
    });
    expect(colors.get("brand")).toBe(0x0a0b0c);
    expect(colors.get("ok")).toBe(0x010203);
    expect(colors.get("lore")).toBe(4);
  });

  it("fails clearly on a missing token, an alias cycle or a non-hex value", async () => {
    const { resolveEmbedColors } =
      await import("../../src/utils/embed-style.js");
    const full = KINDS.filter((k) => k !== "brand").map((k) => ({
      name: `embed-${k}`,
      value: "#000000",
    }));
    const run = (brand: { name: string; value: string }[]): unknown =>
      resolveEmbedColors({ color: { tokens: [...full, ...brand] } });
    expect(() => run([])).toThrow(/embed-brand" is missing/);
    expect(() =>
      run([
        { name: "embed-brand", value: "{a}" },
        { name: "a", value: "{embed-brand}" },
      ]),
    ).toThrow(/alias cycle/);
    expect(() => run([{ name: "embed-brand", value: "blue" }])).toThrow(
      /not a #rrggbb/,
    );
  });
});
