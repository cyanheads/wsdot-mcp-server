/**
 * @fileoverview Converts the HTML fragments WSDOT and WSF embed inside text fields — highway
 * alert descriptions and ferry bulletin bodies — into plain text, keeping link destinations.
 * @module services/html-text
 */

/** Tags whose boundaries are a line break in the plain-text rendering. */
const BLOCK_TAGS = new Set([
  'address',
  'article',
  'blockquote',
  'br',
  'div',
  'dd',
  'dl',
  'dt',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tr',
  'ul',
]);

/** Tags whose *content* is markup machinery rather than prose, and is dropped with the tag. */
const DROPPED_CONTENT_TAGS = new Set(['script', 'style', 'template']);

/**
 * The named entities the feeds actually use (`&quot;`), plus the handful a copy-paste from a word
 * processor tends to carry. Anything else is left verbatim rather than guessed at.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  bull: '•',
  deg: '°',
  gt: '>',
  hellip: '…',
  ldquo: '“',
  lsquo: '‘',
  lt: '<',
  mdash: '—',
  middot: '·',
  nbsp: ' ',
  ndash: '–',
  quot: '"',
  rdquo: '”',
  rsquo: '’',
};

/**
 * A single entity reference. Every quantifier is bounded and none is nested, so the match cost is
 * a constant per starting position — see the linearity note on {@link htmlToText}.
 */
const ENTITY = /&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g;

/** Horizontal whitespace — everything `\s` covers except the line breaks the block tags emit. */
const HORIZONTAL_WHITESPACE = /[^\S\n]+/g;

/** A tag name: the letters after `<` or `</`, with any XML namespace prefix (`o:p`) dropped. */
const TAG_NAME = /^<\/?([a-zA-Z][^\s/>]*)/;

/**
 * One attribute of a tag: a name with an optional quoted or bare value — the feeds carry both
 * forms. A quoted value is consumed by the same match as its name, so a ` href=` sequence sitting
 * inside some other attribute's value cannot pose as the destination.
 */
const ATTRIBUTE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/g;

/**
 * Control characters, which a client discards before resolving a URL. A tab, newline, or NUL
 * sitting inside a scheme is invisible to whatever follows the link, so they go before the
 * scheme is read.
 */
const URL_CONTROL = /\p{Cc}/gu;

/** An entity reference {@link decodeEntities} did not recognize. */
const RESIDUAL_ENTITY = /&[a-zA-Z#][a-zA-Z0-9]*;/;

/** Where a URL's path, query, or fragment begins — a `:` after this point is not a scheme. */
const URL_PATH_START = /[/?#]/;

/**
 * Schemes worth reproducing in plain text. The feeds only ever link out over HTTP(S), so anything
 * else — `javascript:`, `data:` — is a destination this server has no reason to hand an agent, and
 * the anchor keeps its text without it.
 */
const SAFE_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);

/**
 * The destination to reproduce for an anchor, or `''` to keep only the anchor's text.
 *
 * The test is default-deny: a value whose first `:` precedes any `/?#` is scheme-bearing and has to
 * name a {@link SAFE_SCHEMES} member exactly. A scheme obscured behind control characters or a
 * half-decoded entity therefore drops rather than passing through as merely unrecognized — the
 * client that resolves the URL would strip the padding and be left with the scheme this rejects.
 * A relative destination carries no scheme at all and is kept as it arrived.
 */
function linkDestination(href: string): string {
  const value = href.replace(URL_CONTROL, '').trim();
  if (RESIDUAL_ENTITY.test(value)) return '';
  const colon = value.indexOf(':');
  if (colon === -1) return value;
  const pathStart = value.search(URL_PATH_START);
  if (pathStart !== -1 && pathStart < colon) return value;
  return SAFE_SCHEMES.has(value.slice(0, colon).toLowerCase()) ? value : '';
}

/** The first `href` on an anchor tag, or `''` when it carries none. */
function anchorHref(tag: string): string {
  ATTRIBUTE.lastIndex = TAG_NAME.exec(tag)?.[0].length ?? 1;
  for (let attr = ATTRIBUTE.exec(tag); attr; attr = ATTRIBUTE.exec(tag)) {
    if (attr[1]?.toLowerCase() === 'href') return attr[2] ?? attr[3] ?? attr[4] ?? '';
  }
  return '';
}

function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(ENTITY, (raw, body: string) => {
    if (body.startsWith('#')) {
      const codePoint =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      // A surrogate half is a valid code point but not a valid character; emitting one leaves an
      // unpaired surrogate in every downstream encoding of this text.
      const usable =
        codePoint > 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff);
      return usable ? String.fromCodePoint(codePoint) : raw;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? raw;
  });
}

/**
 * Index of the `>` closing the tag that opens at `start`, or -1 when the input has none. Quoted
 * attribute values are skipped so a `>` inside one does not end the tag early.
 */
function findTagEnd(input: string, start: number): number {
  let quote = '';
  for (let i = start + 1; i < input.length; i++) {
    const char = input[i];
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return i;
    }
  }
  return -1;
}

