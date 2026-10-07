import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import {
  MessageFlags,
  type ChatInputCommandInteraction,
  type EmbedBuilder,
} from "discord.js";

const mockIsEnabled = jest.fn<() => Promise<boolean>>();
const mockCountHistory = jest.fn<() => Promise<number>>();
const mockGetHistory = jest.fn<() => Promise<unknown[]>>();

jest.unstable_mockModule("../../src/services/moderation-service.js", () => ({
  ModerationService: {
    getInstance: jest.fn(() => ({
      isEnabled: mockIsEnabled,
      countHistory: mockCountHistory,
      getHistory: mockGetHistory,
    })),
  },
}));

// Case lines (#908) come from the case service, off unless a test opts in.
const mockCasesEnabled = jest.fn<() => Promise<boolean>>();
const mockGetCasesForEntries =
  jest.fn<(guildId: string, ids: unknown[]) => Promise<Map<string, unknown>>>();

jest.unstable_mockModule(
  "../../src/services/moderation-case-service.js",
  () => ({
    ModerationCaseService: {
      getInstance: jest.fn(() => ({
        isEnabled: mockCasesEnabled,
        getCasesForEntries: mockGetCasesForEntries,
      })),
    },
  }),
);

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { data, execute, PAGE_SIZE, MAX_REASON_DISPLAY_LENGTH } =
  await import("../../src/commands/modlog.js");

function makeInteraction(
  page: number | null = null,
  guildId: string | null = "guild-1",
) {
  const reply = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const deferReply = jest
    .fn<() => Promise<void>>()
    .mockResolvedValue(undefined);
  const editReply = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const interaction = {
    id: "interaction-1",
    client: {},
    guildId,
    user: { id: "mod-1" },
    replied: false,
    deferred: false,
    options: {
      getUser: () => ({
        id: "target-1",
        tag: "target#0001",
        displayAvatarURL: () => "https://cdn.example/avatar.png",
      }),
      getInteger: () => page,
    },
    reply,
    deferReply,
    editReply,
  };
  return {
    interaction: interaction as unknown as ChatInputCommandInteraction,
    reply,
    deferReply,
    editReply,
  };
}

// The handler defers first (#842), so the rendered embed arrives via editReply.
function embedDescription(editReply: jest.Mock): string {
  const payload = editReply.mock.calls[0][0] as { embeds: EmbedBuilder[] };
  return payload.embeds[0].data.description ?? "";
}

beforeEach(() => {
  mockCasesEnabled.mockReset().mockResolvedValue(false);
  mockGetCasesForEntries.mockReset().mockResolvedValue(new Map());
});

