import { describe, it, expect } from "@jest/globals";
import { DiscordAPIError, RateLimitError } from "discord.js";
import {
  CHANNEL_RENAME_LIMIT,
  CHANNEL_RENAME_WINDOW_MS,
  ChannelRenameQueue,
  describeRetryIn,
  rateLimitWait,
} from "../../src/services/event-rename-queue.js";

function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

const CH = "200000000000000001";

function rateLimited(timeToReset = 90_000): RateLimitError {
  return new RateLimitError({
    timeToReset,
    limit: 2,
    method: "PATCH",
    hash: "h",
    url: "u",
    route: "/channels/:id",
    majorParameter: CH,
    global: false,
    retryAfter: timeToReset,
    sublimitTimeout: 0,
    scope: "user",
  } as never);
}

describe("ChannelRenameQueue (#1196)", () => {
  it("allows two renames per window and refuses the third with the time left", async () => {
    const c = clock();
    const q = new ChannelRenameQueue({ now: c.now });
    let sent = 0;
    const job = async (): Promise<void> => void sent++;
    expect((await q.run(CH, job)).status).toBe("done");
    c.advance(60_000);
    expect((await q.run(CH, job)).status).toBe("done");
    c.advance(60_000);
    const third = await q.run(CH, job);
    expect(third.status).toBe("limited");
    // The first rename ages out 10 minutes after it was sent: 8 minutes left.
    if (third.status === "limited") {
      expect(third.retryAfterMs).toBe(CHANNEL_RENAME_WINDOW_MS - 120_000);
    }
    expect(sent).toBe(2);
    // Never slept: the refusal came back at once, and nothing was sent.
    c.advance(CHANNEL_RENAME_WINDOW_MS - 120_000);
    expect((await q.run(CH, job)).status).toBe("done");
    expect(sent).toBe(3);
  });

  it("budgets each channel on its own", async () => {
    const q = new ChannelRenameQueue({ now: clock().now });
    for (let i = 0; i < CHANNEL_RENAME_LIMIT; i++)
      await q.run(CH, async () => 1);
    expect((await q.run(CH, async () => 1)).status).toBe("limited");
    expect((await q.run("200000000000000002", async () => 1)).status).toBe(
      "done",
    );
  });

  it("check() takes nothing; reserve() takes a slot in the same step", () => {
    const q = new ChannelRenameQueue({ now: clock().now });
    for (let i = 0; i < 5; i++) expect(q.check(CH).ok).toBe(true);
    expect(q.reserve(CH).ok).toBe(true);
    expect(q.reserve(CH).ok).toBe(true);
    expect(q.check(CH).ok).toBe(false);
    expect(q.reserve(CH).ok).toBe(false);
  });

  it("a failed request with an unknown outcome keeps its slot", async () => {
    const q = new ChannelRenameQueue({ now: clock().now });
    const r = await q.run(CH, async () => {
      throw new Error("Discord API timeout");
    });
    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.rateLimited).toBe(false);
    await q.run(CH, async () => 1);
    expect((await q.run(CH, async () => 1)).status).toBe("limited");
  });

  it("a rate-limit rejection gives the slot back and blocks the channel until Discord's reset", async () => {
    const c = clock();
    const q = new ChannelRenameQueue({ now: c.now });
    const r = await q.run(CH, async () => {
      throw new Error("wrapped", { cause: rateLimited(90_000) });
    });
    expect(r.status).toBe("failed");
    if (r.status === "failed") {
      expect(r.rateLimited).toBe(true);
      expect(r.retryAfterMs).toBe(90_000);
    }
    // The local count said there was room, Discord said wait: believe Discord.
    const blocked = q.check(CH);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.retryAfterMs).toBe(90_000);
    c.advance(90_000);
    expect(q.check(CH).ok).toBe(true);
    // The rejected request was never sent, so it did not use the budget.
    expect((await q.run(CH, async () => 1)).status).toBe("done");
    expect((await q.run(CH, async () => 1)).status).toBe("done");
    expect((await q.run(CH, async () => 1)).status).toBe("limited");
  });

  it("runs the renames of one channel one at a time, in order", async () => {
    const q = new ChannelRenameQueue({ now: clock().now, limit: 10 });
    const log: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const a = q.run(CH, async () => {
      log.push("a:start");
      await gate;
      log.push("a:end");
    });
    const b = q.run(CH, async () => {
      log.push("b:start");
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(log).toEqual(["a:start"]);
    release();
    await Promise.all([a, b]);
    expect(log).toEqual(["a:start", "a:end", "b:start"]);
  });

  it("forget() drops a channel's budget and block", async () => {
    const q = new ChannelRenameQueue({ now: clock().now });
    await q.run(CH, async () => 1);
    await q.run(CH, async () => 1);
    q.noteRateLimited(CH, 60_000);
    expect(q.check(CH).ok).toBe(false);
    q.forget(CH);
    expect(q.check(CH).ok).toBe(true);
  });

  it("describes a wait in words", () => {
    expect(describeRetryIn(500)).toBe("about 1 second");
    expect(describeRetryIn(40_000)).toBe("about 40 seconds");
    expect(describeRetryIn(60_000)).toBe("about 1 minute");
    expect(describeRetryIn(7 * 60_000 - 1)).toBe("about 7 minutes");
  });

  it("rateLimitWait reads a RateLimitError, wrapped or not, and nothing else", () => {
    expect(rateLimitWait(rateLimited(30_000))).toBe(30_000);
    expect(rateLimitWait(new Error("x", { cause: rateLimited(5_000) }))).toBe(
      5_000,
    );
    expect(rateLimitWait(new Error("boom"))).toBeNull();
    expect(rateLimitWait(null)).toBeNull();
  });
});

describe("a 429 answered by Discord with retry_after (#1196)", () => {
  it("is believed in seconds, with five seconds only as the fallback", () => {
    const make = (raw: unknown): DiscordAPIError =>
      new DiscordAPIError(raw as never, 0, 429, "PATCH", "/", {});
    const body = (extra: object) => ({ code: 0, message: "x", ...extra });
    expect(rateLimitWait(make(body({ retry_after: 30 })))).toBe(30_000);
    expect(rateLimitWait(make(body({ retry_after: 0.5 })))).toBe(500);
    expect(rateLimitWait(make(body({})))).toBe(5000);
    expect(
      rateLimitWait(new Error("w", { cause: make(body({ retry_after: 12 })) })),
    ).toBe(12_000);
  });
});
