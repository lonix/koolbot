# Components

Each component is plain HTML with `kb-` classes from [kb.css](kb.css); the server renders it, no client framework is needed. Values come from
[tokens.json](tokens.json). The rules that apply to all of them are in [DESIGN.md](../../DESIGN.md).

## Shell

### TopBar

The bar across the top of every signed-in page: the KoolBot name and version on the left; on the right, who you are and what you may do, then the
session and the way out.

**Markup.** `header.kb-topbar` → `a.kb-topbar__brand` (name and `span.kb-topbar__motto`), `span.kb-pill.kb-mono` with the version, and
`div.kb-topbar__end`, which starts with `span.kb-whoami` (avatar initial, `span.kb-whoami__name` with the display name, one ScopeBadge per scope above Member).

- Admin console: whoami, a ghost link to *My preferences*, the session timer, then *Finish* (small danger button: it ends the admin session).
- Everyone else: whoami, *Admin console* (only for admins who opened `/me`), the timer, then *Sign out*.
- When a newer release exists, an `a.kb-pill.kb-pill--info` follows the version pill.
- Under five minutes left, `is-low` turns the timer `warn`.
- The bar wraps at every width and grows in height (`min-height`, never a fixed `height`); the identity group shrinks (`min-width: 0`) and the name breaks
  anywhere and stops at `18rem`, so a long nickname with three badges never scrolls the page sideways.

### SideNav

One app for everyone; each scope adds its own sections, and admins get the console.

**Non-admins** (signed in with `/me`): `nav.kb-sidenav` holds one group per scope the person has, each headed by the scope's icon and name.

| Scope | Section | Pages |
| --- | --- | --- |
| Member | You | My preferences (its tabs: Overview, Notifications, Timezone, Voice) |
| Event host | Hosting | Your events, New event |
| Moderator | Moderation | Mod log, Command audit, and Tickets once it is on |

A person with only the Member scope has one section, so there is no sidebar at all: My preferences shows its tabs in one centred column.

