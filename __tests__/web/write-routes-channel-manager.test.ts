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
import {
  ChannelType,
  DiscordAPIError,
  RateLimitError,
  type Client,
} from "discord.js";
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
let channelReads = 0;
let failChannelReadsFrom: number | null = null;
let recent: unknown = [];
jest.unstable_mockModule("../../src/web/channel-manager-data.js", () => ({
  fetchChannelViews: async () => {
    channelReads++;
    if (failChannelReadsFrom !== null && channelReads >= failChannelReadsFrom) {
      throw new Error("channels unreadable");
    }
    return channels;
  },
  maxBitrateOf: () => 96000,
  loadRecentChanges: async () => recent,
  botCanManageChannels: async () => canManage,
  loadProtection: async () => {
    if (protectionFails) throw new Error("db down");
    return protection;
  },
}));

const { confirmationToken } = await import("../../src/web/channel-manager.js");
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

const tok = (id: string): string =>
  confirmationToken(
    channels.find((c) => c.id === id) as ManagedChannelView,
    channels,
  );

const created = { id: "100000000000000099", name: "new-chan" };
const mockCreate = jest.fn<(...a: any[]) => Promise<any>>();
const mockEdit = jest.fn<(...a: any[]) => Promise<any>>();
const mockSetPosition = jest.fn<(...a: any[]) => Promise<any>>();
const mockDelete = jest.fn<(...a: any[]) => Promise<any>>();
/** The REST client: edits, moves and deletes are raw, cancellable requests. */
const mockRest = {
  post: jest.fn(async (_route: string, options: any): Promise<unknown> =>
    mockCreate(options.body, options),
  ),
  patch: jest.fn(async (route: string, options: any): Promise<unknown> => {
    if (/^\/channels\/\d+$/.test(route)) return mockEdit(options.body, options);
    return mockSetPosition(options.body, options);
  }),
  delete: jest.fn(async (_route: string, options: any): Promise<unknown> =>
    mockDelete(options),
  ),
};
let liveFlags: { manageable?: boolean; deletable?: boolean } = {};
let fetchMissing = false;

function makeClient(opts: { guildFails?: boolean } = {}): Client {
  const guild = {
    id: "guild-1",
    channels: {
      fetch: jest.fn(async (id: string) =>
        fetchMissing
          ? null
          : {
              id,
              isThread: () => false,
              ...liveFlags,
            },
      ),
    },
  };
  return {
    rest: mockRest,
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
    createChannelManagerRouter(client, mockRest as never),
  ]);
}
const flashOf = (res: Response) =>
  parseFlashRedirect(res.headers.get("location"));

/**
 * A refusal about fields (#1523): the page again with 422, every marked control
 * and each error line by its id.
 */
