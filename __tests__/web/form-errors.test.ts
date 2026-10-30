import { describe, it, expect } from "@jest/globals";
import {
  addFieldError,
  formView,
  type RefusedForm,
} from "../../src/web/form-errors.js";

const refused: RefusedForm = {
  formId: "demo-create",
  errors: { cron: "Use five fields.", message: "At most 10 characters." },
  values: { cron: "<bad>", message: "hello", channelId: "c2", flag: "1" },
};

describe("addFieldError", () => {
  it("keeps the first message for a field", () => {
    const errors: Record<string, string> = {};
    addFieldError(errors, "cron", "first");
    addFieldError(errors, "cron", "second");
    addFieldError(errors, "message", "other");
    expect(errors).toEqual({ cron: "first", message: "other" });
  });
});

describe("formView for a form that was not refused", () => {
  it.each([undefined, null, { ...refused, formId: "other-form" }])(
    "renders nothing extra (%#)",
    (state) => {
      const v = formView(state, "demo-create");
      expect(v.refused).toBe(false);
      expect(v.value("cron", "0 9 * * *")).toBe("0 9 * * *");
      expect(v.checked("flag", true)).toBe(true);
      expect(v.attrs("cron")).toBe("");
      expect(v.error("cron")).toBe("");
      expect(v.open()).toBe("");
      expect(v.selected("channelId", "c1")).toBe("c1");
      expect(v.valueAttr("cron")).toBe("");
      expect(v.textareaContent("message", "a<b")).toBe("a&lt;b");
    },
  );
});

describe("formView for the refused form", () => {
  const v = formView(refused, "demo-create");

  it("keeps the typed value, ignoring the fallback", () => {
    expect(v.refused).toBe(true);
    expect(v.value("cron", "x")).toBe("<bad>");
    expect(v.value("missing", "fallback")).toBe("");
    expect(v.selected("channelId", "c1")).toBe("c2");
    expect(v.checked("flag", false)).toBe(true);
    expect(v.checked("other", true)).toBe(false);
  });

  it("starts a refused textarea with a newline so a leading blank line survives parsing", () => {
    expect(v.textareaContent("message", "ignored")).toBe("\nhello");
    expect(v.textareaContent("missing")).toBe("\n");
  });

  it("writes a value attribute only for a non-empty typed value", () => {
    expect(v.valueAttr("cron")).toBe(' value="&lt;bad&gt;"');
    expect(v.valueAttr("embedColor")).toBe("");
  });

  it("marks only refused fields, linked to a unique error line", () => {
    expect(v.attrs("cron")).toBe(
      ' id="demo-create-cron" aria-invalid="true" aria-describedby="demo-create-cron-error"',
    );
    expect(v.attrs("channelId")).toBe(' id="demo-create-channelId"');
    expect(v.error("cron")).toBe(
      '<p class="kb-field__error" id="demo-create-cron-error">Use five fields.</p>',
    );
    expect(v.error("channelId")).toBe("");
  });

  it("escapes messages and opens a disclosure", () => {
    const x = formView({ formId: "f", errors: { a: "<b>&" }, values: {} }, "f");
    expect(x.error("a")).toContain("&lt;b&gt;&amp;");
    expect(x.open()).toBe(" open");
  });

  it("keeps an existing describedby alongside the error line", () => {
    expect(v.attrs("cron", "help-id")).toContain(
      'aria-describedby="help-id demo-create-cron-error"',
    );
    expect(v.attrs("channelId", "help-id")).toContain(
      ' aria-describedby="help-id"',
    );
  });

  it("control carries its id on every render, refused or not (#1533)", () => {
    const plain = formView(null, "demo-create");
    expect(plain.control("cron")).toEqual({ id: "demo-create-cron" });
    expect(plain.control("cron", "help-id")).toEqual({
      id: "demo-create-cron",
      describedBy: "help-id",
    });
    expect(v.control("cron", "help-id")).toEqual({
      id: "demo-create-cron",
      invalid: true,
      describedByBase: "help-id",
      describedBy: "help-id demo-create-cron-error",
    });
    expect(v.control("channelId")).toEqual({ id: "demo-create-channelId" });
  });

  it("hands a control the same ids and error line as attrs does (#1530)", () => {
    expect(v.refusedControl("cron", "help-id")).toEqual({
      id: "demo-create-cron",
      invalid: true,
      describedByBase: "help-id",
      describedBy: "help-id demo-create-cron-error",
    });
    expect(v.refusedControl("channelId")).toEqual({
      id: "demo-create-channelId",
    });
    const plain = formView(null, "demo-create");
    expect(plain.refusedControl("cron")).toEqual({});
    expect(plain.refusedControl("cron", "help-id")).toEqual({
      describedBy: "help-id",
    });
  });
});
