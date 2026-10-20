# Pages

The redesigned screens, grouped by the scope that sees them. Each describes what the page shows first and why; the components are in
[components.md](components.md), the patterns in [patterns.md](patterns.md).

## Admin console

### DashboardPage

The Dashboard: state first, then what needs you, and every card links to the page where you act.

1. Four StatTiles: Version, Discord, Database, Permissions.
2. Left column: *Needs you* (problems from Bot permissions and Server scan, each with a button to that page) and *This week in voice* (links to Voice
   analytics).
3. Right column: Features with their on/off status, each linking to its page, and the Server facts.

Read-only: no switches here. Cards are as tall as their content.

### EventsPage

The pattern for every feature page (#1301), shown on Events.

1. **Status line** under the title: the On badge and the key values as Mentions and chips. A missing required value, or a missing permission, is a
   warn chip that links to where it is fixed.
2. **The usable part**, with its main actions in the header: *Start now* and *Schedule event*. Then *Live now*, *Upcoming* (no id column, no empty
   columns, Edit and Cancel per row) and *Past events (n)* folded.
3. **Settings (n)**, folded at the bottom. The summary says how many differ from the default. It opens by default when the feature is off or a
   required value is missing, stays open after a save (with the flash), and remembers its state per page.

`renderFeatureSettingsCard()` is shared by 14 pages, so this order lands everywhere at once.

### BotPermissionsPage

Bot permissions (#1306): what to do comes first, then every permission in one matrix.

1. **How to fix**, only when something is missing: a numbered, deduplicated list of steps and *Re-authorise KoolBot*, which opens Discord's bot-invite
   page with every permission the switched-on features need. Whether Discord applies the new bits to the existing role still needs checking; if it
   does not, the steps stay and the button goes.
2. **Permissions**: one row per Discord permission, in Discord's order and words, sorted Missing → Not checked → Has. Status is an icon and a word
   (`kb-perm--missing | --unknown | --has`), and missing rows are tinted `err-bg`. *Where* uses Mentions; *Needed by* lists feature chips. *Role
   position* is a row of its own.
3. **Not needed (n)**, folded: permissions only switched-off features would use, with those features as dashed chips.
4. A *Show all Discord permissions* switch lists every flag, the unused ones marked "Not used by KoolBot".

When nothing is missing, step 1 becomes one green callout: "All permissions your switched-on features need are in place."

### ServerScanPage

Server scan, Overview tab. The read-only inventory of `adopt-view.ts`, reordered so the verdict and what to do next come first.

1. Verdict Callout (ready, or not ready with the blocker count).
2. Tiles: Readiness, Roles, Channels, Other bots; each opens its tab. Permission detail lives on Bot permissions, so the scan links there instead of
   repeating the table.
3. Left: Warnings as IssueRows, Notes folded; Suggestions, each with a button to the page that acts on it.
4. Right: Other bots, one card per bot with a coverage bar and the replacement table folded; Discord native facts.

The full role, channel and bot tables live in their tabs. The ownership-hints switch in the header replaces the `?sample=1` link.

### ServerScanChannelsPage

Server scan, Channels tab. The channels as Discord shows them, categories with their channels under them. Each row shows what uses the channel (green
chips), what it looks like it could be (*looks like Quotes* plus *Claim*, which opens Channel claims with the channel filled in), Discord's own flags,
and *Custom permissions* when it is not synced to its category. Filters on top narrow it to what is used, what could be claimed, or what has custom
permissions. A row's overwrites open on demand.

### WizardAccessPage

The Setup wizard's Access step: who can do what, before any channel is set up.

- Steps: Features → **Access** → Channels → Review.
- One AccessCard per scope: Admins (`/config`), Moderators, Event hosts and Members (all `/me`). Each maps Discord roles through a Picker, or offers
  to create the role (*Create @Event host*), and writes a role group with the matching capability.
- A callout warns when a switched-on feature has nobody to run it ("Events is on and nobody can host yet").

## Event host

### HostEventsPage

*Your events*: the home of the Event host scope, for people who host but are not admins or moderators.

- Header: why they can host ("You can host because you are in @Event hosts"), *Start now* and *New event*.
- *Live now* (or one line saying how Start now works), *Upcoming* with Edit and Cancel, *Past events* folded.
- Only events the person created; server-wide event settings stay with admins.

### NewEventPage

Creating an event, here as an event host. Admins get the same form from the Events page.

1. **When** first: *Now*, *In 15 min*, *In 30 min*, *In 1 hour*, *Pick date & time*. *Now* creates the channels at once and announces the event as
   happening now. Native date and time inputs; the timezone select puts the server's zone first.
2. **Details**: title, where to announce (Picker), duration (preset minutes).
3. **Groups**: one switch. When on, PresetCards first and a one-line summary; *Customise* holds the compact rows (marker, name, size, tag), *Generate*
   and *Add a group*. Group leaders and clan tags follow, with their options nested under them. Lead time sits in *Advanced*.
4. *Save setup as a preset* and *Create event*.

The groups block is one component, shared with the host panel and the preset editor (#1299).

### HostPanelPage

The host panel for a live event, as an event host who is neither admin nor moderator sees it (the Hosting section in the sidebar).

- Toolbar: Unlocked/Locked, then *Randomise…* and *Move people…* (each opens a Dialog with its options), then *Send to teams*.
- Board: a column per team plus *Not in a team*. People are dragged between columns, with a team menu per person as the no-JavaScript fallback; each
  shows where they are connected now.
- At the bottom, folded: *Event settings* (Group leaders and Clan tags, children nested) and *Change the groups* (add, remove, preset, switch off).
  Each summary states the current values.

## Moderator

### ModerationPage

*Mod log*: the home of the Moderator scope, for people who moderate but are not admins.

- Header: why they see it ("You see it because you are in @Moderator").
- Tiles: open cases (warn when any), actions in the last 7 days, timeouts running now.
- *Open cases* with *Review*, then *Actions* (filter by kind) with mentions for channels and a link to each case.
- Moderators read the log and review cases; moderation settings stay with admins. Tickets joins this section once the server switches it on.

## Member

### MemberOverviewPage

My preferences, Overview tab, for a member who also hosts (so the sidebar shows You and Hosting). Only what the server has switched on: a live event
the person hosts comes first, then one FeatureCard per preference with its current value, and the account ids as one line of fine print. A member with
no other scope sees the same page without a sidebar.
