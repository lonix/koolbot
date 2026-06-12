import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";

const mockFetch = jest.fn<typeof fetch>();
const mockPollItemFindOne = jest.fn();
const mockPollItemCreate = jest.fn();
const mockPollItemFindById = jest.fn();
const mockPollScheduleFindById = jest.fn();
const mockRegisterReloadCallback = jest.fn();
const mockConfigGetBoolean = jest.fn();
const mockConfigGetNumber = jest.fn();

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: jest.fn(() => ({
      registerReloadCallback: mockRegisterReloadCallback,
      getBoolean: mockConfigGetBoolean,
      getNumber: mockConfigGetNumber,
    })),
  },
}));

jest.unstable_mockModule("../../src/models/poll-item.js", () => ({
  PollItem: {
    findOne: mockPollItemFindOne,
    create: mockPollItemCreate,
    findById: mockPollItemFindById,
  },
}));

jest.unstable_mockModule("../../src/models/poll-schedule.js", () => ({
  PollSchedule: {
    findById: mockPollScheduleFindById,
  },
}));

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { PollService } = await import("../../src/services/poll-service.js");

// Build a real fetch Response so the service exercises the genuine
// Headers/ReadableStream plumbing it relies on at runtime (Node 22+).
function makeResponse(
  body: string | ReadableStream<Uint8Array> | null,
  contentType: string,
  init: {
    status?: number;
    statusText?: string;
    headers?: Record<string, string>;
  } = {},
): Response {
  const headers = new Headers(init.headers);
  if (contentType) {
    headers.set("content-type", contentType);
  }
  return new Response(body, { status: 200, ...init, headers });
}

