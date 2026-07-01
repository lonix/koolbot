import { describe, it, expect } from "@jest/globals";
import { renderUserBirthdayBody } from "../../src/web/user-layout.js";

describe("renderUserBirthdayBody day dropdown (#704)", () => {
  const base = { csrfToken: "tok", featureEnabled: true };

  it("renders the day as a select, not a free-text number input", () => {
    const html = renderUserBirthdayBody({ ...base, selected: null });
    // Day is now a <select> matching the month dropdown.
    expect(html).toContain('<select id="bd-day" name="day"');
    expect(html).not.toContain('<input id="bd-day"');
  });

  it("offers all 31 day options plus a blank placeholder", () => {
    const html = renderUserBirthdayBody({ ...base, selected: null });
    expect(html).toContain("— Day —");
    for (let d = 1; d <= 31; d++) {
      expect(html).toContain(`<option value="${d}">${d}</option>`);
    }
  });

  it("preselects the stored month and day", () => {
    const html = renderUserBirthdayBody({
      ...base,
      selected: { month: 2, day: 29, year: null },
    });
    expect(html).toContain('<option value="2" selected>February</option>');
    expect(html).toContain('<option value="29" selected>29</option>');
  });

  it("includes the month-aware day-limiting script", () => {
    const html = renderUserBirthdayBody({ ...base, selected: null });
    // The script drives the Day dropdown off the selected Month.
    expect(html).toContain("bd-month");
    expect(html).toContain("bd-day");
    // Days-in-month table (Feb capped at 29).
    expect(html).toContain("[31,29,31,30,31,30,31,31,30,31,30,31]");
  });

  it("keeps the year as an optional number input", () => {
    const html = renderUserBirthdayBody({
      ...base,
      selected: { month: 6, day: 15, year: 1990 },
    });
    expect(html).toContain('<input id="bd-year" name="year" type="number"');
    expect(html).toContain('value="1990"');
  });
});
