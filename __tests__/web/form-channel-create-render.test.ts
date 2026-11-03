/* global Element, HTMLFormElement, HTMLSelectElement */
/**
 * The Channel field of the Announcements and Polls forms as the Picker, and its
 * create row (#1665). Server markup only; the row's script is covered in
 * channel-picker-create.test.ts and the posting in form-channel-create-routes.test.ts.
 */
import { describe, it, expect } from "@jest/globals";
import { ChannelType } from "discord.js";
import { JSDOM } from "jsdom";
import {
  renderAnnouncementsPage,
  renderPollsPage,
} from "../../src/web/admin-views.js";
import type { PickerCreate } from "../../src/web/setting-pickers.js";

type AnnouncementsProps = Parameters<typeof renderAnnouncementsPage>[0];
type PollsProps = Parameters<typeof renderPollsPage>[0];

const CHANNELS = [
  { id: "1", name: "general", type: ChannelType.GuildText, parentName: null },
  { id: "2", name: "news", type: ChannelType.GuildText, parentName: "Info" },
];
const OK: PickerCreate = { kind: "channel", channelKind: "text", ok: true };
const NO: PickerCreate = {
  ...OK,
  ok: false,
  reason: "The bot needs Manage Channels.",
};
const COMMON = { csrfToken: "t", guildId: "g", remainingMs: 900_000 };

const announcements = (over: Partial<AnnouncementsProps> = {}): string =>
  renderAnnouncementsPage({
    ...COMMON,
    enabled: true,
    rows: [],
    textChannels: CHANNELS,
    ...over,
  } as AnnouncementsProps);

const polls = (over: Partial<PollsProps> = {}): string =>
  renderPollsPage({
    ...COMMON,
    enabled: true,
    defaultDurationHours: 24,
    cooldownDays: 7,
    settingRows: [],
    textChannels: CHANNELS,
    roles: [],
    items: [],
    schedules: [
      {
        id: "s1",
        channelId: "2",
        channelName: "news",
        channelType: ChannelType.GuildText,
        cron: "0 12 * * 3",
        durationHours: 24,
        pingRoleId: null,
        pingRoleName: null,
        enabled: true,
        lastRun: "—",
      },
    ],
    ...over,
  } as PollsProps);

/** Every Channel picker of a page: its wrapper, its select and the parsed meta. */
function channelPickers(html: string): Array<{
  form: string;
  wrapper: Element;
  select: HTMLSelectElement;
  meta: any;
}> {
  const doc = new JSDOM(html).window.document;
  return Array.from(doc.querySelectorAll("select[name='channelId']")).map(
    (select) => {
      const wrapper = select.parentElement as Element;
      return {
        form: (select.closest("form") as HTMLFormElement).getAttribute(
          "action",
        ) as string,
        wrapper,
        select: select as HTMLSelectElement,
        meta: JSON.parse(wrapper.getAttribute("data-picker-meta") as string),
      };
    },
  );
}
const createOf = (meta: any): unknown =>
  Array.isArray(meta) ? undefined : meta.create;

describe("the Channel field is the Picker (#1665)", () => {
  it("every channel select of the Announcements page is a span.kb-picker[data-picker]", () => {
    const pickers = channelPickers(announcements());
    expect(pickers.map((p) => p.form)).toEqual([
      "/admin/announcements/create",
      "/admin/announcements/post-once",
    ]);
    for (const p of pickers) {
      expect(p.wrapper.matches("span.kb-picker[data-picker]")).toBe(true);
      expect(p.select.required).toBe(true);
      expect(p.select.className).toBe("kb-select");
    }
  });

  it("every channel select of the Polls page is one: the edit row and the new schedule", () => {
    const pickers = channelPickers(polls());
    expect(pickers.map((p) => p.form)).toEqual([
      "/admin/polls/schedules/s1/edit",
      "/admin/polls/schedules/create",
    ]);
    for (const p of pickers) {
      expect(p.wrapper.matches("span.kb-picker[data-picker]")).toBe(true);
    }
  });

  it("keeps the options, and the stored channel stays selected on the edit row", () => {
    const edit = channelPickers(polls())[0];
    expect(
      Array.from(edit.select.options).map((o) => [
        o.value,
        o.textContent,
        o.selected,
      ]),
    ).toEqual([
      ["1", "# general", false],
      ["2", "# news · INFO", true],
    ]);
    // One meta entry per option, in markup order.
    expect(edit.meta).toHaveLength(edit.select.options.length);
  });

  it("a stored channel that is no longer listed stays selected as unavailable", () => {
    const html = polls({
      schedules: [
        {
          id: "s1",
          channelId: "999",
          channelName: "999",
          channelType: null,
          cron: "0 12 * * 3",
          durationHours: 24,
          pingRoleId: null,
          pingRoleName: null,
          enabled: true,
          lastRun: "—",
        },
      ],
    });
    const edit = channelPickers(html)[0];
    const selected = Array.from(edit.select.options).filter((o) => o.selected);
    expect(selected.map((o) => o.value)).toEqual(["999"]);
    expect(selected[0].textContent).toContain("unavailable");
    expect(edit.meta).toHaveLength(edit.select.options.length);
    expect(edit.meta[edit.meta.length - 1][0]).toBe("missing");
  });

  it("with no text channel at all, the empty row says so and meta stays in step", () => {
    const [create] = channelPickers(announcements({ textChannels: [] }));
    expect(Array.from(create.select.options).map((o) => o.textContent)).toEqual(
      ["(no text channels available)"],
    );
    expect(create.meta).toEqual([null]);
  });
});

