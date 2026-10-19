import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";

/**
 * The leader customiser's button and modal (#1196), with the REAL rules and the
 * REAL writer against the in-memory Event stand-in, so "a leader removed or a
 * switch turned off while the modal was open" is proven through the whole path.
 */

import {
  cstore,
  cupdates,
  cfake,
  CEventMock,
  type CDoc,
} from "../services/event-customise-fake-event.js";

jest.unstable_mockModule("../../src/models/event.js", () => ({
  Event: CEventMock,
}));
let eventsEnabled: boolean | "throw" | "hang" = true;
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: () => ({
      getBoolean: async () => {
        if (eventsEnabled === "throw") throw new Error("config down");
        if (eventsEnabled === "hang")
          return new Promise<boolean>(() => undefined);
        return eventsEnabled;
      },
    }),
  },
}));
jest.unstable_mockModule(
  "../../src/services/tracking-opt-out-service.js",
  () => ({
    TrackingOptOutService: { getInstance: () => ({ admission: () => 1 }) },
  }),
);
jest.unstable_mockModule("../../src/services/event-nickname-tags.js", () => ({
  EventNicknameTags: {
    getInstance: () => ({
      syncMember: jest.fn(async () => "none"),
      requestSweep: jest.fn(),
    }),
  },
}));
const recordAudit = jest.fn(async () => undefined);
jest.unstable_mockModule("../../src/web/audit.js", () => ({
  recordAudit,
  boundAuditEntry: <T>(e: T): T => e,
}));
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const {
  handleCustomiseButton,
  handleCustomiseModal,
  BUTTON_READ_DEADLINE_MS,
  BUTTON_TOTAL_BUDGET_MS,
  BUTTON_MIN_READ_MS,
  buttonReadBudget,
} = await import("../../src/handlers/event-customise-handler.js");
type Deps =
  import("../../src/services/event-leader-customise.js").CustomiseDeps;
const { getRenameQueue } =
  await import("../../src/services/event-rename-queue.js");

const GUILD = "111111111111111111";
const EV = "65a000000000000000000001";
const RED = "g_00000001";
const BLUE = "g_00000002";
const RED_CH = "200000000000000001";
const BLUE_CH = "200000000000000002";
const LEADER = "100000000000000001";
const OTHER = "100000000000000002";
const MEMBER = "100000000000000003";

function seed(over: Partial<CDoc> = {}): CDoc {
  const doc: CDoc = {
    _id: EV,
    guildId: GUILD,
    state: "active",
    groupsEnabled: true,
    captainsEnabled: true,
    captainCustomisationEnabled: true,
    tagsEnabled: true,
    leaderLabel: "Captain",
    groups: [
      {
        key: RED,
        name: "Red",
        tag: "RED",
        kind: "team",
        channelId: RED_CH,
        captainId: LEADER,
        memberIds: [LEADER, MEMBER],
      },
      {
        key: BLUE,
        name: "Blue",
        tag: "BLU",
        kind: "team",
        channelId: BLUE_CH,
        captainId: OTHER,
        memberIds: [OTHER],
      },
    ],
    ...over,
  };
  cstore.set(EV, doc);
  return doc;
}
const red = (): NonNullable<CDoc["groups"]>[number] =>
  cstore.get(EV)!.groups.find((g) => g.key === RED)!;

interface Reply {
  content?: string;
  flags?: unknown;
  allowedMentions?: unknown;
}

function makeButton(
  over: {
    customId?: string;
    guildId?: string | null;
    channelId?: string;
    userId?: string;
    createdTimestamp?: number;
  } = {},
) {
  const replies: Reply[] = [];
  const i = {
    customId: over.customId ?? `evcust:btn:${EV}:${RED}`,
    guildId: over.guildId === undefined ? GUILD : over.guildId,
    channelId: over.channelId ?? RED_CH,
    user: { id: over.userId ?? LEADER },
    createdTimestamp: over.createdTimestamp ?? Date.now(),
    client: {},
    replied: false,
    deferred: false,
    reply: jest.fn(async (p: Reply) => {
      replies.push(p);
      i.replied = true;
    }),
    showModal: jest.fn(async () => undefined),
  };
  return { i, replies };
}

