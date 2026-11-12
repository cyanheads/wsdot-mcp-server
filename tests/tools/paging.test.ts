/**
 * @fileoverview The paging pieces the paged list tools share, tested at their own seam: the
 * `limit` schema in each WSDOT_CLAMP_LIMITS mode (what it accepts, rejects, and advertises), the
 * clamp with its notice, log line, and counter, and the page text and continuation sentence.
 * Each tool's wiring is proven in `traffic-paging.test.ts` and the shared pagination contract.
 * @module tests/tools/paging.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext, type MockContextLogger } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Every counter increment, by metric name. The wrapped counter still records through the SDK. */
const counterAdds = vi.hoisted(() => [] as { name: string; args: unknown[] }[]);

vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    ...actual,
    createCounter: (...params: Parameters<typeof actual.createCounter>) => {
      const counter = actual.createCounter(...params);
      return {
        add: (...args: Parameters<typeof counter.add>) => {
          counterAdds.push({ name: params[0], args });
          counter.add(...args);
        },
      };
    },
  };
});

import {
  clampPageLimit,
  continuationNotice,
  type PageLimitSpec,
  pageLimitSchema,
  renderPage,
  slicePage,
  withClampNotice,
  withContinuation,
} from '@/mcp-server/tools/paging.js';

const SPEC: PageLimitSpec = {
  tool: 'wsdot_test_rows',
  unit: 'rows',
  defaultLimit: 20,
  maxLimit: 500,
};

