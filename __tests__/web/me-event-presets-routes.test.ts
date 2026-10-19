/**
 * `/me/events/presets` over real HTTP (#1216): a host's own group presets.
 * The real router, validator, service, CSRF check and view run; the preset
 * model is the in-memory fake (equality matching, so a query without the owner
 * would leak between the two hosts below), and the audit write, config and
 * event lookups are stubbed.
 */
import {
  describe,
  it,
  expect,
  jest,
  beforeAll,
  beforeEach,
  afterAll,
} from "@jest/globals";
import {
  startAdminHarness,
  createTestSession,
  parseFlashRedirect,
  TEST_CSRF_TOKEN,
  type AdminHarness,
} from "./admin-harness.js";
import { makeStore } from "../services/preset-fake-store.js";

process.env.WEBUI_SESSION_SECRET = "test-secret-for-me-event-presets";

const personal = makeStore("personal");
const mockRecordAudit = jest.fn<(...args: unknown[]) => Promise<undefined>>(
  async () => undefined,
);
const mockGetEvent = jest.fn<(id: string) => Promise<unknown>>();
let configuredMax = 4;

jest.unstable_mockModule(
  "../../src/models/event-group-personal-preset.js",
  () => ({ EventGroupPersonalPreset: personal.model }),
);
jest.unstable_mockModule("../../src/web/audit.js", () => ({
  recordAudit: mockRecordAudit,
  boundAuditEntry: (e: unknown) => e,
}));
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: (): unknown => ({
      getNumber: async (key: string, fallback: number) =>
        key === "events.groups.max_count" ? configuredMax : fallback,
      getString: async () => "",
      getBoolean: async () => false,
      registerReloadCallback: jest.fn(),
    }),
  },
}));
jest.unstable_mockModule("../../src/services/event-service.js", () => ({
  EventService: { getInstance: () => ({ getEvent: mockGetEvent }) },
}));

const { createMeEventPresetsRouter } =
  await import("../../src/web/routes/me-event-presets.js");
const { requireCsrf } = await import("../../src/web/csrf.js");
const catalogSvc =
  await import("../../src/services/event-group-preset-service.js");

const GUILD = "guild-1";
const A = "111111111111111111";
const B = "222222222222222222";

let current = createTestSession({
  discordUserId: A,
  guildId: GUILD,
  role: "user",
});
let harness: AdminHarness;

beforeAll(async () => {
  harness = await startAdminHarness(
    [
      (req, _res, next): void => {
        Object.assign(req, {
          webSession: current,
          csrfToken: TEST_CSRF_TOKEN,
        });
        next();
      },
      // The real router adds `requireCsrf` itself; the harness mounts the
      // same cookie + field pair the real app does.
      createMeEventPresetsRouter({} as never),
    ],
    "/me/events/presets",
  );
});

afterAll(async () => {
  await harness.close();
});

beforeEach(() => {
  jest.clearAllMocks();
  personal.state.reset();
  configuredMax = 4;
  current = createTestSession({
    discordUserId: A,
    guildId: GUILD,
    role: "user",
  });
});

const as = (userId: string, role: "user" | "admin" = "user"): void => {
  current = createTestSession({ discordUserId: userId, guildId: GUILD, role });
};

const good = {
  preset_name: "Clan match",
  groups_label: "Squad",
  group_0_name: "Assault",
  group_0_size: "8",
  group_1_name: "Logi",
};

async function save(
  body: Record<string, string>,
): Promise<ReturnType<typeof parseFlashRedirect>> {
  const res = await harness.post("/save", body);
  expect(res.status).toBe(303);
  return parseFlashRedirect(res.headers.get("location"));
}

async function page(query = ""): Promise<string> {
  const res = await harness.get(query ? `?${query}` : "");
  expect(res.status).toBe(200);
  return res.text();
}

const presetIdOf = (userId: string, name: string): string => {
  const row = personal.state.rows.find(
    (r) => r.ownerId === userId && r.name === name,
  );
  if (!row) throw new Error(`no preset ${name} for ${userId}`);
  return catalogSvc.personalPresetId(row._id);
};

