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
    MAX_REVIEW_DAYS: 3650,
    ModerationCaseService: {
      getInstance: (): unknown => ({
        isEnabled: mockIsEnabled,
        isEnabledStrict: mockIsEnabled,
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
const { registerFormPage } = await import("../../src/web/form-pages.js");
const { renderModerationPage } = await import("../../src/web/admin-views.js");
const { requireAdminRoleMiddleware } = await import("../../src/web/session.js");

const client = { user: { id: "bot" } } as unknown as Client;
const session = createTestSession();
let harness: AdminHarness;

const ENTRY = "a".repeat(24);
const CASE = "b".repeat(24);
const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  jest.clearAllMocks();
  // No page to draw a refusal on, unless a test registers one: the flash.
  registerFormPage("/admin/moderation", async () => {
    throw new Error("page unavailable");
  });
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
    ["a numeric prefix", { review_in_days: "30days" }],
    ["fractional days", { review_in_days: "1.5" }],
    ["a day that does not exist", { review_at: "2030-02-31" }],
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
    ["uphold", "kept out for now."],
    ["extend", "put off to the new review date."],
    ["permanent", "kept out for good. It is not reviewed again."],
    ["readmit", "closed: the member was let back in."],
  ])(
    "%s calls the service as the session and audits it",
    async (decision, word) => {
      const flash = flashOf(
        await decide(decision, { next_review_in_days: "60", note: "reviewed" }),
      );
      expect(flash).toMatchObject({ path: "/admin/moderation", type: "ok" });
      expect(flash.msg).toBe(`Case #14 ${word}`);

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
      new MockCaseError("terminal", "Case #14 is already closed: let back in."),
    );
    const res = await decide("readmit");
    expect(res.status).toBe(303);
    expect(flashOf(res)).toMatchObject({
      type: "err",
      msg: "Case #14 is already closed: let back in.",
    });
    expect(lastAudit()).toMatchObject({
      action: "moderation.case.readmit",
      result: "failure",
    });
  });

  it("tells the loser of a race which status the case was found in", async () => {
    mockDecide.mockRejectedValue(
      new MockCaseError(
        "status-changed",
        'Case #14 changed while you were looking: it is now "let back in".',
      ),
    );
    expect(flashOf(await decide("permanent")).msg).toBe(
      'Case #14 changed while you were looking: it is now "let back in".',
    );
  });
});

