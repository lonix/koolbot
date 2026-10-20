import { describe, it, expect } from "@jest/globals";
import { commandListsMatch } from "../../src/utils/command-diff.js";

type Cmd = Record<string, unknown>;

const sent = (): Cmd[] => [
  {
    name: "quote",
    description: "Quotes",
    default_member_permissions: "8",
    options: [
      { type: 3, name: "text", description: "Text", required: true },
      {
        type: 3,
        name: "kind",
        description: "Kind",
        choices: [{ name: "A", value: "a" }],
      },
    ],
  },
  { name: "ping", description: "Pong" },
];

// How Discord echoes the same payload back.
const echoed = (): Cmd[] => [
  {
    id: "2",
    application_id: "c",
    version: "1",
    guild_id: "g",
    type: 1,
    name: "ping",
    description: "Pong",
    name_localizations: null,
    description_localizations: null,
    default_member_permissions: null,
    dm_permission: true,
    nsfw: false,
  },
  {
    id: "1",
    application_id: "c",
    version: "1",
    guild_id: "g",
    type: 1,
    name: "quote",
    description: "Quotes",
    name_localizations: null,
    description_localizations: null,
    default_member_permissions: "8",
    dm_permission: true,
    nsfw: false,
    options: [
      { type: 3, name: "text", description: "Text", required: true },
      {
        description: "Kind",
        name: "kind",
        type: 3,
        required: false,
        autocomplete: false,
        choices: [{ value: "a", name: "A" }],
      },
    ],
  },
];

const opts = (c: Cmd): Cmd[] => c.options as Cmd[];

describe("commandListsMatch (#1307)", () => {
  it("matches despite order, defaults, ids and key order", () => {
    expect(commandListsMatch(sent(), echoed())).toBe(true);
  });

  it("treats number/bigint permission bits like Discord's string", () => {
    const s = sent();
    s[0].default_member_permissions = 8n;
    expect(commandListsMatch(s, echoed())).toBe(true);
    s[0].default_member_permissions = 8;
    expect(commandListsMatch(s, echoed())).toBe(true);
  });

  it("treats empty localisations / options as absent", () => {
    const s = sent();
    Object.assign(s[1], {
      name_localizations: {},
      options: [],
      dm_permission: undefined,
    });
    expect(commandListsMatch(s, echoed())).toBe(true);
  });

  it("detects an added command", () => {
    expect(
      commandListsMatch([...sent(), { name: "x", description: "" }], echoed()),
    ).toBe(false);
  });

  it("detects a removed command", () => {
    expect(commandListsMatch(sent().slice(0, 1), echoed())).toBe(false);
  });

  it("detects an edited option (description, required, choice, order)", () => {
    const a = sent();
    opts(a[0])[0].description = "Other";
    expect(commandListsMatch(a, echoed())).toBe(false);

    const b = sent();
    opts(b[0])[0].required = false;
    expect(commandListsMatch(b, echoed())).toBe(false);

    const c = sent();
    (opts(c[0])[1].choices as Cmd[])[0].value = "z";
    expect(commandListsMatch(c, echoed())).toBe(false);

    const d = sent();
    opts(d[0]).reverse();
    expect(commandListsMatch(d, echoed())).toBe(false);
  });

  it("detects a permission or nsfw change", () => {
    const a = sent();
    a[0].default_member_permissions = "32";
    expect(commandListsMatch(a, echoed())).toBe(false);
    const b = sent();
    b[1].nsfw = true;
    expect(commandListsMatch(b, echoed())).toBe(false);
  });

  it("compares contexts only when they are sent", () => {
    const s = sent();
    s[1].contexts = [0];
    expect(commandListsMatch(s, echoed())).toBe(false);
  });

  it("returns false (never throws) on bad input", () => {
    expect(commandListsMatch(sent(), null)).toBe(false);
    expect(commandListsMatch(sent(), { message: "x" })).toBe(false);
    expect(commandListsMatch([{ nope: 1 }], [{ nope: 1 }])).toBe(false);
    const dup = [{ name: "a" }, { name: "a" }];
    expect(commandListsMatch(dup, dup)).toBe(false);
    const cyc: Cmd = { name: "a" };
    cyc.self = cyc;
    expect(commandListsMatch([cyc], [{ name: "a" }])).toBe(false);
  });

  describe("malformed collections never compare equal", () => {
    const ping = (): Cmd[] => [{ name: "ping", description: "Pong" }];
    const bad = (extra: Cmd): Cmd[] => [
      {
        type: 1,
        name: "ping",
        description: "Pong",
        dm_permission: true,
        nsfw: false,
        ...extra,
      },
    ];

    it("top-level options / localisations / contexts", () => {
      expect(commandListsMatch(ping(), bad({ options: "invalid" }))).toBe(
        false,
      );
      expect(commandListsMatch(ping(), bad({ options: {} }))).toBe(false);
      expect(commandListsMatch(ping(), bad({ name_localizations: "x" }))).toBe(
        false,
      );
      expect(
        commandListsMatch(ping(), bad({ description_localizations: ["a"] })),
      ).toBe(false);
      expect(commandListsMatch(ping(), bad({ options: [1] }))).toBe(false);
    });

    it("nested options, choices, channel_types", () => {
      const withOpt = (o: Cmd): Cmd[] =>
        bad({ options: [{ type: 3, name: "a", description: "A", ...o }] });
      const desired = (): Cmd[] => [
        {
          name: "ping",
          description: "Pong",
          options: [{ type: 3, name: "a", description: "A" }],
        },
      ];
      expect(commandListsMatch(desired(), withOpt({}))).toBe(true);
      expect(commandListsMatch(desired(), withOpt({ options: "x" }))).toBe(
        false,
      );
      expect(commandListsMatch(desired(), withOpt({ choices: "x" }))).toBe(
        false,
      );
      expect(commandListsMatch(desired(), withOpt({ choices: [null] }))).toBe(
        false,
      );
      expect(
        commandListsMatch(desired(), withOpt({ channel_types: "x" })),
      ).toBe(false);
      expect(
        commandListsMatch(
          desired(),
          withOpt({
            choices: [{ name: "a", value: 1, name_localizations: 5 }],
          }),
        ),
      ).toBe(false);
    });

    it("absent markers (null, {}, []) still match", () => {
      expect(
        commandListsMatch(
          ping(),
          bad({
            options: [],
            name_localizations: {},
            description_localizations: null,
          }),
        ),
      ).toBe(true);
    });

    it("localisation changes are detected", () => {
      const s = ping();
      s[0].name_localizations = { nb: "ping" };
      expect(commandListsMatch(s, bad({}))).toBe(false);
      expect(
        commandListsMatch(s, bad({ name_localizations: { nb: "ping" } })),
      ).toBe(true);
      expect(
        commandListsMatch(ping(), bad({ name_localizations: { nb: "ping" } })),
      ).toBe(false);
    });
  });
});
