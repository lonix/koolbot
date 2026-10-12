import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { QuoteService } from "../../src/services/quote-service.js";
import { ConfigService } from "../../src/services/config-service.js";
import {
  RoleGroupService,
  type RoleGroupView,
} from "../../src/services/role-group-service.js";

jest.mock("mongoose");
jest.mock("../../src/database/schema.js");
jest.mock("../../src/services/config-service.js");
jest.mock("../../src/services/cooldown-manager.js");
jest.mock("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

/**
 * `quotes.delete_roles` with role groups (#1023). The fallback (no guild id,
 * or no staff/admin group) keeps the original role-id behaviour.
 */

const group = (
  id: string,
  rank: number,
  roleId: string,
  capabilities: RoleGroupView["capabilities"] = [],
): RoleGroupView =>
  ({ id, name: id, rank, roleId, capabilities }) as unknown as RoleGroupView;

const GROUPS = [
  group("admin", 3, "rAdmin", ["admin"]),
  group("mod", 2, "rMod", ["staff"]),
  group("vip", 1, "rVip"),
];

describe("QuoteService.deleteQuote with role groups", () => {
  let service: QuoteService;
  let findById: jest.Mock;
  let findByIdAndDelete: jest.Mock;
  let setting = "";
  let listSpy: jest.SpiedFunction<RoleGroupService["list"]>;

  beforeEach(() => {
    jest.clearAllMocks();
    setting = "";
    service = new QuoteService();
    findById = jest.fn(async () => ({ _id: "q1", addedById: "author" }));
    findByIdAndDelete = jest.fn(async () => undefined);
    (service as never as { model: unknown }).model = {
      findById,
      findByIdAndDelete,
    };
    // The service holds one module-level ConfigService; point its read at
    // the test's setting value.
    const config = ConfigService.getInstance() as unknown as {
      getString: jest.Mock;
    };
    config.getString = jest.fn(async () => setting);
    listSpy = jest
      .spyOn(RoleGroupService.getInstance(), "list")
      .mockResolvedValue(GROUPS);
  });

  const del = (roles: string[], guildId?: string, user = "someone") =>
    service.deleteQuote("q1", user, roles, guildId);

  describe("fallback (unchanged behaviour)", () => {
    it("without a guild id never reads groups", async () => {
      setting = "rawRole";
      await expect(del(["rawRole"])).resolves.toBeUndefined();
      await expect(del(["other"])).rejects.toThrow("permission");
      expect(listSpy).not.toHaveBeenCalled();
    });

    it("an empty setting stays open with no groups defined", async () => {
      listSpy.mockResolvedValue([]);
      await expect(del([], "g1")).resolves.toBeUndefined();
    });

    it("an empty setting stays open when no group is staff or admin", async () => {
      listSpy.mockResolvedValue([group("vip", 1, "rVip")]);
      await expect(del([], "g1")).resolves.toBeUndefined();
    });

    it("raw role ids still work with groups defined", async () => {
      setting = "rawRole";
      await expect(del(["rawRole"], "g1")).resolves.toBeUndefined();
      await expect(del(["rMod"], "g1")).rejects.toThrow("permission");
    });

    it("lets the quote's own saver delete it", async () => {
      setting = "rawRole";
      await expect(del([], "g1", "author")).resolves.toBeUndefined();
    });
  });

  describe("group based", () => {
    it("an empty setting means staff and admin once such a group exists", async () => {
      await expect(del(["rMod"], "g1")).resolves.toBeUndefined();
      await expect(del(["rAdmin"], "g1")).resolves.toBeUndefined();
      await expect(del(["rVip"], "g1")).rejects.toThrow("permission");
      await expect(del([], "g1")).rejects.toThrow("permission");
      expect(findByIdAndDelete).toHaveBeenCalledTimes(2);
    });

    it("accepts a group token", async () => {
      setting = "group:vip";
      await expect(del(["rVip"], "g1")).resolves.toBeUndefined();
      await expect(del(["rMod"], "g1")).rejects.toThrow("permission");
    });

    it("accepts 'and above'", async () => {
      setting = "group:mod+";
      await expect(del(["rAdmin"], "g1")).resolves.toBeUndefined();
      await expect(del(["rMod"], "g1")).resolves.toBeUndefined();
      await expect(del(["rVip"], "g1")).rejects.toThrow("permission");
    });

    it("mixes raw roles and groups", async () => {
      setting = "rawRole,group:mod";
      await expect(del(["rawRole"], "g1")).resolves.toBeUndefined();
      await expect(del(["rMod"], "g1")).resolves.toBeUndefined();
    });

    it("a group-only setting is not treated as empty", async () => {
      setting = "group:gone";
      await expect(del(["rMod"], "g1")).rejects.toThrow("permission");
    });

    it("denies rather than opening deletion when the groups can't be read", async () => {
      listSpy.mockRejectedValue(new Error("database offline"));
      await expect(del(["rMod"], "g1")).rejects.toThrow("permission");
      setting = "rawRole";
      await expect(del(["rawRole"], "g1")).rejects.toThrow("permission");
      // The saver can still remove their own quote.
      await expect(del([], "g1", "author")).resolves.toBeUndefined();
    });
  });
});
