import fc from 'fast-check';
import { EngineError, type ConversionMethod } from '@tw/model';
import { describe, expect, it } from 'vitest';
import { allUnits, applyConversion, checkConvertible, compatibleUnits, conversionMethod, getUnit } from './index';

function convert(x: number, from: string, to: string): number {
  return applyConversion(conversionMethod(from, to), x);
}

function relativeError(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.abs(expected);
}

function refusal(from: string, to: string): { code: string; message: string; fix: string } {
  const check = checkConvertible(from, to);
  if (check.ok) throw new Error(`${from} → ${to} was expected to be refused`);
  return check;
}

/** Every ordered pair of units that convert into each other, including a unit with itself. */
const PAIRS: [string, string][] = allUnits().flatMap((u) =>
  compatibleUnits(u.code).map((v): [string, string] => [u.code, v.code]),
);

/**
 * Round-trip tolerance: 4 ulp of the largest magnitude the computation passes through. For pure
 * scale factors that is 4 ulp relative to x. With offsets (temperatures) the SI value can be much
 * larger than x (0.001 °C is 273.151 K), and rounding at that magnitude is the floor of accuracy.
 */
function roundTripTolerance(m: ConversionMethod, x: number): number {
  const si = x * m.fromFactor + m.fromOffset;
  const magnitude = Math.max(Math.abs(x), Math.abs(si) / m.fromFactor, Math.abs(si - m.toOffset) / m.fromFactor);
  return 4 * Number.EPSILON * magnitude;
}

/** Finite doubles away from the subnormal range, where relative precision is lost by design. */
const value = fc
  .double({ min: -1e12, max: 1e12, noNaN: true, noDefaultInfinity: true })
  .filter((x) => x === 0 || Math.abs(x) >= 1e-280);

describe('reference values', () => {
  it('1 ft = 0.3048 m exactly', () => {
    expect(convert(1, 'ft', 'm')).toBe(0.3048);
  });

  it('1 psi = 6894.757293168361 Pa within 1e-12 relative', () => {
    for (const psi of ['psi', 'psia', 'psig', 'delta_psi']) {
      const to = { psi: 'Pa', psia: 'Pa', psig: 'kPag', delta_psi: 'delta_kPa' }[psi] ?? 'Pa';
      const scale = to === 'Pa' ? 1 : 1000;
      expect(relativeError(convert(1, psi, to) * scale, 6894.757293168361)).toBeLessThan(1e-12);
    }
  });

  it('1 bbl = 0.158987294928 m³', () => {
    expect(convert(1, 'bbl', 'm3')).toBe(0.158987294928);
  });

  it('0 °C = 32 °F = 273.15 K', () => {
    expect(convert(0, 'degC', 'K')).toBe(273.15);
    expect(convert(0, 'degC', 'degF')).toBeCloseTo(32, 12);
    expect(convert(32, 'degF', 'degC')).toBeCloseTo(0, 12);
    expect(relativeError(convert(32, 'degF', 'K'), 273.15)).toBeLessThan(1e-12);
    expect(relativeError(convert(273.15, 'K', 'degF'), 32)).toBeLessThan(1e-12);
  });

  it('1 Btu (IT) = 1055.05585262 J', () => {
    expect(convert(1, 'Btu', 'J')).toBe(1055.05585262);
  });

  it('1 kWh = 3.6e6 J', () => {
    expect(convert(1, 'kWh', 'J')).toBe(3.6e6);
  });

  it('1 MMBtu = 1.05505585262e9 J', () => {
    expect(convert(1, 'MMBtu', 'J')).toBe(1.05505585262e9);
  });

  it('1 MMscf/d = 1e6 scf/d', () => {
    expect(relativeError(convert(1, 'MMscf/d', 'scf/d'), 1e6)).toBeLessThan(1e-12);
  });

  it.each([
    [100, 'psia', 'kPa', 689.4757293168361],
    [10, 'bar', 'kPa', 1000],
    [1, 'bbl/d', 'm3/d', 0.158987294928],
    [1, 'MMBtu', 'GJ', 1.05505585262],
    [1, 'MMBtu/d', 'GJ/d', 1.05505585262],
    [1, 'hp', 'kW', 0.7456998715822702],
    [100, 'delta_degC', 'delta_degF', 180],
    [-40, 'degC', 'degF', -40],
    [50, '%', 'fraction', 0.5],
    [1, 'acre', 'm2', 4046.8564224],
    [1, 't/d', 'kg/h', 1000 / 24],
    [1, 'Mscf', 'scf', 1000],
    [1, 'stb', 'scf', 5.614583333333333],
  ])('%d %s = %d %s', (x, from, to, expected) => {
    expect(relativeError(convert(x, from, to), expected)).toBeLessThan(1e-12);
  });
});

