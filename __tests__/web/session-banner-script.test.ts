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
import {
  BANNER_SURFACES,
  sessionBannerScript,
  type BannerSurface,
} from "../../src/web/session-banner.js";

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
  advance: (ms: number) => Promise<void>;
  /** Jump the clock without running any timer, like a laptop waking up. */
  sleep: (ms: number) => void;
  fire: (type: string) => void;
  /** Let the pending fetch promise chains settle. */
  settle: () => Promise<void>;
  fetched: string[];
  replyWith: (r: PingReply | "network-error") => void;
}

const SURFACES: Array<{
  name: string;
  key: BannerSurface;
  ping: string;
  home: string;
}> = [
  {
    name: "admin",
    key: "admin",
    ping: BANNER_SURFACES.admin.ping,
    home: BANNER_SURFACES.admin.signIn,
  },
  {
    name: "/me",
    key: "me",
    ping: BANNER_SURFACES.me.ping,
    home: BANNER_SURFACES.me.signIn,
  },
];

function mount(
  surface: (typeof SURFACES)[number],
  remainingMs: number,
  /** Replaces the real script, for the mutation checks below. */
  script: string = sessionBannerScript(surface.key),
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
  // The script is handed to the window's own Function constructor with the
  // stand-in `window` as its parameter; nothing is spliced into code.
  const run = new (
    dom.window as unknown as { Function: FunctionConstructor }
  ).Function("window", script);
  run(fakeWindow);

  const settleNow = async (): Promise<void> => {
    for (let i = 0; i < 40; i++) await Promise.resolve();
  };
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
    advance: async (ms) => {
      const end = now + ms;
      // Promise callbacks run between timer callbacks, as in a browser.
      await settleNow();
      for (;;) {
        const due = timers
          .filter((t) => t.next <= end)
          .sort((a, b) => a.next - b.next)[0];
        if (!due) break;
        // Monotonic: an overdue timer runs at the current time, never in the
        // past, and is rescheduled from now (like a browser that coalesces
        // the callbacks it missed), so a callback always reads the post-sleep
        // clock and eight hours are not replayed one tick at a time.
        now = Math.max(now, due.next);
        due.next = now + due.every;
        due.fn();
        await settleNow();
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
      for (let i = 0; i < 40; i++) await Promise.resolve();
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
    await h.advance(61 * 1000);
    expect(h.text()).toBe("28:59");
    expect(h.fakeWindow.location.href).toBe("");
  });

  it("asks the server when the countdown reaches zero and leaves for the sign-in path on a 401", async () => {
    const h = mount(surface, 3000);
    h.replyWith({ status: 401, body: { error: "unauthorized" } });
    await h.advance(8000);
    expect(h.text()).toBe("0:00");
    // The page asked first (the ping, not the local deadline, decided).
    expect(h.fetched.length).toBeGreaterThanOrEqual(2);
    expect(h.fakeWindow.location.href).toBe(surface.home);
  });

  it("does not navigate when another tab renewed the session: the ping says time is left", async () => {
    const h = mount(surface, 3000);
    h.replyWith({
      status: 200,
      body: { remainingMs: 25 * MINUTE },
    });
    await h.advance(8000);
    await h.settle();
    expect(h.fakeWindow.location.href).toBe("");
    // The server's remaining time is applied, not the stale local deadline.
    // 5 s of the 8 s had passed when the ping answered (the first tick after
    // the 3 s deadline that is allowed to ask), 3 s more since.
    expect(h.text()).toMatch(/^2[45]:[0-5]\d$/);
    await h.advance(10 * 1000);
    expect(Number(h.text().split(":")[0])).toBeLessThanOrEqual(24);
  });

  it("navigates when the ping itself says no time is left", async () => {
    const h = mount(surface, 3000);
    h.replyWith({ status: 200, body: { remainingMs: 0 } });
    await h.advance(8000);
    await h.settle();
    expect(h.fakeWindow.location.href).toBe(surface.home);
  });

  it("does not navigate when the validating ping fails, and retries", async () => {
    const h = mount(surface, 3000);
    h.replyWith("network-error");
    await h.advance(8000);
    const first = h.fetched.length;
    await h.advance(6000);
    expect(h.fakeWindow.location.href).toBe("");
    // It retried.
    expect(h.fetched.length).toBeGreaterThan(first);
    const failed = h.fetched.length;
    h.replyWith({ status: 500 });
    await h.advance(6000);
    expect(h.fakeWindow.location.href).toBe("");
    // The retry is not a flood: at most one ping per 5 seconds while overdue.
    expect(h.fetched.length - failed).toBeLessThanOrEqual(2);
    h.replyWith({ status: 401, body: {} });
    await h.advance(6000);
    expect(h.fakeWindow.location.href).toBe(surface.home);
  });

  it("leaves for the sign-in path after the clock jumps by 8 hours, once the server confirms", async () => {
    const h = mount(surface, WINDOW);
    await h.settle();
    const before = h.fetched.length;
    h.sleep(8 * 60 * MINUTE);
    h.replyWith({ status: 401, body: {} });
    await h.advance(1000);
    await h.settle();
    expect(h.fakeWindow.location.href).toBe(surface.home);
    // Overdue timers ran late, once each; eight hours were not replayed.
    expect(h.fetched.length - before).toBeLessThanOrEqual(3);
  });

  it("copes with the clock jumping back a little: no navigation, no double fire", async () => {
    const h = mount(surface, WINDOW);
    await h.advance(10 * 1000);
    h.sleep(-4000);
    await h.advance(6000);
    await h.settle();
    expect(h.fakeWindow.location.href).toBe("");
    // Clock at 12 s of the original timeline after going back 4 s: the last
    // tick read 12 s, so 30:00 - 12 s. No tick ran twice for one instant.
    expect(h.text()).toBe("29:48");
  });

  it.each(["mousemove", "keydown"])(
    "does not let a %s after an 8-hour jump keep the page alive, even before any timer fires",
    async (type) => {
      const h = mount(surface, WINDOW);
      await h.settle();
      h.sleep(8 * 60 * MINUTE);
      h.replyWith({ status: 401, body: {} });
      // The input event arrives first, ahead of the interval timers.
      h.fire(type);
      expect(h.text()).not.toBe("29:59");
      expect(h.text()).not.toBe("30:00");
      await h.settle();
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
      await h.advance(30 * 1000);
      await h.settle();
      expect(h.text()).toBe("10:00");
      await h.advance(5 * 1000 + 1);
      h.fire(type);
      // 10 minutes confirmed, 5 seconds gone: anything above 9:55 is a promise
      // the server never made.
      expect(h.text()).toBe("9:54");
    },
  );

  it("sends the page to the sign-in path when the ping answers 401", async () => {
    const h = mount(surface, WINDOW);
    h.replyWith({ status: 401, body: { error: "unauthorized" } });
    await h.advance(30 * 1000);
    await h.settle();
    expect(h.fakeWindow.location.href).toBe(surface.home);
  });

  it("keeps counting when the ping fails with a network error or a 500", async () => {
    const h = mount(surface, WINDOW);
    h.replyWith("network-error");
    await h.advance(30 * 1000);
    await h.settle();
    h.replyWith({ status: 500 });
    await h.advance(30 * 1000);
    await h.settle();
    expect(h.text()).toBe("29:00");
    expect(h.fakeWindow.location.href).toBe("");
  });

  it.each(["visibilitychange", "pageshow"])(
    "asks the server before anything else when the page wakes on %s",
    async (type) => {
      const h = mount(surface, WINDOW);
      await h.settle();
      const before = h.fetched.length;
      h.sleep(10 * MINUTE);
      h.replyWith({ status: 401, body: { error: "unauthorized" } });
      h.fire(type);
      // One ping, even though the local deadline has also passed.
      expect(h.fetched.length).toBe(before + 1);
      expect(h.fakeWindow.location.href).toBe("");
      await h.settle();
      expect(h.fakeWindow.location.href).toBe(surface.home);
    },
  );

  it.each(["visibilitychange", "pageshow"])(
    "keeps the page when it wakes on %s and the server says another tab renewed the session",
    async (type) => {
      const h = mount(surface, WINDOW);
      await h.settle();
      h.sleep(2 * 60 * MINUTE);
      h.replyWith({ status: 200, body: { remainingMs: 20 * MINUTE } });
      h.fire(type);
      await h.settle();
      expect(h.fakeWindow.location.href).toBe("");
      expect(h.text()).toBe("20:00");
    },
  );
});