describe("PollService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (PollService as unknown as { instance: unknown }).instance = undefined;
    mockConfigGetBoolean.mockResolvedValue(false);
    mockConfigGetNumber.mockResolvedValue(7);
    mockPollItemFindOne.mockResolvedValue(null);
    mockPollItemCreate.mockResolvedValue({});
    mockPollItemFindById.mockResolvedValue(null);
    mockPollScheduleFindById.mockResolvedValue(null);
    global.fetch = mockFetch as unknown as typeof fetch;
    // The import host allowlist is server-controlled; allow the fixture host
    // used throughout these tests via the configurable env var.
    process.env.POLL_IMPORT_ALLOWED_HOSTS = "example.com";
  });

  afterEach(() => {
    delete process.env.POLL_IMPORT_ALLOWED_HOSTS;
  });

  it("rejects invalid URL formats before fetching", async () => {
    const service = PollService.getInstance({} as never);

    const result = await service.importFromUrl(
      "not-a-url",
      "guild-1",
      "user-1",
    );

    expect(result).toEqual({
      imported: 0,
      skipped: 0,
      errors: ["Invalid URL format. Please provide a valid HTTP or HTTPS URL."],
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects non-http protocols before fetching", async () => {
    const service = PollService.getInstance({} as never);

    const result = await service.importFromUrl(
      "file:///etc/passwd",
      "guild-1",
      "user-1",
    );

    expect(result).toEqual({
      imported: 0,
      skipped: 0,
      errors: ["URL must use the http or https protocol"],
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects private and local destinations before fetching", async () => {
    const service = PollService.getInstance({} as never);

    const blockedUrls = [
      "http://127.0.0.1/internal",
      "http://10.0.0.12/internal",
      "http://172.20.0.5/internal",
      "http://192.168.1.10/internal",
      "http://169.254.169.254/latest/meta-data/",
      "http://localhost/internal",
      "http://foo.localhost/internal",
      "http://[::1]/internal",
      "http://[fc00::1]/internal",
      "http://[fe80::1]/internal",
      "http://[::ffff:127.0.0.1]/internal",
      "http://[::ffff:7f00:1]/internal",
    ];

    for (const blockedUrl of blockedUrls) {
      const result = await service.importFromUrl(
        blockedUrl,
        "guild-1",
        "user-1",
      );

      expect(result).toEqual({
        imported: 0,
        skipped: 0,
        errors: ["URL must not point to a private or local address"],
      });
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects hosts that are not on the import allowlist", async () => {
    const service = PollService.getInstance({} as never);

    const result = await service.importFromUrl(
      "https://evil.example.org/polls.yaml",
      "guild-1",
      "user-1",
    );

    expect(result).toEqual({
      imported: 0,
      skipped: 0,
      errors: ["URL host is not allowed for imports"],
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects look-alike hosts that only suffix an allowed host", async () => {
    const service = PollService.getInstance({} as never);

    const result = await service.importFromUrl(
      "https://example.com.evil.org/polls.yaml",
      "guild-1",
      "user-1",
    );

    expect(result).toEqual({
      imported: 0,
      skipped: 0,
      errors: ["URL host is not allowed for imports"],
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("allows GitHub raw hosts by default when no allowlist is configured", async () => {
    delete process.env.POLL_IMPORT_ALLOWED_HOSTS;
    mockFetch.mockResolvedValue(
      makeResponse(
        `polls:
  - question: Default host?
    answers:
      - Yes
      - No
`,
        "text/yaml",
      ),
    );

    const service = PollService.getInstance({} as never);

    const result = await service.importFromUrl(
      "https://raw.githubusercontent.com/org/repo/main/polls.yaml",
      "guild-1",
      "user-1",
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.imported).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it("continues importing polls from allowed https URLs", async () => {
    mockFetch.mockResolvedValue(
      makeResponse(
        `polls:
  - question: Favorite color?
    answers:
      - Blue
      - Green
`,
        "text/yaml; charset=utf-8",
      ),
    );

    const service = PollService.getInstance({} as never);

    const result = await service.importFromUrl(
      "https://example.com/polls.yaml",
      "guild-1",
      "user-1",
    );

    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com/polls.yaml",
      expect.objectContaining({
        redirect: "error",
        headers: {
          "User-Agent": "KoolBot-PollService/1.0",
        },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(mockPollItemFindOne).toHaveBeenCalledWith({
      guildId: "guild-1",
      question: "Favorite color?",
    });
    expect(mockPollItemCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        question: "Favorite color?",
        answers: ["Blue", "Green"],
        createdBy: "user-1",
        source: "https://example.com/polls.yaml",
      }),
    );
    expect(result).toEqual({
      imported: 1,
      skipped: 0,
      errors: [],
    });
  });

  it("reports an HTTP error for a non-2xx response", async () => {
    mockFetch.mockResolvedValue(
      makeResponse("Not found", "text/plain", {
        status: 404,
        statusText: "Not Found",
      }),
    );

    const service = PollService.getInstance({} as never);

    const result = await service.importFromUrl(
      "https://example.com/missing.yaml",
      "guild-1",
      "user-1",
    );

    expect(result).toEqual({
      imported: 0,
      skipped: 0,
      errors: ["HTTP 404: Not Found"],
    });
    expect(mockPollItemCreate).not.toHaveBeenCalled();
  });

  it("rejects responses with a non-JSON/YAML Content-Type", async () => {
    mockFetch.mockResolvedValue(
      makeResponse(
        "<!DOCTYPE html><html><body>Login required</body></html>",
        "text/html; charset=utf-8",
      ),
    );

    const service = PollService.getInstance({} as never);

    const result = await service.importFromUrl(
      "https://example.com/login",
      "guild-1",
      "user-1",
    );

    expect(result).toEqual({
      imported: 0,
      skipped: 0,
      errors: [
        'Unexpected Content-Type from import URL: "text/html". Expected JSON or YAML.',
      ],
    });
    expect(mockPollItemCreate).not.toHaveBeenCalled();
  });

  it("reports an invalid-format error for an empty or non-object body", async () => {
    mockFetch.mockResolvedValue(makeResponse("", "text/plain"));

    const service = PollService.getInstance({} as never);

    const result = await service.importFromUrl(
      "https://example.com/empty.yaml",
      "guild-1",
      "user-1",
    );

    expect(result).toEqual({
      imported: 0,
      skipped: 0,
      errors: ["Invalid format: expected { polls: [...] }"],
    });
    expect(mockPollItemCreate).not.toHaveBeenCalled();
  });

  it("reports a clear error when a declared Content-Length exceeds the cap", async () => {
    mockFetch.mockResolvedValue(
      makeResponse("", "text/yaml", {
        headers: { "content-length": String(2 * 1024 * 1024 + 1) },
      }),
    );

    const service = PollService.getInstance({} as never);

    const result = await service.importFromUrl(
      "https://example.com/huge.yaml",
      "guild-1",
      "user-1",
    );

    expect(result).toEqual({
      imported: 0,
      skipped: 0,
      errors: ["URL response too large (max 2 MB)"],
    });
    expect(mockPollItemCreate).not.toHaveBeenCalled();
  });

  it("enforces the size cap while streaming a body with no Content-Length", async () => {
    const oversized = "x".repeat(2 * 1024 * 1024 + 10);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(oversized));
        controller.close();
      },
    });
    mockFetch.mockResolvedValue(makeResponse(stream, "text/yaml"));

    const service = PollService.getInstance({} as never);

    const result = await service.importFromUrl(
      "https://example.com/streamed.yaml",
      "guild-1",
      "user-1",
    );

    expect(result).toEqual({
      imported: 0,
      skipped: 0,
      errors: ["URL response too large (max 2 MB)"],
    });
    expect(mockPollItemCreate).not.toHaveBeenCalled();
  });

  it("reports a clear error when the request times out", async () => {
    mockFetch.mockRejectedValue(
      new DOMException("The operation was aborted", "AbortError"),
    );

    const service = PollService.getInstance({} as never);

    const result = await service.importFromUrl(
      "https://example.com/slow.yaml",
      "guild-1",
      "user-1",
    );

    expect(result).toEqual({
      imported: 0,
      skipped: 0,
      errors: ["Request timeout - URL took too long to respond"],
    });
    expect(mockPollItemCreate).not.toHaveBeenCalled();
  });

  it("reports a network error when fetch fails to connect", async () => {
    mockFetch.mockRejectedValue(new TypeError("fetch failed"));

    const service = PollService.getInstance({} as never);

    const result = await service.importFromUrl(
      "https://example.com/unreachable.yaml",
      "guild-1",
      "user-1",
    );

    expect(result).toEqual({
      imported: 0,
      skipped: 0,
      errors: ["No response from URL - check if URL is accessible"],
    });
    expect(mockPollItemCreate).not.toHaveBeenCalled();
  });

  describe("importFromString (paste path)", () => {
    it("imports a valid pasted YAML library without any network call", async () => {
      const service = PollService.getInstance({} as never);

      const result = await service.importFromString(
        `polls:
  - question: Favorite color?
    answers:
      - Blue
      - Green
    tags: [fun]
`,
        "guild-1",
        "user-1",
      );

      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockPollItemFindOne).toHaveBeenCalledWith({
        guildId: "guild-1",
        question: "Favorite color?",
      });
      expect(mockPollItemCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          guildId: "guild-1",
          question: "Favorite color?",
          answers: ["Blue", "Green"],
          tags: ["fun"],
          createdBy: "user-1",
          source: "paste",
        }),
      );
      expect(result).toEqual({ imported: 1, skipped: 0, errors: [] });
    });

    it("imports a valid pasted JSON library", async () => {
      const service = PollService.getInstance({} as never);

      const result = await service.importFromString(
        JSON.stringify({
          polls: [{ question: "Tea or coffee?", answers: ["Tea", "Coffee"] }],
        }),
        "guild-1",
        "user-1",
      );

      expect(mockPollItemCreate).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ imported: 1, skipped: 0, errors: [] });
    });

    it("rejects content larger than the import size cap before parsing", async () => {
      const service = PollService.getInstance({} as never);
      const oversized = "x".repeat(2 * 1024 * 1024 + 1);

      const result = await service.importFromString(
        oversized,
        "guild-1",
        "user-1",
      );

      expect(result).toEqual({
        imported: 0,
        skipped: 0,
        errors: ["Content too large (max 2 MB)"],
      });
      expect(mockPollItemCreate).not.toHaveBeenCalled();
    });

    it("reports an invalid-format error for malformed YAML", async () => {
      const service = PollService.getInstance({} as never);

      const result = await service.importFromString(
        "polls:\n  - question: 'unterminated\n",
        "guild-1",
        "user-1",
      );

      expect(result.imported).toBe(0);
      expect(result.errors).toEqual([
        "Invalid format: could not parse content as YAML or JSON",
      ]);
      expect(mockPollItemCreate).not.toHaveBeenCalled();
    });

    it("skips a poll whose answer exceeds the 55-character cap", async () => {
      const service = PollService.getInstance({} as never);
      const longAnswer = "a".repeat(56);

      const result = await service.importFromString(
        JSON.stringify({
          polls: [{ question: "Too long?", answers: ["Yes", longAnswer] }],
        }),
        "guild-1",
        "user-1",
      );

      expect(result.imported).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.errors).toEqual(["Poll 1: Answer too long (max 55 chars)"]);
      expect(mockPollItemCreate).not.toHaveBeenCalled();
    });

    it("rejects a non-string question instead of querying with it (NoSQL injection guard)", async () => {
      const service = PollService.getInstance({} as never);

      const result = await service.importFromString(
        JSON.stringify({
          polls: [{ question: { $ne: null }, answers: ["A", "B"] }],
        }),
        "guild-1",
        "user-1",
      );

      expect(result.imported).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.errors).toEqual(["Poll 1: Missing question or answers"]);
      // The operator object must never reach the duplicate-check query.
      expect(mockPollItemFindOne).not.toHaveBeenCalled();
      expect(mockPollItemCreate).not.toHaveBeenCalled();
    });

    it("skips a duplicate question that already exists", async () => {
      mockPollItemFindOne.mockResolvedValue({ _id: "existing" });
      const service = PollService.getInstance({} as never);

      const result = await service.importFromString(
        JSON.stringify({
          polls: [{ question: "Existing?", answers: ["A", "B"] }],
        }),
        "guild-1",
        "user-1",
      );

      expect(result).toEqual({ imported: 0, skipped: 1, errors: [] });
      expect(mockPollItemCreate).not.toHaveBeenCalled();
    });
  });

  describe("updatePollItem", () => {
    it("changes only the editable fields and preserves usage stats/provenance", async () => {
      const save = jest.fn<() => Promise<void>>().mockResolvedValue();
      const item = {
        _id: { toString: () => "item-1" },
        guildId: "guild-1",
        question: "Old question?",
        answers: ["A", "B"],
        multiSelect: false,
        tags: ["old"],
        usageCount: 7,
        lastUsed: new Date("2026-01-01T00:00:00Z"),
        createdBy: "creator-1",
        source: "manual",
        save,
      };
      mockPollItemFindById.mockResolvedValue(item);
      const service = PollService.getInstance({} as never);

      const result = await service.updatePollItem(
        "item-1",
        {
          question: "New question?",
          answers: ["Yes", "No", "Maybe"],
          multiSelect: true,
          tags: ["new", "fun"],
        },
        "guild-1",
      );

      expect(result).toBe(item);
      expect(save).toHaveBeenCalledTimes(1);
      // Editable fields changed.
      expect(item.question).toBe("New question?");
      expect(item.answers).toEqual(["Yes", "No", "Maybe"]);
      expect(item.multiSelect).toBe(true);
      expect(item.tags).toEqual(["new", "fun"]);
      // Stats and provenance are untouched.
      expect(item.usageCount).toBe(7);
      expect(item.lastUsed).toEqual(new Date("2026-01-01T00:00:00Z"));
      expect(item.createdBy).toBe("creator-1");
      expect(item.source).toBe("manual");
    });

    it("refuses to edit an item belonging to another guild", async () => {
      const save = jest.fn<() => Promise<void>>().mockResolvedValue();
      mockPollItemFindById.mockResolvedValue({
        _id: { toString: () => "item-1" },
        guildId: "other-guild",
        save,
      });
      const service = PollService.getInstance({} as never);

      const result = await service.updatePollItem(
        "item-1",
        { question: "Q?", answers: ["A", "B"], multiSelect: false, tags: [] },
        "guild-1",
      );

      expect(result).toBeNull();
      expect(save).not.toHaveBeenCalled();
    });

    it("returns null when the item does not exist", async () => {
      mockPollItemFindById.mockResolvedValue(null);
      const service = PollService.getInstance({} as never);

      const result = await service.updatePollItem(
        "missing",
        { question: "Q?", answers: ["A", "B"], multiSelect: false, tags: [] },
        "guild-1",
      );

      expect(result).toBeNull();
    });
  });

  describe("updateSchedule", () => {
    it("rejects an invalid cron expression before touching the database", async () => {
      const service = PollService.getInstance({} as never);

      await expect(
        service.updateSchedule(
          "sched-1",
          {
            channelId: "chan-1",
            cronSchedule: "not a cron",
            pollDuration: 12,
            roleIdToPing: null,
          },
          "guild-1",
        ),
      ).rejects.toThrow("Invalid cron expression");
      expect(mockPollScheduleFindById).not.toHaveBeenCalled();
    });

    it("saves the new fields and re-arms the running cron job in place", async () => {
      const save = jest.fn<() => Promise<void>>().mockResolvedValue();
      const schedule = {
        _id: { toString: () => "sched-1" },
        guildId: "guild-1",
        channelId: "old-chan",
        cronSchedule: "0 9 * * *",
        pollDuration: 24,
        roleIdToPing: null as string | null,
        enabled: true,
        save,
      };
      mockPollScheduleFindById.mockResolvedValue(schedule);

      const service = PollService.getInstance({} as never);
      // Simulate a running service with an existing job for this schedule.
      const oldStop = jest.fn();
      const internals = service as unknown as {
        isInitialized: boolean;
        jobs: Map<string, { schedule: unknown; job: { stop: () => void } }>;
      };
      internals.isInitialized = true;
      internals.jobs.set("sched-1", {
        schedule,
        job: { stop: oldStop },
      });

      const result = await service.updateSchedule(
        "sched-1",
        {
          channelId: "new-chan",
          cronSchedule: "0 12 * * 1",
          pollDuration: 6,
          roleIdToPing: "role-9",
        },
        "guild-1",
      );

      expect(result).toBe(schedule);
      expect(save).toHaveBeenCalledTimes(1);
      expect(schedule.channelId).toBe("new-chan");
      expect(schedule.cronSchedule).toBe("0 12 * * 1");
      expect(schedule.pollDuration).toBe(6);
      expect(schedule.roleIdToPing).toBe("role-9");
      // Old job stopped, a fresh job armed in its place.
      expect(oldStop).toHaveBeenCalledTimes(1);
      const rearmed = internals.jobs.get("sched-1");
      expect(rearmed).toBeDefined();
      expect(rearmed?.job).not.toBe(oldStop);

      // Stop the real CronJob so it does not leak a live timer.
      service.destroy();
    });

    it("refuses to edit a schedule belonging to another guild", async () => {
      const save = jest.fn<() => Promise<void>>().mockResolvedValue();
      mockPollScheduleFindById.mockResolvedValue({
        _id: { toString: () => "sched-1" },
        guildId: "other-guild",
        save,
      });
      const service = PollService.getInstance({} as never);

      const result = await service.updateSchedule(
        "sched-1",
        {
          channelId: "chan-1",
          cronSchedule: "0 12 * * 1",
          pollDuration: 12,
          roleIdToPing: null,
        },
        "guild-1",
      );

      expect(result).toBeNull();
      expect(save).not.toHaveBeenCalled();
    });
  });
});
