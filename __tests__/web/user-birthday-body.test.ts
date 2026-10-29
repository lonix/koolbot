import { describe, it, expect } from "@jest/globals";
import { JSDOM } from "jsdom";
import {
  birthdayRemoveItems,
  renderUserBirthdayBody,
} from "../../src/web/user-layout.js";

/** What the tests read from a form control. */
type InputEl = { value: string };

describe("renderUserBirthdayBody day dropdown (#704)", () => {
  const base = { csrfToken: "tok" };

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

describe("renderUserBirthdayBody remove button (#1521)", () => {
  const stored = { month: 4, day: 12, year: null };

  function removeButton(html: string) {
    const doc = new JSDOM(html).window.document;
    return doc.querySelector('button[name="clear"]')!;
  }

  it("is a danger button without an inline style", () => {
    const b = removeButton(
      renderUserBirthdayBody({ csrfToken: "tok", selected: stored }),
    );
    expect(b.getAttribute("class")).toBe("kb-btn kb-btn--danger");
    expect(b.getAttribute("style")).toBeNull();
    expect(b.getAttribute("value")).toBe("1");
    expect(b.getAttribute("type")).toBe("submit");
  });

  it("asks first, with the consequences in the member's terms", () => {
    const b = removeButton(
      renderUserBirthdayBody({ csrfToken: "tok", selected: stored }),
    );
    expect(b.getAttribute("data-confirm")).toBe("Remove your birthday?");
    const items = JSON.parse(b.getAttribute("data-confirm-list")!) as string[];
    expect(items).toEqual(birthdayRemoveItems(0));
    expect(items.join(" ")).toContain(
      "birthday role you hold now is taken back",
    );
    expect(items.join(" ")).toContain(
      "your birthday is kept so you can try again",
    );
    expect(b.getAttribute("data-confirm-tone")).toBeNull();
  });

  it("the save form itself does not carry data-confirm", () => {
    const html = renderUserBirthdayBody({ csrfToken: "tok", selected: stored });
    const doc = new JSDOM(html).window.document;
    expect(doc.querySelector("form")!.hasAttribute("data-confirm")).toBe(false);
  });

  it("adds the cooldown line only when the cooldown is above 0", () => {
    const list = (seconds?: number): string[] =>
      JSON.parse(
        removeButton(
          renderUserBirthdayBody({
            csrfToken: "tok",
            selected: stored,
            changeCooldownSeconds: seconds,
          }),
        ).getAttribute("data-confirm-list")!,
      ) as string[];
    expect(list(undefined)).toHaveLength(4);
    expect(list(0)).toHaveLength(4);
    expect(list(300).at(-1)).toBe("You can set a birthday again in 5 minutes.");
    expect(list(30).at(-1)).toBe("You can set a birthday again in 30 seconds.");
  });

  it("renders no remove button without a stored birthday", () => {
    const html = renderUserBirthdayBody({ csrfToken: "tok", selected: null });
    expect(html).not.toContain('name="clear"');
  });
});

describe("renderUserBirthdayBody refused form (#1535)", () => {
  const refused = (errors: Record<string, string>) => ({
    formId: "birthday",
    errors,
    values: { month: "2", day: "30", year: "1800" },
  });

  it("uses the kb- field components for the three controls, with or without a refusal", () => {
    for (const refusedForm of [null, refused({})]) {
      const doc = new JSDOM(
        renderUserBirthdayBody({ csrfToken: "t", selected: null, refusedForm }),
      ).window.document;
      expect(doc.querySelectorAll(".kb-field > label.kb-label")).toHaveLength(
        3,
      );
      expect(doc.querySelectorAll("select.kb-select")).toHaveLength(2);
      expect(doc.querySelectorAll("input.kb-input")).toHaveLength(1);
      expect(doc.querySelector("[style]")).toBeNull();
    }
  });

  it("marks nothing for a form that was not refused", () => {
    const html = renderUserBirthdayBody({ csrfToken: "t", selected: null });
    expect(html).not.toContain("aria-invalid");
    expect(html).not.toContain("kb-field__error");
  });

  it("shows the posted values, not the stored birthday, and marks the date and year", () => {
    const doc = new JSDOM(
      renderUserBirthdayBody({
        csrfToken: "t",
        selected: { month: 6, day: 15, year: 1990 },
        refusedForm: refused({ date: "No such day.", year: "Bad year." }),
      }),
    ).window.document;
    expect(
      doc.querySelector("#bd-month option[selected]")!.getAttribute("value"),
    ).toBe("2");
    expect(
      doc.querySelector("#bd-day option[selected]")!.getAttribute("value"),
    ).toBe("30");
    expect((doc.getElementById("bd-year") as unknown as InputEl).value).toBe(
      "1800",
    );
    expect(doc.querySelectorAll('[aria-invalid="true"]')).toHaveLength(3);
    // Every control points at an error line that exists.
    for (const el of doc.querySelectorAll('[aria-invalid="true"]')) {
      const target = doc.getElementById(el.getAttribute("aria-describedby")!);
      expect(target?.classList.contains("kb-field__error")).toBe(true);
    }
  });

  it("escapes what was typed", () => {
    const html = renderUserBirthdayBody({
      csrfToken: "t",
      selected: null,
      refusedForm: {
        formId: "birthday",
        errors: { year: "Bad year." },
        values: { month: "", day: "", year: '"><script>x</script>' },
      },
    });
    expect(html).not.toContain("<script>x</script>");
  });
});
