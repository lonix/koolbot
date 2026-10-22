/**
 * The series template of a row read through Mongoose is a subdocument, not the
 * plain object the other tests use (#1298). These tests build real documents
 * with the real model (no database needed) and run repeated scoped edits over
 * them.
 */
import { describe, it, expect, jest } from "@jest/globals";
import { nextSeriesTemplate } from "../../src/services/event-edit.js";

// The suite-wide setup replaces mongoose with a stub, so the real one is taken
// explicitly. No database is needed to build a hydrated document. The schema
// mirrors the series template of `models/event.ts` (a single nested subdocument).
const mongoose = jest.requireActual("mongoose") as typeof import("mongoose");
const TemplateSchema = new mongoose.Schema(
  {
    title: { type: String },
    description: { type: String },
    durationMinutes: { type: Number },
    timezone: { type: String },
  },
  { _id: false },
);
const RealEvent = mongoose.model(
  "HydratedSeriesTemplateProbe",
  new mongoose.Schema({
    title: String,
    description: String,
    startTime: Date,
    timezone: String,
    durationMinutes: Number,
    recurrence: String,
    seriesId: String,
    seriesTemplate: { type: TemplateSchema },
  }),
);

function hydrated(seriesTemplate?: Record<string, unknown>) {
  return new RealEvent({
    title: "Renamed once",
    description: "Bring snacks",
    startTime: new Date("2030-01-04T20:00:00Z"),
    timezone: "UTC",
    durationMinutes: 120,
    recurrence: "weekly",
    seriesId: "s1",
    ...(seriesTemplate ? { seriesTemplate } : {}),
  });
}

const TEMPLATE = {
  title: "Game night",
  description: "Bring snacks",
  durationMinutes: 120,
  timezone: "UTC",
};

describe("nextSeriesTemplate on a hydrated row", () => {
  it("keeps the unchanged fields of a stored template when only the duration changes", () => {
    const row = hydrated(TEMPLATE);
    // A subdocument, not a plain object.
    expect(row.seriesTemplate).not.toBe(TEMPLATE);
    expect(
      typeof (row.seriesTemplate as unknown as { toObject?: unknown }).toObject,
    ).toBe("function");
    const out = nextSeriesTemplate("following", row, {
      title: row.title,
      description: row.description,
      startTime: row.startTime,
      timezone: row.timezone,
      durationMinutes: 45,
    });
    // Exactly the four fields: no document internals, nothing lost.
    expect(out).toEqual({ ...TEMPLATE, durationMinutes: 45 });
    expect(Object.keys(out).sort()).toEqual([
      "description",
      "durationMinutes",
      "timezone",
      "title",
    ]);
  });

  it("returns the stored template as plain values for an 'occurrence' edit", () => {
    const row = hydrated(TEMPLATE);
    const out = nextSeriesTemplate("occurrence", row, {
      title: "Again",
      description: row.description,
      startTime: row.startTime,
      timezone: row.timezone,
      durationMinutes: row.durationMinutes,
    });
    expect(out).toEqual(TEMPLATE);
    expect(Object.keys(out)).toHaveLength(4);
  });

  it("survives repeated edits: rename once, then change only the duration for the series", () => {
    // 1: "This occurrence" rename, from a row with no template yet.
    const first = hydrated();
    first.title = "Game night";
    const afterRename = nextSeriesTemplate("occurrence", first, {
      title: "Special night",
      description: first.description,
      startTime: first.startTime,
      timezone: first.timezone,
      durationMinutes: first.durationMinutes,
    });
    // 2: the row as read back from the store, with that template.
    const second = hydrated(afterRename);
    second.title = "Special night";
    const afterDuration = nextSeriesTemplate("following", second, {
      title: second.title,
      description: second.description,
      startTime: second.startTime,
      timezone: second.timezone,
      durationMinutes: 45,
    });
    expect(afterDuration).toEqual({
      title: "Game night",
      description: "Bring snacks",
      durationMinutes: 45,
      timezone: "UTC",
    });
  });
});
