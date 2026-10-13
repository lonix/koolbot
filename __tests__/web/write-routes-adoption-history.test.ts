/**
 * Route-handler tests for the adoption history and rollback pages (#1025),
 * driven over HTTP through the shared harness with the real middleware stack.
 * The snapshot reads and the adoption engine are mocked.
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
    getInstance: () => ({ getBoolean: async () => false }),
  },
}));

const mockList = jest.fn<(...a: any[]) => Promise<any>>();
const mockDetail = jest.fn<(...a: any[]) => Promise<any>>();
jest.unstable_mockModule(
  "../../src/services/adoption-snapshot-history.js",
  () => ({
    listSnapshots: mockList,
    getSnapshotDetail: mockDetail,
    canRollback: (s: string) =>
      s === "applied" || s === "partial" || s === "rollback_partial",
  }),
);
const mockRecoverStale = jest.fn<(...a: any[]) => Promise<number>>();
const mockStartRollback = jest.fn<(...a: any[]) => any>();
const mockGetRollbackJob = jest.fn<(...a: any[]) => any>();
jest.unstable_mockModule(
  "../../src/services/server-adoption-service.js",
  () => ({
    DESTRUCTIVE_RESTORE_NOTE: "Messages can't be restored.",
    MongoAdoptionStore: class {
      recoverStale = mockRecoverStale;
    },
    ServerAdoptionService: {
      getInstance: async () => ({
        startRollback: mockStartRollback,
        getRollbackJob: mockGetRollbackJob,
      }),
    },
  }),
);

const { createAdoptionHistoryRouter } =
  await import("../../src/web/routes/write/adoption-history.js");
const { requireCsrf } = await import("../../src/web/csrf.js");
const { requireAdminRoleMiddleware } = await import("../../src/web/session.js");

const session = createTestSession();
const SNAP = "a".repeat(24);
const JOB = "11111111-1111-1111-1111-111111111111";

const summary = (over: Record<string, unknown> = {}) => ({
  id: SNAP,
  planId: "plan-1",
  appliedBy: "admin-1",
  status: "applied",
  createdAt: new Date("2026-10-01T10:00:00Z"),
  rolledBackBy: null,
  rolledBackAt: null,
  applied: 3,
  failed: 0,
  skipped: 0,
  destructive: 0,
  createdRoles: 1,
  revertibleCreatedRoles: 1,
  interrupted: 0,
  operations: [{ summary: "Make #news read-only", destructive: false }],
  ...over,
});

const client = {
  guilds: { fetch: jest.fn(async () => ({ id: "guild-1" })) },
} as unknown as Client;

let harness: AdminHarness;
async function mount(): Promise<void> {
  harness = await startAdminHarness([
    stubRequireSession(session),
    requireAdminRoleMiddleware(),
    requireCsrf,
    createAdoptionHistoryRouter(client),
  ]);
}
const flashOf = (res: Response) =>
  parseFlashRedirect(res.headers.get("location"));

beforeEach(() => {
  jest.clearAllMocks();
  mockList.mockResolvedValue({
    snapshots: [summary()],
    page: 1,
    hasMore: false,
  });
  mockDetail.mockResolvedValue(summary());
  mockStartRollback.mockReturnValue({ id: JOB });
  mockRecoverStale.mockResolvedValue(0);
});
afterEach(async () => {
  await harness?.close();
  harness = undefined as unknown as AdminHarness;
});

describe("GET /adopt/history", () => {
  it("lists this server's snapshots with a restore link", async () => {
    await mount();
    const res = await harness.get("/adopt/history");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Adoption history");
    expect(html).toContain(`/admin/adopt/history/${SNAP}/restore`);
    expect(mockList).toHaveBeenCalledWith("guild-1", 1);
  });

  it("passes a sanitised page number through", async () => {
    await mount();
    await harness.get("/adopt/history?page=3");
    expect(mockList).toHaveBeenLastCalledWith("guild-1", 3);
    await harness.get("/adopt/history?page=abc");
    expect(mockList).toHaveBeenLastCalledWith("guild-1", 1);
  });

  it("fails closed when the history can't be read", async () => {
    mockList.mockRejectedValue(new Error("db down"));
    await mount();
    const html = await (await harness.get("/adopt/history")).text();
    expect(html).toContain("couldn't be read");
  });

  it("ignores a malformed job id", async () => {
    await mount();
    const html = await (
      await harness.get("/adopt/history?job=%22%3E%3Cscript%3E")
    ).text();
    expect(html).not.toContain("ah-job");
  });
});

describe("stale lock recovery", () => {
  it("runs before the list, the confirm page and the restore check, so a stuck rolling_back snapshot becomes restorable", async () => {
    const order: string[] = [];
    mockRecoverStale.mockImplementation(async () => {
      order.push("recover");
      return 1;
    });
    mockList.mockImplementation(async () => {
      order.push("list");
      return { snapshots: [], page: 1, hasMore: false };
    });
    mockDetail.mockImplementation(async () => {
      order.push("detail");
      return summary({ status: "rollback_partial" });
    });
    await mount();
    await harness.get("/adopt/history");
    await harness.get(`/adopt/history/${SNAP}/restore`);
    await harness.post(`/adopt/history/${SNAP}/restore`, {});
    expect(order).toEqual([
      "recover",
      "list",
      "recover",
      "detail",
      "recover",
      "detail",
    ]);
    expect(mockRecoverStale).toHaveBeenCalledWith("guild-1", 30 * 60 * 1000);
    expect(mockStartRollback).toHaveBeenCalled();
  });

  it("still serves the page when recovery itself fails", async () => {
    mockRecoverStale.mockRejectedValue(new Error("db"));
    await mount();
    expect((await harness.get("/adopt/history")).status).toBe(200);
  });
});

describe("GET /adopt/history/:id/restore", () => {
  it("shows what will be reverted and starts nothing", async () => {
    await mount();
    const res = await harness.get(`/adopt/history/${SNAP}/restore`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Make #news read-only");
    expect(html).toContain('name="deleteCreatedRoles"');
    expect(html).not.toMatch(/name="deleteCreatedRoles"[^>]*checked/);
    expect(mockStartRollback).not.toHaveBeenCalled();
  });

  it("redirects with a notice for an unknown snapshot", async () => {
    mockDetail.mockResolvedValue(null);
    await mount();
    const res = await harness.get(`/adopt/history/${SNAP}/restore`);
    expect(res.status).toBe(303);
  });
});

describe("POST /adopt/history/:id/restore", () => {
  it("starts the rollback, audits it, and leaves created roles alone by default", async () => {
    await mount();
    const res = await harness.post(`/adopt/history/${SNAP}/restore`, {});
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain(`job=${JOB}`);
    expect(mockStartRollback).toHaveBeenCalledWith(SNAP, {
      actor: session,
      deleteCreatedRoles: false,
    });
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "adopt.rollback", result: "success" }),
    );
  });

  it("deletes created roles only when ticked", async () => {
    await mount();
    await harness.post(`/adopt/history/${SNAP}/restore`, {
      deleteCreatedRoles: "1",
    });
    expect(mockStartRollback).toHaveBeenCalledWith(
      SNAP,
      expect.objectContaining({ deleteCreatedRoles: true }),
    );
  });

  it("refuses a snapshot that can't be rolled back", async () => {
    mockDetail.mockResolvedValue(summary({ status: "rolled_back" }));
    await mount();
    const res = await harness.post(`/adopt/history/${SNAP}/restore`, {});
    expect(flashOf(res).type).toBe("warn");
    expect(mockStartRollback).not.toHaveBeenCalled();
  });

  it("refuses an unknown or foreign snapshot", async () => {
    mockDetail.mockResolvedValue(null);
    await mount();
    const res = await harness.post(`/adopt/history/${SNAP}/restore`, {});
    expect(flashOf(res).type).toBe("warn");
    expect(mockStartRollback).not.toHaveBeenCalled();
  });

  it("reports and audits an engine refusal", async () => {
    mockStartRollback.mockImplementation(() => {
      throw new Error("busy");
    });
    await mount();
    const res = await harness.post(`/adopt/history/${SNAP}/restore`, {});
    expect(flashOf(res)).toMatchObject({ type: "err", msg: "busy" });
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "adopt.rollback", result: "failure" }),
    );
  });

  it("requires the CSRF token", async () => {
    await mount();
    const res = await harness.post(
      `/adopt/history/${SNAP}/restore`,
      {},
      { csrfField: "wrong" },
    );
    expect(res.status).toBe(403);
    expect(mockStartRollback).not.toHaveBeenCalled();
  });
});

describe("GET /adopt/history/job/:id", () => {
  it("reports a running, finished and unknown job", async () => {
    await mount();
    mockGetRollbackJob.mockReturnValueOnce({ status: "running" });
    expect(await (await harness.get("/adopt/history/job/x")).json()).toEqual({
      status: "running",
      text: "Restoring…",
    });
    mockGetRollbackJob.mockReturnValueOnce({
      status: "done",
      result: { restored: ["a", "b"], failed: [] },
    });
    expect(
      (await (await harness.get("/adopt/history/job/x")).json()).text,
    ).toBe("Restored 2 step(s).");
    mockGetRollbackJob.mockReturnValueOnce({
      status: "failed",
      error: "nope",
    });
    expect(
      (await (await harness.get("/adopt/history/job/x")).json()).text,
    ).toBe("Restore failed: nope");
    mockGetRollbackJob.mockReturnValueOnce(undefined);
    const gone = await harness.get("/adopt/history/job/x");
    expect(gone.status).toBe(404);
  });
});