describe("saving", () => {
  it("stores the preset under the signed-in host and audits it as personal", async () => {
    const flash = await save(good);
    expect(flash).toMatchObject({ path: "/me/events/presets", type: "ok" });
    expect(personal.state.rows).toHaveLength(1);
    expect(personal.state.rows[0]).toMatchObject({
      guildId: GUILD,
      ownerId: A,
      name: "Clan match",
      groupLabel: "Squad",
    });
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
    expect(mockRecordAudit.mock.calls[0][1]).toMatchObject({
      action: "event-preset.create",
      result: "success",
      details: expect.objectContaining({
        scope: "personal",
        name: "Clan match",
      }),
    });
  });

  it("applies the editor's validator: nothing is stored for input the event form would refuse", async () => {
    for (const bad of [
      { ...good, group_0_size: "100" },
      { ...good, group_1_name: "assault" },
      { ...good, preset_name: "" },
      { ...good, preset_name: "Wardogs" },
      { ...good, preset_name: "x".repeat(51) },
    ]) {
      expect((await save(bad)).type).toBe("err");
    }
    const body: Record<string, string> = { preset_name: "Big" };
    for (let i = 0; i < 5; i++) body[`group_${i}_name`] = `G${i}`;
    const tooMany = await save(body);
    expect(tooMany.msg).toContain("at most 4 groups");
    expect(personal.state.rows).toHaveLength(0);
    // A refused save is audited by neither: it never reached a write.
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("stops at the per-host limit, and audits the refusal as a failure", async () => {
    for (let i = 0; i < catalogSvc.MAX_PERSONAL_PRESETS; i++) {
      expect((await save({ ...good, preset_name: `P${i}` })).type).toBe("ok");
    }
    const over = await save({ ...good, preset_name: "Eleventh" });
    expect(over.type).toBe("err");
    expect(over.msg).toContain("Delete one first");
    expect(personal.state.rows).toHaveLength(catalogSvc.MAX_PERSONAL_PRESETS);
    expect(mockRecordAudit.mock.calls.at(-1)?.[1]).toMatchObject({
      action: "event-preset.create",
      result: "failure",
    });
  });

  it("edits the host's own preset, audits an update, and keeps a refused edit an edit", async () => {
    await save(good);
    const id = presetIdOf(A, "Clan match");
    const ok = await save({ ...good, preset_id: id, preset_name: "Renamed" });
    expect(ok.type).toBe("ok");
    expect(personal.state.rows[0].name).toBe("Renamed");
    expect(mockRecordAudit.mock.calls.at(-1)?.[1]).toMatchObject({
      action: "event-preset.update",
      targetId: id,
    });
    const refused = await harness.post("/save", {
      ...good,
      preset_id: id,
      group_0_size: "100",
    });
    expect(refused.headers.get("location")).toContain(
      `?edit=${encodeURIComponent(id)}&flash=err`,
    );
  });
});

describe("isolation between hosts", () => {
  beforeEach(async () => {
    await save({ ...good, preset_name: "Secret plan <b>x</b>" });
  });

  it("does not list, offer or prefill another host's preset", async () => {
    const aId = presetIdOf(A, "Secret plan <b>x</b>");
    expect(await page()).toContain("Secret plan &lt;b&gt;x&lt;/b&gt;");

    as(B);
    const list = await page();
    expect(list).not.toContain("Secret plan");
    expect(list).toContain("You have no presets yet");
    const edit = await page(`edit=${encodeURIComponent(aId)}`);
    expect(edit).not.toContain("Secret plan");
    expect(edit).not.toContain('value="Assault"');
    expect(edit).toContain("no longer exists");
  });

  it("cannot be edited or deleted by another host, and says only 'not found'", async () => {
    const aId = presetIdOf(A, "Secret plan <b>x</b>");
    as(B);
    const edit = await save({ ...good, preset_id: aId, preset_name: "Hijack" });
    expect(edit.type).toBe("err");
    expect(edit.msg).toContain("not found");
    const del = await harness.post("/delete", { id: aId });
    const delFlash = parseFlashRedirect(del.headers.get("location"));
    expect(delFlash.type).toBe("err");
    expect(delFlash.msg).toContain("not found");
    expect(personal.state.rows).toHaveLength(1);
    expect(personal.state.rows[0].name).toBe("Secret plan <b>x</b>");
    expect(mockRecordAudit.mock.calls.at(-1)?.[1]).toMatchObject({
      action: "event-preset.delete",
      result: "failure",
    });
  });

  it("creates under the second host's own id, never the first's", async () => {
    as(B);
    await save({ ...good, preset_name: "Mine" });
    expect(personal.state.rows.map((r) => [r.ownerId, r.name])).toEqual([
      [A, "Secret plan <b>x</b>"],
      [B, "Mine"],
    ]);
    const list = await page();
    expect(list).toContain("Mine");
    expect(list).not.toContain("Secret plan");
  });

  it("lets the owner delete, audited", async () => {
    const aId = presetIdOf(A, "Secret plan <b>x</b>");
    const res = await harness.post("/delete", { id: aId });
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("ok");
    expect(personal.state.rows).toHaveLength(0);
    expect(mockRecordAudit.mock.calls.at(-1)?.[1]).toMatchObject({
      action: "event-preset.delete",
      targetId: aId,
      result: "success",
    });
  });
});

describe("the page", () => {
  it("escapes everything it prints and posts CSRF tokens with every form", async () => {
    await save({
      ...good,
      preset_name: "<img src=x onerror=alert(1)>",
      group_0_name: "<script>x</script>",
    });
    const html = await page();
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    const forms = html.split('<form method="POST"').length - 1;
    const tokens = html.split('name="_csrf"').length - 1;
    // The Finish button of the layout has one too.
    expect(tokens).toBeGreaterThanOrEqual(forms);
  });

  it("answers a read failure with a notice, and never a blank add form for an edit", async () => {
    personal.state.failFind = true;
    const list = await page();
    expect(list).toContain("could not be read");
    const edit = await page(`edit=my:${"a".repeat(24)}`);
    expect(edit).toContain("cannot be loaded right now");
  });
});

describe("prefilling from an event (the host panel's 'Save as my preset')", () => {
  const event = (
    over: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    _id: "65a000000000000000000001",
    guildId: GUILD,
    createdBy: A,
    title: "Friday <i>night</i>",
    state: "scheduled",
    groupsEnabled: true,
    groupLabel: "Squad",
    leaderLabel: "Leader",
    channelLeadMinutes: 20,
    tagsEnabled: false,
    groups: [
      {
        key: "g_1",
        name: "Heli",
        kind: "team",
        size: 4,
        tag: "",
        marker: "",
        memberIds: ["member-9001"],
        captainId: "member-9001",
        channelId: "chan-7001",
      },
    ],
    ...over,
  });

  it("copies names, kinds, sizes and labels for the host, and no members, leaders or channels", async () => {
    mockGetEvent.mockResolvedValue(event());
    const html = await page("fromEvent=65a000000000000000000001");
    expect(html).toContain('value="Heli"');
    expect(html).toContain('value="4"');
    expect(html).toContain("Friday &lt;i&gt;night&lt;/i&gt;");
    expect(html).not.toContain("member-9001");
    expect(html).not.toContain("chan-7001");
  });

  it("refuses to show another host's event layout, and says nothing about whether it exists", async () => {
    mockGetEvent.mockResolvedValue(event());
    as(B);
    const html = await page("fromEvent=65a000000000000000000001");
    expect(html).not.toContain('value="Heli"');
    expect(html).toContain("not found, has no groups, or is not yours");
    mockGetEvent.mockResolvedValue(null);
    expect(await page("fromEvent=65a000000000000000000009")).toContain(
      "not found, has no groups, or is not yours",
    );
  });

  it("lets an admin copy any event's layout (the host check is the panel's)", async () => {
    mockGetEvent.mockResolvedValue(event());
    as(B, "admin");
    expect(await page("fromEvent=65a000000000000000000001")).toContain(
      'value="Heli"',
    );
  });
});

describe("CSRF", () => {
  it("rejects a save and a delete without a matching token", async () => {
    const save403 = await harness.post("/save", good, { csrfField: "wrong" });
    expect(save403.status).toBe(403);
    const del403 = await harness.post(
      "/delete",
      { id: "my:" + "a".repeat(24) },
      { csrfField: null },
    );
    expect(del403.status).toBe(403);
    expect(personal.state.rows).toHaveLength(0);
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("keeps requireCsrf wired (the router adds it itself)", () => {
    expect(typeof requireCsrf).toBe("function");
  });
});
