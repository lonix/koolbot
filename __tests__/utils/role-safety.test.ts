import { describe, it, expect } from "@jest/globals";
import { PermissionFlagsBits } from "discord.js";
import {
  SELF_ASSIGN_FORBIDDEN_PERMISSIONS,
  forbiddenSelfAssignPermissions,
  automaticGrantBlockReason,
} from "../../src/utils/role-safety.js";

const role = (...bits: bigint[]) => ({
  permissions: { bitfield: bits.reduce((a, b) => a | b, 0n) },
});

describe("forbiddenSelfAssignPermissions (#1145)", () => {
  it("covers exactly the permissions the audit listed", () => {
    expect(new Set(SELF_ASSIGN_FORBIDDEN_PERMISSIONS)).toEqual(
      new Set([
        PermissionFlagsBits.Administrator,
        PermissionFlagsBits.ManageGuild,
        PermissionFlagsBits.ManageRoles,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.BanMembers,
        PermissionFlagsBits.KickMembers,
        PermissionFlagsBits.ModerateMembers,
        PermissionFlagsBits.ManageWebhooks,
        PermissionFlagsBits.MentionEveryone,
      ]),
    );
  });

  it("names each forbidden permission a role carries", () => {
    expect(
      forbiddenSelfAssignPermissions(
        role(
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.Administrator,
          PermissionFlagsBits.KickMembers,
        ),
      ).sort(),
    ).toEqual(["Administrator", "KickMembers"]);
  });

  it("names only the bits actually set", () => {
    expect(
      forbiddenSelfAssignPermissions(role(PermissionFlagsBits.KickMembers)),
    ).toEqual(["KickMembers"]);
    expect(
      forbiddenSelfAssignPermissions(
        role(
          PermissionFlagsBits.Administrator,
          PermissionFlagsBits.KickMembers,
        ),
      ).sort(),
    ).toEqual(["Administrator", "KickMembers"]);
  });

  it("is empty for an ordinary role", () => {
    expect(
      forbiddenSelfAssignPermissions(
        role(PermissionFlagsBits.SendMessages, PermissionFlagsBits.Connect),
      ),
    ).toEqual([]);
    expect(forbiddenSelfAssignPermissions(role())).toEqual([]);
  });

  it("treats a role with no readable permissions as safe", () => {
    expect(forbiddenSelfAssignPermissions({})).toEqual([]);
    expect(forbiddenSelfAssignPermissions({ permissions: null })).toEqual([]);
  });
});

describe("automaticGrantBlockReason (#1145)", () => {
  it("allows a role with neither forbidden permissions nor the admin group", () => {
    expect(
      automaticGrantBlockReason(
        { id: "1", ...role(PermissionFlagsBits.ManageMessages) },
        ["2"],
      ),
    ).toBeNull();
  });

  it("names the forbidden permissions", () => {
    expect(
      automaticGrantBlockReason({
        id: "1",
        ...role(
          PermissionFlagsBits.Administrator,
          PermissionFlagsBits.BanMembers,
        ),
      }),
    ).toBe("carries powerful permissions (BanMembers, Administrator)");
  });

  it("refuses the admin role group's role even without permissions", () => {
    expect(automaticGrantBlockReason({ id: "2", ...role() }, ["2"])).toBe(
      "is the role of the admin role group",
    );
  });

  it("treats a role with unreadable permissions as safe", () => {
    expect(automaticGrantBlockReason({ id: "1" })).toBeNull();
  });
});
