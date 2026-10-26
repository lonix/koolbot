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
const { registerFormPage } = await import("../../src/web/form-pages.js");
const { renderPollsPage } = await import("../../src/web/admin-views.js");
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

// The read router registers the page's renderer in the app (#1517); here the
// real view stands in, with one stored schedule and question to edit, so a
// refusal is checked as the markup the person gets.
const registerPage = (): void =>
  registerFormPage("/admin/polls", async (_req, refused) =>
    renderPollsPage({
      guildId: "guild-1",
      csrfToken: "csrf",
      remainingMs: 1000,
      navFeatureStatus: {},
      enabled: true,
      defaultDurationHours: 24,
      cooldownDays: 7,
      settingRows: [],
      textChannels: [
        { id: "channel-9", name: "general", type: 0 },
        { id: "channel-3", name: "random", type: 0 },
      ],
      roles: [{ id: "role-5", name: "Pollsters" }],
      schedules: [
        {
          id: "sched-1",
          channelId: "channel-9",
          channelName: "general",
          channelType: 0,
          cron: "0 12 * * 5",
          durationHours: 24,
          pingRoleId: null,
          pingRoleName: null,
          enabled: true,
          lastRun: "—",
        },
      ],
      items: [
        {
          id: "item-1",
          question: "Stored question?",
          answers: ["Yes", "No"],
          tags: ["fun"],
          multiSelect: false,
          usageCount: 0,
          lastUsed: "—",
          enabled: true,
          source: "manual",
        },
      ],
      refusedForm: refused,
    }),
  );

/** A refused form: 422 with the page, the marked fields and each error line. */
async function refusal(res: Response): Promise<{
  html: string;
  invalidIds: string[];
  errorLines: Record<string, string>;
}> {
  expect(res.status).toBe(422);
  const html = await res.text();
  const invalidIds = [...html.matchAll(/<[^>]*aria-invalid="true"[^>]*>/g)].map(
    (m) => /id="([^"]+)"/.exec(m[0])?.[1] ?? "",
  );
  const errorLines: Record<string, string> = {};
  for (const m of html.matchAll(
    /<p class="kb-field__error" id="([^"]+)">([^<]*)<\/p>/g,
  )) {
    errorLines[m[1]] = m[2];
  }
  return { html, invalidIds, errorLines };
}