describe("a refused case form (#1523)", () => {
  // The read router registers the page's renderer in the app; here the real
  // view stands in with one kick in the log and one case waiting for a decision.
  const registerPage = (pageNumber = 1): void =>
    registerFormPage("/admin/moderation", async (req, refused) => {
      // The real renderer takes the log's query from `view_query`.
      const query = new URLSearchParams(
        String((req.body as Record<string, unknown>)?.view_query ?? ""),
      );
      return renderModerationPage({
        guildId: "guild-1",
        csrfToken: "csrf",
        remainingMs: 1000,
        navFeatureStatus: {},
        enabled: true,
        actionOptions: ["kick", "ban"],
        userOptions: [],
        filters: { action: query.get("action") ?? "", userId: "" },
        rows: [
          {
            entryId: ENTRY,
            caseNumber: null,
            caseStatus: null,
            createdAt: "2026-01-01 10:00",
            userId: "1",
            userLabel: "Alice",
            moderatorId: null,
            moderatorLabel: null,
            action: "kick",
            reason: null,
            source: "command",
          },
        ],
        total: 100,
        page: pageNumber,
        pageSize: 50,
        casesEnabled: true,
        defaultReviewDays: 90,
        caseGroups: {
          overdue: [
            {
              id: CASE,
              caseNumber: 14,
              userId: "1",
              userLabel: "Alice",
              action: "kick",
              status: "under_review",
              reviewAt: null,
              openedAt: "2026-01-01T10:00:00.000Z",
              openedByLabel: "Mod",
              originModeratorLabel: null,
              reason: null,
              events: [],
              history: [],
              live: true,
            },
          ],
          dueSoon: [],
          scheduled: [],
          indefinite: [],
          recentlyResolved: [],
        },
        settingRows: [],
        refusedForm: refused,
      });
    });
  beforeEach(() => registerPage());

  const lines = (html: string): Record<string, string> =>
    Object.fromEntries(
      [
        ...html.matchAll(
          /<p class="kb-field__error" id="([^"]+)">([^<]*)<\/p>/g,
        ),
      ].map((m) => [m[1], m[2]]),
    );

  it("opens the row's Open case form with the days marked and the typed note kept", async () => {
    const res = await harness.post("/moderation/cases/open", {
      entry_id: ENTRY,
      review_in_days: " 0",
      note: " keep me ",
    });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain(
      '<details class="helper edit-details" open><summary>Open case</summary>',
    );
    expect(html).toContain(
      `<input type="number" name="review_in_days" min="1" max="3650" value=" 0" id="moderation-case-open-${ENTRY}-review_in_days" aria-invalid="true" aria-describedby="moderation-case-open-${ENTRY}-review_in_days-error">`,
    );
    expect(lines(html)).toEqual({
      [`moderation-case-open-${ENTRY}-review_in_days-error`]:
        "Review days must be a whole number from 1 to 3650.",
    });
    expect(html).toContain('value=" keep me "');
    expect(mockOpenCase).not.toHaveBeenCalled();
  });

  it("marks an over-long note and keeps the cleared days", async () => {
    const res = await harness.post("/moderation/cases/open", {
      entry_id: ENTRY,
      review_in_days: "",
      note: "x".repeat(501),
    });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(Object.keys(lines(html))).toEqual([
      `moderation-case-open-${ENTRY}-note-error`,
    ]);
    // Cleared days mean "no review date" and stay cleared.
    expect(html).toMatch(/name="review_in_days"[^>]* value="" id=/);
  });

  it("hands the page's own query back, so the refused row is on the page it drew", async () => {
    // The row is on page 2 of the ban log; the POST has no query of its own.
    const res = await harness.post("/moderation/cases/open", {
      entry_id: ENTRY,
      review_in_days: "0",
      view_query: "?action=kick&page=2",
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain(
      "moderation-case-open-" + ENTRY + "-review_in_days-error",
    );
  });

  it("answers the flash for a log row that is no longer on the page", async () => {
    const res = await harness.post("/moderation/cases/open", {
      entry_id: "f".repeat(24),
      review_in_days: "0",
    });
    expect(res.status).toBe(303);
    expect(flashOf(res).msg).toBe(
      "Not saved. Review days must be a whole number from 1 to 3650.",
    );
  });

  it("keeps cases being off a flash even when a field is wrong", async () => {
    mockIsEnabled.mockResolvedValue(false);
    const res = await harness.post("/moderation/cases/open", {
      entry_id: ENTRY,
      review_in_days: "0",
    });
    expect(res.status).toBe(303);
    expect(flashOf(res).msg).toBe("Moderation cases are turned off.");
  });

  it.each(["uphold", "extend", "permanent", "readmit"])(
    "marks the %s decision's days and note in the case's form and audits the refusal",
    async (decision) => {
      const res = await harness.post(`/moderation/cases/${CASE}/${decision}`, {
        next_review_in_days: "5000",
        note: "x".repeat(501),
      });
      expect(res.status).toBe(422);
      const html = await res.text();
      expect(Object.keys(lines(html))).toEqual(
        [
          `moderation-case-decide-${CASE}-note-error`,
          `moderation-case-decide-${CASE}-next_review_in_days-error`,
        ].sort((a, b) => html.indexOf(a) - html.indexOf(b)),
      );
      expect(html).toContain('value="5000"');
      expect(mockDecide).not.toHaveBeenCalled();
      expect(lastAudit()).toMatchObject({
        action: `moderation.case.${decision}`,
        targetId: CASE,
        result: "failure",
        errorMessage: "Note must be 500 characters or fewer.",
      });
    },
  );

  it("lets a switched-off case lifecycle outrank a wrong field on a decision", async () => {
    mockIsEnabled.mockResolvedValue(false);
    const res = await harness.post(`/moderation/cases/${CASE}/uphold`, {
      next_review_in_days: "0",
    });
    expect(res.status).toBe(303);
    expect(flashOf(res).msg).toBe("Moderation cases are turned off.");
    expect(lastAudit()).toMatchObject({ result: "failure" });
  });

  it("leaves a case that is gone from the page to the flash", async () => {
    const res = await harness.post(
      `/moderation/cases/${"c".repeat(24)}/uphold`,
      {
        next_review_in_days: "0",
      },
    );
    expect(res.status).toBe(303);
    expect(flashOf(res).msg).toBe(
      "Not saved. Review days must be a whole number from 1 to 3650.",
    );
  });
});

describe("POST /moderation/cases/run-review", () => {
  it("runs the review pass and audits it", async () => {
    const flash = flashOf(
      await harness.post("/moderation/cases/run-review", {}),
    );
    expect(flash).toMatchObject({ type: "ok" });
    expect(flash.msg).toBe("Check done: 2 cases now need a decision.");
    expect(lastAudit()).toMatchObject({
      action: "moderation.case.run_review",
      result: "success",
    });
  });

  it("says one case needs a decision in the singular", async () => {
    mockRunNow.mockResolvedValue({ due: 1, flipped: 1, notified: false });
    expect(
      flashOf(await harness.post("/moderation/cases/run-review", {})).msg,
    ).toBe("Check done: 1 case now needs a decision.");
  });

  it("says so when the feature is off and nothing ran", async () => {
    mockRunNow.mockResolvedValue(null);
    expect(
      flashOf(await harness.post("/moderation/cases/run-review", {})).msg,
    ).toBe("Moderation cases are turned off.");
  });
});
