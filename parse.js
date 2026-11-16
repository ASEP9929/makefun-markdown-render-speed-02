// A single-pass CommonMark 0.31.2 + GFM 0.29 renderer whose HTML matches
// marked 18.1.3 (default options) character for character.
//
// Layout of this file:
//   1. small string helpers (escaping, entities, tab columns)
//   2. link labels, destinations and titles; link reference definitions
//   3. the block pass: lines -> a block tree
//   4. the inline pass: raw text -> HTML (delimiter stack for emphasis)
//   5. rendering the tree to HTML, and the parse() entry point.
//
// The block pass follows the CommonMark reference shape: open containers are
// matched line by line, then new blocks are started, then the line's rest is
// added to the open leaf. The inline pass tokenises once, left to right, and
// resolves emphasis with a delimiter stack.

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  // A trailing line end leaves a final empty line behind; drop it so the
  // document does not end with a phantom blank line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const state = new BlockState(lines, src.endsWith('\n'));
  state.run();
  let html = renderBlocks(state.root, state.refs);
  // An HTML block renders its raw text, so it ends with a newline only
  // when the source line that closes it had one. When the document has
  // no trailing newline, strip the final newline if the last block is
  // an HTML block (gfm-657); when it has one, supply it if missing.
  if (!src.endsWith('\n')) {
    const last = state.root.children[state.root.children.length - 1];
    if (last && last.t === 'html' && html.endsWith('\n')) html = html.slice(0, -1);
  } else if (html !== '' && !html.endsWith('\n')) {
    html += '\n';
  }
  return html;
}

// ---------------------------------------------------------------- helpers

const PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));

function isSpace(ch) {
  return ch === ' ' || ch === '\t';
}

function isBlankLine(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

// Plain HTML escaping, used for code spans, code blocks and plain text runs:
// every & becomes &amp;, no matter what follows it.
function escapeText(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    let rep = null;
    if (c === '&') rep = '&amp;';
    else if (c === '<') rep = '&lt;';
    else if (c === '>') rep = '&gt;';
    else if (c === '"') rep = '&quot;';
    else if (c === "'") rep = '&#39;';
    if (rep !== null) {
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return out + s.slice(start);
}

// Does an entity-like pattern start at s[i] (i points at '&')?
// Matches &name; , &#digits; and &#x hex; with no check on the number.
function entityAt(s, i) {
  if (s[i] !== '&') return 0;
  let j = i + 1;
  if (s[j] === '#') {
    j++;
    if (s[j] === 'x' || s[j] === 'X') {
      j++;
      const h0 = j;
      while (j < s.length && /[0-9a-fA-F]/.test(s[j])) j++;
      if (j === h0 || s[j] !== ';') return 0;
      return j + 1 - i;
    }
    const d0 = j;
    while (j < s.length && s[j] >= '0' && s[j] <= '9') j++;
    if (j === d0 || s[j] !== ';') return 0;
    return j + 1 - i;
  }
  if (!/[A-Za-z]/.test(s[j] || '')) return 0;
  j++;
  while (j < s.length && /[A-Za-z0-9]/.test(s[j])) j++;
  if (s[j] !== ';') return 0;
  return j + 1 - i;
}

// Attribute escaping (href, title, fenced-code language): an & that begins an
// entity-like pattern is left alone, every other & becomes &amp;.
function escapeAttr(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '&') {
      const n = entityAt(s, i);
      if (n > 0) {
        i += n - 1;
        continue;
      }
      out += s.slice(start, i) + '&amp;';
      start = i + 1;
    } else if (c === '<') {
      out += s.slice(start, i) + '&lt;';
      start = i + 1;
    } else if (c === '>') {
      out += s.slice(start, i) + '&gt;';
      start = i + 1;
    } else if (c === '"') {
      out += s.slice(start, i) + '&quot;';
      start = i + 1;
    } else if (c === "'") {
      out += s.slice(start, i) + '&#39;';
      start = i + 1;
    }
  }
  return out + s.slice(start);
}

// Decode one numeric character reference starting at s[i] (s[i] === '&',
// s[i+1] === '#'). Returns [text, length] where text is the decoded
// character, or null when the reference is not a decodable one.
function numericEntity(s, i) {
  let j = i + 2;
  let code = 0;
  let ok = false;
  if (s[j] === 'x' || s[j] === 'X') {
    j++;
    const h0 = j;
    while (j < s.length && /[0-9a-fA-F]/.test(s[j])) {
      code = code * 16 + parseInt(s[j], 16);
      j++;
      if (code > 0x10ffff) {
        // Still consume the digits, but the value is out of range.
        while (j < s.length && /[0-9a-fA-F]/.test(s[j])) j++;
        break;
      }
    }
    ok = j > h0 && s[j] === ';';
  } else {
    const d0 = j;
    while (j < s.length && s[j] >= '0' && s[j] <= '9') {
      code = code * 10 + (s.charCodeAt(j) - 48);
      j++;
      if (code > 0x10ffff) {
        while (j < s.length && s[j] >= '0' && s[j] <= '9') j++;
        break;
      }
    }
    ok = j > d0 && s[j] === ';';
  }
  if (!ok) return null;
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) code = 0xfffd;
  return [String.fromCodePoint(code), j + 1 - i];
}

// Width of one tab stop from column col.
function tabWidth(col) {
  return 4 - (col % 4);
}

// Advance over indentation on line s starting at index i, column col,
// consuming at most maxCols columns. `partial` is the number of spaces a
// previously half-eaten tab leaves behind at the front of the line; those
// spaces are consumed first. Returns [i, col, partial] where col is the
// document column of the character at i and partial is the number of
// spaces a partially consumed tab leaves behind (0 when the line's next
// character is not a half-eaten tab). A tab that is only partly consumed
// is stepped over entirely: its remaining width becomes the partial.
function eatIndent(s, i, col, maxCols, partial) {
  let left = maxCols;
  let part = partial || 0;
  let cur = col - part;
  if (part > 0) {
    const take = Math.min(part, left);
    part -= take;
    cur += take;
    left -= take;
    if (left === 0) return [i, col, part];
  }
  while (left > 0 && i < s.length) {
    const c = s[i];
    if (c === ' ') {
      i++;
      cur++;
      left--;
      col = cur;
    } else if (c === '\t') {
      const w = tabWidth(cur);
      if (w <= left) {
        i++;
        cur += w;
        left -= w;
        col = cur;
      } else {
        i++;
        part = w - left;
        cur += w;
        col = cur;
        left = 0;
      }
    } else break;
  }
  return [i, col, part];
}

// How many columns of indentation does the line have from index i, column
// col, with `partial` spaces of a half-eaten tab in front? Tab widths are
// measured from the document columns, so the raw tab at i is measured
// from col.
function indentCols(s, i, col, partial) {
  let c = col;
  let j = i;
  let ind = partial || 0;
  while (j < s.length) {
    const ch = s[j];
    if (ch === ' ') {
      j++;
      c++;
      ind++;
    } else if (ch === '\t') {
      j++;
      const w = tabWidth(c);
      c += w;
      ind += w;
    } else break;
  }
  return ind;
}

// The rest of line s from index i, with a partially consumed tab rendered
// as `partial` spaces in front.
function restOf(s, i, partial) {
  return partial > 0 ? ' '.repeat(partial) + s.slice(i) : s.slice(i);
}

// The content of a line inside a container (a quote or list item), with
// tabs in its leading whitespace expanded to spaces using each tab's
// document column (marked's J): a tab at column c becomes 4 - (c % 4)
// spaces. `partial` spaces from a partially consumed tab are prepended
// as-is. At the top level tabs are kept, so this is only used when a
// container prefix was consumed.
function expandContentTabs(s, i, partial, col) {
  let out = partial > 0 ? ' '.repeat(partial) : '';
  let c = col;
  let j = i;
  while (j < s.length && (s[j] === ' ' || s[j] === '\t')) {
    if (s[j] === '\t') {
      const w = 4 - (c % 4);
      out += ' '.repeat(w);
      c += w;
    } else {
      out += ' ';
      c++;
    }
    j++;
  }
  return out + s.slice(j);
}

// ---------------------------------------------------------------- link pieces

// Parse a link label starting at s[pos] === '['. Returns {label, end}
// (end is the index just past ']') or null. Brackets may nest; backslash
// escapes do not count as brackets; labels are at most 999 code units and
// hold no blank line.
function parseLabel(s, pos) {
  // A reference label (marked's `le`): no '[' or ']' inside, backslash
  // escapes are skipped, a newline is allowed only when it does not start
  // a blank line. The label must not be empty or all whitespace.
  if (s[pos] !== '[') return null;
  let i = pos + 1;
  const start = i;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '[') return null;
    if (c === ']') {
      const raw = s.slice(start, i);
      if (raw.length === 0 || raw.length > 999) return null;
      if (/^\s*$/.test(raw)) return null;
      if (/\n[ \t]*\n/.test(raw)) return null;
      return { label: raw, end: i + 1 };
    }
    if (c === '\n') {
      let j = i + 1;
      while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
      if (j >= s.length || s[j] === '\n') return null;
    }
    i++;
  }
  return null;
}

