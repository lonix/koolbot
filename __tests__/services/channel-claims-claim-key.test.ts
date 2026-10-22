import { describe, it, expect } from "@jest/globals";
import {
  FEATURE_TARGETS,
  GUESS_BIND_KEYS,
  claimKeyFor,
  featureFitsChannel,
  featureTarget,
} from "../../src/services/channel-claims.js";
import { scanChannel } from "../web/channels-scan-fixtures.js";

describe("claimKeyFor (#1364)", () => {
  it("maps every guess to a real, bindable feature", () => {
    for (const key of Object.values(GUESS_BIND_KEYS)) {
      expect(featureTarget(key)).toBeDefined();
    }
  });

  it("names the feature for a text channel that looks like one", () => {
    expect(claimKeyFor(scanChannel({ id: "1", featureGuess: "quotes" }))).toBe(
      "quotes.channel_id",
    );
  });

  it("names the lobby for a voice channel and the category target for a category", () => {
    expect(
      claimKeyFor(
        scanChannel({ id: "1", kind: "voice", featureGuess: "voicechannels" }),
      ),
    ).toBe("voicechannels.lobby.channel_id");
    expect(
      claimKeyFor(
        scanChannel({ id: "1", kind: "category", featureGuess: "tickets" }),
      ),
    ).toBe("tickets.category_id");
  });

  it("gives no key without a guess, or for a guess with no single target", () => {
    expect(claimKeyFor(scanChannel({ id: "1" }))).toBeNull();
    expect(
      claimKeyFor(scanChannel({ id: "1", featureGuess: "polls" })),
    ).toBeNull();
    expect(
      claimKeyFor(scanChannel({ id: "1", featureGuess: "announcements" })),
    ).toBeNull();
  });

  it("gives no key when the target does not fit the kind of channel", () => {
    // `tickets` binds a category, never a text channel.
    expect(
      claimKeyFor(scanChannel({ id: "1", featureGuess: "tickets" })),
    ).toBeNull();
    expect(
      claimKeyFor(
        scanChannel({
          id: "1",
          kind: "voice",
          featureGuess: "voicechannels",
          flags: { stage: true },
        }),
      ),
    ).toBeNull();
    expect(
      claimKeyFor(
        scanChannel({
          id: "1",
          featureGuess: "quotes",
          flags: { forum: true },
        }),
      ),
    ).toBeNull();
  });

  it("gives no key for a channel a feature already uses", () => {
    expect(
      claimKeyFor(
        scanChannel({ id: "1", featureGuess: "quotes", usedBy: ["quotes"] }),
      ),
    ).toBeNull();
  });

  it("gives no key for the channels Discord itself uses", () => {
    for (const flag of ["rules", "system", "publicUpdates"] as const) {
      expect(
        claimKeyFor(
          scanChannel({
            id: "1",
            featureGuess: "notices",
            flags: { [flag]: true },
          }),
        ),
      ).toBeNull();
    }
  });
});

describe("featureFitsChannel", () => {
  it("fits each feature kind to one kind of channel only", () => {
    const text = scanChannel({ id: "t" });
    const voice = scanChannel({ id: "v", kind: "voice" });
    const category = scanChannel({ id: "c", kind: "category" });
    for (const target of FEATURE_TARGETS) {
      const fits = [text, voice, category].filter((c) =>
        featureFitsChannel(target, c),
      );
      expect(fits).toHaveLength(1);
    }
  });
});
