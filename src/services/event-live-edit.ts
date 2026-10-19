/**
 * Live edit of a running event's group settings (#1239, step 1 of the split of
 * #1197). The host panel's Settings section posts a form; this module plans the
 * change from fresh state, asks for confirmation when a change needs it, and
 * applies it under the per-event locks with ONE result (and, in the route, ONE
 * audit entry) per save.
 *
 * Rows delivered here: channel lead time and lock groups on/off. Later steps
 * (#1240 leaders and tags, #1241 names, sizes and preset, #1242 kind and
 * add/remove, #1243 groups on/off) only ADD ROWS (see "Extension contract").
 *
 * ## The root rules (each stated once; `__tests__/services/event-live-edit.test.ts`
 * has a table test over them)
 *
 * 1. **Who may edit, and when** (`editBlocker`, the only place that decides):
 *    `events.enabled` must read as on (an unreadable switch is off: fail
 *    closed); the event must exist in this guild and be `scheduled` or
 *    `active`; and no end or cancel may hold it (`deps.isEnding`, the #1223
 *    hold mechanism, asked again before EVERY write, with no await between the
 *    check and the write). Everything else is a refusal that changes nothing.
 * 2. **Decide from a fresh read, inside the locks.** The event is read again
 *    after both locks are held (`Event.findOne(...).lean()`); the form's copy
 *    and the gate's copy of the event are never used to decide. Nothing is
 *    queued or awaited between that read and the plan.
 * 3. **A field changes only when the host changed it** (base value rule). The
 *    form posts, for each field, the value it SHOWED (`b_<row>`) and the value
 *    it now holds (`s_<row>`). With `stored` the fresh value:
 *      - `submitted == base`: untouched, never written (a stale form cannot
 *        revert somebody else's change by saving an unrelated field);
 *      - `submitted == stored`: already applied, nothing to do (idempotent);
 *      - `stored != base`: conflict (someone changed it while the form was
 *        open): reported, not written; the other fields still proceed;
 *      - otherwise a change `stored -> submitted`, validated as below.
 * 4. **Every write is conditional on what it was decided from** (the row's
 *    `from` value, the event being open, the guild) and returns an explicit
 *    outcome the executor honours: `applied`, `lost` (the condition no longer
 *    held: someone else changed it; NEVER reported as success), `failed` (the
 *    write threw) or `partial` (stored, but a follow-up part did not happen).
 *    A write never saves `state`, `channelId` or `groups` from a copy: rows set
 *    only their own fields (`$set` of one field, or `arrayFilters` by key).
 * 5. **One result per save, partial success explicit and re-runnable.** The
 *    result lists what was applied and everything that was not (conflicts,
 *    lost writes, failures), each with a reason. Saving the same form again
 *    converges: what is applied is "already applied", what was not is tried
 *    again from the fresh read.
 * 6. **Confirmation is a signed round trip, never a client dialog.** When any
 *    planned change needs confirmation nothing is applied; the caller gets the
 *    change set and signs it (`signConfirmation`). The token binds the event
 *    id, the guild, the host's user id, an expiry and the exact change set
 *    (rows with their `from` and `to` values, plus a hash of them) and the
 *    event's `liveEditRevision` when the page was shown, under HMAC with the
 *    Web UI session secret (a missing secret fails closed). A confirmed run
 *    plans again from the fresh read INSIDE the locks and applies only when
 *    that fresh change set equals the token's AND the revision is still the
 *    token's. Every save that applies something first claims the save by
 *    moving the revision on (`$inc`, conditional on the revision it planned
 *    at, before any row is written), so a token can be used once: a stale
 *    token (the event changed since), a token for another event, user or
 *    change set, an expired one, a replay after the change was applied and a
 *    replay after the value was reversed (A to B confirmed, B to A saved, the
 *    same change set A to B planned again) all end in "nothing applied". The
 *    revision is one durable counter on the event: no per-user and no
 *    per-event state is kept in memory, so nothing needs clearing when a
 *    member's data is reset. Another writer of a field that a
 *    confirmation-gated row owns must `$inc` the revision too (as the claim
 *    does), or a reversal through that writer is not seen.
 * 7. **Derived values stay derived.** A group's "over size" state (members
 *    above its size, `isGroupOverSize`) is computed on read and never stored;
 *    stored group fields get no schema default.
 * 8. **Validation** is the one set of rules of the event form (#1188). A row
 *    checks its own field with the shared checkers (`checkChannelLead`, later
 *    `checkGroupName`, `checkGroupTag`); a row that changes the group list
 *    validates the edited setup with `ctx.validateSetup`, which always passes
 *    `presetId: ""` (a stored preset id may have been disabled or deleted since
 *    and must never block an edit) and never lets the group cap fall below the
 *    number of groups the event already has (an organiser lowering
 *    `events.groups.max_count` does not lock hosts out of unrelated settings).
 *    The validator's output is only checked, never written.
 *
 * ## Locks
 *
 * The executor takes `withEventMoveLock` (outer: a bulk move, another live edit
 * or an end in flight answers `busy` at once) and then `withGroupLock` (inner:
 * membership changes queue behind it). Both are held for the whole run, so an
 * edit and a bulk move never interleave. Neither lock is re-entrant (the group
 * lock is a promise chain, the move lock answers busy to itself): ROW HANDLERS
 * RUN WITH BOTH HELD AND MUST ONLY CALL LOCK-FREE INTERNALS (`writeGroupsLocked`,
 * not `setGroupsLocked`). A later row that must move people calls a lock-free
 * entry of the mover, never `moveEventMembers`.
 *
 * ## Extension contract (for #1240 to #1243)
 *
 * Add one `LiveEditRow` (via `defineRow`) to `LIVE_EDIT_ROWS`; the planner, the
 * confirmation token, the executor, the result text and the audit details need
 * no change. A row supplies:
 *   - `id`, `label`: the field name (letters only, it names the form fields
 *     `s_<id>` and `b_<id>`) and the host-facing name.
 *   - `read(event)`: the stored value as a JSON primitive or JSON structure,
 *     normalised so that "equal" is `stableStringify` equality.
 *   - `parse(raw)`: posted text to a value, or an error (a complete sentence that
 *     names the field: it is shown as it is).
 *   - `applicable(event)`: null when the row can be edited now, else the reason
 *     it cannot (shown read-only; a change is refused with it).
 *   - `validate?(to, ctx)`: an error text, or null. `ctx.event` is the fresh
 *     row; `ctx.validateSetup(mutate)` runs rule 8.
 *   - `needsConfirmation?(from, to, event)`: the reason to confirm, or null.
 *   - `apply(ctx)`: ONE conditional write decided from `ctx.from` and `ctx.event`
 *     (fresh), returning a `RowOutcome`. Before every outward (Discord) call it
 *     must ask `ctx.ending()`. A Discord failure must leave DB and Discord in a
 *     state a later pass reconciles, and say so with `partial` or `failed`; it
 *     must never sleep through a rate limit (use the rename queue and report).
 *   - `owed?(event)` and `reconcile?(ctx)`: only for a row whose `apply` can
 *     return `partial`. `partial` is kept in the result and the audit (what was
 *     stored, what is owed), and a re-save of the same form finds the stored
 *     value equal to the submitted one, sees `owed` (read from the fresh row,
 *     so the row must keep a durable marker, such as a pending flag) and runs
 *     `reconcile` instead of reporting "already applied"; it asks
 *     `needsConfirmation(stored, stored)` first like any change.
 *   - `describe(value)`: plain text for the result and the confirmation page.
 * Order of execution is the order of `LIVE_EDIT_ROWS`. Values must be JSON
 * (they travel in the token and the audit row).
 *
 * The form is the only part a row does not bring with it: its control is
 * rendered by `web/host-settings-view.ts` (a value field `s_<id>` and a base
 * field `b_<id>`, see `valueField` / `baseField`) and fed by
 * `createSettingsSection` in `web/routes/host-events.ts`. A new row adds its
 * control and that wiring (and its `__tests__/web/host-settings-routes.test.ts`
 * case); the planner, token, executor, result text and audit need nothing.
 */

