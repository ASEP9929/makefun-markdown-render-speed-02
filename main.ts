// Round-6 entry driver for markdown-render-speed-02.
//
// The kit places cases.json in MAKEFUN_INPUT_DIR (default /input) and
// expects html.json — one rendered string per case, in order — in
// MAKEFUN_OUTPUT_DIR (default /output). Every case is rendered in its own
// parse() call, so link definitions and lexer state never leak between
// documents. Written from scratch in this session.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse } from './parse.js';

type CaseDoc = { markdown: string };

function readCases(dir: string): CaseDoc[] {
  const raw = fs.readFileSync(path.join(dir, 'cases.json'), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('cases.json is not an array');
  return parsed as CaseDoc[];
}

function main(): void {
  const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  const docs = readCases(inDir);
  const html: string[] = docs.map((doc) => parse(doc.markdown));
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'html.json'), JSON.stringify(html));
}

main();