beforeEach(async () => {
  jest.clearAllMocks();
  registerPage();
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
  it("refuses a missing channel and cron and marks both", async () => {
    const res = await harness.post("/polls/schedules/create", {
      durationHours: "24",
    });
    const r = await refusal(res);
    expect(r.invalidIds).toEqual([
      "poll-schedule-create-channelId",
      "poll-schedule-create-cron",
    ]);
    expect(r.errorLines["poll-schedule-create-channelId-error"]).toBe(
      "Pick a channel.",
    );
    expect(mockCreateSchedule).not.toHaveBeenCalled();
  });

  it.each([
    ["0", "Use 1 to 768 hours."],
    ["769", "Use 1 to 768 hours."],
    ["", "Enter a whole number of hours, from 1 to 768."],
    ["lots", "Enter a whole number of hours, from 1 to 768."],
  ])(
    "refuses an out-of-range duration (%s) and keeps it",
    async (durationHours, message) => {
      const res = await harness.post("/polls/schedules/create", {
        ...SCHEDULE,
        durationHours,
      });
      const r = await refusal(res);
      expect(r.invalidIds).toEqual(["poll-schedule-create-durationHours"]);
      expect(r.errorLines["poll-schedule-create-durationHours-error"]).toBe(
        message,
      );
      expect(r.html).toContain(
        `value="${durationHours}" required id="poll-schedule-create-durationHours"`,
      );
      expect(mockCreateSchedule).not.toHaveBeenCalled();
    },
  );

  it("refuses an invalid cron expression, keeping the typed cron, channel and ping role", async () => {
    const res = await harness.post("/polls/schedules/create", {
      ...SCHEDULE,
      channelId: "channel-3",
      cron: "every <friday>",
      pingRoleId: "role-5",
    });
    const r = await refusal(res);
    expect(r.invalidIds).toEqual(["poll-schedule-create-cron"]);
    expect(r.html).toContain('value="every &lt;friday&gt;"');
    expect(r.html).toContain('<option value="channel-3" selected>');
    expect(r.html).toContain('<option value="role-5" selected>');
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
  it("falls back to the not-found flash when the refused row no longer exists", async () => {
    mockGetSchedule.mockResolvedValue(null);
    const res = await harness.post("/polls/schedules/gone/edit", {
      ...SCHEDULE,
      cron: "bad cron",
    });
    expect(res.status).toBe(303);
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toBe("Schedule gone not found.");
    expect(mockUpdateSchedule).not.toHaveBeenCalled();
  });

  it("refuses a bad edit, reopens that row's form and keeps what was typed", async () => {
    mockGetSchedule.mockResolvedValue({ guildId: "guild-1" });
    const res = await harness.post("/polls/schedules/sched-1/edit", {
      ...SCHEDULE,
      cron: "bad cron",
      durationHours: "5",
    });
    const r = await refusal(res);
    expect(r.invalidIds).toEqual(["poll-schedule-edit-sched-1-cron"]);
    // The details element holding the refused form is open, or the marked
    // field would be hidden and could not take focus.
    expect(r.html).toContain(
      '<details class="helper edit-details" open><summary>Edit</summary>',
    );
    expect(r.html).toContain('value="bad cron"');
    expect(r.html).toContain('value="5"');
    expect(mockUpdateSchedule).not.toHaveBeenCalled();
  });

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
  it("keeps a refused cron exactly as typed", async () => {
    const res = await harness.post("/polls/schedules/create", {
      ...SCHEDULE,
      cron: "  bad cron  ",
    });
    const r = await refusal(res);
    expect(r.html).toContain('value="  bad cron  "');
  });

  it("refuses a missing question, keeping the answers and tags", async () => {
    const res = await harness.post("/polls/items/create", {
      answers: "a, b",
      tags: "x, y",
      multiSelect: "1",
    });
    const r = await refusal(res);
    expect(r.invalidIds).toEqual(["poll-item-create-question"]);
    expect(r.errorLines["poll-item-create-question-error"]).toBe(
      "Enter the question.",
    );
    expect(r.html).toContain('value="a, b"');
    expect(r.html).toContain('value="x, y"');
    expect(r.html).toMatch(/name="multiSelect" value="1" checked/);
    expect(mockCreatePollItem).not.toHaveBeenCalled();
  });

  it("refuses a question past Discord's 300-character cap", async () => {
    const res = await harness.post("/polls/items/create", {
      ...ITEM,
      question: "q".repeat(301),
    });
    const r = await refusal(res);
    expect(r.errorLines["poll-item-create-question-error"]).toBe(
      "At most 300 characters.",
    );
  });

  it.each([
    ["one answer", "just one"],
    ["eleven answers", "a,b,c,d,e,f,g,h,i,j,k"],
  ])("refuses %s", async (_label, answers) => {
    const res = await harness.post("/polls/items/create", {
      ...ITEM,
      answers,
    });
    const r = await refusal(res);
    expect(r.invalidIds).toEqual(["poll-item-create-answers"]);
    expect(r.errorLines["poll-item-create-answers-error"]).toBe(
      "Give 2 to 10 answers, separated by commas.",
    );
    expect(mockCreatePollItem).not.toHaveBeenCalled();
  });

  it("refuses an answer past Discord's 55-character cap", async () => {
    const res = await harness.post("/polls/items/create", {
      ...ITEM,
      answers: `ok, ${"x".repeat(56)}`,
    });
    const r = await refusal(res);
    expect(r.errorLines["poll-item-create-answers-error"]).toBe(
      "Each answer is at most 55 characters.",
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
  it("falls back to the not-found flash when the refused question no longer exists", async () => {
    mockListPollItems.mockResolvedValue([]);
    const res = await harness.post("/polls/items/gone/edit", {
      question: "Q",
      answers: "only-one",
    });
    expect(res.status).toBe(303);
    expect(parseFlashRedirect(res.headers.get("location")).msg).toBe(
      "Question gone not found.",
    );
  });

  it("keeps question text exactly as typed when refusing", async () => {
    mockListPollItems.mockResolvedValue([{ _id: "item-1" }]);
    const res = await harness.post("/polls/items/item-1/edit", {
      question: "  Q?  ",
      answers: " only-one ",
    });
    const r = await refusal(res);
    expect(r.html).toContain('value="  Q?  "');
    expect(r.html).toContain('value=" only-one "');
  });

  it("applies the same answer validation on edit, in that row's open form", async () => {
    mockListPollItems.mockResolvedValue([{ _id: "item-1" }]);
    const res = await harness.post("/polls/items/item-1/edit", {
      question: "Q",
      answers: "only-one",
    });
    const r = await refusal(res);
    expect(r.invalidIds).toEqual(["poll-item-edit-item-1-answers"]);
    expect(r.errorLines["poll-item-edit-item-1-answers-error"]).toBe(
      "Give 2 to 10 answers, separated by commas.",
    );
    expect(r.html).toContain(
      '<details class="helper edit-details" open><summary>Edit</summary>',
    );
    expect(r.html).toContain('value="only-one"');
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
