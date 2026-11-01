/**
 * The session banner script (#1635) in jsdom, for both surfaces. It runs with
 * a clock and timers the test owns, so a sleep of hours is one call.
 *
 * What it proves: after the page wakes from a long gap the countdown ends at
 * once and sends the browser to the sign-in path, whatever the pointer or
 * keyboard did first; a 401 from the ping does the same; and the number on
 * screen never exceeds what the server last confirmed, because the server
 * counts real requests only (a mouse move is not one).
 */
import { describe, it, expect } from "@jest/globals";
import { JSDOM } from "jsdom";
import { sessionBannerScript } from "../../src/web/session-banner.js";

const MINUTE = 60 * 1000;
const WINDOW = 30 * MINUTE;

interface PingReply {
  status: number;
  body?: unknown;
}

interface Harness {
  dom: JSDOM;
  fakeWindow: { location: { href: string } };
  text: () => string;
  lowClass: () => boolean;
  advance: (ms: number) => void;
  /** Jump the clock without running any timer, like a laptop waking up. */
  sleep: (ms: number) => void;
  fire: (type: string) => void;
  /** Let the pending fetch promise chains settle. */
  settle: () => Promise<void>;
  fetched: string[];
  replyWith: (r: PingReply | "network-error") => void;
}

const SURFACES = [
  { name: "admin", ping: "/admin/session/ping", home: "/admin/" },
  { name: "/me", ping: "/me/session/ping", home: "/me/" },
] as const;

function mount(
  surface: (typeof SURFACES)[number],
  remainingMs: number,
): Harness {
  const dom = new JSDOM(
    `<!doctype html><body><span class="kb-session"><span id="session-countdown" data-remaining-ms="${remainingMs}" data-inactivity-ms="${WINDOW}">--:--</span></span></body>`,
    { runScripts: "outside-only", pretendToBeVisual: true },
  );
  const win = dom.window as unknown as Record<string, unknown> & {
    Date: { now: () => number };
  };
  let now = Date.UTC(2026, 10, 1, 0, 0, 0);
  win.Date.now = () => now;

  const timers: Array<{ every: number; next: number; fn: () => void }> = [];
  win.setInterval = (fn: () => void, every: number) => {
    timers.push({ every, next: now + every, fn });
    return timers.length;
  };

  const fetched: string[] = [];
  let reply: PingReply | "network-error" = { status: 200 };
  win.fetch = (url: string) => {
    fetched.push(url);
    if (reply === "network-error") return Promise.reject(new Error("offline"));
    const r = reply;
    return Promise.resolve({
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      json: () => Promise.resolve(r.body),
    });
  };

  const windowListeners: Array<() => void> = [];
  const fakeWindow = {
    location: { href: "" },
    addEventListener: (_type: string, fn: () => void) => {
      windowListeners.push(fn);
    },
  };
  (win as Record<string, unknown>).__fakeWindow = fakeWindow;
  dom.window.eval(
    `(function(window){${sessionBannerScript(surface.ping, surface.home)}})(__fakeWindow)`,
  );

  const text = (): string =>
    dom.window.document.getElementById("session-countdown")?.textContent ?? "";
  return {
    dom,
    fakeWindow,
    text,
    lowClass: () =>
      dom.window.document
        .querySelector(".kb-session")
        ?.classList.contains("is-low") ?? false,
    advance: (ms) => {
      const end = now + ms;
      for (;;) {
        const due = timers
          .filter((t) => t.next <= end)
          .sort((a, b) => a.next - b.next)[0];
        if (!due) break;
        now = due.next;
        due.next += due.every;
        due.fn();
      }
      now = end;
    },
    sleep: (ms) => {
      now += ms;
    },
    fire: (type) => {
      // pageshow fires on the window (here the stand-in the script was given).
      if (type === "pageshow") {
        windowListeners.forEach((fn) => fn());
        return;
      }
      dom.window.document.dispatchEvent(new dom.window.Event(type));
    },
    settle: async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    },
    fetched,
    replyWith: (r) => {
      reply = r;
    },
  };
}

describe.each(SURFACES)("session banner script on $name", (surface) => {
  it("counts down from the server's remaining time and polls the read-only ping", async () => {
    const h = mount(surface, WINDOW);
    expect(h.text()).toBe("30:00");
    expect(h.fetched).toEqual([surface.ping]);
    h.advance(61 * 1000);
    expect(h.text()).toBe("28:59");
    expect(h.fakeWindow.location.href).toBe("");
  });

  it("sends the page to the sign-in path when the countdown reaches zero", () => {
    const h = mount(surface, 3000);
    h.advance(3000);
    expect(h.text()).toBe("0:00");
    expect(h.fakeWindow.location.href).toBe(surface.home);
  });

  it("sends the page to the sign-in path on the first tick after the clock jumps by 8 hours", () => {
    const h = mount(surface, WINDOW);
    h.sleep(8 * 60 * MINUTE);
    h.advance(1000);
    expect(h.fakeWindow.location.href).toBe(surface.home);
  });

  it.each(["mousemove", "keydown"])(
    "does not let a %s after an 8-hour jump keep the page alive, even before any timer fires",
    (type) => {
      const h = mount(surface, WINDOW);
      h.sleep(8 * 60 * MINUTE);
      // The input event arrives first, ahead of the interval timers.
      h.fire(type);
      expect(h.text()).not.toBe("29:59");
      expect(h.text()).not.toBe("30:00");
      h.advance(1000);
      expect(h.fakeWindow.location.href).toBe(surface.home);
    },
  );

  it.each(["mousemove", "keydown"])(
    "never shows more time after a %s than the last ping confirmed",
    async (type) => {
      const h = mount(surface, WINDOW);
      h.replyWith({
        status: 200,
        body: {
          remainingMs: 10 * MINUTE,
          expiresAt: new Date(Date.UTC(2026, 10, 2)).toISOString(),
        },
      });
      h.advance(30 * 1000);
      await h.settle();
      expect(h.text()).toBe("10:00");
      h.advance(5 * 1000 + 1);
      h.fire(type);
      // 10 minutes confirmed, 5 seconds gone: anything above 9:55 is a promise
      // the server never made.
      expect(h.text()).toBe("9:54");
    },
  );

  it("sends the page to the sign-in path when the ping answers 401", async () => {
    const h = mount(surface, WINDOW);
    h.replyWith({ status: 401, body: { error: "unauthorized" } });
    h.advance(30 * 1000);
    await h.settle();
    expect(h.fakeWindow.location.href).toBe(surface.home);
  });

  it("keeps counting when the ping fails with a network error or a 500", async () => {
    const h = mount(surface, WINDOW);
    h.replyWith("network-error");
    h.advance(30 * 1000);
    await h.settle();
    h.replyWith({ status: 500 });
    h.advance(30 * 1000);
    await h.settle();
    expect(h.text()).toBe("29:00");
    expect(h.fakeWindow.location.href).toBe("");
  });

  it.each(["visibilitychange", "pageshow"])(
    "asks the server and corrects the countdown when the page wakes on %s",
    async (type) => {
      const h = mount(surface, WINDOW);
      await h.settle();
      const before = h.fetched.length;
      h.sleep(10 * MINUTE);
      h.replyWith({ status: 401, body: { error: "unauthorized" } });
      h.fire(type);
      await h.settle();
      expect(h.fetched.length).toBe(before + 1);
      expect(h.fakeWindow.location.href).toBe(surface.home);
    },
  );
});
