import { describe, it, expect } from "@jest/globals";
import {
  hasStaffGroup,
  isGroupRef,
  makeGroupRef,
  parseGroupRef,
  resolveGroupRefs,
  splitRoleRefs,
  splitRoleSetting,
  staffRoleIds,
} from "../../src/services/role-group-access.js";
import type { RoleGroupView } from "../../src/services/role-group-service.js";

const group = (
  id: string,
  rank: number,
  roleId: string | null,
  capabilities: RoleGroupView["capabilities"] = [],
): RoleGroupView =>
  ({ id, name: id, rank, roleId, capabilities }) as unknown as RoleGroupView;

// Highest rank first, like RoleGroupService.list().
const GROUPS = [
  group("admin", 3, "rAdmin", ["admin"]),
  group("mod", 2, "rMod", ["staff"]),
  group("vip", 1, "rVip"),
  group("lost", 0, null),
];

describe("group references (#1023)", () => {
  it("round-trips a reference with and without 'and above'", () => {
    expect(makeGroupRef("g1", false)).toBe("group:g1");
    expect(makeGroupRef("g1", true)).toBe("group:g1+");
    expect(parseGroupRef("group:g1")).toEqual({
      groupId: "g1",
      andAbove: false,
    });
    expect(parseGroupRef(" group:g1+ ")).toEqual({
      groupId: "g1",
      andAbove: true,
    });
  });

  it("does not mistake a role id or an empty reference for a group", () => {
    expect(parseGroupRef("123456789012345678")).toBeNull();
    expect(parseGroupRef("group:")).toBeNull();
    expect(parseGroupRef("group:+")).toBeNull();
    expect(isGroupRef("123456789012345678")).toBe(false);
    expect(isGroupRef("group:g1")).toBe(true);
  });

  it("splits a mixed list into role ids and group references", () => {
    expect(splitRoleRefs(["111", "group:a", " ", "222", "group:b+"])).toEqual({
      roleIds: ["111", "222"],
      groupRefs: ["group:a", "group:b+"],
    });
    expect(splitRoleSetting("111, group:a ,,222")).toEqual({
      roleIds: ["111", "222"],
      groupRefs: ["group:a"],
    });
    expect(splitRoleSetting("")).toEqual({ roleIds: [], groupRefs: [] });
  });
});

describe("resolveGroupRefs", () => {
  it("resolves a single group to its role", () => {
    expect(resolveGroupRefs(GROUPS, ["group:mod"])).toEqual(["rMod"]);
  });

  it("'and above' adds every group ranked at or above it", () => {
    expect(resolveGroupRefs(GROUPS, ["group:mod+"]).sort()).toEqual([
      "rAdmin",
      "rMod",
    ]);
    expect(resolveGroupRefs(GROUPS, ["group:vip+"]).sort()).toEqual([
      "rAdmin",
      "rMod",
      "rVip",
    ]);
  });

  it("skips unlinked and deleted groups, and de-duplicates", () => {
    expect(resolveGroupRefs(GROUPS, ["group:lost", "group:gone"])).toEqual([]);
    expect(
      resolveGroupRefs(GROUPS, ["group:mod", "group:mod+"]).sort(),
    ).toEqual(["rAdmin", "rMod"]);
  });

  it("ignores values that are not group references", () => {
    expect(resolveGroupRefs(GROUPS, ["123", "group:vip"])).toEqual(["rVip"]);
  });
});

describe("staff helpers", () => {
  it("counts staff and admin groups, with a role, as the staff capability", () => {
    expect(staffRoleIds(GROUPS).sort()).toEqual(["rAdmin", "rMod"]);
    expect(hasStaffGroup(GROUPS)).toBe(true);
  });

  it("is false when no group carries staff or admin", () => {
    expect(hasStaffGroup([group("vip", 1, "rVip")])).toBe(false);
    expect(hasStaffGroup([])).toBe(false);
    expect(staffRoleIds([group("s", 1, null, ["staff"])])).toEqual([]);
  });
});
