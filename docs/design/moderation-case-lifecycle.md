# Design: moderation case lifecycle

Design pass for [#908](https://github.com/lonix/koolbot/issues/908) — review periods, outcomes and
readmission on top of the moderation log. **Status: proposed, not built.** Nothing in this document
has shipped; it exists so the decision can be reviewed before any code lands.

## 1. Why this needs a design pass

`src/models/moderation-log.ts` states its own scope in its docstring:

> Deliberately kept simple (an append-only history, not a case-management system): no appeals,
> expiry, or edit workflow.

That was the right call for #728 and it is why the log has stayed cheap. A case lifecycle reverses
it. Three things make that reversal more expensive than it looks, and they are the reason this is a
design issue rather than a command PR:

1. **Mutability.** Lifecycle state changes; log rows do not. Whatever holds `status` and `reviewAt`
   is a mutable record, and the append-only guarantee is the log's main property.
2. **Retention.** `ModerationLogCleanupService` prunes by `createdAt` against
   `moderation.retention_days` (default 365). A case with a six-month review, or the history behind
   a readmitted member, can be deleted before it is needed. This is a correctness bug the moment a
   `reviewAt` exists, not a nice-to-have.
3. **Privacy.** `__tests__/config/user-data-registry-drift.test.ts` scans `src/models/*.ts` for
   user-id-shaped fields and fails the build when one is not declared in
   `src/services/user-data-registry.ts`. A new model carrying `userId` has to be triaged for export
   (#719) *and* deletion (#906) before it can ship.

## 2. Recommendation first

**Land [#907](https://github.com/lonix/koolbot/issues/907) before building any of this.** That issue
surfaces prior history at the moment an action is recorded, is read-side only, needs no model change
and no retention work. It is the cheap subset of the same idea. If moderators stop asking once it has
shipped, this issue should be closed rather than built — the "keep the log append-only and do
nothing" alternative in #908 is genuinely defensible.

If it is still wanted after #907, build **Phase 1 only** (§9): review date, review queue, four
outcomes, retention exemption. Explicitly out of Phase 1: automatic case opening, KoolBot performing
the unban itself, and any automated `expired` transition. Each of those is a separate decision with
its own failure mode, and none is needed for the use case in the issue.

## 3. Model: a separate `ModerationCase` collection

Two options were on the table in the issue. This design picks the second.

| Option | Consequence |
| --- | --- |
| Extend `ModerationLog` with lifecycle fields | Every reader has to know which fields mutate under it; the prune-by-`createdAt` rule grows exceptions *inside* the collection it prunes; the docstring's guarantee is gone for all rows, including the ~99% that are plain history. |
| **New `ModerationCase` collection referencing log rows** | `ModerationLog` stays append-only and its privacy classification stays as-is. Mutation is confined to one small collection whose whole purpose is to mutate. Costs one extra query on the `/modlog` path and one join on the admin page. |

The second also matches the shape of the data: cases are *rare* (a handful per guild per year)
while log rows are *many*. Putting a rarely-set `reviewAt` on every row is the wrong storage shape
regardless of the guarantee.

### 3.1 Schema sketch

```ts
// src/models/moderation-case.ts
export type ModerationCaseStatus =
  "open" | "under_review" | "upheld" | "lifted" | "expired";

export type ModerationCaseOutcome =
  "upheld" | "extended" | "permanent" | "readmitted";

export interface IModerationCaseEvent {
  at: Date;
  /** Staff member who recorded the decision. Never null — cases are only opened by a human. */
  byUserId: string;
  from: ModerationCaseStatus;
  to: ModerationCaseStatus;
  outcome: ModerationCaseOutcome | null; // null for the opening event
  note: string | null;
}

export interface IModerationCase extends Document {
  guildId: string;
  /** Per-guild, human-quotable ("case #14"). See §3.3. */
  caseNumber: number;
  /** The member the case is about. */
  userId: string;
  /** The `ModerationLog` row that opened the case (the kick/ban). */
  originEntryId: Types.ObjectId;
  /** Denormalised from the origin entry so the queue renders without a join. */
  action: ModerationAction;
  status: ModerationCaseStatus;
  /** When staff should look at this again. `null` on terminal statuses. */
  reviewAt: Date | null;
  openedAt: Date;
  /** Moderator who took the originating action, copied from the origin entry. May be null. */
  originModeratorId: string | null;
  /** Staff member who opened the case (not necessarily the same person). */
  openedByUserId: string;
  /** The `ModerationLog` row that enacted a readmission (the `unban`), once one exists. */
  resolutionEntryId: Types.ObjectId | null;
  /** Append-only trail *inside* the case: every transition, who, when, why. */
  events: IModerationCaseEvent[];
  updatedAt: Date;
}
```

`events[]` is what makes the mutable collection auditable: `status` is the current answer, `events`
is how it got there. It is the same append-only-array shape as the session objects in
`models/voice-channel-tracking.ts`, so it is a pattern the codebase already carries.

### 3.2 Indexes

```ts
// The review queue: due and overdue cases for one guild.
ModerationCaseSchema.index({ guildId: 1, status: 1, reviewAt: 1 });
// Per-member lookup, backing the `/modlog` case line and the member view.
ModerationCaseSchema.index({ guildId: 1, userId: 1, openedAt: -1 });
// Case reference lookup, and the uniqueness guarantee for §3.3.
ModerationCaseSchema.index({ guildId: 1, caseNumber: 1 }, { unique: true });
// Reverse lookup from a log row, used by `/modlog` and by the retention exemption.
ModerationCaseSchema.index({ guildId: 1, originEntryId: 1 });
```

### 3.3 Case numbers

Moderators quote case numbers out loud, so a hex ObjectId suffix is a poor reference. The repo has
no sequence-counter precedent, so this needs a decision:

- **Recommended:** a tiny `ModerationCaseCounter` model (`{ guildId, seq }`) incremented with
  `findOneAndUpdate({ guildId }, { $inc: { seq: 1 } }, { upsert: true, new: true })`. Race-free,
  ~20 lines, no dependency on read-then-write. The unique index above is the backstop.
- **Alternative:** `_id.toHexString().slice(-6)`. Zero new infrastructure, but not sequential and
  awkward to read aloud.

Do **not** use `countDocuments() + 1` — two staff opening cases in the same second collide, and the
unique index turns that into a 500 on the admin page.

## 4. State machine

```text
                      staff opens a case against a kick/ban log row
                                        │
                                        ▼
                        ┌──────────── open ────────────┐
                        │        (reviewAt set)        │
       reviewAt passes  │                              │  reviewAt = null
       (daily cron)     ▼                              ▼
                   under_review                   (stays open, never
                    │   │   │  │                   enters the queue —
        ┌───────────┘   │   │  └───────────┐       queryable, indefinite)
        │               │   │              │
     extend          uphold │           readmit
   (new reviewAt)   (new reviewAt)         │
        │               │   │              ▼
        └──────► open ◄──┘   │           lifted  (terminal)
                             │
                         permanent
                             │
                             ▼
                          upheld  (terminal, reviewAt = null)

  expired (terminal): closed without a human decision — see §4.2
```

### 4.1 Transitions

| From | Action | To | Writes |
| --- | --- | --- | --- |
| — | open case | `open` | case created, `reviewAt` set (or null), opening event |
| `open` | review comes due | `under_review` | status flip + notice, by the cron job (§6) |
| `under_review` | uphold | `open` | new `reviewAt`, event with outcome `upheld` |
| `under_review` | extend | `open` | new `reviewAt` (required), outcome `extended` |
| `under_review` | make permanent | `upheld` | `reviewAt: null`, outcome `permanent` |
| `under_review` | readmit | `lifted` | `reviewAt: null`, outcome `readmitted`, optional `resolutionEntryId` |
| `open` | any of the four | as above | staff may decide early; the queue is a prompt, not a gate |
| `upheld` / `lifted` / `expired` | — | — | terminal; the UI offers no action, the service rejects one |

Every transition goes through one service method that takes `(caseId, expectedStatus, outcome)` and
uses a conditional update (`findOneAndUpdate({ _id, status: expectedStatus }, …)`), so two staff
resolving the same case from two browser tabs cannot both win. The loser gets a flash error naming
the status it actually found.

Note that `uphold` and `extend` both land back in `open` with a new `reviewAt`. They are kept
distinct because the *outcome* recorded in `events[]` is the point of the feature — "reviewed and
upheld twice" reads differently from "kept getting deferred".

### 4.2 Why `under_review` is stored rather than derived

The queue could be derived (`status: "open" AND reviewAt <= now`) with no status flip at all. Storing
it wins on one thing: the cron job posts a "due for review" notice, and a stored transition makes
that notice idempotent without a second `notifiedAt` field — the job only notifies on cases it
actually flipped. The cost is one write per due case per lifetime, which for a handful of cases a
year is nothing. **Recommended: store it.**

`expired` has no automatic producer in Phase 1. It exists for two later needs: a retention rule that
closes very old unreviewed cases, and the safety valve for a case whose origin entry has gone
missing. Leaving it unproduced is deliberate — an automatic expiry silently converts "nobody looked
at this" into "this is resolved", which is exactly the outcome the issue's use case is trying to
prevent.

### 4.3 Who opens a case

Discord's native kick/ban flow has no field that could carry a review date, so setting one is always
a second, deliberate step. Therefore:

- **Phase 1: staff open cases by hand** from the admin page, against an existing log entry.
- **Later, opt-in:** `moderation.cases.auto_open_actions` (CSV of `kick`, `ban`; default empty)
  auto-opens a case with `reviewAt = now + moderation.cases.default_review_days` when
  `ModerationService.handleAuditLogEntry` mirrors a matching action. Off by default because
  auto-opening a case for every ban in a large guild produces a queue nobody works.

## 5. Surface: Web UI, plus a case line in `/modlog`

`CLAUDE.md`'s "Admin surface: Web UI only" rule settles this — a review queue with uphold / extend /
permanent / readmit actions is case *management*, so it belongs under `src/web/`. No new slash
command.

### 5.1 Admin page

A **Cases** section on the existing `/admin/moderation` page rather than a new route: the nav entry
already exists (`src/web/admin-layout.ts`), the queue is small, and moderators looking at the log
and at the queue are doing the same job. Three groups, in this order:

1. **Overdue** — `status: "under_review"`, `reviewAt < now`, oldest first.
2. **Due soon** — `status: "open"`, `reviewAt` within the next 7 days.
3. **Recently resolved** — terminal, `events[-1].at` within the last 30 days.

Each row shows the member, the originating action and its reason, who took it, and — this is the
whole point of the feature — the member's prior log entries, read with the existing
`ModerationService.getHistory` / `countHistory`. No new query paths.

Read side goes in `src/web/read-only-routes.ts` alongside the existing moderation handler; rendering
in `src/web/admin-views.ts` next to `renderModerationPage`. As on that page today,
`moderation.enabled` is the master gate and the section renders a disabled notice when it is off.

### 5.2 Write routes

A new `src/web/routes/write/moderation.ts` exporting `createModerationRouter(client)`, mounted in
`createWriteRouter` (`src/web/write-routes.ts`) — which already applies `requireSession`, the admin
role check and `requireCsrf` at the single mount point, so the module adds no middleware of its own.

```text
POST /moderation/cases/open              entryId, reviewAt | reviewInDays, note
POST /moderation/cases/:id/uphold        nextReviewAt | nextReviewInDays, note
POST /moderation/cases/:id/extend        nextReviewAt  (required), note
POST /moderation/cases/:id/permanent     note
POST /moderation/cases/:id/readmit       note, [performUnban]
```

Every one calls `recordAudit` from `src/web/audit.ts` — a case decision is precisely what the web
audit log is for, and it is the answer to "who let them back in?" if the case itself is later
pruned. Use `flashRedirect` / `getString` / `asyncHandler` / `TEXT_LIMITS` from
`src/web/routes/write/helpers.ts` and add a `caseNote` limit there rather than inventing a local
constant.

`performUnban` is gated behind `moderation.cases.readmit_unbans` (default **false**). Recording the
decision is the feature; performing the unban is a distinct privilege, and a bot that silently
unbans on a checkbox tick is a surprise. When enabled, the REST call goes through
`CommandManager.makeDiscordApiCall` per `CLAUDE.md`, and a failed unban must still record the
decision — the case flips to `lifted` and the flash says the Discord-side unban failed.

### 5.3 `/modlog`

`/modlog` grows one line per entry that is the origin of a case:

```text
👢 Kick — 12 Jan 2026 by @moderator
Reason: Repeated spam after warnings
Case #14 — under review, due 12 Mar 2026
```

```text
🔨 Ban — 3 Aug 2025 by @moderator
Reason: Harassment
Case #9 — readmitted 4 Feb 2026 by @staff
```

One extra query per page: `ModerationCase.find({ guildId, originEntryId: { $in: pageIds } })`,
keeping the command at two queries total. **Watch the embed budget:** `src/commands/modlog.ts`
already trims reasons to `MAX_REASON_DISPLAY_LENGTH` (300) to keep a 10-entry page inside the
4096-char description limit (#840). A ~55-char case line on every entry costs up to ~550 chars, so
either lower the reason budget or rely on `clampToLimit` — and add a test that a full page of
maximal entries *plus* case lines still fits, because the existing test only covers the former.

## 6. Scheduling

A new `ModerationCaseReviewService extends ScheduledService` (`src/services/scheduled-service.ts`).
Per `CLAUDE.md`, do not hand-roll the cron skeleton and do not add an `isRunning` guard — the base
class already coalesces concurrent runs and swallows tick failures. The subclass supplies only:

- `isEnabled()` → `moderation.enabled && moderation.cases.enabled`
- `resolveSchedule()` → `moderation.cases.review_cron` (default `0 9 * * *`, a morning nudge)
- `runOnce()` → find `{ guildId, status: "open", reviewAt: { $lte: now } }`, flip each to
  `under_review` with an event, then post one digest message naming the cases now due

Return a summary object as `TSummary` so the admin page can offer a "run now" button, as the other
scheduled services do.

The notice channel follows the repo convention (`core.<type>.enabled` + `core.<type>.channel_id`,
mirroring `core.startup.*` per `CLAUDE.md`): add `core.moderation_review.*` and send via
`DiscordLogger.logToChannel`, which is already generic over `core.<type>` and needs **no new logger
code**. The feature gate stays `moderation.cases.enabled`; the `core.*` pair only decides whether and
where the notice is posted.

Wire the service into `src/index.ts` next to `ModerationLogCleanupService`.

## 7. Retention — the part most likely to be got wrong

Today: `ModerationLogCleanupService.runCleanup()` runs `ModerationLog.deleteMany({ createdAt: { $lt:
cutoff } })` daily at 03:30, with `moderation.retention_days` default 365 and `<= 0` meaning "keep
forever". With cases in play that can delete the origin entry of a live case, or the prior history
that makes a review decidable — the exact data the feature exists to show.

Three rules, all of which need tests:

1. **Never prune an entry a live case references.** Per run, collect
   `ModerationCase.distinct("originEntryId", { guildId, status: { $in: ["open", "under_review"] } })`
   plus the non-null `resolutionEntryId`s, and add `_id: { $nin: protectedIds }` to the delete
   filter. The set is bounded by *open case count* (tens), not log size, so `$nin` is safe here in a
   way it would not be against the log itself.
2. **Never prune the context behind a live or recent case.** Collect
   `ModerationCase.distinct("userId", …)` for cases that are non-terminal, or resolved within
   `moderation.cases.history_grace_days` (default 365), and add `userId: { $nin: protectedUserIds }`.
   Again bounded by case count. This is what makes "two warnings → timeout → removed → reviewed →
   allowed back → new issue" still readable a year later.
3. **Prune cases on their own rule, measured from resolution.** `moderation.cases.retention_days`
   (default `0` = keep forever) applied to the last event's timestamp, never to `openedAt` — a case
   opened 400 days ago and resolved yesterday is a fresh decision record. Non-terminal cases are
   never pruned regardless of age; they are the queue.

Concretely, the bug rules 1–2 fix: an entry created on day 1 with a review at day 400 is deleted on
day 365 under today's code, and the review then has nothing to review. Test that case directly.

`moderation.retention_days: 0` keeps its current meaning — nothing is pruned, so the exemptions are
moot. Also keep the existing behaviour that the whole job no-ops while `moderation.enabled` is off.

## 8. Cross-cutting requirements

### 8.1 Per-user data registry (#719, #913, #906) — build-blocking

`ModerationCase` carries four user-id fields, and `user-data-registry-drift.test.ts` fails the build
until each is declared in `src/services/user-data-registry.ts`. Recommended classification, matching
how `moderation-log` is already classified there:

| Field | `exportable` | `subject` | `onDelete` |
| --- | --- | --- | --- |
| `userId` | `false` | `self` | `retain` |
| `openedByUserId` | `false` | `mention` | `retain` |
| `originModeratorId` | `false` | `mention` | `retain` |
| `events[].byUserId` | `false` | `mention` | `retain` |

`collection: "moderation-case"`, `guildScoped: true`, `source: "src/models/moderation-case.ts"`.

The tension is worth stating plainly in the `note` / `deleteNote`, as the registry's docstring asks:
a member who purges their data under #906 keeps their case history, because a moderation record that
the subject can erase is not a moderation record. That is the same call already made for
`moderation-log`, so this is consistency rather than a new position — but it *is* a position, and the
registry is where it has to be argued.

If the `ModerationCaseCounter` model of §3.3 is added, it carries no user ids and needs no entry.

### 8.2 Config keys

All under the existing `moderation` category (already in `CONFIG_CATEGORIES`, so no cleanup-sweep
risk per #609/#834). Each needs the type-map entry, the `defaultConfig` default and the
`settingsMetadata` entry in `src/services/config-schema.ts`, plus a row in `SETTINGS.md` —
`__tests__/config/settings-doc-drift.test.ts` enforces both directions.

| Key | Default | Purpose |
| --- | --- | --- |
| `moderation.cases.enabled` | `false` | Feature gate for the whole lifecycle |
| `moderation.cases.review_cron` | `0 9 * * *` | When the due-review job runs |
| `moderation.cases.default_review_days` | `90` | Pre-filled review window when opening a case |
| `moderation.cases.auto_open_actions` | `""` | CSV of `kick`,`ban` to auto-open cases for; empty = manual only |
| `moderation.cases.readmit_unbans` | `false` | Whether "readmit" may perform the Discord unban |
| `moderation.cases.retention_days` | `0` | Days to keep resolved cases, from resolution; `0` = forever |
| `moderation.cases.history_grace_days` | `365` | How long a case protects its member's log history from pruning |
| `core.moderation_review.enabled` | `false` | Post the due-review notice to a channel |
| `core.moderation_review.channel_id` | `""` | Which channel |

Multi-setting feature, so add the key list to `WIZARD_FEATURE_SETTINGS` and a position to
`WIZARD_FEATURE_ORDER` in `src/web/routes/write/helpers.ts`; the wizard step/review/apply routes then
render them with no per-feature code.

### 8.3 Docs

- `SETTINGS.md` — the new keys, **and a correction**: the Moderation notes currently assert "The log
  is an append-only history, not a case-management system: there are no appeals, expiring warnings,
  or auto-moderation thresholds." The log stays append-only; the second half needs rewriting.
- `src/models/moderation-log.ts` — same correction to the docstring, which #908 already flags. The
  honest replacement says the log is still append-only and points at `moderation-case.ts` for
  lifecycle state.
- `WEBUI.md` — the Cases section of the moderation page.
- `COMMANDS.md` — the `/modlog` case line.

### 8.4 Migration

No backfill and no `MigrationService` step. Existing log rows are untouched; cases exist only from
the moment staff open one. `moderation.cases.enabled` defaults to `false`, so an upgrade changes
nothing until an operator opts in — the same posture as `moderation.enabled` itself.

## 9. Phasing

**Phase 1 (the whole use case in #908):** `ModerationCase` model + counter, the four outcomes with
conditional updates, the Cases section and write routes, the due-review cron and notice, the three
retention rules, registry entries, config keys, docs. No auto-open, no bot-performed unban, no
automatic `expired`.

**Phase 2, only if asked for:** `moderation.cases.auto_open_actions`; `readmit_unbans`; a retention
rule that produces `expired`; a member-facing "you may reapply on <date>" DM (which would need its
own consent decision against the opt-in-only DM posture noted in `SETTINGS.md`).

## 10. Test plan

Mirroring `__tests__/`; stub Mongo with `stubMongoGuard` from `__tests__/test-utils.ts`.

- `__tests__/models/moderation-case.test.ts` — enums, defaults, the unique index.
- `__tests__/services/moderation-case-service.test.ts` — every legal transition; every illegal one
  rejected (terminal statuses especially); the conditional-update race where two resolves hit the
  same case and exactly one wins.
- `__tests__/services/moderation-case-review-service.test.ts` — disabled gate (both keys), due
  selection at the boundary, notice fires once and not again on the next tick, a throwing notice
  does not fail the run.
- `__tests__/services/moderation-log-cleanup.test.ts` — extend with: an open case's origin entry
  survives the cutoff; a protected member's unrelated history survives; a case resolved beyond the
  grace window prunes normally; `retention_days: 0` still no-ops.
- `__tests__/commands/modlog.test.ts` — case line for each terminal and non-terminal status; a full
  page of maximal reasons *plus* case lines stays inside the embed limit.
- `__tests__/web/` — route auth and CSRF, `recordAudit` called with the case id, an illegal
  transition returns a flash error rather than a 500.
- Drift gates: `settings-doc-drift` and `user-data-registry-drift` both green.

## 11. Open questions for review

1. **Is this wanted at all after #907?** §2's recommendation is to find out first.
2. **Case reference:** sequential counter (§3.3) or ObjectId suffix?
3. **`history_grace_days` default 365** — should protecting a member's whole history for a year after
   a readmission instead be unbounded (`0` = forever), given moderation history plausibly wants to
   outlive routine activity data, as `ModerationLogCleanupService` already argues for
   `retention_days: 0`?
4. **Warnings as case origins.** This design restricts cases to `kick` / `ban`, matching the issue's
   "temporary removal" use case. Should a `timeout` be able to carry a review date too?
5. **`core.moderation_review.*` vs a `moderation.cases.*` channel key.** The `core.*` pair follows
   the documented convention and needs no logger code, but it does put a moderation channel id in
   the `core` category. Convention was preferred here; worth a second opinion.
