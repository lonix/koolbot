# Example Poll Libraries

Ready-to-import poll question banks for KoolBot's [poll feature](../../SETTINGS.md#polls).

| File | What it is |
| --- | --- |
| [`sample-polls.yaml`](./sample-polls.yaml) | A small, heavily commented starter library. Use it as a reference for the file format and as a starting point for your own server. |
| [`two-maidens-one-chalice.yaml`](./two-maidens-one-chalice.yaml) | A 60+ entry "would you rather" dilemma compendium (absurd / cursed / nerdy). Single-select only. |

## How to import

1. **Open the importer.** Web UI → **Polls → Import questions**.
2. **Provide the content.** Either pick the `.yaml`/`.json` file with the file
   chooser (it loads into the text box, where you can review or edit it first)
   or paste the document directly. KoolBot never fetches from the network — the
   content comes straight from your browser, so there is no URL to host and no
   host allowlist to configure.
3. **Import.** KoolBot validates each entry, **skips duplicates** (matched by
   question text), and copies the rest into your guild's local poll library.

Re-importing the same file later is safe — only new questions get added.

## File format

```yaml
polls:
  - question: "Would you rather lose an arm or lose a leg?"  # required, <= 300 chars
    answers: ["Lose an arm", "Lose a leg"]                   # required, 2-10 options, each <= 55 chars
    multiselect: false                                       # optional, default false
    tags: ["dilemma", "classic"]                             # optional, free-form
```

JSON works too — the importer accepts either, with the same `{ "polls": [...] }` shape.

### Rules (enforced on import)

- `question` — required, max **300** characters.
- `answers` — required, **2 to 10** options, each max **55** characters.
- `multiselect` — optional boolean, defaults to `false`.
- `tags` — optional list of strings for your own organization.

Invalid entries are skipped individually with an error in the import summary —
one bad poll won't fail the whole import.
