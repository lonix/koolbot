import { describe, expect, it } from "@jest/globals";
import type { Client } from "discord.js";
import {
  FALLBACK_SERVER_NAME,
  getGuildName,
} from "../../src/utils/guild-name.js";

const client = (guilds: Array<[string, { name?: string }]>): Client =>
  ({ guilds: { cache: new Map(guilds) } }) as unknown as Client;

describe("getGuildName (#1526)", () => {
  it.each([
    [
      "a cached guild",
      client([["g1", { name: "Koolbot Dev" }]]),
      "g1",
      "Koolbot Dev",
    ],
    ["a guild that is not cached", client([]), "g1", FALLBACK_SERVER_NAME],
    [
      "an unnamed guild",
      client([["g1", { name: "  " }]]),
      "g1",
      FALLBACK_SERVER_NAME,
    ],
    [
      "an empty guild id",
      client([["g1", { name: "x" }]]),
      "",
      FALLBACK_SERVER_NAME,
    ],
    [
      "a client without a guild cache",
      {} as unknown as Client,
      "g1",
      FALLBACK_SERVER_NAME,
    ],
  ])("%s", (_label, c, id, expected) => {
    expect(getGuildName(c, id)).toBe(expected);
  });

  it("falls back to the words a member reads", () => {
    expect(FALLBACK_SERVER_NAME).toBe("your server");
  });
});
