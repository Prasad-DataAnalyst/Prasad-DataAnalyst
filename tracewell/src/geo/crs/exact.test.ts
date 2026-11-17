import { describe, expect, it } from 'vitest';
import * as exact from './exact';

/** Seeded, so a failure names inputs that can be tried again. */
function* randoms(seed: number, n: number, lo: number, hi: number): Generator<number> {
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const u = s / 2 ** 32;
    yield lo + u * (hi - lo);
  }
}

/** The difference in units of the last place of the larger magnitude. */
function ulps(a: number, b: number): number {
  if (a === b) return 0;
  const scale = Math.max(Math.abs(a), Math.abs(b), 2 ** -1022);
  return Math.abs(a - b) / (scale * Number.EPSILON);
}

describe('exact elementary functions', () => {
  const cases: [string, (x: number) => number, (x: number) => number, number, number, number][] = [
    ['sin', exact.sin, Math.sin, -20, 20, 1],
    ['cos', exact.cos, Math.cos, -20, 20, 1],
    ['tan', exact.tan, Math.tan, -1.5, 1.5, 2],
    ['atan', exact.atan, Math.atan, -50, 50, 1],
    ['asin', exact.asin, Math.asin, -1, 1, 2],
    ['log', exact.log, Math.log, 1e-6, 1e6, 1],
    ['exp', exact.exp, Math.exp, -50, 50, 1],
    ['sinh', exact.sinh, Math.sinh, -3, 3, 3],
    ['expm1', exact.expm1, Math.expm1, -3, 3, 3],
    ['log1p', exact.log1p, Math.log1p, -0.9, 3, 3],
    ['cosh', exact.cosh, Math.cosh, -3, 3, 2],
    ['tanh', exact.tanh, Math.tanh, -3, 3, 3],
    ['asinh', exact.asinh, Math.asinh, -20, 20, 3],
    ['atanh', exact.atanh, Math.atanh, -0.999, 0.999, 3],
  ];
  it.each(cases)('%s agrees with the platform within a few units in the last place', (_name, f, ref, lo, hi, tol) => {
    let worst = 0;
    let at = 0;
    for (const x of randoms(7, 20000, lo, hi)) {
      const d = ulps(f(x), ref(x));
      if (d > worst) {
        worst = d;
        at = x;
      }
    }
    expect(worst, `worst at ${at}`).toBeLessThanOrEqual(tol);
  });

  it('is exact where the answer is', () => {
    expect([exact.sin(0), exact.cos(0), exact.tan(0), exact.atan(0), exact.log(1), exact.exp(0)]).toEqual([
      0, 1, 0, 0, 0, 1,
    ]);
    expect(exact.atan2(0, -1)).toBe(Math.PI);
    expect(exact.atan2(-0, -1)).toBe(-Math.PI);
    expect(exact.atan2(1, 0)).toBe(Math.PI / 2);
    expect(exact.atan2(-1, 0)).toBe(-Math.PI / 2);
    expect(exact.atan2(1, 1)).toBe(Math.PI / 4);
    expect(exact.atan2(-1, -1)).toBe((-3 * Math.PI) / 4);
    expect(exact.log(2 ** 40)).toBeCloseTo(40 * Math.LN2, 13);
  });

  it('refuses what it is not built for, rather than giving a wrong number', () => {
    expect(exact.sin(1e6)).toBeNaN();
    expect(exact.log(-1)).toBeNaN();
    expect(exact.log(0)).toBe(-Infinity);
    expect(exact.exp(800)).toBeNaN();
    expect(exact.asin(1.5)).toBeNaN();
  });
});
