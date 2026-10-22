# Moderation labels

The words moderation shows people, reviewed once for plain English (#1353). Many moderators and members read English as a second language, so a word
that is correct but uncommon (*uphold*, *readmit*, *unban*) is replaced by a plain one where that loses no meaning. The same decision uses the same
word on the admin Moderation page, on `/me/moderation`, and in Discord (`/modlog`, the moderation notice, the review notice).

The words live in one module, `src/utils/moderation-labels.ts`, and every page and message imports from it. `__tests__/web/moderation-labels.test.ts`
renders the real pages and messages and fails when a retired word shows up on one of them again.

**Display words only.** Stored values (`readmit`, `readmitted`, `under_review`, `upheld`, `unban`, `untimeout`, `raid_clear`), enum keys, route paths
(`/cases/:id/uphold`, `/readmit`) and audit actions (`moderation.case.<decision>`) are unchanged, so existing data and queries keep working. Discord
command names and option names (`/warn`, `/timeout`, `/ban`, `/modlog`, `reason`, `duration`) are registered API surface and are not touched either.

## Decisions on a case

The Review form has four buttons. The stored decision name is in the last column.

| Was | Now | Why | Stored decision |
| --- | --- | --- | --- |
| Uphold | Keep out for now | Says what happens: the member stays out and the next review is set | `uphold` |
| Extend | Decide later | Nothing is decided; the case only gets a new review date | `extend` |
| Make permanent | Keep out for good | Pairs with *Keep out for now* and *Let back in* | `permanent` |
| Let back in | Let back in | Already plain (#1350) | `readmit` |

The confirmation dialogs follow the buttons. *Keep out for good*: "Keep this member out for good? The case closes with no further review." with the
consequences "The case closes as "kept out for good" and its review date is cleared." and "It is not reviewed again." *Let back in*: "Let this member
back in? KoolBot does not lift the ban in Discord; do that there."

After a decision the flash reads `Case #14 kept out for now.`, `Case #14 put off to the new review date.`,
`Case #14 kept out for good. It is not reviewed again.` or `Case #14 closed: the member was let back in.`

## Case states and the history of decisions

A case has a state and, for each decision, an entry in its history. `upheld` is both a state (set by *Keep out for good*) and a recorded outcome (set
by *Keep out for now*), so the two have different words on purpose.

| Stored | Was | Now |
| --- | --- | --- |
| state `open` | open | open |
| state `under_review` | under review | needs a decision |
| state `upheld` | upheld (Web UI), made permanent (Discord) | kept out for good |
| state `lifted` | let back in | let back in |
| state `expired` | expired | expired |
| outcome `upheld` | upheld (raw) | kept out for now |
| outcome `extended` | extended (raw) | put off to a later date |
| outcome `permanent` | permanent (raw) | kept out for good |
| outcome `readmitted` | let back in | let back in |
| history entry without outcome, state `under_review` | came due | marked as needing a decision |

*Under review* suggests someone is looking at the case. The state really means the review date has passed and a person has to decide, so it says that.
The same wording replaces every *due* and *overdue*.

## Where a case waits

| Was | Now |
| --- | --- |
| Overdue | Needs a decision |
| Due soon | Review in the next 7 days |
| Scheduled | Review later |
| No review date | No review date |
| Recently resolved | Closed in the last 30 days |
| "N due for review" (tile), "None due for review" | "N need a decision" ("1 needs a decision"), "None need a decision" |
| Due (badge on a review date) | Needs a decision |
| Run review pass now | Check review dates now |
| "Move every case whose review date has passed into review now?" | "Mark every case whose review date has passed as needing a decision now?" |
| "Review pass done: N cases moved into review." | "Check done: N cases now need a decision." |
| Discord notice "N moderation cases due for review" | "N moderation cases need a decision" |
| Discord case line "under review, due <date>" | "needs a decision, review date <date>" |
| Discord case line "made permanent" | "kept out for good" |

## Actions in the log

| Stored | Was (Web UI) | Was (Discord) | Now (both) |
| --- | --- | --- | --- |
| `warn` | warn | Warn | warn |
| `kick` | kick | Kick | kick |
| `ban` | ban | Ban | ban |
| `unban` | unban | Unban | ban lifted |
| `timeout` | timeout | Timeout | timeout |
| `untimeout` | untimeout | Timeout lifted | timeout lifted |
| `quarantine` | quarantine | Quarantine | quarantine |
| `raid_lockdown` | raid lockdown | Raid lockdown on | raid lockdown started |
| `raid_clear` | raid cleared | Raid lockdown off | raid lockdown lifted |

Discord shows the word with a capital letter and an emoji in front (`🕊️ Ban lifted`); the Web UI shows it lower case in a badge, as before.

## Other words

| Was | Now |
| --- | --- |
| Prior history (case card, embed field), "No other history on file", "No prior entries" | Earlier actions, "No earlier actions on file", "No earlier entries" |
| "Escalation stays a human decision." | "Staff always make the decision." |
| "native kick/ban/timeout actions mirrored from the guild audit log" | "kicks, bans and timeouts made in Discord itself, copied in from the server's audit log" |
| "Native actions require the bot to have View Audit Log" | "Actions made in Discord itself need the bot to have View Audit Log" |
| Service refusal "Case #14 is already lifted." | "Case #14 is already closed: let back in." |
| Service refusal "Case #14 was already under review." | `Case #14 changed while you were looking: it is now "needs a decision". Reload the page to see the latest.` |
| Service refusal "Extending a case needs a new review date." | "Deciding later needs a new review date." |

## Kept on purpose

| Word | Why |
| --- | --- |
| warn, kick, ban, timeout | Discord's own names for these actions (DESIGN.md: Discord's own names verbatim). Members already know them from Discord. |
| quarantine | The raid feature isolates a member behind a role; no shorter word means the same. It is rare and always explained next to its setting. |
| Review, Open case, Case #14 | Plain, and short enough for a button. |
| expired | Plain. |
| Moderator, Member, Reason, Source | Plain. |
| Server Members intent, View Audit Log | Discord's own names. |
