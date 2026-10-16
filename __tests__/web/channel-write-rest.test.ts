/**
 * The Channel Manager's write client (#1065), driven through the real
 * @discordjs/rest request handler with a fake network, so the retry and
 * rate-limit behaviour is the library's own and not a hand-emitted event.
 */

import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { DiscordAPIError, HTTPError, RateLimitError, Routes } from "discord.js";
import {
  cancellableCall,
  createWriteRest,
  describeWriteFailure,
  rateLimitMessage,
  rateLimitWaitMs,
  RATE_LIMIT_FAST_FAIL_MS,
} from "../../src/web/channel-write-rest.js";

type Transport = (url: string, init: unknown) => Promise<Response>;

const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const abortError = (): Error =>
  Object.assign(new Error("This operation was aborted"), {
    name: "AbortError",
  });

const clientWith = (transport: Transport) =>
  createWriteRest("token", transport as never);

describe("createWriteRest: no automatic retries", () => {
  it("sends exactly one request when the response is lost (transport timeout)", async () => {
    // The shared client would re-send this up to 3 times, duplicating a create.
    const transport = jest.fn<Transport>(async () => {
      throw abortError();
    });
    await expect(
      clientWith(transport).post(Routes.guildChannels("123"), {
        body: { name: "x", type: 0 },
      }),
    ).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("sends exactly one request when the connection is reset", async () => {
    const transport = jest.fn<Transport>(async () => {
      throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    });
    await expect(
      clientWith(transport).patch(Routes.channel("123"), {
        body: { name: "x" },
      }),
    ).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("sends exactly one request on a 5xx", async () => {
    const transport = jest.fn<Transport>(async () => json(502, {}));
    await expect(
      clientWith(transport).patch(Routes.channel("123"), {
        body: { name: "x" },
      }),
    ).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("passes a successful response through", async () => {
    const transport = jest.fn<Transport>(async () =>
      json(200, { id: "1", name: "x" }),
    );
    await expect(
      clientWith(transport).patch(Routes.channel("123"), {
        body: { name: "x" },
      }),
    ).resolves.toEqual({ id: "1", name: "x" });
  });
});

describe("createWriteRest: long rate-limit waits are rejected, not queued", () => {
  // The library creates a sleep() for the wait before it decides to reject; fake
  // timers keep that 9-minute timer from holding the test process open. A
  // rejection that actually waited would leave the promise unsettled and fail.
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("rejects an actual 429 with a long retry-after at once, without waiting or retrying", async () => {
    // Discord's rename sublimit answers 429 with retry-after in the body and
    // header; the shared client would sleep for it, here we hear it at once.
    const transport = jest.fn<Transport>(async () =>
      json(
        429,
        {
          message: "You are being rate limited.",
          retry_after: 540,
          global: false,
        },
        { "Retry-After": "540", "X-RateLimit-Scope": "user" },
      ),
    );
    const error = await clientWith(transport)
      .patch(Routes.channel("123"), { body: { name: "x" } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(rateLimitWaitMs(error as RateLimitError)).toBeGreaterThanOrEqual(
      540_000,
    );
    expect(transport).toHaveBeenCalledTimes(1);
    // 540 s plus the client's 50 ms safety offset rounds up to 10 minutes.
    expect(describeWriteFailure(error)).toContain("10 minutes");
  });

  it("rejects a request whose bucket an earlier response showed to be empty, without sending it", async () => {
    // The first request only teaches the client the bucket's hash. The second
    // succeeds but uses up the bucket (remaining 0, reset in 9 minutes); the
    // third never leaves the process.
    const transport = jest.fn<Transport>(async () =>
      json(
        200,
        { id: "123" },
        {
          "X-RateLimit-Limit": "2",
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset-After": "540",
          "X-RateLimit-Bucket": "bucket-1",
        },
      ),
    );
    const rest = clientWith(transport);
    await rest.patch(Routes.channel("123"), { body: { name: "a" } });
    await rest.patch(Routes.channel("123"), { body: { name: "b" } });
    const error = await rest
      .patch(Routes.channel("123"), { body: { user_limit: 5 } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(rateLimitWaitMs(error as RateLimitError)).toBeGreaterThan(
      RATE_LIMIT_FAST_FAIL_MS,
    );
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("reports a rate limit for a different channel independently", async () => {
    const transport = jest.fn<Transport>(async (url) =>
      url.endsWith("/123")
        ? json(
            200,
            { id: "123" },
            {
              "X-RateLimit-Limit": "2",
              "X-RateLimit-Remaining": "0",
              "X-RateLimit-Reset-After": "540",
              "X-RateLimit-Bucket": "bucket-1",
            },
          )
        : json(200, { id: "456" }),
    );
    const rest = clientWith(transport);
    await rest.patch(Routes.channel("123"), { body: { name: "a" } });
    await rest.patch(Routes.channel("123"), { body: { name: "b" } });
    await expect(
      rest.patch(Routes.channel("456"), { body: { name: "b" } }),
    ).resolves.toEqual({ id: "456" });
  });
});

describe("messages", () => {
  it("words a short wait in seconds and a long one in minutes", () => {
    expect(rateLimitMessage(30_000)).toContain("30 seconds");
    expect(rateLimitMessage(60_000)).toContain("1 minute.");
    expect(rateLimitMessage(540_000)).toContain("9 minutes");
  });

  it("describes timeouts as an unknown outcome and other errors as refused", () => {
    expect(describeWriteFailure(abortError())).toContain("unknown");
    expect(
      describeWriteFailure(new Error("Discord API timeout for edit channel")),
    ).toContain("unknown whether the change was applied");
    expect(
      describeWriteFailure(
        new DiscordAPIError(
          { message: "Missing Permissions", code: 50013 },
          50013,
          403,
          "POST",
          "https://discord.com/api/v10/guilds/1/channels",
          {},
        ),
      ),
    ).toBe("Discord refused the change: Missing Permissions");
  });

  it("treats a lost connection, a 5xx and unexpected errors as an unconfirmed outcome", () => {
    // Discord may have accepted the request before the answer was lost, so
    // a retry could make a duplicate; only a 4xx answer is a definite refusal.
    for (const error of [
      Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
      new HTTPError(502, "Bad Gateway", "POST", "https://discord.com/x", {}),
      new TypeError("fetch failed"),
    ]) {
      const message = describeWriteFailure(error);
      expect(message).toContain("unknown whether");
      expect(message).toContain("Check Discord before trying again");
      expect(message).not.toContain("refused");
    }
  });
});

describe("cancellableCall", () => {
  it("aborts the attempt's signal when the call fails", async () => {
    let signal: AbortSignal | undefined;
    const manager = {
      makeDiscordApiCall: async (
        fn: () => Promise<unknown>,
      ): Promise<never> => {
        void fn().catch(() => undefined);
        throw new Error("boom");
      },
    };
    await expect(
      cancellableCall(
        manager as never,
        (s) => {
          signal = s;
          return new Promise(() => undefined);
        },
        "op",
        false,
      ),
    ).rejects.toThrow("boom");
    expect(signal?.aborted).toBe(true);
  });

  it("aborts the previous attempt when a retry starts", async () => {
    const signals: AbortSignal[] = [];
    const manager = {
      makeDiscordApiCall: async (
        fn: () => Promise<unknown>,
      ): Promise<string> => {
        void fn();
        return (await fn()) as string;
      },
    };
    await cancellableCall(
      manager as never,
      (s) => {
        signals.push(s);
        return Promise.resolve("ok");
      },
      "op",
      true,
    );
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
  });
});
