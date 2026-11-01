/**
 * @jest-environment <rootDir>/__tests__/jsdom-node-env.cjs
 */
import { describe, it, expect, jest, afterEach } from "@jest/globals";
import { AUTO_SUBMIT_SCRIPT } from "../../src/web/auto-submit.js";
import { renderAdoptPage } from "../../src/web/adopt-view.js";
import { installDocumentForAxe } from "./a11y-dom.js";
import { busyScan } from "./server-scan-fixtures.js";

/** A page body with one auto-applying form and one plain form. */
const FORMS = `
<form id="auto" method="get" action="/admin/adopt" data-autosubmit>
  <label><input type="checkbox" role="switch" name="sample" value="1"> Switch</label>
  <button type="submit" id="apply" data-autosubmit-hide>Apply</button>
</form>
<form id="plain" method="get" action="/x">
  <input type="checkbox" name="a" value="1">
  <button type="submit" id="plain-btn">Go</button>
</form>`;

function mount(): void {
  document.body.innerHTML = FORMS;
}

afterEach(() => {
  document.body.innerHTML = "";
  jest.restoreAllMocks();
});

describe("auto-submit script (#1630)", () => {
  it("hides the Apply button of an auto-applying form, and only that one", () => {
    mount();
    new Function(AUTO_SUBMIT_SCRIPT)();
    expect(document.getElementById("apply")!.hidden).toBe(true);
    expect(document.getElementById("plain-btn")!.hidden).toBe(false);
  });

  it("submits the form when its switch changes", () => {
    mount();
    const submit = jest
      .spyOn(HTMLFormElement.prototype, "requestSubmit")
      .mockImplementation(() => {});
    new Function(AUTO_SUBMIT_SCRIPT)();
    const box = document.querySelector<HTMLInputElement>("#auto input")!;
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    expect(submit).toHaveBeenCalledTimes(1);
    expect((submit.mock.contexts[0] as HTMLFormElement).id).toBe("auto");
  });

  it("leaves a form without data-autosubmit alone", () => {
    mount();
    const submit = jest
      .spyOn(HTMLFormElement.prototype, "requestSubmit")
      .mockImplementation(() => {});
    new Function(AUTO_SUBMIT_SCRIPT)();
    const box = document.querySelector<HTMLInputElement>("#plain input")!;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    expect(submit).not.toHaveBeenCalled();
  });

  it("falls back to submit() where requestSubmit is missing", () => {
    mount();
    const proto = HTMLFormElement.prototype as unknown as Record<
      string,
      unknown
    >;
    const original = proto.requestSubmit;
    delete proto.requestSubmit;
    const submit = jest
      .spyOn(HTMLFormElement.prototype, "submit")
      .mockImplementation(() => {});
    try {
      new Function(AUTO_SUBMIT_SCRIPT)();
      document
        .querySelector("#auto input")!
        .dispatchEvent(new Event("change", { bubbles: true }));
      expect(submit).toHaveBeenCalledTimes(1);
    } finally {
      proto.requestSubmit = original;
    }
  });

  it("works without JavaScript: the rendered form is a GET with a visible Apply", () => {
    const html = renderAdoptPage({
      csrfToken: "t",
      remainingMs: 1000,
      navFeatureStatus: {} as never,
      scan: busyScan(),
      sampled: false,
      tab: "overview",
    });
    // The page carries the script, but installDocumentForAxe drops scripts,
    // which is the same document a browser with JavaScript off ends up with.
    expect(html).toContain(AUTO_SUBMIT_SCRIPT);
    installDocumentForAxe(html);
    const form = document.querySelector<HTMLFormElement>(
      "form[data-autosubmit]",
    )!;
    expect(form.method).toBe("get");
    expect(form.getAttribute("action")).toBe("/admin/adopt");
    const apply = form.querySelector<HTMLButtonElement>(
      "[data-autosubmit-hide]",
    )!;
    expect(apply.textContent).toBe("Apply");
    expect(apply.hidden).toBe(false);
  });
});