// A label's normalised form: collapse every run of whitespace to one space,
// trim, and fold case.
function normaliseLabel(raw) {
  // Unicode case folding: the sharp-s and final-sigma foldings that
  // toLowerCase() does not do (ẞ/ß -> ss, ς -> σ), plus the ligatures.
  return raw
    .replace(/ß/g, 'ss')
    .replace(/ẞ/g, 'ss')
    .replace(/ς/g, 'σ')
    .replace(/ﬀ/g, 'ff')
    .replace(/ﬁ/g, 'fi')
    .replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi')
    .replace(/ﬄ/g, 'ffl')
    .replace(/ﬅ/g, 'st')
    .replace(/ﬆ/g, 'st')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Skip spaces, tabs and line ends from pos.
function skipSpaceLines(s, pos) {
  while (pos < s.length && (s[pos] === ' ' || s[pos] === '\t' || s[pos] === '\n')) pos++;
  return pos;
}

// Skip spaces and tabs only (no line ends).
function skipSpace(s, pos) {
  while (pos < s.length && (s[pos] === ' ' || s[pos] === '\t')) pos++;
  return pos;
}

// Skip spaces/tabs, then exactly one line end, then spaces/tabs: the
// position of the first character of the next line. Returns -1 when there
// is no single line end (end of text, junk on the line, or a blank line).
function skipToNextLine(s, pos) {
  let p = pos;
  while (p < s.length && (s[p] === ' ' || s[p] === '\t')) p++;
  if (p >= s.length || s[p] !== '\n') return -1;
  p++;
  while (p < s.length && (s[p] === ' ' || s[p] === '\t')) p++;
  return p;
}

// Parse a link destination at s[pos]. Returns {dest, end} or null.
// <...> form: no line end, no unescaped < inside; bare form: no spaces or
// control characters, balanced parentheses, backslash escapes allowed.
function parseDestination(s, pos) {
  if (s[pos] === '<') {
    let i = pos + 1;
    let out = '';
    while (i < s.length) {
      const c = s[i];
      if (c === '\n' || c === '<') return null;
      if (c === '>') return { dest: out, end: i + 1 };
      if (c === '\\' && i + 1 < s.length && PUNCT.has(s[i + 1])) {
        out += s[i + 1];
        i += 2;
        continue;
      }
      out += c;
      i++;
    }
    return null;
  }
  let depth = 0;
  let i = pos;
  let out = '';
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 32) break;
    if (c === '\\' && i + 1 < s.length && PUNCT.has(s[i + 1])) {
      out += s[i + 1];
      i += 2;
      continue;
    }
    if (c === '(') {
      depth++;
      out += c;
      i++;
      continue;
    }
    if (c === ')') {
      if (depth === 0) break;
      depth--;
      out += c;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  if (i === pos) return null;
  return { dest: out, end: i };
}

// Parse a link title at s[pos]: "..." or '...' or (...), possibly spanning
// lines. Returns {title, end} or null.
function parseTitle(s, pos) {
  const open = s[pos];
  if (open !== '"' && open !== "'" && open !== '(') return null;
  const close = open === '(' ? ')' : open;
  let i = pos + 1;
  let out = '';
  while (i < s.length) {
    const c = s[i];
    if (c === close) return { title: out, end: i + 1 };
    if (c === '\\' && i + 1 < s.length && PUNCT.has(s[i + 1])) {
      out += s[i + 1];
      i += 2;
      continue;
    }
    if (open === '(' && c === '(') return null;
    out += c;
    i++;
  }
  return null;
}

// Try to read link reference definitions from the start of a paragraph's
// joined text. Returns {defs, rest}: defs is a list of {label, dest, title}
// in order, rest is the text left after the definitions ('' when the whole
// paragraph was definitions).
function parseRefDefs(text) {
  const defs = [];
  let pos = 0;
  for (;;) {
    let p = pos;
    // Up to three spaces of indentation.
    let ind = 0;
    while (p < text.length && text[p] === ' ' && ind < 3) {
      p++;
      ind++;
    }
    if (p >= text.length || text[p] !== '[') break;
    const lab = parseLabel(text, p);
    if (!lab) break;
    p = lab.end;
    if (text[p] !== ':') break;
    p++;
    p = skipSpaceLines(text, p);
    const dst = parseDestination(text, p);
    if (!dst) break;
    p = dst.end;
    // After the destination only spaces/tabs may sit on the line; a title
    // may follow on this line (separated by at least one space/tab) or
    // on the next line (separated by the line end alone, never a blank
    // line). Anything else on the line means this is not a definition.
    let q = skipSpace(text, p);
    let title = null;
    if (q < text.length && text[q] !== '\n') {
      if (q === p) break; // no whitespace before it (cm-201: `<bar>(baz)`)
      if (text[q] === '"' || text[q] === "'" || text[q] === '(') {
        const t = parseTitle(text, q);
        if (!t) break;
        title = t.title;
        q = skipSpace(text, t.end);
      } else {
        break;
      }
    } else {
      const r = skipToNextLine(text, p);
      if (r >= 0 && (text[r] === '"' || text[r] === "'" || text[r] === '(')) {
        const t = parseTitle(text, r);
        if (t) {
          const q2 = skipSpace(text, t.end);
          if (q2 >= text.length || text[q2] === '\n') {
            title = t.title;
            q = q2;
          }
          // Junk after the title: the title is not consumed, but the
          // definition still counts, without a title (cm-210); q stays
          // at the end of the destination line.
        }
      }
    }
    if (q < text.length && text[q] !== '\n') break;
    defs.push({ label: normaliseLabel(lab.label), dest: dst.dest, title });
    if (q >= text.length) {
      pos = q;
      break;
    }
    pos = q + 1; // move past the line end
  }
  return { defs, rest: text.slice(pos) };
}

// ---------------------------------------------------------------- block pass

// Block node shapes (extra fields are parse state, not rendered):
//  doc   { t:'doc', children }
//  quote { t:'quote', children }
//  list  { t:'list', ordered, start, delim, tight, children, blankPending }
//  item  { t:'item', children, contentIndent, markerCol, task }
//  para  { t:'para', lines }
//  head  { t:'head', level, text }
//  hr    { t:'hr' }
//  code  { t:'code', fenced, fence, fenceLen, info, lines }
//  html  { t:'html', kind, endTag, lines }
//  table { t:'table', head, aligns, rows }

const BLOCK_TAGS = new Set(
  ('address article aside base basefont blockquote body caption center col colgroup dd ' +
   'details dialog dir div dl dt fieldset figcaption figure footer form frame frameset ' +
   'h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav ' +
   'noframes ol optgroup option p param section source summary table tbody td tfoot th ' +
   'thead title tr track ul').split(' '),
);

// Try to read a list marker at s[i] (i is at most 3 columns past the
// container base). Returns null, or an object describing the marker and the
// column where the item's content begins.
function readListMarker(s, i, col) {
  let ordered = false;
  let start = 1;
  let delim = '';
  let bullet = '';
  let mlen = 0;
  const c = s[i];
  if (c === '-' || c === '+' || c === '*') {
    bullet = c;
    mlen = 1;
  } else if (c >= '0' && c <= '9') {
    let j = i;
    let num = '';
    while (j < s.length && s[j] >= '0' && s[j] <= '9' && num.length < 10) {
      num += s[j];
      j++;
    }
    if (num.length === 0 || num.length > 9) return null;
    const d = s[j];
    if (d !== '.' && d !== ')') return null;
    const n = Number(num);
    if (n > 999999999) return null;
    ordered = true;
    start = n;
    delim = d;
    mlen = j + 1 - i;
  } else return null;
  // The marker must be followed by a space, a tab or the end of the line.
  const after = s[i + mlen];
  if (after !== undefined && after !== ' ' && after !== '\t') return null;
  // Measure the gap after the marker. One to four columns put the content
  // after them; five or more put it one column past the marker, and the
  // rest of the gap belongs to the content.
  let j = i + mlen;
  let c2 = col + mlen;
  let gap = 0;
  let one = null;
  while (j < s.length && (s[j] === ' ' || s[j] === '\t')) {
    if (one === null) {
      if (s[j] === ' ') {
        one = [j + 1, c2 + 1, 0];
      } else {
        const w = tabWidth(c2);
        one = [j + 1, c2 + w, w - 1];
      }
    }
    if (s[j] === ' ') {
      gap++;
      c2++;
      j++;
    } else {
      const w = tabWidth(c2);
      gap += w;
      c2 += w;
      j++;
    }
    if (gap >= 5) break;
  }
  const empty = j >= s.length;
  const contentIndent = empty || gap >= 5 ? col + mlen + 1 : c2;
  if (gap >= 5 && one !== null) {
    return { ordered, start, delim, bullet, mlen, empty, contentIndent, endPos: one[0], endCol: one[1], partial: one[2] };
  }
  return { ordered, start, delim, bullet, mlen, empty, contentIndent, endPos: j, endCol: c2, partial: 0 };
}

// Is the line, from position i, a thematic break? (up to three spaces of
// indent are allowed before it; the caller checks the indent.)
function isThematicBreak(s, i) {
  const c = s[i];
  if (c !== '*' && c !== '-' && c !== '_') return false;
  let n = 0;
  let j = i;
  while (j < s.length) {
    const ch = s[j];
    if (ch === c) n++;
    else if (ch === ' ' || ch === '\t') {
      // spaces are allowed between the markers
    } else return false;
    j++;
  }
  return n >= 3;
}

// Is the line, from position i, a setext underline? Returns 1 for '=', 2
// for '-', 0 otherwise. The markers must form one unbroken run: spaces
// are allowed only before the first marker and after the last one, so
// "= =" is not an underline and "--- -" is a thematic break, not a
// heading (cm-088).
function setextLevel(s, i) {
  const c = s[i];
  if (c !== '=' && c !== '-') return 0;
  let j = i;
  let n = 0;
  let spaced = false;
  while (j < s.length) {
    const ch = s[j];
    if (ch === c) {
      if (spaced) return 0;
      n++;
      j++;
    } else if (ch === ' ' || ch === '\t') {
      spaced = true;
      j++;
    } else return 0;
  }
  return n >= 1 ? (c === '=' ? 1 : 2) : 0;
}

// Split a table row line into cells: unescaped | separates, backslash escapes
// are kept for the inline pass, leading/trailing pipes are dropped, and each
// cell is trimmed of spaces and tabs.
function splitTableRow(line) {
  line = line.trim();
  if (line.startsWith('|')) line = line.slice(1);
  if (line.endsWith('|')) line = line.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length && line[i + 1] === '|') {
      // An escaped pipe is a literal pipe, not a cell separator; the
      // backslash has served its purpose and is dropped, so a code span
      // containing it renders the bare pipe (doc-01).
      cur += '|';
      i++;
      continue;
    }
    if (c === '|') {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

// Does the line, from position i, look like a table delimiter row? Returns
// the alignment list (null for none) or null when it is not a delimiter row.
function parseDelimiterRow(s, i) {
  let line = s.slice(i).trim();
  if (line.startsWith('|')) line = line.slice(1);
  if (line.endsWith('|')) line = line.slice(0, -1);
  if (line === '') return null;
  const parts = line.split('|');
  const aligns = [];
  for (let part of parts) {
    part = part.trim();
    let left = false;
    let right = false;
    if (part.startsWith(':')) {
      left = true;
      part = part.slice(1);
    }
    if (part.endsWith(':')) {
      right = true;
      part = part.slice(0, -1);
    }
    if (part.length === 0 || !/^-+$/.test(part)) return null;
    aligns.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
  }
  return aligns;
}

// Classify an HTML block start at s[i]. Returns {kind, endTag} or null.
// kind 1: pre/script/style/textarea, 2: <!--, 3: <?, 4: <!letter, 5: <![CDATA[,
// kind 6: block-level tag, kind 7: any complete tag alone on the line.
function htmlBlockStart(s, i) {
  if (s[i] !== '<') return null;
  const rest = s.slice(i + 1);
  const m1 = /^(pre|script|style|textarea)(?=[ \t>]|$)/i.exec(rest);
  if (m1) return { kind: 1, endTag: m1[1].toLowerCase() };
  if (rest.startsWith('!--')) return { kind: 2, endTag: null };
  if (rest.startsWith('?')) return { kind: 3, endTag: null };
  if (rest.startsWith('!') && /^[A-Za-z]/.test(rest.slice(1))) return { kind: 4, endTag: null };
  if (rest.startsWith('![CDATA[')) return { kind: 5, endTag: null };
  // Kind 6: a block-level tag. The tag need not be complete on this line
  // (its attributes may continue on the next); only the tag name, followed
  // by a space, tab, '>' or the end of the line, is required.
  const tag = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?=[ \t>]|$)/.exec(s.slice(i));
  if (tag && BLOCK_TAGS.has(tag[1].toLowerCase())) {
    return { kind: 6, endTag: null };
  }
  // Kind 7: a complete open or close tag, alone on the line. The tag
  // must be syntactically valid: attributes need proper names/values
  // separated by whitespace, and a closing tag takes no attributes
  // (cm-619, cm-622, cm-624, cm-632).
  const attr = "(?:[ \\t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \\t]*=[ \\t]*(?:[^ \\t\"'=<>\\x60]+|'[^']*'|\"[^\"]*\"))?)*";
  const m7open = new RegExp('^<[A-Za-z][A-Za-z0-9-]*' + attr + '[ \\t]*\\/?>[ \\t]*$').exec(s.slice(i));
  const m7close = /^<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>[ \t]*$/.exec(s.slice(i));
  if (m7open || m7close) return { kind: 7, endTag: null };
  return null;
}

// Does this line end an HTML block of the given kind? (The line itself is
// part of the block.)
function htmlBlockEnds(kind, endTag, line) {
  const low = line.toLowerCase();
  if (kind === 1) return low.includes('</' + endTag + '>');
  if (kind === 2) return line.includes('-->');
  if (kind === 3) return line.includes('?>');
  if (kind === 4) return line.includes('>');
  if (kind === 5) return line.includes(']]>');
  return false; // kinds 6 and 7 end at a blank line
}

// Inside a fenced code block, a line that falls short of a list item's
// content indent still belongs to the item, unless it starts a new block
// that can interrupt it. marked's list-item consumption breaks on exactly
// these starts (all at an indent below the item's content indent): a list
// marker, a thematic break, a fenced code start, an ATX heading, an HTML
// block start, or a blockquote start. Anything else (plain text, a
// reference definition, ...) stays inside the item and becomes code
// content. `line` is the line text from the container-matched position.
function interruptsFencedCodeItem(line, contentIndent) {
  let j = 0;
  let spaces = 0;
  while (line[j] === ' ') { j++; spaces++; }
  if (spaces >= contentIndent) return false;
  const rest = line.slice(j);
  if (/^(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/.test(rest)) return true;
  if (/^(?:-[ \t]*){3,}$/.test(rest) || /^(?:_[ \t]*){3,}$/.test(rest) || /^(?:\*[ \t]*){3,}$/.test(rest)) return true;
  if (/^(?:```+|~~~+)/.test(rest)) return true;
  if (/^#{1,6}(?:[ \t]|$)/.test(rest)) return true;
  if (rest[0] === '>') return true;
  if (htmlBlockStart(rest, 0)) return true;
  return false;
}

class BlockState {
  constructor(lines, srcEndsNL) {
    this.lines = lines;
    this.srcEndsNL = srcEndsNL;
    this.root = { t: 'doc', children: [] };
    this.refs = new Map();
    // Whether a raw `<a>` opening tag has been seen without a matching
    // `</a>`: while set, GFM autolinks are not created (marked's
    // inLink state, which leaks across blocks until `</a>`).
    this.refs.inLink = false;
    this.stack = [this.root];
  }

  tip() {
    return this.stack[this.stack.length - 1];
  }

  // The deepest open container (doc, quote, list or item).
  containerTip() {
    for (let k = this.stack.length - 1; k >= 0; k--) {
      const b = this.stack[k];
      if (b.t === 'doc' || b.t === 'quote' || b.t === 'list' || b.t === 'item') return b;
    }
    return this.root;
  }

  addChild(block) {
    // A list can only contain list items. If the deepest open container
    // is a list, the list is over: close it and add the block to the
    // list's parent instead.
    let parent = this.containerTip();
    while (parent.t === 'list') {
      this.closeTo(this.stack.indexOf(parent));
      parent = this.containerTip();
    }
    parent.children.push(block);
  }

  // Close blocks down to (and including) the block at stack index k,
  // finalising each one.
  closeTo(k) {
    while (this.stack.length > k) {
      const b = this.stack.pop();
      this.finalise(b);
    }
  }

  closeLeaf() {
    const t = this.tip();
    if (t.t === 'para' || t.t === 'code' || t.t === 'html' || t.t === 'table') {
      this.stack.pop();
      this.finalise(t);
    }
  }

  finalise(b) {
    if (b.t === 'para') {
      const text = b.lines.join('\n');
      const { defs, rest } = parseRefDefs(text);
      for (const d of defs) {
        if (!this.refs.has(d.label)) this.refs.set(d.label, { dest: d.dest, title: d.title });
      }
      if (rest.trim() === '') {
        // The paragraph was only definitions: drop it from its parent.
        const parent = this.containerTip();
        const idx = parent.children.indexOf(b);
        if (idx >= 0) parent.children.splice(idx, 1);
      } else {
        b.text = rest;
        delete b.lines;
      }
    } else if (b.t === 'code' && b.fenced) {
      // A fenced code block drops its last content line when it is blank
      // (cm-318: exactly one trailing blank line is removed, whether
      // the block is closed by its fence or by EOF).
      if (b.lines.length > 0 && b.lines[b.lines.length - 1] === '') b.lines.pop();
    } else if (b.t === 'code' && !b.fenced) {
      // Strip trailing blank lines from an indented code block.
      while (b.lines.length > 0 && isBlankLine(b.lines[b.lines.length - 1])) b.lines.pop();
    } else if (b.t === 'list') {
      // A list is loose when a blank line separated blocks inside it; the
      // flag was raised while parsing.
      b.tight = !b.loose;
      delete b.loose;
      delete b.blankPending;
    }
  }

  run() {
    for (let n = 0; n < this.lines.length; n++) {
      this.processLine(this.lines[n], n === this.lines.length - 1 && !this.srcEndsNL,
        n + 1 < this.lines.length ? this.lines[n + 1] : null);
    }
    this.closeTo(1);
  }

  // Try to match the open containers against this line. Returns an object
  // {pos, col, partial, matched} where matched is the stack depth that
  // matched (containers only), or {lazy:true, ...} when the line is a lazy
  // paragraph continuation.
  matchContainers(raw) {
    let pos = 0;
    let col = 0;
    let partial = 0;
    // Walk the stack's containers from the outside in.
    let depth = 1; // stack index of the next container to match
    while (depth < this.stack.length) {
      const b = this.stack[depth];
      if (b.t !== 'quote' && b.t !== 'list' && b.t !== 'item') break;
      const blank = isBlankLine(restOf(raw, pos, partial));
      if (b.t === 'quote') {
        // Up to three spaces, then '>'. After it, one optional space is
        // consumed; a tab there is only partly consumed, leaving the
        // rest of its width as spaces in front of the content.
        const [p2, c2] = eatIndent(raw, pos, col, 3, partial);
        if (raw[p2] === '>') {
          let q = p2 + 1;
          let cq = c2 + 1;
          let qpart = 0;
          if (raw[q] === ' ') {
            q++;
            cq++;
          } else if (raw[q] === '\t') {
            const w = tabWidth(cq);
            q++;
            cq += w;
            qpart = w - 1;
          }
          pos = q;
          col = cq;
          partial = qpart;
          depth++;
          continue;
        }
        break;
      }
      if (b.t === 'list') {
        // A list continues when the line starts a new item of the same
        // kind at a column below the current item's content indent, is
        // blank, or is indented to the item's content. A marker at or
        // beyond the content indent is nested inside the item, not a
        // sibling item.
        const item = this.stack[depth + 1];
        const [p2, c2] = eatIndent(raw, pos, col, 3, partial);
        const mk = readListMarker(raw, p2, c2);
        const sameKind =
          mk &&
          mk.ordered === b.ordered &&
          (b.ordered ? mk.delim === b.delim : mk.bullet === b.bullet) &&
          item && item.t === 'item' && c2 < col + item.contentIndent;
        if (sameKind) {
          // The new item is handled in the block-start phase; the list
          // itself matches here.
          depth++;
          continue;
        }
        if (blank) {
          depth++;
          continue;
        }
        // An empty item followed by a blank line accepts no further
        // content: an indented line after it belongs outside the list
        // (cm-280). Sibling markers and blank lines still match (they
        // were handled above), so only the indented-content path ends.
        if (item && item.t === 'item' && item.children.length === 0 && b.blankPending) {
          break;
        }
        // The column of the first non-space char, in the same coordinate
        // system as contentIndent: the current position's column plus the
        // indent from here (the partial counts as the indent so far).
        // contentIndent is relative to the container-matched position,
        // so the comparison is against that position plus the offset.
        const absCol = col - partial + indentCols(raw, pos, col, partial);
        if (item && item.t === 'item' && absCol >= col + item.contentIndent) {
          depth++;
          continue;
        }
        // Fenced code inside the item keeps lines that fall short of the
        // item's indent, unless the line starts a new block (see
        // interruptsFencedCodeItem). The line stays at its current
        // position; the code block strips the opening fence's indent.
        if (item && item.t === 'item' && this.tip().t === 'code' && this.tip().fenced &&
            !interruptsFencedCodeItem(restOf(raw, pos, partial), item.contentIndent)) {
          depth++;
          continue;
        }
        break;
      }
      // item
      if (blank) {
        depth++;
        continue;
      }
      // A new sibling item of the parent list ends this item.
      {
        const parentList = this.stack[depth - 1];
        const [p2, c2] = eatIndent(raw, pos, col, 3, partial);
        const mk = readListMarker(raw, p2, c2);
        if (mk && parentList && parentList.t === 'list' &&
            mk.ordered === parentList.ordered &&
            (parentList.ordered ? mk.delim === parentList.delim : mk.bullet === parentList.bullet) &&
            c2 < col + b.contentIndent) {
          break;
        }
      }
      const absCol = col - partial + indentCols(raw, pos, col, partial);
      if (absCol >= col + b.contentIndent) {
        // Advance to the content indent: the content starts
        // contentIndent columns past the current position (the partial
        // counts as columns already consumed).
        const [p2, c2, part] = eatIndent(raw, pos, col, b.contentIndent + partial, partial);
        pos = p2;
        col = c2;
        partial = part;
        depth++;
        continue;
      }
      // Fenced code inside this item keeps the line (see the list branch
      // above); it is code content, not the end of the item.
      if (this.tip().t === 'code' && this.tip().fenced &&
          !interruptsFencedCodeItem(restOf(raw, pos, partial), b.contentIndent)) {
        depth++;
        continue;
      }
      break;
    }
    return { pos, col, partial, depth };
  }

  processLine(raw, finalNoNL, nextRaw) {
    const m = this.matchContainers(raw);
    const matchedDepth = m.depth;
    // Every container matched when the first unmatched entry is a leaf
    // (a paragraph, code block, ...) rather than a container; the leaf
    // itself is not counted by matchContainers.
    const failedTop = this.stack[matchedDepth];
    const allMatched = !failedTop || (failedTop.t !== 'quote' && failedTop.t !== 'list' && failedTop.t !== 'item');
    const tip = this.tip();
    const rest = restOf(raw, m.pos, m.partial);
    // A whitespace-only line is blank, EXCEPT a tab-only line inside a
    // table: marked treats it as a row of empty cells (a space-only line
    // is a blank separator that ends the table).
    const blank = isBlankLine(rest) && !(tip.t === 'table' && rest.includes('\t'));
    if (matchedDepth < this.stack.length) {
      // The first unmatched block decides what happens next. When it is a
      // container (quote, list or item) that failed to match, the line may
      // still be a lazy continuation of an open paragraph, provided it
      // does not start a new block. When it is a leaf, no container
      // failed, and the leaf is left for startBlocks to continue or close.
      const failed = this.stack[matchedDepth];
      const containerFailed = failed.t === 'quote' || failed.t === 'list' || failed.t === 'item';
      if (containerFailed) {
        // A list marker at the sibling position of the failed item
        // starts a new block: a same-kind marker is a new item of the
        // list (cm-302's `2.`), a different delimiter starts a new list
        // (cm-302's `3)`), and a bare marker is an empty item (cm-315).
        // The failed block may be the item itself, or the list when the
        // marker's kind differs from the list's (the list branch breaks
        // first then); the item is the next stack entry in that case.
        let newItem = false;
        if (failed.t === 'item' || failed.t === 'list') {
          const item = failed.t === 'item' ? failed : this.stack[matchedDepth + 1];
          const [p2, c2] = eatIndent(raw, m.pos, m.col, 3, m.partial);
          const mk = readListMarker(raw, p2, c2);
          if (mk && item && item.t === 'item' && c2 < m.col + item.contentIndent) {
            newItem = true;
          }
        }
        if (!blank && tip.t === 'para' && !newItem &&
            !this.startsNewBlock(raw, m.pos, m.col, m.partial, false)) {
          // A lazy continuation joins the paragraph: leading whitespace
          // below four columns is content and is kept (a lazy ` bar`
          // keeps its space); at four columns or more the indented-code
          // check consumes four columns even though the code block
          // cannot interrupt the paragraph (cm-291, cm-312).
          let content;
          if (indentCols(raw, m.pos, m.col, m.partial) >= 4) {
            const [p2, pc2, part] = eatIndent(raw, m.pos, m.col, 4, m.partial);
            content = m.pos > 0 ? expandContentTabs(raw, p2, part, pc2) : restOf(raw, p2, part);
          } else {
            content = restOf(raw, m.pos, m.partial);
          }
          // A lazy line that looks like a setext underline cannot be one
          // (a setext underline may not be lazy), so inside a blockquote
          // it is paragraph text indented four spaces, which keeps it
          // from being read as an underline (cm-093).
          if (/^(?:=+|-+)[ \t]*$/.test(content) && this.stack.some(b => b.t === 'quote')) {
            tip.lines.push('    ' + content);
          } else {
            tip.lines.push(content);
          }
          return;
        }
        this.closeTo(matchedDepth);
      }
    }
    if (blank) {
      // A whitespace-only line leaves its spaces in the open paragraph
      // when it is the document's last line without a trailing newline,
      // or when it is the last line of a blockquote (the next line does
      // not continue the quote): the quote's text is re-read without a
      // trailing newline, so the final space-only line is paragraph
      // content, not a separator (cm-241). The line still separates
      // blocks afterwards, so blankLine runs either way.
      if (allMatched && this.tip().t === 'para') {
        const rest = restOf(raw, m.pos, m.partial);
        if (rest !== '') {
          let quoteEnds = false;
          if (this.stack.some(b => b.t === 'quote')) {
            if (nextRaw === null) quoteEnds = true;
            else {
              const [p2] = eatIndent(nextRaw, 0, 0, 3, 0);
              quoteEnds = nextRaw[p2] !== '>';
            }
          }
          if (finalNoNL || quoteEnds) {
            this.tip().lines.push(rest);
          }
        }
      }
      this.blankLine(raw, m);
      return;
    }
    this.startBlocks(raw, m.pos, m.col, m.partial);
  }

  blankLine(raw, m) {
    const tip = this.tip();
    // A blank line inside a code block or an HTML block of kinds 1-5 is
    // content, not a separator, so it must not mark a list loose.
    let separator = true;
    if (tip.t === 'code') {
      if (tip.fenced) {
        // A blank line inside fenced code keeps its spaces past the
        // opening fence's indent (cm-129); it is content, not a
        // separator.
        const [p2, , part] = eatIndent(raw, m.pos, m.col, tip.fenceIndent || 0, m.partial);
        tip.lines.push(restOf(raw, p2, part));
      } else {
        // Indented code keeps the blank line's content past the 4-column
        // indent (spaces, or a partly-consumed tab's remainder as spaces).
        const [p2, , part] = eatIndent(raw, m.pos, m.col, 4, m.partial);
        tip.lines.push(restOf(raw, p2, part));
      }
      separator = false;
    } else if (tip.t === 'html') {
      if (tip.kind <= 5) {
        // Kinds 1-5 keep blank lines as content (a comment or script
        // continues across them until its closing tag, cm-179); they
        // end only at their closing tag or EOF.
        tip.lines.push('');
        separator = false;
      } else {
        // Kinds 6-7 end at a blank line.
        this.closeLeaf();
      }
    } else if (tip.t === 'para' || tip.t === 'table') {
      this.closeLeaf();
    }
    // A one-line HTML block (kinds 1-5) closed at creation is followed
    // by this blank line when it is the parent's last child and is not
    // still open on the stack (cm-308/309). A kind-1 block still open
    // keeps the blank line as content (cm-169/170), so it is excluded.
    // A tab-only blank line does NOT suppress the block's trailing
    // newline (marked keeps `-->\\n` after a tab-only separator).
    // A kind 6-7 block keeps its trailing newline only when the blank
    // line is spaces-only (a truly empty blank line strips it).
    {
      const parent = this.containerTip();
      if (parent.children.length > 0) {
        const last = parent.children[parent.children.length - 1];
        if (last.t === 'html' && !this.stack.includes(last)) {
          const rest = restOf(raw, m.pos, m.partial);
          if (last.kind <= 5) {
            // Kind 1 (<pre>/<script>/<style>) only suppresses its
            // trailing newline after a truly empty blank line; a
            // spaces-only blank line leaves the newline in place.
            // Kinds 2-5 suppress it after any blank line without a tab.
            if (last.kind === 1 ? rest === '' : !rest.includes('\t')) last.followedByBlank = true;
          } else if (/^ +$/.test(rest)) {
            last.followedByBlank = true;
          }
        }
      }
    }
    if (!separator) return;
    // A blank line inside a list marks every enclosing list
    // pending-loose (cm-325/326); the flag only takes effect when
    // another block follows inside the same list. Stop at a leaf or a
    // non-list container: a blank line inside a fenced code block or a
    // block quote does not loosen an outer list (cm-320).
    for (let k = this.stack.length - 1; k >= 0; k--) {
      const b = this.stack[k];
      if (b.t === 'list') {
        b.blankPending = true;
        continue;
      }
      if (b.t === 'item') continue;
      break;
    }
  }

  startBlocks(raw, pos, col, partial) {
    // Loop so that closing a leaf (paragraph, table, code) re-checks the
    // same line for a new block start.
    for (;;) {
      const tip = this.tip();
      // Inside a container the line's leading tabs are expanded to
      // spaces (marked's J); at the top level they are kept.
      const line = pos > 0 ? expandContentTabs(raw, pos, partial, col) : restOf(raw, pos, partial);
      // Fenced code: only the closing fence matters here. Content lines
      // lose the opening fence's indent (cm-131/132/133).
      if (tip.t === 'code' && tip.fenced) {
        const [p2, c2] = eatIndent(raw, pos, col, 3, partial);
        const l2 = restOf(raw, p2, 0);
        const fm = /^(```+|~~~+)[ \t]*$/.exec(l2);
        if (fm && fm[1][0] === tip.fence && fm[1].length >= tip.fenceLen) {
          this.closeLeaf();
          return;
        }
        const [q2, qc2, qpart] = eatIndent(raw, pos, col, tip.fenceIndent || 0, partial);
        tip.lines.push(pos > 0 ? expandContentTabs(raw, q2, qpart, qc2) : restOf(raw, q2, qpart));
        return;
      }
      // Indented code: the line must be indented four or more.
      if (tip.t === 'code' && !tip.fenced) {
        const ind = indentCols(raw, pos, col, partial);
        if (ind >= 4) {
          const [p2, c2, part] = eatIndent(raw, pos, col, 4, partial);
          tip.lines.push(pos > 0 ? expandContentTabs(raw, p2, part, c2) : restOf(raw, p2, part));
          return;
        }
        this.closeLeaf();
        continue;
      }
      // HTML block: check the end condition, else the line is content.
      if (tip.t === 'html') {
        if (tip.kind <= 5 && htmlBlockEnds(tip.kind, tip.endTag, line)) {
          tip.lines.push(line);
          this.closeLeaf();
          return;
        }
        tip.lines.push(line);
        return;
      }
      // Table: a body row, unless the line starts another block.
      if (tip.t === 'table') {
        if (this.startsNewBlock(raw, pos, col, partial, true)) {
          this.closeLeaf();
          continue;
        }
        tip.rows.push(splitTableRow(line));
        return;
      }
      // Paragraph: setext, table, or an interrupting block.
      if (tip.t === 'para') {
        const [p2] = eatIndent(raw, pos, col, 3, partial);
        const lv = setextLevel(raw, p2);
        if (lv > 0 || (indentCols(raw, pos, col, partial) <= 3 && parseDelimiterRow(raw, p2))) {
          // A paragraph that is only reference definitions is closed
          // instead: the line is re-processed as a new block (a setext
          // underline after pure definitions becomes a thematic break,
          // a delimiter row after them is just paragraph text).
          const { defs: pd, rest: pr } = parseRefDefs(tip.lines.join('\n'));
          if (pd.length > 0 && pr.trim() === '') {
            this.closeLeaf();
            continue;
          }
        }
        if (lv > 0) {
          // Reference definitions at the start of the paragraph belong
          // to the document, not to the heading; the heading text is
          // what is left, with the first line's leading spaces and the
          // last line's trailing spaces stripped.
          const { defs, rest } = parseRefDefs(tip.lines.join('\n'));
          for (const d of defs) {
            if (!this.refs.has(d.label)) this.refs.set(d.label, { dest: d.dest, title: d.title });
          }
          tip.t = 'head';
          tip.level = lv;
          tip.text = rest.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
          delete tip.lines;
          this.stack.pop();
          this.finalise(tip);
          return;
        }
        if (tip.lines.length === 1 && indentCols(raw, pos, col, partial) <= 3) {
          const aligns = parseDelimiterRow(raw, p2);
          if (aligns) {
            const head = splitTableRow(tip.lines[0]);
            if (head.length === aligns.length) {
              tip.t = 'table';
              tip.head = head;
              tip.aligns = aligns;
              tip.rows = [];
              delete tip.lines;
              return;
            }
          }
        }
        if (this.startsNewBlock(raw, pos, col, partial, false)) {
          this.closeLeaf();
          continue;
        }
        // When the remaining indent is four or more inside a list item,
        // the indented-code check consumes four columns even though the
        // code block cannot interrupt the paragraph; the line joins the
        // paragraph past those columns. In a blockquote or at the top
        // level the indent is kept (the quote's text is re-read as a
        // paragraph, which keeps its spaces).
        let pushLine = line;
        if (indentCols(raw, pos, col, partial) >= 4) {
          const parent = this.containerTip();
          if (parent.t === 'list' || parent.t === 'item') {
            const [p2, pc2, part] = eatIndent(raw, pos, col, 4, partial);
            pushLine = pos > 0 ? expandContentTabs(raw, p2, part, pc2) : restOf(raw, p2, part);
          }
        }
        tip.lines.push(pushLine);
        return;
      }
      // No leaf open: try to start a new block.
      if (this.tryStartBlock(raw, pos, col, partial)) return;
      // Otherwise the line starts (or continues) a paragraph. A new
      // paragraph after a blank line makes an enclosing list loose; only
      // the innermost list with a pending flag is marked, and outer
      // lists' flags are cleared once it is consumed (cm-319, cm-325).
      let foundLoose = false;
      for (let k = this.stack.length - 1; k >= 0; k--) {
        const b = this.stack[k];
        if (b.t === 'list') {
          if (!foundLoose && b.blankPending) {
            b.loose = true;
            b.blankPending = false;
            foundLoose = true;
          } else if (foundLoose) {
            b.blankPending = false;
          }
        }
        if (b.t === 'doc') break;
      }
      const para = { t: 'para', lines: [line] };
      this.addChild(para);
      this.stack.push(para);
      return;
    }
  }

  // Does the line, at the current position, start a block? Used to decide
  // whether a paragraph is interrupted (inTable=false) or a table ends
  // (inTable=true). Indented code only counts when inTable is true.
  startsNewBlock(raw, pos, col, partial, inTable) {
    const [p2, c2] = eatIndent(raw, pos, col, 3, partial);
    const line = restOf(raw, p2, 0);
    if (line === '') return false;
    if (isThematicBreak(raw, p2)) return true;
    if (/^#{1,6}(?:[ \t]|$)/.test(line)) return true;
    const fm = /^(```+|~~~+)(.*)$/.exec(line);
    if (fm) {
      if (fm[1][0] === '`' && fm[2].includes('`')) return false;
      return true;
    }
    const hb = htmlBlockStart(raw, p2);
    if (hb && hb.kind <= 6) return true;
    if (raw[p2] === '>') return true;
    const mk = readListMarker(raw, p2, c2);
    if (mk) {
      if (inTable) return true;
      // An ordered list may interrupt a paragraph only when it starts
      // with 1, except inside a list item, where the item text is
      // re-read with the list rule tried first, so any number
      // interrupts (doc-02, doc-04).
      const parent = this.containerTip();
      const inListItem = parent.t === 'list' || parent.t === 'item';
      if (!mk.empty && (!mk.ordered || mk.start === 1 || inListItem)) return true;
      return false;
    }
    if (inTable && indentCols(raw, pos, col, partial) >= 4) return true;
    return false;
  }

  // Try to start a new block at the current position. Returns true when a
  // block was started (the line is consumed or pushed onto a leaf).
  tryStartBlock(raw, pos, col, partial) {
    const [p2, c2] = eatIndent(raw, pos, col, 3, partial);
    const line = restOf(raw, p2, 0);
    if (line === '') return false;
    // A new block inside a list that had a blank line pending makes it loose.
    // Mark the first (innermost) list with a pending flag; a blank line
    // inside a nested list does not loosen an outer list (cm-319), so once
    // a list consumes the pending blank line, outer lists' flags are
    // cleared too. A list created after the blank line has no flag, so an
    // outer list with a flag is still marked (cm-325).
    const markLoose = () => {
      let found = false;
      for (let k = this.stack.length - 1; k >= 0; k--) {
        const b = this.stack[k];
        if (b.t === 'list') {
          if (!found && b.blankPending) {
            b.loose = true;
            b.blankPending = false;
            found = true;
          } else if (found) {
            b.blankPending = false;
          }
        }
        if (b.t === 'doc') return;
      }
    };
    // Thematic break.
    if (isThematicBreak(raw, p2)) {
      markLoose();
      this.addChild({ t: 'hr' });
      return true;
    }
    // ATX heading.
    const hm = /^(#{1,6})(?:[ \t]+(.*?)|[ \t]*)$/.exec(line);
    if (hm && (line.length === hm[1].length || line[hm[1].length] === ' ' || line[hm[1].length] === '\t')) {
      markLoose();
      let text = hm[2] === undefined ? '' : hm[2];
      text = text.replace(/[ \t]+$/, '');
      // The whole content may be a closing sequence (e.g. "### ###" -> empty).
      text = text.replace(/^[ \t]*#+$/, '');
      text = text.replace(/[ \t]+#+[ \t]*$/, '');
      text = text.replace(/[ \t]+$/, '');
      this.addChild({ t: 'head', level: hm[1].length, text });
      return true;
    }
    // Fenced code block. The opening fence's indent (up to three
    // columns) is stripped from every content line (cm-131/132/133)
    // for a backtick fence; marked does NOT strip it for a tilde
    // fence (its content keeps the fence's indent).
    const fm = /^(```+|~~~+)(.*)$/.exec(line);
    if (fm && !(fm[1][0] === '`' && fm[2].includes('`'))) {
      markLoose();
      const code = { t: 'code', fenced: true, fence: fm[1][0], fenceLen: fm[1].length, info: fm[2].trim(), lines: [], fenceIndent: fm[1][0] === '~' ? 0 : (c2 - col) };
      this.addChild(code);
      this.stack.push(code);
      return true;
    }
    // HTML block. The first line keeps its leading spaces (up to three):
    // the block is raw HTML, so the indent is part of its text.
    const hb = htmlBlockStart(raw, p2);
    if (hb) {
      markLoose();
      const firstLine = restOf(raw, pos, partial);
      const html = { t: 'html', kind: hb.kind, endTag: hb.endTag, lines: [firstLine] };
      this.addChild(html);
      if (hb.kind <= 5 && htmlBlockEnds(hb.kind, hb.endTag, firstLine)) {
        // A one-line block (e.g. a comment on one line).
        return true;
      }
      this.stack.push(html);
      return true;
    }
    // Blockquote. After '>' one optional space is consumed; a tab there
    // is only partly consumed, leaving the rest of its width as spaces
    // in front of the quoted content.
    if (raw[p2] === '>') {
      markLoose();
      const quote = { t: 'quote', children: [] };
      this.addChild(quote);
      this.stack.push(quote);
      let q = p2 + 1;
      let cq = c2 + 1;
      let qpart = 0;
      if (raw[q] === ' ') {
        q++;
        cq++;
      } else if (raw[q] === '\t') {
        const w = tabWidth(cq);
        q++;
        cq += w;
        qpart = w - 1;
      }
      if (restOf(raw, q, qpart) !== '') {
        this.startBlocks(raw, q, cq, qpart);
      }
      return true;
    }
    // List item. The item belongs to the open list on the stack when it
    // matches, otherwise to a matching open list that is the parent's
    // last child, otherwise to a fresh list.
    const mk = readListMarker(raw, p2, c2);
    if (mk) {
      markLoose();
      const tipC = this.containerTip();
      let list = null;
      if (tipC.t === 'list' && tipC.ordered === mk.ordered &&
          (mk.ordered ? tipC.delim === mk.delim : tipC.bullet === mk.bullet)) {
        list = tipC;
      } else {
        const last = tipC.children[tipC.children.length - 1];
        if (last && last.t === 'list' && last.ordered === mk.ordered &&
            (mk.ordered ? last.delim === mk.delim : last.bullet === mk.bullet) &&
            this.stack.includes(last)) {
          list = last;
        }
      }
      if (!list) {
        list = { t: 'list', ordered: mk.ordered, start: mk.start, delim: mk.delim, bullet: mk.bullet, tight: true, loose: false, blankPending: false, children: [] };
        this.addChild(list);
        this.stack.push(list);
      }
      // contentIndent is stored relative to the container-matched
      // position (col): the document column of a continuation line
      // depends on its own container prefixes (a quote prefix may be
      // shorter than the opening line's), so only the offset from the
      // container-matched position is stable across lines (cm-259).
      // It is NOT relative to the marker: the marker may itself be
      // indented up to three spaces inside the container (cm-257).
      const item = { t: 'item', children: [], contentIndent: mk.contentIndent - col, markerCol: c2, task: null };
      list.children.push(item);
      this.stack.push(item);
      // The rest of the line is the item's first content. A task marker is
      // stripped here, and what follows is paragraph text, never another
      // block start.
      const rest = restOf(raw, mk.endPos, mk.partial || 0);
      const tm = /^\[([ xX])\][ \t]+/.exec(rest);
      if (tm && rest.slice(tm[0].length) !== '') {
        item.task = tm[1] === ' ' ? ' ' : 'x';
        const para = { t: 'para', lines: [rest.slice(tm[0].length)] };
        item.children.push(para);
        this.stack.push(para);
        return true;
      }
      if (rest !== '') {
        // The first content line may itself start a block (a heading, a
        // fence, a nested list, ...).
        this.startBlocks(raw, mk.endPos, mk.endCol, mk.partial || 0);
      }
      return true;
    }
    // Indented code block.
    if (indentCols(raw, pos, col, partial) >= 4) {
      markLoose();
      const [p3, c3, part] = eatIndent(raw, pos, col, 4, partial);
      const code = { t: 'code', fenced: false, info: '', lines: [pos > 0 ? expandContentTabs(raw, p3, part, c3) : restOf(raw, p3, part)] };
      this.addChild(code);
      this.stack.push(code);
      return true;
    }
    return false;
  }
}