function makeModal(
  fields: Record<string, string>,
  over: {
    customId?: string;
    guildId?: string | null;
    channelId?: string;
    userId?: string;
  } = {},
) {
  const replies: Reply[] = [];
  const order: string[] = [];
  const i = {
    customId: over.customId ?? `evcust:modal:${EV}:${RED}`,
    guildId: over.guildId === undefined ? GUILD : over.guildId,
    channelId: over.channelId ?? RED_CH,
    user: { id: over.userId ?? LEADER },
    client: {},
    replied: false,
    deferred: false,
    fields: {
      getTextInputValue: (id: string): string => {
        if (!(id in fields)) throw new Error("no such field");
        return fields[id];
      },
    },
    deferReply: jest.fn(async () => {
      order.push("defer");
      i.deferred = true;
    }),
    editReply: jest.fn(async (p: Reply) => {
      order.push("edit");
      replies.push(p);
    }),
    reply: jest.fn(async (p: Reply) => {
      replies.push(p);
    }),
  };
  return { i, replies, order };
}

const realDeps: Deps = {
  eventsEnabled: async () => true,
  syncName: async (_g, _e, key) => ({ groupKey: key, status: "applied" }),
  retag: () => undefined,
};
// The modal handler builds its own deps; stand in for the Discord side only.
jest.unstable_mockModule("../../src/services/event-service.js", () => ({
  EventService: {
    getInstance: () => ({
      syncGroupNames: async (_e: string, _g: string, key: string) => [
        { groupKey: key, status: "applied" },
      ],
    }),
  },
}));
void realDeps;

beforeEach(() => {
  cstore.clear();
  cupdates.length = 0;
  cfake.beforeNextUpdate = null;
  cfake.failFind = false;
  eventsEnabled = true;
  recordAudit.mockClear();
  getRenameQueue().forget(RED_CH);
  getRenameQueue().forget(BLUE_CH);
  seed();
});
afterEach(() => {
  jest.useRealTimers();
});

