import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { MessageFlags, PermissionFlagsBits } from "discord.js";

const mockGetBoolean = jest.fn<() => Promise<boolean>>();
const mockGetString = jest.fn<() => Promise<string>>();
const mockGetNumber =
  jest.fn<(key: string, fallback: number) => Promise<number>>();
const mockFindOne = jest.fn();
const mockFind = jest.fn();

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: jest.fn(() => ({
      getBoolean: mockGetBoolean,
      getString: mockGetString,
      getNumber: mockGetNumber,
    })),
  },
}));

jest.unstable_mockModule("../../src/models/reaction-role-config.js", () => ({
  ReactionRoleConfig: {
    findOne: mockFindOne,
    find: mockFind,
  },
  REACTION_ROLE_STYLES: ["reaction", "button", "select"],
  REACTION_ROLE_MODES: ["toggle", "sticky", "unique"],
}));

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  // reaction-role-service now transitively imports CommandManager, which pulls
  // in the named `isDebugMode` export — the native ESM mock must provide it.
  isDebugMode: jest.fn(() => false),
}));

const { ReactionRoleService } =
  await import("../../src/services/reaction-role-service.js");
const { resetMemberCooldowns } =
  await import("../../src/utils/member-cooldown.js");

/**
 * Build a member whose role membership is backed by a real Set, so
 * add/remove mutate the same state the handler reads back.
 */