// ---------- inline parsing ----------

function isPunct(ch) {
  // CommonMark's "Unicode punctuation character" is general categories
  // P (punctuation) and S (symbols): '$', '£' and '€' count, so '*$*'
  // is not emphasis.
  return ch !== '' && /[\p{P}\p{S}]/u.test(ch);
}
function isWS(ch) {
  return ch !== '' && /\s/.test(ch);
}
function cleanHref(dest) {
  let enc = dest;
  try {
    // marked's `he`: encodeURI, then turn %25 back into % so that a
    // percent-escape the author wrote (e.g. %20) survives verbatim.
    enc = encodeURI(dest).replace(/%25/g, '%');
  } catch (e) {
    enc = dest;
  }
  return escapeAttr(enc);
}
// Is a link label (raw text between '[' and ']') bracket-balanced the way
// marked's label regex requires it: brackets nest at most two deep, and a
// '[' or ']' inside a code span or after a backslash does not count.
function labelBalanced(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '`') {
      let j = i;
      while (j < s.length && s[j] === '`') j++;
      const len = j - i;
      let k = j;
      let found = -1;
      while (k < s.length) {
        if (s[k] === '`') {
          let m = k;
          while (m < s.length && s[m] === '`') m++;
          if (m - k === len) {
            found = m;
            break;
          }
          k = m;
        } else {
          k++;
        }
      }
      if (found === -1) {
        i = j - 1;
        continue;
      }
      i = found - 1;
      continue;
    }
    if (c === '[') {
      if (depth >= 2) return false;
      depth++;
    } else if (c === ']') {
      if (depth === 0) return false;
      depth--;
    }
  }
  return depth === 0;
}

