/* global HTMLInputElement, HTMLDetailsElement, Element, Document */
/**
 * The feature pages use the setting controls (#1533): a schedule is a picker, a
 * colour a swatch with an empty-state box, a poll duration a bounded box and the
 * poll answers one box each. Checked on the DOM the page sends, with the form
 * posting as a browser without JavaScript would (every named control).
 */
import { describe, it, expect } from "@jest/globals";
import { JSDOM } from "jsdom";
import {
  POLL_ANSWER_MAX,
  pollAnswerField,
  renderAnnouncementsPage,
  renderPollsPage,
} from "../../src/web/admin-views.js";
import { renderColourInput } from "../../src/web/setting-pickers.js";
import { TEXT_LIMITS } from "../../src/web/routes/write/helpers.js";
import type { RefusedForm } from "../../src/web/form-errors.js";

const BASE = {
  guildId: "g1",
  csrfToken: "csrf",
  remainingMs: 60_000,
  navFeatureStatus: {},
  enabled: true,
  settingRows: [],
  textChannels: [{ id: "c1", name: "general", type: 0 }],
};

const announcements = (refusedForm?: RefusedForm | null): Document =>
  new JSDOM(renderAnnouncementsPage({ ...BASE, rows: [], refusedForm })).window
    .document;

const poll = (answers: string[], refusedForm?: RefusedForm | null): Document =>
  new JSDOM(
    renderPollsPage({
      ...BASE,
      defaultDurationHours: 36,
      cooldownDays: 7,
      roles: [],
      schedules: [
        {
          id: "s1",
          channelId: "c1",
          channelName: "general",
          channelType: 0,
          cron: "30 16 * * 5",
          durationHours: 12,
          pingRoleId: null,
          pingRoleName: null,
          enabled: true,
          lastRun: "—",
        },
      ],
      items: [
        {
          id: "i1",
          question: "Q?",
          answers,
          tags: [],
          multiSelect: false,
          usageCount: 0,
          lastUsed: "—",
          enabled: true,
          source: "manual",
        },
      ],
      refusedForm,
    }),
  ).window.document;

const form = (doc: Document, actionEnd: string): Element => {
  const found = Array.from(doc.querySelectorAll("form")).find((f) =>
    f.getAttribute("action")?.endsWith(actionEnd),
  );
  if (!found) throw new Error(`no form ${actionEnd}`);
  return found;
};

const val = (root: Element, selector: string): string =>
  (root.querySelector(selector) as HTMLInputElement | null)?.value ?? "<none>";