import crypto from "node:crypto";
import { Buffer } from "buffer";
import { Event, type IEvent } from "../models/event.js";
import { env } from "../config/env.js";
import logger from "../utils/logger.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";
import { withEventMoveLock } from "./event-move-guard.js";
import { withGroupLock, writeGroupsLocked } from "./event-group-assignment.js";
import {
  checkChannelLead,
  resolveGroupCountLimits,
  validateGroupSetup,
  type GroupSetupInput,
  type RawGroupRow,
} from "./event-groups.js";

/** States in which an event may be edited. */
const OPEN_STATES = ["scheduled", "active"] as const;

/** An event id as stored: a Mongo ObjectId in hex. */
const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

/** How long a confirmation page stays valid. */
export const CONFIRM_TTL_MS = 10 * 60 * 1000;

/** Largest token accepted; a bigger one is refused before it is parsed. */
const TOKEN_MAX_LENGTH = 16_384;

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** JSON with sorted keys: equal values give equal text. */
export function stableStringify(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function same(a: JsonValue, b: JsonValue): boolean {
  return stableStringify(a) === stableStringify(b);
}

// ---------------------------------------------------------------
// Rule 7: derived values
// ---------------------------------------------------------------

/** A group holds more members than its size. Derived on read, never stored. */
export function isGroupOverSize(group: {
  size?: number | null;
  memberIds?: readonly string[] | null;
}): boolean {
  return (
    typeof group.size === "number" &&
    (group.memberIds ?? []).length > group.size
  );
}

// ---------------------------------------------------------------
// Rule 1: who may edit, and when
// ---------------------------------------------------------------

export type RefusalCode =
  | "events-off"
  | "no-event"
  | "unreadable"
  | "not-open"
  | "ending"
  | "busy"
  | "no-secret";

/** Host-facing wording of each refusal. */
export const REFUSAL_MESSAGE: Record<RefusalCode, string> = {
  "events-off":
    "Events are turned off, so nothing was changed. Turn on events.enabled first.",
  "no-event": "That event no longer exists. Nothing was changed.",
  unreadable: "The event could not be read, so nothing was changed.",
  "not-open":
    "This event is no longer running, so its settings can no longer be changed.",
  ending: "This event is being ended, so nothing was changed.",
  busy: "A move or another change is already in progress for this event. Wait for it to finish, then try again.",
  "no-secret":
    "The Web UI has no session secret configured, so a change that needs confirmation cannot be made. Nothing was changed.",
};

/**
 * THE rule for whether an edit may run (rule 1). `enabled` is null when the
 * switch could not be read. `event` is the fresh row, or null.
 */
export function editBlocker(input: {
  enabled: boolean | null;
  event: { guildId: string; state: string } | null;
  guildId: string;
  ending: boolean;
}): RefusalCode | null {
  if (input.enabled !== true) return "events-off";
  if (!input.event || input.event.guildId !== input.guildId) {
    return "no-event";
  }
  if (!(OPEN_STATES as readonly string[]).includes(input.event.state)) {
    return "not-open";
  }
  if (input.ending) return "ending";
  return null;
}

// ---------------------------------------------------------------
// Rows
// ---------------------------------------------------------------

export type RowOutcome =
  | { status: "applied" }
  /** The write's condition no longer held; nothing was written. */
  | { status: "lost" }
  | { status: "failed"; message?: string }
  /** Stored, but a follow-up part did not happen; a re-save reconciles. */
  | { status: "partial"; message: string };

export interface ValidateContext {
  /** The fresh row. */
  event: IEvent;
  /** Rule 8 for rows that change the group list; `[]` means valid. */
  validateSetup(mutate: (input: GroupSetupInput) => void): string[];
}

export interface ApplyContext<V extends JsonValue = JsonValue> {
  /** The fresh row the plan was made from. */
  event: IEvent;
  eventId: string;
  guildId: string;
  from: V;
  to: V;
  /** Synchronous: an end or cancel holds the event. Ask before every outward write. */
  ending(): boolean;
}

export interface LiveEditRow<V extends JsonValue = JsonValue> {
  readonly id: string;
  readonly label: string;
  read(event: IEvent): V;
  parse(raw: string): { ok: true; value: V } | { ok: false; error: string };
  applicable(event: IEvent): string | null;
  validate?(to: V, ctx: ValidateContext): string | null;
  needsConfirmation?(from: V, to: V, event: IEvent): string | null;
  apply(ctx: ApplyContext<V>): Promise<RowOutcome>;
  /**
   * Only for a row whose `apply` can return `partial` (the target is stored,
   * a follow-up is still owed). Reads the FRESH row and returns what is still
   * owed (plain text), or null when nothing is. A re-save whose submitted value
   * equals the stored one then plans a reconcile change instead of "already
   * applied", and the executor calls `reconcile`.
   */
  owed?(event: IEvent): string | null;
  /**
   * Finish the owed follow-up, from the stored value (`ctx.from === ctx.to`).
   * The same rules as `apply` (conditional, explicit outcome, ask
   * `ctx.ending()` before outward calls). `applicable` and `validate` are not
   * asked: the target is already stored and only its follow-up is owed.
   */
  reconcile?(ctx: ApplyContext<V>): Promise<RowOutcome>;
  describe(value: V): string;
}

/** Type-erase a row for the registry (rows are typed where they are written). */
export function defineRow<V extends JsonValue>(
  row: LiveEditRow<V>,
): LiveEditRow {
  return row as unknown as LiveEditRow;
}

const isRealId = (id: unknown): boolean => typeof id === "string" && id !== "";

/** Whether the main channel or any group channel exists (or is recorded). */
export function channelsExist(event: {
  channelId?: string | null;
  groups?: ReadonlyArray<{ channelId?: string | null }> | null;
}): boolean {
  return (
    isRealId(event.channelId) ||
    (event.groups ?? []).some((g) => isRealId(g.channelId))
  );
}

/** Row: minutes before the start that the channels are created. */
export const leadTimeRow = defineRow<number | null>({
  id: "channelLeadMinutes",
  label: "Channel creation time",
  read: (e) =>
    typeof e.channelLeadMinutes === "number" ? e.channelLeadMinutes : null,
  applicable: (e) =>
    channelsExist(e)
      ? "The channels already exist, so the creation time can no longer change."
      : null,
  parse: (raw) => checkChannelLead(raw),
  describe: (v) =>
    v === null ? "the server default" : `${v} minutes before the start`,
  async apply({ eventId, guildId, from, to }) {
    // Conditional on: open, this guild, the value decided from, and still no
    // channel anywhere (`$type` string and not empty, the same test as
    // `channelsExist`). A channel created meanwhile makes this match nothing.
    const created = { $type: "string" as const, $ne: "" };
    const result = await Event.updateOne(
      {
        _id: eventId,
        guildId,
        state: { $in: [...OPEN_STATES] },
        channelLeadMinutes: from,
        $nor: [
          { channelId: created },
          { groups: { $elemMatch: { channelId: created } } },
        ],
      },
      { $set: { channelLeadMinutes: to } },
    );
    return (result?.matchedCount ?? 0) === 1
      ? { status: "applied" }
      : { status: "lost" };
  },
});

/** Row: lock groups on or off (#1191). */
export const lockGroupsRow = defineRow<boolean>({
  id: "groupsLocked",
  label: "Lock groups",
  read: (e) => e.groupsLocked === true,
  applicable: (e) =>
    e.groupsEnabled === true && (e.groups ?? []).length > 0
      ? null
      : "This event has no groups.",
  parse: (raw) =>
    raw === "1" || raw === "0"
      ? { ok: true, value: raw === "1" }
      : { ok: false, error: "Lock groups: choose locked or unlocked." },
  describe: (v) => (v ? "locked" : "unlocked"),
  async apply({ eventId, guildId, from, to }) {
    const written = await writeGroupsLocked({ guildId, eventId, from, to });
    return written === "applied" ? { status: "applied" } : { status: "lost" };
  },
});

/** The rows, in execution order. Later steps add theirs here. */
export const LIVE_EDIT_ROWS: readonly LiveEditRow[] = [
  leadTimeRow,
  lockGroupsRow,
];

// ---------------------------------------------------------------
// Rule 8: validation of an edited setup
// ---------------------------------------------------------------

/** The stored setup as the form's input, with `presetId: ""` (never the stored one). */
export function storedSetupInput(event: IEvent): GroupSetupInput {
  const rows: RawGroupRow[] = (event.groups ?? []).map((g, i) => ({
    position: i + 1,
    name: g.name ?? "",
    kind: g.kind ?? "team",
    size: typeof g.size === "number" ? String(g.size) : "",
    tag: g.tag ?? "",
    marker: g.marker ?? "",
    key: g.key,
  }));
  return {
    enabled: event.groupsEnabled === true,
    presetId: "",
    groupLabel: event.groupLabel ?? "",
    leaderLabel: event.leaderLabel ?? "",
    captainsEnabled: event.captainsEnabled === true,
    captainCustomisationEnabled: event.captainCustomisationEnabled === true,
    tagsEnabled: event.tagsEnabled === true,
    tagsSuffix: event.tagsSuffix === true,
    channelLeadMinutes:
      typeof event.channelLeadMinutes === "number"
        ? String(event.channelLeadMinutes)
        : "",
    rows,
  };
}

/**
 * Validate the stored setup after `mutate` edited it (rule 8). `maxGroups` is
 * the configured cap, or null when it could not be read (fails closed).
 */
export function validateEditedSetup(
  event: IEvent,
  maxGroups: number | null,
  mutate: (input: GroupSetupInput) => void,
): string[] {
  if (maxGroups === null) {
    return ["The group limit could not be read, so nothing was changed."];
  }
  const input = storedSetupInput(event);
  mutate(input);
  const cap = Math.max(
    resolveGroupCountLimits(1, maxGroups).maxCount,
    (event.groups ?? []).length,
  );
  const result = validateGroupSetup(input, { maxCount: cap });
  return result.ok ? [] : result.errors;
}

// ---------------------------------------------------------------
// Submission and planner (rule 3)
// ---------------------------------------------------------------

export interface SubmittedEntry {
  rowId: string;
  /** What the host set. */
  to: JsonValue;
  /** What the form showed. */
  base: JsonValue;
  /** A confirmed reconcile change (see `LiveEditRow.owed`); only from a token. */
  reconcile?: boolean;
}

/** Form field names of a row. */
export const valueField = (rowId: string): string => `s_${rowId}`;
export const baseField = (rowId: string): string => `b_${rowId}`;

/**
 * Read the posted form: for each row, a value field and its base. A row whose
 * value field is absent is untouched. A value without its base, or an
 * unparseable base, means the form is not one this page produced: refused.
 */
export function parseSubmission(
  body: unknown,
  rows: readonly LiveEditRow[] = LIVE_EDIT_ROWS,
): { entries: SubmittedEntry[]; errors: string[] } {
  const source = (body ?? {}) as Record<string, unknown>;
  const entries: SubmittedEntry[] = [];
  const errors: string[] = [];
  for (const row of rows) {
    const raw = source[valueField(row.id)];
    if (typeof raw !== "string") continue;
    const rawBase = source[baseField(row.id)];
    const base = typeof rawBase === "string" ? row.parse(rawBase) : null;
    if (!base || !base.ok) {
      errors.push(`${row.label}: the form is out of date. Reload the page.`);
      continue;
    }
    const to = row.parse(raw);
    if (!to.ok) {
      errors.push(to.error);
      continue;
    }
    entries.push({ rowId: row.id, to: to.value, base: base.value });
  }
  return { entries, errors };
}

export interface PlannedChange {
  rowId: string;
  label: string;
  from: JsonValue;
  to: JsonValue;
  /** Why the host must confirm, or null. */
  confirm: string | null;
  /** The target is already stored; only its owed follow-up is run. */
  reconcile?: boolean;
}

export interface PlanProblem {
  rowId: string;
  label: string;
  message: string;
}

export interface LiveEditPlan {
  changes: PlannedChange[];
  /** Fields someone else changed while the form was open: not written. */
  conflicts: PlanProblem[];
  /** Fields already at the submitted value. */
  alreadyApplied: string[];
  /** Validation errors: a plan with any is never applied. */
  errors: string[];
}

/** Plan from the FRESH event (rule 3). Pure. */
export function planLiveEdit(input: {
  event: IEvent;
  entries: readonly SubmittedEntry[];
  rows?: readonly LiveEditRow[];
  maxGroups: number | null;
}): LiveEditPlan {
  const rows = input.rows ?? LIVE_EDIT_ROWS;
  const plan: LiveEditPlan = {
    changes: [],
    conflicts: [],
    alreadyApplied: [],
    errors: [],
  };
  const ctx: ValidateContext = {
    event: input.event,
    validateSetup: (mutate) =>
      validateEditedSetup(input.event, input.maxGroups, mutate),
  };
  const seen = new Set<string>();
  // Registry order, so execution order never depends on the form.
  for (const row of rows) {
    const entry = input.entries.find((e) => e.rowId === row.id);
    if (!entry || seen.has(row.id)) continue;
    seen.add(row.id);
    const stored = row.read(input.event);
    const owed = row.owed?.(input.event) ?? null;
    const reconcileChange = (): PlannedChange => ({
      rowId: row.id,
      label: row.label,
      from: stored,
      to: stored,
      confirm: row.needsConfirmation?.(stored, stored, input.event) ?? null,
      reconcile: true,
    });
    if (entry.reconcile === true) {
      // A confirmed reconcile: only while that follow-up is still owed (else
      // the fresh change set differs from the confirmed one: stale).
      if (owed !== null && same(entry.to, stored)) {
        plan.changes.push(reconcileChange());
      }
      continue;
    }
    if (same(entry.to, stored)) {
      // Stored already. A follow-up owed is finished, EVEN WHEN the form's
      // base equals it (a refreshed form after a partial save shows the stored
      // value as both value and base: that is the normal retry, and
      // reconciling writes no field). Otherwise it is already applied, or
      // untouched when the host did not change it.
      if (owed !== null && row.reconcile) {
        plan.changes.push(reconcileChange());
      } else if (!same(entry.to, entry.base)) {
        plan.alreadyApplied.push(row.id);
      }
      continue;
    }
    // Untouched, and somebody else changed it meanwhile: never written.
    if (same(entry.to, entry.base)) continue;
    if (!same(stored, entry.base)) {
      plan.conflicts.push({
        rowId: row.id,
        label: row.label,
        message:
          "was changed by someone else while you were editing. Reload the page and try again",
      });
      continue;
    }
    const blocked = row.applicable(input.event);
    if (blocked) {
      plan.errors.push(`${row.label}: ${blocked}`);
      continue;
    }
    const invalid = row.validate?.(entry.to, ctx) ?? null;
    if (invalid) {
      plan.errors.push(`${row.label}: ${invalid}`);
      continue;
    }
    plan.changes.push({
      rowId: row.id,
      label: row.label,
      from: stored,
      to: entry.to,
      confirm: row.needsConfirmation?.(stored, entry.to, input.event) ?? null,
    });
  }
  return plan;
}

// ---------------------------------------------------------------
// Rule 6: the confirmation token
// ---------------------------------------------------------------

export interface ConfirmedChange {
  rowId: string;
  from: JsonValue;
  to: JsonValue;
  reconcile?: boolean;
}

/** Hash of a change set (rows with their from and to), order-independent. */
export function changeSetHash(changes: readonly ConfirmedChange[]): string {
  const canonical = [...changes]
    .map((c) => ({ r: c.rowId, f: c.from, t: c.to, k: c.reconcile === true }))
    .sort((a, b) => (a.r < b.r ? -1 : a.r > b.r ? 1 : 0));
  return crypto
    .createHash("sha256")
    .update(stableStringify(canonical as unknown as JsonValue))
    .digest("hex");
}

interface TokenPayload {
  v: 1;
  e: string;
  g: string;
  u: string;
  x: number;
  h: string;
  /** The event's `liveEditRevision` when the page was shown. */
  n: number;
  c: Array<{ r: string; f: JsonValue; t: JsonValue; k?: boolean }>;
}

function tokenMac(payload: string): string | null {
  const secret = env.webui.sessionSecret;
  if (!secret) return null;
  return crypto
    .createHmac("sha256", secret)
    .update(`live-edit-confirm\0${payload}`)
    .digest("base64url");
}

const canonicalId = (id: string): string => id.toLowerCase();

/** Sign a change set for one event, guild and host. Null without a secret (fail closed). */
export function signConfirmation(input: {
  eventId: string;
  guildId: string;
  userId: string;
  changes: readonly ConfirmedChange[];
  /** `revision` of the `needs-confirmation` outcome the changes came from. */
  revision: number;
  now?: number;
}): string | null {
  const payload: TokenPayload = {
    v: 1,
    e: canonicalId(input.eventId),
    g: input.guildId,
    u: input.userId,
    x: (input.now ?? Date.now()) + CONFIRM_TTL_MS,
    h: changeSetHash(input.changes),
    n: input.revision,
    c: input.changes.map((c) => ({
      r: c.rowId,
      f: c.from,
      t: c.to,
      ...(c.reconcile === true ? { k: true } : {}),
    })),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = tokenMac(body);
  return mac ? `${body}.${mac}` : null;
}

export type ConfirmationCheck =
  | { ok: true; changes: ConfirmedChange[]; revision: number }
  | { ok: false; reason: "invalid" | "expired" | "mismatch" | "no-secret" };

/**
 * Verify a token (constant-time MAC compare) and that it was issued for this
 * event, guild and user and has not expired. The change set is returned for
 * the executor, which still compares it with the fresh plan.
 */
export function verifyConfirmation(
  token: unknown,
  expect: { eventId: string; guildId: string; userId: string; now?: number },
): ConfirmationCheck {
  if (!env.webui.sessionSecret) return { ok: false, reason: "no-secret" };
  if (typeof token !== "string" || token.length > TOKEN_MAX_LENGTH) {
    return { ok: false, reason: "invalid" };
  }
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return { ok: false, reason: "invalid" };
  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = tokenMac(body);
  if (!expected) return { ok: false, reason: "no-secret" };
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    return { ok: false, reason: "invalid" };
  }
  let payload: TokenPayload;
  try {
    payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as TokenPayload;
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (
    payload?.v !== 1 ||
    typeof payload.e !== "string" ||
    typeof payload.g !== "string" ||
    typeof payload.u !== "string" ||
    typeof payload.x !== "number" ||
    typeof payload.h !== "string" ||
    typeof payload.n !== "number" ||
    !Array.isArray(payload.c) ||
    !payload.c.every((c) => c && typeof c.r === "string")
  ) {
    return { ok: false, reason: "invalid" };
  }
  const changes: ConfirmedChange[] = payload.c.map((c) => ({
    rowId: c.r,
    from: c.f,
    to: c.t,
    ...(c.k === true ? { reconcile: true } : {}),
  }));
  if (changeSetHash(changes) !== payload.h) {
    return { ok: false, reason: "invalid" };
  }
  if (
    payload.e !== canonicalId(expect.eventId) ||
    payload.g !== expect.guildId ||
    payload.u !== expect.userId
  ) {
    return { ok: false, reason: "mismatch" };
  }
  if (payload.x <= (expect.now ?? Date.now())) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, changes, revision: payload.n };
}

// ---------------------------------------------------------------
// The executor
// ---------------------------------------------------------------

export interface LiveEditDeps {
  /** `events.enabled`; null when it could not be read (treated as off). */
  isEventsEnabled(): Promise<boolean | null>;
  /** `events.groups.max_count`; null when it could not be read. */
  maxGroups(): Promise<number | null>;
  /** Synchronous: an end or cancel holds this event (`EventService.isEventBeingEnded`). */
  isEnding(eventId: string): boolean;
}

export interface NotApplied {
  rowId: string;
  label: string;
  reason: string;
}

/** A change that is stored but whose follow-up is still owed. */
export interface PartialApplied {
  rowId: string;
  label: string;
  from: JsonValue;
  to: JsonValue;
  /** What is still owed, in plain text. */
  owed: string;
  reconcile: boolean;
}

export type LiveEditOutcome =
  | { status: "refused"; code: RefusalCode; message: string }
  | { status: "invalid"; errors: string[] }
  | {
      status: "needs-confirmation";
      changes: PlannedChange[];
      reasons: string[];
      /** The event's `liveEditRevision` the plan was made at: goes into the token. */
      revision: number;
    }
  | { status: "stale"; message: string }
  | {
      status: "done";
      applied: PlannedChange[];
      /** Stored, follow-up owed: re-saving the same form finishes it. */
      partial: PartialApplied[];
      notApplied: NotApplied[];
      alreadyApplied: string[];
    };

/** The saves counted so far; a row from before the field reads as 0. */
function revisionOf(event: { liveEditRevision?: number | null }): number {
  return typeof event.liveEditRevision === "number"
    ? event.liveEditRevision
    : 0;
}

const STALE_MESSAGE =
  "The settings changed since you reviewed them, so nothing was applied. Review the form again.";

/**
 * Plan and apply one save. `submission` is a posted form (`parseSubmission`);
 * `confirmed` is the verified change set of a confirmation token. Exactly one
 * of them. Everything below runs with both locks held (see the module comment).
 */
export async function runLiveEdit(opts: {
  guildId: string;
  eventId: string;
  deps: LiveEditDeps;
  rows?: readonly LiveEditRow[];
  submission?: readonly SubmittedEntry[];
  confirmed?: readonly ConfirmedChange[];
  /** The token's `revision`; required with `confirmed`. */
  confirmedRevision?: number;
}): Promise<LiveEditOutcome> {
  const rows = opts.rows ?? LIVE_EDIT_ROWS;
  const { guildId, deps } = opts;
  const refuse = (code: RefusalCode): LiveEditOutcome => ({
    status: "refused",
    code,
    message: REFUSAL_MESSAGE[code],
  });
  if (!OBJECT_ID_RE.test(opts.eventId)) return refuse("no-event");
  const eventId = canonicalId(opts.eventId);

  const locked = await withEventMoveLock(eventId, () =>
    withGroupLock(guildId, eventId, () => runLocked()),
  );
  if (locked.busy) return refuse("busy");
  return locked.value;

  async function runLocked(): Promise<LiveEditOutcome> {
    // Config first, then the fresh read, then the hold check: nothing but
    // synchronous code between the read and the plan (rules 1 and 2).
    const enabled = await deps.isEventsEnabled().catch((err: unknown) => {
      logger.warn("Could not read events.enabled for a live edit:", err);
      return null;
    });
    const maxGroups = await deps.maxGroups().catch(() => null);
    let event: IEvent | null;
    try {
      event = (await Event.findOne({
        _id: eventId,
        guildId,
      }).lean()) as IEvent | null;
    } catch (err) {
      logger.error(
        `Event ${sanitizeForLog(eventId)}: could not read the event for a live edit:`,
        err,
      );
      return refuse("unreadable");
    }
    const blocked = editBlocker({
      enabled,
      event,
      guildId,
      ending: deps.isEnding(eventId),
    });
    if (blocked || !event) return refuse(blocked ?? "no-event");

    const entries: SubmittedEntry[] =
      opts.confirmed !== undefined
        ? opts.confirmed.map((c) => ({
            rowId: c.rowId,
            to: c.to,
            base: c.from,
            reconcile: c.reconcile,
          }))
        : [...(opts.submission ?? [])];
    if (entries.some((e) => !rows.some((r) => r.id === e.rowId))) {
      return { status: "stale", message: STALE_MESSAGE };
    }
    const plan = planLiveEdit({ event, entries, rows, maxGroups });
    if (plan.errors.length > 0) {
      return { status: "invalid", errors: plan.errors };
    }

    if (opts.confirmed !== undefined) {
      // The fresh change set must be exactly the one that was confirmed.
      // And the event must not have been saved through the live edit since the
      // page was shown: the same change set can come round again after a
      // reversal (A to B, B to A), and a used token must not apply it.
      if (
        opts.confirmedRevision !== revisionOf(event) ||
        plan.conflicts.length > 0 ||
        changeSetHash(plan.changes) !== changeSetHash(opts.confirmed)
      ) {
        return { status: "stale", message: STALE_MESSAGE };
      }
    } else {
      const reasons = plan.changes
        .map((c) => c.confirm)
        .filter((r): r is string => r !== null);
      if (reasons.length > 0) {
        // A conflict must not vanish into the confirmation page: the form is
        // stale, so the host reloads and decides again.
        if (plan.conflicts.length > 0) {
          return { status: "stale", message: STALE_MESSAGE };
        }
        return {
          status: "needs-confirmation",
          changes: plan.changes,
          reasons,
          revision: revisionOf(event),
        };
      }
    }

    // Claim the save (rule 6): the revision moves on BEFORE any row is written,
    // conditional on the one this plan was made at. A token issued at an older
    // revision can therefore never apply again, however the values moved since
    // (A to B, B to A). A failed save still consumes it (the safe direction).
    if (plan.changes.length > 0) {
      const revision = revisionOf(event);
      if (deps.isEnding(eventId)) return refuse("ending");
      let claimed = false;
      try {
        const result = await Event.updateOne(
          {
            _id: eventId,
            guildId,
            state: { $in: [...OPEN_STATES] },
            liveEditRevision: revision === 0 ? { $in: [0, null] } : revision,
          } as never,
          { $inc: { liveEditRevision: 1 } },
        );
        claimed = (result?.matchedCount ?? 0) === 1;
      } catch (err) {
        logger.error(
          `Event ${sanitizeForLog(eventId)}: could not claim a live edit:`,
          err,
        );
      }
      if (!claimed) return { status: "stale", message: STALE_MESSAGE };
    }

    const applied: PlannedChange[] = [];
    const partial: PartialApplied[] = [];
    const notApplied: NotApplied[] = plan.conflicts.map((c) => ({
      rowId: c.rowId,
      label: c.label,
      reason: c.message,
    }));
    for (const change of plan.changes) {
      const row = rows.find((r) => r.id === change.rowId) as LiveEditRow;
      // Synchronous check, then the write: nothing is awaited in between.
      if (deps.isEnding(eventId)) {
        notApplied.push({
          rowId: change.rowId,
          label: change.label,
          reason: "was not saved because the event is being ended",
        });
        continue;
      }
      let outcome: RowOutcome;
      try {
        const ctx = {
          event: event as IEvent,
          eventId,
          guildId,
          from: change.from,
          to: change.to,
          ending: (): boolean => deps.isEnding(eventId),
        };
        outcome =
          change.reconcile === true && row.reconcile
            ? await row.reconcile(ctx)
            : await row.apply(ctx);
      } catch (err) {
        logger.error(
          `Event ${sanitizeForLog(eventId)}: live edit of ${row.id} failed:`,
          err,
        );
        outcome = { status: "failed" };
      }
      if (outcome.status === "applied") {
        applied.push(change);
      } else if (outcome.status === "partial") {
        // Stored, but not finished: kept in the result and the audit with
        // what is owed, never folded into "not applied".
        partial.push({
          rowId: change.rowId,
          label: change.label,
          from: change.from,
          to: change.to,
          owed: outcome.message,
          reconcile: change.reconcile === true,
        });
      } else if (outcome.status === "lost") {
        notApplied.push({
          rowId: change.rowId,
          label: change.label,
          reason:
            "was changed by someone else while this was being saved. Try again",
        });
      } else {
        notApplied.push({
          rowId: change.rowId,
          label: change.label,
          reason:
            outcome.message ??
            "could not be saved. Try again; the other changes are kept",
        });
      }
    }
    return {
      status: "done",
      applied,
      partial,
      notApplied,
      alreadyApplied: plan.alreadyApplied,
    };
  }
}

// ---------------------------------------------------------------
// The one result
// ---------------------------------------------------------------

export interface LiveEditResult {
  ok: boolean;
  message: string;
  /** Audit details: ids and values only, bounded by the audit layer. */
  details: Record<string, unknown>;
  errorMessage?: string;
}

/** A row's value as plain text (the confirmation page, the result). */
export function describeRowValue(
  rowId: string,
  value: JsonValue,
  rows: readonly LiveEditRow[] = LIVE_EDIT_ROWS,
): string {
  const row = rows.find((r) => r.id === rowId);
  return row ? row.describe(value) : String(value);
}

/** The host-facing result and audit details of an outcome (one per save). */
export function describeLiveEditOutcome(
  outcome: LiveEditOutcome,
  rows: readonly LiveEditRow[] = LIVE_EDIT_ROWS,
): LiveEditResult {
  const rowOf = (id: string): LiveEditRow | undefined =>
    rows.find((r) => r.id === id);
  switch (outcome.status) {
    case "refused":
      return {
        ok: false,
        message: outcome.message,
        details: { outcome: outcome.code },
        errorMessage: outcome.code,
      };
    case "invalid":
      return {
        ok: false,
        message: `Nothing was changed. ${outcome.errors.join(" ")}`,
        details: { outcome: "invalid", errors: outcome.errors },
        errorMessage: "invalid",
      };
    case "stale":
      return {
        ok: false,
        message: outcome.message,
        details: { outcome: "stale" },
        errorMessage: "stale",
      };
    case "needs-confirmation":
      return {
        ok: true,
        message: "Confirmation needed. Nothing was changed yet.",
        details: {
          outcome: "needs-confirmation",
          changes: outcome.changes.map((c) => ({
            row: c.rowId,
            from: c.from,
            to: c.to,
          })),
        },
      };
    case "done": {
      const unfinished = outcome.notApplied.length + outcome.partial.length;
      const details = {
        outcome:
          unfinished > 0
            ? outcome.applied.length + outcome.partial.length > 0
              ? "partial"
              : "not-applied"
            : outcome.applied.length > 0
              ? "applied"
              : "nothing-to-do",
        changes: outcome.applied.map((c) => ({
          row: c.rowId,
          from: c.from,
          to: c.to,
          ...(c.reconcile === true ? { reconcile: true } : {}),
        })),
        // Stored but not finished, with what is still owed.
        stored: outcome.partial.map((c) => ({
          row: c.rowId,
          from: c.from,
          to: c.to,
          owed: c.owed,
          ...(c.reconcile ? { reconcile: true } : {}),
        })),
        notApplied: outcome.notApplied.map((n) => ({
          row: n.rowId,
          reason: n.reason,
        })),
        alreadyApplied: outcome.alreadyApplied,
      };
      if (outcome.applied.length === 0 && unfinished === 0) {
        return {
          ok: true,
          message: "Nothing to change: the event already has these settings.",
          details,
        };
      }
      const saved = outcome.applied.map((c) => {
        const row = rowOf(c.rowId);
        return c.reconcile === true
          ? `${c.label} is finished`
          : `${c.label} is now ${row ? row.describe(c.to) : String(c.to)}`;
      });
      const parts: string[] = [];
      if (saved.length > 0) parts.push(`Saved: ${saved.join("; ")}.`);
      if (outcome.partial.length > 0) {
        parts.push(
          `Saved but not finished: ${outcome.partial
            .map((c) => {
              const row = rowOf(c.rowId);
              return `${c.label} is now ${row ? row.describe(c.to) : String(c.to)} (${c.owed})`;
            })
            .join("; ")}. Save again to finish.`,
        );
      }
      if (outcome.notApplied.length > 0) {
        parts.push(
          `Not saved: ${outcome.notApplied
            .map((n) => `${n.label} ${n.reason}`)
            .join("; ")}. Save again to retry.`,
        );
      }
      return {
        ok: unfinished === 0,
        message: parts.join(" "),
        details,
        errorMessage: "some changes were not applied or not finished",
      };
    }
  }
}
