import type { QuantityKind } from '@tw/model';
import { describe, expect, it } from 'vitest';
import { allUnits, defaultTargetUnit, getUnit, physicalBounds } from './index';

const QUANTITIES: QuantityKind[] = [
  'length',
  'area',
  'volume',
  'std_volume',
  'mass',
  'time',
  'temperature',
  'temperature_diff',
  'pressure_abs',
  'pressure_gauge',
  'pressure_diff',
  'energy',
  'power',
  'density',
  'mass_rate',
  'volume_rate',
  'std_volume_rate',
  'energy_rate',
  'fraction',
  'velocity',
  'dimensionless',
];

describe('physicalBounds', () => {
  it('temperature in degC has min -273.15', () => {
    expect(physicalBounds('temperature', 'degC')).toEqual({ min: -273.15, source: expect.stringContaining('0 K') });
    expect(physicalBounds('temperature', 'K')?.min).toBe(0);
    expect(physicalBounds('temperature', 'degF')?.min).toBe(-459.67);
  });

  it('pressure_abs has min 0', () => {
    for (const code of ['Pa', 'kPa', 'MPa', 'bar', 'psia', 'psi']) {
      expect(physicalBounds('pressure_abs', code), code).toEqual({ min: 0, source: expect.stringContaining('vacuum') });
    }
  });

  it('fraction in % gives [0, 100]', () => {
    expect(physicalBounds('fraction', '%')).toMatchObject({ min: 0, max: 100 });
    expect(physicalBounds('fraction', 'fraction')).toMatchObject({ min: 0, max: 1 });
    expect(physicalBounds('fraction', 'ppm')).toMatchObject({ min: 0, max: 1e6 });
  });

  it('amounts and flows cannot be negative', () => {
    for (const [q, code] of [
      ['volume', 'bbl'],
      ['std_volume', 'MMscf'],
      ['mass', 't'],
      ['energy', 'MMBtu'],
      ['density', 'kg/m3'],
      ['area', 'acre'],
      ['volume_rate', 'bbl/d'],
      ['std_volume_rate', 'Sm3/d'],
      ['mass_rate', 'kg/h'],
      ['energy_rate', 'MMBtu/d'],
    ] as const) {
      expect(physicalBounds(q, code), `${q} in ${code}`).toEqual({ min: 0, source: expect.any(String) });
    }
  });

  it('has no bounds where any value is possible', () => {
    expect(physicalBounds('length', 'm')).toBeNull();
    expect(physicalBounds('temperature_diff', 'delta_degC')).toBeNull();
    expect(physicalBounds('pressure_gauge', 'psig')).toBeNull();
    expect(physicalBounds('pressure_diff', 'inH2O')).toBeNull();
    expect(physicalBounds('power', 'kW')).toBeNull();
    expect(physicalBounds('velocity', 'm/s')).toBeNull();
  });

  it('accepts a unit of the same dimension, and nothing else', () => {
    expect(physicalBounds('energy_rate', 'kW')).toMatchObject({ min: 0 });
    expect(physicalBounds('temperature', 'delta_degC')).toBeNull();
    expect(physicalBounds('pressure_abs', 'psig')).toBeNull();
    expect(physicalBounds('temperature', 'kPa')).toBeNull();
    expect(physicalBounds('temperature', 'nope')).toBeNull();
    expect(physicalBounds('temperature', '°C')).toBeNull();
  });

  it('expresses every bound as the SI bound converted to the unit', () => {
    for (const u of allUnits()) {
      const bounds = physicalBounds(u.quantity, u.code);
      if (bounds?.min !== undefined) {
        const si = bounds.min * u.toSI.factor + u.toSI.offset;
        expect(Math.abs(si), u.code).toBeLessThan(1e-9);
      }
    }
  });
});

describe('defaultTargetUnit', () => {
  it('gives SI and Oilfield defaults', () => {
    expect(defaultTargetUnit('pressure_abs', 'SI')).toBe('kPa');
    expect(defaultTargetUnit('pressure_abs', 'Oilfield')).toBe('psia');
    expect(defaultTargetUnit('temperature', 'SI')).toBe('degC');
    expect(defaultTargetUnit('temperature', 'Oilfield')).toBe('degF');
    expect(defaultTargetUnit('std_volume_rate', 'Oilfield')).toBe('Mscf/d');
    expect(defaultTargetUnit('volume_rate', 'SI')).toBe('m3/d');
  });

  it('gives null where the unit system does not matter', () => {
    for (const q of ['time', 'fraction', 'dimensionless'] as const) {
      expect(defaultTargetUnit(q, 'SI')).toBeNull();
      expect(defaultTargetUnit(q, 'Oilfield')).toBeNull();
    }
  });

  it('every default is a registry unit of exactly that quantity', () => {
    for (const q of QUANTITIES) {
      for (const system of ['SI', 'Oilfield'] as const) {
        const code = defaultTargetUnit(q, system);
        if (code !== null) expect(getUnit(code)?.quantity, `${q} ${system}`).toBe(q);
      }
    }
  });
});
