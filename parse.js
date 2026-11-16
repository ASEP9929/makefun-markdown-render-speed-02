// A CommonMark 0.31.2 + GFM 0.29 renderer that matches marked 18.1.3's
// default output byte for byte. Written from the spec and from the
// practice set's expected outputs. Dependency-free ES module.
//
// Layout of the implementation:
//   * Scan    - a per-line cursor that understands tab stops, so block
//               structure can consume indentation without losing the
//               remainder of a partially used tab.
//   * Blocks  - a container-stack walk over the lines, turning them into
//               a small tree of block nodes (paragraphs, headings, lists,
//               quotes, code, html, tables).
//   * Inlines - a scanner over a block's raw text that builds pieces and
//               then resolves emphasis with a delimiter stack, links with a
//               bracket stack, and GFM autolinks.
//   * Render  - the tree and the inline pieces are turned into HTML.

const PUNCT = '!\"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';

function isSpaceCh(c) {
  if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') return true;
  // Unicode whitespace (U+00A0 and friends) counts too: a `*` next
  // to one cannot flank.
  return c !== '' && /\s/u.test(c);
}

function isAsciiPunct(c) {
  return c.length === 1 && PUNCT.indexOf(c) !== -1;
}

function isDigitCh(c) {
  return c >= '0' && c <= '9';
}

function isAlphaCh(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

function isWordCh(c) {
  return isAlphaCh(c) || isDigitCh(c) || c === '_';
}

// ---------------------------------------------------------------------------
// Escaping.
//
// Text and attribute values: & < > " ' are escaped, except that an & that
// starts something shaped like an entity (&word; or &#digits; or &#xhex;)
// is left alone -- marked keeps those spellings verbatim. Numeric entities
// are decoded elsewhere, so by the time text reaches this function the
// only &s left are literal ones or named-entity spellings.
// Code content: & < > " ' are escaped unconditionally.
const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeText(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '&') {
      const m = /^&(?:#\d+;|#[xX][0-9A-Fa-f]+;|[A-Za-z][A-Za-z0-9]*;)/.exec(s.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
      out += '&amp;';
      i++;
      continue;
    }
    const rep = ESCAPE_MAP[c];
    if (rep !== undefined) {
      out += rep;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function escapeCode(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const rep = ESCAPE_MAP[s[i]];
    out += rep !== undefined ? rep : s[i];
  }
  return out;
}

// Decode one numeric entity starting at s[i] (s[i] === '&'). Returns
// [decodedChar, lengthConsumed] or null when it is not a decodable
// numeric entity. 0 and surrogates become U+FFFD; values above the
// Unicode range are not decodable at all.
function decodeNumeric(s, i) {
  let j = i + 1;
  if (s[j] !== '#') return null;
  j++;
  let hex = false;
  if (s[j] === 'x' || s[j] === 'X') {
    hex = true;
    j++;
  }
  const start = j;
  while (j < s.length && (hex ? /[0-9A-Fa-f]/.test(s[j]) : isDigitCh(s[j]))) j++;
  if (j === start || j >= s.length || s[j] !== ';') return null;
  const digits = s.slice(start, j);
  if (!hex && digits.length > 7) return null;
  if (hex && digits.length > 6) return null;
  const value = hex ? parseInt(digits, 16) : parseInt(digits, 10);
  if (Number.isNaN(value) || value > 0x10ffff) return null;
  if (value === 0) return ['\uFFFD', j - i + 1];
  if (value >= 0xd800 && value <= 0xdfff) return null;
  return [String.fromCodePoint(value), j - i + 1];
}

// Normalize a link label the way the spec wants it: collapse every run
// of whitespace to one space, trim the ends, and fold case.
// Normalize a link label for lookup: collapse whitespace, then fold
// case the way the spec does. Plain lowercasing is not enough: Unicode
// case folding sends sharp-s to `ss` and expands the Latin ligatures.
function normalizeLabel(raw) {
  const folded = raw
    .replace(/[ßẞ]/g, 'ss')
    .replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl')
    .replace(/ﬅ/g, 'st').replace(/ﬆ/g, 'st');
  return folded.replace(/\s+/g, ' ').trim().toLowerCase();
}

// Encode a link destination the way marked does: percent-encode the
// characters that cannot appear raw in a URL, but keep % sequences and
// entity spellings as they are.
function encodeDestination(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '%') {
      out += '%';
      continue;
    }
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || c === ' ' || c === '"' || c === '<' || c === '>' || c === '`' || c === '{' || c === '}' || c === '|' || c === '^' || c === '[' || c === ']' || c === '\\') {
      out += '%' + code.toString(16).toUpperCase().padStart(2, '0');
      continue;
    }
    if (code > 0x7e) {
      // Non-ASCII bytes are percent-encoded UTF-8.
      const bytes = new TextEncoder().encode(c);
      for (const b of bytes) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
      continue;
    }
    out += c;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scan: a cursor over one source line that knows about tab stops.
//
// A tab moves the column to the next multiple of four. When the parser
// only needs part of a tab (for example one space of indentation out of
// a tab that is worth three), the rest of the tab stays behind as virtual
// spaces: `rest` counts them, `cur()` reports a space while any remain,
// and `text()` puts them back in front of the unread tail.
class Scan {
  constructor(line) {
    this.line = line;
    this.at = 0;
    this.col = 0;
    this.rest = 0;
  }
  cur() {
    if (this.rest > 0) return ' ';
    return this.at < this.line.length ? this.line[this.at] : '';
  }
  peek(k) {
    if (this.rest > 0) return k === 0 ? ' ' : this.line[this.at + k - 1] || '';
    return this.line[this.at + k] || '';
  }
  done() {
    return this.rest === 0 && this.at >= this.line.length;
  }
  // Move one column forward.
  step() {
    if (this.rest > 0) {
      this.rest--;
      this.col++;
      return;
    }
    const c = this.line[this.at];
    if (c === '\t') {
      const width = 4 - (this.col % 4);
      this.rest = width - 1;
      this.at++;
      this.col++;
    } else {
      this.at++;
      this.col++;
    }
  }
  // Skip up to `limit` columns of spaces/tabs. Returns columns skipped.
  skipBlank(limit) {
    let n = 0;
    while (n < limit && (this.cur() === ' ' || this.cur() === '\t')) {
      this.step();
      n++;
    }
    return n;
  }
  // How many columns of indentation are ahead (capped at 4), without moving.
  indentAhead() {
    let col = this.col;
    let at = this.at;
    let rest = this.rest;
    let n = 0;
    while (n < 4) {
      let c;
      if (rest > 0) c = ' ';
      else if (at < this.line.length) c = this.line[at];
      else break;
      if (c !== ' ' && c !== '\t') break;
      if (c === '\t') {
        const width = 4 - (col % 4);
        rest = width - 1;
        at++;
        col++;
        n++;
      } else if (rest > 0) {
        rest--;
        col++;
        n++;
      } else {
        at++;
        col++;
        n++;
      }
    }
    return n;
  }
  // Skip exactly `n` columns of spaces/tabs.
  skipColumns(n) {
    let done = 0;
    while (done < n && (this.cur() === ' ' || this.cur() === '\t')) {
      this.step();
      done++;
    }
    return done;
  }
  // The unread tail of the line, with any leftover virtual spaces put back.
  text() {
    return ' '.repeat(this.rest) + this.line.slice(this.at);
  }
  blank() {
    let at = this.at;
    let rest = this.rest;
    while (true) {
      if (rest > 0) {
        rest--;
        continue;
      }
      if (at >= this.line.length) return true;
      const c = this.line[at];
      if (c !== ' ' && c !== '\t') return false;
      at++;
    }
  }
  save() {
    return { at: this.at, col: this.col, rest: this.rest };
  }
  restore(s) {
    this.at = s.at;
    this.col = s.col;
    this.rest = s.rest;
  }
}

// Split the document into lines, normalizing line endings first.
function splitLines(src) {
  const flat = src.replace(/\r\n?/g, '\n');
  const lines = flat.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// ---------------------------------------------------------------------------
// Block nodes.
//
// kind is one of: doc, para, head, fence, code, quote, list, item, html,
// hr, table. Leaves that hold raw text keep it in `text`; paragraphs keep
// their lines in `lines` until they are closed, because a paragraph can
// still turn into a setext heading or a table.
function newNode(kind) {
  return { kind, kids: [], lines: null, text: '', blankBefore: false };
}

// --- Block-start recognizers. Each takes a Scan positioned just past the
// containers and returns a description, or null when the line is not one.

function tryAtx(scan) {
  const save = scan.save();
  scan.skipBlank(3);
  let level = 0;
  while (scan.cur() === '#' && level < 7) {
    scan.step();
    level++;
  }
  if (level === 0 || level > 6) {
    scan.restore(save);
    return null;
  }
  const after = scan.cur();
  if (after !== '' && after !== ' ' && after !== '\t') {
    scan.restore(save);
    return null;
  }
  let content = scan.text();
  // A closing run of #s, preceded by a space, is stripped.
  content = content.replace(/[ \t]+#+[ \t]*$/, '');
  content = content.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  return { level, content };
}

function tryFence(scan) {
  const save = scan.save();
  const startCol = scan.col;
  scan.skipBlank(3);
  const indent = scan.col - startCol;
  const mark = scan.cur();
  if (mark !== '`' && mark !== '~') {
    scan.restore(save);
    return null;
  }
  let len = 0;
  while (scan.cur() === mark) {
    scan.step();
    len++;
  }
  if (len < 3) {
    scan.restore(save);
    return null;
  }
  const info = scan.text();
  if (mark === '`' && info.indexOf('`') !== -1) {
    scan.restore(save);
    return null;
  }
  // A tilde fence does not strip its opening indent from the content
  // (marked keeps the content's indentation verbatim); a backtick
  // fence does.
  return { mark, len, info: info.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''), indent: mark === '~' ? 0 : indent };
}

const HTML_BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'section',
  'source', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'title', 'tr', 'track', 'ul',
]);

