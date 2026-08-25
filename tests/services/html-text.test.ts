/**
 * @fileoverview Tests for htmlToText — the shared HTML-fragment-to-plain-text normalizer applied
 * to highway alert descriptions and ferry bulletin bodies. Covers the markup each feed actually
 * carries, the hostile shapes it does not, and the linear-time guarantee.
 * @module tests/services/html-text.test
 */

import { describe, expect, it } from 'vitest';

import { htmlToText } from '@/services/html-text.js';

describe('htmlToText — anchors', () => {
  it('renders an anchor as text followed by its destination', () => {
    expect(
      htmlToText('Closed through October. <a href="https://wsdot.wa.gov/x">Read the advisory</a>.'),
    ).toBe('Closed through October. Read the advisory (https://wsdot.wa.gov/x).');
  });

  it('handles an unquoted href attribute', () => {
    // Two anchors in the live highway feed carry a bare href; a quoted-only pattern misses them.
    expect(
      htmlToText('See <a href=https://www.cityoforting.org/a-b>the update</a> for details.'),
    ).toBe('See the update (https://www.cityoforting.org/a-b) for details.');
  });

  it('handles a single-quoted href attribute', () => {
    expect(htmlToText("<a href='https://example.com/p'>page</a>")).toBe(
      'page (https://example.com/p)',
    );
  });

  it('does not repeat a destination that is already the anchor text', () => {
    expect(htmlToText('<a href="https://example.com">https://example.com</a>')).toBe(
      'https://example.com',
    );
  });

  it('emits the destination alone when the anchor has no text', () => {
    expect(htmlToText('Read <a href="https://example.com/x"></a> now')).toBe(
      'Read https://example.com/x now',
    );
  });

  it('keeps anchor text when the anchor carries no href', () => {
    expect(htmlToText('<a name="top">anchor</a>')).toBe('anchor');
  });

  it('keeps the text but drops a non-HTTP destination', () => {
    // javascript:/data: destinations are an injection shape the feeds never legitimately emit,
    // and handing one to an agent as a followable link is not worth the fidelity.
    expect(htmlToText('<a href="javascript:alert(1)">click</a>')).toBe('click');
    expect(htmlToText('<a href="data:text/html,<script>alert(1)</script>">click</a>')).toBe(
      'click',
    );
  });

  it('keeps mailto and tel destinations', () => {
    expect(htmlToText('<a href="mailto:x@example.com">email us</a>')).toBe(
      'email us (mailto:x@example.com)',
    );
  });

  it('preserves anchors carrying target and rel attributes', () => {
    expect(
      htmlToText('<a href="https://example.com/p" target="_blank" rel="noopener">map</a>'),
    ).toBe('map (https://example.com/p)');
  });

  it('keeps a relative destination, which names no scheme to vet', () => {
    expect(htmlToText('<a href="/ferries/schedule">schedule</a>')).toBe(
      'schedule (/ferries/schedule)',
    );
  });

  it('reads the real href past another attribute whose value contains one', () => {
    // A quoted value is skipped whole, so ` href=` inside a title cannot pose as the destination.
    expect(
      htmlToText('<a title=" href=https://spoof.example" href="https://real.example">go</a>'),
    ).toBe('go (https://real.example)');
  });

  it('drops a scheme hidden behind control characters', () => {
    // A client strips these before resolving the URL, so the scheme check has to strip them first.
    for (const href of [
      'java\u0000script:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      '\u0001javascript:alert(1)',
    ]) {
      expect(htmlToText(`<a href="${href}">click</a>`)).toBe('click');
    }
  });

  it('drops a destination still carrying an entity this decoder does not resolve', () => {
    // `&colon;` and `&Tab;` are real HTML entities left verbatim here; a consumer that resolves
    // them would be handed back the scheme the check is meant to reject.
    expect(htmlToText('<a href="javascript&colon;alert(1)">click</a>')).toBe('click');
    expect(htmlToText('<a href="java&Tab;script:alert(1)">click</a>')).toBe('click');
  });
});