async function refusal(res: Response): Promise<{
  html: string;
  invalid: string[];
  lines: Record<string, string>;
}> {
  expect(res.status).toBe(422);
  const html = await res.text();
  const invalid = [...html.matchAll(/<[^>]*aria-invalid="true"[^>]*>/g)].map(
    (m) => /id="([^"]+)"/.exec(m[0])?.[1] ?? "",
  );
  const lines: Record<string, string> = {};
  for (const m of html.matchAll(
    /<p class="kb-field__error" id="([^"]+)">([^<]*)<\/p>/g,
  )) {
    lines[m[1]] = m[2].replaceAll("&#39;", "'");
  }
  return { html, invalid, lines };
}

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
  channelReads = 0;
  failChannelReadsFrom = null;
  recent = [];
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
      parent_id: CAT,
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
      user_limit: 5,
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
    expect(opts.parent_id).toBeUndefined();
  });

  it.each([
    ["an unknown type", { type: "forum", name: "x" }, "type", "Pick"],
    ["an empty name", { type: "text", name: "   " }, "name", "name"],
    [
      "a 101-character name",
      { type: "text", name: "x".repeat(101) },
      "name",
      "100",
    ],
    [
      "a 1025-character topic",
      { type: "text", name: "x", topic: "t".repeat(1025) },
      "topic",
      "1024",
    ],
    [
      "a user limit above 99",
      { type: "voice", name: "x", userLimit: "100" },
      "userLimit",
      "99",
    ],
    [
      "a bitrate above the server maximum",
      { type: "voice", name: "x", bitrate: "97" },
      "bitrate",
      "kbps",
    ],
    [
      "a bitrate below 8 kbps",
      { type: "voice", name: "x", bitrate: "7" },
      "bitrate",
      "kbps",
    ],
    [
      "a parent that is not a category",
      { type: "text", name: "x", parent: TEXT },
      "parent",
      "category",
    ],
    [
      "a parent that doesn't exist",
      { type: "text", name: "x", parent: "199999999999999999" },
      "parent",
      "category",
    ],
  ])(
    "rejects %s before calling Discord, marking its field",
    async (_label, body, field, fragment) => {
      await mount();
      const r = await refusal(await harness.post("/channels/create", body));
      expect(r.invalid).toEqual([`channel-create-${field}`]);
      expect(r.lines[`channel-create-${field}-error`]).toContain(fragment);
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockRecordAudit).toHaveBeenCalledTimes(1);
      expect(mockRecordAudit.mock.calls[0][1]).toMatchObject({
        action: "channels.create",
        result: "failure",
      });
    },
  );

  it("marks every refused field at once and keeps what was typed", async () => {
    await mount();
    const r = await refusal(
      await harness.post("/channels/create", {
        type: "voice",
        name: "  ",
        userLimit: " 100",
        bitrate: "7",
        parent: CAT,
        topic: "kept <b>as typed</b>",
      }),
    );
    expect(r.invalid).toEqual([
      "channel-create-name",
      "channel-create-userLimit",
      "channel-create-bitrate",
    ]);
    // The type and category the admin picked, and the limit as typed.
    expect(r.html).toContain('<option value="voice" selected>');
    expect(r.html).toContain(`<option value="${CAT}" selected>`);
    expect(r.html).toContain('value=" 100"');
    expect(r.html).toContain("kept &lt;b&gt;as typed&lt;/b&gt;");
    expect(mockCreate).not.toHaveBeenCalled();
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
    const r = await refusal(res);
    expect(r.lines["channel-create-parent-error"]).toContain("50 per category");
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

  it("sends no bitrate for an unrelated edit when the channel's bitrate isn't a whole number of kbps", async () => {
    // 65536 bps is shown as 66 kbps; posting 66 back means "unchanged".
    channels[3] = view(VOICE, {
      kind: "voice",
      name: "Hangout",
      typeLabel: "voice",
      parentId: CAT,
      userLimit: 4,
      bitrate: 65536,
    });
    await mount();
    const res = await harness.post(`/channels/${VOICE}/edit`, {
      name: "Hangout",
      userLimit: "7",
      bitrate: "66",
      parent: CAT,
    });
    expect(flashOf(res)).toMatchObject({ type: "ok" });
    const sent = mockEdit.mock.calls[0][0];
    expect(sent.user_limit).toBe(7);
    expect(sent).not.toHaveProperty("bitrate");
  });

  it("does not re-validate an unchanged bitrate that is now above the server maximum", async () => {
    // e.g. the server lost its boost: the stored 128 kbps shows as 128.
    channels[3] = view(VOICE, {
      kind: "voice",
      name: "Hangout",
      parentId: CAT,
      userLimit: 4,
      bitrate: 128000,
    });
    await mount();
    const res = await harness.post(`/channels/${VOICE}/edit`, {
      name: "Hangout",
      userLimit: "6",
      bitrate: "128",
      parent: CAT,
    });
    expect(flashOf(res).type).toBe("ok");
    expect(mockEdit.mock.calls[0][0]).not.toHaveProperty("bitrate");
  });

  it("refuses a bitrate edit when the live bitrate differs by less than 1 kbps from the one the form was drawn from", async () => {
    // The form was drawn at 65536 bps (shown 66); the channel is now 66000
    // bps, which also shows as 66. Posting 70 must not overwrite that change.
    channels[3] = view(VOICE, {
      kind: "voice",
      name: "Hangout",
      parentId: CAT,
      userLimit: 4,
      bitrate: 66000,
    });
    await mount();
    const res = await harness.post(`/channels/${VOICE}/edit`, {
      name: "Hangout",
      orig_name: "Hangout",
      userLimit: "4",
      orig_userLimit: "4",
      bitrate: "70",
      orig_bitrate: "66",
      orig_bitrate_bps: "65536",
      parent: CAT,
      orig_parent: CAT,
    });
    expect(flashOf(res).msg).toContain("changed elsewhere");
    expect(mockEdit).not.toHaveBeenCalled();
  });

  it("saves a bitrate edit when the exact original bitrate is unchanged", async () => {
    channels[3] = view(VOICE, {
      kind: "voice",
      name: "Hangout",
      parentId: CAT,
      userLimit: 4,
      bitrate: 65536,
    });
    await mount();
    await harness.post(`/channels/${VOICE}/edit`, {
      name: "Hangout",
      orig_name: "Hangout",
      userLimit: "4",
      orig_userLimit: "4",
      bitrate: "70",
      orig_bitrate: "66",
      orig_bitrate_bps: "65536",
      parent: CAT,
      orig_parent: CAT,
    });
    expect(mockEdit.mock.calls[0][0].bitrate).toBe(70000);
  });

  it("still sends a bitrate the admin actually changed", async () => {
    channels[3] = view(VOICE, {
      kind: "voice",
      name: "Hangout",
      parentId: CAT,
      userLimit: 4,
      bitrate: 65536,
    });
    await mount();
    await harness.post(`/channels/${VOICE}/edit`, {
      name: "Hangout",
      userLimit: "4",
      bitrate: "80",
      parent: CAT,
    });
    expect(mockEdit.mock.calls[0][0].bitrate).toBe(80000);
  });

  it("leaves an untouched multi-line topic alone even though browsers post CRLF", async () => {
    channels[1] = view(TEXT, {
      name: "general",
      parentId: CAT,
      topic: "line one\nline two",
    });
    await mount();
    await harness.post(`/channels/${TEXT}/edit`, {
      name: "general",
      topic: "line one\r\nline two",
      parent: CAT,
    });
    expect(mockEdit).not.toHaveBeenCalled();
  });

  it("a topic-only save after the channel was renamed elsewhere leaves the name alone", async () => {
    // The form was opened when the channel was called "old-name"; someone has
    // since renamed it. Posting the old name back must not rename it back.
    channels[1] = view(TEXT, {
      name: "renamed-elsewhere",
      parentId: CAT,
      topic: "hi",
    });
    await mount();
    const res = await harness.post(`/channels/${TEXT}/edit`, {
      name: "old-name",
      topic: "new topic",
      parent: CAT,
      orig_name: "old-name",
      orig_topic: "hi",
      orig_parent: CAT,
    });
    expect(flashOf(res)).toMatchObject({ type: "ok" });
    const sent = mockEdit.mock.calls[0][0];
    expect(sent.topic).toBe("new topic");
    expect(sent).not.toHaveProperty("name");
  });

  it.each([
    [
      "topic",
      { topic: "mine", orig_topic: "hi" },
      { topic: "changed elsewhere" },
    ],
    ["name", { name: "mine", orig_name: "general" }, { name: "theirs" }],
    [
      "category",
      { parent: "", orig_parent: CAT },
      { parentId: "100000000000000090" },
    ],
  ])(
    "refuses a %s edit when that field was changed elsewhere since the form was opened",
    async (_field, posted, liveChange) => {
      channels.push(
        view("100000000000000090", { kind: "category", name: "Other" }),
      );
      channels[1] = view(TEXT, {
        name: "general",
        parentId: CAT,
        topic: "hi",
        ...liveChange,
      });
      await mount();
      const res = await harness.post(`/channels/${TEXT}/edit`, {
        name: "general",
        topic: "hi",
        parent: CAT,
        orig_name: "general",
        orig_topic: "hi",
        orig_parent: CAT,
        ...posted,
      });
      const flash = flashOf(res);
      expect(flash.type).toBe("err");
      expect(flash.msg).toContain("changed elsewhere");
      expect(mockEdit).not.toHaveBeenCalled();
      expect(mockRecordAudit).toHaveBeenCalledTimes(1);
    },
  );

  it("refuses a bitrate or user limit edit that was changed elsewhere in the meantime", async () => {
    channels[3] = view(VOICE, {
      kind: "voice",
      name: "Hangout",
      parentId: CAT,
      userLimit: 9,
      bitrate: 80000,
    });
    await mount();
    for (const posted of [
      {
        userLimit: "5",
        orig_userLimit: "4",
        bitrate: "64",
        orig_bitrate: "64",
      },
      {
        userLimit: "4",
        orig_userLimit: "4",
        bitrate: "70",
        orig_bitrate: "64",
      },
    ]) {
      const res = await harness.post(`/channels/${VOICE}/edit`, {
        name: "Hangout",
        orig_name: "Hangout",
        parent: CAT,
        orig_parent: CAT,
        ...posted,
      });
      expect(flashOf(res).msg).toContain("changed elsewhere");
    }
    expect(mockEdit).not.toHaveBeenCalled();
  });

  it("saves an edited field while leaving a field changed elsewhere alone", async () => {
    channels[1] = view(TEXT, { name: "theirs", parentId: CAT, topic: "hi" });
    await mount();
    await harness.post(`/channels/${TEXT}/edit`, {
      name: "general",
      orig_name: "general",
      topic: "mine",
      orig_topic: "hi",
      parent: CAT,
      orig_parent: CAT,
    });
    const sent = mockEdit.mock.calls[0][0];
    expect(sent).toMatchObject({ topic: "mine" });
    expect(sent).not.toHaveProperty("name");
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
      user_limit: 10,
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
      parent_id: OTHER,
      lock_permissions: false,
    });
  });

  it("moves a channel out of its category", async () => {
    await mount();
    await harness.post(`/channels/${TEXT}/edit`, {
      name: "general",
      topic: "hi",
      parent: "",
    });
    expect(mockEdit.mock.calls[0][0]).toMatchObject({ parent_id: null });
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
    const r = await refusal(res);
    expect(r.lines[`channel-edit-${TEXT}-parent-error`]).toContain(
      "50 per category",
    );
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
    const r = await refusal(res);
    expect(r.invalid).toEqual([`channel-edit-${TEXT}-name`]);
    expect(mockEdit).not.toHaveBeenCalled();
  });
});

