import { describe, it, expect } from "@jest/globals";
import {
  classifyUpdate,
  compareVersions,
  formatVersion,
  parseVersion,
} from "../../src/utils/semver.js";

describe("semver helpers (#1029)", () => {
  describe("parseVersion", () => {
    it("parses plain and v-prefixed versions", () => {
      expect(parseVersion("2.1.0")).toEqual({
        major: 2,
        minor: 1,
        patch: 0,
        prerelease: null,
      });
      expect(parseVersion("v2.1.0")).toEqual(parseVersion("2.1.0"));
      expect(parseVersion(" v10.20.30 ")?.major).toBe(10);
    });

    it("keeps the pre-release and drops build metadata", () => {
      expect(parseVersion("2.0.0-rc.1+build.5")?.prerelease).toBe("rc.1");
      expect(parseVersion("2.0.0+build.5")?.prerelease).toBeNull();
    });

    it("rejects anything that is not a semantic version", () => {
      for (const raw of ["unknown", "", "2.1", "v", "2.1.0.4", "x2.1.0"]) {
        expect(parseVersion(raw)).toBeNull();
      }
      expect(parseVersion(null)).toBeNull();
      expect(parseVersion(undefined)).toBeNull();
    });
  });

  describe("compareVersions", () => {
    it("orders by major, then minor, then patch", () => {
      expect(compareVersions("1.2.2", "2.0.0")).toBe(-1);
      expect(compareVersions("2.1.0", "2.0.9")).toBe(1);
      expect(compareVersions("2.0.1", "2.0.10")).toBe(-1);
      expect(compareVersions("v2.0.0", "2.0.0")).toBe(0);
    });

    it("sorts a pre-release below its release", () => {
      expect(compareVersions("2.0.0-rc.1", "2.0.0")).toBe(-1);
      expect(compareVersions("2.0.0", "2.0.0-rc.1")).toBe(1);
      expect(compareVersions("2.0.0-rc.1", "2.0.0-rc.2")).toBe(-1);
      expect(compareVersions("2.0.0-rc.1", "2.0.0-rc.1")).toBe(0);
    });

    it("returns null when either side does not parse", () => {
      expect(compareVersions("unknown", "2.0.0")).toBeNull();
      expect(compareVersions("2.0.0", "latest")).toBeNull();
    });
  });

  describe("classifyUpdate", () => {
    it("names the part of the version that moved", () => {
      expect(classifyUpdate("1.2.2", "v2.0.0")).toBe("major");
      expect(classifyUpdate("2.0.0", "v2.1.0")).toBe("minor");
      expect(classifyUpdate("v2.1.0", "2.1.3")).toBe("patch");
      expect(classifyUpdate("2.0.0-rc.1", "2.0.0")).toBe("patch");
    });

    it("returns null when the target is not newer or can't be compared", () => {
      expect(classifyUpdate("2.1.0", "2.1.0")).toBeNull();
      expect(classifyUpdate("2.2.0", "2.1.0")).toBeNull();
      expect(classifyUpdate("unknown", "2.1.0")).toBeNull();
    });
  });

  it("formatVersion adds a v prefix only to semantic versions", () => {
    expect(formatVersion("2.1.0")).toBe("v2.1.0");
    expect(formatVersion("v2.1.0")).toBe("v2.1.0");
    expect(formatVersion("unknown")).toBe("unknown");
  });
});
