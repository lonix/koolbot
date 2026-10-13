/**
 * @jest-environment <rootDir>/__tests__/jsdom-node-env.cjs
 */

/**
 * `CONFIRM_SCRIPT` replaces the inline `onsubmit="return confirm(...)"` /
 * `onclick` handlers that the Web UI's CSP blocks (#1149). A declined prompt
 * must cancel the submit and stop later handlers (the Settings fetch save).
 */
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { CONFIRM_SCRIPT, escapeHtml } from "../../src/web/html.js";

function mount(html: string): void {
  document.body.innerHTML = html;
}

describe("CONFIRM_SCRIPT", () => {
  let confirmMock: jest.Mock<(msg?: string) => boolean>;

  beforeEach(() => {
    confirmMock = jest.fn<(msg?: string) => boolean>();
    (window as unknown as { confirm: unknown }).confirm = confirmMock;
    // Each run registers its own listeners on a fresh document.
    document.body.innerHTML = "";
    // eslint-disable-next-line no-new-func
    new Function(CONFIRM_SCRIPT)();
  });

  it("cancels a form submit and stops later handlers when declined", () => {
    mount('<form id="f" data-confirm="Delete it?"><button>Go</button></form>');
    confirmMock.mockReturnValue(false);
    const later = jest.fn();
    document.getElementById("f")!.addEventListener("submit", later);
    const ev = new window.Event("submit", { bubbles: true, cancelable: true });
    document.getElementById("f")!.dispatchEvent(ev);
    expect(confirmMock).toHaveBeenCalledWith("Delete it?");
    expect(ev.defaultPrevented).toBe(true);
    expect(later).not.toHaveBeenCalled();
  });

  it("lets the submit through when confirmed", () => {
    mount('<form id="f" data-confirm="Delete it?"></form>');
    confirmMock.mockReturnValue(true);
    const ev = new window.Event("submit", { bubbles: true, cancelable: true });
    document.getElementById("f")!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("ignores forms without data-confirm", () => {
    mount('<form id="f"></form>');
    const ev = new window.Event("submit", { bubbles: true, cancelable: true });
    document.getElementById("f")!.dispatchEvent(ev);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it("guards a submit button that carries its own data-confirm", () => {
    mount('<form><button id="b" data-confirm="Sure?">X</button></form>');
    confirmMock.mockReturnValue(false);
    const ev = new window.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    document.getElementById("b")!.dispatchEvent(ev);
    expect(confirmMock).toHaveBeenCalledWith("Sure?");
    expect(ev.defaultPrevented).toBe(true);
  });

  it("round-trips a hostile name through an escaped attribute as plain text", () => {
    const hostile = `x"><script>alert(1)</script> it's`;
    mount(`<form id="f" data-confirm="Delete ${escapeHtml(hostile)}?"></form>`);
    expect(document.querySelectorAll("script")).toHaveLength(0);
    expect(document.getElementById("f")!.getAttribute("data-confirm")).toBe(
      `Delete ${hostile}?`,
    );
  });
});
