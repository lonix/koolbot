import { describe, it, expect, beforeEach, jest } from "@jest/globals";

const mockAxiosGet = jest.fn();
const mockAxiosIsAxiosError = jest.fn();
const mockPollItemFindOne = jest.fn();
const mockPollItemCreate = jest.fn();
const mockRegisterReloadCallback = jest.fn();
const mockConfigGetBoolean = jest.fn();
const mockConfigGetNumber = jest.fn();

jest.unstable_mockModule("axios", () => ({
  default: {
    get: mockAxiosGet,
    isAxiosError: mockAxiosIsAxiosError,
  },
}));

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

describe("PollService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (PollService as unknown as { instance: unknown }).instance = undefined;
    mockAxiosIsAxiosError.mockReturnValue(false);
    mockConfigGetBoolean.mockResolvedValue(false);
    mockConfigGetNumber.mockResolvedValue(7);
    mockPollItemFindOne.mockResolvedValue(null);
    mockPollItemCreate.mockResolvedValue({});
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
    expect(mockAxiosGet).not.toHaveBeenCalled();
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
    expect(mockAxiosGet).not.toHaveBeenCalled();
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
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });

  it("continues importing polls from allowed https URLs", async () => {
    mockAxiosGet.mockResolvedValue({
      data: `polls:
  - question: Favorite color?
    answers:
      - Blue
      - Green
`,
      headers: { "content-type": "text/yaml; charset=utf-8" },
    });

    const service = PollService.getInstance({} as never);

    const result = await service.importFromUrl(
      "https://example.com/polls.yaml",
      "guild-1",
      "user-1",
    );

    expect(mockAxiosGet).toHaveBeenCalledWith(
      "https://example.com/polls.yaml",
      {
        timeout: 10000,
        maxContentLength: 2 * 1024 * 1024,
        maxBodyLength: 2 * 1024 * 1024,
        responseType: "text",
        headers: {
          "User-Agent": "KoolBot-PollService/1.0",
        },
      },
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

  it("rejects responses with a non-JSON/YAML Content-Type", async () => {
    mockAxiosGet.mockResolvedValue({
      data: "<!DOCTYPE html><html><body>Login required</body></html>",
      headers: { "content-type": "text/html; charset=utf-8" },
    });

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
    mockAxiosGet.mockResolvedValue({
      data: "",
      headers: { "content-type": "text/plain" },
    });

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

  it("reports a clear error when the payload exceeds the size cap", async () => {
    mockAxiosIsAxiosError.mockReturnValue(true);
    mockAxiosGet.mockRejectedValue({
      code: "ERR_FR_MAX_BODY_LENGTH_EXCEEDED",
      message: "maxBodyLength size of 2097152 exceeded",
    });

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

  it("reports a clear error when the request times out", async () => {
    mockAxiosIsAxiosError.mockReturnValue(true);
    mockAxiosGet.mockRejectedValue({
      code: "ECONNABORTED",
      message: "timeout of 10000ms exceeded",
    });

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
});