// A complete open tag (with attributes) or closing tag (bare name
// only: `</a href="foo">` is not a tag).
const TAG_RE = /^ {0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*[ \t]*\/?>|<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>)/;

// Which HTML block type (1-7) starts here, or 0. `canInterrupt` is false
// when a paragraph is open: type 7 may not interrupt one.
function htmlBlockType(text, canInterrupt) {
  if (/^ {0,3}<!--/.test(text)) return 2;
  if (/^ {0,3}<\?/.test(text)) return 3;
  if (/^ {0,3}<![A-Za-z]/.test(text)) return 4;
  if (/^ {0,3}<!\[CDATA\[/.test(text)) return 5;
  const m = /^ {0,3}<(\/?)([A-Za-z][A-Za-z0-9-]*)?/.exec(text);
  if (!m || !m[2]) return 0;
  const tag = m[2].toLowerCase();
  const rest = text.slice(m[0].length);
  // After the tag name, a real tag continues with whitespace, `>`,
  // `/`, or the end of the line. Anything else (like `:` in
  // `<http://x>`) is not a tag at all.
  if (!(rest === '' || rest[0] === ' ' || rest[0] === '\t' || rest[0] === '>' || rest[0] === '/')) return 0;
  if (tag === 'script' || tag === 'pre' || tag === 'style' || tag === 'textarea') {
    if (m[1] === '') return 1;
    return 0;
  }
  // A block tag may span lines (`<div id="foo"` on one line, the
  // rest of the tag on the next), so type 6 needs no complete tag.
  if (HTML_BLOCK_TAGS.has(tag)) return 6;
  // Type 7: the tag must be complete and valid on this line, and the
  // whole line must be just the tag.
  if (!canInterrupt) return 0;
  const tagM = TAG_RE.exec(text);
  if (!tagM) return 0;
  if (/^[ \t]*$/.test(text.slice(tagM[0].length))) return 7;
  return 0;
}

// The end condition for an HTML block of the given type: a line ends the
// block when this returns true (the line itself still belongs to it,
// except for types 6 and 7, which end at a blank line).
function htmlBlockEnds(type, tag, line) {
  const lower = line.toLowerCase();
  if (type === 1) return lower.indexOf('</' + tag) !== -1;
  if (type === 2) return line.indexOf('-->') !== -1;
  if (type === 3) return line.indexOf('?>') !== -1;
  if (type === 4) return line.indexOf('>') !== -1;
  if (type === 5) return line.indexOf(']]>') !== -1;
  return false;
}

function tryThematic(scan) {
  const save = scan.save();
  scan.skipBlank(3);
  const mark = scan.cur();
  if (mark !== '*' && mark !== '-' && mark !== '_') {
    scan.restore(save);
    return false;
  }
  let count = 0;
  while (!scan.done()) {
    const c = scan.cur();
    if (c === mark) {
      count++;
      scan.step();
    } else if (c === ' ' || c === '\t') {
      scan.step();
    } else {
      scan.restore(save);
      return false;
    }
  }
  if (count < 3) {
    scan.restore(save);
    return false;
  }
  return true;
}

// A setext underline: a run of = (level 1) or - (level 2) with spaces.
function trySetext(scan) {
  const save = scan.save();
  scan.skipBlank(3);
  const mark = scan.cur();
  if (mark !== '=' && mark !== '-') {
    scan.restore(save);
    return 0;
  }
  let count = 0;
  while (scan.cur() === mark) {
    count++;
    scan.step();
  }
  if (count < 1) {
    scan.restore(save);
    return 0;
  }
  // Only trailing blanks may follow the run. A space inside it, like
  // `= =`, is not a setext underline (it stays paragraph text, and
  // `--- -` is a thematic break instead).
  while (scan.cur() === ' ' || scan.cur() === '\t') scan.step();
  if (!scan.done()) {
    scan.restore(save);
    return 0;
  }
  return mark === '=' ? 1 : 2;
}

// Parse a list marker at the scan position. Returns null, or
// { ordered, bullet, start, delim, markerLen, empty } where markerLen is
// the marker's width in columns and `empty` means nothing but blanks
// follows the marker on this line.
function tryListMarker(scan) {
  const save = scan.save();
  scan.skipBlank(3);
  const c = scan.cur();
  if (c === '-' || c === '+' || c === '*') {
    const after = scan.peek(1);
    if (after !== '' && after !== ' ' && after !== '\t') {
      scan.restore(save);
      return null;
    }
    scan.step();
    return { ordered: false, bullet: c, start: null, delim: c, markerLen: 1, empty: after === '' };
  }
  if (isDigitCh(c)) {
    let digits = '';
    while (isDigitCh(scan.cur()) && digits.length < 10) {
      digits += scan.cur();
      scan.step();
    }
    if (digits.length > 9) {
      scan.restore(save);
      return null;
    }
    const d = scan.cur();
    if (d !== '.' && d !== ')') {
      scan.restore(save);
      return null;
    }
    const after = scan.peek(1);
    if (after !== '' && after !== ' ' && after !== '\t') {
      scan.restore(save);
      return null;
    }
    scan.step();
    return { ordered: true, bullet: null, start: parseInt(digits, 10), delim: d, markerLen: digits.length + 1, empty: after === '' };
  }
  scan.restore(save);
  return null;
}

// ---------------------------------------------------------------------------
// Link reference definitions.
//
// A paragraph can open with one or more definitions: `[label]: dest "title"`.
// They are taken out of the paragraph's text before it is rendered, and
// they are collected for the whole document, so a reference may be used
// before the paragraph that defines it.

function skipInlineSpaces(text, i) {
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
  return i;
}

function skipInlineWhitespace(text, i) {
  while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n')) i++;
  return i;
}

// Parse a link title starting at text[i], where text[i] is ", ' or (.
// Returns { title, end } or null.
function parseLinkTitle(text, i) {
  const q = text[i];
  if (q === '"' || q === "'") {
    let j = i + 1;
    let out = '';
    while (j < text.length && text[j] !== q) {
      if (text[j] === '\\' && j + 1 < text.length && isAsciiPunct(text[j + 1])) {
        out += text[j + 1];
        j += 2;
        continue;
      }
      out += text[j];
      j++;
    }
    if (j >= text.length) return null;
    return { title: out, end: j + 1 };
  }
  // Parenthesized title: no unescaped parens inside.
  let j = i + 1;
  let out = '';
  while (j < text.length) {
    const c = text[j];
    if (c === '\\' && j + 1 < text.length && isAsciiPunct(text[j + 1])) {
      out += text[j + 1];
      j += 2;
      continue;
    }
    if (c === '(' || c === ')') {
      if (c === ')') return { title: out, end: j + 1 };
      return null;
    }
    out += c;
    j++;
  }
  return null;
}

// Try to read one definition starting at text[p]. Returns
// { label, dest, title, end } or null when the text is not a definition.
function parseOneDefinition(text, p) {
  let q = p;
  // Up to three columns of indentation on this line.
  let col = 0;
  while (col < 3 && q < text.length && (text[q] === ' ' || text[q] === '\t')) {
    col += text[q] === '\t' ? 4 - (col % 4) : 1;
    q++;
  }
  if (col > 3 || text[q] !== '[') return null;
  // The label, with backslash escapes allowed. A definition's label
  // takes no nested brackets: it ends at the first `]`, so `[[foo]]`
  // and `[foo [bar]]` are not definitions at all. An unescaped `[`
  // inside the label kills the definition outright.
  let r = q + 1;
  let label = '';
  while (r < text.length) {
    const c = text[r];
    if (c === '\\' && r + 1 < text.length && isAsciiPunct(text[r + 1])) {
      label += c + text[r + 1];
      r += 2;
      continue;
    }
    if (c === '[') return null;
    if (c === ']') break;
    label += c;
    r++;
    if (label.length > 999) return null;
  }
  if (r >= text.length || text[r] !== ']' || label.trim() === '') return null;
  r++;
  if (text[r] !== ':') return null;
  r++;
  r = skipInlineWhitespace(text, r);
  // The destination.
  let dest = '';
  if (text[r] === '<') {
    let e = r + 1;
    while (e < text.length && text[e] !== '>' && text[e] !== '\n' && text[e] !== '<') {
      if (text[e] === '\\' && e + 1 < text.length && isAsciiPunct(text[e + 1])) {
        dest += text[e + 1];
        e += 2;
        continue;
      }
      dest += text[e];
      e++;
    }
    if (e >= text.length || text[e] !== '>') return null;
    r = e + 1;
  } else {
    let e = r;
    let parens = 0;
    let ok = true;
    while (e < text.length) {
      const c = text[e];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') break;
      if (c === '\\' && e + 1 < text.length && isAsciiPunct(text[e + 1])) {
        dest += text[e + 1];
        e += 2;
        continue;
      }
      if (c === '(') {
        parens++;
        dest += c;
        e++;
        continue;
      }
      if (c === ')') {
        if (parens === 0) break;
        parens--;
        dest += c;
        e++;
        continue;
      }
      if (c < ' ') {
        ok = false;
        break;
      }
      dest += c;
      e++;
    }
    if (!ok || parens !== 0 || dest === '') return null;
    r = e;
  }
  // An optional title, on this line or the next one. When a quote or
  // paren opens where a title belongs, it has to parse as one.
  let title = null;
  let after = r;
  let t = skipInlineSpaces(text, r);
  if (text[t] === '"' || text[t] === "'" || text[t] === '(') {
    // A title on this line needs whitespace before it; `<bar>(baz)`
    // has none, so the whole definition fails.
    if (t === r) return null;
    const got = parseLinkTitle(text, t);
    if (!got) return null;
    title = got.title;
    after = got.end;
  } else if (text[t] === '\n') {
    let u = skipInlineSpaces(text, t + 1);
    if (text[u] === '"' || text[u] === "'" || text[u] === '(') {
      const got = parseLinkTitle(text, u);
      if (got) {
        const afterTitle = skipInlineSpaces(text, got.end);
        if (afterTitle >= text.length || text[afterTitle] === '\n') {
          title = got.title;
          after = got.end;
        } else {
          // The title is followed by junk, so it is no title at all:
          // the definition stands with just its destination, and the
          // next line stays as text.
          return { label: normalizeLabel(label), dest, title: null, end: t + 1 };
        }
      } else {
        // The title does not parse: same fallback, no title.
        return { label: normalizeLabel(label), dest, title: null, end: t + 1 };
      }
    }
  }
  // Nothing but blanks may follow on the title's line.
  after = skipInlineSpaces(text, after);
  if (after < text.length && text[after] !== '\n') return null;
  if (text[after] === '\n') after++;
  return { label: normalizeLabel(label), dest, title, end: after };
}

// Pull leading definitions out of a paragraph's raw text. Returns
// { defs, rest }.
function stripDefinitions(text) {
  const defs = [];
  let p = 0;
  while (p < text.length) {
    const got = parseOneDefinition(text, p);
    if (!got) break;
    defs.push(got);
    p = got.end;
  }
  return { defs, rest: text.slice(p) };
}

// ---------------------------------------------------------------------------
// Tables (GFM).
//
// A table row is split on unescaped pipes; a leading or trailing pipe
// leaves an empty edge cell that is dropped.
function splitTableRow(line) {
  const cells = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length && line[i + 1] === '|') {
      cur += '|';
      i++;
      continue;
    }
    if (c === '|') {
      cells.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  cells.push(cur);
  // Drop an empty first cell (leading pipe) and an empty last cell.
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((s) => s.trim());
}

function parseDelimiterRow(line) {
  if (line.indexOf('|') === -1) return null;
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const align = [];
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return null;
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    align.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
  }
  return align;
}

// ---------------------------------------------------------------------------
// The block parser.
//
// The stack holds open blocks: the document at the bottom, then containers
// (quotes, lists, items) and at most one leaf (paragraph, fence, indented
// code, html block, table) on top. Each line is walked in three moves:
// match the open containers, then either continue the open leaf or start
// a new block in the deepest container the line belongs to.

function htmlTagName(text) {
  const m = /^ {0,3}<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(text);
  return m ? m[1].toLowerCase() : '';
}

function countIndent(scan) {
  const save = scan.save();
  let n = 0;
  while (scan.cur() === ' ' || scan.cur() === '\t') {
    scan.step();
    n++;
  }
  scan.restore(save);
  return n;
}

function parseBlocks(lines, refs, endsWithNewline) {
  const root = newNode('doc');
  const stack = [root];
  let sawBlank = false;
  let sawBlankItems = null;
  let sawBlankDirect = false;
  let sawBlankItem = null;
  let atEof = false;
  const top = () => stack[stack.length - 1];

  function addChild(node) {
    // A blank line counts for a block created inside one of the items
    // that were open when it fell, or for the next item in the same
    // list when the blank line sat directly in the previous item. A
    // blank line nested inside a quote does not leak out to the list.
    let blankBefore = false;
    if (sawBlank) {
      let p = top();
      while (p) {
        if (sawBlankItems && sawBlankItems.has(p)) { blankBefore = true; break; }
        p = stack[stack.indexOf(p) - 1];
      }
      if (!blankBefore && node.kind === 'item' && sawBlankDirect && sawBlankItems) {
        const kids = top().kids;
        const prev = kids.length > 0 ? kids[kids.length - 1] : null;
        if (prev && sawBlankItems.has(prev)) blankBefore = true;
      }
    }
    node.blankBefore = blankBefore;
    top().kids.push(node);
    sawBlank = false;
  }

  // Remember a blank line: which items were open, and whether it sat
  // directly in an item (rather than nested in a quote or list inside
  // one).
  function noteBlank() {
    sawBlank = true;
    sawBlankItems = new Set();
    sawBlankItem = null;
    for (const n of stack) {
      if (n.kind === 'item') {
        sawBlankItems.add(n);
        sawBlankItem = n;
      }
    }
    sawBlankDirect = top().kind === 'item';
  }
  function openLeaf(node) {
    addChild(node);
    stack.push(node);
  }

  function finalize(node) {
    if (node.kind === 'para') {
      const raw = node.lines.join('\n');
      const found = stripDefinitions(raw);
      for (const d of found.defs) {
        if (!refs.has(d.label)) refs.set(d.label, { dest: d.dest, title: d.title });
      }
      if (found.rest.trim() === '') {
        const kids = top().kids;
        const at = kids.indexOf(node);
        if (at !== -1) kids.splice(at, 1);
        node.text = '';
        // A paragraph that was only definitions still counts as a
        // block separated by a blank line: the list it sat in is
        // loose even though the paragraph itself is gone.
        if (node.blankBefore && at > 0) top().hadBlankGap = true;
      } else {
        node.text = found.rest;
      }
    } else if (node.kind === 'list') {
      let loose = false;
      for (let i = 0; i < node.kids.length; i++) {
        const item = node.kids[i];
        if (i > 0 && item.blankBefore) loose = true;
        if (item.hadBlankGap) loose = true;
        for (let j = 1; j < item.kids.length; j++) {
          if (item.kids[j].blankBefore) loose = true;
        }
      }
      node.tight = !loose;
    } else if (node.kind === 'code') {
      let end = node.text.length;
      while (end > 0 && node.text[end - 1] === '\n') end--;
      node.text = end === 0 ? '' : node.text.slice(0, end) + '\n';
    } else if (node.kind === 'fence') {
      // A blank line just before the fence closes leaves one newline
      // too many in the content. A fence holding a single blank line
      // is empty.
      if (node.text === '\n') node.text = '';
      else if (node.text.endsWith('\n\n')) node.text = node.text.slice(0, -1);
    } else if (node.kind === 'html') {
      // An HTML block loses its trailing newline when its container
      // ends around it (or a blank line ends it, handled at the
      // close site). A top-level block that ends by its own end
      // marker, or at the end of the document, keeps it -- unless the
      // input itself has no trailing newline, in which case the last
      // line contributed none.
      if (node.text.endsWith('\n') && !(top().kind === 'doc' && (node.endedByMarker || atEof))) {
        node.text = node.text.slice(0, -1);
      } else if (node.text.endsWith('\n') && atEof && !endsWithNewline) {
        node.text = node.text.slice(0, -1);
      }
    }
  }

  function closeTop() {
    const node = stack.pop();
    finalize(node);
  }

  // Start a list item for `marker` (the scan sits just past the marker).
  // `baseCol` is the column the line's content started at, so the item's
  // indent counts from there, not from the line's first column.
  // Returns true when the rest of the line still holds content for the
  // item, false when the item is empty.
  function startListItem(scan, marker, failedList, baseCol) {
    const afterMarker = scan.save();
    const markerEndCol = scan.col;
    let spaces = 0;
    while (spaces < 5 && (scan.cur() === ' ' || scan.cur() === '\t')) {
      scan.step();
      spaces++;
    }
    const restBlank = scan.blank();
    let contentIndent;
    if (restBlank) {
      contentIndent = markerEndCol + 1 - baseCol;
      scan.restore(afterMarker);
      if (scan.cur() === ' ' || scan.cur() === '\t') scan.step();
    } else if (spaces <= 4) {
      contentIndent = markerEndCol + spaces - baseCol;
    } else {
      contentIndent = markerEndCol + 1 - baseCol;
      scan.restore(afterMarker);
      if (scan.cur() === ' ' || scan.cur() === '\t') scan.step();
    }
    let checked = null;
    const head = scan.text();
    // A task checkbox needs a space and real content after it on this
    // same line: `- [ ]` alone is the literal text "[ ]".
    const cb = /^\[( |x|X)\][ \t]+\S/.exec(head);
    if (cb) {
      checked = cb[1] !== ' ';
      scan.step();
      scan.step();
      scan.step();
      while (scan.cur() === ' ' || scan.cur() === '\t') scan.step();
    }
    const sameList = (list) =>
      list && list.kind === 'list' && list.ordered === marker.ordered &&
      (marker.ordered ? list.delim === marker.delim : list.bullet === marker.bullet);
    let list = null;
    if (sameList(failedList)) {
      list = failedList;
    } else if (sameList(top())) {
      list = top();
    } else {
      const last = top().kids[top().kids.length - 1];
      if (sameList(last)) list = last;
    }
    if (!list) {
      list = newNode('list');
      list.ordered = marker.ordered;
      list.delim = marker.delim;
      list.bullet = marker.bullet;
      list.start = marker.ordered ? marker.start : null;
      addChild(list);
      stack.push(list);
    } else if (top() !== list) {
      stack.push(list);
    }
    const item = newNode('item');
    item.indent = contentIndent;
    item.checked = checked;
    addChild(item);
    stack.push(item);
    return !scan.blank();
  }

  // Does the scan start a blockquote (`>` after up to three spaces)?
  // Pure: the position is restored.
  function startsQuote(scan) {
    const save = scan.save();
    scan.skipBlank(3);
    const hit = scan.cur() === '>';
    scan.restore(save);
    return hit;
  }

  // Pure peek: does the scan start a block that may interrupt a paragraph?
  // The recognizers move the scan when they match, so the position is
  // saved and restored here; the real start re-runs them afterwards.
  // `paraOpen` is true when a paragraph is open (type 7 HTML may not
  // interrupt one). `listNeedsOne` is true when an ordered list may only
  // interrupt when it starts at 1: that holds in the non-lazy branch
  // unless the paragraph sits inside a list item; in the lazy branch a
  // list starts outside the paragraph's containers, so any start works.
  // An empty list item cannot interrupt a paragraph to start a new
  // list, but it may join one that is already open (`failedList`).
  function peekInterrupt(scan, paraOpen, listNeedsOne, failedList) {
    const save = scan.save();
    let hit = !!(
      startsQuote(scan) || tryAtx(scan) || tryFence(scan) ||
      htmlBlockType(scan.text(), !paraOpen) !== 0 ||
      tryThematic(scan)
    );
    if (!hit) {
      const marker = tryListMarker(scan);
      const joinsOpen = failedList && failedList.kind === 'list' && failedList.ordered === marker?.ordered &&
        (marker?.ordered ? failedList.delim === marker.delim : failedList.bullet === marker.bullet);
      hit = !!marker && !(paraOpen && listNeedsOne && marker.ordered && marker.start !== 1) && !(paraOpen && scan.blank() && !joinsOpen);
    }
    scan.restore(save);
    return hit;
  }

  // Try the block starts that can interrupt a paragraph. The caller has
  // already decided the line is not a setext underline or a table row.
  // Returns 'list' when a list item was started and its line still has
  // content, 'container' when a blockquote was opened and its line still
  // has content, 'done' when a block was started and the line is spent,
  // or null when nothing starts here.
  function tryInterrupt(scan, failedList, paraOpen, listNeedsOne) {
    const baseCol = scan.col;
    const quoteSave = scan.save();
    scan.skipBlank(3);
    if (scan.cur() === '>') {
      scan.step();
      if (scan.cur() === ' ' || scan.cur() === '\t') scan.step();
      const q = newNode('quote');
      addChild(q);
      stack.push(q);
      return 'container';
    }
    scan.restore(quoteSave);
    const atx = tryAtx(scan);
    if (atx) {
      const h = newNode('head');
      h.lvl = atx.level;
      h.text = atx.content;
      addChild(h);
      return 'done';
    }
    const fence = tryFence(scan);
    if (fence) {
      const f = newNode('fence');
      f.fenceMark = fence.mark;
      f.fenceLen = fence.len;
      f.info = fence.info;
      f.indent = fence.indent;
      f.text = '';
      openLeaf(f);
      return 'done';
    }
    const htmlT = htmlBlockType(scan.text(), !paraOpen);
    if (htmlT !== 0) {
      const h = newNode('html');
      h.htmlType = htmlT;
      h.htmlTag = htmlTagName(scan.text());
      h.text = scan.text() + '\n';
      // A block whose opening line already holds its end marker
      // (like `<style>...</style>` on one line) is done, but it
      // stays open until the next line: a blank line after it
      // strips its trailing newline, a content line keeps it.
      h.endedByMarker = htmlT >= 1 && htmlT <= 5 && htmlBlockEnds(htmlT, h.htmlTag, scan.text());
      openLeaf(h);
      return 'done';
    }
    if (tryThematic(scan)) {
      addChild(newNode('hr'));
      return 'done';
    }
    const markerSave = scan.save();
    const marker = tryListMarker(scan);
    if (marker) {
      // An ordered list may only interrupt a paragraph when it starts
      // at 1, unless the paragraph sits inside a list item.
      if (paraOpen && listNeedsOne && marker.ordered && marker.start !== 1) {
        scan.restore(markerSave);
        return null;
      }
      // An empty list item cannot interrupt a paragraph to start a
      // new list, but it may join one that is already open.
      const joinsOpen = failedList && failedList.kind === 'list' && failedList.ordered === marker.ordered &&
        (marker.ordered ? failedList.delim === marker.delim : failedList.bullet === marker.bullet);
      if (paraOpen && scan.blank() && !joinsOpen) {
        scan.restore(markerSave);
        return null;
      }
      const hasContent = startListItem(scan, marker, failedList, baseCol);
      return hasContent ? 'list' : 'done';
    }
    return null;
  }

  // Try every block start in a fresh container. Returns 'list' or
  // 'container' when a list item or blockquote was started and its line
  // still has content, otherwise 'done'. `paraOpen` is true when the
  // call is interrupting a paragraph; `listNeedsOne` when an ordered
  // list there must start at 1.
  function tryStart(scan, failedList, paraOpen, listNeedsOne) {
    const started = tryInterrupt(scan, failedList, paraOpen, listNeedsOne);
    if (started) return started;
    if (scan.indentAhead() >= 4) {
      const c = newNode('code');
      scan.skipColumns(4);
      c.text = scan.text() + '\n';
      openLeaf(c);
      return 'done';
    }
    // A blank remainder has no content, so it starts no paragraph;
    // an empty one would be spurious.
    if (scan.blank()) return 'done';
    const p = newNode('para');
    p.lines = [scan.text()];
    p.lastLazy = false;
    openLeaf(p);
    return 'done';
  }

  function processLine(raw) {
    const scan = new Scan(raw);
    // A line holding only a tab is a table row (of empty cells), not
    // a blank line that ends the table; a spaces-only line does end it.
    if (scan.blank() && !(top().kind === 'table' && raw.indexOf('\t') !== -1)) {
      const tip = top();
      // Is the open leaf inside a blockquote? A blank line carries no
      // `>` marker, so it cannot belong to anything inside one.
      let insideQuote = false;
      for (let j = stack.length - 1; j >= 1; j--) {
        if (stack[j].kind === 'quote') {
          insideQuote = true;
          break;
        }
      }
      if ((tip.kind === 'fence' || tip.kind === 'code' || (tip.kind === 'html' && tip.htmlType >= 1 && tip.htmlType <= 5 && !tip.endedByMarker)) && !insideQuote) {
        if (tip.kind === 'code') {
          // An indented code block keeps the blank line's spaces past
          // its four-column indent.
          const sv = scan.save();
          scan.skipColumns(4);
          tip.text += scan.text() + '\n';
          scan.restore(sv);
        } else tip.text += scan.text() + '\n';
      } else {
        if (tip.kind === 'para' || tip.kind === 'table' || tip.kind === 'html') {
          // A truly empty blank line strips the HTML block's trailing
          // newline; a blank line holding only spaces or a tab does not.
          if (tip.kind === 'html' && tip.text.endsWith('\n') && scan.text() === '') tip.text = tip.text.slice(0, -1);
          closeTop();
        }
        // A blank line closes any open blockquote (and whatever sits
        // inside it), but it never closes a list or a list item.
        let quoteAt = -1;
        for (let j = stack.length - 1; j >= 1; j--) {
          if (stack[j].kind === 'quote') {
            quoteAt = j;
            break;
          }
        }
        if (quoteAt !== -1) {
          while (stack.length - 1 > quoteAt) closeTop();
          closeTop();
        }
        noteBlank();
      }
      // A blank line seals an empty list item: it took no content on
      // its marker line, and nothing after the gap may join it.
      while (top().kind === 'item' && top().kids.length === 0) closeTop();
      return;
    }

    // Phase 1: match the open containers. A list only counts as matched
    // once its item does; when an item fails, remember its list: the
    // line may still open a new item in it.
    let matched = 0;
    let failedList = null;
    for (let j = 1; j < stack.length; j++) {
      const c = stack[j];
      if (c.kind !== 'quote' && c.kind !== 'list' && c.kind !== 'item') break;
      if (c.kind === 'quote') {
        const sv = scan.save();
        scan.skipBlank(3);
        if (scan.cur() === '>') {
          scan.step();
          if (scan.cur() === ' ' || scan.cur() === '\t') scan.step();
          matched = j;
          continue;
        }
        scan.restore(sv);
        break;
      }
      if (c.kind === 'list') {
        failedList = c;
        continue;
      }
      // item
      if (countIndent(scan) >= c.indent) {
        scan.skipColumns(c.indent);
        matched = j;
        failedList = null;
        continue;
      }
      break;
    }

    // A line whose remainder is EMPTY once the containers are matched
    // is a blank line inside those containers: it closes the open leaf
    // and marks the gap, but the containers stay open. A remainder of
    // only spaces is not empty: it is content for the open leaf (a
    // paragraph takes the spaces as a continuation line, a fence as
    // text), so it falls through to the main loop.
    // Note: a line that held only container markers (like `>`) is not
    // a blank line for list looseness, so it sets no sawBlank here.
    if (scan.text() === '') {
      const tip = top();
      // A blank remainder is content for an open fence/code/html when
      // the line reached the fence's own level, or reached every
      // blockquote ancestor of it (a `>` line keeps a fence alive even
      // when the fence sits inside a list item that the blank line did
      // not reopen; list/item ancestors need not be re-matched).
      let deepestQuote = 0;
      for (let j = 1; j <= stack.length - 2; j++) {
        if (stack[j].kind === 'quote') deepestQuote = j;
      }
      const reachedFence = stack.length - 1 === matched + 1 || matched >= deepestQuote;
      if ((tip.kind === 'fence' || tip.kind === 'code' || (tip.kind === 'html' && tip.htmlType >= 1 && tip.htmlType <= 5 && !tip.endedByMarker)) && reachedFence) {
        if (tip.kind === 'code') {
          const sv = scan.save();
          scan.skipColumns(4);
          tip.text += scan.text() + '\n';
          scan.restore(sv);
        } else tip.text += scan.text() + '\n';
      } else {
        if (tip.kind === 'para' || tip.kind === 'table' || tip.kind === 'html' || tip.kind === 'fence' || tip.kind === 'code') {
          if (tip.kind === 'html' && tip.text.endsWith('\n')) tip.text = tip.text.slice(0, -1);
          closeTop();
        }
        noteBlank();
      }
      // A blank line seals an empty list item: it took no content on
      // its marker line, and nothing after the gap may join it.
      while (top().kind === 'item' && top().kids.length === 0) closeTop();
      return;
    }

    // Work the remainder of the line. Each pass handles one layer: a leaf
    // that ends, or a list item that opens and leaves content behind.
    for (let guard = 0; guard < 100; guard++) {
      const tip = top();
      if (tip.kind === 'para') {
        if (stack.length - 1 > matched + 1) {
          // Lazy: the paragraph lives in a container this line did not
          // reach. Only a block start may interrupt it; anything else
          // continues the paragraph verbatim.
          if (peekInterrupt(scan, true, false, failedList)) {
            while (stack.length - 1 > matched) closeTop();
            const started = tryStart(scan, failedList, true, false);
            if (started === 'list' || started === 'container') { matched = stack.length - 1; continue; }
            return;
          }
          // A lazy continuation with four or more columns of indentation
          // drops four of them, as indented code would -- except a line
          // that looks like a setext underline (`=` run). When the
          // paragraph sits directly in a blockquote and its previous
          // line was lazy too, such a line is padded out to four
          // columns instead, so it cannot read as an underline.
          const lineText = scan.text();
          const setextLike = /^([ \t]*)=+[ \t]*$/.exec(lineText);
          if (setextLike && tip.lastLazy && stack[stack.length - 2].kind === 'quote') {
            const indent = countIndent(scan);
            tip.lines.push(indent < 4 ? ' '.repeat(4 - indent) + lineText : lineText);
          } else {
            if (countIndent(scan) >= 4) scan.skipColumns(4);
            tip.lines.push(scan.text());
          }
          tip.lastLazy = true;
          return;
        }
        const setextSave = scan.save();
        const lvl = trySetext(scan);
        if (lvl) {
          // A paragraph made only of link reference definitions is no
          // paragraph at all: the underline stays as text and the
          // definitions are pulled out at finalize.
          const found = stripDefinitions(tip.lines.join('\n'));
          if (found.rest.trim() !== '') {
            const node = tip;
            closeTop();
            const kids = top().kids;
            const at = kids.indexOf(node);
            if (at !== -1) kids.splice(at, 1);
            if (node.text.trim() !== '') {
              const h = newNode('head');
              h.lvl = lvl;
              h.text = node.text.trim();
              addChild(h);
            }
            return;
          }
          scan.restore(setextSave);
        }
        if (tip.lines.length === 1) {
          const align = parseDelimiterRow(scan.text());
          const first = tip.lines[0];
          const headCells = splitTableRow(first);
          if (align && align.length === headCells.length && !/^\s*\[[^\]]*\]:/.test(first)) {
            const table = newNode('table');
            table.headCells = headCells.slice(0, align.length);
            table.align = align;
            table.rows = [];
            table.blankBefore = tip.blankBefore;
            stack.pop();
            const kids = top().kids;
            kids[kids.indexOf(tip)] = table;
            stack.push(table);
            return;
          }
        }
        // The paragraph's containers all matched, so a list here would
        // sit beside the paragraph in the same container. An ordered
        // list may only do that when it starts at 1, unless the
        // paragraph itself sits inside a list item.
        let inListItem = false;
        for (let j = 1; j <= matched; j++) {
          if (stack[j].kind === 'item') { inListItem = true; break; }
        }
        if (peekInterrupt(scan, true, !inListItem, failedList)) {
          closeTop();
          const started = tryStart(scan, failedList, true, !inListItem);
          if (started === 'list' || started === 'container') { matched = stack.length - 1; continue; }
          return;
        }
        tip.lines.push(scan.text());
        tip.lastLazy = false;
        return;
      }
      if (tip.kind === 'fence') {
        // A fenced block keeps swallowing lines until its closing
        // fence, even when a line does not match the enclosing list
        // item: the content does not have to sit at the item's
        // indent. A blockquote that fails to match ends the fence
        // with it, since the line is outside the quote.
        if (stack.length - 1 > matched + 1) {
          let hasQuote = false;
          for (let j = matched + 1; j < stack.length - 1; j++) {
            if (stack[j].kind === 'quote') { hasQuote = true; break; }
          }
          if (hasQuote) {
            while (stack.length - 1 > matched) closeTop();
            continue;
          }
        }
        const save = scan.save();
        scan.skipBlank(3);
        let n = 0;
        while (scan.cur() === tip.fenceMark) {
          scan.step();
          n++;
        }
        if (n >= tip.fenceLen && scan.text().trim() === '') {
          closeTop();
        } else {
          scan.restore(save);
          // Content lines lose the fence's own opening indent. A tab
          // that the indent reaches into is removed whole.
          if (tip.indent > 0) {
            let removed = 0;
            while (removed < tip.indent) {
              const c = scan.cur();
              if (c === ' ') {
                scan.step();
                removed++;
              } else if (c === '\t') {
                scan.step();
                scan.rest = 0;
                removed = tip.indent;
              } else {
                break;
              }
            }
          }
          // A tab that starts the content expands to spaces from its
          // column, unless it is at the very start of the line.
          if (scan.cur() === '\t' && scan.col > 0) {
            const width = 4 - (scan.col % 4);
            scan.at++;
            scan.col += width;
            scan.rest = width;
          }
          tip.text += scan.text() + '\n';
        }
        return;
      }
      if (tip.kind === 'code') {
        if (stack.length - 1 > matched + 1) {
          while (stack.length - 1 > matched) closeTop();
          continue;
        }
        if (countIndent(scan) >= 4) {
          scan.skipColumns(4);
          // A tab that starts the content expands to spaces from its
          // column, unless it is at the very start of the line.
          if (scan.cur() === '\t' && scan.col > 0) {
            const width = 4 - (scan.col % 4);
            scan.at++;
            scan.col += width;
            scan.rest = width;
          }
          tip.text += scan.text() + '\n';
          return;
        }
        closeTop();
        continue;
      }
      if (tip.kind === 'html') {
        if (stack.length - 1 > matched + 1) {
          while (stack.length - 1 > matched) closeTop();
          continue;
        }
        // The block already ended on an earlier line: close it now
        // and let this line start something new.
        if (tip.endedByMarker) {
          closeTop();
          continue;
        }
        const lineText = scan.text();
        tip.text += lineText + '\n';
        if (tip.htmlType >= 1 && tip.htmlType <= 5 && htmlBlockEnds(tip.htmlType, tip.htmlTag, lineText)) {
          // Done, but stay open until the next line: a blank line
          // after it strips the trailing newline, a content line
          // keeps it.
          tip.endedByMarker = true;
        }
        return;
      }
      if (tip.kind === 'table') {
        if (stack.length - 1 > matched + 1) {
          while (stack.length - 1 > matched) closeTop();
          continue;
        }
        const rowText = scan.text();
        // A plain line is a table row even without pipes (it pads with
        // empty cells). A line that starts a new block ends the table.
        if (peekInterrupt(scan, false, false, null)) {
          closeTop();
          continue;
        }
        const cells = splitTableRow(rowText);
        while (cells.length < tip.align.length) cells.push('');
        tip.rows.push(cells.slice(0, tip.align.length));
        return;
      }
      // A container (or the document): start something new here.
      while (stack.length - 1 > matched) closeTop();
      const started = tryStart(scan, failedList, false, false);
      if (started === 'list' || started === 'container') { matched = stack.length - 1; continue; }
      return;
    }
  }

  for (const raw of lines) processLine(raw);
  atEof = true;
  while (stack.length > 1) closeTop();
  return root;
}

