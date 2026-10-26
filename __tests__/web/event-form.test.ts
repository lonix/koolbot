/**
 * `validateEventForm` names the field a refusal is about (#1531). The message
 * says what to change, in the host's terms; `field` is what a view marks.
 */
import { describe, it, expect, jest } from "@jest/globals";

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: (): unknown => ({
      getString: async (_key: string, fallback: string) => fallback,
      getNumber: async (_key: string, fallback: number) => fallback,
    }),
  },
}));

const { validateEventForm } = await import("../../src/web/event-form.js");
const { markField, renderRefusalCallout } =
  await import("../../src/web/event-field-errors.js");

const ok = {
  title: "Game night",
  description: "",
  date: "2999-01-01",
  time: "18:00",
  duration: "90",
  timezone: "UTC",
};

describe("validateEventForm: the field a refusal is about", () => {
  it.each([
    ["no title", { title: "" }, "title", "Enter a title."],
    ["no date", { date: "" }, "date", "Pick a date."],
    ["no time", { time: "" }, "time", "Enter a time, for example 19:30."],
    [
      "a title over the cap",
      { title: "x".repeat(101) },
      "title",
      "Use at most 100 characters for the title.",
    ],
    [
      "a description over the cap",
      { description: "x".repeat(1001) },
      "description",
      "Use at most 1000 characters for the description.",
    ],
    [
      "an unknown timezone",
      { timezone: "Mars/Base" },
      "timezone",
      "Pick a timezone from the list.",
    ],
    [
      "a malformed date",
      { date: "01/02/2999" },
      "date",
      "Use the date format YYYY-MM-DD.",
    ],
    [
      "a malformed time",
      { time: "7pm" },
      "time",
      "Use 24-hour time as HH:MM, for example 19:30.",
    ],
    [
      "a date that does not exist",
      { date: "2999-02-30" },
      "date",
      "That date and time do not exist. Pick another.",
    ],
    [
      "a start in the past",
      { date: "2000-01-01" },
      "date",
      "Pick a time in the future.",
    ],
    [
      "a duration of zero",
      { duration: "0" },
      "duration",
      "Enter a whole number of minutes, from 1 to 1440.",
    ],
    [
      "a duration that is not a number",
      { duration: "abc" },
      "duration",
      "Enter a whole number of minutes, from 1 to 1440.",
    ],
    [
      "a duration over the cap",
      { duration: "1441" },
      "duration",
      "At most 1440 minutes.",
    ],
  ] as const)("%s", async (_name, change, field, error) => {
    const r = await validateEventForm(
      { ...ok, ...change },
      { requireFuture: true },
    );
    expect(r).toEqual({ ok: false, field, error });
  });

  it("names When when the start comes from the When choice and is not in the future", async () => {
    const r = await validateEventForm(
      { ...ok, date: "", time: "" },
      { requireFuture: true, startOverride: new Date(Date.now() - 1000) },
    );
    expect(r).toEqual({
      ok: false,
      field: "when",
      error: "Pick a time in the future.",
    });
  });

  it("does not ask for a date or time when the When choice decides the start", async () => {
    const r = await validateEventForm(
      { ...ok, date: "", time: "" },
      { requireFuture: true, startOverride: new Date(Date.now() + 60_000) },
    );
    expect(r.ok).toBe(true);
  });

  it("accepts a start in the past when the edit leaves the start alone", async () => {
    const r = await validateEventForm(
      { ...ok, date: "2000-01-01" },
      { requireFuture: false },
    );
    expect(r.ok).toBe(true);
  });
});

describe("markField and renderRefusalCallout", () => {
  const refusal = {
    field: "duration",
    message: "At most 1440 minutes.",
  } as const;

  it("marks only the refused field, with an error line the control points at", () => {
    const m = markField(refusal, "duration", "d");
    expect(m.invalid).toBe(true);
    expect(m.attrs).toBe(' aria-invalid="true" aria-describedby="d-error"');
    expect(m.line).toBe(
      '<p class="kb-field__error" id="d-error">At most 1440 minutes.</p>',
    );
    const other = markField(refusal, "title", "t");
    expect(other).toMatchObject({
      invalid: false,
      errorId: undefined,
      attrs: "",
      line: "",
    });
    expect(other.after(8)).toBe("");
    expect(m.after(8)).toBe(`\n        ${m.line}`);
  });

  it("escapes the message", () => {
    const m = markField({ field: "title", message: "<b>x</b>" }, "title", "t");
    expect(m.line).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  it("gives the reason in the callout only when no field carries it", () => {
    expect(renderRefusalCallout(refusal, "Not saved")).not.toContain(
      "At most 1440",
    );
    const general = renderRefusalCallout(
      { message: "You already have 3 open events." },
      "Not saved",
    );
    expect(general).toContain("You already have 3 open events.");
    expect(general).toContain('role="alert"');
  });
});