describe('refusals', () => {
  it('psia → psig gives UNIT_GAUGE_ABSOLUTE with a fix', () => {
    const r = refusal('psia', 'psig');
    expect(r.code).toBe('UNIT_GAUGE_ABSOLUTE');
    expect(r.message).toContain('atmospheric pressure');
    expect(r.fix).toBe(
      'Choose a unit that is also absolute: Pa, kPa, MPa, bar, psi. If the values are really gauge readings, ' +
        "change the column's unit to psig instead of converting.",
    );
    expect(refusal('barg', 'kPa').code).toBe('UNIT_GAUGE_ABSOLUTE');
  });

  it('scf (60 °F) → Sm3 (15 °C) gives UNIT_CONVENTION', () => {
    const r = refusal('scf', 'Sm3');
    expect(r.code).toBe('UNIT_CONVENTION');
    expect(r.message).toContain('60 °F and 14.696 psia');
    expect(r.message).toContain('15 °C and 101.325 kPa');
    expect(r.fix).toContain('Mscf, MMscf, stb');
    expect(refusal('MMscf/d', 'Sm3/d').code).toBe('UNIT_CONVENTION');
    expect(refusal('Sm3', 'Nm3').code).toBe('UNIT_CONVENTION');
  });

  it('a unit alone in its convention says so in the fix', () => {
    expect(refusal('Nm3', 'Sm3').fix).toContain(
      'No other unit at 0 °C and 101.325 kPa is in the registry, so keep Nm3',
    );
  });

  it('actual → standard volume gives UNIT_CONVENTION', () => {
    expect(refusal('m3', 'Sm3').code).toBe('UNIT_CONVENTION');
    expect(refusal('stb/d', 'bbl/d').code).toBe('UNIT_CONVENTION');
    expect(refusal('m3', 'Sm3').message).toContain('measured pressure and temperature');
    expect(refusal('m3', 'Sm3').fix).toBe(
      "Choose a unit of the same kind: L, bbl, ft3. If the values are already at standard conditions, change the column's unit to Sm3 instead of converting.",
    );
    expect(refusal('stb/d', 'bbl/d').fix).toContain('If the values are really at the measured conditions');
  });

  it('kPa → m gives UNIT_DIMENSION', () => {
    const r = refusal('kPa', 'm');
    expect(r.code).toBe('UNIT_DIMENSION');
    expect(r.message).toBe(
      'kPa measures absolute pressure and m measures length, so one cannot be converted to the other.',
    );
    expect(r.fix).toBe('Choose a unit of absolute pressure: Pa, MPa, bar, psia, psi.');
  });

  it('degC → delta_degC gives UNIT_DIMENSION', () => {
    const r = refusal('degC', 'delta_degC');
    expect(r.code).toBe('UNIT_DIMENSION');
    expect(r.message).toContain('temperature difference has no zero offset');
    expect(refusal('delta_K', 'K').code).toBe('UNIT_DIMENSION');
  });

  it('pressure differences are not pressures', () => {
    expect(refusal('delta_psi', 'psia').code).toBe('UNIT_DIMENSION');
    expect(refusal('inH2O', 'psig').message).toContain('pressure difference');
  });

  it('adds the pressure-difference note only when the other unit is a pressure', () => {
    const note = 'A pressure difference is not measured from vacuum';
    expect(refusal('delta_psi', 'psia').message).toContain(note);
    expect(refusal('kPag', 'delta_kPa').message).toContain(note);
    expect(refusal('delta_psi', 'degC').message).not.toContain(note);
    expect(refusal('inH2O', 'm').message).not.toContain(note);
  });

  it('unknown codes, including aliases, give UNIT_UNKNOWN', () => {
    expect(refusal('furlong', 'm').code).toBe('UNIT_UNKNOWN');
    expect(refusal('m', 'PSIA')).toMatchObject({ code: 'UNIT_UNKNOWN', message: expect.stringContaining('"PSIA"') });
  });

  it('every refusal explains itself without placeholders', () => {
    for (const u of allUnits()) {
      for (const v of allUnits()) {
        const check = checkConvertible(u.code, v.code);
        if (check.ok) continue;
        expect(check.message.length).toBeGreaterThan(20);
        expect(check.fix.length).toBeGreaterThan(20);
        expect(`${check.message} ${check.fix}`).not.toMatch(/undefined|null|NaN/);
      }
    }
  });
});

describe('checkConvertible and compatibleUnits', () => {
  it('lists the units of the same quantity and convention, in registry order', () => {
    expect(compatibleUnits('psia').map((u) => u.code)).toEqual(['Pa', 'kPa', 'MPa', 'bar', 'psia', 'psi']);
    expect(compatibleUnits('scf').map((u) => u.code)).toEqual(['scf', 'Mscf', 'MMscf', 'stb']);
    expect(compatibleUnits('nope')).toEqual([]);
    expect(compatibleUnits('psig')[0]).toEqual({
      code: 'kPag',
      label: 'kilopascal (gauge)',
      quantity: 'pressure_gauge',
      convention: 'gauge',
    });
  });

  it('converts power and energy rate into each other: both are joules per second', () => {
    expect(checkConvertible('kW', 'MMBtu/d')).toEqual({ ok: true });
    expect(compatibleUnits('GJ/d').map((u) => u.code)).toEqual(['W', 'kW', 'MW', 'hp', 'GJ/d', 'MMBtu/d']);
  });

  it('agrees with compatibleUnits and is symmetric for every pair of units', () => {
    for (const u of allUnits()) {
      const compatible = new Set(compatibleUnits(u.code).map((c) => c.code));
      for (const v of allUnits()) {
        expect(checkConvertible(u.code, v.code).ok, `${u.code} → ${v.code}`).toBe(compatible.has(v.code));
        expect(checkConvertible(u.code, v.code).ok).toBe(checkConvertible(v.code, u.code).ok);
      }
    }
  });
});