describe("the fake clock catches a countdown that only counts callbacks", () => {
  // A broken banner that subtracts one second per interval callback instead of
  // reading the clock. With a monotonic clock one callback runs after an 8 hour
  // sleep, so such a countdown must NOT have left: if this check ever passes
  // for a mutant that leaves, the sleep tests above prove nothing.
  const MUTANT =
    "(function(){var left=30*60*1000;setInterval(function(){left-=1000;" +
    "if(left<=0)window.location.href='/mutant/'},1000)})();";

  it("a per-callback countdown has not expired after an 8-hour sleep", async () => {
    const h = mount(SURFACES[0], WINDOW, MUTANT);
    h.sleep(8 * 60 * MINUTE);
    await h.advance(1000);
    expect(h.fakeWindow.location.href).toBe("");
  });

  it("the real script has, once the server confirms", async () => {
    const h = mount(SURFACES[0], WINDOW);
    h.sleep(8 * 60 * MINUTE);
    h.replyWith({ status: 401, body: {} });
    await h.advance(1000);
    await h.settle();
    expect(h.fakeWindow.location.href).toBe(SURFACES[0].home);
  });
});

describe("sessionBannerScript arguments", () => {
  it("rejects a surface that is not one of the two known ones", () => {
    for (const bad of ["", "other", "__proto__", 'admin"});alert(1);//']) {
      expect(() => sessionBannerScript(bad as BannerSurface)).toThrow(
        /Unknown session banner surface/,
      );
    }
  });

  it("writes only the fixed paths, as string literals", () => {
    const admin = sessionBannerScript("admin");
    expect(admin).toContain('fetch("/admin/session/ping"');
    expect(admin).toContain('window.location.href="/admin/"');
    expect(admin).not.toContain("</");
    const me = sessionBannerScript("me");
    expect(me).toContain('fetch("/me/session/ping"');
    expect(me).toContain('window.location.href="/me/"');
  });
});
