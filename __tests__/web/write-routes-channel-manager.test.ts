/**
 * Route-handler tests for the Channel Manager (#1065), driven over HTTP through
 * the shared harness with the real middleware stack. The Discord reads, the
 * protection lookup, the command manager and the audit log are mocked; the
 * validation and refusal rules are the real ones.
 */

import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { ChannelType, type Client } from "discord.js";
import {
  startAdminHarness,
  stubRequireSession,
  createTestSession,
  parseFlashRedirect,
  type AdminHarness,
} from "./admin-harness.js";
import type { ManagedChannelView } from "../../src/web/channel-manager.js";

const mockRecordAudit = jest.fn<(...a: any[]) => Promise<void>>(
  async () => undefined,
);
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

const mockApiCall = jest.fn<(...a: any[]) => Promise<any>>(
  async (fn: () => Promise<unknown>) => fn(),
);
jest.unstable_mockModule("../../src/services/command-manager.js", () => ({
  CommandManager: { getInstance: () => ({ makeDiscordApiCall: mockApiCall }) },
}));

let channels: ManagedChannelView[] = [];
let protection = new Map<string, string[]>();
let canManage = true;
let protectionFails = false;
jest.unstable_mockModule("../../src/web/channel-manager-data.js", () => ({
  fetchChannelViews: async () => channels,
  maxBitrateOf: () => 96000,
  botCanManageChannels: async () => canManage,
  loadProtection: async () => {
    if (protectionFails) throw new Error("db down");
    return protection;
  },
}));

const { createChannelManagerRouter } =
  await import("../../src/web/routes/write/channel-manager.js");
const { requireCsrf } = await import("../../src/web/csrf.js");
const { requireAdminRoleMiddleware } = await import("../../src/web/session.js");

const CAT = "100000000000000001";
const TEXT = "100000000000000002";
const VOICE = "100000000000000003";
const TEXT2 = "100000000000000004";
const STAGE = "100000000000000005";

const view = (
  id: string,
  over: Partial<ManagedChannelView>,
): ManagedChannelView => ({
  id,
  name: id,
  kind: "text",
  typeLabel: "text",
  parentId: null,
  position: 0,
  topic: null,
  userLimit: null,
  bitrate: null,
  ...over,
});

const created = { id: "100000000000000099", name: "new-chan" };
const mockCreate = jest.fn<(...a: any[]) => Promise<any>>();
const mockEdit = jest.fn<(...a: any[]) => Promise<any>>();
const mockSetPosition = jest.fn<(...a: any[]) => Promise<any>>();
const mockDelete = jest.fn<(...a: any[]) => Promise<any>>();
let liveFlags: { manageable?: boolean; deletable?: boolean } = {};
let fetchMissing = false;

function makeClient(opts: { guildFails?: boolean } = {}): Client {
  const guild = {
    id: "guild-1",
    channels: {
      create: mockCreate,
      fetch: jest.fn(async (id: string) =>
        fetchMissing
          ? null
          : {
              id,
              isThread: () => false,
              edit: mockEdit,
              setPosition: mockSetPosition,
              delete: mockDelete,
              ...liveFlags,
            },
      ),
    },
  };
  return {
    guilds: {
      fetch: jest.fn(async () => {
        if (opts.guildFails) throw new Error("down");
        return guild;
      }),
    },
  } as unknown as Client;
}

const session = createTestSession();
let harness: AdminHarness;
async function mount(client: Client = makeClient()): Promise<void> {
  harness = await startAdminHarness([
    stubRequireSession(session),
    requireAdminRoleMiddleware(),
    requireCsrf,
    createChannelManagerRouter(client),
  ]);
}
const flashOf = (res: Response) =>
  parseFlashRedirect(res.headers.get("location"));

beforeEach(() => {
  jest.clearAllMocks();
  channels = [
    view(CAT, { kind: "category", name: "Community" }),
    view(TEXT, { name: "general", parentId: CAT, position: 0, topic: "hi" }),
    view(TEXT2, { name: "random", parentId: CAT, position: 1 }),
    view(VOICE, {
      kind: "voice",
      name: "Hangout",
      typeLabel: "voice",
      parentId: CAT,
      userLimit: 4,
      bitrate: 64000,
    }),
    view(STAGE, { kind: "other", typeLabel: "GuildStageVoice", name: "stage" }),
  ];
  protection = new Map();
  canManage = true;
  protectionFails = false;
  liveFlags = {};
  fetchMissing = false;
  mockCreate.mockResolvedValue(created);
  mockEdit.mockImplementation(async (changes: any) => ({
    name: changes.name ?? "same",
  }));
  mockSetPosition.mockResolvedValue({});
  mockDelete.mockResolvedValue({});
});
afterEach(async () => {
  await harness?.close();
  harness = undefined as unknown as AdminHarness;
});