describe("a refused channel edit (#1523)", () => {
  it("reopens that channel's Edit form, marks the fields and keeps what was typed and the baselines", async () => {
    await mount();
    const r = await refusal(
      await harness.post(`/channels/${VOICE}/edit`, {
        orig_name: "Hangout",
        orig_userLimit: "4",
        orig_bitrate: "64",
        orig_bitrate_bps: "64000",
        orig_parent: CAT,
        name: " Hang out ",
        userLimit: "100",
        bitrate: "999",
        parent: "",
      }),
    );
    expect(r.invalid).toEqual([
      `channel-edit-${VOICE}-userLimit`,
      `channel-edit-${VOICE}-bitrate`,
    ]);
    expect(r.html).toContain('<details class="inline-edit" open>');
    // Typed text stays as typed; the baselines are the ones posted.
    expect(r.html).toContain('value=" Hang out "');
    expect(r.html).toContain('value="100"');
    expect(r.html).toContain(
      '<input type="hidden" name="orig_userLimit" value="4">',
    );
    expect(r.html).toContain(
      '<input type="hidden" name="orig_bitrate_bps" value="64000">',
    );
    expect(mockEdit).not.toHaveBeenCalled();
    expect(mockRecordAudit.mock.calls[0][1]).toMatchObject({
      action: "channels.edit",
      targetId: VOICE,
      result: "failure",
    });
  });

  it("keeps a topic as typed, including a leading blank line", async () => {
    await mount();
    const r = await refusal(
      await harness.post(`/channels/${TEXT}/edit`, {
        orig_name: "general",
        orig_topic: "hi",
        name: "general",
        topic: "\n" + "t".repeat(1025),
      }),
    );
    expect(r.invalid).toEqual([`channel-edit-${TEXT}-topic`]);
    expect(r.html).toContain(
      'aria-describedby="channel-edit-' + TEXT + '-topic-error">\n\n',
    );
  });

  it("keeps a conflict made elsewhere a page flash", async () => {
    await mount();
    const res = await harness.post(`/channels/${TEXT}/edit`, {
      orig_name: "was-called-this",
      name: "renamed",
    });
    expect(res.status).toBe(303);
    expect(flashOf(res).msg).toContain("changed elsewhere");
  });

  it("keeps an unreachable Discord a page flash", async () => {
    await mount(makeClient({ guildFails: true }));
    const res = await harness.post(`/channels/${TEXT}/edit`, {
      name: "x".repeat(101),
    });
    expect(res.status).toBe(303);
    expect(flashOf(res).msg).toContain("couldn't be reached");
  });

  it("says the channel is gone when it was deleted before the refusal", async () => {
    await mount();
    const res = await harness.post("/channels/199999999999999999/edit", {
      name: "x".repeat(101),
    });
    expect(res.status).toBe(303);
    expect(flashOf(res).msg).toBe("That channel no longer exists.");
  });

  it("falls back to the flash when the channels cannot be read to draw the page again", async () => {
    // The write reads the channels once to check the edit; the page reads them
    // again. If that second read fails, the refusal still comes back.
    await mount();
    failChannelReadsFrom = 2;
    const res = await harness.post(`/channels/${TEXT}/edit`, {
      name: "x".repeat(101),
    });
    expect(res.status).toBe(303);
    expect(flashOf(res).msg).toMatch(/^Not saved\. The name is 101/);
  });
});

