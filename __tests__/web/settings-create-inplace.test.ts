/* global HTMLSelectElement, HTMLElement, HTMLInputElement, HTMLFormElement */
/**
 * A saved creation updates the Picker in place (#1663): the AJAX save script
 * turns the pending option into the new channel without navigating, so unsaved
 * edits in the page's other sections survive. Real picker, save bar and save
 * scripts in jsdom; only `fetch` is stubbed.
 */
import { describe, it, expect, jest } from "@jest/globals";
import { JSDOM } from "jsdom";
import { ChannelType } from "discord.js";
import { SETTINGS_SAVE_SCRIPT } from "../../src/web/admin-layout.js";
import { CHANNEL_PICKER_CREATE_SCRIPT } from "../../src/web/setting-pickers.js";
import { SAVEBAR_SCRIPT, renderSaveBar } from "../../src/web/savebar.js";
import {
  renderFeatureSettingsCard,
  type SettingRow,
} from "../../src/web/admin-views.js";

const row = (key: string, current: string, type = "channel"): SettingRow =>
  ({
    key,
    label: key,
    current,
    defaultValue: "",
    type,
    description: "d",
    category: key.split(".")[0],
  }) as SettingRow;

function build(): { dom: JSDOM; fetchMock: ReturnType<typeof jest.fn> } {
  // Two section forms on one page, as on All settings: the first holds the
  // pending creation, the second an unsaved edit.
  const quotes = renderFeatureSettingsCard({
    category: "quotes",
    returnTo: "/admin/settings",
    csrfToken: "t",
    settingRows: [row("quotes.channel_id", "create:Quote Wall")],
    pickers: {
      textChannels: [
        {
          id: "1",
          name: "general",
          type: ChannelType.GuildText,
          parentName: null,
        },
      ],
      createChannel: { kind: "channel", channelKind: "text", ok: true },
    },
  });
  const other = `<form action="/admin/settings/save-section" method="post" data-savebar><input type="hidden" name="keys" value="x.text"><label for="x">Other</label><input id="x" name="value_x.text" value="saved">${renderSaveBar("Save")}</form>`;
  const dom = new JSDOM(
    `<!doctype html><body><main>${quotes}${other}</main></body>`,
    { runScripts: "outside-only" },
  );
  const fetchMock = jest.fn();
  (dom.window as unknown as { fetch: unknown }).fetch = fetchMock;
  dom.window.eval(CHANNEL_PICKER_CREATE_SCRIPT);
  dom.window.eval(SAVEBAR_SCRIPT);
  dom.window.eval(SETTINGS_SAVE_SCRIPT);
  return { dom, fetchMock };
}

const respond = (json: unknown): Promise<unknown> =>
  Promise.resolve({
    status: 200,
    text: () => Promise.resolve(JSON.stringify(json)),
  });
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));
};

describe("a saved creation, in place", () => {
  it("turns the pending option into the channel, keeps other sections' edits and does not navigate", async () => {
    const { dom, fetchMock } = build();
    const doc = dom.window.document;
    const select = doc.querySelector(
      'select[name="value_quotes.channel_id"]',
    ) as HTMLSelectElement;
    expect(select.value).toBe("create:Quote Wall");
    const trigger = doc.querySelector(".kb-picker__trigger") as HTMLElement;
    expect(trigger.textContent).toContain("(will be created)");
    // An unsaved edit in the other section.
    const other = doc.getElementById("x") as HTMLInputElement;
    other.value = "typed, not saved";
    other.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    let posted = "";
    fetchMock.mockImplementation((_url: unknown, init: any) => {
      posted = String(init.body);
      return respond({
        type: "ok",
        text: "Saved 1 setting in quotes. Created # quote-wall for quotes.channel_id.",
        invalidKeys: [],
        invalidReasons: {},
        created: [
          {
            key: "quotes.channel_id",
            id: "100000000000000100",
            name: "quote-wall",
          },
        ],
      });
    });
    const form = doc.querySelector(
      'form[action="/admin/settings/save-section"]',
    ) as HTMLFormElement;
    form.dispatchEvent(
      new dom.window.Event("submit", { bubbles: true, cancelable: true }),
    );
    await flush();

    // The posted value was the pending name; the server took it from there.
    expect(posted).toContain("value_quotes.channel_id=create%3AQuote+Wall");
    // The option is now the channel, at the same index, still selected.
    expect(select.value).toBe("100000000000000100");
    expect(select.querySelectorAll("[data-create]")).toHaveLength(0);
    const picked = select.options[select.selectedIndex];
    expect(picked.textContent).toBe("quote-wall");
    // The picker repainted: the channel as an existing one, nothing pending.
    expect(trigger.textContent).toContain("quote-wall");
    expect(trigger.textContent).not.toContain("will be created");
    // The other section kept its unsaved edit.
    expect(other.value).toBe("typed, not saved");
    // The saved form is clean again: the save bar hides.
    const bar = form.querySelector(
      "[data-savebar-bar], .kb-savebar",
    ) as HTMLElement | null;
    if (bar) expect(bar.hidden).toBe(true);
    // A second save posts the id, not a create value.
    let second = "";
    fetchMock.mockImplementation((_url: unknown, init: any) => {
      second = String(init.body);
      return respond({
        type: "ok",
        text: "Saved 1 setting in quotes.",
        invalidKeys: [],
      });
    });
    form.dispatchEvent(
      new dom.window.Event("submit", { bubbles: true, cancelable: true }),
    );
    await flush();
    expect(decodeURIComponent(second)).toContain(
      "value_quotes.channel_id=100000000000000100",
    );
    expect(second).not.toContain("create");
  });

  it("changes nothing when the response carries no created channel", async () => {
    const { dom, fetchMock } = build();
    const doc = dom.window.document;
    const select = doc.querySelector(
      'select[name="value_quotes.channel_id"]',
    ) as HTMLSelectElement;
    fetchMock.mockImplementation(() =>
      respond({
        type: "err",
        text: "No changes saved.",
        invalidKeys: ["quotes.channel_id"],
        invalidReasons: { "quotes.channel_id": "Missing Permissions" },
      }),
    );
    (
      doc.querySelector(
        'form[action="/admin/settings/save-section"]',
      ) as HTMLFormElement
    ).dispatchEvent(
      new dom.window.Event("submit", { bubbles: true, cancelable: true }),
    );
    await flush();
    expect(select.value).toBe("create:Quote Wall");
    expect(select.querySelectorAll("[data-create]")).toHaveLength(1);
  });
});