function resolveLink(s, j, label, refs) {
  if (s[j] === '(') {
    let k = skipSpaceLines(s, j + 1);
    // An empty destination is a valid link (href="").
    if (s[k] === ')') return { dest: '', title: null, next: k + 1 };
    const dest = parseDestination(s, k);
    if (dest) {
      k = skipSpaceLines(s, dest.end);
      let title = null;
      let ok = true;
      if (s[k] === '"' || s[k] === "'" || s[k] === '(') {
        const t = parseTitle(s, k);
        if (!t) ok = false;
        else {
          title = t.title;
          k = skipSpaceLines(s, t.end);
        }
      }
      if (ok && s[k] === ')') return { dest: dest.dest, title, next: k + 1 };
    }
    // Not a valid inline link: fall through to the reference forms
    // (cm-568: `[foo](not a link)` links as the `[foo]` reference).
  }
  if (s[j] === '[') {
    if (s[j + 1] === ']') {
      // Collapsed reference: the label is the link text itself.
      const ref = refs.get(normaliseLabel(label));
      if (!ref) return null;
      return { dest: ref.dest, title: ref.title, next: j + 2 };
    }
    const lab = parseLabel(s, j);
    if (!lab) return null;
    const ref = refs.get(normaliseLabel(lab.label));
    if (!ref) return null;
    return { dest: ref.dest, title: ref.title, next: lab.end };
  }
  const ref = refs.get(normaliseLabel(label));
  if (!ref) return null;
  return { dest: ref.dest, title: ref.title, next: j };
}
function tryEntity(s, i) {
  const m = /^&([A-Za-z][A-Za-z0-9]*|#[0-9]{1,7}|#[xX][0-9A-Fa-f]{1,6});/.exec(s.slice(i));
  if (!m) return null;
  const body = m[1];
  if (body[0] === '#') {
    let cp;
    if (body[1] === 'x' || body[1] === 'X') cp = parseInt(body.slice(2), 16);
    else cp = parseInt(body.slice(1), 10);
    if (!cp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
    return { text: String.fromCodePoint(cp), next: i + m[0].length, verbatim: false };
  }
  return { text: m[0], next: i + m[0].length, verbatim: true };
}
function tryRawHtml(s, i) {
  if (s.startsWith('<!--', i)) {
    // Abrupt closings: <!--> and <!---> are complete empty comments,
    // so a later --> is plain text (cm-626).
    if (s.startsWith('<!-->', i)) return { html: '<!-->', next: i + 5 };
    if (s.startsWith('<!--->', i)) return { html: '<!--->', next: i + 6 };
    const end = s.indexOf('-->', i + 4);
    if (end !== -1) {
      const content = s.slice(i + 4, end);
      // The content must not start with '>' or '->', and must not end
      // with '-'. A '--' inside the content is allowed (cm-625).
      if (!content.startsWith('>') && !content.startsWith('->') &&
          !content.endsWith('-')) {
        return { html: s.slice(i, end + 3), next: end + 3 };
      }
    }
    return null;
  }
  if (s.startsWith('<?', i)) {
    const end = s.indexOf('?>', i + 2);
    if (end !== -1) return { html: s.slice(i, end + 2), next: end + 2 };
    return null;
  }
  if (s.startsWith('<![CDATA[', i)) {
    const end = s.indexOf(']]>', i + 9);
    if (end !== -1) return { html: s.slice(i, end + 3), next: end + 3 };
    return null;
  }
  if (s.startsWith('<!', i) && /[A-Za-z]/.test(s[i + 2] || '')) {
    const end = s.indexOf('>', i + 2);
    if (end !== -1) return { html: s.slice(i, end + 1), next: end + 1 };
    return null;
  }
  // A tag: an open tag with valid attributes, or a closing tag with no
  // attributes (cm-624). The two shapes are checked separately because
  // a closing tag must not carry attributes.
  const attr = "(?:[ \\t\\n]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \\t\\n]*=[ \\t\\n]*(?:[^ \\t\\n\"'=<>\\x60]+|'[^']*'|\"[^\"]*\"))?)*";
  const open = new RegExp('^<[A-Za-z][A-Za-z0-9-]*' + attr + '[ \\t\\n]*\\/?>').exec(s.slice(i));
  if (open) return { html: open[0], next: i + open[0].length };
  const close = /^<\/[A-Za-z][A-Za-z0-9-]*[ \t\n]*>/.exec(s.slice(i));
  if (close) return { html: close[0], next: i + close[0].length };
  return null;
}
function tryAutolink(s, i) {
  const m = /^<([A-Za-z][A-Za-z0-9.+-]{1,31}:[^<>\s]*)>/.exec(s.slice(i));
  if (m) return { dest: m[1], display: m[1], next: i + m[0].length };
  const e = /^<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)>/.exec(s.slice(i));
  if (e) return { dest: 'mailto:' + e[1], display: e[1], next: i + e[0].length };
  // No loose form: a space inside the brackets voids the bracketed
  // autolink (cm-602), the `<` stays literal text and the bare URL is
  // picked up by the GFM autolink instead.
  return null;
}
function matchDomain(s, i) {
  let j = i;
  let end = -1;
  let dots = 0;
  for (;;) {
    const start = j;
    while (j < s.length && /[A-Za-z0-9_-]/.test(s[j])) j++;
    if (j === start) break;
    end = j;
    if (s[j] === '.') {
      dots++;
      j++;
      continue;
    }
    break;
  }
  return { end, dots };
}
function truncateUnbalancedParen(url) {
  const stack = [];
  for (let k = 0; k < url.length; k++) {
    if (url[k] === '(') stack.push(k);
    else if (url[k] === ')') {
      if (stack.length) stack.pop();
    }
  }
  if (stack.length) return url.slice(0, stack[0]);
  return url;
}
function stripTrailingPunct(url) {
  for (;;) {
    if (url === '') return url;
    const last = url[url.length - 1];
    if ('?!.,:;*_~\'"'.includes(last)) {
      url = url.slice(0, -1);
      continue;
    }
    if (last === ')') {
      let open = 0;
      let close = 0;
      for (const c of url) {
        if (c === '(') open++;
        else if (c === ')') close++;
      }
      if (close > open) {
        url = url.slice(0, -1);
        continue;
      }
    }
    return url;
  }
}
function tryGfmAutolink(s, i, prevChar, inBrackets, inUndEm) {
  // The www / scheme / mailto forms must be preceded by the start of the
  // text, whitespace, or one of * _ ~ (. An email address has no such
  // restriction: its local part is matched greedily from wherever it
  // starts.
  const prevOk = prevChar === '' || isWS(prevChar) || '*_~('.includes(prevChar);
  let url = null;
  let prefix = '';
  let withPath = true;
  if (s.startsWith('www.', i)) {
    if (!prevOk) return null;
    const d = matchDomain(s, i + 4);
    if (d.end === -1) return null;
    url = s.slice(i, d.end);
    prefix = 'http://';
  } else {
    const sm = /^(https?|ftp):\/\//i.exec(s.slice(i));
    if (sm) {
      // A bare scheme URL links wherever it starts (even after a letter
      // or `<`: cm-602's `<https://...>` links the URL after the literal
      // `<`); only the www form needs a preceding boundary.
      const d = matchDomain(s, i + sm[0].length);
      if (d.end === -1) return null;
      url = s.slice(i, d.end);
    } else if (s.startsWith('mailto:', i)) {
      if (!prevOk) return null;
      const em = /^([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)/.exec(s.slice(i + 7));
      if (!em) return null;
      // A trailing `-` or `_` on the address voids the whole autolink
      // (gfm-633: `mailto:a.b-c_d@a.b-` is literal text), unless the
      // `_` is the closing delimiter of an open `_` emphasis.
      const after = i + 7 + em[1].length;
      if ((s[after] === '-' || s[after] === '_') && !(s[after] === '_' && inUndEm)) return null;
      url = 'mailto:' + em[1];
      withPath = false;
    } else {
      // A scheme followed by an email address is one autolink, with an
      // optional single path segment after the address (gfm-633/634/635);
      // `mailto:` above is the exception and takes no segment.
      const sm = /^([A-Za-z][A-Za-z0-9+.-]{1,31}):([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)/.exec(s.slice(i));
      if (sm && prevOk) {
        const after = i + sm[0].length;
        // A trailing `-` or `_` voids the autolink, unless the `_` is
        // the closing delimiter of an open `_` emphasis.
        if ((s[after] !== '-' && s[after] !== '_') || (s[after] === '_' && inUndEm)) {
          url = sm[0];
          const seg = /^\/[A-Za-z0-9.!#$%&'*+=?^_`{|}~@-]+/.exec(s.slice(after));
          if (seg) url += seg[0];
          withPath = false;
        }
      }
      if (url === null) {
        const em = /^([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+)@/.exec(s.slice(i));
        if (!em) return null;
        const d = matchDomain(s, i + em[0].length);
        if (d.end === -1 || d.dots === 0) return null;
        // A domain ending in `-` or `_` voids the whole address
        // (gfm-632): the trailing run is not a valid label ending,
        // unless the `_` run is the closing delimiter of an open `_`
        // emphasis (the email is lexed inside the emphasis, without
        // the delimiter), in which case the domain is trimmed there.
        let dend = d.end;
        while (dend > i + em[0].length && (s[dend - 1] === '-' || s[dend - 1] === '_')) dend--;
        if (dend !== d.end) {
          const tail = s.slice(dend, d.end);
          if (/^_+$/.test(tail) && inUndEm) d.end = dend;
          else return null;
        }
        url = s.slice(i, d.end);
        prefix = 'mailto:';
        withPath = false;
      }
    }
  }
  if (url === null) return null;
  let end = i + url.length;
  if (withPath) {
    let j = end;
    // Inside a link label the path stops at `]` (the label's close):
    // otherwise the autolink swallows the `]` and the link never
    // resolves (doc-03/06/09/10/12/16/19).
    while (j < s.length && !/\s/.test(s[j]) && s[j] !== '<' && !(inBrackets && s[j] === ']')) j++;
    url = s.slice(i, j);
    end = j;
  }
  url = truncateUnbalancedParen(url);
  // A trailing entity reference is not part of the autolink (gfm-627):
  // `...&hl;` links only up to the `&`. This runs before the punctuation
  // trim, which would otherwise strip the `;` and hide the entity.
  url = url.replace(/&(?:[A-Za-z][A-Za-z0-9]*|#[0-9]+|#[xX][0-9A-Fa-f]+);$/, '');
  url = stripTrailingPunct(url);
  if (url === '') return null;
  return { dest: prefix + url, display: url, next: i + url.length };
}

// Decode the HTML entities that the inline renderer emits, so a plain
// text derived from rendered HTML round-trips through escapeAttr.
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|#39);/g, (m, e) => {
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === '#39') return "'";
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (Number.isFinite(n) && n > 0 && n <= 0x10FFFF) return String.fromCodePoint(n);
    }
    return m;
  });
}

// Plain text of an image label's source: parse it as inline markdown and
// reduce the HTML to text. Emphasis/code/links contribute their text,
// a nested image contributes its alt text, raw HTML is stripped.
function altTextOfLabel(labelSource, refs) {
  const html = parseInline(labelSource, refs);
  const withAlts = html.replace(/<img\b[^>]*\balt="([^"]*)"[^>]*>/g, (m, alt) => decodeEntities(alt));
  const stripped = withAlts.replace(/<[^>]*>/g, '');
  return decodeEntities(stripped);
}

// Plain text of a run of inline tokens (used for link labels and image
// alt text): code spans contribute their content, entities and raw HTML
// contribute their literal text, delimiters contribute their characters.
function labelTextOf(tokens, from, to) {
  let out = '';
  for (let k = from; k < to; k++) {
    const tok = tokens[k];
    if (tok.t === 'text' || tok.t === 'code' || tok.t === 'html') out += tok.s;
    else if (tok.t === 'd') out += tok.ch.repeat(tok.len);
    else if (tok.t === '!') out += '!';
    else if (tok.t === '[') out += '[';
    else if (tok.t === 'br' || tok.t === 'nl') out += '\n';
    else if (tok.t === 'auto') out += tok.display;
  }
  return out;
}

// Resolve emphasis and strikethrough over the delimiter stack. A closer
// searches backwards for a matching opener; the odd-match rule (a sum of
// lengths divisible by 3) blocks the match when either side can both open
// and close. A run that is used partly keeps the rest as literal text:
// the rest comes before the tags it opens and after the tags it closes.
function processEmphasis(tokens, delims) {
  // Each delimiter may only pair with a delimiter at or before its
  // maxPair index. When a pair (opener j, closer i) is formed, every
  // delimiter trapped between them can no longer pair with a delimiter
  // past i, so emphasis stays properly nested.
  for (const d of delims) d.maxPair = Infinity;
  for (let i = 0; i < delims.length; i++) {
    const closer = delims[i];
    if (!closer.canClose || closer.tok.len === 0) continue;
    let j = i - 1;
    while (j >= 0 && closer.tok.len > 0) {
      const opener = delims[j];
      if (opener.ch !== closer.ch) {
        j--;
        continue;
      }
      if (!opener.canOpen || opener.tok.len === 0) {
        j--;
        continue;
      }
      // A delimiter inside a link's text may only pair with one inside
      // the same link (or with one outside any link, when both are).
      if ((opener.linkCtx || 0) !== (closer.linkCtx || 0)) {
        j--;
        continue;
      }
      // Strikethrough pairs only when the two runs have the same length
      // and that length is 1 or 2 (marked's del rule is a backreference:
      // `~~x~`, `~x~~`, `~~~x~~~` and longer runs never form a pair).
      if (opener.ch === '~' && (opener.tok.len !== closer.tok.len || opener.tok.len > 2)) {
        j--;
        continue;
      }
      if ((opener.canOpen && opener.canClose) || (closer.canOpen && closer.canClose)) {
        if ((opener.tok.len + closer.tok.len) % 3 === 0 &&
            (opener.tok.len % 3 !== 0 || closer.tok.len % 3 !== 0)) {
          j--;
          continue;
        }
      }
      // A trapped opener cannot reach past the pair that trapped it.
      if (opener.maxPair < i) {
        j--;
        continue;
      }
      const use = opener.ch === '~' ? opener.tok.len : (opener.tok.len >= 2 && closer.tok.len >= 2 ? 2 : 1);
      const tag = opener.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
      opener.tok.openTags.push(tag);
      closer.tok.closeTags.push(tag);
      opener.tok.len -= use;
      closer.tok.len -= use;
      // Trap every delimiter between this opener and closer.
      for (let k = j + 1; k < i; k++) {
        if (delims[k].maxPair > i) delims[k].maxPair = i;
      }
      // If the opener still has length, retry it (e.g. '***' gives both
      // <em> and <strong>); only move to an earlier opener once it is
      // exhausted.
      if (opener.tok.len === 0) j--;
    }
  }
}

function renderInlineTokens(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.t) {
      case 'text':
        out += escapeText(tok.s);
        break;
      case 'code':
        out += '<code>' + escapeText(tok.s) + '</code>';
        break;
      case 'html':
        out += tok.s;
        break;
      case 'br':
        out += '<br>';
        break;
      case 'nl':
        out += '\n';
        break;
      case 'd':
        for (const tag of tok.closeTags) out += '</' + tag + '>';
        if (tok.len > 0) out += tok.ch.repeat(tok.len);
        for (let k = tok.openTags.length - 1; k >= 0; k--) out += '<' + tok.openTags[k] + '>';
        break;
      case 'aopen': {
        out += '<a href="' + cleanHref(tok.dest) + '"';
        if (tok.title) out += ' title="' + escapeAttr(tok.title) + '"';
        out += '>';
        break;
      }
      case 'aclose':
        out += '</a>';
        break;
      case 'auto':
        out += '<a href="' + cleanHref(tok.dest) + '">' + escapeText(tok.display) + '</a>';
        break;
      case 'img': {
        out += '<img src="' + cleanHref(tok.dest) + '" alt="' + escapeAttr(tok.alt) + '"';
        if (tok.title) out += ' title="' + escapeAttr(tok.title) + '"';
        out += '>';
        break;
      }
      case '!':
        out += '!';
        break;
      case '[':
        out += '[';
        break;
      default:
        break;
    }
  }
  return out;
}

