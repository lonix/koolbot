/**
 * The one-line values on the `/me/` preference cards (#1508).
 */

import { describe, it, expect } from "@jest/globals";
import {
  birthdayValue,
  notificationsValue,
  privacyValue,
  timezoneValue,
  voiceValue,
} from "../../src/web/me-preference-values.js";

// 2030-06-01 09:59 UTC is 11:59 in Oslo (summer time) and 09:59 in UTC.
const NOW = new Date("2030-06-01T09:59:00Z");

describe("notificationsValue", () => {
  it.each([
    [2, 3, "2 of 3 on"],
    [0, 3, "None of 3 on"],
    [3, 3, "3 of 3 on"],
    [0, 0, ""],
  ])("%i on of %i offered reads %j", (on, offered, expected) => {
    expect(notificationsValue(on, offered)).toBe(expected);
  });
});

describe("timezoneValue", () => {
  it("names the member's zone and the time there", () => {
    expect(timezoneValue("Europe/Oslo", "UTC", NOW)).toBe(
      "Europe/Oslo · 11:59 now",
    );
  });

  it("says Server default, with the server zone, when none is stored", () => {
    expect(timezoneValue(null, "UTC", NOW)).toBe(
      "Server default (UTC) · 09:59 now",
    );
  });

  it("treats a stored zone that is no longer valid as unset", () => {
    expect(timezoneValue("Mars/Olympus", "UTC", NOW)).toBe(
      "Server default (UTC) · 09:59 now",
    );
  });
});

describe("voiceValue", () => {
  it.each([
    [null, 0, "Server default naming · No presets"],
    ["[AMR] {name}", 1, "[AMR] {name} · 1 preset"],
    [null, 3, "Server default naming · 3 presets"],
  ])("pattern %j with %i presets reads %j", (pattern, count, expected) => {
    expect(voiceValue(pattern, count)).toBe(expected);
  });
});

describe("birthdayValue / privacyValue", () => {
  it("prints the date without the year, or Not set", () => {
    expect(birthdayValue({ month: 3, day: 14 })).toBe("14 March");
    expect(birthdayValue(null)).toBe("Not set");
    expect(birthdayValue({ month: 13, day: 1 })).toBe("Not set");
  });

  it("names the tracking state", () => {
    expect(privacyValue(false)).toBe("Tracking on");
    expect(privacyValue(true)).toBe("Opted out of tracking");
  });
});
