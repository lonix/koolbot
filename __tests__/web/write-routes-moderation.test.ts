/**
 * Route-handler tests for the Moderation write router (#908): the gate, the
 * review-date parsing, that every decision reaches the service with the
 * session's identity and is audited, and that an illegal transition or a lost
 * race comes back as a flash message rather than a 500.
 */

import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import type { Client } from "discord.js";
import {
  startAdminHarness,
  stubRequireSession,
  createTestSession,
  parseFlashRedirect,
  type AdminHarness,
} from "./admin-harness.js";

const mockRecordAudit = jest.fn(async () => undefined);
const mockIsEnabled = jest.fn<() => Promise<boolean>>();
const mockOpenCase =
  jest.fn<(input: Record<string, any>) => Promise<unknown>>();
const mockDecide = jest.fn<(input: Record<string, any>) => Promise<unknown>>();
const mockRunNow = jest.fn<() => Promise<unknown>>();

jest.unstable_mockModule("../../src/web/audit.js", () => ({
  recordAudit: mockRecordAudit,
}));

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

class MockCaseError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

jest.unstable_mockModule(
  "../../src/services/moderation-case-service.js",
  () => ({
    ModerationCaseError: MockCaseError,
    ModerationCaseService: {
      getInstance: (): unknown => ({
        isEnabled: mockIsEnabled,
        openCase: mockOpenCase,
        decide: mockDecide,
      }),
    },
  }),
);

jest.unstable_mockModule(
  "../../src/services/moderation-case-review-service.js",
  () => ({
    ModerationCaseReviewService: {
      getInstance: (): unknown => ({ runNow: mockRunNow }),
    },
  }),
);

const { createModerationRouter } =
  await import("../../src/web/routes/write/moderation.js");
const { requireCsrf } = await import("../../src/web/csrf.js");
const { requireAdminRoleMiddleware } = await import("../../src/web/session.js");

const client = { user: { id: "bot" } } as unknown as Client;
const session = createTestSession();
let harness: AdminHarness;

const ENTRY = "a".repeat(24);
const CASE = "b".repeat(24);
const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  jest.clearAllMocks();
  mockIsEnabled.mockResolvedValue(true);
  mockOpenCase.mockResolvedValue({ _id: CASE, caseNumber: 14 });
  mockDecide.mockResolvedValue({
    _id: CASE,
    caseNumber: 14,
    status: "lifted",
    reviewAt: null,
  });
  mockRunNow.mockResolvedValue({ due: 3, flipped: 2, notified: true });
  harness = await startAdminHarness([
    stubRequireSession(session),
    requireAdminRoleMiddleware(),
    requireCsrf,
    createModerationRouter(client),
  ]);
});

afterEach(async () => {
  await harness.close();
});

const flashOf = (res: Response) =>
  parseFlashRedirect(res.headers.get("location"));

function lastAudit(): Record<string, unknown> {
  const calls = mockRecordAudit.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][1] as Record<string, unknown>;
}

describe("POST /moderation/cases/open", () => {
  const open = (body: Record<string, string>): Promise<Response> =>
    harness.post("/moderation/cases/open", { entry_id: ENTRY, ...body });

  it("rejects a request without a CSRF token", async () => {
    const res = await harness.post(
      "/moderation/cases/open",
      { entry_id: ENTRY },
      { csrfField: null },
    );
    expect(res.status).toBe(403);
    expect(mockOpenCase).not.toHaveBeenCalled();
  });

  it("opens a case for the session's guild and staff member, and audits it", async () => {
    const before = Date.now();
    const flash = flashOf(
      await open({ review_in_days: "30", note: " watch " }),
    );

    expect(flash).toMatchObject({ path: "/admin/moderation", type: "ok" });
    expect(flash.msg).toBe("Opened case #14.");
    const input = mockOpenCase.mock.calls[0][0];
    expect(input).toMatchObject({
      guildId: "guild-1",
      entryId: ENTRY,
      openedByUserId: "admin-1",
      note: "watch",
    });
    const at = (input.reviewAt as Date).getTime();
    expect(at).toBeGreaterThanOrEqual(before + 30 * DAY);
    expect(at).toBeLessThanOrEqual(Date.now() + 30 * DAY);
    expect(lastAudit()).toMatchObject({
      action: "moderation.case.open",
      targetId: CASE,
      result: "success",
    });
  });

  it("accepts a calendar date, and no date for an indefinite case", async () => {
    await open({ review_at: "2030-05-01" });
    expect((mockOpenCase.mock.calls[0][0].reviewAt as Date).toISOString()).toBe(
      "2030-05-01T09:00:00.000Z",
    );
    await open({});
    expect(mockOpenCase.mock.calls[1][0].reviewAt).toBeNull();
  });

  it.each([
    ["0 days", { review_in_days: "0" }],
    ["too many days", { review_in_days: "99999" }],
    ["non-numeric days", { review_in_days: "soon" }],
    ["a malformed date", { review_at: "1 May" }],
    ["an impossible date", { review_at: "2030-13-45" }],
  ])("rejects %s before touching the service", async (_label, body) => {
    const flash = flashOf(await open(body));
    expect(flash.type).toBe("err");
    expect(mockOpenCase).not.toHaveBeenCalled();
  });

  it("rejects an over-long note", async () => {
    const flash = flashOf(
      await open({ review_in_days: "30", note: "x".repeat(501) }),
    );
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("500");
    expect(mockOpenCase).not.toHaveBeenCalled();
  });

  it("refuses while the case lifecycle is off", async () => {
    mockIsEnabled.mockResolvedValue(false);
    const flash = flashOf(await open({ review_in_days: "30" }));
    expect(flash).toMatchObject({
      type: "err",
      msg: "Moderation cases are turned off.",
    });
    expect(mockOpenCase).not.toHaveBeenCalled();
  });

  it("turns a service refusal into a flash and an audited failure, not a 500", async () => {
    mockOpenCase.mockRejectedValue(
      new MockCaseError(
        "already-has-case",
        "A case is already open for that entry.",
      ),
    );
    const res = await open({ review_in_days: "30" });
    expect(res.status).toBe(303);
    expect(flashOf(res)).toMatchObject({
      type: "err",
      msg: "A case is already open for that entry.",
    });
    expect(lastAudit()).toMatchObject({
      action: "moderation.case.open",
      result: "failure",
      errorMessage: "A case is already open for that entry.",
    });
  });

  it("reports an unexpected failure as a flash that names the cause", async () => {
    mockOpenCase.mockRejectedValue(new Error("mongo down"));
    const res = await open({ review_in_days: "30" });
    expect(res.status).toBe(303);
    expect(flashOf(res)).toMatchObject({ type: "err" });
    expect(flashOf(res).msg).toContain("mongo down");
    expect(lastAudit()).toMatchObject({ result: "failure" });
  });
});

