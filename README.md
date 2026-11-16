# markdown-render-speed-02

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![make.fun rank](https://make.fun/badge/rank/ASEP9929/makefun-markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![make.fun reward](https://make.fun/badge/reward/ASEP9929/makefun-markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)

A faster drop-in replacement for **marked 18.1.3** — a dependency-free
JavaScript module (`parse.js`) whose `parse(markdown)` returns exactly the
HTML that marked 18.1.3 returns with default options (GFM on, breaks off,
pedantic off, async off), plus a small driver (`main.ts`) that renders every
case in the input set.

## Approach

- **Single-pass block lexer** with sticky regexes (`lastIndex`, no slicing)
  for ATX/setext headings, fenced/indented code, lists (including nesting,
  task items, loose/tight detection), blockquotes (with lazy continuation),
  tables, HTML blocks, thematic breaks, and link reference definitions.
- **Scanner-based inline parser** that renders HTML directly (no token
  tree): emphasis/strong, links (inline, reference, collapsed, shortcut),
  autolinks (`<...>` and GFM extended `www.`/email), code spans, images,
  strikethrough, hard/soft breaks, entities, and backslash escapes.
- **Correctness first**: validated byte-for-byte against marked 18.1.3 on
  all 720 practice cases (680 CommonMark 0.31.2 + GFM 0.29 spec examples and
  40 generated long READMEs) — **720/720**.
- **Speed**: the single-pass design and sticky regexes keep the whole
  720-case set under marked's CPU time on the same machine (provisional
  local run: ~0.61–0.70 s CPU warm vs marked ~0.76–0.81 s).

The parser implements the spec generally (no case-specific shortcuts, no
lookup tables, no caching across cases), so it should hold on the final
case set drawn after the deadline.

## Layout

- `parse.js` — the entry module (dependency-free ES module, `parse()`).
- `main.ts` — driver: reads `/input/cases.json`, writes `/output/html.json`
  (JSON array of 720 strings, in order). Run with `node /bot/main.ts`
  (Node 22, type stripping, built-ins only).

## Validation

Against the kit's practice set (drand round 33735412):

```
match: 720/720
```

Run locally with the kit's scorer:

```
node program/scorer/main.ts
```
