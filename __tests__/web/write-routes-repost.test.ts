/**
 * Route tests for the three Re-post actions (#1428): the quotes header, the
 * notices header and the rules message. Driven over HTTP with the real session,
 * admin and CSRF middleware; the services that talk to Discord are mocked, and
 * their own behaviour is covered in the service tests.
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

const mockRecordAudit = jest.fn<(...a: any[]) => Promise<void>>(
  async () => undefined,
);
const mockQuoteRepost = jest.fn<(...a: any[]) => Promise<any>>();
const mockNoticeRepost = jest.fn<(...a: any[]) => Promise<any>>();
const mockRulesRepost = jest.fn<(...a: any[]) => Promise<any>>();

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
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: (): unknown => ({
      getBoolean: jest.fn(async () => true),
      getString: jest.fn(async () => ""),
      getNumber: jest.fn(async () => 0),
      registerReloadCallback: jest.fn(),
    }),
  },
}));
jest.unstable_mockModule("../../src/services/quote-service.js", () => ({
  quoteService: {},
}));
jest.unstable_mockModule("../../src/services/quote-channel-manager.js", () => ({
  QuoteChannelManager: {
    getInstance: (): unknown => ({ repostHeader: mockQuoteRepost }),
  },
}));
jest.unstable_mockModule(
  "../../src/services/notices-channel-manager.js",
  () => ({
    NoticesChannelManager: {
      getInstance: (): unknown => ({ repostHeader: mockNoticeRepost }),
    },
  }),
);
jest.unstable_mockModule("../../src/models/notice.js", () => ({ default: {} }));
jest.unstable_mockModule("../../src/utils/discord.js", () => ({
  isMissingPostError: () => false,
}));
jest.unstable_mockModule("../../src/services/rules-service.js", () => ({
  RulesService: {
    getInstance: (): unknown => ({ repostMessage: mockRulesRepost }),
  },
  ROLE_PROBLEM_TEXT: {},
}));
jest.unstable_mockModule("../../src/services/rules-adoption.js", () => ({
  planRulesGate: jest.fn(),
  rulesPlanIsApplicable: () => true,
}));
jest.unstable_mockModule("../../src/web/rules-page.js", () => ({
  parseRulesOptions: () => ({}),
}));
jest.unstable_mockModule(
  "../../src/services/server-adoption-service.js",
  () => ({ ServerAdoptionService: { getInstance: jest.fn() } }),
);

const { createQuotesRouter } =
  await import("../../src/web/routes/write/quotes.js");
const { createNoticesRouter } =
  await import("../../src/web/routes/write/notices.js");
const { createRulesRouter } =
  await import("../../src/web/routes/write/rules.js");
const { requireCsrf } = await import("../../src/web/csrf.js");
const { requireAdminRoleMiddleware } = await import("../../src/web/session.js");

const client = {
  user: { id: "bot" },
  guilds: { fetch: jest.fn(async () => ({ id: "guild-1" })) },
} as unknown as Client;

let harness: AdminHarness;
async function mount(role: "admin" | "user" = "admin"): Promise<void> {
  harness = await startAdminHarness([
    stubRequireSession(createTestSession({ role })),
    requireAdminRoleMiddleware(),
    requireCsrf,
    createQuotesRouter(client),
    createNoticesRouter(client),
    createRulesRouter(client),
  ]);
}

const ok = (old: string, extra: Record<string, unknown> = {}): any => ({
  ok: true,
  messageId: "new1",
  oldMessageId: "old1",
  old,
  ...extra,
});

const CASES = [
  {
    name: "quotes header",
    path: "/quotes/header/repost",
    page: "/admin/quotes",
    action: "quote.header-repost",
    mock: mockQuoteRepost,
  },
  {
    name: "notices header",
    path: "/notices/header/repost",
    page: "/admin/notices",
    action: "notice.header-repost",
    mock: mockNoticeRepost,
  },
  {
    name: "rules message",
    path: "/rules/repost",
    page: "/admin/rules",
    action: "rules.repost",
    mock: mockRulesRepost,
  },
] as const;

beforeEach(() => {
  jest.clearAllMocks();
});
afterEach(async () => {
  await harness?.close();
});

function lastAudit(): Record<string, unknown> {
  const calls = mockRecordAudit.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][1] as Record<string, unknown>;
}

describe.each(CASES)("Re-post: $name", (c) => {
  it("re-posts, passes the id the page showed, audits and says the old one was removed", async () => {
    await mount();
    c.mock.mockResolvedValue(ok("deleted"));
    const res = await harness.post(c.path, { expectedId: "old1" });
    expect(res.status).toBe(303);
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe(c.page);
    expect(flash.type).toBe("ok");
    expect(flash.msg).toContain("posted again");
    expect(flash.msg).toContain("old one was removed");
    expect(c.mock.mock.calls[0]).toContain("old1");
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
    expect(lastAudit()).toMatchObject({
      action: c.action,
      targetId: "new1",
      result: "success",
      details: { oldMessageId: "old1", oldMessage: "deleted" },
    });
  });

  it("warns, not just confirms, when the old message was already gone or in another channel", async () => {
    await mount();
    c.mock.mockResolvedValue(ok("not-found"));
    const res = await harness.post(c.path, { expectedId: "old1" });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("warn");
    expect(flash.msg).toContain("channel it was posted in before");
    expect(lastAudit()).toMatchObject({ result: "success" });
  });

  it("warns when the old message couldn't be deleted", async () => {
    await mount();
    c.mock.mockResolvedValue(ok("delete-failed"));
    const res = await harness.post(c.path, { expectedId: "old1" });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("warn");
    expect(flash.msg).toContain("could not be removed");
  });

  it("shows a missing permission as an error and audits a failure", async () => {
    await mount();
    c.mock.mockResolvedValue({
      ok: false,
      reason: "no-permission",
      error: "KoolBot isn't allowed to post in #x. Nothing was changed.",
    });
    const res = await harness.post(c.path, { expectedId: "old1" });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("isn't allowed to post");
    expect(lastAudit()).toMatchObject({
      action: c.action,
      result: "failure",
      details: { reason: "no-permission" },
      errorMessage: expect.stringContaining("isn't allowed"),
    });
  });

  it("answers a double submit (an id that is no longer the live one) with a warning, not a second post", async () => {
    await mount();
    c.mock.mockResolvedValue({
      ok: false,
      reason: "stale",
      error: "This message was already re-posted.",
    });
    const res = await harness.post(c.path, { expectedId: "old1" });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("warn");
    expect(lastAudit()).toMatchObject({ result: "failure" });
  });

  it("is refused without a CSRF token and posts nothing", async () => {
    await mount();
    const res = await harness.post(
      c.path,
      { expectedId: "old1" },
      { csrfCookie: null, csrfField: null },
    );
    expect(res.status).toBe(403);
    expect(c.mock).not.toHaveBeenCalled();
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("is refused for a non-admin, before CSRF", async () => {
    await mount("user");
    const res = await harness.post(
      c.path,
      { expectedId: "old1" },
      { csrfCookie: null, csrfField: null },
    );
    expect(res.status).toBe(403);
    expect(c.mock).not.toHaveBeenCalled();
  });

  it("does not answer GET", async () => {
    await mount();
    const res = await harness.get(c.path);
    expect(res.status).toBe(404);
    expect(c.mock).not.toHaveBeenCalled();
  });
});