**Admins** (signed in with `/config`) get the console, grouped by task (#1296):

| Group | Pages |
| --- | --- |
| (top) | Dashboard |
| Features | the switched-on features, A to Z; then *N turned off*, folded |
| Access | Command permissions, Role groups, Bot permissions |
| Server setup | Setup wizard, Server scan, Channel claims, Channel manager, Adoption history |
| Bot | Presence, Database, Environment, Command audit, Command metrics |
| (pinned) | All settings |

- Renamed to say what the page does: Permissions → **Command permissions**, Bot Status → **Presence**, Bootstrap → **Environment**, Adoption →
  **Adoption history**, Settings → **All settings**.
- Mark the current page with `aria-current="page"`; a page with problems gets a warn count badge.
- *N turned off* is a `details` element whose open state is remembered per browser (`localStorage`, in try/catch). It is open when the current page is inside it.
- Below 760px the nav sits above the content (reflow, #855).

### PageHeader

The top of a page's content: an optional breadcrumb, the title, one line of what the page is for, and the page's own actions on the right.

**Markup.** `header.kb-pagehead` → `div.kb-pagehead__text` (`p.kb-pagehead__crumbs`, `h1.kb-pagehead__title`, `p.kb-pagehead__sub` or
`p.kb-pagehead__meta`) and `div.kb-pagehead__actions`.

- One `h1` per page, in `page-title`. A state badge may follow the title inside the `h1` (an event's *Active*).
- Use `__sub` for a sentence; use `__meta` for facts (time, duration, channel), each a `span` with a leading icon.
- At most one primary button, and it goes last. A freshness note ("Read 12 s ago") sits left of a *Check again* button.

### Tabs

Underlined tabs for the member pages: Overview, Notifications, Timezone, Voice.

**Markup.** `nav.kb-tabs` with plain links; the current one has `aria-current="page"` (white label plus a `primary` underline, so the state is not
colour alone).

Members only see what they can use. A tab whose feature the server has switched off (Birthday, Rewind) is not rendered at all, and its route returns
404 (#1292). This replaces the greyed *Off* tabs of #709.

Also used inside a page for sibling views of one thing (Server scan: Overview, Roles, Channels, Other bots, Discord), each with a count badge. Inside
a panel, switch sections with a SegmentedControl instead.

## Access

### ScopeBadge

What a person may do here, shown as an icon and a word: **Member** (`user`), **Event host** (`calendar`), **Moderator** (`shield-half`), **Admin** (`user-cog`).

**Markup.** `span.kb-scope` → icon, label. In the TopBar they follow the name inside `span.kb-whoami`; Member is implied and not shown there.

- Scopes come from role groups: Admin from the `admin` capability (or Discord's Administrator, or the server owner), Moderator from `staff`, Event
  host from `host`. Member is anyone allowed `/me`.
- No scope colours: the status colours already mean something, and a scope is not a state.
- Use the same badge on Role groups, the wizard's Access step and anywhere the UI explains why someone sees a page ("You see it because you are in @Moderator").

### AccessCard

One scope explained in one card: how its people sign in, what they can and cannot do, and which Discord roles grant it. Used on the Setup wizard's
Access step and on Role groups.

**Markup.** `div.kb-access` (grid) → `article.kb-access__card` → `header.kb-access__head` (icon well, `h3.kb-access__title`, `p.kb-access__how`),
`ul.kb-access__can` (a check per thing they can do; `li.is-not` with a minus for what they cannot), and `div.kb-access__roles` (a Picker of roles, or
*Create @Event host* when none exists, plus an optional help line).

- Write *can* lines as plain verbs in the member's terms ("Run the host panel: teams, moves, clan tags").
- List *cannot* lines only where people would expect otherwise ("Change settings").

### Steps

Progress through the Setup wizard: done steps show a check, the current one is outlined in `primary` and marked `aria-current="step"`.

**Markup.** `ol.kb-steps-bar` → one `li` per step (`is-done` for finished ones). Steps are links back once done.

The wizard's steps: **Features** → **Access** → **Channels** → **Review**.

## Actions

### Button

Verb-first buttons in four kinds: primary for the one thing the view is for, neutral for everything else, ghost for low-stakes actions, danger for
what deletes or undoes.

**Markup.** `button.kb-btn` or `a.kb-btn`, plus `kb-btn--primary | --danger | --ghost`, and `--sm` for dense rows. An icon goes first (`svg.kb-icon`).
Icon-only buttons are `kb-btn--icon` and need an `aria-label`.

- One `--primary` per view (the save bar's *Save settings* counts as the view's).
- Labels say what happens, in sentence case: *Save settings*, *Remove 2 teams*, *Switch groups off*. Not *OK*, *Submit* or *Yes*.
- A danger button that removes things opens a Dialog first; the dialog's button repeats the label.
- `disabled` greys to 50%; say why next to it (help text), never only by the greyed button.

### Switch

An on/off control that saves as a checkbox. It replaces the "Off: … / On: …" selects of the old forms.

**Markup.** `label.kb-switch` → `input[type=checkbox][role=switch]`, `span.kb-switch__track`, optional `span.kb-switch__state` (prints *On* or *Off*,
so the state never rests on colour or position alone), then the label text. Without visible text, give the input an `aria-label`.

- On: `primary` track, white thumb. Off: `bg` track with a `control` edge (3.66:1 on surface), `muted` thumb.
- A switch that depends on another (Captains lobby needs Leaders) is `disabled`, with help text naming what to turn on.
- A switch changes only its form; the SaveBar saves it. The Dashboard has no switches: features are switched on their own page.

### SegmentedControl

Two to four mutually exclusive choices shown side by side. Replaces short radio lists ("Only people not in a team / Everyone connected") and
two-option selects ("Before the name / After the name").

**Markup.** `div.kb-segmented[role=radiogroup]` with an `aria-label` or `aria-labelledby`, holding `label > input[type=radio] + span` per option. The
checked option gets `fill`, a white label and a heavier weight.

- Keep labels short; show the result where you can (`[AMR] Alice`) in `kb-mono`.
- More than four options, or long labels: use a `kb-select`.
- Also used to switch sections inside one panel (Event settings: Leaders & tags · Teams · Presets).

## Forms

### Field

A labelled input, select or textarea, with optional help and error text.

**Markup.** `div.kb-field` → `label.kb-label[for]`, the control (`input.kb-input`, `select.kb-select`, `textarea.kb-textarea`), then `p.kb-help` or
`p.kb-field__error`. Lay several side by side in `div.kb-fields` (an auto-fitting grid).

- Control edges are `control` (3:1). Never use `border` for a control.
- A field the last save rejected gets `aria-invalid="true"` (red outline) and an error line linked by `aria-describedby`, saying what to change.
- `kb-textarea` is monospace: it holds templates and lists.
- Placeholders show an empty state ("no tag"), never the label.

### NumberField

Numbers that cannot be wrong (#1304): a stepper for small ranges, preset durations for minutes, and a bounded box for anything else.

**Markup.**

- **Stepper:** `span.kb-stepper` → minus button, `input[inputmode=numeric][pattern="[0-9]*"]`, plus button; the buttons disable at `min` and `max`.
  `kb-stepper--sm` in dense rows. A `span.kb-unit` follows.
- **Durations:** a SegmentedControl of common values (`5 · 10 · 15 · 30 · 60 · Custom…`) and the unit after it; *Custom…* reveals a bounded box.
- **Box:** `input.kb-input--sm` with `inputmode=numeric`, sized to its content.

Every number has a `min` and a `max`. The server validates again and rejects out-of-range values with a message ("At most 240 minutes."), never
clamping silently.

### SettingRow

The building block of every settings form: name and one line on the left, the control on the right, and the long explanation behind *More*.

**Markup.** `div.kb-settings` → `div.kb-setting` → a text `div` (`p.kb-setting__name`, `p.kb-setting__desc`), `div.kb-setting__control`, and an
optional `div.kb-setting__extra` (inline *More*, a help line, a missing-permission chip, or nested children). Group rows under a `kb-overline` in
`div.kb-settings__group`.

- **Changed from the default:** a small dot after the name (`kb-setting__changed`, with visually hidden "(changed)") and a reset icon button next to
  the control whose label names the default. No type badges: the control already says what it takes.
- **Children nest under their parent** in `div.kb-nested` (a left rule and an indent). A child is never shown disabled unless its parent sits right
  above it (#1299).
- **Missing permission next to the setting it breaks** (#1253): `a.kb-chip.kb-chip--warn` ("Bot lacks Manage Nicknames") linking to Bot permissions.
- **Bot-managed values** (message ids) are never inputs (#1304): show *Jump to message* and *Re-post* instead.
  The row shows the id as text with *Jump to message* and, once a message exists, a *Re-post* chip (`span.kb-mono` and `a.kb-chip`, or a "Not posted yet"
  line) and has no field. *Re-post* is only a link to the owning feature page (#1428): the action itself is a `renderRepostCard` card there (a
  confirm-gated POST form, red confirm, consequences listed, the shown id sent back as `expectedId`), never a button on All settings.
- **A setting with its own editor** (`editedElsewhere`, the leaderboard tiers) is not listed on All settings (#1428).
- Controls follow #1304: Switch, SegmentedControl, NumberField, Picker or EmojiPicker. A free-text box is only for free text (names, messages, descriptions).

### EmojiPicker

The marker for an event group: a small button showing the current emoji that opens a grid (#1299).

**Markup.** `button.kb-emoji-btn` (the emoji, or a plus when empty; `aria-label` says "Marker: 🔵") and `div.kb-emoji-pop` → search,
`p.kb-picker__group`, `div.kb-emoji-grid` of buttons (`aria-pressed` on the current one), and a *No marker* button.

- The curated first page is the coloured circles and squares, then common team icons. *Generate* uses the same colour order.
- Unicode only: Discord custom emoji cannot go in a channel name, so they are never offered, and neither is any emoji over the 4-code-point limit.
- No JavaScript: the text input it replaces.

### PresetCards

Group setups as cards, so the fast path comes first (#1299, #1300).

**Markup.** `div.kb-choices[role=radiogroup]` → `label.kb-choice` → `input[type=radio]`, `span.kb-choice__title`, `span.kb-choice__meta` (where it
comes from and its shape), `span.kb-choice__marks` (the markers), and a check icon shown when chosen. *Custom* is the last card (`kb-choice--custom`).

- Order: built-in *2 teams / 3 teams / 4 teams*, then the server library, then the host's own presets, then Custom.
- The chosen card selects a border and a check icon, not only a colour.
- Under the cards, one summary line says what the preset will create, with *Customise* to open the rows.

## Discord

### Mention

A channel, category or role, labelled the way Discord labels it (#1303).

**Markup.** `span.kb-mention` with an inline icon whose `aria-label` names the kind, then the name. One helper renders every channel, category or role
name in the UI: options, tables, definition lists, sentences.

| Kind | Shown as |
| --- | --- |
| Text | `hash` icon + name |
| Announcement | `megaphone` icon + name |
| Voice | `volume-2` icon + name |
| Stage | `mic-vocal` icon + name |
| Forum | `messages-square` icon + name |
| Category | `folder` icon + NAME in uppercase (`kb-mention--category`), never a `#` |
| Role | `@Name`, no icon |
| Deleted or unknown id | `kb-mention--missing`: an alert icon and "(unavailable)" |

Inside a native `<option>`, where SVG cannot go, use the Unicode fallback from #1303 (`🔊 Lobby · VOICE`).

### Picker

A searchable list for choosing channels, categories and roles, modelled on Discord's composer autocomplete (#1303).

**Markup.** `div.kb-field` → `button.kb-picker__trigger` (the current value as Mentions, then a chevron) and, when open, `div.kb-picker__pop` →
`label.kb-picker__search`, `ul.kb-picker__list[role=listbox]` with `li.kb-picker__group` headers (*Text channels*, *Voice channels*, *Categories*,
*Role groups*, *Roles*) and `li.kb-picker__opt[role=option]` rows (icon, name, the category muted on the right, a check when selected), then
`p.kb-picker__hint`.

- Typing `#` filters to text channels, `#!` to voice, `@` to roles, as in Discord.
- A setting only lists the kinds it accepts: a voice setting opens on Voice channels.
- Multi-select (roles) shows each chosen role as a Mention in the trigger.
- No JavaScript: a native `select` with `optgroup`s and the category in the option text.

### DiscordEmbed

A sketch of how a KoolBot message reads in Discord, to design and review embeds with. It is drawn with this system's surfaces, not Discord's own interface.

**Markup.** `div.kb-embed` (+ `kb-embed--ok | --warn | --danger | --neutral | --lore`; brand is the default) → `div.kb-embed__body` →
`p.kb-embed__title`, `p.kb-embed__text`, `div.kb-embed__fields` of `div.kb-embed__field` (`p.kb-embed__name`, `p.kb-embed__value`),
`p.kb-embed__foot`.

The card pairs today's messages with the rewritten ones. The rules are in the *Messages in Discord* section of the brand book.

**Message line.** Where it matters who posted, when, and what sits outside the embed (an alert's role mention, an edited post), wrap the embed in
`article.kb-message` → `span.kb-avatar` (the bot's initial), `div.kb-message__body` → `p.kb-message__head` (the name, a `kb-badge--info` *App*
badge, `span.kb-message__time` with "(edited)" for a post the bot keeps up to date), an optional `p.kb-message__text` (the mention line, as
Mentions), then the `kb-embed`.

- A password members need is `span.kb-spoiler[role=img]` with an `aria-label` ("Password, hidden behind a spoiler"): a plain `span` cannot
  carry a name, and the sketch never prints the password.
- Review alerts with the message line: a role mention inside the embed would not notify anyone (*Alerts that mention a role* in `discord.md`).

### EmbedColours

The six embed accents and when to use each. They are tokens (`embed-brand`, `embed-ok`, `embed-warn`, `embed-danger`, `embed-neutral`, `embed-lore`)
in the same colour families as the Web UI, at mid-tones that show on both Discord themes. One helper in the code maps a message kind to its colour, so
no `setColor(0x…)` literal is left in commands or services.

## Status

### Badge

Short status words and counts: badges (uppercase), pills (versions, scopes), chips (things a row refers to) and status dots (a state in a sentence).

**Markup.**

- `span.kb-badge` + `--on | --off | --info | --warn`: *On*, *Off*, *Active*. Add `--count` for a number (rounded, not uppercase).
- `span.kb-pill`: neutral metadata (`v2.0.1`, *Server-wide*); `a.kb-pill--info` for "update available".
- `span.kb-chip`: a feature or permission a row mentions, with a leading icon; `--ok` puts a green check on it.
- `span.kb-status` + `--ok | --warn | --off`: a dot and a word (*Connected*).

Every state carries a word, never only a colour. Status colours always come in their pairs (`ok-bg` with `ok-text`, and so on).

### Callout

A message about the page or the last action, with an optional action on the right.

**Markup.** `div.kb-callout` (+ `--warn | --ok | --err`; plain is info) → `svg.kb-icon`, `div.kb-callout__body` (`p.kb-callout__title`, optional
`p.kb-callout__text`), optional `div.kb-callout__actions`. Use `role="status"` for results and `role="alert"` for failures.

- Title states the fact; text says the impact; the action fixes it (*Review*, *Enable*).
- Put a warning callout at the top of the page only when something needs a decision; never for "everything is fine".
- Results of a save (flash messages) use `--ok` or `--err` and say what changed: "Saved. 3 settings changed."
- The disabled-feature banner (#610) is a plain callout with *Enable* (primary, small) and a *Settings* link.

### IssueRow

One problem per row, read left to right: what is wrong, what it breaks, how to fix it. Built for Bot Permissions; use it for any health check.

**Markup.** Inside a Panel, `article.kb-issue` → `div.kb-issue__icon` (warn by default, `--err` for blocking), a body `div` (`div.kb-issue__head` with
`h3.kb-issue__title` and a scope pill, `p.kb-issue__impact`, `div.kb-issue__affects` with chips), and `div.kb-issue__fix` (overline *How to fix* and
the steps).

- Title is the missing thing (the permission's Discord name). Impact is one sentence in the member's terms.
- Scope pill: *Server-wide* or the channel name.
- Below 760px the fix box moves under the text.

### EmptyState

What a list or area shows when there is nothing in it yet: an icon, one line of what is missing, one line of how it fills up, and an action when there is one.

**Markup.** `div.kb-empty` → `div.kb-empty__icon`, `p.kb-empty__title`, `p.kb-empty__text`, optional `.kb-btn`.

Say how the area fills up ("People show up here as they join"), not only that it is empty. Small areas (a team with nobody) use one italic muted line
instead: `p.kb-team__empty`.

## Containers

### Panel

The container for one topic on a page: a header with title, a meta note and actions; a body; an optional footer note.

**Markup.** `section.kb-panel` → `header.kb-panel__head` (`h2.kb-panel__title`, `span.kb-panel__meta`, `div.kb-panel__actions`), `div.kb-panel__body`
(add `--flush` for a table or list that runs edge to edge), `footer.kb-panel__foot`.

- One topic per panel. If a panel needs sub-headings, split it or use SettingRow groups.
- Put the panel's status in the head (a badge after the title), not as the first line of the body.
- Fine print (where data comes from, what is not sent) goes in the footer, in muted.
- A panel nested in a panel, and team cards inside one, drop to `bg`.
- `kb-panel--danger` edges the panel in `err-bg` for steps that delete things.

### StatTile

A single number or state, with a label and one line of detail. Tiles sit in a `kb-tiles` row at the top of a page so the state is readable before any list.

**Markup.** `a.kb-tile` (or `div` when it links nowhere) → `div.kb-tile__top` (overline label, then a badge, status or icon pushed right),
`div.kb-tile__value` (`stat` style; `small` for the unit), `div.kb-tile__detail`.

- Three or four tiles per row; each opens the page with the detail.
- `kb-tile--warn` when the tile is a problem: the value turns `warn-text` and an alert icon sits top-right.
- Values are facts, not decoration: no tile without a destination or a reason to look.

### FeatureCard

A feature or preference as a card: icon, name, one-line description, and its current value, so nobody has to open it to know how it is set.

**Markup.** `div.kb-features` (grid) → `div.kb-feature` → `div.kb-feature__icon`, `div.kb-feature__body` (`a.kb-feature__name` makes the whole card
the link, `p.kb-feature__desc`, `p.kb-feature__value`), `div.kb-feature__aside` (a chevron, or a Switch that stays clickable above the card link).

- Member pages show only features the server has on, so a member never sees `is-off`.
- `is-off` (dashed edge, grey icon, *Off* badge) is for admin views that list every feature, such as the Setup wizard.
- The Dashboard links to feature pages and never switches a feature; the switch lives on the feature's own page.

### TeamCard

One group of an event: name, tag, how full it is, who is in it, and its channel. The host panel lays the same data out as board columns (`kb-board`);
the card is for places that show teams side by side without moving people, such as an event summary.

**Markup.** `div.kb-teams` (grid) → `article.kb-team` → `header.kb-team__head` (`span.kb-team__tag` in mono, `h3.kb-team__name`, `span.kb-team__count`
with `small` for the size limit), an optional `div.kb-meter` when the team has a size, `ul.kb-people` of `li.kb-person` (avatar initial, name, a crown
icon for the leader) or `p.kb-team__empty`, and `div.kb-team__meta`.

- Teams are told apart by name and tag, never by colour.
- The meter needs an `aria-label` ("3 of 5 places taken").

## Data

### DataTable

Rows of like records that people compare or scan: command audit, moderation cases, metrics.

**Markup.** `table.kb-table` inside `div.kb-panel__body--flush`; `thead th[scope=col]` (overline style on `surface-alt`), `tbody th[scope=row]` for
the row's name. Numbers get `td.kb-num` (right-aligned, tabular). Row actions go in a last `td.kb-actions`.

- Use a table only when columns are compared. A list of things with a status is a `kb-list` or cards.
- Status cells use badges; ids and commands use `kb-mono`.
- Wide tables scroll inside their panel, never the page (#855).

### KeyValue

Facts about one thing: a definition list for labelled facts, a number grid for counts.

**Markup.** `dl.kb-kv` (`dt` muted, `dd` text; two columns, stacking below 760px). For counts, `dl.kb-numbers` with `div > dt + dd` per count: the
number reads first, large.

Keep ids in `kb-mono` after the human name ("Koolbot Dev `1361…`"), not instead of it.

### Heatmap

When people are active: a weekday-by-hour grid and a bar list. The only place the lore colours appear.

**Markup.** `div.kb-heatmap[role=img][aria-label]` (the label names the peak) → a corner `span`, 24 `span.kb-heatmap__col` hour labels, then per
weekday a `span.kb-heatmap__row` and 24 `span.kb-heatmap__cell[data-l=0..4]`; the peak cell adds `is-peak`. Bars: `div.kb-bars` → `div.kb-bars__row`
(`is-peak` on the top one) with label, `span.kb-bars__track > span.kb-bars__fill[style=width:N%]`, and `span.kb-bars__val`.

- Intensity is `lore-fill` at four opacities; the peak is `lore-peak` and is named in text beside the chart.
- Always pair the grid with the bar list or a table: the grid alone is not readable as numbers.

### UptimeStrip

Whether something was up, hour by hour, for the last 24 hours: game servers on their list and edit pages (#1376). A status, not activity, so it
uses the status colours, never the lore colours.

**Markup.** `div.kb-uptime` → `div.kb-uptime__bar[role=img][aria-label]` with 24 `span` cells, oldest first, then the figure in text
(`98.6 % up, last 24 h`). A cell is up by default; `is-part` when some checks failed or maintenance ran that hour, `is-down` when every check
failed, `is-none` before the first check. `kb-uptime--lg` draws a taller bar for a page about one thing.

- Up is `ok-text`, part is `warn-text`, down is `err-text`, no data is `heat-empty`.
- The figure is always next to the bar, and the `aria-label` names each outage ("Down 20 minutes, 03:12 to 03:32 UTC"): never colour alone.
- Maintenance does not count as down in the figure; the help line under a large strip says so.

## Disclosure and overlays

### Disclosure

Detail on demand, built on `details`/`summary`, in three sizes: a whole panel section, a row, and an inline *More* or *Why?* link.

**Markup.** `details.kb-disclosure` → `summary` (a `kb-chev` chevron icon, the label, optional count badge, optional `span.kb-disclosure__hint`
summarising what is inside) and `div.kb-disclosure__body`. Inline: `details.kb-disclosure--inline` with a short link-coloured summary.

- Fold what does not need a decision, keep the rest open: Bot permissions keeps every needed permission in its matrix and folds only *Not needed (3)*;
  Server scan folds *Notes*.
- The summary must say what is inside, so people can skip it.
- Never hide something a person must read before acting; that belongs in the Dialog for that action.

**Settings fold (#1301).** A feature page's settings are one `details.kb-disclosure#feature-settings[data-settings-fold]` at the bottom of the page. Its
summary reads *Settings*, a count badge and a `kb-disclosure__hint` ("2 changed from the default"). It is `open` (and carries `data-fold-forced`) when the
feature is off, a required value is missing, or a save or reset has just happened; otherwise it is folded, and a script remembers per page whether the
admin left it open (`localStorage` in try/catch; only a click on the summary counts as a choice). Above it, the page's status line is a
`div.kb-statusline` of an On/Off badge and `kb-chip`s; a chip for something missing is `a.kb-chip.kb-chip--warn` with an icon, linking to the setting.

### Dialog

The larger context for an action: its options and consequences, shown at the moment it is taken.

**Markup.** `dialog.kb-dialog` opened with `showModal()` → `div.kb-dialog__head` (an icon well and `h2.kb-dialog__title`), `div.kb-dialog__body`,
`div.kb-dialog__foot` (*Cancel* ghost, then the action). The backdrop is `scrim`.
The footer wraps and stacks on a narrow screen, and its buttons may wrap a long label, so *Go back* stays reachable (scoped to the dialog; `.kb-btn` is unchanged).

- **Confirm** (Switch groups off): the title is the question, the body lists every consequence, the button repeats the verb in `danger`.
- **Options** (Randomise teams): a SegmentedControl or a few fields, one sentence on how it works, and a primary button that names the result ("Deal 2 people").
- Replaces the separate confirm pages; without JavaScript the buttons still post to the existing routes.
- Focus starts on the go-back button; Escape closes and focus returns to the control that opened it. `aria-labelledby` points at the title.

**Wiring (`data-confirm`).** Every destructive form or button carries `data-confirm="Title?"`; `CONFIRM_SCRIPT` (`src/web/html.ts`, loaded by the admin
and member layouts) builds the dialog from it, so the title is the whole dialog unless a list is added.

- `data-confirm-list` is a JSON array of consequence strings (`confirmListAttr()` writes it). They are rendered with `textContent`, never as HTML.
  Give a list to the high-impact actions: reset defaults, rebuild and resync, reaction-role and group delete, event cancel, birthday remove and
  making a removal permanent. Other actions are title-only.
- The confirm button repeats the trigger's own label (or `data-confirm-verb`); the ghost button reads *Go back*, so it is never confused with a
  *Cancel* verb such as "Cancel event".
- `data-confirm-tone` is `danger` (the default, so a site that says nothing fails closed to red) or `neutral` (the `primary` fill and its
  `on-primary` label, a pair the #1326 contrast gate already covers). Red is for actions that delete, remove, cancel or reset; "Run now", "Apply plan",
  "Readmit" and "Archive" are neutral. `NEUTRAL_CONFIRM_ACTIONS` in `src/web/html.ts` is the one list of neutral actions; a site that carries a
  consequence list can never be neutral, and the drift test fails when a site's tone and that list disagree.
- Confirming submits the same form (`requestSubmit`), so the CSRF token, typed-name guards and other submit handlers are unchanged.
- Without `showModal()` it falls back to `window.confirm()`; without JavaScript the form posts at once, as before.
- A question built in script (the host panel's fetch-and-upgrade, `src/web/confirm-fetch.ts`, #1344) uses the same dialog through the
  `kb-confirm-request` event (title, items and verb as plain strings, and a `go` callback that runs only from the confirm button). It is for two-step
  routes whose consequences only the server knows: the form carries `data-confirm-fetch`, the script posts it with `fetch`, and the dialog lists the
  server's reasons and changes. The page stays as the no-JavaScript route.

### SaveBar

A bar that sticks to the bottom of a form once something has changed, with a count and the Save and Discard buttons.

**Markup.** `div.kb-savebar[role=region][aria-label="Unsaved changes"]` → a `kb-status--warn` dot, `span.kb-savebar__text` ("2 unsaved changes"),
*Discard* (ghost), *Save settings* (primary). Render it `hidden` and reveal it on the first `input` event.

- It is `position: sticky`, which resolves against the nearest scrolling ancestor, so no ancestor of the bar may be a scroll container
  (`overflow: auto`/`scroll`/`hidden`). On a page with a save bar, `renderAdminPage` puts `has-savebar` on `main` and the form's card is
  `card--savebar`; both use `overflow-x: clip`. Pages without a save bar keep a scrolling `main`. The rows' `.kb-settings` container is the
  bar's sibling and scrolls sideways; a wide table or `pre` on such a page goes in a card (which scrolls) or scrolls itself.
- It replaces the *Save settings* buttons scattered through long forms: one save per form.
- Without JavaScript, render it visible with "Save your changes" as the text.