beforeEach(() => {
  counterAdds.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The `limit` property as a client reads it from `tools/list`, JSON round-tripped. */
function advertised(spec: PageLimitSpec): Record<string, unknown> {
  const emitted = z.toJSONSchema(z.object({ limit: pageLimitSchema(spec) }), { io: 'input' });
  return JSON.parse(JSON.stringify(emitted)).properties.limit;
}

/** The issue messages a value raises, or `[]` when it parses. */
function messages(schema: z.ZodType, value: unknown): string[] {
  const result = schema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

const REJECTED_IN_BOTH_MODES = [
  [0, 'Too small: expected number to be >=1'],
  [-1, 'Too small: expected number to be >=1'],
  [2.5, 'Invalid input: expected int, received number'],
  ['abc', 'Invalid input: expected number, received string'],
] as const;

describe.each([
  ['unset', undefined],
  ['true', 'true'],
])('pageLimitSchema while clamping (WSDOT_CLAMP_LIMITS %s)', (_mode, flag) => {
  beforeEach(() => {
    vi.stubEnv('WSDOT_CLAMP_LIMITS', flag);
  });

  it('accepts a limit above the maximum, unchanged, for the handler to clamp', () => {
    const schema = pageLimitSchema(SPEC);
    for (const value of [1, 500, 501, 100_000]) expect(schema.parse(value)).toBe(value);
    expect(schema.parse(undefined)).toBeUndefined();
  });

  it.each(REJECTED_IN_BOTH_MODES)('rejects %s with its own message', (value, message) => {
    expect(messages(pageLimitSchema(SPEC), value)).toEqual([message]);
  });

  it('advertises a positive integer with no maximum, and states the cap once', () => {
    expect(advertised(SPEC)).toEqual({
      type: 'integer',
      minimum: 1,
      description:
        'Maximum rows to return in this page. Defaults to 20; a larger value returns at most 500 and says so.',
    });
  });
});

describe('pageLimitSchema with WSDOT_CLAMP_LIMITS=false', () => {
  beforeEach(() => {
    vi.stubEnv('WSDOT_CLAMP_LIMITS', 'false');
  });

  it('accepts the maximum and rejects one past it with the bound in the message', () => {
    const schema = pageLimitSchema(SPEC);
    expect(schema.parse(500)).toBe(500);
    expect(messages(schema, 501)).toEqual(['Too big: expected number to be <=500']);
    expect(messages(schema, 100_000)).toEqual(['Too big: expected number to be <=500']);
    expect(schema.safeParse(501).error?.issues[0]).toMatchObject({
      code: 'too_big',
      maximum: 500,
      inclusive: true,
    });
  });

  it.each(REJECTED_IN_BOTH_MODES)('rejects %s with its own message', (value, message) => {
    expect(messages(pageLimitSchema(SPEC), value)).toEqual([message]);
  });

  it('advertises the maximum and the 1–N range', () => {
    expect(advertised(SPEC)).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: 500,
      description: 'Maximum rows to return in this page (1–500). Defaults to 20.',
    });
  });
});

describe('pageLimitSchema — the flag is read on every check and emission', () => {
  it('flips one schema instance between modes without rebuilding it', () => {
    const schema = pageLimitSchema(SPEC);
    const emitted = () =>
      JSON.parse(JSON.stringify(z.toJSONSchema(schema, { io: 'input' }))) as {
        maximum?: number;
      };

    vi.stubEnv('WSDOT_CLAMP_LIMITS', undefined);
    expect(emitted().maximum).toBeUndefined();
    expect(schema.parse(501)).toBe(501);

    vi.stubEnv('WSDOT_CLAMP_LIMITS', 'false');
    expect(emitted().maximum).toBe(500);
    expect(schema.safeParse(501).success).toBe(false);

    vi.stubEnv('WSDOT_CLAMP_LIMITS', 'true');
    expect(emitted().maximum).toBeUndefined();
    expect(schema.parse(501)).toBe(501);
  });

  it('ends the description with the tool note in both modes', () => {
    const spec = { ...SPEC, unit: 'terminals', maxLimit: 20, defaultLimit: 5, note: 'Counts X.' };
    vi.stubEnv('WSDOT_CLAMP_LIMITS', undefined);
    expect(advertised(spec).description).toBe(
      'Maximum terminals to return in this page. Defaults to 5; a larger value returns at most 20 and says so. Counts X.',
    );
    vi.stubEnv('WSDOT_CLAMP_LIMITS', 'false');
    expect(advertised(spec).description).toBe(
      'Maximum terminals to return in this page (1–20). Defaults to 5. Counts X.',
    );
  });
});

describe('clampPageLimit', () => {
  const run = (requested: number | undefined) => {
    const ctx = createMockContext();
    const page = clampPageLimit(SPEC, requested, ctx);
    return { page, logs: (ctx.log as MockContextLogger).calls };
  };

  it.each([
    [undefined, 20],
    [1, 1],
    [499, 499],
    [500, 500],
  ])('serves limit %s as %s with no notice, log line, or counter increment', (requested, limit) => {
    const { page, logs } = run(requested);
    expect(page).toEqual({ limit });
    expect(logs).toEqual([]);
    expect(counterAdds).toEqual([]);
  });

  it.each([
    [501, 'limit 501 exceeds the maximum of 500; using limit 500.'],
    [100_000, 'limit 100000 exceeds the maximum of 500; using limit 500.'],
  ])(
    'clamps %s to the maximum with one log line and one counter increment',
    (requested, notice) => {
      const { page, logs } = run(requested);
      expect(page).toEqual({ limit: 500, clampNotice: notice });
      expect(logs).toEqual([
        {
          level: 'info',
          msg: 'Clamped limit',
          data: { tool: 'wsdot_test_rows', requested, applied: 500 },
        },
      ]);
      expect(counterAdds).toEqual([
        { name: 'wsdot.limit.clamps', args: [1, { 'mcp.tool.name': 'wsdot_test_rows' }] },
      ]);
    },
  );
});

describe('withClampNotice', () => {
  it('appends the clamp sentence after the page notice', () => {
    expect(
      withClampNotice('Showing rows 1–500 of 900. Pass offset=500 for the next page.', {
        limit: 500,
        clampNotice: 'limit 501 exceeds the maximum of 500; using limit 500.',
      }),
    ).toBe(
      'Showing rows 1–500 of 900. Pass offset=500 for the next page. limit 501 exceeds the maximum of 500; using limit 500.',
    );
  });

  it('leaves the notice unchanged when nothing was clamped', () => {
    expect(withClampNotice('Showing rows 1–3 of 3.', { limit: 20 })).toBe('Showing rows 1–3 of 3.');
  });
});

describe('page text and continuation', () => {
  it('renders rows as blank-line separated blocks ending in one newline', () => {
    expect(renderPage(['a', 'b', 'c'], (row) => `### ${row}\nbody`)).toBe(
      '### a\nbody\n\n### b\nbody\n\n### c\nbody\n',
    );
  });

  it('names the next offset', () => {
    expect(continuationNotice(40)).toBe('Pass offset=40 for the next page.');
  });

  it('follows the showing sentence with the continuation only while rows remain', () => {
    expect(withContinuation('Showing rows 1–2 of 5.', 2)).toBe(
      'Showing rows 1–2 of 5. Pass offset=2 for the next page.',
    );
    expect(withContinuation('Showing rows 4–5 of 5.', null)).toBe('Showing rows 4–5 of 5.');
  });
});

describe('slicePage', () => {
  const rows = ['a', 'b', 'c', 'd', 'e'];

  it('takes a full page and points at the next', () => {
    expect(slicePage(rows, 0, 2)).toEqual({ rows: ['a', 'b'], hasMore: true, nextOffset: 2 });
    expect(slicePage(rows, 2, 2)).toEqual({ rows: ['c', 'd'], hasMore: true, nextOffset: 4 });
  });

  it('ends the last page, short or exact, with no next offset', () => {
    expect(slicePage(rows, 4, 2)).toEqual({ rows: ['e'], hasMore: false, nextOffset: null });
    expect(slicePage(rows, 3, 2)).toEqual({ rows: ['d', 'e'], hasMore: false, nextOffset: null });
  });

  it('returns no rows and no next offset for an offset past the end', () => {
    expect(slicePage(rows, 5, 2)).toEqual({ rows: [], hasMore: false, nextOffset: null });
    expect(slicePage(rows, 9, 2)).toEqual({ rows: [], hasMore: false, nextOffset: null });
  });
});
