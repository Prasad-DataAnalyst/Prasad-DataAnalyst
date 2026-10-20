import { readFileSync } from 'node:fs';
import { EngineError, schemas, type QuantityKind, type UnitDef } from '@tw/model';
import { describe, expect, it } from 'vitest';
import { allUnits, findUnit, getUnit, REGISTRY_JSON, REGISTRY_VERSION, unitInfo } from './index';
import { lookupKey, normalizeUnitText } from './names';
import { loadRegistry } from './registry';

const FILE_NAME = 'registry-2026.1.json';
const FILE_URL = new URL('./registry-2026.1.json', import.meta.url);

// Defining constants, typed in independently of the registry so a mistyped factor is caught.
const FT = 0.3048;
const IN = 0.0254;
const LB = 0.45359237;
const G0 = 9.80665;
const BTU = 1055.05585262;
const BBL = 42 * 231 * IN ** 3;
const FT3 = FT ** 3;
const PSI = (LB * G0) / IN ** 2;
const DAY = 86400;
const HOUR = 3600;

/** The defined SI factor (and offset) of every unit; each new unit must be added here as well. */
const DEFINITIONS: Record<string, number | [number, number]> = {
  m: 1,
  km: 1e3,
  mm: 1e-3,
  ft: FT,
  in: IN,
  m2: 1,
  km2: 1e6,
  acre: 43560 * FT ** 2,
  m3: 1,
  L: 1e-3,
  bbl: BBL,
  ft3: FT3,
  Sm3: 1,
  Nm3: 1,
  scf: FT3,
  Mscf: 1e3 * FT3,
  MMscf: 1e6 * FT3,
  stb: BBL,
  kg: 1,
  t: 1e3,
  lb: LB,
  s: 1,
  min: 60,
  h: HOUR,
  d: DAY,
  K: 1,
  degC: [1, 273.15],
  degF: [5 / 9, (459.67 * 5) / 9],
  delta_K: 1,
  delta_degC: 1,
  delta_degF: 5 / 9,
  Pa: 1,
  kPa: 1e3,
  MPa: 1e6,
  bar: 1e5,
  psia: PSI,
  psi: PSI,
  kPag: 1e3,
  barg: 1e5,
  psig: PSI,
  delta_kPa: 1e3,
  delta_psi: PSI,
  inH2O: 248.84,
  J: 1,
  MJ: 1e6,
  GJ: 1e9,
  kWh: 3.6e6,
  Btu: BTU,
  MMBtu: 1e6 * BTU,
  W: 1,
  kW: 1e3,
  MW: 1e6,
  hp: 550 * FT * LB * G0,
  'kg/m3': 1,
  'g/cm3': 1e3,
  'lb/ft3': LB / FT3,
  'kg/s': 1,
  'kg/h': 1 / HOUR,
  't/d': 1e3 / DAY,
  'lb/h': LB / HOUR,
  'm3/s': 1,
  'm3/h': 1 / HOUR,
  'm3/d': 1 / DAY,
  'bbl/d': BBL / DAY,
  'Sm3/d': 1 / DAY,
  'Nm3/h': 1 / HOUR,
  'scf/d': FT3 / DAY,
  'Mscf/d': (1e3 * FT3) / DAY,
  'MMscf/d': (1e6 * FT3) / DAY,
  'stb/d': BBL / DAY,
  'GJ/d': 1e9 / DAY,
  'MMBtu/d': (1e6 * BTU) / DAY,
  fraction: 1,
  '%': 0.01,
  ppm: 1e-6,
  'm/s': 1,
  'ft/s': FT,
};

/** Rounded conventional values: not exact although their decimal is short. */
const CONVENTIONAL = new Set(['inH2O']);

/** Significant digits of a number's shortest decimal form (what the registry file holds). */
function significantDigits(n: number): number {
  const mantissa = String(Math.abs(n)).split('e')[0] ?? '';
  return mantissa.replace('.', '').replace(/^0+/, '').length;
}

function closeTo(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= 4 * Number.EPSILON * Math.max(Math.abs(expected), Number.MIN_VALUE);
}

function unit(code: string): UnitDef {
  const u = getUnit(code);
  if (u === undefined) throw new Error(`no unit ${code}`);
  return u;
}