// The inline scanner: one left-to-right pass over the paragraph text,
// producing tokens; links are resolved as their closing bracket is seen,
// emphasis and strikethrough are resolved afterwards.
function parseInline(text, refs) {
  const tokens = [];
  const delims = [];
  const links = [];
  // A counter for link ids; a delimiter's linkCtx is the id of the link
  // whose text it sits in (0 = outside any link).
  let linkSeq = 0;
  // How many `_` emphasis runs are currently open (a trailing `_` after
  // an email closes one of these, so the email still links; a literal
  // `_` with none open voids the email autolink).
  let undOpen = 0;
  const n = text.length;
  let i = 0;
  const pushText = (s) => {
    if (s === '') return;
    const last = tokens[tokens.length - 1];
    if (last && last.t === 'text') last.s += s;
    else tokens.push({ t: 'text', s });
  };
  while (i < n) {
    const c = text[i];
    if (c === '\n') {
      const last = tokens[tokens.length - 1];
      if (last && last.t === 'text') {
        const m = / {2,}$/.exec(last.s);
        if (m) {
          last.s = last.s.slice(0, last.s.length - m[0].length);
          if (last.s === '') tokens.pop();
          tokens.push({ t: 'br' });
          i++;
          // A hard break strips the leading spaces of the next line
          // (cm-636/637).
          while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
          continue;
        }
      }
      tokens.push({ t: 'nl' });
      i++;
      continue;
    }
    if (c === '\\') {
      const nx = text[i + 1];
      if (nx === '\n') {
        tokens.push({ t: 'br' });
        i += 2;
        // A hard break strips the leading spaces of the next line
        // (cm-637).
        while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
        continue;
      }
      if (nx !== undefined && PUNCT.has(nx)) {
        pushText(nx);
        i += 2;
        continue;
      }
      pushText('\\');
      i++;
      continue;
    }
    if (c === '`') {
      let j = i;
      while (j < n && text[j] === '`') j++;
      const len = j - i;
      let k = j;
      let found = -1;
      while (k < n) {
        if (text[k] === '`') {
          let e = k;
          while (e < n && text[e] === '`') e++;
          if (e - k === len) {
            found = k;
            break;
          }
          k = e;
        } else k++;
      }
      if (found !== -1) {
        let content = text.slice(j, found).replace(/\n/g, ' ');
        if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') {
          content = content.slice(1, -1);
        }
        tokens.push({ t: 'code', s: content });
        i = found + len;
        continue;
      }
      pushText(text.slice(i, j));
      i = j;
      continue;
    }
    if (c === '!' && text[i + 1] === '[') {
      tokens.push({ t: '!' });
      i++;
      continue;
    }
    if (c === '[') {
      // Remember the character position (for the raw label text) and
      // whether this opens an image (a '!' token just before it).
      const tok = { t: '[', active: true, pos: i, image: tokens.length > 0 && tokens[tokens.length - 1].t === '!' };
      tokens.push(tok);
      links.push(tok);
      i++;
      continue;
    }
    if (c === ']') {
      let li = -1;
      for (let k = links.length - 1; k >= 0; k--) {
        if (links[k].active) {
          li = k;
          break;
        }
      }
      if (li === -1) {
        pushText(']');
        i++;
        continue;
      }
      const openTok = links[li];
      const openIdx = tokens.indexOf(openTok);
      // The label must be bracket-balanced in the raw text; an unbalanced
      // label means this ']' does not close the opener at all, so the
      // opener stays alive for a later ']' (e.g. cm-520).
      if (!labelBalanced(text.slice(openTok.pos + 1, i))) {
        pushText(']');
        i++;
        continue;
      }
      const label = labelTextOf(tokens, openIdx + 1, tokens.length);
      // The reference lookup uses the RAW label text (backslashes kept:
      // `[bar][foo\!]` does not match a `[foo!]` definition).
      const rawLabel = text.slice(openTok.pos + 1, i);
      const res = resolveLink(text, i + 1, rawLabel, refs);
      if (res) {
        const isImage = openIdx > 0 && tokens[openIdx - 1].t === '!';
        if (isImage) {
          const imgTok = tokens[openIdx - 1];
          imgTok.t = 'img';
          imgTok.dest = res.dest;
          imgTok.title = res.title;
          // The alt text is the label parsed as inline markdown and
          // reduced to plain text (emphasis resolved, nested images
          // contribute their alt), not the raw label source.
          imgTok.alt = altTextOfLabel(rawLabel, refs);
          tokens.splice(openIdx, tokens.length - openIdx);
          for (let d = delims.length - 1; d >= 0; d--) {
            if (delims[d].tokIdx >= openIdx) delims.splice(d, 1);
          }
        } else {
          openTok.t = 'aopen';
          openTok.dest = res.dest;
          openTok.title = res.title;
          // GFM autolinks are not created inside a link's text (the
          // label is read with inLink set), while `<...>` autolinks
          // are: flatten the GFM ones to plain text, keep the others.
          for (let k = openIdx + 1; k < tokens.length; k++) {
            if (tokens[k].t === 'auto' && tokens[k].gfm) {
              tokens[k] = { t: 'text', s: tokens[k].display };
            }
          }
          tokens.push({ t: 'aclose' });
          // A link may not contain another link: every link opener still
          // pending is deactivated (an image opener is not).
          for (let k = 0; k < links.length; k++) {
            if (links[k] !== openTok && !links[k].image) links[k].active = false;
          }
          // Emphasis may not pair across this link's boundary: mark every
          // delimiter inside the link text with this link's id.
          linkSeq++;
          for (let d = 0; d < delims.length; d++) {
            if (delims[d].tokIdx > openIdx) delims[d].linkCtx = linkSeq;
          }
        }
        links.splice(li);
        i = res.next;
        continue;
      }
      // No link here: this opener can never form one, so it is dead.
      openTok.active = false;
      pushText(']');
      i++;
      continue;
    }
    if (c === '<') {
      const au = tryAutolink(text, i);
      if (au) {
        tokens.push({ t: 'auto', dest: au.dest, display: au.display });
        i = au.next;
        continue;
      }
      const rh = tryRawHtml(text, i);
      if (rh) {
        // A raw `<a>` opening tag sets inLink (suppressing GFM
        // autolinks until a raw `</a>` clears it); other tags do not.
        if (/^<a(?=[\s>])/i.test(rh.html)) refs.inLink = true;
        else if (/^<\/a(?=[\s>])/i.test(rh.html)) refs.inLink = false;
        tokens.push({ t: 'html', s: rh.html });
        i = rh.next;
        continue;
      }
      pushText('<');
      i++;
      continue;
    }
    if (c === '&') {
      const en = tryEntity(text, i);
      if (en) {
        if (en.verbatim) tokens.push({ t: 'html', s: en.text });
        else pushText(en.text);
        i = en.next;
        continue;
      }
      pushText('&');
      i++;
      continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      let j = i;
      while (j < n && text[j] === c) j++;
      const len = j - i;
      const prev = i > 0 ? text[i - 1] : '';
      const next = j < n ? text[j] : '';
      // Flanking: the start/end of the text count as whitespace.
      const prevWS = prev === '' || isWS(prev);
      const nextWS = next === '' || isWS(next);
      const leftF = !nextWS && (!isPunct(next) || prevWS || isPunct(prev));
      const rightF = !prevWS && (!isPunct(prev) || nextWS || isPunct(next));
      let canOpen;
      let canClose;
      if (c === '_') {
        canOpen = leftF && (!rightF || isPunct(prev));
        canClose = rightF && (!leftF || isPunct(next));
      } else {
        canOpen = leftF;
        canClose = rightF;
      }
      const tok = { t: 'd', ch: c, len, canOpen, canClose, openTags: [], closeTags: [] };
      tokens.push(tok);
      delims.push({ tok, tokIdx: tokens.length - 1, ch: c, canOpen, canClose, linkCtx: 0 });
      // Track open `_` emphasis for the GFM email rule below: a `_`
      // that can close closes one open run, otherwise one that can open
      // opens a run.
      if (c === '_') {
        if (canClose && undOpen > 0) undOpen--;
        else if (canOpen) undOpen++;
      }
      i = j;
      continue;
    }
    // GFM extended autolink: try it whenever the character could start
    // one (a www/scheme/mailto prefix, or an email local part), unless
    // a raw `<a>` tag has set inLink (or we are inside a link's text,
    // which the `]` handler flattens below).
    if (/[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]/.test(c) && !refs.inLink) {
      const prev = i > 0 ? text[i - 1] : '';
      const inBrackets = links.some(l => l.active);
      const g = tryGfmAutolink(text, i, prev, inBrackets, undOpen > 0);
      if (g) {
        tokens.push({ t: 'auto', dest: g.dest, display: g.display, gfm: true });
        i = g.next;
        continue;
      }
    }
    pushText(c);
    i++;
  }
  processEmphasis(tokens, delims);
  return renderInlineTokens(tokens);
}

