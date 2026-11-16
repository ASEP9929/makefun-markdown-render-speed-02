# markdown-render-speed-02 — a single-pass CommonMark + GFM renderer

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/ASEP9929/makefun-markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/ASEP9929/makefun-markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free JavaScript Markdown renderer that produces exactly the
same HTML as **marked 18.1.3** with its default settings — GFM enabled,
breaks off, pedantic off, async off — while doing the work in one pass
instead of marked's multi-stage token pipeline.

## What you get

- `parse(markdown)` from `parse.js` returns the HTML string for one
  document, matching marked 18.1.3 byte for byte on the kit's practice
  set: **720 out of 720 cases** (680 CommonMark 0.31.2 and GFM 0.29 spec
  examples, plus 40 generated long-form documents).
- No dependencies, no lookup tables keyed to test cases, no caching of
  results across documents. Every case is rendered from scratch by the
  same general parser, so the behaviour should carry over to the final
  case set drawn after the deadline.

## Running it

The harness runs the driver; you can run it the same way locally:

```sh
node main.ts
```

The driver reads the case list from `MAKEFUN_INPUT_DIR` (falling back to
`/input`), renders each case in isolation — link reference definitions
never leak from one case into the next — and writes the results as a JSON
array of HTML strings to `html.json` inside `MAKEFUN_OUTPUT_DIR`
(falling back to `/output`). Run it from the repository root with Node
22 (type stripping, built-ins only).

## Inside the parser

The implementation is organised as two cooperating engines plus renderers:

- **Block engine** — walks the document once with sticky regular
  expressions anchored at the current cursor. It recognises ATX and setext
  headings, fenced and indented code blocks, ordered and unordered lists
  (nested, with task items and loose/tight detection), blockquotes
  including lazy continuation lines, GFM tables, HTML blocks, thematic
  breaks, and link reference definitions. The block patterns mirror
  marked's own GFM grammar, including the paragraph lookahead that stops
  a paragraph before a fence, list, table, blockquote, heading, rule, or
  HTML block starts.
- **Inline engine** — a scanner that emits HTML directly, without
  building an intermediate token tree. It handles emphasis and strong
  emphasis (including nested delimiters), inline / reference / collapsed /
  shortcut links, images, autolinks in both `<...>` and extended GFM
  form (`www.` and email addresses), code spans, strikethrough, hard and
  soft line breaks, character references, and backslash escapes.
- **Two renderers** — an HTML renderer for the output the harness
  scores, and a plain-text renderer used while resolving link labels and
  other contexts where markup must be stripped.

Because the block pass never slices the input and the inline pass never
materialises tokens, the design keeps per-case work low; the bounty
scores speed against marked on the hidden case set, so the single-pass
structure is the whole point.

## Repository contents

| File | Role |
| --- | --- |
| `parse.js` | The renderer. A dependency-free ES module exporting `parse()`. |
| `main.ts` | The driver. Reads the input cases, renders each one, writes `html.json`. |

## Verifying locally

Score the output against the kit's reference HTML with the kit scorer:

```sh
node program/scorer/main.ts
```

With `MAKEFUN_OUTPUT_DIR`, `MAKEFUN_REFERENCE_DIR`, and
`MAKEFUN_SCORES_DIR` pointed at your output, the reference set, and a
scores directory, the practice set reports:

```
{"passed":1,"cases_passed":720,"cases_total":720}
```

<sub>Entered on [make.fun](https://make.fun/?ref=5z5e6x04&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
