import { describe, it, expect } from "@jest/globals";
import { ButtonStyle } from "discord.js";
import {
  buildControlPanel,
  isControlPanelTitle,
  CONTROL_PANEL_TITLE,
  LEGACY_CONTROL_PANEL_TITLE,
} from "../../src/utils/voice-control-panel.js";
import { embedColor } from "../../src/utils/embed-style.js";

const base = {
  channelId: "c1",
  ownerId: "o1",
  isPrivate: false,
  isLive: false,
  hasWaitingRoom: false,
  presetsEnabled: false,
};

function buttons(state: Parameters<typeof buildControlPanel>[0]) {
  return buildControlPanel(state).components.flatMap((r) =>
    r.components.map((b) => b.data as Record<string, unknown>),
  );
}

describe("buildControlPanel (#1519)", () => {
  it("names the room as a mention and states facts as inline fields", () => {
    const { embed } = buildControlPanel({
      ...base,
      isPrivate: true,
      isLive: true,
      hasWaitingRoom: true,
    });
    expect(embed.data.title).toBe("🔊 Room controls");
    expect(embed.data.description).toBe(
      "Controls for <#c1>. Only its owner can use these buttons.",
    );
    expect(embed.data.fields).toEqual([
      { name: "Privacy", value: "Invite only", inline: true },
      { name: "Live", value: "Yes", inline: true },
      { name: "Waiting room", value: "On", inline: true },
    ]);
    expect(embed.data.footer?.text).toBe("KoolBot · Voice channels");
  });

  it("uses ok while live and neutral otherwise, never for privacy", () => {
    expect(buildControlPanel({ ...base, isLive: true }).embed.data.color).toBe(
      embedColor("ok"),
    );
    expect(buildControlPanel(base).embed.data.color).toBe(
      embedColor("neutral"),
    );
    expect(
      buildControlPanel({ ...base, isPrivate: true }).embed.data.color,
    ).toBe(embedColor("neutral"));
  });

  it("uses sentence-case labels and Danger only for removing the waiting room", () => {
    const off = buttons(base);
    expect(off.map((b) => b.label)).toEqual([
      "Rename",
      "Make private",
      "Invite",
      "Transfer",
      "Go live",
      "Add waiting room",
    ]);
    expect(off.filter((b) => b.style === ButtonStyle.Danger)).toHaveLength(0);
    expect(off[0].style).toBe(ButtonStyle.Primary);

    const on = buttons({
      ...base,
      isPrivate: true,
      isLive: true,
      hasWaitingRoom: true,
      presetsEnabled: true,
    });
    expect(on.map((b) => b.label)).toEqual([
      "Rename",
      "Make public",
      "Invite",
      "Transfer",
      "Go offline",
      "Remove waiting room",
      "Choose preset",
    ]);
    const danger = on.filter((b) => b.style === ButtonStyle.Danger);
    expect(danger.map((b) => b.label)).toEqual(["Remove waiting room"]);
    expect(on[2].disabled).toBeFalsy();
    expect(buttons(base)[2].disabled).toBe(true);
  });

  it("keeps the custom ids so buttons on old posts keep working", () => {
    expect(
      buttons({ ...base, presetsEnabled: true }).map((b) => b.custom_id),
    ).toEqual([
      "vc_control_name_c1_o1",
      "vc_control_privacy_c1_o1",
      "vc_control_invite_c1_o1",
      "vc_control_transfer_c1_o1",
      "vc_control_live_c1_o1",
      "vc_control_waitingroom_c1_o1",
      "vc_preset_open_c1_o1",
    ]);
  });

  it("recognises both the new and the pre-#1519 title", () => {
    expect(isControlPanelTitle(CONTROL_PANEL_TITLE)).toBe(true);
    expect(isControlPanelTitle(LEGACY_CONTROL_PANEL_TITLE)).toBe(true);
    expect(isControlPanelTitle("Something else")).toBe(false);
    expect(isControlPanelTitle(null)).toBe(false);
  });
});