// ---------------------------------------------------------------------------
// Entry point.
export function parse(src) {
  const refs = new Map();
  const flat = src.replace(/\r\n?/g, '\n');
  const tree = parseBlocks(splitLines(src), refs, flat.endsWith('\n') || flat === '');
  return renderBlocks(tree, refs);
}

// ---------------------------------------------------------------------------
// Inline parsing.
//
// A block's raw text is scanned into a flat list of pieces: text runs,
// delimiter runs (* _ ~), code spans, links, images, autolinks, raw HTML
// and hard breaks. Delimiter runs are then paired by a stack walk into
// em / strong / del nodes, and the list renders to HTML.

function isPunctCh(c) {
  if (c === '') return false;
  if (c.length === 1 && c.charCodeAt(0) < 128) return isAsciiPunct(c);
  // CommonMark punctuation is ASCII punctuation plus Unicode P
  // (punctuation) and S (symbols): £ and € count, so `*£*` is not
  // emphasis.
  return /[\p{P}\p{S}]/u.test(c);
}

// Flanking flags for a delimiter run starting at s[i] with length runLen.
function delimFlags(s, i, runLen, ch) {
  const prev = i > 0 ? s[i - 1] : '';
  const next = i + runLen < s.length ? s[i + runLen] : '';
  const prevSpace = prev === '' || isSpaceCh(prev);
  const nextSpace = next === '' || isSpaceCh(next);
  const prevPunct = prev !== '' && isPunctCh(prev);
  const nextPunct = next !== '' && isPunctCh(next);
  const left = !nextSpace && (!nextPunct || prevSpace || prevPunct);
  const right = !prevSpace && (!prevPunct || nextSpace || nextPunct);
  if (ch === '_') {
    return { canOpen: left && (!right || prevPunct), canClose: right && (!left || nextPunct) };
  }
  return { canOpen: left, canClose: right };
}

