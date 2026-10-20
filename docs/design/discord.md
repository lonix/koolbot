# Messages in Discord

What KoolBot posts in Discord (embeds, replies, buttons and DMs) speaks with the same voice as the Web UI. Discord is where most members meet KoolBot,
so this is the larger half of the brand.

## Embeds

- **Accent bar** from the six `embed-*` tokens, chosen by what the message is about, never by feature: `embed-brand` for KoolBot itself (help,
  welcome, notices headers, announcements by default), `embed-ok` when something worked or is on, `embed-warn` when it needs attention, `embed-danger`
  when something failed or was removed, `embed-neutral` for plain information, `embed-lore` for activity and history. Get them from `embedColor(kind)`
  in `src/utils/embed-style.ts`, never a hex literal.
  No Discord blurple, and no pure `0xff0000` or `0x00ff00`. The bar is decorative: the title always says what the message is.
- **A colour the community chose stays theirs.** Notice categories and custom announcements keep their own colour; `embed-neutral` is only the default.
- **Title:** sentence case, at most one emoji at the start, and only when it names a thing (📢 for notices, 🎮 for a game server). Field names carry no emoji.
- **Description:** one or two short sentences saying what this is and what to do with it. No "Welcome!" filler, no "All posts are managed by" boilerplate.
- **Facts go in fields** (`Address`, `Password`), not in the description as `Servername: …` lines. Inline fields for short values, three to a row at most.
- **Lists** use Discord's `-` list markdown, one line per item, `name: what it does`. A list item may start with one emoji when it names a feature.
- **Commands** in inline code with the slash and no option syntax (`/quote`, not `/quote text:"..." author:@user`). The option hints come from Discord itself.
- **Channels, roles and people as real mentions** (`<#id>`, `<@&id>`, `<@id>`), so Discord renders them, links them and shows the right icon. Never
  type `#channel` as text.
- **Footer:** `KoolBot · <Feature>` and, where it helps, the sub-area (`KoolBot · Notices · Game servers`). Never "System", never a database id. An id
  that people need goes in a button or in the Web UI, not in the footer.
- **Time:** the embed `timestamp`, or `<t:…:f>` / `<t:…:R>` in text, so each reader sees their own timezone and format. Never a preformatted date string.
- **Version** appears only on help and about messages, in the footer.

## Replies

- A command that can fail answers ephemerally, in an `embed-danger` embed whose description says what to do next ("Pick a voice channel you own, then
  try again.").
- Confirmations are short: one line, ephemeral unless others need to see it.
- A reply that links to the Web UI says why ("Open the host panel to move people") and sends the one-time link, never a bare URL.

## Buttons and menus

- Verb-first labels, the same words as the Web UI (*Claim*, *Close ticket*, *Randomise*). Primary style for the one main action, Danger only for what
  removes something.
- Select menus list things the way the Web UI pickers do: channels with their kind, roles with `@`.

## Direct messages

- Only for things the member asked for (digest, Rewind, achievement nudges) and switched on in My preferences.
- The first line says why they got it ("Your weekly digest from Koolbot Dev"), and the footer says how to stop it ("Turn this off in /me → Notifications").
