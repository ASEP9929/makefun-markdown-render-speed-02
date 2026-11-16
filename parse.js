// parse.js — a fast drop-in replacement for marked 18.1.3 (GFM defaults).
//
// Reimplemented from the CommonMark 0.31.2 and GFM 0.29 specifications and from
// marked 18.1.3's observable behaviour (marked is MIT-licensed; see README for
// credit). The architecture is original: a single-pass block lexer with
// char-based dispatch, and a scanner-based inline parser that renders HTML
// directly instead of building an intermediate token tree. The regular
// expressions that define token boundaries are the same shapes marked uses,
// because those shapes *are* the behaviour; everything around them — the
// dispatch, the rendering, the hot paths — is written from scratch for speed.
//
// parse(markdown) returns exactly the HTML marked 18.1.3 renders with its
// default options (gfm: true, breaks: false, pedantic: false, async: false).

// ---------------------------------------------------------------------------
// Regex helpers
// ---------------------------------------------------------------------------

// Build a regex from a string or regex source, with a replace() that splices
// another pattern's source in place of a placeholder word. A `^` anchor in a
// spliced pattern is dropped when it no longer sits at the start of the
// composed pattern (it would otherwise anchor mid-pattern).
function buildRegex(source, flags = '') {
  let src = typeof source === 'string' ? source : source.source;
  const api = {
    replace(name, replacement) {
      let rep;
      if (typeof replacement === 'string') rep = replacement;
      else if (replacement && typeof replacement.getRegex === 'function') {
        rep = replacement.getRegex().source;
      } else rep = replacement.source;
      // Drop a ^ that is not at the very start of the spliced source.
      rep = rep.replace(/(^|[^\[])\^/g, '$1');
      src = src.replace(name, rep);
      return api;
    },
    getRegex() {
      return new RegExp(src, flags);
    },
  };
  return api;
}

// Cache a regex factory by indent (0..3), the way marked does for its
// indent-dependent block patterns.
function cachedRegex(factory) {
  const cache = [];
  return (indent) => {
    const n = Math.max(0, Math.min(3, indent - 1));
    return cache[n] || (cache[n] = factory(n));
  };
}

// Does this runtime support lookbehind? (Node 22 does.)
const HAS_LOOKBEHIND = (() => {
  try {
    return !!new RegExp('(?<=1)(?<!1)');
  } catch {
    return false;
  }
})();

// ---------------------------------------------------------------------------
// Shared small patterns
// ---------------------------------------------------------------------------

const RE = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand:
    /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex: (bull) =>
    new RegExp(`^( {0,3}${bull})((?:[ \t][^\\n]*)?(?:\\n|$))`),
  nextBulletRegex: cachedRegex(
    (indent) =>
      new RegExp(`^ {0,${indent}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`)
  ),
  hrRegex: cachedRegex(
    (indent) =>
      new RegExp(
        `^ {0,${indent}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`
      )
  ),
  fencesBeginRegex: cachedRegex(
    (indent) => new RegExp(`^ {0,${indent}}(?:\`\`\`|~~~)`)
  ),
  headingBeginRegex: cachedRegex(
    (indent) => new RegExp(`^ {0,${indent}}#{1,6}(?:\\s|$)`)
  ),
  htmlBeginRegex: cachedRegex(
    (indent) =>
      new RegExp(
        `^ {0,${indent}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
        'i'
      )
  ),
  blockquoteBeginRegex: cachedRegex((indent) => new RegExp(`^ {0,${indent}}>`)),
};

// Block-level HTML tag names that can start an HTML block (type 6).
const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

// HTML comment (used by the HTML-block pattern).
const HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;

// ---------------------------------------------------------------------------
// Block patterns (GFM)
// ---------------------------------------------------------------------------

const BLOCK = {};
BLOCK.newline = /^(?:[ \t]*(?:\n|$))+/;
BLOCK.code = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
BLOCK.fences =
  /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
BLOCK.hr = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
BLOCK.heading = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
BLOCK.bullet = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
// Setext heading, before its placeholders are filled in.
const SETEXT_BASE =
  /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
BLOCK.lheading = buildRegex(SETEXT_BASE)
  .replace(/bull/g, BLOCK.bullet)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  // Note: the hr alternative here must be non-capturing, or it would shift
  // the setext text (group 1) and underline (group 2) numbering.
  .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .getRegex();
// Paragraph base, before its placeholders are filled in.
const PARAGRAPH_BASE =
  /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
const LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
BLOCK.def = buildRegex(
  /^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/
)
  .replace('label', LABEL)
  .replace(
    'title',
    /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/
  )
  .getRegex();
BLOCK.list = buildRegex(/^(bull)([ \t][^\n]*?)?(?:\n|$)/)
  .replace(/bull/g, BLOCK.bullet)
  .getRegex();
BLOCK.text = /^[^\n]+/;
BLOCK.html = buildRegex(
  "^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))",
  'i'
)
  .replace('comment', HTML_COMMENT)
  .replace('tag', BLOCK_TAGS)
  .replace(
    'attribute',
    / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/
  )
  .getRegex();
// Table (GFM).
BLOCK.table = buildRegex(
  "^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)"
)
  .replace('hr', BLOCK.hr)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace(
    'html',
    ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)'
  )
  .replace('tag', BLOCK_TAGS)
  .getRegex();

// Paragraph (GFM): the lookahead stops a paragraph before a block start. Note
// the list interruption only fires for a bullet or a list starting with "1".
function paragraphRegex(listPattern) {
  return buildRegex(PARAGRAPH_BASE)
    .replace('hr', BLOCK.hr)
    .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('|lheading', '')
    .replace('table', BLOCK.table)
    .replace('blockquote', ' {0,3}>')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', listPattern)
    .replace(
      'html',
      ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)'
    )
    .replace('tag', BLOCK_TAGS)
    .getRegex();
}
BLOCK.paragraph = paragraphRegex(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/);
// Paragraph shape used inside blockquotes and list items (a wider list test).
BLOCK.paragraphInner = paragraphRegex(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/);
// Blockquote: a run of `>` lines, whose inner paragraph shape is paragraphInner.
BLOCK.blockquote = buildRegex(
  /^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/
)
  .replace('paragraph', BLOCK.paragraphInner)
  .getRegex();

// ---------------------------------------------------------------------------
// Inline patterns (GFM)
// ---------------------------------------------------------------------------

const INLINE = {};
INLINE.escape = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
INLINE.code = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
INLINE.br = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;

// Character classes used by the emphasis / strikethrough delimiter patterns.
const PUNCT = /[\p{P}\p{S}]/u; // any punctuation or symbol
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u; // whitespace, punctuation or symbol
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u; // anything else (letters, digits…)
const PUNCT_NO_TILDE = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_SPACE_NO_TILDE = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE_OR_TILDE = /(?:[^\s\p{P}\p{S}]|~)/u;
const OPEN_QUOTE = /[\p{Pi}\p{Ps}"']/u;
// A single punctuation-or-space char that is not `*` or `_` (used by the
// "preceded by punctuation" test in the inline lexer).
INLINE.punctuation = buildRegex(/^((?![*_])punctSpace)/, 'u')
  .replace(/punctSpace/g, PUNCT_SPACE)
  .getRegex();

// Delimiter runs: `*`/`_` followed by an optional next character.
const EM_STRONG_L_DELIM =
  /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
INLINE.emStrongLDelim = buildRegex(EM_STRONG_L_DELIM, 'u')
  .replace(/punct/g, PUNCT_NO_TILDE)
  .getRegex();
// Right-delimiter search patterns (global): each alternative either skips a
// stretch of non-delimiter text or captures a delimiter run in groups 1..6.
const R_DELIM_AST =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)';
const R_DELIM_AST_OPEN_QUOTE =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)[\\s](\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|(?:(?!\\*)punct|notPunctSpace)(\\*+)(?!\\*)(?=notPunctSpace)';
const R_DELIM_UND =
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)';
const R_DELIM_UND_OPEN_QUOTE =
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)[\\s](_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)|(?:(?!_)punct|notPunctSpace)(_+)(?!_)(?=notPunctSpace)';
// The GFM right-delimiter patterns use the no-tilde punctuation classes.
INLINE.emStrongRDelimAst = buildRegex(R_DELIM_AST, 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE_OR_TILDE)
  .replace(/punctSpace/g, PUNCT_SPACE_NO_TILDE)
  .replace(/punct/g, PUNCT_NO_TILDE)
  .getRegex();
INLINE.emStrongRDelimUnd = buildRegex(R_DELIM_UND, 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .replace(/punctSpace/g, PUNCT_SPACE)
  .replace(/punct/g, PUNCT)
  .getRegex();
// Strikethrough delimiters.
INLINE.delLDelim = buildRegex(/^~~?(?:((?!~)punct)|[^\s~])/, 'u')
  .replace(/punct/g, PUNCT)
  .getRegex();
const R_DELIM_DEL =
  '^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)';
INLINE.delRDelim = buildRegex(R_DELIM_DEL, 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .replace(/punctSpace/g, PUNCT_SPACE)
  .replace(/punct/g, PUNCT)
  .getRegex();
INLINE.del = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;

// Punctuation runs (used by the emphasis masking pass).
INLINE.anyPunctuation = buildRegex(/\\(punct)/, 'gu')
  .replace(/punct/g, PUNCT)
  .getRegex();
INLINE.anyPunctuationOutsideCode = buildRegex(
  /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/,
  'gu'
)
  .replace(/punct/g, PUNCT)
  .getRegex();
// Links / code spans / raw HTML, used to mask their contents out of the
// emphasis scan.
INLINE.blockSkip = buildRegex(/link|precode-code|html/, 'g')
  .replace(
    'link',
    /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/
  )
  .replace('precode-', HAS_LOOKBEHIND ? '(?<!`)()' : '(^^|[^`])')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/)
  .getRegex();

// Autolinks: <scheme:...> and <email>.
const EMAIL_INLINE =
  /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/;
INLINE.autolink = buildRegex(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace('email', EMAIL_INLINE)
  .getRegex();
// Inline HTML tag.
const HTML_COMMENT_CLOSED = buildRegex(HTML_COMMENT).replace('(?:-->|$)', '-->').getRegex();
INLINE.tag = buildRegex(
  '^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>'
)
  .replace('comment', HTML_COMMENT_CLOSED)
  .replace(
    'attribute',
    /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/
  )
  .getRegex();

// Link labels and destinations.
const BRACKETS = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const LABEL_INNER = buildRegex(
  /(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/
).replace('brackets', BRACKETS);
INLINE.link = buildRegex(
  /^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/
)
  .replace('label', LABEL_INNER)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace(
    'title',
    /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/
  )
  .getRegex();
INLINE.reflink = buildRegex(/^!?\[(label)\]\[(ref)\]/)
  .replace('label', LABEL_INNER)
  .replace('ref', LABEL)
  .getRegex();
INLINE.nolink = buildRegex(/^!?\[(ref)\](?:\[\])?/).replace('ref', LABEL).getRegex();
// The masking pass's search for reference-style links.
const LABEL_MASK = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const LABEL_INNER_MASK = buildRegex(
  /(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/
).replace('brackets', BRACKETS);
INLINE.reflinkSearch = buildRegex('reflink|nolink(?!\\()', 'g')
  .replace(
    'reflink',
    buildRegex(/^!?\[(label)\]\[(ref)\]/)
      .replace('label', LABEL_INNER_MASK)
      .replace('ref', LABEL_MASK)
      .getRegex()
  )
  .replace(
    'nolink',
    buildRegex(/^!?\[(ref)\](?:\[\])?/).replace('ref', LABEL_MASK).getRegex()
  )
  .getRegex();

// GFM extended autolinks: www., http(s)/ftp URLs, and bare email addresses.
// The bare-email alternative captures the `@` in group 2 (the mailto:/xmpp:
// alternative uses a group-less email pattern, so the groups line up with
// marked's).
const PROTOCOL = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const EMAIL_GFM =
  /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EMAIL_GFM_AT =
  /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const MAILTO_XMPP = buildRegex(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
  .replace(/email/g, EMAIL_GFM)
  .getRegex();
INLINE.url = buildRegex(
  /^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/
)
  .replace('emailProtocol', MAILTO_XMPP)
  .replace('protocol', PROTOCOL)
  .replace('email', EMAIL_GFM_AT)
  .getRegex();
INLINE.urlBackpedal =
  /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

// Plain-text runs (GFM): consumes as much as possible, stopping before any
// construct, a URL/email start, or a hard-break marker.
INLINE.text = buildRegex(
  /^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/
)
  .replace('protocol', PROTOCOL)
  .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
  .replace('wwwStart', HAS_LOOKBEHIND ? '(?<![^\\s*_~(])www\\.' : 'www\\.')
  .getRegex();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escape HTML special characters. With encode=true, `&` is escaped too (code
// spans and code blocks); otherwise valid entities are left alone.
function escapeHtml(str, encode) {
  if (encode) {
    if (RE.escapeTest.test(str)) return str.replace(RE.escapeReplace, (ch) => ESCAPE_MAP[ch]);
  } else if (RE.escapeTestNoEncode.test(str)) {
    return str.replace(RE.escapeReplaceNoEncode, (ch) => ESCAPE_MAP[ch]);
  }
  return str;
}

// Decode numeric character references; escape a bare `&` (marked's unescape).
function unescapeEntities(str) {
  if (RE.numericCharacterReference.test(str)) {
    return str.replace(RE.numericCharacterReferenceOrAmpersand, (match, dec, hex) => {
      if (dec === undefined && hex === undefined) return '&amp;';
      const code = hex === undefined ? parseInt(dec, 10) : parseInt(hex, 16);
      if (code === 0 || code > 0x10ffff || (code >= 0xD800 && code <= 0xDFFF)) return '�';
      if (code === 38) return '&amp;';
      return String.fromCodePoint(code);
    });
  }
  return str;
}

// Normalize a link label for lookup: trim, collapse whitespace, case-fold.
function normalizeLabel(label) {
  return label.trim().replace(RE.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Percent-encode a URL the way marked does (encodeURI, but keep % as %).
function encodeUri(href) {
  try {
    return encodeURI(href).replace(RE.percentDecode, '%');
  } catch {
    return null;
  }
}

// Strip a trailing run of `ch` (invert=true strips trailing chars that are
// NOT `ch`). Used for closing ATX hashes and trailing newlines.
function stripTrailing(str, ch, invert) {
  const n = str.length;
  if (n === 0) return '';
  let count = 0;
  for (; count < n; ) {
    const c = str.charAt(n - count - 1);
    if (c === ch && !invert) count++;
    else if (c !== ch && invert) count++;
    else break;
  }
  return str.slice(0, n - count);
}

// Remove up to two trailing blank lines from a code block's text.
function stripTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && RE.blankLine.test(lines[end])) end--;
  return lines.length - end <= 2 ? str : lines.slice(0, end + 1).join('\n');
}

// Expand tabs to spaces, each tab advancing to the next multiple of 4.
function expandTabs(str, startCol = 0) {
  let out = '';
  let col = startCol;
  for (const ch of str) {
    if (ch === '\t') {
      const n = 4 - (col % 4);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// Find the unmatched close paren in a link destination: returns the index of
// the first unmatched `)`, -2 if a `(` is never closed, -1 if balanced.
function findParenClose(str, pair) {
  if (str.indexOf(pair[0]) === -1 && str.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === pair[0]) depth++;
    else if (str[i] === pair[1] && (depth--, depth < 0)) return i;
  }
  return depth > 0 ? -2 : -1;
}

// Split a table row into cells, honouring escaped pipes.
function splitCells(row, count) {
  const replaced = row.replace(RE.findPipe, (match, offset, str) => {
    let escaped = false;
    let i = offset;
    while (--i >= 0 && str[i] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = replaced.split(RE.splitPipe);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(RE.slashPipe, '|');
  return cells;
}

// ---------------------------------------------------------------------------
// Sticky (position-anchored) versions of the anchored patterns, so the
// scanners can run on the whole source with lastIndex instead of slicing.
// ---------------------------------------------------------------------------

function sticky(re) {
  const src = re.source.replace(/(^|\|)\^/g, '$1');
  const flags = re.flags.replace('g', '') + 'y';
  return new RegExp(src, flags);
}

const SB = {}; // sticky block patterns
for (const key of [
  'newline', 'code', 'fences', 'heading', 'hr', 'blockquote', 'list', 'html',
  'def', 'lheading', 'table', 'paragraph', 'paragraphInner', 'text',
]) {
  SB[key] = sticky(BLOCK[key]);
}

const SI = {}; // sticky inline patterns
for (const key of [
  'escape', 'code', 'br', 'text', 'link', 'reflink', 'nolink',
  'emStrongLDelim', 'delLDelim', 'del', 'autolink', 'tag', 'url',
]) {
  SI[key] = sticky(INLINE[key]);
}

// ---------------------------------------------------------------------------
// Emphasis masking: hide link / code / HTML contents from the emphasis
// scanner, so a `*` inside a link label or a code span never counts as a
// delimiter. The mask preserves string length, so indexes line up.
// ---------------------------------------------------------------------------

// Does this text contain a link (inline or reference)? Used by the mask.
function linkInText(text, links) {
  if (!text.includes('[')) return false;
  const linkRe = INLINE.link;
  for (const m of text.matchAll(INLINE.blockSkip)) {
    if (linkRe.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of text.matchAll(INLINE.reflinkSearch)) {
    const s = m[0];
    const open = s.lastIndexOf('[');
    if (
      !(s.charAt(0) === '!' || !Object.hasOwn(links, normalizeLabel(s.slice(open + 1, -1)))) &&
      !(open > 1 && linkInText(s.slice(1, open - 1), links))
    ) {
      return true;
    }
  }
  return false;
}

// The masked source for an inline string, plus the last position at which a
// `*`, `_` or `~` run could close emphasis / strikethrough.
function computeMask(src, links) {
  let masked = src;
  if (links && src.includes('[')) {
    const re = INLINE.reflinkSearch;
    const maskRef = (match) => {
      const open = match.lastIndexOf('[');
      if (!Object.hasOwn(links, normalizeLabel(match.slice(open + 1, -1)))) return match;
      if (open > 1 && match.charAt(0) !== '!') {
        const inner = match.slice(1, open - 1);
        if (linkInText(inner, links)) {
          return '[' + inner.replace(re, maskRef) + '][' + 'a'.repeat(match.length - open - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match.length - 2) + ']';
    };
    masked = masked.replace(re, maskRef);
  }
  masked = masked.replace(INLINE.anyPunctuationOutsideCode, (match, ticks, punct) => {
    if (punct) return '+'.repeat(match.length);
    if (ticks) {
      return ticks + match.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks;
    }
    return match;
  });
  masked = masked.replace(INLINE.blockSkip, (match, _a, precode) => {
    const off = precode ? precode.length : 0;
    return match.slice(0, off) + '[' + 'a'.repeat(match.length - off - 2) + ']';
  });
  // Last possible closer: the start of the last delimiter run that is not
  // preceded by whitespace.
  const last = { '*': -1, '_': -1 };
  let lastTilde = -1;
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const r = masked[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const prev = s === 0 ? '\n' : masked[s - 1];
    let i = s + 1;
    while (i < n && masked[i] === r) i++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (r === '~') lastTilde = s;
      else last[r] = s;
    }
    s = i - 1;
  }
  return { masked, last, lastTilde };
}

// ---------------------------------------------------------------------------
// Inline parser: a scanner that renders HTML directly (no token tree).
// ---------------------------------------------------------------------------

// Does a link label contain raw HTML / an autolink that reaches past the
// label? If so the link is invalid (marked's `Be` check).
function labelHasHtml(src, label, offset) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') {
      s++;
      continue;
    }
    if (label[s] === '`') {
      const m = INLINE.code.exec(label.slice(s));
      if (m) {
        s += m[0].length - 1;
        continue;
      }
    }
    if (label[s] !== '<') continue;
    const rest = src.slice(offset + s);
    const m = INLINE.tag.exec(rest) || INLINE.autolink.exec(rest);
    if (m) {
      if (m[0].length > label.length - s) return true;
      s += m[0].length - 1;
    }
  }
  return false;
}

// Build a link or image from a matched link/reflink. Returns the rendered
// HTML and the raw length consumed, or null when the link must be dropped
// (its label contained a link of its own). `state.linkEmitted` is the shared
// flag: a link created anywhere inside the label sets it, which drops an
// outer link (marked's De).
function buildLink(ctx, match, href, title, isImage) {
  const labelRaw = match[1].replace(RE.outputLinkReplace, '$1');
  const savedInLink = ctx.state.inLink;
  const savedEmitted = ctx.state.linkEmitted;
  const savedRawBlock = ctx.state.inRawBlock;
  ctx.state.inLink = true;
  ctx.state.linkEmitted = false;
  // An image's alt text is always rendered as plain text; a link label
  // inherits the caller's mode.
  const inner = renderInline(labelRaw, ctx.links, ctx.state, isImage ? true : ctx.plain, false);
  const emittedInside = inner.linkEmitted;
  ctx.state.linkEmitted = savedEmitted;
  ctx.state.inLink = savedInLink;
  if (!isImage) {
    if (emittedInside) {
      ctx.state.inRawBlock = savedRawBlock;
      return null;
    }
    ctx.state.linkEmitted = true;
  }
  if (ctx.plain) {
    // In plain-text mode (image alt text) a link renders as its label text.
    return { html: inner.html, end: match[0].length };
  }
  if (isImage) {
    const encoded = encodeUri(href);
    if (encoded === null) return { html: escapeHtml(inner.html), end: match[0].length };
    let out = '<img src="' + escapeHtml(encoded) + '" alt="' + escapeHtml(inner.html) + '"';
    if (title) out += ' title="' + escapeHtml(title) + '"';
    return { html: out + '>', end: match[0].length };
  }
  const encoded = encodeUri(href);
  if (encoded === null) return { html: inner.html, end: match[0].length };
  // A plain link's href is escaped without encoding `&` (valid entities in
  // the destination stay as-is); only autolinks encode `&`.
  let out = '<a href="' + escapeHtml(encoded) + '"';
  if (title) out += ' title="' + escapeHtml(title) + '"';
  return { html: out + '>' + inner.html + '</a>', end: match[0].length };
}

// Try an inline link `[text](dest "title")` at position pos. Returns the
// rendered result or null.
function tryInlineLink(ctx, pos) {
  if (!ctx.linkParenPossible) return null;
  SI.link.lastIndex = pos;
  const m = SI.link.exec(ctx.src);
  if (!m) return null;
  const offset = m[0].charAt(0) === '!' ? 2 : 1;
  if (labelHasHtml(ctx.src, m[1], pos + offset)) return null;
  let dest = m[2].trim();
  let title = '';
  if (RE.startAngleBracket.test(dest)) {
    if (!RE.endAngleBracket.test(dest)) return null;
    const stripped = stripTrailing(dest.slice(0, -1), '\\');
    if ((dest.length - stripped.length) % 2 === 0) return null;
  } else {
    const close = findParenClose(m[2], '()');
    if (close === -2) return null;
    if (close > -1) {
      const cut = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + close;
      m[2] = m[2].substring(0, close);
      m[0] = m[0].substring(0, cut).trim();
      m[3] = '';
    }
  }
  const rawStripped = stripTrailing(m[0].slice(0, -1), '\\');
  if ((m[0].length - rawStripped.length) % 2 === 0) return null;
  dest = m[2];
  if (m[3]) title = m[3].slice(1, -1);
  dest = dest.trim();
  if (RE.startAngleBracket.test(dest)) dest = dest.slice(1, -1);
  const href = dest.replace(INLINE.anyPunctuation, '$1');
  const cleanTitle = title ? title.replace(INLINE.anyPunctuation, '$1') : '';
  return buildLink(ctx, m, href, cleanTitle, m[0].charAt(0) === '!');
}

// Try a reference link `[text][label]`, `[text][]` or `[text]` at pos.
function tryRefLink(ctx, pos) {
  SI.reflink.lastIndex = pos;
  let m = SI.reflink.exec(ctx.src);
  if (!m) {
    SI.nolink.lastIndex = pos;
    m = SI.nolink.exec(ctx.src);
    if (!m) return null;
  }
  const offset = m[0].charAt(0) === '!' ? 2 : 1;
  if (labelHasHtml(ctx.src, m[1], pos + offset)) return null;
  const ref = ctx.links[normalizeLabel(m[2] || m[1])];
  if (!ref) {
    // Not a defined reference: the `[` (or `!`) is literal text.
    return { html: null, end: 1, literal: m[0].charAt(0) };
  }
  return buildLink(ctx, m, ref.href, ref.title, m[0].charAt(0) === '!');
}

// Emphasis / strong. Returns {html, end} or null. `prev` is the character
// before this position ('' at the start or after a non-text token).
function tryEmStrong(ctx, pos, prev) {
  const src = ctx.src;
  SI.emStrongLDelim.lastIndex = pos;
  const s = SI.emStrongLDelim.exec(src);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return null;
  const delim = s[0][0]; // '*' or '_'
  const sameAsPrev = prev === delim;
  if (!ctx.mask) ctx.mask = computeMask(src, ctx.links);
  const masked = ctx.mask.masked;
  const i = masked.length - src.length + pos; // offset of pos in the masked source
  let l = i;
  while (l > 0 && masked[l - 1] === delim) l--;
  const p = [...masked.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const h = p === '*' || p === '_' || !!INLINE.punctuation.exec(p);
  let n = prev;
  if (l < i) n = p;
  const u = l < i ? h : !!INLINE.punctuation.exec(n);
  if (s[4] && n.match(RE.unicodeAlphaNumeric)) return null;
  const d = s[1] || s[3] || '';
  // An opener must be left-flanking: not followed by punctuation while
  // preceded by a non-punctuation character.
  if (d && n && !u) return null;
  const k = [...s[0]].length - 1; // opening run length
  let m = k;
  let f = 0;
  const y = i - l + k;
  const canClose = !!p.trim() && (!!d || (delim === '*' && !h));
  const rDelim = delim === '*' ? INLINE.emStrongRDelimAst : INLINE.emStrongRDelimUnd;
  const last = ctx.mask.last[delim];
  const q = masked.length - src.length + pos + k; // index just after the opener
  if (last < q) return null;
  const slice = masked.slice(q);
  const maxIndex = last - q;
  rDelim.lastIndex = 0;
  let match;
  while ((match = rDelim.exec(slice)) !== null && !(match.index > maxIndex)) {
    const g = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
    if (!g) continue;
    const b0 = [...g].length;
    if (match[3] || match[4]) {
      m += b0;
      continue;
    } else if (match[5] || match[6] || canClose) {
      if (sameAsPrev && (match[5] || match[6])) break;
      if (y % 3 && !((y + b0) % 3)) {
        f += b0;
        continue;
      }
    }
    m -= b0;
    if (m > 0) continue;
    const b = Math.min(b0, b0 + m + f);
    const firstLen = [...match[0]][0].length;
    const raw = src.slice(pos, pos + k + match.index + firstLen + b);
    if (Math.min(k, b) % 2) {
      const innerText = raw.slice(1, -1);
      const inner = renderInline(innerText, ctx.links, ctx.state, ctx.plain, false);
      return {
        html: ctx.plain ? inner.html : '<em>' + inner.html + '</em>',
        end: raw.length,
      };
    }
    const innerText = raw.slice(2, -2);
    const inner = renderInline(innerText, ctx.links, ctx.state, ctx.plain, false);
    return {
      html: ctx.plain ? inner.html : '<strong>' + inner.html + '</strong>',
      end: raw.length,
    };
  }
  return null;
}

// Strikethrough. Returns {html, end} or null.
function tryDel(ctx, pos, prev) {
  const src = ctx.src;
  SI.delLDelim.lastIndex = pos;
  const s = SI.delLDelim.exec(src);
  if (!s) return null;
  // An opener must be left-flanking: not followed by punctuation while
  // preceded by a non-punctuation character.
  if (s[1] && prev && !INLINE.punctuation.exec(prev)) return null;
  const runLen = [...s[0]].length - 1;
  let p = runLen;
  if (!ctx.mask) ctx.mask = computeMask(src, ctx.links);
  const masked = ctx.mask.masked;
  const last = ctx.mask.lastTilde;
  const d = masked.length - src.length + pos + runLen;
  if (last < d) return null;
  const slice = masked.slice(d);
  const maxIndex = last - d;
  const rDelim = INLINE.delRDelim;
  rDelim.lastIndex = 0;
  let match;
  while ((match = rDelim.exec(slice)) !== null && !(match.index > maxIndex)) {
    const g = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
    if (!g) continue;
    const len = [...g].length;
    if (len !== runLen) continue;
    if (match[3] || match[4]) {
      p += len;
      continue;
    }
    p -= len;
    if (p > 0) continue;
    const use = Math.min(len, len + p);
    const firstLen = [...match[0]][0].length;
    const raw = src.slice(pos, pos + runLen + match.index + firstLen + use);
    const innerText = raw.slice(runLen, -runLen);
    const inner = renderInline(innerText, ctx.links, ctx.state, ctx.plain, false);
    return {
      html: ctx.plain ? inner.html : '<del>' + inner.html + '</del>',
      end: raw.length,
    };
  }
  return null;
}

// GFM extended autolink (www., http(s)/ftp URL, bare email) at pos.
function tryUrl(ctx, pos) {
  SI.url.lastIndex = pos;
  const m = SI.url.exec(ctx.src);
  if (!m) return null;
  let text;
  let href;
  if (m[2] === '@') {
    text = m[0];
    href = 'mailto:' + text;
  } else {
    let raw = m[0];
    do {
      const prev = raw;
      INLINE.urlBackpedal.lastIndex = 0;
      const back = INLINE.urlBackpedal.exec(raw);
      raw = back ? back[0] : '';
      if (raw === prev) break;
    } while (true);
    text = raw;
    href = m[1] === 'www.' ? 'http://' + raw : raw;
  }
  if (ctx.plain) return { html: text, end: text.length };
  const encoded = encodeUri(href);
  if (encoded === null) return { html: escapeHtml(text, true), end: text.length };
  return {
    html: '<a href="' + escapeHtml(encoded, true) + '">' + escapeHtml(text, true) + '</a>',
    end: text.length,
  };
}

// Render one inline string to HTML. `resetRaw` resets inRawBlock (top-level
// inline strings only); nested parses (link labels, emphasis contents) keep
// the caller's inRawBlock. Returns {html, linkEmitted}.
function renderInline(src, links, state, plain, resetRaw = true) {
  if (resetRaw) state.inRawBlock = false;
  const ctx = {
    src,
    links,
    state,
    plain: !!plain,
    mask: null,
    linkParenPossible: true,
  };
  const savedParen = state.linkParenPossible;
  ctx.linkParenPossible = (savedParen !== false) && src.includes(')');
  state.linkParenPossible = ctx.linkParenPossible;
  let out = '';
  let pos = 0;
  const len = src.length;
  let prev = '';
  let prevText = false;
  try {
    while (pos < len) {
      if (!prevText) prev = '';
      prevText = false;
      const ch = src[pos];
      // Backslash escape.
      if (ch === '\\') {
        SI.escape.lastIndex = pos;
        const m = SI.escape.exec(src);
        if (m) {
          out += ctx.plain ? m[1] : escapeHtml(m[1]);
          pos += m[0].length;
          continue;
        }
      }
      // Raw HTML tag or autolink <...>.
      if (ch === '<') {
        SI.tag.lastIndex = pos;
        const m = SI.tag.exec(src);
        if (m) {
          if (!state.inLink && RE.startATag.test(m[0])) state.inLink = true;
          else if (state.inLink && RE.endATag.test(m[0])) state.inLink = false;
          if (!state.inRawBlock && RE.startPreScriptTag.test(m[0])) state.inRawBlock = true;
          else if (state.inRawBlock && RE.endPreScriptTag.test(m[0])) state.inRawBlock = false;
          out += m[0];
          pos += m[0].length;
          continue;
        }
        SI.autolink.lastIndex = pos;
        const a = SI.autolink.exec(src);
        if (a) {
          let text;
          let href;
          if (a[2] === '@') {
            text = a[1];
            href = 'mailto:' + text;
          } else {
            text = a[1];
            href = text;
          }
          if (ctx.plain) {
            out += text;
          } else {
            const encoded = encodeUri(href);
            if (encoded === null) out += escapeHtml(text, true);
            else {
              out += '<a href="' + escapeHtml(encoded, true) + '">' + escapeHtml(text, true) + '</a>';
            }
          }
          // An autolink <...> does not set linkEmitted (only links built
          // through buildLink do), so it never drops an outer link.
          pos += a[0].length;
          continue;
        }
      }
      // Links and images.
      if (ch === '[' || (ch === '!' && src[pos + 1] === '[')) {
        const link = tryInlineLink(ctx, pos);
        if (link) {
          out += link.html;
          pos += link.end;
          continue;
        }
        const ref = tryRefLink(ctx, pos);
        if (ref) {
          if (ref.html !== null) {
            out += ref.html;
            pos += ref.end;
            continue;
          }
          // Undefined reference: the `[` (or `!`) is literal text; fall
          // through to the text run, which will consume it.
        }
      }
      // Emphasis / strong.
      if (ch === '*' || ch === '_') {
        const em = tryEmStrong(ctx, pos, prev);
        if (em) {
          out += em.html;
          pos += em.end;
          continue;
        }
      }
      // Code span.
      if (ch === '`') {
        SI.code.lastIndex = pos;
        const m = SI.code.exec(src);
        if (m) {
          let text = m[2].replace(RE.newLineCharGlobal, ' ');
          const hasNonSpace = RE.nonSpaceChar.test(text);
          const padded = RE.startingSpaceChar.test(text) && RE.endingSpaceChar.test(text);
          if (hasNonSpace && padded) text = text.substring(1, text.length - 1);
          out += ctx.plain ? text : '<code>' + escapeHtml(text, true) + '</code>';
          pos += m[0].length;
          continue;
        }
      }
      // Hard break (two or more spaces, or a backslash, before a newline).
      if (ch === ' ' || ch === '\\') {
        SI.br.lastIndex = pos;
        const m = SI.br.exec(src);
        if (m) {
          if (!ctx.plain) out += '<br>';
          pos += m[0].length;
          continue;
        }
      }
      // Strikethrough.
      if (ch === '~') {
        const del = tryDel(ctx, pos, prev);
        if (del) {
          out += del.html;
          pos += del.end;
          continue;
        }
      }
      // GFM autolink: www., a URL scheme, mailto:/xmpp:, or an email.
      if (!state.inLink) {
        let maybeUrl = false;
        if (ch === 'w' && src.startsWith('www.', pos)) maybeUrl = true;
        else if (
          (ch === 'h' || ch === 'H' || ch === 'f' || ch === 'F') &&
          /^(?:https?|ftp):\/\//i.test(src.slice(pos, pos + 8))
        ) {
          maybeUrl = true;
        } else if (
          (ch === 'm' || ch === 'x') &&
          (src.startsWith('mailto:', pos) || src.startsWith('xmpp:', pos))
        ) {
          maybeUrl = true;
        } else if (/[A-Za-z0-9]/.test(ch)) {
          // An email address: an `@` later in this word.
          let i = pos;
          while (i < len && /[A-Za-z0-9._+\-]/.test(src[i])) i++;
          if (i < len && src[i] === '@') maybeUrl = true;
        }
        if (maybeUrl) {
          const url = tryUrl(ctx, pos);
          if (url) {
            // Note: a GFM autolink does NOT set linkEmitted (only links
            // built through buildLink do), so it never drops an outer link.
            out += url.html;
            pos += url.end;
            continue;
          }
        }
      }
      // Plain text run.
      SI.text.lastIndex = pos;
      const m = SI.text.exec(src);
      if (m && m[0].length > 0) {
        const raw = m[0];
        if (ctx.plain) {
          out += state.inRawBlock ? raw : unescapeEntities(raw);
        } else if (state.inRawBlock) {
          out += raw;
        } else {
          out += escapeHtml(unescapeEntities(raw));
        }
        if (raw.slice(-1) !== '_') prev = raw.slice(-1);
        prevText = true;
        pos += raw.length;
        continue;
      }
      // The text pattern should always match at least one character; if it
      // does not, consume one character as text to guarantee progress.
      const one = src[pos];
      if (ctx.plain) {
        out += state.inRawBlock ? one : unescapeEntities(one);
      } else if (state.inRawBlock) {
        out += one;
      } else {
        out += escapeHtml(unescapeEntities(one));
      }
      if (one !== '_') prev = one;
      prevText = true;
      pos += 1;
    }
  } finally {
    state.linkParenPossible = savedParen;
  }
  return { html: out, linkEmitted: state.linkEmitted };
}

// ---------------------------------------------------------------------------
// Block lexer: produces a lean node tree plus the link-reference map.
// Nodes: {t, ...}. Inline text is parsed at render time, once the whole
// document's link definitions are known (a definition later in the document
// can serve a link earlier in it).
// ---------------------------------------------------------------------------

// Checkbox HTML for a task-list item (marked's checkbox renderer: the
// input element, with a trailing space). The token's `raw` ("[ ] ") is
// only used by the plain-text renderer, never here.
function checkboxHtml(checked) {
  return '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

// Lex the blocks in `src` (a whole document, a blockquote chunk, or a list
// item's text). `state.top` selects paragraph (true) versus text (false)
// tokens for plain lines. `mergePara` (blockquote chunks only) merges the
// first paragraph with the previous chunk's trailing paragraph. `out` is the
// array blocks are appended to (shared across blockquote chunks, so a
// paragraph can merge with the previous chunk's). Returns the array.
function lexBlocks(src, state, links, mergePara = false, out = null) {
  const blocks = out || [];
  let pos = 0;
  const len = src.length;
  let guard = len + 1;
  // The type of the last token processed, including tokens that are not
  // pushed as blocks (a space run, a link definition). It decides whether
  // a following definition / indented code block is absorbed into a
  // preceding paragraph, and whether a text token merges with the one
  // before it. It lives on the blocks array so it carries across
  // blockquote chunks, which share one array.
  let lastToken = blocks.lastToken ?? null;
  while (pos < len) {
    if (len - pos >= guard) throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    guard = len - pos;
    const startPos = pos;

    // Blank lines / whitespace.
    SB.newline.lastIndex = pos;
    let m = SB.newline.exec(src);
    if (m && m[0].length > 0) {
      const run = m[0];
      pos += run.length;
      if (run.length === 1 && lastToken !== null) {
        // A single newline is folded into the previous token in marked;
        // it does not break merging and is not a space token.
      } else {
        lastToken = 'space';
        if (/\n.*\n/.test(run)) blocks.hasBlankLine = true;
      }
      continue;
    }

    // Indented code block.
    SB.code.lastIndex = pos;
    m = SB.code.exec(src);
    if (m) {
      const raw = stripTrailingBlankLines(m[0]);
      const text = raw.replace(RE.codeRemoveIndent, '');
      if (
        (lastToken === 'paragraph' || lastToken === 'text') &&
        blocks[blocks.length - 1] &&
        (blocks[blocks.length - 1].t === 'paragraph' || blocks[blocks.length - 1].t === 'text')
      ) {
        // An indented code block cannot interrupt a paragraph: it is
        // absorbed into the paragraph's text.
        blocks[blocks.length - 1].text += '\n' + text;
      } else {
        blocks.push({ t: 'code', text, lang: '' });
        lastToken = 'code';
      }
      pos += raw.length;
      continue;
    }

    // Fenced code block.
    SB.fences.lastIndex = pos;
    m = SB.fences.exec(src);
    if (m) {
      const info = m[2] ? m[2].trim().replace(INLINE.anyPunctuation, '$1') : m[2];
      let text = m[3] || '';
      // Indent compensation: if the opening fence is indented, strip that
      // much indent from the content lines.
      const indentMatch = m[0].match(RE.indentCodeCompensation);
      if (indentMatch) {
        const indent = indentMatch[1];
        text = text
          .split('\n')
          .map((line) => {
            const lead = line.match(RE.beginningSpace);
            if (!lead) return line;
            return line.slice(Math.min(lead[0].length, indent.length));
          })
          .join('\n');
      }
      blocks.push({ t: 'code', text, lang: info });
      lastToken = 'code';
      pos += m[0].length;
      continue;
    }

    // ATX heading.
    SB.heading.lastIndex = pos;
    m = SB.heading.exec(src);
    if (m) {
      let text = m[2].trim();
      if (RE.endingHash.test(text)) {
        const stripped = stripTrailing(text, '#');
        if (!stripped || RE.endingSpaceTabChar.test(stripped)) text = stripped.trim();
      }
      blocks.push({ t: 'heading', depth: m[1].length, text });
      lastToken = 'heading';
      pos += stripTrailing(m[0], '\n').length;
      continue;
    }

    // Thematic break.
    SB.hr.lastIndex = pos;
    m = SB.hr.exec(src);
    if (m) {
      blocks.push({ t: 'hr' });
      lastToken = 'hr';
      pos += stripTrailing(m[0], '\n').length;
      continue;
    }

    // Blockquote.
    const bq = lexBlockquote(src, pos, state, links);
    if (bq) {
      blocks.push(bq.node);
      lastToken = 'blockquote';
      pos = bq.end;
      continue;
    }

    // List.
    const list = lexList(src, pos, state, links);
    if (list) {
      blocks.push(list.node);
      lastToken = 'list';
      pos = list.end;
      continue;
    }

    // HTML block.
    SB.html.lastIndex = pos;
    m = SB.html.exec(src);
    if (m) {
      const raw = stripTrailingBlankLines(m[0]);
      blocks.push({
        t: 'html',
        text: raw,
        pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style',
      });
      lastToken = 'html';
      pos += raw.length;
      continue;
    }

    // Link reference definition.
    SB.def.lastIndex = pos;
    m = SB.def.exec(src);
    if (m) {
      if (!RE.startAngleBracket.test(m[2]) && findParenClose(m[2], '()') !== -1) {
        // Unbalanced parens in a bare destination: not a definition.
      } else {
        const raw = stripTrailing(m[0], '\n');
        const tag = normalizeLabel(m[1]);
        const href = m[2]
          ? m[2].replace(RE.hrefBrackets, '$1').replace(INLINE.anyPunctuation, '$1')
          : '';
        const title = m[3]
          ? m[3].substring(1, m[3].length - 1).replace(INLINE.anyPunctuation, '$1')
          : m[3];
        const prev = blocks[blocks.length - 1];
        if (
          (lastToken === 'paragraph' || lastToken === 'text') &&
          prev &&
          (prev.t === 'paragraph' || prev.t === 'text')
        ) {
          // A definition directly after a paragraph is absorbed into it.
          prev.text += '\n' + raw;
        } else {
          if (!links[tag]) links[tag] = { href, title };
        }
        lastToken = 'def';
        pos += raw.length;
        continue;
      }
    }

    // Table (GFM).
    SB.table.lastIndex = pos;
    m = SB.table.exec(src);
    if (m && RE.tableDelimiter.test(m[2])) {
      const headerCells = splitCells(m[1]);
      const alignsRaw = m[2].replace(RE.tableAlignChars, '').split('|');
      const aligns = [];
      if (headerCells.length === alignsRaw.length) {
        for (const a of alignsRaw) {
          if (RE.tableAlignRight.test(a)) aligns.push('right');
          else if (RE.tableAlignCenter.test(a)) aligns.push('center');
          else if (RE.tableAlignLeft.test(a)) aligns.push('left');
          else aligns.push(null);
        }
        const header = headerCells.map((text, i) => ({
          text,
          align: aligns[i],
          header: true,
        }));
        const rows = [];
        if (m[3] && m[3].trim()) {
          for (const line of m[3].replace(RE.tableRowBlankLine, '').split('\n')) {
            rows.push(
              splitCells(line, header.length).map((text, i) => ({
                text,
                align: aligns[i],
                header: false,
              }))
            );
          }
        }
        blocks.push({ t: 'table', header, align: aligns, rows });
        lastToken = 'table';
        pos += stripTrailing(m[0], '\n').length;
        continue;
      }
    }

    // Setext heading.
    SB.lheading.lastIndex = pos;
    m = SB.lheading.exec(src);
    if (m) {
      blocks.push({
        t: 'heading',
        depth: m[2].charAt(0) === '=' ? 1 : 2,
        text: m[1].trim(),
      });
      lastToken = 'heading';
      pos += stripTrailing(m[0], '\n').length;
      continue;
    }

    // Paragraph (only at the top level or inside a blockquote).
    if (state.top) {
      SB.paragraph.lastIndex = pos;
      m = SB.paragraph.exec(src);
      if (m) {
        let text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
        const prev = blocks[blocks.length - 1];
        if (mergePara && lastToken === 'paragraph' && prev && prev.t === 'paragraph') {
          prev.text += '\n' + text;
        } else {
          blocks.push({ t: 'paragraph', text });
        }
        mergePara = false;
        lastToken = 'paragraph';
        pos += m[0].length;
        continue;
      }
    }

    // Plain text (a single line; merges with a preceding text block).
    SB.text.lastIndex = pos;
    m = SB.text.exec(src);
    if (m) {
      const prev = blocks[blocks.length - 1];
      if (lastToken === 'text' && prev && prev.t === 'text') {
        prev.text += '\n' + m[0];
      } else {
        blocks.push({ t: 'text', text: m[0] });
      }
      lastToken = 'text';
      pos += m[0].length;
      continue;
    }

    if (pos === startPos) throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
  }
  state.top = true;
  blocks.lastToken = lastToken;
  return blocks;
}

// Blockquote: gather `>` lines in chunks, strip the markers, and lex the
// inner content (paragraphs merge across chunks for lazy continuation).
function lexBlockquote(src, pos, state, links) {
  SB.blockquote.lastIndex = pos;
  const m = SB.blockquote.exec(src);
  if (!m) return null;
  let lines = stripTrailing(m[0], '\n').split('\n');
  let rawOut = '';
  let textOut = '';
  const blocks = [];
  while (lines.length > 0) {
    let seenMarker = false;
    const chunk = [];
    let p = 0;
    for (p = 0; p < lines.length; p++) {
      if (RE.blockquoteStart.test(lines[p])) {
        chunk.push(lines[p]);
        seenMarker = true;
      } else if (!seenMarker) {
        chunk.push(lines[p]);
      } else {
        break;
      }
    }
    lines = lines.slice(p);
    const chunkStr = chunk.join('\n');
    const inner = chunkStr
      .replace(RE.blockquoteMarkerWhitespace, (match, marker, ws) => marker + expandTabs(ws, marker.length))
      .replace(RE.blockquoteSetextReplace, '\n    $1')
      .replace(RE.blockquoteSetextReplace2, '');
    rawOut = rawOut ? rawOut + '\n' + chunkStr : chunkStr;
    textOut = textOut ? textOut + '\n' + inner : inner;
    const savedTop = state.top;
    state.top = true;
    // Lex into the shared blocks array, so a paragraph at the start of
    // this chunk can merge with the previous chunk's trailing paragraph
    // (lazy continuation).
    lexBlocks(inner, state, links, true, blocks);
    state.top = savedTop;
    if (lines.length === 0) break;
    const last = blocks[blocks.length - 1];
    if (last && (last.t === 'code' || last.t === 'heading' || last.t === 'hr' || last.t === 'html' || last.t === 'table')) {
      break;
    }
    if (last && last.t === 'blockquote') {
      const nested = last;
      const rest = nested.raw + '\n' + lines.join('\n').replace(RE.blockquoteSetextReplace2, '');
      const reparsed = lexBlockquote(rest, 0, state, links);
      blocks[blocks.length - 1] = reparsed.node;
      const leftover = rest.substring(reparsed.node.raw.length).replace(/^\n/, '');
      const leftoverLines = leftover ? leftover.split('\n').length : 0;
      const consumedLines = leftoverLines > 0 ? lines.slice(0, -leftoverLines) : lines;
      if (consumedLines.length > 0) {
        rawOut += '\n' + consumedLines.join('\n');
      }
      textOut = textOut.substring(0, textOut.length - nested.text.length) + reparsed.node.text;
      lines = leftoverLines > 0 ? lines.slice(lines.length - leftoverLines) : [];
      if (lines.length > 0 && RE.blockquoteStart.test(lines[0])) continue;
      break;
    } else if (last && last.t === 'list') {
      const nested = last;
      const rest = nested.raw + '\n' + lines.join('\n');
      const reparsed = lexList(rest, 0, state, links);
      blocks[blocks.length - 1] = reparsed.node;
      const extra = reparsed.node.raw.length > nested.raw.length
        ? rest.slice(nested.raw.length + 1, reparsed.node.raw.length).split('\n').length
        : 0;
      if (extra > 0) {
        const used = lines.slice(0, extra).join('\n');
        rawOut += '\n' + used;
        textOut += '\n' + used;
      }
      lines = lines.slice(extra);
      continue;
    }
  }
  return { node: { t: 'blockquote', blocks, raw: rawOut, text: textOut }, end: pos + rawOut.length };
}

// Sticky list-item matcher, cached by bullet pattern.
const listItemStickyCache = new Map();
function listItemSticky(bull) {
  let re = listItemStickyCache.get(bull);
  if (!re) {
    re = sticky(RE.listItemRegex(bull));
    listItemStickyCache.set(bull, re);
  }
  return re;
}

// List: bullet or ordered, with nesting, task items, and loose detection.
function lexList(src, pos, state, links) {
  SB.list.lastIndex = pos;
  const first = SB.list.exec(src);
  if (!first) return null;
  const startOffset = pos;
  let rest = src.slice(pos);
  const full = src;
  const consumed = () => full.length - rest.length;
  const bulletRaw = first[1].trim();
  const ordered = bulletRaw.length > 1;
  const list = {
    t: 'list',
    raw: '',
    ordered,
    start: ordered ? +bulletRaw.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  const bullPattern = ordered ? `\\d{1,9}\\${bulletRaw.slice(-1)}` : `\\${bulletRaw}`;
  const itemRe = listItemSticky(bullPattern);
  let pendingLoose = false;
  while (rest) {
    let emptyItem = false;
    let itemText = '';
    itemRe.lastIndex = 0;
    const item = itemRe.exec(rest);
    if (!item || BLOCK.hr.test(rest)) break;
    const itemStart = consumed();
    rest = rest.substring(item[0].length);
    const firstLine = item[2].split('\n', 1)[0];
    const bulletLen = item[1].length;
    const expanded = firstLine.replace(RE.leadingSpaceTab, (ws) => expandTabs(ws, bulletLen));
    const nextLine = rest.split('\n', 1)[0];
    let lineEmpty = !expanded.trim();
    let indent;
    if (lineEmpty) {
      indent = bulletLen + 1;
    } else {
      indent = expanded.search(RE.nonSpaceChar);
      if (indent > 4) indent = 1;
      itemText = expanded.slice(indent);
      indent += bulletLen;
    }
    if (lineEmpty && RE.blankLine.test(nextLine)) {
      rest = rest.substring(nextLine.length + 1);
      emptyItem = true;
    }
    if (!emptyItem) {
      const nextBullet = RE.nextBulletRegex(indent);
      const hrRe = RE.hrRegex(indent);
      const fencesRe = RE.fencesBeginRegex(indent);
      const headingRe = RE.headingBeginRegex(indent);
      const htmlRe = RE.htmlBeginRegex(indent);
      const bqRe = RE.blockquoteBeginRegex(indent);
      let cur = expanded;
      while (rest) {
        const line = rest.split('\n', 1)[0];
        let lineText = line;
        const expandedLine = line.replace(RE.leadingSpaceTab, (ws) => expandTabs(ws));
        if (
          fencesRe.test(lineText) ||
          headingRe.test(lineText) ||
          htmlRe.test(lineText) ||
          bqRe.test(lineText) ||
          nextBullet.test(lineText) ||
          hrRe.test(lineText)
        ) {
          break;
        }
        if (expandedLine.search(RE.nonSpaceChar) >= indent || !lineText.trim()) {
          itemText += '\n' + expandedLine.slice(indent);
        } else {
          if (
            lineEmpty ||
            cur.replace(RE.tabCharGlobal, '    ').search(RE.nonSpaceChar) >= 4 ||
            fencesRe.test(cur) ||
            headingRe.test(cur) ||
            htmlRe.test(cur) ||
            hrRe.test(cur)
          ) {
            break;
          }
          let cont = lineText;
          if (
            /^ {0,3}(?:=+|-+) *$/.test(lineText) &&
            BLOCK.lheading.test(`${cur}\n${lineText}`)
          ) {
            cont = '    ' + expandedLine.replace(/^ {0,3}/, '');
          }
          itemText += '\n' + cont;
        }
        lineEmpty = !lineText.trim();
        rest = rest.substring(line.length + 1);
        cur = expandedLine.slice(indent);
      }
    }
    const itemRaw = full.slice(itemStart, consumed());
    if (!list.loose) {
      if (pendingLoose) list.loose = true;
      else if (RE.doubleBlankLine.test(itemRaw)) pendingLoose = true;
    }
    list.items.push({
      t: 'list_item',
      raw: itemRaw,
      task: RE.listIsTask.test(itemText),
      loose: false,
      text: itemText,
      blocks: [],
    });
  }
  const lastItem = list.items[list.items.length - 1];
  if (!lastItem) return null;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  list.raw = full.slice(startOffset, consumed()).trimEnd();
  // Lex each item's content (as text blocks, not paragraphs) and decide
  // looseness: an item whose blocks contain a blank line makes the list
  // loose (marked's space-token test).
  for (const item of list.items) {
    state.top = false;
    item.blocks = lexBlocks(item.text, state, links, false);
    if (!list.loose && item.blocks.hasBlankLine) list.loose = true;
  }
  // Task items: strip the checkbox marker and record it.
  for (const item of list.items) {
    const firstBlock = item.blocks[0];
    if (item.task && firstBlock && (firstBlock.t === 'text' || firstBlock.t === 'paragraph')) {
      item.text = item.text.replace(RE.listReplaceTask, '');
      firstBlock.text = firstBlock.text.replace(RE.listReplaceTask, '');
      const cb = RE.listTaskCheckbox.exec(item.raw);
      if (cb) {
        const checked = cb[0] !== '[ ]';
        if (list.loose) {
          firstBlock.cb = checked;
          firstBlock.cbRaw = cb[0] + ' ';
        } else {
          item.blocks.unshift({ t: 'checkbox', checked, raw: cb[0] + ' ' });
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const b of item.blocks) {
        if (b.t === 'text') b.t = 'paragraph';
      }
    }
  }
  return { node: list, end: startOffset + list.raw.length };
}

// ---------------------------------------------------------------------------
// Renderer: blocks -> HTML (inline parsing happens here, with the complete
// link map).
// ---------------------------------------------------------------------------

function renderTableCell(cell, links, state) {
  const inner = renderInline(cell.text, links, state, false).html;
  const tag = cell.header ? 'th' : 'td';
  return (cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`) + inner + `</${tag}>\n`;
}

function renderBlock(node, links, state) {
  switch (node.t) {
    case 'space':
      return '';
    case 'hr':
      return '<hr>\n';
    case 'code': {
      const langWord = node.lang ? node.lang.match(RE.notSpaceStart)?.[0] : '';
      const text = node.text ? node.text.replace(RE.endingNewline, '') + '\n' : '';
      const escaped = escapeHtml(text, true);
      if (langWord) {
        return '<pre><code class="language-' + escapeHtml(langWord) + '">' + escaped + '</code></pre>\n';
      }
      return '<pre><code>' + escaped + '</code></pre>\n';
    }
    case 'heading': {
      const inner = renderInline(node.text, links, state, false).html;
      return `<h${node.depth}>${inner}</h${node.depth}>\n`;
    }
    case 'blockquote':
      return `<blockquote>\n${renderBlocks(node.blocks, links, state)}</blockquote>\n`;
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      const start = node.ordered && node.start !== 1 ? ` start="${node.start}"` : '';
      let items = '';
      for (const item of node.items) {
        items += `<li>${renderBlocks(item.blocks, links, state)}</li>\n`;
      }
      return `<${tag}${start}>\n${items}</${tag}>\n`;
    }
    case 'html':
      return node.text;
    case 'table': {
      let head = '';
      for (const cell of node.header) head += renderTableCell(cell, links, state);
      let body = '';
      for (const row of node.rows) {
        let cells = '';
        for (const cell of row) cells += renderTableCell(cell, links, state);
        body += `<tr>\n${cells}</tr>\n`;
      }
      if (body) body = `<tbody>${body}</tbody>`;
      return `<table>\n<thead>\n<tr>\n${head}</tr>\n</thead>\n${body}</table>\n`;
    }
    case 'paragraph': {
      const cb = node.cb !== undefined ? checkboxHtml(node.cb, node.cbRaw) : '';
      const inner = renderInline(node.text, links, state, false).html;
      return `<p>${cb}${inner}</p>\n`;
    }
    case 'text': {
      const cb = node.cb !== undefined ? checkboxHtml(node.cb, node.cbRaw) : '';
      const inner = renderInline(node.text, links, state, false).html;
      return cb + inner;
    }
    case 'checkbox':
      return checkboxHtml(node.checked, node.raw);
    default:
      return '';
  }
}

function renderBlocks(blocks, links, state) {
  let out = '';
  for (const node of blocks) out += renderBlock(node, links, state);
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(markdown) {
  const src = markdown.replace(RE.carriageReturn, '\n');
  const links = Object.create(null);
  const state = {
    top: true,
    inLink: false,
    inRawBlock: false,
    linkParenPossible: true,
    linkEmitted: false,
  };
  const blocks = lexBlocks(src, state, links, false);
  return renderBlocks(blocks, links, state);
}
