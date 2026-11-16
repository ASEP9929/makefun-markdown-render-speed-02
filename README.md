# markdown-render-speed-02 — a single-pass CommonMark + GFM renderer

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/ASEP9929/makefun-markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/ASEP9929/makefun-markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free JavaScript Markdown renderer that aims to produce exactly
the same HTML as **marked 18.1.3** with its default settings — GFM on,
breaks off, pedantic off, async off — while doing the work in a single
pass instead of marked's multi-stage token pipeline.

## What it is

- `parse(markdown)` from `parse.js` returns the HTML string for one
  document. The block layer walks the document line by line, matching
  open containers (block quotes, lists, list items) and starting new
  blocks as they appear; the inline layer then scans each paragraph once,
  resolving links, emphasis, code spans, autolinks and raw HTML in that
  single scan.
- No dependencies, no lookup tables keyed to test cases, no caching of
  results across documents. Every document is rendered from scratch by
  the same general parser, so the behaviour should carry over to the
  final case set drawn after the deadline.
- Coverage includes the CommonMark 0.31.2 spec examples and the GFM 0.29
  extensions (tables, strikethrough, task lists, autolinks, disallowed
  raw HTML), checked against the kit's practice set of 720 cases.

## Running it

The harness runs the driver; you can run it the same way locally:

```sh
node main.ts
```

`main.ts` reads the cases from `MAKEFUN_INPUT_DIR` (or `/input`) and
writes the rendered HTML to `MAKEFUN_OUTPUT_DIR` (or `/output`).

## Layout

- `parse.js` — the parser: block layer, inline layer, and renderer.
- `main.ts` — the driver: reads cases, renders each one, writes `html.json`.
- `LICENSE` — MIT.
