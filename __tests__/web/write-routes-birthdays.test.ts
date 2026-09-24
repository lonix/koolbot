/**
 * Route-handler tests for the Birthdays write router (#986): the edit
 * validation ladder, that an admin edit never creates an entry or leaks the
 * birth year into the audit log, that remove goes through the #916 purge
 * rather than a raw delete, and the run-now outcomes.
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
const mockEditBirthday = jest.fn<() => Promise<unknown>>();
const mockPurgeForUser = jest.fn<() => Promise<Record<string, unknown>>>();
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

jest.unstable_mockModule("../../src/services/birthday-service.js", () => ({
  BirthdayService: {
    getInstance: (): unknown => ({
      editBirthday: mockEditBirthday,
      purgeForUser: mockPurgeForUser,
      runNow: mockRunNow,
    }),
  },
}));

const { createBirthdaysRouter } =
  await import("../../src/web/routes/write/birthdays.js");
const { requireCsrf } = await import("../../src/web/csrf.js");
const { requireAdminRoleMiddleware } = await import("../../src/web/session.js");

const client = { user: { id: "bot" } } as unknown as Client;
const session = createTestSession();
let harness: AdminHarness;

const MEMBER = "111111111111111111";

const CLEAN_PURGE = {
  matched: 1,
  removed: 1,
  roleRevoked: false,
  announcementsAttempted: 0,
  announcementsDeleted: 0,
  announcementsFailed: 0,
};

beforeEach(async () => {
  jest.clearAllMocks();
  mockEditBirthday.mockResolvedValue({
    before: { month: 6, day: 15, year: 1990 },
    after: { month: 6, day: 16, year: 1990 },
  });
  mockPurgeForUser.mockResolvedValue(CLEAN_PURGE);
  mockRunNow.mockResolvedValue({
    ranAt: new Date(),
    candidates: 3,
    announced: 1,
    rolesGranted: 1,
    rolesRemoved: 0,
    failed: 0,
  });
  harness = await startAdminHarness([
    stubRequireSession(session),
    requireAdminRoleMiddleware(),
    requireCsrf,
    createBirthdaysRouter(client),
  ]);
});

afterEach(async () => {
  await harness.close();
});

function lastAudit(): Record<string, unknown> {
  const calls = mockRecordAudit.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][1] as Record<string, unknown>;
}

describe("POST /birthdays/:userId/edit", () => {
  const edit = (
    body: Record<string, string>,
    userId = MEMBER,
  ): Promise<Response> => harness.post(`/birthdays/${userId}/edit`, body);

  it("rejects a request without a CSRF token", async () => {
    const res = await harness.post(
      `/birthdays/${MEMBER}/edit`,
      { month: "6", day: "16" },
      { csrfField: null },
    );
    expect(res.status).toBe(403);
    expect(mockEditBirthday).not.toHaveBeenCalled();
  });

  it("rejects a member id that isn't a snowflake", async () => {
    const flash = parseFlashRedirect(
      (await edit({ month: "6", day: "16" }, "bob")).headers.get("location"),
    );
    expect(flash).toMatchObject({ path: "/admin/birthdays", type: "err" });
    expect(flash.msg).toContain("Discord user ID");
    expect(mockEditBirthday).not.toHaveBeenCalled();
  });

  it("requires a month and a day in range", async () => {
    for (const body of [
      { month: "", day: "16" },
      { month: "13", day: "16" },
      { month: "6", day: "0" },
    ]) {
      const flash = parseFlashRedirect(
        (await edit(body)).headers.get("location"),
      );
      expect(flash.msg).toBe("Choose a month and a day.");
    }
    expect(mockEditBirthday).not.toHaveBeenCalled();
  });

  it("refuses to create an entry the member never set", async () => {
    mockEditBirthday.mockResolvedValue(null);
    const flash = parseFlashRedirect(
      (await edit({ month: "6", day: "16" })).headers.get("location"),
    );
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("No birthday is stored");
    expect(lastAudit()).toMatchObject({
      action: "birthday.edit",
      result: "failure",
      errorMessage: "not found",
    });
  });

  it("reports a database outage as a failure, not a missing entry", async () => {
    mockEditBirthday.mockRejectedValue(new Error("db down"));
    const flash = parseFlashRedirect(
      (await edit({ month: "6", day: "16" })).headers.get("location"),
    );
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("Failed to update");
    expect(flash.msg).toContain("db down");
    expect(flash.msg).not.toContain("No birthday is stored");
    expect(lastAudit()).toMatchObject({
      result: "failure",
      errorMessage: "db down",
    });
  });

  it("saves the date in the session's guild and audits without the year", async () => {
    const flash = parseFlashRedirect(
      (await edit({ month: "6", day: "16" })).headers.get("location"),
    );
    expect(flash).toMatchObject({ type: "ok", path: "/admin/birthdays" });
    expect(mockEditBirthday).toHaveBeenCalledWith(MEMBER, "guild-1", {
      month: 6,
      day: 16,
      clearYear: false,
    });
    const audit = lastAudit();
    expect(audit).toMatchObject({
      action: "birthday.edit",
      targetId: MEMBER,
      result: "success",
      details: {
        before: { month: 6, day: 15, hasYear: true },
        after: { month: 6, day: 16, hasYear: true },
      },
    });
    expect(JSON.stringify(audit)).not.toContain("1990");
  });

  it("passes clear_year through and says the year was removed", async () => {
    mockEditBirthday.mockResolvedValue({
      before: { month: 6, day: 15, year: 1990 },
      after: { month: 6, day: 16, year: null },
    });
    const flash = parseFlashRedirect(
      (await edit({ month: "6", day: "16", clear_year: "1" })).headers.get(
        "location",
      ),
    );
    expect(mockEditBirthday).toHaveBeenCalledWith(MEMBER, "guild-1", {
      month: 6,
      day: 16,
      clearYear: true,
    });
    expect(flash.msg).toContain("removed the birth year");
    expect(lastAudit()).toMatchObject({
      details: { after: { hasYear: false } },
    });
  });

  it("reports a service validation error", async () => {
    mockEditBirthday.mockRejectedValue(
      new Error('"4/31" is not a valid month/day'),
    );
    const flash = parseFlashRedirect(
      (await edit({ month: "4", day: "31" })).headers.get("location"),
    );
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("not a valid month/day");
    expect(lastAudit()).toMatchObject({ result: "failure" });
  });
});

describe("POST /birthdays/:userId/remove", () => {
  const remove = (userId = MEMBER): Promise<Response> =>
    harness.post(`/birthdays/${userId}/remove`, {});

  it("rejects a request without a CSRF token", async () => {
    const res = await harness.post(
      `/birthdays/${MEMBER}/remove`,
      {},
      { csrfField: null },
    );
    expect(res.status).toBe(403);
    expect(mockPurgeForUser).not.toHaveBeenCalled();
  });

  it("rejects a member id that isn't a snowflake", async () => {
    const flash = parseFlashRedirect(
      (await remove("bob")).headers.get("location"),
    );
    expect(flash.type).toBe("err");
    expect(mockPurgeForUser).not.toHaveBeenCalled();
  });

  it("removes through the #916 purge, not a raw delete", async () => {
    mockPurgeForUser.mockResolvedValue({
      ...CLEAN_PURGE,
      roleRevoked: true,
      announcementsAttempted: 2,
      announcementsDeleted: 2,
    });
    const flash = parseFlashRedirect((await remove()).headers.get("location"));
    expect(mockPurgeForUser).toHaveBeenCalledWith("guild-1", MEMBER);
    expect(flash.type).toBe("ok");
    expect(flash.msg).toBe(
      `Removed ${MEMBER}'s birthday and took back the birthday role and deleted 2 birthday posts.`,
    );
    expect(lastAudit()).toMatchObject({
      action: "birthday.remove",
      targetId: MEMBER,
      result: "success",
      details: { removed: 1, roleRevoked: true, announcementsDeleted: 2 },
    });
  });

  it("reports an unknown member as not found", async () => {
    mockPurgeForUser.mockResolvedValue({
      ...CLEAN_PURGE,
      matched: 0,
      removed: 0,
    });
    const flash = parseFlashRedirect((await remove()).headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("No birthday is stored");
    expect(lastAudit()).toMatchObject({ errorMessage: "not found" });
  });

  it("reports an incomplete purge as a failure, not a removal", async () => {
    mockPurgeForUser.mockResolvedValue({
      ...CLEAN_PURGE,
      removed: 0,
      announcementsAttempted: 1,
      announcementsFailed: 1,
      error: "1 birthday announcement(s) could not be deleted",
    });
    const flash = parseFlashRedirect((await remove()).headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("Could not fully remove");
    expect(flash.msg).toContain("could not be deleted");
    expect(lastAudit()).toMatchObject({
      result: "failure",
      details: { announcementsFailed: 1 },
    });
  });

  it("treats a read failure (no match, but an error) as a failure", async () => {
    mockPurgeForUser.mockResolvedValue({
      ...CLEAN_PURGE,
      matched: 0,
      removed: 0,
      error: "db down",
    });
    const flash = parseFlashRedirect((await remove()).headers.get("location"));
    expect(flash.msg).toContain("db down");
  });
});

describe("POST /birthdays/run-now", () => {
  it("rejects a request without a CSRF token", async () => {
    const res = await harness.post(
      "/birthdays/run-now",
      {},
      { csrfField: null },
    );
    expect(res.status).toBe(403);
    expect(mockRunNow).not.toHaveBeenCalled();
  });

  it("runs the scheduled check and reports the summary", async () => {
    const flash = parseFlashRedirect(
      (await harness.post("/birthdays/run-now", {})).headers.get("location"),
    );
    expect(mockRunNow).toHaveBeenCalledTimes(1);
    expect(flash).toMatchObject({ type: "ok", path: "/admin/birthdays" });
    expect(flash.msg).toContain("1 announced");
    expect(lastAudit()).toMatchObject({
      action: "birthday.run-now",
      result: "success",
      details: { announced: 1, rolesGranted: 1 },
    });
  });

  it("warns when the run did not happen", async () => {
    mockRunNow.mockResolvedValue(null);
    const flash = parseFlashRedirect(
      (await harness.post("/birthdays/run-now", {})).headers.get("location"),
    );
    expect(flash.type).toBe("warn");
    expect(flash.msg).toContain("did not run");
    expect(lastAudit()).toMatchObject({ result: "failure" });
  });

  it("warns and audits a failure when members failed", async () => {
    mockRunNow.mockResolvedValue({
      ranAt: new Date(),
      candidates: 3,
      announced: 1,
      rolesGranted: 0,
      rolesRemoved: 0,
      failed: 2,
    });
    const flash = parseFlashRedirect(
      (await harness.post("/birthdays/run-now", {})).headers.get("location"),
    );
    expect(flash.type).toBe("warn");
    expect(lastAudit()).toMatchObject({
      result: "failure",
      errorMessage: "2 member(s) failed",
    });
  });

  it("reports a thrown run as an error", async () => {
    mockRunNow.mockRejectedValue(new Error("gateway down"));
    const flash = parseFlashRedirect(
      (await harness.post("/birthdays/run-now", {})).headers.get("location"),
    );
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("gateway down");
  });
});
