import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalCell, canonicalJson, canonicalNumber, utf8 } from './canonical';
import { EngineError } from './errors';
import type { JsonValue } from './ids';
import type { CellValue, Geometry } from './values';

interface Vector {
  name: string;
  kind: 'number' | 'json' | 'cell';
  input: string;
  expected: string;
}

interface VectorFile {
  vectors: Vector[];
  rejected: { name: string; kind: 'number'; literal: string }[];
}

const VECTORS = JSON.parse(
  readFileSync(new URL('./__fixtures__/canonical-vectors.json', import.meta.url), 'utf8'),
) as VectorFile;

function encode(kind: Vector['kind'], value: unknown): string {
  switch (kind) {
    case 'number':
      return canonicalNumber(value as number);
    case 'json':
      return canonicalJson(value as JsonValue);
    case 'cell':
      return canonicalCell(value as CellValue);
  }
}

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof EngineError ? e.code : 'not an EngineError';
  }
  return undefined;
}

/** Rebuilds every object with its keys in a shuffled order, using the shuffles fast-check drew. */
function permuteKeys(value: JsonValue, rank: (key: string) => number): JsonValue {
  if (Array.isArray(value)) return value.map((item) => permuteKeys(item, rank));
  if (value === null || typeof value !== 'object') return value;
  const keys = Object.keys(value).sort((a, b) => rank(a) - rank(b) || (a < b ? 1 : -1));
  // fromEntries defines own properties, so a '__proto__' key stays a key instead of setting the prototype.
  return Object.fromEntries(keys.map((key) => [key, permuteKeys(value[key] as JsonValue, rank)]));
}

function withoutNegativeZero(value: JsonValue): JsonValue {
  if (typeof value === 'number') return Object.is(value, -0) ? 0 : value;
  if (Array.isArray(value)) return value.map(withoutNegativeZero);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withoutNegativeZero(v)]));
}

/** Whitespace outside string literals; canonical JSON has none. */
function structuralWhitespace(text: string): boolean {
  return /\s/.test(text.replace(/"(?:[^"\\]|\\.)*"/g, '""'));
}

describe('canonicalNumber', () => {
  it.each([0.1, 1e21, 1e-7, 123456789012345680000, 5e-324, 1.7976931348623157e308])('equals String(n) for %s', (n) => {
    expect(canonicalNumber(n)).toBe(String(n));
  });

  it('writes the boundary forms of Number.prototype.toString', () => {
    expect(canonicalNumber(1e21)).toBe('1e+21');
    expect(canonicalNumber(1e20)).toBe('100000000000000000000');
    expect(canonicalNumber(1e-7)).toBe('1e-7');
    expect(canonicalNumber(0.000001)).toBe('0.000001');
    expect(canonicalNumber(-1.5)).toBe('-1.5');
  });

  it("writes -0 as '0'", () => {
    expect(canonicalNumber(-0)).toBe('0');
  });

  it.each([NaN, Infinity, -Infinity])('throws INVALID_INPUT for %s', (n) => {
    expect(errorCode(() => canonicalNumber(n))).toBe('INVALID_INPUT');
  });

  it('round-trips every finite double', () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true, noDefaultInfinity: true }), (x) => {
        expect(Number(canonicalNumber(x))).toBe(Object.is(x, -0) ? 0 : x);
      }),
      { numRuns: 2000 },
    );
  });

  it('equals String(n) for every finite double except -0', () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true, noDefaultInfinity: true }), (x) => {
        expect(canonicalNumber(x)).toBe(Object.is(x, -0) ? '0' : String(x));
      }),
      { numRuns: 2000 },
    );
  });
});

