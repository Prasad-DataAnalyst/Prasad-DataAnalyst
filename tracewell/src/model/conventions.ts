/**
 * The conventions a project works to (FR-CNV-01, FR-CNV-02): the reference conditions of standard
 * volumes, the energy unit, the combustion and metering reference temperatures of ISO 6976, and a
 * stated tonne-to-energy factor. Each is chosen explicitly or left unset, never assumed; a project
 * records them through a decision with a reason, so the audit log says who chose which and why.
 * The native engine (engine.rs) validates them with the same rules and the same messages.
 */
import type { UnitConvention } from './units';

/** Standard reference conditions, as the unit registry tags standard volumes. */
export type StandardConditions = Exclude<UnitConvention, 'gauge'>;
export type EnergyUnit = 'MMBtu' | 'kWh' | 'GJ';
export type TonneEnergyUnit = 'MMBtu/t' | 'GJ/t' | 'kWh/t';

export interface TonneToEnergy {
  /** Energy per tonne, in `unit`; greater than 0. */
  factor: number;
  unit: TonneEnergyUnit;
  /** Where the factor comes from, such as the contract clause that states it. */
  source: string;
}

export interface Conventions {
  standardConditions: StandardConditions | null;
  energyUnit: EnergyUnit | null;
  /** Combustion reference temperature of calorific values, °C. */
  combustionTemperature: number | null;
  /** Metering reference temperature of volumes, °C. */
  meteringTemperature: number | null;
  tonneToEnergy: TonneToEnergy | null;
}

export const NO_CONVENTIONS: Conventions = Object.freeze({
  standardConditions: null,
  energyUnit: null,
  combustionTemperature: null,
  meteringTemperature: null,
  tonneToEnergy: null,
});

/** The choices, in the order a form lists them. */
export const STANDARD_CONDITIONS: readonly StandardConditions[] = Object.freeze([
  'std-60F-14.696psia',
  'std-15C-101.325kPa',
  'std-0C-101.325kPa',
]);
export const ENERGY_UNITS: readonly EnergyUnit[] = Object.freeze(['MMBtu', 'GJ', 'kWh']);
export const TONNE_ENERGY_UNITS: readonly TonneEnergyUnit[] = Object.freeze(['MMBtu/t', 'GJ/t', 'kWh/t']);
/** The combustion reference temperatures of ISO 6976:2016, °C (15.55 °C is 60 °F). */
export const COMBUSTION_TEMPERATURES: readonly number[] = Object.freeze([25, 20, 15.55, 15, 0]);
/** The metering reference temperatures of ISO 6976:2016, °C. */
export const METERING_TEMPERATURES: readonly number[] = Object.freeze([20, 15.55, 15, 0]);

const CONDITIONS_TEXT: Readonly<Record<StandardConditions, string>> = {
  'std-60F-14.696psia': '60 °F and 14.696 psia',
  'std-15C-101.325kPa': '15 °C and 101.325 kPa',
  'std-0C-101.325kPa': '0 °C and 101.325 kPa',
};

/** How a form and the status bar name a set of standard conditions. */
export function standardConditionsText(c: StandardConditions): string {
  return CONDITIONS_TEXT[c];
}

const KEYS = ['standardConditions', 'energyUnit', 'combustionTemperature', 'meteringTemperature', 'tonneToEnergy'];
const TONNE_KEYS = ['factor', 'unit', 'source'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function keysProblem(v: Record<string, unknown>, keys: string[], what: string): string | null {
  const missing = keys.filter((k) => !(k in v));
  const extra = Object.keys(v).filter((k) => !keys.includes(k));
  if (missing.length > 0) return `${what} has no ${missing.join(', ')}`;
  if (extra.length > 0) return `${what} has the unknown member ${extra.join(', ')}`;
  return null;
}

/** Why a value is not a set of conventions, or null when it is one. */
export function conventionsProblem(v: unknown): string | null {
  if (!isRecord(v)) return 'the conventions are not an object';
  const keys = keysProblem(v, KEYS, 'the conventions');
  if (keys !== null) return keys;
  const oneOf = (value: unknown, choices: readonly unknown[], what: string): string | null =>
    value === null || choices.includes(value)
      ? null
      : `${what} ${JSON.stringify(value)} is not one of ${choices.map((c) => JSON.stringify(c)).join(', ')}`;
  const problem =
    oneOf(v['standardConditions'], STANDARD_CONDITIONS, 'the standard conditions') ??
    oneOf(v['energyUnit'], ENERGY_UNITS, 'the energy unit') ??
    oneOf(v['combustionTemperature'], COMBUSTION_TEMPERATURES, 'the combustion reference temperature') ??
    oneOf(v['meteringTemperature'], METERING_TEMPERATURES, 'the metering reference temperature');
  if (problem !== null) return problem;
  const t = v['tonneToEnergy'];
  if (t === null) return null;
  if (!isRecord(t)) return 'the tonne-to-energy factor is not an object';
  const tk = keysProblem(t, TONNE_KEYS, 'the tonne-to-energy factor');
  if (tk !== null) return tk;
  const factor = t['factor'];
  if (typeof factor !== 'number' || !Number.isFinite(factor) || factor <= 0) {
    return 'the tonne-to-energy factor is not a number greater than 0';
  }
  if (!TONNE_ENERGY_UNITS.includes(t['unit'] as TonneEnergyUnit)) {
    return `the tonne-to-energy unit ${JSON.stringify(t['unit'])} is not one of ${TONNE_ENERGY_UNITS.map((u) => JSON.stringify(u)).join(', ')}`;
  }
  const source = t['source'];
  if (typeof source !== 'string' || source.trim() === '') return 'the tonne-to-energy factor names no source';
  if (source.length > 200) return 'the source of the tonne-to-energy factor is longer than 200 characters';
  return null;
}

/** A temperature as a form shows it: 15.55 °C (60 °F). */
export function referenceTemperatureText(t: number): string {
  return t === 15.55 ? '15.55 °C (60 °F)' : `${t} °C`;
}

/** The conventions in one line, as the status bar and an export's README state them; null when none is set. */
export function conventionsText(c: Conventions): string | null {
  const parts = [
    c.standardConditions === null ? null : `standard conditions ${standardConditionsText(c.standardConditions)}`,
    c.energyUnit === null ? null : `energy in ${c.energyUnit}`,
    c.combustionTemperature === null ? null : `combustion at ${referenceTemperatureText(c.combustionTemperature)}`,
    c.meteringTemperature === null ? null : `metering at ${referenceTemperatureText(c.meteringTemperature)}`,
    c.tonneToEnergy === null
      ? null
      : `${c.tonneToEnergy.factor} ${c.tonneToEnergy.unit} (${c.tonneToEnergy.source.trim()})`,
  ].filter((p): p is string => p !== null);
  return parts.length === 0 ? null : parts.join(', ');
}
