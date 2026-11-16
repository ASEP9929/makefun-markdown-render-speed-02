// Entry driver for markdown-render-speed-02.
//
// The kit drops a cases.json into MAKEFUN_INPUT_DIR (or /input) and
// expects an html.json with one rendered string per case in
// MAKEFUN_OUTPUT_DIR (or /output). Each case is rendered on its own so
// link definitions never leak from one document into the next.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse } from './parse.js';

interface InputCase {
  markdown: string;
}

function main(): void {
  const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  const payload = fs.readFileSync(path.join(inDir, 'cases.json'), 'utf8');
  const docs = JSON.parse(payload) as InputCase[];
  const rendered: string[] = [];
  for (const doc of docs) {
    rendered.push(parse(doc.markdown));
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'html.json'), JSON.stringify(rendered));
}

main();
