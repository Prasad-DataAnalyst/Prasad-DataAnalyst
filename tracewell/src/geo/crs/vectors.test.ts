/**
 * The exact bits of the elementary functions and of transformations between pairs of systems,
 * kept in __fixtures__/crs-vectors.json. This test keeps the TypeScript code to them, and the
 * native engine's geodesy tests keep its code to the same file, so both engines convert every
 * coordinate to the same bits. After a deliberate change to the arithmetic, write the file again
 * with TW_UPDATE_VECTORS=1 and check both engines agree.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as exact from './exact';
import { crsTransformer } from './transform';

const FILE = new URL('./__fixtures__/crs-vectors.json', import.meta.url);
const VIEW = new DataView(new ArrayBuffer(8));

function bits(x: number): string {
  VIEW.setFloat64(0, x);
  return VIEW.getBigUint64(0).toString(16).padStart(16, '0');
}

function* randoms(seed: number, n: number, lo: number, hi: number): Generator<number> {
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    yield lo + (s / 2 ** 32) * (hi - lo);
  }
}

const UNARY: [string, (x: number) => number, number, number][] = [
  ['sin', exact.sin, -50, 50],
  ['cos', exact.cos, -50, 50],
  ['tan', exact.tan, -1.5, 1.5],
  ['atan', exact.atan, -20, 20],
  ['asin', exact.asin, -1, 1],
  ['log', exact.log, 1e-8, 1e8],
  ['exp', exact.exp, -40, 40],
  ['sinh', exact.sinh, -3, 3],
  ['cosh', exact.cosh, -3, 3],
  ['tanh', exact.tanh, -3, 3],
  ['asinh', exact.asinh, -30, 30],
  ['atanh', exact.atanh, -0.99, 0.99],
  ['log1p', exact.log1p, -0.9, 5],
  ['expm1', exact.expm1, -3, 3],
];

/** Pairs of systems, each with the area its points are drawn from: [west, south, east, north]. */
const PAIRS: [string, string, [number, number, number, number]][] = [
  ['EPSG:4326', 'EPSG:32631', [0, 40, 6, 80]],
  ['EPSG:32631', 'EPSG:4326', [200000, 4500000, 800000, 8500000]],
  ['EPSG:4326', 'EPSG:27700', [-7, 50, 1.5, 60]],
  ['EPSG:27700', 'EPSG:4326', [0, 0, 700000, 1200000]],
  ['EPSG:23031', 'EPSG:4326', [300000, 5000000, 700000, 7000000]],
  ['EPSG:4230', 'EPSG:25831', [0, 50, 6, 62]],
  ['EPSG:2154', 'EPSG:4326', [100000, 6100000, 1200000, 7100000]],
  ['EPSG:4326', 'EPSG:2154', [-4, 42, 8, 51]],
  ['EPSG:26715', 'EPSG:4267', [300000, 3000000, 700000, 5500000]],
  ['EPSG:4267', 'EPSG:4326', [-120, 25, -70, 49]],
  ['EPSG:28350', 'EPSG:4283', [200000, 6000000, 800000, 8000000]],
  ['EPSG:4326', 'EPSG:28350', [114, -35, 120, -20]],
  ['EPSG:32760', 'EPSG:4326', [300000, 5000000, 700000, 9000000]],
  ['EPSG:4326', 'OGC:CRS84', [-180, -90, 180, 90]],
];

function build(): unknown {
  const functions: Record<string, [string, string][]> = {};
  for (const [name, f, lo, hi] of UNARY) {
    functions[name] = [...randoms(name.length * 7919, 150, lo, hi)].map((x) => [bits(x), bits(f(x))]);
  }
  const ys = [...randoms(11, 150, -5, 5)];
  functions['atan2'] = [...randoms(13, 150, -5, 5)].map((x, i) => [
    `${bits(ys[i] as number)},${bits(x)}`,
    bits(exact.atan2(ys[i] as number, x)),
  ]);
  functions['pow'] = [...randoms(17, 150, 0.01, 3)].map((x, i) => [
    `${bits(x)},${bits((ys[i] as number) / 3)}`,
    bits(exact.pow(x, (ys[i] as number) / 3)),
  ]);
  const transforms = PAIRS.map(([from, to, [w, s, e, n]], k) => {
    const t = crsTransformer(from, to);
    const xs = [...randoms(100 + k, 60, w, e)];
    const points = [...randoms(200 + k, 60, s, n)].map((y, i) => {
      const x = xs[i] as number;
      const out = t.forward(x, y);
      return [bits(x), bits(y), out === null ? null : bits(out[0]), out === null ? null : bits(out[1])];
    });
    return { from, to, points };
  });
  return { functions, transforms };
}

describe('exact bits', () => {
  it('match the vectors the native engine is held to', () => {
    const now = build();
    if (process.env['TW_UPDATE_VECTORS'] === '1') writeFileSync(FILE, `${JSON.stringify(now)}\n`);
    expect(now).toEqual(JSON.parse(readFileSync(FILE, 'utf8')));
  });
});
