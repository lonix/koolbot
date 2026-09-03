/**
 * Route-handler tests for the Polls write router (issue #849).
 *
 * The polls router is the largest write router after Settings and was at
 * ~6% coverage. It carries two independent validation ladders — schedules
 * (channel/cron/duration) and the question library (question + 2–10 answers
 * within Discord's 300/55-character caps) — plus the guild scoping that
 * keeps one guild's schedules out of another's reach.
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
const mockCreateSchedule = jest.fn<() => Promise<{ _id: string }>>();
const mockUpdateSchedule = jest.fn<() => Promise<unknown>>();
const mockDeleteSchedule = jest.fn<() => Promise<boolean>>();
const mockGetSchedule = jest.fn<() => Promise<unknown>>();
const mockSetScheduleEnabled = jest.fn<() => Promise<unknown>>();
const mockTestSchedule = jest.fn<() => Promise<void>>();
const mockCreatePollItem = jest.fn<() => Promise<{ _id: string }>>();
const mockUpdatePollItem = jest.fn<() => Promise<unknown>>();
const mockDeletePollItem = jest.fn<() => Promise<boolean>>();
const mockListPollItems =
  jest.fn<() => Promise<Array<Record<string, unknown>>>>();
const mockSetPollItemEnabled = jest.fn<() => Promise<unknown>>();
const mockImportFromString = jest.fn<() => Promise<unknown>>();

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

jest.unstable_mockModule("../../src/services/poll-service.js", () => ({
  PollService: {
    getInstance: (): unknown => ({
      createSchedule: mockCreateSchedule,
      updateSchedule: mockUpdateSchedule,
      deleteSchedule: mockDeleteSchedule,
      getSchedule: mockGetSchedule,
      setScheduleEnabled: mockSetScheduleEnabled,
      testSchedule: mockTestSchedule,
      createPollItem: mockCreatePollItem,
      updatePollItem: mockUpdatePollItem,
      deletePollItem: mockDeletePollItem,
      listPollItems: mockListPollItems,
      setPollItemEnabled: mockSetPollItemEnabled,
      importFromString: mockImportFromString,
    }),
  },
}));

const { createPollsRouter } =
  await import("../../src/web/routes/write/polls.js");
const { requireCsrf } = await import("../../src/web/csrf.js");
const { requireAdminRoleMiddleware } = await import("../../src/web/session.js");

const client = { user: { id: "bot" } } as unknown as Client;
const session = createTestSession();
let harness: AdminHarness;

const SCHEDULE = {
  channelId: "channel-9",
  cron: "0 12 * * 5",
  durationHours: "24",
};
const ITEM = { question: "Best snack?", answers: "Crisps, Chocolate, Fruit" };

beforeEach(async () => {
  jest.clearAllMocks();
  mockCreateSchedule.mockResolvedValue({ _id: "sched-1" });
  mockUpdateSchedule.mockResolvedValue({ _id: "sched-1" });
  mockDeleteSchedule.mockResolvedValue(true);
  mockTestSchedule.mockResolvedValue(undefined);
  mockCreatePollItem.mockResolvedValue({ _id: "item-1" });
  mockUpdatePollItem.mockResolvedValue({ _id: "item-1" });
  mockDeletePollItem.mockResolvedValue(true);
  mockListPollItems.mockResolvedValue([]);
  harness = await startAdminHarness([
    stubRequireSession(session),
    requireAdminRoleMiddleware(),
    requireCsrf,
    createPollsRouter(client),
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

describe("POST /polls/schedules/create", () => {
  it("requires a channel and a cron expression", async () => {
    const res = await harness.post("/polls/schedules/create", {
      durationHours: "24",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/polls");
    expect(flash.msg).toBe("Channel and cron are required.");
    expect(mockCreateSchedule).not.toHaveBeenCalled();
  });

  it.each(["0", "769", "", "lots"])(
    "rejects an out-of-range duration (%s)",
    async (durationHours) => {
      const res = await harness.post("/polls/schedules/create", {
        ...SCHEDULE,
        durationHours,
      });
      expect(parseFlashRedirect(res.headers.get("location")).msg).toBe(
        "Duration must be an integer between 1 and 768 hours.",
      );
      expect(mockCreateSchedule).not.toHaveBeenCalled();
    },
  );

  it("rejects an invalid cron expression", async () => {
    const res = await harness.post("/polls/schedules/create", {
      ...SCHEDULE,
      cron: "every friday",
    });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
      "Invalid cron expression",
    );
    expect(mockCreateSchedule).not.toHaveBeenCalled();
  });

  it("creates an enabled schedule scoped to the session's guild", async () => {
    const res = await harness.post("/polls/schedules/create", {
      ...SCHEDULE,
      pingRoleId: "role-5",
    });
    expect(mockCreateSchedule.mock.calls[0][0]).toMatchObject({
      guildId: session.guildId,
      channelId: "channel-9",
      cronSchedule: "0 12 * * 5",
      pollDuration: 24,
      roleIdToPing: "role-5",
      enabled: true,
      createdBy: session.discordUserId,
    });
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("ok");
    expect(lastAudit()).toMatchObject({
      action: "poll-schedule.create",
      targetId: "sched-1",
      result: "success",
    });
  });

  it("stores a blank ping role as null rather than an empty string", async () => {
    await harness.post("/polls/schedules/create", SCHEDULE);
    expect(mockCreateSchedule.mock.calls[0][0]).toMatchObject({
      roleIdToPing: null,
    });
  });

  it("audits a create that threw", async () => {
    mockCreateSchedule.mockRejectedValue(new Error("cron taken"));
    const res = await harness.post("/polls/schedules/create", SCHEDULE);
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("err");
    expect(lastAudit()).toMatchObject({ result: "failure" });
  });
});

describe("POST /polls/schedules/:id/{edit,delete,toggle,test}", () => {
  it("edits a schedule scoped to the session's guild", async () => {
    const res = await harness.post("/polls/schedules/sched-1/edit", SCHEDULE);
    expect(mockUpdateSchedule).toHaveBeenCalledWith(
      "sched-1",
      {
        channelId: "channel-9",
        cronSchedule: "0 12 * * 5",
        pollDuration: 24,
        roleIdToPing: null,
      },
      session.guildId,
    );
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("ok");
  });

  it("reports an edit that matched no schedule in this guild", async () => {
    mockUpdateSchedule.mockResolvedValue(null);
    const res = await harness.post("/polls/schedules/sched-1/edit", SCHEDULE);
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("err");
    expect(lastAudit()).toMatchObject({
      action: "poll-schedule.edit",
      errorMessage: "not found or wrong guild",
    });
  });

  it("deletes a schedule", async () => {
    const res = await harness.post("/polls/schedules/sched-1/delete");
    expect(mockDeleteSchedule).toHaveBeenCalledWith("sched-1", session.guildId);
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("ok");
  });

  it("refuses to toggle a schedule belonging to another guild", async () => {
    mockGetSchedule.mockResolvedValue({
      _id: "sched-1",
      guildId: "another-guild",
      enabled: true,
    });
    const res = await harness.post("/polls/schedules/sched-1/toggle");
    expect(mockSetScheduleEnabled).not.toHaveBeenCalled();
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("err");
    expect(lastAudit()).toMatchObject({
      errorMessage: "not found or wrong guild",
    });
  });

  it("flips a schedule's enabled flag", async () => {
    mockGetSchedule.mockResolvedValue({
      _id: "sched-1",
      guildId: session.guildId,
      enabled: true,
    });
    mockSetScheduleEnabled.mockResolvedValue({ _id: "sched-1" });
    const res = await harness.post("/polls/schedules/sched-1/toggle");
    expect(mockSetScheduleEnabled).toHaveBeenCalledWith(
      "sched-1",
      false,
      session.guildId,
    );
    expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
      "disabled",
    );
  });

  it("refuses to test-fire a schedule from another guild", async () => {
    mockGetSchedule.mockResolvedValue({
      _id: "sched-1",
      guildId: "another-guild",
    });
    const res = await harness.post("/polls/schedules/sched-1/test");
    expect(mockTestSchedule).not.toHaveBeenCalled();
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("err");
  });

  it("posts a test poll and audits it", async () => {
    mockGetSchedule.mockResolvedValue({
      _id: "sched-1",
      guildId: session.guildId,
    });
    const res = await harness.post("/polls/schedules/sched-1/test");
    expect(mockTestSchedule).toHaveBeenCalledWith("sched-1");
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("ok");
    expect(lastAudit()).toMatchObject({
      action: "poll-schedule.test",
      result: "success",
    });
  });

  it("turns a failed test into a flash", async () => {
    mockGetSchedule.mockResolvedValue({
      _id: "sched-1",
      guildId: session.guildId,
    });
    mockTestSchedule.mockRejectedValue(new Error("no questions available"));
    const res = await harness.post("/polls/schedules/sched-1/test");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("no questions available");
  });
});

describe("POST /polls/items/create", () => {
  it("requires a question", async () => {
    const res = await harness.post("/polls/items/create", {
      answers: "a, b",
    });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toBe(
      "Question is required.",
    );
    expect(mockCreatePollItem).not.toHaveBeenCalled();
  });

  it("rejects a question past Discord's 300-character cap", async () => {
    const res = await harness.post("/polls/items/create", {
      ...ITEM,
      question: "q".repeat(301),
    });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toBe(
      "Question must be 300 characters or fewer.",
    );
  });

  it.each([
    ["one answer", "just one"],
    ["eleven answers", "a,b,c,d,e,f,g,h,i,j,k"],
  ])("rejects %s", async (_label, answers) => {
    const res = await harness.post("/polls/items/create", {
      ...ITEM,
      answers,
    });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toBe(
      "Provide 2–10 comma-separated answers.",
    );
    expect(mockCreatePollItem).not.toHaveBeenCalled();
  });

  it("rejects an answer past Discord's 55-character cap", async () => {
    const res = await harness.post("/polls/items/create", {
      ...ITEM,
      answers: `ok, ${"x".repeat(56)}`,
    });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toBe(
      "Each answer must be 55 characters or fewer.",
    );
  });

  it("splits and trims answers and tags, defaulting multiSelect off", async () => {
    const res = await harness.post("/polls/items/create", {
      ...ITEM,
      tags: " food , fun , ",
    });
    expect(mockCreatePollItem.mock.calls[0][0]).toMatchObject({
      guildId: session.guildId,
      question: "Best snack?",
      answers: ["Crisps", "Chocolate", "Fruit"],
      tags: ["food", "fun"],
      multiSelect: false,
      enabled: true,
      source: "manual",
      createdBy: session.discordUserId,
    });
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("ok");
    expect(lastAudit()).toMatchObject({
      action: "poll-item.create",
      targetId: "item-1",
      details: { answerCount: 3, tagCount: 2, multiSelect: false },
    });
  });

  it("records a checked multiSelect box", async () => {
    await harness.post("/polls/items/create", { ...ITEM, multiSelect: "on" });
    expect(mockCreatePollItem.mock.calls[0][0]).toMatchObject({
      multiSelect: true,
    });
  });
});

describe("POST /polls/items/:id/{edit,delete,toggle}", () => {
  it("applies the same answer validation on edit", async () => {
    const res = await harness.post("/polls/items/item-1/edit", {
      question: "Q",
      answers: "only-one",
    });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toBe(
      "Provide 2–10 comma-separated answers.",
    );
    expect(mockUpdatePollItem).not.toHaveBeenCalled();
  });

  it("edits a question scoped to the session's guild", async () => {
    const res = await harness.post("/polls/items/item-1/edit", ITEM);
    expect(mockUpdatePollItem).toHaveBeenCalled();
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("ok");
  });

  it("deletes a question", async () => {
    const res = await harness.post("/polls/items/item-1/delete");
    expect(mockDeletePollItem).toHaveBeenCalledWith("item-1", session.guildId);
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("ok");
    expect(lastAudit()).toMatchObject({
      action: "poll-item.delete",
      result: "success",
    });
  });

  it("reports a delete that matched nothing", async () => {
    mockDeletePollItem.mockResolvedValue(false);
    const res = await harness.post("/polls/items/item-1/delete");
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("err");
    expect(lastAudit()).toMatchObject({
      errorMessage: "not found or wrong guild",
    });
  });

  it("only toggles a question listed for this guild", async () => {
    mockListPollItems.mockResolvedValue([{ _id: "other", enabled: true }]);
    const res = await harness.post("/polls/items/item-1/toggle");
    expect(mockSetPollItemEnabled).not.toHaveBeenCalled();
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("err");
  });

  it("flips a question's enabled flag", async () => {
    mockListPollItems.mockResolvedValue([{ _id: "item-1", enabled: false }]);
    mockSetPollItemEnabled.mockResolvedValue({ _id: "item-1" });
    const res = await harness.post("/polls/items/item-1/toggle");
    expect(mockSetPollItemEnabled).toHaveBeenCalledWith(
      "item-1",
      true,
      session.guildId,
    );
    expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
      "enabled",
    );
  });
});

describe("POST /polls/items/import-text", () => {
  it("requires some content to import", async () => {
    const res = await harness.post("/polls/items/import-text", {});
    expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
      "Paste some YAML or JSON",
    );
    expect(mockImportFromString).not.toHaveBeenCalled();
  });

  it("reports a clean import as success", async () => {
    mockImportFromString.mockResolvedValue({
      imported: 4,
      skipped: 1,
      errors: [],
    });
    const res = await harness.post("/polls/items/import-text", {
      content: "- question: hi",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("ok");
    expect(flash.msg).toBe("Imported 4, skipped 1, errors 0.");
    expect(mockImportFromString).toHaveBeenCalledWith(
      "- question: hi",
      session.guildId,
      session.discordUserId,
      "paste",
    );
    expect(lastAudit()).toMatchObject({
      action: "poll-item.import",
      result: "success",
      details: { source: "paste", imported: 4 },
    });
  });

  it("warns when some rows imported and some errored", async () => {
    mockImportFromString.mockResolvedValue({
      imported: 2,
      skipped: 0,
      errors: ["row 3 bad"],
    });
    const res = await harness.post("/polls/items/import-text", {
      content: "x",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("warn");
    expect(flash.msg).toContain("First error: row 3 bad");
    expect(lastAudit()).toMatchObject({ result: "success" });
  });

  it("fails when nothing imported and everything errored", async () => {
    mockImportFromString.mockResolvedValue({
      imported: 0,
      skipped: 0,
      errors: ["bad yaml"],
    });
    const res = await harness.post("/polls/items/import-text", {
      content: "x",
    });
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("err");
    expect(lastAudit()).toMatchObject({ result: "failure" });
  });

  it("turns a thrown import into a flash", async () => {
    mockImportFromString.mockRejectedValue(new Error("unparseable"));
    const res = await harness.post("/polls/items/import-text", {
      content: "x",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("unparseable");
  });
});