describe('registry file', () => {
  it('validates against schemas.unitRegistry', () => {
    const result = schemas.unitRegistry.safeParse(JSON.parse(REGISTRY_JSON));
    expect(result.success, result.error?.message).toBe(true);
  });

  it('REGISTRY_JSON equals the file contents', () => {
    expect(REGISTRY_JSON).toBe(readFileSync(FILE_URL, 'utf8'));
  });

  it('has version 2026.1, matching its file name', () => {
    expect(REGISTRY_VERSION).toBe('2026.1');
    expect(FILE_NAME).toBe(`registry-${REGISTRY_VERSION}.json`);
    expect((JSON.parse(REGISTRY_JSON) as { version: string }).version).toBe(REGISTRY_VERSION);
  });

  it('holds about 60 units (between 60 and 80)', () => {
    expect(allUnits().length).toBeGreaterThanOrEqual(60);
    expect(allUnits().length).toBeLessThanOrEqual(80);
  });
});

describe('names', () => {
  it('codes and aliases are unique', () => {
    const names = allUnits().flatMap((u) => [u.code, ...u.aliases]);
    expect(new Set(names).size).toBe(names.length);
  });

  it('no two names share a lookup key, and no alias repeats its unit after normalisation', () => {
    const keys = allUnits().flatMap((u) => [u.code, ...u.aliases].map(lookupKey));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('codes are short ASCII identifiers', () => {
    for (const u of allUnits()) expect(u.code).toMatch(/^[A-Za-z0-9_/%]{1,12}$/);
  });
});

describe('definitions', () => {
  it('every unit has a non-empty source and label', () => {
    for (const u of allUnits()) {
      expect(u.source.trim(), u.code).not.toBe('');
      expect(u.label.trim(), u.code).not.toBe('');
    }
  });

  it('every unit has an independently typed definition', () => {
    expect(Object.keys(DEFINITIONS).sort()).toEqual(
      allUnits()
        .map((u) => u.code)
        .sort(),
    );
  });

  it.each(allUnits().map((u) => [u.code, u] as const))('%s matches its definition', (code, u) => {
    const definition = DEFINITIONS[code] ?? Number.NaN;
    const [factor, offset] = typeof definition === 'number' ? [definition, 0] : definition;
    expect(closeTo(u.toSI.factor, factor), `factor ${u.toSI.factor} vs ${factor}`).toBe(true);
    expect(closeTo(u.toSI.offset, offset), `offset ${u.toSI.offset} vs ${offset}`).toBe(true);
  });

  it('keeps the plan reference values', () => {
    expect(unit('ft').toSI.factor).toBe(0.3048);
    expect(unit('bbl').toSI.factor).toBe(0.158987294928);
    expect(unit('Btu').toSI.factor).toBe(1055.05585262);
    expect(unit('MMBtu').toSI.factor).toBe(1.05505585262e9);
    expect(unit('kWh').toSI.factor).toBe(3.6e6);
    expect(Math.abs(unit('psia').toSI.factor / 6894.757293168361 - 1)).toBeLessThan(1e-12);
  });

  it('flags as exact only factors whose short decimal is the defined value', () => {
    for (const u of allUnits()) {
      const short = significantDigits(u.toSI.factor) <= 15 && significantDigits(u.toSI.offset) <= 15;
      if (u.exact) expect(short, u.code).toBe(true);
      else expect(!short || CONVENTIONAL.has(u.code), u.code).toBe(true);
    }
    expect(unit('inH2O').exact).toBe(false);
    expect(unit('psia').exact).toBe(false);
    expect(unit('ft3').exact).toBe(true);
  });

  it('tags standard volumes with their reference conditions and gauge pressures as gauge', () => {
    const tagged: Partial<Record<QuantityKind, true>> = { std_volume: true, std_volume_rate: true };
    for (const u of allUnits()) {
      if (u.quantity === 'pressure_gauge') expect(u.convention, u.code).toBe('gauge');
      else if (tagged[u.quantity]) expect(u.convention, u.code).toMatch(/^std-/);
      else expect(u.convention, u.code).toBeNull();
    }
  });

  it('is frozen, so callers cannot change a factor', () => {
    const psia = unit('psia');
    expect(Object.isFrozen(allUnits())).toBe(true);
    expect(Object.isFrozen(psia) && Object.isFrozen(psia.toSI) && Object.isFrozen(psia.aliases)).toBe(true);
    expect(() => {
      (psia.toSI as { factor: number }).factor = 1;
    }).toThrow(TypeError);
  });
});

describe('getUnit', () => {
  it('accepts exact codes only', () => {
    expect(getUnit('psia')?.code).toBe('psia');
    expect(getUnit('MMscf/d')?.code).toBe('MMscf/d');
    expect(getUnit('PSIA')).toBeUndefined();
    expect(getUnit('°F')).toBeUndefined();
    expect(getUnit('nope')).toBeUndefined();
  });
});

describe('findUnit', () => {
  it.each([
    ['psia', 'psia'],
    ['PSIA', 'psia'],
    ['  psia ', 'psia'],
    ['psi(a)', 'psia'],
    ['psi abs', 'psia'],
    ['psi g', 'psig'],
    ['m³/d', 'm3/d'],
    ['m3/d', 'm3/d'],
    ['M3/D', 'm3/d'],
    ['m3/day', 'm3/d'],
    ['m3 per day', 'm3/d'],
    ['m^3/d', 'm3/d'],
    ['degF', 'degF'],
    ['°F', 'degF'],
    ['ºF', 'degF'],
    ['deg F', 'degF'],
    ['deg. F', 'degF'],
    ['℃', 'degC'],
    ['C', 'degC'],
    ['K', 'K'],
    ['delta degC', 'delta_degC'],
    ['Δ°C', 'delta_degC'],
    ['kg_h', undefined],
    ['kg/hr', 'kg/h'],
    ['kW·h', 'kWh'],
    ['kW h', 'kWh'],
    ['MMSCFD', 'MMscf/d'],
    ['mmscf/d', 'MMscf/d'],
    ['Mcf/d', 'Mscf/d'],
    ['Mscf', 'Mscf'],
    ['kPa(g)', 'kPag'],
    ['KPA', 'kPa'],
    ['Pa', 'Pa'],
    ['PA', undefined],
    ['mm', 'mm'],
    ['MM', undefined],
    ['M', undefined],
    ['m', 'm'],
    ['L', 'L'],
    ['l', 'L'],
    ['c', undefined],
    ['bbl/day', 'bbl/d'],
    ['BOPD', 'bbl/d'],
    ['Sm³', 'Sm3'],
    ['mol%', '%'],
    ['％', '%'],
    ['Btu_IT', 'Btu'],
    ['BTU', 'Btu'],
    ['in. H2O', 'inH2O'],
    ['inH2O', 'inH2O'],
    ['', undefined],
    ['   ', undefined],
    ['Comments', undefined],
  ])('%j → %s', (text, code) => {
    expect(findUnit(text)?.code).toBe(code);
  });

  it('finds every code and alias', () => {
    for (const u of allUnits()) {
      for (const name of [u.code, ...u.aliases]) expect(findUnit(name), name).toBe(u);
    }
  });
});

describe('normalizeUnitText', () => {
  it('keeps case and removes spacing and marks', () => {
    expect(normalizeUnitText(' Sm³ / day ')).toBe('Sm3/d');
    expect(normalizeUnitText('bbl_per_hour')).toBe('bbl/h');
    expect(normalizeUnitText('percent')).toBe('percent');
  });
});

describe('unitInfo', () => {
  it('keeps code, label, quantity and convention', () => {
    expect(unitInfo(unit('scf'))).toEqual({
      code: 'scf',
      label: 'standard cubic foot (60 °F, 14.696 psia)',
      quantity: 'std_volume',
      convention: 'std-60F-14.696psia',
    });
  });
});

describe('loadRegistry', () => {
  const base = JSON.parse(REGISTRY_JSON) as { version: string; units: UnitDef[] };

  function load(units: UnitDef[]): () => unknown {
    return () => loadRegistry(JSON.stringify({ version: 'test', units }));
  }

  it('loads the shipped text', () => {
    expect(loadRegistry(REGISTRY_JSON).units.length).toBe(allUnits().length);
  });

  it('rejects names that collide after normalisation', () => {
    const psia = base.units.find((u) => u.code === 'psia');
    const psig = base.units.find((u) => u.code === 'psig');
    if (psia === undefined || psig === undefined) throw new Error('psia and psig are expected');
    expect(load([psia, { ...psig, aliases: [...psig.aliases, ' PSI A'] }])).toThrow(/same after normalisation/);
  });

  it('rejects names that are empty after normalisation', () => {
    const [first] = base.units;
    if (first === undefined) throw new Error('registry too small');
    expect(load([{ ...first, aliases: [' . '] }])).toThrow(/empty after normalisation/);
  });

  it('rejects documents that fail the schema, and text that is not JSON', () => {
    const [first] = base.units;
    if (first === undefined) throw new Error('registry too small');
    expect(load([{ ...first, toSI: { factor: 0, offset: 0 } }])).toThrow(/units\.0\.toSI\.factor/);
    expect(() => loadRegistry('{')).toThrow(EngineError);
  });
});