function createMember(userId: string, roleIds: string[] = []): any {
  const roles = new Set(roleIds);
  return {
    id: userId,
    guild: { id: "guild1" },
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
  const g: any = {
    members: { fetch: jest.fn(async () => member) },
    roles: {
      cache: { get: (id: string) => roleCache.get(id) },
      fetch: jest.fn(async (id: string) => roleCache.get(id) ?? null),
    },
  };
  member.guild = g; // a real GuildMember points back at its guild
  return g;
}

describe("ReactionRoleService component interactions", () => {
  let service: InstanceType<typeof ReactionRoleService>;
  let mockClient: any;
  let guild: any;

  beforeEach(() => {
    jest.clearAllMocks();
    resetMemberCooldowns();
    mockGetBoolean.mockResolvedValue(true);
    mockGetString.mockResolvedValue("reaction");
    // Defaults: 10 flips per 30 seconds.
    mockGetNumber.mockImplementation(async (key) =>
      key === "reactionroles.max_toggles" ? 10 : 30,
    );

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
          content: expect.stringContaining("You now have <@&role1>"),
          flags: MessageFlags.Ephemeral,
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
          content: expect.stringContaining("Removed <@&role1>"),
          flags: MessageFlags.Ephemeral,
        }),
      );
    });

    it("stops a member flipping a role over and over, with a short ephemeral reply (#1147)", async () => {
      mockGetNumber.mockImplementation(async (key) =>
        key === "reactionroles.max_toggles" ? 3 : 30,
      );
      const member = createMember("user1", []);
      guild = createGuild(member, { role1: "Gamer" });
      mockFindOne.mockResolvedValue({ roleId: "role1", roleName: "Gamer" });

      const replies: string[] = [];
      for (let i = 0; i < 5; i++) {
        const interaction = buildInteraction();
        await service.handleButtonInteraction(interaction);
        replies.push(
          (interaction.reply.mock.calls[0][0] as { content: string }).content,
        );
      }

      // Three flips go through (add, remove, add); the rest are refused.
      expect(member.roles.add).toHaveBeenCalledTimes(2);
      expect(member.roles.remove).toHaveBeenCalledTimes(1);
      expect(replies[3]).toMatch(/too quickly.*wait \d+ seconds?/i);
      expect(replies[4]).toMatch(/too quickly/i);
    });

    it("refuses a button for a role that now carries dangerous permissions, using the live role (#1145)", async () => {
      const member = createMember("user1", []);
      guild = createGuild(member, { role1: "Gamer" });
      // Stale cache says safe; the live fetch says Administrator.
      guild.roles.fetch = jest.fn(async (id: string) => ({
        id,
        name: "Gamer",
        permissions: { bitfield: PermissionFlagsBits.Administrator },
      }));
      mockFindOne.mockResolvedValue({ roleId: "role1", roleName: "Gamer" });

      const interaction = buildInteraction();
      await service.handleButtonInteraction(interaction);

      expect(member.roles.add).not.toHaveBeenCalled();
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("can't be self-assigned"),
          flags: MessageFlags.Ephemeral,
        }),
      );
    });

    it("refuses a select for such a role but still lets the member drop it", async () => {
      const member = createMember("user1", []);
      guild = createGuild(member, { role1: "Gamer" });
      guild.roles.fetch = jest.fn(async (id: string) => ({
        id,
        name: "Gamer",
        permissions: { bitfield: PermissionFlagsBits.BanMembers },
      }));
      mockFind.mockResolvedValue([{ roleId: "role1", roleName: "Gamer" }]);
      const sel = (values: string[]): any => ({
        guildId: "guild1",
        user: { id: "user1" },
        message: { id: "msg1" },
        values,
        replied: false,
        deferred: false,
        reply: jest.fn(),
        followUp: jest.fn(),
      });

      const add = sel(["role1"]);
      await service.handleSelectInteraction(add);
      expect(member.roles.add).not.toHaveBeenCalled();
      expect((add.reply.mock.calls[0][0] as any).content).toContain(
        "can't be self-assigned",
      );

      // Removing a role the member already holds is never blocked.
      const held = createMember("user1", ["role1"]);
      guild.members.fetch = jest.fn(async () => held);
      await service.handleSelectInteraction(sel([]));
      expect(held.roles.remove).toHaveBeenCalledTimes(1);
    });

    it.each([
      [
        "rejects",
        async () => {
          throw new Error("REST down");
        },
      ],
      ["returns nothing", async () => null],
    ])(
      "fails closed on button and select when the live role fetch %s",
      async (_name, fetchImpl) => {
        const member = createMember("user1", []);
        guild = createGuild(member, { role1: "Gamer" });
        guild.roles.fetch = jest.fn(fetchImpl as never);
        mockFindOne.mockResolvedValue({ roleId: "role1", roleName: "Gamer" });
        mockFind.mockResolvedValue([{ roleId: "role1", roleName: "Gamer" }]);

        const button = buildInteraction();
        await service.handleButtonInteraction(button);
        expect((button.reply.mock.calls[0][0] as any).content).toContain(
          "can't be self-assigned right now",
        );

        const select: any = {
          guildId: "guild1",
          user: { id: "user1" },
          message: { id: "msg1" },
          values: ["role1"],
          replied: false,
          deferred: false,
          reply: jest.fn(),
          followUp: jest.fn(),
        };
        await service.handleSelectInteraction(select);
        expect((select.reply.mock.calls[0][0] as any).content).toContain(
          "can't be self-assigned right now",
        );
        expect(member.roles.add).not.toHaveBeenCalled();
      },
    );

    it("stops REST role lookups after the attempt cap for a binding to a deleted role (#1147)", async () => {
      const member = createMember("user1", []);
      guild = createGuild(member, {});
      // The role is gone: not cached, and the fallback fetch finds nothing.
      guild.roles.fetch = jest.fn(async () => null);
      mockFindOne.mockResolvedValue({ roleId: "role1", roleName: "Gone" });

      const replies: string[] = [];
      for (let i = 0; i < 40; i++) {
        const interaction = buildInteraction();
        await service.handleButtonInteraction(interaction);
        replies.push(
          (interaction.reply.mock.calls[0][0] as { content: string }).content,
        );
      }

      expect((guild.roles.fetch as jest.Mock).mock.calls.length).toBe(30);
      expect(replies[0]).toContain("no longer exists");
      expect(replies[39]).toContain("too quickly");
    });

    it("never limits a removal, even past the attempt cap, and a normal grant is unchanged", async () => {
      const member = createMember("user1", ["role1"]);
      guild = createGuild(member, {});
      // Not cached, but the fallback fetch finds the role.
      guild.roles.fetch = jest.fn(async (id: string) => ({
        id,
        name: "Gamer",
      }));
      mockFindOne.mockResolvedValue({ roleId: "role1", roleName: "Gamer" });
      // Exhaust the attempt budget with grant attempts by the same member.
      const other = createMember("user1", []);
      const g2 = createGuild(other, {});
      g2.roles.fetch = jest.fn(async () => null);
      guild.members.fetch = jest.fn(async () => member);
      for (let i = 0; i < 31; i++) {
        const saved = guild;
        guild = g2;
        await service.handleButtonInteraction(buildInteraction());
        guild = saved;
      }

      const removal = buildInteraction();
      await service.handleButtonInteraction(removal);
      expect(member.roles.remove).toHaveBeenCalledTimes(1);
      expect((removal.reply.mock.calls[0][0] as any).content).toContain(
        "Removed",
      );
    });

    it("charges an uncached grant attempt once, not twice (#1147)", async () => {
      // Role missing from the cache but found by the fallback fetch.
      const member = createMember("user1", []);
      guild = createGuild(member, {});
      guild.roles.fetch = jest.fn(async (id: string) => ({
        id,
        name: "Gamer",
        permissions: { bitfield: PermissionFlagsBits.Connect },
      }));
      mockFindOne.mockResolvedValue({ roleId: "role1", roleName: "Gamer" });
      // 15 attempts: charged once each that is 15 of 30; twice would be 30.
      mockGetNumber.mockImplementation(async (key) =>
        key === "reactionroles.max_toggles" ? 0 : 30,
      );
      for (let i = 0; i < 20; i++) {
        member.roles.remove.mockClear();
        await service.handleButtonInteraction(buildInteraction()); // add
        await service.handleButtonInteraction(buildInteraction()); // remove
      }
      // 20 grants went through (charged once each). Charged twice, the cap of
      // 30 would have stopped them after 15.
      expect(member.roles.add).toHaveBeenCalledTimes(20);
    });

    it("gives the flip back when the role change fails, so only real changes count (#1147)", async () => {
      mockGetNumber.mockImplementation(async (key) =>
        key === "reactionroles.max_toggles" ? 2 : 30,
      );
      const member = createMember("user1", []);
      guild = createGuild(member, { role1: "Gamer" });
      mockFindOne.mockResolvedValue({ roleId: "role1", roleName: "Gamer" });
      member.roles.add.mockRejectedValue(new Error("Missing Permissions"));

      // Three failing attempts: with the limit at 2 they would exhaust it if
      // failures counted.
      for (let i = 0; i < 3; i++) {
        await service.handleButtonInteraction(buildInteraction());
      }
      member.roles.add.mockImplementation(async (role: { id: string }) => {
        member.roles.cache.has = (id: string) => id === role.id;
      });
      const ok = buildInteraction();
      await service.handleButtonInteraction(ok);
      expect((ok.reply.mock.calls[0][0] as any).content).toContain(
        "You now have",
      );
    });

    it("still grants a safe role through the live check", async () => {
      const member = createMember("user1", []);
      guild = createGuild(member, { role1: "Gamer" });
      guild.roles.fetch = jest.fn(async (id: string) => ({
        id,
        name: "Gamer",
        permissions: { bitfield: PermissionFlagsBits.Connect },
      }));
      mockFindOne.mockResolvedValue({ roleId: "role1", roleName: "Gamer" });
      await service.handleButtonInteraction(buildInteraction());
      expect(member.roles.add).toHaveBeenCalledTimes(1);
    });

    it("does not count one member's flips against another", async () => {
      mockGetNumber.mockImplementation(async (key) =>
        key === "reactionroles.max_toggles" ? 1 : 30,
      );
      const a = createMember("user1", []);
      guild = createGuild(a, { role1: "Gamer" });
      mockFindOne.mockResolvedValue({ roleId: "role1", roleName: "Gamer" });
      await service.handleButtonInteraction(buildInteraction());

      const b = createMember("user2", []);
      guild = createGuild(b, { role1: "Gamer" });
      await service.handleButtonInteraction(
        buildInteraction({ user: { id: "user2" } }),
      );
      expect(b.roles.add).toHaveBeenCalledTimes(1);
    });

    it("applies no limit when reactionroles.max_toggles is 0", async () => {
      mockGetNumber.mockImplementation(async (key) =>
        key === "reactionroles.max_toggles" ? 0 : 30,
      );
      const member = createMember("user1", []);
      guild = createGuild(member, { role1: "Gamer" });
      mockFindOne.mockResolvedValue({ roleId: "role1", roleName: "Gamer" });
      for (let i = 0; i < 25; i++) {
        await service.handleButtonInteraction(buildInteraction());
      }
      expect(
        member.roles.add.mock.calls.length +
          member.roles.remove.mock.calls.length,
      ).toBe(25);
    });

    it("does not count a click that changes nothing", async () => {
      mockGetNumber.mockImplementation(async (key) =>
        key === "reactionroles.max_toggles" ? 1 : 30,
      );
      const member = createMember("user1", []);
      guild = createGuild(member, { role1: "Gamer" });
      mockFindOne.mockResolvedValue({ roleId: "role1", roleName: "Gamer" });
      // A select that already matches reports "No changes" and is free.
      const sel = (values: string[]): any => ({
        guildId: "guild1",
        user: { id: "user1" },
        message: { id: "msg1" },
        values,
        replied: false,
        deferred: false,
        reply: jest.fn(),
        followUp: jest.fn(),
      });
      mockFind.mockResolvedValue([{ roleId: "role1", roleName: "Gamer" }]);
      await service.handleSelectInteraction(sel([]));
      await service.handleSelectInteraction(sel([]));
      const real = sel(["role1"]);
      await service.handleSelectInteraction(real);
      expect(member.roles.add).toHaveBeenCalledTimes(1);
    });

    it("refuses when the feature is disabled", async () => {
      mockGetBoolean.mockResolvedValue(false);
      const interaction = buildInteraction();

      await service.handleButtonInteraction(interaction);

      expect(mockFindOne).not.toHaveBeenCalled();
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("disabled"),
          flags: MessageFlags.Ephemeral,
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
          flags: MessageFlags.Ephemeral,
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
        expect.objectContaining({ flags: MessageFlags.Ephemeral }),
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
          flags: MessageFlags.Ephemeral,
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

    // #1522: every picker names the feature in the footer and gives its
    // instruction in the description, never in the footer.
    it.each([
      ["button", "toggle", "Click it again to remove the role."],
      ["select", "toggle", "Deselect it to remove the role."],
      ["reaction", "toggle", "Remove your reaction to lose access."],
      ["reaction", "sticky", "Removing your reaction keeps the role."],
      ["reaction", "unique", "clears the other roles"],
    ])(
      "a %s picker in %s mode: feature footer, instruction in the description",
      (style, mode, sentence) => {
        const payload = (service as any).buildRoleMessagePayload({
          emoji: "🎮",
          roleName: "Gamer",
          roleId: "role1",
          style,
          mode,
        });
        const embed = payload.embeds[0].toJSON();
        expect(embed.footer.text).toBe("KoolBot · Reaction roles");
        expect(embed.description).toContain(sentence);
      },
    );
  });
});
