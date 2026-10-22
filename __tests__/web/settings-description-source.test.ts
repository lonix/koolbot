/**
 * Setting descriptions come from the schema, never from a stored copy (#1302).
 * A `configs` row written before the fix carries the description the setting
 * had when it was first saved; the page must still show the current schema
 * text, through the real GET /admin/settings route and the shared
 * `buildSettingRows` used by the feature pages.
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
  type AdminHarness,
} from "./admin-harness.js";

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  isDebugMode: jest.fn(() => false),
}));

const OLD_TEXT = "Frozen description from an old install";
const ORPHAN_TEXT = "Stored text for a key the schema dropped";
const NEW_TEXT = "Brand new schema description for events";

const storedRows = [
  {
    key: "events.enabled",
    value: true,
    description: OLD_TEXT,
    category: "events",
  },
  {
    key: "retired.setting",
    value: "x",
    description: ORPHAN_TEXT,
    category: "core",
  },
];

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: (): unknown => ({
      getBoolean: jest.fn(async () => false),
      getString: jest.fn(async () => ""),
      getNumber: jest.fn(async () => 0),
      getAll: jest.fn(async () => storedRows),
      get: jest.fn(async () => null),
      registerReloadCallback: jest.fn(),
    }),
  },
}));

const { createReadOnlyRouter, buildSettingRows } =
  await import("../../src/web/read-only-routes.js");
const { settingsMetadata } =
  await import("../../src/services/config-schema.js");

const client = {
  user: { id: "bot" },
  guilds: {
    cache: new Map(),
    fetch: jest.fn(async () => {
      throw new Error("discord down");
    }),
  },
  commands: new Map(),
} as unknown as Client;

const meta = settingsMetadata["events.enabled"] as { description: string };
const originalDescription = meta.description;
let harness: AdminHarness;

beforeEach(async () => {
  meta.description = NEW_TEXT;
  harness = await startAdminHarness([
    createReadOnlyRouter(client, stubRequireSession(createTestSession())),
  ]);
});

afterEach(async () => {
  meta.description = originalDescription;
  await harness.close();
});

describe("GET /settings description source (#1302)", () => {
  it("shows the schema description, not the one stored in an old row", async () => {
    const res = await harness.get("/settings");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.includes(NEW_TEXT)).toBe(true);
    expect(html.includes(OLD_TEXT)).toBe(false);
  });

  it("still shows the stored description for a key the schema no longer has", async () => {
    const html = await (await harness.get("/settings")).text();
    expect(html.includes(ORPHAN_TEXT)).toBe(true);
  });
});

describe("buildSettingRows description source (#1302)", () => {
  it("prefers the schema description over a stored one but keeps the stored value", () => {
    const [row] = buildSettingRows(["events.enabled"], storedRows);
    expect(row.description).toBe(NEW_TEXT);
    expect(row.current).toBe(true);
  });

  it("falls back to the stored description only when the schema has none", () => {
    const [row] = buildSettingRows(["retired.setting"], storedRows);
    expect(row.description).toBe(ORPHAN_TEXT);
  });
});

describe("picker settings reach the rendered pages (#1426)", () => {
  const KEYS = [
    "events.timezone",
    "events.channel_prefix",
    "reactionroles.group_role_colour",
    "voicechannels.channel.prefix",
    "voicechannels.channel.suffix",
  ];

  it("carries each key's format on the rows the feature pages build", () => {
    expect(
      Object.fromEntries(
        buildSettingRows(KEYS, []).map((r) => [r.key, r.format]),
      ),
    ).toEqual({
      "events.timezone": "timezone",
      "events.channel_prefix": "emoji",
      "reactionroles.group_role_colour": "colour",
      "voicechannels.channel.prefix": "emoji",
      "voicechannels.channel.suffix": "emoji",
    });
  });

  it("renders them as pickers on the Settings page", async () => {
    const html = await (await harness.get("/settings")).text();
    expect(html).toContain(
      '<select class="kb-select" id="set-events.timezone"',
    );
    expect(html).toContain('type="color"');
    expect(html).toContain("data-emoji-field");
  });
});
