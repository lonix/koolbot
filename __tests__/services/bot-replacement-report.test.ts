import { describe, it, expect } from "@jest/globals";
import {
  buildBotReplacementReport,
  summariseCapabilities,
} from "../../src/services/bot-replacement-report.js";
import type { KnownBot } from "../../src/content/known-bots.js";
import type { ServerScan } from "../../src/services/server-scan-service.js";

const catalog: KnownBot[] = [
  {
    key: "roler",
    name: "Roler",
    description: "Roles",
    ids: ["100000000000000001"],
    capabilities: [
      {
        id: "reaction-roles",
        label: "Reaction roles",
        feature: "reactionroles",
        coverage: { level: "full" },
      },
    ],
  },
  {
    key: "modder",
    name: "Modder",
    description: "Moderation",
    ids: ["100000000000000002"],
    capabilities: [
      {
        id: "moderation",
        label: "Moderation",
        feature: "moderation",
        coverage: { level: "partial", missing: "auto-mod" },
      },
      {
        id: "event-log",
        label: "Log",
        coverage: { level: "planned", issue: 1027 },
      },
      { id: "auto-mod", label: "Auto-mod", coverage: { level: "none" } },
    ],
  },
  {
    key: "modder2",
    name: "Modder Two",
    description: "Moderation too",
    ids: ["100000000000000003"],
    capabilities: [
      {
        id: "moderation",
        label: "Moderation",
        feature: "moderation",
        coverage: { level: "partial", missing: "auto-mod" },
      },
    ],
  },
  {
    key: "tunes",
    name: "Tunes",
    description: "Music",
    ids: ["100000000000000004"],
    capabilities: [
      {
        id: "music",
        label: "Music",
        coverage: { level: "keep", reason: "policy" },
      },
    ],
  },
];

function makeScan(
  bots: Array<{
    userId: string;
    verified?: boolean | null;
    roleIds?: string[];
    overwriteChannelIds?: string[];
  }>,
  extra: Partial<ServerScan> = {},
): ServerScan {
  return {
    guildId: "g",
    guildName: "G",
    scannedAt: "",
    scanned: {} as any,
    roles: [{ id: "role-1", name: "Roler role" } as any],
    channels: [
      {
        id: "ch-log",
        name: "join-log",
        overwrites: [{ id: "100000000000000002", type: "member" }],
        usedBy: ["moderation"],
        ownerHint: {
          botId: "100000000000000002",
          botTag: "Modder#1",
          share: 0.9,
        },
      } as any,
      {
        id: "ch-other",
        name: "chat",
        overwrites: [],
        usedBy: [],
        ownerHint: null,
      } as any,
    ],
    bots: [
      {
        userId: "koolbot",
        tag: null,
        roleIds: [],
        overwriteChannelIds: [],
        verified: true,
        isKoolBot: true,
      },
      ...bots.map((b) => ({
        userId: b.userId,
        tag: `${b.userId}#0`,
        roleIds: b.roleIds ?? [],
        overwriteChannelIds: b.overwriteChannelIds ?? [],
        verified: b.verified ?? null,
        isKoolBot: false,
      })),
    ],
    readiness: { membersIntent: true } as any,
    ...extra,
  } as ServerScan;
}

describe("summariseCapabilities", () => {
  it("says fully, N of M, no overlap and keep", () => {
    expect(summariseCapabilities([{ coverage: { level: "full" } }])).toEqual({
      kind: "full",
      text: "Can fully replace",
    });
    expect(
      summariseCapabilities([
        { coverage: { level: "full" } },
        { coverage: { level: "partial", missing: "x" } },
        { coverage: { level: "none" } },
      ]).text,
    ).toBe("Can replace 2 of 3 features (1 only partly)");
    expect(
      summariseCapabilities([
        { coverage: { level: "planned", issue: 1 } },
        { coverage: { level: "none" } },
      ]),
    ).toEqual({ kind: "none", text: "No overlap" });
    expect(
      summariseCapabilities([{ coverage: { level: "keep", reason: "r" } }])
        .kind,
    ).toBe("keep");
  });

  it("does not treat a mixed keep+full bot as fully replaceable", () => {
    expect(
      summariseCapabilities([
        { coverage: { level: "full" } },
        { coverage: { level: "keep", reason: "r" } },
      ]),
    ).toEqual({ kind: "partial", text: "Can replace 1 of 2 features" });
    expect(
      summariseCapabilities([
        { coverage: { level: "none" } },
        { coverage: { level: "keep", reason: "r" } },
      ]).kind,
    ).toBe("none");
  });

  it("still calls an all-full bot fully replaceable when nothing is kept", () => {
    expect(
      summariseCapabilities([
        { coverage: { level: "full" } },
        { coverage: { level: "full" } },
      ]).kind,
    ).toBe("full");
  });
});

