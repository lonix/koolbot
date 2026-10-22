# Page patterns

How to turn a page that lists everything into one that shows what is needed when it is needed. Each pattern names the components it uses; the Pages
group shows them applied.

## Overview pages (Dashboard, Server scan)

1. PageHeader with a freshness note and *Check again* when the data is read live.
2. StatTiles with the counts that answer "is it OK?". Each tile opens the page with the detail.
3. What needs a decision, as a short list with a button to the page that fixes it.
4. The rest as content-sized panels.
5. No switches or forms: an overview links to the page where you act.

## Health pages (Bot permissions)

1. *How to fix* first, only when something is wrong: numbered, deduplicated steps.
2. One table of everything, problems sorted to the top, each row with an icon and a word for its state.
3. What does not apply folded at the end.

## Feature pages (Events, Quotes, Polls, Reaction roles and the rest)

1. PageHeader with a status line (state badge, key values as Mentions, warn chips for anything missing) and the feature's main actions.
2. The usable part: the feature's own content, newest or most urgent first, history folded.
3. *Settings (n)* folded at the bottom, its summary saying how many differ from the default. It opens by default when the feature is off or a required
   value is missing, and stays open after a save.

Inside settings: SettingRows grouped under overlines; Switch, SegmentedControl, NumberField, Picker or EmojiPicker as the control (choose, don't type:
free text only for names, messages and descriptions); children nested under their parent; one SaveBar; destructive steps last, each with a Dialog.

## Grouping and ordering (people into teams, notices, presence messages, poll questions, role-group ranks)

- Drag is the main way: a board of columns for groups, a list with a drag handle for order.
- Every item also has a menu (*Move to…*) or *Move up* / *Move down* buttons, reachable by keyboard and with one click, so no task needs a drag (WCAG 2.5.7).
- Without JavaScript the same controls post a form.
- A move that changes something in Discord (moving people in voice) is a separate, explicit action, like *Send to teams*.

## Pages for a scope

- Every page a host or moderator reaches says why ("You can host because you are in @Event hosts").
- Hosts and moderators see only their own part: a host's events, the mod log. Server-wide settings stay in the admin console.
- A non-admin with one scope gets no sidebar; with more, one sidebar section per scope.

## Member pages

- Tabs for the preference areas; features the server has switched off are not shown at all.
- Live things first (an event you host now), then a FeatureCard per preference showing its current value.
- Account ids as one `help` line, not a panel.

## Host panel

- The board is the page: a toolbar (Locked/Unlocked, *Randomise…*, *Move people…*, *Send to teams*) over one column per team plus *Not in a team*.
- Options that need room open in a Dialog. Event settings and group changes are folded at the bottom.

## Setup wizard

Features → **Access** → Channels → Review. The Access step maps Discord roles to Admins, Moderators, Event hosts and Members with one AccessCard each,
and warns when a switched-on feature has nobody to run it.

## From the old classes

| Old (`admin-layout.ts`, `user-layout.ts`) | Now |
| --- | --- |
| `.banner`, `.pill`, `a.surface` | TopBar with whoami and ScopeBadges |
| `nav.side`, `.nav-group-heading`, `.nav-badge`, `.nav-disabled` | SideNav: scope sections, or the console grouped by task with *N turned off* folded |
| `h1` + `.subtitle` | PageHeader |
| `.page-nav` | Tabs (switched-off features not rendered) |
| `.card` | Panel |
| `.rw-stat`, `.rw-hero` | StatTile; `stat-hero` on a `lore-deep` panel |
| `.kv` | KeyValue (`kb-kv`, `kb-numbers`) |
| `table`, `th`, `td` | DataTable |
| `.tag-on`, `.tag-off`, `.tag-info`, `.tag-warn`, `.tag-diff-*` | Badge |
| `.notice.info/.ok/.warn/.err`, `.notice.feature-disabled` | Callout |
| `.btn`, `.btn-primary`, `.btn-secondary`, `.btn-danger`, `.btn-sm` | Button |
| `form.stack`, `.field-row`, `.help`, `renderFeatureSettingsCard()` | SettingRow inside a folded *Settings (n)* |
| Off/On `select` | Switch |
| radio lists, two-option `select` | SegmentedControl |
| number `input` with `min` only | NumberField |
| channel and role `select` with a `#` prefix | Picker and Mention |
| `.feature-card`, `.feature-list` | FeatureCard |
| `.helper` (`details`) | Disclosure |
| confirm pages | Dialog (the page stays as the no-JavaScript route) |
| `.empty` | EmptyState |
| `.heatgrid`, `.heat-bars`, `.rw-hours`, `.rw-days` | Heatmap |
| `.cascade-off`, `.dep-off` | children nested under their parent |
| `setColor(0x…)` literals | the `embed-*` tokens through one helper |