describe('conversionMethod', () => {
  it('records factors, offsets, formula, citation and registry version', () => {
    const m = conversionMethod('psia', 'kPa');
    expect(m).toMatchObject({
      from: 'psia',
      to: 'kPa',
      fromFactor: getUnit('psia')?.toSI.factor,
      fromOffset: 0,
      toFactor: 1000,
      toOffset: 0,
      formula: 'y = x * 6894.757293168362 / 1000',
      registryVersion: '2026.1',
    });
    expect(m.source).toContain('psia: Pound-force per square inch');
    expect(m.source).toContain('NIST SP 811 (2008), Appendix B.8');
    expect(m.source).toContain(' | kPa: ');
  });

  it.each([
    ['degC', 'K', 'y = x + 273.15'],
    ['K', 'degC', 'y = x - 273.15'],
    ['degC', 'degF', 'y = (x + 273.15 - 255.37222222222223) / 0.5555555555555556'],
    ['degF', 'degC', 'y = x * 0.5555555555555556 + 255.37222222222223 - 273.15'],
    ['ft', 'm', 'y = x * 0.3048'],
    ['m', 'ft', 'y = x / 0.3048'],
    ['psi', 'psia', 'y = x'],
    ['kPa', 'kPa', 'y = x'],
  ])('%s → %s: %s', (from, to, formula) => {
    expect(conversionMethod(from, to).formula).toBe(formula);
  });

  it('cites a shared source once', () => {
    expect(conversionMethod('kPa', 'kPa').source).toBe(getUnit('kPa')?.source);
  });

  it('throws EngineError with the check code, fix and units', () => {
    let error: unknown;
    try {
      conversionMethod('psia', 'psig');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EngineError);
    expect(error).toMatchObject({ code: 'UNIT_GAUGE_ABSOLUTE', detail: { from: 'psia', to: 'psig' } });
    expect((error as EngineError).fix).toBe(refusal('psia', 'psig').fix);
    expect(() => conversionMethod('kPa', 'm')).toThrow(expect.objectContaining({ code: 'UNIT_DIMENSION' }));
    expect(() => conversionMethod('x', 'm')).toThrow(expect.objectContaining({ code: 'UNIT_UNKNOWN' }));
  });

  it('writes a formula that evaluates exactly like applyConversion', () => {
    for (const [from, to] of PAIRS) {
      const m = conversionMethod(from, to);
      // Test-only evaluation of the recorded text, to prove the audit log describes the computation.
      const evaluate = new Function('x', `return ${m.formula.replace(/^y = /, '')};`) as (x: number) => number;
      for (const x of [-1234.5, -1, 0.1, 1, 98.6, 3e7])
        expect(evaluate(x), `${from} → ${to}`).toBe(applyConversion(m, x));
    }
  });
});

describe('applyConversion', () => {
  it('returns x unchanged between units with the same factor and offset', () => {
    const m = conversionMethod('degF', 'degF');
    for (const x of [0.1, -459.67, 1e15, 98.6]) expect(applyConversion(m, x)).toBe(x);
    expect(applyConversion(conversionMethod('psi', 'psia'), 0.1)).toBe(0.1);
  });

  it('round-trips A → B → A within 4 ulp for every compatible pair (fixed values)', () => {
    for (const [from, to] of PAIRS) {
      const there = conversionMethod(from, to);
      const back = conversionMethod(to, from);
      for (const x of [0, 1, -1, 1e-6, 0.001, 123.456, -273.15, 1e9, -9999.25]) {
        const result = applyConversion(back, applyConversion(there, x));
        expect(Math.abs(result - x), `${from} → ${to} → ${from} at ${x}`).toBeLessThanOrEqual(
          roundTripTolerance(there, x),
        );
      }
    }
  });

  it('round-trips A → B → A within 4 ulp for every compatible pair (property)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...PAIRS), value, ([from, to], x) => {
        const there = conversionMethod(from, to);
        const result = applyConversion(conversionMethod(to, from), applyConversion(there, x));
        return Math.abs(result - x) <= roundTripTolerance(there, x);
      }),
      { numRuns: 5000 },
    );
  });

  it('is monotonic increasing for every compatible pair (property)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...PAIRS), value, value, ([from, to], a, b) => {
        const m = conversionMethod(from, to);
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        return applyConversion(m, lo) <= applyConversion(m, hi);
      }),
      { numRuns: 5000 },
    );
  });

  it('is strictly increasing over distinguishable inputs', () => {
    for (const [from, to] of PAIRS) {
      const m = conversionMethod(from, to);
      expect(applyConversion(m, 1), `${from} → ${to}`).toBeLessThan(applyConversion(m, 2));
    }
  });
});
