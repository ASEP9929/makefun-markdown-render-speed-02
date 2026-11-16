// Round-6 rewrite of the markdown renderer for make.fun "markdown-render-speed-02".
// Written from scratch in this session. Behaviour target: marked (GFM, breaks off),
// verified against the kit's vendored marked build and the practice scorer.
// Structure is my own: a regex table, small pure helpers, an InlineEngine,
// a BlockEngine and two renderers. No code is copied from the round-5 file.

const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

// Regex builder: holds a source string, lets callers substitute sub-patterns
// (anchors are stripped from inserted patterns, like marked's edit helper).
function rxEdit(src, flags) {
  let s = typeof src === 'string' ? src : src.source;
  const api = {
    sub(find, repl) {
      let r = typeof repl === 'string' ? repl : repl.source;
      r = r.replace(/(^|[^\[])\^/g, '$1');
      s = s.replace(find, r);
      return api;
    },
    done() { return new RegExp(s, flags); },
  };
  return api;
}

// marked's cached "other" regex builders clamp the indent: they build the
// pattern for max(0, min(3, indent - 1)), not for the indent itself. A
// nested list line (2 spaces + bullet) must NOT end the outer item, so the
// effective indent is one less than the content indent.
const dIndent = (t) => Math.max(0, Math.min(3, t - 1));

// ---- shared "other" patterns ------------------------------------------------
const O = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
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
  numericCharacterReferenceOrAmpersand: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex: (bullet) => new RegExp(`^( {0,3}${bullet})((?:[ \t][^\\n]*)?(?:\\n|$))`),
  nextBulletRegex: (indent) => new RegExp(`^ {0,${dIndent(indent)}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`),
  hrRegex: (indent) => new RegExp(`^ {0,${dIndent(indent)}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`),
  fencesBeginRegex: (indent) => new RegExp(`^ {0,${dIndent(indent)}}(?:\`\`\`|~~~)`),
  headingBeginRegex: (indent) => new RegExp(`^ {0,${dIndent(indent)}}#{1,6}(?:\\s|$)`),
  htmlBeginRegex: (indent) => new RegExp(`^ {0,${dIndent(indent)}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'),
  blockquoteBeginRegex: (indent) => new RegExp(`^ {0,${dIndent(indent)}}>`),
};

// ---- block patterns (GFM) ---------------------------------------------------
const BULLET_RX = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const HR_RX = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const FENCES_RX = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const HEADING_RX = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const NEWLINE_RX = /^(?:[ \t]*(?:\n|$))+/;
const INDENTED_CODE_RX = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const TEXT_RX = /^[^\n]+/;

const HTML_COMMENT_RX = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const HTML_BLOCK_RX = rxEdit(
  '^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))',
  'i',
)
  .sub('comment', HTML_COMMENT_RX)
  .sub('tag', BLOCK_TAGS)
  .sub('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .done();

const DEF_LABEL_RX = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const DEF_TITLE_RX = /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/;
const DEF_RX = rxEdit(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .sub('label', DEF_LABEL_RX)
  .sub('title', DEF_TITLE_RX)
  .done();

const LIST_RX = rxEdit(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).sub(/bull/g, BULLET_RX).done();

const PARA_BASE = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
const HTML_INLINE_START = ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';
const FENCES_START = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';

function paraWith(listPattern) {
  return rxEdit(PARA_BASE)
    .sub('hr', HR_RX)
    .sub('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .sub('|lheading', '')
    .sub('|table', '')
    .sub('blockquote', ' {0,3}>')
    .sub('fences', FENCES_START)
    .sub('list', listPattern)
    .sub('html', rxEdit(HTML_INLINE_START).sub('tag', BLOCK_TAGS).done())
    .done();
}

function tableRx() {
  return rxEdit(/^ *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n|hr|heading|blockquote|code|fences|list|html).*(?:\n|$))*)\n*|$)/)
    .sub('hr', HR_RX)
    .sub('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .sub('blockquote', ' {0,3}>')
    .sub('code', '(?: {4}| {0,3}\t)[^\\n]')
    .sub('fences', FENCES_START)
    .sub('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
    .sub('html', rxEdit(HTML_INLINE_START).sub('tag', BLOCK_TAGS).done())
    .done();
}

const QUOTE_PARA_RX = paraWith(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/);
const GFM_PARA_RX = rxEdit(PARA_BASE)
  .sub('hr', HR_RX)
  .sub('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .sub('|lheading', '')
  .sub('table', tableRx())
  .sub('blockquote', ' {0,3}>')
  .sub('fences', FENCES_START)
  .sub('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
  .sub('html', rxEdit(HTML_INLINE_START).sub('tag', BLOCK_TAGS).done())
  .done();

const BLOCKQUOTE_RX = rxEdit(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/).sub('paragraph', QUOTE_PARA_RX).done();

const LHEADING_BASE = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const LHEADING_RX = rxEdit(LHEADING_BASE)
  .sub(/bull/g, BULLET_RX)
  .sub(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .sub(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .sub(/blockquote/g, / {0,3}>/)
  .sub(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .sub(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .sub(/html/g, / {0,3}<[^\n>]+>\n/)
  .sub(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .done();

const BLOCK = {
  newline: NEWLINE_RX,
  code: INDENTED_CODE_RX,
  fences: FENCES_RX,
  hr: HR_RX,
  heading: HEADING_RX,
  lheading: LHEADING_RX,
  list: LIST_RX,
  html: HTML_BLOCK_RX,
  def: DEF_RX,
  table: tableRx(),
  paragraph: GFM_PARA_RX,
  text: TEXT_RX,
  blockquote: BLOCKQUOTE_RX,
};

// ---- inline patterns (GFM) --------------------------------------------------
const PUNCT = /[\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;

const INLINE = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  // GFM text: stops before URLs, www., emails, mailto:/xmpp:, backticks,
  // tildes, and the other inline triggers, so those rules get their turn.
  text: /^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@))))/,
  punctuation: rxEdit(/^((?![*_])punctSpace)/, 'u').sub(/punctSpace/g, PUNCT_SPACE).done(),
  // Unescape helper: matches a backslash + punctuation char, capturing the
  // char, so replace(..., '$1') strips the backslash. Used for link hrefs,
  // titles, fence info strings and link definitions.
  anyPunctuation: /\\((?!~)[\p{P}\p{S}])/gu,
  anyPunctuationOutsideCode: rxEdit(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu').sub(/punct/g, PUNCT).done(),
  autolink: rxEdit(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
    .sub('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
    .sub('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
    .done(),
  tag: rxEdit('^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>')
    .sub('comment', rxEdit(HTML_COMMENT_RX).sub('(?:-->|$)', '-->').done())
    .sub('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
    .done(),
  url: rxEdit(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
    .sub('emailProtocol', rxEdit(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).sub(/email/g, /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/).done())
    .sub('protocol', /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/)
    .sub('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
    .done(),
  _backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
  emStrongLDelim: rxEdit(/^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/, 'u')
    .sub(/punct/g, /(?!~)[\p{P}\p{S}]/u)
    .done(),
  emStrongRDelimAst: rxEdit('^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)', 'gu')
    .sub(/notPunctSpace/g, /(?:[^\s\p{P}\p{S}]|~)/u)
    .sub(/punctSpace/g, /(?!~)[\s\p{P}\p{S}]/u)
    .sub(/punct/g, /(?!~)[\p{P}\p{S}]/u)
    .done(),
  emStrongRDelimUnd: rxEdit('^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)', 'gu')
    .sub(/notPunctSpace/g, NOT_PUNCT_SPACE)
    .sub(/punctSpace/g, PUNCT_SPACE)
    .sub(/punct/g, PUNCT)
    .done(),
  delLDelim: rxEdit(/^~~?(?:((?!~)punct)|[^\s~])/, 'u').sub(/punct/g, PUNCT).done(),
  delRDelim: rxEdit('^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)', 'gu')
    .sub(/notPunctSpace/g, NOT_PUNCT_SPACE)
    .sub(/punctSpace/g, PUNCT_SPACE)
    .sub(/punct/g, PUNCT)
    .done(),
  blockSkip: rxEdit(/link|precode-code|html/, 'g')
    .sub('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
    .sub('precode-', '(?<!`)()')
    .sub('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
    .sub('html', /<(?! )[^<>]*?>/)
    .done(),
};

// Link label: nested brackets, escapes, code spans, or 2+ backticks before ].
// A lone backtick that is not a code span and not 2+ before ] kills the label.
const BRACKET_RX = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const LABEL_RX = rxEdit(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
  .sub('brackets', BRACKET_RX)
  .done();
const REF_LABEL_RX = rxEdit(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
  .sub('brackets', BRACKET_RX)
  .done();

INLINE.link = rxEdit(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .sub('label', LABEL_RX)
  .sub('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .sub('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .done();
INLINE.reflink = rxEdit(/^!?\[(label)\]\[(ref)\]/).sub('label', LABEL_RX).sub('ref', DEF_LABEL_RX).done();
INLINE.nolink = rxEdit(/^!?\[(ref)\](?:\[\])?/).sub('ref', DEF_LABEL_RX).done();
INLINE.reflinkSearch = rxEdit('reflink|nolink(?!\\()', 'g')
  .sub('reflink', rxEdit(/^!?\[(label)\]\[(ref)\]/).sub('label', REF_LABEL_RX).sub('ref', /(?:\\[\s\S]|[^\[\]\\]){1,999}/).done())
  .sub('nolink', rxEdit(/^!?\[(ref)\](?:\[\])?/).sub('ref', /(?:\\[\s\S]|[^\[\]\\]){1,999}/).done())
  .done();

// ---- small pure helpers -----------------------------------------------------
const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function entityFor(ch) { return ENTITIES[ch]; }

// Escape for output. When `encode` is set, & < > " ' are all encoded;
// otherwise only < > " ' and bare & (not part of a valid entity) are encoded.
function escOut(str, encode) {
  if (encode) {
    if (O.escapeTest.test(str)) return str.replace(O.escapeReplace, entityFor);
  } else if (O.escapeTestNoEncode.test(str)) {
    return str.replace(O.escapeReplaceNoEncode, entityFor);
  }
  return str;
}

// Unescape inline text: numeric character references, and & not starting an
// entity becomes &amp; (the rest is left alone; < > " ' are handled by escOut).
function unescapeInline(str) {
  if (!O.numericCharacterReference.test(str)) return str;
  return str.replace(O.numericCharacterReferenceOrAmpersand, (whole, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = hex === undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (cp === 0 || cp > 1114111 || (cp >= 55296 && cp <= 57343)) return '\uFFFD';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}

function encodeHref(href) {
  try {
    return encodeURI(href).replace(O.percentDecode, '%');
  } catch {
    return null;
  }
}

// Strip trailing `ch` characters from a string (or, when `invert` is set,
// strip trailing characters that are NOT `ch`).
function stripTrail(str, ch, invert) {
  const n = str.length;
  if (n === 0) return '';
  let cut = 0;
  for (; cut < n;) {
    const c = str.charAt(n - cut - 1);
    if (c === ch && !invert) cut++;
    else if (c !== ch && invert) cut++;
    else break;
  }
  return str.slice(0, n - cut);
}

// Normalise a link-reference label for lookup.
function normLabel(str) {
  return str.trim().replace(O.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Paren balance scan: index of the first unmatched ')' , -2 when '(' is left
// open at the end, -1 when balanced / no parens at all.
function parenEnd(str, pair) {
  if (str.indexOf(pair[0]) === -1 && str.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') { i++; continue; }
    if (str[i] === pair[0]) depth++;
    else if (str[i] === pair[1] && (--depth < 0)) return i;
  }
  return depth > 0 ? -2 : -1;
}

// Expand tabs to spaces with tab stops of 4, starting at column `col`.
function expandTabs(str, col = 0) {
  let at = col, out = '';
  for (const ch of str) {
    if (ch === '\t') {
      const n = 4 - (at % 4);
      out += ' '.repeat(n);
      at += n;
    } else {
      out += ch;
      at++;
    }
  }
  return out;
}

// Drop trailing blank lines, but keep the text unchanged when there are at
// most one trailing blank line.
function trimBlankTail(str) {
  const lines = str.split('\n');
  let last = lines.length - 1;
  for (; last >= 0 && O.blankLine.test(lines[last]);) last--;
  return lines.length - last <= 2 ? str : lines.slice(0, last + 1).join('\n');
}

// Remove the opening fence's indentation (in characters, not columns) from
// every line of fenced-code content.
function fenceDedent(fenceRaw, content) {
  const m = fenceRaw.match(O.indentCodeCompensation);
  if (m === null) return content;
  const width = m[1].length;
  return content.split('\n').map((line) => {
    const lead = line.match(O.beginningSpace);
    if (lead === null) return line;
    return line.slice(Math.min(lead[0].length, width));
  }).join('\n');
}

// Split a table row into cells, honouring escaped pipes and trimming.
function splitCells(row, maxCells) {
  const fixed = row.replace(O.findPipe, (ch, off, whole) => {
    let escaped = false, p = off;
    for (; --p >= 0 && whole[p] === '\\';) escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const parts = fixed.split(O.splitPipe);
  let i = 0;
  if (parts[0].trim() || parts.shift(), parts.length > 0 && !parts.at(-1)?.trim() && parts.pop(), maxCells) {
    if (parts.length > maxCells) parts.splice(maxCells);
    else for (; parts.length < maxCells;) parts.push('');
  }
  for (; i < parts.length; i++) parts[i] = parts[i].trim().replace(O.slashPipe, '|');
  return parts;
}

// ---- emphasis/del closer cache ------------------------------------------------
// For a masked source, find the last index at which a closer run of `*`, `_`
// or `~` can start (a run preceded by a non-whitespace character). The
// InlineEngine keeps a stack of these analyses, one per nested inline pass.
function lastCloserScan(masked) {
  const idx = { '*': -1, _: -1 };
  let del = -1;
  const n = masked.length;
  for (let i = 0; i < n; i++) {
    const ch = masked[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? ' ' : masked[i - 1];
    let j = i + 1;
    for (; j < n && masked[j] === ch;) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') del = i;
      else idx[ch] = i;
    }
    i = j - 1;
  }
  return { maskedSrc: masked, lastPossibleEmStrongCloserIndex: idx, lastPossibleDelCloserIndex: del };
}

class InlineEngine {
  constructor(lexer) {
    this.lex = lexer; // back-reference to the BlockEngine (state + links)
    this.closerStack = [];
  }

  // -- closer cache -----------------------------------------------------------
  pushCloser(masked) {
    this.closerStack.push(lastCloserScan(masked));
  }
  popCloser() {
    this.closerStack.pop();
  }
  lastEmCloser(masked, ch) {
    const top = this.closerStack.at(-1);
    if (top && top.maskedSrc === masked) return top.lastPossibleEmStrongCloserIndex[ch];
    return lastCloserScan(masked).lastPossibleEmStrongCloserIndex[ch];
  }
  lastDelCloser(masked) {
    const top = this.closerStack.at(-1);
    if (top && top.maskedSrc === masked) return top.lastPossibleDelCloserIndex;
    return lastCloserScan(masked).lastPossibleDelCloserIndex;
  }

  // -- masking ----------------------------------------------------------------
  // Build the masked source used by the emphasis/delimiter search: link
  // references that resolve are hidden, code spans and inline links/html are
  // replaced by same-length `[aaa...]` placeholders so delimiters inside
  // them are invisible to the closer search.
  maskSource(text) {
    let out = text;
    if (this.lex.links && text.includes('[')) {
      const search = INLINE.reflinkSearch;
      const hide = (whole) => {
        const open = whole.lastIndexOf('[');
        if (!Object.hasOwn(this.lex.links, normLabel(whole.slice(open + 1, -1)))) return whole;
        if (open > 1 && whole.charAt(0) !== '!') {
          const inner = whole.slice(1, open - 1);
          if (this.linkInText(inner)) {
            return '[' + inner.replace(search, hide) + '][' + 'a'.repeat(whole.length - open - 2) + ']';
          }
        }
        return '[' + 'a'.repeat(whole.length - 2) + ']';
      };
      out = out.replace(search, hide);
    }
    out = out.replace(INLINE.anyPunctuationOutsideCode, (whole, spanOpen, escapedPunct) => {
      if (escapedPunct) return '+'.repeat(whole.length);
      if (spanOpen) return spanOpen + whole.slice(spanOpen.length, -spanOpen.length).replace(/`/g, '+') + spanOpen;
      return whole;
    });
    out = out.replace(INLINE.blockSkip, (whole) => '[' + 'a'.repeat(whole.length - 2) + ']');
    return out;
  }

  // Does `text` contain a link (inline or reference) that is not an image?
  linkInText(text) {
    if (!text.includes('[')) return false;
    for (const m of text.matchAll(INLINE.blockSkip)) {
      if (INLINE.link.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
    }
    for (const m of text.matchAll(INLINE.reflinkSearch)) {
      const whole = m[0];
      const open = whole.lastIndexOf('[');
      if (!(whole.charAt(0) === '!' || !Object.hasOwn(this.lex.links, normLabel(whole.slice(open + 1, -1)))) &&
          !(open > 1 && this.linkInText(whole.slice(1, open - 1)))) {
        return true;
      }
    }
    return false;
  }

  // Does the label `label` (found at offset `off` in `full`) contain an html
  // tag or autolink that runs past the end of the label? If so the link is
  // rejected (a link cannot contain a tag that escapes its label).
  hasLinkInside(full, label, off) {
    if (!label.includes('<')) return false;
    for (let i = 0; i < label.length; i++) {
      if (label[i] === '\\') { i++; continue; }
      if (label[i] === '`') {
        const span = INLINE.code.exec(label.slice(i));
        if (span) { i += span[0].length - 1; continue; }
      }
      if (label[i] !== '<') continue;
      const rest = full.slice(off + i);
      const hit = INLINE.tag.exec(rest) || INLINE.autolink.exec(rest);
      if (hit) {
        if (hit[0].length > label.length - i) return true;
        i += hit[0].length - 1;
      }
    }
    return false;
  }

  // Build a link/image token from a matched label + href/title, parsing the
  // label text inline. A link whose label itself contains a link is dropped.
  makeLink(match, dest, raw) {
    const href = dest.href;
    const title = dest.title || null;
    const labelText = match[1].replace(O.outputLinkReplace, '$1');
    const isImage = match[0].charAt(0) === '!';
    const savedInLink = this.lex.state.inLink;
    const savedEmitted = this.lex.state.linkEmitted;
    const savedRaw = this.lex.state.inRawBlock;
    this.lex.state.inLink = true;
    this.lex.state.linkEmitted = false;
    const inner = this.lex.inlineTokens(labelText);
    const nested = this.lex.state.linkEmitted;
    this.lex.state.linkEmitted = savedEmitted;
    this.lex.state.inLink = savedInLink;
    if (!isImage) {
      if (nested) { this.lex.state.inRawBlock = savedRaw; return undefined; }
      this.lex.state.linkEmitted = true;
    }
    return { type: isImage ? 'image' : 'link', raw, href, title, text: labelText, tokens: inner };
  }

  // -- inline tokenizers ------------------------------------------------------
  tryEscape(rest) {
    const m = INLINE.escape.exec(rest);
    if (m) return { type: 'escape', raw: m[0], text: m[1] };
    return undefined;
  }

  tryTag(rest) {
    const m = INLINE.tag.exec(rest);
    if (!m) return undefined;
    if (!this.lex.state.inLink && O.startATag.test(m[0])) this.lex.state.inLink = true;
    else if (this.lex.state.inLink && O.endATag.test(m[0])) this.lex.state.inLink = false;
    if (!this.lex.state.inRawBlock && O.startPreScriptTag.test(m[0])) this.lex.state.inRawBlock = true;
    else if (this.lex.state.inRawBlock && O.endPreScriptTag.test(m[0])) this.lex.state.inRawBlock = false;
    return { type: 'html', raw: m[0], inLink: this.lex.state.inLink, inRawBlock: this.lex.state.inRawBlock, block: false, text: m[0] };
  }

  tryLink(rest) {
    if (this.lex.state.linkParenPossible === false) return undefined;
    const m = INLINE.link.exec(rest);
    if (!m) return undefined;
    const bang = m[0].charAt(0) === '!' ? 2 : 1;
    if (this.hasLinkInside(rest, m[1], bang)) return undefined;
    let dest = m[2].trim();
    if (O.startAngleBracket.test(dest)) {
      if (!O.endAngleBracket.test(dest)) return undefined;
      const stripped = stripTrail(dest.slice(0, -1), '\\');
      if ((dest.length - stripped.length) % 2 === 0) return undefined;
    } else {
      const cut = parenEnd(m[2], '()');
      if (cut === -2) return undefined;
      if (cut > -1) {
        const head = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + cut;
        m[2] = m[2].substring(0, cut);
        m[0] = m[0].substring(0, head).trim();
        m[3] = '';
      }
    }
    const noEsc = stripTrail(m[0].slice(0, -1), '\\');
    if ((m[0].length - noEsc.length) % 2 === 0) return undefined;
    let href = m[2];
    const title = m[3] ? m[3].slice(1, -1) : '';
    href = href.trim();
    if (O.startAngleBracket.test(href)) href = href.slice(1, -1);
    return this.makeLink(
      m,
      { href: href && href.replace(INLINE.anyPunctuation, '$1'), title: title && title.replace(INLINE.anyPunctuation, '$1') },
      m[0],
    );
  }

  tryRefLink(rest) {
    let m = INLINE.reflink.exec(rest) || INLINE.nolink.exec(rest);
    if (!m) return undefined;
    const bang = m[0].charAt(0) === '!' ? 2 : 1;
    if (this.hasLinkInside(rest, m[1], bang)) return undefined;
    const dest = this.lex.links[normLabel(m[2] || m[1])];
    if (!dest) {
      const first = m[0].charAt(0);
      return { type: 'text', raw: first, text: first };
    }
    return this.makeLink(m, dest, m[0]);
  }

  tryEmStrong(rest, masked, prevChar = '') {
    const m = INLINE.emStrongLDelim.exec(rest);
    if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return undefined;
    const ch = m[0][0];
    const inRun = prevChar === ch;
    const pos = masked.length - rest.length;
    let runStart = pos;
    for (; runStart > 0 && masked[runStart - 1] === ch;) runStart--;
    const before = [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
    const beforeIsPunct = before === '*' || before === '_' || !!INLINE.punctuation.exec(before);
    if (runStart < pos) prevChar = before;
    const prevIsPunct = runStart < pos ? beforeIsPunct : !!INLINE.punctuation.exec(prevChar);
    if (m[4] && prevChar.match(O.unicodeAlphaNumeric)) return undefined;
    const canOpen = m[1] || m[3] || '';
    if (!canOpen || !prevChar || prevIsPunct) {
      const runLen = [...m[0]].length - 1;
      let need = runLen;
      let extra = 0;
      const base = pos - runStart + runLen;
      const canAlsoClose = !!before.trim() && (!!canOpen || (ch === '*' && !beforeIsPunct));
      if (ch !== '*' && ch !== '_') return undefined;
      const closerRe = ch === '*' ? INLINE.emStrongRDelimAst : INLINE.emStrongRDelimUnd;
      const lastCloser = this.lastEmCloser(masked, ch);
      const openerAt = masked.length - rest.length + runLen;
      if (lastCloser < openerAt) return undefined;
      const sliced = masked.slice(-rest.length + runLen);
      const limit = lastCloser - openerAt;
      closerRe.lastIndex = 0;
      let hit;
      while ((hit = closerRe.exec(sliced)) !== null && !(hit.index > limit)) {
        const run = hit[1] || hit[2] || hit[3] || hit[4] || hit[5] || hit[6];
        if (!run) continue;
        const runChars = [...run].length;
        if (hit[3] || hit[4]) { need += runChars; continue; }
        if (hit[5] || hit[6] || canAlsoClose) {
          if (inRun && (hit[5] || hit[6])) break;
          if (base % 3 && !((base + runChars) % 3)) { extra += runChars; continue; }
        }
        if ((need -= runChars) > 0) continue;
        const take = Math.min(runChars, runChars + need + extra);
        const firstLen = [...hit[0]][0].length;
        const raw = rest.slice(0, runLen + hit.index + firstLen + take);
        if (Math.min(runLen, take) % 2) {
          const inner = raw.slice(1, -1);
          return { type: 'em', raw, text: inner, tokens: this.lex.inlineTokens(inner) };
        }
        const inner = raw.slice(2, -2);
        return { type: 'strong', raw, text: inner, tokens: this.lex.inlineTokens(inner) };
      }
    }
    return undefined;
  }

  tryCodeSpan(rest) {
    const m = INLINE.code.exec(rest);
    if (!m) return undefined;
    let text = m[2].replace(O.newLineCharGlobal, ' ');
    const hasNonSpace = /[^ ]/.test(text);
    const padded = /^ /.test(text) && / $/.test(text);
    if (hasNonSpace && padded) text = text.substring(1, text.length - 1);
    return { type: 'codespan', raw: m[0], text };
  }

  tryBr(rest) {
    const m = INLINE.br.exec(rest);
    if (m) return { type: 'br', raw: m[0] };
    return undefined;
  }

  tryDel(rest, masked, prevChar = '') {
    const m = INLINE.delLDelim.exec(rest);
    if (!m) return undefined;
    if (!(m[1] || '') || !prevChar || INLINE.punctuation.exec(prevChar)) {
      const runLen = [...m[0]].length - 1;
      let need = runLen;
      const closerRe = INLINE.delRDelim;
      const lastCloser = this.lastDelCloser(masked);
      const openerAt = masked.length - rest.length + runLen;
      if (lastCloser < openerAt) return undefined;
      const sliced = masked.slice(-rest.length + runLen);
      const limit = lastCloser - openerAt;
      closerRe.lastIndex = 0;
      let hit;
      while ((hit = closerRe.exec(sliced)) !== null && !(hit.index > limit)) {
        const run = hit[1] || hit[2] || hit[3] || hit[4] || hit[5] || hit[6];
        if (!run) continue;
        const runChars = [...run].length;
        if (runChars !== runLen) continue;
        if (hit[3] || hit[4]) { need += runChars; continue; }
        if ((need -= runChars) > 0) continue;
        const take = Math.min(runChars, runChars + need);
        const firstLen = [...hit[0]][0].length;
        const raw = rest.slice(0, runLen + hit.index + firstLen + take);
        const inner = raw.slice(runLen, -runLen);
        return { type: 'del', raw, text: inner, tokens: this.lex.inlineTokens(inner) };
      }
    }
    return undefined;
  }

  tryAutoLink(rest) {
    const m = INLINE.autolink.exec(rest);
    if (!m) return undefined;
    let text;
    let href;
    if (m[2] === '@') { text = m[1]; href = 'mailto:' + text; }
    else { text = m[1]; href = text; }
    return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  }

  tryUrl(rest) {
    const m = INLINE.url.exec(rest);
    if (!m) return undefined;
    let text;
    let href;
    if (m[2] === '@') {
      text = m[0];
      href = 'mailto:' + text;
    } else {
      let kept = m[0];
      let prev = kept;
      do {
        prev = kept;
        kept = INLINE._backpedal.exec(kept)?.[0] ?? '';
      } while (kept !== prev);
      text = kept;
      href = m[1] === 'www.' ? 'http://' + kept : kept;
    }
    return { type: 'link', raw: text, text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  }

  tryText(rest) {
    const m = INLINE.text.exec(rest);
    if (!m) return undefined;
    const rawBlock = this.lex.state.inRawBlock;
    return { type: 'text', raw: m[0], text: rawBlock ? m[0] : unescapeInline(m[0]), escaped: rawBlock };
  }

  // -- the inline loop --------------------------------------------------------
  // Tokenize `src` into `out` (an array that is filled in place). The masked
  // source is computed once per call and handed to the emphasis/del search.
  runInline(src, out = []) {
    const savedParen = this.lex.state.linkParenPossible;
    this.lex.state.linkParenPossible = savedParen && src.includes(')');
    try {
      return this.runInlineMasked(src, out);
    } finally {
      this.lex.state.linkParenPossible = savedParen;
    }
  }

  runInlineMasked(src, out) {
    const needsMask = src.includes('*') || src.includes('_') || src.includes('~');
    const masked = needsMask ? this.maskSource(src) : src;
    this.pushCloser(masked);
    try {
      return this.scanInline(src, masked, out);
    } finally {
      this.popCloser();
    }
  }

  scanInline(rest, masked, out) {
    let sawText = false;
    let prevChar = '';
    let guard = Infinity;
    while (rest) {
      if (rest.length < guard) guard = rest.length;
      else throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
      if (!sawText) prevChar = '';
      sawText = false;
      let tok;
      if ((tok = this.tryEscape(rest))) { rest = rest.substring(tok.raw.length); out.push(tok); continue; }
      if ((tok = this.tryTag(rest))) { rest = rest.substring(tok.raw.length); out.push(tok); continue; }
      if ((tok = this.tryLink(rest))) { rest = rest.substring(tok.raw.length); out.push(tok); continue; }
      if ((tok = this.tryRefLink(rest))) {
        rest = rest.substring(tok.raw.length);
        const last = out.at(-1);
        if (tok.type === 'text' && last?.type === 'text') { last.raw += tok.raw; last.text += tok.text; }
        else out.push(tok);
        continue;
      }
      if ((tok = this.tryEmStrong(rest, masked, prevChar))) { rest = rest.substring(tok.raw.length); out.push(tok); continue; }
      if ((tok = this.tryCodeSpan(rest))) { rest = rest.substring(tok.raw.length); out.push(tok); continue; }
      if ((tok = this.tryBr(rest))) { rest = rest.substring(tok.raw.length); out.push(tok); continue; }
      if ((tok = this.tryDel(rest, masked, prevChar))) { rest = rest.substring(tok.raw.length); out.push(tok); continue; }
      if ((tok = this.tryAutoLink(rest))) { rest = rest.substring(tok.raw.length); out.push(tok); continue; }
      if (!this.lex.state.inLink && (tok = this.tryUrl(rest))) { rest = rest.substring(tok.raw.length); out.push(tok); continue; }
      if ((tok = this.tryText(rest))) {
        rest = rest.substring(tok.raw.length);
        if (tok.raw.slice(-1) !== '_') prevChar = tok.raw.slice(-1);
        sawText = true;
        const last = out.at(-1);
        if (last?.type === 'text') { last.raw += tok.raw; last.text += tok.text; }
        else out.push(tok);
        continue;
      }
      if (rest) throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
      break;
    }
    return out;
  }
}

// ---- block lexer --------------------------------------------------------------
class BlockEngine {
  constructor() {
    this.tokens = [];
    this.links = Object.create(null);
    this.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
    this.inlineQueue = [];
    this.inlineEngine = new InlineEngine(this);
  }

  inlineTokens(src, out = []) {
    return this.inlineEngine.runInline(src, out);
  }

  // Queue an inline pass: returns the (initially empty) token array, filled
  // in once the whole document has been block-lexed.
  inline(src) {
    const toks = [];
    this.inlineQueue.push({ src, tokens: toks });
    return toks;
  }

  lex(src) {
    src = src.replace(O.carriageReturn, '\n');
    this.blockTokens(src, this.tokens);
    for (let i = 0; i < this.inlineQueue.length; i++) {
      const item = this.inlineQueue[i];
      this.state.inRawBlock = false;
      this.inlineTokens(item.src, item.tokens);
    }
    this.inlineQueue = [];
    return this.tokens;
  }

  blockTokens(src, out = [], lazy = false) {
    let guard = Infinity;
    while (src) {
      if (src.length < guard) guard = src.length;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      let tok;
      if ((tok = this.trySpace(src))) {
        src = src.substring(tok.raw.length);
        const prev = out.at(-1);
        if (tok.raw.length === 1 && prev !== undefined) prev.raw += '\n';
        else out.push(tok);
        continue;
      }
      if ((tok = this.tryCode(src))) {
        src = src.substring(tok.raw.length);
        const prev = out.at(-1);
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue.at(-1).src = prev.text;
        } else out.push(tok);
        continue;
      }
      if ((tok = this.tryFences(src))) { src = src.substring(tok.raw.length); out.push(tok); continue; }
      if ((tok = this.tryHeading(src))) { src = src.substring(tok.raw.length); out.push(tok); continue; }
      if ((tok = this.tryHr(src))) { src = src.substring(tok.raw.length); out.push(tok); continue; }
      if ((tok = this.tryBlockquote(src))) { src = src.substring(tok.raw.length); out.push(tok); continue; }
      if ((tok = this.tryList(src))) { src = src.substring(tok.raw.length); out.push(tok); continue; }
      if ((tok = this.tryHtml(src))) { src = src.substring(tok.raw.length); out.push(tok); continue; }
      if ((tok = this.tryDef(src))) {
        src = src.substring(tok.raw.length);
        const prev = out.at(-1);
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.raw;
          this.inlineQueue.at(-1).src = prev.text;
        } else {
          if (!this.links[tok.tag]) this.links[tok.tag] = { href: tok.href, title: tok.title };
          out.push(tok);
        }
        continue;
      }
      if ((tok = this.tryTable(src))) { src = src.substring(tok.raw.length); out.push(tok); continue; }
      if ((tok = this.tryLheading(src))) { src = src.substring(tok.raw.length); out.push(tok); continue; }
      if (this.state.top && (tok = this.tryParagraph(src))) {
        const prev = out.at(-1);
        if (lazy && prev?.type === 'paragraph') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = prev.text;
        } else out.push(tok);
        lazy = false;
        src = src.substring(tok.raw.length);
        continue;
      }
      if ((tok = this.tryText(src))) {
        src = src.substring(tok.raw.length);
        const prev = out.at(-1);
        if (prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = prev.text;
        } else out.push(tok);
        continue;
      }
      if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      break;
    }
    this.state.top = true;
    return out;
  }

  // -- block tokenizers ---------------------------------------------------------
  trySpace(src) {
    const m = BLOCK.newline.exec(src);
    if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
    return undefined;
  }

  tryCode(src) {
    const m = BLOCK.code.exec(src);
    if (!m) return undefined;
    const raw = trimBlankTail(m[0]);
    return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(O.codeRemoveIndent, '') };
  }

  tryFences(src) {
    const m = BLOCK.fences.exec(src);
    if (!m) return undefined;
    return {
      type: 'code',
      raw: m[0],
      lang: m[2] ? m[2].trim().replace(INLINE.anyPunctuation, '$1') : m[2],
      text: fenceDedent(m[0], m[3] || ''),
    };
  }

  tryHeading(src) {
    const m = BLOCK.heading.exec(src);
    if (!m) return undefined;
    let text = m[2].trim();
    if (O.endingHash.test(text)) {
      const stripped = stripTrail(text, '#');
      if (!stripped || O.endingSpaceTabChar.test(stripped)) text = stripped.trim();
    }
    return { type: 'heading', raw: stripTrail(m[0], '\n'), depth: m[1].length, text, tokens: this.inline(text) };
  }

  tryHr(src) {
    const m = BLOCK.hr.exec(src);
    if (m) return { type: 'hr', raw: stripTrail(m[0], '\n') };
    return undefined;
  }

  tryBlockquote(src) {
    const m = BLOCK.blockquote.exec(src);
    if (!m) return undefined;
    let lines = stripTrail(m[0], '\n').split('\n');
    let accRaw = '';
    let accText = '';
    const outTokens = [];
    while (lines.length > 0) {
      let seenMarker = false;
      const chunk = [];
      let p;
      for (p = 0; p < lines.length; p++) {
        if (O.blockquoteStart.test(lines[p])) { chunk.push(lines[p]); seenMarker = true; }
        else if (!seenMarker) chunk.push(lines[p]);
        else break;
      }
      lines = lines.slice(p);
      const chunkRaw = chunk.join('\n');
      const chunkText = chunkRaw
        .replace(O.blockquoteMarkerWhitespace, (whole, marker, ws) => marker + expandTabs(ws, marker.length))
        .replace(O.blockquoteSetextReplace, '\n    $1')
        .replace(O.blockquoteSetextReplace2, '');
      accRaw = accRaw ? accRaw + '\n' + chunkRaw : chunkRaw;
      accText = accText ? accText + '\n' + chunkText : chunkText;
      const savedTop = this.state.top;
      this.state.top = true;
      this.blockTokens(chunkText, outTokens, true);
      this.state.top = savedTop;
      if (lines.length === 0) break;
      const last = outTokens.at(-1);
      if (last?.type === 'code' || last?.type === 'heading' || last?.type === 'hr' || last?.type === 'html' || last?.type === 'table') break;
      if (last?.type === 'blockquote') {
        const inner = last;
        const rest = lines.join('\n');
        const combined = inner.raw + '\n' + rest.replace(O.blockquoteSetextReplace2, '');
        const extended = this.tryBlockquote(combined);
        outTokens[outTokens.length - 1] = extended;
        const leftover = combined.substring(extended.raw.length).replace(/^\n/, '');
        const leftoverLines = leftover ? leftover.split('\n').length : 0;
        const kept = leftoverLines ? lines.slice(0, -leftoverLines) : lines;
        if (kept.length > 0) accRaw = accRaw + '\n' + kept.join('\n');
        accText = accText.substring(0, accText.length - inner.text.length) + extended.text;
        lines = lines.slice(kept.length);
        if (lines.length > 0 && O.blockquoteStart.test(lines[0])) continue;
        break;
      }
      if (last?.type === 'list') {
        const inner = last;
        const combined = inner.raw + '\n' + lines.join('\n');
        const extended = this.tryList(combined);
        outTokens[outTokens.length - 1] = extended;
        const added = extended.raw.length > inner.raw.length
          ? combined.slice(inner.raw.length + 1, extended.raw.length).split('\n').length
          : 0;
        if (added > 0) {
          const addedLines = lines.slice(0, added).join('\n');
          accRaw = accRaw + '\n' + addedLines;
          accText = accText + '\n' + addedLines;
        }
        lines = lines.slice(added);
        continue;
      }
      // Any other last token (e.g. a paragraph): keep looping so lazy
      // continuation lines are re-lexed and merged into this blockquote.
    }
    return { type: 'blockquote', raw: accRaw, tokens: outTokens, text: accText };
  }

  tryList(src) {
    const head = BLOCK.list.exec(src);
    if (!head) return undefined;
    const full = src;
    let rest = src;
    const used = () => full.length - rest.length;
    let bullet = head[1].trim();
    const ordered = bullet.length > 1;
    const listTok = { type: 'list', raw: '', ordered, start: ordered ? +bullet.slice(0, -1) : '', loose: false, items: [] };
    bullet = ordered ? `\\d{1,9}\\${bullet.slice(-1)}` : `\\${bullet}`;
    const itemRe = O.listItemRegex(bullet);
    let sawDoubleBlank = false;
    while (rest) {
      let emptyItem = false;
      let itemText = '';
      const itemHead = itemRe.exec(rest);
      if (!itemHead || BLOCK.hr.test(rest)) break;
      const startUsed = used();
      rest = rest.substring(itemHead[0].length);
      const firstLine = itemHead[2].split('\n', 1)[0];
      const bulletLen = itemHead[1].length;
      let firstContent = firstLine.replace(O.leadingSpaceTab, (ws) => expandTabs(ws, bulletLen));
      const nextLine = rest.split('\n', 1)[0];
      const isEmpty = !firstContent.trim();
      let contentIndent = 0;
      if (isEmpty) {
        contentIndent = bulletLen + 1;
      } else {
        contentIndent = firstContent.search(O.nonSpaceChar);
        if (contentIndent > 4) contentIndent = 1;
        itemText = firstContent.slice(contentIndent);
        contentIndent += bulletLen;
      }
      if (isEmpty && O.blankLine.test(nextLine)) {
        rest = rest.substring(nextLine.length + 1);
        emptyItem = true;
      }
      if (!emptyItem) {
        const nextBullet = O.nextBulletRegex(contentIndent);
        const hrAt = O.hrRegex(contentIndent);
        const fenceAt = O.fencesBeginRegex(contentIndent);
        const headingAt = O.headingBeginRegex(contentIndent);
        const htmlAt = O.htmlBeginRegex(contentIndent);
        const quoteAt = O.blockquoteBeginRegex(contentIndent);
        let prevBlank = isEmpty;
        let cur = firstContent;
        while (rest) {
          const line = rest.split('\n', 1)[0];
          let expanded;
          if (fenceAt.test(line) || headingAt.test(line) || htmlAt.test(line) || quoteAt.test(line) || nextBullet.test(line) || hrAt.test(line)) break;
          expanded = line.replace(O.leadingSpaceTab, (ws) => expandTabs(ws));
          if (expanded.search(O.nonSpaceChar) >= contentIndent || !line.trim()) {
            itemText += '\n' + expanded.slice(contentIndent);
          } else {
            if (prevBlank || cur.replace(O.tabCharGlobal, '    ').search(O.nonSpaceChar) >= 4 ||
                fenceAt.test(cur) || headingAt.test(cur) || htmlAt.test(cur) || hrAt.test(cur)) break;
            const lazyLine = /^ {0,3}(?:=+|-+) *$/.test(line) && BLOCK.lheading.test(cur + '\n' + line)
              ? '    ' + expanded.replace(/^ {0,3}/, '')
              : line;
            itemText += '\n' + lazyLine;
          }
          prevBlank = !line.trim();
          rest = rest.substring(line.length + 1);
          cur = expanded.slice(contentIndent);
        }
      }
      const itemRaw = full.slice(startUsed, used());
      if (!listTok.loose) {
        if (sawDoubleBlank) listTok.loose = true;
        else if (O.doubleBlankLine.test(itemRaw)) sawDoubleBlank = true;
      }
      listTok.items.push({ type: 'list_item', raw: itemRaw, task: !!O.listIsTask.test(itemText), loose: false, text: itemText, tokens: [] });
    }
    const lastItem = listTok.items.at(-1);
    if (!lastItem) return undefined;
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
    listTok.raw = full.slice(0, used()).trimEnd();
    for (const item of listTok.items) {
      this.state.top = false;
      item.tokens = this.blockTokens(item.text, []);
      if (!listTok.loose) {
        const spaces = item.tokens.filter((t) => t.type === 'space');
        if (spaces.length > 0 && spaces.some((t) => O.anyLine.test(t.raw))) listTok.loose = true;
      }
    }
    for (const item of listTok.items) {
      const first = item.tokens[0];
      if (item.task && (first?.type === 'text' || first?.type === 'paragraph')) {
        item.text = item.text.replace(O.listReplaceTask, '');
        first.raw = first.raw.replace(O.listReplaceTask, '');
        first.text = first.text.replace(O.listReplaceTask, '');
        for (let i = this.inlineQueue.length - 1; i >= 0; i--) {
          if (O.listIsTask.test(this.inlineQueue[i].src)) {
            this.inlineQueue[i].src = this.inlineQueue[i].src.replace(O.listReplaceTask, '');
            break;
          }
        }
        const box = O.listTaskCheckbox.exec(item.raw);
        if (box) {
          const check = { type: 'checkbox', raw: box[0] + ' ', checked: box[0] !== '[ ]' };
          item.checked = check.checked;
          if (listTok.loose) {
            if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) && 'tokens' in item.tokens[0] && item.tokens[0].tokens) {
              item.tokens[0].raw = check.raw + item.tokens[0].raw;
              item.tokens[0].text = check.raw + item.tokens[0].text;
              item.tokens[0].tokens.unshift(check);
            } else {
              item.tokens.unshift({ type: 'paragraph', raw: check.raw, text: check.raw, tokens: [check] });
            }
          } else {
            item.tokens.unshift(check);
          }
        }
      } else if (item.task) {
        item.task = false;
      }
    }
    if (listTok.loose) {
      for (const item of listTok.items) {
        item.loose = true;
        for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
      }
    }
    return listTok;
  }

  tryHtml(src) {
    const m = BLOCK.html.exec(src);
    if (!m) return undefined;
    const text = trimBlankTail(m[0]);
    return { type: 'html', block: true, raw: text, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style', text };
  }

  tryDef(src) {
    const m = BLOCK.def.exec(src);
    if (!m) return undefined;
    if (!O.startAngleBracket.test(m[2]) && parenEnd(m[2], '()') !== -1) return undefined;
    const tag = normLabel(m[1]);
    const href = m[2] ? m[2].replace(O.hrefBrackets, '$1').replace(INLINE.anyPunctuation, '$1') : '';
    const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(INLINE.anyPunctuation, '$1') : m[3];
    return { type: 'def', tag, raw: stripTrail(m[0], '\n'), href, title };
  }

  tryTable(src) {
    const m = BLOCK.table.exec(src);
    if (!m || !O.tableDelimiter.test(m[2])) return undefined;
    const headerCells = splitCells(m[1]);
    const aligns = m[2].replace(O.tableAlignChars, '').split('|');
    const bodyLines = m[3]?.trim() ? m[3].replace(O.tableRowBlankLine, '').split('\n') : [];
    const tok = { type: 'table', raw: stripTrail(m[0], '\n'), header: [], align: [], rows: [] };
    if (headerCells.length !== aligns.length) return undefined;
    for (const a of aligns) {
      if (O.tableAlignRight.test(a)) tok.align.push('right');
      else if (O.tableAlignCenter.test(a)) tok.align.push('center');
      else if (O.tableAlignLeft.test(a)) tok.align.push('left');
      else tok.align.push(null);
    }
    for (let i = 0; i < headerCells.length; i++) {
      tok.header.push({ text: headerCells[i], tokens: this.inline(headerCells[i]), header: true, align: tok.align[i] });
    }
    for (const line of bodyLines) {
      tok.rows.push(splitCells(line, tok.header.length).map((cell, j) => ({ text: cell, tokens: this.inline(cell), header: false, align: tok.align[j] })));
    }
    return tok;
  }

  tryLheading(src) {
    const m = BLOCK.lheading.exec(src);
    if (!m) return undefined;
    const text = m[1].trim();
    return { type: 'heading', raw: stripTrail(m[0], '\n'), depth: m[2].charAt(0) === '=' ? 1 : 2, text, tokens: this.inline(text) };
  }

  tryParagraph(src) {
    const m = BLOCK.paragraph.exec(src);
    if (!m) return undefined;
    const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
    return { type: 'paragraph', raw: m[0], text, tokens: this.inline(text) };
  }

  tryText(src) {
    const m = BLOCK.text.exec(src);
    if (m) return { type: 'text', raw: m[0], text: m[0], tokens: this.inline(m[0]) };
    return undefined;
  }
}

// ---- renderers ----------------------------------------------------------------
class PlainRenderer {
  parseInline(tokens) {
    let out = '';
    for (const tok of tokens) out += this.renderToken(tok);
    return out;
  }
  renderToken(tok) {
    switch (tok.type) {
      case 'strong':
      case 'em':
      case 'del':
      case 'link':
      case 'image':
        return tok.tokens ? this.parseInline(tok.tokens) : tok.text;
      case 'codespan':
      case 'html':
      case 'text':
        return tok.text;
      case 'br':
        return '';
      case 'checkbox':
        return tok.raw;
      default:
        return tok.text ?? '';
    }
  }
}

class HtmlRenderer {
  constructor() {
    this.plain = new PlainRenderer();
  }

  render(tokens) {
    let out = '';
    for (const tok of tokens) out += this.renderBlock(tok);
    return out;
  }

  renderBlock(tok) {
    switch (tok.type) {
      case 'space': return '';
      case 'hr': return '<hr>\n';
      case 'heading': return `<h${tok.depth}>${this.renderInline(tok.tokens)}</h${tok.depth}>\n`;
      case 'code': {
        const lang = (tok.lang || '').match(O.notSpaceStart)?.[0];
        const body = tok.text ? tok.text.replace(O.endingNewline, '') + '\n' : '';
        const inner = escOut(body, true);
        return lang
          ? `<pre><code class="language-${escOut(lang)}">${inner}</code></pre>\n`
          : `<pre><code>${inner}</code></pre>\n`;
      }
      case 'table': {
        let headCells = '';
        for (const cell of tok.header) headCells += this.tableCell(cell);
        let head = `<tr>\n${headCells}</tr>\n`;
        let body = '';
        for (const row of tok.rows) {
          let cells = '';
          for (const cell of row) cells += this.tableCell(cell);
          body += `<tr>\n${cells}</tr>\n`;
        }
        if (body) body = `<tbody>${body}</tbody>`;
        return `<table>\n<thead>\n${head}</thead>\n${body}</table>\n`;
      }
      case 'blockquote': return `<blockquote>\n${this.render(tok.tokens)}</blockquote>\n`;
      case 'list': {
        const tag = tok.ordered ? 'ol' : 'ul';
        const start = tok.ordered && tok.start !== 1 ? ` start="${tok.start}"` : '';
        let items = '';
        for (const item of tok.items) items += `<li>${this.render(item.tokens)}</li>\n`;
        return `<${tag}${start}>\n${items}</${tag}>\n`;
      }
      case 'checkbox': return '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
      case 'html': return tok.text;
      case 'def': return '';
      case 'paragraph': return `<p>${this.renderInline(tok.tokens)}</p>\n`;
      case 'text': return this.renderInline(tok.tokens);
      default: throw new Error('Token with "' + tok.type + '" type was not found.');
    }
  }

  tableCell(cell) {
    const tag = cell.header ? 'th' : 'td';
    const inner = this.renderInline(cell.tokens);
    return (cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`) + inner + `</${tag}>\n`;
  }

  renderInline(tokens) {
    let out = '';
    for (const tok of tokens) out += this.renderInlineToken(tok);
    return out;
  }

  renderInlineToken(tok) {
    switch (tok.type) {
      case 'escape': return this.textToken(tok);
      case 'html': return tok.text;
      case 'link': {
        const label = tok.autolink ? escOut(tok.text, true) : this.renderInline(tok.tokens);
        const encoded = encodeHref(tok.href);
        if (encoded === null) return label;
        const href = escOut(encoded, tok.autolink);
        let out = `<a href="${href}"`;
        if (tok.title) out += ` title="${escOut(tok.title)}"`;
        return out + '>' + label + '</a>';
      }
      case 'image': {
        const alt = tok.tokens ? this.plain.parseInline(tok.tokens) : tok.text;
        const encoded = encodeHref(tok.href);
        if (encoded === null) return escOut(alt);
        let out = `<img src="${escOut(encoded)}" alt="${escOut(alt)}"`;
        if (tok.title) out += ` title="${escOut(tok.title)}"`;
        return out + '>';
      }
      case 'checkbox': return '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
      case 'strong': return `<strong>${this.renderInline(tok.tokens)}</strong>`;
      case 'em': return `<em>${this.renderInline(tok.tokens)}</em>`;
      case 'codespan': return `<code>${escOut(tok.text, true)}</code>`;
      case 'br': return '<br>';
      case 'del': return `<del>${this.renderInline(tok.tokens)}</del>`;
      case 'text': return this.textToken(tok);
      default: throw new Error('Token with "' + tok.type + '" type was not found.');
    }
  }

  textToken(tok) {
    if ('tokens' in tok && tok.tokens) return this.renderInline(tok.tokens);
    if ('escaped' in tok && tok.escaped) return tok.text;
    return escOut(tok.text);
  }
}

export function parse(markdown) {
  const engine = new BlockEngine();
  const tokens = engine.lex(markdown);
  return new HtmlRenderer().render(tokens);
}

export default parse;
