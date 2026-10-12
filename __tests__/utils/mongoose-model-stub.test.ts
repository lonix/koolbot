import { describe, it, expect, afterEach } from "@jest/globals";
import mongoose from "mongoose";
import { mockModel, usePerModelStubs } from "../test-utils.js";

type Stub = Record<string, unknown>;

const modelOf = (name: string): Stub => mongoose.model(name) as unknown as Stub;

/** `usePerModelStubs()` is per test file; undo it so each case starts shared. */
afterEach(() => {
  (globalThis as { __perModelStubs?: boolean }).__perModelStubs = false;
});

describe("global mongoose mock model stubs (#1089)", () => {
  it("shares one stub across models by default", () => {
    const a = modelOf("StubModelA");
    const b = modelOf("StubModelB");
    const marker = (): string => "shared";

    a.find = marker;

    expect(b.find).toBe(marker);
    expect(a.findOne).toBe(b.findOne);
  });

  it("returns the same object for repeated lookups of one model", () => {
    expect(modelOf("StubModelA")).toBe(modelOf("StubModelA"));
  });

  it("gives each model an independent stub after usePerModelStubs()", () => {
    usePerModelStubs();
    const a = modelOf("StubModelC");
    const b = modelOf("StubModelD");

    const aFind = (): string => "a";
    const bFind = (): string => "b";
    a.find = aFind;
    b.find = bFind;

    expect(a.find).toBe(aFind);
    expect(b.find).toBe(bFind);
    expect(a.findOne).not.toBe(b.findOne);
  });

  it("applies to models resolved before the opt-in", () => {
    // Resolved before opting in, as a model module imported at the top of a
    // test file would be.
    const early = modelOf("StubModelE");
    const sharedFind = early.find;

    usePerModelStubs();

    expect(early.find).not.toBe(sharedFind);
    expect(early.find).toBe(mockModel("StubModelE").find);
  });

  it("mockModel returns one stable stub per name", () => {
    expect(mockModel("StubModelF")).toBe(mockModel("StubModelF"));
    expect(mockModel("StubModelF")).not.toBe(mockModel("StubModelG"));
  });

  it("keeps the schema registry working", () => {
    const registry = (globalThis as { __mockSchemas?: Map<string, unknown> })
      .__mockSchemas;
    const schema = new mongoose.Schema({});
    mongoose.model("StubModelH", schema as never);

    expect(registry?.get("StubModelH")).toBe(schema);
  });
});
