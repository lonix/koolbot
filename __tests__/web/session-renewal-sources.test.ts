/**
 * What can renew a Web UI session without the person doing anything (#1635).
 *
 * Every request behind `requireSession` writes a new cookie with `act = now`.
 * So a page that fetches on a timer would keep a session alive for as long as
 * the tab stays open. This test reads the page scripts in `src/web` and fails
 * when a new timer-driven request, meta refresh or reload appears, so that the
 * list in WEBUI.md ("What counts as activity") is revisited with it.
 *
 * Today the only timer-driven requests are the banner's read-only
 * `/session/ping` (mounted before `requireSession`, so it renews nothing) and
 * the six job-status polls, which stop as soon as the job is not `running`
 * (`job-poll-scripts.test.ts`).
 */
import { describe, it, expect } from "@jest/globals";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(process.cwd(), "src", "web");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return p.endsWith(".ts") ? [p] : [];
  });
}

const files = sources(ROOT).map((p) => ({
  rel: relative(ROOT, p),
  text: readFileSync(p, "utf8"),
}));

/** A browser-side `fetch(` (not `client.guilds.fetch(` or `.fetch(`). */
const BROWSER_FETCH = /(?<![.\w])fetch\(/;
const TIMER = /\bset(Interval|Timeout)\(/;

describe("what can renew a session by itself", () => {
  it("only the banner and the six job-status pages fetch on a timer", () => {
    const timed = files
      .filter((f) => BROWSER_FETCH.test(f.text) && TIMER.test(f.text))
      .map((f) => f.rel)
      .sort();
    expect(timed).toEqual(
      [
        "adoption-history-view.ts",
        "bot-cleanup-view.ts",
        "channel-claims-view.ts",
        "event-adoption-view.ts",
        "role-groups-views.ts",
        "rules-page.ts",
        "session-banner.ts",
      ].sort(),
    );
  });

  it("only the banner clock and the /me timezone clock use setInterval, and neither fetches", () => {
    const users = files
      .filter((f) => /\bsetInterval\(/.test(f.text))
      .map((f) => f.rel)
      .sort();
    expect(users).toEqual(["session-banner.ts", "user-layout.ts"]);
    const layout = files.find((f) => f.rel === "user-layout.ts");
    expect(layout && BROWSER_FETCH.test(layout.text)).toBe(false);
  });

  it("no page reloads itself or refreshes by meta tag", () => {
    for (const f of files) {
      expect(f.text).not.toMatch(/location\.reload\(/);
      expect(f.text).not.toMatch(/http-equiv=["']refresh/i);
    }
  });

  it("the banner polls the read-only ping, never a page", () => {
    const banner = files.find((f) => f.rel === "session-banner.ts");
    expect(banner?.text).toContain("pingPath");
    expect(banner?.text).not.toMatch(/fetch\(['"]\/(admin|me)\//);
  });
});
