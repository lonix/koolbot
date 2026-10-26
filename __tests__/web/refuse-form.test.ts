/**
 * `refuseForm` (#1517): the shared way a write route answers a refused form.
 * It is independent of any page; the page's renderer is registered by path.
 */
import { describe, it, expect, jest } from "@jest/globals";
import type { Request, Response } from "express";
import { refuseForm } from "../../src/web/routes/write/helpers.js";
import { registerFormPage } from "../../src/web/form-pages.js";

function fakeRes(): {
  res: Response;
  status: jest.Mock;
  send: jest.Mock;
  redirect: jest.Mock;
} {
  const send = jest.fn();
  const redirect = jest.fn();
  const status = jest.fn();
  const res = {
    status,
    type: jest.fn(),
    send,
    redirect,
  } as unknown as Response;
  status.mockReturnValue(res);
  (res.type as unknown as jest.Mock).mockReturnValue(res);
  return { res, status, send, redirect };
}

const req = {} as Request;

describe("refuseForm", () => {
  it("does nothing when no field was refused", async () => {
    const { res, status, redirect } = fakeRes();
    const answered = await refuseForm(req, res, {
      page: "/admin/demo",
      formId: "demo",
      errors: {},
      values: { a: "1" },
    });
    expect(answered).toBe(false);
    expect(status).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("renders the registered page with 422 and hands it the refused form", async () => {
    const page = '<p class="kb-field__error" id="demo-cron-error">x</p>';
    const render = jest.fn(async () => page);
    registerFormPage("/admin/demo", render);
    const { res, status, send, redirect } = fakeRes();
    const answered = await refuseForm(req, res, {
      page: "/admin/demo",
      formId: "demo",
      errors: { cron: "Use five fields." },
      values: { cron: "x" },
    });
    expect(answered).toBe(true);
    expect(render).toHaveBeenCalledWith(req, {
      formId: "demo",
      errors: { cron: "Use five fields." },
      values: { cron: "x" },
    });
    expect(status).toHaveBeenCalledWith(422);
    expect(send).toHaveBeenCalledWith(page);
    expect(redirect).not.toHaveBeenCalled();
  });

  it("redirects with the first message when the page has no renderer", async () => {
    const { res, status, redirect } = fakeRes();
    const answered = await refuseForm(req, res, {
      page: "/admin/unregistered",
      formId: "demo",
      errors: { a: "First.", b: "Second." },
      values: { a: "typed" },
    });
    expect(answered).toBe(true);
    expect(status).not.toHaveBeenCalled();
    const [code, location] = redirect.mock.calls[0] as [number, string];
    expect(code).toBe(303);
    expect(location).toMatch(/^\/admin\/unregistered\?flash=err&msg=/);
    expect(location).toContain("msg=Not+saved.+First.");
    // Typed text never goes into the URL.
    expect(location).not.toContain("typed");
  });

  it("falls back to the flash when the rendered page does not hold the refused form", async () => {
    // A row deleted in another tab: the page has no form with this id, so a
    // 422 would show no message and no marked field.
    registerFormPage("/admin/gone", async () => "<html>no such form</html>");
    const { res, status, send, redirect } = fakeRes();
    await refuseForm(req, res, {
      page: "/admin/gone",
      formId: "row-edit-9",
      errors: { cron: "Use five fields." },
      values: {},
    });
    expect(status).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledTimes(1);
  });

  it("falls back to the redirect when rendering fails", async () => {
    registerFormPage("/admin/broken", async () => {
      throw new Error("boom");
    });
    const { res, status, redirect } = fakeRes();
    await refuseForm(req, res, {
      page: "/admin/broken",
      formId: "demo",
      errors: { a: "First." },
      values: {},
    });
    expect(status).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledTimes(1);
  });
});