describe("POST /moderation/cases/:id/<decision>", () => {
  const decide = (
    decision: string,
    body: Record<string, string> = {},
  ): Promise<Response> =>
    harness.post(`/moderation/cases/${CASE}/${decision}`, body);

  it.each([
    ["uphold", "upheld"],
    ["extend", "extended"],
    ["permanent", "made permanent"],
    ["readmit", "readmitted"],
  ])(
    "%s calls the service as the session and audits it",
    async (decision, word) => {
      const flash = flashOf(
        await decide(decision, { next_review_in_days: "60", note: "reviewed" }),
      );
      expect(flash).toMatchObject({ path: "/admin/moderation", type: "ok" });
      expect(flash.msg).toBe(`Case #14 ${word}.`);

      expect(mockDecide.mock.calls[0][0]).toMatchObject({
        guildId: "guild-1",
        caseId: CASE,
        decision,
        byUserId: "admin-1",
        note: "reviewed",
      });
      expect(lastAudit()).toMatchObject({
        action: `moderation.case.${decision}`,
        targetId: CASE,
        result: "success",
      });
    },
  );

  it("rejects a request without a CSRF token", async () => {
    const res = await harness.post(
      `/moderation/cases/${CASE}/readmit`,
      {},
      { csrfField: null },
    );
    expect(res.status).toBe(403);
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it("passes no date through when none is given", async () => {
    await decide("permanent");
    expect(mockDecide.mock.calls[0][0].nextReviewAt).toBeNull();
  });

  it("refuses while the case lifecycle is off", async () => {
    mockIsEnabled.mockResolvedValue(false);
    expect(flashOf(await decide("readmit")).type).toBe("err");
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it("flashes an illegal transition instead of returning a 500", async () => {
    mockDecide.mockRejectedValue(
      new MockCaseError("terminal", "Case #14 is already lifted."),
    );
    const res = await decide("readmit");
    expect(res.status).toBe(303);
    expect(flashOf(res)).toMatchObject({
      type: "err",
      msg: "Case #14 is already lifted.",
    });
    expect(lastAudit()).toMatchObject({
      action: "moderation.case.readmit",
      result: "failure",
    });
  });

  it("tells the loser of a race which status the case was found in", async () => {
    mockDecide.mockRejectedValue(
      new MockCaseError("status-changed", "Case #14 was already lifted."),
    );
    expect(flashOf(await decide("permanent")).msg).toBe(
      "Case #14 was already lifted.",
    );
  });
});

describe("POST /moderation/cases/run-review", () => {
  it("runs the review pass and audits it", async () => {
    const flash = flashOf(
      await harness.post("/moderation/cases/run-review", {}),
    );
    expect(flash).toMatchObject({ type: "ok" });
    expect(flash.msg).toContain("2 cases");
    expect(lastAudit()).toMatchObject({
      action: "moderation.case.run_review",
      result: "success",
    });
  });

  it("says so when the feature is off and nothing ran", async () => {
    mockRunNow.mockResolvedValue(null);
    expect(
      flashOf(await harness.post("/moderation/cases/run-review", {})).msg,
    ).toBe("Moderation cases are turned off.");
  });
});
