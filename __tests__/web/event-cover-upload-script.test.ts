/**
 * @jest-environment <rootDir>/__tests__/jsdom-node-env.cjs
 */

/* global document, Element, Event, HTMLFormElement, HTMLInputElement */
/**
 * The cover upload page script (#1181, #1393), shared by the admin Events page
 * and the host's edit page: it is run in jsdom against the real markup of the
 * edit page, with a fake `window` (confirm, location) and a fake `fetch`.
 * What it must do: ask before it discards a changed event-edit form, follow the
 * reload URL only for a saved cover (a rejected one is shown in place), and
 * leave an unchanged page alone.
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { EVENT_COVER_UPLOAD_SCRIPT } from "../../src/web/event-cover-upload.js";
import { renderEventEditBody } from "../../src/web/event-edit-view.js";

type Reply = { type: string; text: string; reload?: string };

let confirmAnswer = true;
const confirmFn = jest.fn<(m: string) => boolean>(() => confirmAnswer);
const assign = jest.fn<(url: string) => void>();
const fetchFn = jest.fn<(...a: unknown[]) => Promise<unknown>>();

function reply(body: Reply): void {
  fetchFn.mockResolvedValue({
    status: 200,
    text: async () => JSON.stringify(body),
  });
}

function mount(hasCover = true): {
  edit: HTMLFormElement;
  upload: HTMLFormElement;
  remove: HTMLFormElement | null;
  title: HTMLInputElement;
  msg: Element;
} {
  const html = renderEventEditBody({
    csrfToken: "tok",
    cover: { kind: "editable", hasCover, series: false },
    event: {
      id: "65a000000000000000000001",
      title: "Quiz night",
      description: "Bring a friend",
      durationMinutes: 90,
      timezone: "UTC",
      date: "2099-06-01",
      time: "20:00",
      when: "2099-06-01 20:00 (UTC)",
      version: "v1",
      mode: "full",
    },
  });
  document.body.innerHTML = html;
  // The markup carries the page script; it is run below with fake globals, so
  // the parsed copy is dropped from the DOM (no text scraping of the HTML).
  document.querySelectorAll("script").forEach((el) => el.remove());
  const upload = document.querySelector(
    "form[data-cover-upload]",
  ) as HTMLFormElement;
  const file = upload.querySelector("input[type=file]") as HTMLInputElement;
  Object.defineProperty(file, "files", {
    value: [{ size: 10, name: "a.png" }],
    configurable: true,
  });
  new Function("window", "fetch", "document", EVENT_COVER_UPLOAD_SCRIPT)(
    { confirm: confirmFn, location: { assign } },
    fetchFn,
    document,
  );
  return {
    edit: document.querySelector("[data-event-edit-form]") as HTMLFormElement,
    upload,
    remove: document.querySelector("form[data-cover-remove]"),
    title: document.getElementById("edit-title") as HTMLInputElement,
    msg: upload.querySelector(".cover-msg") as Element,
  };
}

const submit = (f: HTMLFormElement): boolean =>
  f.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

beforeEach(() => {
  confirmAnswer = true;
  confirmFn.mockClear();
  assign.mockClear();
  fetchFn.mockReset();
});

describe("cover upload script", () => {
  it("uploads and follows the reload URL for a saved cover, without asking when nothing was edited", async () => {
    const { upload } = mount();
    reply({ type: "ok", text: "saved", reload: "/me/events/x/host/edit?f=1" });
    submit(upload);
    await settle();
    expect(confirmFn).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/me/events/x/host/edit?f=1");
  });

  it("asks before uploading over a changed details form, and uploads nothing when declined", async () => {
    const { upload, title } = mount();
    title.value = "Quiz night, edited";
    confirmAnswer = false;
    submit(upload);
    await settle();
    expect(confirmFn).toHaveBeenCalledTimes(1);
    expect(confirmFn.mock.calls[0][0]).toMatch(/unsaved changes/);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(title.value).toBe("Quiz night, edited");
  });

  it("uploads after the host confirms", async () => {
    const { upload, title } = mount();
    title.value = "Changed";
    reply({ type: "ok", text: "saved", reload: "/me/events/x/host/edit?f=1" });
    submit(upload);
    await settle();
    expect(confirmFn).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("does not reload after a rejected upload: the message shows in place and the draft stays", async () => {
    const { upload, title, msg } = mount();
    title.value = "Changed";
    reply({
      type: "err",
      text: "Cover image rejected: not an image",
      reload: "/me/events/x/host/edit?f=1",
    });
    submit(upload);
    await settle();
    expect(assign).not.toHaveBeenCalled();
    expect(msg.textContent).toBe("Cover image rejected: not an image");
    expect(title.value).toBe("Changed");
  });

  it("asks before removing over a changed details form, and cancels the removal when declined", () => {
    const { remove, title } = mount(true);
    title.value = "Changed";
    confirmAnswer = false;
    const proceeded = submit(remove as HTMLFormElement);
    expect(confirmFn).toHaveBeenCalledTimes(1);
    expect(proceeded).toBe(false);
  });

  it("lets a removal go ahead without asking when the details are unchanged", () => {
    const { remove } = mount(true);
    expect(submit(remove as HTMLFormElement)).toBe(true);
    expect(confirmFn).not.toHaveBeenCalled();
  });
});
