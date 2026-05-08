import { describe, it, expect, beforeEach, jest } from "@jest/globals";

const mockAxiosGet = jest.fn();
const mockPollItemFindOne = jest.fn();
const mockPollItemCreate = jest.fn();
const mockRegisterReloadCallback = jest.fn();
const mockConfigGetBoolean = jest.fn();
const mockConfigGetNumber = jest.fn();

jest.unstable_mockModule("axios", () => ({
  default: {
    get: mockAxiosGet,
    isAxiosError: jest.fn(() => false),
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
    mockConfigGetBoolean.mockResolvedValue(false);
    mockConfigGetNumber.mockResolvedValue(7);
    mockPollItemFindOne.mockResolvedValue(null);
    mockPollItemCreate.mockResolvedValue({});
  });

  it("rejects invalid URL formats before fetching", async () => {
    const service = PollService.getInstance({} as never);

    const result = await service.importFromUrl("not-a-url", "guild-1", "user-1");

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
      const result = await service.importFromUrl(blockedUrl, "guild-1", "user-1");

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
    });

    const service = PollService.getInstance({} as never);

    const result = await service.importFromUrl(
      "https://example.com/polls.yaml",
      "guild-1",
      "user-1",
    );

    expect(mockAxiosGet).toHaveBeenCalledWith("https://example.com/polls.yaml", {
      timeout: 10000,
      maxContentLength: 1024 * 1024,
      headers: {
        "User-Agent": "KoolBot-PollService/1.0",
      },
    });
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
});
