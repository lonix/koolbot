import { describe, it, expect, jest, beforeEach } from "@jest/globals";

const mockGetBoolean = jest.fn<() => Promise<boolean>>();
const mockGetString = jest.fn<() => Promise<string>>();
const mockFindOne = jest.fn();
const mockFind = jest.fn();

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: jest.fn(() => ({
      getBoolean: mockGetBoolean,
      getString: mockGetString,
    })),
  },
}));

jest.unstable_mockModule("../../src/models/reaction-role-config.js", () => ({
  ReactionRoleConfig: {
    findOne: mockFindOne,
    find: mockFind,
  },
  REACTION_ROLE_STYLES: ["reaction", "button", "select"],
}));

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { ReactionRoleService } =
  await import("../../src/services/reaction-role-service.js");

/**
 * Build a member whose role membership is backed by a real Set, so
 * add/remove mutate the same state the handler reads back.
 */
function createMember(userId: string, roleIds: string[] = []): any {
  const roles = new Set(roleIds);
  return {
    user: { id: userId, tag: `user#${userId}` },
    roles: {
      cache: {
        has: (id: string) => roles.has(id),
      },
      add: jest.fn(async (role: { id: string }) => {
        roles.add(role.id);
      }),
      remove: jest.fn(async (role: { id: string }) => {
        roles.delete(role.id);
      }),
    },
  };
}

function createGuild(member: any, roles: Record<string, string>): any {
  const roleCache = new Map(
    Object.entries(roles).map(([id, name]) => [id, { id, name }]),
  );
  return {
    members: { fetch: jest.fn(async () => member) },
    roles: {
      cache: { get: (id: string) => roleCache.get(id) },
      fetch: jest.fn(async (id: string) => roleCache.get(id) ?? null),
    },
  };
}

describe("ReactionRoleService component interactions", () => {
  let service: InstanceType<typeof ReactionRoleService>;
  let mockClient: any;
  let guild: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetBoolean.mockResolvedValue(true);
    mockGetString.mockResolvedValue("reaction");

    mockClient = {
      isReady: jest.fn().mockReturnValue(true),
      guilds: { fetch: jest.fn(async () => guild) },
      on: jest.fn(),
    };
    service = ReactionRoleService.getInstance(mockClient);
  });

  describe("handleButtonInteraction", () => {
    function buildInteraction(overrides: any = {}): any {
      return {
        customId: "reactrole:btn:role1",
        guildId: "guild1",
        user: { id: "user1" },
        message: { id: "msg1" },
        replied: false,
        deferred: false,
        reply: jest.fn(),
        followUp: jest.fn(),
        ...overrides,
      };
    }

    it("adds the role and confirms when the member lacks it", async () => {
      const member = createMember("user1", []);
      guild = createGuild(member, { role1: "Gamer" });
      mockFindOne.mockResolvedValue({ roleId: "role1", roleName: "Gamer" });

      const interaction = buildInteraction();
      await service.handleButtonInteraction(interaction);

      expect(member.roles.add).toHaveBeenCalledTimes(1);
      expect(member.roles.remove).not.toHaveBeenCalled();
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("You now have **Gamer**"),
          ephemeral: true,
        }),
      );
    });

    it("removes the role and confirms when the member already has it", async () => {
      const member = createMember("user1", ["role1"]);
      guild = createGuild(member, { role1: "Gamer" });
      mockFindOne.mockResolvedValue({ roleId: "role1", roleName: "Gamer" });

      const interaction = buildInteraction();
      await service.handleButtonInteraction(interaction);

      expect(member.roles.remove).toHaveBeenCalledTimes(1);
      expect(member.roles.add).not.toHaveBeenCalled();
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("Removed **Gamer**"),
          ephemeral: true,
        }),
      );
    });

    it("refuses when the feature is disabled", async () => {
      mockGetBoolean.mockResolvedValue(false);
      const interaction = buildInteraction();

      await service.handleButtonInteraction(interaction);

      expect(mockFindOne).not.toHaveBeenCalled();
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("disabled"),
          ephemeral: true,
        }),
      );
    });

    it("reports when the mapping no longer exists", async () => {
      guild = createGuild(createMember("user1"), {});
      mockFindOne.mockResolvedValue(null);
      const interaction = buildInteraction();

      await service.handleButtonInteraction(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("no longer available"),
          ephemeral: true,
        }),
      );
    });
  });

  describe("handleSelectInteraction", () => {
    function buildInteraction(values: string[]): any {
      return {
        customId: "reactrole:sel",
        guildId: "guild1",
        user: { id: "user1" },
        message: { id: "msg1" },
        values,
        replied: false,
        deferred: false,
        reply: jest.fn(),
        followUp: jest.fn(),
      };
    }

    it("adds a selected managed role", async () => {
      const member = createMember("user1", []);
      guild = createGuild(member, { role1: "Gamer" });
      mockFind.mockResolvedValue([{ roleId: "role1", roleName: "Gamer" }]);

      const interaction = buildInteraction(["role1"]);
      await service.handleSelectInteraction(interaction);

      expect(member.roles.add).toHaveBeenCalledTimes(1);
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ ephemeral: true }),
      );
    });

    it("removes a managed role that was deselected", async () => {
      const member = createMember("user1", ["role1"]);
      guild = createGuild(member, { role1: "Gamer" });
      mockFind.mockResolvedValue([{ roleId: "role1", roleName: "Gamer" }]);

      const interaction = buildInteraction([]);
      await service.handleSelectInteraction(interaction);

      expect(member.roles.remove).toHaveBeenCalledTimes(1);
    });

    it("reports no changes when selection matches current roles", async () => {
      const member = createMember("user1", ["role1"]);
      guild = createGuild(member, { role1: "Gamer" });
      mockFind.mockResolvedValue([{ roleId: "role1", roleName: "Gamer" }]);

      const interaction = buildInteraction(["role1"]);
      await service.handleSelectInteraction(interaction);

      expect(member.roles.add).not.toHaveBeenCalled();
      expect(member.roles.remove).not.toHaveBeenCalled();
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "No changes made.",
          ephemeral: true,
        }),
      );
    });
  });

  describe("buildRoleMessagePayload", () => {
    it("emits a button component for the button style", () => {
      const payload = (service as any).buildRoleMessagePayload({
        emoji: "🎮",
        roleName: "Gamer",
        roleId: "role1",
        style: "button",
      });
      const button = payload.components[0].components[0];
      expect(button.data.custom_id).toBe("reactrole:btn:role1");
      expect(button.data.label).toBe("Gamer");
    });

    it("emits a select menu carrying the roleId as the option value", () => {
      const payload = (service as any).buildRoleMessagePayload({
        emoji: "🎮",
        roleName: "Gamer",
        roleId: "role1",
        style: "select",
      });
      const menu = payload.components[0].components[0];
      expect(menu.data.custom_id).toBe("reactrole:sel");
      expect(menu.options[0].data.value).toBe("role1");
    });

    it("emits no components for the reaction style", () => {
      const payload = (service as any).buildRoleMessagePayload({
        emoji: "🎮",
        roleName: "Gamer",
        roleId: "role1",
        style: "reaction",
      });
      expect(payload.components).toBeUndefined();
      expect(payload.embeds).toHaveLength(1);
    });
  });
});