describe("mixed keep bots in the report (#1026)", () => {
  const mixed: KnownBot[] = [
    {
      key: "mix",
      name: "Mix",
      description: "d",
      ids: ["100000000000000009"],
      verifiedAgainst: "Discord app directory, 2026-10-12",
      capabilities: [
        {
          id: "reaction-roles",
          label: "Roles",
          feature: "reactionroles",
          coverage: { level: "full" },
        },
        {
          id: "music",
          label: "Music",
          coverage: { level: "keep", reason: "policy" },
        },
      ],
    },
  ];
  it("never lists it as removable after the switch", () => {
    const report = buildBotReplacementReport(
      makeScan([{ userId: "100000000000000009" }]),
      {},
      mixed,
    );
    expect(report.cards[0]!.summaryKind).toBe("partial");
    expect(report.combined.removableAfterSwitch).toEqual([]);
    expect(report.combined.headline).toContain("None can be removed outright");
  });
  it("carries verifiedAgainst, and null when the entry has none", () => {
    const verified = buildBotReplacementReport(
      makeScan([{ userId: "100000000000000009" }]),
      {},
      mixed,
    );
    expect(verified.cards[0]!.verifiedAgainst).toBe(
      "Discord app directory, 2026-10-12",
    );
    const unverified = buildBotReplacementReport(
      makeScan([{ userId: "100000000000000001" }]),
      {},
      catalog,
    );
    expect(unverified.cards[0]!.verifiedAgainst).toBeNull();
  });
});

describe("buildBotReplacementReport (#1026)", () => {
  it("classifies catalogued, custom and unknown bots and never claims for the last two", () => {
    const report = buildBotReplacementReport(
      makeScan([
        { userId: "100000000000000001" },
        { userId: "200000000000000001", verified: false },
        { userId: "200000000000000002", verified: true },
        { userId: "200000000000000003", verified: null },
      ]),
      {},
      catalog,
    );
    const kinds = report.cards.map((c) => c.kind);
    expect(kinds).toEqual(["catalogued", "custom", "unknown", "unknown"]);
    expect(report.cards[1]!.summary).toContain("Community-built bot");
    expect(report.cards[1]!.capabilities).toEqual([]);
    expect(report.cards[2]!.summary).toContain("no claims");
    expect(report.cards.some((c) => c.userId === "koolbot")).toBe(false);
  });

  it("reports enabled state from config and attaches steps only to covered capabilities", () => {
    const off = buildBotReplacementReport(
      makeScan([{ userId: "100000000000000002" }]),
      {},
      catalog,
    );
    const on = buildBotReplacementReport(
      makeScan([{ userId: "100000000000000002" }]),
      { "moderation.enabled": true },
      catalog,
    );
    const mod = (r: typeof off) =>
      r.cards[0]!.capabilities.find((c) => c.id === "moderation")!;
    expect(mod(off).enabled).toBe(false);
    expect(mod(on).enabled).toBe(true);
    expect(mod(on).steps.length).toBeGreaterThan(0);
    const planned = on.cards[0]!.capabilities.find(
      (c) => c.id === "event-log",
    )!;
    expect(planned.enabled).toBeNull();
    expect(planned.steps).toEqual([]);
  });

  it("lists leftovers: owned channels, member overwrites, bound features, locked role", () => {
    const report = buildBotReplacementReport(
      makeScan([
        {
          userId: "100000000000000002",
          roleIds: ["role-1"],
          overwriteChannelIds: ["ch-log"],
        },
      ]),
      {},
      catalog,
    );
    const card = report.cards[0]!;
    expect(card.roleNames).toEqual(["Roler role"]);
    expect(card.leftovers.ownedChannels.map((c) => c.name)).toEqual([
      "join-log",
    ]);
    expect(card.leftovers.memberOverwriteChannels.map((c) => c.name)).toEqual([
      "join-log",
    ]);
    expect(card.leftovers.boundFeatures).toEqual([
      { channel: "join-log", features: ["moderation"] },
    ]);
  });

  it("builds the combined view: duplicates, removable bots, uncovered", () => {
    const report = buildBotReplacementReport(
      makeScan([
        { userId: "100000000000000001" },
        { userId: "100000000000000002" },
        { userId: "100000000000000003" },
        { userId: "100000000000000004" },
      ]),
      {},
      catalog,
    );
    const c = report.combined;
    expect(c.removableAfterSwitch).toEqual(["Roler"]);
    expect(c.headline).toContain(
      "After the switch you could consider removing: Roler",
    );
    const dup = c.duplicated.find((d) => d.id === "moderation")!;
    expect(dup.bots).toEqual(["Modder", "Modder Two"]);
    expect(c.covered.map((x) => x.id).sort()).toEqual([
      "moderation",
      "reaction-roles",
    ]);
    expect(c.uncovered.map((x) => x.id).sort()).toEqual([
      "auto-mod",
      "event-log",
      "music",
    ]);
  });

  it("handles nothing to replace and lists what KoolBot adds", () => {
    const report = buildBotReplacementReport(
      makeScan([{ userId: "200000000000000001", verified: false }]),
      { "polls.enabled": true },
      catalog,
    );
    expect(report.combined.headline).toMatch(
      /^No overlapping bots found\. KoolBot adds: /,
    );
    expect(report.combined.koolbotAdds).not.toContain("Polls");
    expect(report.combined.koolbotAdds).toContain("Temporary voice channels");
  });

  it("does not claim overlap for keep-only bots", () => {
    const report = buildBotReplacementReport(
      makeScan([{ userId: "100000000000000004" }]),
      {},
      catalog,
    );
    expect(report.cards[0]!.summaryKind).toBe("keep");
    expect(report.combined.headline).toContain("No overlapping bots found");
  });

  it("warns when the GuildMembers intent is off", () => {
    const report = buildBotReplacementReport(
      makeScan([], { readiness: { membersIntent: false } as any }),
      {},
      catalog,
    );
    expect(report.warnings[0]).toContain("GuildMembers intent is off");
  });
});
