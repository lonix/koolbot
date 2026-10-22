import type { ServerScan } from "../../src/services/server-scan-service.js";
import { busyScan } from "./server-scan-fixtures.js";

const NO_FLAGS = {
  afk: false,
  rules: false,
  system: false,
  publicUpdates: false,
  webhookFed: false,
  followed: false,
  announcement: false,
  forum: false,
  stage: false,
  onboardingDefault: false,
};

type Chan = ServerScan["channels"][number];

/** One scanned channel; every field a row reads has a quiet default. */
export function scanChannel(
  over: Partial<Omit<Chan, "flags">> & {
    id: string;
    flags?: Partial<Chan["flags"]>;
  },
): Chan {
  return {
    name: over.id,
    kind: "text",
    typeName: "GuildText",
    parentId: null,
    parentName: null,
    syncedToParent: null,
    position: 0,
    overwrites: [],
    usedBy: [],
    featureGuess: null,
    gatedByRoleIds: [],
    ownerHint: null,
    ...over,
    flags: { ...NO_FLAGS, ...(over.flags ?? {}) },
  };
}

/**
 * `busyScan()` with the channels as a server would have them (#1364): channels
 * outside any category, a category with text and voice channels (the voice one
 * has the lowest position and must still list last), a channel a feature uses,
 * custom permissions, a "looks like" row that can be claimed, ones that cannot
 * (no single target, a Discord community channel, a text channel for a
 * category-only feature), a category that can be claimed, and a channel whose
 * category is not in the scan. Kept apart from `busyScan()` so the other
 * Server scan fixtures do not change.
 */
export function channelsScan(): ServerScan {
  const base = busyScan();
  return {
    ...base,
    channels: [
      scanChannel({ id: "10", name: "general", position: 0 }),
      scanChannel({
        id: "11",
        name: "quote-board",
        position: 1,
        featureGuess: "quotes",
      }),
      scanChannel({
        id: "20",
        name: "Community",
        kind: "category",
        typeName: "GuildCategory",
        position: 0,
      }),
      scanChannel({
        id: "21",
        name: "lobby",
        kind: "voice",
        typeName: "GuildVoice",
        parentId: "20",
        parentName: "Community",
        syncedToParent: true,
        position: 0,
        featureGuess: "voicechannels",
      }),
      scanChannel({
        id: "22",
        name: "quotes",
        parentId: "20",
        parentName: "Community",
        syncedToParent: false,
        position: 1,
        usedBy: ["quotes"],
        overwrites: [
          {
            id: "r1",
            type: "role",
            label: "Mod",
            allow: ["ViewChannel"],
            deny: ["SendMessages"],
          },
        ],
        gatedByRoleIds: ["r1"],
      }),
      scanChannel({
        id: "23",
        name: "poll-night",
        parentId: "20",
        parentName: "Community",
        syncedToParent: true,
        position: 2,
        featureGuess: "polls",
      }),
      scanChannel({
        id: "24",
        name: "rules",
        parentId: "20",
        parentName: "Community",
        syncedToParent: true,
        position: 3,
        featureGuess: "notices",
        flags: { rules: true },
      }),
      scanChannel({
        id: "30",
        name: "Support",
        kind: "category",
        typeName: "GuildCategory",
        position: 1,
        featureGuess: "tickets",
      }),
      scanChannel({
        id: "31",
        name: "ticket-log",
        parentId: "30",
        parentName: "Support",
        syncedToParent: true,
        position: 0,
        featureGuess: "tickets",
      }),
      scanChannel({
        id: "40",
        name: "stray",
        parentId: "gone",
        parentName: null,
        position: 9,
      }),
    ],
  };
}
