import { describe, it, expect } from "@jest/globals";
import { data } from "../../src/commands/notice.js";

describe("Notice Command", () => {
  describe("command metadata", () => {
    it("should have correct command name", () => {
      expect(data.name).toBe("notice");
    });

    it("should have a description", () => {
      expect(data.description).toBeTruthy();
      expect(data.description).toContain("notice");
    });

    it("should be a valid slash command", () => {
      const json = data.toJSON();
      expect(json).toHaveProperty("name", "notice");
      expect(json).toHaveProperty("description");
    });

    it("should require administrator permissions", () => {
      const json = data.toJSON();
      expect(json.default_member_permissions).toBeDefined();
    });
  });

  describe("subcommands", () => {
    it("should have add subcommand", () => {
      const json = data.toJSON();
      const addSubcommand = json.options?.find(
        (opt: any) => opt.name === "add",
      );
      expect(addSubcommand).toBeDefined();
      expect(addSubcommand?.type).toBe(1); // SUBCOMMAND type
    });

    it("should have edit subcommand", () => {
      const json = data.toJSON();
      const editSubcommand = json.options?.find(
        (opt: any) => opt.name === "edit",
      );
      expect(editSubcommand).toBeDefined();
      expect(editSubcommand?.type).toBe(1);
    });

    it("should have delete subcommand", () => {
      const json = data.toJSON();
      const deleteSubcommand = json.options?.find(
        (opt: any) => opt.name === "delete",
      );
      expect(deleteSubcommand).toBeDefined();
      expect(deleteSubcommand?.type).toBe(1);
    });

    it("should have sync subcommand", () => {
      const json = data.toJSON();
      const syncSubcommand = json.options?.find(
        (opt: any) => opt.name === "sync",
      );
      expect(syncSubcommand).toBeDefined();
      expect(syncSubcommand?.type).toBe(1);
    });

    it("should not have list subcommand", () => {
      const json = data.toJSON();
      const listSubcommand = json.options?.find(
        (opt: any) => opt.name === "list",
      );
      expect(listSubcommand).toBeUndefined();
    });
  });

  describe("add subcommand parameters", () => {
    it("should have title parameter", () => {
      const json = data.toJSON();
      const addSubcommand = json.options?.find(
        (opt: any) => opt.name === "add",
      );
      const titleOption = addSubcommand?.options?.find(
        (opt: any) => opt.name === "title",
      );

      expect(titleOption).toBeDefined();
      expect(titleOption?.type).toBe(3); // STRING type
      expect(titleOption?.required).toBe(true);
      expect(titleOption?.max_length).toBe(256);
    });

    it("should have content parameter", () => {
      const json = data.toJSON();
      const addSubcommand = json.options?.find(
        (opt: any) => opt.name === "add",
      );
      const contentOption = addSubcommand?.options?.find(
        (opt: any) => opt.name === "content",
      );

      expect(contentOption).toBeDefined();
      expect(contentOption?.type).toBe(3);
      expect(contentOption?.required).toBe(true);
      expect(contentOption?.max_length).toBe(4000);
    });

    it("should have category parameter with choices", () => {
      const json = data.toJSON();
      const addSubcommand = json.options?.find(
        (opt: any) => opt.name === "add",
      );
      const categoryOption = addSubcommand?.options?.find(
        (opt: any) => opt.name === "category",
      );

      expect(categoryOption).toBeDefined();
      expect(categoryOption?.type).toBe(3);
      expect(categoryOption?.required).toBe(true);
      expect(categoryOption?.choices).toBeDefined();
      expect(categoryOption?.choices?.length).toBe(5);

      const categoryValues = categoryOption?.choices?.map(
        (choice: any) => choice.value,
      );
      expect(categoryValues).toContain("general");
      expect(categoryValues).toContain("rules");
      expect(categoryValues).toContain("info");
      expect(categoryValues).toContain("help");
      expect(categoryValues).toContain("game-servers");
    });

    it("should have optional order parameter", () => {
      const json = data.toJSON();
      const addSubcommand = json.options?.find(
        (opt: any) => opt.name === "add",
      );
      const orderOption = addSubcommand?.options?.find(
        (opt: any) => opt.name === "order",
      );

      expect(orderOption).toBeDefined();
      expect(orderOption?.type).toBe(4); // INTEGER type
      expect(orderOption?.required).toBe(false);
      expect(orderOption?.min_value).toBe(0);
    });
  });

  describe("edit subcommand parameters", () => {
    it("should have id parameter", () => {
      const json = data.toJSON();
      const editSubcommand = json.options?.find(
        (opt: any) => opt.name === "edit",
      );
      const idOption = editSubcommand?.options?.find(
        (opt: any) => opt.name === "id",
      );

      expect(idOption).toBeDefined();
      expect(idOption?.type).toBe(3);
      expect(idOption?.required).toBe(true);
      expect(idOption?.description).toContain("footer");
    });

    it("should have optional parameters", () => {
      const json = data.toJSON();
      const editSubcommand = json.options?.find(
        (opt: any) => opt.name === "edit",
      );

      const titleOption = editSubcommand?.options?.find(
        (opt: any) => opt.name === "title",
      );
      const contentOption = editSubcommand?.options?.find(
        (opt: any) => opt.name === "content",
      );
      const categoryOption = editSubcommand?.options?.find(
        (opt: any) => opt.name === "category",
      );
      const orderOption = editSubcommand?.options?.find(
        (opt: any) => opt.name === "order",
      );

      expect(titleOption?.required).toBe(false);
      expect(contentOption?.required).toBe(false);
      expect(categoryOption?.required).toBe(false);
      expect(orderOption?.required).toBe(false);
    });
  });

  describe("delete subcommand parameters", () => {
    it("should have id parameter", () => {
      const json = data.toJSON();
      const deleteSubcommand = json.options?.find(
        (opt: any) => opt.name === "delete",
      );
      const idOption = deleteSubcommand?.options?.find(
        (opt: any) => opt.name === "id",
      );

      expect(idOption).toBeDefined();
      expect(idOption?.type).toBe(3);
      expect(idOption?.required).toBe(true);
      expect(idOption?.description).toContain("footer");
    });
  });
});