// Decode the numeric entities in a string (0 becomes U+FFFD; surrogates
// and out-of-range values are not decodable, so their & is escaped).
// Named entities are left untouched: marked keeps those spellings.
function decodeNumericEntities(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '&') {
      const got = decodeNumeric(s, i);
      if (got) {
        // A decoded & must not join the text that follows into a fake
        // entity reference, so it is escaped at once.
        out += got[0] === '&' ? '&amp;' : got[0];
        i += got[1];
        continue;
      }
      if (/^&#[0-9]+;/.test(s.slice(i)) || /^&#[xX][0-9A-Fa-f]+;/.test(s.slice(i))) {
        out += '&amp;';
        i++;
        continue;
      }
      out += '&';
      i++;
      continue;
    }
    out += s[i];
    i++;
  }
  return out;
}

// Find the `]` that closes the label starting at s[start] (s[start]
// is '['). Brackets nest; backslash escapes and code spans are skipped.
// Returns the index of the closing `]`, or -1.
function findLabelEnd(s, start) {
  let depth = 0;
  let i = start;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      i += 2;
      continue;
    }
    if (c === '<') {
      // Skip an autolink or raw HTML tag whole: a `]` inside one
      // (often inside a quoted attribute value) does not close the
      // label.
      const rest = s.slice(i);
      const schemeM = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}):([^<>\s]*)>/.exec(rest);
      if (schemeM) {
        i += schemeM[0].length;
        continue;
      }
      const emailM = /^<([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+)>/.exec(rest);
      if (emailM) {
        i += emailM[0].length;
        continue;
      }
      const html = matchHtml(s, i);
      if (html !== null) {
        i += html.length;
        continue;
      }
      i++;
      continue;
    }
    if (c === '`') {
      let n = 0;
      while (i + n < s.length && s[i + n] === '`') n++;
      let k = i + n;
      let found = -1;
      while (k < s.length) {
        if (s[k] === '`') {
          let m = 0;
          while (k + m < s.length && s[k + m] === '`') m++;
          if (m === n) {
            found = k;
            break;
          }
          k += m;
        } else {
          k++;
        }
      }
      if (found === -1) {
        i += n;
        continue;
      }
      i = found + n;
      continue;
    }
    if (c === '[') {
      depth++;
      i++;
      continue;
    }
    if (c === ']') {
      depth--;
      if (depth === 0) return i;
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

// Parse the `(destination "title")` tail of an inline link, starting at
// s[j] (s[j] is '('). Returns { dest, title, end } or null.
function parseInlineLink(s, j) {
  let i = skipInlineWhitespace(s, j + 1);
  let dest = '';
  if (s[i] === '<') {
    let k = i + 1;
    let buf = '';
    let ok = false;
    while (k < s.length) {
      const c = s[k];
      if (c === '\n' || c === '<') break;
      if (c === '>') {
        ok = true;
        break;
      }
      if (c === '\\' && k + 1 < s.length && isAsciiPunct(s[k + 1])) {
        buf += s[k + 1];
        k += 2;
        continue;
      }
      buf += c;
      k++;
    }
    if (!ok) return null;
    dest = buf;
    i = k + 1;
  } else {
    let depth = 0;
    let buf = '';
    let k = i;
    let closed = false;
    while (k < s.length) {
      const c = s[k];
      if (c === ' ' || c === '\t' || c === '\n') break;
      if (c === '(') {
        depth++;
        buf += c;
        k++;
        continue;
      }
      if (c === ')') {
        if (depth === 0) {
          closed = true;
          break;
        }
        depth--;
        buf += c;
        k++;
        continue;
      }
      if (c === '\\' && k + 1 < s.length && isAsciiPunct(s[k + 1])) {
        buf += s[k + 1];
        k += 2;
        continue;
      }
      buf += c;
      k++;
    }
    if (closed) return { dest: buf, title: null, end: k + 1 };
    if (k >= s.length) return null;
    dest = buf;
    i = k;
  }
  i = skipInlineWhitespace(s, i);
  let title = null;
  if (s[i] === '"' || s[i] === "'" || s[i] === '(') {
    const got = parseLinkTitle(s, i);
    if (!got) return null;
    title = got.title;
    i = got.end;
    i = skipInlineWhitespace(s, i);
  }
  if (s[i] !== ')') return null;
  return { dest, title, end: i + 1 };
}

// Try to read a link or image starting at s[i] (s[i] is '[' or '!').
// Returns { node, end } or null when this is not a link.
function tryLink(s, i, refs) {
  let isImage = false;
  let open = i;
  if (s[i] === '!') {
    if (s[i + 1] !== '[') return null;
    isImage = true;
    open = i + 1;
  }
  const close = findLabelEnd(s, open);
  if (close === -1) return null;
  const labelRaw = s.slice(open + 1, close);
  const after = close + 1;
  let dest = null;
  let title = null;
  let end = -1;
  if (s[after] === '(') {
    const got = parseInlineLink(s, after);
    if (got) {
      dest = got.dest;
      title = got.title;
      end = got.end;
    } else {
      // Not a valid inline link after all: fall back to the shortcut
      // reference, leaving the `(...)` as literal text.
      const ref = refs.get(normalizeLabel(labelRaw));
      if (!ref) return null;
      dest = ref.dest;
      title = ref.title;
      end = after;
    }
  } else if (s[after] === '[') {
    const secondClose = findLabelEnd(s, after);
    if (secondClose === -1) return null;
    const secondRaw = s.slice(after + 1, secondClose);
    const key = secondRaw === '' ? normalizeLabel(labelRaw) : normalizeLabel(secondRaw);
    const ref = refs.get(key);
    if (!ref) return null;
    dest = ref.dest;
    title = ref.title;
    end = secondClose + 1;
  } else {
    const ref = refs.get(normalizeLabel(labelRaw));
    if (!ref) return null;
    dest = ref.dest;
    title = ref.title;
    end = after;
  }
  const kids = scanInline(labelRaw, refs, true);
  processDelims(kids);
  // A link may not contain another link: the inner one wins and the
  // outer brackets stay literal. (An image may hold one in its alt.)
  if (!isImage && containsLink(kids)) return null;
  return { node: { t: 'link', dest, title, kids, isImage }, end };
}

// Does any node here, at any depth, hold a real link (not an image)?
function containsLink(nodes) {
  for (const node of nodes) {
    if (node.t === 'link' && !node.isImage) return true;
    if (node.kids && containsLink(node.kids)) return true;
  }
  return false;
}

// Match one raw HTML construct at s[i] (s[i] is '<'): a comment,
// processing instruction, declaration, CDATA section, or a tag. Returns
// the matched text, or null.
function matchHtml(s, i) {
  if (s.startsWith('<!--', i)) {
    // `<!-->` and `<!--->` are empty comments that end at once.
    if (s.startsWith('<!-->', i)) return '<!-->';
    if (s.startsWith('<!--->', i)) return '<!--->';
    const end = s.indexOf('-->', i + 4);
    if (end !== -1) return s.slice(i, end + 3);
    return null;
  }
  if (s.startsWith('<?', i)) {
    const end = s.indexOf('?>', i + 2);
    if (end !== -1) return s.slice(i, end + 2);
    return null;
  }
  if (s.startsWith('<![CDATA[', i)) {
    const end = s.indexOf(']]>', i + 9);
    if (end !== -1) return s.slice(i, end + 3);
    return null;
  }
  if (s.startsWith('<!', i) && i + 2 < s.length && isAlphaCh(s[i + 2])) {
    const end = s.indexOf('>', i + 2);
    if (end !== -1) return s.slice(i, end + 1);
    return null;
  }
  let j = i + 1;
  const closing = s[j] === '/';
  if (closing) j++;
  if (j >= s.length || !isAlphaCh(s[j])) return null;
  while (j < s.length && (isAlphaCh(s[j]) || isDigitCh(s[j]) || s[j] === '-')) j++;
  if (closing) {
    // A closing tag takes only blanks before `>`.
    while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    if (s[j] === '>') return s.slice(i, j + 1);
    return null;
  }
  while (j < s.length) {
    let k = j;
    while (k < s.length && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
    if (k >= s.length) return null;
    if (s[k] === '>') return s.slice(i, k + 1);
    if (s[k] === '/' && s[k + 1] === '>') return s.slice(i, k + 2);
    if (s[k] === '/') return null;
    // An attribute must be set off from the tag name (or the
    // previous attribute) by whitespace: `<m:abc>` and
    // `<a href='bar'title=title>` are not tags.
    if (k === j) return null;
    if (!(isAlphaCh(s[k]) || s[k] === '_' || s[k] === ':')) return null;
    while (k < s.length && (isAlphaCh(s[k]) || isDigitCh(s[k]) || s[k] === '_' || s[k] === ':' || s[k] === '.' || s[k] === '-')) k++;
    let m = k;
    while (m < s.length && (s[m] === ' ' || s[m] === '\t' || s[m] === '\n')) m++;
    if (s[m] === '=') {
      m++;
      while (m < s.length && (s[m] === ' ' || s[m] === '\t' || s[m] === '\n')) m++;
      if (s[m] === '"' || s[m] === "'") {
        const q = s[m];
        m++;
        while (m < s.length && s[m] !== q) m++;
        if (m >= s.length) return null;
        m++;
      } else {
        if (m >= s.length) return null;
        const bad = s[m];
        if (bad === ' ' || bad === '\t' || bad === '\n' || bad === '"' || bad === "'" || bad === '=' || bad === '<' || bad === '>' || bad === '`') return null;
        while (m < s.length) {
          const ch = s[m];
          if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '"' || ch === "'" || ch === '=' || ch === '<' || ch === '>' || ch === '`') break;
          m++;
        }
      }
      j = m;
    } else {
      // No value: the attribute ends right after its name, before
      // the whitespace, so the next pass can see the gap.
      j = k;
    }
  }
  return null;
}

// Scan a bare GFM URL starting at `start`, whose prefix (www. or a
// scheme) is `prefixLen` long. Returns the URL text, or null when there
// is nothing linkable there.
function scanGfmUrl(s, start, prefixLen) {
  let j = start + prefixLen;
  if (j >= s.length || !/[A-Za-z0-9]/.test(s[j])) return null;
  let end = j;
  while (end < s.length) {
    const c = s[end];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '<' || c === '>' || c === '"' || c === "'" || c < ' ') break;
    end++;
  }
  let url = s.slice(start, end);
  // Strip trailing punctuation and unbalanced closing parens, in
  // either order, until nothing more comes off: a `)*` tail needs the
  // `*` gone before the `)` can be judged unbalanced.
  let changed = true;
  while (changed) {
    changed = false;
    while (url.endsWith(')')) {
      const opens = (url.match(/\(/g) || []).length;
      const closes = (url.match(/\)/g) || []).length;
      if (closes > opens) { url = url.slice(0, -1); changed = true; }
      else break;
    }
    const stripped = url.replace(/[.,;:!?*_~'"\]}(]+$/, '');
    if (stripped !== url) { url = stripped; changed = true; }
  }
  // A trailing `&name;` is an entity reference, not part of the URL:
  // the `;` was stripped above, so the `&name` tail goes too.
  const entM = /&([A-Za-z0-9]+)$/.exec(url);
  if (entM && s[start + url.length] === ';') url = url.slice(0, -entM[0].length);
  if (url.length <= prefixLen) return null;
  return url;
}

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/;

// Try a bare GFM autolink at s[i]: www., a scheme, or an email address.
// Returns { dest, label, mailto, end } or null.
function matchGfmAutolink(s, i) {
  const prev = i > 0 ? s[i - 1] : '';
  const prevOk = prev === '' || !/[A-Za-z0-9_/.]/.test(prev);
  if (s.startsWith('www.', i) && prevOk) {
    const got = scanGfmUrl(s, i, 4);
    if (got) return { dest: 'http://' + got, label: got, mailto: false, end: i + got.length };
    return null;
  }
  const schemeM = /^([A-Za-z][A-Za-z0-9+.-]{1,31}):/.exec(s.slice(i));
  if (schemeM && prevOk) {
    const scheme = schemeM[1].toLowerCase();
    const afterColon = i + schemeM[0].length;
    if (scheme === 'mailto') {
      // The part after mailto: is an email address, not a bare URL.
      const emailM = EMAIL_RE.exec(s.slice(afterColon));
      if (emailM) {
        const nextCh = s[afterColon + emailM[0].length];
        if (nextCh !== '-' && nextCh !== '_') {
          const url = 'mailto:' + emailM[0];
          return { dest: url, label: url, mailto: false, end: afterColon + emailM[0].length };
        }
      }
      return null;
    }
    // A hierarchical URL carries // after the colon; it belongs to
    // the prefix so the scanner starts on an alphanumeric.
    let prefixLen = schemeM[0].length;
    if (s.startsWith('//', afterColon)) prefixLen += 2;
    const got = scanGfmUrl(s, i, prefixLen);
    if (got) {
      let url = got;
      // A bare scheme URL that holds an address (user@domain) takes a
      // single path segment after the domain: `xmpp:a@b/txt/bin`
      // links only up to `/txt`.
      if (prefixLen === schemeM[0].length) {
        const atAt = url.indexOf('@');
        if (atAt !== -1) {
          const firstSlash = url.indexOf('/', atAt);
          if (firstSlash !== -1) {
            const secondSlash = url.indexOf('/', firstSlash + 1);
            if (secondSlash !== -1) url = url.slice(0, secondSlash);
          }
        }
      }
      return { dest: url, label: url, mailto: false, end: i + url.length };
    }
    return null;
  }
  if (isAlphaCh(s[i]) || isDigitCh(s[i])) {
    const emailM = EMAIL_RE.exec(s.slice(i));
    if (emailM) {
      // A domain that would end in - or _ is not a valid email: the
      // address is literal text, not an autolink at all.
      const nextCh = s[i + emailM[0].length];
      if (nextCh === '-' || nextCh === '_') return null;
      const prevBad = prev !== '' && /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]/.test(prev);
      if (!prevBad) {
        return { dest: 'mailto:' + emailM[0], label: emailM[0], mailto: true, end: i + emailM[0].length };
      }
    }
  }
  return null;
}

// Scan one inline string into a flat piece list.
function scanInline(s, refs, noAuto) {
  const nodes = [];
  let buf = '';
  const flush = () => {
    if (buf !== '') {
      nodes.push({ t: 'text', s: decodeNumericEntities(buf) });
      buf = '';
    }
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      if (s[i + 1] === '\n') {
        flush();
        nodes.push({ t: 'br' });
        i += 2;
        while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
        continue;
      }
      if (i + 1 < s.length && isAsciiPunct(s[i + 1])) {
        // An escaped & is a literal &, so it is escaped at once and
        // cannot join the text that follows into an entity reference.
        buf += s[i + 1] === '&' ? '&amp;' : s[i + 1];
        i += 2;
        continue;
      }
      buf += '\\';
      i++;
      continue;
    }
    if (c === '`') {
      let n = 0;
      while (i + n < s.length && s[i + n] === '`') n++;
      let k = i + n;
      let found = -1;
      while (k < s.length) {
        if (s[k] === '`') {
          let m = 0;
          while (k + m < s.length && s[k + m] === '`') m++;
          if (m === n) {
            found = k;
            break;
          }
          k += m;
        } else {
          k++;
        }
      }
      if (found !== -1) {
        flush();
        let content = s.slice(i + n, found);
        content = content.replace(/\n/g, ' ');
        if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
          content = content.slice(1, -1);
        }
        nodes.push({ t: 'code', s: content });
        i = found + n;
        continue;
      }
      buf += '`'.repeat(n);
      i += n;
      continue;
    }
    if (c === '[' || (c === '!' && s[i + 1] === '[')) {
      const got = tryLink(s, i, refs);
      if (got) {
        flush();
        nodes.push(got.node);
        i = got.end;
        continue;
      }
      buf += c;
      i++;
      continue;
    }
    if (c === '<') {
      const rest = s.slice(i);
      const schemeM = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}):([^<>\s]*)>/.exec(rest);
      if (schemeM) {
        flush();
        const full = schemeM[1] + ':' + schemeM[2];
        nodes.push({ t: 'auto', dest: full, label: full, mailto: false });
        i += schemeM[0].length;
        continue;
      }
      const emailM = /^<([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+)>/.exec(rest);
      if (emailM) {
        flush();
        nodes.push({ t: 'auto', dest: 'mailto:' + emailM[1], label: emailM[1], mailto: true });
        i += emailM[0].length;
        continue;
      }
      const html = matchHtml(s, i);
      if (html !== null) {
        flush();
        nodes.push({ t: 'html', s: html });
        i += html.length;
        continue;
      }
      buf += '<';
      i++;
      continue;
    }
    if (c === '\n') {
      let trailing = 0;
      for (let k = buf.length - 1; k >= 0 && buf[k] === ' '; k--) trailing++;
      if (trailing >= 2) {
        buf = buf.slice(0, buf.length - trailing);
        flush();
        nodes.push({ t: 'br' });
        i++;
        while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
      } else {
        buf += '\n';
        i++;
      }
      continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      let n = 0;
      while (i + n < s.length && s[i + n] === c) n++;
      if (c === '~' && n > 2) {
        buf += '~'.repeat(n);
        i += n;
        continue;
      }
      const flags = delimFlags(s, i, n, c);
      if (!flags.canOpen && !flags.canClose) {
        buf += c.repeat(n);
        i += n;
        continue;
      }
      flush();
      nodes.push({ t: 'delim', ch: c, len: n, canOpen: flags.canOpen, canClose: flags.canClose });
      i += n;
      continue;
    }
    if ((c === 'w' || c === 'h' || c === 'f' || isAlphaCh(c) || isDigitCh(c)) && !noAuto) {
      const auto = matchGfmAutolink(s, i);
      if (auto) {
        flush();
        nodes.push({ t: 'auto', dest: auto.dest, label: auto.label, mailto: auto.mailto });
        i = auto.end;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return nodes;
}

// Find the nearest opener for `closer` among the pieces before index
// `closerIdx`: same character, able to open, still has delimiters left,
// and allowed by the odd-match rule. Returns its index, or -1.
function findOpener(nodes, closerIdx, closer) {
  for (let q = closerIdx - 1; q >= 0; q--) {
    const cand = nodes[q];
    if (cand.t !== 'delim' || cand.ch !== closer.ch || !cand.canOpen || cand.len <= 0) continue;
    if (closer.ch === '~' && cand.len !== closer.len) continue;
    if ((cand.canClose || closer.canOpen) && (cand.len + closer.len) % 3 === 0) {
      if (!(cand.len % 3 === 0 && closer.len % 3 === 0)) continue;
    }
    return q;
  }
  return -1;
}

// Pair delimiter runs into em / strong / del nodes. Closers are walked
// left to right; each one takes the nearest opener the rules allow, and
// a run that still has delimiters left after a match is examined again,
// so `***a***` becomes em(strong(a)) and `****a****` two strongs.
function processDelims(nodes) {
  let p = 0;
  while (p < nodes.length) {
    const closer = nodes[p];
    if (closer.t !== 'delim' || !closer.canClose || closer.len <= 0) {
      p++;
      continue;
    }
    const openIdx = findOpener(nodes, p, closer);
    if (openIdx === -1) {
      p++;
      continue;
    }
    const opener = nodes[openIdx];
    let use;
    if (closer.ch === '~') {
      use = opener.len;
    } else if (opener.len >= 2 && closer.len >= 2) {
      use = 2;
    } else {
      use = 1;
    }
    const tag = closer.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em';
    const kids = nodes.slice(openIdx + 1, p);
    const node = { t: tag, kids };
    opener.len -= use;
    closer.len -= use;
    const replacement = [];
    if (opener.len > 0) replacement.push(opener);
    replacement.push(node);
    if (closer.len > 0) replacement.push(closer);
    nodes.splice(openIdx, p - openIdx + 1, ...replacement);
    p = closer.len > 0 ? openIdx + replacement.length - 1 : openIdx + replacement.length;
  }
}

// The plain text inside a piece list, with all markup stripped. Used
// for an image's alt attribute.
function plainText(nodes) {
  let out = '';
  for (const node of nodes) {
    if (node.t === 'text') out += node.s;
    else if (node.t === 'delim') out += node.ch.repeat(node.len);
    else if (node.t === 'code') out += node.s;
    else if (node.t === 'br') out += '\n';
    else if (node.t === 'auto') out += node.label;
    else if (node.t === 'link') out += plainText(node.kids);
    else if (node.t === 'em' || node.t === 'strong' || node.t === 'del') out += plainText(node.kids);
  }
  return out;
}

function renderInline(nodes) {
  let out = '';
  for (const node of nodes) {
    if (node.t === 'text') {
      out += escapeText(node.s);
    } else if (node.t === 'delim') {
      out += escapeText(node.ch.repeat(node.len));
    } else if (node.t === 'code') {
      out += '<code>' + escapeCode(node.s) + '</code>';
    } else if (node.t === 'br') {
      out += '<br>';
    } else if (node.t === 'html') {
      out += node.s;
    } else if (node.t === 'auto') {
      out += '<a href="' + escapeText(encodeDestination(node.dest)) + '">' + escapeText(node.label) + '</a>';
    } else if (node.t === 'link') {
      const href = escapeText(encodeDestination(node.dest));
      if (node.isImage) {
        out += '<img src="' + href + '" alt="' + escapeText(plainText(node.kids)) + '"';
        if (node.title !== null && node.title !== undefined) {
          out += ' title="' + escapeText(decodeNumericEntities(node.title)) + '"';
        }
        out += '>';
      } else {
        out += '<a href="' + href + '"';
        if (node.title !== null && node.title !== undefined) {
          out += ' title="' + escapeText(decodeNumericEntities(node.title)) + '"';
        }
        out += '>' + renderInline(node.kids) + '</a>';
      }
    } else if (node.t === 'em') {
      out += '<em>' + renderInline(node.kids) + '</em>';
    } else if (node.t === 'strong') {
      out += '<strong>' + renderInline(node.kids) + '</strong>';
    } else if (node.t === 'del') {
      out += '<del>' + renderInline(node.kids) + '</del>';
    }
  }
  return out;
}

// Render one block's inline content: scan it, pair its delimiters,
// render it.
function inlineHtml(text, refs) {
  const pieces = scanInline(text, refs);
  processDelims(pieces);
  return renderInline(pieces);
}

// ---------------------------------------------------------------------------
// Block rendering.

function renderBlocks(node, refs, listTight) {
  switch (node.kind) {
    case 'doc': {
      let out = '';
      for (const kid of node.kids) out += renderBlocks(kid, refs, false);
      return out;
    }
    case 'para': {
      if (node.text === '') return '';
      return '<p>' + inlineHtml(node.text, refs) + '</p>\n';
    }
    case 'head': {
      return '<h' + node.lvl + '>' + inlineHtml(node.text, refs) + '</h' + node.lvl + '>\n';
    }
    case 'fence': {
      // The info string's first word is the language; backslash
      // escapes in it resolve to the punctuation itself.
      const firstWord = node.info.split(/[ \t]/)[0].replace(/\\([!-/:-@\[-`{-~])/g, '$1');
      const cls = firstWord === '' ? '' : ' class="language-' + escapeText(firstWord) + '"';
      return '<pre><code' + cls + '>' + escapeCode(node.text) + '</code></pre>\n';
    }
    case 'code': {
      return '<pre><code>' + escapeCode(node.text) + '</code></pre>\n';
    }
    case 'quote': {
      let out = '<blockquote>\n';
      for (const kid of node.kids) out += renderBlocks(kid, refs, false);
      return out + '</blockquote>\n';
    }
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      const start = node.ordered && node.start !== null && node.start !== 1 ? ' start="' + node.start + '"' : '';
      let out = '<' + tag + start + '>\n';
      for (const kid of node.kids) out += renderBlocks(kid, refs, node.tight);
      return out + '</' + tag + '>\n';
    }
    case 'item': {
      const box = node.checked === null
        ? ''
        : node.checked
          ? '<input checked="" disabled="" type="checkbox"> '
          : '<input disabled="" type="checkbox"> ';
      let body = '';
      for (let i = 0; i < node.kids.length; i++) {
        const kid = node.kids[i];
        if (kid.kind === 'para' && listTight) {
          let text = inlineHtml(kid.text, refs);
          if (i === 0 && box !== '') text = box + text;
          body += text;
        } else if (kid.kind === 'para' && i === 0 && box !== '') {
          body += '<p>' + box + inlineHtml(kid.text, refs) + '</p>\n';
        } else {
          body += renderBlocks(kid, refs, false);
        }
      }
      if (node.kids.length === 0 && box !== '') body = box.trimEnd();
      return '<li>' + body + '</li>\n';
    }
    case 'hr': {
      return '<hr>\n';
    }
    case 'html': {
      return node.text;
    }
    case 'table': {
      const cell = (tag, align, text) => {
        const attr = align === null ? '' : ' align="' + align + '"';
        return '<' + tag + attr + '>' + inlineHtml(text, refs) + '</' + tag + '>\n';
      };
      let out = '<table>\n<thead>\n<tr>\n';
      for (let i = 0; i < node.headCells.length; i++) {
        out += cell('th', node.align[i], node.headCells[i]);
      }
      out += '</tr>\n</thead>\n';
      if (node.rows.length > 0) {
        out += '<tbody>';
        for (const row of node.rows) {
          out += '<tr>\n';
          for (let i = 0; i < row.length; i++) {
            out += cell('td', node.align[i], row[i]);
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      return out + '</table>\n';
    }
    default:
      return '';
  }
}