describe("the Customise team button (#1196)", () => {
  it("opens a modal with the team's name and tag for the team's leader", async () => {
    const { i, replies } = makeButton();
    await handleCustomiseButton(i as never);
    expect(replies).toHaveLength(0);
    expect(i.showModal).toHaveBeenCalledTimes(1);
    const modal = (i.showModal.mock.calls[0] as unknown[])[0] as {
      toJSON: () => {
        custom_id: string;
        components: Array<{
          components: Array<{
            custom_id: string;
            value: string;
            max_length: number;
          }>;
        }>;
      };
    };
    const json = modal.toJSON();
    expect(json.custom_id).toBe(`evcust:modal:${EV}:${RED}`);
    const fields = json.components.map((r) => r.components[0]);
    expect(fields.map((f) => f.custom_id)).toEqual(["name", "tag"]);
    expect(fields[0]).toMatchObject({ value: "Red", max_length: 50 });
    expect(fields[1]).toMatchObject({ value: "RED", max_length: 8 });
  });

  it("leaves the tag field out while the event does not use clan tags", async () => {
    cstore.get(EV)!.tagsEnabled = false;
    const { i } = makeButton();
    await handleCustomiseButton(i as never);
    const modal = (i.showModal.mock.calls[0] as unknown[])[0] as {
      toJSON: () => { components: unknown[] };
    };
    expect(modal.toJSON().components).toHaveLength(1);
  });

  const refused: Array<
    [string, () => ReturnType<typeof makeButton>, (() => void)?, RegExp?]
  > = [
    [
      "a team member who is not the leader",
      () => makeButton({ userId: MEMBER }),
      undefined,
      /Only the current captain/,
    ],
    [
      "another team's leader",
      () => makeButton({ userId: OTHER }),
      undefined,
      /Only the current captain/,
    ],
    ["a stranger", () => makeButton({ userId: "100000000000000099" })],
    [
      "a button copied into another channel",
      () => makeButton({ channelId: BLUE_CH }),
      undefined,
      /does not belong to this channel/,
    ],
    [
      "customisation off",
      () => makeButton(),
      () => void (cstore.get(EV)!.captainCustomisationEnabled = false),
      /not allowed captains/,
    ],
    [
      "leaders off",
      () => makeButton(),
      () => void (cstore.get(EV)!.captainsEnabled = false),
      /switched off/,
    ],
    [
      "an ended event",
      () => makeButton(),
      () => void (cstore.get(EV)!.state = "ended"),
      /no longer running/,
    ],
    [
      "events off",
      () => makeButton(),
      () => void (eventsEnabled = false),
      /switched off/,
    ],
    [
      "events unreadable",
      () => makeButton(),
      () => void (eventsEnabled = "throw"),
    ],
    [
      "an event of another server",
      () => makeButton({ guildId: "999999999999999999" }),
    ],
    [
      "a missing event",
      () =>
        makeButton({ customId: `evcust:btn:65a0000000000000000000ff:${RED}` }),
    ],
    [
      "an unknown team",
      () => makeButton({ customId: `evcust:btn:${EV}:g_ffffffff` }),
    ],
  ];
  it.each(
    refused.map((r) => [r[0], r[1], r[2] ?? null, r[3] ?? null] as const),
  )(
    "refuses %s, ephemeral and without a modal",
    async (_n, make, mutate, text) => {
      if (mutate) mutate();
      const { i, replies } = make();
      await handleCustomiseButton(i as never);
      expect(i.showModal).not.toHaveBeenCalled();
      expect(replies).toHaveLength(1);
      expect(replies[0].flags).toBeDefined();
      expect(replies[0].allowedMentions).toEqual({ parse: [] });
      expect(String(replies[0].content).length).toBeGreaterThan(10);
      if (text) expect(replies[0].content).toMatch(text);
    },
  );

  it.each([
    "evcust:btn",
    `evcust:modal:${EV}:${RED}`,
    `evcust:btn:${EV}:${RED}:x`,
    `evcust:btn:${EV}:${RED}\n`,
  ])(
    "a malformed or wrong-kind custom id (%j) is refused, nothing is read",
    async (customId) => {
      const { i, replies } = makeButton({ customId });
      await handleCustomiseButton(i as never);
      expect(i.showModal).not.toHaveBeenCalled();
      expect(replies[0].content).toMatch(/not valid/);
      expect(cupdates).toHaveLength(0);
    },
  );

  it("outside a server there is nothing to check: refused", async () => {
    const { i, replies } = makeButton({ guildId: null });
    await handleCustomiseButton(i as never);
    expect(i.showModal).not.toHaveBeenCalled();
    expect(replies).toHaveLength(1);
  });

  it("a read that does not come back in time answers 'try again' instead of letting the interaction die", async () => {
    jest.useFakeTimers();
    eventsEnabled = "hang";
    const { i, replies } = makeButton();
    const done = handleCustomiseButton(i as never);
    await jest.advanceTimersByTimeAsync(BUTTON_READ_DEADLINE_MS + 1);
    await done;
    expect(BUTTON_READ_DEADLINE_MS).toBeLessThan(3000);
    expect(i.showModal).not.toHaveBeenCalled();
    expect(replies).toHaveLength(1);
    expect(replies[0].content).toMatch(/Press the button again/);
  });

  it("the deadline counts from when Discord made the interaction, not from when the handler started", async () => {
    jest.useFakeTimers();
    eventsEnabled = "hang";
    // The dispatcher already used 2.4 s of Discord's 3: the read gets what is left.
    const { i, replies } = makeButton({ createdTimestamp: Date.now() - 2400 });
    const done = handleCustomiseButton(i as never);
    await jest.advanceTimersByTimeAsync(BUTTON_MIN_READ_MS + 1);
    await done;
    expect(replies).toHaveLength(1);
    expect(replies[0].content).toMatch(/Press the button again/);
    expect(i.showModal).not.toHaveBeenCalled();
  });

  it("buttonReadBudget: full budget when fresh, what is left when late, never below the minimum, tolerant of a bad clock", () => {
    const now = 1_000_000;
    expect(buttonReadBudget(now, now)).toBe(BUTTON_READ_DEADLINE_MS);
    expect(buttonReadBudget(now - 1000, now)).toBe(
      BUTTON_TOTAL_BUDGET_MS - 1000,
    );
    expect(buttonReadBudget(now - 2800, now)).toBe(BUTTON_MIN_READ_MS);
    expect(buttonReadBudget(now - 60_000, now)).toBe(BUTTON_MIN_READ_MS);
    // A clock that runs behind Discord's (a creation time in the future) or an
    // interaction without one never shortens the budget.
    expect(buttonReadBudget(now + 5000, now)).toBe(BUTTON_READ_DEADLINE_MS);
    expect(buttonReadBudget(undefined, now)).toBe(BUTTON_READ_DEADLINE_MS);
    expect(buttonReadBudget(Number.NaN, now)).toBe(BUTTON_READ_DEADLINE_MS);
    expect(BUTTON_TOTAL_BUDGET_MS).toBeLessThan(3000);
  });

  it("a team without a tag gets an empty tag field with no value (never an empty value)", async () => {
    red().tag = "";
    const { i } = makeButton();
    await handleCustomiseButton(i as never);
    const modal = (i.showModal.mock.calls[0] as unknown[])[0] as {
      toJSON: () => {
        components: Array<{ components: Array<Record<string, unknown>> }>;
      };
    };
    const tag = modal.toJSON().components[1].components[0];
    expect(tag.custom_id).toBe("tag");
    expect("value" in tag).toBe(false);
  });

  it("a failed read answers 'try again' too", async () => {
    cfake.failFind = true;
    const { i, replies } = makeButton();
    await handleCustomiseButton(i as never);
    expect(i.showModal).not.toHaveBeenCalled();
    expect(replies[0].content).toMatch(/Press the button again/);
  });

  it("reads the event of the interaction's own server only", async () => {
    const { i } = makeButton();
    await handleCustomiseButton(i as never);
    // seed() is in GUILD; a button from another server finds nothing.
    const other = makeButton({ guildId: "999999999999999999" });
    await handleCustomiseButton(other.i as never);
    expect(other.i.showModal).not.toHaveBeenCalled();
  });
});

