import { describe, it, expect, beforeEach, jest } from "@jest/globals";

const mockFetch = jest.fn<typeof fetch>();
const mockPollItemFindOne = jest.fn();
const mockPollItemCreate = jest.fn();
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
  },
}));

jest.unstable_mockModule("../../src/models/poll-schedule.js", () => ({
  PollSchedule: {},
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
    global.fetch = mockFetch as unknown as typeof fetch;
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
        redirect: "follow",
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
    mockFetch.mockRejectedValue(new DOMException("The operation was aborted", "AbortError"));

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
});
