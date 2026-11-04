/**
 * The helper that creates the roles an admin typed into a role Picker (#1618):
 * the plan (nothing written), the apply that re-checks the live server inside
 * the role lock, and the rollback of what one apply created.
 */

import { describe, it, expect, jest, afterEach } from "@jest/globals";
import { DiscordAPIError, Routes } from "discord.js";
import type { RoleCreateDeps } from "../../src/web/role-create.js";

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  isDebugMode: () => false,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { applyRolePlan, planRoles, removeCreatedRoles } =
  await import("../../src/web/role-create.js");
const { withRoleLock, ROLE_LOCK_BUSY_MESSAGE, roleWriteLock } =
  await import("../../src/web/role-write-lock.js");
const { withChannelLock, CHANNEL_LOCK_WAIT_MS, CHANNEL_READ_TIMEOUT_MS } =
  await import("../../src/web/channel-write-lock.js");

const live = [
  { id: "1", name: "@everyone" },
  { id: "2", name: "Moderator" },
];

const apiError = (status = 403): Error =>
  new DiscordAPIError(
    { code: 50013, message: "Missing Permissions" },
    50013,
    status,
    "POST",
    "https://discord.com/api/v10/guilds/1/roles",
    {},
  );

function setup(roles = live) {
  let next = 900;
  const post = jest.fn(
    async (_route: string, opts: { body: Record<string, unknown> }) => ({
      id: String(++next),
      name: opts.body.name as string,
      position: 1,
    }),
  );
  const del = jest
    .fn<(route: string, opts: unknown) => Promise<void>>()
    .mockResolvedValue(undefined);
  const deps: RoleCreateDeps = {
    guildId: "1",
    rest: { post, delete: del } as unknown as RoleCreateDeps["rest"],
    call: (fn) => fn(new AbortController().signal),
    listRoles: async () => roles,
    reason: "test",
  };
  return { deps, post, del };
}

afterEach(() => {
  jest.useRealTimers();
});

describe("planRoles", () => {
  it("plans a create for a free name, trimmed", () => {
    const plan = planRoles([{ name: "  Quartermaster " }], live);
    expect(plan).toMatchObject({
      ok: true,
      entries: [{ name: "Quartermaster", action: "create" }],
    });
  });

  it("selects an existing role whose name matches, ignoring case, and keeps its own spelling", () => {
    const plan = planRoles([{ name: "mODerator" }], live);
    expect(plan).toMatchObject({
      ok: true,
      entries: [{ name: "Moderator", action: "existing", existingId: "2" }],
    });
  });

  it("refuses a blank name and one over 100 characters", () => {
    expect(planRoles([{ name: "   " }], live)).toEqual({
      ok: false,
      errors: ["The name cannot be blank."],
    });
    expect(planRoles([{ name: "x".repeat(101) }], live)).toEqual({
      ok: false,
      errors: ["The name can be at most 100 characters."],
    });
    expect(planRoles([{ name: "x".repeat(100) }], live).ok).toBe(true);
  });

  it("refuses a name two roles share, and the same name twice in one plan", () => {
    const two = [...live, { id: "3", name: "moderator" }];
    const a = planRoles([{ name: "Moderator" }], two);
    expect(a.ok).toBe(false);
    expect(a.ok === false && a.errors[0]).toContain("Two roles are called");
    const b = planRoles([{ name: "Crew" }, { name: "CREW" }], live);
    expect(b.ok).toBe(false);
    expect(b.ok === false && b.errors[0]).toContain("more than once");
  });

  it("counts @everyone as a role of that name, so the mapping can refuse it", () => {
    expect(planRoles([{ name: "@everyone" }], live)).toMatchObject({
      ok: true,
      entries: [{ action: "existing", existingId: "1" }],
    });
  });

  it("refuses past Discord's 250 roles", () => {
    const many = Array.from({ length: 250 }, (_, i) => ({
      id: String(i + 10),
      name: `r${i}`,
    }));
    const plan = planRoles([{ name: "One more" }], many);
    expect(plan.ok).toBe(false);
    expect(planRoles([{ name: "r1" }], many).ok).toBe(true);
  });

  it("gives the same plan id for the same plan and a different one when a name appears", () => {
    const a = planRoles([{ name: "Crew" }], live);
    const b = planRoles([{ name: "Crew" }], live);
    const c = planRoles(
      [{ name: "Crew" }],
      [...live, { id: "9", name: "crew" }],
    );
    expect(a.ok && b.ok && c.ok).toBe(true);
    expect(a.ok && b.ok && a.planId === b.planId).toBe(true);
    expect(a.ok && c.ok && a.planId !== c.planId).toBe(true);
  });
});