describe("every POST", () => {
  it("is always available: there is no enabled key to switch it off", async () => {
    await mount();
    const res = await harness.post("/channels/create", {
      type: "text",
      name: "x",
    });
    expect(flashOf(res)).toMatchObject({ path: "/admin/channels", type: "ok" });
  });

  it("refuses without Manage Channels, calls Discord not at all, and audits once", async () => {
    canManage = false;
    await mount();
    const res = await harness.post("/channels/create", {
      type: "text",
      name: "x",
    });
    const flash = flashOf(res);
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("Manage Channels");
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
    expect(mockRecordAudit.mock.calls[0][1]).toMatchObject({
      action: "channels.create",
      result: "failure",
    });
  });

  it("reports an unreachable server and audits the failure", async () => {
    await mount(makeClient({ guildFails: true }));
    const res = await harness.post("/channels/create", {
      type: "text",
      name: "x",
    });
    expect(flashOf(res).msg).toContain("couldn't be reached");
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
  });

  it("turns a Discord error into a flash and an audited failure", async () => {
    mockCreate.mockRejectedValue(new Error("Missing Permissions"));
    await mount();
    const res = await harness.post("/channels/create", {
      type: "text",
      name: "x",
    });
    expect(flashOf(res).msg).toContain("Missing Permissions");
    expect(mockRecordAudit.mock.calls[0][1]).toMatchObject({
      result: "failure",
    });
  });
});

