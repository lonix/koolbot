import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";

const mockGetBoolean =
  jest.fn<(key: string, def: boolean) => Promise<boolean>>();
const mockRegisterReload = jest.fn();
const mockRemoveReload = jest.fn();

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: jest.fn(() => ({
      getBoolean: mockGetBoolean,
      registerReloadCallback: mockRegisterReload,
      removeReloadCallback: mockRemoveReload,
    })),
  },
}));

const mockIsCategoryEnabled = jest.fn<(type: string) => Promise<boolean>>();
const mockLogToChannel =
  jest.fn<(type: string, msg: Record<string, unknown>) => Promise<boolean>>();

jest.unstable_mockModule("../../src/services/discord-logger.js", () => ({
  DiscordLogger: {
    getInstance: jest.fn(() => ({
      isCategoryEnabled: mockIsCategoryEnabled,
      logToChannel: mockLogToChannel,
    })),
  },
}));

const mockFindOneLean = jest.fn<() => Promise<unknown>>();
const mockUpdateOne = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule("../../src/models/version-check-state.js", () => ({
  VersionCheckState: {
    findOne: jest.fn(() => ({ lean: mockFindOneLean })),
    updateOne: mockUpdateOne,
  },
}));

let runningVersion = "2.0.0";
jest.unstable_mockModule("../../src/utils/version.js", () => ({
  getBotVersion: (): string => runningVersion,
}));

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const {
  VersionCheckService,
  RELEASES_API_URL,
  UPDATE_CHECK_USER_AGENT,
  CHECK_INTERVAL_MS,
  MIN_CHECK_GAP_MS,
} = await import("../../src/services/version-check-service.js");

type FetchMock = jest.Mock<
  (
    input: string,
    init?: { headers?: Record<string, string>; signal?: AbortSignal },
  ) => Promise<{
    ok: boolean;
    status: number;
    headers: { get(name: string): string | null };
    json(): Promise<unknown>;
  }>
>;

function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Awaited<ReturnType<FetchMock>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

function release(tag: string, extra: Record<string, unknown> = {}): unknown {
  return {
    tag_name: tag,
    html_url: `https://github.com/lonix/koolbot/releases/tag/${tag}`,
    published_at: "2026-09-01T12:00:00Z",
    ...extra,
  };
}

const client = { user: { id: "bot" } } as never;
let fetchMock: FetchMock;

function service(): InstanceType<typeof VersionCheckService> {
  return VersionCheckService.getInstance(client, fetchMock as never);
}

beforeEach(() => {
  VersionCheckService.reset();
  jest.clearAllMocks();
  runningVersion = "2.0.0";
  fetchMock = jest.fn() as FetchMock;
  mockGetBoolean.mockResolvedValue(true);
  mockFindOneLean.mockResolvedValue(null);
  mockUpdateOne.mockResolvedValue({});
  mockIsCategoryEnabled.mockResolvedValue(false);
  mockLogToChannel.mockResolvedValue(true);
});

afterEach(() => {
  VersionCheckService.reset();
  jest.useRealTimers();
});

