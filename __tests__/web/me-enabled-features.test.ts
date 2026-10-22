/**
 * /me only shows features that are switched on (#1292).
 *
 * One acceptance line per block: a switched-off feature is in no tab, no
 * overview card and no notification row, its page answers 404 (GET and POST),
 * a failed config read is an error rather than a 404, and nothing a member
 * saved is deleted, so the value is back when the feature is.
 */

import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { Buffer } from "buffer";
import { createHmac } from "node:crypto";
import { createUserRouter } from "../../src/web/user-routes.js";
import { signValue } from "../../src/web/cookies.js";
import { WebSessionService } from "../../src/services/web-session-service.js";
import { meConfigStub } from "../test-utils.js";

const SECRET = "test-secret-for-me-enabled-features";
const csrf = (): string =>
  createHmac("sha256", SECRET).update("csrf\0session-id").digest("base64url");

const ALL_ON: Record<string, boolean> = {
  "rewind.enabled": true,
  "rewind.nudge.enabled": true,
  "voicechannels.presets.enabled": true,
  "birthdays.enabled": true,
  "privacy.enabled": true,
  "achievements.enabled": true,
  "digest.enabled": true,
};

type Prefs = { achievements: boolean; digest: boolean; rewind: boolean };

interface Out {
  statusCode: number;
  body: string;
  redirectedTo?: string;
  nextError?: unknown;
}

interface Harness {
  call: (
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
  ) => Promise<Out>;
  prefs: Prefs;
  setPrefs: jest.Mock;
  setNamePattern: jest.Mock;
  setBirthday: jest.Mock;
  getSummary: jest.Mock;
}

/** A router over in-memory services; `config` is read live on every request. */
async function harness(
  config: { values: Record<string, boolean>; extra?: Record<string, unknown> },
  stored: Prefs = { achievements: true, digest: true, rewind: true },
): Promise<Harness> {
  const now = Date.now();
  const cookie = `koolbot_session=${signValue(
    Buffer.from(
      JSON.stringify({
        sid: "session-id",
        uid: "user-1",
        gid: "guild-1",
        rol: "user",
        iat: now - 60_000,
        act: now - 60_000,
      }),
    ).toString("base64url"),
    SECRET,
  )}`;

  jest.spyOn(WebSessionService.getInstance(), "findById").mockResolvedValue({
    discordUserId: "user-1",
    guildId: "guild-1",
    role: "user",
    scopes: [],
    revokedAt: null,
    expiresAt: new Date(now + 60 * 60 * 1000),
  } as never);

  const { PermissionsService } =
    await import("../../src/services/permissions-service.js");
  jest.spyOn(PermissionsService, "getInstance").mockReturnValue({
    checkCommandPermission: async () => true,
    isAdministrator: async () => true,
    resolveWebScopes: async () => ["member"],
  } as never);

  const { ConfigService } =
    await import("../../src/services/config-service.js");
  jest
    .spyOn(ConfigService, "getInstance")
    .mockImplementation(
      () => meConfigStub(config.values, config.extra) as never,
    );

  const prefs: Prefs = { ...stored };
  const setPrefs = jest
    .fn<(u: string, g: string, patch: Partial<Prefs>) => Promise<Prefs>>()
    .mockImplementation(async (_u, _g, patch) => {
      Object.assign(prefs, patch);
      return { ...prefs };
    });
  const { UserNotificationPrefsService } =
    await import("../../src/services/user-notification-prefs-service.js");
  jest.spyOn(UserNotificationPrefsService, "getInstance").mockReturnValue({
    getPrefs: async () => ({ ...prefs }),
    getTimezone: async () => null,
    setPrefs,
  } as never);

  const setNamePattern = jest
    .fn<(u: string, raw: string) => Promise<string | null>>()
    .mockResolvedValue("x");
  const { UserVoicePrefsService } =
    await import("../../src/services/user-voice-prefs-service.js");
  jest.spyOn(UserVoicePrefsService, "getInstance").mockReturnValue({
    getPrefs: async () => ({ namePattern: "Saved {username}", presets: [] }),
    setNamePattern,
  } as never);

  const setBirthday = jest
    .fn<() => Promise<unknown>>()
    .mockResolvedValue({ month: 3, day: 4, year: null });
  const { BirthdayService } =
    await import("../../src/services/birthday-service.js");
  jest.spyOn(BirthdayService, "getInstance").mockReturnValue({
    getBirthday: async () => ({ month: 6, day: 16, year: 1990 }),
    setBirthday,
  } as never);

  const getSummary = jest.fn().mockResolvedValue(null as never);
  const { RewindService } =
    await import("../../src/services/rewind-service.js");
  jest.spyOn(RewindService, "getInstance").mockReturnValue({
    getSummary,
    getDefaultRewindYear: async () => new Date().getUTCFullYear(),
  } as never);

  const { WebAuditLog } = await import("../../src/models/web-audit-log.js");
  jest.spyOn(WebAuditLog, "create").mockResolvedValue({} as never);

  const client = {} as never;
  const { createSessionMiddleware } = await import("../../src/web/session.js");
  const router = createUserRouter(client, createSessionMiddleware(client));

  const call: Harness["call"] = async (method, path, body) => {
    const out: Out = { statusCode: 200, body: "" };
    const headers: Record<string, unknown> = { cookie };
    if (method === "POST") headers["x-csrf-token"] = csrf();
    const res = {
      statusCode: 200,
      status: (code: number) => {
        out.statusCode = code;
        return res;
      },
      type: () => res,
      send: (b: unknown) => {
        out.body = typeof b === "string" ? b : String(b);
        return res;
      },
      setHeader: () => res,
      getHeader: () => undefined,
      header: () => res,
      redirect: (code: unknown, url?: unknown) => {
        out.statusCode = typeof code === "number" ? code : 302;
        out.redirectedTo = String(url ?? code);
        return res;
      },
    };
    const req = {
      method,
      url: path,
      originalUrl: `/me${path}`,
      path,
      baseUrl: "/me",
      headers,
      body: body ?? {},
      query: {},
      csrfToken: csrf(),
      header: (name: string) => headers[name.toLowerCase()],
    };
    await new Promise<void>((resolve) => {
      router(
        req as never,
        res as never,
        ((err?: unknown) => {
          out.nextError = err;
          resolve();
        }) as never,
      );
      setTimeout(resolve, 0);
    });
    await new Promise((r) => setTimeout(r, 10));
    return out;
  };

  return { call, prefs, setPrefs, setNamePattern, setBirthday, getSummary };
}