describe("Modlog Command", () => {
  it("has the correct command name", () => {
    expect(data.name).toBe("modlog");
  });

  it("has a description", () => {
    expect(data.description.length).toBeGreaterThan(0);
  });

  it("requires a user option and an optional page option", () => {
    const json = data.toJSON();
    expect(json.options?.[0]).toMatchObject({
      name: "user",
      type: 6, // User
      required: true,
    });
    expect(json.options?.[1]).toMatchObject({
      name: "page",
      type: 4, // Integer
    });
    expect(json.options?.[1]?.required ?? false).toBe(false);
  });

  it("defaults to the Moderate Members permission", () => {
    const json = data.toJSON();
    expect(json.default_member_permissions).toBe((1n << 40n).toString());
  });

  // #840: a page of 10 entries each carrying a 512-char reason overflows the
  // 4096-char embed description, so the whole reply failed on guilds with
  // verbose moderators.
  describe("payload limit (#840)", () => {
    beforeEach(() => {
      mockIsEnabled.mockReset().mockResolvedValue(true);
      mockCountHistory.mockReset();
      mockGetHistory.mockReset();
    });

    const worstCaseEntries = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        guildId: "guild-1",
        userId: "target-1",
        // The longest action label plus a full-width snowflake moderator id.
        moderatorId: "123456789012345678",
        action: "untimeout",
        // /warn stores reasons of up to 512 characters.
        reason: `${String(i).padStart(3, "0")} ${"r".repeat(508)}`,
        source: "command",
        createdAt: new Date(2026, 0, 1 + i),
      }));

    it("keeps a full page of maximum-length reasons within 4096 characters", async () => {
      mockCountHistory.mockResolvedValue(PAGE_SIZE * 3);
      mockGetHistory.mockResolvedValue(worstCaseEntries(PAGE_SIZE));
      const { interaction, editReply } = makeInteraction(1);

      await execute(interaction);

      expect(editReply).toHaveBeenCalledTimes(1);
      const description = embedDescription(editReply);
      expect(description.length).toBeLessThanOrEqual(4096);
      // Every entry on the page is still shown: pagination stays honest.
      expect(description.match(/Timeout lifted/g)).toHaveLength(PAGE_SIZE);
      expect(description).not.toContain("more on this page");
    });

    it("shortens each over-long reason to the display cap", async () => {
      mockCountHistory.mockResolvedValue(1);
      mockGetHistory.mockResolvedValue(worstCaseEntries(1));
      const { interaction, editReply } = makeInteraction();

      await execute(interaction);

      const description = embedDescription(editReply);
      const quoted = description.split("\n> ")[1];
      expect(quoted.length).toBe(MAX_REASON_DISPLAY_LENGTH);
      expect(quoted.endsWith("…")).toBe(true);
      expect(quoted.startsWith("000 rrr")).toBe(true);
    });

    it("leaves short reasons untouched", async () => {
      mockCountHistory.mockResolvedValue(1);
      mockGetHistory.mockResolvedValue([
        { ...worstCaseEntries(1)[0], action: "warn", reason: "Spamming" },
      ]);
      const { interaction, editReply } = makeInteraction();

      await execute(interaction);

      expect(embedDescription(editReply)).toContain("\n> Spamming");
    });
  });

  // #908: a kick or ban that has a case shows its state under the entry.
  describe("case lines (#908)", () => {
    const at = new Date("2026-03-12T00:00:00Z");
    const ts = Math.floor(at.getTime() / 1000);

    const removal = (
      id: string,
      action: "kick" | "ban" = "kick",
      reason = "spam",
    ) => ({
      _id: id,
      guildId: "guild-1",
      userId: "target-1",
      moderatorId: "123456789012345678",
      action,
      reason,
      source: "audit",
      createdAt: new Date("2026-01-12T00:00:00Z"),
    });

    const withCases = (cases: Record<string, unknown>) => {
      mockCasesEnabled.mockResolvedValue(true);
      mockGetCasesForEntries.mockResolvedValue(new Map(Object.entries(cases)));
    };

    beforeEach(() => {
      mockIsEnabled.mockReset().mockResolvedValue(true);
      mockCountHistory.mockReset().mockResolvedValue(1);
      mockGetHistory.mockReset();
    });

    it.each([
      [
        "an open case with a review date",
        { status: "open", reviewAt: at, events: [] },
        `Case #14 — open, review <t:${ts}:D>`,
      ],
      [
        "an open case without one",
        { status: "open", reviewAt: null, events: [] },
        "Case #14 — open, no review date",
      ],
      [
        "a case under review",
        { status: "under_review", reviewAt: at, events: [] },
        `Case #14 — under review, due <t:${ts}:D>`,
      ],
      [
        "a readmitted case, naming who decided",
        {
          status: "lifted",
          reviewAt: null,
          events: [{ at, byUserId: "staff-9" }],
        },
        `Case #14 — readmitted <t:${ts}:D> by <@staff-9>`,
      ],
      [
        "a permanent case",
        {
          status: "upheld",
          reviewAt: null,
          events: [{ at, byUserId: "staff-9" }],
        },
        `Case #14 — made permanent <t:${ts}:D> by <@staff-9>`,
      ],
      [
        "an expired case",
        { status: "expired", reviewAt: null, events: [] },
        "Case #14 — expired",
      ],
    ])("shows %s", async (_label, caseDoc, expected) => {
      mockGetHistory.mockResolvedValue([removal("e1")]);
      withCases({ e1: { caseNumber: 14, ...caseDoc } });
      const { interaction, editReply } = makeInteraction();

      await execute(interaction);

      expect(embedDescription(editReply)).toContain(`\n${expected}`);
    });

    it("looks cases up once for the page, keyed on the page's entry ids", async () => {
      mockGetHistory.mockResolvedValue([removal("e1"), removal("e2", "ban")]);
      withCases({});
      const { interaction } = makeInteraction();

      await execute(interaction);

      expect(mockGetCasesForEntries).toHaveBeenCalledTimes(1);
      expect(mockGetCasesForEntries).toHaveBeenCalledWith("guild-1", [
        "e1",
        "e2",
      ]);
    });

    it("leaves entries without a case, and every entry when cases are off, unchanged", async () => {
      mockGetHistory.mockResolvedValue([removal("e1")]);
      withCases({});
      const first = makeInteraction();
      await execute(first.interaction);
      expect(embedDescription(first.editReply)).not.toContain("Case #");

      mockCasesEnabled.mockResolvedValue(false);
      mockGetCasesForEntries.mockClear();
      await execute(makeInteraction().interaction);
      expect(mockGetCasesForEntries).not.toHaveBeenCalled();
    });

    it("still shows the history when the case lookup fails", async () => {
      mockGetHistory.mockResolvedValue([removal("e1")]);
      mockCasesEnabled.mockResolvedValue(true);
      mockGetCasesForEntries.mockRejectedValue(new Error("mongo down"));
      const { interaction, editReply } = makeInteraction();

      await execute(interaction);

      expect(embedDescription(editReply)).toContain("Kick");
    });

    it("keeps a full page of maximal reasons plus case lines within 4096 characters", async () => {
      const entries = Array.from({ length: PAGE_SIZE }, (_, i) =>
        removal(
          `e${i}`,
          "ban",
          `${String(i).padStart(3, "0")} ${"r".repeat(508)}`,
        ),
      );
      mockCountHistory.mockResolvedValue(PAGE_SIZE);
      mockGetHistory.mockResolvedValue(entries);
      withCases(
        Object.fromEntries(
          entries.map((e) => [
            e._id,
            {
              caseNumber: 1000,
              status: "lifted",
              reviewAt: null,
              events: [{ at, byUserId: "123456789012345678" }],
            },
          ]),
        ),
      );
      const { interaction, editReply } = makeInteraction();

      await execute(interaction);

      const description = embedDescription(editReply);
      expect(description.length).toBeLessThanOrEqual(4096);
      // Whatever is shown is shown whole, and anything dropped is said so.
      const shown = description.match(/Case #1000/g)?.length ?? 0;
      expect(shown).toBeGreaterThan(0);
      if (shown < PAGE_SIZE) expect(description).toContain("more on this page");
    });
  });

  // The history count + page query are DB round trips; the handler must
  // acknowledge (ephemerally — visibility is fixed at the first ACK) before
  // them so a slow query cannot miss Discord's 3-second window (#842).
  describe("interaction acknowledgement (#842)", () => {
    beforeEach(() => {
      mockIsEnabled.mockReset().mockResolvedValue(true);
      mockCountHistory.mockReset().mockResolvedValue(0);
      mockGetHistory.mockReset().mockResolvedValue([]);
    });

    it("defers ephemerally before any DB work, then edits the reply", async () => {
      const order: string[] = [];
      const { interaction, reply, deferReply, editReply } = makeInteraction();
      deferReply.mockImplementation(async () => {
        order.push("defer");
      });
      mockIsEnabled.mockImplementation(async () => {
        order.push("isEnabled");
        return true;
      });
      mockCountHistory.mockImplementation(async () => {
        order.push("count");
        return 1;
      });
      mockGetHistory.mockResolvedValue([
        {
          action: "warn",
          createdAt: new Date("2026-01-01T00:00:00Z"),
          moderatorId: "mod-1",
          reason: "spam",
        },
      ]);

      await execute(interaction);

      expect(order).toEqual(["defer", "isEnabled", "count"]);
      expect(deferReply).toHaveBeenCalledWith({
        flags: MessageFlags.Ephemeral,
      });
      expect(reply).not.toHaveBeenCalled();
      expect(editReply).toHaveBeenCalledTimes(1);
      const payload = editReply.mock.calls[0][0] as { embeds: unknown[] };
      expect(payload.embeds).toHaveLength(1);
      // Ephemerality is set on the deferral; editReply must not repeat it.
      expect(payload).not.toHaveProperty("flags");
    });

    it("edits the deferred reply when the member has no history", async () => {
      const { interaction, deferReply, editReply } = makeInteraction();

      await execute(interaction);

      expect(deferReply).toHaveBeenCalledTimes(1);
      expect(editReply).toHaveBeenCalledWith({
        content: "**target#0001** has no moderation history.",
      });
    });

    it("edits the deferred reply when the moderation log is disabled", async () => {
      mockIsEnabled.mockResolvedValue(false);
      const { interaction, deferReply, editReply } = makeInteraction();

      await execute(interaction);

      expect(deferReply).toHaveBeenCalledWith({
        flags: MessageFlags.Ephemeral,
      });
      expect(mockCountHistory).not.toHaveBeenCalled();
      expect(editReply).toHaveBeenCalledWith({
        content: "The moderation log is currently disabled.",
      });
    });

    it("replies directly, without deferring, outside a guild", async () => {
      const { interaction, reply, deferReply } = makeInteraction(null, null);

      await execute(interaction);

      expect(deferReply).not.toHaveBeenCalled();
      expect(reply).toHaveBeenCalledWith(
        expect.objectContaining({ flags: MessageFlags.Ephemeral }),
      );
    });

    it("delivers the error message via editReply once deferred", async () => {
      mockCountHistory.mockRejectedValue(new Error("boom"));
      const { interaction, reply, deferReply, editReply } = makeInteraction();
      deferReply.mockImplementation(async () => {
        (interaction as { deferred: boolean }).deferred = true;
      });

      await execute(interaction);

      expect(reply).not.toHaveBeenCalled();
      expect(editReply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "There was an error fetching the moderation history.",
        }),
      );
    });
  });
});