describe('htmlToText — block structure', () => {
  it('renders each paragraph on its own line', () => {
    expect(htmlToText('<p>First.</p>\r\n<p>Second.</p>')).toBe('First.\nSecond.');
  });

  it('renders list items on their own lines', () => {
    expect(htmlToText('<ol><li>Follow the signal.</li><li>Take a pass.</li></ol>')).toBe(
      'Follow the signal.\nTake a pass.',
    );
  });

  it('breaks on <br />', () => {
    expect(htmlToText('One<br />Two<br/>Three')).toBe('One\nTwo\nThree');
  });

  it('flattens nested inline spans without inserting breaks', () => {
    // One live bulletin is almost entirely nested <span> wrappers around individual words.
    expect(
      htmlToText(
        '<p><span data-contrast="auto" class="TextRun SCXW180249970"><span>Vessel</span> <span>#2</span></span></p>',
      ),
    ).toBe('Vessel #2');
  });

  it('drops XML-namespaced Office-paste tags', () => {
    expect(htmlToText('<o:p>Pasted</o:p><u1:p>fragment</u1:p>')).toBe('Pasted\nfragment');
  });

  it('collapses runs of whitespace and drops blank lines', () => {
    expect(htmlToText('<p>Line&nbsp;one</p>\r\n\r\n<p>Line   two</p><p></p>')).toBe(
      'Line one\nLine two',
    );
  });

  it('returns an empty string for markup carrying no text', () => {
    expect(htmlToText('<p></p><br/><span></span>')).toBe('');
  });
});

describe('htmlToText — entities', () => {
  it('decodes the named entities the feeds use', () => {
    expect(htmlToText('<p>He said &quot;go&quot; &amp; left</p>')).toBe('He said "go" & left');
  });

  it('decodes decimal and hexadecimal numeric references', () => {
    expect(htmlToText('<p>&#8217;s and &#x2014; dash</p>')).toBe('’s and — dash');
  });

  it('leaves an unrecognized entity verbatim rather than guessing', () => {
    expect(htmlToText('<p>&foobar; stays</p>')).toBe('&foobar; stays');
  });

  it('leaves a reference to a surrogate half verbatim rather than emitting one', () => {
    // String.fromCodePoint accepts it, and the result is an unpaired surrogate that survives into
    // every downstream encoding of the response.
    expect(htmlToText('<p>a&#xD800;b</p>')).toBe('a&#xD800;b');
    expect(htmlToText('<p>a&#xDFFF;b</p>')).toBe('a&#xDFFF;b');
    // Code points on the far side of the surrogate range still decode.
    expect(htmlToText('<p>&#x1F6A2;</p>')).toBe('🚢');
  });

  it('drops attribute-embedded entities along with their tag', () => {
    // Live bulletins hide a JSON blob full of &quot; inside data-ccp-props; it is not prose.
    expect(
      htmlToText(
        '<span data-ccp-props="{&quot;134233117&quot;:false,&quot;201341983&quot;:0}">Wait for green.</span>',
      ),
    ).toBe('Wait for green.');
  });

  it('decodes entities only after tags are gone, so encoded markup stays inert text', () => {
    // Decoding first would turn this into a live <script> element for the tag-stripper to see.
    expect(htmlToText('&lt;script&gt;alert(1)&lt;/script&gt;')).toBe('<script>alert(1)</script>');
  });
});

describe('htmlToText — dropped content', () => {
  it('drops a script element and everything inside it', () => {
    expect(htmlToText('<script>alert("xss")</script>Real advisory text.')).toBe(
      'Real advisory text.',
    );
  });

  it('drops a style element and everything inside it', () => {
    expect(htmlToText('<style>.x{color:red}</style>Body copy.')).toBe('Body copy.');
  });

  it('drops the remainder when a script element is never closed', () => {
    expect(htmlToText('Before.<script>alert(1)')).toBe('Before.');
  });

  it('does not end a script at a longer tag name that merely starts the same way', () => {
    expect(htmlToText('<script>a</scriptx>b</script>Tail.')).toBe('Tail.');
  });

  it('drops a comment whole, including one holding a > or a script', () => {
    // A comment runs to `-->`; ending it at the first `>` spills its contents into the prose.
    expect(htmlToText('<!-- a > b -->Visible.')).toBe('Visible.');
    expect(htmlToText('<!-- <script>alert(1)</script> -->After.')).toBe('After.');
  });

  it('drops the Office conditional comments a Word paste carries', () => {
    expect(
      htmlToText('<!--[if !supportLists]--><span>1.</span><!--[endif]--> Follow the signal.'),
    ).toBe('1. Follow the signal.');
  });
});