describe('canonicalJson', () => {
  it('sorts nested keys and has no whitespace', () => {
    const value = { b: [{ z: 1, a: { y: true, x: null } }], a: 'text with spaces', c: {} };
    expect(canonicalJson(value)).toBe('{"a":"text with spaces","b":[{"a":{"x":null,"y":true},"z":1}],"c":{}}');
  });

  it('gives the same output whatever the key insertion order', () => {
    const forward = { alpha: 1, beta: { one: 1, two: [2, { p: 1, q: 2 }] }, gamma: null };
    const backward = { gamma: null, beta: { two: [2, { q: 2, p: 1 }], one: 1 }, alpha: 1 };
    expect(canonicalJson(backward)).toBe(canonicalJson(forward));
  });

  it('sorts keys by UTF-16 code unit, so integer-like keys sort as text', () => {
    expect(canonicalJson({ '10': 1, '2': 2, '1': 3, a: 4 })).toBe('{"1":3,"10":1,"2":2,"a":4}');
    // U+1F600 is the surrogate pair D83D DE00, which sorts before U+FF21 by code unit.
    expect(canonicalJson({ '\uff21': 1, '\u{1f600}': 2 })).toBe('{"\u{1f600}":2,"\uff21":1}');
  });

  it('escapes strings exactly as JSON.stringify does', () => {
    const text = 'quote " backslash \\ newline \n tab \t nul \u0000 unit separator \u001f del \u007f lone \ud800';
    expect(canonicalJson(text)).toBe(JSON.stringify(text));
    expect(canonicalJson(text)).toContain('\\ud800');
  });

  it('writes canonical numbers inside containers', () => {
    expect(canonicalJson([1.0, -0, 1e21, 1e-7, 0.1])).toBe('[1,0,1e+21,1e-7,0.1]');
  });

  it('accepts objects without a prototype, as structuredClone and parsers may produce', () => {
    const bare = Object.assign(Object.create(null) as Record<string, JsonValue>, { b: 1, a: 2 });
    expect(canonicalJson(bare)).toBe('{"a":2,"b":1}');
  });

  it('leaves out object members whose value is undefined, as JSON.stringify does', () => {
    const value = { a: 1, b: undefined } as unknown as JsonValue;
    expect(canonicalJson(value)).toBe('{"a":1}');
  });

  it.each<[string, unknown]>([
    ['NaN', { a: NaN }],
    ['Infinity', [Infinity]],
    ['undefined array element', [1, undefined]],
    ['a Date', { at: new Date(0) }],
    ['a Map', new Map()],
    ['a typed array', new Uint8Array(2)],
    ['a function', { f: () => 1 }],
    ['a bigint', 1n],
    ['a symbol', Symbol('s')],
  ])('throws INVALID_INPUT for %s', (_name, value) => {
    expect(errorCode(() => canonicalJson(value as JsonValue))).toBe('INVALID_INPUT');
  });

  it('throws INVALID_INPUT for a reference cycle', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    expect(errorCode(() => canonicalJson(cyclic as JsonValue))).toBe('INVALID_INPUT');
  });

  it('encodes a shared, acyclic sub-object every time it appears', () => {
    const shared = { k: 1 };
    expect(canonicalJson({ a: shared, b: [shared, shared] })).toBe('{"a":{"k":1},"b":[{"k":1},{"k":1}]}');
  });

  it('is stable under key permutation, parses back to the value and has no structural whitespace', () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.func(fc.integer()), (generated, rankFn) => {
        const value = generated as JsonValue;
        const text = canonicalJson(value);
        expect(canonicalJson(permuteKeys(value, (key) => rankFn(key)))).toBe(text);
        expect(JSON.parse(text)).toEqual(withoutNegativeZero(value));
        expect(structuralWhitespace(text)).toBe(false);
      }),
      { numRuns: 500 },
    );
  });
});