describe("the create row is offered only when creation can work (#1665)", () => {
  it("offers it on every channel Picker of both pages when the bot can create", () => {
    for (const html of [
      announcements({ createChannel: OK }),
      polls({ createChannel: OK }),
    ]) {
      const pickers = channelPickers(html);
      expect(pickers.length).toBeGreaterThan(0);
      for (const p of pickers) expect(createOf(p.meta)).toEqual(OK);
    }
  });

  it("carries the help line, and no row, when the bot cannot create", () => {
    for (const html of [
      announcements({ createChannel: NO }),
      polls({ createChannel: NO }),
    ]) {
      for (const p of channelPickers(html)) {
        expect(createOf(p.meta)).toEqual(NO);
      }
    }
  });

  it("an unreadable answer adds neither row nor line: the plain array, as before", () => {
    for (const html of [announcements(), polls()]) {
      for (const p of channelPickers(html)) {
        expect(Array.isArray(p.meta)).toBe(true);
      }
      expect(html).not.toContain("&quot;create&quot;");
    }
  });

  it("the page sends the picker script that knows the create row only when a row asks for it", () => {
    expect(announcements({ createChannel: OK })).toContain("CR=1e6");
    expect(announcements()).not.toContain("CR=1e6");
  });
});

describe("a refused form keeps a pending creation (#1665)", () => {
  it("draws the typed name again as a pending option, with the error under the field", () => {
    const html = announcements({
      createChannel: OK,
      refusedForm: {
        formId: "announcement-create",
        errors: { channelId: "Discord refused to create the channel." },
        values: {
          channelId: "create:Daily News",
          cron: "0 9 * * *",
          message: "Hi",
        },
      },
    });
    const create = channelPickers(html)[0];
    const pending = Array.from(create.select.options).filter((o) => o.selected);
    expect(pending.map((o) => o.value)).toEqual(["create:Daily News"]);
    expect(pending[0].hasAttribute("data-create")).toBe(true);
    expect(pending[0].textContent).toBe("Daily News (will be created)");
    expect(create.select.getAttribute("aria-invalid")).toBe("true");
    expect(html).toContain('id="announcement-create-channelId-error"');
    expect(html).toContain("Discord refused to create the channel.");
    // The other form on the page is untouched.
    const once = channelPickers(html)[1];
    expect(
      Array.from(once.select.options).some((o) =>
        o.hasAttribute("data-create"),
      ),
    ).toBe(false);
  });

  it("the Polls schedule forms do the same, the edit form of its own row", () => {
    const values = {
      channelId: "create:Weekly Poll",
      cron: "0 12 * * 3",
      durationHours: "24",
      pingRoleId: "",
    };
    const edit = channelPickers(
      polls({
        createChannel: OK,
        refusedForm: {
          formId: "poll-schedule-edit-s1",
          errors: { channelId: "No." },
          values,
        },
      }),
    );
    expect(
      Array.from(edit[0].select.options)
        .filter((o) => o.selected)
        .map((o) => o.value),
    ).toEqual(["create:Weekly Poll"]);
    expect(
      Array.from(edit[1].select.options).some((o) =>
        o.hasAttribute("data-create"),
      ),
    ).toBe(false);
    const created = channelPickers(
      polls({
        createChannel: OK,
        refusedForm: {
          formId: "poll-schedule-create",
          errors: { channelId: "No." },
          values,
        },
      }),
    );
    expect(
      Array.from(created[1].select.options)
        .filter((o) => o.selected)
        .map((o) => o.value),
    ).toEqual(["create:Weekly Poll"]);
  });
});