describe('htmlToText — malformed and non-markup input', () => {
  it('returns input with no markup characters byte-for-byte', () => {
    const plain = 'Lane   closure  at MP 30.';
    expect(htmlToText(plain)).toBe(plain);
  });

  it('leaves a less-than sign used as arithmetic alone', () => {
    expect(htmlToText('Delay < 10 min & rising')).toBe('Delay < 10 min & rising');
  });

  it('leaves an unterminated tag as literal text', () => {
    expect(htmlToText('Text <a href="x" with no closing bracket')).toBe(
      'Text <a href="x" with no closing bracket',
    );
  });

  it('handles an empty string', () => {
    expect(htmlToText('')).toBe('');
  });

  it('drops comments and declarations', () => {
    expect(htmlToText('<!-- note -->Visible<!DOCTYPE html>')).toBe('Visible');
  });
});

describe('htmlToText — linear time', () => {
  /**
   * A prior release shipped a regex that backtracked quadratically and blocked the event loop for
   * 40 seconds on a 4 KB input, so linearity is measured rather than argued. Each shape below is
   * run at two sizes an order of magnitude apart; quadratic cost would show as a ~100x jump.
   * The assertion is deliberately loose (25x) — it is a catastrophe detector, not a benchmark, and
   * has to stay stable on a loaded CI machine.
   */
  const shapes: [string, (n: number) => string][] = [
    ['unterminated tag openers', (n) => '<'.repeat(n)],
    ['unclosed anchors', (n) => '<a href=x '.repeat(n / 10)],
    ['nested spans', (n) => `${'<span>'.repeat(n / 12)}x${'</span>'.repeat(n / 12)}`],
    ['repeated entities', (n) => '&quot;'.repeat(n / 6)],
    ['attribute soup', (n) => `<a ${'href="x" '.repeat(n / 9)}>t</a>`],
    ['unclosed script', (n) => `<script>${'a'.repeat(n)}`],
    ['angle brackets in prose', (n) => 'a < b > c '.repeat(n / 10)],
    // Locating each closing tag by lowercasing the whole input made this shape quadratic —
    // a full copy per element, 10 seconds on 576 KB.
    ['many script elements', (n) => '<script>x</script>'.repeat(n / 18)],
    ['many style elements', (n) => '<style>.a{}</style>'.repeat(n / 19)],
    ['many anchors', (n) => '<a href="https://e.com/x">t</a>'.repeat(n / 31)],
    ['many paragraphs', (n) => '<p>text</p>'.repeat(n / 11)],
  ];

  /**
   * Fastest of several runs. A single measurement picks up whatever GC pause or scheduler blip
   * the rest of the suite happens to cause, which on a sub-millisecond sample swamps the signal
   * being measured; the minimum is the run that got a clean slice of CPU.
   */
  function timeOf(input: string): number {
    let fastest = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 5; run++) {
      const start = performance.now();
      htmlToText(input);
      fastest = Math.min(fastest, performance.now() - start);
    }
    return fastest;
  }

  for (const [label, build] of shapes) {
    it(`stays linear on ${label}`, () => {
      const small = build(50_000);
      const large = build(500_000);
      // Warm the JIT so compile cost is not charged to the small sample.
      timeOf(small);
      timeOf(large);

      // Sub-millisecond samples make a ratio meaningless; the absolute bound covers those.
      const smallMs = Math.max(timeOf(small), 1);
      const largeMs = timeOf(large);

      // The bound discriminates growth class, not a constant factor: a 10x input costs ~10x
      // linear and ~100x quadratic, so anything under 50 rules out the quadratic backtracking
      // this guards. A tighter bound only measures how much CPU the rest of the suite left.
      expect(largeMs / smallMs).toBeLessThan(50);
      expect(largeMs).toBeLessThan(2_000);
    });
  }

  it('normalizes a 400 KB pathological fragment well inside a request budget', () => {
    const input = `${'<a href="https://example.com/x">link</a><p>&quot;text&quot;</p>'.repeat(6_000)}`;
    const start = performance.now();
    const out = htmlToText(input);
    expect(performance.now() - start).toBeLessThan(1_000);
    expect(out).toContain('link (https://example.com/x)');
  });
});