describe("POST /channels/:id/move", () => {
  it("moves one step relative to its siblings", async () => {
    await mount();
    const res = await harness.post(`/channels/${TEXT2}/move`, {
      direction: "up",
    });
    expect(flashOf(res)).toMatchObject({ type: "ok" });
    // TEXT and TEXT2 are renumbered with TEXT2 first.
    expect(mockSetPosition.mock.calls[0][0]).toEqual([
      { id: TEXT2, position: 0 },
      { id: TEXT, position: 1 },
    ]);
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
    // Only CAT's text channels are renumbered; B (in the other category) is
    // not part of the move.
    expect(mockSetPosition.mock.calls[0][0]).toEqual([
      { id: C, position: 0 },
      { id: TEXT, position: 1 },
    ]);
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

  it("refuses a move drawn for a neighbour that is no longer adjacent", async () => {
    await mount();
    // TEXT2 sits below TEXT; the page showed Up swapping with some other channel.
    const stale = await harness.post(`/channels/${TEXT2}/move`, {
      direction: "up",
      neighbor: "100000000000000099",
    });
    expect(flashOf(stale).msg).toContain("changed since you opened this page");
    expect(mockSetPosition).not.toHaveBeenCalled();
    const fresh = await harness.post(`/channels/${TEXT2}/move`, {
      direction: "up",
      neighbor: TEXT,
    });
    expect(flashOf(fresh).type).toBe("ok");
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
      confirm: tok(TEXT2),
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

  it("rejects a confirmation shown before the channel was renamed, then accepts a fresh one", async () => {
    const shown = tok(TEXT2);
    channels = channels.map((c) =>
      c.id === TEXT2 ? { ...c, name: "renamed-since" } : c,
    );
    await mount();
    const stale = await harness.post(`/channels/${TEXT2}/delete`, {
      confirm: shown,
    });
    const flash = flashOf(stale);
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain(
      "changed since you opened the confirmation page",
    );
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockRecordAudit.mock.calls[0][1]).toMatchObject({
      action: "channels.delete",
      result: "failure",
    });
    const fresh = await harness.post(`/channels/${TEXT2}/delete`, {
      confirm: tok(TEXT2),
    });
    expect(flashOf(fresh).type).toBe("ok");
    expect(mockDelete).toHaveBeenCalledTimes(1);
  });

  it("rejects a confirmation shown before the channel was moved to another category", async () => {
    const shown = tok(TEXT2);
    channels = channels.map((c) =>
      c.id === TEXT2 ? { ...c, parentId: null } : c,
    );
    await mount();
    const res = await harness.post(`/channels/${TEXT2}/delete`, {
      confirm: shown,
    });
    expect(flashOf(res).msg).toContain("changed since");
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("rejects an empty category's confirmation once a channel was added to it", async () => {
    const EMPTY = "100000000000000080";
    channels = [...channels, view(EMPTY, { kind: "category", name: "Empty" })];
    const shown = tok(EMPTY);
    channels = [...channels, view("100000000000000081", { parentId: EMPTY })];
    await mount();
    const res = await harness.post(`/channels/${EMPTY}/delete`, {
      confirm: shown,
    });
    expect(flashOf(res).type).toBe("err");
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("refuses a channel KoolBot manages, naming the setting, and audits the refusal", async () => {
    protection = new Map([[TEXT2, ["the quotes.channel_id setting"]]]);
    await mount();
    const res = await harness.post(`/channels/${TEXT2}/delete`, {
      confirm: tok(TEXT2),
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
      confirm: tok(TEXT2),
    });
    expect(flashOf(res).msg).toContain(feature);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("refuses a non-empty category", async () => {
    await mount();
    const res = await harness.post(`/channels/${CAT}/delete`, {
      confirm: tok(CAT),
    });
    expect(flashOf(res).msg).toContain("still holds 3 channels");
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("fails closed when the managed-channel lookup fails", async () => {
    protectionFails = true;
    await mount();
    const res = await harness.post(`/channels/${TEXT2}/delete`, {
      confirm: tok(TEXT2),
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
      confirm: tok(TEXT2),
    });
    expect(flashOf(res).type).toBe("ok");
  });

  it("surfaces other Discord errors", async () => {
    mockDelete.mockRejectedValue(
      Object.assign(new Error("Missing Access"), { code: 50001 }),
    );
    await mount();
    const res = await harness.post(`/channels/${TEXT2}/delete`, {
      confirm: tok(TEXT2),
    });
    expect(flashOf(res).msg).toContain("Missing Access");
  });

  it("refuses a channel the bot's permission overrides block", async () => {
    liveFlags = { deletable: false };
    await mount();
    const res = await harness.post(`/channels/${TEXT2}/delete`, {
      confirm: tok(TEXT2),
    });
    expect(flashOf(res).msg).toContain("permission override");
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("says so when the channel is already gone", async () => {
    fetchMissing = true;
    await mount();
    const res = await harness.post(`/channels/${TEXT2}/delete`, {
      confirm: tok(TEXT2),
    });
    expect(flashOf(res).msg).toContain("no longer exists");
  });
});

describe("GET /channels: recent changes", () => {
  it("shows the page's own audit entries, escaped, so changes can be checked without a database tool", async () => {
    recent = [
      {
        at: "2026-10-16T13:22:36.000Z",
        actorId: "admin-1",
        action: "channels.edit",
        targetId: TEXT,
        channelName: "<b>general</b>",
        result: "success",
        message: null,
      },
      {
        at: "2026-10-16T13:26:58.000Z",
        actorId: "admin-1",
        action: "channels.delete",
        targetId: TEXT2,
        channelName: "quotes",
        result: "failure",
        message: "KoolBot manages quotes: <script>x</script>",
      },
    ];
    await mount();
    const html = await (await harness.get("/channels")).text();
    expect(html).toContain("Recent changes");
    expect(html).toContain("&lt;b&gt;general&lt;/b&gt;");
    expect(html).toContain("refused or failed");
    expect(html).not.toContain("<script>x</script>");
  });

  it("says so when the audit entries can't be read", async () => {
    recent = null;
    await mount();
    const html = await (await harness.get("/channels")).text();
    expect(html).toContain("The audit log couldn't be read");
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
    expect(html).toContain(`name="confirm" value="${tok(TEXT2)}"`);
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
      { confirm: tok(TEXT2) },
      { csrfCookie: null, csrfField: null },
    );
    expect(res.status).toBe(403);
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

describe("cancellable requests and rate limits", () => {
  const rateLimit = (
    waitMs: number,
    over: Record<string, unknown> = {},
  ): RateLimitError =>
    new RateLimitError({
      timeToReset: waitMs,
      retryAfter: waitMs,
      sublimitTimeout: 0,
      limit: 2,
      method: "PATCH",
      hash: "h",
      url: "https://discord.com/api/v10/channels/1",
      route: "/channels/:id",
      majorParameter: "1",
      global: false,
      scope: "user",
      ...over,
    });

  it("sends a user-limit-only edit as one PATCH with only that field and a cancel signal", async () => {
    channels[3] = view(VOICE, {
      kind: "voice",
      name: "Hangout",
      parentId: CAT,
      userLimit: 4,
      bitrate: 64000,
    });
    await mount();
    await harness.post(`/channels/${VOICE}/edit`, {
      name: "Hangout",
      orig_name: "Hangout",
      userLimit: "6",
      orig_userLimit: "4",
      bitrate: "64",
      orig_bitrate: "64",
      parent: CAT,
      orig_parent: CAT,
    });
    expect(mockRest.patch).toHaveBeenCalledTimes(1);
    expect(mockRest.patch.mock.calls[0][0]).toBe(`/channels/${VOICE}`);
    const options = mockRest.patch.mock.calls[0][1];
    expect(options.body).toEqual({ user_limit: 6 });
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    [
      "a bucket already known to be empty",
      { timeToReset: 540_000, retryAfter: 0 },
      "9 minutes",
    ],
    [
      "an actual 429 with a retry-after",
      { timeToReset: 0, retryAfter: 120_000 },
      "2 minutes",
    ],
    [
      "a rename sublimit",
      { timeToReset: 0, retryAfter: 0, sublimitTimeout: 600_000 },
      "10 minutes",
    ],
  ])(
    "reports %s with when to retry, changing nothing",
    async (_label, wait, expected) => {
      mockEdit.mockRejectedValue(rateLimit(0, wait));
      await mount();
      const res = await harness.post(`/channels/${TEXT}/edit`, {
        name: "general",
        topic: "new",
        parent: CAT,
      });
      const flash = flashOf(res);
      expect(flash.type).toBe("err");
      expect(flash.msg).toContain(expected);
      expect(flash.msg).toContain("cancelled");
      expect(mockRecordAudit.mock.calls[0][1]).toMatchObject({
        action: "channels.edit",
        result: "failure",
      });
    },
  );

  it("aborts the request and reports a timeout as an unknown outcome, not as unchanged", async () => {
    let signal: AbortSignal | undefined;
    mockEdit.mockImplementation(
      (_body: unknown, options: any) =>
        new Promise(() => {
          signal = options.signal;
        }),
    );
    mockApiCall.mockImplementationOnce(async (fn: () => Promise<unknown>) => {
      void fn();
      throw new Error(
        "Discord API timeout for edit channel; not retried because it may still complete",
      );
    });
    await mount();
    const res = await harness.post(`/channels/${TEXT}/edit`, {
      name: "general",
      topic: "new",
      parent: CAT,
    });
    const flash = flashOf(res);
    expect(flash.msg).toContain("unknown whether the change was applied");
    expect(flash.msg).not.toContain("nothing should have changed");
    expect(flash.msg).not.toContain("may still complete");
    expect(signal?.aborted).toBe(true);
  });

  it("sends a create as a cancellable raw POST and aborts it when it times out", async () => {
    let signal: AbortSignal | undefined;
    mockCreate.mockImplementation(
      (_body: unknown, options: any) =>
        new Promise(() => {
          signal = options.signal;
        }),
    );
    mockApiCall.mockImplementationOnce(async (fn: () => Promise<unknown>) => {
      void fn();
      throw new Error("Discord API timeout for create channel; not retried");
    });
    await mount();
    const res = await harness.post("/channels/create", {
      type: "text",
      name: "news",
    });
    expect(mockRest.post.mock.calls[0][0]).toBe("/guilds/guild-1/channels");
    expect(mockRest.post.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(flashOf(res).msg).toContain(
      "unknown whether the change was applied",
    );
    // The queued create is dropped, so a retry cannot make a duplicate.
    expect(signal?.aborted).toBe(true);
  });

  it("sends moves and deletes as cancellable requests too", async () => {
    await mount();
    await harness.post(`/channels/${TEXT2}/move`, { direction: "up" });
    expect(mockRest.patch.mock.calls[0][0]).toBe("/guilds/guild-1/channels");
    expect(mockRest.patch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    await harness.post(`/channels/${TEXT2}/delete`, { confirm: tok(TEXT2) });
    expect(mockRest.delete.mock.calls[0][0]).toBe(`/channels/${TEXT2}`);
    expect(mockRest.delete.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});

describe("overlapping saves and uncertain outcomes", () => {
  it("runs a second save only after the first completed, from a fresh read, so it sees the conflict", async () => {
    channels[1] = view(TEXT, { name: "general", parentId: CAT, topic: "hi" });
    // The first edit takes a while. Without the per-server lock the second
    // request would read the same snapshot meanwhile and also pass its checks.
    mockEdit.mockImplementationOnce(async (body: any) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      channels = channels.map((c) =>
        c.id === TEXT ? { ...c, name: body.name } : c,
      );
      return { name: body.name };
    });
    await mount();
    const form = (name: string): Record<string, string> => ({
      name,
      orig_name: "general",
      topic: "hi",
      orig_topic: "hi",
      parent: CAT,
      orig_parent: CAT,
    });
    const [first, second] = await Promise.all([
      harness.post(`/channels/${TEXT}/edit`, form("first-rename")),
      harness.post(`/channels/${TEXT}/edit`, form("second-rename")),
    ]);
    expect(flashOf(first).type).toBe("ok");
    const flash = flashOf(second);
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("changed elsewhere");
    expect(mockEdit).toHaveBeenCalledTimes(1);
    expect(mockEdit.mock.calls[0][0].name).toBe("first-rename");
  });

  it("reports a lost connection on a create as unconfirmed, not refused", async () => {
    mockCreate.mockRejectedValue(
      Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    );
    await mount();
    const res = await harness.post("/channels/create", {
      type: "text",
      name: "news",
    });
    const flash = flashOf(res);
    expect(flash.msg).toContain("unknown whether");
    expect(flash.msg).toContain("Check Discord before trying again");
    expect(flash.msg).not.toContain("refused");
  });

  it("reports a definite Discord rejection as refused", async () => {
    mockCreate.mockRejectedValue(
      new DiscordAPIError(
        { message: "Missing Permissions", code: 50013 },
        50013,
        403,
        "POST",
        "https://discord.com/api/v10/guilds/guild-1/channels",
        {},
      ),
    );
    await mount();
    const res = await harness.post("/channels/create", {
      type: "text",
      name: "news",
    });
    expect(flashOf(res).msg).toContain("Discord refused the change");
  });
});
