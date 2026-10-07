import { describe, it, expect } from "@jest/globals";
import fs from "fs";
import path from "path";

/**
 * Guards against Mongoose's "Duplicate schema index" warning (#1102).
 *
 * Declaring a single field with `index: true` / `unique: true` *and* adding a
 * `schema.index()` on the same lone key makes Mongoose keep one and silently
 * drop the other's options (TTL, unique, partial filter). Every model is
 * loaded under the global Schema stub (see `__tests__/setup.ts`), which
 * records both the field definitions and the `schema.index()` calls.
 */

type IndexEntry = [Record<string, unknown>, Record<string, unknown>];

interface RecordedSchema {
  definition: Record<string, Record<string, unknown> | undefined>;
  indexes(): IndexEntry[];
}

const modelsDir = path.join(process.cwd(), "src", "models");
for (const file of fs.readdirSync(modelsDir)) {
  if (file.endsWith(".ts")) {
    await import(`../../src/models/${file.replace(/\.ts$/, ".js")}`);
  }
}

const registry = (globalThis as { __mockSchemas?: Map<string, RecordedSchema> })
  .__mockSchemas;

describe("model schema indexes (#1102)", () => {
  it("loads the model schemas", () => {
    expect(registry?.size).toBeGreaterThan(5);
    expect(registry?.has("AdoptionSnapshot")).toBe(true);
  });

  it("never indexes a field both inline and via schema.index()", () => {
    const duplicates: string[] = [];
    for (const [model, schema] of registry ?? []) {
      const seen = new Set<string>();
      for (const [name, def] of Object.entries(schema.definition)) {
        if (def?.index || def?.unique) seen.add(JSON.stringify({ [name]: 1 }));
      }
      for (const [fields, options] of schema.indexes()) {
        const key = JSON.stringify(fields);
        const normalised = JSON.stringify(
          Object.fromEntries(Object.keys(fields).map((k) => [k, 1])),
        );
        const single = Object.keys(fields).length === 1;
        if (options.name == null && single && seen.has(normalised)) {
          duplicates.push(`${model} ${key}`);
        }
        seen.add(single ? normalised : key);
      }
    }
    expect(duplicates).toEqual([]);
  });

  it("keeps the AdoptionSnapshot one-active-per-server unique index", () => {
    const indexes = registry?.get("AdoptionSnapshot")?.indexes() ?? [];
    const unique = indexes.find(([, opts]) => opts.unique === true);
    expect(unique?.[0]).toEqual({ guildId: 1, active: 1 });
    expect(unique?.[1].partialFilterExpression).toEqual({ active: true });
  });
});