describe("POST /channels/create", () => {
  it("creates a text channel under a category through makeDiscordApiCall, without retry on timeout", async () => {
    await mount();
    const res = await harness.post("/channels/create", {
      type: "text",
      name: "  news  ",
      topic: "Headlines",
      parent: CAT,
    });
    expect(flashOf(res)).toMatchObject({ type: "ok" });
    expect(flashOf(res).msg).toContain("new-chan");
    expect(mockApiCall).toHaveBeenCalledTimes(1);
    expect(mockApiCall.mock.calls[0].slice(1)).toEqual([
      "create channel",
      30000,
      3,
      false,
    ]);
    expect(mockCreate.mock.calls[0][0]).toMatchObject({
      name: "news",
      type: ChannelType.GuildText,
      parent: CAT,
      topic: "Headlines",
    });
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
    expect(mockRecordAudit.mock.calls[0][1]).toMatchObject({
      action: "channels.create",
      targetId: created.id,
      result: "success",
    });
  });

  it("creates a voice channel with the limit and bitrate converted to bps", async () => {
    await mount();
    await harness.post("/channels/create", {
      type: "voice",
      name: "Squad",
      userLimit: "5",
      bitrate: "64",
    });
    expect(mockCreate.mock.calls[0][0]).toMatchObject({
      type: ChannelType.GuildVoice,
      userLimit: 5,
      bitrate: 64000,
    });
  });

  it("creates a category and ignores the channel-only fields", async () => {
    await mount();
    await harness.post("/channels/create", {
      type: "category",
      name: "Games",
      topic: "ignored",
      parent: CAT,
    });
    const opts = mockCreate.mock.calls[0][0];
    expect(opts.type).toBe(ChannelType.GuildCategory);
    expect(opts.topic).toBeUndefined();
    expect(opts.parent).toBeUndefined();
  });

  it.each([
    ["an unknown type", { type: "forum", name: "x" }, "Pick"],
    ["an empty name", { type: "text", name: "   " }, "name"],
    ["a 101-character name", { type: "text", name: "x".repeat(101) }, "100"],
    [
      "a 1025-character topic",
      { type: "text", name: "x", topic: "t".repeat(1025) },
      "1024",
    ],
    [
      "a user limit above 99",
      { type: "voice", name: "x", userLimit: "100" },
      "99",
    ],
    [
      "a bitrate above the server maximum",
      { type: "voice", name: "x", bitrate: "97" },
      "kbps",
    ],
    [
      "a bitrate below 8 kbps",
      { type: "voice", name: "x", bitrate: "7" },
      "kbps",
    ],
    [
      "a parent that is not a category",
      { type: "text", name: "x", parent: TEXT },
      "category",
    ],
    [
      "a parent that doesn't exist",
      { type: "text", name: "x", parent: "199999999999999999" },
      "category",
    ],
  ])("rejects %s before calling Discord", async (_label, body, fragment) => {
    await mount();
    const res = await harness.post("/channels/create", body);
    const flash = flashOf(res);
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain(fragment);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
  });

  it("refuses the 501st channel", async () => {
    channels = Array.from({ length: 500 }, (_, i) =>
      view(`3${String(i).padStart(17, "0")}`, {}),
    );
    await mount();
    const res = await harness.post("/channels/create", {
      type: "text",
      name: "x",
    });
    expect(flashOf(res).msg).toContain("500");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("refuses the 51st channel in a category", async () => {
    channels = [
      view(CAT, { kind: "category" }),
      ...Array.from({ length: 50 }, (_, i) =>
        view(`3${String(i).padStart(17, "0")}`, { parentId: CAT }),
      ),
    ];
    await mount();
    const res = await harness.post("/channels/create", {
      type: "text",
      name: "x",
      parent: CAT,
    });
    expect(flashOf(res).msg).toContain("50 per category");
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe("POST /channels/:id/edit", () => {
  it("sends only the changed fields, once, without retry on timeout", async () => {
    await mount();
    const res = await harness.post(`/channels/${TEXT}/edit`, {
      name: "general",
      topic: "new topic",
      parent: CAT,
    });
    expect(flashOf(res)).toMatchObject({ type: "ok" });
    expect(mockEdit).toHaveBeenCalledTimes(1);
    const sent = mockEdit.mock.calls[0][0];
    expect(sent.topic).toBe("new topic");
    expect(sent).not.toHaveProperty("name");
    expect(sent).not.toHaveProperty("parent");
    expect(mockApiCall.mock.calls[0][4]).toBe(false);
    expect(mockRecordAudit.mock.calls[0][1]).toMatchObject({
      action: "channels.edit",
      details: { changed: ["topic"] },
    });
  });

  it("never renames a channel when only the topic changes, even with a compound-emoji name", async () => {
    const family = "👨‍👩‍👧‍👦 family";
    channels[1] = view(TEXT, { name: family, parentId: CAT, topic: "hi" });
    await mount();
    const res = await harness.post(`/channels/${TEXT}/edit`, {
      name: family,
      topic: "new topic",
      parent: CAT,
    });
    expect(flashOf(res)).toMatchObject({ type: "ok" });
    const sent = mockEdit.mock.calls[0][0];
    expect(sent.topic).toBe("new topic");
    expect(sent).not.toHaveProperty("name");
  });

  it("never rewrites an unchanged name that normalisation would alter", async () => {
    channels[1] = view(TEXT, {
      name: "double  space",
      parentId: CAT,
      topic: "hi",
    });
    await mount();
    await harness.post(`/channels/${TEXT}/edit`, {
      name: "double  space",
      topic: "other",
      parent: CAT,
    });
    expect(mockEdit.mock.calls[0][0]).not.toHaveProperty("name");
  });

  it("renames, and reports the name Discord returned", async () => {
    mockEdit.mockResolvedValue({ name: "normalised-name" });
    await mount();
    const res = await harness.post(`/channels/${TEXT}/edit`, {
      name: "Normalised Name",
      topic: "hi",
      parent: CAT,
    });
    expect(flashOf(res).msg).toContain("normalised-name");
  });

  it("edits a voice channel's limit and bitrate", async () => {
    await mount();
    await harness.post(`/channels/${VOICE}/edit`, {
      name: "Hangout",
      userLimit: "10",
      bitrate: "96",
      parent: CAT,
    });
    expect(mockEdit.mock.calls[0][0]).toMatchObject({
      userLimit: 10,
      bitrate: 96000,
    });
  });

  it("moves a channel to another category without rewriting permissions", async () => {
    const OTHER = "100000000000000050";
    channels.push(view(OTHER, { kind: "category", name: "Other" }));
    await mount();
    await harness.post(`/channels/${TEXT}/edit`, {
      name: "general",
      topic: "hi",
      parent: OTHER,
    });
    expect(mockEdit.mock.calls[0][0]).toMatchObject({
      parent: OTHER,
      lockPermissions: false,
    });
  });

  it("moves a channel out of its category", async () => {
    await mount();
    await harness.post(`/channels/${TEXT}/edit`, {
      name: "general",
      topic: "hi",
      parent: "",
    });
    expect(mockEdit.mock.calls[0][0]).toMatchObject({ parent: null });
  });

  it("does nothing when nothing changed", async () => {
    await mount();
    const res = await harness.post(`/channels/${TEXT}/edit`, {
      name: "general",
      topic: "hi",
      parent: CAT,
    });
    expect(flashOf(res).msg).toContain("Nothing to change");
    expect(mockEdit).not.toHaveBeenCalled();
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
  });

  it("refuses to move into a full category", async () => {
    const FULL = "100000000000000060";
    channels = [
      view(FULL, { kind: "category" }),
      view(TEXT, { name: "general" }),
      ...Array.from({ length: 50 }, (_, i) =>
        view(`3${String(i).padStart(17, "0")}`, { parentId: FULL }),
      ),
    ];
    await mount();
    const res = await harness.post(`/channels/${TEXT}/edit`, {
      name: "general",
      parent: FULL,
    });
    expect(flashOf(res).msg).toContain("50 per category");
    expect(mockEdit).not.toHaveBeenCalled();
  });

  it("refuses types it doesn't manage, unknown ids and bad ids", async () => {
    await mount();
    expect(
      flashOf(await harness.post(`/channels/${STAGE}/edit`, { name: "x" })).msg,
    ).toContain("only text channels");
    expect(
      flashOf(
        await harness.post(`/channels/199999999999999999/edit`, { name: "x" }),
      ).msg,
    ).toContain("no longer exists");
    expect(
      flashOf(await harness.post(`/channels/abc/edit`, { name: "x" })).msg,
    ).toContain("isn't a channel");
    expect(mockEdit).not.toHaveBeenCalled();
  });

  it("refuses when a permission override stops the bot managing the channel", async () => {
    liveFlags = { manageable: false };
    await mount();
    const res = await harness.post(`/channels/${TEXT}/edit`, {
      name: "renamed",
      topic: "hi",
      parent: CAT,
    });
    expect(flashOf(res).msg).toContain("permission override");
    expect(mockEdit).not.toHaveBeenCalled();
  });

  it("says so when the channel vanished between the page and the save", async () => {
    fetchMissing = true;
    await mount();
    const res = await harness.post(`/channels/${TEXT}/edit`, {
      name: "renamed",
      topic: "hi",
      parent: CAT,
    });
    expect(flashOf(res).msg).toContain("no longer exists");
  });

  it("validates the name length", async () => {
    await mount();
    const res = await harness.post(`/channels/${TEXT}/edit`, {
      name: "x".repeat(101),
    });
    expect(flashOf(res).type).toBe("err");
    expect(mockEdit).not.toHaveBeenCalled();
  });
});

describe("POST /channels/:id/move", () => {
  it("moves one step relative to its siblings", async () => {
    await mount();
    const res = await harness.post(`/channels/${TEXT2}/move`, {
      direction: "up",
    });
    expect(flashOf(res)).toMatchObject({ type: "ok" });
    expect(mockSetPosition.mock.calls[0][0]).toBe(-1);
    expect(mockSetPosition.mock.calls[0][1]).toMatchObject({ relative: true });
    expect(mockApiCall.mock.calls[0][4]).toBe(false);
    expect(mockRecordAudit.mock.calls[0][1]).toMatchObject({
      action: "channels.move",
      details: { direction: "up" },
    });
  });

  it("moves relative to the same-category neighbour when another category's channel sits between them in guild-wide order", async () => {
    // A (CAT, 0), B (OTHER, 1), C (CAT, 2): discord.js sorts a relative move
    // inside the channel's own parent and group, so one step up from C is A.
    const OTHER = "100000000000000070";
    const B = "100000000000000071";
    const C = "100000000000000072";
    channels = [
      view(CAT, { kind: "category", name: "One", position: 0 }),
      view(OTHER, { kind: "category", name: "Two", position: 1 }),
      view(TEXT, { name: "a", parentId: CAT, position: 0 }),
      view(B, { name: "b", parentId: OTHER, position: 1 }),
      view(C, { name: "c", parentId: CAT, position: 2 }),
    ];
    await mount();
    const up = await harness.post(`/channels/${C}/move`, { direction: "up" });
    expect(flashOf(up)).toMatchObject({ type: "ok" });
    expect(mockSetPosition.mock.calls[0][0]).toBe(-1);
    expect(mockSetPosition.mock.calls[0][1]).toMatchObject({ relative: true });
    // B is alone in its category, so it has no neighbour to swap with.
    const alone = await harness.post(`/channels/${B}/move`, {
      direction: "down",
    });
    expect(flashOf(alone).msg).toContain("already last");
    // A is first among CAT's channels even though B sits after it overall.
    const first = await harness.post(`/channels/${TEXT}/move`, {
      direction: "up",
    });
    expect(flashOf(first).msg).toContain("already first");
    expect(mockSetPosition).toHaveBeenCalledTimes(1);
  });

  it("refuses to move past the first or last place", async () => {
    await mount();
    const res = await harness.post(`/channels/${TEXT}/move`, {
      direction: "up",
    });
    expect(flashOf(res).msg).toContain("already first");
    expect(mockSetPosition).not.toHaveBeenCalled();
  });

  it("rejects a bad direction", async () => {
    await mount();
    const res = await harness.post(`/channels/${TEXT}/move`, {
      direction: "sideways",
    });
    expect(flashOf(res).msg).toContain("up or down");
  });
});

describe("POST /channels/:id/delete", () => {
  it("deletes an unmanaged channel after confirmation and audits it", async () => {
    await mount();
    const res = await harness.post(`/channels/${TEXT2}/delete`, {
      confirm: TEXT2,
    });
    expect(flashOf(res)).toMatchObject({ type: "ok" });
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockRecordAudit.mock.calls[0][1]).toMatchObject({
      action: "channels.delete",
      targetId: TEXT2,
      result: "success",
    });
  });

  it("will not delete without the confirmation field, whatever else is sent", async () => {
    await mount();
    for (const body of [{}, { confirm: "yes" }, { confirm: TEXT }]) {
      const res = await harness.post(`/channels/${TEXT2}/delete`, body);
      expect(flashOf(res).msg).toContain("confirmation page");
    }
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockRecordAudit).toHaveBeenCalledTimes(3);
  });

  it("refuses a channel KoolBot manages, naming the setting, and audits the refusal", async () => {
    protection = new Map([[TEXT2, ["the quotes.channel_id setting"]]]);
    await mount();
    const res = await harness.post(`/channels/${TEXT2}/delete`, {
      confirm: TEXT2,
    });
    const flash = flashOf(res);
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("quotes.channel_id");
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockRecordAudit.mock.calls[0][1]).toMatchObject({
      action: "channels.delete",
      result: "failure",
      details: { reasons: ["the quotes.channel_id setting"] },
    });
  });

  it.each([
    [
      "a reaction role's channel",
      "a reaction role's private channel (Reaction Roles, mapping rr1)",
      "Reaction Roles",
    ],
    [
      "a poll destination",
      "a poll schedule's channel (Polls, schedule ps1)",
      "Polls",
    ],
  ])("refuses %s, naming the feature", async (_label, reason, feature) => {
    protection = new Map([[TEXT2, [reason]]]);
    await mount();
    const res = await harness.post(`/channels/${TEXT2}/delete`, {
      confirm: TEXT2,
    });
    expect(flashOf(res).msg).toContain(feature);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("refuses a non-empty category", async () => {
    await mount();
    const res = await harness.post(`/channels/${CAT}/delete`, {
      confirm: CAT,
    });
    expect(flashOf(res).msg).toContain("still holds 3 channels");
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("fails closed when the managed-channel lookup fails", async () => {
    protectionFails = true;
    await mount();
    const res = await harness.post(`/channels/${TEXT2}/delete`, {
      confirm: TEXT2,
    });
    expect(flashOf(res).msg).toContain("Couldn't verify");
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("treats Discord's Unknown Channel as already deleted", async () => {
    mockDelete.mockRejectedValue(
      Object.assign(new Error("Unknown Channel"), { code: 10003 }),
    );
    await mount();
    const res = await harness.post(`/channels/${TEXT2}/delete`, {
      confirm: TEXT2,
    });
    expect(flashOf(res).type).toBe("ok");
  });

  it("surfaces other Discord errors", async () => {
    mockDelete.mockRejectedValue(
      Object.assign(new Error("Missing Access"), { code: 50001 }),
    );
    await mount();
    const res = await harness.post(`/channels/${TEXT2}/delete`, {
      confirm: TEXT2,
    });
    expect(flashOf(res).msg).toContain("Missing Access");
  });

  it("refuses a channel the bot's permission overrides block", async () => {
    liveFlags = { deletable: false };
    await mount();
    const res = await harness.post(`/channels/${TEXT2}/delete`, {
      confirm: TEXT2,
    });
    expect(flashOf(res).msg).toContain("permission override");
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("says so when the channel is already gone", async () => {
    fetchMissing = true;
    await mount();
    const res = await harness.post(`/channels/${TEXT2}/delete`, {
      confirm: TEXT2,
    });
    expect(flashOf(res).msg).toContain("no longer exists");
  });
});

describe("GET /channels", () => {
  it("renders the tree, escaping channel names and topics", async () => {
    channels[1] = view(TEXT, {
      name: "<img src=x onerror=alert(1)>",
      topic: "<script>alert(2)</script>",
      parentId: CAT,
    });
    protection = new Map([[TEXT2, ["the quotes.channel_id setting"]]]);
    await mount();
    const res = await harness.get("/channels");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Channel Manager");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert(2)");
    expect(html).toContain("&lt;img src=x");
    expect(html).toContain("managed by KoolBot");
    expect(html).toContain("the quotes.channel_id setting");
    expect(html).toContain("Not managed here (GuildStageVoice)");
  });

  it("warns and disables every control without Manage Channels", async () => {
    canManage = false;
    await mount();
    const html = await (await harness.get("/channels")).text();
    expect(html).toContain("doesn't have the Manage Channels permission");
    expect(html).toMatch(
      /<button type="submit" class="btn btn-primary" disabled>Create/,
    );
  });

  it("explains an unreachable server instead of failing", async () => {
    await mount(makeClient({ guildFails: true }));
    const res = await harness.get("/channels");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Discord couldn&#39;t be reached");
  });

  it("warns that deleting is refused while the managed-channel lookup is down", async () => {
    protectionFails = true;
    await mount();
    const html = await (await harness.get("/channels")).text();
    expect(html).toContain("Deleting is refused");
  });
});

describe("GET /channels/:id/delete", () => {
  it("shows the confirmation with a CSRF-protected form that carries the confirm field", async () => {
    await mount();
    const html = await (await harness.get(`/channels/${TEXT2}/delete`)).text();
    expect(html).toContain("Delete permanently");
    expect(html).toContain(`action="/admin/channels/${TEXT2}/delete"`);
    expect(html).toContain(`name="confirm" value="${TEXT2}"`);
    expect(html).toContain('name="_csrf"');
    // The page itself deletes nothing.
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("shows the refusal, with no delete form, for a managed channel", async () => {
    protection = new Map([[TEXT2, ["the tickets.category_id setting"]]]);
    await mount();
    const html = await (await harness.get(`/channels/${TEXT2}/delete`)).text();
    expect(html).toContain("tickets.category_id");
    expect(html).not.toContain("Delete permanently");
  });

  it("fails closed when the lookup fails", async () => {
    protectionFails = true;
    await mount();
    const html = await (await harness.get(`/channels/${TEXT2}/delete`)).text();
    expect(html).toContain("Couldn&#39;t verify");
    expect(html).not.toContain("Delete permanently");
  });

  it("handles a missing channel, an unmanaged type and a missing permission", async () => {
    await mount();
    expect(
      await (await harness.get(`/channels/199999999999999999/delete`)).text(),
    ).toContain("no longer exists");
    expect(
      await (await harness.get(`/channels/${STAGE}/delete`)).text(),
    ).toContain("only text channels");
    canManage = false;
    const html = await (await harness.get(`/channels/${TEXT2}/delete`)).text();
    expect(html).toContain("Manage Channels");
    expect(html).not.toContain("Delete permanently");
  });

  it("redirects with a flash when Discord is unreachable", async () => {
    await mount(makeClient({ guildFails: true }));
    const res = await harness.get(`/channels/${TEXT2}/delete`);
    expect(res.status).toBe(303);
  });
});

describe("CSRF", () => {
  it("rejects a write without a CSRF token", async () => {
    await mount();
    const res = await harness.post(
      `/channels/${TEXT2}/delete`,
      { confirm: TEXT2 },
      { csrfCookie: null, csrfField: null },
    );
    expect(res.status).toBe(403);
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