/**
 * Index of the `<` opening `</name`, at or after `from`, or -1 when there is none. The name has to
 * end where the tag does, so `</scriptx>` does not close a `<script>` and spill the rest of its
 * body into the prose.
 *
 * Only the tag name is lowercased for the comparison: lowercasing the whole input once per dropped
 * element would cost a full copy each time, and a few thousand `<script>` elements would then take
 * quadratic time. It would also misalign indices, since case conversion can change a string's
 * length.
 */
function findClosingTag(input: string, name: string, from: number): number {
  for (let i = input.indexOf('</', from); i !== -1; i = input.indexOf('</', i + 1)) {
    if (input.slice(i + 2, i + 2 + name.length).toLowerCase() !== name) continue;
    const after = input[i + 2 + name.length];
    if (after === undefined || after === '>' || after === '/' || /\s/.test(after)) return i;
  }
  return -1;
}

/**
 * Renders an HTML fragment as plain text. Block elements become line breaks, `<script>`/`<style>`
 * content is dropped along with its tags, remaining tags are removed, entity references in the
 * surviving text are decoded, and each anchor keeps its destination as `text (url)` — for the
 * HTTP(S)-class schemes listed in {@link SAFE_SCHEMES}; any destination naming another scheme, or
 * hiding one behind control characters or an unresolved entity, is dropped and the anchor
 * contributes its text alone.
 *
 * Input with neither `<` nor `&` is returned byte-for-byte — the highway-alert feed is mostly
 * plain prose and there is nothing to normalize there.
 *
 * Entities are decoded only *after* the tags around them are gone, so an entity-encoded tag
 * (`&lt;script&gt;`) decodes to inert text and can never be re-read as markup. It also keeps the
 * `&quot;`-laden JSON that the ferry feed hides in `data-ccp-props` attributes out of the prose:
 * the attribute leaves with its tag, before any decoding happens.
 *
 * Cost is linear in the input length. The scan visits each character once — a tag is found by a
 * forward scan that the cursor then skips past, and an unterminated `<` sets a flag rather than
 * re-scanning the tail for every later `<`. No regex here is applied to the whole input: each runs
 * over one tag, one attribute value, one text run, or one line, and every quantifier in them is
 * bounded or unnested. A prior release in this server shipped a regex that backtracked
 * quadratically over a few KB of input, so this is verified by a timing test rather than by
 * inspection — see `tests/services/html-text.test.ts`.
 */
export function htmlToText(input: string): string {
  if (!input.includes('<') && !input.includes('&')) return input;

  const chunks: string[] = [];
  /** Where the current anchor's text starts in `chunks`, so `</a>` can compare it to the href. */
  let anchor: { href: string; mark: number } | undefined;
  let unterminated = false;
  let i = 0;
  let textStart = 0;

  const flushText = (end: number) => {
    if (end > textStart) chunks.push(decodeEntities(input.slice(textStart, end)));
  };

  while (i < input.length) {
    if (input[i] !== '<') {
      i++;
      continue;
    }
    // Only a name, a closing slash, or a declaration opens a tag; "a < b" stays prose.
    const next = input[i + 1];
    if (
      unterminated ||
      next === undefined ||
      !(next === '/' || next === '!' || next === '?' || /[a-zA-Z]/.test(next))
    ) {
      i++;
      continue;
    }

    if (input.startsWith('<!--', i)) {
      // A comment runs to `-->`, not to the first `>`, and none of what it holds is prose.
      flushText(i);
      const close = input.indexOf('-->', i + 4);
      i = close === -1 ? input.length : close + 3;
      textStart = i;
      continue;
    }

    const end = findTagEnd(input, i);
    if (end === -1) {
      // The rest of the input is one unterminated tag — an unclosed quoted value, or a name with
      // no `>` after it — so no later `<` can open another.
      unterminated = true;
      i++;
      continue;
    }

    flushText(i);
    const tag = input.slice(i, end + 1);
    const name = TAG_NAME.exec(tag)?.[1]?.split(':').pop()?.toLowerCase() ?? '';
    const isClosing = tag[1] === '/';
    i = end + 1;
    textStart = i;

    if (!isClosing && DROPPED_CONTENT_TAGS.has(name)) {
      const close = findClosingTag(input, name, i);
      const closeEnd = close === -1 ? -1 : findTagEnd(input, close);
      i = closeEnd === -1 ? input.length : closeEnd + 1;
      textStart = i;
      chunks.push('\n');
      continue;
    }

    if (name === 'a') {
      if (isClosing) {
        if (anchor) {
          const text = chunks.slice(anchor.mark).join('').trim();
          if (anchor.href && text !== anchor.href) {
            chunks.push(text ? ` (${anchor.href})` : anchor.href);
          }
          anchor = undefined;
        }
      } else {
        anchor = {
          href: linkDestination(decodeEntities(anchorHref(tag))),
          mark: chunks.length,
        };
      }
      continue;
    }

    if (BLOCK_TAGS.has(name)) chunks.push('\n');
  }
  flushText(input.length);

  return chunks
    .join('')
    .split('\n')
    .map((line) => line.replace(HORIZONTAL_WHITESPACE, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}