describe("applyRolePlan", () => {
  it("creates each role with no permissions, not hoisted and not mentionable", async () => {
    const { deps, post } = setup();
    const plan = planRoles([{ name: "Crew" }], live);
    if (!plan.ok) throw new Error("plan");
    const res = await applyRolePlan(deps, [{ name: "Crew" }], plan.planId);
    expect(res).toEqual({
      ok: true,
      roles: [{ id: "901", name: "Crew", position: 1, created: true }],
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe(Routes.guildRoles("1"));
    // `permissions` must be sent: left out, Discord copies @everyone's.
    expect(post.mock.calls[0][1]).toMatchObject({
      body: {
        name: "Crew",
        permissions: "0",
        hoist: false,
        mentionable: false,
      },
      reason: "test",
    });
  });

  it("creates nothing when the live roles no longer give the reviewed plan", async () => {
    const { deps, post } = setup([...live, { id: "7", name: "crew" }]);
    const reviewed = planRoles([{ name: "Crew" }], live);
    if (!reviewed.ok) throw new Error("plan");
    const res = await applyRolePlan(deps, [{ name: "Crew" }], reviewed.planId);
    expect(res).toMatchObject({ ok: false, removed: [], stuck: [] });
    expect(res.ok === false && res.error).toContain("changed since Review");
    expect(post).not.toHaveBeenCalled();
  });

  it("removes what it created when a later create fails, newest first", async () => {
    const { deps, post, del } = setup();
    const entries = [{ name: "A" }, { name: "B" }, { name: "C" }];
    const plan = planRoles(entries, live);
    if (!plan.ok) throw new Error("plan");
    post
      .mockResolvedValueOnce({ id: "901", name: "A", position: 1 })
      .mockResolvedValueOnce({ id: "902", name: "B", position: 1 })
      .mockRejectedValueOnce(apiError());
    const res = await applyRolePlan(deps, entries, plan.planId);
    expect(res).toMatchObject({
      ok: false,
      removed: ["902", "901"],
      stuck: [],
    });
    expect(res.ok === false && res.error).toContain("Missing Permissions");
    expect(res.ok === false && res.error).toContain("removed again");
    expect(del.mock.calls.map((c) => c[0])).toEqual([
      Routes.guildRole("1", "902"),
      Routes.guildRole("1", "901"),
    ]);
  });

  it("names a role it could not remove and never says nothing changed", async () => {
    const { deps, post, del } = setup();
    const entries = [{ name: "A" }, { name: "B" }];
    const plan = planRoles(entries, live);
    if (!plan.ok) throw new Error("plan");
    post
      .mockResolvedValueOnce({ id: "901", name: "A", position: 1 })
      .mockRejectedValueOnce(apiError());
    del.mockRejectedValue(apiError(500));
    const res = await applyRolePlan(deps, entries, plan.planId);
    expect(res).toMatchObject({ ok: false, removed: [], stuck: ["901"] });
    expect(res.ok === false && res.error).toContain("still exist: 901");
  });

  it("counts a role that is already gone as removed", async () => {
    const { deps, del } = setup();
    del.mockRejectedValue(apiError(404));
    expect(await removeCreatedRoles(deps, ["901"])).toEqual({
      removed: ["901"],
      stuck: [],
    });
  });

  it("refuses with nothing created while an adoption apply is active", async () => {
    const { deps, post } = setup();
    const plan = planRoles([{ name: "Crew" }], live);
    if (!plan.ok) throw new Error("plan");
    const res = await applyRolePlan(
      { ...deps, busyReason: async () => "Another apply is already running." },
      [{ name: "Crew" }],
      plan.planId,
    );
    expect(res).toMatchObject({ ok: false, removed: [], stuck: [] });
    expect(res.ok === false && res.error).toContain("already running");
    expect(post).not.toHaveBeenCalled();
  });

  it("creates the name once when two applies for it run together", async () => {
    const created: Array<{ id: string; name: string }> = [];
    const entries = [{ name: "Crew" }];
    const reviewed = planRoles(entries, live);
    if (!reviewed.ok) throw new Error("plan");
    const mk = () => {
      const { deps, post } = setup();
      post.mockImplementation(
        async (_r: string, o: { body: Record<string, unknown> }) => {
          await new Promise((r) => setTimeout(r, 20));
          const role = {
            id: String(created.length + 500),
            name: o.body.name as string,
          };
          created.push(role);
          return { ...role, position: 1 };
        },
      );
      deps.listRoles = async () => [...live, ...created];
      return deps;
    };
    const [a, b] = await Promise.all([
      applyRolePlan(mk(), entries, reviewed.planId),
      applyRolePlan(mk(), entries, reviewed.planId),
    ]);
    expect(created).toHaveLength(1);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
  });

  it("does not take the channel lock, and the channel lock does not take this one", async () => {
    const { deps, post } = setup();
    const plan = planRoles([{ name: "Crew" }], live);
    if (!plan.ok) throw new Error("plan");
    let release: () => void = () => undefined;
    const holding = withChannelLock(
      "1",
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const res = await applyRolePlan(deps, [{ name: "Crew" }], plan.planId);
    expect(res.ok).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
    release();
    await holding;
  });

  it("gives up with the busy message after the bounded wait, and never runs later", async () => {
    jest.useFakeTimers();
    const { deps, post } = setup();
    const plan = planRoles([{ name: "Crew" }], live);
    if (!plan.ok) throw new Error("plan");
    let release: () => void = () => undefined;
    const holding = withRoleLock(
      "1",
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const waiting = applyRolePlan(deps, [{ name: "Crew" }], plan.planId);
    await jest.advanceTimersByTimeAsync(CHANNEL_LOCK_WAIT_MS + 1);
    expect(await waiting).toMatchObject({
      ok: false,
      error: ROLE_LOCK_BUSY_MESSAGE,
    });
    release();
    await holding;
    await jest.advanceTimersByTimeAsync(10);
    expect(post).not.toHaveBeenCalled();
    expect(roleWriteLock.size).toBe(0);
  });

  it("does not run when the caller is cancelled while queued", async () => {
    const { deps, post } = setup();
    const plan = planRoles([{ name: "Crew" }], live);
    if (!plan.ok) throw new Error("plan");
    let release: () => void = () => undefined;
    const holding = withRoleLock(
      "1",
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const gone = new AbortController();
    const waiting = applyRolePlan(
      { ...deps, signal: gone.signal },
      [{ name: "Crew" }],
      plan.planId,
    );
    gone.abort();
    expect(await waiting).toMatchObject({
      ok: false,
      error: ROLE_LOCK_BUSY_MESSAGE,
    });
    release();
    await holding;
    await new Promise((r) => setTimeout(r, 10));
    expect(post).not.toHaveBeenCalled();
  });

  it("refuses, releasing the lock, when reading the roles stalls", async () => {
    jest.useFakeTimers();
    const { deps, post } = setup();
    deps.listRoles = () => new Promise(() => undefined);
    const plan = planRoles([{ name: "Crew" }], live);
    if (!plan.ok) throw new Error("plan");
    const running = applyRolePlan(deps, [{ name: "Crew" }], plan.planId);
    await jest.advanceTimersByTimeAsync(CHANNEL_READ_TIMEOUT_MS + 1);
    const res = await running;
    expect(res).toMatchObject({ ok: false, removed: [], stuck: [] });
    expect(post).not.toHaveBeenCalled();
    expect(roleWriteLock.size).toBe(0);
  });
});
