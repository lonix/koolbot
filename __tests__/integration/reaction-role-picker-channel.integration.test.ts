import { describe, it, expect, beforeAll, beforeEach } from "@jest/globals";
import { DiscordAPIError, type Client } from "discord.js";
import { describeWithMongo, useRealMongo } from "./mongo-harness.js";
import { ReactionRoleConfig } from "../../src/models/reaction-role-config.js";
import { ReactionRoleService } from "../../src/services/reaction-role-service.js";

/**
 * Each mapping remembers the channel its picker was posted in (#1207); rows
 * created before that lack the field and fall back to the configured channel.
 *
 * The unit tests mock the model, so they cannot show that the queries the
 * lifecycle paths run (`$exists`, `$in: [null, ""]`) match a row where the
 * field is absent, that Mongoose does not write the field into an old row when
 * it archives it, or that a stamped row round-trips. These run against a real
 * server. Old rows are written with the raw driver, because `Model.create`
 * would not add the field either way but `collection.insertOne` proves the
 * document really has none.
 */
describeWithMongo(
  "reaction-role picker channel against a real MongoDB (#1207)",
  () => {
    useRealMongo();

    const OLD = "100000000000000001";
    const NEW = "100000000000000002";
    const GUILD = "guild-1";

    beforeAll(async () => {
      await ReactionRoleConfig.init();
    });

    beforeEach(async () => {
      await ReactionRoleConfig.deleteMany({});
    });

    /** Insert a row without Mongoose, so an absent field stays absent. */
    async function insertRaw(fields: Record<string, unknown>) {
      const now = new Date();
      const { insertedId } = await ReactionRoleConfig.collection.insertOne({
        guildId: GUILD,
        messageId: "m-1",
        roleId: "role-1",
        emoji: "🎮",
        roleName: "Gamer",
        style: "reaction",
        autoCreated: false,
        mode: "toggle",
        isArchived: false,
        createdAt: now,
        updatedAt: now,
        ...fields,
      });
      return insertedId;
    }

    function serviceWithConfigured(configured: string) {
      const service = ReactionRoleService.getInstance({} as Client);
      (service as never)["configService"] = {
        getString: async () => configured,
        getBoolean: async () => true,
        getNumber: async () => 0,
      };
      return service;
    }

    beforeEach(() => {
      (ReactionRoleService as unknown as { instance?: unknown }).instance =
        undefined;
    });

    it("loads a row written before the field with no picker channel, and keeps it that way", async () => {
      const id = await insertRaw({});
      const raw = await ReactionRoleConfig.collection.findOne({ _id: id });
      expect(raw).not.toHaveProperty("messageChannelId");

      const loaded = await ReactionRoleConfig.findById(id);
      expect(loaded).not.toBeNull();
      expect(loaded?.messageChannelId).toBeUndefined();

      // Archiving an old row (reconcile and the delete handlers do this with
      // `save()`) must not write the field: it would pin the row to a channel
      // it was never verified in.
      if (!loaded) throw new Error("row missing");
      loaded.isArchived = true;
      loaded.archivedAt = new Date();
      await loaded.save();
      const after = await ReactionRoleConfig.collection.findOne({ _id: id });
      expect(after).toMatchObject({ isArchived: true });
      expect(after).not.toHaveProperty("messageChannelId");
    });

    it("round-trips a mapping that remembers its channel", async () => {
      const created = await ReactionRoleConfig.create({
        guildId: GUILD,
        messageId: "m-2",
        messageChannelId: OLD,
        roleId: "role-2",
        emoji: "🎨",
        roleName: "Artist",
        autoCreated: false,
      });
      const loaded = await ReactionRoleConfig.findById(created._id).lean();
      expect(loaded?.messageChannelId).toBe(OLD);
    });

    describe("handleChannelDelete", () => {
      const deleted = (id: string) => ({ id, guild: { id: GUILD } }) as never;

      async function archivedMessageIds(): Promise<string[]> {
        const rows = await ReactionRoleConfig.find({ isArchived: true }).lean();
        return rows.map((r) => r.messageId).sort();
      }

      async function seed() {
        // A picker in the old channel, one in the new, and an older row with no
        // stored channel (its picker is wherever the setting points).
        await insertRaw({
          messageId: "in-old",
          roleId: "r1",
          emoji: "1️⃣",
          messageChannelId: OLD,
        });
        await insertRaw({
          messageId: "in-new",
          roleId: "r2",
          emoji: "2️⃣",
          messageChannelId: NEW,
        });
        await insertRaw({ messageId: "legacy", roleId: "r3", emoji: "3️⃣" });
      }

      it("archives only the mappings that lived in the deleted old channel", async () => {
        await seed();
        // The setting points at the new channel now.
        await serviceWithConfigured(NEW).handleChannelDelete(deleted(OLD));
        expect(await archivedMessageIds()).toEqual(["in-old"]);
      });

      it("archives an unstamped row that shares a deleted picker with a stamped one", async () => {
        // A picker from before the field, topped up afterwards: mixed rows.
        await insertRaw({ messageId: "shared", roleId: "r1", emoji: "1️⃣" });
        await insertRaw({
          messageId: "shared",
          roleId: "r2",
          emoji: "2️⃣",
          messageChannelId: OLD,
        });
        await insertRaw({
          messageId: "other",
          roleId: "r3",
          emoji: "3️⃣",
          messageChannelId: NEW,
        });
        await serviceWithConfigured(NEW).handleChannelDelete(deleted(OLD));
        const rows = await ReactionRoleConfig.find({ isArchived: true }).lean();
        expect(rows.map((r) => r.roleId).sort()).toEqual(["r1", "r2"]);
      });

      it("archives the configured channel's own mappings and the older rows that follow the setting", async () => {
        await seed();
        await serviceWithConfigured(NEW).handleChannelDelete(deleted(NEW));
        expect(await archivedMessageIds()).toEqual(["in-new", "legacy"]);
      });

      it("leaves older rows alone when the deleted channel is not the configured one", async () => {
        await seed();
        await serviceWithConfigured(NEW).handleChannelDelete(
          deleted("100000000000000099"),
        );
        expect(await archivedMessageIds()).toEqual([]);
      });
    });

    describe("picker lookup for a row without its own channel", () => {
      // A guild whose channels resolve by id, holding one picker message in OLD.
      function guildWithPickerIn(channelId: string, messageId: string) {
        const deletedMessages: string[] = [];
        const channel = {
          id: channelId,
          isTextBased: () => true,
          messages: {
            fetch: async (id: string) => {
              if (id !== messageId) {
                throw Object.assign(Object.create(DiscordAPIError.prototype), {
                  code: 10008,
                  message: "Unknown Message",
                });
              }
              return {
                id,
                delete: async () => {
                  deletedMessages.push(id);
                },
              };
            },
          },
        };
        const guild = {
          id: GUILD,
          channels: {
            fetch: async (id: string) => {
              if (id !== channelId) {
                throw Object.assign(Object.create(DiscordAPIError.prototype), {
                  code: 10003,
                  message: "Unknown Channel",
                });
              }
              return channel;
            },
          },
        };
        return { guild, deletedMessages };
      }

      function wire(service: ReactionRoleService, guild: unknown) {
        (service as never)["client"] = {
          guilds: { fetch: async () => guild },
          user: { id: "bot" },
        };
      }

      it("deletes the picker from the channel it remembers, not the configured one", async () => {
        const id = await insertRaw({
          messageId: "picker",
          autoCreated: true,
          messageChannelId: OLD,
        });
        const { guild, deletedMessages } = guildWithPickerIn(OLD, "picker");
        const service = serviceWithConfigured(NEW);
        wire(service, guild);

        const result = await service.deleteReactionRole(GUILD, String(id));

        expect(result.success).toBe(true);
        expect(deletedMessages).toEqual(["picker"]);
        expect(await ReactionRoleConfig.countDocuments({})).toBe(0);
      });

      it("takes the channel from a sibling row on the same message when its own is absent", async () => {
        // Matched by `{ $exists: true, $ne: "" }`: the sibling carries the field,
        // this row (the one deleted) does not.
        const id = await insertRaw({
          messageId: "picker",
          roleId: "r1",
          emoji: "1️⃣",
          autoCreated: true,
        });
        await insertRaw({
          messageId: "picker",
          roleId: "r2",
          emoji: "2️⃣",
          messageChannelId: OLD,
        });
        const { guild, deletedMessages } = guildWithPickerIn(OLD, "picker");
        const service = serviceWithConfigured(NEW);
        wire(service, guild);

        const result = await service.deleteReactionRole(GUILD, String(id));

        expect(result.success).toBe(true);
        expect(deletedMessages).toEqual(["picker"]);
      });

      it("falls back to the configured channel for an older row with no sibling", async () => {
        const id = await insertRaw({ messageId: "picker", autoCreated: true });
        const { guild, deletedMessages } = guildWithPickerIn(NEW, "picker");
        const service = serviceWithConfigured(NEW);
        wire(service, guild);

        const result = await service.deleteReactionRole(GUILD, String(id));

        expect(result.success).toBe(true);
        expect(deletedMessages).toEqual(["picker"]);
      });

      it("does not treat an empty stored channel as a channel", async () => {
        const id = await insertRaw({
          messageId: "picker",
          autoCreated: true,
          messageChannelId: "",
        });
        const { guild, deletedMessages } = guildWithPickerIn(NEW, "picker");
        const service = serviceWithConfigured(NEW);
        wire(service, guild);

        await service.deleteReactionRole(GUILD, String(id));

        expect(deletedMessages).toEqual(["picker"]);
      });
    });
  },
);
