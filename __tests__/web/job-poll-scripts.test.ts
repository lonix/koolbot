/**
 * The six job-status poll scripts (#1635). Their `/job/<id>` requests sit
 * behind `requireSession`, so each one renews the session (`act`). That is
 * only safe if a poll ends. The table drives every script through every
 * answer and counts the requests: only a job the server still reports as
 * `running` may schedule another one.
 */
import { describe, it, expect } from "@jest/globals";
import { JSDOM } from "jsdom";
import { JOB_SCRIPT as ADOPTION_HISTORY } from "../../src/web/adoption-history-view.js";
import { JOB_SCRIPT as RULES } from "../../src/web/rules-page.js";
import { JOB_SCRIPT as BOT_CLEANUP } from "../../src/web/bot-cleanup-view.js";
import { JOB_SCRIPT as CHANNEL_CLAIMS } from "../../src/web/channel-claims-view.js";
import { JOB_SCRIPT as ROLE_GROUPS } from "../../src/web/role-groups-views.js";
import { JOB_SCRIPT as EVENT_ADOPTION } from "../../src/web/event-adoption-view.js";

const SCRIPTS = [
  { name: "adoption history", build: ADOPTION_HISTORY, el: "ah-job" },
  { name: "rules", build: RULES, el: "rules-job" },
  { name: "bot cleanup", build: BOT_CLEANUP, el: "bc-job" },
  { name: "channel claims", build: CHANNEL_CLAIMS, el: "cc-job" },
  { name: "role groups", build: ROLE_GROUPS, el: "rg-job" },
  { name: "event adoption", build: EVENT_ADOPTION, el: "ea-job" },
] as const;

type Answer =
  | { kind: "json"; status: number; body: unknown }
  | { kind: "html"; status: number }
  | { kind: "network-error" };

const ANSWERS: Array<{ name: string; answer: Answer; reschedules: boolean }> = [
  {
    name: "running",
    answer: {
      kind: "json",
      status: 200,
      body: { status: "running", text: "…" },
    },
    reschedules: true,
  },
  {
    name: "done",
    answer: { kind: "json", status: 200, body: { status: "done", text: "ok" } },
    reschedules: false,
  },
  {
    name: "failed",
    answer: {
      kind: "json",
      status: 200,
      body: { status: "failed", text: "x" },
    },
    reschedules: false,
  },
  {
    name: "unknown job (404, e.g. after a restart)",
    answer: {
      kind: "json",
      status: 404,
      body: { status: "unknown", text: "?" },
    },
    reschedules: false,
  },
  {
    name: "an unrecognised status",
    answer: { kind: "json", status: 200, body: { status: "weird", text: "?" } },
    reschedules: false,
  },
  {
    name: "the 401 sign-in page (HTML, not JSON)",
    answer: { kind: "html", status: 401 },
    reschedules: false,
  },
  {
    name: "a network error",
    answer: { kind: "network-error" },
    reschedules: false,
  },
];

/** Run the script, then fire every timer it set, for `rounds` rounds. */
async function run(
  script: string,
  elId: string,
  answer: Answer,
  rounds: number,
): Promise<{ fetches: number; href: string; text: string }> {
  const dom = new JSDOM(
    `<!doctype html><body><div id="${elId}"></div></body>`,
    {
      runScripts: "outside-only",
    },
  );
  const win = dom.window as unknown as Record<string, unknown>;
  let fetches = 0;
  let pending: Array<() => void> = [];
  win.setTimeout = (fn: () => void) => {
    pending.push(fn);
    return pending.length;
  };
  win.fetch = () => {
    fetches++;
    if (answer.kind === "network-error") return Promise.reject(new Error("x"));
    return Promise.resolve({
      status: answer.status,
      json: () =>
        answer.kind === "json"
          ? Promise.resolve(answer.body)
          : Promise.reject(new SyntaxError("not json")),
    });
  };
  // jsdom cannot navigate; a stand-in `location` absorbs the redirect.
  const loc = { href: "" };
  win.__loc = loc;
  dom.window.eval(`(function(location){${script}})(__loc)`);
  for (let round = 0; round < rounds; round++) {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const due = pending;
    pending = [];
    due.forEach((fn) => fn());
  }
  for (let i = 0; i < 20; i++) await Promise.resolve();
  return {
    fetches,
    href: loc.href,
    text: dom.window.document.getElementById(elId)?.textContent ?? "",
  };
}

describe.each(SCRIPTS)("job poll script: $name", ({ build, el }) => {
  it.each(ANSWERS)("$name", async ({ answer, reschedules }) => {
    const script = build("3f1c2d4e-0000-4000-8000-000000000000");
    const r = await run(script, el, answer, 5);
    if (reschedules) {
      // One request now plus one per round while the job stays `running`.
      expect(r.fetches).toBe(6);
      expect(r.href).toBe("");
    } else {
      // Exactly one request, whatever the five timer rounds that follow.
      expect(r.fetches).toBe(1);
    }
    if (answer.kind === "network-error" || answer.kind === "html") {
      expect(r.text).toContain("Lost contact with the bot");
    }
  });
});
