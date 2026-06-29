import { describe, it, expect } from "@jest/globals";
import {
  ACCOLADE_METADATA,
  MILESTONE_ACCOLADES,
  isMilestoneAccolade,
  type AccoladeType,
} from "../../src/content/accolades.js";

describe("MILESTONE_ACCOLADES (#657, Part 2)", () => {
  it("references only real accolade types", () => {
    for (const type of MILESTONE_ACCOLADES) {
      expect(ACCOLADE_METADATA[type]).toBeDefined();
    }
  });

  it("has no duplicate entries", () => {
    expect(new Set(MILESTONE_ACCOLADES).size).toBe(MILESTONE_ACCOLADES.length);
  });

  it("stays a small, curated subset of all accolades", () => {
    const total = Object.keys(ACCOLADE_METADATA).length;
    // Loud, server-wide shout-outs should be rare — well under half of all
    // accolades. Guards against someone accidentally flagging the bulk of
    // the list and spamming the celebrations channel.
    expect(MILESTONE_ACCOLADES.length).toBeGreaterThan(0);
    expect(MILESTONE_ACCOLADES.length).toBeLessThan(total / 2);
  });

  it("includes the marquee crossings called out in the issue", () => {
    expect(MILESTONE_ACCOLADES).toContain("voice_legend_8765");
    expect(MILESTONE_ACCOLADES).toContain("voice_veteran_1000");
    expect(MILESTONE_ACCOLADES).toContain("quote_legend");
  });
});

describe("isMilestoneAccolade", () => {
  it("returns true for every flagged accolade", () => {
    for (const type of MILESTONE_ACCOLADES) {
      expect(isMilestoneAccolade(type)).toBe(true);
    }
  });

  it("returns false for a non-marquee accolade", () => {
    expect(isMilestoneAccolade("first_hour")).toBe(false);
    expect(isMilestoneAccolade("quotable")).toBe(false);
  });

  it("returns false for an unknown / non-accolade string", () => {
    expect(isMilestoneAccolade("not_a_real_type")).toBe(false);
    expect(isMilestoneAccolade("")).toBe(false);
  });

  it("agrees with the MILESTONE_ACCOLADES set across all accolades", () => {
    for (const type of Object.keys(ACCOLADE_METADATA) as AccoladeType[]) {
      expect(isMilestoneAccolade(type)).toBe(
        (MILESTONE_ACCOLADES as readonly string[]).includes(type),
      );
    }
  });
});
