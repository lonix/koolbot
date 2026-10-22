import { describe, it, expect } from "@jest/globals";
import { PermissionFlagsBits } from "discord.js";
import {
  SELF_ASSIGN_FORBIDDEN_PERMISSIONS,
  forbiddenSelfAssignPermissions,
  automaticGrantBlockReason,
  groupBackedBlockReason,
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

  it.each(["Admins", "Moderators", "Event hosts"])(
    "refuses a role that backs the %s group even without permissions (#1375)",
    (groupName) => {
      expect(
        automaticGrantBlockReason({ id: "2", ...role() }, [
          { roleId: "2", groupName },
        ]),
      ).toContain(`backs the role group "${groupName}"`);
    },
  );

  it("ignores groups backed by other roles", () => {
    expect(
      automaticGrantBlockReason({ id: "2", ...role() }, [
        { roleId: "3", groupName: "Moderators" },
      ]),
    ).toBeNull();
  });

  it("treats a role with unreadable permissions as safe", () => {
    expect(automaticGrantBlockReason({ id: "1" })).toBeNull();
  });
});

describe("groupBackedBlockReason (#1375)", () => {
  it("is null when no group uses the role", () => {
    expect(groupBackedBlockReason([])).toBeNull();
  });

  it("names every group and strips line breaks from the name", () => {
    const reason = groupBackedBlockReason([
      { roleId: "1", groupName: "Mods\nforged line" },
      { roleId: "1", groupName: "Hosts" },
    ]);
    expect(reason).toContain('"Mods forged line", "Hosts"');
    expect(reason).not.toContain("\n");
  });
});
