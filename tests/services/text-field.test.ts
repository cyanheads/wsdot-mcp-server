/**
 * @fileoverview Tests for the shared upstream-string rule: a blank or whitespace-only value is
 * absent, a populated one is kept with its ends trimmed, and HTML-bearing values are rendered to
 * plain text before the same rule applies.
 * @module tests/services/text-field.test
 */

import { describe, expect, it } from 'vitest';
import { htmlTextField, nonBlank, nonBlankHtml, textField } from '@/services/text-field.js';

describe('nonBlank', () => {
  it('returns undefined for null and undefined', () => {
    expect(nonBlank(null)).toBeUndefined();
    expect(nonBlank(undefined)).toBeUndefined();
  });

  it.each(['', ' ', '   ', '\t', '\n', ' \t\r\n ', ' ', '   '])(
    'returns undefined for the blank value %j',
    (blank) => {
      expect(nonBlank(blank)).toBeUndefined();
    },
  );

  it('trims a padded value at the ends only', () => {
    expect(nonBlank('Coupeville ')).toBe('Coupeville');
    expect(nonBlank('  ORE217 ')).toBe('ORE217');
  });

  it('keeps internal whitespace and line breaks', () => {
    expect(nonBlank('  Lane closed.\n  Expect  delays.  ')).toBe('Lane closed.\n  Expect  delays.');
  });

  it('returns a populated, unpadded value unchanged', () => {
    expect(nonBlank('Snoqualmie Pass')).toBe('Snoqualmie Pass');
  });
});

describe('textField', () => {
  it('spreads a trimmed value under its key', () => {
    expect(textField('terminalName', 'Coupeville ')).toEqual({ terminalName: 'Coupeville' });
  });

  it.each([null, undefined, '', '   \t'])('returns an empty object for %j', (raw) => {
    expect(textField('terminalName', raw)).toEqual({});
  });

  it('spreads cleanly into an object literal, omitting blank values', () => {
    const obj = { id: 1, ...textField('a', ' x '), ...textField('b', '  ') };
    expect(obj).toEqual({ id: 1, a: 'x' });
  });
});

describe('htmlTextField', () => {
  it('renders markup to plain text before trimming', () => {
    expect(htmlTextField('body', '<p>  Sailing <b>cancelled</b>.  </p>')).toEqual({
      body: 'Sailing cancelled.',
    });
  });

  it.each(['<p></p>', '<p> </p><br />', '&nbsp;', '<p>&nbsp;</p>'])(
    'drops a value holding only markup or entity whitespace: %j',
    (raw) => {
      expect(htmlTextField('body', raw)).toEqual({});
    },
  );

  it.each(['', '   ', '\t\n'])('drops a blank value that carries no markup: %j', (raw) => {
    expect(htmlTextField('body', raw)).toEqual({});
  });

  it('trims a markup-free padded value, keeping its internal spacing', () => {
    expect(htmlTextField('body', '  All lanes blocked.  Expect delays. ')).toEqual({
      body: 'All lanes blocked.  Expect delays.',
    });
  });

  it('returns an empty object for null and undefined', () => {
    expect(htmlTextField('body', null)).toEqual({});
    expect(htmlTextField('body', undefined)).toEqual({});
  });
});

describe('nonBlankHtml', () => {
  it('renders markup to plain text, keeping a link destination', () => {
    expect(nonBlankHtml('<a href="https://tinyurl.com/mptshczh">Boarding Pass</a> required.')).toBe(
      'Boarding Pass (https://tinyurl.com/mptshczh) required.',
    );
  });

  it.each([null, undefined, '', '  ', '<p></p>', '<p>&nbsp;</p>'])(
    'returns undefined for %j',
    (raw) => {
      expect(nonBlankHtml(raw)).toBeUndefined();
    },
  );

  it('agrees with htmlTextField on every value', () => {
    for (const raw of ['<i>only</i>.', '  plain  ', '<p></p>', null]) {
      const text = nonBlankHtml(raw);
      expect(htmlTextField('body', raw)).toEqual(text === undefined ? {} : { body: text });
    }
  });
});
