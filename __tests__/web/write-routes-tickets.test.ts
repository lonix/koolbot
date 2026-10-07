/**
 * Route-handler tests for the Tickets write router (#1004): verb dispatch,
 * guild-scoped lookup, flash outcomes and exactly one audit record per request.
 * Only `TicketChannelManager` is mocked.
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
const mockFindById = jest.fn<(g: string, id: string) => Promise<unknown>>();
const mockClaim = jest.fn<(t: unknown, u: string) => Promise<unknown>>();
const mockClose = jest.fn<(t: unknown, u: string) => Promise<unknown>>();
const mockReopen = jest.fn<(t: unknown, u: string) => Promise<unknown>>();

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

jest.unstable_mockModule(
  "../../src/services/ticket-channel-manager.js",
  () => ({
    TicketChannelManager: {
      getInstance: (): unknown => ({
        findById: mockFindById,
        claimTicket: mockClaim,
        closeTicket: mockClose,
        reopenTicket: mockReopen,
      }),
    },
  }),
);

const { createTicketsRouter } =
  await import("../../src/web/routes/write/tickets.js");
const { requireCsrf } = await import("../../src/web/csrf.js");
const { requireAdminRoleMiddleware } = await import("../../src/web/session.js");

const client = { user: { id: "bot" } } as unknown as Client;
const session = createTestSession();
const ID = "a".repeat(24);

let harness: AdminHarness;

beforeEach(async () => {
  jest.clearAllMocks();
  mockFindById.mockResolvedValue({ _id: ID });
  harness = await startAdminHarness([
    stubRequireSession(session),
    requireAdminRoleMiddleware(),
    requireCsrf,
    createTicketsRouter(client),
  ]);
});

afterEach(async () => {
  await harness.close();
});

async function act(
  verb: string,
  id = ID,
): Promise<ReturnType<typeof parseFlashRedirect>> {
  const res = await harness.post(`/tickets/${id}/${verb}`, {});
  expect(res.status).toBe(303);
  return parseFlashRedirect(res.headers.get("location"));
}

describe("POST /tickets/:id/:verb", () => {
  it.each([
    ["claim", mockClaim, "Ticket claimed."],
    ["close", mockClose, "Ticket closed."],
    ["reopen", mockReopen, "Ticket reopened."],
  ])("%s dispatches to its own transition", async (verb, mock, text) => {
    mock.mockResolvedValue({ ok: true });
    const flash = await act(verb);
    expect(flash).toMatchObject({
      path: "/admin/tickets",
      type: "ok",
      msg: text,
    });
    expect(mock).toHaveBeenCalledWith({ _id: ID }, session.discordUserId);
    for (const other of [mockClaim, mockClose, mockReopen]) {
      if (other !== mock) expect(other).not.toHaveBeenCalled();
    }
  });

  it("looks the ticket up scoped to the session's guild", async () => {
    mockClose.mockResolvedValue({ ok: true });
    await act("close");
    expect(mockFindById).toHaveBeenCalledWith(session.guildId, ID);
  });

  it("records exactly one audit entry on success", async () => {
    mockClose.mockResolvedValue({ ok: true });
    await act("close");
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
    expect(mockRecordAudit).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        action: "ticket.close",
        targetId: ID,
        result: "success",
      }),
    );
  });

  it("flashes the reason and audits a failure when the transition refuses", async () => {
    mockClaim.mockResolvedValue({ ok: false, reason: "already-claimed" });
    const flash = await act("claim");
    expect(flash.type).toBe("err");
    expect(flash.msg).toBe("That ticket is already claimed.");
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
    expect(mockRecordAudit).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        result: "failure",
        errorMessage: "already-claimed",
      }),
    );
  });

  it("reports an unknown ticket without running a transition", async () => {
    mockFindById.mockResolvedValue(null);
    const flash = await act("close", "f".repeat(24));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("not found");
    expect(mockClose).not.toHaveBeenCalled();
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
  });

  it("turns a thrown error into a failure flash and one audit entry", async () => {
    mockClose.mockRejectedValue(new Error("boom"));
    const flash = await act("close");
    expect(flash.type).toBe("err");
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
    expect(mockRecordAudit).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ result: "failure", errorMessage: "boom" }),
    );
  });
});
