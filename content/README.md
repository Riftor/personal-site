# `content/`

The human-editable source of truth for everything the site serves that is not
code. Plan §6.

The markdown in here is committed. **The media is not** — `.gitignore` covers
`content/**/media` and this repo is public. Originals and transcodes live in
R2; `pnpm run publish` puts them there.

```
content/
  memories/2026-07-cornwall/index.md + media/
  photosets/2026-06-family-dinner/index.md + media/
  activity/2026-08.md                        one file per month, append-only
  pages/about.md                             public portfolio pages
  _fixtures/                                 e2e fixtures, not real content
```

## Publishing

```bash
pnpm run publish content/memories/2026-07-cornwall
pnpm run publish content/activity/2026-08.md --dry-run
pnpm content:publish content/photosets/2026-06-family-dinner --remote
```

`pnpm run publish`, not `pnpm publish` — pnpm keeps `publish` as a built-in
command that pushes a package to the npm registry, so a bare `pnpm publish`
never reaches the script. `pnpm content:publish` is the unambiguous spelling.

The sync is one-directional (git → D1) and keyed on `slug`. Re-running against
an unchanged folder writes nothing; re-running after an edit updates in place.
No redeploy is needed — content lives in D1, so a new memory is live the moment
the CLI finishes.

| Flag        |                                                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| `--dry-run` | Validate, render and transcode, but write no D1 row and no R2 object.                                                      |
| `--force`   | Re-transcode media whose content hash has not moved. Does **not** override the refusal to tighten an already-public asset. |
| `--remote`  | The deployed D1 and R2 instead of the local ones.                                                                          |

Generate stand-in media for the fixture folders with
`node scripts/content/fixtures.mjs`. Replace it by dropping real files in with
the same names and publishing again.

## Frontmatter

```yaml
---
title: Cornwall, July 2026
kind: memory # page | project | memory | photoset | activity
min_tier: family # public | friend | family | partner | owner
status: published # draft | published
occurred_on: 2026-07-14 # the date it is *about*
summary: One line.
slug: 2026-07-cornwall # defaults to the folder (or file) name
sort_key: a # manual ordering override
cover: beach.jpg # must appear in media:
media:
  - file: beach.jpg
    caption: First morning
  - file: surf.mov
    caption: Caden eating sand
    min_tier: partner # per-asset override — STRICTER only
---
```

Rules the CLI enforces, all of them hard errors:

- **An unknown `min_tier`, `kind` or `status` stops the publish.** There is no
  fallback. A typo must not quietly choose an audience.
- **`min_tier` is optional and defaults to `owner`** — nobody but Caden. A
  forgotten field fails towards "nobody can see it".
- **A per-asset `min_tier` may only be stricter than the entry's.** A looser
  one is refused rather than ignored, because honouring it would mean the
  entry's own tier no longer describes who can see its media.
- **An unknown frontmatter key is a typo, not an extension.**
- **A memory or photo set at `min_tier: public` needs a typed "yes"** on a
  terminal, every time. No flag skips it, and a non-interactive stdin aborts.
- **An asset in D1 that the `media:` list no longer names stops the publish.**
  It would otherwise keep rendering on a page the author believes no longer
  shows it. The error prints the commands to remove it.

`status: draft` entries are published to D1 and are **not servable** — no
listing, no detail page, no media.

## The markdown dialect

Rendered once, at publish time, into `content_entry.body_html`, by
`scripts/content/markdown.mjs`. The private templates put that string through
`{@html}`, so the renderer escapes the source **before** any rule runs:

**Raw HTML in a body is displayed as text, never executed.** That is
deliberate. A `<script>` in a memory body would be stored XSS in the half of
the site that holds the private photos, and inline HTML is not worth it.

Supported: ATX headings, paragraphs, `-`/`*` and `1.` lists, `>` blockquotes,
fenced code blocks, `---` rules, and inline `**bold**`, `*italic*`, `` `code` ``
and `[links](https://example.com)`. Link targets are limited to `http:`,
`https:`, `mailto:`, `/same-origin` paths and `#fragments`; anything else
renders as plain text.

Not supported: tables, footnotes, inline images. Images belong in `media:`,
where they get a tier, a caption and a transcode.
