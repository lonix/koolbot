import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import fs from "fs";
import path from "path";

const recordMock = jest.fn<(entry: any) => Promise<void>>();
const getBooleanMock = jest.fn<() => Promise<boolean>>();

jest.unstable_mockModule("../../src/utils/record-command-audit.js", () => ({
  recordCommandAudit: recordMock,
}));
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: () => ({ getBoolean: getBooleanMock }),
  },
}));
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

const {
  startComponentAudit,
  componentAuditLabel,
  resetComponentAuditLimiter,
  COMPONENT_AUDIT_MAX_PER_WINDOW,
  COMPONENT_AUDIT_UNKNOWN,
  COMPONENT_AUDIT_PREFIXES,
} = await import("../../src/utils/component-audit.js");

const interaction = (customId: string, over: Record<string, unknown> = {}) =>
  ({
    customId,
    guildId: "guild-1",
    channelId: "chan-1",
    user: { id: "user-1" },
    ...over,
  }) as any;

describe("component command audit (#1147)", () => {
  beforeEach(() => {
    recordMock.mockReset().mockResolvedValue(undefined);
    getBooleanMock.mockReset().mockResolvedValue(true);
    resetComponentAuditLimiter();
  });

  it("records one success row under a fixed label, never the custom id", async () => {
    const id = "vc_control_letin_111111_222222_333333";
    const audit = startComponentAudit(interaction(id), "button");
    await audit.done();

    expect(recordMock).toHaveBeenCalledTimes(1);
    const entry = recordMock.mock.calls[0][0];
    expect(entry).toMatchObject({
      guildId: "guild-1",
      discordUserId: "user-1",
      commandName: "component:vc_control",
      subcommand: null,
      channelId: "chan-1",
      channelName: null,
      result: "success",
      errorMessage: null,
    });
    expect(JSON.stringify(entry)).not.toContain("111111");
    expect(JSON.stringify(entry)).not.toContain("333333");
  });

  it("stores the name of the voice room a component was used in (#1420)", async () => {
    const audit = startComponentAudit(
      interaction("vc_control_letin_1_2_3", {
        channel: { type: 2, name: "Alice's room" },
      }),
      "button",
    );
    await audit.done();
    expect(recordMock.mock.calls[0][0].channelName).toBe("Alice's room");
  });

  it("records an unrecognised component as denied under the unknown label", async () => {
    const audit = startComponentAudit(
      interaction("something_with_user_999"),
      "button",
    );
    audit.unrecognised();
    await audit.done();

    const entry = recordMock.mock.calls[0][0];
    expect(entry.commandName).toBe(COMPONENT_AUDIT_UNKNOWN);
    expect(entry.result).toBe("denied");
    expect(JSON.stringify(entry)).not.toContain("999");
  });

  it("records only the error class name, not the message", async () => {
    const audit = startComponentAudit(
      interaction("vc_modal_rename_1"),
      "modal",
    );
    await audit.failed(new TypeError("user typed: my secret"));

    const entry = recordMock.mock.calls[0][0];
    expect(entry.result).toBe("error");
    expect(entry.errorMessage).toBe("TypeError");
    expect(entry.commandName).toBe("component:vc_modal");
  });

  it("records nothing when the command audit is switched off", async () => {
    getBooleanMock.mockResolvedValue(false);
    await startComponentAudit(interaction("lfg_join_1"), "button").done();
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("records nothing outside a guild", async () => {
    await startComponentAudit(
      interaction("lfg_join_1", { guildId: null }),
      "button",
    ).done();
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("bounds the rows one member can write per window", async () => {
    for (let i = 0; i < COMPONENT_AUDIT_MAX_PER_WINDOW + 10; i++) {
      await startComponentAudit(interaction("lfg_join_1"), "button").done();
    }
    expect(recordMock).toHaveBeenCalledTimes(COMPONENT_AUDIT_MAX_PER_WINDOW);

    // Another member is not affected.
    await startComponentAudit(
      interaction("lfg_join_1", { user: { id: "user-2" } }),
      "button",
    ).done();
    expect(recordMock).toHaveBeenCalledTimes(
      COMPONENT_AUDIT_MAX_PER_WINDOW + 1,
    );
  });

  it("never lets an audit failure reach the caller", async () => {
    recordMock.mockRejectedValue(new Error("db down"));
    await expect(
      startComponentAudit(interaction("lfg_join_1"), "button").done(),
    ).resolves.toBeUndefined();
  });

  it("labels every prefix the dispatcher in src/index.ts routes", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src", "index.ts"),
      "utf8",
    );
    const start = source.indexOf("// Handle button interactions");
    const end = source.indexOf(
      "if (!interaction.isChatInputCommand()) return;",
    );
    const block = source.slice(start, end);
    const routed = [
      ...block.matchAll(/customId\.startsWith\("([^"]+)"\)/g),
    ].map((m) => m[1]);
    expect(routed.length).toBeGreaterThan(5);

    const known = new Set(
      Object.values(COMPONENT_AUDIT_PREFIXES)
        .flat()
        .map(([prefix]) => prefix),
    );
    for (const prefix of routed) {
      expect(known.has(prefix)).toBe(true);
    }
    // Exact ids: the reaction-role menu and the rules button.
    expect(componentAuditLabel("select", "reactrole:sel")).toBe(
      "component:reactrole_select",
    );
    expect(componentAuditLabel("button", "rules:accept")).toBe(
      "component:rules_accept",
    );
  });

  it("keeps button, select and modal labels from colliding", () => {
    expect(componentAuditLabel("button", "vc_preset_x")).toBe(
      "component:vc_preset",
    );
    expect(componentAuditLabel("select", "vc_preset_x")).toBe(
      "component:vc_preset_select",
    );
    expect(componentAuditLabel("modal", "nothing")).toBe(
      COMPONENT_AUDIT_UNKNOWN,
    );
  });
});