describe("VersionCheckService (#1029)", () => {
  describe("checkNow", () => {
    it("reports an update when the latest release is newer", async () => {
      fetchMock.mockResolvedValue(response(200, release("v2.1.0")));
      const snap = await service().checkNow();
      expect(snap.status).toBe("update-available");
      expect(snap.updateKind).toBe("minor");
      expect(snap.latest?.version).toBe("v2.1.0");
      expect(snap.latest?.url).toBe(
        "https://github.com/lonix/koolbot/releases/tag/v2.1.0",
      );
      expect(snap.latest?.publishedAt?.toISOString()).toBe(
        "2026-09-01T12:00:00.000Z",
      );
      expect(snap.lastError).toBeNull();
    });

    it("classifies a major jump", async () => {
      runningVersion = "1.2.2";
      fetchMock.mockResolvedValue(response(200, release("v2.0.0")));
      expect((await service().checkNow()).updateKind).toBe("major");
    });

    it("reports up to date when the versions match", async () => {
      fetchMock.mockResolvedValue(response(200, release("v2.0.0")));
      const snap = await service().checkNow();
      expect(snap.status).toBe("up-to-date");
      expect(snap.updateKind).toBeNull();
    });

    it("reports ahead when running a newer build than the latest release", async () => {
      runningVersion = "2.2.0";
      fetchMock.mockResolvedValue(response(200, release("v2.1.0")));
      const snap = await service().checkNow();
      expect(snap.status).toBe("ahead");
      expect(snap.updateKind).toBeNull();
    });

    it("can't compare an unknown running version", async () => {
      runningVersion = "unknown";
      fetchMock.mockResolvedValue(response(200, release("v2.1.0")));
      const snap = await service().checkNow();
      expect(snap.status).toBe("unknown-running");
      expect(snap.latest?.version).toBe("v2.1.0");
    });

    it("sends only a generic User-Agent and Accept header", async () => {
      fetchMock.mockResolvedValue(response(200, release("v2.0.0")));
      await service().checkNow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(RELEASES_API_URL);
      expect(init?.headers).toEqual({
        Accept: "application/vnd.github+json",
        "User-Agent": UPDATE_CHECK_USER_AGENT,
      });
      // The User-Agent names the software, never this instance or version.
      expect(UPDATE_CHECK_USER_AGENT).not.toMatch(/\d/);
      expect(url).not.toContain("?");
    });

    it("never links outside the project's releases page", async () => {
      fetchMock.mockResolvedValue(
        response(
          200,
          release("v2.1.0", { html_url: "https://evil.example/x" }),
        ),
      );
      const snap = await service().checkNow();
      expect(snap.latest?.url).toBe(
        "https://github.com/lonix/koolbot/releases/tag/v2.1.0",
      );
    });

    it("rejects a release URL that only looks like it is under /releases/", async () => {
      for (const html_url of [
        "https://github.com/lonix/koolbot/releases/../issues",
        "https://github.com/lonix/koolbot/releases/%2e%2e/issues",
        "https://user@github.com/lonix/koolbot/releases/tag/v2.1.0",
        "http://github.com/lonix/koolbot/releases/tag/v2.1.0",
        "not a url",
      ]) {
        VersionCheckService.reset();
        fetchMock.mockResolvedValue(
          response(200, release("v2.1.0", { html_url })),
        );
        const snap = await service().checkNow();
        expect(snap.latest?.url).toBe(
          "https://github.com/lonix/koolbot/releases/tag/v2.1.0",
        );
      }
    });

    it("records a network error without throwing", async () => {
      fetchMock.mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));
      const snap = await service().checkNow();
      expect(snap.status).toBe("error");
      expect(snap.lastError).toContain("ENOTFOUND");
      expect(snap.latest).toBeNull();
    });

    it("reports a timeout as its own message", async () => {
      fetchMock.mockRejectedValue(
        Object.assign(new Error("aborted"), { name: "TimeoutError" }),
      );
      const snap = await service().checkNow();
      expect(snap.lastError).toBe("GitHub did not respond in time.");
    });

    it("recognises GitHub's rate limit (403 with no requests left)", async () => {
      fetchMock.mockResolvedValue(
        response(
          403,
          { message: "API rate limit exceeded" },
          { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1790000000" },
        ),
      );
      const snap = await service().checkNow();
      expect(snap.status).toBe("error");
      expect(snap.lastError).toContain("Rate-limited by GitHub");
      expect(snap.lastError).toContain(
        new Date(1790000000 * 1000).toISOString(),
      );
    });

    it("recognises a 429 as rate-limited", async () => {
      fetchMock.mockResolvedValue(response(429, {}));
      expect((await service().checkNow()).lastError).toBe(
        "Rate-limited by GitHub.",
      );
    });

    it("maps a 404 and other HTTP errors", async () => {
      fetchMock.mockResolvedValue(response(404, {}));
      expect((await service().checkNow()).lastError).toContain(
        "No published release",
      );
      VersionCheckService.reset();
      fetchMock.mockResolvedValue(response(500, {}));
      expect((await service().checkNow()).lastError).toBe(
        "GitHub returned HTTP 500.",
      );
    });

    it("rejects a release without a version tag", async () => {
      fetchMock.mockResolvedValue(response(200, { tag_name: "nightly" }));
      expect((await service().checkNow()).lastError).toContain("version tag");
    });

    it("keeps the last good result when a later check fails", async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      fetchMock.mockResolvedValueOnce(response(200, release("v2.1.0")));
      const svc = service();
      await svc.checkNow();
      jest.setSystemTime(Date.now() + MIN_CHECK_GAP_MS + 1);
      fetchMock.mockRejectedValueOnce(new Error("offline"));
      const snap = await svc.checkNow();
      expect(snap.status).toBe("error");
      expect(snap.latest?.version).toBe("v2.1.0");
      // The badge still knows an update exists.
      expect(snap.updateKind).toBe("minor");
    });

    it("throttles repeat checks and shares a concurrent request", async () => {
      fetchMock.mockResolvedValue(response(200, release("v2.0.0")));
      const svc = service();
      await Promise.all([svc.checkNow(), svc.checkNow()]);
      await svc.checkNow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("makes no request while the check is disabled", async () => {
      mockGetBoolean.mockResolvedValue(false);
      const snap = await service().checkNow();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(snap.status).toBe("disabled");
      expect(snap.enabled).toBe(false);
      expect(snap.running).toBe("2.0.0");
    });

    it("persists the successful result", async () => {
      fetchMock.mockResolvedValue(response(200, release("v2.1.0")));
      await service().checkNow();
      expect(mockUpdateOne).toHaveBeenCalledWith(
        { key: "latest-release" },
        {
          $set: expect.objectContaining({
            latestVersion: "v2.1.0",
            notifiedVersion: null,
          }),
        },
        { upsert: true },
      );
    });

    it("still answers when persistence is unavailable", async () => {
      mockFindOneLean.mockRejectedValue(new Error("mongo down"));
      mockUpdateOne.mockRejectedValue(new Error("mongo down"));
      fetchMock.mockResolvedValue(response(200, release("v2.1.0")));
      expect((await service().checkNow()).status).toBe("update-available");
    });
  });

  describe("persisted state", () => {
    it("shows the stored result before any check has run", async () => {
      mockGetBoolean.mockResolvedValue(false);
      mockFindOneLean.mockResolvedValue({
        latestVersion: "v2.1.0",
        releaseUrl: "https://github.com/lonix/koolbot/releases/tag/v2.1.0",
        publishedAt: null,
        fetchedAt: new Date("2026-09-20T00:00:00Z"),
        notifiedVersion: "v2.1.0",
      });
      const svc = service();
      await svc.start();
      mockGetBoolean.mockResolvedValue(true);
      await svc.refreshEnabled();
      const snap = svc.getSnapshot();
      expect(snap.latest?.version).toBe("v2.1.0");
      expect(snap.status).toBe("update-available");
    });
  });

  describe("update-available note", () => {
    it("posts once per new release when core.updates is on", async () => {
      mockIsCategoryEnabled.mockResolvedValue(true);
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      fetchMock.mockResolvedValue(response(200, release("v3.0.0")));
      const svc = service();
      await svc.checkNow();
      expect(mockIsCategoryEnabled).toHaveBeenCalledWith("updates");
      expect(mockLogToChannel).toHaveBeenCalledTimes(1);
      const [type, msg] = mockLogToChannel.mock.calls[0];
      expect(type).toBe("updates");
      expect(String(msg.description)).toContain("major");
      expect(String(msg.description)).toContain("breaking changes");

      jest.setSystemTime(Date.now() + MIN_CHECK_GAP_MS + 1);
      await svc.checkNow();
      expect(mockLogToChannel).toHaveBeenCalledTimes(1);
      expect(mockUpdateOne).toHaveBeenLastCalledWith(
        { key: "latest-release" },
        { $set: expect.objectContaining({ notifiedVersion: "v3.0.0" }) },
        { upsert: true },
      );
    });

    it("does not post, or mark as announced, while the category is off", async () => {
      fetchMock.mockResolvedValue(response(200, release("v2.1.0")));
      await service().checkNow();
      expect(mockLogToChannel).not.toHaveBeenCalled();
      expect(mockUpdateOne).toHaveBeenLastCalledWith(
        { key: "latest-release" },
        { $set: expect.objectContaining({ notifiedVersion: null }) },
        { upsert: true },
      );
    });

    it("retries the note on the next check when it was not delivered", async () => {
      mockIsCategoryEnabled.mockResolvedValue(true);
      mockLogToChannel.mockResolvedValueOnce(false);
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      fetchMock.mockResolvedValue(response(200, release("v2.1.0")));
      const svc = service();
      await svc.checkNow();
      expect(mockLogToChannel).toHaveBeenCalledTimes(1);
      expect(mockUpdateOne).toHaveBeenLastCalledWith(
        { key: "latest-release" },
        { $set: expect.objectContaining({ notifiedVersion: null }) },
        { upsert: true },
      );

      jest.setSystemTime(Date.now() + MIN_CHECK_GAP_MS + 1);
      await svc.checkNow();
      expect(mockLogToChannel).toHaveBeenCalledTimes(2);
      expect(mockUpdateOne).toHaveBeenLastCalledWith(
        { key: "latest-release" },
        { $set: expect.objectContaining({ notifiedVersion: "v2.1.0" }) },
        { upsert: true },
      );
    });

    it("does not post when already up to date", async () => {
      mockIsCategoryEnabled.mockResolvedValue(true);
      fetchMock.mockResolvedValue(response(200, release("v2.0.0")));
      await service().checkNow();
      expect(mockLogToChannel).not.toHaveBeenCalled();
    });

    it("does not repost a version stored as announced", async () => {
      mockIsCategoryEnabled.mockResolvedValue(true);
      mockFindOneLean.mockResolvedValue({ notifiedVersion: "v2.1.0" });
      fetchMock.mockResolvedValue(response(200, release("v2.1.0")));
      await service().checkNow();
      expect(mockLogToChannel).not.toHaveBeenCalled();
    });
  });

  describe("lifecycle", () => {
    it("checks at start, re-checks every 12h and stops on destroy", async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      fetchMock.mockResolvedValue(response(200, release("v2.0.0")));
      const svc = service();
      await svc.start();
      await svc.start(); // idempotent
      await jest.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(mockRegisterReload).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      svc.destroy();
      expect(mockRemoveReload).toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("skips the startup check while disabled but keeps the interval armed", async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      mockGetBoolean.mockResolvedValue(false);
      fetchMock.mockResolvedValue(response(200, release("v2.0.0")));
      const svc = service();
      await svc.start();
      await jest.advanceTimersByTimeAsync(0);
      expect(fetchMock).not.toHaveBeenCalled();

      // Enabled later from the Settings page: the next tick picks it up.
      mockGetBoolean.mockResolvedValue(true);
      await jest.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("the reload callback runs a first check once enabled", async () => {
      mockGetBoolean.mockResolvedValue(false);
      fetchMock.mockResolvedValue(response(200, release("v2.0.0")));
      const svc = service();
      await svc.start();
      const onReload = mockRegisterReload.mock
        .calls[0][0] as () => Promise<void>;
      mockGetBoolean.mockResolvedValue(true);
      await onReload();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(svc.getSnapshot().status).toBe("up-to-date");
    });

    it("the reload callback re-checks when switched back on with a cached result", async () => {
      mockFindOneLean.mockResolvedValue({
        latestVersion: "v2.0.0",
        releaseUrl: "https://github.com/lonix/koolbot/releases/tag/v2.0.0",
        publishedAt: null,
        fetchedAt: new Date("2026-01-01T00:00:00Z"),
        notifiedVersion: null,
      });
      mockGetBoolean.mockResolvedValue(false);
      fetchMock.mockResolvedValue(response(200, release("v2.1.0")));
      const svc = service();
      await svc.start();
      expect(svc.getSnapshot().latest?.version).toBe("v2.0.0");
      const onReload = mockRegisterReload.mock
        .calls[0][0] as () => Promise<void>;

      mockGetBoolean.mockResolvedValue(true);
      await onReload();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(svc.getSnapshot().latest?.version).toBe("v2.1.0");

      // A reload while it was already on does not force another request.
      await onReload();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("reports unchecked before the first result arrives", () => {
      expect(service().getSnapshot().status).toBe("unchecked");
    });

    it("peek() does not construct an instance", () => {
      expect(VersionCheckService.peek()).toBeUndefined();
      const svc = service();
      expect(VersionCheckService.peek()).toBe(svc);
    });
  });
});