const values = (
  over: Record<string, boolean> = {},
): Record<string, boolean> => ({
  ...ALL_ON,
  ...over,
});

beforeEach(() => {
  process.env.WEBUI_SESSION_SECRET = SECRET;
  process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES = "30";
  (WebSessionService as unknown as { instance: unknown }).instance = null;
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** The switch that turns each gated feature off, and what names it on a page. */
const FEATURES = [
  {
    name: "Birthday",
    key: "birthdays.enabled",
    href: "/me/birthday",
    path: "/birthday",
    post: "/birthday",
  },
  {
    name: "Voice",
    key: "voicechannels.presets.enabled",
    href: "/me/voice",
    path: "/voice",
    post: "/voice/name-pattern",
  },
  {
    name: "Rewind",
    key: "rewind.enabled",
    href: "/me/rewind",
    path: "/rewind",
    post: null,
  },
] as const;

describe.each(FEATURES)(
  "$name switched off (#1292)",
  ({ name, key, href, path, post }) => {
    it("is in no tab and no overview card", async () => {
      const app = await harness({ values: values({ [key]: false }) });
      const out = await app.call("GET", "/");
      expect(out.statusCode).toBe(200);
      // The tab bar and the card are both anchors to the page.
      expect(out.body).not.toContain(`href="${href}"`);
      expect(out.body).not.toContain(`>${name}</a>`);
      // ...and the "off" treatment is gone with them.
      expect(out.body).not.toContain("nav-badge");
      expect(out.body).not.toContain("tag-off");
    });

    it("is in no tab on the other /me pages either", async () => {
      const app = await harness({ values: values({ [key]: false }) });
      for (const other of ["/notifications", "/timezone"]) {
        const out = await app.call("GET", other);
        expect(out.statusCode).toBe(200);
        expect(out.body).not.toContain(`href="${href}"`);
      }
    });

    it("answers 404 for a bookmarked page, with no data work", async () => {
      const app = await harness({ values: values({ [key]: false }) });
      const out = await app.call("GET", path);
      expect(out.statusCode).toBe(404);
      expect(out.body).toBe("Not found");
      expect(app.getSummary).not.toHaveBeenCalled();
    });

    it("is back in the tab bar and the page loads once it is on again", async () => {
      const app = await harness({ values: values() });
      expect((await app.call("GET", "/")).body).toContain(`href="${href}"`);
      // Reaches the page's own handler (Rewind answers 500 for the empty
      // summary this harness serves), never the gate's 404.
      const page = await app.call("GET", path);
      expect(page.statusCode).not.toBe(404);
      expect(page.nextError).toBeUndefined();
    });

    it("is an error, never a 404, when the switch cannot be read", async () => {
      const app = await harness({
        values: values(),
        extra: {
          getBooleanStrict: async (k: string, fallback = false) => {
            if (k === key) throw new Error("mongo down");
            return values()[k] ?? fallback;
          },
        },
      });
      const out = await app.call("GET", path);
      expect(out.statusCode).not.toBe(404);
      expect(out.nextError).toEqual(new Error("mongo down"));
      expect(out.body).toBe("");
    });

    if (post) {
      it("refuses a POST with a 404 and saves nothing", async () => {
        const app = await harness({ values: values({ [key]: false }) });
        const out = await app.call("POST", post, {
          namePattern: "Hacked",
          month: "3",
          day: "4",
        });
        expect(out.statusCode).toBe(404);
        expect(app.setNamePattern).not.toHaveBeenCalled();
        expect(app.setBirthday).not.toHaveBeenCalled();
      });
    }
  },
);

describe("Rewind switched off (#1292), the per-year route", () => {
  it("answers 404 for /rewind/:year too", async () => {
    const app = await harness({ values: values({ "rewind.enabled": false }) });
    const out = await app.call("GET", "/rewind/2024");
    expect(out.statusCode).toBe(404);
    expect(app.getSummary).not.toHaveBeenCalled();
  });

  it("refuses ahead of the rate limiter, so a bookmark cannot burn the allowance", async () => {
    const app = await harness({ values: values({ "rewind.enabled": false }) });
    // The limiter allows 30 per window; every one of 40 stays a plain 404.
    for (let i = 0; i < 40; i += 1) {
      expect((await app.call("GET", "/rewind")).statusCode).toBe(404);
    }
  });
});

describe("Notification rows only for features that are on (#1292)", () => {
  const rows = async (
    over: Record<string, boolean>,
    extra?: Record<string, unknown>,
  ): Promise<string> => {
    const app = await harness({ values: values(over), extra });
    return (await app.call("GET", "/notifications")).body;
  };

  it("offers all three when everything is on", async () => {
    const body = await rows({});
    for (const k of ["achievements", "digest", "rewind"]) {
      expect(body).toContain(`name="${k}"`);
    }
  });

  it.each([
    ["achievements.enabled", "Achievement DMs", "achievements"],
    [
      "achievements.dm_notifications.enabled",
      "Achievement DMs",
      "achievements",
    ],
    ["digest.enabled", "Weekly digest", "digest"],
    ["rewind.enabled", "Year-in-review", "rewind"],
    ["rewind.nudge.enabled", "Year-in-review", "rewind"],
  ])("drops the row when %s is off", async (key, label, name) => {
    const body = await rows({ [key]: false });
    expect(body).not.toContain(label);
    expect(body).not.toContain(`name="${name}"`);
    expect(body).not.toContain(`name="submitted_${name}"`);
    // The other two stay.
    const others = ["achievements", "digest", "rewind"].filter(
      (k) => k !== name,
    );
    for (const k of others) expect(body).toContain(`name="${k}"`);
  });

  it("reads the achievement DM switch as on when it was never stored (schema default)", async () => {
    // `achievements.dm_notifications.enabled` defaults to true: an install that
    // never stored it must keep the row.
    const stored = values();
    const body = await rows(
      {},
      {
        getBooleanStrict: async (k: string, fallback = false) =>
          k in stored && k !== "achievements.dm_notifications.enabled"
            ? stored[k]
            : fallback,
      },
    );
    expect(body).toContain('name="achievements"');
  });

  it("falls back to rewind.enabled for the nudge when rewind.nudge.enabled was never stored", async () => {
    const body = await rows(
      { "rewind.nudge.enabled": false },
      {
        getBooleanStrict: async (k: string, fallback = false) =>
          k === "rewind.nudge.enabled" ? fallback : (values()[k] ?? fallback),
      },
    );
    expect(body).toContain('name="rewind"');
  });

  it("says so, with no form, when none are on", async () => {
    const body = await rows({
      "achievements.enabled": false,
      "digest.enabled": false,
      "rewind.enabled": false,
    });
    expect(body).toContain("direct messages to offer");
    expect(body).not.toContain('action="/me/notifications"');
    expect(body).not.toContain("Save preferences");
  });

  it("is an error, not an empty page, when a switch cannot be read", async () => {
    const app = await harness({
      values: values(),
      extra: {
        getBooleanStrict: async (k: string, fallback = false) => {
          if (k === "digest.enabled") throw new Error("mongo down");
          return values()[k] ?? fallback;
        },
      },
    });
    const out = await app.call("GET", "/notifications");
    expect(out.nextError).toEqual(new Error("mongo down"));
    expect(out.body).not.toContain("no direct messages");
  });
});

describe("Saved choices survive a feature being off (#1292)", () => {
  it("keeps a hidden row's value when the visible rows are saved, and shows it again", async () => {
    const config = { values: values({ "digest.enabled": false }) };
    const app = await harness(config, {
      achievements: true,
      digest: true,
      rewind: true,
    });
    const saved = await app.call("POST", "/notifications", {
      submitted_achievements: "1",
      // achievements unchecked: an explicit opt-out of a visible row
      submitted_rewind: "1",
      rewind: "true",
    });
    expect(saved.statusCode).toBe(303);
    expect(app.prefs).toEqual({
      achievements: false,
      digest: true, // untouched
      rewind: true,
    });
    // Admin turns the digest back on: the member's old choice is still there.
    config.values["digest.enabled"] = true;
    const page = (await app.call("GET", "/notifications")).body;
    expect(page).toContain('name="digest" value="true" checked');
    expect(page).toContain('name="achievements" value="true">');
  });

  it("ignores a stale form that still carries a hidden row", async () => {
    const app = await harness(
      { values: values({ "digest.enabled": false }) },
      { achievements: true, digest: true, rewind: true },
    );
    await app.call("POST", "/notifications", {
      submitted_achievements: "1",
      achievements: "true",
      submitted_digest: "1", // digest unchecked on a form rendered before it went off
    });
    expect(app.prefs.digest).toBe(true);
    const patch = app.setPrefs.mock.calls[0][2];
    expect(patch).not.toHaveProperty("digest");
  });

  it("leaves a row alone when the form does not carry it at all", async () => {
    const app = await harness({ values: values() });
    await app.call("POST", "/notifications", {
      submitted_achievements: "1",
      achievements: "true",
    });
    const patch = app.setPrefs.mock.calls[0][2];
    expect(Object.keys(patch)).toEqual(["achievements"]);
    expect(app.prefs.digest).toBe(true);
  });

  it("does not delete the saved voice and birthday values: they show again when switched on", async () => {
    const config = {
      values: values({
        "voicechannels.presets.enabled": false,
        "birthdays.enabled": false,
      }),
    };
    const app = await harness(config);
    expect((await app.call("GET", "/voice")).statusCode).toBe(404);
    expect((await app.call("GET", "/birthday")).statusCode).toBe(404);
    config.values["voicechannels.presets.enabled"] = true;
    config.values["birthdays.enabled"] = true;
    expect((await app.call("GET", "/voice")).body).toContain(
      "Saved {username}",
    );
    // Birthday 16 June is the stored value the service returns.
    expect((await app.call("GET", "/birthday")).body).toMatch(
      /value="6" selected/,
    );
  });
});

describe("No feature name leaks back onto /me while it is off (#1292)", () => {
  it("names Rewind nowhere on the overview, timezone or notifications pages", async () => {
    const app = await harness({
      values: values({
        "rewind.enabled": false,
        "polls.participation.enabled": true,
      }),
    });
    const { PollParticipationTracker } =
      await import("../../src/services/poll-participation-tracker.js");
    jest.spyOn(PollParticipationTracker, "getInstance").mockReturnValue({
      getParticipationSummary: async () => ({
        totalVotes: 4,
        thisYearVotes: 2,
        thisWeekVotes: 1,
        lastVoteAt: null,
      }),
    } as never);
    for (const path of ["/", "/timezone", "/notifications"]) {
      const out = await app.call("GET", path);
      expect(out.statusCode).toBe(200);
      expect(out.body).not.toMatch(/rewind/i);
    }
  });

  it("names Birthday and Voice presets nowhere on those pages while off", async () => {
    const app = await harness({
      values: values({
        "birthdays.enabled": false,
        "voicechannels.presets.enabled": false,
      }),
    });
    for (const path of ["/", "/timezone", "/notifications"]) {
      const out = await app.call("GET", path);
      expect(out.body).not.toMatch(/birthday/i);
      expect(out.body).not.toMatch(/voice-channel presets|\/me\/voice/i);
    }
  });
});

describe("Privacy, the surface that already hid itself (#1066, #1292)", () => {
  it("is in no tab and no card, and both its routes answer 404, while off", async () => {
    const app = await harness({ values: values({ "privacy.enabled": false }) });
    const page = await app.call("GET", "/");
    expect(page.body).not.toContain('href="/me/privacy"');
    expect((await app.call("GET", "/privacy")).statusCode).toBe(404);
    expect((await app.call("GET", "/privacy/export")).statusCode).toBe(404);
  });

  it("answers an error, not 404, when its switch cannot be read", async () => {
    const throwing = {
      getBooleanStrict: async (k: string, fallback = false) => {
        if (k === "privacy.enabled") throw new Error("mongo down");
        return values()[k] ?? fallback;
      },
    };
    for (const path of ["/privacy", "/privacy/export"]) {
      const app = await harness({ values: values(), extra: throwing });
      const out = await app.call("GET", path);
      expect(out.statusCode).not.toBe(404);
      expect(out.nextError).toEqual(new Error("mongo down"));
    }
  });
});