describe("the modal submit (#1196)", () => {
  it("defers (ephemeral) before reading anything, then stores and answers with the result", async () => {
    const { i, replies, order } = makeModal({ name: "Crimson", tag: "CRM" });
    await handleCustomiseModal(i as never);
    expect(order[0]).toBe("defer");
    expect(i.deferReply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: expect.anything() }),
    );
    expect(red().name).toBe("Crimson");
    expect(red().tag).toBe("CRM");
    expect(replies).toHaveLength(1);
    expect(replies[0].content).toContain("Crimson");
    expect(replies[0].allowedMentions).toEqual({ parse: [] });
    // The edit is audited under the leader's id.
    expect(recordAudit).toHaveBeenCalledTimes(1);
    const [session, entry] = recordAudit.mock.calls[0] as unknown as [
      { discordUserId: string },
      { action: string; targetId: string },
    ];
    expect(session.discordUserId).toBe(LEADER);
    expect(entry).toMatchObject({
      action: "event.leader.customise",
      targetId: EV,
    });
  });

  it("a non-leader's submit is refused and stores nothing", async () => {
    const { i, replies } = makeModal(
      { name: "Hijacked", tag: "X" },
      { userId: MEMBER },
    );
    await handleCustomiseModal(i as never);
    expect(replies[0].content).toMatch(/Only the current captain/);
    expect(red().name).toBe("Red");
    expect(cupdates).toHaveLength(0);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("a leader cannot submit a modal for another team", async () => {
    const { i, replies } = makeModal(
      { name: "Hijacked" },
      { customId: `evcust:modal:${EV}:${BLUE}`, channelId: BLUE_CH },
    );
    await handleCustomiseModal(i as never);
    expect(replies[0].content).toMatch(/Only the current captain/);
    expect(cstore.get(EV)!.groups.find((g) => g.key === BLUE)!.name).toBe(
      "Blue",
    );
  });

  it("a switch turned off while the modal was open is rejected at submit", async () => {
    const button = makeButton();
    await handleCustomiseButton(button.i as never);
    expect(button.i.showModal).toHaveBeenCalled();
    // The host switches customisation off while the leader types.
    cstore.get(EV)!.captainCustomisationEnabled = false;
    const { i, replies } = makeModal({ name: "Crimson", tag: "CRM" });
    await handleCustomiseModal(i as never);
    expect(replies[0].content).toMatch(/not allowed captains/);
    expect(red().name).toBe("Red");
    expect(red().tag).toBe("RED");
  });

  it("a leader removed while the modal was open is rejected at submit", async () => {
    const button = makeButton();
    await handleCustomiseButton(button.i as never);
    red().captainId = MEMBER;
    const { i, replies } = makeModal({ name: "Crimson" });
    await handleCustomiseModal(i as never);
    expect(replies[0].content).toMatch(/Only the current captain/);
    expect(red().name).toBe("Red");
  });

  it("a leader removed in the instant between the read and the write is rejected too", async () => {
    cfake.beforeNextUpdate = () => void (red().captainId = null);
    const { i, replies } = makeModal({ name: "Crimson" });
    await handleCustomiseModal(i as never);
    expect(replies[0].content).toMatch(/Nothing was changed/);
    expect(red().name).toBe("Red");
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("an event that ended or events switched off while the modal was open is rejected", async () => {
    cstore.get(EV)!.state = "ended";
    const a = makeModal({ name: "Crimson" });
    await handleCustomiseModal(a.i as never);
    expect(a.replies[0].content).toMatch(/no longer running/);
    cstore.get(EV)!.state = "active";
    eventsEnabled = false;
    const b = makeModal({ name: "Crimson" });
    await handleCustomiseModal(b.i as never);
    expect(b.replies[0].content).toMatch(/switched off/);
    expect(red().name).toBe("Red");
  });

  it.each([
    ["an empty name", { name: "  " }, /name is required/i],
    ["a name that is too long", { name: "x".repeat(60) }, /at most 50/],
    [
      "a tag that is too long",
      { name: "Crimson", tag: "123456789" },
      /at most 8/,
    ],
    ["a control character", { name: "Cr\u0001imson" }, /control characters/],
  ])(
    "invalid input (%s) is explained and stores nothing",
    async (_n, fields, text) => {
      const { i, replies } = makeModal(fields as Record<string, string>);
      await handleCustomiseModal(i as never);
      expect(replies[0].content).toMatch(text);
      expect(red().name).toBe("Red");
      expect(cupdates).toHaveLength(0);
      expect(recordAudit).not.toHaveBeenCalled();
    },
  );

  it("a name another team uses is refused", async () => {
    const { i, replies } = makeModal({ name: "blue" });
    await handleCustomiseModal(i as never);
    expect(replies[0].content).toMatch(/already called/);
    expect(red().name).toBe("Red");
  });

  it("without a tag field (events without clan tags) the tag is left alone", async () => {
    const { i } = makeModal({ name: "Crimson" });
    await handleCustomiseModal(i as never);
    expect(red().name).toBe("Crimson");
    expect(red().tag).toBe("RED");
  });

  it("nothing changed is said plainly and not audited", async () => {
    const { i, replies } = makeModal({ name: "Red", tag: "RED" });
    await handleCustomiseModal(i as never);
    expect(replies[0].content).toMatch(/Nothing changed/);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("member text is shown as plain text and pings nobody", async () => {
    const { i, replies } = makeModal({ name: "@everyone <@1234>" });
    await handleCustomiseModal(i as never);
    const text = String(replies[0].content);
    expect(text).not.toContain("<@1234>");
    expect(text).not.toMatch(/@everyone/);
    expect(replies[0].allowedMentions).toEqual({ parse: [] });
  });

  it("a malformed custom id is still acknowledged and then refused", async () => {
    const { i, replies } = makeModal(
      { name: "x" },
      { customId: `evcust:modal:${EV}` },
    );
    await handleCustomiseModal(i as never);
    expect(i.deferReply).toHaveBeenCalled();
    expect(replies[0].content).toMatch(/not valid/);
    expect(cupdates).toHaveLength(0);
  });

  it("outside a server there is nothing to change", async () => {
    const { i, replies } = makeModal({ name: "x" }, { guildId: null });
    await handleCustomiseModal(i as never);
    expect(replies[0].content).toMatch(/not valid/);
    expect(cupdates).toHaveLength(0);
  });

  it("a store failure answers honestly instead of throwing", async () => {
    cfake.failFind = true;
    const { i, replies } = makeModal({ name: "Crimson" });
    await expect(handleCustomiseModal(i as never)).resolves.toBeUndefined();
    expect(replies[0].content).toMatch(/could not be read/);
  });
});
