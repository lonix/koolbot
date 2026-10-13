/**
 * Schema-level guard for #1142: `errorMessage` is capped by the model itself,
 * so a caller that forgets to bound it (the route tests mock `create`) still
 * cannot persist an unbounded string.
 */

import { describe, it, expect } from "@jest/globals";

interface RecordedSchema {
  path(name: string): { options: Record<string, unknown> };
}

describe("WebAuditLog schema", () => {
  it("caps errorMessage at 1000 characters through its setter", async () => {
    await import("../../src/models/web-audit-log.js");
    const registry = (
      globalThis as { __mockSchemas?: Map<string, RecordedSchema> }
    ).__mockSchemas;
    const schema = registry?.get("WebAuditLog");
    expect(schema).toBeDefined();

    const setter = schema!.path("errorMessage").options.set as (
      v: unknown,
    ) => unknown;
    expect(typeof setter).toBe("function");

    const capped = setter("E".repeat(50_000)) as string;
    expect(capped).toHaveLength(1000);
    expect(setter("short")).toBe("short");
    expect(setter(null)).toBeNull();
  });
});