// ---------- rendering ----------

function renderBlocks(node, refs) {
  const out = [];
  for (const b of node.children) renderBlock(b, refs, out);
  return out.join('');
}

function renderBlock(b, refs, out) {
  switch (b.t) {
    case 'para':
      out.push('<p>' + parseInline(b.text, refs) + '</p>\n');
      break;
    case 'head':
      out.push('<h' + b.level + '>' + parseInline(b.text, refs) + '</h' + b.level + '>\n');
      break;
    case 'hr':
      out.push('<hr>\n');
      break;
    case 'code': {
      const content = b.lines.join('\n') + (b.lines.length ? '\n' : '');
      if (b.fenced) {
        // Backslash escapes in the info string are decoded before the
        // language word is taken (cm-024: `foo\+bar` -> `foo+bar`).
        const info = (b.info.split(/\s+/)[0] || '').replace(/\\([!-/:-@[-`{-~])/g, '$1');
        out.push('<pre><code' + (info ? ' class="language-' + escapeAttr(info) + '"' : '') + '>' + escapeText(content) + '</code></pre>\n');
      } else {
        out.push('<pre><code>' + escapeText(content) + '</code></pre>\n');
      }
      break;
    }
    case 'html': {
      // Kinds 1-5 end on the line that closes them, so their text keeps
      // that line's newline — unless a blank line follows the block, in
      // which case no trailing newline is emitted (cm-308/309). Kinds
      // 6-7 end at a blank line, whose newline is stripped (marked's
      // `ge`) — except a spaces-only blank line, which leaves a trailing
      // newline. A trailing newline at the very end of the document is
      // supplied by parse() instead.
      const body = b.lines.join('\n');
      if (b.kind <= 5) {
        out.push(!b.followedByBlank ? body + '\n' : body);
      } else {
        out.push(b.followedByBlank ? body + '\n' : body);
      }
      break;
    }
    case 'quote':
      out.push('<blockquote>\n');
      for (const child of b.children) renderBlock(child, refs, out);
      out.push('</blockquote>\n');
      break;
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      const attrs = b.ordered && b.start !== 1 ? ' start="' + b.start + '"' : '';
      out.push('<' + tag + attrs + '>\n');
      for (const item of b.children) renderItem(item, b, refs, out);
      out.push('</' + tag + '>\n');
      break;
    }
    case 'table': {
      out.push('<table>\n<thead>\n<tr>\n');
      for (let k = 0; k < b.head.length; k++) {
        const a = b.aligns[k];
        out.push('<th' + (a ? ' align="' + a + '"' : '') + '>' + parseInline(b.head[k], refs) + '</th>\n');
      }
      out.push('</tr>\n</thead>\n');
      if (b.rows.length > 0) {
        out.push('<tbody>');
        for (const row of b.rows) {
          out.push('<tr>\n');
          for (let k = 0; k < b.head.length; k++) {
            const a = b.aligns[k];
            const cell = k < row.length ? row[k] : '';
            out.push('<td' + (a ? ' align="' + a + '"' : '') + '>' + parseInline(cell, refs) + '</td>\n');
          }
          out.push('</tr>\n');
        }
        out.push('</tbody>');
      }
      out.push('</table>\n');
      break;
    }
    default:
      break;
  }
}

// A list item. In a tight list a paragraph child renders as bare inline
// HTML; in a loose list it gets <p> tags. Other blocks render as usual.
// A task checkbox, when present, opens the item's first paragraph (or,
// failing that, precedes its first block).
function renderItem(item, list, refs, out) {
  out.push('<li>');
  const tight = list.tight;
  const taskHtml = item.task === null
    ? ''
    : item.task === 'x'
      ? '<input checked="" disabled="" type="checkbox"> '
      : '<input disabled="" type="checkbox"> ';
  for (let k = 0; k < item.children.length; k++) {
    const child = item.children[k];
    if (child.t === 'para') {
      const inner = parseInline(child.text, refs);
      if (tight) {
        out.push((k === 0 ? taskHtml : '') + inner);
      } else {
        out.push('<p>' + (k === 0 ? taskHtml : '') + inner + '</p>\n');
      }
    } else {
      if (k === 0 && taskHtml) out.push(taskHtml);
      renderBlock(child, refs, out);
    }
  }
  out.push('</li>\n');
}
