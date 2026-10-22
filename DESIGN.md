# Design system

How KoolBot's Web UI and its messages in Discord look, read and are put together. New pages, components and embeds follow this document;
where existing code disagrees, this document wins and the gap is tracked in the v2.1 Web UI redesign epic (#1314).

| File | What it holds |
| --- | --- |
| [docs/design/tokens.json](docs/design/tokens.json) | Every colour, type style, spacing step, radius, shadow and layout size. The single source for values. |
| [docs/design/kb.css](docs/design/kb.css) | The `kb-` component stylesheet. Colours, spacing, radii, shadows and layout come from the tokens; font sizes come from the generated `--type-<style>-size` properties. |
| [docs/design/components.md](docs/design/components.md) | One section per component: what it is for, its markup, its rules. |
| [docs/design/pages.md](docs/design/pages.md) | The redesigned pages, per scope, and what each shows first. |
| [docs/design/patterns.md](docs/design/patterns.md) | Page patterns, and which component replaces each old class. |
| [docs/design/discord.md](docs/design/discord.md) | Embeds, replies, buttons and direct messages in Discord. |
| [docs/design/labels.md](docs/design/labels.md) | The reviewed moderation words (old to new), shared by the Web UI and Discord. |

KoolBot is a self-hosted Discord bot: **K**eeper **O**f **O**ur **L**ore. Each community runs its own instance and owns its data. The Web UI is where
admins configure the bot, where event hosts run their events, where moderators read the log, and where members manage their own preferences. This
system is the redesign of that UI and of the bot's messages in Discord: the same dark palette, with pages that lead with state and keep detail one
click away.

Load `tokens.css` (generated from `docs/design/tokens.json` by `src/web/design-assets.ts`), then `docs/design/kb.css`, and build pages from the `kb-` classes.
The Web UI serves both from `/admin/_assets/` and `/me/_assets/` and links them from every layout. Components are plain
HTML and CSS, rendered by the server; there is no client framework.

## Principles

1. **State before detail.** Every page opens with what is true now: a few stat tiles or status dots. Lists, tables and settings come after.
2. **Problems first, the rest folded.** What needs a decision is open and at the top (a warning Callout, *Needs fixing*). What is fine or finished is
   counted and folded in a Disclosure (*Not needed 3*, *Past events 12*).
3. **Show the value, not just the setting.** A preference card says how it is set ("Europe/Oslo · 10:59 now"); a feature row says *On* or *Off*.
   Nobody should open a page to learn its state.
4. **Explain at the moment it matters.** One line of description per setting. The long "what happens if" text goes behind *More*, and the consequences
   of a destructive step go in its Dialog, not in a paragraph that sits on the page forever.
5. **Content first, settings last.** A feature page opens with what the feature holds (quotes, events, tickets). Its settings sit at the bottom in one
   Disclosure, folded, with a summary line of the current values.
6. **Choose, don't type.** When the valid values are known, offer them: a switch, a segmented control, a bounded number, a picker for channels, roles
   and timezones, an emoji picker. A free-text box is only for text that is genuinely free (names, messages, descriptions). Ids the bot manages are
   shown, never typed.
7. **Move things directly.** When the task is putting things into groups or into an order (people into teams; notices, presence messages, poll
   questions, role-group ranks), let people drag them. Every drag has a keyboard and single-click alternative, a menu or *Move up* / *Move down* (WCAG
   2.5.7), and the same form works without JavaScript. Settings are never dragged.
8. **Act where it lives.** Overview pages (Dashboard, Server scan) link to the page that acts; they do not carry switches or forms of their own.
9. **People see only what they can use.** Each scope adds its own section, and nothing else shows. On `/me`, a feature the server has switched off is
   not shown at all: no tab, no card. A page says why someone sees it ("You can host because you are in @Event hosts").
10. **One job, one primary button.** Each view has at most one `primary` button. Long forms get one SaveBar instead of a Save button per section.
11. **Never colour alone.** Every state has a word (*On*, *Off*, *Active*, *1 issue*) and usually an icon or dot. Teams are told apart by name and tag.

## Content

The UI copy is already plain and precise; keep it that way.

- **Say what happens, in the member's terms.** "Clan tags are not applied to nicknames and old tags are not restored." "Nothing here changes anything
  in Discord."
- **Sentence case** for titles, buttons and labels: *Bot permissions*, *Save settings*, *Lock groups*.
- **Verb-first buttons** that name the result: *Randomise*, *Send to teams*, *Switch groups off*, *Remove 2 teams*. Never *OK* or *Submit*.
- **British spelling**, as the UI already uses: *Randomise*, *Customise*.
- **You** is the person reading; the bot is *the bot* or *KoolBot*. "Give the bot's role Manage Nicknames."
- **Numbers as numerals** with their unit: "120 minutes", "9 of 10 in place", "Read from Discord 12 s ago".
- **Times** carry their zone: "2026-10-20 08:59 UTC" for admin facts, the member's own timezone on member pages ("Today 12:15 (Europe/Oslo)").
- **Discord's own names verbatim**: permission names (*Manage Nicknames*), channel names including their emoji (📅 Testing). Emoji appear only when
  they are Discord content, never as UI decoration.
- **Ids and keys in mono**, after the human name: Koolbot Dev `1361410364620804136`, `voicechannels.enabled`.

## Colour

The palette is the shipped one, now defined once in `tokens.json` and shared by the admin and member pages. Dark only.

- **Surfaces, darkest to lightest:** `bg` (page, inputs, wells, cards nested in a panel) → `surface` (panels, tiles, cards, side nav, dialogs) →
  `surface-alt` (table header, row hover) → `chrome` (top bar, nav hover, save bar) → `selected` (current nav item, info callouts, icon wells) →
  `fill` (neutral buttons, pills, the selected segment).
- **Text:** `text` for content, `text-secondary` for labels and nav, `muted` for descriptions and metadata. `muted` is only 4.0:1 on `fill`: never put it there.
- **Edges:** `border` for decorative hairlines only. Anything you click or type into is edged in `control` (3:1 or better on `bg`, `surface` and `chrome`).
- **Action:** `primary` with `on-primary` for the one main button, switch tracks when on, and the current tab's underline. `danger` with `on-primary`
  for destructive buttons. `link` for inline links.
- **Status pairs, always together:** `ok-bg`/`ok-text` (On, success), `err-bg`/`err-text` (Off, errors), `info-bg`/`info-text` (Active, update
  available), `warn-bg`/`warn-text` (needs attention). The `*-text` colours alone make status dots on any surface. `warn` is warning text on a
  surface.
- **Lore colours** (`lore-deep`, `lore`, `lore-fill`, `lore-peak`, `lore-text`) are for activity data only: heatmaps, bar lists and Rewind. Not for
  buttons, links or decoration. Rewind's hero is a solid `lore-deep` panel, not the old indigo gradient.
- **Focus:** a solid 2px `focus` ring, offset 2px, on every interactive element (8:1 or better on every surface).

## Type

The system font stack (`--font-sans`) for everything and `--font-mono` for ids, keys, versions and the session timer. No web fonts: a self-hosted bot
should not send its admins' browsers to a font CDN, and the native face is the fastest.

- `page-title` once per page; `panel-title` for panel, card and issue titles; `section-title` for dialog titles.
- `stat` for tile values and `stat-hero` for the one headline number on a page (Rewind). Both use tabular figures.
- `ui` (0.9rem) is the base size inside the app: nav, tables, setting names, inputs. `body` (1rem) is for running text.
- `description` and `help` for the line under a setting or field, always in `muted`.
- `overline` (uppercase, tracked) for nav group headings, tile labels and table headers; `badge` for status badges.

## Space, shape and depth

- Spacing steps `space-1` to `space-8` (0.25rem to 2rem). Panels pad `space-4` by `space-5`; tiles and cards sit `space-3` apart; panels stack `space-4` apart.
- Radii: `radius-xs` heat cells, `radius-sm` badges, `radius-md` buttons, inputs, nav items and callouts, `radius-lg` panels, tiles, cards and
  dialogs, `radius-pill` pills, chips, switch tracks and avatars.
- Borders separate; there are no card shadows. `shadow-pop` lifts only what floats: the Dialog and the SaveBar.
- Motion is 150 ms on colour and transform (switch thumb, chevrons), and off under `prefers-reduced-motion`.

## Layout

- **Admin:** TopBar (`topbar-height`), SideNav (`sidebar-width`), and a main column up to `content-max`. Page order: PageHeader → Callout (only if
  needed) → tiles → content panels → settings, folded. Two-column rows use `kb-cols` (wide left, narrow right); cards are as tall as their content.
- **Scopes:** four, each granted by a role group capability and shown as a ScopeBadge next to the person's name in the TopBar.

  | Scope | Granted by | Signs in with | Sees |
  | --- | --- | --- | --- |
  | Member | being allowed `/me` (Command permissions) | `/me` | You: My preferences |
  | Event host | the `host` capability | `/me` | + Hosting: Your events, New event, the host panel of their own events |
  | Moderator | the `staff` capability | `/me` | + Moderation: Mod log, Command audit (built), Tickets once it has a page and is on |
  | Admin | the `admin` capability, Administrator, or server owner | `/config` | the admin console |

- **Navigation:** non-admins get one section per scope in the sidebar, and no sidebar at all when they only have one. The admin console is grouped by
  task: Dashboard, Features (switched-on, A to Z, the rest folded under *N turned off*), Access, Server setup, Bot, and All settings pinned at the bottom.
  [SideNav](docs/design/components.md#sidenav) has the full lists and the renames.
- **Setup wizard:** Features → Access → Channels → Review. The Access step maps Discord roles to the four scopes before anything else is set up.
- **Member pages** (My preferences, host panel): TopBar, then one centred column up to `member-content-max`, with Tabs under the bar.
- **As built (#1317):** the TopBar and the non-admin SideNav are rendered by `src/web/app-shell.ts` (the nav registry is `SHELL_NAV`), a section shows
  once it has a page that exists, and the sidebar once two sections do. The admin console's sidebar is the same
  `kb-sidenav`, grouped by task in `NAV_ITEMS` (`src/web/admin-layout.ts`, #1296).
- **Reflow:** below 760px the nav sits above the content, columns stack and setting controls drop under their names (#855).

## Iconography

Interface and page icons are Lucide icons (ISC licence), copied into the repo and inlined as SVG, never loaded from a CDN. 24×24 viewBox, 2px stroke,
round caps and joins, `currentColor`, drawn at 16px (`kb-icon`) or 20px (`kb-icon--lg`). The files are in the **Icons** asset group. Marks of games
and services follow *Brand icons*, and every icon enters the repo as *Pulling icons into the repo* says (both below).

| Page | Icon | Page | Icon |
| --- | --- | --- | --- |
| Dashboard | `layout-dashboard` | Moderation | `gavel` |
| Events | `calendar` | Tickets | `ticket` |
| Quotes | `quote` | Command audit | `scroll-text` |
| Polls | `vote` | Setup wizard | `wand-sparkles` |
| Birthdays | `cake` | Server scan | `scan-search` |
| Weekly digest | `newspaper` | Channel manager | `folder-tree` |
| Voice channels | `mic` | Channel claims | `flag` |
| Voice analytics | `audio-lines` | Role groups | `users` |
| Leaderboard roles | `trophy` | Command access | `key-round` |
| Announcements | `megaphone` | Adoption history | `history` |
| Notices | `sticky-note` | Presence | `activity` |
| Rules | `book-open` | Bot permissions | `shield-check` |
| Reaction roles | `smile-plus` | Command metrics | `chart-column` |
| Database | `database` | Environment | `server-cog` |
| All settings | `sliders-horizontal` | Game servers | `gamepad-2` |

Interface icons: `check`, `circle-check`, `triangle-alert`, `circle-x`, `info`, `chevron-right` (disclosures, links out of a row), `chevron-down`
(*More*), `external-link`, `user`, `log-out`, `clock`, `bell`, `hash` (text channel), `volume-2` (voice channel), `crown` (team leader), `tag`,
`settings` (a feature's settings section), `shuffle` (Randomise), `arrow-right-left` (move people), `lock`, `lock-open`, `plus`, `trash-2`,
`shield-half` (staff scope), `grip-vertical` (drag handle), `ellipsis` (a row's menu), `refresh-cw` (check again), `zap` (test a connection),
`wrench` (maintenance), `server` (servers).

KoolBot has no logo; the name is set in type in the TopBar.

### Brand icons

A game, platform, social network or voice app is shown with its own mark, next to its name and never instead of it. Marks come from one source per
need, in this order, so a mark added in two years looks like one added today:

1. **Tabler Icons, the outline `brand-*` set** (MIT, `@tabler/icons`). Drawn on Lucide's grid and stroke (24×24, 2px, round caps and joins), so a
   mark sits beside an interface icon without looking pasted in. Among its 376 brands: Discord, Steam, Twitch, YouTube, X, Reddit, Facebook,
   Instagram, TikTok, Bluesky, Mastodon, Kick, Minecraft and Xbox.
2. **Simple Icons** (CC0, `simple-icons`), only for a brand Tabler does not have, such as Counter-Strike, PlayStation, Mumble or TeamSpeak. These
   are solid marks: draw them with `kb-icon--filled` at the same size, and switch to Tabler's once Tabler adds the brand.
3. **Neither has it: ask upstream first.** Request the mark from Simple Icons, which takes marks from a brand's official assets, checks its
   guidelines and publishes a clean one-colour 24×24 file. Or ask Tabler for an outline mark. Until it lands, use the stand-in (5).
4. **A mark the brand supplies itself**, only with proof that the brand's terms allow exactly how we draw it: in our software, redistributed,
   in one colour, at icon size, symbol only. Every point is listed in [CONTRIBUTING.md → Adding an icon](CONTRIBUTING.md#adding-an-icon). If any
   point is unclear, the answer is no.
5. **Otherwise** the Lucide icon for the kind of thing: `gamepad-2` for a game, `headphones` for a voice app, `globe` for a website.

- Never draw, trace or edit a mark, and never take one from a font, another icon set or a fan site. A brand's own file is used only under 4.
- Marks are `currentColor` like every other icon, never in brand colours: colour would be the only thing telling two marks apart, and the palette
  stays ours.
- The name is always written next to the mark, and the mark is `aria-hidden`.
- A mark is a trademark: the licence covers the SVG, not the mark. Use it only to say which game or service something is, unaltered, never as
  decoration or as if it were KoolBot's own.
- **Names:** Lucide icons keep Lucide's name (`gamepad-2`). Every mark is `brand-<name>` whichever source it comes from (`brand-discord` from Tabler,
  `brand-mumble` from Simple Icons), so code asks for a brand the same way and moving it to another source changes no caller.

Game servers: `brand-minecraft` (Tabler), `brand-counter-strike` (Simple Icons), and `gamepad-2` for Factorio, Other game and LinuxGSM games
without a mark of their own.

### Pulling icons into the repo

Icons are code and are kept like code: pinned, listed and reproducible (#1390).

- **From the published package only**, at a pinned version: `lucide-static`, `@tabler/icons`, `simple-icons`. Never from a website, a CDN, a design
  file or another project, and never edited by hand. The one exception is a brand-supplied mark (*Brand icons*, 4). Its file is committed under
  `src/web/icons/acquired/`, with its proof in the manifest.
- **One module renders every icon** (`icon(name)`, #1369). No view keeps its own copy of path data.
- **One manifest lists every icon in use** (`src/web/icons/manifest.json`): our name, the source and the source's name. `npm run icons:pull`
  copies each listed icon from the pinned packages, so updating a source is a version bump and a re-pull, and every changed drawing shows in review.
- **The pull keeps only the drawing.** The outer `svg` attributes, `<title>` and Tabler's invisible bounding-box path are dropped; the module adds
  `kb-icon` and `aria-hidden`.
- **Licences ship with the icons**, in `THIRD_PARTY_NOTICES.md` (#1392): the ISC (Lucide) and MIT (Tabler) notices, Simple Icons (CC0) by name,
  and each brand-supplied mark's terms, marked as not covered by KoolBot's licence.
- **Only what is used.** An icon is pulled with the first page or message that shows it, and removed with the last.
- **A new source** needs this section changed first. It must have an open licence that allows copying into the repo, a versioned package that is
  still maintained, and a style that matches one of the sources above.

## Accessibility

The rules from #854 and #855 carry over: control edges at 3:1 (`control`), a visible focus ring everywhere, a skip link to `#main`, row headers in
tables, `aria-invalid` plus an error line on rejected fields, reflow at 760px, and wide tables scrolling inside their panel. New here: switches carry
*On*/*Off* text, the segmented control's selected option changes weight as well as fill, heatmaps name their peak in text, and dialogs say every
consequence in words.

## Added in the redesign

Components the old UI did not have, each for a reason above: **Switch** and **SegmentedControl** (replace Off/On selects and radio lists),
**SettingRow** (one-line descriptions, detail behind *More*), **IssueRow** (problem, impact, fix), **TeamCard** and the team board, **Dialog**
(options and confirmations; replaces confirm pages), **SaveBar** (one save per form). For access: **ScopeBadge**, **AccessCard** and **Steps**. For
Discord: **Mention**, **Picker** and the **DiscordEmbed** sketch. For forms: **NumberField**, **EmojiPicker** and **PresetCards**. Tokens added:
`scrim`, `shadow-pop`, the six `embed-*` accents, the `panel-title` style, and the `layout` sizes. The Pages group shows the redesigned screens for
every scope: the admin Dashboard, Events, Bot permissions, Server scan and the wizard's Access step; an event host's Your events, New event and host
panel; a moderator's Mod log; and My preferences.

Bot messages follow the same voice: see [Messages in Discord](docs/design/discord.md).