describe('canonicalCell', () => {
  const point: Geometry = { type: 'Point', coordinates: [3.2, 56.5] };

  it.each<[string, CellValue, string]>([
    ['null', null, '\u0000N'],
    ['empty string', '', 's:'],
    ['string', 'Well A-12', 's:Well A-12'],
    ['string with newlines', 'line 1\nline 2\r\nline 3', 's:line 1\nline 2\r\nline 3'],
    ['string with emoji', '\u{1f6e2}\ufe0f Brent \u{1f600}', 's:\u{1f6e2}\ufe0f Brent \u{1f600}'],
    ['decomposed string, not normalised', 'e\u0301', 's:e\u0301'],
    ['string that spells the null encoding', '\u0000N', 's:\u0000N'],
    ['integer', 42, 'n:42'],
    ['fraction', -273.15, 'n:-273.15'],
    ['negative zero', -0, 'n:0'],
    ['exponent form', 1e21, 'n:1e+21'],
    ['true', true, 'b:1'],
    ['false', false, 'b:0'],
    ['date', { date: '2026-03-01' }, 'd:2026-03-01'],
    ['datetime', { datetime: '2026-03-01T06:30:00.000Z' }, 't:2026-03-01T06:30:00.000Z'],
    ['point geometry', { geometry: point }, 'g:{"coordinates":[3.2,56.5],"type":"Point"}'],
    [
      'geometry collection',
      {
        geometry: {
          type: 'GeometryCollection',
          geometries: [
            point,
            {
              type: 'LineString',
              coordinates: [
                [0, -0],
                [1, 2],
              ],
            },
          ],
        },
      },
      'g:{"geometries":[{"coordinates":[3.2,56.5],"type":"Point"},{"coordinates":[[0,0],[1,2]],"type":"LineString"}],' +
        '"type":"GeometryCollection"}',
    ],
  ])('encodes %s', (_name, value, expected) => {
    expect(canonicalCell(value)).toBe(expected);
  });

  it('keeps null distinct from every string', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => {
        expect(canonicalCell(s)).not.toBe(canonicalCell(null));
      }),
    );
  });

  it.each<[string, unknown]>([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['an array', [1, 2]],
    ['an unknown object', { value: 1 }],
    ['a geometry with a non-finite coordinate', { geometry: { type: 'Point', coordinates: [NaN, 0] } }],
    // Ambiguous or lossy objects would otherwise share a digest with a different, well-formed cell.
    ['an object that is both a date and a datetime', { date: '2026-03-01', datetime: '2026-03-01T06:30:00.000Z' }],
    ['a date with another member', { date: '2026-03-01', note: 'estimated' }],
    ['a geometry with another member', { geometry: { type: 'Point', coordinates: [1, 2] }, crs: 'EPSG:27700' }],
    // Another engine writes the same instant in the canonical form, so a different spelling must not digest silently.
    ['a datetime without milliseconds', { datetime: '2026-03-01T06:30:00Z' }],
    ['a datetime with an offset', { datetime: '2026-03-01T06:30:00.000+01:00' }],
    ['a datetime in lower case', { datetime: '2026-03-01t06:30:00.000z' }],
    ['a date without zero padding', { date: '2026-3-1' }],
    ['a date with a time', { date: '2026-03-01T00:00:00.000Z' }],
    ['a date with an expanded year', { date: '+012026-03-01' }],
  ])('throws INVALID_INPUT for %s', (_name, value) => {
    expect(errorCode(() => canonicalCell(value as CellValue))).toBe('INVALID_INPUT');
  });
});

describe('golden vectors (shared with tests/oracle/canonical.py)', () => {
  it('cover every encoding', () => {
    const kinds = new Set(VECTORS.vectors.map((v) => v.kind));
    expect([...kinds].sort()).toEqual(['cell', 'json', 'number']);
    expect(VECTORS.rejected.length).toBeGreaterThan(0);
  });

  it.each(VECTORS.vectors.map((v) => [`${v.kind}: ${v.name}`, v] as const))('%s', (_label, v) => {
    expect(encode(v.kind, JSON.parse(v.input))).toBe(v.expected);
  });

  it.each(VECTORS.rejected.map((r) => [r.name, r] as const))('rejects %s', (_label, r) => {
    expect(errorCode(() => encode(r.kind, Number(r.literal)))).toBe('INVALID_INPUT');
  });
});

describe('utf8', () => {
  it('encodes text as UTF-8 bytes', () => {
    expect([...utf8('A\u00e9\u20ac\u{1f600}')]).toEqual([0x41, 0xc3, 0xa9, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80]);
  });

  it('encodes the canonical null cell as NUL then N', () => {
    expect([...utf8(canonicalCell(null))]).toEqual([0x00, 0x4e]);
  });

  it('replaces a lone surrogate with U+FFFD', () => {
    expect([...utf8('\ud800')]).toEqual([0xef, 0xbf, 0xbd]);
  });
});