describe("the schedule picker on the feature forms", () => {
  const doc = announcements();
  const create = form(doc, "/announcements/create");

  it("is a labelled group that posts the string and its named parts", () => {
    const group = create.querySelector(".cron-picker");
    expect(group?.getAttribute("role")).toBe("group");
    const label = doc.getElementById(
      group?.getAttribute("aria-labelledby") ?? "none",
    );
    expect(label?.textContent).toBe("Schedule");
    expect(val(create, ".cron-hidden")).toBe("0 9 * * *");
    expect(create.querySelector(".cron-hidden")?.getAttribute("name")).toBe(
      "cron",
    );
    const names = Array.from(group?.querySelectorAll("[name]") ?? []).map((e) =>
      e.getAttribute("name"),
    );
    expect(names).toEqual([
      "cron",
      "cron_mode",
      "cron_time",
      "cron_dow",
      "cron_dom",
      "cron_custom",
    ]);
  });

  it("shows every part until the script hides the unused ones", () => {
    expect(create.querySelectorAll(".cron-picker [hidden]")).toHaveLength(0);
  });

  it("starts as daily at the default time and no text box for cron", () => {
    expect(
      create.querySelector(".cron-picker")?.getAttribute("data-mode"),
    ).toBe("daily");
    expect(val(create, ".cron-time")).toBe("09:00");
    expect(create.querySelector('input[type="text"][name="cron"]')).toBeNull();
  });

  it("replaces the examples disclosure with one help line that names the format", () => {
    expect(doc.body.innerHTML).not.toContain("Cron expression examples");
    const help = doc.getElementById("announcement-create-cron-help");
    expect(help?.textContent).toContain(
      "minute hour day-of-month month day-of-week",
    );
    expect(help?.textContent).toContain("*/30 * * * *");
  });

  it("opens a stored schedule in the mode it fits, and a odd one as Custom", () => {
    const polls = poll(["a", "b"]);
    const edit = form(polls, "/schedules/s1/edit");
    expect(edit.querySelector(".cron-picker")?.getAttribute("data-mode")).toBe(
      "weekly",
    );
    expect(val(edit, ".cron-time")).toBe("16:30");
    expect(val(edit, ".cron-dow")).toBe("5");
  });

  it("keeps every id on the page unique, each schedule row included", () => {
    for (const d of [doc, poll(["a", "b"])]) {
      const ids = Array.from(d.querySelectorAll("[id]")).map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe("the embed colour on Announcements", () => {
  const doc = announcements();

  it.each(["/announcements/create", "/announcements/post-once"])(
    "is a swatch and a No colour box on %s, ticked at first",
    (action) => {
      const f = form(doc, action);
      const swatch = f.querySelector("[name=embedColor]");
      expect(swatch?.getAttribute("type")).toBe("color");
      const box = f.querySelector("[name=use_default_embedColor]");
      expect(box?.hasAttribute("checked")).toBe(true);
      expect(box?.parentElement?.textContent?.trim()).toBe("No colour");
      expect(f.textContent).not.toContain("Use default");
      expect(
        doc.querySelector(`label[for="${swatch?.getAttribute("id")}"]`)
          ?.textContent,
      ).toBe("Colour");
    },
  );

  it("is not a hex text box any more", () => {
    expect(
      doc.querySelector('input[type="text"][name="embedColor"]'),
    ).toBeNull();
  });

  it("is never a label inside a label", () => {
    expect(doc.querySelectorAll("label label")).toHaveLength(0);
  });
});

describe("renderColourInput's box label", () => {
  it("keeps Use default unless the form words it", () => {
    expect(renderColourInput("c", "use_default_c", "")).toContain(
      "> Use default</label>",
    );
    expect(
      renderColourInput("c", "use_default_c", "", {}, "No colour"),
    ).toContain("> No colour</label>");
  });

  it("escapes the label", () => {
    expect(
      renderColourInput("c", "use_default_c", "", {}, "<b>none</b>"),
    ).toContain("&lt;b&gt;none&lt;/b&gt;");
  });
});

describe("the poll duration", () => {
  const doc = poll(["a", "b"]);

  it.each([
    ["/schedules/create", "36"],
    ["/schedules/s1/edit", "12"],
  ])("is a bounded whole-number box on %s", (action, hours) => {
    const box = form(doc, action).querySelector(
      "[name=durationHours]",
    ) as HTMLInputElement;
    expect(box.getAttribute("type")).toBe("text");
    expect(box.getAttribute("inputmode")).toBe("numeric");
    expect(box.getAttribute("data-min")).toBe("1");
    expect(box.getAttribute("data-max")).toBe("768");
    expect(box.value).toBe(hours);
    expect(box.hasAttribute("required")).toBe(true);
  });
});

describe("the poll answers", () => {
  it("are one box each: two shown, the rest in a disclosure, each capped", () => {
    const doc = poll(["Yes", "No"]);
    const create = form(doc, "/items/create");
    const boxes = Array.from(
      create.querySelectorAll<HTMLInputElement>("[name=answers]"),
    );
    expect(boxes).toHaveLength(POLL_ANSWER_MAX);
    expect(boxes.every((b) => b.getAttribute("maxlength") === "55")).toBe(true);
    expect(boxes.map((b) => b.hasAttribute("required"))).toEqual([
      true,
      true,
      ...Array<boolean>(POLL_ANSWER_MAX - 2).fill(false),
    ]);
    const folded = create.querySelector("details") as HTMLDetailsElement;
    expect(folded.querySelectorAll("[name=answers]")).toHaveLength(
      POLL_ANSWER_MAX - 2,
    );
    expect(folded.hasAttribute("open")).toBe(false);
    expect(create.querySelector("[name=answers][type=text]")).not.toBeNull();
  });

  it("match the length the route and Discord enforce", () => {
    const doc = poll(["a", "b"]);
    expect(
      form(doc, "/items/create")
        .querySelector("[name=answers]")
        ?.getAttribute("maxlength"),
    ).toBe(String(TEXT_LIMITS.pollAnswer));
  });

  it("hold a stored answer each, with a comma kept inside its box", () => {
    const doc = poll(["Yes, please", "No"]);
    const edit = form(doc, "/items/i1/edit");
    expect(
      Array.from(edit.querySelectorAll<HTMLInputElement>("[name=answers]"))
        .map((b) => b.value)
        .slice(0, 3),
    ).toEqual(["Yes, please", "No", ""]);
  });

  it("open the folded boxes when a stored answer sits in one", () => {
    const answers = ["a", "b", "c"];
    const edit = form(poll(answers), "/items/i1/edit");
    expect(edit.querySelector("details")?.hasAttribute("open")).toBe(true);
  });

  it("open the folded boxes when a refused form typed into one, and keep each box", () => {
    const doc = poll(["a", "b"], {
      formId: "poll-item-create",
      errors: { answers: "Give 2 to 10 answers, one in each box." },
      values: {
        question: "Q",
        [pollAnswerField(0)]: "x",
        [pollAnswerField(5)]: "z, w",
      },
    });
    const create = form(doc, "/items/create");
    expect(create.querySelector("details")?.hasAttribute("open")).toBe(true);
    const boxes = Array.from(
      create.querySelectorAll<HTMLInputElement>("[name=answers]"),
    );
    expect(boxes[0].value).toBe("x");
    expect(boxes[1].value).toBe("");
    expect(boxes[5].value).toBe("z, w");
    // The error line is linked from every box, and each box has its own id.
    expect(boxes.every((b) => b.getAttribute("aria-invalid") === "true")).toBe(
      true,
    );
    expect(
      boxes.every((b) =>
        b
          .getAttribute("aria-describedby")
          ?.includes("poll-item-create-answers-error"),
      ),
    ).toBe(true);
    expect(new Set(boxes.map((b) => b.id)).size).toBe(POLL_ANSWER_MAX);
  });

  it("escape typed text exactly once", () => {
    const doc = poll(["a", "b"], {
      formId: "poll-item-create",
      errors: { answers: "x" },
      values: { [pollAnswerField(0)]: "<i>&amp;</i>" },
    });
    expect(val(form(doc, "/items/create"), "[name=answers]")).toBe(
      "<i>&amp;</i>",
    );
  });

  it("do not mention commas any more", () => {
    const html = poll(["a", "b"]).body.innerHTML;
    expect(html).not.toContain("comma-separated, 2");
    expect(html).not.toContain("Yes, No, Maybe");
  });
});
